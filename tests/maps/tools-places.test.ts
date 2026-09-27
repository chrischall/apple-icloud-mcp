import { beforeEach, describe, expect, it, vi } from 'vitest';
import { harness } from './_helpers.js';

beforeEach(() => {
  process.env.DISPLAY_TZ = 'America/New_York';
});

const APPLE_PARK = {
  coordinate: { latitude: 37.3346438, longitude: -122.008972 },
  displayMapRegion: { southLatitude: 37.32, westLongitude: -122.01, northLatitude: 37.33, eastLongitude: -122.0 },
  name: 'Apple Park Way',
  formattedAddressLines: ['Apple Park Way', 'Cupertino, CA  95014', 'United States'],
  structuredAddress: { locality: 'Cupertino', postCode: '95014', areasOfInterest: ['Apple Park'] },
  country: 'United States',
  countryCode: 'US',
};

const COMPACT_APPLE_PARK = {
  name: 'Apple Park Way',
  latitude: 37.3346438,
  longitude: -122.008972,
  address: 'Apple Park Way, Cupertino, CA 95014, United States',
  countryCode: 'US',
};

describe('apple_maps_geocode', () => {
  it('geocodes with every hint and returns compact places', async () => {
    const h = harness({ '/v1/geocode': () => ({ data: { results: [APPLE_PARK] } }) });
    const { isError, json } = await h.call('apple_maps_geocode', {
      address: '  Apple Park, Cupertino ',
      limitToCountries: ['us', 'ca'],
      near: { latitude: 37.33, longitude: -122.03 },
      lang: 'en-GB',
    });
    expect(isError).toBe(false);
    expect(h.dataCalls()[0]!.query).toEqual({
      q: 'Apple Park, Cupertino',
      limitToCountries: ['US', 'CA'],
      lang: 'en-GB',
      searchLocation: '37.33,-122.03',
    });
    expect(json).toEqual({
      returned: 1,
      query: { address: 'Apple Park, Cupertino', limitToCountries: ['US', 'CA'], near: { latitude: 37.33, longitude: -122.03 }, lang: 'en-GB' },
      places: [COMPACT_APPLE_PARK],
    });
    expect(Object.keys(json).at(-1)).toBe('places');
  });

  it('view full returns Apple’s records verbatim (and never sends view upstream)', async () => {
    const h = harness({ '/v1/geocode': () => ({ data: { results: [APPLE_PARK] } }) });
    const { json } = await h.call('apple_maps_geocode', { address: 'Apple Park', view: 'full' });
    expect(json.places).toEqual([APPLE_PARK]);
    expect(h.dataCalls()[0]!.query).toEqual({ q: 'Apple Park' });
  });

  it('says what was searched when nothing matched (absent results = empty)', async () => {
    const h = harness({ '/v1/geocode': [() => ({ data: { results: [] } }), () => ({ data: {} })] });
    const a = await h.call('apple_maps_geocode', { address: 'Nowhere 123', limitToCountries: ['fr'], near: { latitude: 1, longitude: 2 } });
    expect(a.json).toEqual({
      returned: 0,
      query: { address: 'Nowhere 123', limitToCountries: ['FR'], near: { latitude: 1, longitude: 2 } },
      note: 'Apple Maps found no match for "Nowhere 123" (countries FR; near 1,2).',
      places: [],
    });
    const b = await h.call('apple_maps_geocode', { address: 'Nowhere' });
    expect(b.json.note).toBe('Apple Maps found no match for "Nowhere".');
  });

  it('never renders a malformed upstream body as an empty result', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({
      '/v1/geocode': [
        () => ({ data: null }),
        () => ({ data: { results: { oops: true } } }),
        () => ({ data: '<html>' }),
        // `results` renamed: the places are there, under another key.
        () => ({ data: { places: [APPLE_PARK] } }),
      ],
    });
    for (let i = 0; i < 4; i++) {
      const { isError, json } = await h.call('apple_maps_geocode', { address: 'x' });
      expect(isError).toBe(true);
      expect(json.error.code).toBe('UPSTREAM_ERROR');
      expect(json.places).toBeUndefined();
    }
    warn.mockRestore();
  });

  it('falls back to the raw records (with a stderr warning) when the projection cannot read them', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const odd = { location: { lat: 1, lng: 2 } };
    const h = harness({ '/v1/geocode': () => ({ data: { results: [APPLE_PARK, odd] } }) });
    const { json } = await h.call('apple_maps_geocode', { address: 'x' });
    expect(json.places).toEqual([APPLE_PARK, odd]);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/could not project GET \/v1\/geocode results/);
    warn.mockRestore();
  });

  it('refuses a blank address before calling Apple', async () => {
    const h = harness({});
    const { isError, json } = await h.call('apple_maps_geocode', { address: '   ' });
    expect(isError).toBe(true);
    expect(json.error).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'address is empty.' });
    expect(h.request).not.toHaveBeenCalled();
  });

  it('surfaces an Apple 400 as INVALID_ARGUMENT and a 429 as RATE_LIMITED', async () => {
    const h = harness({
      '/v1/geocode': [
        () => ({ error: 400, body: '{"error":{"message":"Invalid lang","details":["lang"]}}' }),
        () => ({ error: 429 }),
      ],
    });
    const a = await h.call('apple_maps_geocode', { address: 'x' });
    expect(a.json.error).toMatchObject({ code: 'INVALID_ARGUMENT', status: 400, service: 'maps' });
    expect(a.json.error.message).toContain('Invalid lang (lang)');
    const b = await h.call('apple_maps_geocode', { address: 'x' });
    expect(b.json.error).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(b.json.error.hint).toMatch(/25,000/);
  });
});

