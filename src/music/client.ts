import { createHash } from 'node:crypto';
import { createCachedTokenSource, parseLenient, type CachedTokenSource } from '@chrischall/mcp-utils';
import { z } from 'zod';
import { mintMusicDeveloperToken, type DeveloperKey } from '../apple-keys.js';
import { ConfigError, CredentialsRejectedError, UpstreamError, errorMessage, rememberSecret, scrub } from '../errors.js';
import { describeErrorBody, httpRequest, type QueryValue } from '../http.js';
import {
  ENV,
  OFFICIAL_SETUP,
  USER_TOKEN_HOWTO,
  WEB_SETUP,
  officialUserToken,
  resolveOfficialDev,
  storefrontFromEnv,
  webDeveloperTokenOverride,
  webUserToken,
  type OfficialDev,
} from './credentials.js';
import { normalizeStorefront } from './ids.js';
import { LABEL, isRecord, num, str, type AppleResource } from './project.js';
import { WEB_ORIGIN, WebTokenSource, type HttpFn } from './web-token.js';
import { PlaylistAttributeLog, PlaylistWriteLog } from './write-log.js';

/**
 * The Apple Music client: picks a backend for each tool call, attaches the
 * right credentials, and turns Apple's answers into this server's errors.
 *
 * Routing (decided per call from the environment):
 *  - catalog  → official if a developer token is available, else web.
 *  - library  → official if a developer token AND a Music User Token are
 *               available, else web.
 *  - extended → web only (rename, delete, remove/reorder tracks, move,
 *               unfavourite, remove from library — the official API has no
 *               endpoint for any of them).
 *
 * A 401 means Apple refused the DEVELOPER token: the cached token is dropped
 * and the request replayed once with a fresh one. If the official token is
 * still refused and web mode is on, the call is served by the web backend and
 * the response says so (a shared Maps/WeatherKit key without MusicKit mints a
 * token Apple rejects, and that must not break a working web setup). A 403 is
 * the USER token (expired, revoked, privacy consent, no subscription).
 */

export const OFFICIAL_ORIGIN = 'https://api.music.apple.com';
export const WEB_API_ORIGIN = 'https://amp-api.music.apple.com';
const MINT_BUFFER_MS = 10 * 60 * 1000;

export type BackendName = 'official' | 'web';
export type RouteKind = 'catalog' | 'library' | 'extended';

export interface Backend {
  name: BackendName;
  origin: string;
  /** Which variables (or which scrape) supplied the developer token — never the value. */
  devSource: string;
  userToken?: string;
  /** Fingerprint of the official developer credential (for the rejection latch). */
  officialKey?: string;
  token(): Promise<string>;
  /** Drop the cached developer token; true when a retry could use a DIFFERENT one. */
  refresh(): boolean;
}

export interface MusicRequest {
  method?: string;
  /** Root-relative path; every id in it must already be validated. */
  path: string;
  query?: Record<string, QueryValue>;
  json?: unknown;
  /** Statuses returned instead of thrown (e.g. 404 = "absent"). */
  okStatuses?: number[];
  /** Extra hint for a 404 (what the id should have been). */
  notFoundHint?: string;
}

export interface MusicResponse<T = unknown> {
  status: number;
  data: T | undefined;
}

export interface Page {
  status: number;
  items: AppleResource[];
  hasMore: boolean;
  total?: number;
}

export interface Storefront {
  storefront: string;
  source: 'argument' | 'APPLE_MUSIC_STOREFRONT' | 'account' | 'default';
  note?: string;
}

const ResourceSchema = z.looseObject({ id: z.string(), type: z.string() });
export const DocSchema = z.looseObject({
  data: z.array(ResourceSchema),
  next: z.string().optional(),
  meta: z.looseObject({ total: z.number().optional() }).optional(),
});

