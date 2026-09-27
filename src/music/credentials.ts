import { readEnvVar, type EnvSource } from '@chrischall/mcp-utils';
import { decodeJwtPayload, resolveDeveloperKey, type DeveloperKey } from '../apple-keys.js';
import { ConfigError, rememberSecret } from '../errors.js';
import { normalizeStorefront } from './ids.js';

/**
 * Which Apple Music credentials the environment holds — read on EVERY call
 * (never cached at import), so the server lists its tools with an empty
 * environment and a hosted child sees the env it was spawned with.
 *
 * Two profiles:
 *  - **official** — Apple's documented API on api.music.apple.com. A developer
 *    token (`APPLE_MUSIC_DEVELOPER_TOKEN`, or minted from the Apple Developer
 *    key) is enough for the catalog; the library also needs a Music User Token
 *    (`APPLE_MUSIC_USER_TOKEN`).
 *  - **web** — opt-in, Apple's web-player API on amp-api.music.apple.com,
 *    enabled only by `APPLE_MUSIC_WEB_USER_TOKEN` (the `media-user-token`
 *    cookie of a signed-in music.apple.com session). Its developer token is
 *    `APPLE_MUSIC_WEB_DEVELOPER_TOKEN` or read from music.apple.com.
 */

export const ENV = {
  developerToken: 'APPLE_MUSIC_DEVELOPER_TOKEN',
  userToken: 'APPLE_MUSIC_USER_TOKEN',
  webUserToken: 'APPLE_MUSIC_WEB_USER_TOKEN',
  webDeveloperToken: 'APPLE_MUSIC_WEB_DEVELOPER_TOKEN',
  storefront: 'APPLE_MUSIC_STOREFRONT',
} as const;

/**
 * How to get a Music User Token. It only works with the developer key that minted it, so someone without the
 * server's key asks its owner for a short-lived developer token from it — never for the `.p8` itself.
 */
export const USER_TOKEN_HOWTO =
  "run `npx @chrischall/aws-mcp music-auth` with the server's Apple Developer key set — or, without the key, with " +
  'APPLE_MUSIC_DEVELOPER_TOKEN set to a token its owner mints with `music-auth --print-developer-token`';

/** What to tell someone who has configured neither profile. */
export const OFFICIAL_SETUP =
  'Official API: set APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY (a key with Media Services / MusicKit) or ' +
  `APPLE_MUSIC_DEVELOPER_TOKEN; for your library also APPLE_MUSIC_USER_TOKEN (${USER_TOKEN_HOWTO}).`;
export const WEB_SETUP =
  'Web-player mode (unofficial): set APPLE_MUSIC_WEB_USER_TOKEN to the media-user-token cookie of a signed-in ' +
  'music.apple.com browser session (DevTools → Application → Cookies).';

export type OfficialDev =
  | { kind: 'env-token'; token: string; expiresAt: number; source: string }
  | { kind: 'key'; key: DeveloperKey; source: string };

export type OfficialDevResolution =
  | { status: 'ok'; dev: OfficialDev }
  /** Nothing music-specific is configured — the official profile simply is not in use. */
  | { status: 'absent'; error: ConfigError }
  /** Something WAS configured for the official profile, and it is unusable. Never silently skipped. */
  | { status: 'broken'; error: ConfigError };

function tokenProblem(varName: string, token: string, now: number): string | { expiresAt: number } {
  const payload = decodeJwtPayload(token);
  if (!payload) return `${varName} is not a JWT (expected three base64url parts starting with eyJ)`;
  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return `${varName} has no numeric exp (expiry) claim`;
  if (exp * 1000 <= now) return `${varName} expired at ${new Date(exp * 1000).toISOString()}`;
  return { expiresAt: exp * 1000 };
}

/**
 * Resolve the official developer token source without any network I/O.
 *
 * "Broken" (as opposed to "absent") is decided conservatively: a pre-minted
 * token that is set but unusable, or a Music-specific key variable, or a
 * complete set of shared key variables that does not produce a usable key.
 * A shared `APPLE_TEAM_ID` alone (set for Maps or WeatherKit) does not count
 * as an attempt to configure Apple Music.
 */
