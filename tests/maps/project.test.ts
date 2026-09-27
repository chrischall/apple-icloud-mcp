import { beforeEach, describe, expect, it } from 'vitest';
import {
  compactDirections,
  compactEta,
  compactPlace,
  compactPlaces,
  isRecord,
  matchEtas,
  oneLineAddress,
  putTravelTimes,
  type EtaDestination,
} from '../../src/maps/project.js';

const ZONE = 'America/New_York';

beforeEach(() => {
  process.env.DISPLAY_TZ = ZONE;
});

const APPLE_PARK = {
  coordinate: { latitude: 37.3346438, longitude: -122.008972 },
  displayMapRegion: { southLatitude: 37.32, westLongitude: -122.01, northLatitude: 37.33, eastLongitude: -122.0 },
  name: 'Apple Park Way',
  formattedAddressLines: ['Apple Park Way', 'Cupertino, CA  95014', 'United States'],
  structuredAddress: { locality: 'Cupertino', postCode: '95014' },
  country: 'United States',
  countryCode: 'US',
};

describe('small helpers', () => {
  it('isRecord', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });

  it('oneLineAddress joins lines and collapses double spaces', () => {
    expect(oneLineAddress(APPLE_PARK.formattedAddressLines)).toBe('Apple Park Way, Cupertino, CA 95014, United States');
    expect(oneLineAddress([])).toBeUndefined();
    expect(oneLineAddress(['', 3])).toBeUndefined();
    expect(oneLineAddress('x')).toBeUndefined();
  });
});

describe('compactPlace', () => {
  it('keeps what a caller acts on and drops the bulk', () => {
    expect(compactPlace(APPLE_PARK)).toEqual({
      name: 'Apple Park Way',
      latitude: 37.3346438,
      longitude: -122.008972,
      address: 'Apple Park Way, Cupertino, CA 95014, United States',
      countryCode: 'US',
    });
  });

  it('keeps id, category, phone and urls; reads `center` as the coordinate (directions)', () => {
    expect(
      compactPlace({
        id: 'I7C250D2CDCB364A',
        alternateIds: ['X1'],
        name: 'SF Library',
        poiCategory: 'Library',
        center: { latitude: 37.77, longitude: -122.39 },
        telephone: '+14153552838',
        urls: ['https://sfpl.org', ''],
      }),
    ).toEqual({
      id: 'I7C250D2CDCB364A',
      name: 'SF Library',
      category: 'Library',
      latitude: 37.77,
      longitude: -122.39,
      telephone: '+14153552838',
      urls: ['https://sfpl.org'],
    });
  });

  it('accepts a place known only by its coordinate or only by its address', () => {
    expect(compactPlace({ coordinate: { latitude: 1, longitude: 2 } })).toEqual({ latitude: 1, longitude: 2 });
    expect(compactPlace({ formattedAddressLines: ['Somewhere'] })).toEqual({ address: 'Somewhere' });
  });

  it('throws on shapes it does not recognise (so projectOrRaw falls back)', () => {
    expect(() => compactPlace('nope')).toThrow('a place is not an object');
    expect(() => compactPlace({ coordinate: { lat: 1, lng: 2 }, name: '  ' })).toThrow('no name, coordinate or address');
  });

  it('compactPlaces maps a list', () => {
    expect(compactPlaces([APPLE_PARK])).toHaveLength(1);
  });
});

describe('putTravelTimes', () => {
  it('derives estimatedArrival from a departure, leaveBy from an arrival, nothing without a duration', () => {
    const departure = new Date('2026-10-03T16:00:00Z');
    const a: Record<string, unknown> = {};
    putTravelTimes(a, 3900, { zone: ZONE, departure });
    expect(a).toEqual({ estimatedArrival: '2026-10-03T13:05:00-04:00', estimatedArrivalDisplay: 'Sat, Oct 3, 2026, 1:05 PM EDT' });
    const b: Record<string, unknown> = {};
    putTravelTimes(b, 600, { zone: ZONE, arrival: departure });
    expect(b).toEqual({ leaveBy: '2026-10-03T11:50:00-04:00', leaveByDisplay: 'Sat, Oct 3, 2026, 11:50 AM EDT' });
    const c: Record<string, unknown> = {};
    putTravelTimes(c, undefined, { zone: ZONE, departure });
    putTravelTimes(c, 60, { zone: ZONE });
    expect(c).toEqual({});
  });
});

