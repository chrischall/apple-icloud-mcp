import { describe, expect, it, vi } from 'vitest';
import { registerMapsTools, resetDefaultMapsClient, defaultMapsClient } from '../../src/maps/tools.js';
import { fakeServer, setKeyEnv } from './_helpers.js';

const NAMES = [
  'apple_maps_geocode',
  'apple_maps_reverse_geocode',
  'apple_maps_search',
  'apple_maps_directions',
  'apple_maps_etas',
  'apple_maps_lookup_place',
  'apple_maps_snapshot_url',
];

function registered() {
  const { tools, server } = fakeServer();
  registerMapsTools(server);
  return tools;
}

describe('registerMapsTools', () => {
  it('registers all seven tools with an EMPTY environment and does no I/O', () => {
    const tools = registered();
    expect([...tools.keys()]).toEqual(NAMES);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('registers every tool in every write mode (they are all reads)', () => {
    for (const mode of ['none', 'additive', 'all', 'typo']) {
      process.env.APPLE_WRITE_MODE = mode;
      expect([...registered().keys()]).toEqual(NAMES);
    }
  });

  it('registers nothing when APPLE_SERVICES excludes maps', () => {
    process.env.APPLE_SERVICES = 'music,weather';
    expect(registered().size).toBe(0);
  });

  it('marks every tool read-only; the snapshot signer contacts nothing', () => {
    const tools = registered();
    for (const [name, t] of tools) {
      expect(t.cfg.annotations.readOnlyHint).toBe(true);
      expect(t.cfg.annotations.openWorldHint).toBe(name !== 'apple_maps_snapshot_url');
      expect(t.cfg.description.length).toBeLessThanOrEqual(600);
      expect(t.cfg.title).toBeTruthy();
    }
  });

  it('answers a call with a structured NOT_CONFIGURED error naming the variables, never an empty result', async () => {
    resetDefaultMapsClient();
    const tools = registered();
    const res = await tools.get('apple_maps_geocode')!.cb({ address: 'Apple Park' }, {});
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.error).toMatchObject({ code: 'NOT_CONFIGURED', service: 'maps' });
    expect(body.error.missing).toContain('APPLE_TEAM_ID');
    const snap = await tools.get('apple_maps_snapshot_url')!.cb({ center: 'Apple Park' }, {});
    expect(JSON.parse(snap.content[0]!.text).error.code).toBe('NOT_CONFIGURED');
  });

  it('uses one process-wide client by default, so the token cache survives calls', async () => {
    resetDefaultMapsClient();
    expect(defaultMapsClient()).toBe(defaultMapsClient());
    setKeyEnv();
    const fetchMock = vi.fn(async (input: URL | string) => {
      const path = new URL(String(input)).pathname;
      const body = path === '/v1/token' ? { accessToken: 'default-client-token-1', expiresInSeconds: 1800 } : { results: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const tools = registered();
    await tools.get('apple_maps_geocode')!.cb({ address: 'Apple Park' }, {});
    await tools.get('apple_maps_reverse_geocode')!.cb({ latitude: 1, longitude: 2 }, {});
    const paths = fetchMock.mock.calls.map((c) => new URL(String(c[0])).pathname);
    expect(paths).toEqual(['/v1/token', '/v1/geocode', '/v1/reverseGeocode']);
    resetDefaultMapsClient();
  });
});

describe('input schemas', () => {
  // Built inside each test (after the suite's env reset), never at collection time.
  const schema = (name: string) => registered().get(name)!.cfg.inputSchema;
  const ok = (name: string, args: unknown) => expect(schema(name).safeParse(args).success).toBe(true);
  const bad = (name: string, args: unknown) => expect(schema(name).safeParse(args).success).toBe(false);

  it('every tool rejects an unknown argument', () => {
    const minimal: Record<string, unknown> = {
      apple_maps_geocode: { address: 'x' },
      apple_maps_reverse_geocode: { latitude: 1, longitude: 2 },
      apple_maps_search: { query: 'x' },
      apple_maps_directions: { origin: 'a', destination: 'b' },
      apple_maps_etas: { origin: '1,2', destinations: ['3,4'] },
      apple_maps_lookup_place: { placeIds: ['I1'] },
      apple_maps_snapshot_url: { center: 'x' },
    };
    for (const name of NAMES) {
      ok(name, minimal[name]);
      bad(name, { ...(minimal[name] as object), daysAhead: 27 });
    }
  });

  it('geocode', () => {
    ok('apple_maps_geocode', { address: 'Apple Park', limitToCountries: ['us', 'CA'], near: { latitude: 37, longitude: -122 }, lang: 'fr-FR', view: 'full' });
    bad('apple_maps_geocode', {});
    bad('apple_maps_geocode', { address: '' });
    bad('apple_maps_geocode', { address: 'x', lang: 'english!' });
    bad('apple_maps_geocode', { address: 'x', limitToCountries: ['USA'] });
    bad('apple_maps_geocode', { address: 'x', limitToCountries: [] });
    bad('apple_maps_geocode', { address: 'x', near: { latitude: 91, longitude: 0 } });
    bad('apple_maps_geocode', { address: 'x', near: { latitude: 1, longitude: 2, altitude: 3 } });
    bad('apple_maps_geocode', { address: 'x', view: 'raw' });
  });

  it('reverse geocode', () => {
    bad('apple_maps_reverse_geocode', { latitude: 90.5, longitude: 0 });
    bad('apple_maps_reverse_geocode', { latitude: 0, longitude: -180.1 });
    bad('apple_maps_reverse_geocode', { latitude: '1', longitude: 2 });
  });

  it('search', () => {
    ok('apple_maps_search', { query: 'coffee', categories: ['Cafe', 'EVCharger'], resultTypes: ['poi', 'address'], pageToken: 'abc' });
    bad('apple_maps_search', { query: 'coffee', categories: ['cafe'] });
    bad('apple_maps_search', { query: 'coffee', resultTypes: ['query'] });
    bad('apple_maps_search', { query: 'coffee', pageToken: '' });
  });

  it('directions', () => {
    ok('apple_maps_directions', {
      origin: 'a',
      destination: 'b',
      transportType: 'cycling',
      departureDate: '2026-10-03T08:00',
      timeZone: 'Europe/London',
      avoidTolls: true,
      alternateRoutes: true,
    });
    bad('apple_maps_directions', { origin: 'a', destination: 'b', transportType: 'transit' });
    bad('apple_maps_directions', { origin: 'a' });
  });

  it('etas', () => {
    ok('apple_maps_etas', { origin: '1,2', destinations: ['1,2'], transportType: 'transit' });
    bad('apple_maps_etas', { origin: '1,2', destinations: [] });
    bad('apple_maps_etas', { origin: '1,2', destinations: Array.from({ length: 11 }, () => '1,2') });
  });

  it('lookup place', () => {
    bad('apple_maps_lookup_place', { placeIds: [] });
    bad('apple_maps_lookup_place', { placeIds: Array.from({ length: 51 }, (_, i) => `I${i}`) });
  });

  it('snapshot url', () => {
    ok('apple_maps_snapshot_url', {
      annotations: [{ point: '1,2', label: 'Home', color: '#FF3B30', glyphText: 'H', markerStyle: 'large' }, { address: 'x', color: 'red' }],
      size: '640x480',
      scale: 2,
      mapType: 'mutedStandard',
      colorScheme: 'dark',
      showPointsOfInterest: false,
      expiresInMinutes: 60,
      lang: 'en-GB',
    });
    bad('apple_maps_snapshot_url', { center: 'x', size: '640 x 480' });
    bad('apple_maps_snapshot_url', { center: 'x', scale: 4 });
    bad('apple_maps_snapshot_url', { center: 'x', zoom: 2 });
    bad('apple_maps_snapshot_url', { center: 'x', expiresInMinutes: 0 });
    bad('apple_maps_snapshot_url', { annotations: [{ point: '1,2', glyphText: 'AB' }] });
    bad('apple_maps_snapshot_url', { annotations: [{ point: '1,2', color: 'rgb(1,2,3)' }] });
    bad('apple_maps_snapshot_url', { annotations: [{ point: '1,2', markerStyle: 'img' }] });
    bad('apple_maps_snapshot_url', { annotations: [{ point: '1,2', imgIdx: 0 }] });
  });
});
