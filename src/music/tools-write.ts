import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { accessAllowed, getDisplayTimeZone } from '../config.js';
import { AppleToolError, InvalidArgumentError, UnconfirmedWriteError, errorMessage } from '../errors.js';
import { ANNOTATIONS, compactObject, defineTool, jsonResponse } from '../tools/_shared.js';
import { requireData, type AppleDoc, type MusicClient, type MusicSession } from './client.js';
import { head, notesField, uniq } from './common.js';
import {
  ROOT_FOLDER_ID,
  TRACK_TYPES,
  assertCatalogId,
  assertLibraryPlaylistId,
  resolveTrackRef,
  type CatalogType,
  type TrackRef,
} from './ids.js';
import {
  MAX_TRACKS_READ,
  TRACK_WRITE_BATCH,
  appendTracks,
  appendWarnings,
  folderIdArg,
  playlistExists,
  playlistStateRefusal,
  readAllLibraryTracks,
  readFolder,
  readLibraryPlaylist,
  readLibraryTracks,
  refuseReadOnly,
} from './playlists.js';
import { attrs, catalogIdOf, compactResource, firstDataId, nameOf, type AppleResource } from './project.js';
import { RATING_TYPES, assertRatingId, ratingWord, type RatingType } from './tools-library.js';
import { unshownAppends } from './write-log.js';

/**
 * Additive library writes (create, append, add, favourite) plus ratings.
 * Every write re-reads to verify where Apple offers a read, and reports
 * "not yet visible" rather than "failed" when the read lags the write —
 * Apple documents a delay before new library items appear.
 */

export const trackRefSchema = z
  .union([
    z.string().min(1).max(140),
    z.strictObject({
      id: z.string().min(1).max(140).describe('The id.'),
      type: z.enum(TRACK_TYPES).describe('songs / music-videos (catalog ids) or library-songs / library-music-videos (library ids).'),
    }),
  ])
  .describe('A catalog song id (numeric), a library song id (i.…), or {id, type} (needed for music videos).');

/** Typed catalog-id arguments for add_to_library / favorites. */
export const TYPED_ID_FIELDS = {
  songs: 'songs',
  albums: 'albums',
  playlists: 'playlists',
  artists: 'artists',
  musicVideos: 'music-videos',
} as const satisfies Record<string, CatalogType>;
export type TypedIdField = keyof typeof TYPED_ID_FIELDS;

/** What add/remove favorites accept. */
export const FAVORITE_FIELDS: readonly TypedIdField[] = ['songs', 'albums', 'playlists', 'artists', 'musicVideos'];

export function typedIdsSchema(fields: readonly TypedIdField[]) {
  const shape: Record<string, z.ZodOptional<z.ZodArray<z.ZodString>>> = {};
  for (const f of fields) {
    shape[f] = z
      .array(z.string().min(1).max(140))
      .min(1)
      .max(100)
      .optional()
      .describe(`Catalog ${TYPED_ID_FIELDS[f]} ids (up to 100)${f === 'playlists' ? ' — pl.…' : ' — numeric'}.`);
  }
  return shape;
}

/** Validate typed ids and build Apple's `ids[<type>]=…` query. */
export function typedIdsQuery(args: Partial<Record<TypedIdField, string[]>>, fields: readonly TypedIdField[]): { query: Record<string, string[]>; counts: Record<string, number> } {
  const query: Record<string, string[]> = {};
  const counts: Record<string, number> = {};
  for (const f of fields) {
    const list = args[f];
    if (!list) continue;
    const ids = uniq(list);
    const type = TYPED_ID_FIELDS[f];
    ids.forEach((id, i) => assertCatalogId(type, id, `${f}[${i}]`));
    query[`ids[${type}]`] = ids;
    counts[type] = ids.length;
  }
  if (Object.keys(query).length === 0) throw new InvalidArgumentError(`Give at least one of ${fields.join(', ')}.`);
  return { query, counts };
}


