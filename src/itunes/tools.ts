import type { McpServer } from '@modelcontextprotocol/server';
import { projectOrRaw, resolveView, viewParam } from '@chrischall/mcp-utils';
import { z } from 'zod';
import { getDisplayTimeZone } from '../config.js';
import { InvalidArgumentError } from '../errors.js';
import { putInstant } from '../time.js';
import {
  ANNOTATIONS,
  compactObject,
  defineTool,
  jsonResponse,
  limitParam,
  offsetParam,
  pageInfo,
  pagedResponse,
  type PageInfo,
} from '../tools/_shared.js';
import { getDefaultItunesClient, type Fetched, type ItunesClient } from './client.js';
import {
  CHART_NAMES,
  CHARTS,
  LOOKUP_ENTITIES,
  MAX_CHART_POSITIONS,
  MAX_ITUNES_RESULTS,
  SEARCH_ATTRIBUTES,
  SEARCH_ENTITIES,
  SEARCH_MEDIA,
  assertValidForMedia,
  inferMedia,
  normalizeIsbn,
  resolveStorefront,
} from './params.js';
import { compactChartEntry, compactItunesRecord, isRecord, primaryId } from './project.js';

/**
 * iTunes Search / Lookup and Apple's top charts — Apple's no-credential
 * catalog services. Three read tools; nothing here needs an Apple account,
 * a developer key or any environment variable.
 *
 * Paging: none of these endpoints has an offset. Each serves the top N of a
 * capped list (search/lookup 200, charts 100), so `offset` is honoured by
 * asking Apple for the top `offset + limit` (never more than the cap) and
 * slicing, which keeps `nextOffset` something a caller can actually pass
 * back. A page that runs into the cap ends there with `hasMore: false` and a
 * note — it is NOT refused: a refusal would turn the `nextOffset` an earlier
 * page handed out (e.g. 180 with limit 30) into a dead end. Only an offset AT
 * or past the cap, where nothing is reachable, is refused.
 *
 * Charts always fetch the whole top 100 (one cached document per chart and
 * storefront), so every page of a chart comes from the same edition of it and
 * `total` is exact.
 */

export interface ItunesDeps {
  /** Injected client (tests); default: the module-wide throttled, cached client. */
  client?: ItunesClient;
}

const VIEWS = ['compact', 'full'] as const;
const LABEL = 'apple-icloud-mcp';

const countryParam = z
  .string()
  .regex(/^[A-Za-z]{2}$/)
  .optional()
  .describe('Two-letter country code of the store to use, e.g. us, gb, jp (default: APPLE_MUSIC_STOREFRONT, else us).');

const itunesViewParam = viewParam(VIEWS, {
  note:
    'compact keeps ids (trackId/collectionId/artistId), names, type, release date, duration, track numbers, genre, ' +
    'explicitness, ratings, app bundleId/version, podcast feedUrl, episode audio URL and guid, shortDescription and the ' +
    'store link; it drops artwork, 30-second previews, prices (except formattedPrice), censored-name copies and long ' +
    "descriptions. full returns Apple's records verbatim.",
});

const idParam = z
  .union([z.string().regex(/^0*[1-9]\d{0,18}$/), z.number().int().positive().max(Number.MAX_SAFE_INTEGER)])
  .describe('A numeric iTunes / Apple Music id.');

/**
 * An id as Apple writes it back (`trackId: 909253`): leading zeros dropped, so
 * `"0909253"` still matches its record instead of being reported not found.
 */
function canonicalId(id: string | number): string {
  return String(id).replace(/^0+/, '');
}

function fetchFacts(f: Fetched<unknown>, zone: string): Record<string, unknown> {
  const out: Record<string, unknown> = { cached: f.cached };
  putInstant(out, 'fetchedAt', new Date(f.fetchedAt), zone);
  return out;
}

function withNotes(notes: string[]): Record<string, unknown> {
  return notes.length > 0 ? { notes } : {};
}

function storeLabel(country: string): string {
  return `${country.toUpperCase()} store`;
}

