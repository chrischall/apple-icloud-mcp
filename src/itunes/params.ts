import { readEnvVar } from '@chrischall/mcp-utils';
import { ConfigError, InvalidArgumentError } from '../errors.js';

/**
 * Argument vocabulary for the iTunes Search API and Apple's chart feeds, and
 * the validation Apple itself does not do.
 *
 * The media → entity and media → attribute tables are Apple's own
 * (https://performance-partners.apple.com/search-api). Apple REJECTS a bad
 * `attribute` with HTTP 400, but it does NOT check `entity` against `media`
 * (verified live: `media=music&entity=podcast` quietly returns podcasts), so a
 * mismatched pair would come back as a confident answer to a different
 * question. Both are checked here, before any request, naming the valid values.
 *
 * `movie`, `tvShow` and `shortFilm` media are deliberately not offered: live
 * probes returned nothing for obvious titles (Dune, Inception, Severance).
 */

export const SEARCH_MEDIA = ['all', 'music', 'podcast', 'audiobook', 'software', 'ebook', 'musicVideo'] as const;
export type SearchMedia = (typeof SEARCH_MEDIA)[number];

export const ENTITIES_BY_MEDIA: Readonly<Record<SearchMedia, readonly string[]>> = {
  all: ['movie', 'album', 'allArtist', 'podcast', 'musicVideo', 'mix', 'audiobook', 'tvSeason', 'allTrack'],
  music: ['musicArtist', 'musicTrack', 'album', 'musicVideo', 'mix', 'song'],
  podcast: ['podcastAuthor', 'podcast', 'podcastEpisode'],
  audiobook: ['audiobookAuthor', 'audiobook'],
  software: ['software', 'iPadSoftware', 'desktopSoftware'],
  ebook: ['ebook'],
  musicVideo: ['musicArtist', 'musicVideo'],
};

export const ATTRIBUTES_BY_MEDIA: Readonly<Record<SearchMedia, readonly string[]>> = {
  all: [
    'actorTerm', 'languageTerm', 'allArtistTerm', 'tvEpisodeTerm', 'shortFilmTerm', 'directorTerm', 'releaseYearTerm',
    'titleTerm', 'featureFilmTerm', 'ratingIndex', 'keywordsTerm', 'descriptionTerm', 'authorTerm', 'genreIndex',
    'mixTerm', 'allTrackTerm', 'artistTerm', 'composerTerm', 'tvSeasonTerm', 'producerTerm', 'ratingTerm', 'songTerm',
    'movieArtistTerm', 'showTerm', 'movieTerm', 'albumTerm',
  ],
  music: ['mixTerm', 'genreIndex', 'artistTerm', 'composerTerm', 'albumTerm', 'ratingIndex', 'songTerm'],
  podcast: ['titleTerm', 'languageTerm', 'authorTerm', 'genreIndex', 'artistTerm', 'ratingIndex', 'keywordsTerm', 'descriptionTerm'],
  audiobook: ['titleTerm', 'authorTerm', 'genreIndex', 'ratingIndex'],
  software: ['softwareDeveloper'],
  // Apple documents no attributes for ebook searches.
  ebook: [],
  musicVideo: ['genreIndex', 'artistTerm', 'albumTerm', 'ratingIndex', 'songTerm'],
};

function union(table: Readonly<Record<string, readonly string[]>>): [string, ...string[]] {
  return [...new Set(Object.values(table).flat())] as [string, ...string[]];
}

/** Every entity value any supported media accepts (the schema enum; per-media validity is checked in the handler). */
export const SEARCH_ENTITIES = union(ENTITIES_BY_MEDIA);
/** Every attribute value any supported media accepts. */
export const SEARCH_ATTRIBUTES = union(ATTRIBUTES_BY_MEDIA);

const SPECIFIC_MEDIA: readonly SearchMedia[] = ['music', 'podcast', 'audiobook', 'software', 'ebook', 'musicVideo'];

/**
 * The media to search when the caller named none. Apple's own default is
 * `all`, but `all` accepts neither `song` nor `podcastEpisode`, so
 * `{term, entity: 'song'}` would be refused for a media nobody chose. With an
 * entity, the first specific media that accepts it (and the attribute, if any)
 * is used; with only an attribute, `all` if it accepts it, else the first
 * specific media that does. When no media accepts the pair, the refusal names
 * the pair — not a media the caller never chose.
 */
export function inferMedia(entity: string | undefined, attribute: string | undefined): SearchMedia {
  const order: readonly SearchMedia[] = entity === undefined ? ['all', ...SPECIFIC_MEDIA] : [...SPECIFIC_MEDIA, 'all'];
  const fits = (m: SearchMedia): boolean =>
    (entity === undefined || ENTITIES_BY_MEDIA[m].includes(entity)) && (attribute === undefined || ATTRIBUTES_BY_MEDIA[m].includes(attribute));
  const media = order.find(fits);
  if (media !== undefined) return media;
  // Only a PAIR can fail: every schema-valid entity or attribute belongs to some media on its own.
  const forEntity = SEARCH_MEDIA.filter((m) => ENTITIES_BY_MEDIA[m].includes(entity as string));
  const forAttribute = SEARCH_MEDIA.filter((m) => ATTRIBUTES_BY_MEDIA[m].includes(attribute as string));
  throw new InvalidArgumentError(
    `No media accepts entity "${entity}" together with attribute "${attribute}".`,
    `entity "${entity}" belongs to media ${forEntity.join(', ')}; attribute "${attribute}" to media ` +
      `${forAttribute.join(', ')}. Drop one, or pick values from the same media.`,
  );
}

