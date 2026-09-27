import { beforeEach, describe, expect, it } from 'vitest';
import { FakeLibrary, captureTools, callTool, installFetch, route, track, useOfficial, useWeb, type FakeReq } from './_helpers.js';

beforeEach(() => {
  process.env.DISPLAY_TZ = 'America/New_York';
});

const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => String(from + i));

describe('apple_music_create_playlist', () => {
  it('creates a playlist and verifies it by re-reading', async () => {
    useOfficial();
    const l = new FakeLibrary();
    const { calls } = installFetch(l.handler());
    const r = await callTool(captureTools(), 'apple_music_create_playlist', { name: 'Focus' });
    expect(r.isError).toBe(false);
    expect(calls[0]!.body).toEqual({ attributes: { name: 'Focus' } });
    expect(calls[0]!.url.search).toBe('');
    expect(r.data).toMatchObject({ backend: 'official', id: 'p.NEW1', name: 'Focus', created: true, tracksRequested: 0, tracksAdded: 0, verified: true });
    expect((r.data.playlist as Record<string, unknown>).name).toBe('Focus');
  });

  it('puts the first 100 tracks in the create body, appends the rest in batches, and verifies the count', async () => {
    useWeb();
    const l = new FakeLibrary();
    l.folders.set('p.F1', { name: 'Chill' });
    const { calls } = installFetch(l.handler());
    const tracks = [...ids(149), { id: 'i.lib', type: 'library-songs' }];
    const r = await callTool(captureTools(), 'apple_music_create_playlist', { name: 'Big', description: 'd', isPublic: true, folderId: 'p.F1', tracks });
    const create = calls.find((c) => c.method === 'POST' && c.path === '/v1/me/library/playlists')!;
    expect(create.url.search).toBe('?with=shared');
    const body = create.body as { attributes: unknown; relationships: { tracks: { data: unknown[] }; parent: unknown } };
    expect(body.attributes).toEqual({ name: 'Big', description: 'd', isPublic: true });
    expect(body.relationships.tracks.data).toHaveLength(100);
    expect(body.relationships.tracks.data[0]).toEqual({ id: '1', type: 'songs' });
    expect(body.relationships.parent).toEqual({ data: [{ id: 'p.F1', type: 'library-playlist-folders' }] });
    const append = calls.find((c) => c.method === 'POST' && c.path.endsWith('/tracks'))!;
    expect((append.body as { data: unknown[] }).data).toHaveLength(50);
    expect((append.body as { data: unknown[] }).data.at(-1)).toEqual({ id: 'i.lib', type: 'library-songs' });
    expect(r.data).toMatchObject({ backend: 'web', tracksRequested: 150, tracksAdded: 150, verified: true });
    expect(r.data.partial).toBeUndefined();
  });

  it('refuses a bad track or folder before writing anything', async () => {
    useWeb();
    const l = new FakeLibrary();
    installFetch(l.handler());
    const tools = captureTools();
    const bad = await callTool(tools, 'apple_music_create_playlist', { name: 'x', tracks: ['l.album'] });
    expect((bad.data.error as { code: string }).code).toBe('INVALID_ARGUMENT');
    // get_catalog_items refuses l.… ids, so the hint must not send the album id there.
    expect((bad.data.error as { hint: string }).hint).toMatch(/apple_music_search_library/);
    const followed = await callTool(tools, 'apple_music_get_catalog_items', { type: 'albums', ids: ['l.album'] });
    expect((followed.data.error as { hint: string }).hint).toMatch(/LIBRARY id/);
    const nofolder = await callTool(tools, 'apple_music_create_playlist', { name: 'x', folderId: 'p.NOPE' });
    expect(nofolder.data.error).toMatchObject({ code: 'NOT_FOUND' });
    const badFolder = await callTool(tools, 'apple_music_create_playlist', { name: 'x', folderId: 'i.x' });
    expect((badFolder.data.error as { code: string }).code).toBe('INVALID_ARGUMENT');
    const plFolder = await callTool(tools, 'apple_music_create_playlist', { name: 'x', folderId: 'pl.x' });
    expect((plFolder.data.error as { hint: string }).hint).toMatch(/not a folder.*apple_music_list_folders/);
    expect(l.writes).toEqual([]);
    const root = await callTool(tools, 'apple_music_create_playlist', { name: 'x', folderId: 'root' });
    expect(root.data.verified).toBe(true);
  });

  it('a create answer without an id is an UNCONFIRMED write (it may exist)', async () => {
    useWeb();
    installFetch(route('POST', '/v1/me/library/playlists', { status: 201, text: '' }));
    const r = await callTool(captureTools(), 'apple_music_create_playlist', { name: 'Ghost', tracks: ids(101) });
    expect(r.data.error).toMatchObject({ code: 'UNCONFIRMED_WRITE' });
    expect((r.data.error as { message: string }).message).toMatch(/returned no id.*tracks 101–101 were not added/);
    installFetch(route('POST', '/v1/me/library/playlists', { status: 201, json: { data: [] } }));
    const r2 = await callTool(captureTools(), 'apple_music_create_playlist', { name: 'Ghost' });
    expect((r2.data.error as { message: string }).message).not.toMatch(/were not added/);
  });

  it('a 5xx on the create is UNCONFIRMED, never retried', async () => {
    useWeb();
    const { calls } = installFetch(route('POST', '/v1/me/library/playlists', { status: 503, text: '' }));
    const r = await callTool(captureTools(), 'apple_music_create_playlist', { name: 'x' });
    expect(r.data.error).toMatchObject({ code: 'UNCONFIRMED_WRITE' });
    expect(calls).toHaveLength(1);
  });

  it('reports a failed or unconfirmed append batch without losing the new playlist id', async () => {
    useWeb();
    const l = new FakeLibrary();
    let mode: 'fail' | 'unknown' = 'fail';
    installFetch(
      (req) => (req.method === 'POST' && /\/tracks$/.test(req.path) ? (mode === 'fail' ? { status: 400, json: { errors: [{ title: 'Invalid Request Body' }] } } : { status: 500, text: '' }) : undefined),
      l.handler(),
    );
    const tools = captureTools();
    const r = await callTool(tools, 'apple_music_create_playlist', { name: 'P', tracks: ids(250) });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ id: 'p.NEW1', tracksAdded: 100, partial: true, verified: false });
    expect(r.data.warnings).toEqual(['Tracks 101–200 were not added: music (web): POST /v1/me/library/playlists/p.NEW1/tracks failed with HTTP 400 — Invalid Request Body', '50 track(s) after those were not attempted.']);
    mode = 'unknown';
    const r2 = await callTool(tools, 'apple_music_create_playlist', { name: 'P', tracks: ids(150) });
    expect((r2.data.warnings as string[])[0]).toMatch(/^Tracks 101–150 MAY have been added/);
  });

  it('Apple lag reads as "not yet visible", and a failing re-read is a warning, not an error', async () => {
    useWeb();
    const l = new FakeLibrary();
    l.lag = true;
    installFetch(l.handler());
    const tools = captureTools();
    const r = await callTool(tools, 'apple_music_create_playlist', { name: 'Slow' });
    expect(r.data).toMatchObject({ created: true, verified: false });
    expect((r.data.warnings as string[])[0]).toMatch(/not visible yet/);
    // Tracks lag: the playlist shows, its appended tracks do not yet.
    const l2 = new FakeLibrary();
    installFetch(l2.handler());
    const lagged = await (async () => {
      const t = captureTools();
      l2.lag = true;
      return callTool(t, 'apple_music_create_playlist', { name: 'Half', tracks: ids(120) });
    })();
    expect(lagged.data.verified).toBe(false);
    expect(lagged.data.warnings).toEqual(['The playlist shows 100 track(s) so far, 120 expected — Apple can take a while to show new tracks; re-read it later.']);
    const l3 = new FakeLibrary();
    installFetch(route('GET', /^\/v1\/me\/library\/playlists\/p\.NEW1$/, { status: 500, text: '' }), l3.handler());
    const broken = await callTool(captureTools(), 'apple_music_create_playlist', { name: 'x' });
    expect(broken.data.verified).toBe(false);
    expect((broken.data.warnings as string[])[0]).toMatch(/^Created, but could not re-read it to verify: .*HTTP 500/);
  });
});

