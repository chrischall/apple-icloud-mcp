import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MapsClient } from '../../src/maps/client.js';
import { registerMapsTools } from '../../src/maps/tools.js';
import { KEY, PRIVATE_PEM, fakeServer } from './_helpers.js';

/**
 * The other tool tests assert the `query` object handed to a fake request
 * function. These go through the REAL `httpRequest` (with `fetch` stubbed) and
 * pin the exact URLs Apple receives — the encoding of the ETA `|` separator,
 * comma-joined lists, booleans and dates — against Apple's documented forms.
 */

const TOKEN = 'wire-access-token-000111';

function setup(body: Record<string, unknown>) {
  const urls: string[] = [];
  const auths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      auths.push((init?.headers as Record<string, string>).Authorization!);
      const data = new URL(url).pathname === '/v1/token' ? { accessToken: TOKEN, expiresInSeconds: 1800 } : body;
      return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  const client = new MapsClient({ resolveKey: () => KEY, now: () => Date.parse('2026-10-03T16:00:00Z') });
  const { tools, server } = fakeServer();
  registerMapsTools(server, { client });
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await tools.get(name)!.cb(args, {});
    return { isError: res.isError === true, json: JSON.parse(res.content[0]!.text) as Record<string, any> };
  };
  return { urls, auths, call, dataUrls: () => urls.filter((u) => !u.endsWith('/v1/token')) };
}

beforeEach(() => {
  process.env.DISPLAY_TZ = 'America/New_York';
});

describe('wire format (real httpRequest)', () => {
  it('ETAs: pipe-separated destinations (percent-encoded), Apple-cased transport, UTC departure without milliseconds', async () => {
    const w = setup({ etas: [] });
    await w.call('apple_maps_etas', {
      origin: '37.331423, -122.030503',
      destinations: ['37.3255,-121.9463', '37.44,-122.17'],
      transportType: 'transit',
      departureDate: '2026-10-05T08:00:30.250',
    });
    expect(w.dataUrls()).toEqual([
      'https://maps-api.apple.com/v1/etas?origin=37.331423,-122.030503&destinations=37.3255,-121.9463%7C37.44,-122.17&transportType=Transit&departureDate=2026-10-05T12%3A00%3A30Z',
    ]);
    // The exchange used the signed auth JWT; the data call the access token.
    expect(w.auths[0]).toMatch(/^Bearer eyJ/);
    expect(w.auths[1]).toBe(`Bearer ${TOKEN}`);
  });

  it('search: filters comma-joined, pagination always enabled, free text and page tokens fully encoded', async () => {
    const w = setup({ results: [], paginationInfo: {} });
    await w.call('apple_maps_search', {
      query: "McDonald's & Co #1",
      categories: ['Cafe', 'Restaurant'],
      resultTypes: ['poi', 'pointOfInterest'],
      limitToCountries: ['us', 'ca'],
      near: { latitude: 37.78, longitude: -122.42 },
      pageToken: 'a+b/c=',
    });
    expect(w.dataUrls()).toEqual([
      'https://maps-api.apple.com/v1/search?q=McDonald%27s%20%26%20Co%20%231&includePoiCategories=Cafe,Restaurant' +
        '&resultTypeFilter=poi,pointOfInterest&limitToCountries=US,CA&searchLocation=37.78,-122.42&enablePagination=true&pageToken=a%2Bb%2Fc%3D',
    ]);
  });

  it('directions: an address origin is encoded, coordinates normalized, avoid=Tolls and requestsAlternateRoutes=true', async () => {
    const w = setup({ routes: [] });
    await w.call('apple_maps_directions', {
      origin: '1 Main St, Springfield & Co',
      destination: '37.780000,-122.4',
      avoidTolls: true,
      alternateRoutes: true,
      arrivalDate: '2026-10-05T09:00-07:00',
    });
    expect(w.dataUrls()).toEqual([
      'https://maps-api.apple.com/v1/directions?origin=1%20Main%20St,%20Springfield%20%26%20Co&destination=37.78,-122.4' +
        '&transportType=Automobile&arrivalDate=2026-10-05T16%3A00%3A00Z&avoid=Tolls&requestsAlternateRoutes=true',
    ]);
  });

  it('place lookup, geocode and reverse geocode', async () => {
    const w = setup({ results: [] });
    await w.call('apple_maps_lookup_place', { placeIds: ['I7C250D2CDCB364A', 'Ab+/='] });
    await w.call('apple_maps_geocode', { address: 'Apple Park, Cupertino, CA', limitToCountries: ['us'], lang: 'en-GB' });
    await w.call('apple_maps_reverse_geocode', { latitude: 37.3301996, longitude: -122.0106415 });
    expect(w.dataUrls()).toEqual([
      'https://maps-api.apple.com/v1/place?ids=I7C250D2CDCB364A,Ab%2B%2F%3D',
      'https://maps-api.apple.com/v1/geocode?q=Apple%20Park,%20Cupertino,%20CA&limitToCountries=US&lang=en-GB',
      'https://maps-api.apple.com/v1/reverseGeocode?loc=37.3301996,-122.0106415',
    ]);
    // One exchange served all three calls; nothing secret travelled in a URL.
    expect(w.urls.filter((u) => u.endsWith('/v1/token'))).toHaveLength(1);
    expect(w.urls.join('\n')).not.toContain(TOKEN);
    expect(w.urls.join('\n')).not.toContain(PRIVATE_PEM.split('\n')[1]!);
  });

  it('an Apple 401 answered with a fresh token is replayed once through the real client', async () => {
    const seen: string[] = [];
    let exchange = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | string, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const auth = (init?.headers as Record<string, string>).Authorization!;
        if (path === '/v1/token') {
          exchange += 1;
          return new Response(JSON.stringify({ accessToken: `wire-token-${exchange}-abcdef`, expiresInSeconds: 1800 }), { status: 200 });
        }
        seen.push(auth);
        if (auth === 'Bearer wire-token-1-abcdef') {
          return new Response('{"error":{"message":"Not Authorized","details":[]}}', { status: 401 });
        }
        return new Response('{"results":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    const client = new MapsClient({ resolveKey: () => KEY });
    await expect(client.get('/v1/geocode', { q: 'x' })).resolves.toMatchObject({ status: 200, data: { results: [] } });
    expect(seen).toEqual(['Bearer wire-token-1-abcdef', 'Bearer wire-token-2-abcdef']);
  });
});