/** Re-read the tracks after an append; undefined when the read stopped at the cap. */
async function verifyTracks(s: MusicSession, playlistId: string, expected: number, warnings: string[]): Promise<AppleResource[] | undefined> {
  const after = await readLibraryTracks(s, playlistId, 0, MAX_TRACKS_READ);
  const count = after.tracks.length;
  if (!after.complete) {
    // The read stopped at the cap: a short count here is the cap, not Apple lagging behind the write.
    warnings.push(`Not verified: the playlist now has more than ${MAX_TRACKS_READ} tracks, more than this tool reads back.`);
    return undefined;
  }
  if (count < expected) {
    warnings.push(`The playlist shows ${count} track(s) so far, ${expected} expected — Apple can take a while to show new tracks; re-read it later.`);
  }
  return after.tracks;
}

export function registerLibraryWriteTools(server: McpServer, client: () => MusicClient): void {
  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_create_playlist',
    service: 'music',
    access: 'additive',
    title: 'Create an Apple Music playlist',
    description:
      'Create a new playlist in your Apple Music library, optionally with tracks (up to 500 catalog or library song ids; ' +
      'added 100 at a time), a description, a folder and public visibility (not in APPLE_WRITE_MODE=additive). Returns ' +
      'the new playlist id (p.…) and checks it by re-reading (Apple can take a few seconds to show it). Needs ' +
      'APPLE_MUSIC_USER_TOKEN or web-player mode.',
    inputSchema: z.strictObject({
      name: z.string().trim().min(1).max(200).describe('Playlist name.'),
      description: z.string().max(1000).optional().describe('Playlist description.'),
      tracks: z.array(trackRefSchema).min(1).max(500).optional().describe('Songs to put in it, in order (up to 500).'),
      folderId: z.string().min(1).max(140).optional().describe('Create it inside this folder (p.… from apple_music_list_folders; default the top level).'),
      isPublic: z.boolean().optional().describe('Show it on your Apple Music profile (default false; needs APPLE_WRITE_MODE=all).'),
    }),
    annotations: ANNOTATIONS.additive,
    handler: async (args) => {
      // Read at call time, like the mode itself. A public playlist is shown to other people, which additive mode
      // (only adds to your own account; nothing reaches anyone else) never allows — as calendar create refuses attendees.
      if (args.isPublic === true && !accessAllowed('all')) {
        throw new AppleToolError(
          'UNSUPPORTED',
          'A public playlist shows on your Apple Music profile to other people, which APPLE_WRITE_MODE=additive never allows. Nothing was created.',
          { hint: 'Create it private (leave out isPublic), or set APPLE_WRITE_MODE=all.' },
        );
      }
      const refs = (args.tracks ?? []).map((r, i) => resolveTrackRef(r, `tracks[${i}]`));
      const parent = args.folderId !== undefined ? folderIdArg(args.folderId) : undefined;
      if (parent !== undefined) assertLibraryPlaylistId(parent, 'folderId', 'folder');
      const s = client().session('library', 'create a playlist');
      if (parent !== undefined && parent !== ROOT_FOLDER_ID) await readFolder(s, parent);
      const first = refs.slice(0, TRACK_WRITE_BATCH);
      const rest = refs.slice(TRACK_WRITE_BATCH);
      const relationships = compactObject({
        tracks: first.length > 0 ? { data: first } : undefined,
        parent: parent !== undefined ? { data: [{ id: parent, type: 'library-playlist-folders' }] } : undefined,
      });
      const body = {
        attributes: compactObject({ name: args.name, description: args.description, isPublic: args.isPublic }),
        ...(Object.keys(relationships).length > 0 ? { relationships } : {}),
      };
      const sentAt = s.client.now();
      const res = await s.request({
        method: 'POST',
        path: '/v1/me/library/playlists',
        // Apple's own web player adds with=shared when creating a public playlist.
        ...(s.backend.name === 'web' && args.isPublic ? { query: { with: 'shared' } } : {}),
        json: body,
      });
      const id = firstDataId(res.data);
      if (!id) {
        throw new UnconfirmedWriteError(
          'music',
          `music (${s.backend.name}): Apple accepted the new playlist "${args.name}" (HTTP ${res.status}) but returned no id, so it cannot be verified${rest.length > 0 ? ` and tracks ${TRACK_WRITE_BATCH + 1}–${refs.length} were not added` : ''}.`,
        );
      }
      const warnings: string[] = [];
      let added = first.length;
      let mayHaveLanded = added;
      if (rest.length > 0) {
        const r = await appendTracks(s, id, rest, first.length);
        added += r.added;
        // As in add_tracks: a batch with an unknown outcome may have landed (`toTrack` counts in `refs`' numbering).
        mayHaveLanded = r.failure?.unconfirmed ? r.failure.toTrack : added;
        warnings.push(...appendWarnings(r));
      }
      // A reorder/remove must not rebuild the list from a read that shows only part of it yet (the first batch
      // without the appended ones): that PUT would drop the rest. So the log expects every track that landed, or may
      // have; and an update_playlist must not PATCH back a name/description/visibility a lagging read does not show yet.
      const what = `create playlist with ${mayHaveLanded} tracks${mayHaveLanded > added ? `, ${mayHaveLanded - added} unconfirmed` : ''}`;
      s.client.playlistWrites.recordAppend(id, { at: sentAt, what }, [], refs.slice(0, mayHaveLanded), s.client.now());
      s.client.playlistAttributes.record(id, { at: sentAt, what: 'create playlist' }, { name: args.name, description: args.description, isPublic: args.isPublic });
      let verified = false;
      let current: Record<string, unknown> | undefined;
      try {
        const seen = await playlistExists(s, id);
        if (!seen) {
          warnings.push('The new playlist is not visible yet (Apple can take a few seconds); it was created — re-read it shortly.');
        } else {
          current = compactResource(seen, getDisplayTimeZone());
          const count = refs.length > 0 ? (await verifyTracks(s, id, added, warnings))?.length : 0;
          verified = count === added && warnings.length === 0;
        }
      } catch (err) {
        warnings.push(`Created, but could not re-read it to verify: ${errorMessage(err)}`);
      }
      return jsonResponse({
        ...head(s),
        id,
        name: args.name,
        created: true,
        tracksRequested: refs.length,
        tracksAdded: added,
        ...(added < refs.length ? { partial: true } : {}),
        verified,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...notesField(s.notes),
        ...(current ? { playlist: current } : {}),
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_add_playlist_tracks',
    service: 'music',
    access: 'additive',
    title: 'Add tracks to an Apple Music playlist',
    description:
      'Append songs (up to 500 catalog or library ids) to the end of one of your library playlists. By default skips songs ' +
      'already in the playlist (matched by catalog id; refused while Apple does not show your last change to it yet). ' +
      'Refuses playlists you cannot edit (Apple-curated or collaborative). Verifies the new tracks show. Needs ' +
      'APPLE_MUSIC_USER_TOKEN or web-player mode.',
    inputSchema: z.strictObject({
      playlistId: z.string().min(1).max(140).describe('Library playlist id (p.…) from apple_music_list_playlists.'),
      tracks: z.array(trackRefSchema).min(1).max(500).describe('Songs to append, in order (up to 500).'),
      skipDuplicates: z.boolean().optional().describe('Skip songs already in the playlist or repeated in this request (default true).'),
    }),
    annotations: ANNOTATIONS.additive,
    handler: async (args) => {
      assertLibraryPlaylistId(args.playlistId, 'playlistId', 'edit');
      const refs = args.tracks.map((r, i) => resolveTrackRef(r, `tracks[${i}]`));
      const s = client().session('library', 'add tracks to a playlist');
      const pl = await readLibraryPlaylist(s, args.playlistId);
      const name = nameOf(pl, args.playlistId);
      refuseReadOnly(pl, name);
      const before = await readAllLibraryTracks(s, args.playlistId);
      const skipDuplicates = args.skipDuplicates ?? true;
      // A read that does not show this process's last change to the playlist yet (Apple's reads lag its writes)
      // cannot be trusted as the duplicate check's list — a retried add would append its tracks a second time —
      // nor as the baseline the new tracks are verified against.
      if (before.complete && skipDuplicates) {
        const stale = playlistStateRefusal(s.client, args.playlistId, name, before.tracks, undefined, 'checking for duplicates against this read could add a track twice');
        if (stale) return stale;
      }
      const lagging = before.complete && !skipDuplicates ? s.client.playlistWrites.pending(args.playlistId, before.tracks, s.client.now()) : undefined;
      const notes: string[] = [...before.notes];
      const toAdd: TrackRef[] = [];
      const skipped: Array<{ id: string; reason: string }> = [];
      if (skipDuplicates) {
        const catalogIds = new Set(before.tracks.map((t) => catalogIdOf(t)).filter((x): x is string => x !== undefined));
        const libraryIds = new Set(before.tracks.map((t) => t.id));
        const seen = new Set<string>();
        for (const ref of refs) {
          const present = ref.type.startsWith('library-') ? libraryIds.has(ref.id) : catalogIds.has(ref.id);
          if (present) skipped.push({ id: ref.id, reason: 'already in the playlist' });
          else if (seen.has(`${ref.type}:${ref.id}`)) skipped.push({ id: ref.id, reason: 'repeated in this request' });
          else {
            seen.add(`${ref.type}:${ref.id}`);
            toAdd.push(ref);
          }
        }
        if (!before.complete) notes.push(`The duplicate check covered the first ${MAX_TRACKS_READ} tracks only.`);
      } else {
        toAdd.push(...refs);
      }
      if (toAdd.length === 0) {
        return jsonResponse({
          ...head(s, { playlistId: args.playlistId, playlist: name }),
          added: 0,
          skippedCount: skipped.length,
          verified: true,
          ...notesField([...s.notes, ...notes, 'Nothing to add: every track is already in the playlist.']),
          skipped,
        });
      }
      const sentAt = s.client.now();
      const r = await appendTracks(s, args.playlistId, toAdd);
      if (r.added === 0 && r.failure && !r.failure.unconfirmed) throw r.failure.error;
      // Something landed (or may have — an unconfirmed batch counts): a reorder/remove must not rebuild the list from
      // a read that does not show it.
      const mayHaveLanded = r.failure?.unconfirmed ? r.failure.toTrack : r.added;
      if (before.complete) {
        s.client.playlistWrites.recordAppend(args.playlistId, { at: sentAt, what: 'add tracks' }, before.tracks, toAdd.slice(0, mayHaveLanded), s.client.now());
      }
      const warnings = appendWarnings(r);
      if (lagging) {
        warnings.push(
          `Apple was not showing your last change to "${name}" yet (${lagging.what}) when this read it, so the tracks were appended ` +
            '(skipDuplicates: false) to a list this call cannot verify against — re-read it shortly.',
        );
      }
      let verified = false;
      let tracksNow: number | undefined;
      if (before.complete) {
        try {
          const expected = before.tracks.length + r.added;
          const after = await verifyTracks(s, args.playlistId, expected, warnings);
          tracksNow = after?.length;
          // By presence, not only by count: under lag another write's track can make the count match.
          const unseen = after && tracksNow! >= expected ? unshownAppends(before.tracks, toAdd.slice(0, r.added), after) : [];
          if (unseen.length > 0) {
            warnings.push(`Not showing in the playlist yet: ${unseen.join(', ')} — Apple can take a while to show new tracks; re-read it later.`);
          }
          verified = tracksNow === expected && unseen.length === 0 && !r.failure && !lagging;
        } catch (err) {
          warnings.push(`Added, but could not re-read the playlist to verify: ${errorMessage(err)}`);
        }
      } else {
        notes.push(`Not verified: the playlist has more than ${MAX_TRACKS_READ} tracks.`);
      }
      return jsonResponse({
        ...head(s, { playlistId: args.playlistId, playlist: name }),
        added: r.added,
        requested: refs.length,
        skippedCount: skipped.length,
        ...(before.complete ? { tracksBefore: before.tracks.length } : {}),
        ...(tracksNow !== undefined ? { tracksNow } : {}),
        ...(r.failure ? { partial: true } : {}),
        verified,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...notesField([...s.notes, ...notes]),
        skipped,
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_create_folder',
    service: 'music',
    // No tool in this server removes a playlist folder (delete_playlist deletes playlists only), so a created
    // folder cannot be undone here: destructive by the inverse test, and so outside APPLE_WRITE_MODE=additive,
    // whose promise is that every write it registers is non-destructive.
    access: 'all',
    title: 'Create an Apple Music playlist folder',
    description:
      'Create a playlist folder in your Apple Music library, at the top level or inside another folder. Returns the new ' +
      'folder id (p.…) for apple_music_create_playlist / apple_music_move_playlist. Needs APPLE_MUSIC_USER_TOKEN or web-player mode.',
    inputSchema: z.strictObject({
      name: z.string().trim().min(1).max(200).describe('Folder name.'),
      parentFolderId: z.string().min(1).max(140).optional().describe('Create it inside this folder (p.…; default "root", the top level).'),
    }),
    annotations: { ...ANNOTATIONS.additive, destructiveHint: true },
    handler: async (args) => {
      const parent = folderIdArg(args.parentFolderId ?? 'root');
      assertLibraryPlaylistId(parent, 'parentFolderId', 'folder');
      const s = client().session('library', 'create a playlist folder');
      if (parent !== ROOT_FOLDER_ID) await readFolder(s, parent);
      const res = await s.request({
        method: 'POST',
        path: '/v1/me/library/playlist-folders',
        json: { attributes: { name: args.name }, relationships: { parent: { data: [{ id: parent, type: 'library-playlist-folders' }] } } },
      });
      const id = firstDataId(res.data);
      if (!id) {
        throw new UnconfirmedWriteError('music', `music (${s.backend.name}): Apple accepted the new folder "${args.name}" (HTTP ${res.status}) but returned no id.`);
      }
      const warnings: string[] = [];
      let verified = false;
      try {
        const check = await s.request<AppleDoc>({ path: `/v1/me/library/playlist-folders/${id}`, okStatuses: [404] });
        if (check.status === 404) warnings.push('The new folder is not visible yet (Apple can take a few seconds); it was created — re-read it shortly.');
        else verified = requireData(check.data, 'GET /v1/me/library/playlist-folders/{id}').length > 0;
      } catch (err) {
        warnings.push(`Created, but could not re-read it to verify: ${errorMessage(err)}`);
      }
      return jsonResponse({
        ...head(s),
        id,
        name: args.name,
        parentFolderId: parent,
        created: true,
        verified,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...notesField(s.notes),
      });
    },
  });

  // -------------------------------------------------------------------------
  const LIBRARY_FIELDS: readonly TypedIdField[] = ['songs', 'albums', 'playlists', 'musicVideos'];
  defineTool(server, {
    name: 'apple_music_add_to_library',
    service: 'music',
    access: 'additive',
    title: 'Add songs, albums or playlists to your Apple Music library',
    description:
      'Add catalog songs, albums, playlists or music videos to your Apple Music library by catalog id (up to 100 per type). ' +
      'Apple answers only "accepted": it silently ignores ids it cannot add and new items can take a while to appear, so ' +
      'check later with apple_music_search_library. Needs APPLE_MUSIC_USER_TOKEN or web-player mode.',
    inputSchema: z.strictObject(typedIdsSchema(LIBRARY_FIELDS)),
    annotations: ANNOTATIONS.additive,
    handler: async (args) => {
      const { query, counts } = typedIdsQuery(args as Partial<Record<TypedIdField, string[]>>, LIBRARY_FIELDS);
      const s = client().session('library', 'add items to your library');
      const res = await s.request({ method: 'POST', path: '/v1/me/library', query });
      return jsonResponse({
        ...head(s),
        accepted: true,
        status: res.status,
        requested: counts,
        verified: false,
        ...notesField([
          ...s.notes,
          "Apple accepted the request but reports nothing per item: ids it cannot add are silently ignored, and new items can take a while to appear. Check with apple_music_search_library.",
        ]),
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_add_favorites',
    service: 'music',
    access: 'additive',
    title: 'Favorite songs, albums, playlists or artists in Apple Music',
    description:
      'Mark catalog songs, albums, playlists, artists or music videos as favorites (the star in Apple Music; favorite songs ' +
      'go to your Favorite Songs playlist), by catalog id, up to 100 per type. Apple answers only "accepted" and silently ' +
      'ignores ids it cannot favorite. Needs APPLE_MUSIC_USER_TOKEN or web-player mode.',
    inputSchema: z.strictObject(typedIdsSchema(FAVORITE_FIELDS)),
    annotations: ANNOTATIONS.additive,
    handler: async (args) => {
      const { query, counts } = typedIdsQuery(args as Partial<Record<TypedIdField, string[]>>, FAVORITE_FIELDS);
      const s = client().session('library', 'add favorites');
      const res = await s.request({ method: 'POST', path: '/v1/me/favorites', query });
      return jsonResponse({
        ...head(s),
        accepted: true,
        status: res.status,
        requested: counts,
        verified: false,
        ...notesField([...s.notes, 'Apple accepted the request but reports nothing per item and offers no way to read favorites back; ids it cannot favorite are ignored.']),
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_set_rating',
    service: 'music',
    access: 'all',
    title: 'Love or dislike an Apple Music item',
    description:
      'Set your rating on a song, album, playlist, music video or station (catalog or library id): love, dislike, or none ' +
      'to clear it. Always sends the rating (Apple\'s reads can lag its writes); returns the previous rating as read and ' +
      'verifies the new one. Needs APPLE_MUSIC_USER_TOKEN or web-player mode.',
    inputSchema: z.strictObject({
      type: z.enum(RATING_TYPES).describe('What the id is: catalog types (songs, albums, …) or library-* types for library ids.'),
      id: z.string().min(1).max(140).describe('The item id.'),
      rating: z.enum(['love', 'dislike', 'none']).describe('love, dislike, or none to remove your rating.'),
    }),
    annotations: ANNOTATIONS.toggle,
    handler: async (args) => {
      assertRatingId(args.type, args.id, 'id');
      const s = client().session('library', 'change a rating');
      const previous = await readRating(s, args.type, args.id);
      // Sent even when the read already shows this rating: the read may lag a change made moments ago (an undo
      // right after a love would otherwise be skipped and reported as done). PUT and DELETE are both idempotent.
      const path = `/v1/me/ratings/${args.type}/${args.id}`;
      if (args.rating === 'none') {
        await s.request({ method: 'DELETE', path, okStatuses: [404] });
      } else {
        await s.request({ method: 'PUT', path, json: { type: 'rating', attributes: { value: args.rating === 'love' ? 1 : -1 } } });
      }
      const warnings: string[] = [];
      let verified = false;
      try {
        const now = await readRating(s, args.type, args.id);
        // A read that showed this rating BEFORE the write too proves nothing about it.
        verified = now === args.rating && previous !== args.rating;
        if (now !== args.rating) warnings.push(`Apple still reports "${now}" — the change may not be visible yet.`);
        else if (previous === args.rating) {
          warnings.push(`Not verified: Apple read "${now}" before the change too, so this read cannot confirm it — re-read it shortly.`);
        }
      } catch (err) {
        warnings.push(`Changed, but could not re-read the rating to verify: ${errorMessage(err)}`);
      }
      return jsonResponse({
        ...head(s, { type: args.type, id: args.id }),
        previous,
        rating: args.rating,
        // Unknown when the read already showed the new rating: it may lag the real one.
        ...(previous !== args.rating ? { changed: true } : {}),
        verified,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...notesField([
          ...s.notes,
          previous === args.rating ? `Apple already read "${previous}"; it was sent anyway, since a read can lag a change made moments ago.` : undefined,
        ]),
      });
    },
  });
}

async function readRating(s: MusicSession, type: RatingType, id: string): Promise<'love' | 'dislike' | 'none'> {
  const path = `/v1/me/ratings/${type}/${id}`;
  const res = await s.request<AppleDoc>({ path, okStatuses: [404] });
  if (res.status === 404) return 'none';
  const first = requireData(res.data, `GET ${path}`)[0];
  return ratingWord(first === undefined ? undefined : attrs(first).value);
}
