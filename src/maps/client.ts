import { createHash } from 'node:crypto';
import { createCachedTokenSource, type CachedTokenSource } from '@chrischall/mcp-utils';
import { z } from 'zod';
import { mintMapsAuthToken, resolveDeveloperKey, type DeveloperKey } from '../apple-keys.js';
import { CredentialsRejectedError, UpstreamError, rememberSecret, scrub } from '../errors.js';
import { describeErrorBody, httpRequest, type HttpRequest, type HttpResponse, type QueryValue } from '../http.js';

/**
 * Apple Maps Server API client.
 *
 * Auth is a two-step dance (research: apple-dev-apis.md §1.2–1.3):
 *  1. sign a short-lived ES256 "maps auth token" (`scope: server_api`) with
 *     the developer key;
 *  2. exchange it at `GET /v1/token` for a ~30-minute ACCESS token, which is
 *     the only credential the data endpoints accept (the auth JWT itself is
 *     refused there).
 *
 * The access token is cached until 60 s before its expiry. The cache is
 * bound to a fingerprint of the key that minted it, so a different
 * `APPLE_TEAM_ID` / key id / private key (the environment is read on every
 * call, never at import) never reuses a token minted from the old one.
 *
 * A 401 from a data endpoint invalidates the cached access token (unless a
 * concurrent call already replaced it), exchanges a fresh one and replays the
 * request ONCE; a second 401 is reported.
 */

export const MAPS_API_BASE = 'https://maps-api.apple.com';

/** Refresh the access token this long before Apple says it expires. */
export const TOKEN_REFRESH_BUFFER_MS = 60_000;

/** Lifetime assumed when `/v1/token` omits `expiresInSeconds` (Apple documents 1800). */
export const DEFAULT_ACCESS_TOKEN_TTL_S = 1800;

export type RequestFn = <T = unknown>(req: HttpRequest) => Promise<HttpResponse<T>>;

export const TOKEN_REJECTED_HINT =
  'Apple refused the Maps auth token. Check APPLE_TEAM_ID is your 10-character Team ID, that the key id ' +
  '(APPLE_MAPS_KEY_ID or APPLE_KEY_ID) matches the private key, that the key has MapKit JS enabled and is ' +
  'configured with a Maps ID, and that it has not been revoked.';

export const ACCESS_REJECTED_HINT =
  'Apple Maps refused the access token even after a fresh one was exchanged (this is retried once automatically). ' +
  'The key may have been revoked or lost its MapKit JS / Maps ID association.';

export const FORBIDDEN_HINT =
  'Apple Maps refused this request for the key. Check the key has MapKit JS enabled and is configured with a Maps ID.';

export const QUOTA_HINT =
  'Apple allows 25,000 Maps Server API calls per day per developer team, shared with MapKit JS. ' +
  'Wait before retrying; if this keeps happening the daily quota is exhausted.';

/** Apple's error body: `{"error":{"message":"…","details":["…"]}}` (live), or the documented bare `{message, details}`. */
export function mapsErrorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') {
      const outer = parsed as Record<string, unknown>;
      const inner = (outer.error && typeof outer.error === 'object' ? outer.error : outer) as Record<string, unknown>;
      const message = typeof inner.message === 'string' ? inner.message : '';
      const details = Array.isArray(inner.details)
        ? inner.details.filter((d): d is string => typeof d === 'string' && d.length > 0)
        : [];
      if (message || details.length) {
        return details.length ? `${message}${message ? ' ' : ''}(${details.join('; ')})` : message;
      }
    }
  } catch {
    // not JSON — fall through
  }
  return describeErrorBody(text).message;
}

/**
 * Error mapping for a Maps request, consulted by `httpRequest` for every
 * non-2xx answer before its defaults.
 */
export function classifyMapsError(method: string, path: string, phase: 'token' | 'data') {
  return (status: number, text: string): Error | undefined => {
    const detail = mapsErrorDetail(text);
    const what = scrub(`maps: ${method} ${path} failed with HTTP ${status}${detail ? ` — ${detail}` : ''}`);
    if (status === 401 || status === 403) {
      const hint = phase === 'token' ? TOKEN_REJECTED_HINT : status === 401 ? ACCESS_REJECTED_HINT : FORBIDDEN_HINT;
      return new CredentialsRejectedError('maps', status, what, hint);
    }
    if (status === 400) {
      return new UpstreamError('maps', 400, what, {
        code: 'INVALID_ARGUMENT',
        hint: 'Apple Maps rejected a request parameter. Check the addresses, coordinates, categories, country codes and dates.',
      });
    }
    if (status === 404) {
      return new UpstreamError('maps', 404, what, {
        hint: 'Apple Maps found nothing for this request. Check the place ids, addresses or coordinates.',
      });
    }
    if (status === 429) return new UpstreamError('maps', 429, what, { hint: QUOTA_HINT });
    return undefined;
  };
}

