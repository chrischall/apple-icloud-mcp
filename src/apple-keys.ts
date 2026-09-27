import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expandPath, readEnvVar, signEs256Jwt, type EnvSource } from '@chrischall/mcp-utils';
import type { ServiceName } from './config.js';
import { ConfigError, rememberSecret } from './errors.js';

/**
 * Apple Developer key material, shared by the three "developer token"
 * services — Apple Music (MusicKit), Apple Maps Server API and WeatherKit.
 *
 * One `.p8` key can carry all three capabilities (the portal lets you tick
 * several services on one key), so the shared variables are the default:
 *
 *   APPLE_TEAM_ID        10-character Team ID
 *   APPLE_KEY_ID         10-character Key ID
 *   APPLE_PRIVATE_KEY    the .p8 contents (see `normalizePrivateKey` for accepted shapes)
 *   APPLE_PRIVATE_KEY_PATH  or a path to the .p8 file (local installs only)
 *
 * Each service may override the key with its own pair, because Apple caps
 * keys per Media ID / Maps ID at two and people end up with one per service:
 *
 *   APPLE_MUSIC_KEY_ID      / APPLE_MUSIC_PRIVATE_KEY
 *   APPLE_MAPS_KEY_ID       / APPLE_MAPS_PRIVATE_KEY
 *   APPLE_WEATHERKIT_KEY_ID / APPLE_WEATHERKIT_PRIVATE_KEY
 *
 * Nothing is read at import: resolution happens on the first call that needs
 * a token, so the server lists its tools with an empty environment.
 */

export type KeyedService = 'music' | 'maps' | 'weather';

const PREFIX: Record<KeyedService, string> = {
  music: 'APPLE_MUSIC',
  maps: 'APPLE_MAPS',
  weather: 'APPLE_WEATHERKIT',
};

export interface DeveloperKey {
  teamId: string;
  keyId: string;
  /** PKCS#8 PEM, validated as an EC P-256 private key. */
  privateKeyPem: string;
  /** Which variables supplied it — for the healthcheck, never the key itself. */
  source: string;
}

/**
 * Accept the shapes a .p8 actually arrives in through an env block:
 *  - the PEM verbatim (multi-line);
 *  - the PEM with literal `\n` escapes (a one-line secret field);
 *  - the whole PEM base64-encoded;
 *  - just the base64 body between the BEGIN/END lines;
 *  - the PEM with its line breaks turned into spaces, or dropped entirely —
 *    what a single-line form field does to a pasted multi-line value, and a
 *    shape OpenSSL refuses to parse.
 * Every PEM is re-armored canonically (64-column body, LF endings).
 * Returns a normalized PEM, or undefined when the value is none of those.
 */
export function normalizePrivateKey(raw: string): string | undefined {
  let value = raw.trim().replace(/\\r/g, '').replace(/\\n/g, '\n');
  if (!value.includes('-----BEGIN')) {
    const compact = value.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(compact)) return undefined;
    const decoded = Buffer.from(compact, 'base64').toString('utf8');
    if (!decoded.includes('-----BEGIN')) return armor('PRIVATE KEY', compact);
    value = decoded;
  }
  const pem = PEM_BLOCK_RE.exec(value);
  // An unrecognisable armor is passed through for `validateEcKey` to reject by name.
  if (!pem) return value.trim().replace(/\r\n/g, '\n') + '\n';
  return armor(pem[1]!, pem[2]!.replace(/\s+/g, ''));
}

/** `-----BEGIN <label>-----<body>-----END <label>-----`, whatever whitespace separates the parts. */
const PEM_BLOCK_RE = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/;

function armor(label: string, body: string): string {
  const lines = body.match(/.{1,64}/g) ?? [];
  return [`-----BEGIN ${label}-----`, ...lines, `-----END ${label}-----`].join('\n') + '\n';
}

/** Validate that `pem` is an EC P-256 private key; returns an error string or undefined. */
export function validateEcKey(pem: string): string | undefined {
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ec') return `it is a ${key.asymmetricKeyType ?? 'non-EC'} key, not an EC (ES256) key`;
    const curve = key.asymmetricKeyDetails?.namedCurve;
    // No name means explicit curve parameters OpenSSL could not match to a
    // named curve — so not P-256. Accepting it would mint tokens Apple rejects.
    if (curve !== 'prime256v1') return `it uses ${curve ? `curve ${curve}` : 'an unnamed curve'}, not P-256`;
    return undefined;
  } catch {
    return 'it could not be parsed as a private key';
  }
}

