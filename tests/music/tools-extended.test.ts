import { beforeEach, describe, expect, it } from 'vitest';
import { callConfirmed, callPreview, NO_ELICIT_CTX, type GatedHandler } from '../tools/_confirm-helpers.js';
import { dedupeTracks, moveTracks, replaceTracks, sortTracks } from '../../src/music/tools-extended.js';
import { FakeLibrary, captureTools, callTool, installFetch, route, track, useOfficial, useWeb, type CapturedTool, type FakeReq } from './_helpers.js';

beforeEach(() => {
  process.env.DISPLAY_TZ = 'America/New_York';
});

function setup() {
  useWeb();
  const l = new FakeLibrary();
  l.addPlaylist('p.A', {
    name: 'Road Trip',
    description: 'Loud',
    tracks: [track(1), track(2), track(3, { artistName: undefined }), track(2, { id: 'i.T2' }), track(4, { id: 'i.MV', type: 'library-music-videos', catalogId: '1004' })],
  });
  l.addPlaylist('p.RO', { name: 'Apple Hits', canEdit: false, hasCatalog: true, tracks: [track(9)] });
  l.folders.set('p.F1', { name: 'Chill' });
  const fetch = installFetch(l.handler());
  const tools = captureTools();
  const h = (name: string): GatedHandler => (tools.get(name) as CapturedTool).cb as unknown as GatedHandler;
  return { l, tools, h, ...fetch };
}

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;
const ids = (l: FakeLibrary, id = 'p.A') => l.playlists.get(id)!.tracks.map((t) => t.id);

describe('web mode is required', () => {
  it('every extended tool refuses with a ConfigError explaining the official API cannot do it', async () => {
    useOfficial();
    installFetch();
    const tools = captureTools();
    for (const [name, args] of [
      ['apple_music_update_playlist', { playlistId: 'p.A', name: 'x' }],
      ['apple_music_remove_playlist_tracks', { playlistId: 'p.A', positions: [1] }],
      ['apple_music_reorder_playlist', { playlistId: 'p.A', operation: 'reverse' }],
      ['apple_music_move_playlist', { playlistId: 'p.A', folderId: 'root' }],
      ['apple_music_delete_playlist', { playlistId: 'p.A' }],
      ['apple_music_remove_from_library', { type: 'songs', ids: ['i.x'] }],
      ['apple_music_remove_favorites', { songs: ['1'] }],
    ] as const) {
      const r = await callTool(tools, name, args, NO_ELICIT_CTX);
      expect(r.data.error, name).toMatchObject({ code: 'NOT_CONFIGURED', missing: ['APPLE_MUSIC_WEB_USER_TOKEN'] });
      expect((r.data.error as { message: string }).message).toMatch(/official Apple Music API cannot/);
    }
  });
});

