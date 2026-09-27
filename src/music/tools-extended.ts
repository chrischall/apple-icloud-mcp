import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getDisplayTimeZone } from '../config.js';
import { AppleToolError, InvalidArgumentError, UnconfirmedWriteError, UpstreamError, errorMessage } from '../errors.js';
import { CONFIRM_NOTE, confirmTokenParam, confirmWrite, stateRevision } from '../tools/_confirm.js';
import { ANNOTATIONS, compactObject, defineTool, jsonResponse } from '../tools/_shared.js';
import { requireData, type AppleDoc, type MusicClient, type MusicSession } from './client.js';
import { head, notesField, uniq } from './common.js';
import { ROOT_FOLDER_ID, assertLibraryId, assertLibraryPlaylistId, LIBRARY_TYPES } from './ids.js';
import {
  MAX_TRACKS_READ,
  folderIdArg,
  playlistExists,
  playlistPath,
  readAllLibraryTracks,
  readFolder,
  readFolderChildren,
  playlistFields,
  readLibraryPlaylist,
  refuseReadOnly,
  requireCompleteRead,
  trackKey,
  trackLabel,
} from './playlists.js';
import { attrs, nameOf, num, putDate, resourceName, str, type AppleResource } from './project.js';
import { FAVORITE_FIELDS, typedIdsQuery, typedIdsSchema, type TypedIdField } from './tools-write.js';

/**
 * Extended playlist and library tools — the operations Apple's documented API
 * does not offer (rename, delete, remove/reorder tracks, move, remove from
 * library, unfavourite). They exist only on Apple's web-player API, so they
 * need web mode, and they carry that API's risk: it is undocumented and Apple
 * may change or block it without notice.
 *
 * Destructive ones (delete, remove tracks, reorder/replace, remove from
 * library) go through the confirm gate, with the preview and revision built
 * from a FRESH read on every call, so a token issued before the playlist
 * changed is refused rather than applied to a version nobody approved.
 */

const WEB_ONLY = "Uses Apple's web-player API (unofficial; needs APPLE_MUSIC_WEB_USER_TOKEN).";
const EDITABLE_TRACK_TYPES = new Set(['library-songs', 'library-music-videos']);
const PREVIEW_ROWS = 10;

function assertEditableTypes(tracks: AppleResource[]): void {
  const odd = tracks.find((t) => !EDITABLE_TRACK_TYPES.has(t.type));
  if (odd) {
    throw new AppleToolError('UNSUPPORTED', `This playlist holds a track of type "${odd.type}" (${odd.id}), which this tool does not know how to rewrite.`, {
      hint: 'Make this change in the Music app.',
    });
  }
}

function sameOrder(a: AppleResource[], b: AppleResource[]): boolean {
  return a.length === b.length && a.every((t, i) => t.id === b[i]!.id);
}

function labels(tracks: AppleResource[]): Record<string, unknown>[] {
  return tracks.slice(0, PREVIEW_ROWS).map((t, i) => trackLabel(t, i + 1));
}

// ---------------------------------------------------------------------------
// Reorder computations (pure; exported for tests)
// ---------------------------------------------------------------------------

export const SORT_KEYS = ['name', 'artistName', 'albumName', 'releaseDate', 'duration', 'dateAdded'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

function sortValue(t: AppleResource, by: SortKey): string | number | undefined {
  const a = attrs(t);
  if (by === 'duration') return num(a.durationInMillis);
  if (by === 'name') return resourceName(t);
  return str(a[by]);
}

/** Stable sort; tracks missing the key go last in either direction. */
export function sortTracks(tracks: AppleResource[], by: SortKey, descending: boolean): AppleResource[] {
  const dir = descending ? -1 : 1;
  return [...tracks].sort((x, y) => {
    const a = sortValue(x, by);
    const b = sortValue(y, by);
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
    const cmp = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'en', { sensitivity: 'base', numeric: true });
    return cmp * dir;
  });
}