describe('apple_maps_reverse_geocode', () => {
  it('sends loc=lat,lng and projects', async () => {
    const h = harness({ '/v1/reverseGeocode': () => ({ data: { results: [APPLE_PARK] } }) });
    const { json } = await h.call('apple_maps_reverse_geocode', { latitude: 37.3301996, longitude: -122.0106415, lang: 'de-DE' });
    expect(h.dataCalls()[0]!.query).toEqual({ loc: '37.3301996,-122.0106415', lang: 'de-DE' });
    expect(json).toEqual({
      returned: 1,
      query: { latitude: 37.3301996, longitude: -122.0106415, lang: 'de-DE' },
      places: [COMPACT_APPLE_PARK],
    });
  });

  it('full view and empty results', async () => {
    const h = harness({ '/v1/reverseGeocode': [() => ({ data: { results: [APPLE_PARK] } }), () => ({ data: { results: [] } })] });
    expect((await h.call('apple_maps_reverse_geocode', { latitude: 1, longitude: 2, view: 'full' })).json.places).toEqual([APPLE_PARK]);
    const empty = await h.call('apple_maps_reverse_geocode', { latitude: 0, longitude: -160 });
    expect(empty.json.note).toBe('Apple Maps has no address at 0,-160 (open water or an unmapped area?).');
    expect(empty.json.places).toEqual([]);
  });

  it('re-checks ranges in the handler', async () => {
    const h = harness({});
    const { json } = await h.call('apple_maps_reverse_geocode', { latitude: 100, longitude: 0 });
    expect(json.error.code).toBe('INVALID_ARGUMENT');
  });
});

const EIFFEL = {
  id: 'I6FD4B5A6E2D4B2A0',
  name: 'Eiffel Tower',
  poiCategory: 'Landmark',
  formattedAddressLines: ['5 Avenue Anatole France', '75007 Paris', 'France'],
  countryCode: 'FR',
  coordinate: { latitude: 48.85827172505176, longitude: 2.294531782785587 },
};

