import { parseRetryAfterMs, withAmbientCancellation } from '@chrischall/mcp-utils';
import { getRequestTimeoutMs, isDebugLog, type ServiceName } from './config.js';
import {
  AppleToolError,
  CredentialsRejectedError,
  TransportError,
  UnconfirmedWriteError,
  UpstreamError,
  scrub,
} from './errors.js';

/**
 * The one HTTP chokepoint every HTTPS-speaking service goes through.
 *
 * Why not mcp-utils' `createApiClient`: CalDAV/CardDAV need raw XML bodies and
 * WebDAV methods it cannot send, Apple Music needs two credentials plus an
 * Origin, and Maps/WeatherKit each have their own token dance — five clients
 * with five retry policies is how drift starts. This module owns what they
 * must agree on:
 *
 *  - **Global `fetch`, always.** On mcp-host the child reaches the internet
 *    only through the egress proxy that `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`
 *    point Node's built-in fetch at. A library with its own HTTP stack
 *    silently bypasses it and times out.
 *  - **A host allowlist** (`assertAllowedUrl`). CalDAV answers with absolute
 *    hrefs the SERVER chooses; an Authorization header must never follow one
 *    off Apple's hosts.
 *  - **A per-attempt timeout folded with the caller's cancellation**, so a
 *    cancelled tool call stops its fetch rather than burning metered CPU.
 *  - **Writes are never retried blindly.** A non-idempotent request whose
 *    outcome is unknown (timeout, dropped connection, 5xx, 408) throws
 *    `UnconfirmedWriteError` — "may have landed, check first" — instead of
 *    being replayed into a duplicate.
 *  - **Secrets never reach an error or a log** (`scrub`).
 */

/** Exact hosts this server may call. Mirrors mint.yaml `egress.allow`. */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'api.music.apple.com',
  'amp-api.music.apple.com',
  'music.apple.com',
  'caldav.icloud.com',
  'contacts.icloud.com',
  'maps-api.apple.com',
  'weatherkit.apple.com',
  'itunes.apple.com',
  'rss.marketingtools.apple.com',
]);

/**
 * Suffixes for hosts Apple assigns per account: iCloud moves every DAV
 * account onto a partition host (`p42-caldav.icloud.com`) through the hrefs it
 * returns. The leading dot means "a subdomain of", never the bare domain.
 */
export const ALLOWED_HOST_SUFFIXES: readonly string[] = ['.icloud.com'];

export function isAllowedHost(host: string): boolean {
  const h = host.toLowerCase();
  return ALLOWED_HOSTS.has(h) || ALLOWED_HOST_SUFFIXES.some((s) => h.endsWith(s) && h.length > s.length);
}

/** Throws unless `url` is https on an allowed Apple host. */
export function assertAllowedUrl(url: URL, service: ServiceName): void {
  if (url.protocol !== 'https:' || !isAllowedHost(url.hostname)) {
    throw new AppleToolError(
      'UPSTREAM_ERROR',
      `${service}: refusing to contact ${url.protocol}//${url.hostname} — not an allowed Apple host.`,
      { hint: 'This is a safety check: the upstream pointed at a host outside the allowlist.' },
    );
  }
}

/** The credential family of an allowed host: all of iCloud, all of Apple Music, or the host itself. */
export function credentialFamily(host: string): string {
  const h = host.toLowerCase();
  if (h === 'icloud.com' || h.endsWith('.icloud.com')) return 'icloud';
  if (h === 'music.apple.com' || h.endsWith('.music.apple.com')) return 'music';
  return h;
}

export type QueryValue = string | number | boolean | null | undefined | ReadonlyArray<string | number>;

/**
 * Append query parameters. Arrays are COMMA-JOINED (Apple's convention:
 * `ids=1,2,3`, `types=songs,albums`), never repeated keys. Brackets and
 * commas are left literal — Apple documents `ids[songs]=` and `filter[isrc]=`
 * in that form, and percent-encoding them is not something we need to find
 * out the hard way. Everything else is percent-encoded.
 */