export interface AppleDoc {
  data?: AppleResource[];
  next?: string;
  meta?: Record<string, unknown>;
  results?: Record<string, unknown>;
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function devFingerprint(dev: OfficialDev): string {
  return dev.kind === 'env-token' ? sha(`t\0${dev.token}`) : sha(`k\0${dev.key.teamId}\0${dev.key.keyId}\0${dev.key.privateKeyPem}`);
}

/**
 * Apple's `data` array. The document is checked with `parseLenient` (a drift
 * in the fields read here is warned about on stderr), and a document with no
 * `data` array at all is an error — never an empty list.
 */
export function requireData(doc: unknown, context: string, status = 200): AppleResource[] {
  const parsed = parseLenient(DocSchema, doc, { label: LABEL, context }) as unknown;
  if (isRecord(parsed) && Array.isArray(parsed.data)) return parsed.data as AppleResource[];
  throw new UpstreamError('music', status, `music: ${context} returned an unexpected shape (no data array).`, {
    hint: 'Apple may have changed this endpoint. Retry later; if it persists, report it.',
  });
}

/** `meta.total` when Apple sent one. */
export function totalOf(doc: unknown): number | undefined {
  return isRecord(doc) && isRecord(doc.meta) ? num(doc.meta.total) : undefined;
}

/** Whether Apple's collection has another page (`next`, or a total larger than what was read). */
export function nextOf(doc: unknown): boolean {
  return isRecord(doc) && str(doc.next) !== undefined;
}

export interface MusicClientOptions {
  http?: HttpFn;
  now?: () => number;
}

export class MusicClient {
  readonly http: HttpFn;
  readonly now: () => number;
  readonly web: WebTokenSource;
  private readonly mintSources = new Map<string, CachedTokenSource>();
  /** Official developer credentials Apple definitively refused on a catalog read (see class doc). */
  private readonly rejectedOfficial = new Set<string>();
  private readonly storefronts = new Map<string, string>();
  /** The playlist orders this process replaced recently, so a lagging read is not rewritten over them. */
  readonly playlistWrites = new PlaylistWriteLog();
  /** The playlist names/descriptions/visibility this process set recently, so a lagging read is not PATCHed back. */
  readonly playlistAttributes = new PlaylistAttributeLog();

  constructor(opts: MusicClientOptions = {}) {
    this.http = opts.http ?? (httpRequest as HttpFn);
    this.now = opts.now ?? Date.now;
    this.web = new WebTokenSource(this.http, this.now);
  }

  /** Start a tool call's session on the backend that serves `kind`. `what` names the operation in errors. */
  session(kind: RouteKind, what: string): MusicSession {
    return new MusicSession(this, kind, this.route(kind, what));
  }

  /** Whether web mode is on (APPLE_MUSIC_WEB_USER_TOKEN set). */
  webEnabled(): boolean {
    return webUserToken() !== undefined;
  }

  route(kind: RouteKind, what: string): Backend {
    const webUser = webUserToken();
    if (kind === 'extended') {
      if (webUser) return this.webBackend(webUser);
      throw new ConfigError(
        'music',
        `Apple's official Apple Music API cannot ${what}; only Apple's web-player API (unofficial) can, and web mode is off.`,
        [ENV.webUserToken],
        `${WEB_SETUP} It uses an undocumented API that Apple may change or block at any time.`,
      );
    }
    const official = resolveOfficialDev(process.env, this.now());
    const latched = (dev: OfficialDev): boolean => webUser !== undefined && this.rejectedOfficial.has(devFingerprint(dev));
    if (kind === 'catalog') {
      if (official.status === 'ok' && !latched(official.dev)) return this.officialBackend(official.dev);
      if (official.status === 'broken') throw official.error;
      if (webUser) return this.webBackend(webUser);
      throw new ConfigError(
        'music',
        `To ${what}, Apple Music needs credentials, and none are configured.`,
        ['APPLE_TEAM_ID + APPLE_KEY_ID + APPLE_PRIVATE_KEY (or APPLE_MUSIC_DEVELOPER_TOKEN)', ENV.webUserToken],
        `${OFFICIAL_SETUP} Or: ${WEB_SETUP}`,
      );
    }
    const userToken = officialUserToken();
    if (official.status === 'ok' && userToken && !latched(official.dev)) return this.officialBackend(official.dev, userToken);
    if (official.status === 'broken' && userToken) throw official.error;
    if (webUser) return this.webBackend(webUser);
    if (official.status === 'ok') {
      throw new ConfigError(
        'music',
        `To ${what}, Apple needs a Music User Token for your account; APPLE_MUSIC_USER_TOKEN is not set.`,
        [ENV.userToken, ENV.webUserToken],
        `To sign in once with MusicKit, ${USER_TOKEN_HOWTO}; then set APPLE_MUSIC_USER_TOKEN to the value it prints (it lasts ` +
          `about 6 months). Or: ${WEB_SETUP}`,
      );
    }
    if (official.status === 'broken') throw official.error;
    throw new ConfigError(
      'music',
      `To ${what}, Apple Music needs credentials for your account, and none are configured.`,
      [`${ENV.userToken} (with an Apple Developer key)`, ENV.webUserToken],
      `${OFFICIAL_SETUP} Or: ${WEB_SETUP}`,
    );
  }