describe('apple_music_add_playlist_tracks', () => {
  function setup() {
    const l = new FakeLibrary();
    l.addPlaylist('p.A', { name: 'Mine', tracks: [track(1), track(2)] });
    l.addPlaylist('p.RO', { name: 'Apple Hits', canEdit: false });
    l.addPlaylist('p.E', { name: 'Empty' });
    return l;
  }

  it('skips songs already present (by catalog id) or repeated, adds the rest, and verifies the count', async () => {
    useWeb();
    const l = setup();
    const { calls } = installFetch(l.handler());
    const r = await callTool(captureTools(), 'apple_music_add_playlist_tracks', {
      playlistId: 'p.A',
      tracks: ['1001', '2000', '2000', 'i.T2', 'i.NEW', { id: '77', type: 'music-videos' }],
    });
    const append = calls.find((c) => c.method === 'POST')!;
    expect((append.body as { data: unknown[] }).data).toEqual([
      { id: '2000', type: 'songs' },
      { id: 'i.NEW', type: 'library-songs' },
      { id: '77', type: 'music-videos' },
    ]);
    expect(r.data).toMatchObject({ backend: 'web', playlistId: 'p.A', playlist: 'Mine', added: 3, requested: 6, skippedCount: 3, tracksBefore: 2, tracksNow: 5, verified: true });
    expect(r.data.skipped).toEqual([
      { id: '1001', reason: 'already in the playlist' },
      { id: '2000', reason: 'repeated in this request' },
      { id: 'i.T2', reason: 'already in the playlist' },
    ]);
    expect(Object.keys(r.data).at(-1)).toBe('skipped');
  });

  it('adds everything with skipDuplicates:false, and adds to an empty playlist', async () => {
    useWeb();
    const l = setup();
    installFetch(l.handler());
    const tools = captureTools();
    const r = await callTool(tools, 'apple_music_add_playlist_tracks', { playlistId: 'p.A', tracks: ['1001', '1001'], skipDuplicates: false });
    expect(r.data).toMatchObject({ added: 2, skippedCount: 0, tracksNow: 4, verified: true });
    const e = await callTool(tools, 'apple_music_add_playlist_tracks', { playlistId: 'p.E', tracks: ['5'] });
    expect(e.data).toMatchObject({ added: 1, tracksBefore: 0, tracksNow: 1, verified: true });
  });

  it('refuses a read-only playlist, and does nothing when every track is already there', async () => {
    useWeb();
    const l = setup();
    installFetch(l.handler());
    const tools = captureTools();
    const ro = await callTool(tools, 'apple_music_add_playlist_tracks', { playlistId: 'p.RO', tracks: ['5'] });
    expect(ro.data.error).toMatchObject({ code: 'UNSUPPORTED' });
    expect((ro.data.error as { message: string }).message).toMatch(/"Apple Hits" cannot be edited/);
    const dup = await callTool(tools, 'apple_music_add_playlist_tracks', { playlistId: 'p.A', tracks: ['1001', '1002'] });
    expect(dup.data).toMatchObject({ added: 0, skippedCount: 2, verified: true, notes: ['Nothing to add: every track is already in the playlist.'] });
    expect(l.writes).toEqual([]);
    const bad = await callTool(tools, 'apple_music_add_playlist_tracks', { playlistId: 'pl.x', tracks: ['5'] });
    expect((bad.data.error as { code: string }).code).toBe('INVALID_ARGUMENT');
    // Adding an Apple playlist to your library would only lead to the canEdit:false refusal above.
    expect((bad.data.error as { hint: string }).hint).toMatch(/read-only.*apple_music_create_playlist/);
    expect((bad.data.error as { hint: string }).hint).not.toMatch(/add_to_library/);
  });

  it('a first batch refused outright is an error; a later failure is a partial result', async () => {
    useWeb();
    const l = setup();
    let posts = 0;
    let failAt = 1;
    installFetch((req: FakeReq) => (req.method === 'POST' && ++posts === failAt ? { status: 400, json: { errors: [{ title: 'Bad' }] } } : undefined), l.handler());
    const tools = captureTools();
    const first = await callTool(tools, 'apple_music_add_playlist_tracks', { playlistId: 'p.A', tracks: ids(150, 5000) });
    expect(first.isError).toBe(true);
    expect(first.data.error).toMatchObject({ code: 'UPSTREAM_ERROR', status: 400 });
    posts = 0;
    failAt = 2;
    const later = await callTool(tools, 'apple_music_add_playlist_tracks', { playlistId: 'p.A', tracks: ids(150, 6000) });
    expect(later.data).toMatchObject({ added: 100, partial: true, verified: false, tracksNow: 102 });
    expect((later.data.warnings as string[])[0]).toMatch(/Tracks 101–150 were not added/);
  });

  it('an unconfirmed first batch is reported, not thrown; a failing verification read is a warning', async () => {
    useWeb();
    const l = setup();
    let postDone = false;
    installFetch(
      (req: FakeReq) => {
        if (req.method === 'POST') {
          postDone = true;
          return { status: 502, text: '' };
        }
        if (postDone && req.method === 'GET' && req.path.endsWith('/tracks')) return { status: 500, text: '' };
        return undefined;
      },
      l.handler(),
    );
    const r = await callTool(captureTools(), 'apple_music_add_playlist_tracks', { playlistId: 'p.A', tracks: ['9'] });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ added: 0, partial: true, verified: false });
    expect((r.data.warnings as string[]).join(' ')).toMatch(/MAY have been added.*could not re-read the playlist to verify/);
  });

  it('a playlist over 5000 tracks: duplicate check and verification are limited, and it says so', async () => {
    useWeb();
    const l = new FakeLibrary();
    l.addPlaylist('p.H', { name: 'Huge', tracks: Array.from({ length: 5001 }, (_, i) => track(i + 1)) });
    installFetch(l.handler());
    const r = await callTool(captureTools(), 'apple_music_add_playlist_tracks', { playlistId: 'p.H', tracks: ['1'] });
    expect(r.data).toMatchObject({ added: 1, verified: false });
    expect(r.data.tracksBefore).toBeUndefined();
    expect(r.data.notes).toEqual(['The duplicate check covered the first 5000 tracks only.', 'Not verified: the playlist has more than 5000 tracks.']);
  });

  it('crossing 5000 tracks: the capped read-back is not mistaken for Apple lagging', async () => {
    useWeb();
    const l = new FakeLibrary();
    l.addPlaylist('p.B', { name: 'Big', tracks: Array.from({ length: 4990 }, (_, i) => track(i + 1)) });
    installFetch(l.handler());
    const tracks = Array.from({ length: 20 }, (_, i) => String(900000 + i));
    const r = await callTool(captureTools(), 'apple_music_add_playlist_tracks', { playlistId: 'p.B', tracks });
    expect(r.data).toMatchObject({ added: 20, tracksBefore: 4990, verified: false });
    expect(r.data.tracksNow).toBeUndefined();
    expect(r.data.warnings).toEqual(['Not verified: the playlist now has more than 5000 tracks, more than this tool reads back.']);
    expect(l.playlists.get('p.B')!.tracks).toHaveLength(5010);
  });
});

