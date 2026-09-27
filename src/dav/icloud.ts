import { createHash } from 'node:crypto';
import type { EnvSource } from '@chrischall/mcp-utils';
import { UpstreamError, rememberSecret } from '../errors.js';
import { resolveICloudCredentials, type ICloudCredentials } from '../icloud-auth.js';
import { stateCache } from '../state.js';
import { DavClient, isICloudUrl, sameResource, type DavRequestFn } from './client.js';
import { NS, type DavMultistatus, type DavService } from './xml.js';

/**
 * iCloud CalDAV / CardDAV discovery: from the well-known root to the
 * account's home collection on its partition host.
 *
 *   PROPFIND https://caldav.icloud.com/        Depth 0  current-user-principal → /<dsid>/principal/
 *   PROPFIND https://caldav.icloud.com/<dsid>/principal/  Depth 0  calendar-home-set
 *            → https://pNN-caldav.icloud.com:443/<dsid>/calendars/
 *
 * (CardDAV: contacts.icloud.com, addressbook-home-set → …/<dsid>/carddavhome/.)
 * Depth MUST be 0 — iCloud answers the principal lookup with Depth 1 as 400.
 * The partition switch happens through the absolute home-set href; every
 * later href resolves against THAT host, which `DavResponse.url` already does.
 *
 * Discovery costs two round trips (~1.3 s), so its result is cached per
 * account in memory and on disk (`$MCP_DATA_DIR/.aws-mcp/dav-<kind>.json`,
 * 0600, bound to a digest of the username + app-specific password — rotate
 * either and the record is discarded). A disk record is re-checked with one
 * cheap PROPFIND before it is trusted; if the cached home is refused or gone,
 * discovery runs again once.
 *
 * The `<dsid>` in these paths is the account's numeric id; it is registered
 * with `rememberSecret` so it is scrubbed from every error and log.
 */

/** Where discovery starts. Not `icloud.com/.well-known/…`: that redirects to a 404 page. */
export const ICLOUD_DAV_ROOTS: Readonly<Record<DavService, string>> = {
  calendar: 'https://caldav.icloud.com/',
  contacts: 'https://contacts.icloud.com/',
};

const HOME_SET: Readonly<Record<DavService, readonly [string, string]>> = {
  calendar: [NS.CALDAV, 'calendar-home-set'],
  contacts: [NS.CARDDAV, 'addressbook-home-set'],
};

/** What discovery finds. Both are absolute URLs; `homeUrl` ends with `/`. */
export interface DavDiscovery {
  principalUrl: string;
  /** The calendar home (CalDAV) or address-book home (CardDAV), on the partition host. */
  homeUrl: string;
}

function firstUrl(ms: DavMultistatus, namespace: string, name: string): string | undefined {
  for (const r of ms.responses) {
    const url = r.props.urls(namespace, name)[0];
    if (url !== undefined) return url;
  }
  return undefined;
}

/** Register the numeric account id in a DAV path as a secret, so `scrub` removes it. */
function rememberAccountIn(url: string): void {
  const first = new URL(url).pathname.split('/').find((s) => s.length > 0);
  if (first !== undefined && /^\d+$/.test(first)) rememberSecret(first);
}

function rememberAccount(found: DavDiscovery): void {
  rememberAccountIn(found.principalUrl);
  rememberAccountIn(found.homeUrl);
}

/**
 * Run discovery with `client` (two PROPFINDs, Depth 0). Throws
 * `CredentialsRejectedError` when iCloud refuses the credentials (and latches
 * them), `UpstreamError` when an answer lacks the expected property — never a
 * guessed URL.
 */
export async function discover(client: DavClient, kind: DavService): Promise<DavDiscovery> {
  const root = await client.propfind(ICLOUD_DAV_ROOTS[kind], [[NS.DAV, 'current-user-principal']], 0);
  const principalUrl = firstUrl(root, NS.DAV, 'current-user-principal');
  if (principalUrl === undefined) {
    throw new UpstreamError(kind, 207, `${kind}: iCloud did not report a current-user-principal, so the account cannot be located.`, {
      hint: 'iCloud may be having trouble; retry shortly.',
    });
  }
  // Before the next request: its debug log line, and any error it raises,
  // carry the principal path — and the account id in it.
  rememberAccountIn(principalUrl);
  const [homeNs, homeName] = HOME_SET[kind];
  const principal = await client.propfind(principalUrl, [[homeNs, homeName]], 0);
  const homeHref = firstUrl(principal, homeNs, homeName);
  if (homeHref === undefined) {
    throw new UpstreamError(kind, 207, `${kind}: iCloud did not report a ${homeName} for this account.`, {
      hint:
        kind === 'calendar'
          ? 'Check that Calendars is turned on for this Apple ID in iCloud settings.'
          : 'Check that Contacts is turned on for this Apple ID in iCloud settings.',
    });
  }
  const home = new URL(homeHref);
  // The home host comes from the server; refuse anything outside iCloud
  // BEFORE it is cached (the client would also refuse it at request time).
  if (!isICloudUrl(home)) {
    throw new UpstreamError(kind, 207, `${kind}: iCloud reported a ${homeName} outside iCloud (${home.host}); refusing to use it.`, {
      hint: 'This is a safety check: credentials are only ever sent to https://*.icloud.com.',
    });
  }
  // A collection URL ends with a slash, so member names resolve inside it.
  if (!home.pathname.endsWith('/')) home.pathname += '/';
  const found = { principalUrl, homeUrl: home.href };
  rememberAccount(found);
  return found;
}

