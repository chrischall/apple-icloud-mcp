import { httpRequest, type HttpRequest, type HttpResponse } from '../http.js';
import { AppleToolError, CredentialsRejectedError, InvalidArgumentError, UpstreamError, rememberSecret } from '../errors.js';
import { REJECTED_HINT, assertNotLatched, latchRejection, type ICloudCredentials } from '../icloud-auth.js';
import { VERSION } from '../version.js';
import {
  NS,
  davErrorConditions,
  parseMultistatus,
  propfindBody,
  safeDecode,
  type DavMultistatus,
  type DavService,
  type PropRef,
} from './xml.js';

export type { DavService } from './xml.js';

/**
 * A small WebDAV client for iCloud CalDAV / CardDAV, on the shared
 * `httpRequest` chokepoint (host allowlist, timeouts, bounded retries, and
 * `UnconfirmedWriteError` for a write whose outcome is unknown).
 *
 * What it adds on top:
 *  - HTTP Basic auth built per request from the app-specific password — the
 *    header value is registered with `rememberSecret`, so it is scrubbed from
 *    every error and log, and it is never logged.
 *  - The credential latch: `assertNotLatched` before every request, and
 *    `latchRejection` on a DEFINITIVE rejection (see `classify`), so a stale
 *    password is not re-sent on every call — repeated failures can lock an
 *    Apple ID.
 *  - WebDAV status semantics: 207 is success and its body is always parsed
 *    (an unreadable body is an error, never an empty listing); 412 on a
 *    conditional write is a typed `PreconditionFailedError`; a `<DAV:error>`
 *    body's condition names (`need-privileges`, `valid-sync-token`, …) are
 *    surfaced as `UpstreamError.upstreamCode`.
 *
 * URLs are absolute. Build them from `DavResponse.url` / `DavProps.urls()`
 * (already resolved against the host that produced them — the partition
 * host, not the discovery host) or `childUrl`. The client refuses any URL
 * that is not `https://*.icloud.com` before the credential is attached, and
 * `httpRequest` re-checks every redirect hop against its Apple allowlist.
 */

/** The request function the client sends through (default `httpRequest`); tests inject a fake. */
export type DavRequestFn = (req: HttpRequest) => Promise<HttpResponse<unknown>>;

export interface DavClientOptions {
  service: DavService;
  /** Apple ID email. */
  username: string;
  /** App-specific password. */
  password: string;
  /** Defaults to `httpRequest`. */
  request?: DavRequestFn;
  /**
   * Called with the status and URL when iCloud answers 401, or 403/404/410
   * without a `<DAV:error>` body — a hint that cached discovery may be stale.
   * `getDavContext` uses it to drop its cache (on a refusal, or when the home
   * itself is gone) so the next call rediscovers. Never called by `probe`.
   */
  onRefused?: (status: number, url: string) => void;
}

/** Content type for `put` of an iCalendar (`.ics`) resource. */
export const ICALENDAR_CONTENT_TYPE = 'text/calendar; charset=utf-8';
/** Content type for `put` of a vCard (`.vcf`) resource. */
export const VCARD_CONTENT_TYPE = 'text/vcard; charset=utf-8';
const XML_CONTENT_TYPE = 'application/xml; charset=utf-8';

/**
 * iCloud's discovery hosts. A bare 403 here is a credential rejection (iCloud
 * answers 403 instead of 401 for a username outside Apple's mail domains).
 * Elsewhere a 403 more often means "read-only calendar" or throttling, and
 * latching the credential on it would lock the user out of everything.
 */
export const DAV_DISCOVERY_HOSTS: ReadonlySet<string> = new Set(['caldav.icloud.com', 'contacts.icloud.com']);

/** Which conditional request header a 412 answer refused. */
export type DavPrecondition = 'if-match' | 'if-none-match' | 'overwrite';

/**
 * A conditional write was refused with 412 — nothing was written. Branch on
 * `preconditions`: `if-match` means the item CHANGED since it was read (re-read
 * and retry); `if-none-match` means it ALREADY EXISTS; `overwrite` means a
 * MOVE destination already exists.
 */
