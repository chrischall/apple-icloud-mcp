import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureTools, callTool, installFetch, route, useOfficial, useWeb } from './_helpers.js';

const song = (id: string, name = `Song ${id}`) => ({
  id,
  type: 'songs',
  attributes: { name, artistName: 'Artist', albumName: 'Album', durationInMillis: 200000, releaseDate: '2020-01-31', artwork: { url: 'x' }, previews: [{ url: 'p' }] },
});

beforeEach(() => {
  process.env.DISPLAY_TZ = 'America/New_York';
});

describe('apple_music_search_catalog', () => {
  it('groups by type with per-group paging facts before the items, and reports the backend and storefront', async () => {
    useOfficial({ user: false });
    const { calls } = installFetch(
      route('GET', '/v1/catalog/gb/search', {
        json: {
          results: {
            songs: { href: '/x', next: '/v1/catalog/gb/search?offset=2&term=x&types=songs', data: [song('1'), song('2')] },
            albums: { data: [{ id: '9', type: 'albums', attributes: { name: 'LP', artistName: 'A', trackCount: 10 } }] },
          },
        },
      }),
    );
    const tools = captureTools();
    const r = await callTool(tools, 'apple_music_search_catalog', { term: 'hey jude', types: ['songs', 'albums', 'artists', 'songs'], limit: 2, storefront: 'GB' });
    expect(r.isError).toBe(false);
    expect(calls[0]!.url.search).toBe('?term=hey%20jude&types=songs,albums,artists&limit=2&offset=0');
    expect(r.data).toMatchObject({ backend: 'official', storefront: 'gb', term: 'hey jude', types: ['songs', 'albums', 'artists'] });
    const results = r.data.results as Record<string, Record<string, unknown>>;
    expect(Object.keys(results.songs!)).toEqual(['returned', 'offset', 'limit', 'nextOffset', 'hasMore', 'items']);
    expect(results.songs).toMatchObject({ returned: 2, hasMore: true, nextOffset: 2 });
    expect((results.songs!.items as unknown[])[0]).toEqual({
      id: '1',
      type: 'songs',
      name: 'Song 1',
      artistName: 'Artist',
      albumName: 'Album',
      duration: '3:20',
      durationMs: 200000,
      releaseDate: '2020-01-31',
      releaseDateDisplay: 'Fri, Jan 31, 2020',
    });
    expect(results.albums).toMatchObject({ returned: 1, hasMore: false, nextOffset: null });
    expect(results.artists).toMatchObject({ returned: 0, items: [] });
    expect(r.data.notes).toBeUndefined();
  });

  it('says what was searched when nothing matched, and full returns Apple\'s records', async () => {
    useWeb();
    installFetch(route('GET', '/v1/me/storefront', { json: { data: [{ id: 'jp' }] } }), route('GET', '/v1/catalog/jp/search', { json: { results: {} } }));
    const r = await callTool(captureTools(), 'apple_music_search_catalog', { term: 'zzqx', offset: 25, view: 'full' });
    expect(r.data.backend).toBe('web');
    expect(r.data.storefront).toBe('jp');
    expect(r.data.notes).toEqual(['No catalog results for "zzqx" among songs, albums, artists, playlists in the jp storefront at offset 25.']);
    const r0 = await callTool(captureTools(), 'apple_music_search_catalog', { term: 'zzqx', types: ['stations'] });
    expect(r0.data.notes).toEqual(['No catalog results for "zzqx" among stations in the jp storefront.']);
  });

  it('never renders a malformed answer as "no results"', async () => {
    useOfficial({ user: false });
    installFetch(route('GET', '/v1/catalog/us/search', { json: { oops: true } }), route('GET', '/v1/catalog/gb/search', { json: { results: { songs: { nope: 1 } } } }));
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tools = captureTools();
    const a = await callTool(tools, 'apple_music_search_catalog', { term: 'x' });
    expect(a.isError).toBe(true);
    expect((a.data.error as Record<string, unknown>).message).toMatch(/unexpected shape/);
    const b = await callTool(tools, 'apple_music_search_catalog', { term: 'x', storefront: 'gb' });
    expect(b.isError).toBe(true);
    warn.mockRestore();
  });

  it('a missing configuration is a structured NOT_CONFIGURED error naming both options', async () => {
    const r = await callTool(captureTools(), 'apple_music_search_catalog', { term: 'x' });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatchObject({ code: 'NOT_CONFIGURED', service: 'music' });
    expect((r.data.error as { missing: string[] }).missing).toContain('APPLE_MUSIC_WEB_USER_TOKEN');
  });
});