describe('apple_maps_search', () => {
  it('always enables pagination, sends filters, and puts paging facts first', async () => {
    const h = harness({
      '/v1/search': () => ({
        data: {
          displayMapRegion: { southLatitude: 1 },
          results: [EIFFEL],
          paginationInfo: { nextPageToken: 'NEXT', prevPageToken: 'PREV', totalPageCount: 3, totalResults: 25 },
        },
      }),
    });
    const { json } = await h.call('apple_maps_search', {
      query: 'eiffel tower',
      near: { latitude: 48.85, longitude: 2.29 },
      categories: ['Landmark', 'Museum'],
      resultTypes: ['poi'],
      limitToCountries: ['fr'],
      lang: 'fr-FR',
      pageToken: 'CURRENT',
    });
    expect(h.dataCalls()[0]!.query).toEqual({
      q: 'eiffel tower',
      includePoiCategories: ['Landmark', 'Museum'],
      resultTypeFilter: ['poi'],
      limitToCountries: ['FR'],
      lang: 'fr-FR',
      searchLocation: '48.85,2.29',
      enablePagination: true,
      pageToken: 'CURRENT',
    });
    expect(Object.keys(json)).toEqual(['returned', 'hasMore', 'nextPageToken', 'prevPageToken', 'totalResults', 'totalPages', 'query', 'notes', 'places']);
    expect(json).toMatchObject({ returned: 1, hasMore: true, nextPageToken: 'NEXT', prevPageToken: 'PREV', totalResults: 25, totalPages: 3 });
    expect(json.notes).toEqual(['More results exist: call again with the same query and filters plus pageToken = nextPageToken.']);
    expect(json.places).toEqual([
      {
        id: 'I6FD4B5A6E2D4B2A0',
        name: 'Eiffel Tower',
        category: 'Landmark',
        latitude: 48.85827172505176,
        longitude: 2.294531782785587,
        address: '5 Avenue Anatole France, 75007 Paris, France',
        countryCode: 'FR',
      },
    ]);
  });

  it('last page: hasMore false with nextPageToken null; full view adds the display region', async () => {
    const h = harness({
      '/v1/search': () => ({ data: { displayMapRegion: { southLatitude: 1 }, results: [EIFFEL], paginationInfo: { nextPageToken: '', totalPageCount: 1 } } }),
    });
    const { json } = await h.call('apple_maps_search', { query: 'eiffel', view: 'full' });
    expect(json).toEqual({
      returned: 1,
      hasMore: false,
      nextPageToken: null,
      totalPages: 1,
      query: { query: 'eiffel' },
      displayMapRegion: { southLatitude: 1 },
      places: [EIFFEL],
    });
  });

  it('full view without a display region omits it', async () => {
    const h = harness({ '/v1/search': () => ({ data: { results: [EIFFEL], paginationInfo: {} } }) });
    const { json } = await h.call('apple_maps_search', { query: 'eiffel', view: 'full' });
    expect(json.displayMapRegion).toBeUndefined();
  });

  it('an empty page names every filter that was applied, and missing pagination info is called out', async () => {
    const h = harness({ '/v1/search': () => ({ data: { results: [] } }) });
    const { json } = await h.call('apple_maps_search', {
      query: 'unicorn stable',
      near: { latitude: 1, longitude: 2 },
      categories: ['Zoo'],
      resultTypes: ['poi', 'address'],
      limitToCountries: ['us'],
      pageToken: 'T',
    });
    // A later page with no pagination info cannot claim to be the last one.
    expect(json.hasMore).toBeNull();
    expect(json.notes).toEqual([
      'Apple Maps found no places for "unicorn stable" (near 1,2; categories Zoo; result types poi,address; countries US; at the given pageToken).',
      'Apple sent no pagination info with this page, so whether more results exist is unknown (hasMore is null).',
    ]);
    expect(json.places).toEqual([]);
  });

  it('hasMore is null (not false) when a page of results arrives without pagination info', async () => {
    const h = harness({ '/v1/search': () => ({ data: { results: [EIFFEL] } }) });
    const { json } = await h.call('apple_maps_search', { query: 'eiffel' });
    expect(json).toMatchObject({ returned: 1, hasMore: null, nextPageToken: null });
    expect(json.notes).toEqual(['Apple sent no pagination info with this page, so whether more results exist is unknown (hasMore is null).']);
  });

  it('an empty FIRST page without pagination info is simply empty: hasMore false, no "unknown" note', async () => {
    const h = harness({ '/v1/search': () => ({ data: { results: [] } }) });
    const { json } = await h.call('apple_maps_search', { query: 'unicorn stable' });
    expect(json).toMatchObject({ returned: 0, hasMore: false, nextPageToken: null });
    expect(json.notes).toEqual(['Apple Maps found no places for "unicorn stable".']);
  });

  it('a renamed result list is an upstream error, never "found no places"', async () => {
    const h = harness({ '/v1/search': () => ({ data: { places: [EIFFEL], paginationInfo: {} } }) });
    const { isError, json } = await h.call('apple_maps_search', { query: 'eiffel' });
    expect(isError).toBe(true);
    expect(json.error).toMatchObject({ code: 'UPSTREAM_ERROR', service: 'maps' });
    expect(json.error.message).toBe('maps: GET /v1/search returned no "results" list but an unexpected "places" list.');
    expect(json.places).toBeUndefined();
  });

  it('refuses a blank query', async () => {
    const h = harness({});
    expect((await h.call('apple_maps_search', { query: ' ' })).json.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('apple_maps_lookup_place', () => {
  it('looks ids up in one call, reports per-id errors with their meaning, and dedupes', async () => {
    const h = harness({
      '/v1/place': () => ({
        data: {
          results: [EIFFEL, { ...APPLE_PARK, id: 'CANONICAL', alternateIds: ['OLDID', 7] }, 'junk'],
          errors: [
            { id: 'BADID', errorCode: 'FAILED_INVALID_ID' },
            { id: 'GONE', errorCode: 'FAILED_NOT_FOUND' },
            { id: 'FLAKY', errorCode: 'FAILED_INTERNAL_ERROR' },
            { id: 'ODD', errorCode: 'FAILED_SOMETHING_NEW' },
            'junk',
          ],
        },
      }),
    });
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { json } = await h.call('apple_maps_lookup_place', {
      placeIds: ['I6FD4B5A6E2D4B2A0', ' OLDID ', 'BADID', 'GONE', 'FLAKY', 'ODD', 'MISSING', 'OLDID'],
      lang: 'en-US',
    });
    warn.mockRestore();
    expect(h.dataCalls()[0]!.query).toEqual({ ids: ['I6FD4B5A6E2D4B2A0', 'OLDID', 'BADID', 'GONE', 'FLAKY', 'ODD', 'MISSING'], lang: 'en-US' });
    expect(Object.keys(json)).toEqual(['requested', 'returned', 'failed', 'notes', 'errors', 'places']);
    expect(json).toMatchObject({ requested: 7, returned: 3, failed: 5 });
    expect(json.errors).toEqual([
      { id: 'BADID', errorCode: 'FAILED_INVALID_ID', meaning: 'the id is malformed' },
      { id: 'GONE', errorCode: 'FAILED_NOT_FOUND', meaning: 'no place has this id' },
      { id: 'FLAKY', errorCode: 'FAILED_INTERNAL_ERROR', meaning: 'Apple had an internal error for this id — retry it' },
      { id: 'ODD', errorCode: 'FAILED_SOMETHING_NEW', meaning: 'Apple gave no further detail' },
      { errorCode: 'UNKNOWN', meaning: 'Apple gave no further detail' },
    ]);
    expect(json.notes).toEqual([
      '1 duplicate id(s) were looked up once.',
      '5 of 7 id(s) could not be resolved; see errors.',
      'No result or error names 1 id(s): MISSING. Apple may have returned them under a different (canonical) id — compare the places returned (view "full" shows alternateIds).',
    ]);
    // 'junk' is not a place, so the whole array falls back to raw.
    expect(json.places).toHaveLength(3);
  });

  it('a clean lookup has no notes or errors; compact places', async () => {
    const { id: _drop, ...noId } = APPLE_PARK as typeof APPLE_PARK & { id?: string };
    const h = harness({ '/v1/place': () => ({ data: { results: [EIFFEL, { ...noId, alternateIds: ['PARK'] }] } }) });
    const { json } = await h.call('apple_maps_lookup_place', { placeIds: ['I6FD4B5A6E2D4B2A0', 'PARK'] });
    expect(json).toEqual({
      requested: 2,
      returned: 2,
      failed: 0,
      places: [expect.objectContaining({ id: 'I6FD4B5A6E2D4B2A0', name: 'Eiffel Tower' }), COMPACT_APPLE_PARK],
    });
    expect(h.dataCalls()[0]!.query).toEqual({ ids: ['I6FD4B5A6E2D4B2A0', 'PARK'] });
  });

  it('full view is verbatim', async () => {
    const h = harness({ '/v1/place': () => ({ data: { results: [EIFFEL] } }) });
    const { json } = await h.call('apple_maps_lookup_place', { placeIds: ['I6FD4B5A6E2D4B2A0'], view: 'full' });
    expect(json.places).toEqual([EIFFEL]);
  });

  it('refuses an id that cannot be a place id (it would corrupt the comma-joined list)', async () => {
    const h = harness({});
    const { json } = await h.call('apple_maps_lookup_place', { placeIds: ['ok', 'a,b'] });
    expect(json.error).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'placeIds[1] "a,b" is not an Apple Maps place id.' });
    for (const bad of ['two words', 'tab\there', 'bell\u0007']) {
      const r = await h.call('apple_maps_lookup_place', { placeIds: [bad] });
      expect(r.json.error.code).toBe('INVALID_ARGUMENT');
    }
    expect(h.request).not.toHaveBeenCalled();
  });

  it('accepts any other opaque id (Apple documents none of its shape); it travels percent-encoded', async () => {
    const h = harness({ '/v1/place': () => ({ data: { results: [{ ...EIFFEL, id: 'Ab+/=_x' }] } }) });
    const { isError, json } = await h.call('apple_maps_lookup_place', { placeIds: ['Ab+/=_x'] });
    expect(isError).toBe(false);
    expect(json).toMatchObject({ requested: 1, returned: 1, failed: 0 });
    expect(h.dataCalls()[0]!.query).toEqual({ ids: ['Ab+/=_x'] });
  });

  it('an all-failed lookup (errors and no results) is reported, not refused as a shape change', async () => {
    const h = harness({ '/v1/place': () => ({ data: { errors: [{ id: 'GONE', errorCode: 'FAILED_NOT_FOUND' }] } }) });
    const { isError, json } = await h.call('apple_maps_lookup_place', { placeIds: ['GONE'] });
    expect(isError).toBe(false);
    expect(json).toMatchObject({ requested: 1, returned: 0, failed: 1, errors: [{ id: 'GONE', errorCode: 'FAILED_NOT_FOUND' }], places: [] });
  });
});