/** Throws unless `entity`/`attribute` are valid for `media` (Apple's table). */
export function assertValidForMedia(media: SearchMedia, entity: string | undefined, attribute: string | undefined): void {
  if (entity !== undefined && !ENTITIES_BY_MEDIA[media].includes(entity)) {
    throw new InvalidArgumentError(
      `entity "${entity}" is not valid for media "${media}".`,
      `Valid entity values for media "${media}": ${ENTITIES_BY_MEDIA[media].join(', ')}. Or change media.`,
    );
  }
  if (attribute !== undefined && !ATTRIBUTES_BY_MEDIA[media].includes(attribute)) {
    const valid = ATTRIBUTES_BY_MEDIA[media];
    throw new InvalidArgumentError(
      `attribute "${attribute}" is not valid for media "${media}".`,
      valid.length > 0
        ? `Valid attribute values for media "${media}": ${valid.join(', ')}. Or change media.`
        : `Apple supports no attribute for media "${media}"; omit it.`,
    );
  }
}

/** Entities a lookup can list related items for — Apple uses one entity vocabulary for search and lookup. */
export const LOOKUP_ENTITIES = SEARCH_ENTITIES;

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

/** Chart name → the path segments of Apple's RSS feed generator (verified live, 2026-09). */
export const CHARTS = {
  'music-songs': { media: 'music', feed: 'most-played', type: 'songs' },
  'music-albums': { media: 'music', feed: 'most-played', type: 'albums' },
  'music-videos': { media: 'music', feed: 'most-played', type: 'music-videos' },
  'music-playlists': { media: 'music', feed: 'most-played', type: 'playlists' },
  podcasts: { media: 'podcasts', feed: 'top', type: 'podcasts' },
  'podcast-episodes': { media: 'podcasts', feed: 'top', type: 'podcast-episodes' },
  'podcast-channels': { media: 'podcasts', feed: 'top-subscriber', type: 'podcast-channels' },
  'apps-free': { media: 'apps', feed: 'top-free', type: 'apps' },
  'apps-paid': { media: 'apps', feed: 'top-paid', type: 'apps' },
  'books-free': { media: 'books', feed: 'top-free', type: 'books' },
  'books-paid': { media: 'books', feed: 'top-paid', type: 'books' },
  audiobooks: { media: 'audio-books', feed: 'top', type: 'audio-books' },
} as const satisfies Record<string, { media: string; feed: string; type: string }>;

export type ChartName = keyof typeof CHARTS;
export const CHART_NAMES = Object.keys(CHARTS) as [ChartName, ...ChartName[]];

/** Apple's chart feeds serve at most the top 100 (limit 101 answers HTTP 500). */
export const MAX_CHART_POSITIONS = 100;
/** Apple's search and lookup serve at most 200 results (a larger lookup limit silently falls back to the default). */
export const MAX_ITUNES_RESULTS = 200;

// ---------------------------------------------------------------------------
// Storefront / country
// ---------------------------------------------------------------------------

const STOREFRONT_RE = /^[a-z]{2}$/i;

/**
 * The two-letter store to query: the caller's value, else APPLE_MUSIC_STOREFRONT
 * (the same default the Apple Music tools use), else `us`. Read at CALL time.
 *
 * A malformed APPLE_MUSIC_STOREFRONT is an error, not a silent fallback to
 * `us`: the storefront decides WHICH store answers, so quietly searching the
 * wrong country would return confident, wrong results.
 */
export function resolveStorefront(explicit: string | undefined, field: string): string {
  if (explicit !== undefined) {
    if (!STOREFRONT_RE.test(explicit)) {
      throw new InvalidArgumentError(
        `${field} "${explicit}" is not a two-letter country code.`,
        'Use an ISO 3166-1 alpha-2 code such as us, gb, ca, jp or de.',
      );
    }
    return explicit.toLowerCase();
  }
  const env = readEnvVar('APPLE_MUSIC_STOREFRONT');
  if (env === undefined) return 'us';
  if (!STOREFRONT_RE.test(env)) {
    throw new ConfigError(
      'itunes',
      `APPLE_MUSIC_STOREFRONT "${env}" is not a two-letter country code, so the default store is unknown.`,
      ['APPLE_MUSIC_STOREFRONT'],
      `Set APPLE_MUSIC_STOREFRONT to an ISO 3166-1 alpha-2 code such as us or gb, or pass ${field} explicitly.`,
    );
  }
  return env.toLowerCase();
}

// ---------------------------------------------------------------------------
// Lookup keys
// ---------------------------------------------------------------------------

/**
 * An ISBN as Apple looks books up: 13 digits. A valid ISBN-10 is converted
 * (978 prefix, recomputed check digit); hyphens and spaces are ignored. A
 * failing check digit is refused — it is a typo, and a typo'd ISBN can match
 * a different real book.
 */
export function normalizeIsbn(raw: string): string {
  const s = raw.replace(/[\s-]/g, '').toUpperCase();
  const bad = (why: string): never => {
    throw new InvalidArgumentError(`isbn "${raw}" is not a valid ISBN: ${why}.`, 'Pass a 13-digit ISBN (978…/979…) or a 10-digit ISBN.');
  };
  if (/^\d{13}$/.test(s)) {
    if (!/^97[89]/.test(s)) return bad('a 13-digit ISBN starts with 978 or 979');
    if (isbn13Check(s.slice(0, 12)) !== s[12]) return bad('the check digit does not match');
    return s;
  }
  if (/^\d{9}[\dX]$/.test(s)) {
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (10 - i) * (s[i] === 'X' ? 10 : Number(s[i]));
    if (sum % 11 !== 0) return bad('the check digit does not match');
    const core = `978${s.slice(0, 9)}`;
    return core + isbn13Check(core);
  }
  return bad('expected 10 or 13 digits');
}

function isbn13Check(twelve: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}