export function resolveOfficialDev(env: EnvSource = process.env, now: number = Date.now()): OfficialDevResolution {
  const envToken = readEnvVar(ENV.developerToken, { env });
  if (envToken !== undefined) {
    rememberSecret(envToken);
    const checked = tokenProblem(ENV.developerToken, envToken, now);
    if (typeof checked === 'string') {
      return {
        status: 'broken',
        error: new ConfigError(
          'music',
          `${checked}.`,
          [ENV.developerToken],
          'Mint a new developer token (Apple allows up to 6 months), or unset APPLE_MUSIC_DEVELOPER_TOKEN and set APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY so this server mints its own.',
        ),
      };
    }
    return { status: 'ok', dev: { kind: 'env-token', token: envToken, expiresAt: checked.expiresAt, source: ENV.developerToken } };
  }
  try {
    const key = resolveDeveloperKey('music', env);
    return { status: 'ok', dev: { kind: 'key', key, source: key.source } };
  } catch (err) {
    /* v8 ignore next -- resolveDeveloperKey only throws ConfigError */
    if (!(err instanceof ConfigError)) throw err;
    const has = (k: string): boolean => readEnvVar(k, { env }) !== undefined;
    const musicSpecific = has('APPLE_MUSIC_KEY_ID') || has('APPLE_MUSIC_PRIVATE_KEY');
    const sharedComplete =
      has('APPLE_TEAM_ID') && has('APPLE_KEY_ID') && (has('APPLE_PRIVATE_KEY') || has('APPLE_PRIVATE_KEY_PATH'));
    return { status: musicSpecific || sharedComplete ? 'broken' : 'absent', error: err };
  }
}

/** `APPLE_MUSIC_USER_TOKEN`, registered for scrubbing. */
export function officialUserToken(env: EnvSource = process.env): string | undefined {
  const v = readEnvVar(ENV.userToken, { env });
  rememberSecret(v);
  return v;
}

/** `APPLE_MUSIC_WEB_USER_TOKEN` — its presence is what turns web mode on. */
export function webUserToken(env: EnvSource = process.env): string | undefined {
  const v = readEnvVar(ENV.webUserToken, { env });
  rememberSecret(v);
  return v;
}

export interface WebDevOverride {
  token: string;
  expiresAt: number;
}

/** `APPLE_MUSIC_WEB_DEVELOPER_TOKEN`, validated (a set-but-unusable value is a ConfigError, never ignored). */
export function webDeveloperTokenOverride(env: EnvSource = process.env, now: number = Date.now()): WebDevOverride | undefined {
  const v = readEnvVar(ENV.webDeveloperToken, { env });
  if (v === undefined) return undefined;
  rememberSecret(v);
  const checked = tokenProblem(ENV.webDeveloperToken, v, now);
  if (typeof checked === 'string') {
    throw new ConfigError(
      'music',
      `${checked}.`,
      [ENV.webDeveloperToken],
      'Unset APPLE_MUSIC_WEB_DEVELOPER_TOKEN to let this server read the current web-player token from music.apple.com, or paste a fresh one.',
    );
  }
  return { token: v, expiresAt: checked.expiresAt };
}

/** `APPLE_MUSIC_STOREFRONT`, normalized; a malformed value is a ConfigError rather than a silent `us`. */
export function storefrontFromEnv(env: EnvSource = process.env): string | undefined {
  const v = readEnvVar(ENV.storefront, { env });
  if (v === undefined) return undefined;
  try {
    return normalizeStorefront(v, ENV.storefront);
  } catch {
    throw new ConfigError('music', `APPLE_MUSIC_STOREFRONT "${v}" is not a two-letter storefront code.`, [ENV.storefront], 'Use a lowercase ISO country code such as us, gb or jp.');
  }
}