const TokenResponseSchema = z.looseObject({
  accessToken: z.string().min(1),
  expiresInSeconds: z.number().positive().optional(),
});

export interface ExchangedToken {
  accessToken: string;
  expiresInSeconds: number;
}

/**
 * Mint a Maps auth token from `key` and exchange it at `GET /v1/token`.
 * Both tokens are registered with `rememberSecret` before anything can echo them.
 */
export async function exchangeMapsToken(key: DeveloperKey, request: RequestFn, now: number): Promise<ExchangedToken> {
  const auth = mintMapsAuthToken(key, now);
  rememberSecret(auth.token);
  const res = await request({
    service: 'maps',
    method: 'GET',
    url: `${MAPS_API_BASE}/v1/token`,
    headers: { Authorization: `Bearer ${auth.token}` },
    responseType: 'json',
    classifyError: classifyMapsError('GET', '/v1/token', 'token'),
  });
  const parsed = TokenResponseSchema.safeParse(res.data);
  if (!parsed.success) {
    throw new UpstreamError('maps', res.status, 'maps: GET /v1/token answered without a usable accessToken.', {
      hint: 'The Apple Maps token endpoint may have changed or be degraded. Retry later.',
    });
  }
  rememberSecret(parsed.data.accessToken);
  return {
    accessToken: parsed.data.accessToken,
    expiresInSeconds: parsed.data.expiresInSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_S,
  };
}

/** Identity of a key for cache binding — a digest, never the key itself. */
export function keyFingerprint(key: DeveloperKey): string {
  return createHash('sha256').update(`${key.teamId}\n${key.keyId}\n${key.privateKeyPem}`).digest('base64url');
}

export interface MapsClientOptions {
  /** Resolve the developer key; default `resolveDeveloperKey('maps')` against the live environment. */
  resolveKey?: () => DeveloperKey;
  /** The HTTP function; default `httpRequest`. */
  request?: RequestFn;
  /** Clock; default `Date.now`. */
  now?: () => number;
}

export interface MapsGetResult<T> {
  status: number;
  data: T;
}

export class MapsClient {
  private readonly resolveKeyFn: () => DeveloperKey;
  private readonly request: RequestFn;
  readonly now: () => number;
  private cache: { fingerprint: string; source: CachedTokenSource } | undefined;

  constructor(opts: MapsClientOptions = {}) {
    this.resolveKeyFn = opts.resolveKey ?? (() => resolveDeveloperKey('maps'));
    this.request = opts.request ?? httpRequest;
    this.now = opts.now ?? Date.now;
  }

  /** The developer key, resolved NOW from the environment (throws `ConfigError`). */
  key(): DeveloperKey {
    return this.resolveKeyFn();
  }

  private tokenSource(key: DeveloperKey): CachedTokenSource {
    const fingerprint = keyFingerprint(key);
    if (!this.cache || this.cache.fingerprint !== fingerprint) {
      const source = createCachedTokenSource({
        mint: async () => {
          const t = await exchangeMapsToken(key, this.request, this.now());
          return { token: t.accessToken, ttlMs: t.expiresInSeconds * 1000 };
        },
        bufferMs: TOKEN_REFRESH_BUFFER_MS,
        now: this.now,
      });
      this.cache = { fingerprint, source };
    }
    return this.cache.source;
  }

  /** A currently valid access token (cached, or freshly exchanged). */
  async accessToken(): Promise<string> {
    return this.tokenSource(this.key()).getToken();
  }

  /**
   * `GET <path>` on the Maps Server API with the access token; on a 401 the
   * token is re-exchanged and the request replayed once.
   */
  async get<T = unknown>(path: string, query: Record<string, QueryValue> = {}): Promise<MapsGetResult<T>> {
    const source = this.tokenSource(this.key());
    const send = async (token: string): Promise<MapsGetResult<T>> => {
      const res = await this.request<T>({
        service: 'maps',
        method: 'GET',
        url: `${MAPS_API_BASE}${path}`,
        query,
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'json',
        classifyError: classifyMapsError('GET', path, 'data'),
      });
      return { status: res.status, data: res.data };
    };
    // Outside the try: a refusal at /v1/token is a key problem, and re-running
    // the exchange would only repeat it.
    const token = await source.getToken();
    try {
      return await send(token);
    } catch (err) {
      if (!(err instanceof CredentialsRejectedError) || err.status !== 401) throw err;
      // Drop the token only if it is still the one Apple refused. When several
      // calls hit the same expiry together, the first to get here re-exchanges;
      // the rest must replay with ITS token, not invalidate it and exchange
      // again (each exchange is a call against the shared daily quota).
      let fresh = await source.getToken();
      if (fresh === token) {
        source.invalidate();
        fresh = await source.getToken();
      }
      return send(fresh);
    }
  }
}
