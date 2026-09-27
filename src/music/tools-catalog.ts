import { parseLenient, projectOrRaw } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getDisplayTimeZone } from '../config.js';
import { InvalidArgumentError, UpstreamError } from '../errors.js';
import { ANNOTATIONS, defineTool, jsonResponse, limitParam, offsetParam, pageInfo, pagedResponse } from '../tools/_shared.js';
import { nextOf, requireData, type AppleDoc, type MusicClient } from './client.js';
import { head, musicViewParam, notesField, storefrontParam, uniq, viewOf, withPositions } from './common.js';
import { CATALOG_TYPES, assertCatalogId, type CatalogType } from './ids.js';
import { LABEL, compactResource, isRecord, projectList, str, type AppleResource } from './project.js';

/**
 * Catalog tools: search, lookup and charts. They need only a developer token
 * (official) or web mode; nothing here touches the account.
 */

const SEARCH_TYPES = ['songs', 'albums', 'artists', 'playlists', 'music-videos', 'stations'] as const;
const DEFAULT_SEARCH_TYPES: readonly (typeof SEARCH_TYPES)[number][] = ['songs', 'albums', 'artists', 'playlists'];

/** Apple's documented `?ids=` maxima per type. */
const MAX_IDS: Record<CatalogType, number> = {
  songs: 300,
  albums: 100,
  artists: 25,
  playlists: 25,
  'music-videos': 100,
  stations: 100,
};
const MAX_TRACKS_PER_REQUEST = 300;

const ARTIST_VIEWS = [
  'top-songs',
  'latest-release',
  'full-albums',
  'similar-artists',
  'featured-playlists',
  'singles',
  'top-music-videos',
  'appears-on-albums',
  'compilation-albums',
  'live-albums',
] as const;

const CHART_TYPES = ['songs', 'albums', 'playlists', 'music-videos'] as const;

const SearchSchema = z.looseObject({ results: z.looseObject({}) });
const ChartsSchema = z.looseObject({ results: z.looseObject({}) });

function shapeError(context: string): UpstreamError {
  return new UpstreamError('music', 200, `music: ${context} returned an unexpected shape.`, {
    hint: 'Apple may have changed this endpoint. Retry later; if it persists, report it.',
  });
}

