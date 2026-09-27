import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AppleToolError, UnconfirmedWriteError, UpstreamError, errorMessage } from '../errors.js';
import { jsonErrorResponse } from '../tools/_shared.js';
import { requireData, type AppleDoc, type MusicClient, type MusicSession } from './client.js';
import { ROOT_FOLDER_ID, type TrackRef } from './ids.js';
import { attrs, catalogIdOf, isRecord, nameOf, resourceName, str, type AppleResource } from './project.js';
import { PLAYLIST_WRITE_TTL_MS, trackRevision } from './write-log.js';

/**
 * Library playlist plumbing shared by the read and write tools.
 *
 * The track list of a library playlist is read 100 at a time (Apple's maximum
 * for that relationship) with explicit offsets. Any change that REWRITES the
 * list (remove, reorder, dedupe) is computed from a complete fresh read and
 * refused when the read was capped — a PUT built from a partial read would
 * silently truncate the playlist.
 */

export const LIBRARY_TRACKS_PER_REQUEST = 100;
export const MAX_TRACKS_READ = 5000;
export const TRACK_WRITE_BATCH = 100;
export const FOLDER_CHILDREN_PER_REQUEST = 100;
export const MAX_FOLDER_CHILDREN = 2000;

export const PLAYLIST_NOT_FOUND = 'No library playlist has this id. List yours with apple_music_list_playlists (ids look like p.…).';
export const FOLDER_NOT_FOUND = 'No playlist folder has this id. List folders with apple_music_list_folders (the root is "root").';
export const EMPTY_TRACKS_NOTE = 'Apple answered 404 for the track list, which is what it does for a playlist with no tracks.';

export function playlistPath(id: string): string {
  return `/v1/me/library/playlists/${id}`;
}

/** GET one library playlist's attributes. */
export async function readLibraryPlaylist(s: MusicSession, id: string): Promise<AppleResource> {
  const path = playlistPath(id);
  const res = await s.request<AppleDoc>({ path, notFoundHint: PLAYLIST_NOT_FOUND });
  const pl = requireData(res.data, `GET ${path}`)[0];
  if (!pl) {
    throw new UpstreamError('music', 404, `music (${s.backend.name}): library playlist ${id} was not found.`, { hint: PLAYLIST_NOT_FOUND });
  }
  return pl;
}

/** Does the playlist exist right now? (404 → false; used to verify deletes and creates.) */
export async function playlistExists(s: MusicSession, id: string): Promise<AppleResource | undefined> {
  const path = playlistPath(id);
  const res = await s.request<AppleDoc>({ path, okStatuses: [404] });
  if (res.status === 404) return undefined;
  return requireData(res.data, `GET ${path}`)[0];
}

export interface TrackRead {
  tracks: AppleResource[];
  /** Every track was read (nothing beyond the cap). */
  complete: boolean;
  total?: number;
  notes: string[];
}

/** Read a window of a library playlist's tracks. */
export async function readLibraryTracks(s: MusicSession, id: string, offset: number, want: number): Promise<TrackRead> {
  const r = await s.collect(`${playlistPath(id)}/tracks`, {}, {
    offset,
    want,
    perRequest: LIBRARY_TRACKS_PER_REQUEST,
    okStatuses: [404],
  });
  const notes = r.items.length === 0 && offset === 0 ? [r.emptyStatus === 404 ? EMPTY_TRACKS_NOTE : 'This playlist has no tracks.'] : [];
  return { tracks: r.items, complete: !r.hasMore, total: r.total, notes };
}

/** Read every track (up to MAX_TRACKS_READ). */
export function readAllLibraryTracks(s: MusicSession, id: string): Promise<TrackRead> {
  return readLibraryTracks(s, id, 0, MAX_TRACKS_READ);
}

/** Warnings describing a partial append, for the response. */
export function appendWarnings(r: AppendResult): string[] {
  if (!r.failure) return [];
  const f = r.failure;
  const out = [
    f.unconfirmed
      ? `Tracks ${f.fromTrack}–${f.toTrack} MAY have been added (Apple's answer was lost: ${f.message}). Re-read the playlist before retrying them.`
      : `Tracks ${f.fromTrack}–${f.toTrack} were not added: ${f.message}`,
  ];
  if (r.notAttempted > 0) out.push(`${r.notAttempted} track(s) after those were not attempted.`);
  return out;
}

