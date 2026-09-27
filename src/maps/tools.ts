import type { McpServer } from '@modelcontextprotocol/server';
import { parseLenient, projectOrRaw, resolveView, viewParam } from '@chrischall/mcp-utils';
import { z } from 'zod';
import { canonicalTimeZone, getDisplayTimeZone } from '../config.js';
import { InvalidArgumentError, UpstreamError } from '../errors.js';
import type { QueryValue } from '../http.js';
import { parseDateInput, putInstant } from '../time.js';
import { ANNOTATIONS, compactObject, defineTool, jsonResponse } from '../tools/_shared.js';
import { MapsClient } from './client.js';
import { assertCoordinateInRange, formatCoordinate, parseLocation, type Coordinate } from './location.js';
import {
  compactDirections,
  compactEta,
  compactPlaces,
  isRecord,
  matchEtas,
  type EtaDestination,
  type Rec,
  type TravelTiming,
} from './project.js';
import { buildSignedSnapshotUrl } from './snapshot.js';

/**
 * Apple Maps Server API tools (research: apple-dev-apis.md §1–2). All seven
 * are reads — geocoding, search, directions, ETAs, place lookup and a
 * locally signed snapshot URL — so every write mode registers them.
 *
 * Nothing here reads the environment at registration: the developer key is
 * resolved inside each handler (a missing key is a `ConfigError` on the
 * first call, not a missing tool).
 */

export interface MapsDeps {
  /** The Maps client (token cache + HTTP). Default: one lazily built, process-wide client. */
  client?: MapsClient;
  /** Clock for "depart now" and snapshot expiry. Default: the client's clock. */
  now?: () => number;
}

let defaultClient: MapsClient | undefined;

/** The process-wide client, so the access-token cache survives across tool calls. */
export function defaultMapsClient(): MapsClient {
  defaultClient ??= new MapsClient();
  return defaultClient;
}

/** Test seam: drop the process-wide client (and its token cache). */
export function resetDefaultMapsClient(): void {
  defaultClient = undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LABEL = 'apple-icloud-mcp';
const VIEWS = ['compact', 'full'] as const;

/** Apple's `PoiCategory` values (Maps Server API docs, 77 values). */
export const POI_CATEGORIES = [
  'Airport', 'AirportGate', 'AirportTerminal', 'AmusementPark', 'AnimalService', 'Aquarium', 'ATM', 'AutomotiveRepair',
  'Bakery', 'Bank', 'Baseball', 'Basketball', 'Beach', 'Beauty', 'Bowling', 'Brewery', 'Cafe', 'Campground', 'CarRental',
  'Castle', 'ConventionCenter', 'Distillery', 'EVCharger', 'Fairground', 'FireStation', 'Fishing', 'FitnessCenter',
  'FoodMarket', 'Fortress', 'GasStation', 'GoKart', 'Golf', 'Hiking', 'Hospital', 'Hotel', 'Kayaking', 'Landmark',
  'Laundry', 'Library', 'Mailbox', 'Marina', 'MiniGolf', 'MovieTheater', 'Museum', 'MusicVenue', 'NationalMonument',
  'NationalPark', 'Nightlife', 'Park', 'Parking', 'Pharmacy', 'Planetarium', 'Playground', 'Police', 'PostOffice',
  'PublicTransport', 'ReligiousSite', 'Restaurant', 'Restroom', 'RockClimbing', 'RVPark', 'School', 'SkatePark',
  'Skating', 'Skiing', 'Soccer', 'Spa', 'Stadium', 'Store', 'Surfing', 'Swimming', 'Tennis', 'Theater', 'University',
  'Volleyball', 'Winery', 'Zoo',
] as const;

/** Apple's `SearchResultType` values. */
export const RESULT_TYPES = ['poi', 'address', 'physicalFeature', 'pointOfInterest'] as const;

const DIRECTIONS_TRANSPORT = ['automobile', 'walking', 'cycling'] as const;
const ETA_TRANSPORT = ['automobile', 'transit', 'walking', 'cycling'] as const;
const APPLE_TRANSPORT: Record<(typeof ETA_TRANSPORT)[number], string> = {
  automobile: 'Automobile',
  transit: 'Transit',
  walking: 'Walking',
  cycling: 'Cycling',
};

const PLACE_ERROR_MEANING: Record<string, string> = {
  FAILED_INVALID_ID: 'the id is malformed',
  FAILED_NOT_FOUND: 'no place has this id',
  FAILED_INTERNAL_ERROR: 'Apple had an internal error for this id — retry it',
};

const KEY_NOTE =
  'Needs an Apple Developer key with MapKit JS enabled: APPLE_TEAM_ID + APPLE_KEY_ID + APPLE_PRIVATE_KEY ' +
  '(or APPLE_MAPS_KEY_ID / APPLE_MAPS_PRIVATE_KEY).';

/** Snapshot limits (Apple docs: width/height 50–640, zoom 3–20, scale 1–3). */
const SNAPSHOT_MIN_PX = 50;
const SNAPSHOT_MAX_PX = 640;
const SNAPSHOT_MAX_ANNOTATIONS = 50;
/** Glyphs auto-assigned to labelled pins: Apple allows one character from a-z, A-Z, 0-9. */
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefghijklmnopqrstuvwxyz';
/** Above this, note that Apple may refuse the URL as too large (HTTP 413; the exact limit is undocumented). */
const LONG_URL_CHARS = 8000;

// ---------------------------------------------------------------------------
// Schema atoms
// ---------------------------------------------------------------------------

const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

const latitudeParam = z.number().min(-90).max(90);
const longitudeParam = z.number().min(-180).max(180);

const nearParam = z
  .strictObject({
    latitude: latitudeParam.describe('Latitude, -90 to 90.'),
    longitude: longitudeParam.describe('Longitude, -180 to 180.'),
  })
  .optional()
  .describe('Bias results toward this point (e.g. where the user is). A hint, not a filter: farther results can still appear.');

const langParam = z
  .string()
  .regex(LANG_RE)
  .optional()
  .describe('Language for names and addresses, as a BCP 47 tag such as en-US, fr-FR or ja-JP (default en-US).');

const countriesParam = z
  .array(z.string().regex(/^[A-Za-z]{2}$/))
  .min(1)
  .max(25)
  .optional()
  .describe('Only return results in these countries: ISO 3166-1 alpha-2 codes, e.g. ["US","CA"].');

const timeZoneParam = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe('IANA time zone (e.g. America/New_York) used to read a date without an offset and to display times. Default: the server display zone (DISPLAY_TZ).');

function travelDateParam(what: 'departure' | 'arrival'): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe(
      `Desired ${what} time for traffic-aware estimates: YYYY-MM-DDTHH:MM (local time in timeZone) or ISO with Z/offset. ` +
        (what === 'departure' ? 'Default: now. ' : '') +
        'Give departureDate or arrivalDate, not both.',
    );
}