function readKeyFile(path: string, varName: string, service: ServiceName): string {
  try {
    return readFileSync(expandPath(path), 'utf8');
  } catch {
    throw new ConfigError(service, `Could not read the private key file named by ${varName}.`, [varName], `Check that ${varName} points at a readable .p8 file.`);
  }
}

/**
 * Resolve the developer key for `service`, or throw a `ConfigError` naming
 * exactly which variables are missing.
 */
export function resolveDeveloperKey(service: KeyedService, env: EnvSource = process.env): DeveloperKey {
  const svcName: ServiceName = service;
  const prefix = PREFIX[service];
  const teamId = readEnvVar('APPLE_TEAM_ID', { env });
  const ownKeyId = readEnvVar(`${prefix}_KEY_ID`, { env });
  const ownKey = readEnvVar(`${prefix}_PRIVATE_KEY`, { env });
  const keyId = ownKeyId ?? readEnvVar('APPLE_KEY_ID', { env });

  let rawKey: string | undefined;
  let keyVar: string;
  if (ownKey !== undefined) {
    rawKey = ownKey;
    keyVar = `${prefix}_PRIVATE_KEY`;
  } else if (readEnvVar('APPLE_PRIVATE_KEY', { env }) !== undefined) {
    rawKey = readEnvVar('APPLE_PRIVATE_KEY', { env });
    keyVar = 'APPLE_PRIVATE_KEY';
  } else {
    const path = readEnvVar('APPLE_PRIVATE_KEY_PATH', { env });
    keyVar = 'APPLE_PRIVATE_KEY_PATH';
    if (path !== undefined) rawKey = readKeyFile(path, keyVar, svcName);
  }

  const missing: string[] = [];
  if (!teamId) missing.push('APPLE_TEAM_ID');
  if (!keyId) missing.push(`APPLE_KEY_ID (or ${prefix}_KEY_ID)`);
  if (rawKey === undefined) missing.push(`APPLE_PRIVATE_KEY (or ${prefix}_PRIVATE_KEY / APPLE_PRIVATE_KEY_PATH)`);
  if (missing.length === 0) assertPairMatches(service, env);
  if (missing.length > 0) {
    throw new ConfigError(
      svcName,
      `${serviceLabel(service)} needs an Apple Developer key, and ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set.`,
      missing,
      `Create a key in the Apple Developer portal (Certificates, Identifiers & Profiles → Keys) with ${capabilityLabel(service)} enabled, then set APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY (the .p8 contents).`,
    );
  }
  const pem = normalizePrivateKey(rawKey as string);
  const problem = pem === undefined ? 'it is not a PEM or base64 key' : validateEcKey(pem);
  if (pem === undefined || problem !== undefined) {
    throw new ConfigError(
      svcName,
      `The private key in ${keyVar} is unusable: ${problem}.`,
      [keyVar],
      `Paste the whole .p8 file (including the BEGIN/END PRIVATE KEY lines) into ${keyVar}; one-line values with \\n escapes and base64 are accepted too.`,
    );
  }
  rememberSecret(rawKey);
  return {
    teamId: teamId as string,
    keyId: keyId as string,
    privateKeyPem: pem,
    source: `${ownKeyId ? `${prefix}_KEY_ID` : 'APPLE_KEY_ID'} + ${keyVar}`,
  };
}

/**
 * A key id names exactly one private key, so the service-specific pair and
 * the shared pair must not be crossed. When BOTH a shared key id and a shared
 * private key are set, the shared id provably belongs to the shared key — so
 * pairing it with `<SVC>_PRIVATE_KEY`, or pairing `<SVC>_KEY_ID` with the
 * shared key, mints tokens Apple rejects with a bare 401 that names neither
 * variable. Refuse that up front, by name. With only half of the shared pair
 * set, crossing is the ordinary single-key setup (e.g. APPLE_MUSIC_KEY_ID +
 * APPLE_PRIVATE_KEY for one Music key) and is allowed.
 */
