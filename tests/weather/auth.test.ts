import { describe, expect, it } from 'vitest';
import { ConfigError, scrub } from '../../src/errors.js';
import { TOKEN_REFRESH_BUFFER_MS, createWeatherTokenCache, resolveWeatherAuth } from '../../src/weather/auth.js';
import { KEY_ID, NOW, PEM, SERVICE_ID, TEAM_ID, decodeJwt, setWeatherEnv } from './_fixtures.js';

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error('expected a ConfigError');
}

describe('resolveWeatherAuth', () => {
  it('reports every missing variable at once when nothing is set', () => {
    const err = configError(() => resolveWeatherAuth());
    expect(err.service).toBe('weather');
    expect(err.code).toBe('NOT_CONFIGURED');
    expect(err.missing).toEqual([
      'APPLE_TEAM_ID',
      'APPLE_KEY_ID (or APPLE_WEATHERKIT_KEY_ID)',
      'APPLE_PRIVATE_KEY (or APPLE_WEATHERKIT_PRIVATE_KEY / APPLE_PRIVATE_KEY_PATH)',
      'APPLE_WEATHERKIT_SERVICE_ID',
    ]);
    expect(err.message).toMatch(/APPLE_WEATHERKIT_SERVICE_ID is not set either/);
    expect(err.hint).toMatch(/WeatherKit enabled/);
    expect(err.hint).toMatch(/Services IDs/);
  });

  it('names only the Services ID when the key resolves', () => {
    setWeatherEnv({ APPLE_WEATHERKIT_SERVICE_ID: undefined });
    const err = configError(() => resolveWeatherAuth());
    expect(err.missing).toEqual(['APPLE_WEATHERKIT_SERVICE_ID']);
    expect(err.message).toMatch(/needs a Services ID/);
  });

  it('passes the key error through unchanged when the Services ID is set', () => {
    setWeatherEnv({ APPLE_PRIVATE_KEY: undefined });
    const err = configError(() => resolveWeatherAuth());
    expect(err.missing).toEqual(['APPLE_PRIVATE_KEY (or APPLE_WEATHERKIT_PRIVATE_KEY / APPLE_PRIVATE_KEY_PATH)']);
  });

  it('combines an unusable key with a missing Services ID', () => {
    setWeatherEnv({ APPLE_PRIVATE_KEY: 'not a key at all!', APPLE_WEATHERKIT_SERVICE_ID: undefined });
    const err = configError(() => resolveWeatherAuth());
    expect(err.missing).toEqual(['APPLE_PRIVATE_KEY', 'APPLE_WEATHERKIT_SERVICE_ID']);
    expect(err.message).toMatch(/unusable/);
  });

  it('treats a placeholder Services ID as unset', () => {
    setWeatherEnv({ APPLE_WEATHERKIT_SERVICE_ID: '${APPLE_WEATHERKIT_SERVICE_ID}' });
    expect(configError(() => resolveWeatherAuth()).missing).toEqual(['APPLE_WEATHERKIT_SERVICE_ID']);
  });

  it('returns the key, the Services ID and the variable names that supplied them', () => {
    setWeatherEnv();
    const auth = resolveWeatherAuth();
    expect(auth.serviceId).toBe(SERVICE_ID);
    expect(auth.key.teamId).toBe(TEAM_ID);
    expect(auth.key.keyId).toBe(KEY_ID);
    expect(auth.source).toBe('APPLE_KEY_ID + APPLE_PRIVATE_KEY + APPLE_WEATHERKIT_SERVICE_ID');
  });

  it('honours the WeatherKit-specific key override', () => {
    setWeatherEnv({ APPLE_KEY_ID: undefined, APPLE_PRIVATE_KEY: undefined, APPLE_WEATHERKIT_KEY_ID: 'WKEY123456', APPLE_WEATHERKIT_PRIVATE_KEY: PEM });
    const auth = resolveWeatherAuth();
    expect(auth.key.keyId).toBe('WKEY123456');
    expect(auth.source).toBe('APPLE_WEATHERKIT_KEY_ID + APPLE_WEATHERKIT_PRIVATE_KEY + APPLE_WEATHERKIT_SERVICE_ID');
  });

  it('reads an explicit env source instead of process.env', () => {
    const auth = resolveWeatherAuth({ APPLE_TEAM_ID: TEAM_ID, APPLE_KEY_ID: KEY_ID, APPLE_PRIVATE_KEY: PEM, APPLE_WEATHERKIT_SERVICE_ID: 'com.other' });
    expect(auth.serviceId).toBe('com.other');
  });
});

describe('createWeatherTokenCache', () => {
  it('mints a WeatherKit-shaped JWT with exactly the documented claims', async () => {
    setWeatherEnv();
    const cache = createWeatherTokenCache(() => NOW);
    const { token, fresh } = await cache.get(resolveWeatherAuth());
    expect(fresh).toBe(true);
    const { header, payload } = decodeJwt(token);
    expect(header).toMatchObject({ alg: 'ES256', kid: KEY_ID, id: `${TEAM_ID}.${SERVICE_ID}` });
    const iat = Math.floor(NOW / 1000);
    expect(payload).toEqual({ iss: TEAM_ID, iat, exp: iat + 3600, sub: SERVICE_ID });
  });

  it('registers every minted token as a secret, so it is scrubbed by value wherever it appears', async () => {
    setWeatherEnv();
    const { token } = await createWeatherTokenCache(() => NOW).get(resolveWeatherAuth());
    // Glued to other characters, the JWT shape match cannot see it; only the literal registration can.
    expect(scrub(`abc${token}def`)).toBe('abc[REDACTED]def');
  });

  it('serves the cached token until the refresh buffer, then re-mints', async () => {
    setWeatherEnv();
    let now = NOW;
    const cache = createWeatherTokenCache(() => now);
    const auth = resolveWeatherAuth();
    const first = await cache.get(auth);
    now += 10_000;
    const second = await cache.get(auth);
    expect(second).toEqual({ token: first.token, fresh: false });
    now = NOW + 3_600_000 - TOKEN_REFRESH_BUFFER_MS + 1;
    const third = await cache.get(auth);
    expect(third.fresh).toBe(true);
    expect(third.token).not.toBe(first.token);
  });

  it('re-mints when the credential changes (a rotated Services ID never reuses the old token)', async () => {
    setWeatherEnv();
    const cache = createWeatherTokenCache(() => NOW);
    const first = await cache.get(resolveWeatherAuth());
    setWeatherEnv({ APPLE_WEATHERKIT_SERVICE_ID: 'com.example.rotated' });
    const second = await cache.get(resolveWeatherAuth());
    expect(second.fresh).toBe(true);
    expect(decodeJwt(second.token).payload.sub).toBe('com.example.rotated');
    expect(second.token).not.toBe(first.token);
  });

  it('invalidate() forces the next get to mint (and is harmless before any get)', async () => {
    setWeatherEnv();
    let now = NOW;
    const cache = createWeatherTokenCache(() => now);
    cache.invalidate();
    const auth = resolveWeatherAuth();
    const first = await cache.get(auth);
    cache.invalidate();
    now += 5_000;
    const second = await cache.get(auth);
    expect(second.fresh).toBe(true);
    expect(second.token).not.toBe(first.token);
  });

  it('defaults to the real clock', async () => {
    setWeatherEnv();
    const { token } = await createWeatherTokenCache().get(resolveWeatherAuth());
    const { payload } = decodeJwt(token);
    expect(Math.abs((payload.iat as number) - Date.now() / 1000)).toBeLessThan(60);
  });
});
