import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MusicClient } from '../../src/music/client.js';
import { resetDefaultMusicClient } from '../../src/music/common.js';
import { PROBE_LABEL, makeMusicHealth, musicHealth } from '../../src/music/health.js';
import { stateCache } from '../../src/state.js';
import { FAR_FUTURE, OFFICIAL_DEV, WEB_DEV, fakeJwt, installFetch, p256Pem, route, useOfficial, useWeb } from './_helpers.js';

beforeEach(() => {
  process.env.DISPLAY_TZ = 'America/New_York';
  stateCache('music-web-token.json', 'web-token-v1', (v) => v).clear();
});

const health = () => makeMusicHealth(() => new MusicClient()).check();

describe('musicHealth', () => {
  it('not configured: names both options and probes nothing', async () => {
    const { calls } = installFetch();
    const h = await health();
    expect(h).toMatchObject({ service: 'music', configured: false });
    expect(h.missing).toEqual(['APPLE_TEAM_ID + APPLE_KEY_ID + APPLE_PRIVATE_KEY (or APPLE_MUSIC_DEVELOPER_TOKEN)', 'APPLE_MUSIC_WEB_USER_TOKEN']);
    expect(calls).toHaveLength(0);
  });

  it('official developer token only: one GET /v1/test, plus a note about the missing user token', async () => {
    useOfficial({ user: false });
    const { calls } = installFetch(route('GET', '/v1/test', { status: 200, text: '' }, 'api.music.apple.com'));
    const h = await health();
    expect(h).toMatchObject({ configured: true, ok: true, probe: PROBE_LABEL, credential: { source: 'official: APPLE_MUSIC_DEVELOPER_TOKEN', detail: { official: { developerToken: 'APPLE_MUSIC_DEVELOPER_TOKEN', userToken: false }, web: { enabled: false } } } });
    expect(h.notes).toEqual([
      'APPLE_MUSIC_DEVELOPER_TOKEN expires Thu, Dec 31, 2099, 7:00 PM EST.',
      "Official API: catalog only — set APPLE_MUSIC_USER_TOKEN for your library (run `npx @chrischall/aws-mcp music-auth` with the server's Apple Developer key set — or, without the key, with APPLE_MUSIC_DEVELOPER_TOKEN set to a token its owner mints with `music-auth --print-developer-token`).",
      'official developer token: OK',
    ]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/test']);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${OFFICIAL_DEV}`);
  });

  it('never probes a catalog item: a working key passes even where every catalog id would 404', async () => {
    useOfficial({ user: false });
    // The old probe read catalog song 1440833851, which Apple does not have: a 404 failed every working setup.
    const { calls } = installFetch(
      route('GET', '/v1/test', { status: 200, text: '' }),
      route('GET', /^\/v1\/catalog\//, { status: 404, json: { errors: [{ status: '404', code: '40400', title: 'Resource Not Found' }] } }),
    );
    const h = await health();
    expect(h).toMatchObject({ ok: true, probe: expect.stringMatching(/^official: GET \/v1\/test /) });
    expect(calls.every((c) => !c.path.startsWith('/v1/catalog/'))).toBe(true);
  });

  it('official + user token + web: probes each backend directly and reports storefronts', async () => {
    useOfficial();
    process.env.APPLE_MUSIC_WEB_USER_TOKEN = 'web-media-user-token-0123456789';
    installFetch(
      route('GET', '/v1/test', { status: 200, text: '' }, 'api.music.apple.com'),
      route('GET', '/v1/me/storefront', { json: { data: [{ id: 'gb' }] } }, 'api.music.apple.com'),
      route('GET', '/us/browse', { text: '<script src="/assets/index~abc.js">' }),
      route('GET', '/assets/index~abc.js', { text: `"${fakeJwt({ iss: 'AMPWebPlay', exp: FAR_FUTURE })}"` }),
      route('GET', '/v1/me/storefront', { text: 'not json' }, 'amp-api.music.apple.com'),
    );
    const h = await health();
    expect(h.ok).toBe(true);
    expect(h.credential?.source).toBe('official: APPLE_MUSIC_DEVELOPER_TOKEN + APPLE_MUSIC_USER_TOKEN; web: APPLE_MUSIC_WEB_USER_TOKEN');
    expect(h.credential?.detail?.web).toEqual({ enabled: true, developerToken: 'music.apple.com' });
    expect(h.notes).toContain('The web-player developer token will be read from music.apple.com on first use.');
    expect(h.notes).toContain('official developer token: OK');
    expect(h.notes).toContain('official library: OK (storefront gb)');
    expect(h.notes).toContain('web: OK');
    expect(h.notes).toContain("Web-player mode uses Apple's unofficial web-player API, which Apple may change or block without notice.");
  });

  it('an official storefront answer without an id still passes', async () => {
    useOfficial();
    installFetch(route('GET', '/v1/test', { json: {} }), route('GET', '/v1/me/storefront', { json: { data: [] } }));
    const h = await health();
    expect(h.ok).toBe(true);
    expect(h.notes).toContain('official library: OK');
  });

  it('web with an env token or a cached scraped token reports its expiry', async () => {
    useWeb();
    installFetch(route('GET', '/v1/me/storefront', { json: { data: [{ id: 'us' }] } }));
    const h = await health();
    expect(h).toMatchObject({ ok: true, credential: { source: 'web: APPLE_MUSIC_WEB_USER_TOKEN' } });
    expect(h.credential?.detail?.web).toEqual({ enabled: true, developerToken: 'APPLE_MUSIC_WEB_DEVELOPER_TOKEN', developerTokenExpires: '2099-12-31T19:00:00-05:00' });
    expect(h.notes).toContain('web: OK (storefront us)');
    delete process.env.APPLE_MUSIC_WEB_DEVELOPER_TOKEN;
    stateCache('music-web-token.json', 'web-token-v1', (v) => v).save({ token: WEB_DEV, expiresAt: FAR_FUTURE * 1000 });
    const h2 = await health();
    expect(h2.notes?.[0]).toMatch(/Web-player developer token \(music.apple.com\) expires Thu, Dec 31, 2099/);
  });

  it('a broken web override is shown in detail and fails the probe', async () => {
    process.env.APPLE_MUSIC_WEB_USER_TOKEN = 'web-media-user-token-0123456789';
    process.env.APPLE_MUSIC_WEB_DEVELOPER_TOKEN = 'garbage';
    installFetch();
    const h = await health();
    expect(h.configured).toBe(true);
    expect(h.ok).toBe(false);
    expect((h.credential?.detail?.web as { error: string }).error).toMatch(/not a JWT/);
    expect(h.error?.code).toBe('NOT_CONFIGURED');
  });

  it('a misconfigured official profile is configured-but-failing, not "not configured"', async () => {
    process.env.APPLE_MUSIC_DEVELOPER_TOKEN = fakeJwt({ exp: 10 });
    const { calls } = installFetch();
    const h = await health();
    expect(h).toMatchObject({ configured: true, ok: false, credential: { source: 'official: misconfigured' } });
    expect(h.error?.message).toMatch(/expired/);
    expect(h.notes).toEqual([expect.stringMatching(/^official: FAILED — NOT_CONFIGURED: .*expired/)]);
    expect(calls).toHaveLength(0);
  });

  it('a misconfigured official profile does not stop the web profile from being checked', async () => {
    process.env.APPLE_MUSIC_DEVELOPER_TOKEN = fakeJwt({ exp: 10 });
    useWeb();
    installFetch(route('GET', '/v1/me/storefront', { json: { data: [{ id: 'us' }] } }, 'amp-api.music.apple.com'));
    const h = await health();
    expect(h).toMatchObject({ ok: false, error: { code: 'NOT_CONFIGURED' } });
    expect(h.notes).toContain('web: OK (storefront us)');
    expect(h.notes).toContain("Web-player mode uses Apple's unofficial web-player API, which Apple may change or block without notice.");
  });

  it('a rejected developer key is reported with its status and hint (no web fallback), and the web profile is still checked', async () => {
    process.env.APPLE_TEAM_ID = 'TEAM123456';
    process.env.APPLE_KEY_ID = 'KEY1234567';
    process.env.APPLE_PRIVATE_KEY = p256Pem();
    useWeb();
    const { calls } = installFetch(
      route('GET', '/v1/test', { status: 401, text: '' }, 'api.music.apple.com'),
      route('GET', '/v1/me/storefront', { json: { data: [{ id: 'us' }] } }, 'amp-api.music.apple.com'),
    );
    const h = await health();
    expect(h).toMatchObject({ ok: false, error: { code: 'CREDENTIALS_REJECTED', status: 401 } });
    expect(h.hint).toMatch(/Media Services \(MusicKit\)/);
    expect(calls.map((c) => `${c.host} ${c.path}`)).toEqual([
      'api.music.apple.com /v1/test',
      'api.music.apple.com /v1/test',
      'amp-api.music.apple.com /v1/me/storefront',
    ]);
    expect(h.notes).toEqual([
      expect.stringMatching(/^Official API: catalog only/),
      expect.stringMatching(/^Web-player developer token/),
      "Web-player mode uses Apple's unofficial web-player API, which Apple may change or block without notice.",
      expect.stringMatching(/^official developer token: FAILED — CREDENTIALS_REJECTED \(HTTP 401\): music \(official\): GET \/v1\/test failed with HTTP 401/),
      'web: OK (storefront us)',
    ]);
  });

  it('each official check runs whatever the other answered: a refused user token is the error, the rest still report', async () => {
    useOfficial();
    useWeb();
    const { calls } = installFetch(
      route('GET', '/v1/test', { status: 200, text: '' }, 'api.music.apple.com'),
      route('GET', '/v1/me/storefront', { status: 403, json: { errors: [{ status: '403', title: 'Forbidden' }] } }, 'api.music.apple.com'),
      route('GET', '/v1/me/storefront', { json: { data: [{ id: 'gb' }] } }, 'amp-api.music.apple.com'),
    );
    const h = await health();
    expect(h).toMatchObject({ ok: false, error: { code: 'CREDENTIALS_REJECTED', status: 403 } });
    expect(h.notes).toContain('official developer token: OK');
    expect(h.notes).toContainEqual(expect.stringMatching(/^official library: FAILED — CREDENTIALS_REJECTED \(HTTP 403\)/));
    expect(h.notes).toContain('web: OK (storefront gb)');
    expect(calls).toHaveLength(3);
  });

  it('a failure that is not an Apple error is still reported per backend', async () => {
    useOfficial({ user: false });
    const c = new MusicClient();
    vi.spyOn(c, 'send').mockRejectedValue(undefined);
    const h = await makeMusicHealth(() => c).check();
    expect(h).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(h.notes).toContainEqual(expect.stringMatching(/^official developer token: FAILED — INTERNAL_ERROR: /));
  });

  it('a client that cannot even be built fails the check without per-backend notes', async () => {
    useOfficial();
    const h = await makeMusicHealth(() => {
      throw new Error('boom');
    }).check();
    expect(h).toMatchObject({ configured: true, ok: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } });
    expect(h.notes).toBeUndefined();
  });

  it('the exported probe uses the shared client', async () => {
    resetDefaultMusicClient();
    const h = await musicHealth.check();
    expect(h.configured).toBe(false);
    expect(musicHealth.service).toBe('music');
  });
});
