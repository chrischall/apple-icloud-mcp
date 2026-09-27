import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stateRevision } from '../../src/tools/_confirm.js';
import { FakeLibrary, captureTools, callTool, installFetch, route, track, useOfficial, useWeb } from './_helpers.js';

beforeEach(() => {
  process.env.DISPLAY_TZ = 'America/New_York';
});

function lib(): FakeLibrary {
  const l = new FakeLibrary();
  l.addPlaylist('p.A', { name: 'Road Trip', description: 'Loud', tracks: Array.from({ length: 5 }, (_, i) => track(i + 1)) });
  l.addPlaylist('p.B', { name: 'Empty', tracks: [] });
  l.addPlaylist('p.C', { name: 'Apple Mix', canEdit: false, hasCatalog: true });
  l.folders.set('p.F1', { name: 'Chill', dateAdded: '2024-05-05T10:00:00Z' });
  l.folders.set('p.F2', { name: 'Nested', parent: 'p.F1' });
  l.playlists.get('p.C')!.parent = 'p.F1';
  return l;
}

describe('apple_music_list_playlists', () => {
  it('lists library playlists with paging first and the data array last', async () => {
    useOfficial();
    const l = lib();
    const { calls } = installFetch(l.handler());
    const r = await callTool(captureTools(), 'apple_music_list_playlists', { limit: 2 });
    expect(calls[0]!.url.search).toBe('?limit=2&offset=0');
    expect(calls[0]!.headers['music-user-token']).toBeDefined();
    expect(Object.keys(r.data)).toEqual(['backend', 'returned', 'offset', 'limit', 'nextOffset', 'hasMore', 'playlists']);
    expect(r.data).toMatchObject({ backend: 'official', returned: 2, hasMore: true, nextOffset: 2 });
    expect((r.data.playlists as unknown[])[0]).toEqual({
      id: 'p.A',
      type: 'library-playlists',
      name: 'Road Trip',
      dateAdded: '2025-01-01T22:04:05-05:00',
      dateAddedDisplay: 'Wed, Jan 1, 2025, 10:04 PM EST',
      canEdit: true,
      isPublic: false,
      hasCatalog: false,
      description: 'Loud',
    });
  });

  it('says so when the library has no playlists', async () => {
    useWeb();
    installFetch(new FakeLibrary().handler());
    const r = await callTool(captureTools(), 'apple_music_list_playlists', { offset: 10 });
    expect(r.data.notes).toEqual(['Your library has no playlists at offset 10.']);
    const r0 = await callTool(captureTools(), 'apple_music_list_playlists', {});
    expect(r0.data.notes).toEqual(['Your library has no playlists.']);
  });

  it('lists a folder\'s children; an empty folder is empty, a missing one is NOT_FOUND', async () => {
    useWeb();
    const l = lib();
    l.folders.set('p.EMPTY', { name: 'Nothing' });
    installFetch(l.handler());
    const tools = captureTools();
    const r = await callTool(tools, 'apple_music_list_playlists', { folderId: 'p.F1' });
    expect(r.data).toMatchObject({ backend: 'web', folderId: 'p.F1', returned: 2 });
    expect((r.data.children as Array<{ id: string }>).map((c) => c.id)).toEqual(['p.F2', 'p.C']);
    l.metaTotal = true;
    const root = await callTool(tools, 'apple_music_list_playlists', { folderId: 'root', view: 'full' });
    expect(root.data.folderId).toBe('p.playlistsroot');
    expect(root.data.total).toBe(4);
    l.metaTotal = false;
    const empty = await callTool(tools, 'apple_music_list_playlists', { folderId: 'p.EMPTY' });
    expect(empty.data.notes).toEqual(['Folder p.EMPTY has nothing.']);
    const past = await callTool(tools, 'apple_music_list_playlists', { folderId: 'p.F1', offset: 50 });
    expect(past.data.notes).toEqual(['Folder p.F1 has nothing at offset 50.']);
    const missing = await callTool(tools, 'apple_music_list_playlists', { folderId: 'p.NOPE' });
    expect(missing.isError).toBe(true);
    expect(missing.data.error).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect((missing.data.error as { hint: string }).hint).toMatch(/apple_music_list_folders/);
    const bad = await callTool(tools, 'apple_music_list_playlists', { folderId: 'pl.x' });
    expect((bad.data.error as { code: string }).code).toBe('INVALID_ARGUMENT');
  });
});