function viewNote(note: string): ReturnType<typeof viewParam> {
  return viewParam(VIEWS, { note });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The zone for this call — the argument, else the display zone — in its
 * canonical spelling (`america/new_york` → `America/New_York`), the same
 * spelling DISPLAY_TZ resolves to. Intl is case-insensitive, so validating
 * alone echoed the caller's spelling back as the response's `timeZone`.
 */
function resolveZone(tz: string | undefined): string {
  if (tz === undefined) return getDisplayTimeZone();
  const zone = canonicalTimeZone(tz);
  if (zone === undefined) {
    throw new InvalidArgumentError(`timeZone "${tz}" is not a known IANA time zone.`, 'Use a zone name like America/New_York or Europe/London.');
  }
  return zone;
}

function nearValue(near: Coordinate | undefined): string | undefined {
  if (near === undefined) return undefined;
  assertCoordinateInRange(near, 'near');
  return formatCoordinate(near);
}

function upperCountries(list: string[] | undefined): string[] | undefined {
  return list?.map((c) => c.toUpperCase());
}

function requireText(value: string, field: string): string {
  const v = value.trim();
  if (!v) throw new InvalidArgumentError(`${field} is empty.`);
  return v;
}

/** A travel time for Apple: must carry a time of day; returned as the instant. */
function parseTravelDate(value: string | undefined, field: string, zone: string): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = parseDateInput(value, field, zone);
  if (parsed.dateOnly) {
    throw new InvalidArgumentError(
      `${field} "${value}" has no time of day; a travel estimate needs one.`,
      `Use YYYY-MM-DDTHH:MM (local time in ${zone}), or an ISO time with Z or an offset.`,
    );
  }
  return parsed.instant;
}

/** Apple wants ISO-8601 in UTC with no fractional seconds: `2026-10-03T20:30:00Z`. */
function appleUtc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Travel timing shared by directions and ETAs. */
function travelTiming(
  args: { departureDate?: string; arrivalDate?: string; timeZone?: string },
  now: () => number,
): { zone: string; departure?: Date; arrival?: Date; timing: TravelTiming; head: Rec } {
  const zone = resolveZone(args.timeZone);
  if (args.departureDate !== undefined && args.arrivalDate !== undefined) {
    throw new InvalidArgumentError('Give departureDate or arrivalDate, not both.', 'Apple estimates a trip either from a departure time or toward an arrival time.');
  }
  const departure = parseTravelDate(args.departureDate, 'departureDate', zone);
  const arrival = parseTravelDate(args.arrivalDate, 'arrivalDate', zone);
  const head: Rec = {};
  let timing: TravelTiming;
  if (arrival) {
    head.timeBasis = 'arriveBy';
    putInstant(head, 'arrival', arrival, zone);
    timing = { zone, arrival };
  } else {
    head.timeBasis = departure ? 'departAt' : 'departNow';
    const effective = departure ?? new Date(now());
    putInstant(head, 'departure', effective, zone);
    timing = { zone, departure: effective };
  }
  return { zone, ...(departure ? { departure } : {}), ...(arrival ? { arrival } : {}), timing, head };
}

/** Throw unless the 200 body is a JSON object — a null/HTML body must never read as "nothing found". */
function expectObject(data: unknown, status: number, context: string): Rec {
  if (!isRecord(data)) {
    throw new UpstreamError('maps', status, `maps: ${context} returned an unexpected body (not a JSON object).`, {
      hint: 'Apple Maps may be degraded or the API may have changed. Retry later.',
    });
  }
  return data;
}

/**
 * A list member of a response. Present but not an array = an upstream shape
 * error. Absent = empty — but ONLY when the body carries no other non-empty
 * list: `{"places":[…]}` where `results` was expected is a renamed field, and
 * reading it as "Apple found nothing" would be a false negative stated as
 * fact. `siblings` names the lists that legitimately travel alongside `key`
 * (`/v1/place` answers all-failed lookups with `errors` and no `results`).
 */
