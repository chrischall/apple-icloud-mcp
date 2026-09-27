import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppleToolError, TransportError, UpstreamError } from '../../src/errors.js';
import {
  CACHE_TTL_MS,
  checkChartFeed,
  checkItunesEnvelope,
  classifyChartError,
  classifyItunesError,
  createItunesClient,
  getDefaultItunesClient,
  resetDefaultItunesClient,
} from '../../src/itunes/client.js';
import { PODCAST, SONG, chartFeed, chartSong, envelope, itunesResponse, jsonResponse } from './fixtures.js';

function stubFetch(...responses: Array<Response | (() => Response) | Error>) {
  const fn = vi.fn(async (_url: unknown, _init?: unknown) => {
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : (next as Response).clone();
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function calledUrl(fn: ReturnType<typeof stubFetch>, i = 0): string {
  return String(fn.mock.calls[i]?.[0]);
}

afterEach(() => {
  resetDefaultItunesClient();
  vi.restoreAllMocks();
});

describe('itunes endpoint', () => {
  it('GETs itunes.apple.com with the query and parses the text/javascript JSON body', async () => {
    const fetch = stubFetch(itunesResponse(envelope([SONG])));
    const client = createItunesClient({ now: () => 1_000 });
    const res = await client.itunes('search', { term: 'let down', media: 'music', country: 'us', limit: 5, entity: undefined });
    expect(calledUrl(fetch)).toBe('https://itunes.apple.com/search?term=let%20down&media=music&country=us&limit=5');
    expect(res).toEqual({ data: envelope([SONG]), cached: false, fetchedAt: 1_000 });
  });

  it('serves a repeat from the cache for an hour, with the original fetch time', async () => {
    let t = 0;
    const fetch = stubFetch(itunesResponse(envelope([SONG])));
    const client = createItunesClient({ now: () => t });
    await client.itunes('lookup', { id: ['1'] });
    t = 5_000;
    const again = await client.itunes('lookup', { id: ['1'] });
    expect(again.cached).toBe(true);
    expect(again.fetchedAt).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    t = CACHE_TTL_MS + 1;
    const expired = await client.itunes('lookup', { id: ['1'] });
    expect(expired.cached).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fresh bypasses the cache (and still refreshes it)', async () => {
    let t = 0;
    const fetch = stubFetch(itunesResponse(envelope([SONG])));
    const client = createItunesClient({ now: () => t });
    await client.itunes('lookup', { id: '909253' });
    t = 1_000;
    const probe = await client.itunes('lookup', { id: '909253' }, { fresh: true });
    expect(probe).toMatchObject({ cached: false, fetchedAt: 1_000 });
    expect(fetch).toHaveBeenCalledTimes(2);
    t = 2_000;
    // The next ordinary call is served the refreshed entry.
    expect(await client.itunes('lookup', { id: '909253' })).toMatchObject({ cached: true, fetchedAt: 1_000 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('identical concurrent requests share one upstream call', async () => {
    const fetch = stubFetch(itunesResponse(envelope([SONG])));
    const client = createItunesClient({ now: () => 0 });
    const [a, b] = await Promise.all([client.itunes('search', { term: 'x' }), client.itunes('search', { term: 'x' })]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a.data).toEqual(b.data);
  });

  it('never caches a failure', async () => {
    const fetch = stubFetch(itunesResponse('{"errorMessage":"Invalid value(s) for key(s): [country]"}', 400), itunesResponse(envelope([SONG])));
    const client = createItunesClient({ now: () => 0 });
    await expect(client.itunes('search', { term: 'x' })).rejects.toBeInstanceOf(UpstreamError);
    await expect(client.itunes('search', { term: 'x' })).resolves.toMatchObject({ cached: false });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("maps Apple's 400 errorMessage keys back to this tool's argument names", async () => {
    stubFetch(
      itunesResponse(
        { errorMessage: 'Invalid value(s) for key(s): [attributeType, resultEntity]', queryParameters: { output: 'json' } },
        400,
      ),
    );
    const client = createItunesClient({ now: () => 0 });
    const err = (await client.itunes('search', { term: 'x' }).catch((e: unknown) => e)) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(err.status).toBe(400);
    expect(err.message).toBe('itunes: Apple rejected the request — Invalid value(s) for key(s): [attributeType, resultEntity]');
    expect(err.hint).toBe('Check the value of: attribute, entity.');
  });

  it('a 403 is reported as Apple rate limiting, with the budget in the hint', async () => {
    stubFetch(itunesResponse('', 403));
    const client = createItunesClient({ now: () => 0 });
    const err = (await client.itunes('search', { term: 'x' }).catch((e: unknown) => e)) as UpstreamError;
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.hint).toContain('about 20 iTunes Search/Lookup requests per minute');
  });

  it('a body without a results list is an error, never an empty answer', async () => {
    stubFetch(itunesResponse({ resultCount: 0 }));
    const err = await createItunesClient({ now: () => 0 })
      .itunes('search', { term: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).message).toContain('/search answered without a results list');
  });

  it('a body that is not JSON is an error', async () => {
    stubFetch(itunesResponse('<html>busy</html>'));
    await expect(createItunesClient({ now: () => 0 }).itunes('lookup', { id: '1' })).rejects.toThrow(/not valid JSON/);
  });

  it('warns on stderr when a record drifts, and passes the raw record through', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const drifted = { ...SONG, trackId: '1097861834' };
    stubFetch(itunesResponse(envelope([drifted])));
    const res = await createItunesClient({ now: () => 0 }).itunes('lookup', { id: '1097861834' });
    expect(res.data.results[0]).toEqual(drifted);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/unexpected GET itunes\.apple\.com\/lookup shape/);
  });

  it('keeps Apple key order in records (full view is verbatim)', async () => {
    stubFetch(itunesResponse(envelope([PODCAST])));
    const res = await createItunesClient({ now: () => 0 }).itunes('lookup', { id: '1200361736' });
    expect(Object.keys(res.data.results[0] as object)).toEqual(Object.keys(PODCAST));
  });

  it('a transport failure surfaces as an error', async () => {
    stubFetch(new TypeError('fetch failed'));
    await expect(createItunesClient({ now: () => 0 }).itunes('lookup', { id: '1' })).rejects.toBeInstanceOf(TransportError);
  });
});

describe('module-wide throttle', () => {
  it('lets 20 requests through a minute, then waits for the window', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const fetch = stubFetch(() => itunesResponse(envelope([])));
    const client = createItunesClient({
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    for (let i = 0; i < 20; i++) await client.itunes('search', { term: `q${i}` });
    expect(sleeps).toEqual([]);
    t = 40_000;
    await client.itunes('search', { term: 'q20' });
    expect(sleeps).toEqual([20_000]);
    expect(fetch).toHaveBeenCalledTimes(21);
    // Cache hits do not spend the budget.
    await client.itunes('search', { term: 'q0' });
    expect(fetch).toHaveBeenCalledTimes(21);
  });

  it('refuses with RATE_LIMITED rather than hang when the next slot is over 30 s away', async () => {
    const fetch = stubFetch(() => itunesResponse(envelope([])));
    const client = createItunesClient({ now: () => 0 });
    for (let i = 0; i < 20; i++) await client.itunes('lookup', { id: String(i) });
    const err = (await client.itunes('lookup', { id: '99' }).catch((e: unknown) => e)) as AppleToolError;
    expect(err).toBeInstanceOf(AppleToolError);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.message).toContain('the next one could start in 60 s');
    expect(err.hint).toContain('Retry in about 60 seconds');
    expect((err as AppleToolError & { service?: string }).service).toBe('itunes');
    expect(fetch).toHaveBeenCalledTimes(20);
  });

  it('a call can set its own, shorter wait limit (the health probe)', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const fetch = stubFetch(() => itunesResponse(envelope([])));
    const client = createItunesClient({
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    for (let i = 0; i < 20; i++) await client.itunes('lookup', { id: String(i) });
    t = 50_000; // the window opens in 10 s: fine for a tool call, too long for this one
    const err = (await client.itunes('lookup', { id: '99' }, { fresh: true, maxWaitMs: 5_000 }).catch((e: unknown) => e)) as AppleToolError;
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.message).toContain('could start in 10 s');
    expect(fetch).toHaveBeenCalledTimes(20);
    // The refusal reserved nothing: an ordinary call still gets the 10 s slot.
    await client.itunes('lookup', { id: '99' });
    expect(sleeps).toEqual([10_000]);
    expect(fetch).toHaveBeenCalledTimes(21);
  });

  it('does not throttle the chart host', async () => {
    const fetch = stubFetch(() => jsonResponse(chartFeed([])));
    const client = createItunesClient({ now: () => 0 });
    for (let i = 1; i <= 25; i++) await client.chart('us', 'music', 'most-played', i, 'songs');
    expect(fetch).toHaveBeenCalledTimes(25);
  });
});

describe('chart endpoint', () => {
  it('GETs the RSS feed path and returns the feed', async () => {
    const fetch = stubFetch(jsonResponse(chartFeed([chartSong(0)])));
    const client = createItunesClient({ now: () => 7 });
    const res = await client.chart('gb', 'music', 'most-played', 10, 'songs');
    expect(calledUrl(fetch)).toBe('https://rss.marketingtools.apple.com/api/v2/gb/music/most-played/10/songs.json');
    expect(res.data.results).toEqual([chartSong(0)]);
    expect(res.data.title).toBe('Top Songs');
    expect(res.fetchedAt).toBe(7);
    const again = await client.chart('gb', 'music', 'most-played', 10, 'songs');
    expect(again.cached).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("explains Apple's HTTP 500 for a storefront without charts", async () => {
    stubFetch(new Response('<html><title>500 Internal Server Error</title></html>', { status: 500, headers: { 'content-type': 'text/html' } }));
    const err = (await createItunesClient({ now: () => 0 })
      .chart('zz', 'music', 'most-played', 10, 'songs')
      .catch((e: unknown) => e)) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(500);
    expect(err.message).toBe('itunes: Apple\'s music/most-played/songs chart feed failed with HTTP 500 for storefront "zz".');
    expect(err.hint).toContain('an unknown country code');
  });

  it('other statuses keep the default mapping', async () => {
    stubFetch(jsonResponse({ status: 404, error: 'Not Found' }, 404));
    const err = (await createItunesClient({ now: () => 0 })
      .chart('us', 'music', 'top-free', 10, 'songs')
      .catch((e: unknown) => e)) as UpstreamError;
    expect(err.code).toBe('NOT_FOUND');
  });

  it('a feed without results is an error', async () => {
    stubFetch(jsonResponse({ feed: { title: 'Top Songs' } }));
    await expect(createItunesClient({ now: () => 0 }).chart('us', 'music', 'most-played', 10, 'songs')).rejects.toThrow(
      /music\/most-played\/songs chart feed answered without a results list/,
    );
  });
});

describe('error classification and shape checks', () => {
  it('classifyItunesError leaves what it does not recognise to the default mapping', () => {
    expect(classifyItunesError(400, '<html>bad</html>')).toBeUndefined();
    expect(classifyItunesError(400, '{"message":"x"}')).toBeUndefined();
    expect(classifyItunesError(400, '"text"')).toBeUndefined();
    expect(classifyItunesError(500, '')).toBeUndefined();
    const plain = classifyItunesError(400, '{"errorMessage":"Something odd"}') as UpstreamError;
    expect(plain.hint).toBe('Check the arguments against the tool description.');
    const unknownKey = classifyItunesError(400, '{"errorMessage":"Invalid value(s) for key(s): [weirdKey, ]"}') as UpstreamError;
    expect(unknownKey.hint).toBe('Check the value of: weirdKey.');
  });

  it('classifyChartError only claims HTTP 500', () => {
    expect(classifyChartError('us', 'apps/top-free/apps')(502)).toBeUndefined();
    expect(classifyChartError('us', 'apps/top-free/apps')(500)).toBeInstanceOf(UpstreamError);
  });

  it('checkItunesEnvelope / checkChartFeed refuse anything without a results array', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => checkItunesEnvelope(null, 'search')).toThrow(UpstreamError);
    expect(() => checkItunesEnvelope({ results: 'none' }, 'search')).toThrow(UpstreamError);
    expect(checkItunesEnvelope({ results: [] }, 'search')).toEqual({ results: [] });
    expect(() => checkChartFeed([], 'x')).toThrow(UpstreamError);
    expect(() => checkChartFeed({ feed: [] }, 'x')).toThrow(UpstreamError);
    expect(checkChartFeed(chartFeed([]), 'x').results).toEqual([]);
  });
});

describe('default client', () => {
  it('is one module-wide instance, built on first use', () => {
    const a = getDefaultItunesClient();
    expect(getDefaultItunesClient()).toBe(a);
    resetDefaultItunesClient();
    expect(getDefaultItunesClient()).not.toBe(a);
  });

  it('works with the real clock', async () => {
    stubFetch(itunesResponse(envelope([SONG])));
    const before = Date.now();
    const res = await getDefaultItunesClient().itunes('lookup', { id: '1097861834' });
    expect(res.fetchedAt).toBeGreaterThanOrEqual(before);
  });
});