  webBackend(userToken: string): Backend {
    const override = webDeveloperTokenOverride(process.env, this.now());
    return {
      name: 'web',
      origin: WEB_API_ORIGIN,
      devSource: override ? ENV.webDeveloperToken : 'the music.apple.com web player',
      userToken,
      token: async () => (await this.web.get()).token,
      refresh: () => this.web.invalidate(),
    };
  }

  officialBackend(dev: OfficialDev, userToken?: string): Backend {
    const base = { name: 'official' as const, origin: OFFICIAL_ORIGIN, devSource: dev.source, officialKey: devFingerprint(dev), ...(userToken ? { userToken } : {}) };
    if (dev.kind === 'env-token') {
      return { ...base, token: () => Promise.resolve(dev.token), refresh: () => false };
    }
    const src = this.mintSource(dev.key);
    return {
      ...base,
      token: () => src.getToken(),
      refresh: () => {
        src.invalidate();
        return true;
      },
    };
  }

  private mintSource(key: DeveloperKey): CachedTokenSource {
    const id = sha(`${key.teamId}\0${key.keyId}\0${key.privateKeyPem}`);
    let src = this.mintSources.get(id);
    if (!src) {
      src = createCachedTokenSource({
        mint: async () => {
          const minted = mintMusicDeveloperToken(key, this.now());
          rememberSecret(minted.token);
          return { token: minted.token, expiresAt: minted.expiresAt };
        },
        bufferMs: MINT_BUFFER_MS,
        now: this.now,
      });
      this.mintSources.set(id, src);
    }
    return src;
  }

  /** Remember that Apple refused this official developer credential outright. */
  latchOfficial(b: Backend): void {
    if (b.officialKey) this.rejectedOfficial.add(b.officialKey);
  }

  headers(b: Backend, devToken: string): Record<string, string> {
    rememberSecret(devToken);
    const h: Record<string, string> = { Authorization: `Bearer ${devToken}`, Accept: 'application/json' };
    if (b.name === 'web') {
      // Never x-apple-client-version: amp-api answers a server that sends it with HTTP 500.
      h['media-user-token'] = b.userToken as string;
      h.Origin = WEB_ORIGIN;
      h.Referer = `${WEB_ORIGIN}/`;
    } else if (b.userToken) {
      h['Music-User-Token'] = b.userToken;
    }
    return h;
  }

  /** One request with the 401 → fresh developer token → replay-once rule. Returns 401 to the caller if it persists. */
  async send(b: Backend, req: MusicRequest): Promise<{ status: number; text: string }> {
    const method = (req.method ?? 'GET').toUpperCase();
    const attempt = async () => {
      const dev = await b.token();
      return this.http<string>({
        service: 'music',
        method,
        url: `${b.origin}${req.path}`,
        ...(req.query ? { query: req.query } : {}),
        headers: this.headers(b, dev),
        ...(req.json !== undefined ? { json: req.json } : {}),
        okStatuses: [401, ...(req.okStatuses ?? [])],
        responseType: 'text',
        classifyError: (status, text) => this.classify(b, method, req, status, text),
      });
    };
    let res = await attempt();
    if (res.status === 401 && b.refresh()) res = await attempt();
    return { status: res.status, text: res.text };
  }

