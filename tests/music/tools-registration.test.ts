import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { CONFIRM_NOTE } from '../../src/tools/_confirm.js';
import { MusicClient } from '../../src/music/client.js';
import { clientGetter, defaultMusicClient, head, notesField, resetDefaultMusicClient, uniq } from '../../src/music/common.js';
import { registerMusicTools } from '../../src/music/tools.js';
import { captureTools, type CapturedTool } from './_helpers.js';

const READ = [
  'apple_music_search_catalog',
  'apple_music_get_catalog_items',
  'apple_music_get_charts',
  'apple_music_list_playlists',
  'apple_music_get_playlist',
  'apple_music_list_folders',
  'apple_music_search_library',
  'apple_music_list_library',
  'apple_music_get_history',
  'apple_music_get_recommendations',
  'apple_music_get_replay',
  'apple_music_get_ratings',
];
const ADDITIVE = ['apple_music_create_playlist', 'apple_music_add_playlist_tracks', 'apple_music_add_to_library', 'apple_music_add_favorites'];
const ALL = [
  'apple_music_create_folder',
  'apple_music_set_rating',
  'apple_music_update_playlist',
  'apple_music_remove_playlist_tracks',
  'apple_music_reorder_playlist',
  'apple_music_move_playlist',
  'apple_music_delete_playlist',
  'apple_music_remove_from_library',
  'apple_music_remove_favorites',
];
const GATED = ['apple_music_remove_playlist_tracks', 'apple_music_reorder_playlist', 'apple_music_delete_playlist', 'apple_music_remove_from_library'];

/** A minimal valid argument set per tool, for the strict-schema check. */
const MINIMAL: Record<string, Record<string, unknown>> = {
  apple_music_search_catalog: { term: 'x' },
  apple_music_get_catalog_items: { type: 'songs', ids: ['1'] },
  apple_music_get_charts: {},
  apple_music_list_playlists: {},
  apple_music_get_playlist: { playlistId: 'p.x' },
  apple_music_list_folders: {},
  apple_music_search_library: { term: 'x' },
  apple_music_list_library: { kind: 'songs' },
  apple_music_get_history: { feed: 'heavy-rotation' },
  apple_music_get_recommendations: {},
  apple_music_get_replay: {},
  apple_music_get_ratings: { type: 'songs', ids: ['1'] },
  apple_music_create_playlist: { name: 'x' },
  apple_music_add_playlist_tracks: { playlistId: 'p.x', tracks: ['1'] },
  apple_music_create_folder: { name: 'x' },
  apple_music_add_to_library: { songs: ['1'] },
  apple_music_add_favorites: { songs: ['1'] },
  apple_music_set_rating: { type: 'songs', id: '1', rating: 'love' },
  apple_music_update_playlist: { playlistId: 'p.x', name: 'y' },
  apple_music_remove_playlist_tracks: { playlistId: 'p.x', positions: [1] },
  apple_music_reorder_playlist: { playlistId: 'p.x', operation: 'reverse' },
  apple_music_move_playlist: { playlistId: 'p.x', folderId: 'root' },
  apple_music_delete_playlist: { playlistId: 'p.x' },
  apple_music_remove_from_library: { type: 'songs', ids: ['i.x'] },
  apple_music_remove_favorites: { songs: ['1'] },
};