export function registerItunesTools(server: McpServer, deps: ItunesDeps = {}): void {
  const client = (): ItunesClient => deps.client ?? getDefaultItunesClient();

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_itunes_search',
    service: 'itunes',
    access: 'read',
    title: 'Search the iTunes Store catalog',
    description:
      "Search Apple's iTunes Store catalog — songs, albums, artists, podcasts and podcast episodes, audiobooks, apps and " +
      'ebooks — with no Apple account or key. Returns ids, names, artist, release date, duration and store links. ' +
      "trackId/collectionId/artistId are the SAME ids Apple Music's catalog uses (handy for adding songs to playlists); " +
      'podcasts include feedUrl. Narrow with media, entity and attribute; country picks the store (default ' +
      'APPLE_MUSIC_STOREFRONT, else us). Apple serves only the top 200 matches; it allows about 20 searches a minute.',
    inputSchema: z.strictObject({
      term: z.string().min(1).max(500).describe('Words to search for, e.g. a title, artist, author, show or app name.'),
      media: z
        .enum(SEARCH_MEDIA)
        .optional()
        .describe(
          'Kind of content: music, podcast, audiobook, software (apps), ebook, musicVideo, or all. Default: all, or the ' +
            'media the entity/attribute belongs to (entity song → music, podcastEpisode → podcast).',
        ),
      entity: z
        .enum(SEARCH_ENTITIES)
        .optional()
        .describe(
          'Result type within media, e.g. song, album, musicArtist (music); podcast, podcastEpisode (podcast); software, ' +
            'iPadSoftware, desktopSoftware (software); audiobook; ebook. Must be valid for media.',
        ),
      attribute: z
        .enum(SEARCH_ATTRIBUTES)
        .optional()
        .describe(
          'Match the term against one field only, e.g. artistTerm, songTerm, albumTerm (music); titleTerm, authorTerm ' +
            '(podcast, audiobook); softwareDeveloper (software). Must be valid for media.',
        ),
      country: countryParam,
      limit: limitParam(25, MAX_ITUNES_RESULTS),
      offset: offsetParam.describe(
        'Zero-based index of the first result (default 0, below 200); pass nextOffset from the previous page.',
      ),
      explicit: z.boolean().optional().describe('false leaves out explicit content (default: included).'),
      lang: z.enum(['en_us', 'ja_jp']).optional().describe('Language of the results: en_us (default) or ja_jp.'),
      view: itunesViewParam,
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const term = args.term.trim();
      if (term === '') throw new InvalidArgumentError('term is blank.', 'Pass the words to search for.');
      const media = args.media ?? inferMedia(args.entity, args.attribute);
      assertValidForMedia(media, args.entity, args.attribute);
      const country = resolveStorefront(args.country, 'country');
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 25;
      if (offset >= MAX_ITUNES_RESULTS) {
        throw new InvalidArgumentError(
          `offset ${offset} is past the end: Apple returns at most the top ${MAX_ITUNES_RESULTS} results for a search.`,
          'Use an offset below 200; to reach something further down, narrow the search (media, entity, attribute or more specific words).',
        );
      }
      // The top `want` results; a page that runs into Apple's cap simply ends there.
      const want = Math.min(offset + limit, MAX_ITUNES_RESULTS);
      const view = resolveView(args.view, VIEWS);
      const zone = getDisplayTimeZone();
      const explicit = args.explicit === undefined ? undefined : args.explicit ? 'Yes' : 'No';
      const fetched = await client().itunes('search', {
        term,
        media,
        entity: args.entity,
        attribute: args.attribute,
        country,
        limit: want,
        explicit,
        lang: args.lang,
      });
      const all = fetched.data.results;
      const slice = all.slice(offset, want);
      const capped = want >= MAX_ITUNES_RESULTS && all.length >= MAX_ITUNES_RESULTS;
      // Fewer than asked for means Apple had no more: that count IS the total.
      const page =
        all.length < want
          ? pageInfo({ offset, limit, returned: slice.length, total: all.length })
          : pageInfo({ offset, limit, returned: slice.length, hasMore: !capped });
      const notes: string[] = [];
      const filters = [`media ${media}`, ...(args.entity ? [`entity ${args.entity}`] : []), ...(args.attribute ? [`attribute ${args.attribute}`] : [])];
      if (all.length === 0) {
        notes.push(
          `No results for "${term}" in the ${storeLabel(country)} (${filters.join(', ')}). Try fewer or different words, ` +
            'fewer filters (media, entity, attribute), or another country.',
        );
      } else if (slice.length === 0) {
        notes.push(`offset ${offset} is past the end: Apple returned ${all.length} results for this search.`);
      }
      if (capped) {
        notes.push(
          `Apple returns at most ${MAX_ITUNES_RESULTS} results for a search and this one reached that cap, so more may match. ` +
            'Narrow it with media, entity, attribute or more specific words.',
        );
      }
      const query = compactObject({ term, media, entity: args.entity, attribute: args.attribute, country, explicit: args.explicit, lang: args.lang });
      const results =
        view === 'full'
          ? slice
          : projectOrRaw(slice, (rs) => rs.map((r) => compactItunesRecord(r, zone)), { label: LABEL, context: 'GET itunes.apple.com/search' });
      return jsonResponse(pagedResponse(page, 'results', results, { ...withNotes(notes), query, ...fetchFacts(fetched, zone) }));
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_itunes_lookup',
    service: 'itunes',
    access: 'read',
    title: 'Look up iTunes Store items by id, UPC, ISBN or bundle id',
    description:
      'Look up iTunes Store items (no Apple account or key) by ids — 1–200 trackId/collectionId/artistId values, e.g. from ' +
      'apple_itunes_search or an Apple Music link — or by one UPC/EAN (album), ISBN (book) or bundleId (app). With one item ' +
      'and entity, lists its related items: an album\'s songs (song), an artist\'s albums (album), a podcast\'s episodes ' +
      '(podcastEpisode, newest first; Apple serves at most 200 and fewer for some shows). Ids match Apple Music catalog ids; ' +
      'ids not found are listed. Episode ids cannot be looked up directly.',
    inputSchema: z.strictObject({
      ids: z
        .array(idParam)
        .min(1)
        .max(MAX_ITUNES_RESULTS)
        .optional()
        .describe('1–200 iTunes ids (trackId, collectionId or artistId). Only one id when entity is set.'),
      upc: z.string().regex(/^\d{8,14}$/).optional().describe('An album or video UPC/EAN (8–14 digits).'),
      isbn: z
        .string()
        .regex(/^[0-9Xx\s-]{10,17}$/)
        .optional()
        .describe('A book ISBN, 13-digit or 10-digit (hyphens allowed; ISBN-10 is converted).'),
      bundleId: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,154}$/)
        .optional()
        .describe('An app bundle identifier, e.g. com.apple.Pages.'),
      entity: z
        .enum(LOOKUP_ENTITIES)
        .optional()
        .describe(
          "List the item's related items of this type: song (an album's or artist's songs), album (an artist's albums), " +
            'podcastEpisode (a podcast\'s episodes), musicVideo, ebook, audiobook, software, …',
        ),
      limit: limitParam(50, MAX_ITUNES_RESULTS).describe(
        'With entity: maximum related items to return (default 50, max 200; Apple serves only the first 200).',
      ),
      offset: offsetParam.describe(
        'With entity: zero-based index of the first related item (default 0, below 200); pass nextOffset from the previous page.',
      ),
      sort: z.enum(['recent']).optional().describe('With entity: "recent" returns the newest related items first.'),
      country: countryParam,
      view: itunesViewParam,
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const given = (['ids', 'upc', 'isbn', 'bundleId'] as const).filter((k) => args[k] !== undefined);
      if (given.length !== 1) {
        throw new InvalidArgumentError(
          given.length === 0 ? 'Nothing to look up.' : `Pass only one of ${given.join(', ')}.`,
          'Pass exactly one of ids, upc, isbn or bundleId.',
        );
      }
      let key: 'id' | 'upc' | 'isbn' | 'bundleId';
      let values: string[];
      if (args.ids !== undefined) {
        key = 'id';
        values = [...new Set(args.ids.map(canonicalId))];
      } else if (args.upc !== undefined) {
        key = 'upc';
        values = [args.upc];
      } else if (args.isbn !== undefined) {
        key = 'isbn';
        values = [normalizeIsbn(args.isbn)];
      } else {
        key = 'bundleId';
        values = [args.bundleId as string];
      }
      const entity = args.entity;
      if (entity === undefined) {
        const stray = (['limit', 'offset', 'sort'] as const).filter((k) => args[k] !== undefined);
        if (stray.length > 0) {
          throw new InvalidArgumentError(
            `${stray.join(', ')} ${stray.length === 1 ? 'applies' : 'apply'} only to related items, which need entity.`,
            'Add entity (e.g. song, album or podcastEpisode) or leave them out.',
          );
        }
      } else if (values.length > 1) {
        throw new InvalidArgumentError(
          'entity lists the related items of ONE item, but several ids were given.',
          "Call apple_itunes_lookup once per id to list each one's related items.",
        );
      }
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      if (offset >= MAX_ITUNES_RESULTS) {
        throw new InvalidArgumentError(
          `offset ${offset} is past the end: Apple's lookup serves at most the first ${MAX_ITUNES_RESULTS} related items.`,
          'Use an offset below 200.',
        );
      }
      // The first `want` related items; a page that runs into Apple's cap simply ends there.
      const want = Math.min(offset + limit, MAX_ITUNES_RESULTS);
      const country = resolveStorefront(args.country, 'country');
      const view = resolveView(args.view, VIEWS);
      const zone = getDisplayTimeZone();
      const fetched = await client().itunes('lookup', {
        [key]: values,
        entity,
        limit: entity === undefined ? undefined : want,
        sort: args.sort,
        country,
      });
      const results = fetched.data.results;
      // Echoed in this tool's own argument names.
      const query = compactObject({ [key === 'id' ? 'ids' : key]: key === 'id' ? values : values[0], entity, sort: args.sort, country });
      const project = (rs: unknown[]): unknown[] =>
        view === 'full'
          ? rs
          : projectOrRaw(rs, (list) => list.map((r) => compactItunesRecord(r, zone)), { label: LABEL, context: 'GET itunes.apple.com/lookup' });
      const notes: string[] = [];

      if (entity === undefined) {
        // Ids are matched to the records Apple returned; a UPC/ISBN/bundle id is not echoed back, so it is
        // "not found" only when nothing came back at all.
        const found = new Set(results.filter(isRecord).map(primaryId));
        const notFound = key === 'id' ? values.filter((v) => !found.has(v)) : results.length === 0 ? values : [];
        if (notFound.length > 0) {
          notes.push(
            `Nothing found for ${key} ${notFound.join(', ')} in the ${storeLabel(country)}: it may not exist or not be sold ` +
              'there (try country).' +
              (key === 'id' ? ' Podcast episode ids cannot be looked up directly — look up the show with entity podcastEpisode.' : ''),
          );
        }
        // No paging here (limit/offset need entity); a UPC can match more than one record, so the "limit"
        // is whichever is larger — a page must never claim to hold more than its limit.
        const page = pageInfo({ offset: 0, limit: Math.max(values.length, results.length), returned: results.length, total: results.length });
        return jsonResponse(
          pagedResponse(page, 'results', project(results), {
            ...withNotes(notes),
            query,
            ...(notFound.length > 0 ? { notFound } : {}),
            ...fetchFacts(fetched, zone),
          }),
        );
      }

      // One item + its related items. Apple lists the item itself first (verified live for artist, album and podcast ids).
      const target = values[0] as string;
      const [first, ...rest] = results;
      const hasItem = isRecord(first) && (key !== 'id' || primaryId(first) === target);
      const related = hasItem ? rest : results;
      const slice = related.slice(offset, want);
      const full = related.length >= want;
      const capped = full && want >= MAX_ITUNES_RESULTS;
      const page: PageInfo = pageInfo({ offset, limit, returned: slice.length, hasMore: full && !capped });
      if (results.length === 0) {
        notes.push(`Nothing found for ${key} ${target} in the ${storeLabel(country)}: it may not exist or not be sold there (try country).`);
      } else if (!hasItem) {
        notes.push(`Apple did not return the looked-up item itself; everything it returned is listed under related.`);
      }
      if (hasItem && related.length === 0) {
        notes.push(`Apple returned no ${entity} items related to ${key} ${target}.`);
      } else if (related.length > 0 && slice.length === 0) {
        notes.push(`offset ${offset} is past the end: Apple returned ${related.length} related items.`);
      }
      const episodeCount = hasItem && entity === 'podcastEpisode' ? (first as Record<string, unknown>).trackCount : undefined;
      if (typeof episodeCount === 'number' && episodeCount > related.length && !page.hasMore) {
        notes.push(
          `This podcast lists ${episodeCount} episodes, but Apple's lookup returned ${related.length}: it serves at most ` +
            `${MAX_ITUNES_RESULTS} and fewer for some shows. The full list is in the show's RSS feed (feedUrl), which this server does not fetch.`,
        );
      } else if (capped) {
        notes.push(`Apple's lookup serves at most ${MAX_ITUNES_RESULTS} related items and this list reached that cap; more may exist.`);
      }
      const projected = project(hasItem ? [first, ...slice] : slice);
      const itemOut = hasItem ? projected[0] : undefined;
      const relatedOut = hasItem ? projected.slice(1) : projected;
      return jsonResponse(
        pagedResponse(page, 'related', relatedOut, {
          ...withNotes(notes),
          query,
          ...(results.length === 0 ? { notFound: [target] } : {}),
          ...fetchFacts(fetched, zone),
          ...(itemOut !== undefined ? { item: itemOut } : {}),
        }),
      );
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_charts_get',
    service: 'itunes',
    access: 'read',
    title: 'Get Apple top charts',
    description:
      "Apple's current top charts (no Apple account or key): most-played songs, albums, music videos and playlists on Apple " +
      'Music; top podcasts, trending podcast episodes and top subscriber channels; top free/paid apps and books; top ' +
      'audiobooks. Returns ranked entries (rank, id, name, artist, release date, genres, store link) for one storefront ' +
      '(two-letter country code; default APPLE_MUSIC_STOREFRONT, else us), up to the top 100. ' +
      'Song, album and podcast ids work with apple_itunes_lookup and Apple Music.',
    inputSchema: z.strictObject({
      chart: z
        .enum(CHART_NAMES)
        .describe(
          'Which chart: music-songs, music-albums, music-videos, music-playlists, podcasts, podcast-episodes, ' +
            'podcast-channels, apps-free, apps-paid, books-free, books-paid, audiobooks.',
        ),
      storefront: z
        .string()
        .regex(/^[A-Za-z]{2}$/)
        .optional()
        .describe('Two-letter country code of the chart, e.g. us, gb, jp (default: APPLE_MUSIC_STOREFRONT, else us).'),
      limit: limitParam(25, MAX_CHART_POSITIONS),
      offset: offsetParam.describe('Zero-based chart position to start at (default 0, below 100); pass nextOffset from the previous page.'),
      view: viewParam(VIEWS, {
        note:
          "compact gives rank, id, name, artistName/artistId, collectionId (a song's album or an episode's show), release date, " +
          "genre names, explicit and the store link, dropping artwork and genre/artist URLs; full returns Apple's feed " +
          'entries verbatim (their rank is offset + position).',
      }),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const spec = CHARTS[args.chart];
      const storefront = resolveStorefront(args.storefront, 'storefront');
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 25;
      if (offset >= MAX_CHART_POSITIONS) {
        throw new InvalidArgumentError(
          `offset ${offset} is past the end: Apple's charts list at most the top ${MAX_CHART_POSITIONS}.`,
          'Use an offset below 100.',
        );
      }
      const view = resolveView(args.view, VIEWS);
      const zone = getDisplayTimeZone();
      // Always the whole top 100: pages then share one cached edition of the chart (a chart
      // fetched per page could change between pages, repeating or skipping positions) and
      // `total` is exact — Apple's feed IS the whole chart.
      const fetched = await client().chart(storefront, spec.media, spec.feed, MAX_CHART_POSITIONS, spec.type);
      const feed = fetched.data;
      const all = feed.results;
      const slice = all.slice(offset, offset + limit);
      const page = pageInfo({ offset, limit, returned: slice.length, total: all.length });
      const notes: string[] = [];
      if (all.length === 0) notes.push(`Apple's ${args.chart} chart for storefront ${storefront} has no entries.`);
      else if (slice.length === 0) notes.push(`offset ${offset} is past the end of this chart (${all.length} entries).`);
      else if (all.length >= MAX_CHART_POSITIONS && offset + slice.length >= all.length) {
        notes.push(`Apple's chart feeds list only the top ${MAX_CHART_POSITIONS}; positions further down are not available.`);
      }
      // The feed's own `updated` stamp is not reported: it is the time Apple generated the response (verified
      // live — it equals the request time), not when the chart last changed, so it would read as a false fact.
      const facts: Record<string, unknown> = compactObject({
        chart: args.chart,
        storefront,
        title: typeof feed.title === 'string' ? feed.title : undefined,
      });
      const entries =
        view === 'full'
          ? slice
          : projectOrRaw(slice, (rs) => rs.map((r, i) => compactChartEntry(r, offset + i + 1, zone)), {
              label: LABEL,
              context: `GET rss.marketingtools.apple.com ${spec.media}/${spec.feed}/${spec.type}`,
            });
      return jsonResponse(pagedResponse(page, 'results', entries, { ...withNotes(notes), ...facts, ...fetchFacts(fetched, zone) }));
    },
  });
}