export function registerCatalogTools(server: McpServer, client: () => MusicClient): void {
  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_search_catalog',
    service: 'music',
    access: 'read',
    title: 'Search the Apple Music catalog',
    description:
      "Search Apple Music's catalog by text for songs, albums, artists, playlists, music videos or stations. Results are " +
      'grouped by type, each group with its own returned/hasMore/nextOffset, and carry catalog ids other tools take (e.g. ' +
      'to add songs to a playlist). Up to 25 per type per call. Needs an Apple Developer key (APPLE_TEAM_ID, APPLE_KEY_ID, ' +
      'APPLE_PRIVATE_KEY) or web-player mode (APPLE_MUSIC_WEB_USER_TOKEN).',
    inputSchema: z.strictObject({
      term: z.string().trim().min(1).max(200).describe('What to search for, e.g. "bohemian rhapsody queen". Prefer "title artist" over "title - artist".'),
      types: z
        .array(z.enum(SEARCH_TYPES))
        .min(1)
        .max(SEARCH_TYPES.length)
        .optional()
        .describe('Which kinds of results (default songs, albums, artists, playlists).'),
      limit: limitParam(10, 25).describe('Results per type (default 10, max 25).'),
      offset: offsetParam.describe('Skip this many results per type (use a group\'s nextOffset).'),
      storefront: storefrontParam,
      view: musicViewParam(),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const c = client();
      const s = c.session('catalog', 'search the catalog');
      const sf = await c.resolveStorefront(args.storefront);
      const types = uniq(args.types ?? DEFAULT_SEARCH_TYPES);
      const limit = args.limit ?? 10;
      const offset = args.offset ?? 0;
      const path = `/v1/catalog/${sf.storefront}/search`;
      const res = await s.request<{ results?: unknown }>({ path, query: { term: args.term, types, limit, offset } });
      const doc = parseLenient(SearchSchema, res.data, { label: LABEL, context: `GET ${path}` });
      if (!isRecord(doc) || !isRecord(doc.results)) throw shapeError(`GET ${path}`);
      const zone = getDisplayTimeZone();
      const view = viewOf(args.view);
      const groups: Record<string, unknown> = {};
      let found = 0;
      for (const t of types) {
        const g = doc.results[t];
        const items = g === undefined ? [] : requireData(g, `GET ${path} (${t})`);
        found += items.length;
        const page = pageInfo({ offset, limit, returned: items.length, hasMore: nextOf(g) && items.length > 0 });
        groups[t] = pagedResponse(page, 'items', projectList(items, view, zone, `GET ${path} ${t}`));
      }
      return jsonResponse({
        ...head(s, { storefront: sf.storefront, term: args.term, types }),
        ...notesField([
          ...s.notes,
          sf.note,
          found === 0 ? `No catalog results for "${args.term}" among ${types.join(', ')} in the ${sf.storefront} storefront${offset > 0 ? ` at offset ${offset}` : ''}.` : undefined,
        ]),
        results: groups,
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_get_catalog_items',
    service: 'music',
    access: 'read',
    title: 'Look up Apple Music catalog items',
    description:
      'Look up Apple Music catalog songs, albums, artists, playlists, music videos or stations by id — or songs/music videos ' +
      'by ISRC, albums by UPC. A single album or playlist also returns its track list (paged); a single artist can include ' +
      'views such as top-songs or latest-release. Reports ids Apple did not return. Needs an Apple Developer key or web-player mode.',
    inputSchema: z.strictObject({
      type: z.enum(CATALOG_TYPES).describe('What the ids are.'),
      ids: z
        .array(z.string().min(1).max(140))
        .min(1)
        .max(300)
        .optional()
        .describe('Catalog ids (numeric; pl.… for playlists, ra.… for stations). Max per call: songs 300, albums/music-videos/stations 100, artists/playlists 25.'),
      isrc: z.array(z.string().regex(/^[A-Za-z]{2}[A-Za-z0-9]{3}\d{7}$/, 'an ISRC like USUM71703861')).min(1).max(25).optional().describe('ISRC codes (songs or music-videos only; one ISRC can match several items).'),
      upc: z.array(z.string().regex(/^\d{8,14}$/, 'a UPC/EAN barcode number')).min(1).max(25).optional().describe('UPC barcodes (albums only).'),
      tracksLimit: limitParam(100, 300).describe('For one album or playlist: tracks to return (default 100, max 300).'),
      tracksOffset: offsetParam.describe('For one album or playlist: skip this many tracks (use tracksPage.nextOffset).'),
      views: z.array(z.enum(ARTIST_VIEWS)).min(1).max(5).optional().describe('For ONE artist: extra lists to include, e.g. top-songs, latest-release, full-albums, similar-artists, featured-playlists.'),
      storefront: storefrontParam,
      view: musicViewParam(),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const type = args.type;
      const given = [args.ids, args.isrc, args.upc].filter((x) => x !== undefined).length;
      if (given !== 1) throw new InvalidArgumentError('Give exactly one of ids, isrc or upc.');
      if (args.isrc && type !== 'songs' && type !== 'music-videos') throw new InvalidArgumentError('isrc works only with type songs or music-videos.');
      if (args.upc && type !== 'albums') throw new InvalidArgumentError('upc works only with type albums.');
      const ids = args.ids ? uniq(args.ids) : undefined;
      if (ids) {
        if (ids.length > MAX_IDS[type]) throw new InvalidArgumentError(`Apple returns at most ${MAX_IDS[type]} ${type} per request; ${ids.length} ids were given.`, 'Split the ids across calls.');
        ids.forEach((id, i) => assertCatalogId(type, id, `ids[${i}]`));
      }
      const single = ids?.length === 1 && (type === 'albums' || type === 'playlists') ? ids[0] : undefined;
      if ((args.tracksLimit !== undefined || args.tracksOffset !== undefined) && single === undefined) {
        throw new InvalidArgumentError('tracksLimit/tracksOffset apply only to a single album or playlist id.');
      }
      if (args.views && !(type === 'artists' && ids?.length === 1)) {
        throw new InvalidArgumentError('views apply only to a single artist id (type artists, one id).');
      }

      const c = client();
      const s = c.session('catalog', 'look up catalog items');
      const sf = await c.resolveStorefront(args.storefront);
      const base = `/v1/catalog/${sf.storefront}/${type}`;
      let items: AppleResource[];
      if (args.views && ids) {
        const res = await s.request<AppleDoc>({ path: `${base}/${ids[0]}`, query: { views: uniq(args.views) }, okStatuses: [404] });
        items = res.status === 404 ? [] : requireData(res.data, `GET ${base}/{id}`);
      } else {
        // ISRCs are defined upper-case; send them that way whatever the caller typed.
        const query = ids ? { ids } : args.isrc ? { 'filter[isrc]': uniq(args.isrc.map((c) => c.toUpperCase())) } : { 'filter[upc]': args.upc };
        const res = await s.request<AppleDoc>({ path: base, query });
        items = requireData(res.data, `GET ${base}`);
      }
      const zone = getDisplayTimeZone();
      const view = viewOf(args.view);
      const missing = ids ? ids.filter((id) => !items.some((it) => it.id === id)) : [];
      const notes: Array<string | undefined> = [...s.notes, sf.note];
      if (items.length === 0) {
        const what = ids ? `ids ${ids.join(', ')}` : args.isrc ? `ISRC ${args.isrc.join(', ')}` : `UPC ${(args.upc as string[]).join(', ')}`;
        notes.push(`Apple returned no ${type} for ${what} in the ${sf.storefront} storefront.`);
      }

      // Artist views are Apple's FIRST page of each list; say which ones hold more rather than cap them silently.
      for (const it of items) {
        if (!isRecord(it.views)) continue;
        for (const [viewName, v] of Object.entries(it.views)) {
          const shown = v && Array.isArray(v.data) ? v.data.length : 0;
          // As with any page: a `next` after an empty page is not "more" (see MusicSession.page).
          if (shown > 0 && nextOf(v)) notes.push(`The ${viewName} view shows Apple's first ${shown} items; Apple has more.`);
        }
      }

      let tracksPart: Record<string, unknown> = {};
      if (single !== undefined && items.length > 0) {
        const tracksLimit = args.tracksLimit ?? 100;
        const tracksOffset = args.tracksOffset ?? 0;
        const r = await s.collect(`${base}/${single}/tracks`, {}, { offset: tracksOffset, want: tracksLimit, perRequest: MAX_TRACKS_PER_REQUEST, okStatuses: [404] });
        const page = pageInfo({ offset: tracksOffset, limit: tracksLimit, returned: r.items.length, hasMore: r.hasMore, total: r.total });
        if (r.items.length === 0) notes.push(`No tracks were returned for ${single}${tracksOffset > 0 ? ` at offset ${tracksOffset}` : ''}.`);
        const tracks = withPositions(projectList(r.items, view, zone, `GET ${base}/{id}/tracks`), tracksOffset);
        tracksPart = { tracksPage: page, tracksData: tracks };
      }

      const projected =
        view === 'compact'
          ? projectOrRaw(
              items,
              (arr) =>
                arr.map((r) => {
                  const out = compactResource(r, zone);
                  if (isRecord(r.views)) {
                    const views: Record<string, unknown> = {};
                    for (const [name, v] of Object.entries(r.views)) {
                      views[name] = v && Array.isArray(v.data) ? v.data.map((x) => compactResource(x, zone)) : [];
                    }
                    out.views = views;
                  }
                  return out;
                }),
              { label: LABEL, context: `GET ${base}` },
            )
          : items;
      const { tracksData, ...tracksHead } = tracksPart as { tracksData?: unknown[] };
      return jsonResponse({
        ...head(s, { storefront: sf.storefront, type }),
        ...(ids ? { requested: ids.length } : {}),
        returned: items.length,
        ...(missing.length > 0 ? { missing } : {}),
        ...notesField(notes),
        ...tracksHead,
        items: projected,
        ...(tracksData ? { tracks: tracksData } : {}),
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_music_get_charts',
    service: 'music',
    access: 'read',
    title: 'Get Apple Music charts',
    description:
      "Get Apple Music's top charts (most played songs, albums, playlists, music videos) for a storefront, optionally for one " +
      'genre. Each chart has its own returned/hasMore/nextOffset and ranked items with catalog ids. Needs an Apple Developer key or web-player mode.',
    inputSchema: z.strictObject({
      types: z.array(z.enum(CHART_TYPES)).min(1).max(CHART_TYPES.length).optional().describe('Which charts (default songs, albums, playlists).'),
      genre: z.string().regex(/^\d{1,12}$/, 'a numeric genre id').optional().describe('Numeric genre id (e.g. 20 = Alternative, 21 = Rock) to chart one genre.'),
      chart: z.string().regex(/^[a-z0-9-]{1,40}$/, 'a chart name such as most-played').optional().describe('Which chart, e.g. most-played (default: every chart Apple offers for the type).'),
      limit: limitParam(20, 50).describe('Items per chart (default 20, max 50).'),
      offset: offsetParam.describe('Skip this many items per chart (use a chart\'s nextOffset).'),
      storefront: storefrontParam,
      view: musicViewParam(),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const c = client();
      const s = c.session('catalog', 'read charts');
      const sf = await c.resolveStorefront(args.storefront);
      const types = uniq(args.types ?? ['songs', 'albums', 'playlists']);
      const limit = args.limit ?? 20;
      const offset = args.offset ?? 0;
      const path = `/v1/catalog/${sf.storefront}/charts`;
      const res = await s.request({ path, query: { types, limit, offset, chart: args.chart, genre: args.genre } });
      const doc = parseLenient(ChartsSchema, res.data, { label: LABEL, context: `GET ${path}` });
      if (!isRecord(doc) || !isRecord(doc.results)) throw shapeError(`GET ${path}`);
      const zone = getDisplayTimeZone();
      const view = viewOf(args.view);
      const charts: unknown[] = [];
      const absent: string[] = [];
      for (const t of types) {
        const list = doc.results[t];
        // No chart list, or an empty one, is the same answer — and an empty result must say what was asked.
        if (list === undefined || (Array.isArray(list) && list.length === 0)) {
          absent.push(t);
          continue;
        }
        if (!Array.isArray(list)) throw shapeError(`GET ${path} (${t})`);
        for (const chart of list) {
          const items = requireData(chart, `GET ${path} (${t})`);
          const page = pageInfo({ offset, limit, returned: items.length, hasMore: nextOf(chart) && items.length > 0 });
          charts.push({
            type: t,
            ...(str((chart as Record<string, unknown>).chart) ? { chart: (chart as Record<string, unknown>).chart } : {}),
            ...(str((chart as Record<string, unknown>).name) ? { name: (chart as Record<string, unknown>).name } : {}),
            ...pagedResponse(page, 'items', projectList(items, view, zone, `GET ${path} ${t}`)),
          });
        }
      }
      return jsonResponse({
        ...head(s, { storefront: sf.storefront }),
        ...(args.chart ? { chart: args.chart } : {}),
        ...(args.genre ? { genre: args.genre } : {}),
        ...notesField([
          ...s.notes,
          sf.note,
          absent.length > 0 ? `Apple returned no ${absent.join(', ')} chart for this storefront${args.genre ? ` and genre ${args.genre}` : ''}${args.chart ? ` (chart ${args.chart})` : ''}.` : undefined,
        ]),
        charts,
      });
    },
  });
}