const DIRECTIONS = {
  origin: { name: 'Start', coordinate: { latitude: 37.7857, longitude: -122.4011 } },
  destination: {
    center: { latitude: 37.7753881, longitude: -122.3931773 },
    name: 'San Francisco Public Library - Mission Bay',
    formattedAddressLines: ['960 4th St', 'San Francisco, CA  94158', 'United States'],
    countryCode: 'US',
  },
  routes: [
    { name: '4th St', distanceMeters: 2033, durationSeconds: 506, transportType: 'AUTOMOBILE', stepIndexes: [0, 1, 2], hasTolls: true },
    { name: '2nd St', distanceMeters: 2342, durationSeconds: 592, transportType: 'AUTOMOBILE', stepIndexes: [3] },
  ],
  steps: [
    { stepPathIndex: 0, distanceMeters: 0, durationSeconds: 0 },
    { stepPathIndex: 1, distanceMeters: 37, durationSeconds: 11, instructions: 'Turn right onto Minna St' },
    { stepPathIndex: 2, distanceMeters: 1996, durationSeconds: 495, instructions: 'Walk the rest', transportType: 'WALKING' },
    { stepPathIndex: 3, instructions: 'Arrive' },
  ],
  stepPaths: [[{ latitude: 1, longitude: 2 }]],
};

describe('compactDirections', () => {
  const departure = new Date('2026-10-03T16:00:00Z');

  it('projects routes with formatted distance/duration, tolls, arrival and steps; drops stepPaths', () => {
    const out = compactDirections(DIRECTIONS, { zone: ZONE, departure });
    expect(out.origin).toEqual({ name: 'Start', latitude: 37.7857, longitude: -122.4011 });
    expect(out.destination).toMatchObject({ name: 'San Francisco Public Library - Mission Bay', latitude: 37.7753881 });
    expect(out.routes).toEqual([
      {
        name: '4th St',
        distanceMeters: 2033,
        distance: '1.3 mi / 2.0 km',
        durationSeconds: 506,
        duration: '8 min',
        hasTolls: true,
        transportType: 'automobile',
        estimatedArrival: '2026-10-03T12:08:26-04:00',
        estimatedArrivalDisplay: 'Sat, Oct 3, 2026, 12:08 PM EDT',
        steps: [
          { instructions: 'Turn right onto Minna St', distance: '121 ft / 37 m', duration: '11 s' },
          { instructions: 'Walk the rest', distance: '1.2 mi / 2.0 km', duration: '8 min', transportType: 'walking' },
        ],
      },
      {
        name: '2nd St',
        distanceMeters: 2342,
        distance: '1.5 mi / 2.3 km',
        durationSeconds: 592,
        duration: '10 min',
        transportType: 'automobile',
        estimatedArrival: '2026-10-03T12:09:52-04:00',
        estimatedArrivalDisplay: 'Sat, Oct 3, 2026, 12:09 PM EDT',
        steps: [{ instructions: 'Arrive' }],
      },
    ]);
    expect(JSON.stringify(out)).not.toContain('stepPaths');
  });

  it('tolerates missing origin/destination/routes/steps and routes without numbers', () => {
    expect(compactDirections({}, { zone: ZONE })).toEqual({ routes: [] });
    expect(compactDirections({ routes: [{ name: 'X', distanceMeters: 5, stepIndexes: [0] }] }, { zone: ZONE })).toEqual({
      routes: [{ name: 'X', distanceMeters: 5, distance: '16 ft / 5 m' }],
    });
    expect(compactDirections({ routes: [{ name: 'Y', durationSeconds: 5 }], steps: [] }, { zone: ZONE })).toEqual({
      routes: [{ name: 'Y', durationSeconds: 5, duration: '5 s' }],
    });
  });

  it('throws on unrecognised shapes', () => {
    expect(() => compactDirections([], { zone: ZONE })).toThrow('not an object');
    expect(() => compactDirections({ routes: {} }, { zone: ZONE })).toThrow('routes is not an array');
    expect(() => compactDirections({ routes: [], steps: 'x' }, { zone: ZONE })).toThrow('steps is not an array');
    expect(() => compactDirections({ routes: ['x'] }, { zone: ZONE })).toThrow('a route is not an object');
    expect(() => compactDirections({ routes: [{ name: 'renamed', distance: 5, duration: 9 }] }, { zone: ZONE })).toThrow('a route has no distance or duration');
    expect(() => compactDirections({ routes: [{ distanceMeters: 1, stepIndexes: [5] }], steps: [] }, { zone: ZONE })).toThrow('step 5 is missing');
    expect(() => compactDirections({ routes: [{ distanceMeters: 1, stepIndexes: ['0'] }], steps: [{}] }, { zone: ZONE })).toThrow('step -1 is missing');
  });
});

const dest = (index: number, latitude: number, longitude: number): EtaDestination => ({
  index,
  value: `${latitude},${longitude}`,
  latitude,
  longitude,
});

