import { putInstant } from '../time.js';
import { compactObject } from '../tools/_shared.js';
import { formatDistance, formatDuration } from './format.js';

/**
 * The `compact` rung of the Maps tools: the fields a caller acts on (ids,
 * coordinates, a one-line address, distances and times in both units) and
 * none of the bulk (display regions, the structured copy of the address,
 * alternate ids, step polylines). `full` is Apple's record verbatim.
 *
 * Every projector THROWS on a shape it does not recognise — callers wrap it
 * in `projectOrRaw`, which then returns Apple's payload whole and warns on
 * stderr. A projector that quietly returned `{}` would be indistinguishable
 * from "Apple found nothing", which is the false negative this fleet refuses
 * to produce.
 */

export type Rec = Record<string, unknown>;

export function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  return out.length ? out : undefined;
}

function lower(v: unknown): string | undefined {
  return str(v)?.toLowerCase();
}

/** Apple's `formattedAddressLines` as one line (`"1 Apple Park Way, Cupertino, CA 95014, United States"`). */
export function oneLineAddress(lines: unknown): string | undefined {
  const arr = strArray(lines);
  return arr?.map((l) => l.replace(/\s+/g, ' ').trim()).join(', ');
}

/**
 * A place (geocode/search/lookup result, or a directions endpoint).
 * Directions responses carry the point as `center` rather than `coordinate`
 * (Apple's own example) — both are read.
 */
export function compactPlace(p: unknown): Rec {
  if (!isRecord(p)) throw new Error('a place is not an object');
  const coord = isRecord(p.coordinate) ? p.coordinate : isRecord(p.center) ? p.center : undefined;
  const out = compactObject({
    id: str(p.id),
    name: str(p.name),
    category: str(p.poiCategory),
    latitude: num(coord?.latitude),
    longitude: num(coord?.longitude),
    address: oneLineAddress(p.formattedAddressLines),
    countryCode: str(p.countryCode),
    telephone: str(p.telephone),
    urls: strArray(p.urls),
  });
  if (out.name === undefined && out.latitude === undefined && out.address === undefined) {
    throw new Error('a place has no name, coordinate or address');
  }
  return out;
}

export function compactPlaces(list: readonly unknown[]): Rec[] {
  return list.map(compactPlace);
}

/** When a route or ETA was computed for: the traffic-aware time is relative to this. */
export interface TravelTiming {
  zone: string;
  /** Departure instant (the requested one, or "now" when neither was given). */
  departure?: Date;
  /** Requested arrival instant (then `leaveBy` is derived instead of `estimatedArrival`). */
  arrival?: Date;
}

/** Adds `estimatedArrival` (from a departure) or `leaveBy` (from an arrival) for a duration. */
export function putTravelTimes(target: Rec, durationSeconds: number | undefined, timing: TravelTiming): void {
  if (durationSeconds === undefined) return;
  if (timing.arrival) {
    putInstant(target, 'leaveBy', new Date(timing.arrival.getTime() - durationSeconds * 1000), timing.zone);
  } else if (timing.departure) {
    putInstant(target, 'estimatedArrival', new Date(timing.departure.getTime() + durationSeconds * 1000), timing.zone);
  }
}

function compactStep(s: unknown, index: number): Rec | undefined {
  if (!isRecord(s)) throw new Error(`step ${index} is missing or not an object`);
  const distanceMeters = num(s.distanceMeters);
  const durationSeconds = num(s.durationSeconds);
  const instructions = str(s.instructions);
  // The first step of every route is the start point: no instruction, 0 m.
  if (instructions === undefined && !distanceMeters) return undefined;
  return compactObject({
    instructions,
    distance: distanceMeters !== undefined ? formatDistance(distanceMeters) : undefined,
    duration: durationSeconds !== undefined ? formatDuration(durationSeconds) : undefined,
    transportType: lower(s.transportType),
  });
}

function compactRoute(r: unknown, steps: unknown[] | undefined, timing: TravelTiming): Rec {
  if (!isRecord(r)) throw new Error('a route is not an object');
  const distanceMeters = num(r.distanceMeters);
  const durationSeconds = num(r.durationSeconds);
  if (distanceMeters === undefined && durationSeconds === undefined) throw new Error('a route has no distance or duration');
  const route: Rec = compactObject({
    name: str(r.name),
    distanceMeters,
    distance: distanceMeters !== undefined ? formatDistance(distanceMeters) : undefined,
    durationSeconds,
    duration: durationSeconds !== undefined ? formatDuration(durationSeconds) : undefined,
    hasTolls: typeof r.hasTolls === 'boolean' ? r.hasTolls : undefined,
    transportType: lower(r.transportType),
  });
  putTravelTimes(route, durationSeconds, timing);
  if (steps !== undefined && Array.isArray(r.stepIndexes)) {
    route.steps = r.stepIndexes
      .map((i) => compactStep(typeof i === 'number' ? steps[i] : undefined, typeof i === 'number' ? i : -1))
      .filter((s): s is Rec => s !== undefined);
  }
  return route;
}