describe('apple_music_create_folder', () => {
  it('creates at the root by default or inside an existing folder, and verifies', async () => {
    useWeb();
    const l = new FakeLibrary();
    l.folders.set('p.F1', { name: 'Chill' });
    const { calls } = installFetch(l.handler());
    const tools = captureTools();
    const r = await callTool(tools, 'apple_music_create_folder', { name: 'New' });
    expect(calls[0]!.body).toEqual({ attributes: { name: 'New' }, relationships: { parent: { data: [{ id: 'p.playlistsroot', type: 'library-playlist-folders' }] } } });
    expect(r.data).toMatchObject({ backend: 'web', name: 'New', parentFolderId: 'p.playlistsroot', created: true, verified: true });
    const sub = await callTool(tools, 'apple_music_create_folder', { name: 'Sub', parentFolderId: 'p.F1' });
    expect(sub.data).toMatchObject({ parentFolderId: 'p.F1', verified: true });
    const missing = await callTool(tools, 'apple_music_create_folder', { name: 'Sub', parentFolderId: 'p.NOPE' });
    expect(missing.data.error).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lag, a failed re-read, and a create answer with no id', async () => {
    useWeb();
    const l = new FakeLibrary();
    l.lag = true;
    installFetch(l.handler());
    const tools = captureTools();
    const lag = await callTool(tools, 'apple_music_create_folder', { name: 'Slow' });
    expect(lag.data).toMatchObject({ verified: false, warnings: [expect.stringMatching(/not visible yet/)] });
    installFetch(route('GET', /playlist-folders\/p\.F/, { status: 500, text: '' }), new FakeLibrary().handler());
    const broken = await callTool(tools, 'apple_music_create_folder', { name: 'X' });
    expect((broken.data.warnings as string[])[0]).toMatch(/could not re-read/);
    installFetch(route('POST', '/v1/me/library/playlist-folders', { status: 201, text: '' }));
    const noid = await callTool(tools, 'apple_music_create_folder', { name: 'X' });
    expect(noid.data.error).toMatchObject({ code: 'UNCONFIRMED_WRITE' });
  });
});