describe('apple_music_update_playlist', () => {
  it('renames, redescribes and publishes, returning previous and current values', async () => {
    const { l, calls, tools } = setup();
    const r = await callTool(tools, 'apple_music_update_playlist', { playlistId: 'p.A', name: 'Road Trip 2', description: 'Quiet', isPublic: true });
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url.search).toBe('?with=shared');
    expect(patch.body).toEqual({ attributes: { name: 'Road Trip 2', description: 'Quiet', isPublic: true } });
    expect(r.data).toMatchObject({
      backend: 'web',
      playlist: 'Road Trip',
      changed: true,
      previous: { name: 'Road Trip', description: 'Loud', isPublic: false },
      requested: { name: 'Road Trip 2', description: 'Quiet', isPublic: true },
      current: { name: 'Road Trip 2', description: 'Quiet', isPublic: true },
      verified: true,
    });
    expect(l.playlists.get('p.A')!.name).toBe('Road Trip 2');
  });

  it('sends the complete attribute set as Apple\'s web player does (requested = only what changed); clearing a description verifies when Apple drops it', async () => {
    const { calls, tools } = setup();
    const r = await callTool(tools, 'apple_music_update_playlist', { playlistId: 'p.A', name: 'Road Trip', description: '', isPublic: false });
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ attributes: { name: 'Road Trip', description: '', isPublic: false } });
    expect(calls.find((c) => c.method === 'PATCH')!.url.search).toBe('');
    expect(r.data).toMatchObject({ changed: true, verified: true, requested: { description: '' } });
    expect((r.data.current as Record<string, unknown>).description).toBeUndefined();
  });

  it('renaming a PUBLIC playlist keeps it public (isPublic and with=shared are sent, as the web player does), and never invents fields Apple did not report', async () => {
    const { l, calls, tools } = setup();
    l.addPlaylist('p.PUB', { name: 'Shared', description: 'For friends', isPublic: true });
    const r = await callTool(tools, 'apple_music_update_playlist', { playlistId: 'p.PUB', name: 'Shared 2' });
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url.search).toBe('?with=shared');
    expect(patch.body).toEqual({ attributes: { name: 'Shared 2', description: 'For friends', isPublic: true } });
    expect(r.data).toMatchObject({ requested: { name: 'Shared 2' }, verified: true });
    expect(l.playlists.get('p.PUB')).toMatchObject({ name: 'Shared 2', description: 'For friends', isPublic: true });
    l.addPlaylist('p.BARE', { name: 'Bare', isPublic: undefined });
    await callTool(tools, 'apple_music_update_playlist', { playlistId: 'p.BARE', name: 'Bare 2' });
    expect(calls.filter((c) => c.method === 'PATCH').at(-1)!.body).toEqual({ attributes: { name: 'Bare 2' } });
  });

  it('no-op, nothing given, read-only playlist', async () => {
    const { tools, l } = setup();
    const same = await callTool(tools, 'apple_music_update_playlist', { playlistId: 'p.A', name: 'Road Trip' });
    expect(same.data).toMatchObject({ changed: false, notes: ['Nothing to change: the playlist already has these values.'] });
    expect(((await callTool(tools, 'apple_music_update_playlist', { playlistId: 'p.A' })).data.error as { message: string }).message).toMatch(/at least one of/);
    const ro = await callTool(tools, 'apple_music_update_playlist', { playlistId: 'p.RO', name: 'x' });
    expect(ro.data.error).toMatchObject({ code: 'UNSUPPORTED' });
    expect(l.writes).toEqual([]);
  });

  it('lag and a failed re-read become warnings', async () => {
    const { l, tools } = setup();
    l.lag = true;
    const r = await callTool(tools, 'apple_music_update_playlist', { playlistId: 'p.A', name: 'New', description: '' });
    expect(r.data.verified).toBe(false);
    expect(r.data.warnings).toEqual(['name still reads "Road Trip" — Apple may not show the change yet.', 'description still reads "Loud" — Apple may not show the change yet.']);
    const lag2 = new FakeLibrary();
    lag2.addPlaylist('p.N', { name: 'N' });
    lag2.lag = true;
    installFetch(lag2.handler());
    const r2 = await callTool(captureTools(), 'apple_music_update_playlist', { playlistId: 'p.N', description: 'd' });
    expect(r2.data.warnings).toEqual(['description still reads null — Apple may not show the change yet.']);
    const lag3 = new FakeLibrary();
    lag3.addPlaylist('p.P', { name: 'P', isPublic: undefined });
    lag3.lag = true;
    installFetch(lag3.handler());
    const r4 = await callTool(captureTools(), 'apple_music_update_playlist', { playlistId: 'p.P', isPublic: true });
    expect(r4.data.previous).toEqual({ name: 'P' });
    expect(r4.data.warnings).toEqual(['isPublic still reads null — Apple may not show the change yet.']);
    let patched = false;
    const l3 = new FakeLibrary();
    l3.addPlaylist('p.X', { name: 'X' });
    installFetch((req: FakeReq) => {
      if (req.method === 'PATCH') patched = true;
      return patched && req.method === 'GET' ? { status: 500, text: '' } : undefined;
    }, l3.handler());
    const r3 = await callTool(captureTools(), 'apple_music_update_playlist', { playlistId: 'p.X', name: 'Y' });
    expect(r3.data).toMatchObject({ changed: true, verified: false });
    expect((r3.data.warnings as string[])[0]).toMatch(/could not re-read the playlist/);
  });
});

