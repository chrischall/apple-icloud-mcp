import { beforeEach, describe, expect, it } from 'vitest';
import { CAN_ASK_CTX, callConfirmed, callPreview, NO_ELICIT_CTX, type GatedHandler } from '../tools/_confirm-helpers.js';
import { MusicClient } from '../../src/music/client.js';
import { PREVIEW_LIST_CAP, dedupeTracks, moveTracks, replaceTracks, sortTracks } from '../../src/music/tools-extended.js';
import { PLAYLIST_WRITE_TTL_MS } from '../../src/music/write-log.js';
import { stateRevision } from '../../src/tools/_confirm.js';
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
    // The revision of the order it left, for the next change's expectedRevision.
    expect(r.revision).toBe(stateRevision(['i.T3', 'i.MV']));
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
    expect(r.revision).toBe(stateRevision(['i.T3', 'i.T2', 'i.T1']));
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
    expect(r.data.revision).toBe(stateRevision(ids(l)));
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

describe('reorder preview names the tracks it drops or moves', () => {
  const REORDER = 'apple_music_reorder_playlist';
  /** 13 tracks: Song 1–11, then second copies of Song 2 and Song 5 at positions 12 and 13 — past the first-10 rows. */
  function thirteen() {
    const env = setup();
    env.l.playlists.get('p.A')!.tracks = [...Array.from({ length: 11 }, (_, i) => track(i + 1)), track(2), track(5)];
    return env;
  }

  it('dedupe lists every copy it removes, with position and artist, even when the first rows do not change', async () => {
    const { l, h } = thirteen();
    const p1 = await callPreview(h(REORDER), { playlistId: 'p.A', operation: 'dedupe' });
    expect(p1.preview).toMatchObject({
      tracksBefore: 13,
      tracksAfter: 11,
      removed: 2,
      removing: [
        { position: 12, name: 'Song 2', artistName: 'Artist 2', id: 'i.T2' },
        { position: 13, name: 'Song 5', artistName: 'Artist 5', id: 'i.T5' },
      ],
    });
    // The first-10 rows alone could not show what goes: they are identical.
    expect(p1.preview.firstAfter).toEqual(p1.preview.firstBefore);
    expect(p1.preview.removingMore).toBeUndefined();
    expect(p1.preview.moving).toBeUndefined();
    const ask = await h(REORDER)({ playlistId: 'p.A', operation: 'dedupe' }, CAN_ASK_CTX);
    expect(JSON.stringify(ask)).toContain('removing 2 track(s): \\"Song 2\\", \\"Song 5\\"');
    expect(l.writes).toEqual([]);
  });

  it(`replace names every dropped track, up to ${PREVIEW_LIST_CAP}, then counts the rest`, async () => {
    const { l, h } = setup();
    l.playlists.get('p.A')!.tracks = Array.from({ length: 60 }, (_, i) => track(i + 1));
    const args = { playlistId: 'p.A', operation: 'replace', trackIds: ['i.T1', 'i.T2'] };
    const p1 = await callPreview(h(REORDER), args);
    const removing = p1.preview.removing as Array<{ position: number; name: string }>;
    expect(p1.preview).toMatchObject({ tracksBefore: 60, tracksAfter: 2, removed: 58, removingMore: 58 - PREVIEW_LIST_CAP });
    expect(removing).toHaveLength(PREVIEW_LIST_CAP);
    expect(removing[0]).toEqual({ position: 3, name: 'Song 3', artistName: 'Artist 3', id: 'i.T3' });
    expect(removing.at(-1)).toMatchObject({ position: 52, name: 'Song 52' });
    const ask = await h(REORDER)(args, CAN_ASK_CTX);
    expect(JSON.stringify(ask)).toContain('removing 58 track(s): \\"Song 3\\", \\"Song 4\\", \\"Song 5\\" and 55 more');
    expect(l.writes).toEqual([]);
  });

  it('move names the tracks it moves and where from and to', async () => {
    const { h } = thirteen();
    const one = await callPreview(h(REORDER), { playlistId: 'p.A', operation: 'move', fromPosition: 5, toPosition: 1 });
    expect(one.preview).toMatchObject({
      change: 'move "Song 5" from position 5 to 1',
      fromPosition: 5,
      toPosition: 1,
      moving: [{ position: 5, name: 'Song 5', artistName: 'Artist 5', id: 'i.T5' }],
    });
    expect(one.preview.removed).toBeUndefined();
    const block = await callPreview(h(REORDER), { playlistId: 'p.A', operation: 'move', fromPosition: 12, toPosition: 11, count: 2 });
    expect(block.preview).toMatchObject({
      change: 'move 2 tracks ("Song 2", "Song 5") from position 12 to 11',
      moving: [
        { position: 12, name: 'Song 2' },
        { position: 13, name: 'Song 5' },
      ],
    });
    const many = await callPreview(h(REORDER), { playlistId: 'p.A', operation: 'move', fromPosition: 1, toPosition: 4, count: 10 });
    expect(many.preview.change).toBe('move 10 tracks ("Song 1", "Song 2" and 8 more) from position 1 to 4');
  });
});