export class PreconditionFailedError extends UpstreamError {
  readonly preconditions: readonly DavPrecondition[];
  constructor(service: DavService, what: string, preconditions: readonly DavPrecondition[]) {
    const reasons: string[] = [];
    if (preconditions.includes('if-match')) reasons.push('it changed on iCloud since it was read (its ETag no longer matches)');
    if (preconditions.includes('if-none-match')) reasons.push('it already exists on iCloud');
    if (preconditions.includes('overwrite')) reasons.push('the destination already exists');
    super(service, 412, `${service}: ${what} was refused because ${reasons.join(', or ')}; nothing was changed.`, {
      hint: preconditions.includes('if-match')
        ? 'Re-read the item to get its current content and ETag, then retry the change.'
        : 'Read the existing item instead of creating it again, or use a different name.',
    });
    this.name = 'PreconditionFailedError';
    this.preconditions = preconditions;
  }
}

export interface DavGetResult {
  body: string;
  /** The ETag exactly as sent (quotes included) — pass it back as `ifMatch`. */
  etag?: string;
  contentType?: string;
}

export interface DavWriteResult {
  status: number;
  /** The new ETag, when the server sent one (iCloud may omit it on create — GET it back then). */
  etag?: string;
}

/** Result of `probe`: reachable, or the refusal status. */
export type DavProbeResult = { ok: true } | { ok: false; status: number };

/** Thrown inside a probe's classifier so the probe can answer instead of latching. */
class ProbeRefused extends Error {
  constructor(readonly status: number) {
    super(`probe refused with HTTP ${status}`);
  }
}

const PROBE_REFUSALS = new Set([401, 403, 404, 410]);

interface SendOptions {
  headers?: Record<string, string>;
  body?: string;
  /** Conditional headers this request carries (a 412 then means one of them failed). */
  conditions?: DavPrecondition[];
  /** Answer 401/403/404/410 with `ProbeRefused` instead of latching/throwing. */
  probe?: boolean;
}

function toUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new InvalidArgumentError('A DAV request needs an absolute URL.');
  }
}

/**
 * The Basic credential goes to iCloud and nowhere else. `httpRequest`'s
 * allowlist admits every Apple host this server uses (Apple Music, Maps…);
 * an iCloud href pointing at one of those must still not receive the
 * app-specific password.
 */
export function isICloudUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return url.protocol === 'https:' && host.endsWith('.icloud.com') && host.length > '.icloud.com'.length;
}

/**
 * Normalise an ETag for `If-Match`: kept verbatim when quoted, quoted when
 * bare, `*` ("any current version") passed through, refused when unsafe. The
 * characters allowed are RFC 7232's `etagc` (visible ASCII except `"`, plus
 * obs-text 0x80–0xFF): anything else cannot be sent as a header at all —
 * `fetch` rejects it before the request leaves, and on a write that would be
 * misreported as "may have been applied".
 */
function etagHeader(etag: string): string {
  const v = etag.trim();
  if (v === '*') return v;
  if (/^(?:W\/)?"[\x21\x23-\x7E\x80-\xFF]*"$/.test(v)) return v;
  if (/^[\x21\x23-\x7E\x80-\xFF]+$/.test(v)) return `"${v}"`;
  throw new InvalidArgumentError('That ETag is not a valid entity tag; use the etag value returned by a read.');
}

function depthHeader(depth: number): string {
  if (depth !== 0 && depth !== 1) throw new InvalidArgumentError('A DAV Depth must be 0 or 1.');
  return String(depth);
}

function conditionHint(conditions: string[]): string | undefined {
  if (conditions.includes('need-privileges')) {
    return 'Your account lacks permission for this change — the calendar or address book is probably shared read-only or subscribed.';
  }
  if (conditions.includes('valid-sync-token')) return 'The sync token has expired; list the collection again from scratch.';
  if (conditions.some((c) => c === 'no-uid-conflict' || c === 'uid-conflict')) {
    return 'An item with the same UID already exists (possibly in another calendar).';
  }
  return undefined;
}

/**
 * One account's WebDAV client. Usually obtained from `getDavContext(kind)`
 * (icloud.ts), which also supplies the discovered home URL:
 *
 * ```ts
 * const { client, homeUrl } = await getDavContext('calendar');
 * const listing = await client.propfind(homeUrl, [[NS.DAV, 'displayname'], [NS.DAV, 'resourcetype']], 1);
 * for (const r of listing.responses) {
 *   if (sameResource(r.url, homeUrl)) continue; // the home lists itself
 *   r.props.text(NS.DAV, 'displayname');
 * }
 * const events = await client.report(calendarUrl, calendarQueryBody({ timeRange: { start, end } }), 1);
 * const { body, etag } = await client.get(eventUrl);
 * await client.put(eventUrl, ics, ICALENDAR_CONTENT_TYPE, { ifMatch: etag }); // 412 → PreconditionFailedError
 * ```
 *
 * Every method throws the foundation errors (`CredentialsRejectedError`,
 * `UpstreamError` — `code` NOT_FOUND for 404 —, `TransportError`,
 * `UnconfirmedWriteError` for a write with an unknown outcome,
 * `InvalidArgumentError`) and never resolves an error as an empty result.
 */