export function withQuery(base: string | URL, query: Record<string, QueryValue> | undefined): URL {
  const url = new URL(base);
  if (!query) return url;
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(query)) {
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Array.isArray(raw) ? raw.join(',') : String(raw);
    if (Array.isArray(raw) && raw.length === 0) continue;
    parts.push(`${encodeQueryPart(key)}=${encodeQueryPart(value)}`);
  }
  if (parts.length === 0) return url;
  const existing = url.search.length > 1 ? url.search.slice(1) + '&' : '';
  url.search = '?' + existing + parts.join('&');
  return url;
}

function encodeQueryPart(s: string): string {
  return encodeURIComponent(s).replace(/%2C/gi, ',').replace(/%5B/gi, '[').replace(/%5D/gi, ']');
}

export interface HttpRequest {
  service: ServiceName;
  method: string;
  url: string | URL;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  /** A raw body (XML, iCalendar, vCard, form). Mutually exclusive with `json`. */
  body?: string;
  /** A JSON body; sets `Content-Type: application/json`. */
  json?: unknown;
  /** Per-attempt timeout; defaults to APPLE_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Whether replaying this request is harmless. Defaults to true for
   * GET/HEAD/OPTIONS/PROPFIND/REPORT and false for everything else. A
   * non-idempotent request is retried ONLY on 429 (a refusal to process),
   * and an unknown outcome becomes `UnconfirmedWriteError`.
   */
  idempotent?: boolean;
  /** Statuses returned to the caller instead of thrown (e.g. 404 for "absent", 412 for a precondition). */
  okStatuses?: readonly number[];
  /** How to read the body. Default: `json` when the content type says so, else `text`. */
  responseType?: 'json' | 'text' | 'bytes';
  /**
   * Service-specific error mapping, consulted before the defaults for every
   * status not in `okStatuses` and ≥ 300. Return an Error to throw it, or
   * undefined for the default mapping. Its answer is IGNORED for a 5xx or 408
   * on a non-idempotent request, which is always `UnconfirmedWriteError` (the
   * outcome is unknown, whatever the body says).
   */
  classifyError?: (status: number, bodyText: string, headers: Headers) => Error | undefined;
  /** Max 429 retries (default 1). */
  rateLimitRetries?: number;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  /** The final URL (after any redirect fetch followed). */
  url: string;
  /** Parsed JSON for `json`, the text for `text`, undefined for `bytes`. */
  data: T;
  text: string;
  bytes: Uint8Array;
}

/** Largest response body read into memory (a full address book is a few MB). */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

const MAX_REDIRECTS = 5;
/** Headers that carry a credential and must not follow a redirect out of their service family. */
const CREDENTIAL_HEADER_RE = /^(authorization|proxy-authorization|cookie|music-user-token|media-user-token)$/i;
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PROPFIND', 'REPORT']);
const RETRYABLE_READ_STATUSES = new Set([502, 503, 504]);

/** Test seam: the sleep used between retries. */
export let sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export function setSleepForTests(fn: (ms: number) => Promise<void>): void {
  sleep = fn;
}

function debug(line: string): void {
  if (isDebugLog()) console.error(`[apple-icloud-mcp] ${scrub(line)}`);
}

/** Pull a readable message out of an error body (Apple's JSON:API `errors[]`, `{error:{message}}`, or text). */
export function describeErrorBody(text: string): { message: string; code?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { message: '' };
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const errors = parsed.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const e = errors[0] as Record<string, unknown>;
      const parts = [e.title, e.detail].filter((x): x is string => typeof x === 'string' && x.length > 0);
      const code = typeof e.code === 'string' ? e.code : undefined;
      return { message: clip(parts.join(': ')), ...(code ? { code } : {}) };
    }
    const err = parsed.error;
    if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
      return { message: clip((err as Record<string, string>).message) };
    }
    if (typeof parsed.reason === 'string') return { message: clip(parsed.reason) };
    if (typeof parsed.message === 'string') return { message: clip(parsed.message) };
  } catch {
    // not JSON — fall through to text
  }
  // Strip tags from an HTML/XML error page so the snippet is readable.
  const flat = trimmed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return { message: flat.length > 300 ? `${flat.slice(0, 300)}… [truncated]` : flat };
}