describe('apple_music_get_catalog_items', () => {
  const tools = () => captureTools();

  it.each([
    [{ type: 'songs' }, /exactly one of ids, isrc or upc/],
    [{ type: 'songs', ids: ['1'], isrc: ['USUM71703861'] }, /exactly one/],
    [{ type: 'albums', isrc: ['USUM71703861'] }, /isrc works only/],
    [{ type: 'songs', upc: ['00602445960248'] }, /upc works only/],
    [{ type: 'artists', ids: Array.from({ length: 26 }, (_, i) => String(i + 1)) }, /at most 25 artists/],
    [{ type: 'songs', ids: ['pl.x'] }, /numeric catalog songs id/],
    [{ type: 'songs', ids: ['1'], tracksLimit: 5 }, /single album or playlist/],
    [{ type: 'albums', ids: ['1', '2'], tracksOffset: 5 }, /single album or playlist/],
    [{ type: 'albums', ids: ['1'], views: ['top-songs'] }, /single artist/],
    [{ type: 'artists', ids: ['1', '2'], views: ['top-songs'] }, /single artist/],
  ])('refuses %j', async (args, msg) => {
    useOfficial({ user: false });
    installFetch();
    const r = await callTool(tools(), 'apple_music_get_catalog_items', args);
    expect(r.isError).toBe(true);
    expect((r.data.error as { code: string; message: string }).code).toBe('INVALID_ARGUMENT');
    expect((r.data.error as { message: string }).message).toMatch(msg);
  });

  it('multi-get by id reports missing ids', async () => {
    useOfficial({ user: false });
    const { calls } = installFetch(route('GET', '/v1/catalog/us/songs', { json: { data: [song('1')] } }));
    const r = await callTool(tools(), 'apple_music_get_catalog_items', { type: 'songs', ids: ['1', '2', '1'] });
    expect(calls[0]!.url.search).toBe('?ids=1,2');
    expect(r.data).toMatchObject({ backend: 'official', storefront: 'us', type: 'songs', requested: 2, returned: 1, missing: ['2'] });
  });

  it('ISRC and UPC lookups, and an empty answer says what was looked up', async () => {
    useOfficial({ user: false });
    const { calls } = installFetch(route('GET', '/v1/catalog/us/songs', { json: { data: [] } }), route('GET', '/v1/catalog/us/albums', { json: { data: [] } }));
    const a = await callTool(tools(), 'apple_music_get_catalog_items', { type: 'songs', isrc: ['USUM71703861'] });
    expect(calls[0]!.url.search).toBe('?filter[isrc]=USUM71703861');
    expect(a.data.notes).toEqual(['Apple returned no songs for ISRC USUM71703861 in the us storefront.']);
    // ISRCs are upper-case by definition; a lower-case one is normalized (and de-duplicated) before it is sent.
    await callTool(tools(), 'apple_music_get_catalog_items', { type: 'songs', isrc: ['usum71703861', 'USUM71703861'] });
    expect(calls.at(-1)!.url.search).toBe('?filter[isrc]=USUM71703861');
    calls.pop();
    const b = await callTool(tools(), 'apple_music_get_catalog_items', { type: 'albums', upc: ['00602445960248'] });
    expect(calls[1]!.url.search).toBe('?filter[upc]=00602445960248');
    expect(b.data.notes).toEqual(['Apple returned no albums for UPC 00602445960248 in the us storefront.']);
    const c = await callTool(tools(), 'apple_music_get_catalog_items', { type: 'albums', ids: ['5'] });
    expect(c.data.notes).toEqual(['Apple returned no albums for ids 5 in the us storefront.']);
    expect(c.data.missing).toEqual(['5']);
  });

  it('a single album includes its tracks, paged, with absolute positions; paging facts precede the data', async () => {
    useOfficial({ user: false });
    const tracks = Array.from({ length: 5 }, (_, i) => song(String(100 + i)));
    const { calls } = installFetch(
      route('GET', '/v1/catalog/us/albums', { json: { data: [{ id: '7', type: 'albums', attributes: { name: 'LP', trackCount: 5 } }] } }),
      route('GET', '/v1/catalog/us/albums/7/tracks', (req) => {
        const o = Number(req.query.get('offset'));
        const l = Number(req.query.get('limit'));
        return { json: { data: tracks.slice(o, o + l), ...(o + l < 5 ? { next: '/n' } : {}), meta: { total: 5 } } };
      }),
    );
    const r = await callTool(tools(), 'apple_music_get_catalog_items', { type: 'albums', ids: ['7'], tracksLimit: 2, tracksOffset: 1 });
    expect(calls[1]!.url.search).toBe('?limit=2&offset=1');
    expect(r.data.tracksPage).toEqual({ returned: 2, total: 5, offset: 1, limit: 2, nextOffset: 3, hasMore: true });
    expect((r.data.tracks as Array<{ position: number; id: string }>).map((t) => [t.position, t.id])).toEqual([
      [2, '101'],
      [3, '102'],
    ]);
    const keys = Object.keys(r.data);
    expect(keys.indexOf('tracksPage')).toBeLessThan(keys.indexOf('items'));
    expect(keys.at(-1)).toBe('tracks');
  });

  it('a playlist with no tracks at the offset says so; a null track survives the raw fallback', async () => {
    useOfficial({ user: false });
    installFetch(
      route('GET', '/v1/catalog/us/playlists', { json: { data: [{ id: 'pl.a', type: 'playlists', attributes: { name: 'PL', curatorName: 'Apple Music' } }] } }),
      route('GET', '/v1/catalog/us/playlists/pl.a/tracks', (req) => (req.query.get('offset') === '0' ? { json: { data: [null] } } : { status: 404, text: '' })),
    );
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const empty = await callTool(tools(), 'apple_music_get_catalog_items', { type: 'playlists', ids: ['pl.a'], tracksOffset: 3 });
    expect(empty.data.notes).toEqual(['No tracks were returned for pl.a at offset 3.']);
    const zero = await callTool(tools(), 'apple_music_get_catalog_items', { type: 'playlists', ids: ['pl.a'], view: 'full' });
    expect(zero.data.tracks).toEqual([null]);
    warn.mockRestore();
    const none = await callTool(tools(), 'apple_music_get_catalog_items', { type: 'playlists', ids: ['pl.a'], tracksLimit: 3, tracksOffset: 0 });
    expect(none.data.tracksPage).toMatchObject({ returned: 1 });
  });

  it('an empty playlist at offset 0 notes that no tracks came back', async () => {
    useOfficial({ user: false });
    installFetch(
      route('GET', '/v1/catalog/us/playlists', { json: { data: [{ id: 'pl.b', type: 'playlists', attributes: { name: 'PL' } }] } }),
      route('GET', '/v1/catalog/us/playlists/pl.b/tracks', { status: 404, text: '' }),
    );
    const r = await callTool(tools(), 'apple_music_get_catalog_items', { type: 'playlists', ids: ['pl.b'] });
    expect(r.data.notes).toEqual(['No tracks were returned for pl.b.']);
  });

  it('artist views: compact per view; a missing artist is reported, not thrown', async () => {
    useOfficial({ user: false });
    const { calls } = installFetch(
      route('GET', '/v1/catalog/us/artists/5', {
        json: {
          data: [
            {
              id: '5',
              type: 'artists',
              attributes: { name: 'Band' },
              views: {
                'top-songs': { next: '/v1/catalog/us/artists/5/view/top-songs?offset=1', data: [song('1')] },
                'latest-release': {},
                singles: { next: '/v1/catalog/us/artists/5/view/singles?offset=0' },
              },
            },
          ],
        },
      }),
      route('GET', '/v1/catalog/us/artists/6', { status: 404, text: '' }),
    );
    const r = await callTool(tools(), 'apple_music_get_catalog_items', { type: 'artists', ids: ['5'], views: ['top-songs', 'latest-release', 'top-songs', 'singles'] });
    expect(calls[0]!.url.search).toBe('?views=top-songs,latest-release,singles');
    const item = (r.data.items as Array<Record<string, unknown>>)[0]!;
    expect(item.name).toBe('Band');
    expect((item.views as Record<string, unknown[]>)['top-songs']).toHaveLength(1);
    expect((item.views as Record<string, unknown[]>)['latest-release']).toEqual([]);
    // A view is Apple's first page; one that has more says so instead of passing for the whole list.
    expect(r.data.notes).toEqual(["The top-songs view shows Apple's first 1 items; Apple has more."]);
    const full = await callTool(tools(), 'apple_music_get_catalog_items', { type: 'artists', ids: ['5'], views: ['top-songs'], view: 'full' });
    expect((full.data.items as Array<Record<string, unknown>>)[0]!.views).toBeDefined();
    const missing = await callTool(tools(), 'apple_music_get_catalog_items', { type: 'artists', ids: ['6'], views: ['top-songs'] });
    expect(missing.data).toMatchObject({ returned: 0, missing: ['6'] });
  });
});