describe('add to library / favorites', () => {
  it('builds Apple\'s typed ids[...] query and says Apple reports nothing per item', async () => {
    useOfficial();
    const { calls } = installFetch(route('POST', '/v1/me/library', { status: 202, text: '' }), route('POST', '/v1/me/favorites', { status: 202, text: '' }));
    const tools = captureTools();
    const r = await callTool(tools, 'apple_music_add_to_library', { songs: ['1', '2', '1'], musicVideos: ['3'], playlists: ['pl.u-x'] });
    expect(calls[0]!.url.search).toBe('?ids[songs]=1,2&ids[playlists]=pl.u-x&ids[music-videos]=3');
    expect(r.data).toMatchObject({ backend: 'official', accepted: true, status: 202, requested: { songs: 2, playlists: 1, 'music-videos': 1 }, verified: false });
    expect((r.data.notes as string[])[0]).toMatch(/silently ignored/);
    const f = await callTool(tools, 'apple_music_add_favorites', { artists: ['99'], albums: ['5'] });
    expect(calls[1]!.url.search).toBe('?ids[albums]=5&ids[artists]=99');
    expect(f.data).toMatchObject({ accepted: true, requested: { albums: 1, artists: 1 } });
  });

  it('refuses an empty request and malformed ids', async () => {
    useOfficial();
    installFetch();
    const tools = captureTools();
    expect(((await callTool(tools, 'apple_music_add_to_library', {})).data.error as { message: string }).message).toMatch(/at least one of songs, albums, playlists, musicVideos/);
    expect(((await callTool(tools, 'apple_music_add_favorites', { playlists: ['123'] })).data.error as { message: string }).message).toMatch(/playlists\[0\]/);
  });
});