/** Refuse to compute a rewrite from a partial read. */
export function requireCompleteRead(read: TrackRead, what: string): void {
  if (!read.complete) {
    throw new AppleToolError('UNSUPPORTED', `music: this playlist has more than ${MAX_TRACKS_READ} tracks; refusing to ${what} from a partial read.`, {
      hint: 'Edit this playlist in the Music app. A change computed from part of the track list would drop the rest.',
    });
  }
}

/** Refuse a playlist Apple marks read-only (`canEdit: false`). */
export function refuseReadOnly(pl: AppleResource, name: string): void {
  if (attrs(pl).canEdit === false) {
    throw new AppleToolError('UNSUPPORTED', `Playlist "${name}" cannot be edited (Apple reports canEdit: false).`, {
      hint:
        'Apple-curated playlists saved to your library and collaborative playlists are read-only through this API. ' +
        'Create your own playlist instead (apple_music_delete_playlist can drop it from your library).',
    });
  }
}

/** The editable fields of a playlist as Apple reports them (absent when Apple sent none). */
export function playlistFields(pl: AppleResource): { name?: string; description?: string; isPublic?: boolean } {
  const a = attrs(pl);
  // `update_playlist` sends these back as the complete attribute set, so a description Apple holds only as
  // `short` must be read, not taken for "" (which would clear it).
  const description = str(a.description) ?? (isRecord(a.description) ? (str(a.description.standard) ?? str(a.description.short) ?? '') : undefined);
  const name = resourceName(pl);
  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(typeof a.isPublic === 'boolean' ? { isPublic: a.isPublic } : {}),
  };
}

/** Short identity of a track for previews: position, name, artist. */
export function trackLabel(t: AppleResource, position: number): Record<string, unknown> {
  const a = attrs(t);
  return {
    position,
    name: nameOf(t),
    ...(typeof a.artistName === 'string' ? { artistName: a.artistName } : {}),
    id: t.id,
  };
}

/** The dedupe key of a track: its catalog id, else its library id. */
export function trackKey(t: AppleResource): string {
  return catalogIdOf(t) ?? t.id;
}

export interface AppendResult {
  added: number;
  /** The batch that failed, if any; later batches were not attempted. */
  failure?: { fromTrack: number; toTrack: number; message: string; unconfirmed: boolean; error: unknown };
  notAttempted: number;
}

/**
 * Append tracks in batches of 100 (larger requests are refused upstream).
 * Stops at the first failed batch: later batches would most likely fail the
 * same way, and the caller must report exactly what landed. `numberFrom` is
 * how many of the caller's tracks precede `refs` (so a failure is reported in
 * the caller's own 1-based numbering).
 */
export async function appendTracks(s: MusicSession, playlistId: string, refs: TrackRef[], numberFrom = 0): Promise<AppendResult> {
  let added = 0;
  for (let i = 0; i < refs.length; i += TRACK_WRITE_BATCH) {
    const batch = refs.slice(i, i + TRACK_WRITE_BATCH);
    try {
      await s.request({ method: 'POST', path: `${playlistPath(playlistId)}/tracks`, json: { data: batch } });
      added += batch.length;
    } catch (err) {
      return {
        added,
        failure: {
          fromTrack: numberFrom + i + 1,
          toTrack: numberFrom + i + batch.length,
          message: errorMessage(err),
          unconfirmed: err instanceof UnconfirmedWriteError,
          error: err,
        },
        notAttempted: refs.length - i - batch.length,
      };
    }
  }
  return { added, notAttempted: 0 };
}

// ---------------------------------------------------------------------------
// Rewrites must start from the order the caller (and this process) last saw
// ---------------------------------------------------------------------------

/** The `expectedRevision` argument of the playlist-rewriting tools. */
export const expectedRevisionParam = z
  .string()
  .regex(/^s\d+:[A-Za-z0-9_-]{10,64}$/, 'a revision from apple_music_get_playlist or a previous playlist write')
  .optional()
  .describe(
    'The playlist revision you expect: from apple_music_get_playlist (a complete read) or from the previous change\'s ' +
      'result. Refused if the playlist no longer reads as that revision. (A change is also refused, whatever this says, ' +
      'while Apple still shows the list as it was before this server\'s last change to it.)',
  );

/** Error code of a refusal to rewrite a playlist from a read that is not the expected state. */
export const PLAYLIST_CHANGED = 'PLAYLIST_CHANGED';

/**
 * Refuse to rewrite a playlist from `tracks` (a fresh, complete read) when
 *  - it still shows the order a write from THIS process replaced moments ago
 *    (Apple's reads lag its writes; a full-list rewrite from that read would
 *    undo the change), or
 *  - the caller passed `expectedRevision` and the read is a different order.
 * Returns the error result to hand back, or undefined to proceed.
 */
