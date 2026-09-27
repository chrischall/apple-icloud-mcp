import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, harness } from './_helpers.js';

beforeEach(() => {
  process.env.DISPLAY_TZ = 'America/New_York';
});

const DIRECTIONS = {
  origin: { name: 'Start', coordinate: { latitude: 37.7857, longitude: -122.4011 } },
  destination: {
    center: { latitude: 37.7753881, longitude: -122.3931773 },
    name: 'SF Public Library - Mission Bay',
    formattedAddressLines: ['960 4th St', 'San Francisco, CA  94158', 'United States'],
    countryCode: 'US',
  },
  routes: [
    { name: '4th St', distanceMeters: 2033, durationSeconds: 506, transportType: 'AUTOMOBILE', stepIndexes: [0, 1], hasTolls: true },
    { name: '2nd St', distanceMeters: 2342, durationSeconds: 592, transportType: 'AUTOMOBILE', stepIndexes: [2], hasTolls: false },
    { name: 'Harrison St', distanceMeters: 2029, durationSeconds: 548, transportType: 'AUTOMOBILE', stepIndexes: [2] },
  ],
  steps: [
    { stepPathIndex: 0, distanceMeters: 0, durationSeconds: 0 },
    { stepPathIndex: 1, distanceMeters: 2033, durationSeconds: 506, instructions: 'Turn right onto Minna St' },
    { stepPathIndex: 2, distanceMeters: 2342, durationSeconds: 592, instructions: 'Head south' },
  ],
  stepPaths: [[{ latitude: 37.7857, longitude: -122.4011 }], [], []],
};

