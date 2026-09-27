import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createItunesClient, resetDefaultItunesClient } from '../../src/itunes/client.js';
import { compactChartEntry, compactItunesRecord } from '../../src/itunes/project.js';
import { registerItunesTools } from '../../src/itunes/tools.js';
import { ANNOTATIONS } from '../../src/tools/_shared.js';
import {
  ALBUM,
  ARTIST,
  PODCAST,
  SOFTWARE,
  SONG,
  chartFeed,
  chartSong,
  envelope,
  episode,
  itunesResponse,
  jsonResponse,
} from './fixtures.js';

const NY = 'America/New_York';
const T0 = Date.UTC(2026, 8, 27, 12, 0, 0);
const FETCHED = { cached: false, fetchedAt: '2026-09-27T08:00:00-04:00', fetchedAtDisplay: 'Sun, Sep 27, 2026, 8:00 AM EDT' };

interface Registered {
  cfg: { description: string; inputSchema: z.ZodType; annotations: unknown; title?: string };
  cb: (args: Record<string, unknown>, ctx: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

function fakeServer() {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, cfg: Registered['cfg'], cb: Registered['cb']) => tools.set(name, { cfg, cb }),
  } as unknown as McpServer;
  return { tools, server };
}

function stubFetch(...responses: Array<Response | (() => Response)>) {
  const fn = vi.fn(async (_url: unknown, _init?: unknown) => {
    const next = responses.length > 1 ? responses.shift() : responses[0];
    return typeof next === 'function' ? next() : (next as Response).clone();
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function setup(...responses: Array<Response | (() => Response)>) {
  const fetch = stubFetch(...responses);
  const { tools, server } = fakeServer();
  registerItunesTools(server, { client: createItunesClient({ now: () => T0 }) });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await (tools.get(name) as Registered).cb(args, {});
    return { result, body: JSON.parse(result.content[0]!.text) as Record<string, any> };
  };
  const url = (i = 0) => String(fetch.mock.calls[i]?.[0]);
  return { fetch, tools, call, url };
}

function songs(n: number, from = 0): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({ ...SONG, trackId: 5000 + from + i, trackName: `Song ${from + i}` }));
}

beforeEach(() => {
  process.env.DISPLAY_TZ = NY;
});

afterEach(() => {
  resetDefaultItunesClient();
  vi.restoreAllMocks();
});

describe('registration', () => {
  it('registers all three read tools with an empty environment', () => {
    const { tools, server } = fakeServer();
    registerItunesTools(server);
    expect([...tools.keys()]).toEqual(['apple_itunes_search', 'apple_itunes_lookup', 'apple_charts_get']);
    for (const t of tools.values()) {
      expect(t.cfg.annotations).toEqual(ANNOTATIONS.read);
      expect(t.cfg.description.length).toBeLessThanOrEqual(620);
      expect(() => z.toJSONSchema(t.cfg.inputSchema, { io: 'input' })).not.toThrow();
    }
    expect(tools.get('apple_itunes_search')!.cfg.description).toContain("SAME ids Apple Music's catalog uses");
    expect(tools.get('apple_itunes_search')!.cfg.description).toContain('feedUrl');
  });

  it('registers even in read-only mode, and not at all when the service is switched off', () => {
    process.env.APPLE_WRITE_MODE = 'none';
    const a = fakeServer();
    registerItunesTools(a.server);
    expect(a.tools.size).toBe(3);
    process.env.APPLE_SERVICES = 'music,maps';
    const b = fakeServer();
    registerItunesTools(b.server);
    expect(b.tools.size).toBe(0);
  });

  it('uses the module-wide default client when no deps are given', async () => {
    stubFetch(itunesResponse(envelope([SONG])));
    const { tools, server } = fakeServer();
    registerItunesTools(server);
    const r = await tools.get('apple_itunes_lookup')!.cb({ ids: ['1097861834'] }, {});
    expect(JSON.parse(r.content[0]!.text).results[0].trackName).toBe('Let Down');
  });
});

