import { parseLenient, projectOrRaw } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getDisplayTimeZone } from '../config.js';
import { InvalidArgumentError, UpstreamError } from '../errors.js';
import { stateRevision } from '../tools/_confirm.js';
import { ANNOTATIONS, defineTool, jsonResponse, limitParam, offsetParam, pageInfo, pagedResponse } from '../tools/_shared.js';
import { nextOf, requireData, type AppleDoc, type MusicClient, type MusicSession } from './client.js';
import { head, musicViewParam, notesField, storefrontParam, uniq, viewOf, withPositions } from './common.js';
import {
  ROOT_FOLDER_ID,
  assertCatalogId,
  assertLibraryId,
  assertLibraryPlaylistId,
  isCatalogPlaylistId,
  isLibraryPlaylistId,
  type CatalogType,
} from './ids.js';
import { LABEL, attrs, compactResource, isRecord, nameOf, projectList, putDate, resourceName, str, type AppleResource } from './project.js';
import { MAX_TRACKS_READ, folderIdArg, readFolderChildren, readLibraryPlaylist, readLibraryTracks } from './playlists.js';

/**
 * Library read tools. Each needs a Music User Token (official) or web mode;
 * the documented `/v1/me/...` endpoints are served by either backend.
 */

const LIBRARY_SEARCH_TYPES = ['songs', 'albums', 'artists', 'playlists', 'music-videos'] as const;
const LIBRARY_KINDS = ['songs', 'albums', 'artists', 'music-videos', 'recently-added'] as const;
/** Apple's maximum `limit` per request for library collections (default 25; 100 accepted). */
const LIBRARY_PER_REQUEST = 100;
/** recently-added documents no limit; 25 is the conservative page size used for it. */
const RECENTLY_ADDED_PER_REQUEST = 25;
const CATALOG_PLAYLIST_TRACKS_PER_REQUEST = 300;

const FEEDS = {
  'recently-played': {
    path: '/v1/me/recent/played',
    perRequest: 10,
    types: ['albums', 'library-albums', 'playlists', 'library-playlists', 'stations', 'artists', 'curators'],
  },
  'recently-played-tracks': {
    path: '/v1/me/recent/played/tracks',
    perRequest: 30,
    types: ['songs', 'library-songs', 'music-videos', 'library-music-videos'],
  },
  'recent-stations': { path: '/v1/me/recent/radio-stations', perRequest: 10, types: undefined },
  'heavy-rotation': { path: '/v1/me/history/heavy-rotation', perRequest: 10, types: undefined },
} as const;
type Feed = keyof typeof FEEDS;

const RATING_TYPES = [
  'songs',
  'albums',
  'playlists',
  'music-videos',
  'stations',
  'library-songs',
  'library-albums',
  'library-playlists',
  'library-music-videos',
] as const;
export type RatingType = (typeof RATING_TYPES)[number];
export { RATING_TYPES };

/** Validate an id for a ratings type (catalog or library). */
export function assertRatingId(type: RatingType, id: string, field: string): void {
  if (type.startsWith('library-')) assertLibraryId(id, field);
  else assertCatalogId(type as CatalogType, id, field);
}

/** Apple's rating value → words. */
export function ratingWord(value: unknown): 'love' | 'dislike' | 'none' {
  return value === 1 ? 'love' : value === -1 ? 'dislike' : 'none';
}

const ResultsSchema = z.looseObject({ results: z.looseObject({}) });

function shapeError(context: string): UpstreamError {
  return new UpstreamError('music', 200, `music: ${context} returned an unexpected shape.`, {
    hint: 'Apple may have changed this endpoint. Retry later; if it persists, report it.',
  });
}