describe('apple_maps_directions', () => {
  it('departing now: sends Apple-cased parameters, estimates arrival, notes tolls, drops stepPaths', async () => {
    const h = harness({ '/v1/directions': () => ({ data: DIRECTIONS }) });
    const { isError, json } = await h.call('apple_maps_directions', {
      origin: '37.7857, -122.4011',
      destination: 'San Francisco City Hall, CA',
      avoidTolls: true,
      alternateRoutes: true,
      near: { latitude: 37.78, longitude: -122.42 },
      lang: 'en-US',
    });
    expect(isError).toBe(false);
    expect(h.dataCalls()[0]!.query).toEqual({
      origin: '37.7857,-122.4011',
      destination: 'San Francisco City Hall, CA',
      transportType: 'Automobile',
      departureDate: undefined,
      arrivalDate: undefined,
      avoid: 'Tolls',
      requestsAlternateRoutes: true,
      searchLocation: '37.78,-122.42',
      lang: 'en-US',
    });
    expect(Object.keys(json)).toEqual([
      'returned', 'timeBasis', 'departure', 'departureDisplay', 'timeZone', 'query', 'notes', 'origin', 'destination', 'routes',
    ]);
    expect(json).toMatchObject({
      returned: 3,
      timeBasis: 'departNow',
      departure: '2026-10-03T12:00:00-04:00',
      departureDisplay: 'Sat, Oct 3, 2026, 12:00 PM EDT',
      timeZone: 'America/New_York',
      query: {
        origin: '37.7857,-122.4011',
        destination: 'San Francisco City Hall, CA',
        transportType: 'automobile',
        avoidTolls: true,
        alternateRoutes: true,
        near: { latitude: 37.78, longitude: -122.42 },
        lang: 'en-US',
      },
      notes: [
        'avoidTolls only asks Apple to prefer toll-free routes; route(s) 1 still have tolls.',
        'Apple did not say whether route(s) 3 have tolls.',
      ],
      destination: { name: 'SF Public Library - Mission Bay', latitude: 37.7753881, longitude: -122.3931773 },
    });
    expect(json.routes[0]).toEqual({
      name: '4th St',
      distanceMeters: 2033,
      distance: '1.3 mi / 2.0 km',
      durationSeconds: 506,
      duration: '8 min',
      hasTolls: true,
      transportType: 'automobile',
      estimatedArrival: '2026-10-03T12:08:26-04:00',
      estimatedArrivalDisplay: 'Sat, Oct 3, 2026, 12:08 PM EDT',
      steps: [{ instructions: 'Turn right onto Minna St', distance: '1.3 mi / 2.0 km', duration: '8 min' }],
    });
    expect(JSON.stringify(json)).not.toContain('stepPaths');
  });

  it('departureDate: offset-less input is wall-clock in timeZone and sent to Apple in UTC', async () => {
    const h = harness({ '/v1/directions': () => ({ data: DIRECTIONS }) });
    const { json } = await h.call('apple_maps_directions', {
      origin: 'A',
      destination: 'B',
      transportType: 'walking',
      departureDate: '2026-10-05T08:30',
      timeZone: 'Europe/London',
    });
    expect(h.dataCalls()[0]!.query).toMatchObject({ transportType: 'Walking', departureDate: '2026-10-05T07:30:00Z' });
    expect(json).toMatchObject({ timeBasis: 'departAt', departure: '2026-10-05T08:30:00+01:00', timeZone: 'Europe/London' });
    expect(json.routes[0].estimatedArrival).toBe('2026-10-05T08:38:26+01:00');
    expect(json.notes).toEqual(['Apple did not say whether route(s) 3 have tolls.']);
  });

  it('a mis-cased timeZone is read as its IANA zone and echoed in canonical spelling', async () => {
    const h = harness({ '/v1/directions': () => ({ data: DIRECTIONS }), '/v1/etas': () => ({ data: { etas: [] } }) });
    const { json } = await h.call('apple_maps_directions', {
      origin: 'A',
      destination: 'B',
      departureDate: '2026-10-05T08:30',
      timeZone: 'europe/london',
    });
    expect(h.dataCalls()[0]!.query).toMatchObject({ departureDate: '2026-10-05T07:30:00Z' });
    expect(json).toMatchObject({ departure: '2026-10-05T08:30:00+01:00', timeZone: 'Europe/London' });
    const etas = await h.call('apple_maps_etas', { origin: '1,2', destinations: ['3,4'], timeZone: 'US/Eastern' });
    expect(etas.json.timeZone).toBe('America/New_York');
  });

  it('arrivalDate: sends arrivalDate and derives leave-by times', async () => {
    const h = harness({ '/v1/directions': () => ({ data: DIRECTIONS }) });
    const { json } = await h.call('apple_maps_directions', {
      origin: 'A',
      destination: 'B',
      transportType: 'cycling',
      arrivalDate: '2026-10-05T09:00:00Z',
    });
    expect(h.dataCalls()[0]!.query).toMatchObject({ transportType: 'Cycling', arrivalDate: '2026-10-05T09:00:00Z', departureDate: undefined });
    expect(json).toMatchObject({ timeBasis: 'arriveBy', arrival: '2026-10-05T05:00:00-04:00' });
    expect(json.departure).toBeUndefined();
    expect(json.routes[0].leaveBy).toBe('2026-10-05T04:51:34-04:00');
    expect(json.routes[0].estimatedArrival).toBeUndefined();
  });

  it('refuses both dates, a date without a time, a bad date and an unknown zone — before calling Apple', async () => {
    const h = harness({});
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ departureDate: '2026-10-05T08:00', arrivalDate: '2026-10-05T09:00' }, /not both/],
      [{ departureDate: '2026-10-05' }, /departureDate "2026-10-05" has no time of day/],
      [{ arrivalDate: '2026-02-30T10:00' }, /arrivalDate "2026-02-30T10:00" is not a valid date/],
      [{ timeZone: 'Mars/Olympus' }, /timeZone "Mars\/Olympus" is not a known IANA time zone/],
      [{ timeZone: '\u221204:00' }, /timeZone "\u221204:00" is not a known IANA time zone/],
      [{ origin: '91,0' }, /origin "91,0" has latitude 91/],
      [{ origin: ' ' }, /origin is empty/],
    ];
    for (const [extra, re] of cases) {
      const { isError, json } = await h.call('apple_maps_directions', { origin: 'A', destination: 'B', ...extra });
      expect(isError).toBe(true);
      expect(json.error.code).toBe('INVALID_ARGUMENT');
      expect(json.error.message).toMatch(re);
    }
    expect(h.request).not.toHaveBeenCalled();
  });

  it('no notes at all when every route states its tolls', async () => {
    const clean = { ...DIRECTIONS, routes: [{ ...DIRECTIONS.routes[1], stepIndexes: [2] }] };
    const h = harness({ '/v1/directions': () => ({ data: clean }) });
    const { json } = await h.call('apple_maps_directions', { origin: 'A', destination: 'B' });
    expect(json.notes).toBeUndefined();
    expect(json.routes).toHaveLength(1);
    expect(json.routes[0].hasTolls).toBe(false);
  });

  it('no route: says what was asked for', async () => {
    const h = harness({ '/v1/directions': () => ({ data: { routes: [] } }) });
    const { json } = await h.call('apple_maps_directions', { origin: 'Honolulu', destination: 'Tokyo' });
    expect(json).toMatchObject({ returned: 0, notes: ['Apple Maps returned no automobile route from "Honolulu" to "Tokyo".'], routes: [] });
  });

  it('steps without a routes list is a shape change, never "no route"', async () => {
    const h = harness({ '/v1/directions': () => ({ data: { paths: [{ name: '4th St' }], steps: DIRECTIONS.steps } }) });
    const { isError, json } = await h.call('apple_maps_directions', { origin: 'A', destination: 'B' });
    expect(isError).toBe(true);
    expect(json.error.code).toBe('UPSTREAM_ERROR');
    expect(json.error.message).toMatch(/GET \/v1\/directions returned no "routes" list but an unexpected "paths" list/);
  });

  it('an arrival estimate that crosses the DST fall-back carries the new offset', async () => {
    // 2026-11-01 01:30 EDT + 1 h = 01:30 EST: same wall clock, different instant.
    const oneHour = { routes: [{ name: 'I-95', distanceMeters: 100_000, durationSeconds: 3600, hasTolls: false }] };
    const h = harness({ '/v1/directions': () => ({ data: oneHour }) });
    const { json } = await h.call('apple_maps_directions', { origin: 'A', destination: 'B', departureDate: '2026-11-01T01:30' });
    expect(h.dataCalls()[0]!.query).toMatchObject({ departureDate: '2026-11-01T05:30:00Z' });
    expect(json.departure).toBe('2026-11-01T01:30:00-04:00');
    expect(json.routes[0]).toMatchObject({
      duration: '1 h',
      estimatedArrival: '2026-11-01T01:30:00-05:00',
      estimatedArrivalDisplay: 'Sun, Nov 1, 2026, 1:30 AM EST',
    });
  });

  it('full view returns Apple’s response verbatim, including stepPaths', async () => {
    const h = harness({ '/v1/directions': () => ({ data: DIRECTIONS }) });
    const { json } = await h.call('apple_maps_directions', { origin: 'A', destination: 'B', view: 'full' });
    expect(json.stepPaths).toEqual(DIRECTIONS.stepPaths);
    expect(json.routes).toEqual(DIRECTIONS.routes);
    expect(json.steps).toEqual(DIRECTIONS.steps);
    expect(json.returned).toBe(3);
  });

  it('falls back to the raw response when a route cannot be projected; non-object routes do not break the toll scan', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = { routes: [{ name: 'X', stepIndexes: [9] }, 'junk'], steps: [] };
    const h = harness({ '/v1/directions': () => ({ data: raw }) });
    const { json } = await h.call('apple_maps_directions', { origin: 'A', destination: 'B' });
    expect(json.routes).toEqual(raw.routes);
    expect(json.notes).toEqual(['Apple did not say whether route(s) 1, 2 have tolls.']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

const D0 = '37.32556561130194,-121.94635203581443';
const D1 = '37.44176585512703,-122.17259315798667';
const ETA0 = {
  destination: { latitude: 37.32556561130194, longitude: -121.94635203581443 },
  transportType: 'AUTOMOBILE',
  distanceMeters: 9550,
  expectedTravelTimeSeconds: 975,
  staticTravelTimeSeconds: 540,
};
const ETA1 = {
  destination: { latitude: 37.44176585512703, longitude: -122.17259315798667 },
  transportType: 'AUTOMOBILE',
  distanceMeters: 23286,
  expectedTravelTimeSeconds: 1336,
  staticTravelTimeSeconds: 1039,
};

describe('apple_maps_etas', () => {
  it('sends pipe-joined destinations and returns one compact ETA per destination, in request order', async () => {
    const h = harness({ '/v1/etas': () => ({ data: { etas: [ETA1, ETA0] } }) });
    const { json } = await h.call('apple_maps_etas', { origin: '37.331423, -122.030503', destinations: [D0, D1] });
    expect(h.dataCalls()[0]!.query).toEqual({
      origin: '37.331423,-122.030503',
      destinations: '37.32556561,-121.94635204|37.44176586,-122.17259316',
      transportType: 'Automobile',
      departureDate: undefined,
      arrivalDate: undefined,
    });
    expect(Object.keys(json)).toEqual(['returned', 'requested', 'timeBasis', 'departure', 'departureDisplay', 'timeZone', 'query', 'etas']);
    expect(json).toMatchObject({ returned: 2, requested: 2, timeBasis: 'departNow', query: { origin: '37.331423,-122.030503', transportType: 'automobile' } });
    expect(json.etas).toEqual([
      {
        destinationIndex: 0,
        destination: '37.32556561,-121.94635204',
        distanceMeters: 9550,
        distance: '5.9 mi / 9.6 km',
        expectedTravelTimeSeconds: 975,
        travelTime: '16 min',
        staticTravelTimeSeconds: 540,
        travelTimeWithoutTraffic: '9 min',
        transportType: 'automobile',
        estimatedArrival: '2026-10-03T12:16:15-04:00',
        estimatedArrivalDisplay: 'Sat, Oct 3, 2026, 12:16 PM EDT',
      },
      expect.objectContaining({ destinationIndex: 1, distanceMeters: 23286, travelTime: '22 min' }),
    ]);
  });

  it('reports destinations Apple returned no ETA for (never silently drops one); transit says why', async () => {
    const h = harness({ '/v1/etas': () => ({ data: { etas: [ETA0] } }) });
    const { json } = await h.call('apple_maps_etas', {
      origin: '37.33,-122.03',
      destinations: [D0, D1],
      transportType: 'transit',
      departureDate: '2026-10-05T08:00',
    });
    expect(h.dataCalls()[0]!.query).toMatchObject({ transportType: 'Transit', departureDate: '2026-10-05T12:00:00Z' });
    expect(json).toMatchObject({ returned: 1, requested: 2, timeBasis: 'departAt' });
    expect(json.notes).toEqual([
      'Apple returned no ETA for 1 of 2 destination(s) (indexes 1): not reachable by transit from the origin, or not supported there (transit ETAs exist only where Apple Maps has transit data).',
    ]);
    expect(json.noEta).toEqual([{ destinationIndex: 1, destination: '37.44176586,-122.17259316' }]);
  });

  it('an answer with no etas at all lists every destination as missing', async () => {
    const h = harness({ '/v1/etas': () => ({ data: {} }) });
    const { json } = await h.call('apple_maps_etas', { origin: '1,2', destinations: ['3,4'], transportType: 'walking', arrivalDate: '2026-10-05T09:00' });
    expect(h.dataCalls()[0]!.query).toMatchObject({ transportType: 'Walking', arrivalDate: '2026-10-05T13:00:00Z' });
    expect(json.timeBasis).toBe('arriveBy');
    expect(json.notes).toEqual(['Apple returned no ETA for 1 of 1 destination(s) (indexes 0): not reachable by walking from the origin, or not supported there.']);
    expect(json.etas).toEqual([]);
  });

  it('keeps ETAs it cannot tie to a destination visible under unmatched', async () => {
    const stray = { destination: { latitude: 10, longitude: 10 }, distanceMeters: 1 };
    const h = harness({ '/v1/etas': () => ({ data: { etas: [ETA0, stray, 'junk'] } }) });
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { json } = await h.call('apple_maps_etas', { origin: '1,2', destinations: [D0, D1] });
    warn.mockRestore();
    expect(json.unmatched).toEqual([stray, 'junk']);
    // Apple DID answer; it is not claimed that destination 1 is unreachable.
    expect(json.notes).toEqual([
      "No ETA could be tied to 1 of 2 destination(s) (indexes 1). Apple's ETAs listed under unmatched did not echo a requested destination and may belong to them.",
      '2 ETA(s) from Apple could not be matched to a requested destination; they are listed under unmatched.',
    ]);
    expect(JSON.stringify(json.notes)).not.toContain('not reachable');
    expect(json.noEta).toEqual([{ destinationIndex: 1, destination: '37.44176586,-122.17259316' }]);
  });

  it('pairs two destinations a few metres apart with their own ETAs even when Apple answers out of order', async () => {
    // ~5.5 m apart: both inside the echo tolerance of each other.
    const a = { destination: { latitude: 37.3, longitude: -122 }, distanceMeters: 100, expectedTravelTimeSeconds: 60 };
    const b = { destination: { latitude: 37.30005, longitude: -122 }, distanceMeters: 200, expectedTravelTimeSeconds: 120 };
    const h = harness({ '/v1/etas': () => ({ data: { etas: [b, a] } }) });
    const { json } = await h.call('apple_maps_etas', { origin: '1,2', destinations: ['37.3,-122', '37.30005,-122'] });
    expect(json.etas.map((e: { destinationIndex: number; distanceMeters: number }) => [e.destinationIndex, e.distanceMeters])).toEqual([
      [0, 100],
      [1, 200],
    ]);
  });

  it('falls back to the tagged raw records when an ETA cannot be read (never a hollow record)', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const renamed = { destination: ETA0.destination, travelSeconds: 975 };
    const h = harness({ '/v1/etas': () => ({ data: { etas: [renamed] } }) });
    const { json } = await h.call('apple_maps_etas', { origin: '1,2', destinations: [D0] });
    expect(json.etas).toEqual([{ destinationIndex: 0, ...renamed }]);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/could not project GET \/v1\/etas etas/);
    warn.mockRestore();
  });

  it('full view returns Apple’s ETA records verbatim, tagged with the destination index', async () => {
    const h = harness({ '/v1/etas': () => ({ data: { etas: [ETA0] } }) });
    const { json } = await h.call('apple_maps_etas', { origin: '1,2', destinations: [D0], view: 'full', timeZone: 'UTC' });
    expect(json.etas).toEqual([{ destinationIndex: 0, ...ETA0 }]);
    expect(json.departure).toBe('2026-10-03T16:00:00+00:00');
  });

  it('refuses addresses (Apple’s ETA endpoint takes coordinates only)', async () => {
    const h = harness({});
    const a = await h.call('apple_maps_etas', { origin: 'Cupertino', destinations: [D0] });
    expect(a.json.error.message).toMatch(/origin "Cupertino" must be coordinates/);
    const b = await h.call('apple_maps_etas', { origin: '1,2', destinations: [D0, 'Palo Alto'] });
    expect(b.json.error.message).toMatch(/destinations\[1\] "Palo Alto" must be coordinates/);
    expect(b.json.error.hint).toMatch(/apple_maps_geocode/);
    expect(h.request).not.toHaveBeenCalled();
  });

  it('uses an injected clock for "now"', async () => {
    const h = harness({ '/v1/etas': () => ({ data: { etas: [ETA0] } }) }, { now: () => NOW + 3_600_000 });
    const { json } = await h.call('apple_maps_etas', { origin: '1,2', destinations: [D0] });
    expect(json.departure).toBe('2026-10-03T13:00:00-04:00');
  });
});