/** Move `count` tracks starting at `from` so the first of them lands at `to` (all 1-based). */
export function moveTracks(tracks: AppleResource[], from: number, to: number, count: number): AppleResource[] {
  const n = tracks.length;
  if (from + count - 1 > n) {
    throw new InvalidArgumentError(`fromPosition ${from} with count ${count} runs past the end (the playlist has ${n} tracks).`);
  }
  if (to > n - count + 1) {
    throw new InvalidArgumentError(`toPosition ${to} is out of range: with ${count} track(s) moved, the last valid position is ${n - count + 1}.`);
  }
  const block = tracks.slice(from - 1, from - 1 + count);
  const rest = [...tracks.slice(0, from - 1), ...tracks.slice(from - 1 + count)];
  rest.splice(to - 1, 0, ...block);
  return rest;
}

/** Keep the first occurrence of each song (by catalog id, else library id). */
export function dedupeTracks(tracks: AppleResource[]): AppleResource[] {
  const seen = new Set<string>();
  return tracks.filter((t) => {
    const k = trackKey(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Build the new list from library ids; each id may be used as often as it currently appears. */
export function replaceTracks(tracks: AppleResource[], ids: string[]): AppleResource[] {
  const pool = new Map<string, AppleResource[]>();
  for (const t of tracks) pool.set(t.id, [...(pool.get(t.id) ?? []), t]);
  const out: AppleResource[] = [];
  const unknown: string[] = [];
  const excess: string[] = [];
  for (const id of ids) {
    const left = pool.get(id);
    if (!left) unknown.push(id);
    else if (left.length === 0) excess.push(id);
    else out.push(left.shift()!);
  }
  if (unknown.length > 0) {
    throw new InvalidArgumentError(`trackIds not in this playlist: ${uniq(unknown).join(', ')}.`, 'replace can reorder and drop tracks, not add new ones — use apple_music_add_playlist_tracks for that. Take ids from apple_music_get_playlist.');
  }
  if (excess.length > 0) {
    throw new InvalidArgumentError(`trackIds repeat ${uniq(excess).join(', ')} more times than the playlist holds it.`);
  }
  return out;
}

// ---------------------------------------------------------------------------

export function registerExtendedTools(server: McpServer, client: () => MusicClient): void {
  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_update_playlist',
    service: 'music',
    access: 'all',
    title: 'Rename an Apple Music playlist or change its description',
    description:
      'Rename one of your Apple Music library playlists, change its description, or make it public/private. Returns the ' +
      `previous values and verifies the change. ${WEB_ONLY}`,
    inputSchema: z.strictObject({
      playlistId: z.string().min(1).max(140).describe('Library playlist id (p.…) from apple_music_list_playlists.'),
      name: z.string().trim().min(1).max(200).optional().describe('New name.'),
      description: z.string().max(1000).optional().describe('New description ("" clears it).'),
      isPublic: z.boolean().optional().describe('Show it on your Apple Music profile (true) or not (false).'),
    }),
    annotations: ANNOTATIONS.update,
    handler: async (args) => {
      assertLibraryPlaylistId(args.playlistId, 'playlistId');
      if (args.name === undefined && args.description === undefined && args.isPublic === undefined) {
        throw new InvalidArgumentError('Give at least one of name, description or isPublic.');
      }
      const s = client().session('extended', 'rename a playlist or change its description or visibility');
      const pl = await readLibraryPlaylist(s, args.playlistId);
      const name = nameOf(pl, args.playlistId);
      refuseReadOnly(pl, name);
      const previous = playlistFields(pl);
      const changes = compactObject({
        name: args.name !== undefined && args.name !== previous.name ? args.name : undefined,
        description: args.description !== undefined && args.description !== (previous.description ?? '') ? args.description : undefined,
        isPublic: args.isPublic !== undefined && args.isPublic !== previous.isPublic ? args.isPublic : undefined,
      });
      if (Object.keys(changes).length === 0) {
        return jsonResponse({ ...head(s, { playlistId: args.playlistId, playlist: name }), changed: false, previous, ...notesField([...s.notes, 'Nothing to change: the playlist already has these values.']) });
      }
      // Apple's web player always PATCHes the complete set {name, description, isPublic} (and adds with=shared
      // whenever the result is public). Whether a partial body leaves the omitted fields alone is undocumented —
      // it could clear a description or make a public playlist private — so send the merged set it sends.
      const attributes = compactObject({ ...previous, ...changes });
      await s.request({
        method: 'PATCH',
        path: playlistPath(args.playlistId),
        ...(attributes.isPublic === true ? { query: { with: 'shared' } } : {}),
        json: { attributes },
      });
      const warnings: string[] = [];
      let current: Record<string, unknown> | undefined;
      try {
        const now: Record<string, unknown> = playlistFields(await readLibraryPlaylist(s, args.playlistId));
        current = now;
        for (const [k, v] of Object.entries(changes)) {
          // A cleared description may come back as "" or be dropped entirely; both mean cleared.
          if ((now[k] ?? (k === 'description' ? '' : undefined)) !== v) {
            warnings.push(`${k} still reads ${JSON.stringify(now[k] ?? null)} — Apple may not show the change yet.`);
          }
        }
      } catch (err) {
        warnings.push(`Changed, but could not re-read the playlist to verify: ${errorMessage(err)}`);
      }
      return jsonResponse({
        ...head(s, { playlistId: args.playlistId, playlist: name }),
        changed: true,
        previous,
        requested: changes,
        ...(current ? { current } : {}),
        verified: current !== undefined && warnings.length === 0,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...notesField(s.notes),
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_remove_playlist_tracks',
    service: 'music',
    access: 'all',
    title: 'Remove tracks from an Apple Music playlist',
    description:
      'Remove tracks from one of your library playlists by library track id and/or 1-based position (from ' +
      'apple_music_get_playlist). Apple removes EVERY copy of a track, so removing one copy of a duplicate is refused ' +
      `(use apple_music_reorder_playlist). ${WEB_ONLY} ${CONFIRM_NOTE}`,
    inputSchema: z.strictObject({
      playlistId: z.string().min(1).max(140).describe('Library playlist id (p.…).'),
      trackIds: z.array(z.string().min(1).max(140)).min(1).max(500).optional().describe('Library ids of the tracks to remove (every copy of each).'),
      positions: z.array(z.number().int().min(1)).min(1).max(500).optional().describe('1-based positions of tracks to remove (as listed by apple_music_get_playlist).'),
      confirmToken: confirmTokenParam,
    }),
    annotations: ANNOTATIONS.remove,
    handler: async (args, ctx) => {
      assertLibraryPlaylistId(args.playlistId, 'playlistId');
      if (!args.trackIds && !args.positions) throw new InvalidArgumentError('Give trackIds and/or positions.');
      const trackIds = args.trackIds ? uniq(args.trackIds) : [];
      trackIds.forEach((id, i) => assertLibraryId(id, `trackIds[${i}]`));
      const s = client().session('extended', 'remove tracks from a playlist');
      const pl = await readLibraryPlaylist(s, args.playlistId);
      const name = nameOf(pl, args.playlistId);
      refuseReadOnly(pl, name);
      const read = await readAllLibraryTracks(s, args.playlistId);
      requireCompleteRead(read, 'remove tracks');
      const tracks = read.tracks;
      const n = tracks.length;
      const occurrences = new Map<string, number[]>();
      tracks.forEach((t, i) => occurrences.set(t.id, [...(occurrences.get(t.id) ?? []), i + 1]));

      const targets = new Set<string>();
      const notInPlaylist = trackIds.filter((id) => !occurrences.has(id));
      for (const id of trackIds) if (occurrences.has(id)) targets.add(id);
      const byPosition = new Map<string, Set<number>>();
      for (const pos of uniq(args.positions ?? [])) {
        if (pos > n) throw new InvalidArgumentError(`position ${pos} is past the end: "${name}" has ${n} track(s).`, 'Positions are 1-based, as listed by apple_music_get_playlist.');
        const id = tracks[pos - 1]!.id;
        byPosition.set(id, (byPosition.get(id) ?? new Set()).add(pos));
      }
      for (const [id, chosen] of byPosition) {
        const all = occurrences.get(id)!;
        if (chosen.size < all.length && !targets.has(id)) {
          throw new InvalidArgumentError(
            `"${nameOf(tracks[all[0]! - 1]!, id)}" appears ${all.length} times (positions ${all.join(', ')}), and Apple can only remove every copy of a track at once — removing just position ${[...chosen].join(', ')} is not possible here.`,
            'Use apple_music_reorder_playlist with operation "replace" (the full list without that copy) or "dedupe".',
          );
        }
        targets.add(id);
      }
      if (targets.size === 0) {
        throw new InvalidArgumentError(`None of these trackIds are in "${name}": ${notInPlaylist.join(', ')}.`, 'Use the library track ids listed by apple_music_get_playlist.');
      }
      const removing = tracks.filter((t) => targets.has(t.id));
      assertEditableTypes(removing);
      // Apple's web player (requestRemoveFromPlaylist) names every playlist item — music videos included — as
      // ids[library-songs]; there is no evidence of an ids[library-music-videos] form, so none is invented here.
      const ids = { 'ids[library-songs]': [...targets] };
      const preview = {
        playlist: name,
        playlistId: args.playlistId,
        removing: [...targets].map((id) => {
          const t = removing.find((x) => x.id === id)!;
          const label = trackLabel(t, occurrences.get(id)![0]!);
          const positions = occurrences.get(id)!;
          return { name: label.name, ...(label.artistName ? { artistName: label.artistName } : {}), positions, ...(positions.length > 1 ? { copies: positions.length } : {}) };
        }),
        tracksBefore: n,
        tracksAfter: n - removing.length,
        ...(notInPlaylist.length > 0 ? { notInPlaylist } : {}),
      };
      const gate = await confirmWrite(ctx, {
        tool: 'apple_music_remove_playlist_tracks',
        action: 'apple.music.playlist.tracks.remove',
        message: `Remove ${removing.length} track(s) from the playlist "${name}"?`,
        target: `playlist:${args.playlistId}`,
        revision: stateRevision(tracks.map((t) => t.id)),
        payload: { playlistId: args.playlistId, ids, mode: 'all' },
        preview,
        args,
        confirmToken: args.confirmToken,
      });
      if (gate) return gate;
      await s.request({ method: 'DELETE', path: `${playlistPath(args.playlistId)}/tracks`, query: { ...ids, mode: 'all' } });
      const warnings: string[] = [];
      let tracksAfter: number | undefined;
      try {
        const after = await readAllLibraryTracks(s, args.playlistId);
        tracksAfter = after.tracks.length;
        const left = after.tracks.filter((t) => targets.has(t.id)).length;
        if (left > 0 || tracksAfter !== n - removing.length) {
          warnings.push(`The playlist still shows ${tracksAfter} track(s)${left > 0 ? `, ${left} of them ones being removed` : ''} — Apple may not show the change yet; re-read it shortly.`);
        }
      } catch (err) {
        warnings.push(`Removed, but could not re-read the playlist to verify: ${errorMessage(err)}`);
      }
      return jsonResponse({
        ...head(s, { playlistId: args.playlistId, playlist: name }),
        removed: removing.length,
        tracksBefore: n,
        ...(tracksAfter !== undefined ? { tracksAfter } : {}),
        verified: tracksAfter !== undefined && warnings.length === 0,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(notInPlaylist.length > 0 ? { notInPlaylist } : {}),
        ...notesField(s.notes),
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_reorder_playlist',
    service: 'music',
    access: 'all',
    title: 'Reorder, sort, dedupe or rewrite an Apple Music playlist',
    description:
      'Reorder one of your library playlists: move tracks, sort (name, artist, album, release date, duration, date ' +
      'added), reverse, dedupe (keep the first copy of each song), or replace with a complete new order of its track ids ' +
      `(can drop tracks). ${WEB_ONLY} ${CONFIRM_NOTE}`,
    inputSchema: z.strictObject({
      playlistId: z.string().min(1).max(140).describe('Library playlist id (p.…).'),
      operation: z.enum(['move', 'sort', 'reverse', 'dedupe', 'replace']).describe('What to do.'),
      fromPosition: z.number().int().min(1).optional().describe('move: 1-based position of the first track to move.'),
      toPosition: z.number().int().min(1).optional().describe('move: 1-based position the first moved track should end up at.'),
      count: z.number().int().min(1).max(MAX_TRACKS_READ).optional().describe('move: how many consecutive tracks to move (default 1).'),
      by: z.enum(SORT_KEYS).optional().describe('sort: the key (dateAdded is when the song entered your library; Apple often omits it on playlist tracks, and a key no track has is refused).'),
      descending: z.boolean().optional().describe('sort: largest/latest/Z first (default false).'),
      trackIds: z.array(z.string().min(1).max(140)).min(1).max(MAX_TRACKS_READ).optional().describe('replace: the complete new order as library track ids from apple_music_get_playlist; ids left out are removed.'),
      confirmToken: confirmTokenParam,
    }),
    annotations: ANNOTATIONS.update,
    handler: async (args, ctx) => {
      assertLibraryPlaylistId(args.playlistId, 'playlistId');
      const allowed: Record<typeof args.operation, string[]> = {
        move: ['fromPosition', 'toPosition', 'count'],
        sort: ['by', 'descending'],
        reverse: [],
        dedupe: [],
        replace: ['trackIds'],
      };
      const extra = (['fromPosition', 'toPosition', 'count', 'by', 'descending', 'trackIds'] as const).filter(
        (k) => args[k] !== undefined && !allowed[args.operation].includes(k),
      );
      if (extra.length > 0) throw new InvalidArgumentError(`${extra.join(', ')} ${extra.length === 1 ? 'does' : 'do'} not apply to operation "${args.operation}".`);
      if (args.operation === 'move' && (args.fromPosition === undefined || args.toPosition === undefined)) {
        throw new InvalidArgumentError('move needs fromPosition and toPosition.');
      }
      if (args.operation === 'sort' && args.by === undefined) throw new InvalidArgumentError('sort needs by.');
      if (args.operation === 'replace' && args.trackIds === undefined) throw new InvalidArgumentError('replace needs trackIds.');
      args.trackIds?.forEach((id, i) => assertLibraryId(id, `trackIds[${i}]`));

      const s = client().session('extended', 'reorder a playlist');
      const pl = await readLibraryPlaylist(s, args.playlistId);
      const name = nameOf(pl, args.playlistId);
      refuseReadOnly(pl, name);
      const read = await readAllLibraryTracks(s, args.playlistId);
      requireCompleteRead(read, 'rewrite its order');
      const current = read.tracks;
      let next: AppleResource[];
      let summary: string;
      let sortNote: string | undefined;
      switch (args.operation) {
        case 'move': {
          const count = args.count ?? 1;
          next = moveTracks(current, args.fromPosition!, args.toPosition!, count);
          summary = `move ${count} track(s) from position ${args.fromPosition} to ${args.toPosition}`;
          break;
        }
        case 'sort': {
          const by = args.by!;
          const missing = current.filter((t) => sortValue(t, by) === undefined).length;
          // A key no track carries would leave the order untouched and read as "already sorted" — a false claim.
          if (current.length > 0 && missing === current.length) {
            throw new AppleToolError('UNSUPPORTED', `Apple reports no ${by} for any track in "${name}", so they cannot be sorted by it.`, {
              hint: `Sort by one of ${SORT_KEYS.filter((k) => k !== by).join(', ')} instead.`,
            });
          }
          next = sortTracks(current, by, args.descending ?? false);
          summary = `sort by ${by}${args.descending ? ' (descending)' : ''}`;
          if (missing > 0) sortNote = `${missing} track(s) have no ${by} and go last, in their current order.`;
          break;
        }
        case 'reverse':
          next = [...current].reverse();
          summary = 'reverse the order';
          break;
        case 'dedupe':
          next = dedupeTracks(current);
          summary = 'remove duplicate songs, keeping the first copy';
          break;
        case 'replace':
          next = replaceTracks(current, args.trackIds!);
          summary = 'replace the track list with the given order';
          break;
      }
      if (sameOrder(current, next)) {
        return jsonResponse({
          ...head(s, { playlistId: args.playlistId, playlist: name, operation: args.operation }),
          changed: false,
          tracks: current.length,
          ...notesField([...s.notes, `Nothing to change: the playlist is already in that order${args.operation === 'dedupe' ? ' with no duplicates' : ''}.`, sortNote]),
        });
      }
      assertEditableTypes(current);
      const removed = current.length - next.length;
      const payload = { data: next.map((t) => ({ id: t.id, type: t.type })) };
      const preview = {
        playlist: name,
        playlistId: args.playlistId,
        change: summary,
        tracksBefore: current.length,
        tracksAfter: next.length,
        ...(removed > 0 ? { removed } : {}),
        ...(sortNote ? { note: sortNote } : {}),
        firstBefore: labels(current),
        firstAfter: labels(next),
      };
      const gate = await confirmWrite(ctx, {
        tool: 'apple_music_reorder_playlist',
        action: 'apple.music.playlist.tracks.replace',
        message: `Rewrite the order of "${name}" (${summary})${removed > 0 ? `, removing ${removed} track(s)` : ''}?`,
        target: `playlist:${args.playlistId}`,
        revision: stateRevision(current.map((t) => t.id)),
        payload: { playlistId: args.playlistId, ...payload },
        preview,
        args,
        confirmToken: args.confirmToken,
      });
      if (gate) return gate;
      await s.request({ method: 'PUT', path: `${playlistPath(args.playlistId)}/tracks`, json: payload });
      const warnings: string[] = [];
      let verified = false;
      try {
        const after = await readAllLibraryTracks(s, args.playlistId);
        verified = sameOrder(after.tracks, next);
        if (!verified) warnings.push('The playlist does not show the new order yet — Apple can lag; re-read it shortly before changing it again.');
      } catch (err) {
        warnings.push(`Changed, but could not re-read the playlist to verify: ${errorMessage(err)}`);
      }
      return jsonResponse({
        ...head(s, { playlistId: args.playlistId, playlist: name, operation: args.operation }),
        changed: true,
        tracksBefore: current.length,
        tracksAfter: next.length,
        ...(removed > 0 ? { removed } : {}),
        verified,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...notesField([...s.notes, sortNote]),
        firstAfter: labels(next),
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_move_playlist',
    service: 'music',
    access: 'all',
    title: 'Move an Apple Music playlist into a folder',
    description:
      'Move one of your library playlists into a playlist folder, or back to the top level ("root"). Checks the folder ' +
      `exists and verifies the playlist appears in it. ${WEB_ONLY}`,
    inputSchema: z.strictObject({
      playlistId: z.string().min(1).max(140).describe('Library playlist id (p.…).'),
      folderId: z.string().min(1).max(140).describe('Destination folder id (p.… from apple_music_list_folders), or "root" for the top level.'),
    }),
    annotations: ANNOTATIONS.toggle,
    handler: async (args) => {
      assertLibraryPlaylistId(args.playlistId, 'playlistId');
      const folderId = folderIdArg(args.folderId);
      assertLibraryPlaylistId(folderId, 'folderId');
      if (folderId === args.playlistId) throw new InvalidArgumentError('A playlist cannot be moved into itself.');
      const s = client().session('extended', 'move a playlist into a folder');
      const pl = await readLibraryPlaylist(s, args.playlistId);
      const name = nameOf(pl, args.playlistId);
      const folderName = folderId === ROOT_FOLDER_ID ? 'the top level' : nameOf(await readFolder(s, folderId), folderId);
      const before = await readFolderChildren(s, folderId);
      if (before.items.some((c) => c.id === args.playlistId)) {
        return jsonResponse({ ...head(s, { playlistId: args.playlistId, playlist: name, folderId, folder: folderName }), changed: false, ...notesField([...s.notes, `"${name}" is already in ${folderName}.`]) });
      }
      await s.request({
        method: 'PUT',
        path: `${playlistPath(args.playlistId)}/parent`,
        json: { data: [{ id: folderId, type: 'library-playlist-folders' }] },
      });
      const warnings: string[] = [];
      let verified = false;
      try {
        const after = await readFolderChildren(s, folderId);
        verified = after.items.some((c) => c.id === args.playlistId);
        if (!verified) warnings.push(`"${name}" does not show in ${folderName} yet — Apple can lag; re-read it shortly.`);
      } catch (err) {
        warnings.push(`Moved, but could not re-read the folder to verify: ${errorMessage(err)}`);
      }
      return jsonResponse({
        ...head(s, { playlistId: args.playlistId, playlist: name, folderId, folder: folderName }),
        changed: true,
        verified,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...notesField(s.notes),
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_delete_playlist',
    service: 'music',
    access: 'all',
    title: 'Delete an Apple Music playlist',
    description:
      'Delete one of your library playlists (songs stay in your library). For an Apple playlist saved to your library, this ' +
      `removes it from your library. The preview shows its name, track count and date added; verifies it is gone. ${WEB_ONLY} ${CONFIRM_NOTE}`,
    inputSchema: z.strictObject({
      playlistId: z.string().min(1).max(140).describe('Library playlist id (p.…).'),
      confirmToken: confirmTokenParam,
    }),
    annotations: ANNOTATIONS.remove,
    handler: async (args, ctx) => {
      assertLibraryPlaylistId(args.playlistId, 'playlistId');
      if (args.playlistId === ROOT_FOLDER_ID) throw new InvalidArgumentError('p.playlistsroot is the root folder, not a playlist.');
      const s = client().session('extended', 'delete a playlist');
      const pl = await readLibraryPlaylist(s, args.playlistId);
      const name = nameOf(pl, args.playlistId);
      const read = await readAllLibraryTracks(s, args.playlistId);
      const a = attrs(pl);
      const preview: Record<string, unknown> = {
        playlist: name,
        playlistId: args.playlistId,
        tracks: read.complete ? read.tracks.length : `${MAX_TRACKS_READ}+`,
      };
      putDate(preview, 'dateAdded', a.dateAdded, getDisplayTimeZone());
      const description = playlistFields(pl).description;
      if (description) preview.description = description;
      if (a.hasCatalog === true) preview.note = "This is a playlist saved from Apple Music's catalog; deleting removes it from your library only.";
      const gate = await confirmWrite(ctx, {
        tool: 'apple_music_delete_playlist',
        action: 'apple.music.playlist.delete',
        message: `Delete the playlist "${name}" (${String(preview.tracks)} tracks)? This cannot be undone.`,
        target: `playlist:${args.playlistId}`,
        revision: stateRevision({ name, description: description ?? null, tracks: read.tracks.map((t) => t.id) }),
        payload: { playlistId: args.playlistId },
        preview,
        args,
        confirmToken: args.confirmToken,
      });
      if (gate) return gate;
      await s.request({ method: 'DELETE', path: playlistPath(args.playlistId) });
      const warnings: string[] = [];
      let verified = false;
      try {
        verified = (await playlistExists(s, args.playlistId)) === undefined;
        if (!verified) warnings.push(`"${name}" still shows in your library — Apple can lag; re-read it shortly.`);
      } catch (err) {
        warnings.push(`Deleted, but could not re-read to verify: ${errorMessage(err)}`);
      }
      return jsonResponse({
        ...head(s, { playlistId: args.playlistId, playlist: name }),
        deleted: true,
        verified,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...notesField(s.notes),
      });
    },
  });

  // -------------------------------------------------------------------------
  const REMOVABLE = ['songs', 'albums', 'music-videos', 'playlists'] as const satisfies readonly (typeof LIBRARY_TYPES)[number][];
  defineTool(server, {
    name: 'apple_music_remove_from_library',
    service: 'music',
    access: 'all',
    title: 'Remove songs, albums or playlists from your Apple Music library',
    description:
      'Remove songs, albums, music videos or playlists from your Apple Music library by LIBRARY id (i.…, l.…, p.… from ' +
      'apple_music_list_library / apple_music_search_library), up to 50 at a time; the preview names each item. ' +
      `${WEB_ONLY} ${CONFIRM_NOTE}`,
    inputSchema: z.strictObject({
      type: z.enum(REMOVABLE).describe('What the ids are.'),
      ids: z.array(z.string().min(1).max(140)).min(1).max(50).describe('Library ids (up to 50).'),
      confirmToken: confirmTokenParam,
    }),
    annotations: ANNOTATIONS.remove,
    handler: async (args, ctx) => {
      const ids = uniq(args.ids);
      ids.forEach((id, i) => (args.type === 'playlists' ? assertLibraryPlaylistId(id, `ids[${i}]`) : assertLibraryId(id, `ids[${i}]`)));
      const s = client().session('extended', 'remove items from your library');
      const found = await readLibraryItems(s, args.type, ids);
      const notInLibrary = ids.filter((id) => !found.some((f) => f.id === id));
      if (found.length === 0) {
        throw new UpstreamError('music', 404, `music (${s.backend.name}): none of these ${args.type} ids are in your library: ${ids.join(', ')}.`, {
          hint: 'Use library ids from apple_music_list_library or apple_music_search_library (catalog ids are different).',
        });
      }
      const removing = found.map((f) => {
        const a = attrs(f);
        return { id: f.id, name: nameOf(f), ...(str(a.artistName) ? { artistName: a.artistName } : {}) };
      });
      const gate = await confirmWrite(ctx, {
        tool: 'apple_music_remove_from_library',
        action: 'apple.music.library.remove',
        message: `Remove ${removing.length} ${args.type} from your Apple Music library?`,
        target: `library:${args.type}:${found.map((f) => f.id).join(',')}`,
        revision: stateRevision(removing),
        payload: { type: args.type, ids: found.map((f) => f.id) },
        preview: { type: args.type, count: removing.length, removing, ...(notInLibrary.length > 0 ? { notInLibrary } : {}) },
        args,
        confirmToken: args.confirmToken,
      });
      if (gate) return gate;
      const removed: string[] = [];
      let failure: { id: string; message: string; unconfirmed: boolean } | undefined;
      for (const f of found) {
        try {
          await s.request({ method: 'DELETE', path: `/v1/me/library/${args.type}/${f.id}` });
          removed.push(f.id);
        } catch (err) {
          if (removed.length === 0 && !(err instanceof UnconfirmedWriteError)) throw err;
          failure = { id: f.id, message: errorMessage(err), unconfirmed: err instanceof UnconfirmedWriteError };
          break;
        }
      }
      const warnings: string[] = [];
      if (failure) {
        warnings.push(
          failure.unconfirmed
            ? `${failure.id} MAY have been removed (Apple's answer was lost: ${failure.message}).`
            : `${failure.id} was not removed: ${failure.message}`,
        );
        const rest = found.length - removed.length - 1;
        if (rest > 0) warnings.push(`${rest} item(s) after it were not attempted.`);
      }
      let verified = false;
      if (removed.length > 0) {
        try {
          const still = await readLibraryItems(s, args.type, removed);
          verified = still.length === 0 && !failure;
          if (still.length > 0) warnings.push(`Still listed: ${still.map((x) => x.id).join(', ')} — Apple can lag; re-check shortly.`);
        } catch (err) {
          warnings.push(`Removed, but could not re-read to verify: ${errorMessage(err)}`);
        }
      }
      return jsonResponse({
        ...head(s, { type: args.type }),
        removed: removed.length,
        requested: ids.length,
        ...(failure ? { partial: true } : {}),
        verified,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(notInLibrary.length > 0 ? { notInLibrary } : {}),
        ...notesField(s.notes),
        removedIds: removed,
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_remove_favorites',
    service: 'music',
    access: 'all',
    title: 'Unfavorite songs, albums, playlists or artists in Apple Music',
    description:
      'Remove the favorite (star) from catalog songs, albums, playlists, artists or music videos, by catalog id, up to 100 ' +
      `per type. Apple answers only "accepted" and offers no way to read favorites back. ${WEB_ONLY}`,
    inputSchema: z.strictObject(typedIdsSchema(FAVORITE_FIELDS)),
    annotations: ANNOTATIONS.toggle,
    handler: async (args) => {
      const { query, counts } = typedIdsQuery(args as Partial<Record<TypedIdField, string[]>>, FAVORITE_FIELDS);
      const s = client().session('extended', 'remove favorites');
      const res = await s.request({ method: 'DELETE', path: '/v1/me/favorites', query });
      return jsonResponse({
        ...head(s),
        accepted: true,
        status: res.status,
        requested: counts,
        verified: false,
        ...notesField([...s.notes, 'Apple reports nothing per item and offers no way to read favorites back.']),
      });
    },
  });
}

async function readLibraryItems(s: MusicSession, type: string, ids: string[]): Promise<AppleResource[]> {
  const path = `/v1/me/library/${type}`;
  const res = await s.request<AppleDoc>({ path, query: { ids }, okStatuses: [404] });
  return res.status === 404 ? [] : requireData(res.data, `GET ${path}`);
}