describe('playlist rewrites never rebuild from a read that lags the last write', () => {
  const REORDER = 'apple_music_reorder_playlist';
  const REMOVE = 'apple_music_remove_playlist_tracks';
  const ORIGINAL = ['i.T1', 'i.T2', 'i.T3', 'i.T2', 'i.MV'];
  const errorOf = (r: { data: Record<string, unknown> }) => r.data.error as Record<string, string>;

  it('dedupe then sort: the sort is refused while Apple still shows the duplicates, and runs once it catches up', async () => {
    const { l, h, tools } = setup();
    l.lag = true;
    const d = parse(await callConfirmed(h(REORDER), { playlistId: 'p.A', operation: 'dedupe' }));
    const deduped = ['i.T1', 'i.T2', 'i.T3', 'i.MV'];
    expect(d).toMatchObject({ changed: true, verified: false, revision: stateRevision(deduped) });
    expect(ids(l)).toEqual(deduped);

    const sortArgs = { playlistId: 'p.A', operation: 'sort', by: 'name', descending: true };
    const refused = await callTool(tools, REORDER, sortArgs, NO_ELICIT_CTX);
    expect(refused.isError).toBe(true);
    expect(errorOf(refused)).toMatchObject({ code: 'PLAYLIST_CHANGED', service: 'music', playlistId: 'p.A', currentRevision: stateRevision(ORIGINAL) });
    expect(errorOf(refused).message).toMatch(/^Apple is not showing your last change to "Road Trip" yet \(reorder \(dedupe\), 0 s ago\).*would undo it/);
    expect(errorOf(refused).hint).toMatch(/re-read it with apple_music_get_playlist.*lapses 120 s/);
    // Passing the dedupe's own revision does not get past it either: the read is still the old list.
    const chained = await callTool(tools, REORDER, { ...sortArgs, expectedRevision: d.revision }, NO_ELICIT_CTX);
    expect(errorOf(chained)).toMatchObject({ code: 'PLAYLIST_CHANGED', expectedRevision: d.revision });
    expect(errorOf(chained).message).toMatch(/not showing your last change/);
    expect(l.writes).toEqual(['replace p.A']);
    expect(ids(l)).toEqual(deduped);

    // A re-read says the same, so "re-read and retry" is not a loop that ends in a stale rewrite.
    const g = await callTool(tools, 'apple_music_get_playlist', { playlistId: 'p.A', allTracks: true });
    expect(g.data.revision).toBe(stateRevision(ORIGINAL));
    expect(g.data.notes).toContainEqual(expect.stringMatching(/does not show the change made 0 s ago \(reorder \(dedupe\)\) yet/));

    l.lag = false;
    const g2 = await callTool(tools, 'apple_music_get_playlist', { playlistId: 'p.A', allTracks: true });
    expect(g2.data.notes).toBeUndefined();
    const sorted = parse(await callConfirmed(h(REORDER), { ...sortArgs, expectedRevision: g2.data.revision }));
    expect(sorted).toMatchObject({ changed: true, verified: true, tracksBefore: 4, tracksAfter: 4 });
    expect(ids(l)).toEqual(['i.MV', 'i.T3', 'i.T2', 'i.T1']);
  });

  it('add then reorder: the tracks just added are not dropped by a rewrite from the lagging read', async () => {
    const { l, tools, h } = setup();
    l.lag = true;
    const add = await callTool(tools, 'apple_music_add_playlist_tracks', { playlistId: 'p.A', tracks: ['777'] });
    expect(add.data).toMatchObject({ added: 1, verified: false });
    const refused = await callTool(tools, REORDER, { playlistId: 'p.A', operation: 'reverse' }, NO_ELICIT_CTX);
    expect(errorOf(refused)).toMatchObject({ code: 'PLAYLIST_CHANGED' });
    expect(errorOf(refused).message).toMatch(/\(add tracks, 0 s ago\)/);
    const rm = await callTool(tools, REMOVE, { playlistId: 'p.A', positions: [1] }, NO_ELICIT_CTX);
    expect(errorOf(rm)).toMatchObject({ code: 'PLAYLIST_CHANGED' });
    expect(ids(l)).toEqual([...ORIGINAL, 'i.C777']);
    l.lag = false;
    const r = parse(await callConfirmed(h(REORDER), { playlistId: 'p.A', operation: 'reverse' }));
    expect(r).toMatchObject({ tracksBefore: 6, verified: true });
    expect(ids(l)).toEqual(['i.C777', 'i.MV', 'i.T2', 'i.T3', 'i.T2', 'i.T1']);
  });

  it('create then reorder: a read listing only the first batch of a new playlist is not rewritten over the rest', async () => {
    const { l, tools, h } = setup();
    l.lag = true;
    // 150 tracks: 100 go in the create, 50 are appended — the lagging read shows the playlist with the first 100.
    const tracks = Array.from({ length: 150 }, (_, i) => String(1000 + i));
    const created = await callTool(tools, 'apple_music_create_playlist', { name: 'Big', tracks });
    expect(created.data).toMatchObject({ tracksAdded: 150, verified: false });
    const id = created.data.id as string;
    const refused = await callTool(tools, REORDER, { playlistId: id, operation: 'reverse' }, NO_ELICIT_CTX);
    expect(errorOf(refused)).toMatchObject({ code: 'PLAYLIST_CHANGED', playlistId: id });
    expect(errorOf(refused).message).toMatch(/\(create playlist with 150 tracks, 0 s ago\).*would undo it/);
    const rm = await callTool(tools, REMOVE, { playlistId: id, positions: [1] }, NO_ELICIT_CTX);
    expect(errorOf(rm)).toMatchObject({ code: 'PLAYLIST_CHANGED' });
    const g = await callTool(tools, 'apple_music_get_playlist', { playlistId: id, allTracks: true });
    expect(g.data.total).toBe(100);
    expect(g.data.notes).toContainEqual(expect.stringMatching(/does not show the change made 0 s ago \(create playlist with 150 tracks\) yet/));
    expect(l.playlists.get(id)!.tracks).toHaveLength(150);
    l.lag = false;
    const r = parse(await callConfirmed(h(REORDER), { playlistId: id, operation: 'reverse' }));
    expect(r).toMatchObject({ tracksBefore: 150, tracksAfter: 150, verified: true });
    expect(l.playlists.get(id)!.tracks).toHaveLength(150);
  });

  it('remove then reorder, and the guard lapses after its TTL', async () => {
    useWeb();
    const l = new FakeLibrary();
    l.addPlaylist('p.A', { name: 'Road Trip', tracks: [track(1), track(2), track(3)] });
    installFetch(l.handler());
    let clock = Date.parse('2026-09-27T12:00:00Z');
    const tools = captureTools(new MusicClient({ now: () => clock }));
    const h = (name: string): GatedHandler => (tools.get(name) as CapturedTool).cb as unknown as GatedHandler;
    l.lag = true;
    const rm = parse(await callConfirmed(h(REMOVE), { playlistId: 'p.A', positions: [1] }));
    expect(rm).toMatchObject({ removed: 1, verified: false, revision: stateRevision(['i.T2', 'i.T3']) });
    clock += PLAYLIST_WRITE_TTL_MS - 1000;
    const refused = await callTool(tools, REORDER, { playlistId: 'p.A', operation: 'reverse' }, NO_ELICIT_CTX);
    expect(errorOf(refused).message).toMatch(/\(remove tracks, 119 s ago\)/);
    // A second removal from the stale list is refused the same way.
    const again = await callTool(tools, REMOVE, { playlistId: 'p.A', positions: [2] }, NO_ELICIT_CTX);
    expect(errorOf(again)).toMatchObject({ code: 'PLAYLIST_CHANGED' });
    clock += 2000;
    // Past the TTL the record is dropped (Apple has had its time); the change is previewed as usual.
    const later = await callPreview(h(REORDER), { playlistId: 'p.A', operation: 'reverse' });
    expect(later.preview.tracksBefore).toBe(3);
  });

  it('an UNCONFIRMED rewrite is remembered too (it may have landed); a refused one is not', async () => {
    const { l } = setup();
    let failPut: 503 | 400 = 503;
    installFetch((req: FakeReq) => (req.method === 'PUT' ? { status: failPut, json: { errors: [{ status: String(failPut), title: 'Nope' }] } } : undefined), l.handler());
    const tools = captureTools();
    const h = (name: string): GatedHandler => (tools.get(name) as CapturedTool).cb as unknown as GatedHandler;
    const r = parse(await callConfirmed(h(REORDER), { playlistId: 'p.A', operation: 'reverse' }));
    expect(r.error).toMatchObject({ code: 'UNCONFIRMED_WRITE' });
    const next = await callTool(tools, REORDER, { playlistId: 'p.A', operation: 'dedupe' }, NO_ELICIT_CTX);
    expect(errorOf(next).message).toMatch(/\(reorder \(reverse\), unconfirmed, 0 s ago\)/);

    failPut = 400;
    const tools2 = captureTools();
    const h2 = (name: string): GatedHandler => (tools2.get(name) as CapturedTool).cb as unknown as GatedHandler;
    const bad = parse(await callConfirmed(h2(REORDER), { playlistId: 'p.A', operation: 'reverse' }));
    expect(bad.error).toMatchObject({ code: 'UPSTREAM_ERROR', status: 400 });
    // Nothing landed, so nothing is remembered: the next change is previewed normally.
    const ok = await callPreview(h2(REORDER), { playlistId: 'p.A', operation: 'dedupe' });
    expect(ok.preview.removed).toBe(1);
  });

  it('expectedRevision: a rewrite applies only to the order the caller read; results chain', async () => {
    const { l, h, tools } = setup();
    const read = await callTool(tools, 'apple_music_get_playlist', { playlistId: 'p.A', allTracks: true });
    const r0 = read.data.revision as string;
    expect(r0).toBe(stateRevision(ORIGINAL));
    const rev = parse(await callConfirmed(h(REORDER), { playlistId: 'p.A', operation: 'reverse', expectedRevision: r0 }));
    expect(rev).toMatchObject({ verified: true, revision: stateRevision([...ORIGINAL].reverse()) });

    // The pre-reverse revision is stale now: refused, naming both revisions.
    const stale = await callTool(tools, REORDER, { playlistId: 'p.A', operation: 'dedupe', expectedRevision: r0 }, NO_ELICIT_CTX);
    expect(stale.isError).toBe(true);
    expect(errorOf(stale)).toMatchObject({ code: 'PLAYLIST_CHANGED', expectedRevision: r0, currentRevision: rev.revision });
    expect(errorOf(stale).message).toMatch(/^"Road Trip" no longer reads as revision s1:.*changed since then, or Apple has not caught up/);
    expect(errorOf(stale).hint).toMatch(/apple_music_get_playlist \(allTracks\)/);

    // The revision the reverse returned chains into the next change.
    const rm = parse(await callConfirmed(h(REMOVE), { playlistId: 'p.A', trackIds: ['i.MV'], expectedRevision: rev.revision }));
    expect(rm).toMatchObject({ removed: 1, verified: true, revision: stateRevision(['i.T2', 'i.T3', 'i.T2', 'i.T1']) });

    // A change made elsewhere (the Music app) since the read is caught the same way, by either tool.
    l.playlists.get('p.A')!.tracks.push(track(8));
    for (const [name, args] of [
      [REMOVE, { playlistId: 'p.A', positions: [1] }],
      [REORDER, { playlistId: 'p.A', operation: 'reverse' }],
    ] as const) {
      const r = await callTool(tools, name, { ...args, expectedRevision: rm.revision }, NO_ELICIT_CTX);
      expect(errorOf(r), name).toMatchObject({ code: 'PLAYLIST_CHANGED' });
    }
    expect(l.writes).toEqual(['replace p.A', 'remove p.A']);

    // The schema takes only a revision's shape.
    const schema = (tools.get(REORDER) as CapturedTool).cfg.inputSchema;
    expect(schema.safeParse({ playlistId: 'p.A', operation: 'reverse', expectedRevision: 'latest' }).success).toBe(false);
    expect(schema.safeParse({ playlistId: 'p.A', operation: 'reverse', expectedRevision: r0 }).success).toBe(true);
  });

  it('catalog playlist ids get a hint that fits the tool (editing tools never suggest adding it to the library)', async () => {
    const { tools } = setup();
    for (const [name, args] of [
      [REORDER, { playlistId: 'pl.u-abc', operation: 'reverse' }],
      [REMOVE, { playlistId: 'pl.u-abc', positions: [1] }],
      ['apple_music_update_playlist', { playlistId: 'pl.u-abc', name: 'x' }],
    ] as const) {
      const hint = errorOf(await callTool(tools, name, args, NO_ELICIT_CTX)).hint!;
      expect(hint, name).toMatch(/read-only.*apple_music_create_playlist/);
      expect(hint, name).not.toMatch(/add_to_library/);
    }
    for (const [name, args] of [
      ['apple_music_delete_playlist', { playlistId: 'pl.u-abc' }],
      ['apple_music_remove_from_library', { type: 'playlists', ids: ['pl.u-abc'] }],
      ['apple_music_move_playlist', { playlistId: 'pl.u-abc', folderId: 'root' }],
    ] as const) {
      const hint = errorOf(await callTool(tools, name, args, NO_ELICIT_CTX)).hint!;
      expect(hint, name).toMatch(/p\.… id of your library copy/);
    }
    expect(errorOf(await callTool(tools, 'apple_music_move_playlist', { playlistId: 'p.A', folderId: 'pl.x' })).hint).toMatch(/not a folder/);
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