describe('apple_music_get_playlist', () => {
  it('returns tracks with absolute positions, catalog ids, and a revision when the whole list was read', async () => {
    useWeb();
    const l = lib();
    installFetch(l.handler());
    const r = await callTool(captureTools(), 'apple_music_get_playlist', { playlistId: 'p.A' });
    expect(r.data).toMatchObject({ backend: 'web', returned: 5, total: 5, hasMore: false, revision: stateRevision(['i.T1', 'i.T2', 'i.T3', 'i.T4', 'i.T5']) });
    expect((r.data.playlist as Record<string, unknown>).name).toBe('Road Trip');
    expect((r.data.tracks as unknown[])[0]).toEqual({
      position: 1,
      id: 'i.T1',
      type: 'library-songs',
      name: 'Song 1',
      artistName: 'Artist 1',
      albumName: 'Album 1',
      duration: '3:01',
      durationMs: 181000,
      catalogId: '1001',
    });
    const keys = Object.keys(r.data);
    expect(keys.slice(-2)).toEqual(['playlist', 'tracks']);
  });

  it('pages 100 at a time under the hood, and a window has no revision', async () => {
    useWeb();
    const l = new FakeLibrary();
    l.metaTotal = true;
    l.addPlaylist('p.BIG', { name: 'Big', tracks: Array.from({ length: 250 }, (_, i) => track(i + 1)) });
    const { calls } = installFetch(l.handler());
    const r = await callTool(captureTools(), 'apple_music_get_playlist', { playlistId: 'p.BIG', limit: 150, offset: 10 });
    expect(calls.slice(1).map((c) => c.url.search)).toEqual(['?limit=100&offset=10', '?limit=50&offset=110']);
    expect(r.data).toMatchObject({ returned: 150, total: 250, hasMore: true, nextOffset: 160 });
    expect(r.data.revision).toBeUndefined();
    expect((r.data.tracks as Array<{ position: number }>)[0]!.position).toBe(11);
  });

  it('allTracks reads everything (and refuses limit/offset); a capped read says so', async () => {
    useWeb();
    const l = new FakeLibrary();
    l.addPlaylist('p.HUGE', { name: 'Huge', tracks: Array.from({ length: 5001 }, (_, i) => track(i + 1)) });
    installFetch(l.handler());
    const tools = captureTools();
    const bad = await callTool(tools, 'apple_music_get_playlist', { playlistId: 'p.HUGE', allTracks: true, limit: 5 });
    expect((bad.data.error as { message: string }).message).toMatch(/do not combine/);
    const r = await callTool(tools, 'apple_music_get_playlist', { playlistId: 'p.HUGE', allTracks: true, view: 'full' });
    expect(r.data).toMatchObject({ returned: 5000, hasMore: true, nextOffset: 5000 });
    expect(r.data.notes).toEqual(['Stopped after 5000 tracks; the playlist has more. Page on with offset 5000.']);
    expect(r.data.revision).toBeUndefined();
    expect((r.data.tracks as Array<Record<string, unknown>>)[0]!.attributes).toBeDefined();
  });

  it('an empty playlist is explained, not an error; past the end is said', async () => {
    useWeb();
    installFetch(lib().handler());
    const tools = captureTools();
    const r = await callTool(tools, 'apple_music_get_playlist', { playlistId: 'p.B' });
    expect(r.data).toMatchObject({ returned: 0, total: 0, revision: stateRevision([]) });
    expect(r.data.notes).toEqual(['Apple answered 404 for the track list, which is what it does for a playlist with no tracks.']);
    const past = await callTool(tools, 'apple_music_get_playlist', { playlistId: 'p.A', offset: 10 });
    expect(past.data.notes).toEqual(['No tracks at offset 10.']);
  });

  it('a missing library playlist is NOT_FOUND with a pointer; a non-playlist id is refused', async () => {
    useWeb();
    installFetch(lib().handler());
    const tools = captureTools();
    const r = await callTool(tools, 'apple_music_get_playlist', { playlistId: 'p.GONE' });
    expect(r.data.error).toMatchObject({ code: 'NOT_FOUND' });
    expect((r.data.error as { hint: string }).hint).toMatch(/apple_music_list_playlists/);
    expect(((await callTool(tools, 'apple_music_get_playlist', { playlistId: 'i.x' })).data.error as { message: string }).message).toMatch(/not a playlist id/);
    expect(((await callTool(tools, 'apple_music_get_playlist', { playlistId: 'p.A', storefront: 'us' })).data.error as { message: string }).message).toMatch(/catalog playlists/);
  });

  it('a playlist answer with no record is NOT_FOUND', async () => {
    useWeb();
    installFetch(route('GET', '/v1/me/library/playlists/p.Z', { json: { data: [] } }));
    const r = await callTool(captureTools(), 'apple_music_get_playlist', { playlistId: 'p.Z' });
    expect(r.data.error).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reads a catalog playlist (pl.…) in a storefront', async () => {
    useOfficial({ user: false });
    const { calls } = installFetch(
      route('GET', '/v1/catalog/fr/playlists/pl.x', { json: { data: [{ id: 'pl.x', type: 'playlists', attributes: { name: 'Hits', curatorName: 'Apple Music' } }] } }),
      route('GET', '/v1/catalog/fr/playlists/pl.x/tracks', { json: { data: [{ id: '1', type: 'songs', attributes: { name: 'One' } }], meta: { total: 1 } } }),
      route('GET', '/v1/catalog/us/playlists/pl.y', { json: { data: [] } }),
    );
    const tools = captureTools();
    const r = await callTool(tools, 'apple_music_get_playlist', { playlistId: 'pl.x', storefront: 'fr', limit: 300 });
    expect(calls[1]!.url.search).toBe('?limit=300&offset=0');
    expect(r.data).toMatchObject({ backend: 'official', returned: 1, total: 1, revision: stateRevision(['1']) });
    expect((r.data.playlist as Record<string, unknown>).curatorName).toBe('Apple Music');
    installFetch(
      route('GET', '/v1/catalog/us/playlists/pl.e', { json: { data: [{ id: 'pl.e', type: 'playlists', attributes: { name: 'Empty' } }] } }),
      route('GET', '/v1/catalog/us/playlists/pl.e/tracks', { status: 404, text: '' }),
      route('GET', '/v1/me/library/playlists/p.E200', { json: { data: [{ id: 'p.E200', type: 'library-playlists', attributes: { name: 'E' } }] } }),
      route('GET', '/v1/me/library/playlists/p.E200/tracks', { json: { data: [] } }),
      route('GET', '/v1/catalog/us/playlists/pl.y', { json: { data: [] } }),
    );
    const empty = await callTool(tools, 'apple_music_get_playlist', { playlistId: 'pl.e' });
    expect(empty.data).toMatchObject({ returned: 0, total: 0, notes: ['Apple returned no tracks for this playlist.'] });
    process.env.APPLE_MUSIC_USER_TOKEN = 'official-user-token-0123456789';
    const e200 = await callTool(tools, 'apple_music_get_playlist', { playlistId: 'p.E200' });
    expect(e200.data.notes).toEqual(['This playlist has no tracks.']);
    const missing = await callTool(tools, 'apple_music_get_playlist', { playlistId: 'pl.y' });
    expect(missing.data.error).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('apple_music_list_folders', () => {
  it('lists sub-folders with ids and counts the playlists beside them', async () => {
    useWeb();
    installFetch(lib().handler());
    const tools = captureTools();
    const root = await callTool(tools, 'apple_music_list_folders', {});
    expect(root.data).toMatchObject({ backend: 'web', folderId: 'p.playlistsroot', isRoot: true, returned: 1, playlistCount: 2, complete: true });
    expect(root.data.folders).toEqual([{ id: 'p.F1', name: 'Chill', dateAdded: '2024-05-05T06:00:00-04:00', dateAddedDisplay: 'Sun, May 5, 2024, 6:00 AM EDT' }]);
    const sub = await callTool(tools, 'apple_music_list_folders', { folderId: 'p.F1' });
    expect(sub.data).toMatchObject({ folderId: 'p.F1', returned: 1, playlistCount: 1 });
    expect(sub.data.isRoot).toBeUndefined();
    const leaf = await callTool(tools, 'apple_music_list_folders', { folderId: 'p.F2' });
    expect(leaf.data.notes).toEqual(['No sub-folders in folder p.F2.']);
    const bare = new FakeLibrary();
    bare.addPlaylist('p.only', { name: 'Only' });
    installFetch(bare.handler());
    const top = await callTool(captureTools(), 'apple_music_list_folders', {});
    expect(top.data).toMatchObject({ returned: 0, playlistCount: 1, notes: ['No sub-folders in the top level.'] });
  });

  it('a very large folder is reported as incomplete; nameless folders fall back to their id', async () => {
    useWeb();
    installFetch(
      route('GET', '/v1/me/library/playlist-folders/p.playlistsroot/children', (req) => ({
        json: { data: Array.from({ length: Number(req.query.get('limit')) }, (_, i) => ({ id: `p.x${i}`, type: i === 0 ? 'library-playlist-folders' : 'library-playlists' })), next: '/more' },
      })),
    );
    const r = await callTool(captureTools(), 'apple_music_list_folders', { folderId: 'root' });
    expect(r.data).toMatchObject({ complete: false, returned: 20, playlistCount: 1980 });
    expect((r.data.folders as Array<{ name: string }>)[0]!.name).toBe('p.x0');
    expect(r.data.notes).toEqual(['Read only the first 2000 items of this folder; counts cover those.']);
  });
});

describe('apple_music_search_library / list_library / history / recommendations', () => {
  it('searches the library with library-* types and groups by the plain names', async () => {
    useWeb();
    const { calls } = installFetch(
      route('GET', '/v1/me/library/search', {
        json: { results: { 'library-songs': { data: [{ id: 'i.1', type: 'library-songs', attributes: { name: 'Hit', playParams: { catalogId: '55' } } }], next: '/n' } } },
      }),
    );
    const tools = captureTools();
    const r = await callTool(tools, 'apple_music_search_library', { term: 'hit', types: ['songs', 'playlists'] });
    expect(calls[0]!.url.search).toBe('?term=hit&types=library-songs,library-playlists&limit=10&offset=0');
    const res = r.data.results as Record<string, Record<string, unknown>>;
    expect(res.songs).toMatchObject({ returned: 1, hasMore: true });
    expect((res.songs!.items as unknown[])[0]).toEqual({ id: 'i.1', type: 'library-songs', name: 'Hit', catalogId: '55' });
    expect(res.playlists).toMatchObject({ returned: 0 });
  });

  it('library search: nothing found, and a malformed answer', async () => {
    useWeb();
    let n = 0;
    installFetch(route('GET', '/v1/me/library/search', () => (++n === 1 ? { json: { results: {} } } : { json: {} })));
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tools = captureTools();
    const none = await callTool(tools, 'apple_music_search_library', { term: 'zz', offset: 5 });
    expect(none.data.notes).toEqual(['Nothing in your library matches "zz" among songs, albums, artists, playlists at offset 5.']);
    expect((await callTool(tools, 'apple_music_search_library', { term: 'zz' })).isError).toBe(true);
    installFetch(route('GET', '/v1/me/library/search', { json: { results: {} } }));
    const zero = await callTool(tools, 'apple_music_search_library', { term: 'zz', types: ['music-videos'], view: 'full' });
    expect(zero.data.notes).toEqual(['Nothing in your library matches "zz" among music-videos.']);
    warn.mockRestore();
  });

  it('lists library songs (100/request) and recently-added (25/request)', async () => {
    useWeb();
    const { calls } = installFetch(
      route('GET', '/v1/me/library/songs', { json: { data: [{ id: 'i.1', type: 'library-songs', attributes: { name: 'A' } }], meta: { total: 1 } } }),
      route('GET', '/v1/me/library/recently-added', (req) => {
        const o = Number(req.query.get('offset'));
        return { json: { data: o < 50 ? Array.from({ length: Number(req.query.get('limit')) }, (_, i) => ({ id: `l.${o + i}`, type: 'library-albums' })) : [], next: '/n' } };
      }),
      route('GET', '/v1/me/library/albums', { json: { data: [] } }),
    );
    const tools = captureTools();
    const songs = await callTool(tools, 'apple_music_list_library', { kind: 'songs', limit: 100 });
    expect(calls[0]!.url.search).toBe('?limit=100&offset=0');
    expect(songs.data).toMatchObject({ kind: 'songs', returned: 1, total: 1, hasMore: false });
    const recent = await callTool(tools, 'apple_music_list_library', { kind: 'recently-added', limit: 60 });
    expect(calls.slice(1, 4).map((c) => c.url.search)).toEqual(['?limit=25&offset=0', '?limit=25&offset=25', '?limit=10&offset=50']);
    expect(recent.data).toMatchObject({ returned: 50, hasMore: false });
    const none = await callTool(tools, 'apple_music_list_library', { kind: 'albums', offset: 3 });
    expect(none.data.notes).toEqual(['No albums in your library at offset 3.']);
    const none0 = await callTool(tools, 'apple_music_list_library', { kind: 'albums' });
    expect(none0.data.notes).toEqual(['No albums in your library.']);
  });

  it('history feeds send their required types and respect each endpoint\'s page size', async () => {
    useWeb();
    const { calls } = installFetch(
      route('GET', '/v1/me/recent/played', (req) => ({ json: { data: Array.from({ length: Number(req.query.get('limit')) }, (_, i) => ({ id: `${i}`, type: 'albums' })), next: '/n' } })),
      route('GET', '/v1/me/recent/played/tracks', { json: { data: [{ id: '1', type: 'songs' }] } }),
      route('GET', '/v1/me/history/heavy-rotation', { json: { data: [] } }),
    );
    const tools = captureTools();
    const played = await callTool(tools, 'apple_music_get_history', { feed: 'recently-played', limit: 15 });
    expect(calls.map((c) => c.url.search)).toEqual([
      '?types=albums,library-albums,playlists,library-playlists,stations,artists,curators&limit=10&offset=0',
      '?types=albums,library-albums,playlists,library-playlists,stations,artists,curators&limit=5&offset=10',
    ]);
    expect(played.data).toMatchObject({ feed: 'recently-played', perRequestMax: 10, returned: 15, hasMore: true });
    await callTool(tools, 'apple_music_get_history', { feed: 'recently-played-tracks', limit: 50 });
    expect(calls[2]!.url.search).toBe('?types=songs,library-songs,music-videos,library-music-videos&limit=30&offset=0');
    const heavy = await callTool(tools, 'apple_music_get_history', { feed: 'heavy-rotation' });
    expect(heavy.data.notes).toEqual(['Apple returned nothing for heavy-rotation.']);
    const heavyOff = await callTool(tools, 'apple_music_get_history', { feed: 'heavy-rotation', offset: 4 });
    expect(heavyOff.data.notes).toEqual(['Apple returned nothing for heavy-rotation at offset 4.']);
  });

  it('recommendations: groups with titles and compact contents', async () => {
    useWeb();
    installFetch(
      route('GET', '/v1/me/recommendations', {
        json: {
          data: [
            {
              id: '6-27s5hU6azhJY',
              type: 'personal-recommendation',
              attributes: { title: { stringForDisplay: 'Made for You' }, kind: 'music-recommendations', resourceTypes: ['playlists'], nextUpdateDate: '2026-10-07T15:59:59Z' },
              relationships: { contents: { next: '/more', data: [{ id: 'pl.pm-1', type: 'playlists', attributes: { name: 'Favorites Mix' } }] } },
            },
            { id: 'r2', type: 'personal-recommendation', attributes: {} },
            { id: 'r3', type: 'personal-recommendation' },
          ],
        },
      }),
    );
    const tools = captureTools();
    const r = await callTool(tools, 'apple_music_get_recommendations', { limit: 3 });
    expect((r.data.groups as unknown[])[0]).toEqual({
      id: '6-27s5hU6azhJY',
      title: 'Made for You',
      kind: 'music-recommendations',
      resourceTypes: ['playlists'],
      nextUpdateDate: '2026-10-07T11:59:59-04:00',
      nextUpdateDateDisplay: 'Wed, Oct 7, 2026, 11:59 AM EDT',
      contentsHasMore: true,
      contents: [{ id: 'pl.pm-1', type: 'playlists', name: 'Favorites Mix' }],
    });
    expect((r.data.groups as unknown[])[1]).toEqual({ id: 'r2', contents: [] });
    const full = await callTool(tools, 'apple_music_get_recommendations', { view: 'full' });
    expect(((full.data.groups as Array<Record<string, unknown>>)[0]!.attributes as Record<string, unknown>).kind).toBe('music-recommendations');
  });

  it('recommendations: none', async () => {
    useWeb();
    installFetch(route('GET', '/v1/me/recommendations', { json: { data: [] } }));
    const r = await callTool(captureTools(), 'apple_music_get_recommendations', {});
    expect(r.data.notes).toEqual(['Apple returned no recommendations for this account.']);
  });
});

describe('apple_music_get_replay', () => {
  it('latest: the documented summary with its views', async () => {
    useOfficial();
    const { calls } = installFetch(
      route('GET', '/v1/me/music-summaries', {
        json: {
          data: [
            {
              id: 'x',
              type: 'music-summaries',
              attributes: { period: 'year', year: 2025 },
              views: {
                'top-songs': { data: [{ id: '1', type: 'songs', attributes: { name: 'Top' } }] },
                'top-albums': {},
                'top-artists': { next: '/v1/me/music-summaries/x/view/top-artists?offset=1', data: [{ id: '9', type: 'artists', attributes: { name: 'Band' } }] },
              },
            },
          ],
        },
      }),
    );
    const r = await callTool(captureTools(), 'apple_music_get_replay', { views: ['top-songs', 'top-albums', 'top-artists'] });
    expect(calls[0]!.url.search).toBe('?filter[year]=latest&views=top-songs,top-albums,top-artists');
    expect(r.data).toMatchObject({ backend: 'official', year: 'latest', summaryYear: 2025, period: 'year' });
    expect(r.data.lists).toEqual({
      'top-songs': { returned: 1, hasMore: false, items: [{ id: '1', type: 'songs', name: 'Top' }] },
      'top-albums': { returned: 0, hasMore: false, items: [] },
      // Apple's summary is a first page: a view that has more must say so, not pass for the whole list.
      'top-artists': { returned: 1, hasMore: true, items: [{ id: '9', type: 'artists', name: 'Band' }] },
    });
    expect(r.data.notes).toEqual(["Apple's latest summary holds only the first 1 top-artists (it has more); asking for a specific year with limit can return more."]);
  });

  it('latest: no summary yet is explained; limit is refused for latest', async () => {
    useWeb();
    installFetch(route('GET', '/v1/me/music-summaries', { json: { data: [{ id: 'x', type: 'music-summaries' }] } }), route('GET', '/v1/me/music-summaries/none', { json: { data: [] } }));
    const tools = captureTools();
    const r = await callTool(tools, 'apple_music_get_replay', { view: 'full' });
    expect(r.data.lists).toEqual({ 'top-songs': { returned: 0, hasMore: false, items: [] }, 'top-albums': { returned: 0, hasMore: false, items: [] }, 'top-artists': { returned: 0, hasMore: false, items: [] } });
    expect(r.data.summaryYear).toBeUndefined();
    const bad = await callTool(tools, 'apple_music_get_replay', { limit: 5 });
    expect((bad.data.error as { code: string }).code).toBe('INVALID_ARGUMENT');
    installFetch(route('GET', '/v1/me/music-summaries', { json: { data: [] } }));
    const none = await callTool(tools, 'apple_music_get_replay', {});
    expect(none.data.notes).toEqual(['Apple has no Replay summary for this account yet (Replay needs enough listening in a year).']);
  });

  it('a specific year uses the per-view endpoints with play counts and dates; a missing year is noted', async () => {
    useWeb();
    const { calls } = installFetch(
      route('GET', '/v1/me/music-summaries/year-2025/view/top-songs', {
        json: {
          data: [
            {
              id: 'eWVhci0yMDI1LXNvbmctMQ',
              type: 'song-period-summaries',
              attributes: { playCount: 42, firstPlayed: '2025-01-03', lastPlayed: '2025-12-30T20:00:00Z' },
              relationships: { empty: { data: [] }, songs: { data: [{ id: '1', type: 'songs', attributes: { name: 'Top' } }] } },
            },
            { id: 'e2', type: 'song-period-summaries' },
          ],
        },
      }),
      route('GET', '/v1/me/music-summaries/year-2025/view/top-albums', { status: 404, text: '' }),
    );
    const d = await callTool(captureTools(), 'apple_music_get_replay', { year: '2025', views: ['top-albums'] });
    expect(((d.data.lists as Record<string, Record<string, unknown>>)['top-albums']!).limit).toBe(25);
    const r = await callTool(captureTools(), 'apple_music_get_replay', { year: '2025', views: ['top-songs', 'top-albums'], limit: 10 });
    expect(calls[1]!.url.search).toBe('?limit=10&offset=0');
    const songs = (r.data.lists as Record<string, Record<string, unknown>>)['top-songs']!;
    expect(songs).toMatchObject({ returned: 2, hasMore: false });
    expect((songs.items as unknown[])[0]).toEqual({
      id: 'eWVhci0yMDI1LXNvbmctMQ',
      type: 'song-period-summaries',
      playCount: 42,
      firstPlayed: '2025-01-03',
      firstPlayedDisplay: 'Fri, Jan 3, 2025',
      lastPlayed: '2025-12-30T15:00:00-05:00',
      lastPlayedDisplay: 'Tue, Dec 30, 2025, 3:00 PM EST',
      item: { id: '1', type: 'songs', name: 'Top' },
    });
    expect((songs.items as unknown[])[1]).toEqual({ id: 'e2', type: 'song-period-summaries' });
    expect(r.data.notes).toEqual([expect.stringMatching(/Apple has no top-albums for 2025 \(HTTP 404\)/)]);
  });
});

describe('apple_music_get_ratings', () => {
  it('maps values to love / dislike / none for every requested id', async () => {
    useWeb();
    const l = new FakeLibrary();
    l.ratings.set('songs/1', 1);
    l.ratings.set('songs/2', -1);
    const { calls } = installFetch(l.handler());
    const tools = captureTools();
    const r = await callTool(tools, 'apple_music_get_ratings', { type: 'songs', ids: ['1', '2', '3', '1'] });
    expect(calls[0]!.url.search).toBe('?ids=1,2,3');
    expect(r.data.ratings).toEqual([
      { id: '1', rating: 'love' },
      { id: '2', rating: 'dislike' },
      { id: '3', rating: 'none' },
    ]);
    const none = await callTool(tools, 'apple_music_get_ratings', { type: 'library-songs', ids: ['i.x'] });
    expect(none.data.ratings).toEqual([{ id: 'i.x', rating: 'none' }]);
    expect(none.data.notes).toEqual(['Apple answered 404: none of these ids has a rating.']);
    const bad = await callTool(tools, 'apple_music_get_ratings', { type: 'library-songs', ids: ['123'] });
    expect((bad.data.error as { code: string }).code).toBe('INVALID_ARGUMENT');
  });

  it('a rating without attributes reads as none', async () => {
    useWeb();
    installFetch(route('GET', '/v1/me/ratings/albums', { json: { data: [{ id: '5', type: 'ratings' }] } }));
    const r = await callTool(captureTools(), 'apple_music_get_ratings', { type: 'albums', ids: ['5'] });
    expect(r.data.ratings).toEqual([{ id: '5', rating: 'none' }]);
  });
});