describe('apple_music_remove_playlist_tracks (confirm-gated)', () => {
  it('phase 1 previews names, positions and counts and writes nothing; phase 2 removes and verifies', async () => {
    const { l, h, calls } = setup();
    const args = { playlistId: 'p.A', trackIds: ['i.T2', 'i.NOPE'], positions: [1] };
    const p1 = await callPreview(h('apple_music_remove_playlist_tracks'), args);
    expect(p1.preview).toMatchObject({
      playlist: 'Road Trip',
      playlistId: 'p.A',
      removing: [
        { name: 'Song 2', artistName: 'Artist 2', positions: [2, 4], copies: 2 },
        { name: 'Song 1', artistName: 'Artist 1', positions: [1] },
      ],
      tracksBefore: 5,
      tracksAfter: 2,
      notInPlaylist: ['i.NOPE'],
    });
    expect(l.writes).toEqual([]);
    const r = parse(await callConfirmed(h('apple_music_remove_playlist_tracks'), args));
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.url.search).toBe('?ids[library-songs]=i.T2,i.T1&mode=all');
    expect(del.body).toBeUndefined();
    expect(r).toMatchObject({ backend: 'web', removed: 3, tracksBefore: 5, tracksAfter: 2, verified: true, notInPlaylist: ['i.NOPE'] });
    expect(ids(l)).toEqual(['i.T3', 'i.MV']);
  });

  it('a track with no artist is previewed by name alone', async () => {
    const { h } = setup();
    const p1 = await callPreview(h('apple_music_remove_playlist_tracks'), { playlistId: 'p.A', positions: [3] });
    expect(p1.preview.removing).toEqual([{ name: 'Song 3', positions: [3] }]);
  });

  it('names a music video as ids[library-songs] too — the only form Apple\'s web player sends', async () => {
    const { h, calls, l } = setup();
    const r = parse(await callConfirmed(h('apple_music_remove_playlist_tracks'), { playlistId: 'p.A', positions: [5] }));
    expect(calls.find((c) => c.method === 'DELETE')!.url.search).toBe('?ids[library-songs]=i.MV&mode=all');
    expect(r).toMatchObject({ removed: 1, verified: true });
    expect(ids(l)).toEqual(['i.T1', 'i.T2', 'i.T3', 'i.T2']);
  });

  it('refuses to remove only some copies of a duplicated track (Apple removes all)', async () => {
    const { tools } = setup();
    const r = await callTool(tools, 'apple_music_remove_playlist_tracks', { playlistId: 'p.A', positions: [4] }, NO_ELICIT_CTX);
    expect(r.data.error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect((r.data.error as { message: string }).message).toMatch(/"Song 2" appears 2 times \(positions 2, 4\).*just position 4/);
    expect((r.data.error as { hint: string }).hint).toMatch(/apple_music_reorder_playlist/);
    const both = await callPreview((tools.get('apple_music_remove_playlist_tracks') as CapturedTool).cb as unknown as GatedHandler, { playlistId: 'p.A', positions: [2, 4] });
    expect(both.preview.tracksAfter).toBe(3);
  });

  it.each([
    [{ playlistId: 'p.A' }, 'INVALID_ARGUMENT', /trackIds and\/or positions/],
    [{ playlistId: 'p.A', positions: [9] }, 'INVALID_ARGUMENT', /position 9 is past the end: "Road Trip" has 5/],
    [{ playlistId: 'p.A', trackIds: ['i.NOPE'] }, 'INVALID_ARGUMENT', /None of these trackIds are in "Road Trip": i.NOPE/],
    [{ playlistId: 'p.A', trackIds: ['123'] }, 'INVALID_ARGUMENT', /trackIds\[0\]/],
    [{ playlistId: 'p.RO', positions: [1] }, 'UNSUPPORTED', /cannot be edited/],
    [{ playlistId: 'p.GONE', positions: [1] }, 'NOT_FOUND', /./],
  ])('refuses %j before any write', async (args, code, msg) => {
    const { tools, l } = setup();
    const r = await callTool(tools, 'apple_music_remove_playlist_tracks', args, NO_ELICIT_CTX);
    expect(r.data.error).toMatchObject({ code });
    expect((r.data.error as { message: string }).message).toMatch(msg);
    expect(l.writes).toEqual([]);
  });

  it('a playlist that changed between preview and confirm is refused (DRAFT_CHANGED)', async () => {
    const { l, h } = setup();
    const args = { playlistId: 'p.A', positions: [1] };
    const p1 = await callPreview(h('apple_music_remove_playlist_tracks'), args);
    l.playlists.get('p.A')!.tracks.push(track(7));
    const r = await h('apple_music_remove_playlist_tracks')({ ...args, confirmToken: p1.confirmToken }, NO_ELICIT_CTX);
    expect(r.content[0]!.text).toMatch(/DRAFT_CHANGED/);
    expect(l.writes).toEqual([]);
  });

  it('unknown track types, and playlists too large to read whole, are refused', async () => {
    const { l, tools } = setup();
    l.playlists.get('p.A')!.tracks[0]!.type = 'songs';
    const odd = await callTool(tools, 'apple_music_remove_playlist_tracks', { playlistId: 'p.A', positions: [1] }, NO_ELICIT_CTX);
    expect(odd.data.error).toMatchObject({ code: 'UNSUPPORTED' });
    l.addPlaylist('p.H', { name: 'Huge', tracks: Array.from({ length: 5001 }, (_, i) => track(i + 1)) });
    const huge = await callTool(tools, 'apple_music_remove_playlist_tracks', { playlistId: 'p.H', positions: [1] }, NO_ELICIT_CTX);
    expect(huge.data.error).toMatchObject({ code: 'UNSUPPORTED' });
    expect((huge.data.error as { message: string }).message).toMatch(/more than 5000 tracks/);
  });

  it('lag and a failed re-read become warnings', async () => {
    const { l, h } = setup();
    l.lag = true;
    const r = parse(await callConfirmed(h('apple_music_remove_playlist_tracks'), { playlistId: 'p.A', positions: [1] }));
    expect(r).toMatchObject({ removed: 1, verified: false, tracksAfter: 5 });
    expect((r.warnings as string[])[0]).toMatch(/still shows 5 track\(s\), 1 of them ones being removed/);
    l.lag = false;
    let deleted = false;
    installFetch((req: FakeReq) => {
      if (req.method === 'DELETE') deleted = true;
      return deleted && req.method === 'GET' ? { status: 500, text: '' } : undefined;
    }, l.handler());
    const tools2 = captureTools();
    const r2 = parse(await callConfirmed((tools2.get('apple_music_remove_playlist_tracks') as CapturedTool).cb as unknown as GatedHandler, { playlistId: 'p.A', trackIds: ['i.T3'] }));
    expect(r2.verified).toBe(false);
    expect(r2.tracksAfter).toBeUndefined();
    expect((r2.warnings as string[])[0]).toMatch(/could not re-read/);
  });

  it('a mismatched count (without the removed ids) is still a warning', async () => {
    const { l, h } = setup();
    let deleted = false;
    installFetch(
      (req: FakeReq) => {
        if (req.method === 'DELETE') deleted = true;
        if (deleted && req.method === 'GET' && req.path.endsWith('/tracks')) return { json: { data: [{ id: 'i.T3', type: 'library-songs' }] } };
        return undefined;
      },
      l.handler(),
    );
    const tools = captureTools();
    const r = parse(await callConfirmed((tools.get('apple_music_remove_playlist_tracks') as CapturedTool).cb as unknown as GatedHandler, { playlistId: 'p.A', positions: [1] }));
    expect(r.verified).toBe(false);
    expect((r.warnings as string[])[0]).toMatch(/^The playlist still shows 1 track\(s\) —/);
    void h;
  });
});

