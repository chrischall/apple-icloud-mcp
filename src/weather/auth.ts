import { createHash } from 'node:crypto';
import { createCachedTokenSource, readEnvVar, type CachedTokenSource, type EnvSource } from '@chrischall/mcp-utils';
import { mintWeatherKitToken, resolveDeveloperKey, type DeveloperKey } from '../apple-keys.js';
import { ConfigError, rememberSecret } from '../errors.js';

/**
 * WeatherKit REST credentials.
 *
 * WeatherKit takes the developer JWT DIRECTLY as the bearer (no exchange, unlike
 * Maps), and that JWT names a Services ID twice — the non-standard `id` header
 * (`<TeamID>.<ServicesID>`) and the `sub` claim — so on top of the shared
 * Apple Developer key (`resolveDeveloperKey('weather')`) it needs
 * `APPLE_WEATHERKIT_SERVICE_ID`. Both are read at CALL time.
 */

export const SERVICE_ID_VAR = 'APPLE_WEATHERKIT_SERVICE_ID';

const SERVICE_ID_HINT =
  'Register a Services ID in the Apple Developer portal (Certificates, Identifiers & Profiles → Identifiers → + → ' +
  'Services IDs, e.g. com.example.weather) and set APPLE_WEATHERKIT_SERVICE_ID to it. The key named by APPLE_KEY_ID ' +
  '(or APPLE_WEATHERKIT_KEY_ID) must have WeatherKit enabled.';

export interface WeatherAuth {
  key: DeveloperKey;
  /** The Services ID (`sub` claim; the second half of the `id` header). */
  serviceId: string;
  /** Which variables supplied the credential — names only, for the healthcheck. */
  source: string;
}

/**
 * Resolve the WeatherKit credential, or throw a `ConfigError` naming EVERY
 * missing variable at once (a key problem and a missing Services ID are
 * reported together, so fixing one does not just reveal the next).
 */
export function resolveWeatherAuth(env: EnvSource = process.env): WeatherAuth {
  const serviceId = readEnvVar(SERVICE_ID_VAR, { env });
  let key: DeveloperKey;
  try {
    key = resolveDeveloperKey('weather', env);
  } catch (err) {
    if (serviceId === undefined && err instanceof ConfigError) {
      throw new ConfigError(
        'weather',
        `${err.message} ${SERVICE_ID_VAR} is not set either.`,
        [...err.missing, SERVICE_ID_VAR],
        [err.hint, SERVICE_ID_HINT].filter((h) => h !== undefined).join(' '),
      );
    }
    throw err;
  }
  if (serviceId === undefined) {
    throw new ConfigError('weather', `WeatherKit needs a Services ID, and ${SERVICE_ID_VAR} is not set.`, [SERVICE_ID_VAR], SERVICE_ID_HINT);
  }
  return { key, serviceId, source: `${key.source} + ${SERVICE_ID_VAR}` };
}

/** Re-mint this long before the (1 h) token expires, so a slow call never carries a token that dies mid-flight. */
export const TOKEN_REFRESH_BUFFER_MS = 5 * 60_000;

export interface WeatherTokenCache {
  /**
   * A token for `auth`: cached when one is valid for exactly this credential,
   * otherwise minted. `fresh` is true when this call minted it — a rejection
   * of a freshly minted token is definitive and is not replayed.
   */
  get(auth: WeatherAuth): Promise<{ token: string; fresh: boolean }>;
  /** Drop the cached token (after Apple rejected it). */
  invalidate(): void;
}

/** A digest of everything that shapes the token, so a rotated key or Services ID never reuses a stale one. */
function fingerprint(auth: WeatherAuth): string {
  return createHash('sha256')
    .update([auth.key.teamId, auth.key.keyId, auth.serviceId, auth.key.privateKeyPem].join('\u0000'))
    .digest('hex');
}

/**
 * The per-process token cache. It is keyed by the credential's fingerprint
 * because config is read per call: if the environment changes (a hosted
 * deployment rotating the key), the next call must mint for the NEW key rather
 * than serve the old key's token for up to an hour.
 */
export function createWeatherTokenCache(now: () => number = Date.now): WeatherTokenCache {
  let current: { fingerprint: string; source: CachedTokenSource } | undefined;
  let mints = 0;
  return {
    async get(auth) {
      const fp = fingerprint(auth);
      if (current === undefined || current.fingerprint !== fp) {
        current = {
          fingerprint: fp,
          source: createCachedTokenSource({
            mint: async () => {
              mints += 1;
              const minted = mintWeatherKitToken(auth.key, auth.serviceId, now());
              // The bearer is a credential: scrubbed by value from every error
              // and log line, not only when it still looks like a JWT.
              rememberSecret(minted.token);
              return minted;
            },
            bufferMs: TOKEN_REFRESH_BUFFER_MS,
            now,
          }),
        };
      }
      const before = mints;
      const token = await current.source.getToken();
      return { token, fresh: mints !== before };
    },
    invalidate() {
      current?.source.invalidate();
    },
  };
}
