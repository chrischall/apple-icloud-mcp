import { InvalidArgumentError } from '../errors.js';

/**
 * Apple Music identifier shapes, validated BEFORE an id is put into a URL
 * path. An id is spliced into `/v1/me/library/playlists/{id}/tracks`, so an
 * unchecked value (`../ratings`, `p.x?ids=…`) would address a different
 * endpoint than the one the tool — and the confirmation preview — named.
 *
 * Shapes (Apple's documentation and observed payloads):
 *  - catalog songs / albums / artists / music videos: numeric (`1440833851`)
 *  - catalog playlists: `pl.` (`pl.u-…` user-shared, `pl.pm-…` personal mix)
 *  - stations: `ra.` (`ra.u-…` for a personal station)
 *  - library items: one lowercase letter and a dot — `i.` songs and music
 *    videos, `a.` songs added from the catalog (Apple's own examples show
 *    `a.1542568135` inside library playlists), `l.` albums, `r.` artists,
 *    `p.` playlists AND playlist folders (`p.playlistsroot` is the root).
 */

const NUMERIC_RE = /^\d{1,20}$/;
const TAIL = String.raw`[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}`;
const CATALOG_PLAYLIST_RE = new RegExp(`^pl\\.${TAIL}$`);
const STATION_RE = new RegExp(`^ra\\.${TAIL}$`);
const LIBRARY_RE = new RegExp(`^[a-z]\\.${TAIL}$`);
const LIBRARY_PLAYLIST_RE = new RegExp(`^p\\.${TAIL}$`);
const LIBRARY_TRACK_RE = new RegExp(`^[ia]\\.${TAIL}$`);

/** The root playlist folder's id (Apple documents it via `filter[identity]=playlistsroot`). */
export const ROOT_FOLDER_ID = 'p.playlistsroot';

export const CATALOG_TYPES = ['songs', 'albums', 'artists', 'playlists', 'music-videos', 'stations'] as const;
export type CatalogType = (typeof CATALOG_TYPES)[number];

export const LIBRARY_TYPES = ['songs', 'albums', 'artists', 'playlists', 'music-videos'] as const;
export type LibraryType = (typeof LIBRARY_TYPES)[number];

function bad(field: string, value: string, expected: string, hint?: string): never {
  throw new InvalidArgumentError(`${field} "${value}" is not ${expected}.`, hint);
}

export function isCatalogId(type: CatalogType, id: string): boolean {
  if (type === 'playlists') return CATALOG_PLAYLIST_RE.test(id);
  if (type === 'stations') return STATION_RE.test(id);
  return NUMERIC_RE.test(id);
}

/** Throws unless `id` is a catalog id of `type`. */
export function assertCatalogId(type: CatalogType, id: string, field: string): void {
  if (isCatalogId(type, id)) return;
  const expected =
    type === 'playlists'
      ? 'a catalog playlist id (pl.…)'
      : type === 'stations'
        ? 'a station id (ra.…)'
        : `a numeric catalog ${type} id`;
  bad(field, id, expected, LIBRARY_RE.test(id) ? 'That looks like a LIBRARY id; this argument takes catalog ids.' : undefined);
}

/** Throws unless `id` is shaped like a library id (one letter, a dot, then [A-Za-z0-9._-]). */
export function assertLibraryId(id: string, field: string): void {
  if (!LIBRARY_RE.test(id)) {
    bad(field, id, 'a library id (like i.…, l.…, r.… or p.…)', NUMERIC_RE.test(id) ? 'That looks like a CATALOG id; this argument takes library ids.' : undefined);
  }
}

/** Throws unless `id` is a library playlist (or folder) id: `p.…`. */
export function assertLibraryPlaylistId(id: string, field: string): void {
  if (!LIBRARY_PLAYLIST_RE.test(id)) {
    bad(
      field,
      id,
      'a library playlist id (p.…)',
      CATALOG_PLAYLIST_RE.test(id)
        ? 'pl.… is a CATALOG playlist. Add it to your library first (apple_music_add_to_library), then use the p.… id from apple_music_list_playlists.'
        : 'Use the id from apple_music_list_playlists.',
    );
  }
}

/** Whether `id` is a catalog playlist id (`pl.…`). */
export function isCatalogPlaylistId(id: string): boolean {
  return CATALOG_PLAYLIST_RE.test(id);
}

/** Whether `id` is a library playlist/folder id (`p.…`). */
export function isLibraryPlaylistId(id: string): boolean {
  return LIBRARY_PLAYLIST_RE.test(id);
}

// ---------------------------------------------------------------------------
// Track references for playlist writes
// ---------------------------------------------------------------------------

export const TRACK_TYPES = ['songs', 'library-songs', 'music-videos', 'library-music-videos'] as const;
export type TrackType = (typeof TRACK_TYPES)[number];

export interface TrackRef {
  id: string;
  type: TrackType;
}

export type TrackRefInput = string | { id: string; type: TrackType };

/**
 * Turn a caller's track reference into the `{id, type}` Apple's playlist
 * endpoints take. A bare string is inferred: numeric → a catalog song,
 * `i.`/`a.` → a library song. Anything else (an album, a playlist, a music
 * video) must be named with an explicit `{id, type}` — guessing would add the
 * wrong kind of item or fail upstream with a vaguer error.
 */
export function resolveTrackRef(ref: TrackRefInput, field: string): TrackRef {
  if (typeof ref === 'string') {
    if (NUMERIC_RE.test(ref)) return { id: ref, type: 'songs' };
    if (LIBRARY_TRACK_RE.test(ref)) return { id: ref, type: 'library-songs' };
    if (CATALOG_PLAYLIST_RE.test(ref) || LIBRARY_PLAYLIST_RE.test(ref)) {
      bad(field, ref, 'a song', 'Playlists cannot be added as tracks. Read the playlist (apple_music_get_playlist) and add its songs.');
    }
    if (/^l\./.test(ref)) {
      bad(field, ref, 'a song', 'l.… is a library ALBUM. Read its tracks (apple_music_get_catalog_items with type albums) and add those.');
    }
    return bad(
      field,
      ref,
      'a song id',
      'Give a catalog song id (numeric), a library song id (i.…), or {"id": …, "type": "music-videos" | "library-music-videos"} for a music video.',
    );
  }
  if (ref.type === 'songs' || ref.type === 'music-videos') {
    if (!NUMERIC_RE.test(ref.id)) bad(`${field}.id`, ref.id, `a numeric catalog id (type ${ref.type})`);
  } else if (!LIBRARY_TRACK_RE.test(ref.id)) {
    bad(`${field}.id`, ref.id, `a library id (i.…) for type ${ref.type}`);
  }
  return { id: ref.id, type: ref.type };
}

/** Normalize a storefront code (`US` → `us`), or throw. */
export function normalizeStorefront(value: string, field: string): string {
  const v = value.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(v)) bad(field, value, 'a two-letter storefront code (like us, gb, jp)');
  return v;
}