describe('apple_music_reorder_playlist (confirm-gated)', () => {
  it('pure helpers: move, sort (missing values last), dedupe, replace', () => {
    const t = (id: string, attrs: Record<string, unknown> = {}) => ({ id, type: 'library-songs', attributes: attrs });
    const list = [t('a'), t('b'), t('c'), t('d')];
    expect(moveTracks(list, 1, 3, 2).map((x) => x.id)).toEqual(['c', 'd', 'a', 'b']);
    expect(moveTracks(list, 4, 1, 1).map((x) => x.id)).toEqual(['d', 'a', 'b', 'c']);
    expect(() => moveTracks(list, 4, 1, 2)).toThrow(/runs past the end/);
    expect(() => moveTracks(list, 1, 4, 2)).toThrow(/last valid position is 3/);
    const s = [t('1', { name: 'b', durationInMillis: 3 }), t('2', { name: 'A', durationInMillis: 1 }), t('3', {}), t('4', { name: 'c10' }), t('5', { name: 'c9' })];
    expect(sortTracks(s, 'name', false).map((x) => x.id)).toEqual(['2', '1', '5', '4', '3']);
    expect(sortTracks(s, 'name', true).map((x) => x.id)).toEqual(['4', '5', '1', '2', '3']);
    expect(sortTracks(s, 'duration', false).map((x) => x.id)).toEqual(['2', '1', '3', '4', '5']);
    expect(sortTracks([t('x'), t('y')], 'releaseDate', false).map((x) => x.id)).toEqual(['x', 'y']);
    expect(sortTracks([t('x'), t('y', { dateAdded: '2020' })], 'dateAdded', false).map((x) => x.id)).toEqual(['y', 'x']);
    const d = [t('i.1', { playParams: { catalogId: '9' } }), t('i.2', { playParams: { catalogId: '9' } }), t('i.3'), t('i.3')];
    expect(dedupeTracks(d).map((x) => x.id)).toEqual(['i.1', 'i.3']);
    expect(replaceTracks(d, ['i.3', 'i.1', 'i.3']).map((x) => x.id)).toEqual(['i.3', 'i.1', 'i.3']);
    expect(() => replaceTracks(d, ['i.9', 'i.9'])).toThrow(/not in this playlist: i.9\./);
    expect(() => replaceTracks(d, ['i.1', 'i.1'])).toThrow(/repeat i.1 more times/);
  });

  it('sort: preview shows the first tracks before and after; confirm PUTs the full list and verifies the order', async () => {
    const { l, h, calls } = setup();
    l.playlists.get('p.A')!.tracks = [track(3), track(1), track(2)];
    const args = { playlistId: 'p.A', operation: 'sort', by: 'name', descending: true };
    const p1 = await callPreview(h('apple_music_reorder_playlist'), args);
    expect(p1.preview).toMatchObject({ playlist: 'Road Trip', change: 'sort by name (descending)', tracksBefore: 3, tracksAfter: 3 });
    expect((p1.preview.firstAfter as Array<{ name: string; position: number }>).map((x) => [x.position, x.name])).toEqual([
      [1, 'Song 3'],
      [2, 'Song 2'],
      [3, 'Song 1'],
    ]);
    const r = parse(await callConfirmed(h('apple_music_reorder_playlist'), args));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toEqual({ data: [{ id: 'i.T3', type: 'library-songs' }, { id: 'i.T2', type: 'library-songs' }, { id: 'i.T1', type: 'library-songs' }] });
    expect(r).toMatchObject({ backend: 'web', operation: 'sort', changed: true, tracksBefore: 3, tracksAfter: 3, verified: true });
    expect(ids(l)).toEqual(['i.T3', 'i.T2', 'i.T1']);
  });

  it('move, reverse, dedupe and replace', async () => {
    const { l, h } = setup();
    parse(await callConfirmed(h('apple_music_reorder_playlist'), { playlistId: 'p.A', operation: 'move', fromPosition: 5, toPosition: 1 }));
    expect(ids(l)).toEqual(['i.MV', 'i.T1', 'i.T2', 'i.T3', 'i.T2']);
    parse(await callConfirmed(h('apple_music_reorder_playlist'), { playlistId: 'p.A', operation: 'reverse' }));
    expect(ids(l)).toEqual(['i.T2', 'i.T3', 'i.T2', 'i.T1', 'i.MV']);
    const asc = await callPreview(h('apple_music_reorder_playlist'), { playlistId: 'p.A', operation: 'sort', by: 'duration' });
    expect(asc.preview.change).toBe('sort by duration');
    const d = await callPreview(h('apple_music_reorder_playlist'), { playlistId: 'p.A', operation: 'dedupe' });
    expect(d.preview).toMatchObject({ tracksBefore: 5, tracksAfter: 4, removed: 1 });
    const dr = parse(await callConfirmed(h('apple_music_reorder_playlist'), { playlistId: 'p.A', operation: 'dedupe' }));
    expect(dr).toMatchObject({ removed: 1, verified: true });
    expect(ids(l)).toEqual(['i.T2', 'i.T3', 'i.T1', 'i.MV']);
    const rr = parse(await callConfirmed(h('apple_music_reorder_playlist'), { playlistId: 'p.A', operation: 'replace', trackIds: ['i.T1', 'i.T2'] }));
    expect(rr).toMatchObject({ tracksAfter: 2, removed: 2 });
    expect(ids(l)).toEqual(['i.T1', 'i.T2']);
  });

  it('sort refuses a key no track carries (it would "succeed" without changing anything) and names tracks that lack it', async () => {
    const { l, h, tools } = setup();
    // Apple's playlist tracks usually carry no dateAdded: sorting by it must not claim "already in that order".
    const none = await callTool(tools, 'apple_music_reorder_playlist', { playlistId: 'p.A', operation: 'sort', by: 'dateAdded' }, NO_ELICIT_CTX);
    expect(none.isError).toBe(true);
    expect(none.data.error).toMatchObject({ code: 'UNSUPPORTED' });
    expect((none.data.error as { message: string; hint: string }).message).toMatch(/no dateAdded for any track in "Road Trip"/);
    expect((none.data.error as { hint: string }).hint).toMatch(/name, artistName, albumName, releaseDate, duration/);
    expect(l.writes).toEqual([]);

    l.playlists.get('p.A')!.tracks = [track(1), track(2, { dateAdded: '2024-05-01T10:00:00Z' }), track(3, { dateAdded: '2023-01-01T10:00:00Z' })];
    const args = { playlistId: 'p.A', operation: 'sort', by: 'dateAdded' };
    const p1 = await callPreview(h('apple_music_reorder_playlist'), args);
    expect(p1.preview.note).toBe('1 track(s) have no dateAdded and go last, in their current order.');
    const r = parse(await callConfirmed(h('apple_music_reorder_playlist'), args));
    expect(ids(l)).toEqual(['i.T3', 'i.T2', 'i.T1']);
    expect(r.notes).toEqual(['1 track(s) have no dateAdded and go last, in their current order.']);

    // Already sorted, with a track lacking the key: the no-op still says which tracks were not compared.
    const again = await callTool(tools, 'apple_music_reorder_playlist', args, NO_ELICIT_CTX);
    expect(again.data).toMatchObject({ changed: false });
    expect(again.data.notes).toEqual(['Nothing to change: the playlist is already in that order.', '1 track(s) have no dateAdded and go last, in their current order.']);

    // An empty playlist is simply already sorted.
    l.playlists.get('p.A')!.tracks = [];
    const empty = await callTool(tools, 'apple_music_reorder_playlist', args, NO_ELICIT_CTX);
    expect(empty.data).toMatchObject({ changed: false, tracks: 0 });
  });

  it('a no-op says so without a confirmation or a write', async () => {
    const { l, tools } = setup();
    const r = await callTool(tools, 'apple_music_reorder_playlist', { playlistId: 'p.A', operation: 'move', fromPosition: 2, toPosition: 2, count: 2 }, NO_ELICIT_CTX);
    expect(r.data).toMatchObject({ changed: false, tracks: 5, notes: ['Nothing to change: the playlist is already in that order.'] });
    l.playlists.get('p.A')!.tracks = [track(1)];
    const dd = await callTool(tools, 'apple_music_reorder_playlist', { playlistId: 'p.A', operation: 'dedupe' }, NO_ELICIT_CTX);
    expect(dd.data.notes).toEqual(['Nothing to change: the playlist is already in that order with no duplicates.']);
    expect(l.writes).toEqual([]);
  });

  it.each([
    [{ operation: 'reverse', by: 'name' }, /by does not apply to operation "reverse"/],
    [{ operation: 'sort', trackIds: ['i.1'], fromPosition: 1 }, /fromPosition, trackIds do not apply/],
    [{ operation: 'move', fromPosition: 1 }, /move needs fromPosition and toPosition/],
    [{ operation: 'sort' }, /sort needs by/],
    [{ operation: 'replace' }, /replace needs trackIds/],
    [{ operation: 'replace', trackIds: ['123'] }, /trackIds\[0\]/],
    [{ operation: 'replace', trackIds: ['i.NOPE'] }, /not in this playlist/],
    [{ operation: 'move', fromPosition: 9, toPosition: 1 }, /runs past the end/],
  ])('refuses %j', async (extra, msg) => {
    const { tools, l } = setup();
    const r = await callTool(tools, 'apple_music_reorder_playlist', { playlistId: 'p.A', ...extra }, NO_ELICIT_CTX);
    expect(r.data.error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect((r.data.error as { message: string }).message).toMatch(msg);
    expect(l.writes).toEqual([]);
  });

  it('refuses read-only playlists and unknown track types; lag and failed re-reads are warnings', async () => {
    const { l, tools, h } = setup();
    expect((await callTool(tools, 'apple_music_reorder_playlist', { playlistId: 'p.RO', operation: 'reverse' }, NO_ELICIT_CTX)).data.error).toMatchObject({ code: 'UNSUPPORTED' });
    l.playlists.get('p.A')!.tracks[2]!.type = 'library-podcasts';
    const odd = await callTool(tools, 'apple_music_reorder_playlist', { playlistId: 'p.A', operation: 'reverse' }, NO_ELICIT_CTX);
    expect((odd.data.error as { message: string }).message).toMatch(/type "library-podcasts"/);
    l.playlists.get('p.A')!.tracks[2]!.type = undefined;
    l.lag = true;
    const lag = parse(await callConfirmed(h('apple_music_reorder_playlist'), { playlistId: 'p.A', operation: 'reverse' }));
    expect(lag).toMatchObject({ changed: true, verified: false, warnings: [expect.stringMatching(/does not show the new order yet/)] });
    l.lag = false;
    let put = false;
    installFetch((req: FakeReq) => {
      if (req.method === 'PUT') put = true;
      return put && req.method === 'GET' ? { status: 500, text: '' } : undefined;
    }, l.handler());
    const t2 = captureTools();
    const fail = parse(await callConfirmed((t2.get('apple_music_reorder_playlist') as CapturedTool).cb as unknown as GatedHandler, { playlistId: 'p.A', operation: 'reverse' }));
    expect((fail.warnings as string[])[0]).toMatch(/could not re-read/);
  });
});

describe('apple_music_move_playlist', () => {
  it('moves into a folder and back to the root, verifying membership', async () => {
    const { l, tools, calls } = setup();
    const r = await callTool(tools, 'apple_music_move_playlist', { playlistId: 'p.A', folderId: 'p.F1' });
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ data: [{ id: 'p.F1', type: 'library-playlist-folders' }] });
    expect(r.data).toMatchObject({ backend: 'web', playlist: 'Road Trip', folderId: 'p.F1', folder: 'Chill', changed: true, verified: true });
    expect(l.playlists.get('p.A')!.parent).toBe('p.F1');
    const again = await callTool(tools, 'apple_music_move_playlist', { playlistId: 'p.A', folderId: 'p.F1' });
    expect(again.data).toMatchObject({ changed: false, notes: ['"Road Trip" is already in Chill.'] });
    const back = await callTool(tools, 'apple_music_move_playlist', { playlistId: 'p.A', folderId: 'root' });
    expect(back.data).toMatchObject({ folderId: 'p.playlistsroot', folder: 'the top level', verified: true });
  });

  it('refuses a missing folder and moving into itself; lag and failures are warnings', async () => {
    const { l, tools } = setup();
    expect((await callTool(tools, 'apple_music_move_playlist', { playlistId: 'p.A', folderId: 'p.NOPE' })).data.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(((await callTool(tools, 'apple_music_move_playlist', { playlistId: 'p.A', folderId: 'p.A' })).data.error as { message: string }).message).toMatch(/into itself/);
    l.lag = true;
    const lag = await callTool(tools, 'apple_music_move_playlist', { playlistId: 'p.A', folderId: 'p.F1' });
    expect(lag.data).toMatchObject({ changed: true, verified: false, warnings: ['"Road Trip" does not show in Chill yet — Apple can lag; re-read it shortly.'] });
    l.lag = false;
    l.playlists.get('p.A')!.parent = undefined;
    let put = false;
    installFetch((req: FakeReq) => {
      if (req.method === 'PUT') put = true;
      return put && req.method === 'GET' ? { status: 500, text: '' } : undefined;
    }, l.handler());
    const fail = await callTool(captureTools(), 'apple_music_move_playlist', { playlistId: 'p.A', folderId: 'p.F1' });
    expect((fail.data.warnings as string[])[0]).toMatch(/could not re-read the folder/);
  });

  it('a folder without a name is shown by id', async () => {
    useWeb();
    const l = new FakeLibrary();
    l.addPlaylist('p.A', { name: 'A', tracks: [] });
    installFetch(route('GET', '/v1/me/library/playlist-folders/p.X', { json: { data: [{ id: 'p.X', type: 'library-playlist-folders' }] } }), route('GET', '/v1/me/library/playlist-folders/p.X/children', { json: { data: [{ id: 'p.A', type: 'library-playlists' }] } }), l.handler());
    const r = await callTool(captureTools(), 'apple_music_move_playlist', { playlistId: 'p.A', folderId: 'p.X' });
    expect(r.data).toMatchObject({ folder: 'p.X', changed: false });
  });
});