/**
 * The most of an upstream error message that reaches a tool result. Apple's
 * messages are a sentence; anything longer is a body echoed back, and it
 * would land in the model's context whole.
 */
const MAX_ERROR_MESSAGE_CHARS = 500;

function clip(message: string): string {
  return message.length > MAX_ERROR_MESSAGE_CHARS ? `${message.slice(0, MAX_ERROR_MESSAGE_CHARS)}… [truncated]` : message;
}

function defaultError(req: HttpRequest, url: URL, status: number, bodyText: string): Error {
  const { message, code } = describeErrorBody(bodyText);
  const what = `${req.service}: ${req.method.toUpperCase()} ${url.pathname} failed with HTTP ${status}`;
  const full = message ? `${what} — ${message}` : what;
  if (status === 401) {
    return new CredentialsRejectedError(req.service, status, scrub(full), 'The credential was rejected. Check it is current and correct; retrying will not help.');
  }
  return new UpstreamError(req.service, status, scrub(full), code === undefined ? {} : { upstreamCode: code });
}

/**
 * Perform one logical request (with the bounded retries described above).
 * Throws `AppleToolError` subclasses; never returns a non-2xx status unless it
 * is listed in `okStatuses`.
 */
export async function httpRequest<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
  let method = req.method.toUpperCase();
  let url = withQuery(req.url, req.query);
  assertAllowedUrl(url, req.service);
  const idempotent = req.idempotent ?? IDEMPOTENT_METHODS.has(method);
  const timeoutMs = req.timeoutMs ?? getRequestTimeoutMs();
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  let body: string | undefined = req.body;
  if (req.json !== undefined) {
    body = JSON.stringify(req.json);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }
  assertSendableHeaders(headers, req.service);
  const rateLimitRetries = req.rateLimitRetries ?? 1;
  let rateLimited = 0;
  let readRetried = false;
  let redirects = 0;

  for (;;) {
    const started = Date.now();
    const controller = new AbortController();
    // Always defined: `withAmbientCancellation` returns our own signal when
    // there is no ambient one, and a combination when there is.
    const signal = withAmbientCancellation(controller.signal) as AbortSignal;
    if (signal.aborted) {
      // Cancelled before this attempt left: nothing was sent, so this is
      // definitive even for a write.
      throw new AppleToolError('NETWORK_ERROR', `${req.service}: request cancelled by the caller.`);
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    debug(`→ ${method} ${url.origin}${url.pathname}`);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal,
        // Redirects are followed by hand so every hop is checked against the
        // allowlist BEFORE the Authorization header travels to it.
        redirect: 'manual',
      });
    } catch (err) {
      clearTimeout(timer);
      const timedOut = controller.signal.aborted;
      if (!timedOut && signal.aborted) {
        // Cancelled mid-flight: a write may already have reached Apple.
        if (!idempotent) {
          throw new UnconfirmedWriteError(
            req.service,
            `${req.service}: ${method} ${url.pathname} was cancelled by the caller while in flight; the change may have been applied.`,
            err,
          );
        }
        throw new AppleToolError('NETWORK_ERROR', `${req.service}: request cancelled by the caller.`, { cause: err });
      }
      const why = timedOut ? `timed out after ${timeoutMs} ms` : `could not connect (${scrub(errText(err))})`;
      debug(`✗ ${method} ${url.pathname} ${why}`);
      if (!idempotent) {
        throw new UnconfirmedWriteError(req.service, `${req.service}: ${method} ${url.pathname} ${why}; the change may have been applied.`, err);
      }
      if (!timedOut && !readRetried) {
        readRetried = true;
        continue;
      }
      throw new TransportError(req.service, timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', `${req.service}: ${method} ${url.pathname} ${why}.`, err);
    }

    // Same rule as a complete answer: only a definitive 4xx (other than 408)
    // proves a write did not land. A 2xx/3xx, a 5xx or a 408 may have.
    const mayHaveLanded = !idempotent && (res.status < 400 || res.status >= 500 || res.status === 408);
    let bytes: Uint8Array;
    try {
      bytes = await readBounded(res, MAX_RESPONSE_BYTES);
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof ResponseTooLarge) {
        const what = `${req.service}: response from ${url.pathname} is larger than ${MAX_RESPONSE_BYTES} bytes; refusing to read it`;
        if (mayHaveLanded) {
          throw new UnconfirmedWriteError(req.service, `${what} (HTTP ${res.status}); the change may have been applied.`);
        }
        throw new UpstreamError(req.service, res.status, `${what}.`);
      }
      const timedOut = controller.signal.aborted;
      const why = timedOut ? `timed out reading the response after ${timeoutMs} ms` : `lost the connection reading the response`;
      if (mayHaveLanded) {
        throw new UnconfirmedWriteError(req.service, `${req.service}: ${method} ${url.pathname} ${why}; the change may have been applied.`, err);
      }
      throw new TransportError(req.service, timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', `${req.service}: ${method} ${url.pathname} ${why}.`, err);
    }
    clearTimeout(timer);
    debug(`← ${res.status} ${method} ${url.pathname} (${Date.now() - started} ms, ${bytes.byteLength} B)`);
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location && res.status !== 304) {
      if (redirects >= MAX_REDIRECTS) {
        throw new UpstreamError(req.service, res.status, `${req.service}: too many redirects from ${url.pathname}.`);
      }
      redirects += 1;
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new UpstreamError(req.service, res.status, `${req.service}: ${url.pathname} redirected (HTTP ${res.status}) to a Location that is not a URL.`);
      }
      assertAllowedUrl(next, req.service);
      if (credentialFamily(next.hostname) !== credentialFamily(url.hostname)) {
        // A credential belongs to the service family it was issued for. Every
        // hop is an Apple host, but an iCloud password has no business reaching
        // Apple Music or Maps (or the reverse), so a hop that leaves the family
        // travels without the caller's credentials. Hops WITHIN a family keep
        // them: iCloud moves an account onto its partition host
        // (caldav.icloud.com → p42-caldav.icloud.com), and stripping the
        // password there would turn a redirect into a 401 that latches it.
        for (const h of Object.keys(headers)) {
          if (CREDENTIAL_HEADER_RE.test(h)) delete headers[h];
        }
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        // The body is gone, so its description must go too (fetch does the same).
        for (const h of Object.keys(headers)) {
          if (/^content-(type|length|encoding|language|location)$/i.test(h)) delete headers[h];
        }
      }
      url = next;
      continue;
    }
    const text = new TextDecoder().decode(bytes);
    const ok = (res.status >= 200 && res.status < 300) || (req.okStatuses?.includes(res.status) ?? false);

    if (!ok) {
      if (res.status === 429 && rateLimited < rateLimitRetries) {
        rateLimited += 1;
        await sleep(parseRetryAfterMs(res.headers.get('retry-after'), { defaultMs: 2000, capMs: 10_000 }));
        continue;
      }
      if (idempotent && RETRYABLE_READ_STATUSES.has(res.status) && !readRetried) {
        readRetried = true;
        await sleep(1000);
        continue;
      }
      // The service mapping runs (it may have side effects, like latching a
      // rejected credential), but it cannot override the one rule that is this
      // module's, not each caller's: a write whose outcome is unknown is
      // UnconfirmedWriteError. A mapping that turned a 500 on a PUT into a
      // plain UpstreamError would invite a blind retry — a duplicate event, a
      // second send.
      const custom = req.classifyError?.(res.status, text, res.headers);
      if (!idempotent && (res.status >= 500 || res.status === 408)) {
        const { message } = describeErrorBody(text);
        throw new UnconfirmedWriteError(
          req.service,
          scrub(`${req.service}: ${method} ${url.pathname} got HTTP ${res.status}${message ? ` — ${message}` : ''}; the change may have been applied.`),
        );
      }
      if (custom) throw custom;
      if (res.status === 429) {
        throw new UpstreamError(req.service, 429, `${req.service}: rate limited by Apple (HTTP 429) on ${url.pathname}.`, {
          hint: 'Apple is throttling requests. Wait a minute before retrying.',
        });
      }
      throw defaultError({ ...req, method }, url, res.status, text);
    }

    let data: unknown;
    const type = req.responseType ?? (/[/+]json\b/i.test(res.headers.get('content-type') ?? '') ? 'json' : 'text');
    if (type === 'json') {
      if (text.trim() === '') data = null;
      else {
        try {
          data = JSON.parse(text);
        } catch (err) {
          throw new UpstreamError(req.service, res.status, `${req.service}: ${url.pathname} returned a body that is not valid JSON.`, {
            hint: 'The upstream may be down or have changed. Retry later.',
          });
        }
      }
    } else if (type === 'text') {
      data = text;
    }
    return { status: res.status, headers: res.headers, url: res.url || url.toString(), data: data as T, text, bytes };
  }
}