export class DavClient {
  readonly service: DavService;
  readonly username: string;
  // ECMAScript-private: never enumerable, so a client that ends up inside a
  // logged or serialised object cannot carry the credential with it.
  readonly #creds: ICloudCredentials;
  readonly #authorization: string;
  readonly #request: DavRequestFn;
  readonly #onRefused: ((status: number, url: string) => void) | undefined;

  constructor(opts: DavClientOptions) {
    this.service = opts.service;
    this.username = opts.username;
    this.#creds = { username: opts.username, password: opts.password };
    const token = Buffer.from(`${opts.username}:${opts.password}`, 'utf8').toString('base64');
    rememberSecret(opts.password);
    rememberSecret(token);
    this.#authorization = `Basic ${token}`;
    this.#request = opts.request ?? httpRequest;
    this.#onRefused = opts.onRefused;
  }

  /**
   * PROPFIND `url` at `depth` for `props` (a list of property names, or a
   * complete XML body). Depth 0 = the resource itself; 1 = it and its
   * direct members. Resolves with the parsed 207 answer.
   */
  async propfind(url: string, props: string | readonly PropRef[], depth: 0 | 1): Promise<DavMultistatus> {
    const body = typeof props === 'string' ? props : propfindBody(props);
    return this.multistatus('PROPFIND', url, body, depth);
  }

  /** REPORT `url` with a body from the xml.ts builders (calendar-query, multiget, sync-collection, …). */
  async report(url: string, body: string, depth: 0 | 1): Promise<DavMultistatus> {
    return this.multistatus('REPORT', url, body, depth);
  }

  /** GET a resource (an `.ics` or `.vcf`). A missing one is `UpstreamError` code NOT_FOUND (status 404). */
  async get(url: string): Promise<DavGetResult> {
    const res = await this.send('GET', url, {});
    const etag = res.headers.get('etag');
    const contentType = res.headers.get('content-type');
    return { body: res.text, ...(etag ? { etag } : {}), ...(contentType ? { contentType } : {}) };
  }

  /**
   * PUT a whole resource. Create with `ifNoneMatch: '*'` (412 → it already
   * exists); update with `ifMatch: <etag from the read>` (412 → it changed
   * since). Never retried: an unknown outcome is `UnconfirmedWriteError`.
   */
  async put(
    url: string,
    body: string,
    contentType: string,
    opts: { ifMatch?: string; ifNoneMatch?: '*' } = {},
  ): Promise<DavWriteResult> {
    const headers: Record<string, string> = { 'Content-Type': contentType };
    const conditions: DavPrecondition[] = [];
    if (opts.ifMatch !== undefined) {
      headers['If-Match'] = etagHeader(opts.ifMatch);
      conditions.push('if-match');
    }
    if (opts.ifNoneMatch !== undefined) {
      if (opts.ifNoneMatch !== '*') throw new InvalidArgumentError('ifNoneMatch only supports "*".');
      headers['If-None-Match'] = '*';
      conditions.push('if-none-match');
    }
    const res = await this.send('PUT', url, { headers, body, conditions });
    const etag = res.headers.get('etag');
    return { status: res.status, ...(etag ? { etag } : {}) };
  }

  /**
   * DELETE a resource, optionally only if it is unchanged (`ifMatch`; 412 → it
   * changed since). A `207 Multi-Status` answer means some members could NOT
   * be deleted (RFC 4918 §9.6.1) and is thrown as an `UpstreamError`, never
   * reported as success.
   */
  async delete(url: string, opts: { ifMatch?: string } = {}): Promise<{ status: number }> {
    const headers: Record<string, string> = {};
    const conditions: DavPrecondition[] = [];
    if (opts.ifMatch !== undefined) {
      headers['If-Match'] = etagHeader(opts.ifMatch);
      conditions.push('if-match');
    }
    const res = await this.send('DELETE', url, { headers, conditions });
    this.refusePartial('DELETE', url, res.status);
    return { status: res.status };
  }