describe('apple_music_delete_playlist (confirm-gated)', () => {
  it('previews name, track count and date added; deletes and verifies it is gone', async () => {
    const { l, h } = setup();
    const p1 = await callPreview(h('apple_music_delete_playlist'), { playlistId: 'p.A' });
    expect(p1.preview).toEqual({
      playlist: 'Road Trip',
      playlistId: 'p.A',
      tracks: 5,
      dateAdded: '2025-01-01T22:04:05-05:00',
      dateAddedDisplay: 'Wed, Jan 1, 2025, 10:04 PM EST',
      description: 'Loud',
    });
    expect(l.playlists.has('p.A')).toBe(true);
    const r = parse(await callConfirmed(h('apple_music_delete_playlist'), { playlistId: 'p.A' }));
    expect(r).toMatchObject({ backend: 'web', playlist: 'Road Trip', deleted: true, verified: true });
    expect(l.playlists.has('p.A')).toBe(false);
  });

  it('an Apple playlist saved to the library says deleting only removes it from the library; huge counts are "5000+"', async () => {
    const { l, h } = setup();
    const p1 = await callPreview(h('apple_music_delete_playlist'), { playlistId: 'p.RO' });
    expect(p1.preview.note).toMatch(/removes it from your library only/);
    l.addPlaylist('p.H', { name: 'Huge', tracks: Array.from({ length: 5001 }, (_, i) => track(i + 1)) });
    expect((await callPreview(h('apple_music_delete_playlist'), { playlistId: 'p.H' })).preview.tracks).toBe('5000+');
  });

  it('refuses the root folder; lag and failed re-reads are warnings', async () => {
    const { l, tools, h } = setup();
    expect(((await callTool(tools, 'apple_music_delete_playlist', { playlistId: 'p.playlistsroot' }, NO_ELICIT_CTX)).data.error as { message: string }).message).toMatch(/root folder/);
    l.lag = true;
    const lag = parse(await callConfirmed(h('apple_music_delete_playlist'), { playlistId: 'p.A' }));
    expect(lag).toMatchObject({ deleted: true, verified: false, warnings: ['"Road Trip" still shows in your library — Apple can lag; re-read it shortly.'] });
    l.lag = false;
    l.addPlaylist('p.Z', { name: 'Z' });
    let deleted = false;
    installFetch((req: FakeReq) => {
      if (req.method === 'DELETE') deleted = true;
      return deleted && req.method === 'GET' ? { status: 500, text: '' } : undefined;
    }, l.handler());
    const t2 = captureTools();
    const fail = parse(await callConfirmed((t2.get('apple_music_delete_playlist') as CapturedTool).cb as unknown as GatedHandler, { playlistId: 'p.Z' }));
    expect((fail.warnings as string[])[0]).toMatch(/could not re-read/);
  });
});