describe('input schemas', () => {
  const { tools } = (() => {
    const s = fakeServer();
    registerItunesTools(s.server);
    return s;
  })();
  const parse = (name: string, args: unknown) => tools.get(name)!.cfg.inputSchema.safeParse(args).success;

  it('apple_itunes_search', () => {
    expect(parse('apple_itunes_search', { term: 'x' })).toBe(true);
    expect(
      parse('apple_itunes_search', {
        term: 'x',
        media: 'podcast',
        entity: 'podcastEpisode',
        attribute: 'titleTerm',
        country: 'GB',
        limit: 200,
        offset: 0,
        explicit: false,
        lang: 'ja_jp',
        view: 'full',
      }),
    ).toBe(true);
    expect(parse('apple_itunes_search', { term: 'x', unknown: 1 })).toBe(false);
    expect(parse('apple_itunes_search', { term: '' })).toBe(false);
    expect(parse('apple_itunes_search', {})).toBe(false);
    expect(parse('apple_itunes_search', { term: 'x', limit: 0 })).toBe(false);
    expect(parse('apple_itunes_search', { term: 'x', limit: 201 })).toBe(false);
    expect(parse('apple_itunes_search', { term: 'x', offset: -1 })).toBe(false);
    expect(parse('apple_itunes_search', { term: 'x', country: 'usa' })).toBe(false);
    expect(parse('apple_itunes_search', { term: 'x', media: 'movie' })).toBe(false);
    expect(parse('apple_itunes_search', { term: 'x', entity: 'tvEpisode' })).toBe(false);
    expect(parse('apple_itunes_search', { term: 'x', lang: 'fr_fr' })).toBe(false);
    expect(parse('apple_itunes_search', { term: 'x', view: 'raw' })).toBe(false);
  });

  it('apple_itunes_lookup', () => {
    expect(parse('apple_itunes_lookup', { ids: ['1', 2] })).toBe(true);
    expect(parse('apple_itunes_lookup', { ids: ['1'], entity: 'podcastEpisode', limit: 200, offset: 0, sort: 'recent', country: 'us', view: 'compact' })).toBe(true);
    expect(parse('apple_itunes_lookup', { upc: '634904078164' })).toBe(true);
    expect(parse('apple_itunes_lookup', { isbn: '978-0-316-06935-9' })).toBe(true);
    expect(parse('apple_itunes_lookup', { bundleId: 'com.apple.Pages' })).toBe(true);
    expect(parse('apple_itunes_lookup', { ids: ['1'], extra: true })).toBe(false);
    expect(parse('apple_itunes_lookup', { ids: [] })).toBe(false);
    expect(parse('apple_itunes_lookup', { ids: Array.from({ length: 201 }, (_, i) => String(i + 1)) })).toBe(false);
    expect(parse('apple_itunes_lookup', { ids: ['abc'] })).toBe(false);
    expect(parse('apple_itunes_lookup', { ids: [-1] })).toBe(false);
    expect(parse('apple_itunes_lookup', { ids: [1.5] })).toBe(false);
    expect(parse('apple_itunes_lookup', { upc: '12' })).toBe(false);
    expect(parse('apple_itunes_lookup', { bundleId: '../etc' })).toBe(false);
    expect(parse('apple_itunes_lookup', { ids: ['1'], sort: 'popular' })).toBe(false);
  });

  it('apple_charts_get', () => {
    expect(parse('apple_charts_get', { chart: 'music-songs' })).toBe(true);
    expect(parse('apple_charts_get', { chart: 'audiobooks', storefront: 'jp', limit: 100, offset: 0, view: 'full' })).toBe(true);
    expect(parse('apple_charts_get', {})).toBe(false);
    expect(parse('apple_charts_get', { chart: 'movies' })).toBe(false);
    expect(parse('apple_charts_get', { chart: 'music-songs', storefront: 'x' })).toBe(false);
    expect(parse('apple_charts_get', { chart: 'music-songs', limit: 101 })).toBe(false);
    expect(parse('apple_charts_get', { chart: 'music-songs', genre: 14 })).toBe(false);
  });
});