export function playlistStateRefusal(
  c: MusicClient,
  playlistId: string,
  name: string,
  tracks: readonly AppleResource[],
  expectedRevision: string | undefined,
): CallToolResult | undefined {
  const currentRevision = trackRevision(tracks);
  const now = c.now();
  const pending = c.playlistWrites.pending(playlistId, currentRevision, now);
  const refuse = (message: string, hint: string): CallToolResult =>
    jsonErrorResponse({
      error: {
        code: PLAYLIST_CHANGED,
        service: 'music',
        message,
        hint,
        playlistId,
        currentRevision,
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      },
    });
  if (pending) {
    const ago = Math.max(0, Math.round((now - pending.at) / 1000));
    return refuse(
      `Apple is not showing your last change to "${name}" yet (${pending.what}, ${ago} s ago): it still lists the tracks as ` +
        'they were before that change, and rewriting the playlist from this read would undo it. Nothing was changed.',
      `Wait a few seconds, re-read it with apple_music_get_playlist, and retry once it shows the change (this check lapses ${PLAYLIST_WRITE_TTL_MS / 1000} s after the change).`,
    );
  }
  if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
    return refuse(
      `"${name}" no longer reads as revision ${expectedRevision}: the playlist changed since then, or Apple has not caught up ` +
        'with your last change yet. Nothing was changed.',
      'Re-read it with apple_music_get_playlist (allTracks), check the order, and retry with the revision it returns.',
    );
  }
  return undefined;
}

/**
 * Send a write that replaces `before` (the playlist's order as read) and
 * remember it, so a lagging read is not rewritten over it. An UNCONFIRMED
 * write is remembered too: it may have landed.
 */
export async function recordedPlaylistWrite<T>(
  s: MusicSession,
  playlistId: string,
  what: string,
  before: readonly AppleResource[],
  send: () => Promise<T>,
): Promise<T> {
  const at = s.client.now();
  try {
    const out = await send();
    rememberPlaylistWrite(s, playlistId, what, before, at);
    return out;
  } catch (err) {
    if (err instanceof UnconfirmedWriteError) rememberPlaylistWrite(s, playlistId, `${what}, unconfirmed`, before, at);
    throw err;
  }
}

/** Remember that a write sent at `at` replaced the order `before` (see PlaylistWriteLog). */
export function rememberPlaylistWrite(s: MusicSession, playlistId: string, what: string, before: readonly AppleResource[], at: number): void {
  s.client.playlistWrites.record(playlistId, { at, what, before: trackRevision(before) });
}

/** GET one playlist folder (404 → NOT_FOUND with a pointer to list_folders). */
export async function readFolder(s: MusicSession, folderId: string): Promise<AppleResource> {
  const path = `/v1/me/library/playlist-folders/${folderId}`;
  const res = await s.request<AppleDoc>({ path, notFoundHint: FOLDER_NOT_FOUND });
  const folder = requireData(res.data, `GET ${path}`)[0];
  if (!folder) throw new UpstreamError('music', 404, `music (${s.backend.name}): playlist folder ${folderId} was not found.`, { hint: FOLDER_NOT_FOUND });
  return folder;
}

/**
 * The children (folders and playlists) of a folder, up to MAX_FOLDER_CHILDREN.
 * Apple may answer 404 for an EMPTY folder's children (as it does for an empty
 * playlist's tracks), so a 404 is double-checked against the folder itself:
 * a folder that exists is empty; one that does not is NOT_FOUND.
 */
export async function readFolderChildren(
  s: MusicSession,
  folderId: string,
  window: { offset: number; want: number } = { offset: 0, want: MAX_FOLDER_CHILDREN },
): Promise<{ items: AppleResource[]; complete: boolean; total?: number }> {
  const r = await s.collect(`/v1/me/library/playlist-folders/${folderId}/children`, {}, {
    offset: window.offset,
    want: window.want,
    perRequest: FOLDER_CHILDREN_PER_REQUEST,
    okStatuses: [404],
  });
  if (r.emptyStatus === 404 && r.items.length === 0 && window.offset === 0) await readFolder(s, folderId);
  return { items: r.items, complete: !r.hasMore, total: r.total };
}

/** `root` → the root folder id. */
export function folderIdArg(value: string): string {
  return value === 'root' ? ROOT_FOLDER_ID : value;
}