describe('apple_music_remove_from_library (confirm-gated)', () => {
  function libSetup() {
    const s = setup();
    s.l.items.set(
      'songs',
      new Map([
        ['i.1', { id: 'i.1', type: 'library-songs', attributes: { name: 'One', artistName: 'A' } }],
        ['i.2', { id: 'i.2', type: 'library-songs', attributes: { name: 'Two' } }],
        ['i.3', { id: 'i.3', type: 'library-songs' }],
      ]),
    );
    return s;
  }

  it('previews item names, deletes each by library id, and verifies', async () => {
    const { l, h, calls } = libSetup();
    const args = { type: 'songs', ids: ['i.1', 'i.2', 'i.9'] };
    const p1 = await callPreview(h('apple_music_remove_from_library'), args);
    expect(p1.preview).toEqual({
      type: 'songs',
      count: 2,
      removing: [
        { id: 'i.1', name: 'One', artistName: 'A' },
        { id: 'i.2', name: 'Two' },
      ],
      notInLibrary: ['i.9'],
    });
    const r = parse(await callConfirmed(h('apple_music_remove_from_library'), args));
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/v1/me/library/songs/i.1', '/v1/me/library/songs/i.2']);
    expect(r).toMatchObject({ backend: 'web', removed: 2, requested: 3, verified: true, notInLibrary: ['i.9'], removedIds: ['i.1', 'i.2'] });
    expect([...l.items.get('songs')!.keys()]).toEqual(['i.3']);
  });

  it('nothing found is NOT_FOUND; playlist ids must be p.…', async () => {
    const { tools } = libSetup();
    const r = await callTool(tools, 'apple_music_remove_from_library', { type: 'albums', ids: ['l.x'] }, NO_ELICIT_CTX);
    expect(r.data.error).toMatchObject({ code: 'NOT_FOUND' });
    expect((r.data.error as { hint: string }).hint).toMatch(/catalog ids are different/);
    expect((await callTool(tools, 'apple_music_remove_from_library', { type: 'playlists', ids: ['i.x'] }, NO_ELICIT_CTX)).data.error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect((await callTool(tools, 'apple_music_remove_from_library', { type: 'songs', ids: ['12'] }, NO_ELICIT_CTX)).data.error).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('stops at the first failure and reports exactly what was removed', async () => {
    const { l } = libSetup();
    let dels = 0;
    let fail: { status: number } = { status: 400 };
    let failOn = 2;
    installFetch((req: FakeReq) => (req.method === 'DELETE' && ++dels === failOn ? { status: fail.status, text: '' } : undefined), l.handler());
    const t = captureTools();
    const handler = (t.get('apple_music_remove_from_library') as CapturedTool).cb as unknown as GatedHandler;
    const partial = parse(await callConfirmed(handler, { type: 'songs', ids: ['i.1', 'i.2', 'i.3'] }));
    expect(partial).toMatchObject({ removed: 1, partial: true, verified: false, removedIds: ['i.1'] });
    expect(partial.warnings).toEqual([expect.stringMatching(/^i\.2 was not removed: .*HTTP 400/), '1 item(s) after it were not attempted.']);
    dels = 0;
    failOn = 1;
    const first = await callConfirmed(handler, { type: 'songs', ids: ['i.2', 'i.3'] });
    expect(first.isError).toBe(true);
    expect(parse(first).error).toMatchObject({ status: 400 });
    dels = 0;
    fail = { status: 500 };
    const unk = parse(await callConfirmed(handler, { type: 'songs', ids: ['i.2'] }));
    expect(unk).toMatchObject({ removed: 0, partial: true, verified: false, warnings: [expect.stringMatching(/i\.2 MAY have been removed/)] });
  });

  it('still-listed items and failed re-reads are warnings', async () => {
    const { l } = libSetup();
    installFetch((req: FakeReq) => (req.method === 'DELETE' ? { status: 204 } : undefined), l.handler());
    const t = captureTools();
    const r = parse(await callConfirmed((t.get('apple_music_remove_from_library') as CapturedTool).cb as unknown as GatedHandler, { type: 'songs', ids: ['i.1'] }));
    expect(r).toMatchObject({ verified: false, warnings: ['Still listed: i.1 — Apple can lag; re-check shortly.'] });
    let deleted = false;
    installFetch((req: FakeReq) => {
      if (req.method === 'DELETE') deleted = true;
      return deleted && req.method === 'GET' ? { status: 500, text: '' } : undefined;
    }, l.handler());
    const t2 = captureTools();
    const r2 = parse(await callConfirmed((t2.get('apple_music_remove_from_library') as CapturedTool).cb as unknown as GatedHandler, { type: 'songs', ids: ['i.1'] }));
    expect((r2.warnings as string[])[0]).toMatch(/could not re-read/);
  });
});

describe('apple_music_remove_favorites', () => {
  it('DELETEs Apple\'s typed favorites query', async () => {
    useWeb();
    const { calls } = installFetch(route('DELETE', '/v1/me/favorites', { status: 202, text: '' }));
    const r = await callTool(captureTools(), 'apple_music_remove_favorites', { songs: ['1'], artists: ['2'] });
    expect(calls[0]!.url.search).toBe('?ids[songs]=1&ids[artists]=2');
    expect(r.data).toMatchObject({ backend: 'web', accepted: true, status: 202, requested: { songs: 1, artists: 1 }, verified: false });
  });
});