/**
 * Refuse, BEFORE anything is sent, a header `fetch` would refuse (a newline
 * or a non-Latin-1 character in a value — say, a pasted token with a stray
 * line break). Left to `fetch`, the rejection looks like a failed connection:
 * a write would be reported as "may have been applied" when nothing left, and
 * undici's message quotes the VALUE, which may be the credential itself. This
 * names the header only.
 */
function assertSendableHeaders(headers: Record<string, string>, service: ServiceName): void {
  for (const [name, value] of Object.entries(headers)) {
    try {
      new Headers([[name, value]]);
    } catch {
      throw new AppleToolError('INVALID_ARGUMENT', `${service}: the ${name.replace(/[^\x21-\x7e]/g, '?')} request header has a value (or name) HTTP cannot carry; nothing was sent.`, {
        hint: 'A credential or setting probably contains a line break or a non-ASCII character. Re-enter it on one line.',
      });
    }
  }
}

/** Internal signal from `readBounded`: the body passed the cap (distinct from a lost connection). */
class ResponseTooLarge extends Error {}

/**
 * Read a response body, refusing — without buffering it — one larger than
 * `max` bytes. `arrayBuffer()` would hold a hostile or runaway body in memory
 * whole before any size check could run, so the declared `Content-Length` is
 * checked first and the stream is counted as it arrives (a compressed body's
 * decoded size is only knowable that way). A response object without a
 * readable stream (a test double) is read whole and then checked.
 */
async function readBounded(res: Response, max: number): Promise<Uint8Array> {
  const body = res.body as ReadableStream<Uint8Array> | null | undefined;
  // Only a response that HAS a body is judged by its declared length: a HEAD
  // (or 204/304) answer carries the Content-Length of a body it does not send.
  const declared = Number(res.headers.get('content-length') ?? '');
  if (body && Number.isFinite(declared) && declared > max) {
    await body.cancel().catch(() => undefined);
    throw new ResponseTooLarge();
  }
  if (!body || typeof body.getReader !== 'function') {
    const whole = new Uint8Array(await res.arrayBuffer());
    if (whole.byteLength > max) throw new ResponseTooLarge();
    return whole;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? `: ${cause.message}` : '';
    return `${err.message}${causeMsg}`;
  }
  return String(err);
}