describe('matchEtas', () => {
  const d0 = dest(0, 37.32556561130194, -121.94635203581443);
  const d1 = dest(1, 37.44176585512703, -122.17259315798667);
  const e0 = { destination: { latitude: 37.32556561130194, longitude: -121.94635203581443 }, distanceMeters: 9550 };
  const e1 = { destination: { latitude: 37.44176585512703, longitude: -122.17259315798667 }, distanceMeters: 23286 };

  it('pairs by echoed coordinate regardless of order', () => {
    const m = matchEtas([e1, e0], [d0, d1]);
    expect(m.matched.map((x) => [x.destination.index, x.eta.distanceMeters])).toEqual([
      [0, 9550],
      [1, 23286],
    ]);
    expect(m.missing).toEqual([]);
    expect(m.unmatched).toEqual([]);
  });

  it('pairs duplicated destinations one-to-one', () => {
    const m = matchEtas([e0, e0], [d0, dest(1, d0.latitude, d0.longitude)]);
    expect(m.matched.map((x) => x.destination.index)).toEqual([0, 1]);
  });

  it('falls back to order when exactly as many are left on both sides', () => {
    const snapped = { destination: { latitude: 37.4, longitude: -122.1 }, distanceMeters: 1 };
    const noEcho = { distanceMeters: 2 };
    const m = matchEtas([noEcho, snapped], [d0, d1]);
    expect(m.matched.map((x) => [x.destination.index, x.eta.distanceMeters])).toEqual([
      [0, 2],
      [1, 1],
    ]);
  });

  it('reports missing destinations and unmatched etas instead of guessing', () => {
    const m = matchEtas([e0], [d0, d1]);
    expect(m.matched).toHaveLength(1);
    expect(m.missing).toEqual([d1]);
    expect(m.unmatched).toEqual([]);

    const stray = { destination: { latitude: 10, longitude: 10 } };
    const m2 = matchEtas([stray, e0, 'junk'], [d0, d1]);
    expect(m2.matched.map((x) => x.destination.index)).toEqual([0]);
    expect(m2.missing).toEqual([d1]);
    expect(m2.unmatched).toEqual([stray, 'junk']);

    // A destination echo without numeric coordinates cannot be paired by position when counts differ.
    const m4 = matchEtas([{ destination: {} }, { destination: { latitude: '1', longitude: 2 } }], [d0]);
    expect(m4.matched).toEqual([]);
    expect(m4.unmatched).toHaveLength(2);

    const m3 = matchEtas(['junk'], [d0]);
    expect(m3.matched).toEqual([]);
    expect(m3.missing).toEqual([d0]);
    expect(m3.unmatched).toEqual(['junk']);

    expect(matchEtas([], [d0])).toEqual({ matched: [], missing: [d0], unmatched: [] });
  });
});

describe('compactEta', () => {
  it('formats distance and both travel times and adds the arrival estimate', () => {
    const out = compactEta(
      {
        destination: dest(1, 37.3, -121.9),
        eta: { transportType: 'AUTOMOBILE', distanceMeters: 9550, expectedTravelTimeSeconds: 975, staticTravelTimeSeconds: 540 },
      },
      { zone: ZONE, departure: new Date('2026-10-03T16:00:00Z') },
    );
    expect(out).toEqual({
      destinationIndex: 1,
      destination: '37.3,-121.9',
      distanceMeters: 9550,
      distance: '5.9 mi / 9.6 km',
      expectedTravelTimeSeconds: 975,
      travelTime: '16 min',
      staticTravelTimeSeconds: 540,
      travelTimeWithoutTraffic: '9 min',
      transportType: 'automobile',
      estimatedArrival: '2026-10-03T12:16:15-04:00',
      estimatedArrivalDisplay: 'Sat, Oct 3, 2026, 12:16 PM EDT',
    });
    expect(compactEta({ destination: dest(0, 1, 2), eta: { staticTravelTimeSeconds: 60 } }, { zone: ZONE })).toEqual({
      destinationIndex: 0,
      destination: '1,2',
      staticTravelTimeSeconds: 60,
      travelTimeWithoutTraffic: '1 min',
    });
    expect(compactEta({ destination: dest(2, 1, 2), eta: { distanceMeters: 1000, expectedTravelTimeSeconds: 90 } }, { zone: ZONE })).toEqual({
      destinationIndex: 2,
      destination: '1,2',
      distanceMeters: 1000,
      distance: '0.6 mi / 1.0 km',
      expectedTravelTimeSeconds: 90,
      travelTime: '2 min',
    });
    expect(() => compactEta({ destination: dest(3, 1, 2), eta: { travelSeconds: 60 } }, { zone: ZONE })).toThrow(
      'the ETA for destination 3 has no distance or travel time',
    );
  });
});
