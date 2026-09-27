import { createResponseCache, parseLenient, type ResponseCache } from '@chrischall/mcp-utils';
import { z } from 'zod';
import { AppleToolError, UpstreamError, scrub } from '../errors.js';
import { httpRequest, withQuery, type QueryValue } from '../http.js';
import { isRecord } from './project.js';
import { createSlidingWindowLimiter, type SlidingWindowLimiter } from './throttle.js';

/**
 * The one way this module reaches Apple: `itunes.apple.com` (Search / Lookup)
 * and `rss.marketingtools.apple.com` (charts). Neither needs a credential.
 *
 *  - **One module-wide sliding-window throttle** for itunes.apple.com, shared by
 *    every tool and the health probe: Apple allows about 20 calls a minute per
 *    IP and answers more with a refusal. The chart host has no documented limit
 *    and does not share that budget, so it is not throttled.
 *  - **A 1-hour response cache** (≤ 200 entries) for both hosts, keyed on the
 *    exact request URL. Apple itself sends `cache-control: max-age=86400` on
 *    search answers, so an hour is conservative; a cached answer is reported
 *    as such with the time it was fetched. Identical concurrent requests share
 *    one upstream call. Failures are never cached.
 *  - **Shape checks before anything is cached or rendered.** A body without the
 *    `results` array is an error — never an empty list.
 */

export const ITUNES_BASE = 'https://itunes.apple.com';
export const CHARTS_BASE = 'https://rss.marketingtools.apple.com/api/v2';

export const CACHE_TTL_MS = 60 * 60 * 1000;
export const CACHE_MAX_ENTRIES = 200;
export const RATE_LIMIT = { maxCalls: 20, windowMs: 60_000, minSpacingMs: 3_000, maxWaitMs: 30_000 } as const;

const RATE_HINT =
  'Apple allows about 20 iTunes Search/Lookup requests per minute from one IP address (shared by everyone on a hosted ' +
  'deployment). Wait a minute before retrying; repeating an identical request within an hour is served from cache.';

export interface Fetched<T> {
  data: T;
  /** Whether this answer came from the response cache rather than a request just made. */
  cached: boolean;
  /** When Apple produced this answer (epoch ms). */
  fetchedAt: number;
}

export interface ItunesEnvelope {
  resultCount?: number;
  results: unknown[];
}

export interface ChartFeed {
  /** Apple's localized chart title, e.g. "Top Songs". */
  title?: string;
  results: unknown[];
}

export interface ItunesCallOptions {
  /** Skip the cache and any identical in-flight request (the health probe must really reach Apple). */
  fresh?: boolean;
  /** Refuse (RATE_LIMITED) rather than wait longer than this for a throttle slot; default RATE_LIMIT.maxWaitMs. */
  maxWaitMs?: number;
}

export interface ItunesClient {
  /** GET `https://itunes.apple.com/<endpoint>` — throttled and cached. */
  itunes(endpoint: 'search' | 'lookup', query: Record<string, QueryValue>, opts?: ItunesCallOptions): Promise<Fetched<ItunesEnvelope>>;
  /** GET one Apple chart feed — cached. */
  chart(storefront: string, media: string, feed: string, limit: number, type: string): Promise<Fetched<ChartFeed>>;
}

export interface ItunesClientOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

// Only the fields this module reads; drift warns (stderr) and the raw body flows on.
const itunesRecordSchema = z.looseObject({
  wrapperType: z.string().optional(),
  kind: z.string().optional(),
  collectionType: z.string().optional(),
  trackId: z.number().optional(),
  collectionId: z.number().optional(),
  artistId: z.number().optional(),
  trackName: z.string().optional(),
  collectionName: z.string().optional(),
  artistName: z.string().optional(),
  releaseDate: z.string().optional(),
  trackTimeMillis: z.number().optional(),
  trackCount: z.number().optional(),
  feedUrl: z.string().optional(),
});
const itunesEnvelopeSchema = z.looseObject({ resultCount: z.number().optional(), results: z.array(itunesRecordSchema) });

const chartItemSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  artistName: z.string().optional(),
  artistId: z.string().optional(),
  releaseDate: z.string().optional(),
  url: z.string().optional(),
  contentAdvisoryRating: z.string().optional(),
  genres: z.array(z.looseObject({ name: z.string().optional() })).optional(),
});
const chartEnvelopeSchema = z.looseObject({
  feed: z.looseObject({
    title: z.string().optional(),
    results: z.array(chartItemSchema),
  }),
});

/**
 * Apple's iTunes errors are `{errorMessage: "Invalid value(s) for key(s): [country]", queryParameters: {…}}`
 * with HTTP 400 (verified live). Its key names are internal, so they are
 * translated back to this tool's argument names in the hint.
 */
const APPLE_KEY_TO_ARG: Record<string, string> = {
  country: 'country',
  attributeType: 'attribute',
  resultEntity: 'entity',
  media: 'media',
  mediaType: 'media',
  itunesId: 'ids',
  id: 'ids',
  upc: 'upc',
  isbn: 'isbn',
  bundleId: 'bundleId',
  limit: 'limit',
  lang: 'lang',
  explicit: 'explicit',
  sort: 'sort',
  term: 'term',
};

export function classifyItunesError(status: number, bodyText: string): Error | undefined {
  if (status === 400) {
    let message: string | undefined;
    try {
      const parsed = JSON.parse(bodyText) as unknown;
      if (isRecord(parsed) && typeof parsed.errorMessage === 'string') message = parsed.errorMessage;
    } catch {
      // not JSON: the default mapping describes it
    }
    if (message === undefined) return undefined;
    const keys = [...message.matchAll(/\[([^\]]*)\]/g)].flatMap((m) => (m[1] as string).split(','));
    const args = [...new Set(keys.map((k) => k.trim()).filter((k) => k.length > 0).map((k) => APPLE_KEY_TO_ARG[k] ?? k))];
    return new UpstreamError('itunes', 400, scrub(`itunes: Apple rejected the request — ${message}`), {
      code: 'INVALID_ARGUMENT',
      hint: args.length > 0 ? `Check the value of: ${args.join(', ')}.` : 'Check the arguments against the tool description.',
    });
  }
  if (status === 403) {
    // Reported (not verified here) to be how Apple answers when the per-minute budget is spent.
    return new UpstreamError('itunes', 403, 'itunes: Apple refused the request (HTTP 403) — most likely its rate limit.', {
      code: 'RATE_LIMITED',
      hint: RATE_HINT,
    });
  }
  return undefined;
}

/**
 * Apple's chart host answers HTTP 500 (an HTML page) for a storefront that
 * lacks the chart: an unknown code (verified live: zz, va), or a real store
 * without that kind of content (cn has music charts but no books; ir no apps).
 */
export function classifyChartError(storefront: string, chart: string) {
  return (status: number): Error | undefined => {
    if (status !== 500) return undefined;
    return new UpstreamError('itunes', 500, `itunes: Apple's ${chart} chart feed failed with HTTP 500 for storefront "${storefront}".`, {
      hint:
        'Apple answers 500 when a storefront has no such chart (an unknown country code, or a store that does not sell ' +
        'this kind of content) and when the service is down. Check the storefront is a two-letter country code where ' +
        'Apple sells this content, e.g. us, gb, jp, or try another chart; retry later if it is.',
    });
  };
}