export function registerLibraryReadTools(server: McpServer, client: () => MusicClient): void {
  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_list_playlists',
    service: 'music',
    access: 'read',
    title: 'List your Apple Music playlists',
    description:
      'List the playlists in your Apple Music library (alphabetical), or the contents of one playlist folder (folders and ' +
      'playlists). Each has its library id (p.…), name, description, canEdit, isPublic, hasCatalog, dateAdded and ' +
      'lastModifiedDate. Paged. Needs APPLE_MUSIC_USER_TOKEN with an Apple Developer key, or web-player mode (APPLE_MUSIC_WEB_USER_TOKEN).',
    inputSchema: z.strictObject({
      folderId: z.string().min(1).max(140).optional().describe('List this folder\'s children instead ("root" or a folder id p.… from apple_music_list_folders).'),
      limit: limitParam(50, 100),
      offset: offsetParam,
      view: musicViewParam(),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const s = client().session('library', 'list your playlists');
      const limit = args.limit ?? 50;
      const offset = args.offset ?? 0;
      const zone = getDisplayTimeZone();
      const view = viewOf(args.view);
      if (args.folderId !== undefined) {
        const folderId = folderIdArg(args.folderId);
        assertLibraryPlaylistId(folderId, 'folderId');
        const r = await readFolderChildren(s, folderId, { offset, want: limit });
        const page = pageInfo({ offset, limit, returned: r.items.length, hasMore: !r.complete, total: r.total });
        return jsonResponse({
          ...head(s, { folderId }),
          ...pagedResponse(
            page,
            'children',
            projectList(r.items, view, zone, 'GET /v1/me/library/playlist-folders/{id}/children'),
            notesField([...s.notes, r.items.length === 0 ? `Folder ${folderId} has nothing${offset > 0 ? ` at offset ${offset}` : ''}.` : undefined]),
          ),
        });
      }
      const r = await s.collect('/v1/me/library/playlists', {}, { offset, want: limit, perRequest: LIBRARY_PER_REQUEST });
      const page = pageInfo({ offset, limit, returned: r.items.length, hasMore: r.hasMore, total: r.total });
      return jsonResponse({
        ...head(s),
        ...pagedResponse(
          page,
          'playlists',
          projectList(r.items, view, zone, 'GET /v1/me/library/playlists'),
          notesField([...s.notes, r.items.length === 0 ? `Your library has no playlists${offset > 0 ? ` at offset ${offset}` : ''}.` : undefined]),
        ),
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_get_playlist',
    service: 'music',
    access: 'read',
    title: 'Read an Apple Music playlist and its tracks',
    description:
      'Read one playlist — a library playlist (p.…) or a catalog playlist (pl.…) — with its tracks in order. Each track has ' +
      'its 1-based position, library id, catalogId, name, artist, album and duration. Paged (up to 300 per call), or ' +
      `allTracks for the whole list (up to ${MAX_TRACKS_READ}); a complete read returns a revision. Library playlists need ` +
      'APPLE_MUSIC_USER_TOKEN or web-player mode.',
    inputSchema: z.strictObject({
      playlistId: z.string().min(1).max(140).describe('Library playlist id (p.…, from apple_music_list_playlists) or catalog playlist id (pl.…).'),
      limit: limitParam(100, 300).describe('Tracks to return (default 100, max 300).'),
      offset: offsetParam.describe('Skip this many tracks (use nextOffset).'),
      allTracks: z.boolean().optional().describe(`Read every track (up to ${MAX_TRACKS_READ}) instead of one page. Do not combine with limit/offset.`),
      storefront: storefrontParam.describe('Catalog playlists only: storefront to read it in.'),
      view: musicViewParam(),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const id = args.playlistId;
      if (args.allTracks && (args.limit !== undefined || args.offset !== undefined)) {
        throw new InvalidArgumentError('allTracks reads the whole list; do not combine it with limit or offset.');
      }
      const catalog = isCatalogPlaylistId(id);
      if (!catalog && !isLibraryPlaylistId(id)) {
        throw new InvalidArgumentError(`playlistId "${id}" is not a playlist id.`, 'Library playlists look like p.…, catalog playlists like pl.….');
      }
      if (!catalog && args.storefront !== undefined) throw new InvalidArgumentError('storefront applies only to catalog playlists (pl.…).');
      const offset = args.offset ?? 0;
      const want = args.allTracks ? MAX_TRACKS_READ : (args.limit ?? 100);
      const zone = getDisplayTimeZone();
      const view = viewOf(args.view);
      const c = client();
      let s: MusicSession;
      let pl: AppleResource;
      let tracks: AppleResource[];
      let complete: boolean;
      let total: number | undefined;
      const notes: Array<string | undefined> = [];
      if (catalog) {
        s = c.session('catalog', 'read a catalog playlist');
        const sf = await c.resolveStorefront(args.storefront);
        notes.push(sf.note);
        const base = `/v1/catalog/${sf.storefront}/playlists/${id}`;
        const res = await s.request<AppleDoc>({ path: base, notFoundHint: 'No catalog playlist has this id in this storefront.' });
        const found = requireData(res.data, `GET ${base}`)[0];
        if (!found) throw new UpstreamError('music', 404, `music (${s.backend.name}): catalog playlist ${id} was not found.`);
        pl = found;
        const r = await s.collect(`${base}/tracks`, {}, { offset, want, perRequest: CATALOG_PLAYLIST_TRACKS_PER_REQUEST, okStatuses: [404] });
        tracks = r.items;
        complete = !r.hasMore;
        total = r.total;
        if (tracks.length === 0 && offset === 0) notes.push('Apple returned no tracks for this playlist.');
      } else {
        s = c.session('library', 'read a library playlist');
        pl = await readLibraryPlaylist(s, id);
        const r = await readLibraryTracks(s, id, offset, want);
        tracks = r.tracks;
        complete = r.complete;
        total = r.total;
        notes.push(...r.notes);
      }
      const whole = offset === 0 && complete;
      if (whole && total === undefined) total = tracks.length;
      if (args.allTracks && !complete) notes.push(`Stopped after ${MAX_TRACKS_READ} tracks; the playlist has more. Page on with offset ${MAX_TRACKS_READ}.`);
      if (tracks.length === 0 && offset > 0) notes.push(`No tracks at offset ${offset}.`);
      const page = pageInfo({ offset, limit: want, returned: tracks.length, hasMore: !complete, total });
      const projected = withPositions(projectList(tracks, view, zone, `GET ${catalog ? 'catalog' : 'library'} playlist tracks`), offset);
      return jsonResponse({
        ...head(s),
        ...page,
        ...(whole ? { revision: stateRevision(tracks.map((t) => t.id)) } : {}),
        ...notesField([...s.notes, ...notes]),
        playlist: view === 'compact' ? compactResource(pl, zone) : pl,
        tracks: projected,
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_list_folders',
    service: 'music',
    access: 'read',
    title: 'List your Apple Music playlist folders',
    description:
      'List the playlist folders in your Apple Music library: the top level, or the sub-folders of one folder. Each has its ' +
      'folder id (p.…, for apple_music_list_playlists folderId, apple_music_create_folder parentFolderId and ' +
      'apple_music_move_playlist), name and dateAdded, plus how many playlists sit directly in the folder. Needs ' +
      'APPLE_MUSIC_USER_TOKEN or web-player mode.',
    inputSchema: z.strictObject({
      folderId: z.string().min(1).max(140).optional().describe('List this folder\'s sub-folders (default "root", the top level).'),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const folderId = folderIdArg(args.folderId ?? 'root');
      assertLibraryPlaylistId(folderId, 'folderId');
      const s = client().session('library', 'list playlist folders');
      const r = await readFolderChildren(s, folderId);
      const zone = getDisplayTimeZone();
      const folders = r.items.filter((it) => it.type === 'library-playlist-folders');
      const playlistCount = r.items.filter((it) => it.type === 'library-playlists').length;
      const rows = folders.map((f) => {
        const a = attrs(f);
        const row: Record<string, unknown> = { id: f.id, name: nameOf(f) };
        putDate(row, 'dateAdded', a.dateAdded, zone);
        return row;
      });
      return jsonResponse({
        ...head(s, { folderId, ...(folderId === ROOT_FOLDER_ID ? { isRoot: true } : {}) }),
        returned: rows.length,
        playlistCount,
        complete: r.complete,
        ...notesField([
          ...s.notes,
          r.complete ? undefined : `Read only the first ${r.items.length} items of this folder; counts cover those.`,
          rows.length === 0 ? `No sub-folders in ${folderId === ROOT_FOLDER_ID ? 'the top level' : `folder ${folderId}`}.` : undefined,
        ]),
        folders: rows,
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_search_library',
    service: 'music',
    access: 'read',
    title: 'Search your Apple Music library',
    description:
      'Search YOUR Apple Music library (not the whole catalog) by text for songs, albums, artists, playlists or music ' +
      'videos. Results are grouped by type with library ids (i.… songs, l.… albums, p.… playlists) and each group\'s ' +
      'returned/hasMore/nextOffset. Up to 25 per type. Needs APPLE_MUSIC_USER_TOKEN or web-player mode.',
    inputSchema: z.strictObject({
      term: z.string().trim().min(1).max(200).describe('What to search for in your library.'),
      types: z.array(z.enum(LIBRARY_SEARCH_TYPES)).min(1).max(LIBRARY_SEARCH_TYPES.length).optional().describe('Kinds of items (default songs, albums, artists, playlists).'),
      limit: limitParam(10, 25).describe('Results per type (default 10, max 25).'),
      offset: offsetParam.describe('Skip this many results per type.'),
      view: musicViewParam(),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const s = client().session('library', 'search your library');
      const types = uniq(args.types ?? (['songs', 'albums', 'artists', 'playlists'] as const));
      const limit = args.limit ?? 10;
      const offset = args.offset ?? 0;
      const path = '/v1/me/library/search';
      const res = await s.request({ path, query: { term: args.term, types: types.map((t) => `library-${t}`), limit, offset } });
      const doc = parseLenient(ResultsSchema, res.data, { label: LABEL, context: `GET ${path}` });
      if (!isRecord(doc) || !isRecord(doc.results)) throw shapeError(`GET ${path}`);
      const zone = getDisplayTimeZone();
      const view = viewOf(args.view);
      const groups: Record<string, unknown> = {};
      let found = 0;
      for (const t of types) {
        const g = doc.results[`library-${t}`];
        const items = g === undefined ? [] : requireData(g, `GET ${path} (library-${t})`);
        found += items.length;
        const page = pageInfo({ offset, limit, returned: items.length, hasMore: nextOf(g) && items.length > 0 });
        groups[t] = pagedResponse(page, 'items', projectList(items, view, zone, `GET ${path} ${t}`));
      }
      return jsonResponse({
        ...head(s, { term: args.term, types }),
        ...notesField([
          ...s.notes,
          found === 0 ? `Nothing in your library matches "${args.term}" among ${types.join(', ')}${offset > 0 ? ` at offset ${offset}` : ''}.` : undefined,
        ]),
        results: groups,
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_list_library',
    service: 'music',
    access: 'read',
    title: 'List your Apple Music library',
    description:
      'List what is in your Apple Music library: all songs, albums, artists or music videos (alphabetical, paged), or ' +
      'recently-added items. Items carry library ids and, for songs, the catalogId. Needs APPLE_MUSIC_USER_TOKEN or web-player mode.',
    inputSchema: z.strictObject({
      kind: z.enum(LIBRARY_KINDS).describe('What to list.'),
      limit: limitParam(50, 100),
      offset: offsetParam,
      view: musicViewParam(),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const s = client().session('library', 'list your library');
      const limit = args.limit ?? 50;
      const offset = args.offset ?? 0;
      const recent = args.kind === 'recently-added';
      const path = recent ? '/v1/me/library/recently-added' : `/v1/me/library/${args.kind}`;
      const r = await s.collect(path, {}, { offset, want: limit, perRequest: recent ? RECENTLY_ADDED_PER_REQUEST : LIBRARY_PER_REQUEST });
      const page = pageInfo({ offset, limit, returned: r.items.length, hasMore: r.hasMore, total: r.total });
      return jsonResponse({
        ...head(s, { kind: args.kind }),
        ...pagedResponse(
          page,
          'items',
          projectList(r.items, viewOf(args.view), getDisplayTimeZone(), `GET ${path}`),
          notesField([...s.notes, r.items.length === 0 ? `No ${args.kind} in your library${offset > 0 ? ` at offset ${offset}` : ''}.` : undefined]),
        ),
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_get_history',
    service: 'music',
    access: 'read',
    title: 'Get your Apple Music listening history',
    description:
      'Your recent Apple Music listening: recently-played (albums, playlists, stations), recently-played-tracks (songs), ' +
      'recent-stations, or heavy-rotation. Apple gives no play timestamps or counts here and pages recently-played 10 at a ' +
      'time and tracks 30 at a time (this tool pages for you; only about the last 50 items are reachable). Needs ' +
      'APPLE_MUSIC_USER_TOKEN or web-player mode.',
    inputSchema: z.strictObject({
      feed: z.enum(Object.keys(FEEDS) as [Feed, ...Feed[]]).describe('Which history list.'),
      limit: limitParam(10, 50),
      offset: offsetParam,
      view: musicViewParam(),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const feed = FEEDS[args.feed];
      const s = client().session('library', 'read your listening history');
      const limit = args.limit ?? 10;
      const offset = args.offset ?? 0;
      const query = feed.types ? { types: [...feed.types] } : {};
      const r = await s.collect(feed.path, query, { offset, want: limit, perRequest: feed.perRequest });
      const page = pageInfo({ offset, limit, returned: r.items.length, hasMore: r.hasMore, total: r.total });
      return jsonResponse({
        ...head(s, { feed: args.feed, perRequestMax: feed.perRequest }),
        ...pagedResponse(
          page,
          'items',
          projectList(r.items, viewOf(args.view), getDisplayTimeZone(), `GET ${feed.path}`),
          notesField([...s.notes, r.items.length === 0 ? `Apple returned nothing for ${args.feed}${offset > 0 ? ` at offset ${offset}` : ''}.` : undefined]),
        ),
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_get_recommendations',
    service: 'music',
    access: 'read',
    title: 'Get your Apple Music recommendations',
    description:
      'Your personal Apple Music recommendations ("Made for You", "Recently Played" and similar groups), each with its title ' +
      'and the albums, playlists or stations in it (catalog ids). Needs APPLE_MUSIC_USER_TOKEN or web-player mode.',
    inputSchema: z.strictObject({
      limit: limitParam(10, 30).describe('Recommendation groups to return (default 10, max 30).'),
      offset: offsetParam,
      view: musicViewParam('compact gives each group its title, kind and compact contents; full is Apple\'s records verbatim.'),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const s = client().session('library', 'read your recommendations');
      const limit = args.limit ?? 10;
      const offset = args.offset ?? 0;
      const r = await s.collect('/v1/me/recommendations', {}, { offset, want: limit, perRequest: 30 });
      const zone = getDisplayTimeZone();
      const view = viewOf(args.view);
      const groups =
        view === 'compact'
          ? projectOrRaw(
              r.items,
              (arr) =>
                arr.map((g) => {
                  const a = attrs(g);
                  const contents = g.relationships?.contents;
                  const data = contents && Array.isArray(contents.data) ? contents.data : [];
                  const out: Record<string, unknown> = { id: g.id };
                  const title = resourceName(g);
                  if (title !== undefined) out.title = title;
                  if (str(a.kind)) out.kind = a.kind;
                  if (Array.isArray(a.resourceTypes)) out.resourceTypes = a.resourceTypes;
                  putDate(out, 'nextUpdateDate', a.nextUpdateDate, zone);
                  if (contents && nextOf(contents)) out.contentsHasMore = true;
                  out.contents = data.map((x) => compactResource(x, zone));
                  return out;
                }),
              { label: LABEL, context: 'GET /v1/me/recommendations' },
            )
          : r.items;
      const page = pageInfo({ offset, limit, returned: r.items.length, hasMore: r.hasMore, total: r.total });
      return jsonResponse({
        ...head(s),
        ...pagedResponse(page, 'groups', groups, notesField([...s.notes, r.items.length === 0 ? 'Apple returned no recommendations for this account.' : undefined])),
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_get_replay',
    service: 'music',
    access: 'read',
    title: 'Get your Apple Music Replay',
    description:
      'Apple Music Replay: your top songs, albums and artists for the latest Replay year, or for a given year (with play ' +
      'counts where Apple provides them). Needs APPLE_MUSIC_USER_TOKEN or web-player mode; a specific year uses an ' +
      'undocumented Apple endpoint that works most reliably in web-player mode.',
    inputSchema: z.strictObject({
      year: z
        .string()
        .regex(/^(latest|\d{4})$/, '"latest" or a four-digit year')
        .optional()
        .describe('"latest" (default: the most recent year with enough listening) or a year like "2025".'),
      views: z.array(z.enum(['top-songs', 'top-albums', 'top-artists'])).min(1).max(3).optional().describe('Which top lists (default all three).'),
      limit: limitParam(25, 100).describe('For a specific year: items per list (default 25, max 100). The latest summary returns Apple\'s own list sizes.'),
      view: musicViewParam(),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const s = client().session('library', 'read your Apple Music Replay');
      const views = uniq(args.views ?? (['top-songs', 'top-albums', 'top-artists'] as const));
      const year = args.year ?? 'latest';
      if (year === 'latest' && args.limit !== undefined) throw new InvalidArgumentError('limit applies only to a specific year; the latest summary returns Apple\'s own list sizes.');
      const zone = getDisplayTimeZone();
      const view = viewOf(args.view);
      const project = (items: AppleResource[], context: string): unknown[] =>
        view === 'full'
          ? items
          : projectOrRaw(
              items,
              (arr) =>
                arr.map((it) => {
                  const out = compactResource(it, zone);
                  const a = attrs(it);
                  putDate(out, 'firstPlayed', a.firstPlayed, zone);
                  putDate(out, 'lastPlayed', a.lastPlayed, zone);
                  const rel = Object.values(it.relationships ?? {}).find((r) => r && Array.isArray(r.data) && r.data.length > 0);
                  if (rel?.data?.[0]) out.item = compactResource(rel.data[0], zone);
                  return out;
                }),
              { label: LABEL, context },
            );
      const lists: Record<string, unknown> = {};
      const notes: Array<string | undefined> = [];
      let period: Record<string, unknown> = {};
      if (year === 'latest') {
        const path = '/v1/me/music-summaries';
        const res = await s.request<AppleDoc>({ path, query: { 'filter[year]': 'latest', views } });
        const summary = requireData(res.data, `GET ${path}`)[0];
        if (!summary) {
          notes.push('Apple has no Replay summary for this account yet (Replay needs enough listening in a year).');
        } else {
          const a = attrs(summary);
          period = { ...(a.year !== undefined ? { summaryYear: a.year } : {}), ...(str(a.period) ? { period: a.period } : {}) };
          for (const v of views) {
            const data = summary.views?.[v]?.data;
            const items = Array.isArray(data) ? data : [];
            // Apple's summary carries each view's first page only; say when it holds more (no silent cap).
            const hasMore = nextOf(summary.views?.[v]) && items.length > 0;
            if (hasMore) notes.push(`Apple's latest summary holds only the first ${items.length} ${v} (it has more); asking for a specific year with limit can return more.`);
            lists[v] = { returned: items.length, hasMore, items: project(items, `${path} ${v}`) };
          }
        }
      } else {
        const limit = args.limit ?? 25;
        for (const v of views) {
          const path = `/v1/me/music-summaries/year-${year}/view/${v}`;
          const r = await s.collect(path, {}, { offset: 0, want: limit, perRequest: 100, okStatuses: [404] });
          if (r.emptyStatus === 404) notes.push(`Apple has no ${v} for ${year} (HTTP 404) — that year may have too little listening, or the official API may not serve it (web-player mode does more reliably).`);
          lists[v] = pagedResponse(pageInfo({ offset: 0, limit, returned: r.items.length, hasMore: r.hasMore }), 'items', project(r.items, `GET ${path}`));
        }
      }
      return jsonResponse({ ...head(s, { year, ...period }), ...notesField([...s.notes, ...notes]), lists });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_get_ratings',
    service: 'music',
    access: 'read',
    title: 'Get your Apple Music ratings (love / dislike)',
    description:
      'Whether you have loved or disliked songs, albums, playlists, music videos or stations — catalog or library ids — ' +
      'returning love, dislike or none per id. Needs APPLE_MUSIC_USER_TOKEN or web-player mode.',
    inputSchema: z.strictObject({
      type: z.enum(RATING_TYPES).describe('What the ids are: catalog types (songs, albums, …) or library-* types for library ids.'),
      ids: z.array(z.string().min(1).max(140)).min(1).max(100).describe('Up to 100 ids of that type.'),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const ids = uniq(args.ids);
      ids.forEach((id, i) => assertRatingId(args.type, id, `ids[${i}]`));
      const s = client().session('library', 'read your ratings');
      const path = `/v1/me/ratings/${args.type}`;
      const res = await s.request<AppleDoc>({ path, query: { ids }, okStatuses: [404] });
      const data = res.status === 404 ? [] : requireData(res.data, `GET ${path}`);
      const byId = new Map(data.map((d) => [d.id, attrs(d).value]));
      return jsonResponse({
        ...head(s, { type: args.type }),
        returned: ids.length,
        ...notesField([...s.notes, res.status === 404 ? 'Apple answered 404: none of these ids has a rating.' : undefined]),
        ratings: ids.map((id) => ({ id, rating: ratingWord(byId.get(id)) })),
      });
    },
  });
}

