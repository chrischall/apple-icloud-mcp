import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, CredentialsRejectedError, UnconfirmedWriteError, UpstreamError } from '../../src/errors.js';
import { MusicClient, requireData, totalOf, nextOf, type Backend } from '../../src/music/client.js';
import { stateCache } from '../../src/state.js';
import { OFFICIAL_DEV, USER_TOKEN, WEB_DEV, WEB_USER, fakeJwt, installFetch, p256Pem, route, useOfficial, useWeb } from './_helpers.js';

const json = (data: unknown) => ({ json: data });

beforeEach(() => {
  process.env.DISPLAY_TZ = 'America/New_York';
});

describe('routing', () => {
  it('extended ops need web mode, and say the official API cannot do them', () => {
    const c = new MusicClient();
    useOfficial();
    const err = (() => {
      try {
        c.route('extended', 'delete a playlist');
      } catch (e) {
        return e as ConfigError;
      }
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err!.message).toMatch(/official Apple Music API cannot delete a playlist/);
    expect(err!.missing).toEqual(['APPLE_MUSIC_WEB_USER_TOKEN']);
    useWeb();
    expect(c.route('extended', 'x').name).toBe('web');
  });

  it('catalog: official when a developer token is available, else web, else a ConfigError naming both', () => {
    const c = new MusicClient();
    expect(() => c.route('catalog', 'search')).toThrow(/needs credentials/);
    useWeb();
    expect(c.route('catalog', 'search').name).toBe('web');
    useOfficial({ user: false });
    const b = c.route('catalog', 'search');
    expect(b.name).toBe('official');
    expect(b.userToken).toBeUndefined();
    process.env.APPLE_MUSIC_DEVELOPER_TOKEN = fakeJwt({ exp: 5 });
    expect(() => c.route('catalog', 'search')).toThrow(/expired/);
  });

  it('library: official needs a user token too; otherwise web; otherwise precise errors', () => {
    const c = new MusicClient();
    expect(() => c.route('library', 'list your playlists')).toThrow(/none are configured/);
    useOfficial({ user: false });
    const e = (() => {
      try {
        c.route('library', 'list your playlists');
      } catch (err) {
        return err as ConfigError;
      }
    })();
    expect(e?.missing).toEqual(['APPLE_MUSIC_USER_TOKEN', 'APPLE_MUSIC_WEB_USER_TOKEN']);
    expect(e?.hint).toMatch(/music-auth/);
    useWeb();
    expect(c.route('library', 'x').name).toBe('web');
    process.env.APPLE_MUSIC_USER_TOKEN = USER_TOKEN;
    const b = c.route('library', 'x');
    expect(b.name).toBe('official');
    expect(b.userToken).toBe(USER_TOKEN);
  });

  it('a broken official credential is reported, not silently skipped, when it would have been used', () => {
    const c = new MusicClient();
    process.env.APPLE_MUSIC_DEVELOPER_TOKEN = 'nope';
    expect(() => c.route('library', 'x')).toThrow(/not a JWT/);
    process.env.APPLE_MUSIC_USER_TOKEN = USER_TOKEN;
    expect(() => c.route('library', 'x')).toThrow(/not a JWT/);
    useWeb();
    process.env.APPLE_MUSIC_DEVELOPER_TOKEN = 'nope';
    expect(() => c.route('library', 'x')).toThrow(/not a JWT/);
    delete process.env.APPLE_MUSIC_USER_TOKEN;
    expect(c.route('library', 'x').name).toBe('web');
  });

  it('describes where the web developer token comes from', () => {
    const c = new MusicClient();
    useWeb();
    expect(c.webBackend(WEB_USER).devSource).toBe('APPLE_MUSIC_WEB_DEVELOPER_TOKEN');
    delete process.env.APPLE_MUSIC_WEB_DEVELOPER_TOKEN;
    expect(c.webBackend(WEB_USER).devSource).toMatch(/web player/);
  });
});

describe('requests', () => {
  it('sends official credentials (Music-User-Token only when set) and web credentials with Origin, never x-apple-client-version', async () => {
    const { calls } = installFetch(route('GET', '/v1/test', json({ data: [] })));
    const c = new MusicClient();
    useOfficial({ user: false });
    await c.session('catalog', 'x').request({ path: '/v1/test' });
    useOfficial();
    await c.session('library', 'x').request({ path: '/v1/test' });
    delete process.env.APPLE_MUSIC_DEVELOPER_TOKEN;
    delete process.env.APPLE_MUSIC_USER_TOKEN;
    useWeb();
    await c.session('library', 'x').request({ path: '/v1/test' });
    expect(calls[0]!.host).toBe('api.music.apple.com');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${OFFICIAL_DEV}`);
    expect(calls[0]!.headers['music-user-token']).toBeUndefined();
    expect(calls[1]!.headers['music-user-token']).toBe(USER_TOKEN);
    expect(calls[2]!.host).toBe('amp-api.music.apple.com');
    expect(calls[2]!.headers).toMatchObject({ authorization: `Bearer ${WEB_DEV}`, 'media-user-token': WEB_USER, origin: 'https://music.apple.com', referer: 'https://music.apple.com/' });
    expect(Object.keys(calls[2]!.headers)).not.toContain('x-apple-client-version');
  });

  it('mints a developer token from the key, caches it, and re-mints once on a 401', async () => {
    process.env.APPLE_TEAM_ID = 'TEAM123456';
    process.env.APPLE_KEY_ID = 'KEY1234567';
    process.env.APPLE_PRIVATE_KEY = p256Pem();
    let n = 0;
    const { calls } = installFetch(route('GET', '/v1/catalog/us/songs', () => (++n === 2 ? { status: 401, text: '' } : json({ data: [] }))));
    let now = Date.now();
    const c = new MusicClient({ now: () => now });
    await c.session('catalog', 'x').request({ path: '/v1/catalog/us/songs' });
    const first = calls[0]!.headers.authorization;
    now += 1000;
    await c.session('catalog', 'x').request({ path: '/v1/catalog/us/songs' });
    expect(calls).toHaveLength(3);
    expect(calls[1]!.headers.authorization).toBe(first);
    expect(calls[2]!.headers.authorization).not.toBe(first);
    const payload = JSON.parse(Buffer.from(first!.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    expect(payload.iss).toBe('TEAM123456');
    // A different key gets its own token source.
    process.env.APPLE_PRIVATE_KEY = p256Pem();
    await c.session('catalog', 'x').request({ path: '/v1/catalog/us/songs' });
    expect(calls[3]!.headers.authorization).not.toBe(calls[2]!.headers.authorization);
  });

  it('a pre-minted token that Apple rejects is not retried and says which credential failed', async () => {
    useOfficial();
    const { calls } = installFetch(route('GET', '/v1/me/x', { status: 401, json: { errors: [{ title: 'Unauthorized' }] } }));
    const err = await new MusicClient().session('library', 'x').request({ path: '/v1/me/x' }).catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect(err).toBeInstanceOf(CredentialsRejectedError);
    expect((err as CredentialsRejectedError).status).toBe(401);
    expect((err as CredentialsRejectedError).message).toMatch(/music \(official\): GET \/v1\/me\/x failed with HTTP 401 — Unauthorized/);
    expect((err as CredentialsRejectedError).hint).toMatch(/APPLE_MUSIC_DEVELOPER_TOKEN.*MusicKit/);
  });

  it('a web token still rejected after a re-read gets the web hint', async () => {
    useWeb();
    installFetch(route('GET', '/v1/me/x', { status: 401, text: '' }));
    const err = (await new MusicClient().session('library', 'x').request({ path: '/v1/me/x' }).catch((e: unknown) => e)) as CredentialsRejectedError;
    expect(err.message).toMatch(/music \(web\): GET \/v1\/me\/x failed with HTTP 401$/);
    expect(err.hint).toMatch(/rotated or blocked/);
  });

  it('a web 401 right after the token was read from music.apple.com does not download the web player again', async () => {
    stateCache('music-web-token.json', 'web-token-v1', (v) => v).clear();
    process.env.APPLE_MUSIC_WEB_USER_TOKEN = WEB_USER;
    const page = '<script type="module" src="/assets/index~abc.js"></script>';
    const { calls } = installFetch(
      route('GET', '/us/browse', { text: page }, 'music.apple.com'),
      route('GET', '/assets/index~abc.js', { text: `x="${WEB_DEV}"` }, 'music.apple.com'),
      route('GET', '/v1/me/x', { status: 401, text: '' }, 'amp-api.music.apple.com'),
    );
    let now = Date.UTC(2026, 8, 27);
    const c = new MusicClient({ now: () => now });
    const err = (await c.session('library', 'x').request({ path: '/v1/me/x' }).catch((e: unknown) => e)) as CredentialsRejectedError;
    expect(err).toBeInstanceOf(CredentialsRejectedError);
    expect(err.hint).toMatch(/media-user-token session was signed out/);
    expect(calls.map((x) => x.path)).toEqual(['/us/browse', '/assets/index~abc.js', '/v1/me/x']);
    // The next call a minute later: still no re-read.
    now += 60_000;
    await c.session('library', 'x').request({ path: '/v1/me/x' }).catch(() => undefined);
    expect(calls.map((x) => x.path).slice(3)).toEqual(['/v1/me/x']);
    // Long after the last read, a 401 is worth one re-read (Apple may have rotated the token) and one replay.
    now += 60 * 60_000;
    await c.session('library', 'x').request({ path: '/v1/me/x' }).catch(() => undefined);
    expect(calls.map((x) => x.path).slice(4)).toEqual(['/v1/me/x', '/us/browse', '/assets/index~abc.js', '/v1/me/x']);
    stateCache('music-web-token.json', 'web-token-v1', (v) => v).clear();
  });

  it('falls back to web when Apple rejects the official token, latching catalog rejections for later calls', async () => {
    useOfficial();
    useWeb();
    const { calls } = installFetch(
      route('GET', /^\/v1\//, { status: 401, text: '' }, 'api.music.apple.com'),
      route('GET', /^\/v1\//, json({ data: [{ id: 'us', type: 'storefronts' }] }), 'amp-api.music.apple.com'),
    );
    const c = new MusicClient();
    const s = c.session('catalog', 'x');
    const res = await s.request({ path: '/v1/catalog/us/songs' });
    expect(res.status).toBe(200);
    expect(s.backend.name).toBe('web');
    expect(s.notes[0]).toMatch(/rejected the official developer token \(APPLE_MUSIC_DEVELOPER_TOKEN\)/);
    expect(c.route('catalog', 'x').name).toBe('web');
    expect(c.route('library', 'x').name).toBe('web');
    expect(calls.map((x) => x.host)).toEqual(['api.music.apple.com', 'amp-api.music.apple.com']);

    // A rejection on a /v1/me path falls back too, but does not latch (it may mean "no subscription").
    const c2 = new MusicClient();
    const s2 = c2.session('library', 'x');
    await s2.request({ path: '/v1/me/storefront' });
    expect(s2.backend.name).toBe('web');
    expect(c2.route('library', 'x').name).toBe('official');
  });

  it('maps 403, 404, 429, 5xx and other statuses', async () => {
    useWeb();
    installFetch(
      route('GET', '/403', { status: 403, json: { errors: [{ title: 'Forbidden', detail: 'Invalid authentication', code: '40300' }] } }),
      route('PUT', '/v1/me/library/playlists/p.x/tracks', { status: 403, text: '' }),
      route('GET', '/404', { status: 404, json: { errors: [{ title: 'Resource Not Found', code: '40400' }] } }),
      route('GET', '/404b', { status: 404, text: '' }),
      route('GET', '/429', { status: 429, text: '' }),
      route('GET', '/500', { status: 500, json: { errors: [{ title: 'Upstream Service Error', code: '50001' }] } }),
      route('POST', '/500', { status: 500, text: '' }),
      route('GET', '/400', { status: 400, json: { errors: [{ title: 'Invalid Parameter Value', detail: 'limit', code: '40005' }] } }),
    );
    const s = new MusicClient().session('library', 'x');
    type Err = Error & { hint?: string; status?: number; code?: string; upstreamCode?: string };
    const grab = (req: Parameters<typeof s.request>[0]): Promise<Err> =>
      s.request(req).then(
        () => {
          throw new Error('expected a rejection');
        },
        (e: unknown) => e as Err,
      );

    const e403 = await grab({ path: '/403' });
    expect(e403).toBeInstanceOf(CredentialsRejectedError);
    expect(e403.message).toMatch(/HTTP 403 — Forbidden: Invalid authentication/);
    expect(e403.hint).toMatch(/media-user-token.*privacy prompt/);
    expect(e403.hint).not.toMatch(/playlist change/);
    expect((await grab({ method: 'PUT', path: '/v1/me/library/playlists/p.x/tracks' })).hint).toMatch(/cannot be edited by this client/);

    const e404 = await grab({ path: '/404', notFoundHint: 'Look it up first.' });
    expect(e404).toBeInstanceOf(UpstreamError);
    expect(e404.code).toBe('NOT_FOUND');
    expect(e404.upstreamCode).toBe('40400');
    expect(e404.hint).toBe('Look it up first.');
    expect((await grab({ path: '/404b' })).hint).toMatch(/library ids and catalog ids differ/);

    const e429 = await grab({ path: '/429' });
    expect(e429.code).toBe('RATE_LIMITED');
    expect(e429.hint).toMatch(/shared web-player token/);

    const e500 = await grab({ path: '/500' });
    expect(e500).toBeInstanceOf(UpstreamError);
    expect(e500.upstreamCode).toBe('50001');
    expect(await grab({ method: 'POST', path: '/500' })).toBeInstanceOf(UnconfirmedWriteError);

    const e400 = await grab({ path: '/400' });
    expect(e400.code).toBe('UPSTREAM_ERROR');
    expect(e400.message).toMatch(/Invalid Parameter Value: limit/);
  });

  it('the official 429 hint and the official 403 hint name the official credentials', async () => {
    useOfficial();
    installFetch(route('GET', '/429', { status: 429, text: '' }), route('GET', '/403', { status: 403, text: '' }));
    const s = new MusicClient().session('library', 'x');
    expect(((await s.request({ path: '/429' }).catch((e: unknown) => e)) as { hint: string }).hint).toMatch(/this developer token/);
    expect(((await s.request({ path: '/403' }).catch((e: unknown) => e)) as { hint: string }).hint).toMatch(/APPLE_MUSIC_USER_TOKEN.*music-auth/);
  });

  it('refuses a non-JSON body and treats an empty body as no data', async () => {
    useWeb();
    installFetch(route('GET', '/bad', { text: '<html>oops</html>' }), route('POST', '/empty', { status: 202, text: '' }));
    const s = new MusicClient().session('library', 'x');
    await expect(s.request({ path: '/bad' })).rejects.toThrow(/not valid JSON/);
    expect(await s.request({ method: 'post', path: '/empty' })).toEqual({ status: 202, data: undefined });
  });
});

describe('paging', () => {
  it('page(): okStatuses give an empty page; a drifted shape is an error, never an empty list', async () => {
    useWeb();
    installFetch(
      route('GET', '/gone', { status: 404, text: '' }),
      route('GET', '/drift', json({ results: [] })),
      route('GET', '/ok', json({ data: [{ id: '1', type: 'songs' }], next: '/ok?offset=1', meta: { total: 7 } })),
    );
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const s = new MusicClient().session('library', 'x');
    expect(await s.page('/gone', {}, { okStatuses: [404] })).toEqual({ status: 404, items: [], hasMore: false });
    await expect(s.page('/drift', {})).rejects.toThrow(/unexpected shape \(no data array\)/);
    expect(await s.page('/ok', {})).toEqual({ status: 200, items: [{ id: '1', type: 'songs' }], hasMore: true, total: 7 });
    warn.mockRestore();
  });

  it('collect(): explicit offset+limit per request, stops on no next / empty page, and trusts meta.total', async () => {
    useWeb();
    const all = Array.from({ length: 7 }, (_, i) => ({ id: String(i), type: 'songs' }));
    const { calls } = installFetch(
      route('GET', '/list', (req) => {
        const limit = Number(req.query.get('limit'));
        const offset = Number(req.query.get('offset'));
        return json({ data: all.slice(offset, offset + limit), ...(offset + limit < all.length ? { next: `/list?offset=${offset + limit}` } : {}) });
      }),
      route('GET', '/total', json({ data: all.slice(0, 2), meta: { total: 7 } })),
      route('GET', '/emptynext', json({ data: [], next: '/emptynext?offset=9' })),
    );
    const s = new MusicClient().session('library', 'x');
    const r = await s.collect('/list', { types: ['songs'] }, { offset: 1, want: 5, perRequest: 2 });
    expect(r.items.map((x) => x.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(r.hasMore).toBe(true);
    expect(calls.map((c) => c.url.search)).toEqual(['?types=songs&limit=2&offset=1', '?types=songs&limit=2&offset=3', '?types=songs&limit=1&offset=5']);
    const r2 = await s.collect('/list', {}, { offset: 0, want: 50, perRequest: 5 });
    expect(r2.items).toHaveLength(7);
    expect(r2.hasMore).toBe(false);
    const r3 = await s.collect('/total', {}, { offset: 0, want: 2, perRequest: 2 });
    expect(r3).toEqual({ items: all.slice(0, 2), hasMore: true, total: 7 });
    expect(await s.collect('/emptynext', {}, { offset: 0, want: 5, perRequest: 5 })).toEqual({ items: [], hasMore: false });
  });

  it('helpers', () => {
    expect(() => requireData(null, 'GET /x')).toThrow(UpstreamError);
    expect(totalOf({ meta: { total: 3 } })).toBe(3);
    expect(totalOf({})).toBeUndefined();
    expect(nextOf({ next: '/x' })).toBe(true);
    expect(nextOf(undefined)).toBe(false);
  });
});

describe('resolveStorefront', () => {
  it('argument > APPLE_MUSIC_STOREFRONT > account (cached) > us', async () => {
    const c = new MusicClient();
    expect(await c.resolveStorefront('GB')).toEqual({ storefront: 'gb', source: 'argument' });
    process.env.APPLE_MUSIC_STOREFRONT = 'jp';
    expect(await c.resolveStorefront(undefined)).toEqual({ storefront: 'jp', source: 'APPLE_MUSIC_STOREFRONT' });
    delete process.env.APPLE_MUSIC_STOREFRONT;
    useOfficial({ user: false });
    expect(await c.resolveStorefront(undefined)).toEqual({ storefront: 'us', source: 'default' });
    process.env.APPLE_MUSIC_USER_TOKEN = USER_TOKEN;
    const { calls } = installFetch(route('GET', '/v1/me/storefront', json({ data: [{ id: 'de', type: 'storefronts' }] })));
    expect(await c.resolveStorefront(undefined)).toEqual({ storefront: 'de', source: 'account' });
    expect(await c.resolveStorefront(undefined)).toEqual({ storefront: 'de', source: 'account' });
    expect(calls).toHaveLength(1);
  });

  it('account credentials that are set but unusable are reported in a note, not skipped silently', async () => {
    useOfficial({ user: false });
    process.env.APPLE_MUSIC_WEB_USER_TOKEN = WEB_USER;
    process.env.APPLE_MUSIC_WEB_DEVELOPER_TOKEN = 'garbage';
    const { calls } = installFetch();
    const r = await new MusicClient().resolveStorefront(undefined);
    expect(r).toMatchObject({ storefront: 'us', source: 'default' });
    expect(r.note).toMatch(/Could not read your account's storefront \(APPLE_MUSIC_WEB_DEVELOPER_TOKEN is not a JWT.*\); used the US store/);
    expect(calls).toHaveLength(0);
  });

  it('a failed account lookup falls back to us WITH a note', async () => {
    useWeb();
    installFetch(route('GET', '/v1/me/storefront', { status: 403, text: '' }));
    const r = await new MusicClient().resolveStorefront(undefined);
    expect(r.storefront).toBe('us');
    expect(r.source).toBe('default');
    expect(r.note).toMatch(/Could not read your account's storefront .*HTTP 403/);
  });
});

describe('backend objects', () => {
  it('env-token backends cannot refresh; key backends can', () => {
    const c = new MusicClient();
    const env = c.officialBackend({ kind: 'env-token', token: OFFICIAL_DEV, expiresAt: 0, source: 'APPLE_MUSIC_DEVELOPER_TOKEN' });
    expect(env.refresh()).toBe(false);
    const key: Backend = c.officialBackend({ kind: 'key', key: { teamId: 'T', keyId: 'K', privateKeyPem: p256Pem(), source: 's' }, source: 's' }, USER_TOKEN);
    expect(key.refresh()).toBe(true);
    expect(key.userToken).toBe(USER_TOKEN);
    c.latchOfficial({ ...env, officialKey: undefined });
  });
});