  /** Map a non-2xx answer (other than 401 and the caller's okStatuses) to an error, or undefined for http.ts's default. */
  classify(b: Backend, method: string, req: MusicRequest, status: number, text: string): Error | undefined {
    const idempotent = method === 'GET' || method === 'HEAD';
    // A write whose outcome is unknown must become UnconfirmedWriteError, never a plain error that invites a blind
    // retry. http.ts guarantees that BEFORE it consults classifyError; this line keeps the guarantee if it ever moves.
    /* v8 ignore next -- unreachable: http.ts throws UnconfirmedWriteError for a non-idempotent 5xx/408 before calling classifyError */
    if (!idempotent && (status >= 500 || status === 408)) return undefined;
    const { message, code } = describeErrorBody(text);
    const what = scrub(`music (${b.name}): ${method} ${req.path} failed with HTTP ${status}${message ? ` — ${message}` : ''}`);
    const upstream = code === undefined ? {} : { upstreamCode: code };
    if (status === 403) return new CredentialsRejectedError('music', 403, what, userTokenHint(b, method, req.path));
    if (status === 404) {
      return new UpstreamError('music', 404, what, {
        ...upstream,
        hint: req.notFoundHint ?? 'Apple has no such item. Check the id (library ids and catalog ids differ; library ids change if an item is removed and re-added).',
      });
    }
    if (status === 429) {
      return new UpstreamError('music', 429, what, {
        ...upstream,
        hint:
          b.name === 'web'
            ? 'Apple is throttling the shared web-player token (it can take up to an hour to clear). Wait before retrying.'
            : 'Apple is throttling requests for this developer token. Wait a minute before retrying.',
      });
    }
    return new UpstreamError('music', status, what, upstream);
  }

  rejected401(b: Backend, method: string, path: string, text: string): CredentialsRejectedError {
    const { message } = describeErrorBody(text);
    const what = scrub(`music (${b.name}): ${method} ${path} failed with HTTP 401${message ? ` — ${message}` : ''}`);
    let hint: string;
    if (b.name === 'web') {
      hint =
        `Apple refused the web-player request (developer token from ${b.devSource}). ` +
        'Most often the media-user-token session was signed out or expired: copy a fresh media-user-token cookie from a ' +
        'signed-in music.apple.com tab into APPLE_MUSIC_WEB_USER_TOKEN. Otherwise Apple rotated or blocked the web-player ' +
        'token; if APPLE_MUSIC_WEB_DEVELOPER_TOKEN is set, refresh or unset it.';
    } else {
      hint =
        `Apple rejected the developer token (from ${b.devSource}): check APPLE_TEAM_ID and the key id, that the key has Media ` +
        'Services (MusicKit) enabled, and that the key was not revoked. On your library, a 401 can also mean the Apple ID has no ' +
        'Apple Music subscription.';
    }
    return new CredentialsRejectedError('music', 401, what, hint);
  }

  /**
   * The storefront for a catalog call: the argument, else APPLE_MUSIC_STOREFRONT,
   * else the account's own (when a user token exists; cached per process),
   * else `us`. A failed account lookup falls back to `us` WITH a note — the
   * catalog answer is still correct for the US store and says so.
   */
  async resolveStorefront(arg: string | undefined): Promise<Storefront> {
    if (arg !== undefined) return { storefront: normalizeStorefront(arg, 'storefront'), source: 'argument' };
    const fromEnv = storefrontFromEnv();
    if (fromEnv) return { storefront: fromEnv, source: 'APPLE_MUSIC_STOREFRONT' };
    let session: MusicSession;
    try {
      session = this.session('library', "read your account's storefront");
    } catch (err) {
      /* v8 ignore next -- route() only throws ConfigError */
      if (!(err instanceof ConfigError)) throw err;
      // No account credentials at all: the documented default, nothing to report. Account credentials that ARE
      // set but unusable (a broken APPLE_MUSIC_WEB_DEVELOPER_TOKEN, say) must not be skipped silently.
      if (officialUserToken() === undefined && webUserToken() === undefined) return { storefront: 'us', source: 'default' };
      return {
        storefront: 'us',
        source: 'default',
        note: `Could not read your account's storefront (${errorMessage(err)}); used the US store. Pass storefront or set APPLE_MUSIC_STOREFRONT.`,
      };
    }
    const key = sha(`${session.backend.name}\0${session.backend.userToken}`);
    const cached = this.storefronts.get(key);
    if (cached) return { storefront: cached, source: 'account' };
    try {
      const res = await session.request<AppleDoc>({ path: '/v1/me/storefront' });
      const id = requireData(res.data, 'GET /v1/me/storefront')[0]?.id;
      const sf = normalizeStorefront(String(id), 'storefront');
      this.storefronts.set(key, sf);
      return { storefront: sf, source: 'account' };
    } catch (err) {
      return {
        storefront: 'us',
        source: 'default',
        note: `Could not read your account's storefront (${errorMessage(err)}); used the US store. Pass storefront or set APPLE_MUSIC_STOREFRONT.`,
      };
    }
  }
}

function userTokenHint(b: Backend, method: string, path: string): string {
  const base =
    b.name === 'web'
      ? 'Apple refused the media-user-token (APPLE_MUSIC_WEB_USER_TOKEN): copy a fresh media-user-token cookie from a signed-in music.apple.com tab.'
      : `Apple refused the Music User Token (APPLE_MUSIC_USER_TOKEN): it lasts about 6 months, an Apple ID password change revokes it, and it works only with the developer key that minted it. For a new one, ${USER_TOKEN_HOWTO}.`;
  const more =
    ' HTTP 403 also means the account has not accepted Apple Music\'s privacy prompt (open the Music app once) or has no Apple Music subscription.';
  const playlistWrite =
    method !== 'GET' && path.startsWith('/v1/me/library/playlists/')
      ? ' For a playlist change it can also mean this playlist cannot be edited by this client (Apple-curated, collaborative, or created by another app).'
      : '';
  return base + more + playlistWrite;
}

/**
 * One tool call's conversation with Apple. It starts on the routed backend
 * and records any fallback in `notes`, so the response can report which
 * backend actually served it.
 */
export class MusicSession {
  readonly notes: string[] = [];