// ---------------------------------------------------------------------------
// Context (credentials → client → cached discovery)
// ---------------------------------------------------------------------------

/** A ready-to-use client for the account plus its discovered home. */
export interface DavContext extends DavDiscovery {
  client: DavClient;
  /** Where the home came from: this call's discovery, the in-process cache, or the disk cache. */
  source: 'discovered' | 'memory' | 'disk';
}

export interface DavContextDeps {
  /** Environment to read ICLOUD_USERNAME / ICLOUD_APP_PASSWORD (and the state-cache settings) from; default `process.env`. */
  env?: EnvSource;
  /** Request function for the client (default `httpRequest`); tests inject a fake. */
  request?: DavRequestFn;
}

type Located = { found: DavDiscovery; source: 'discovered' | 'disk' };

/** Per kind: account digest → discovery (in memory) and → discovery in progress. */
const memory: Record<DavService, Map<string, DavDiscovery>> = { calendar: new Map(), contacts: new Map() };
const inflight: Record<DavService, Map<string, Promise<Located>>> = { calendar: new Map(), contacts: new Map() };

function accountDigest(kind: DavService, creds: ICloudCredentials): string {
  return createHash('sha256').update(`dav\u0000${kind}\u0000${creds.username}\u0000${creds.password}`).digest('hex');
}

function isCachedUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return isICloudUrl(url);
}

/**
 * Accept a disk record only when both URLs are https on `*.icloud.com` — a
 * tampered file must not be able to point the Authorization header anywhere.
 */
export function validateDiscovery(raw: unknown): DavDiscovery | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { principalUrl, homeUrl } = raw as Record<string, unknown>;
  if (!isCachedUrl(principalUrl) || !isCachedUrl(homeUrl) || !homeUrl.endsWith('/')) return null;
  return { principalUrl, homeUrl };
}

function diskCache(kind: DavService, digest: string, env: EnvSource) {
  return stateCache<DavDiscovery>(`dav-${kind}.json`, digest, validateDiscovery, env);
}

/**
 * The `DavClient` for `kind` built from ICLOUD_USERNAME / ICLOUD_APP_PASSWORD
 * (read now — `ConfigError` when unset), plus the account's home URL.
 *
 * Discovery is cached per (kind, username, password digest). A 401 or a
 * bare 403 on any later request through the returned client — or a 404/410
 * for the home itself — drops the cache, so the next call rediscovers (and,
 * if the credentials really are bad, latches them on the discovery host).
 * Concurrent first calls share one discovery.
 */
export async function getDavContext(kind: DavService, deps: DavContextDeps = {}): Promise<DavContext> {
  const env = deps.env ?? process.env;
  const creds = resolveICloudCredentials(kind, env);
  const digest = accountDigest(kind, creds);
  const cache = diskCache(kind, digest, env);
  let home: string | undefined;
  const client = new DavClient({
    service: kind,
    ...creds,
    ...(deps.request ? { request: deps.request } : {}),
    // A refusal, or the home itself answering 404/410: drop the cached
    // discovery so the next call finds the account afresh.
    onRefused: (status, url) => {
      if (status === 401 || status === 403 || (home !== undefined && sameResource(url, home))) {
        memory[kind].delete(digest);
        cache.clear();
      }
    },
  });

  const known = memory[kind].get(digest);
  if (known) {
    home = known.homeUrl;
    rememberAccount(known);
    return { client, ...known, source: 'memory' };
  }

  let pending = inflight[kind].get(digest);
  if (!pending) {
    pending = locate(client, kind, cache).finally(() => inflight[kind].delete(digest));
    inflight[kind].set(digest, pending);
  }
  const { found, source } = await pending;
  home = found.homeUrl;
  memory[kind].set(digest, found);
  return { client, ...found, source };
}

async function locate(
  client: DavClient,
  kind: DavService,
  cache: ReturnType<typeof diskCache>,
): Promise<Located> {
  const stored = cache.load();
  if (stored) {
    rememberAccount(stored);
    const check = await client.probe(stored.homeUrl);
    if (check.ok) return { found: stored, source: 'disk' };
    // Refused (401/403) or gone (404/410): the cached home is stale — rediscover once.
    cache.clear();
  }
  const found = await discover(client, kind);
  cache.save(found);
  return { found, source: 'discovered' };
}

/**
 * Forget cached discovery for one kind or both: the in-memory entries and,
 * unless `memoryOnly`, the disk record of the account the environment names.
 * For callers that learn a home is gone; `memoryOnly` simulates a restart in
 * tests.
 */
export function forgetDavContext(kind?: DavService, opts: { env?: EnvSource; memoryOnly?: boolean } = {}): void {
  const env = opts.env ?? process.env;
  const kinds: DavService[] = kind ? [kind] : ['calendar', 'contacts'];
  for (const k of kinds) {
    memory[k].clear();
    inflight[k].clear();
    if (opts.memoryOnly) continue;
    let creds: ICloudCredentials;
    try {
      creds = resolveICloudCredentials(k, env);
    } catch {
      continue; // no credentials → no disk record to find
    }
    diskCache(k, accountDigest(k, creds), env).clear();
  }
}