describe('apple_itunes_search', () => {
  it('searches with defaults and answers paging facts first, data last', async () => {
    const { call, url, result } = await (async () => {
      const s = setup(itunesResponse(envelope([SONG])));
      const r = await s.call('apple_itunes_search', { term: '  let down ' });
      return { ...s, result: r };
    })();
    void call;
    expect(url()).toBe('https://itunes.apple.com/search?term=let%20down&media=all&country=us&limit=25');
    expect(result.result.isError).toBeUndefined();
    expect(result.body).toEqual({
      returned: 1,
      total: 1,
      offset: 0,
      limit: 25,
      nextOffset: null,
      hasMore: false,
      query: { term: 'let down', media: 'all', country: 'us' },
      ...FETCHED,
      results: [compactItunesRecord(SONG, NY)],
    });
    expect(Object.keys(result.body).at(-1)).toBe('results');
    expect(Object.keys(result.body).slice(0, 6)).toEqual(['returned', 'total', 'offset', 'limit', 'nextOffset', 'hasMore']);
  });

  it('passes the filters through and echoes them', async () => {
    const { call, url } = setup(itunesResponse(envelope([episode(1)])));
    const { body } = await call('apple_itunes_search', {
      term: 'the daily',
      media: 'podcast',
      entity: 'podcastEpisode',
      attribute: 'titleTerm',
      country: 'GB',
      explicit: false,
      lang: 'ja_jp',
      limit: 5,
    });
    expect(url()).toBe(
      'https://itunes.apple.com/search?term=the%20daily&media=podcast&entity=podcastEpisode&attribute=titleTerm&country=gb&limit=5&explicit=No&lang=ja_jp',
    );
    expect(body.query).toEqual({
      term: 'the daily',
      media: 'podcast',
      entity: 'podcastEpisode',
      attribute: 'titleTerm',
      country: 'gb',
      explicit: false,
      lang: 'ja_jp',
    });
    expect(body.results[0].episodeUrl).toBe('https://dts.podtrac.com/redirect.mp3/ep1.mp3');
  });

  it('an entity without a media searches the media it belongs to', async () => {
    const { call, url } = setup(itunesResponse(envelope([SONG])));
    const { body } = await call('apple_itunes_search', { term: 'let down', entity: 'song' });
    expect(url()).toBe('https://itunes.apple.com/search?term=let%20down&media=music&entity=song&country=us&limit=25');
    expect(body.query).toEqual({ term: 'let down', media: 'music', entity: 'song', country: 'us' });
  });

  it('explicit: true asks Apple for explicit content, and the default country comes from APPLE_MUSIC_STOREFRONT', async () => {
    process.env.APPLE_MUSIC_STOREFRONT = 'CA';
    const { call, url } = setup(itunesResponse(envelope([SONG])));
    await call('apple_itunes_search', { term: 'x', explicit: true });
    expect(url()).toBe('https://itunes.apple.com/search?term=x&media=all&country=ca&limit=25&explicit=Yes');
  });

  it('a full page may have more: hasMore with a usable nextOffset, no total', async () => {
    const { call } = setup(itunesResponse(envelope(songs(2))));
    const { body } = await call('apple_itunes_search', { term: 'x', limit: 2 });
    expect(body).toMatchObject({ returned: 2, offset: 0, limit: 2, nextOffset: 2, hasMore: true });
    expect(body).not.toHaveProperty('total');
  });

  it('offset asks Apple for offset + limit and slices', async () => {
    const { call, url } = setup(itunesResponse(envelope(songs(4))));
    const { body } = await call('apple_itunes_search', { term: 'x', limit: 2, offset: 2 });
    expect(url()).toContain('limit=4');
    expect(body.results.map((r: { trackName: string }) => r.trackName)).toEqual(['Song 2', 'Song 3']);
    expect(body).toMatchObject({ returned: 2, offset: 2, nextOffset: 4, hasMore: true });
  });

  it("says so when Apple's 200-result cap is reached", async () => {
    const { call, url } = setup(itunesResponse(envelope(songs(200))));
    const { body } = await call('apple_itunes_search', { term: 'x', limit: 50, offset: 150 });
    expect(url()).toContain('limit=200');
    expect(body).toMatchObject({ returned: 50, offset: 150, nextOffset: null, hasMore: false });
    expect(body.notes).toEqual([expect.stringContaining('at most 200 results for a search and this one reached that cap')]);
  });

  it("a nextOffset handed out near the cap stays usable: the page just ends at Apple's 200th result", async () => {
    // limit 30 from 150 → nextOffset 180; 180 + 30 is past the cap, and must not be refused.
    const first = setup(itunesResponse(envelope(songs(180))));
    const a = await first.call('apple_itunes_search', { term: 'x', offset: 150, limit: 30 });
    expect(a.body).toMatchObject({ returned: 30, nextOffset: 180, hasMore: true });
    const next = setup(itunesResponse(envelope(songs(200))));
    const b = await next.call('apple_itunes_search', { term: 'x', offset: 180, limit: 30 });
    expect(next.url()).toContain('limit=200');
    expect(b.result.isError).toBeUndefined();
    expect(b.body).toMatchObject({ returned: 20, offset: 180, limit: 30, nextOffset: null, hasMore: false });
    expect(b.body.results.map((r: { trackName: string }) => r.trackName)).toEqual(Array.from({ length: 20 }, (_, i) => `Song ${180 + i}`));
    expect(b.body.notes).toEqual([expect.stringContaining('at most 200 results for a search and this one reached that cap')]);
    // Apple running out first makes the count exact.
    const short = setup(itunesResponse(envelope(songs(190))));
    const c = await short.call('apple_itunes_search', { term: 'x', offset: 180, limit: 30 });
    expect(c.body).toMatchObject({ returned: 10, total: 190, hasMore: false, nextOffset: null });
    expect(c.body).not.toHaveProperty('notes');
  });

  it('a repeated search is answered from the cache and says so', async () => {
    const { call, fetch } = setup(itunesResponse(envelope([SONG])));
    await call('apple_itunes_search', { term: 'let down' });
    const again = await call('apple_itunes_search', { term: 'let down', view: 'full' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(again.body).toMatchObject({ ...FETCHED, cached: true, results: [SONG] });
  });

  it('an empty answer says what was searched', async () => {
    const { call } = setup(itunesResponse(envelope([])));
    const { body, result } = await call('apple_itunes_search', { term: 'zzz', media: 'music', entity: 'song', attribute: 'songTerm' });
    expect(result.isError).toBeUndefined();
    expect(body).toMatchObject({ returned: 0, total: 0, hasMore: false, results: [] });
    expect(body.notes[0]).toBe(
      'No results for "zzz" in the US store (media music, entity song, attribute songTerm). Try fewer or different words, fewer filters (media, entity, attribute), or another country.',
    );
  });

  it('an offset past the end says so', async () => {
    const { call } = setup(itunesResponse(envelope(songs(3))));
    const { body } = await call('apple_itunes_search', { term: 'x', limit: 5, offset: 10 });
    expect(body).toMatchObject({ returned: 0, total: 3, hasMore: false, nextOffset: null });
    expect(body.notes).toEqual(['offset 10 is past the end: Apple returned 3 results for this search.']);
  });

  it('view full returns the records verbatim', async () => {
    const { call } = setup(itunesResponse(envelope([SONG, SOFTWARE])));
    const { body } = await call('apple_itunes_search', { term: 'x', view: 'full' });
    expect(body.results).toEqual([SONG, SOFTWARE]);
  });

  it('a projection that trips returns the whole page raw (with a stderr warning), never a hole', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { call } = setup(itunesResponse(envelope([SONG, 'garbage'])));
    const { body } = await call('apple_itunes_search', { term: 'x' });
    expect(body.results).toEqual([SONG, 'garbage']);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/could not project GET itunes\.apple\.com\/search/);
  });

  it('refuses bad arguments before any request', async () => {
    const { call, fetch } = setup(itunesResponse(envelope([])));
    const blank = await call('apple_itunes_search', { term: '   ' });
    expect(blank.result.isError).toBe(true);
    expect(blank.body.error).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'term is blank.' });
    const mismatch = await call('apple_itunes_search', { term: 'x', media: 'music', entity: 'podcast' });
    expect(mismatch.body.error.message).toBe('entity "podcast" is not valid for media "music".');
    const tooFar = await call('apple_itunes_search', { term: 'x', offset: 200, limit: 5 });
    expect(tooFar.body.error.message).toBe('offset 200 is past the end: Apple returns at most the top 200 results for a search.');
    const impossible = await call('apple_itunes_search', { term: 'x', entity: 'song', attribute: 'softwareDeveloper' });
    expect(impossible.body.error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'No media accepts entity "song" together with attribute "softwareDeveloper".',
    });
    expect(impossible.body.error.hint).toBe(
      'entity "song" belongs to media music; attribute "softwareDeveloper" to media software. Drop one, or pick values from the same media.',
    );
    process.env.APPLE_MUSIC_STOREFRONT = 'usa';
    const config = await call('apple_itunes_search', { term: 'x' });
    expect(config.body.error).toMatchObject({ code: 'NOT_CONFIGURED', service: 'itunes', missing: ['APPLE_MUSIC_STOREFRONT'] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('an upstream failure is an error result, never an empty list', async () => {
    const { call } = setup(itunesResponse({ errorMessage: 'Invalid value(s) for key(s): [country]' }, 400));
    const { result, body } = await call('apple_itunes_search', { term: 'x', country: 'zz' });
    expect(result.isError).toBe(true);
    expect(body).not.toHaveProperty('results');
    expect(body.error).toMatchObject({ code: 'INVALID_ARGUMENT', status: 400, service: 'itunes', hint: 'Check the value of: country.' });
  });
});

describe('apple_itunes_lookup — by key', () => {
  it('looks up several ids at once and lists the ones not found', async () => {
    const { call, url } = setup(itunesResponse(envelope([ARTIST, SONG])));
    const { body } = await call('apple_itunes_lookup', { ids: [1097861834, '909253', '1097861834', '1'] });
    expect(url()).toBe('https://itunes.apple.com/lookup?id=1097861834,909253,1&country=us');
    expect(body).toEqual({
      returned: 2,
      total: 2,
      offset: 0,
      limit: 3,
      nextOffset: null,
      hasMore: false,
      notes: [
        'Nothing found for id 1 in the US store: it may not exist or not be sold there (try country). Podcast episode ids cannot be looked up directly — look up the show with entity podcastEpisode.',
      ],
      query: { ids: ['1097861834', '909253', '1'], country: 'us' },
      notFound: ['1'],
      ...FETCHED,
      results: [compactItunesRecord(ARTIST, NY), compactItunesRecord(SONG, NY)],
    });
  });

  it('a UPC that matches several records lists them all, with paging facts that add up', async () => {
    const { call } = setup(itunesResponse(envelope([ALBUM, { ...ALBUM, collectionId: 1, collectionName: 'OK Computer (Deluxe)' }])));
    const { body } = await call('apple_itunes_lookup', { upc: '634904078164' });
    expect(body).toMatchObject({ returned: 2, total: 2, offset: 0, limit: 2, hasMore: false, nextOffset: null });
    expect(body.results).toHaveLength(2);
  });

  it('ids with leading zeros are the ids Apple writes back, so they match their records', async () => {
    const { call, url } = setup(itunesResponse(envelope([ARTIST])));
    const { body } = await call('apple_itunes_lookup', { ids: ['0909253', '909253'] });
    expect(url()).toBe('https://itunes.apple.com/lookup?id=909253&country=us');
    expect(body).not.toHaveProperty('notFound');
    expect(body.query.ids).toEqual(['909253']);
  });

  it('everything found: no notes, no notFound', async () => {
    const { call } = setup(itunesResponse(envelope([SONG, 'x'])));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { body } = await call('apple_itunes_lookup', { ids: ['1097861834'], view: 'full' });
    expect(body).not.toHaveProperty('notes');
    expect(body).not.toHaveProperty('notFound');
    expect(body.results).toEqual([SONG, 'x']);
  });

  it('by UPC, ISBN (ISBN-10 converted) and bundle id', async () => {
    const s = setup(itunesResponse(envelope([ALBUM])), itunesResponse(envelope([])), itunesResponse(envelope([SOFTWARE])));
    const upc = await s.call('apple_itunes_lookup', { upc: '634904078164' });
    expect(s.url(0)).toBe('https://itunes.apple.com/lookup?upc=634904078164&country=us');
    expect(upc.body).not.toHaveProperty('notFound');
    expect(upc.body.query).toEqual({ upc: '634904078164', country: 'us' });
    const isbn = await s.call('apple_itunes_lookup', { isbn: '0-316-06935-3', country: 'gb' });
    expect(s.url(1)).toBe('https://itunes.apple.com/lookup?isbn=9780316069359&country=gb');
    expect(isbn.body.notFound).toEqual(['9780316069359']);
    expect(isbn.body.notes).toEqual([
      'Nothing found for isbn 9780316069359 in the GB store: it may not exist or not be sold there (try country).',
    ]);
    const app = await s.call('apple_itunes_lookup', { bundleId: 'com.apple.Pages' });
    expect(s.url(2)).toBe('https://itunes.apple.com/lookup?bundleId=com.apple.Pages&country=us');
    expect(app.body.results[0].bundleId).toBe('com.apple.Pages');
  });

  it('needs exactly one key, and keeps limit/offset/sort for related items', async () => {
    const { call, fetch } = setup(itunesResponse(envelope([])));
    expect((await call('apple_itunes_lookup', {})).body.error).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'Nothing to look up.' });
    expect((await call('apple_itunes_lookup', { ids: ['1'], upc: '634904078164' })).body.error.message).toBe('Pass only one of ids, upc.');
    expect((await call('apple_itunes_lookup', { ids: ['1'], limit: 5 })).body.error.message).toBe(
      'limit applies only to related items, which need entity.',
    );
    expect((await call('apple_itunes_lookup', { ids: ['1'], offset: 5, sort: 'recent' })).body.error.message).toBe(
      'offset, sort apply only to related items, which need entity.',
    );
    expect((await call('apple_itunes_lookup', { ids: ['1', '2'], entity: 'song' })).body.error.message).toBe(
      'entity lists the related items of ONE item, but several ids were given.',
    );
    expect((await call('apple_itunes_lookup', { ids: ['1'], entity: 'song', offset: 200, limit: 50 })).body.error.message).toBe(
      "offset 200 is past the end: Apple's lookup serves at most the first 200 related items.",
    );
    expect((await call('apple_itunes_lookup', { isbn: '123' })).body.error.code).toBe('INVALID_ARGUMENT');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('apple_itunes_lookup — related items', () => {
  const eps = (n: number, from = 0) => Array.from({ length: n }, (_, i) => episode(from + i));

  it("lists a podcast's episodes: the show as item, episodes as related, paging facts first", async () => {
    const { call, url } = setup(itunesResponse(envelope([PODCAST, ...eps(50)])));
    const { body } = await call('apple_itunes_lookup', { ids: ['1200361736'], entity: 'podcastEpisode' });
    expect(url()).toBe('https://itunes.apple.com/lookup?id=1200361736&entity=podcastEpisode&limit=50&country=us');
    expect(Object.keys(body)).toEqual([
      'returned',
      'offset',
      'limit',
      'nextOffset',
      'hasMore',
      'query',
      'cached',
      'fetchedAt',
      'fetchedAtDisplay',
      'item',
      'related',
    ]);
    expect(body).toMatchObject({ returned: 50, offset: 0, limit: 50, nextOffset: 50, hasMore: true });
    expect(body.query).toEqual({ ids: ['1200361736'], entity: 'podcastEpisode', country: 'us' });
    expect(body.item).toEqual(compactItunesRecord(PODCAST, NY));
    expect(body.related[0]).toEqual(compactItunesRecord(episode(0), NY));
  });

  it('a show that returns fewer episodes than it lists gets an explicit note', async () => {
    const { call } = setup(itunesResponse(envelope([PODCAST, ...eps(16)])));
    const { body } = await call('apple_itunes_lookup', { ids: ['1200361736'], entity: 'podcastEpisode', sort: 'recent' });
    expect(body).toMatchObject({ returned: 16, hasMore: false, nextOffset: null });
    expect(body.query.sort).toBe('recent');
    expect(body.notes).toEqual([
      "This podcast lists 2731 episodes, but Apple's lookup returned 16: it serves at most 200 and fewer for some shows. The full list is in the show's RSS feed (feedUrl), which this server does not fetch.",
    ]);
  });

  it("paging to Apple's 200-episode cap ends the pages and says why", async () => {
    const { call, url } = setup(itunesResponse(envelope([PODCAST, ...eps(200)])));
    const { body } = await call('apple_itunes_lookup', { ids: ['1200361736'], entity: 'podcastEpisode', offset: 150, limit: 50 });
    expect(url()).toContain('limit=200');
    expect(body).toMatchObject({ returned: 50, offset: 150, hasMore: false, nextOffset: null });
    expect(body.related[0].trackName).toBe('Episode 150');
    expect(body.notes[0]).toMatch(/^This podcast lists 2731 episodes, but Apple's lookup returned 200/);
  });

  it('a page that runs into the 200 cap ends there instead of being refused', async () => {
    const { call, url } = setup(itunesResponse(envelope([ARTIST, ...songs(200)])));
    const { body, result } = await call('apple_itunes_lookup', { ids: ['909253'], entity: 'song', offset: 180, limit: 50 });
    expect(result.isError).toBeUndefined();
    expect(url()).toBe('https://itunes.apple.com/lookup?id=909253&entity=song&limit=200&country=us');
    expect(body).toMatchObject({ returned: 20, offset: 180, limit: 50, hasMore: false, nextOffset: null });
    expect(body.notes).toEqual(["Apple's lookup serves at most 200 related items and this list reached that cap; more may exist."]);
  });

  it('no episode note when the show really has no more', async () => {
    const { call } = setup(itunesResponse(envelope([{ ...PODCAST, trackCount: 5 }, ...eps(5)])));
    const { body } = await call('apple_itunes_lookup', { ids: ['1200361736'], entity: 'podcastEpisode' });
    expect(body).not.toHaveProperty('notes');
    expect(body.returned).toBe(5);
  });

  it('other related lists note the 200 cap when reached', async () => {
    const { call } = setup(itunesResponse(envelope([ARTIST, ...songs(200)])));
    const { body } = await call('apple_itunes_lookup', { ids: ['909253'], entity: 'song', offset: 190, limit: 10 });
    expect(body).toMatchObject({ returned: 10, hasMore: false });
    expect(body.notes).toEqual(["Apple's lookup serves at most 200 related items and this list reached that cap; more may exist."]);
  });

  it('an id Apple does not know', async () => {
    const { call } = setup(itunesResponse(envelope([])));
    const { body, result } = await call('apple_itunes_lookup', { ids: ['42'], entity: 'song' });
    expect(result.isError).toBeUndefined();
    expect(body).toMatchObject({ returned: 0, hasMore: false, notFound: ['42'], related: [] });
    expect(body).not.toHaveProperty('item');
    expect(body.notes).toEqual(['Nothing found for id 42 in the US store: it may not exist or not be sold there (try country).']);
  });

  it('when Apple does not return the item itself, everything is listed as related', async () => {
    const { call } = setup(itunesResponse(envelope(songs(2))));
    const { body } = await call('apple_itunes_lookup', { ids: ['5'], entity: 'song' });
    expect(body).not.toHaveProperty('item');
    expect(body.related).toHaveLength(2);
    expect(body.notes).toEqual(['Apple did not return the looked-up item itself; everything it returned is listed under related.']);
  });

  it('an item with no related items of that type', async () => {
    const { call } = setup(itunesResponse(envelope([ARTIST])));
    const { body } = await call('apple_itunes_lookup', { ids: ['909253'], entity: 'podcastEpisode' });
    expect(body.item).toEqual(compactItunesRecord(ARTIST, NY));
    expect(body.notes).toEqual(['Apple returned no podcastEpisode items related to id 909253.']);
  });

  it('an offset past the end of the related items', async () => {
    const { call } = setup(itunesResponse(envelope([ARTIST, ALBUM])));
    const { body } = await call('apple_itunes_lookup', { ids: ['909253'], entity: 'album', offset: 5, limit: 5 });
    expect(body).toMatchObject({ returned: 0, hasMore: false });
    expect(body.notes).toEqual(['offset 5 is past the end: Apple returned 1 related items.']);
  });

  it("a UPC's first result is the album; view full keeps both verbatim", async () => {
    const { call, url } = setup(itunesResponse(envelope([ALBUM, SONG])));
    const { body } = await call('apple_itunes_lookup', { upc: '634904078164', entity: 'song', view: 'full' });
    expect(url()).toBe('https://itunes.apple.com/lookup?upc=634904078164&entity=song&limit=50&country=us');
    expect(body.item).toEqual(ALBUM);
    expect(body.related).toEqual([SONG]);
  });
});

describe('apple_charts_get', () => {
  const top = (n: number) => Array.from({ length: n }, (_, i) => chartSong(i));

  it('fetches the whole top 100 once and ranks the compact entries of the page', async () => {
    const { call, url } = setup(jsonResponse(chartFeed(top(100))));
    const { body } = await call('apple_charts_get', { chart: 'music-songs' });
    expect(url()).toBe('https://rss.marketingtools.apple.com/api/v2/us/music/most-played/100/songs.json');
    expect(Object.keys(body)).toEqual([
      'returned',
      'total',
      'offset',
      'limit',
      'nextOffset',
      'hasMore',
      'chart',
      'storefront',
      'title',
      'cached',
      'fetchedAt',
      'fetchedAtDisplay',
      'results',
    ]);
    expect(body).toMatchObject({
      returned: 25,
      total: 100,
      nextOffset: 25,
      hasMore: true,
      chart: 'music-songs',
      storefront: 'us',
      title: 'Top Songs',
      ...FETCHED,
    });
    expect(body.results).toHaveLength(25);
    expect(body.results[0]).toEqual(compactChartEntry(chartSong(0), 1, NY));
    expect(body.results[24].rank).toBe(25);
  });

  it('later pages come from the same cached edition of the chart, with absolute ranks', async () => {
    const { call, url, fetch } = setup(jsonResponse(chartFeed(top(100))));
    await call('apple_charts_get', { chart: 'podcasts', storefront: 'GB' });
    const { body } = await call('apple_charts_get', { chart: 'podcasts', storefront: 'GB', offset: 20, limit: 5 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(url()).toBe('https://rss.marketingtools.apple.com/api/v2/gb/podcasts/top/100/podcasts.json');
    expect(body.results.map((r: { rank: number }) => r.rank)).toEqual([21, 22, 23, 24, 25]);
    expect(body).toMatchObject({ storefront: 'gb', cached: true, nextOffset: 25, hasMore: true });
  });

  it('a chart shorter than 100 is whole; the last page of the top 100 says the feed stops there', async () => {
    const short = setup(jsonResponse(chartFeed(top(10))));
    const a = await short.call('apple_charts_get', { chart: 'apps-free' });
    expect(a.body).toMatchObject({ returned: 10, total: 10, hasMore: false, nextOffset: null });
    expect(a.body).not.toHaveProperty('notes');
    const full = setup(jsonResponse(chartFeed(top(100))));
    const b = await full.call('apple_charts_get', { chart: 'books-paid', offset: 50, limit: 50 });
    expect(full.url()).toContain('/books/top-paid/100/books.json');
    expect(b.body).toMatchObject({ returned: 50, total: 100, hasMore: false, nextOffset: null });
    expect(b.body.notes).toEqual(["Apple's chart feeds list only the top 100; positions further down are not available."]);
  });

  it('a nextOffset near the end stays usable: the page just ends at position 100', async () => {
    const { call } = setup(jsonResponse(chartFeed(top(100))));
    const a = await call('apple_charts_get', { chart: 'music-albums', offset: 60, limit: 30 });
    expect(a.body).toMatchObject({ returned: 30, nextOffset: 90, hasMore: true });
    const b = await call('apple_charts_get', { chart: 'music-albums', offset: 90, limit: 30 });
    expect(b.result.isError).toBeUndefined();
    expect(b.body).toMatchObject({ returned: 10, total: 100, hasMore: false, nextOffset: null });
    expect(b.body.results.map((r: { rank: number }) => r.rank)).toEqual([91, 92, 93, 94, 95, 96, 97, 98, 99, 100]);
  });

  it('empty charts and offsets past the end say so', async () => {
    const empty = setup(jsonResponse(chartFeed([])));
    const a = await empty.call('apple_charts_get', { chart: 'podcast-channels' });
    expect(a.body.notes).toEqual(["Apple's podcast-channels chart for storefront us has no entries."]);
    expect(a.body).toMatchObject({ returned: 0, total: 0, hasMore: false, results: [] });
    const past = setup(jsonResponse(chartFeed([chartSong(0)])));
    const b = await past.call('apple_charts_get', { chart: 'music-songs', offset: 10, limit: 5 });
    expect(b.body.notes).toEqual(['offset 10 is past the end of this chart (1 entries).']);
  });

  it('full view, and a feed without a usable title', async () => {
    process.env.APPLE_MUSIC_STOREFRONT = 'jp';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { call, url } = setup(jsonResponse(chartFeed([chartSong(0)], { title: 42 })));
    const { body } = await call('apple_charts_get', { chart: 'audiobooks', view: 'full' });
    expect(url()).toBe('https://rss.marketingtools.apple.com/api/v2/jp/audio-books/top/100/audio-books.json');
    expect(body).not.toHaveProperty('title');
    expect(body).not.toHaveProperty('updated');
    expect(body.results).toEqual([chartSong(0)]);
  });

  it('refuses an offset past the top 100 and surfaces upstream failures as errors', async () => {
    const { call, fetch } = setup(new Response('<html>500</html>', { status: 500, headers: { 'content-type': 'text/html' } }));
    const tooFar = await call('apple_charts_get', { chart: 'music-songs', offset: 100, limit: 20 });
    expect(tooFar.body.error.message).toBe("offset 100 is past the end: Apple's charts list at most the top 100.");
    expect(fetch).not.toHaveBeenCalled();
    const failed = await call('apple_charts_get', { chart: 'books-free', storefront: 'cn' });
    expect(failed.result.isError).toBe(true);
    expect(failed.body).not.toHaveProperty('results');
    expect(failed.body.error).toMatchObject({ code: 'UPSTREAM_ERROR', status: 500, service: 'itunes' });
    expect(failed.body.error.message).toBe('itunes: Apple\'s books/top-free/books chart feed failed with HTTP 500 for storefront "cn".');
    expect(failed.body.error.hint).toContain('a store that does not sell this kind of content');
  });
});