  constructor(
    readonly client: MusicClient,
    readonly kind: RouteKind,
    public backend: Backend,
  ) {}

  /** Send a request; parse a JSON body (an empty body is `undefined`). */
  async request<T = unknown>(req: MusicRequest): Promise<MusicResponse<T>> {
    const method = (req.method ?? 'GET').toUpperCase();
    for (;;) {
      const b = this.backend;
      const res = await this.client.send(b, req);
      if (res.status === 401) {
        if (b.name === 'official' && this.kind !== 'extended' && this.client.webEnabled()) {
          if (req.path.startsWith('/v1/catalog/')) this.client.latchOfficial(b);
          this.notes.push(
            `Apple rejected the official developer token (${b.devSource}); this call was served by Apple's web-player API instead.`,
          );
          this.backend = this.client.webBackend(webUserToken() as string);
          continue;
        }
        throw this.client.rejected401(b, method, req.path, res.text);
      }
      let data: T | undefined;
      if (res.text.trim() !== '') {
        try {
          data = JSON.parse(res.text) as T;
        } catch {
          throw new UpstreamError('music', res.status, `music (${b.name}): ${method} ${req.path} returned a body that is not valid JSON.`, {
            hint: 'Apple may be having trouble. Retry later.',
          });
        }
      }
      return { status: res.status, data };
    }
  }

  /** GET one page of a collection (`data` + `next`). A status in `okStatuses` yields an empty page. */
  async page(path: string, query: Record<string, QueryValue>, opts: { okStatuses?: number[] } = {}): Promise<Page> {
    const res = await this.request<AppleDoc>({
      path,
      query,
      ...(opts.okStatuses ? { okStatuses: opts.okStatuses } : {}),
    });
    if (opts.okStatuses?.includes(res.status)) return { status: res.status, items: [], hasMore: false };
    const items = requireData(res.data, `GET ${path}`, res.status);
    const total = totalOf(res.data);
    return { status: res.status, items, hasMore: nextOf(res.data) && items.length > 0, ...(total !== undefined ? { total } : {}) };
  }

  /**
   * Read up to `want` items starting at `offset`, `perRequest` at a time
   * (Apple's per-endpoint maximum), with explicit offset/limit on every
   * request — Apple's `next` link drops `limit`.
   */
  async collect(
    path: string,
    query: Record<string, QueryValue>,
    opts: { offset: number; want: number; perRequest: number; okStatuses?: number[] },
  ): Promise<{ items: AppleResource[]; hasMore: boolean; total?: number; emptyStatus?: number }> {
    const items: AppleResource[] = [];
    let hasMore = true;
    let total: number | undefined;
    let emptyStatus: number | undefined;
    while (items.length < opts.want && hasMore) {
      const limit = Math.min(opts.perRequest, opts.want - items.length);
      const page = await this.page(path, { ...query, limit, offset: opts.offset + items.length }, { okStatuses: opts.okStatuses });
      if (opts.okStatuses?.includes(page.status)) emptyStatus = page.status;
      items.push(...page.items);
      hasMore = page.hasMore;
      if (page.total !== undefined) total = page.total;
    }
    if (total !== undefined) hasMore = opts.offset + items.length < total;
    return { items, hasMore, ...(total !== undefined ? { total } : {}), ...(emptyStatus !== undefined ? { emptyStatus } : {}) };
  }
}