  /**
   * MOVE a resource to `destinationUrl` on the same host (e.g. an event to
   * another calendar — iCloud refuses the same UID in two calendars, so a
   * copy cannot work). `overwrite` defaults to false: an existing
   * destination is a 412 `PreconditionFailedError`, never clobbered. A
   * `207 Multi-Status` answer (only part of it moved) is an `UpstreamError`.
   */
  async move(
    url: string,
    destinationUrl: string,
    opts: { overwrite?: boolean; ifMatch?: string } = {},
  ): Promise<{ status: number }> {
    const source = toUrl(url);
    const destination = toUrl(destinationUrl);
    if (destination.origin !== source.origin) {
      throw new InvalidArgumentError('A MOVE destination must be on the same host as the source.');
    }
    const overwrite = opts.overwrite ?? false;
    const headers: Record<string, string> = { Destination: destination.href, Overwrite: overwrite ? 'T' : 'F' };
    const conditions: DavPrecondition[] = overwrite ? [] : ['overwrite'];
    if (opts.ifMatch !== undefined) {
      headers['If-Match'] = etagHeader(opts.ifMatch);
      conditions.push('if-match');
    }
    const res = await this.send('MOVE', url, { headers, conditions });
    this.refusePartial('MOVE', url, res.status);
    return { status: res.status };
  }

  /**
   * A 207 is success only for PROPFIND/REPORT. On DELETE or MOVE it carries
   * per-member failures (RFC 4918 §9.6.1, §9.9.4): part of the change may have
   * happened and part did not, so it must not be reported as done.
   */
  private refusePartial(method: string, url: string, status: number): void {
    if (status !== 207) return;
    const path = toUrl(url).pathname;
    throw new UpstreamError(
      this.service,
      207,
      `${this.service}: ${method} ${path} was only partly carried out — iCloud answered 207 Multi-Status, listing members it could not ${method === 'MOVE' ? 'move' : 'delete'}.`,
      { hint: 'Part of the change may have been applied. Re-read the item or collection to see its current state before retrying.' },
    );
  }

  /**
   * PROPFIND Depth 0 `url` for its resourcetype and report whether it is
   * reachable. Unlike every other method, a 401/403/404/410 is ANSWERED
   * (`{ok: false, status}`) rather than thrown and does NOT latch the
   * credentials — it exists to validate a cached URL before trusting it
   * (`getDavContext` rediscovers once on a refusal, and discovery's own
   * requests latch). Do not use it to retry a rejected credential.
   */
  async probe(url: string): Promise<DavProbeResult> {
    try {
      await this.multistatus('PROPFIND', url, propfindBody([[NS.DAV, 'resourcetype']]), 0, true);
      return { ok: true };
    } catch (err) {
      if (err instanceof ProbeRefused) return { ok: false, status: err.status };
      throw err;
    }
  }

  private async multistatus(method: string, url: string, body: string, depth: 0 | 1, probe = false): Promise<DavMultistatus> {
    const headers = { Depth: depthHeader(depth), 'Content-Type': XML_CONTENT_TYPE, Prefer: 'return=minimal' };
    const res = await this.send(method, url, { headers, body, probe });
    const parsed = parseMultistatus(res.text, { baseUrl: res.url, service: this.service, status: res.status });
    if (parsed.skipped > 0) {
      console.error(
        `[apple-icloud-mcp] WARNING: ${this.service}: a ${method} answer held ${parsed.skipped} malformed <response> element(s); they were ignored.`,
      );
    }
    return parsed;
  }

  private send(method: string, url: string, opts: SendOptions): Promise<HttpResponse<unknown>> {
    const target = toUrl(url);
    if (!isICloudUrl(target)) {
      throw new AppleToolError(
        'UPSTREAM_ERROR',
        `${this.service}: refusing to send iCloud credentials to ${target.protocol}//${target.hostname} — only https://*.icloud.com is allowed.`,
        { hint: 'This is a safety check: a DAV URL pointed outside iCloud.' },
      );
    }
    assertNotLatched(this.#creds, this.service);
    return this.#request({
      service: this.service,
      method,
      url: target,
      headers: { Authorization: this.#authorization, 'User-Agent': `apple-icloud-mcp/${VERSION}`, ...opts.headers },
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      responseType: 'text',
      classifyError: (status, text) => this.classify(method, target, status, text, opts),
    });
  }

