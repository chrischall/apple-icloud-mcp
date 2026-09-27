import { formatDateOnly, putInstant, ymdInZone, zonedParts } from '../time.js';

/**
 * The `compact` rung for iTunes records and chart entries.
 *
 * Compact keeps Apple's own field names for everything a caller acts on — above
 * all `trackId` / `collectionId` / `artistId`, which ARE Apple Music catalog
 * ids — and drops artwork URLs, 30-second preview URLs, prices (apart from an
 * app's or book's `formattedPrice`), censored-name duplicates, store/currency
 * boilerplate and long descriptions. `full` is Apple's record verbatim.
 *
 * Dates: a song's, album's, book's or video's `releaseDate` is a store release
 * DATE wearing an instant's clothes. Apple mostly stamps it midnight Pacific
 * (`1997-05-21T07:00:00Z`) — rendered as an instant in a zone west of Pacific
 * that is the previous evening, so the album would appear to come out a day
 * early — and some releases carry other stamps (`2025-09-30T12:00:00Z`, seen
 * live), whose clock time means nothing. So for those types the value is
 * emitted as the calendar date it denotes (`YYYY-MM-DD`): the Pacific date for
 * a midnight-Pacific stamp, else the date Apple wrote. A podcast's and an
 * episode's publish time and an app's build time are real instants and carry
 * an explicit offset in the display zone.
 */

const APPLE_STORE_ZONE = 'America/Los_Angeles';
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Put a string field when present. */
function putStr(out: Record<string, unknown>, key: string, v: unknown): void {
  const s = str(v);
  if (s !== undefined) out[key] = s;
}

function putNum(out: Record<string, unknown>, key: string, v: unknown): void {
  const n = num(v);
  if (n !== undefined) out[key] = n;
}

/** Ids are what a caller acts on, so one that drifted from number to string (or back) is kept as sent, never dropped. */
function putId(out: Record<string, unknown>, key: string, v: unknown): void {
  if (num(v) !== undefined || str(v) !== undefined) out[key] = v;
}

/**
 * `field` + `fieldDisplay` for an Apple date/time string. A bare `YYYY-MM-DD`
 * stays a date; a `…Z` stamp becomes a date when `storeDate` (see above), else
 * an instant rendered in `zone` with its offset. A value in neither shape is
 * passed through untouched (it is Apple's text, labelled by its own shape)
 * rather than dropped or guessed at.
 */
export function putAppleDate(out: Record<string, unknown>, field: string, value: unknown, zone: string, opts: { storeDate: boolean }): void {
  const s = str(value);
  if (s === undefined) return;
  if (DATE_ONLY_RE.test(s)) {
    out[field] = s;
    out[`${field}Display`] = formatDateOnly(s);
    return;
  }
  const ms = ISO_INSTANT_RE.test(s) ? Date.parse(s) : Number.NaN;
  if (Number.isNaN(ms)) {
    out[field] = s;
    return;
  }
  const date = new Date(ms);
  if (opts.storeDate) {
    const p = zonedParts(date, APPLE_STORE_ZONE);
    // The string ends in Z, so its first ten characters are the date Apple wrote.
    const ymd = p.hour === 0 && p.minute === 0 && p.second === 0 ? ymdInZone(date, APPLE_STORE_ZONE) : s.slice(0, 10);
    out[field] = ymd;
    out[`${field}Display`] = formatDateOnly(ymd);
    return;
  }
  putInstant(out, field, date, zone);
}

/** `4:59`, or `1:17:24` from an hour up — whole seconds, truncated the way Apple's apps show them. */
export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** `song`, `album`, `artist`, `podcast`, `podcast-episode`, `software`, `ebook`, `audiobook`, … */
export function recordType(r: Record<string, unknown>): string {
  const kind = str(r.kind);
  if (kind !== undefined) return kind;
  const wrapper = str(r.wrapperType);
  if (wrapper === 'collection') return str(r.collectionType)?.toLowerCase() ?? 'collection';
  return wrapper ?? 'unknown';
}

/** The id that names the record itself: a track's trackId, else its collectionId, else its artistId. */
export function primaryId(r: Record<string, unknown>): string | undefined {
  for (const key of ['trackId', 'collectionId', 'artistId']) {
    const v = r[key];
    if (typeof v === 'number' || (typeof v === 'string' && v.length > 0)) return String(v);
  }
  return undefined;
}