/** A `/v1/directions` response → `{origin?, destination?, routes}` with per-route steps. */
export function compactDirections(raw: unknown, timing: TravelTiming): Rec {
  if (!isRecord(raw)) throw new Error('the directions response is not an object');
  const routes = raw.routes ?? [];
  if (!Array.isArray(routes)) throw new Error('routes is not an array');
  const steps = raw.steps;
  if (steps !== undefined && !Array.isArray(steps)) throw new Error('steps is not an array');
  return compactObject({
    origin: raw.origin !== undefined ? compactPlace(raw.origin) : undefined,
    destination: raw.destination !== undefined ? compactPlace(raw.destination) : undefined,
    routes: routes.map((r) => compactRoute(r, steps, timing)),
  });
}

/** One requested ETA destination. */
export interface EtaDestination {
  /** 0-based position in the request. */
  index: number;
  /** `lat,lng` as sent. */
  value: string;
  latitude: number;
  longitude: number;
}

export interface EtaMatch {
  destination: EtaDestination;
  eta: Rec;
}

export interface EtaMatching {
  matched: EtaMatch[];
  /** Requested destinations Apple returned no ETA for. */
  missing: EtaDestination[];
  /** ETAs that could not be tied to a requested destination. */
  unmatched: unknown[];
}

/** Apple echoes the destination it was given; allow for float round-trip (≈10 m). */
const ECHO_TOLERANCE_DEG = 1e-4;

function etaPoint(eta: unknown): { latitude: number; longitude: number } | undefined {
  if (!isRecord(eta) || !isRecord(eta.destination)) return undefined;
  const latitude = num(eta.destination.latitude);
  const longitude = num(eta.destination.longitude);
  return latitude !== undefined && longitude !== undefined ? { latitude, longitude } : undefined;
}

/**
 * Pair Apple's ETAs with the requested destinations. By echoed coordinate
 * first — the NEAREST unpaired destination within the tolerance, so two
 * destinations a few metres apart (two shops in one mall) are not swapped
 * when Apple answers out of order; then, only when exactly as many ETAs as
 * destinations are left over, by order. Anything else stays unpaired and is
 * REPORTED — a missing destination is never silently dropped.
 */
export function matchEtas(etas: readonly unknown[], destinations: readonly EtaDestination[]): EtaMatching {
  const pairedEta = new Set<number>();
  const pairedDest = new Set<number>();
  const matched: EtaMatch[] = [];
  etas.forEach((eta, ei) => {
    const p = etaPoint(eta);
    if (!p) return;
    let d: EtaDestination | undefined;
    let best = Number.POSITIVE_INFINITY;
    for (const dest of destinations) {
      if (pairedDest.has(dest.index)) continue;
      const dLat = Math.abs(dest.latitude - p.latitude);
      const dLng = Math.abs(dest.longitude - p.longitude);
      if (dLat > ECHO_TOLERANCE_DEG || dLng > ECHO_TOLERANCE_DEG) continue;
      const dist = dLat + dLng;
      if (dist < best) {
        best = dist;
        d = dest;
      }
    }
    if (d) {
      pairedEta.add(ei);
      pairedDest.add(d.index);
      matched.push({ destination: d, eta: eta as Rec });
    }
  });
  const restEtas = etas.map((eta, ei) => ({ eta, ei })).filter((x) => !pairedEta.has(x.ei));
  const restDests = destinations.filter((d) => !pairedDest.has(d.index));
  if (restEtas.length > 0 && restEtas.length === restDests.length && restEtas.every((x) => isRecord(x.eta))) {
    restEtas.forEach((x, i) => matched.push({ destination: restDests[i]!, eta: x.eta as Rec }));
    matched.sort((a, b) => a.destination.index - b.destination.index);
    return { matched, missing: [], unmatched: [] };
  }
  matched.sort((a, b) => a.destination.index - b.destination.index);
  return { matched, missing: restDests, unmatched: restEtas.map((x) => x.eta) };
}

/** One ETA, compact. Throws when it carries neither a distance nor a travel time (a renamed field, not an answer). */
export function compactEta(m: EtaMatch, timing: TravelTiming): Rec {
  const e = m.eta;
  const distanceMeters = num(e.distanceMeters);
  const expected = num(e.expectedTravelTimeSeconds);
  const staticSeconds = num(e.staticTravelTimeSeconds);
  if (distanceMeters === undefined && expected === undefined && staticSeconds === undefined) {
    throw new Error(`the ETA for destination ${m.destination.index} has no distance or travel time`);
  }
  const out: Rec = compactObject({
    destinationIndex: m.destination.index,
    destination: m.destination.value,
    distanceMeters,
    distance: distanceMeters !== undefined ? formatDistance(distanceMeters) : undefined,
    expectedTravelTimeSeconds: expected,
    travelTime: expected !== undefined ? formatDuration(expected) : undefined,
    staticTravelTimeSeconds: staticSeconds,
    travelTimeWithoutTraffic: staticSeconds !== undefined ? formatDuration(staticSeconds) : undefined,
    transportType: lower(e.transportType),
  });
  putTravelTimes(out, expected, timing);
  return out;
}
