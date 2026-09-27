import { describe, expect, it } from 'vitest';
import { ConfigError, scrub } from '../../src/errors.js';
import {
  officialUserToken,
  resolveOfficialDev,
  storefrontFromEnv,
  webDeveloperTokenOverride,
  webUserToken,
} from '../../src/music/credentials.js';
import { FAR_FUTURE, OFFICIAL_DEV, fakeJwt, p256Pem } from './_helpers.js';

const NOW = Date.UTC(2026, 8, 27);

describe('resolveOfficialDev', () => {
  it('uses a valid pre-minted APPLE_MUSIC_DEVELOPER_TOKEN and remembers it for scrubbing', () => {
    const r = resolveOfficialDev({ APPLE_MUSIC_DEVELOPER_TOKEN: OFFICIAL_DEV }, NOW);
    expect(r.status).toBe('ok');
    expect(r.status === 'ok' && r.dev.kind).toBe('env-token');
    expect(r.status === 'ok' && r.dev.source).toBe('APPLE_MUSIC_DEVELOPER_TOKEN');
    expect(r.status === 'ok' && r.dev.kind === 'env-token' && r.dev.expiresAt).toBe(FAR_FUTURE * 1000);
    expect(scrub(`x ${OFFICIAL_DEV} y`)).not.toContain(OFFICIAL_DEV);
  });

  it.each([
    ['not-a-jwt', /is not a JWT/],
    [fakeJwt({ iss: 'x' }), /no numeric exp/],
    [fakeJwt({ iss: 'x', exp: 1000 }), /expired at 1970-01-01T00:16:40.000Z/],
  ])('a set but unusable token is BROKEN, never ignored (%s)', (token, msg) => {
    const r = resolveOfficialDev({ APPLE_MUSIC_DEVELOPER_TOKEN: token }, NOW);
    expect(r.status).toBe('broken');
    expect(r.status !== 'ok' && r.error).toBeInstanceOf(ConfigError);
    expect(r.status !== 'ok' && r.error.message).toMatch(msg);
    expect(r.status !== 'ok' && r.error.missing).toEqual(['APPLE_MUSIC_DEVELOPER_TOKEN']);
  });

  it('mints from a developer key when no pre-minted token is set', () => {
    const r = resolveOfficialDev({ APPLE_TEAM_ID: 'TEAM123456', APPLE_KEY_ID: 'KEY1234567', APPLE_PRIVATE_KEY: p256Pem() }, NOW);
    expect(r.status).toBe('ok');
    expect(r.status === 'ok' && r.dev.kind).toBe('key');
    expect(r.status === 'ok' && r.dev.source).toBe('APPLE_KEY_ID + APPLE_PRIVATE_KEY');
  });

  it('is ABSENT when nothing music-specific is configured (a shared APPLE_TEAM_ID alone does not count)', () => {
    expect(resolveOfficialDev({}, NOW).status).toBe('absent');
    expect(resolveOfficialDev({ APPLE_TEAM_ID: 'TEAM123456', APPLE_WEATHERKIT_KEY_ID: 'K' }, NOW).status).toBe('absent');
  });

  it('is BROKEN when Music-specific key variables are set but unusable', () => {
    const r = resolveOfficialDev({ APPLE_MUSIC_PRIVATE_KEY: p256Pem() }, NOW);
    expect(r.status).toBe('broken');
    expect(r.status !== 'ok' && r.error.message).toMatch(/APPLE_TEAM_ID/);
  });

  it('is BROKEN when a complete shared key does not parse (inline or by path)', () => {
    const r = resolveOfficialDev({ APPLE_TEAM_ID: 'T', APPLE_KEY_ID: 'K', APPLE_PRIVATE_KEY: '!!not a key!!' }, NOW);
    expect(r.status).toBe('broken');
    expect(r.status !== 'ok' && r.error.message).toMatch(/unusable/);
    const p = resolveOfficialDev({ APPLE_TEAM_ID: 'T', APPLE_KEY_ID: 'K', APPLE_PRIVATE_KEY_PATH: '/nonexistent/AuthKey.p8' }, NOW);
    expect(p.status).toBe('broken');
    expect(p.status !== 'ok' && p.error.message).toMatch(/Could not read the private key file/);
  });
});

describe('user tokens and overrides', () => {
  it('reads and remembers the user tokens', () => {
    expect(officialUserToken({ APPLE_MUSIC_USER_TOKEN: 'user-token-abcdefgh' })).toBe('user-token-abcdefgh');
    expect(officialUserToken({})).toBeUndefined();
    expect(webUserToken({ APPLE_MUSIC_WEB_USER_TOKEN: 'web-token-abcdefgh' })).toBe('web-token-abcdefgh');
    expect(scrub('web-token-abcdefgh and user-token-abcdefgh')).toBe('[REDACTED] and [REDACTED]');
  });

  it('validates APPLE_MUSIC_WEB_DEVELOPER_TOKEN', () => {
    expect(webDeveloperTokenOverride({}, NOW)).toBeUndefined();
    const t = fakeJwt({ iss: 'AMPWebPlay', exp: FAR_FUTURE });
    expect(webDeveloperTokenOverride({ APPLE_MUSIC_WEB_DEVELOPER_TOKEN: t }, NOW)).toEqual({ token: t, expiresAt: FAR_FUTURE * 1000 });
    expect(() => webDeveloperTokenOverride({ APPLE_MUSIC_WEB_DEVELOPER_TOKEN: fakeJwt({ exp: 1 }) }, NOW)).toThrow(/APPLE_MUSIC_WEB_DEVELOPER_TOKEN expired/);
  });

  it('reads APPLE_MUSIC_STOREFRONT and refuses a malformed one', () => {
    expect(storefrontFromEnv({})).toBeUndefined();
    expect(storefrontFromEnv({ APPLE_MUSIC_STOREFRONT: 'GB' })).toBe('gb');
    expect(() => storefrontFromEnv({ APPLE_MUSIC_STOREFRONT: 'england' })).toThrow(ConfigError);
  });
});
