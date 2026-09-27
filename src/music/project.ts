import { projectOrRaw, type View } from '@chrischall/mcp-utils';
import { formatDateOnly, putInstant } from '../time.js';

/**
 * The `compact` projection of Apple Music resources: everything a caller acts
 * on (ids above all — a library id, the catalog id behind it, the type), the
 * names a person recognises, and nothing else. Artwork, preview URLs,
 * `playParams` blobs and colour palettes are dropped; `view: "full"` returns
 * Apple's record verbatim.
 *
 * Every instant is re-emitted with an explicit offset in the display zone plus
 * a `…Display` label; a date-only value (`releaseDate`) stays `YYYY-MM-DD`.
 */

/** A JSON:API resource as Apple sends it (only the fields read here are typed). */
export interface AppleResource {
  id: string;
  type: string;
  href?: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: AppleResource[]; next?: string; href?: string } | undefined>;
  views?: Record<string, { data?: AppleResource[]; next?: string; attributes?: Record<string, unknown> } | undefined>;
  meta?: Record<string, unknown>;
}

export const LABEL = 'apple-cloud-mcp';

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/** A resource's attributes, or `{}` when Apple sent none. */
export function attrs(r: AppleResource): Record<string, unknown> {
  return isRecord(r.attributes) ? r.attributes : {};
}

/** A resource's display name, else `fallback` (its id by default). */
export function nameOf(r: AppleResource, fallback: string = r.id): string {
  return resourceName(r) ?? fallback;
}

/** The `id` of `doc.data[0]`, when there is one (a created resource, a storefront). */
export function firstDataId(doc: unknown): string | undefined {
  const first = isRecord(doc) && Array.isArray(doc.data) ? doc.data[0] : undefined;
  return isRecord(first) ? str(first.id) : undefined;
}

/** `3:25`, or `1:02:03` past an hour. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Put a date or instant Apple sent as a string. `YYYY-MM-DD` stays a date
 * (plus a weekday label); a parseable timestamp becomes an offset instant in
 * `zone`; anything else is passed through untouched rather than guessed at.
 */
export function putDate(target: Record<string, unknown>, field: string, value: unknown, zone: string): void {
  if (typeof value !== 'string' || value.length === 0) return;
  if (YMD_RE.test(value)) {
    target[field] = value;
    const d = new Date(`${value}T00:00:00Z`);
    // Only a real calendar date gets a label (Date rolls 02-30 over into March).
    if (!Number.isNaN(d.getTime()) && d.toISOString().startsWith(value)) target[`${field}Display`] = formatDateOnly(value);
    return;
  }
  // Only a full timestamp is an instant: a bare year ("1975") parses as UTC
  // midnight and would be shifted into the previous year by a western zone.
  const t = /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(t)) {
    target[field] = value;
    return;
  }
  putInstant(target, field, new Date(t), zone);
}

/** The name Apple gives a resource (`name`, or a recommendation's `title.stringForDisplay`). */
export function resourceName(r: AppleResource): string | undefined {
  const a = attrs(r);
  return str(a.name) ?? (isRecord(a.title) ? str(a.title.stringForDisplay) : undefined);
}

/** The catalog id behind a library item (`playParams.catalogId`; a library playlist's `globalId`). */
export function catalogIdOf(r: AppleResource): string | undefined {
  const a = attrs(r);
  const pp = isRecord(a.playParams) ? a.playParams : {};
  return str(pp.catalogId) ?? str(pp.globalId);
}

/** The compact form of one resource. */
export function compactResource(r: AppleResource, zone: string): Record<string, unknown> {
  const a = attrs(r);
  const out: Record<string, unknown> = { id: r.id, type: r.type };
  const name = resourceName(r);
  if (name !== undefined) out.name = name;
  for (const k of ['artistName', 'albumName', 'curatorName'] as const) {
    const v = str(a[k]);
    if (v !== undefined) out[k] = v;
  }
  const ms = num(a.durationInMillis);
  if (ms !== undefined) {
    out.duration = formatDuration(ms);
    out.durationMs = ms;
  }
  putDate(out, 'releaseDate', a.releaseDate, zone);
  for (const k of ['trackNumber', 'discNumber', 'trackCount', 'playCount'] as const) {
    const v = num(a[k]);
    if (v !== undefined) out[k] = v;
  }
  for (const k of ['isrc', 'contentRating', 'url'] as const) {
    const v = str(a[k]);
    if (v !== undefined) out[k] = v;
  }
  if (Array.isArray(a.genreNames)) {
    const genres = a.genreNames.filter((g): g is string => typeof g === 'string');
    if (genres.length > 0) out.genreNames = genres;
  }
  const catalogId = catalogIdOf(r);
  if (catalogId !== undefined && catalogId !== r.id) out.catalogId = catalogId;
  putDate(out, 'dateAdded', a.dateAdded, zone);
  putDate(out, 'lastModifiedDate', a.lastModifiedDate, zone);
  for (const k of ['canEdit', 'isPublic', 'hasCatalog', 'isLive'] as const) {
    const v = bool(a[k]);
    if (v !== undefined) out[k] = v;
  }
  const description = str(a.description) ?? (isRecord(a.description) ? (str(a.description.standard) ?? str(a.description.short)) : undefined);
  if (description !== undefined) out.description = description;
  const notes = isRecord(a.editorialNotes) ? (str(a.editorialNotes.short) ?? str(a.editorialNotes.tagline)) : undefined;
  if (notes !== undefined) out.editorialNotes = notes;
  return out;
}

/**
 * Project a whole array for `view`. `full` is Apple's records verbatim;
 * `compact` goes through `projectOrRaw`, so a projection that trips on a
 * changed upstream shape returns the raw array (and says so on stderr) rather
 * than a page of holes.
 */
export function projectList(items: AppleResource[], view: View, zone: string, context: string): unknown[] {
  if (view !== 'compact') return items;
  return projectOrRaw(items, (arr) => arr.map((r) => compactResource(r, zone)), { label: LABEL, context });
}

/** Project a single resource for `view`. */
export function projectOne(item: AppleResource, view: View, zone: string, context: string): unknown {
  return projectList([item], view, zone, context)[0];
}