describe('apple_music_get_charts', () => {
  it('flattens Apple\'s chart arrays with per-chart paging, and notes absent types', async () => {
    useOfficial({ user: false });
    const { calls } = installFetch(
      route('GET', '/v1/catalog/us/charts', {
        json: {
          results: {
            songs: [{ chart: 'most-played', name: 'Top Songs', orderId: 'x', next: '/n', data: [song('1')] }, { data: [] }],
          },
        },
      }),
    );
    const r = await callTool(captureTools(), 'apple_music_get_charts', { genre: '20', chart: 'most-played', types: ['songs', 'albums'], limit: 1 });
    expect(calls[0]!.url.search).toBe('?types=songs,albums&limit=1&offset=0&chart=most-played&genre=20');
    const charts = r.data.charts as Array<Record<string, unknown>>;
    expect(charts[0]).toMatchObject({ type: 'songs', chart: 'most-played', name: 'Top Songs', returned: 1, hasMore: true, nextOffset: 1 });
    expect(charts[1]).toEqual({ type: 'songs', returned: 0, offset: 0, limit: 1, nextOffset: null, hasMore: false, items: [] });
    expect(r.data).toMatchObject({ chart: 'most-played', genre: '20' });
    expect(r.data.notes).toEqual(['Apple returned no albums chart for this storefront and genre 20 (chart most-played).']);
    const onlySongs = await callTool(captureTools(), 'apple_music_get_charts', { types: ['songs'] });
    expect(onlySongs.data.notes).toBeUndefined();
    expect(onlySongs.data.charts).toHaveLength(2);
  });

  it('defaults, and refuses malformed answers', async () => {
    useOfficial({ user: false });
    installFetch(
      route('GET', '/v1/catalog/us/charts', { json: { results: { songs: [], albums: [], playlists: [] } } }),
      route('GET', '/v1/catalog/gb/charts', { json: { results: { songs: {} } } }),
      route('GET', '/v1/catalog/jp/charts', { json: {} }),
    );
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tools = captureTools();
    const ok = await callTool(tools, 'apple_music_get_charts', {});
    expect(ok.data).toEqual({
      backend: 'official',
      storefront: 'us',
      notes: ['Apple returned no songs, albums, playlists chart for this storefront.'],
      charts: [],
    });
    expect((await callTool(tools, 'apple_music_get_charts', { storefront: 'gb', types: ['songs'] })).isError).toBe(true);
    expect((await callTool(tools, 'apple_music_get_charts', { storefront: 'jp' })).isError).toBe(true);
    const noGenre = await callTool(tools, 'apple_music_get_charts', { storefront: 'us', types: ['music-videos'] });
    expect(noGenre.data.notes).toEqual(['Apple returned no music-videos chart for this storefront.']);
    warn.mockRestore();
  });
});