function assertPairMatches(service: KeyedService, env: EnvSource): void {
  const prefix = PREFIX[service];
  const ownKeyId = readEnvVar(`${prefix}_KEY_ID`, { env });
  const ownKey = readEnvVar(`${prefix}_PRIVATE_KEY`, { env });
  const sharedKeyId = readEnvVar('APPLE_KEY_ID', { env });
  const sharedKeyVar =
    readEnvVar('APPLE_PRIVATE_KEY', { env }) !== undefined
      ? 'APPLE_PRIVATE_KEY'
      : readEnvVar('APPLE_PRIVATE_KEY_PATH', { env }) !== undefined
        ? 'APPLE_PRIVATE_KEY_PATH'
        : undefined;
  if (sharedKeyId === undefined || sharedKeyVar === undefined) return;
  if (ownKey !== undefined && ownKeyId === undefined) {
    throw new ConfigError(
      service,
      `${prefix}_PRIVATE_KEY is set but ${prefix}_KEY_ID is not, and APPLE_KEY_ID belongs to the shared key in ${sharedKeyVar} — ` +
        'a key id must name the key that signs the token.',
      [`${prefix}_KEY_ID`],
      `Set ${prefix}_KEY_ID to the Key ID of the key in ${prefix}_PRIVATE_KEY (Apple Developer portal → Keys), or unset ${prefix}_PRIVATE_KEY to use the shared key.`,
    );
  }
  if (ownKeyId !== undefined && ownKey === undefined && ownKeyId !== sharedKeyId) {
    throw new ConfigError(
      service,
      `${prefix}_KEY_ID is set but ${prefix}_PRIVATE_KEY is not, and the shared key in ${sharedKeyVar} belongs to APPLE_KEY_ID — ` +
        'a key id must name the key that signs the token.',
      [`${prefix}_PRIVATE_KEY`],
      `Set ${prefix}_PRIVATE_KEY to the .p8 contents of key ${prefix}_KEY_ID, or unset ${prefix}_KEY_ID to use the shared key.`,
    );
  }
}

function serviceLabel(service: KeyedService): string {
  return service === 'music' ? 'Apple Music' : service === 'maps' ? 'Apple Maps' : 'WeatherKit';
}

function capabilityLabel(service: KeyedService): string {
  return service === 'music' ? 'Media Services (MusicKit)' : service === 'maps' ? 'MapKit JS' : 'WeatherKit';
}

/** Seconds since the epoch. */
function nowSeconds(now: number): number {
  return Math.floor(now / 1000);
}

/**
 * An Apple Music developer token. Apple allows up to ~6 months; we mint for
 * 12 hours and re-mint, so a revoked key stops working within a day and a
 * leaked token is short-lived.
 */
export const MUSIC_TOKEN_TTL_S = 12 * 60 * 60;

export function mintMusicDeveloperToken(key: DeveloperKey, now = Date.now()): { token: string; expiresAt: number } {
  const iat = nowSeconds(now);
  const exp = iat + MUSIC_TOKEN_TTL_S;
  return { token: signEs256Jwt(key.privateKeyPem, { iss: key.teamId, iat, exp }, { header: { kid: key.keyId } }), expiresAt: exp * 1000 };
}

/**
 * The Maps Server API auth token (exchanged at GET /v1/token for a 30-minute
 * access token). `scope: server_api` is what makes it a server token.
 */
export const MAPS_AUTH_TOKEN_TTL_S = 60 * 60;

export function mintMapsAuthToken(key: DeveloperKey, now = Date.now()): { token: string; expiresAt: number } {
  const iat = nowSeconds(now);
  const exp = iat + MAPS_AUTH_TOKEN_TTL_S;
  return {
    token: signEs256Jwt(key.privateKeyPem, { iss: key.teamId, iat, exp, scope: 'server_api' }, { header: { kid: key.keyId } }),
    expiresAt: exp * 1000,
  };
}

/**
 * A WeatherKit REST token. The non-standard `id` header (`<team>.<service>`)
 * and the `sub` claim (the Services ID) are both required; a missing `id` is
 * the classic cause of `NOT_ENABLED`.
 */
export const WEATHERKIT_TOKEN_TTL_S = 60 * 60;

export function mintWeatherKitToken(key: DeveloperKey, serviceId: string, now = Date.now()): { token: string; expiresAt: number } {
  const iat = nowSeconds(now);
  const exp = iat + WEATHERKIT_TOKEN_TTL_S;
  return {
    token: signEs256Jwt(key.privateKeyPem, { iss: key.teamId, iat, exp, sub: serviceId }, { header: { kid: key.keyId, id: `${key.teamId}.${serviceId}` } }),
    expiresAt: exp * 1000,
  };
}

/** Decode a JWT's payload without verifying it (for expiry and issuer checks on tokens we did not mint). */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const json = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as unknown;
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