export function createItunesClient(opts: ItunesClientOptions = {}): ItunesClient {
  const now = opts.now ?? Date.now;
  const cache: ResponseCache<Fetched<unknown>> = createResponseCache({
    ttlMs: { dynamic: CACHE_TTL_MS },
    maxEntries: CACHE_MAX_ENTRIES,
    now,
  });
  const inFlight = new Map<string, Promise<Fetched<unknown>>>();
  const limiter: SlidingWindowLimiter = createSlidingWindowLimiter({
    ...RATE_LIMIT,
    now,
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    // `service` rides along so the structured error names the service, like every upstream error does.
    refuse: (waitMs) =>
      Object.assign(
        new AppleToolError(
          'RATE_LIMITED',
          `itunes: this server has already made or queued ${RATE_LIMIT.maxCalls} iTunes requests for the current minute ` +
            `(Apple allows about ${RATE_LIMIT.maxCalls} a minute); the next one could start in ${Math.ceil(waitMs / 1000)} s.`,
          { hint: `Retry in about ${Math.ceil(waitMs / 1000)} seconds. ${RATE_HINT}` },
        ),
        { service: 'itunes' as const },
      ),
  });

  /** Cache → shared in-flight request → (throttle →) request. */
  async function get<T>(url: URL, load: () => Promise<T>, fresh: boolean): Promise<Fetched<T>> {
    const key = url.toString();
    if (!fresh) {
      const hit = cache.get(key);
      if (hit !== undefined) return { ...(hit as Fetched<T>), cached: true };
      const pending = inFlight.get(key);
      if (pending !== undefined) return (await pending) as Fetched<T>;
    }
    const promise = (async (): Promise<Fetched<unknown>> => {
      const data = await load();
      const entry = { data, cached: false, fetchedAt: now() };
      cache.set(key, entry);
      return entry;
    })();
    if (!fresh) inFlight.set(key, promise);
    try {
      return (await promise) as Fetched<T>;
    } finally {
      if (!fresh) inFlight.delete(key);
    }
  }

  return {
    itunes(endpoint, query, callOpts = {}) {
      const url = withQuery(`${ITUNES_BASE}/${endpoint}`, query);
      return get<ItunesEnvelope>(
        url,
        () =>
          limiter(async () => {
            const res = await httpRequest<unknown>({
              service: 'itunes',
              method: 'GET',
              url,
              // Apple labels the JSON `text/javascript` (+ content-disposition: attachment); parse it regardless.
              responseType: 'json',
              classifyError: classifyItunesError,
            });
            return checkItunesEnvelope(res.data, endpoint);
          }, { maxWaitMs: callOpts.maxWaitMs }),
        callOpts.fresh === true,
      );
    },
    chart(storefront, media, feed, limit, type) {
      const url = new URL(`${CHARTS_BASE}/${storefront}/${media}/${feed}/${limit}/${type}.json`);
      return get<ChartFeed>(
        url,
        async () => {
          const res = await httpRequest<unknown>({
            service: 'itunes',
            method: 'GET',
            url,
            responseType: 'json',
            classifyError: classifyChartError(storefront, `${media}/${feed}/${type}`),
          });
          return checkChartFeed(res.data, `${media}/${feed}/${type}`);
        },
        false,
      );
    },
  };
}

/** The envelope, or an error — a body without a `results` array must never read as "no results". */
export function checkItunesEnvelope(raw: unknown, endpoint: string): ItunesEnvelope {
  parseLenient(itunesEnvelopeSchema, raw, { label: 'apple-cloud-mcp', context: `GET itunes.apple.com/${endpoint}` });
  // The RAW body flows on (not the parse): zod reorders keys, and `view: full` promises Apple's records verbatim.
  if (!isRecord(raw) || !Array.isArray(raw.results)) {
    throw new UpstreamError('itunes', 200, `itunes: /${endpoint} answered without a results list; the response cannot be read.`, {
      hint: 'Apple may have changed the API or be having problems. Retry later.',
    });
  }
  return raw as unknown as ItunesEnvelope;
}

export function checkChartFeed(raw: unknown, chart: string): ChartFeed {
  parseLenient(chartEnvelopeSchema, raw, { label: 'apple-cloud-mcp', context: `GET rss.marketingtools.apple.com ${chart}` });
  const feed = isRecord(raw) ? raw.feed : undefined;
  if (!isRecord(feed) || !Array.isArray(feed.results)) {
    throw new UpstreamError('itunes', 200, `itunes: Apple's ${chart} chart feed answered without a results list; the response cannot be read.`, {
      hint: 'Apple may have changed the feed or be having problems. Retry later.',
    });
  }
  return feed as unknown as ChartFeed;
}

let defaultClient: ItunesClient | undefined;

/** The module-wide client (one throttle, one cache) — built on first use, never at import. */
export function getDefaultItunesClient(): ItunesClient {
  defaultClient ??= createItunesClient();
  return defaultClient;
}

/** Test seam. */
export function resetDefaultItunesClient(): void {
  defaultClient = undefined;
}
