import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicKey, createVerify, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAPS_AUTH_TOKEN_TTL_S,
  MUSIC_TOKEN_TTL_S,
  WEATHERKIT_TOKEN_TTL_S,
  decodeJwtPayload,
  mintMapsAuthToken,
  mintMusicDeveloperToken,
  mintWeatherKitToken,
  normalizePrivateKey,
  resolveDeveloperKey,
  validateEcKey,
  type DeveloperKey,
} from '../src/apple-keys.js';
import { ConfigError, scrub } from '../src/errors.js';

const p256 = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = p256.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const SEC1 = p256.privateKey.export({ type: 'sec1', format: 'pem' }) as string;
const BODY = PEM.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
const P384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const RSA = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const ED = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

const TEAM = 'TEAM123456';
const KID = 'KEY1234567';

afterEach(() => {
  vi.useRealTimers();
});

/** The key a normalized PEM parses to must be the one we generated. */
function samePublicKey(pem: string, pub: KeyObject = p256.publicKey): boolean {
  return createPublicKey(pem).export({ type: 'spki', format: 'der' }).equals(pub.export({ type: 'spki', format: 'der' }));
}

function verifyJwt(token: string, pub: KeyObject = p256.publicKey): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p, s] = token.split('.') as [string, string, string];
  const v = createVerify('SHA256');
  v.update(`${h}.${p}`);
  const sig = Buffer.from(s, 'base64url');
  expect(sig).toHaveLength(64); // raw r||s (JOSE), not DER
  expect(v.verify({ key: pub, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>,
  };
}

describe('normalizePrivateKey', () => {
  it('keeps a verbatim PEM (canonical armor, trailing newline)', () => {
    const out = normalizePrivateKey(PEM)!;
    expect(out.startsWith('-----BEGIN PRIVATE KEY-----\n')).toBe(true);
    expect(out.endsWith('-----END PRIVATE KEY-----\n')).toBe(true);
    expect(samePublicKey(out)).toBe(true);
    expect(normalizePrivateKey(PEM.trim())).toBe(out);
  });

  it('accepts literal \\n escapes and CRLF line endings (one-line secret fields)', () => {
    const escaped = PEM.trim().replace(/\n/g, '\\n');
    expect(samePublicKey(normalizePrivateKey(escaped)!)).toBe(true);
    const crlfEscaped = PEM.trim().replace(/\n/g, '\\r\\n');
    expect(samePublicKey(normalizePrivateKey(crlfEscaped)!)).toBe(true);
    const crlf = PEM.replace(/\n/g, '\r\n');
    expect(samePublicKey(normalizePrivateKey(crlf)!)).toBe(true);
  });

  it('repairs a PEM whose line breaks became spaces, or were stripped by a single-line input', () => {
    const spaced = PEM.trim().replace(/\n/g, ' ');
    expect(samePublicKey(normalizePrivateKey(spaced)!)).toBe(true);
    const stripped = PEM.replace(/\n/g, '');
    expect(samePublicKey(normalizePrivateKey(stripped)!)).toBe(true);
    expect(normalizePrivateKey(stripped)).toBe(normalizePrivateKey(PEM));
  });

  it('keeps the armor label (a SEC1 "EC PRIVATE KEY" stays one)', () => {
    const out = normalizePrivateKey(SEC1.replace(/\n/g, ' '))!;
    expect(out.startsWith('-----BEGIN EC PRIVATE KEY-----\n')).toBe(true);
    expect(samePublicKey(out)).toBe(true);
  });

  it('decodes a whole PEM supplied base64-encoded', () => {
    const b64 = Buffer.from(PEM).toString('base64');
    expect(samePublicKey(normalizePrivateKey(b64)!)).toBe(true);
  });

  it('wraps a bare base64 body (whitespace allowed) in PKCS#8 armor at 64 columns', () => {
    const out = normalizePrivateKey(`  ${BODY.slice(0, 40)}\n${BODY.slice(40)}  `)!;
    expect(out.split('\n')[1]).toHaveLength(64);
    expect(samePublicKey(out)).toBe(true);
  });

  it('returns undefined for something that is neither PEM nor base64', () => {
    expect(normalizePrivateKey('not a key at all!')).toBeUndefined();
    expect(normalizePrivateKey('')).toBeUndefined();
    expect(normalizePrivateKey('abc-def_ghi')).toBeUndefined();
  });

  it('passes an unrecognizable armor through for validation to reject by name, and armors an empty body', () => {
    expect(normalizePrivateKey('-----BEGIN PRIVATE KEY-----\r\nAAAA')).toBe('-----BEGIN PRIVATE KEY-----\nAAAA\n');
    expect(normalizePrivateKey('-----BEGIN PRIVATE KEY----------END PRIVATE KEY-----')).toBe(
      '-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----\n',
    );
  });
});

describe('validateEcKey', () => {
  it('accepts a P-256 key in PKCS#8 or SEC1 form', () => {
    expect(validateEcKey(PEM)).toBeUndefined();
    expect(validateEcKey(SEC1)).toBeUndefined();
  });

  it('names the problem with anything else', () => {
    expect(validateEcKey(RSA)).toBe('it is a rsa key, not an EC (ES256) key');
    expect(validateEcKey(ED)).toBe('it is a ed25519 key, not an EC (ES256) key');
    expect(validateEcKey(P384)).toBe('it uses curve secp384r1, not P-256');
    expect(validateEcKey('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n')).toBe('it could not be parsed as a private key');
  });
});

describe('resolveDeveloperKey', () => {
  it('lists every missing variable, with service-specific alternatives and capability hints', () => {
    for (const [service, prefix, label, capability] of [
      ['music', 'APPLE_MUSIC', 'Apple Music', 'Media Services (MusicKit)'],
      ['maps', 'APPLE_MAPS', 'Apple Maps', 'MapKit JS'],
      ['weather', 'APPLE_WEATHERKIT', 'WeatherKit', 'WeatherKit'],
    ] as const) {
      let err: ConfigError | undefined;
      try {
        resolveDeveloperKey(service, {});
      } catch (e) {
        err = e as ConfigError;
      }
      expect(err).toBeInstanceOf(ConfigError);
      expect(err!.service).toBe(service);
      expect(err!.missing).toEqual([
        'APPLE_TEAM_ID',
        `APPLE_KEY_ID (or ${prefix}_KEY_ID)`,
        `APPLE_PRIVATE_KEY (or ${prefix}_PRIVATE_KEY / APPLE_PRIVATE_KEY_PATH)`,
      ]);
      expect(err!.message).toContain(`${label} needs an Apple Developer key, and APPLE_TEAM_ID,`);
      expect(err!.message).toMatch(/ are not set\.$/);
      expect(err!.hint).toContain(`with ${capability} enabled`);
    }
  });

  it('says "is not set" for a single missing variable', () => {
    let err: ConfigError | undefined;
    try {
      resolveDeveloperKey('maps', { APPLE_KEY_ID: KID, APPLE_PRIVATE_KEY: PEM });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err!.missing).toEqual(['APPLE_TEAM_ID']);
    expect(err!.message).toMatch(/APPLE_TEAM_ID is not set\.$/);
  });

  it('resolves the shared key and remembers it as a secret', () => {
    const escaped = PEM.trim().replace(/\n/g, '\\n');
    const key = resolveDeveloperKey('music', { APPLE_TEAM_ID: TEAM, APPLE_KEY_ID: KID, APPLE_PRIVATE_KEY: escaped });
    expect(key).toMatchObject({ teamId: TEAM, keyId: KID, source: 'APPLE_KEY_ID + APPLE_PRIVATE_KEY' });
    expect(samePublicKey(key.privateKeyPem)).toBe(true);
    // A body-only key has no PEM armor for shape redaction to find: only the remembered literal catches it.
    resolveDeveloperKey('music', { APPLE_TEAM_ID: TEAM, APPLE_KEY_ID: KID, APPLE_PRIVATE_KEY: BODY });
    expect(scrub(`leak ${BODY}`)).toBe('leak [REDACTED]');
  });

  it('reads process.env by default', () => {
    process.env.APPLE_TEAM_ID = TEAM;
    process.env.APPLE_KEY_ID = KID;
    process.env.APPLE_PRIVATE_KEY = PEM;
    expect(resolveDeveloperKey('weather').keyId).toBe(KID);
  });

  it('prefers a service-specific key pair over the shared one', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const otherPem = other.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const key = resolveDeveloperKey('maps', {
      APPLE_TEAM_ID: TEAM,
      APPLE_KEY_ID: KID,
      APPLE_PRIVATE_KEY: PEM,
      APPLE_MAPS_KEY_ID: 'MAPSKEY001',
      APPLE_MAPS_PRIVATE_KEY: otherPem,
    });
    expect(key.keyId).toBe('MAPSKEY001');
    expect(key.source).toBe('APPLE_MAPS_KEY_ID + APPLE_MAPS_PRIVATE_KEY');
    expect(samePublicKey(key.privateKeyPem, other.publicKey)).toBe(true);
    // Another service still uses the shared pair.
    expect(resolveDeveloperKey('music', { APPLE_TEAM_ID: TEAM, APPLE_KEY_ID: KID, APPLE_PRIVATE_KEY: PEM, APPLE_MAPS_KEY_ID: 'X' }).keyId).toBe(KID);
  });

  describe('never crosses a service-specific key with the shared key id (Apple would answer a bare 401)', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const refusal = (env: Record<string, string>): ConfigError => {
      try {
        resolveDeveloperKey('music', { APPLE_TEAM_ID: TEAM, ...env });
      } catch (e) {
        return e as ConfigError;
      }
      throw new Error('expected a ConfigError');
    };

    it('refuses <SVC>_PRIVATE_KEY without <SVC>_KEY_ID when APPLE_KEY_ID belongs to a shared key', () => {
      const err = refusal({ APPLE_KEY_ID: KID, APPLE_PRIVATE_KEY: PEM, APPLE_MUSIC_PRIVATE_KEY: other });
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.missing).toEqual(['APPLE_MUSIC_KEY_ID']);
      expect(err.message).toBe(
        'APPLE_MUSIC_PRIVATE_KEY is set but APPLE_MUSIC_KEY_ID is not, and APPLE_KEY_ID belongs to the shared key in ' +
          'APPLE_PRIVATE_KEY — a key id must name the key that signs the token.',
      );
      expect(err.hint).toContain('Set APPLE_MUSIC_KEY_ID');
      expect(err.message).not.toContain(KID);
    });

    it('refuses <SVC>_KEY_ID without <SVC>_PRIVATE_KEY when the shared key belongs to a different APPLE_KEY_ID', () => {
      const err = refusal({ APPLE_KEY_ID: KID, APPLE_PRIVATE_KEY: PEM, APPLE_MUSIC_KEY_ID: 'MUSICKEY01' });
      expect(err.missing).toEqual(['APPLE_MUSIC_PRIVATE_KEY']);
      expect(err.message).toContain('APPLE_MUSIC_KEY_ID is set but APPLE_MUSIC_PRIVATE_KEY is not');
      expect(err.hint).toContain('Set APPLE_MUSIC_PRIVATE_KEY');
    });

    it('names APPLE_PRIVATE_KEY_PATH when that is where the shared key lives', () => {
      const dir = mkdtempSync(join(tmpdir(), 'apple-icloud-mcp-key-'));
      try {
        const file = join(dir, 'AuthKey.p8');
        writeFileSync(file, PEM);
        const err = refusal({ APPLE_KEY_ID: KID, APPLE_PRIVATE_KEY_PATH: file, APPLE_MUSIC_KEY_ID: 'MUSICKEY01' });
        expect(err.message).toContain('the shared key in APPLE_PRIVATE_KEY_PATH belongs to APPLE_KEY_ID');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('allows every unambiguous single-key setup', () => {
      // The service id repeats the shared id: same key.
      expect(resolveDeveloperKey('music', { APPLE_TEAM_ID: TEAM, APPLE_KEY_ID: KID, APPLE_PRIVATE_KEY: PEM, APPLE_MUSIC_KEY_ID: KID }).keyId).toBe(KID);
      // No shared private key: APPLE_KEY_ID can only name the service key.
      const a = resolveDeveloperKey('music', { APPLE_TEAM_ID: TEAM, APPLE_KEY_ID: KID, APPLE_MUSIC_PRIVATE_KEY: PEM });
      expect(a.source).toBe('APPLE_KEY_ID + APPLE_MUSIC_PRIVATE_KEY');
      // No shared key id: the service id can only name the shared key.
      const b = resolveDeveloperKey('music', { APPLE_TEAM_ID: TEAM, APPLE_MUSIC_KEY_ID: 'MUSICKEY01', APPLE_PRIVATE_KEY: PEM });
      expect(b).toMatchObject({ keyId: 'MUSICKEY01', source: 'APPLE_MUSIC_KEY_ID + APPLE_PRIVATE_KEY' });
    });
  });

  it('reads APPLE_PRIVATE_KEY_PATH when no inline key is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'apple-icloud-mcp-key-'));
    try {
      const file = join(dir, 'AuthKey.p8');
      writeFileSync(file, PEM);
      const key = resolveDeveloperKey('weather', { APPLE_TEAM_ID: TEAM, APPLE_KEY_ID: KID, APPLE_PRIVATE_KEY_PATH: file });
      expect(key.source).toBe('APPLE_KEY_ID + APPLE_PRIVATE_KEY_PATH');
      expect(samePublicKey(key.privateKeyPem)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports an unreadable key file by variable name', () => {
    let err: ConfigError | undefined;
    try {
      resolveDeveloperKey('music', { APPLE_TEAM_ID: TEAM, APPLE_KEY_ID: KID, APPLE_PRIVATE_KEY_PATH: '/nonexistent/AuthKey.p8' });
    } catch (e) {
      err = e as ConfigError;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect(err!.missing).toEqual(['APPLE_PRIVATE_KEY_PATH']);
    expect(err!.message).toBe('Could not read the private key file named by APPLE_PRIVATE_KEY_PATH.');
    expect(err!.hint).toContain('readable .p8 file');
  });

  it('refuses an unusable key, naming the variable and the problem (never the value)', () => {
    const cases: Array<[Record<string, string>, string, string]> = [
      [{ APPLE_PRIVATE_KEY: 'not a key!' }, 'APPLE_PRIVATE_KEY', 'it is not a PEM or base64 key'],
      [{ APPLE_PRIVATE_KEY: RSA }, 'APPLE_PRIVATE_KEY', 'it is a rsa key, not an EC (ES256) key'],
      [{ APPLE_WEATHERKIT_PRIVATE_KEY: P384 }, 'APPLE_WEATHERKIT_PRIVATE_KEY', 'it uses curve secp384r1, not P-256'],
    ];
    for (const [env, varName, problem] of cases) {
      let err: ConfigError | undefined;
      try {
        resolveDeveloperKey('weather', { APPLE_TEAM_ID: TEAM, APPLE_KEY_ID: KID, ...env });
      } catch (e) {
        err = e as ConfigError;
      }
      expect(err).toBeInstanceOf(ConfigError);
      expect(err!.missing).toEqual([varName]);
      expect(err!.message).toBe(`The private key in ${varName} is unusable: ${problem}.`);
      expect(err!.hint).toContain(`into ${varName}`);
    }
  });
});

describe('token minting', () => {
  const key: DeveloperKey = { teamId: TEAM, keyId: KID, privateKeyPem: normalizePrivateKey(PEM)!, source: 'test' };
  const NOW = Date.parse('2026-09-27T12:00:00.750Z');
  const iat = Math.floor(NOW / 1000);

  it('mints a verifiable Apple Music developer token (kid header, iss/iat/exp, 12 h)', () => {
    const { token, expiresAt } = mintMusicDeveloperToken(key, NOW);
    const { header, payload } = verifyJwt(token);
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: KID });
    expect(payload).toEqual({ iss: TEAM, iat, exp: iat + MUSIC_TOKEN_TTL_S });
    expect(expiresAt).toBe((iat + MUSIC_TOKEN_TTL_S) * 1000);
    expect(MUSIC_TOKEN_TTL_S).toBe(43_200);
  });

  it('mints a verifiable Maps server auth token with scope server_api', () => {
    const { token, expiresAt } = mintMapsAuthToken(key, NOW);
    const { header, payload } = verifyJwt(token);
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: KID });
    expect(payload).toEqual({ iss: TEAM, iat, exp: iat + MAPS_AUTH_TOKEN_TTL_S, scope: 'server_api' });
    expect(expiresAt).toBe((iat + MAPS_AUTH_TOKEN_TTL_S) * 1000);
  });

  it('mints a verifiable WeatherKit token with the id header and sub claim', () => {
    const { token, expiresAt } = mintWeatherKitToken(key, 'com.example.weather', NOW);
    const { header, payload } = verifyJwt(token);
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: KID, id: `${TEAM}.com.example.weather` });
    expect(payload).toEqual({ iss: TEAM, iat, exp: iat + WEATHERKIT_TOKEN_TTL_S, sub: 'com.example.weather' });
    expect(expiresAt).toBe((iat + WEATHERKIT_TOKEN_TTL_S) * 1000);
  });

  it('defaults `now` to the current time', () => {
    vi.useFakeTimers({ now: NOW });
    expect(verifyJwt(mintMusicDeveloperToken(key).token).payload.iat).toBe(iat);
    expect(verifyJwt(mintMapsAuthToken(key).token).payload.iat).toBe(iat);
    expect(verifyJwt(mintWeatherKitToken(key, 's').token).payload.iat).toBe(iat);
  });
});

describe('decodeJwtPayload', () => {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

  it('decodes an object payload without verifying it', () => {
    expect(decodeJwtPayload(`${enc({ alg: 'none' })}.${enc({ iss: 'AMPWebPlay', exp: 1 })}.sig`)).toEqual({ iss: 'AMPWebPlay', exp: 1 });
  });

  it('returns undefined for anything that is not a three-part JWT with an object payload', () => {
    expect(decodeJwtPayload('a.b')).toBeUndefined();
    expect(decodeJwtPayload('a.b.c.d')).toBeUndefined();
    expect(decodeJwtPayload('a.!!!.c')).toBeUndefined();
    expect(decodeJwtPayload(`a.${enc([1, 2])}.c`)).toBeUndefined();
    expect(decodeJwtPayload(`a.${enc(null)}.c`)).toBeUndefined();
    expect(decodeJwtPayload(`a.${enc(7)}.c`)).toBeUndefined();
  });
});