function expectList(obj: Rec, key: string, status: number, context: string, siblings: readonly string[] = []): unknown[] {
  const v = obj[key];
  if (v === undefined || v === null) {
    const other = Object.keys(obj).find((k) => k !== key && !siblings.includes(k) && Array.isArray(obj[k]) && (obj[k] as unknown[]).length > 0);
    if (other !== undefined) {
      throw new UpstreamError('maps', status, `maps: ${context} returned no "${key}" list but an unexpected "${other}" list.`, {
        hint: 'The Apple Maps API may have changed shape; its answer could not be read. Retry later.',
      });
    }
    return [];
  }
  if (!Array.isArray(v)) {
    throw new UpstreamError('maps', status, `maps: ${context} returned "${key}" in an unexpected shape (not a list).`, {
      hint: 'The Apple Maps API may have changed. Retry later.',
    });
  }
  return v;
}

const LocationSchema = z.looseObject({ latitude: z.number(), longitude: z.number() });
const PlaceSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string().optional(),
  coordinate: LocationSchema.optional(),
  formattedAddressLines: z.array(z.string()).optional(),
  countryCode: z.string().optional(),
  poiCategory: z.string().optional(),
  alternateIds: z.array(z.string()).optional(),
});
const PlaceResultsSchema = z.looseObject({ results: z.array(PlaceSchema).optional() });
const SearchResponseSchema = z.looseObject({
  results: z.array(PlaceSchema).optional(),
  paginationInfo: z
    .looseObject({
      nextPageToken: z.string().optional(),
      prevPageToken: z.string().optional(),
      totalPageCount: z.number().optional(),
      totalResults: z.number().optional(),
    })
    .optional(),
});
const DirectionsResponseSchema = z.looseObject({
  routes: z.array(
    z.looseObject({
      name: z.string().optional(),
      distanceMeters: z.number().optional(),
      durationSeconds: z.number().optional(),
      hasTolls: z.boolean().optional(),
      stepIndexes: z.array(z.number()).optional(),
    }),
  ).optional(),
  steps: z.array(z.looseObject({ instructions: z.string().optional(), distanceMeters: z.number().optional() })).optional(),
});
const EtaResponseSchema = z.looseObject({
  etas: z
    .array(
      z.looseObject({
        destination: LocationSchema.optional(),
        distanceMeters: z.number().optional(),
        expectedTravelTimeSeconds: z.number().optional(),
        staticTravelTimeSeconds: z.number().optional(),
      }),
    )
    .optional(),
});
const PlacesResponseSchema = z.looseObject({
  results: z.array(PlaceSchema).optional(),
  errors: z.array(z.looseObject({ id: z.string().optional(), errorCode: z.string().optional() })).optional(),
});

/** GET + object check + lenient schema validation (warns on drift, passes raw through). */
async function getObject(client: MapsClient, path: string, query: Record<string, QueryValue>, schema: z.ZodType): Promise<{ status: number; body: Rec }> {
  const res = await client.get(path, query);
  const context = `GET ${path}`;
  const body = expectObject(res.data, res.status, context);
  parseLenient(schema, body, { label: LABEL, context });
  return { status: res.status, body };
}

function projectPlaces(list: unknown[], view: 'compact' | 'full', context: string): unknown[] {
  if (view === 'full') return list;
  return projectOrRaw(list, compactPlaces, { label: LABEL, context }) as unknown[];
}