  /**
   * Map a failed status to an error, or undefined for `httpRequest`'s default
   * mapping (which keeps 5xx/timeouts on writes as `UnconfirmedWriteError`).
   *
   *  - 401 → latch + `CredentialsRejectedError` (iCloud authenticates the same
   *    Apple ID on every host, so a 401 anywhere is definitive).
   *  - 403 with a `<DAV:error>` body → `UpstreamError` naming the condition
   *    (`need-privileges`: a read-only calendar), never a latch.
   *  - bare 403 on a discovery host → latch + `CredentialsRejectedError`
   *    (iCloud's answer for a non-Apple-domain username with a bad password).
   *  - bare 403 elsewhere → `UpstreamError` (read-only collection or
   *    throttling), never a latch; `onRefused` lets cached discovery be
   *    re-checked — rediscovery goes through a discovery host, where bad
   *    credentials DO latch.
   *  - 412 on a conditional request → `PreconditionFailedError`.
   *
   * `onRefused` fires for 401 and for a bare 403/404/410.
   */
  private classify(method: string, url: URL, status: number, text: string, opts: SendOptions): Error | undefined {
    const what = `${method} ${url.pathname}`;
    if (opts.probe && PROBE_REFUSALS.has(status)) return new ProbeRefused(status);
    // 408 is left to httpRequest whatever its body says: on a write it means
    // the outcome is unknown (`UnconfirmedWriteError`), never a definitive no.
    const conditions = status >= 400 && status < 500 && status !== 408 ? davErrorConditions(text) : [];
    if (status === 401 || (PROBE_REFUSALS.has(status) && conditions.length === 0)) this.#onRefused?.(status, url.href);
    if (status === 401) {
      latchRejection(this.#creds);
      return new CredentialsRejectedError(
        this.service,
        401,
        `${this.service}: iCloud rejected the Apple ID / app-specific password (HTTP 401 on ${what}).`,
        REJECTED_HINT,
      );
    }
    if (status === 412 && opts.conditions && opts.conditions.length > 0) {
      return new PreconditionFailedError(this.service, what, opts.conditions);
    }
    if (status === 403 && conditions.length === 0) {
      if (DAV_DISCOVERY_HOSTS.has(url.hostname.toLowerCase())) {
        latchRejection(this.#creds);
        return new CredentialsRejectedError(
          this.service,
          403,
          `${this.service}: iCloud rejected the Apple ID / app-specific password (HTTP 403 on ${what}).`,
          REJECTED_HINT,
        );
      }
      return new UpstreamError(this.service, 403, `${this.service}: iCloud refused ${what} (HTTP 403).`, {
        hint:
          'The calendar or address book may be read-only (shared or subscribed), or iCloud may be throttling — retry in a ' +
          'minute. If every request fails this way, check ICLOUD_USERNAME and ICLOUD_APP_PASSWORD.',
      });
    }
    if (conditions.length > 0) {
      const hint = conditionHint(conditions);
      return new UpstreamError(this.service, status, `${this.service}: iCloud refused ${what} (HTTP ${status}: ${conditions.join(', ')}).`, {
        upstreamCode: conditions[0] as string,
        ...(hint ? { hint } : {}),
      });
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function comparable(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  return `${u.protocol}//${u.host.toLowerCase()}${safeDecode(u.pathname).replace(/\/+$/, '')}`;
}

/**
 * Whether two absolute URLs name the same resource: same origin (default
 * port ignored), same decoded path, trailing slash ignored. Use it to skip
 * the collection's own entry in a Depth 1 PROPFIND or a REPORT (iCloud lists
 * it among the results).
 */
export function sameResource(a: string, b: string): boolean {
  const x = comparable(a);
  return x !== undefined && x === comparable(b);
}

/**
 * The last path segment of a URL, percent-decoded, ignoring a trailing
 * slash: `…/calendars/home/` → `home`, `…/card/ABC.vcf` → `ABC.vcf`.
 * Empty for the root.
 */
export function lastPathSegment(url: string): string {
  const segments = toUrl(url).pathname.split('/').filter((s) => s.length > 0);
  return safeDecode(segments[segments.length - 1] ?? '');
}

/**
 * The URL of member `name` inside collection `parentUrl` (percent-encoded;
 * a collection gets a trailing slash). Refuses a name that could escape the
 * collection (`''`, `.`, `..`, or containing `/`) — ids arrive from tool
 * arguments, and `new URL('..', parent)` would happily walk up the tree.
 * Prefer a server-supplied `DavResponse.url` for resources that exist.
 */
export function childUrl(parentUrl: string, name: string, opts: { collection?: boolean } = {}): string {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new InvalidArgumentError(`"${name}" is not a valid item name.`);
  }
  const parent = toUrl(parentUrl);
  if (!parent.pathname.endsWith('/')) parent.pathname += '/';
  parent.search = '';
  parent.hash = '';
  return new URL(encodeURIComponent(name) + (opts.collection ? '/' : ''), parent).href;
}