const COLLECTION_TYPES = new Set(['album', 'compilation', 'collection', 'audiobook']);
/** Types whose releaseDate is a real publish instant (a show's newest episode, an episode, an app build). */
const INSTANT_TYPES = new Set(['podcast', 'podcast-episode', 'software', 'mac-software', 'software-package']);

/** Compact projection of one iTunes Search/Lookup record. Throws on a non-object so `projectOrRaw` falls back. */
export function compactItunesRecord(r: unknown, zone: string): Record<string, unknown> {
  if (!isRecord(r)) throw new Error('an iTunes result is not an object');
  const type = recordType(r);
  const out: Record<string, unknown> = { type };
  putId(out, 'trackId', r.trackId);
  putStr(out, 'trackName', r.trackName);
  putId(out, 'collectionId', r.collectionId);
  putStr(out, 'collectionName', r.collectionName);
  putId(out, 'artistId', r.artistId);
  putStr(out, 'artistName', r.artistName);
  putAppleDate(out, 'releaseDate', r.releaseDate, zone, { storeDate: !INSTANT_TYPES.has(type) });
  // A podcast's trackTimeMillis is not a duration (The Daily: 4644).
  const ms = type === 'podcast' ? undefined : num(r.trackTimeMillis);
  if (ms !== undefined) {
    out.duration = formatDuration(ms);
    out.durationMs = ms;
  }
  putNum(out, 'trackNumber', r.trackNumber);
  putNum(out, 'trackCount', r.trackCount);
  putNum(out, 'discNumber', r.discNumber);
  putNum(out, 'discCount', r.discCount);
  putStr(out, 'primaryGenreName', r.primaryGenreName);
  putStr(out, 'explicitness', r.trackExplicitness ?? r.collectionExplicitness);
  putStr(out, 'contentAdvisoryRating', r.contentAdvisoryRating);
  if (typeof r.isStreamable === 'boolean') out.isStreamable = r.isStreamable;
  putStr(out, 'formattedPrice', r.formattedPrice);
  putNum(out, 'averageUserRating', r.averageUserRating);
  putNum(out, 'userRatingCount', r.userRatingCount);
  putStr(out, 'bundleId', r.bundleId);
  putStr(out, 'version', r.version);
  putStr(out, 'sellerName', r.sellerName);
  putAppleDate(out, 'currentVersionReleaseDate', r.currentVersionReleaseDate, zone, { storeDate: false });
  putStr(out, 'episodeGuid', r.episodeGuid);
  putStr(out, 'feedUrl', r.feedUrl);
  putStr(out, 'episodeUrl', r.episodeUrl);
  putStr(out, 'shortDescription', r.shortDescription);
  const url =
    type === 'artist'
      ? (str(r.artistLinkUrl) ?? str(r.artistViewUrl))
      : COLLECTION_TYPES.has(type)
        ? (str(r.collectionViewUrl) ?? str(r.trackViewUrl))
        : (str(r.trackViewUrl) ?? str(r.collectionViewUrl));
  if (url !== undefined) out.url = url;
  return out;
}

/** The album of a charted song, or the show of a charted episode, from Apple's store URL. */
function collectionIdFromUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const m = /\/album\/[^/?#]+\/(\d+)\?(?:[^#]*&)?i=\d+/.exec(url) ?? /\/podcast\/[^/?#]+\/id(\d+)\?(?:[^#]*&)?i=\d+/.exec(url);
  return m?.[1];
}

/** Compact projection of one chart entry; `rank` is its 1-based chart position. */
export function compactChartEntry(r: unknown, rank: number, zone: string): Record<string, unknown> {
  if (!isRecord(r)) throw new Error('a chart entry is not an object');
  const out: Record<string, unknown> = { rank };
  putId(out, 'id', r.id);
  putStr(out, 'name', r.name);
  putStr(out, 'artistName', r.artistName);
  putId(out, 'artistId', r.artistId);
  const collectionId = collectionIdFromUrl(str(r.url));
  if (collectionId !== undefined) out.collectionId = collectionId;
  // Chart release dates are plain dates (`2026-09-24`).
  putAppleDate(out, 'releaseDate', r.releaseDate, zone, { storeDate: true });
  if (Array.isArray(r.genres)) {
    const names = r.genres.map((g) => (isRecord(g) ? str(g.name) : undefined)).filter((n): n is string => n !== undefined);
    if (names.length > 0) out.genres = names;
  }
  // Apple spells it "Explict" in these feeds.
  const rating = str(r.contentAdvisoryRating);
  if (rating !== undefined && /^(explicit|explict)$/i.test(rating)) out.explicit = true;
  putStr(out, 'url', r.url);
  return out;
}