function describeFilters(parts: Array<string | undefined>): string {
  const p = parts.filter((x): x is string => x !== undefined);
  return p.length ? ` (${p.join('; ')})` : '';
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerMapsTools(server: McpServer, deps: MapsDeps = {}): void {
  const client = (): MapsClient => deps.client ?? defaultMapsClient();
  const now = (): number => (deps.now ?? client().now)();

  // 1. Geocode ---------------------------------------------------------------
  defineTool(server, {
    name: 'apple_maps_geocode',
    service: 'maps',
    access: 'read',
    title: 'Geocode an address (Apple Maps)',
    description:
      'Turn an address or place name into coordinates with Apple Maps (geocoding). Returns matching places with ' +
      'latitude/longitude, a one-line address, country code and a place id (for apple_maps_lookup_place). Use it ' +
      'first when a tool needs coordinates (apple_maps_etas, apple_weather_get). Optional: limit to countries, bias ' +
      'toward a nearby point, response language. ' +
      KEY_NOTE,
    inputSchema: z.strictObject({
      address: z.string().min(1).max(500).describe('The address or place name, e.g. "1 Apple Park Way, Cupertino, CA" or "Eiffel Tower".'),
      limitToCountries: countriesParam,
      near: nearParam,
      lang: langParam,
      view: viewNote('"full" adds Apple\'s structured address, display region and alternate ids.'),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const address = requireText(args.address, 'address');
      const view = resolveView(args.view, VIEWS) as 'compact' | 'full';
      const countries = upperCountries(args.limitToCountries);
      const near = nearValue(args.near);
      const { status, body } = await getObject(
        client(),
        '/v1/geocode',
        { q: address, limitToCountries: countries, lang: args.lang, searchLocation: near },
        PlaceResultsSchema,
      );
      const results = expectList(body, 'results', status, 'GET /v1/geocode');
      const query = compactObject({ address, limitToCountries: countries, near: args.near, lang: args.lang });
      const empty = results.length === 0
        ? { notes: [`Apple Maps found no match for "${address}"${describeFilters([countries && `countries ${countries.join(',')}`, near && `near ${near}`])}.`] }
        : {};
      return jsonResponse({ returned: results.length, query, ...empty, places: projectPlaces(results, view, 'GET /v1/geocode results') });
    },
  });

  // 2. Reverse geocode -------------------------------------------------------
  defineTool(server, {
    name: 'apple_maps_reverse_geocode',
    service: 'maps',
    access: 'read',
    title: 'Find the address at coordinates (Apple Maps)',
    description:
      'Find the street address at a latitude/longitude with Apple Maps (reverse geocoding) — e.g. "where is ' +
      '37.33,-122.01?". Returns the place(s) at that point: one-line address, name, country code and place id. ' +
      KEY_NOTE,
    inputSchema: z.strictObject({
      latitude: latitudeParam.describe('Latitude, -90 to 90.'),
      longitude: longitudeParam.describe('Longitude, -180 to 180.'),
      lang: langParam,
      view: viewNote('"full" adds Apple\'s structured address, display region and alternate ids.'),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const point = { latitude: args.latitude, longitude: args.longitude };
      assertCoordinateInRange(point, 'latitude/longitude');
      const loc = formatCoordinate(point);
      const view = resolveView(args.view, VIEWS) as 'compact' | 'full';
      const { status, body } = await getObject(client(), '/v1/reverseGeocode', { loc, lang: args.lang }, PlaceResultsSchema);
      const results = expectList(body, 'results', status, 'GET /v1/reverseGeocode');
      return jsonResponse({
        returned: results.length,
        query: compactObject({ latitude: args.latitude, longitude: args.longitude, lang: args.lang }),
        ...(results.length === 0 ? { notes: [`Apple Maps has no address at ${loc} (open water or an unmapped area?).`] } : {}),
        places: projectPlaces(results, view, 'GET /v1/reverseGeocode results'),
      });
    },
  });

  // 3. Search ----------------------------------------------------------------
  defineTool(server, {
    name: 'apple_maps_search',
    service: 'maps',
    access: 'read',
    title: 'Search for places (Apple Maps)',
    description:
      'Search Apple Maps for places: businesses, points of interest, addresses, landmarks (e.g. "coffee", "EV ' +
      'charger", "Golden Gate Bridge"). Bias toward a point with near; filter by Apple POI category (Restaurant, ' +
      'Cafe, GasStation, EVCharger, Hotel, Parking, Pharmacy…), result type or country. Returns places (name, ' +
      'category, coordinates, address, phone, website, place id) and nextPageToken for the next page. ' +
      KEY_NOTE,
    inputSchema: z.strictObject({
      query: z.string().min(1).max(500).describe('What to search for, e.g. "pizza", "Louvre", "hardware store".'),
      near: nearParam,
      categories: z
        .array(z.enum(POI_CATEGORIES))
        .min(1)
        .max(20)
        .optional()
        .describe('Only these Apple point-of-interest categories (exact names, e.g. ["Restaurant","Cafe"]).'),
      resultTypes: z
        .array(z.enum(RESULT_TYPES))
        .min(1)
        .optional()
        .describe('Only these kinds of result: poi (businesses, landmarks), address, physicalFeature (mountains, lakes…), pointOfInterest.'),
      limitToCountries: countriesParam,
      lang: langParam,
      pageToken: z
        .string()
        .min(1)
        .max(4096)
        .optional()
        .describe('nextPageToken from a previous call, to get the next page. Repeat the same query and filters with it.'),
      view: viewNote('"full" adds Apple\'s structured address, display region and alternate ids.'),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const q = requireText(args.query, 'query');
      const view = resolveView(args.view, VIEWS) as 'compact' | 'full';
      const countries = upperCountries(args.limitToCountries);
      const near = nearValue(args.near);
      const { status, body } = await getObject(
        client(),
        '/v1/search',
        {
          q,
          includePoiCategories: args.categories,
          resultTypeFilter: args.resultTypes,
          limitToCountries: countries,
          lang: args.lang,
          searchLocation: near,
          // Always paginated, so a response can say whether more exist.
          enablePagination: true,
          pageToken: args.pageToken,
        },
        SearchResponseSchema,
      );
      const results = expectList(body, 'results', status, 'GET /v1/search');
      const pagination = isRecord(body.paginationInfo) ? body.paginationInfo : undefined;
      const next = typeof pagination?.nextPageToken === 'string' && pagination.nextPageToken !== '' ? pagination.nextPageToken : undefined;
      const prev = typeof pagination?.prevPageToken === 'string' && pagination.prevPageToken !== '' ? pagination.prevPageToken : undefined;
      const totalResults = typeof pagination?.totalResults === 'number' ? pagination.totalResults : undefined;
      const totalPages = typeof pagination?.totalPageCount === 'number' ? pagination.totalPageCount : undefined;
      const notes: string[] = [];
      if (results.length === 0) {
        notes.push(
          `Apple Maps found no places for "${q}"${describeFilters([
            near && `near ${near}`,
            args.categories && `categories ${args.categories.join(',')}`,
            args.resultTypes && `result types ${args.resultTypes.join(',')}`,
            countries && `countries ${countries.join(',')}`,
            args.pageToken && 'at the given pageToken',
          ])}.`,
        );
      }
      // hasMore is a claim, so it is null — not false — when nothing supports
      // either answer: a page of results with no pagination info could be the
      // first of several. An empty FIRST page is the one case that needs none.
      let hasMore: boolean | null = next !== undefined;
      if (!pagination && (results.length > 0 || args.pageToken !== undefined)) {
        hasMore = null;
        notes.push('Apple sent no pagination info with this page, so whether more results exist is unknown (hasMore is null).');
      }
      if (next) notes.push('More results exist: call again with the same query and filters plus pageToken = nextPageToken.');
      const query = compactObject({
        query: q,
        near: args.near,
        categories: args.categories,
        resultTypes: args.resultTypes,
        limitToCountries: countries,
        lang: args.lang,
        pageToken: args.pageToken,
      });
      return jsonResponse({
        returned: results.length,
        hasMore,
        nextPageToken: next ?? null,
        ...compactObject({ prevPageToken: prev, totalResults, totalPages }),
        query,
        ...(notes.length ? { notes } : {}),
        ...(view === 'full' && body.displayMapRegion !== undefined ? { displayMapRegion: body.displayMapRegion } : {}),
        places: projectPlaces(results, view, 'GET /v1/search results'),
      });
    },
  });

  // 4. Directions ------------------------------------------------------------
  defineTool(server, {
    name: 'apple_maps_directions',
    service: 'maps',
    access: 'read',
    title: 'Get directions (Apple Maps)',
    description:
      'Driving, walking or cycling directions between two places with Apple Maps (addresses or "lat,lng"). ' +
      'Traffic-aware travel time for now or a given departure/arrival time. Returns each route\'s distance (mi and km), ' +
      'duration, tolls, estimated arrival (or leave-by time) and turn-by-turn steps; view "full" adds route geometry. ' +
      'Options: avoid tolls (a preference, not a guarantee), alternate routes. ' +
      KEY_NOTE,
    inputSchema: z.strictObject({
      origin: z.string().min(1).max(500).describe('Start: an address, a place name, or "latitude,longitude".'),
      destination: z.string().min(1).max(500).describe('End: an address, a place name, or "latitude,longitude".'),
      transportType: z.enum(DIRECTIONS_TRANSPORT).optional().describe('automobile (default), walking or cycling.'),
      departureDate: travelDateParam('departure'),
      arrivalDate: travelDateParam('arrival'),
      timeZone: timeZoneParam,
      avoidTolls: z.boolean().optional().describe('Prefer routes without tolls. Apple may still return toll routes — check each route\'s hasTolls.'),
      alternateRoutes: z.boolean().optional().describe('Also return alternative routes when Apple has them (default false).'),
      near: nearParam,
      lang: langParam,
      view: viewNote('"full" returns Apple\'s response verbatim, including every step\'s coordinates (stepPaths) — large.'),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const origin = parseLocation(args.origin, 'origin', { allowAddress: true });
      const destination = parseLocation(args.destination, 'destination', { allowAddress: true });
      const transportType = args.transportType ?? 'automobile';
      const view = resolveView(args.view, VIEWS) as 'compact' | 'full';
      const t = travelTiming(args, now);
      const near = nearValue(args.near);
      const { status, body } = await getObject(
        client(),
        '/v1/directions',
        {
          origin: origin.value,
          destination: destination.value,
          transportType: APPLE_TRANSPORT[transportType],
          departureDate: t.departure && appleUtc(t.departure),
          arrivalDate: t.arrival && appleUtc(t.arrival),
          avoid: args.avoidTolls ? 'Tolls' : undefined,
          requestsAlternateRoutes: args.alternateRoutes ? true : undefined,
          searchLocation: near,
          lang: args.lang,
        },
        DirectionsResponseSchema,
      );
      const routes = expectList(body, 'routes', status, 'GET /v1/directions');
      const notes: string[] = [];
      if (routes.length === 0) {
        notes.push(`Apple Maps returned no ${transportType} route from "${origin.value}" to "${destination.value}".`);
      }
      const tollRoutes: number[] = [];
      const unknownTolls: number[] = [];
      routes.forEach((r, i) => {
        const hasTolls = isRecord(r) ? r.hasTolls : undefined;
        if (hasTolls === true) tollRoutes.push(i + 1);
        else if (hasTolls !== false) unknownTolls.push(i + 1);
      });
      if (args.avoidTolls && tollRoutes.length) {
        notes.push(`avoidTolls only asks Apple to prefer toll-free routes; route(s) ${tollRoutes.join(', ')} still have tolls.`);
      }
      if (unknownTolls.length) notes.push(`Apple did not say whether route(s) ${unknownTolls.join(', ')} have tolls.`);
      const query = compactObject({
        origin: origin.value,
        destination: destination.value,
        transportType,
        avoidTolls: args.avoidTolls,
        alternateRoutes: args.alternateRoutes,
        near: args.near,
        lang: args.lang,
      });
      const data =
        view === 'full'
          ? body
          : projectOrRaw(body, (b) => compactDirections(b, t.timing), { label: LABEL, context: 'GET /v1/directions' });
      return jsonResponse({ returned: routes.length, ...t.head, timeZone: t.zone, query, ...(notes.length ? { notes } : {}), ...data });
    },
  });

  // 5. ETAs ------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_maps_etas',
    service: 'maps',
    access: 'read',
    title: 'Travel times to several destinations (Apple Maps)',
    description:
      'Travel time and distance from one point to up to 10 destinations at once with Apple Maps — driving with live ' +
      'traffic, transit, walking or cycling (e.g. "which of these stores is closest by car?"). Coordinates only ' +
      '("lat,lng"): geocode addresses first with apple_maps_geocode. Returns per destination: distance, travel time ' +
      'with and without traffic, and estimated arrival. ' +
      KEY_NOTE,
    inputSchema: z.strictObject({
      origin: z.string().min(1).max(100).describe('Start point as "latitude,longitude".'),
      destinations: z
        .array(z.string().min(1).max(100))
        .min(1)
        .max(10)
        .describe('1–10 destinations, each "latitude,longitude".'),
      transportType: z.enum(ETA_TRANSPORT).optional().describe('automobile (default, with traffic), transit, walking or cycling.'),
      departureDate: travelDateParam('departure'),
      arrivalDate: travelDateParam('arrival'),
      timeZone: timeZoneParam,
      view: viewNote('"full" returns Apple\'s ETA records verbatim, each tagged with destinationIndex.'),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const origin = parseLocation(args.origin, 'origin', { allowAddress: false });
      const destinations: EtaDestination[] = args.destinations.map((d, i) => {
        const p = parseLocation(d, `destinations[${i}]`, { allowAddress: false });
        // allowAddress:false guarantees a coordinate.
        const c = p as Extract<typeof p, { kind: 'coordinate' }>;
        return { index: i, value: c.value, latitude: c.latitude, longitude: c.longitude };
      });
      const transportType = args.transportType ?? 'automobile';
      const view = resolveView(args.view, VIEWS) as 'compact' | 'full';
      const t = travelTiming(args, now);
      const { status, body } = await getObject(
        client(),
        '/v1/etas',
        {
          origin: origin.value,
          destinations: destinations.map((d) => d.value).join('|'),
          transportType: APPLE_TRANSPORT[transportType],
          departureDate: t.departure && appleUtc(t.departure),
          arrivalDate: t.arrival && appleUtc(t.arrival),
        },
        EtaResponseSchema,
      );
      const etas = expectList(body, 'etas', status, 'GET /v1/etas');
      const m = matchEtas(etas, destinations);
      const notes: string[] = [];
      if (m.missing.length) {
        const which = `${m.missing.length} of ${destinations.length} destination(s) (indexes ${m.missing.map((d) => d.index).join(', ')})`;
        notes.push(
          m.unmatched.length
            ? // Apple DID answer something; it just could not be tied to these. Saying
              // "not reachable" here would state a guess as a fact.
              `No ETA could be tied to ${which}. Apple's ETAs listed under unmatched did not echo a requested ` +
                'destination and may belong to them.'
            : `Apple returned no ETA for ${which}: not reachable by ${transportType} from the origin, or not supported there` +
                (transportType === 'transit' ? ' (transit ETAs exist only where Apple Maps has transit data).' : '.'),
        );
      }
      if (m.unmatched.length) notes.push(`${m.unmatched.length} ETA(s) from Apple could not be matched to a requested destination; they are listed under unmatched.`);
      // `full` (and the fallback when the projection cannot read a record) is Apple's ETA tagged with its destination.
      const tagged = m.matched.map((x) => ({ destinationIndex: x.destination.index, ...x.eta }));
      const records =
        view === 'full'
          ? tagged
          : projectOrRaw(tagged, () => m.matched.map((x) => compactEta(x, t.timing)), { label: LABEL, context: 'GET /v1/etas etas' });
      return jsonResponse({
        returned: m.matched.length,
        requested: destinations.length,
        ...t.head,
        timeZone: t.zone,
        query: { origin: origin.value, transportType },
        ...(notes.length ? { notes } : {}),
        ...(m.missing.length ? { noEta: m.missing.map((d) => ({ destinationIndex: d.index, destination: d.value })) } : {}),
        ...(m.unmatched.length ? { unmatched: m.unmatched } : {}),
        etas: records,
      });
    },
  });

  // 6. Place lookup ----------------------------------------------------------
  defineTool(server, {
    name: 'apple_maps_lookup_place',
    service: 'maps',
    access: 'read',
    title: 'Look up places by id (Apple Maps)',
    description:
      'Look up Apple Maps places by place id — the id field from apple_maps_search, apple_maps_geocode or ' +
      'apple_maps_reverse_geocode results — 1 to 50 at once. Returns each place\'s name, category, coordinates, ' +
      'address, phone and website; ids Apple could not resolve are listed with the reason. ' +
      KEY_NOTE,
    inputSchema: z.strictObject({
      placeIds: z.array(z.string().min(1).max(256)).min(1).max(50).describe('1–50 Apple Maps place ids.'),
      lang: langParam,
      view: viewNote('"full" adds Apple\'s structured address, display region and alternate ids.'),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const view = resolveView(args.view, VIEWS) as 'compact' | 'full';
      const ids: string[] = [];
      for (const [i, raw] of args.placeIds.entries()) {
        const id = raw.trim();
        // Apple documents a place id only as "an opaque string", so refuse just
        // what would corrupt the comma-joined `ids` list (a comma) or cannot be
        // an id (whitespace, control characters) — the value is percent-encoded
        // on the way out, so nothing else can escape the parameter.
        if (!/^[^\s,\p{Cc}]+$/u.test(id)) {
          throw new InvalidArgumentError(`placeIds[${i}] "${raw}" is not an Apple Maps place id.`, 'Use the id field from apple_maps_search or apple_maps_geocode results.');
        }
        if (!ids.includes(id)) ids.push(id);
      }
      const { status, body } = await getObject(client(), '/v1/place', { ids, lang: args.lang }, PlacesResponseSchema);
      const results = expectList(body, 'results', status, 'GET /v1/place', ['errors']);
      const errors = expectList(body, 'errors', status, 'GET /v1/place', ['results']).map((e) => {
        const rec = isRecord(e) ? e : {};
        const id = typeof rec.id === 'string' ? rec.id : undefined;
        const errorCode = typeof rec.errorCode === 'string' ? rec.errorCode : 'UNKNOWN';
        return compactObject({ id, errorCode, meaning: PLACE_ERROR_MEANING[errorCode] ?? 'Apple gave no further detail' });
      });
      const found = new Set<string>();
      for (const r of results) {
        if (!isRecord(r)) continue;
        if (typeof r.id === 'string') found.add(r.id);
        if (Array.isArray(r.alternateIds)) for (const a of r.alternateIds) if (typeof a === 'string') found.add(a);
      }
      const failed = new Set(errors.map((e) => e.id));
      const unaccounted = ids.filter((id) => !found.has(id) && !failed.has(id));
      const notes: string[] = [];
      if (ids.length < args.placeIds.length) notes.push(`${args.placeIds.length - ids.length} duplicate id(s) were looked up once.`);
      if (errors.length) notes.push(`${errors.length} of ${ids.length} id(s) could not be resolved; see errors.`);
      if (unaccounted.length) {
        notes.push(
          `No result or error names ${unaccounted.length} id(s): ${unaccounted.join(', ')}. Apple may have returned ` +
            'them under a different (canonical) id — compare the places returned (view "full" shows alternateIds).',
        );
      }
      return jsonResponse({
        requested: ids.length,
        returned: results.length,
        failed: errors.length,
        ...(notes.length ? { notes } : {}),
        ...(errors.length ? { errors } : {}),
        places: projectPlaces(results, view, 'GET /v1/place results'),
      });
    },
  });

  // 7. Snapshot URL ----------------------------------------------------------
  defineTool(server, {
    name: 'apple_maps_snapshot_url',
    service: 'maps',
    access: 'read',
    title: 'Make a static map image link (Apple Maps)',
    description:
      'Make a signed link to a static Apple Maps image (PNG): centred on an address or "lat,lng", and/or with pins ' +
      '(each with an optional label, colour and one-character glyph; the map fits the pins when no center is given). ' +
      'Choose zoom, size (up to 640x640), scale, map type (standard, hybrid, satellite, mutedStandard) and light/dark. ' +
      'Returns the URL only — nothing is downloaded; the link can be made to expire. Uses the same Apple Developer ' +
      'key (MapKit JS): APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY.',
    inputSchema: z.strictObject({
      center: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe('Map centre: an address or "latitude,longitude". Omit to fit the map around the annotations.'),
      annotations: z
        .array(
          z.strictObject({
            point: z.string().min(1).max(100).optional().describe('Pin location as "latitude,longitude" (give point or address).'),
            address: z.string().min(1).max(300).optional().describe('Pin location as an address (give point or address).'),
            label: z
              .string()
              .min(1)
              .max(80)
              .optional()
              .describe('What this pin is. The image cannot show text, so a labelled pin gets a letter glyph and the response lists a legend.'),
            color: z
              .string()
              .regex(/^(?:#?[0-9A-Fa-f]{6}|[A-Za-z]{3,20})$/)
              .optional()
              .describe('Pin colour: a hex code like "FF3B30" or an HTML colour name like "red".'),
            glyphText: z
              .string()
              .regex(/^[A-Za-z0-9]$/)
              .optional()
              .describe('One letter or digit drawn inside the pin (not shown on "dot" markers).'),
            markerStyle: z.enum(['balloon', 'large', 'dot']).optional().describe('Marker shape: balloon (default), large or dot.'),
          }),
        )
        .min(1)
        .max(SNAPSHOT_MAX_ANNOTATIONS)
        .optional()
        .describe(`Up to ${SNAPSHOT_MAX_ANNOTATIONS} pins, drawn in this order.`),
      zoom: z.number().min(3).max(20).optional().describe('Zoom level 3 (continent) to 20 (building); Apple default 12. Needs center.'),
      size: z
        .string()
        .regex(/^\d{2,3}x\d{2,3}$/)
        .optional()
        .describe('Image size "WIDTHxHEIGHT" in points, each 50–640 (default 600x400).'),
      scale: z.number().int().min(1).max(3).optional().describe('Pixel density 1–3 (2 for retina screens; default 1).'),
      mapType: z.enum(['standard', 'hybrid', 'satellite', 'mutedStandard']).optional().describe('Map style (default standard).'),
      colorScheme: z.enum(['light', 'dark']).optional().describe('light (default) or dark; dark applies to standard and mutedStandard only.'),
      showPointsOfInterest: z.boolean().optional().describe('Show businesses and landmarks on the map (default true).'),
      lang: langParam,
      expiresInMinutes: z
        .number()
        .int()
        .min(1)
        .max(43_200)
        .optional()
        .describe('Make the link stop working after this many minutes (max 30 days). Default: no expiry.'),
    }),
    annotations: { ...ANNOTATIONS.read, openWorldHint: false },
    handler: async (args) => {
      const zone = getDisplayTimeZone();
      const notes: string[] = [];

      let center: string;
      if (args.center !== undefined && args.center.trim().toLowerCase() !== 'auto') {
        center = parseLocation(args.center, 'center', { allowAddress: true }).value;
      } else {
        if (!args.annotations?.length) {
          throw new InvalidArgumentError('Give a center, annotations, or both.', 'Without a center the map is fitted around the annotations, so at least one is needed.');
        }
        if (args.zoom !== undefined) {
          throw new InvalidArgumentError('zoom needs a center: a map fitted around the annotations picks its own zoom.', 'Pass center as well, or drop zoom.');
        }
        center = 'auto';
      }

      let size = '600x400';
      if (args.size !== undefined) {
        const [w, h] = args.size.split('x').map(Number) as [number, number];
        for (const [dim, v] of [['width', w], ['height', h]] as const) {
          if (v < SNAPSHOT_MIN_PX || v > SNAPSHOT_MAX_PX) {
            throw new InvalidArgumentError(`size "${args.size}" has ${dim} ${v}; each side must be ${SNAPSHOT_MIN_PX}–${SNAPSHOT_MAX_PX}.`);
          }
        }
        size = `${w}x${h}`;
      }

      const legend: Rec[] = [];
      let annotationsJson: string | undefined;
      if (args.annotations?.length) {
        const explicit = new Set(args.annotations.map((a) => a.glyphText).filter((g): g is string => g !== undefined));
        const glyphs = [...GLYPHS].filter((g) => !explicit.has(g));
        const pins = args.annotations.map((a, i) => {
          const field = `annotations[${i}]`;
          if ((a.point === undefined) === (a.address === undefined)) {
            throw new InvalidArgumentError(`${field} needs exactly one of point or address.`);
          }
          // An address that is shaped like coordinates IS coordinates, range-checked
          // like every other location argument (Apple would read it that way too).
          const point =
            a.point !== undefined
              ? parseLocation(a.point, `${field}.point`, { allowAddress: false }).value
              : parseLocation(a.address as string, `${field}.address`, { allowAddress: true }).value;
          const dot = a.markerStyle === 'dot';
          const glyph = a.glyphText ?? (a.label !== undefined && !dot ? glyphs.shift() : undefined);
          const color = a.color?.replace(/^#/, '');
          // The legend lists only a glyph the image will actually show: Apple ignores glyphText on dots.
          legend.push(compactObject({ index: i, point, label: a.label, glyph: dot ? undefined : glyph, color, markerStyle: a.markerStyle }));
          return compactObject({ point, color, glyphText: glyph, markerStyle: a.markerStyle });
        });
        annotationsJson = JSON.stringify(pins);
        if (args.annotations.some((a) => a.markerStyle === 'dot' && (a.label !== undefined || a.glyphText !== undefined))) {
          notes.push('Dot markers cannot show a glyph, so labelled dot pins are told apart only by colour; see annotations.');
        }
      }

      if (args.colorScheme === 'dark' && (args.mapType === 'satellite' || args.mapType === 'hybrid')) {
        notes.push(`colorScheme dark has no effect on the ${args.mapType} map type.`);
      }

      let expires: Date | undefined;
      if (args.expiresInMinutes !== undefined) {
        expires = new Date((Math.floor(now() / 1000) + args.expiresInMinutes * 60) * 1000);
      }

      const params: Array<[string, string]> = [['center', center]];
      if (args.zoom !== undefined) params.push(['z', String(args.zoom)]);
      if (args.size !== undefined) params.push(['size', size]);
      if (args.scale !== undefined) params.push(['scale', String(args.scale)]);
      if (args.mapType !== undefined) params.push(['t', args.mapType]);
      if (args.colorScheme !== undefined) params.push(['colorScheme', args.colorScheme]);
      if (args.showPointsOfInterest !== undefined) params.push(['poi', args.showPointsOfInterest ? '1' : '0']);
      if (args.lang !== undefined) params.push(['lang', args.lang]);
      if (annotationsJson !== undefined) params.push(['annotations', annotationsJson]);
      if (expires !== undefined) params.push(['expires', String(expires.getTime() / 1000)]);

      // The key is resolved after every argument check, as the other tools do.
      const url = buildSignedSnapshotUrl(params, client().key());
      if (url.length > LONG_URL_CHARS) {
        notes.push(`The URL is ${url.length} characters; Apple answers HTTP 413 when a snapshot request is too large. Use fewer or shorter annotations if it fails.`);
      }
      notes.push(
        'Signed locally and not fetched. Opening the URL returns a PNG; an HTTP 401 there means the key lacks MapKit JS ' +
          'or its Maps ID association (or the link expired). Apple allows 25,000 unique snapshot requests per day.',
      );

      const out: Rec = {
        url,
        center,
        ...compactObject({ zoom: args.zoom }),
        size,
        scale: args.scale ?? 1,
        mapType: args.mapType ?? 'standard',
        colorScheme: args.colorScheme ?? 'light',
      };
      if (expires) putInstant(out, 'expiresAt', expires, zone);
      out.notes = notes;
      if (legend.length) out.annotations = legend;
      return jsonResponse(out);
    },
  });
}