describe('registration', () => {
  it('registers all 25 tools with an EMPTY environment and does no I/O', () => {
    const tools = captureTools();
    expect([...tools.keys()].sort()).toEqual([...READ, ...ADDITIVE, ...ALL].sort());
  });

  it('APPLE_WRITE_MODE=additive keeps reads + additive writes; none keeps reads only', () => {
    process.env.APPLE_WRITE_MODE = 'additive';
    expect([...captureTools().keys()].sort()).toEqual([...READ, ...ADDITIVE].sort());
    process.env.APPLE_WRITE_MODE = 'none';
    expect([...captureTools().keys()].sort()).toEqual([...READ].sort());
  });

  it('APPLE_SERVICES without music registers nothing', () => {
    process.env.APPLE_SERVICES = 'maps,weather';
    expect(captureTools().size).toBe(0);
  });

  it('every schema is strict, described, and accepts a minimal call', () => {
    const tools = captureTools();
    for (const [name, t] of tools) {
      const schema = t.cfg.inputSchema as unknown as { safeParse: (v: unknown) => { success: boolean }; shape: Record<string, { description?: string }> };
      expect(schema.safeParse(MINIMAL[name]).success, `${name} minimal`).toBe(true);
      expect(schema.safeParse({ ...MINIMAL[name], bogusArgument: 1 }).success, `${name} rejects unknown keys`).toBe(false);
      for (const [field, s] of Object.entries(schema.shape)) expect(s.description, `${name}.${field} has a description`).toBeTruthy();
    }
  });

  it('descriptions are search-friendly and bounded; gated tools end with CONFIRM_NOTE; extended ones say unofficial', () => {
    const tools = captureTools();
    for (const [name, t] of tools) {
      const d = t.cfg.description;
      const body = GATED.includes(name) ? d.slice(0, d.length - CONFIRM_NOTE.length) : d;
      expect(body.length, `${name} description length`).toBeLessThanOrEqual(420);
      expect(d.length, `${name} total description length`).toBeLessThanOrEqual(650);
      if (GATED.includes(name)) expect(d.endsWith(CONFIRM_NOTE), name).toBe(true);
      else expect(d.includes(CONFIRM_NOTE), name).toBe(false);
    }
    for (const name of ['apple_music_update_playlist', 'apple_music_move_playlist', 'apple_music_remove_favorites', ...GATED]) {
      expect(tools.get(name)!.cfg.description).toMatch(/web-player API \(unofficial/);
    }
  });

  it('annotations match the access level', () => {
    const tools = captureTools();
    const ann = (n: string) => (tools.get(n) as CapturedTool).cfg.annotations;
    for (const n of READ) expect(ann(n).readOnlyHint, n).toBe(true);
    for (const n of ADDITIVE) expect(ann(n)).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    for (const n of ['apple_music_set_rating', 'apple_music_move_playlist', 'apple_music_remove_favorites']) expect(ann(n)).toMatchObject({ destructiveHint: false, idempotentHint: true });
    for (const n of ['apple_music_update_playlist', 'apple_music_reorder_playlist', ...GATED]) expect(ann(n).destructiveHint, n).toBe(true);
    // No tool here removes a playlist folder (delete_playlist deletes playlists only), so a created folder cannot be
    // undone through this server: destructive by the inverse test, and so gated to APPLE_WRITE_MODE=all.
    expect(ann('apple_music_create_folder')).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    // Positional removal and move/reverse change a different track, or undo themselves, when repeated: a client
    // that retries or auto-approves "idempotent" tools must not be told they are safe to repeat.
    for (const n of ['apple_music_remove_playlist_tracks', 'apple_music_reorder_playlist']) {
      expect(ann(n), n).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    }
    // Repeating these IS a no-op (the item is already renamed / gone).
    for (const n of ['apple_music_update_playlist', 'apple_music_delete_playlist', 'apple_music_remove_from_library']) expect(ann(n).idempotentHint, n).toBe(true);
  });
});

describe('common', () => {
  it('clientGetter: injected client, lazily built from parts, or the shared default', () => {
    const c = new MusicClient();
    expect(clientGetter({ client: c })()).toBe(c);
    const fromHttp = clientGetter({ http: (async () => ({})) as never });
    expect(fromHttp()).toBe(fromHttp());
    const fromNow = clientGetter({ now: () => 5 });
    expect(fromNow().now()).toBe(5);
    resetDefaultMusicClient();
    const d = clientGetter()();
    expect(d).toBe(defaultMusicClient());
    resetDefaultMusicClient();
    expect(defaultMusicClient()).not.toBe(d);
  });

  it('registerMusicTools works with no deps at all (runMcp passes undefined)', () => {
    const names: string[] = [];
    registerMusicTools({ registerTool: (n: string) => names.push(n) } as unknown as McpServer);
    expect(names).toHaveLength(25);
  });

  it('small helpers', () => {
    const s = { backend: { name: 'web' } } as never;
    expect(head(s, { a: 1 })).toEqual({ backend: 'web', a: 1 });
    expect(head(s)).toEqual({ backend: 'web' });
    expect(notesField([undefined, '', 'x'])).toEqual({ notes: ['x'] });
    expect(notesField([])).toEqual({});
    expect(uniq([1, 1, 2])).toEqual([1, 2]);
  });
});
