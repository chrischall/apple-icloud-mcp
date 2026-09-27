import { describe, expect, it } from 'vitest';
import {
  ROOT_FOLDER_ID,
  assertCatalogId,
  assertLibraryId,
  assertLibraryPlaylistId,
  isCatalogId,
  isCatalogPlaylistId,
  isLibraryPlaylistId,
  normalizeStorefront,
  resolveTrackRef,
} from '../../src/music/ids.js';

describe('catalog ids', () => {
  it('accepts the documented shapes per type', () => {
    expect(isCatalogId('songs', '1440833851')).toBe(true);
    expect(isCatalogId('albums', '1')).toBe(true);
    expect(isCatalogId('playlists', 'pl.u-jV8990gT3bLqrj')).toBe(true);
    expect(isCatalogId('playlists', 'pl.cb4d1c09a2df4230a78d0395fe1f8fde')).toBe(true);
    expect(isCatalogId('stations', 'ra.1498157166')).toBe(true);
    expect(isCatalogId('songs', 'pl.x')).toBe(false);
    expect(isCatalogId('playlists', '123')).toBe(false);
  });

  it('refuses path-injection shapes and names the field', () => {
    expect(() => assertCatalogId('songs', '../ratings', 'ids[0]')).toThrow(/ids\[0\] "..\/ratings" is not a numeric catalog songs id/);
    expect(() => assertCatalogId('playlists', 'pl./x', 'id')).toThrow(/catalog playlist id/);
    expect(() => assertCatalogId('stations', '12', 'id')).toThrow(/station id/);
    expect(() => assertCatalogId('songs', '1440833851', 'id')).not.toThrow();
  });

  it('hints when a library id is given where a catalog id is expected', () => {
    try {
      assertCatalogId('songs', 'i.abc', 'songs[0]');
      expect.unreachable();
    } catch (err) {
      expect((err as { hint?: string }).hint).toMatch(/LIBRARY id/);
    }
  });
});

describe('library ids', () => {
  it('accepts i./a./l./r./p. and refuses others with a hint for catalog ids', () => {
    for (const id of ['i.PkdJNdAIrQozOW', 'a.1542568135', 'l.sticiFl', 'r.y8mMT7t', 'p.WmzVVDOUO9pDBk']) expect(() => assertLibraryId(id, 'id')).not.toThrow();
    expect(() => assertLibraryId('p.x/../y', 'id')).toThrow(/library id/);
    try {
      assertLibraryId('12345', 'trackIds[0]');
      expect.unreachable();
    } catch (err) {
      expect((err as { hint?: string }).hint).toMatch(/CATALOG id/);
    }
    try {
      assertLibraryId('zz', 'x');
      expect.unreachable();
    } catch (err) {
      expect((err as { hint?: string }).hint).toBeUndefined();
    }
  });

  it('library playlist ids must be p.… and a catalog playlist gets a pointer', () => {
    expect(() => assertLibraryPlaylistId('p.abc', 'playlistId')).not.toThrow();
    expect(() => assertLibraryPlaylistId(ROOT_FOLDER_ID, 'folderId')).not.toThrow();
    try {
      assertLibraryPlaylistId('pl.u-abc', 'playlistId');
      expect.unreachable();
    } catch (err) {
      expect((err as { hint?: string }).hint).toMatch(/CATALOG playlist/);
    }
    try {
      assertLibraryPlaylistId('i.abc', 'playlistId');
      expect.unreachable();
    } catch (err) {
      expect((err as { hint?: string }).hint).toMatch(/apple_music_list_playlists/);
    }
    expect(isCatalogPlaylistId('pl.a')).toBe(true);
    expect(isLibraryPlaylistId('p.a')).toBe(true);
    expect(isLibraryPlaylistId('pl.a')).toBe(false);
  });
});

describe('resolveTrackRef', () => {
  it('infers catalog and library songs from bare strings', () => {
    expect(resolveTrackRef('1440833851', 't')).toEqual({ id: '1440833851', type: 'songs' });
    expect(resolveTrackRef('i.abc', 't')).toEqual({ id: 'i.abc', type: 'library-songs' });
    expect(resolveTrackRef('a.1542568135', 't')).toEqual({ id: 'a.1542568135', type: 'library-songs' });
  });

  it('refuses playlists, albums and junk with specific hints', () => {
    const hintOf = (fn: () => unknown): string | undefined => {
      try {
        fn();
      } catch (err) {
        return (err as { hint?: string }).hint;
      }
      return 'no throw';
    };
    expect(hintOf(() => resolveTrackRef('pl.u-abc', 'tracks[0]'))).toMatch(/Playlists cannot be added/);
    expect(hintOf(() => resolveTrackRef('p.abc', 'tracks[0]'))).toMatch(/Playlists cannot be added/);
    expect(hintOf(() => resolveTrackRef('l.abc', 'tracks[0]'))).toMatch(/library ALBUM/);
    expect(hintOf(() => resolveTrackRef('hello', 'tracks[0]'))).toMatch(/music video/);
  });

  it('validates explicit {id, type} objects', () => {
    expect(resolveTrackRef({ id: '123', type: 'music-videos' }, 't')).toEqual({ id: '123', type: 'music-videos' });
    expect(resolveTrackRef({ id: 'i.v', type: 'library-music-videos' }, 't')).toEqual({ id: 'i.v', type: 'library-music-videos' });
    expect(() => resolveTrackRef({ id: 'i.v', type: 'songs' }, 'tracks[1]')).toThrow(/tracks\[1\]\.id "i.v" is not a numeric catalog id \(type songs\)/);
    expect(() => resolveTrackRef({ id: '123', type: 'library-songs' }, 't')).toThrow(/library id \(i\.…\) for type library-songs/);
  });
});

describe('normalizeStorefront', () => {
  it('lowercases a two-letter code and refuses anything else', () => {
    expect(normalizeStorefront(' US ', 'storefront')).toBe('us');
    expect(() => normalizeStorefront('usa', 'storefront')).toThrow(/two-letter storefront/);
  });
});