describe('apple_music_set_rating', () => {
  it('sets love (PUT {type:"rating"}), reports the previous value, and verifies', async () => {
    useWeb();
    const l = new FakeLibrary();
    const { calls } = installFetch(l.handler());
    const tools = captureTools();
    const r = await callTool(tools, 'apple_music_set_rating', { type: 'songs', id: '1', rating: 'love' });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe('/v1/me/ratings/songs/1');
    expect(put.body).toEqual({ type: 'rating', attributes: { value: 1 } });
    expect(r.data).toMatchObject({ backend: 'web', previous: 'none', rating: 'love', changed: true, verified: true });
    const same = await callTool(tools, 'apple_music_set_rating', { type: 'songs', id: '1', rating: 'love' });
    expect(same.data).toMatchObject({ previous: 'love', changed: false, verified: true });
    const dis = await callTool(tools, 'apple_music_set_rating', { type: 'songs', id: '1', rating: 'dislike' });
    expect(dis.data).toMatchObject({ previous: 'love', rating: 'dislike', verified: true });
    const clear = await callTool(tools, 'apple_music_set_rating', { type: 'songs', id: '1', rating: 'none' });
    expect(clear.data).toMatchObject({ previous: 'dislike', rating: 'none', verified: true });
    expect(calls.at(-2)!.method).toBe('DELETE');
  });

  it('warns when the new rating does not read back, or cannot be read', async () => {
    useWeb();
    let gets = 0;
    installFetch(
      route('GET', '/v1/me/ratings/library-songs/i.x', () => (++gets === 1 ? { status: 404, text: '' } : gets === 2 ? { json: { data: [{ id: 'i.x', type: 'ratings' }] } } : { json: { data: [] } })),
      route('PUT', '/v1/me/ratings/library-songs/i.x', { status: 204 }),
    );
    const tools = captureTools();
    const r = await callTool(tools, 'apple_music_set_rating', { type: 'library-songs', id: 'i.x', rating: 'love' });
    expect(r.data).toMatchObject({ changed: true, verified: false, warnings: ['Apple still reports "none" — the change may not be visible yet.'] });
    const again = await callTool(tools, 'apple_music_set_rating', { type: 'library-songs', id: 'i.x', rating: 'none' });
    expect(again.data).toMatchObject({ previous: 'none', changed: false });
    let g2 = 0;
    installFetch(route('GET', '/v1/me/ratings/songs/2', () => (++g2 === 1 ? { status: 404, text: '' } : { status: 500, text: '' })), route('PUT', '/v1/me/ratings/songs/2', { status: 204 }));
    const e = await callTool(tools, 'apple_music_set_rating', { type: 'songs', id: '2', rating: 'dislike' });
    expect((e.data.warnings as string[])[0]).toMatch(/could not re-read the rating/);
    const bad = await callTool(tools, 'apple_music_set_rating', { type: 'stations', id: '12', rating: 'love' });
    expect((bad.data.error as { code: string }).code).toBe('INVALID_ARGUMENT');
  });
});
