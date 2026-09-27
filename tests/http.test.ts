import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withCallSignal } from '@chrischall/mcp-utils';
import {
  ALLOWED_HOSTS,
  ALLOWED_HOST_SUFFIXES,
  MAX_RESPONSE_BYTES,
  assertAllowedUrl,
  credentialFamily,
  describeErrorBody,
  httpRequest,
  isAllowedHost,
  setSleepForTests,
  withQuery,
} from '../src/http.js';
import {
  AppleToolError,
  CredentialsRejectedError,
  TransportError,
  UnconfirmedWriteError,
  UpstreamError,
  rememberSecret,
} from '../src/errors.js';

type FetchImpl = (url: URL, init: RequestInit) => Promise<Response>;

let fetchMock: ReturnType<typeof vi.fn<FetchImpl>>;
let sleeps: number[];

beforeEach(() => {
  fetchMock = vi.fn<FetchImpl>();
  vi.stubGlobal('fetch', fetchMock);
  sleeps = [];
  setSleepForTests(async (ms) => {
    sleeps.push(ms);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function res(status: number, body = '', headers: Record<string, string> = {}, url?: string): Response {
  const r = new Response(status === 204 || status === 304 ? null : body, { status, headers });
  if (url !== undefined) Object.defineProperty(r, 'url', { value: url });
  return r;
}

function json(status: number, data: unknown, headers: Record<string, string> = {}): Response {
  return res(status, JSON.stringify(data), { 'content-type': 'application/json; charset=utf-8', ...headers });
}

/** A response whose body read fails (connection lost, or the abort signal fires while reading). */
function brokenBody(status: number, init: RequestInit, waitForAbort = false): Response {
  return {
    status,
    url: '',
    headers: new Headers(),
    arrayBuffer: () =>
      waitForAbort
        ? new Promise<ArrayBuffer>((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(new Error('aborted while reading')));
          })
        : Promise.reject(new Error('socket hang up')),
  } as unknown as Response;
}

/** A fetch that never answers until its signal aborts. */
function hangUntilAborted(): FetchImpl {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

const URL_MUSIC = 'https://api.music.apple.com/v1/catalog/us/songs';

describe('sleep', () => {
  it('the default sleep waits on a real timer (the setup file swaps it for an instant one)', async () => {
    vi.resetModules();
    const fresh = await import('../src/http.js');
    vi.useFakeTimers();
    let done = false;
    const p = fresh.sleep(1500).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });
});

describe('host allowlist', () => {
  it('allows the listed hosts case-insensitively and any subdomain of an allowed suffix', () => {
    expect(ALLOWED_HOSTS.has('api.music.apple.com')).toBe(true);
    expect(ALLOWED_HOST_SUFFIXES).toEqual(['.icloud.com']);
    expect(isAllowedHost('API.MUSIC.APPLE.COM')).toBe(true);
    expect(isAllowedHost('p42-caldav.icloud.com')).toBe(true);
    expect(isAllowedHost('caldav.icloud.com')).toBe(true);
  });

  it('refuses the bare suffix, look-alikes and everything else', () => {
    expect(isAllowedHost('icloud.com')).toBe(false);
    expect(isAllowedHost('.icloud.com')).toBe(false);
    expect(isAllowedHost('evilicloud.com')).toBe(false);
    expect(isAllowedHost('icloud.com.evil.net')).toBe(false);
    expect(isAllowedHost('example.com')).toBe(false);
    expect(isAllowedHost('apple.com')).toBe(false);
  });

  it('assertAllowedUrl requires https on an allowed host', () => {
    expect(() => assertAllowedUrl(new URL('https://maps-api.apple.com/v1/token'), 'maps')).not.toThrow();
    const insecure = (() => {
      try {
        assertAllowedUrl(new URL('http://maps-api.apple.com/v1/token'), 'maps');
      } catch (e) {
        return e as AppleToolError;
      }
    })()!;
    expect(insecure).toBeInstanceOf(AppleToolError);
    expect(insecure.code).toBe('UPSTREAM_ERROR');
    expect(insecure.message).toContain('refusing to contact http://maps-api.apple.com');
    expect(insecure.hint).toContain('safety check');
    expect(() => assertAllowedUrl(new URL('https://example.com/'), 'calendar')).toThrow(/not an allowed Apple host/);
  });
});

describe('withQuery', () => {
  it('returns the URL unchanged without a query or when every value is skipped', () => {
    expect(withQuery(URL_MUSIC, undefined).toString()).toBe(URL_MUSIC);
    expect(withQuery(URL_MUSIC, { a: undefined, b: null, c: '', d: [] }).toString()).toBe(URL_MUSIC);
  });

  it('comma-joins arrays, keeps brackets and commas literal, encodes everything else', () => {
    const u = withQuery(URL_MUSIC, {
      'ids[songs]': ['1', 2],
      types: ['songs', 'albums'],
      term: 'hello world & more',
      limit: 5,
      explicit: false,
      filter: 'a,b',
    });
    expect(u.search).toBe('?ids[songs]=1,2&types=songs,albums&term=hello%20world%20%26%20more&limit=5&explicit=false&filter=a,b');
  });

  it('appends to an existing query string', () => {
    expect(withQuery(`${URL_MUSIC}?l=en-US`, { limit: 2 }).search).toBe('?l=en-US&limit=2');
    expect(withQuery(new URL(`${URL_MUSIC}?`), { limit: 2 }).search).toBe('?limit=2');
  });
});

describe('describeErrorBody', () => {
  it('handles an empty body', () => {
    expect(describeErrorBody('  ')).toEqual({ message: '' });
  });

  it("reads Apple's JSON:API errors[] (title, detail, code)", () => {
    expect(
      describeErrorBody(JSON.stringify({ errors: [{ status: '400', code: '40005', title: 'Invalid Parameter', detail: 'bad limit' }] })),
    ).toEqual({ message: 'Invalid Parameter: bad limit', code: '40005' });
    expect(describeErrorBody(JSON.stringify({ errors: [{ detail: 'only detail', code: 7 }] }))).toEqual({ message: 'only detail' });
    expect(describeErrorBody(JSON.stringify({ errors: [{ title: '' }] }))).toEqual({ message: '' });
  });

  it('reads {error:{message}}, {reason} and {message}', () => {
    expect(describeErrorBody('{"error":{"message":"quota"}}')).toEqual({ message: 'quota' });
    expect(describeErrorBody('{"reason":"NOT_ENABLED"}')).toEqual({ message: 'NOT_ENABLED' });
    expect(describeErrorBody('{"message":"nope"}')).toEqual({ message: 'nope' });
  });

  it('falls back to flattened text for other JSON, malformed error arrays, HTML and plain text', () => {
    expect(describeErrorBody('{"error":"flat"}')).toEqual({ message: '{"error":"flat"}' });
    expect(describeErrorBody('{"error":{"code":1}}')).toEqual({ message: '{"error":{"code":1}}' });
    expect(describeErrorBody('{"errors":[]}')).toEqual({ message: '{"errors":[]}' });
    expect(describeErrorBody('{"errors":[null]}')).toEqual({ message: '{"errors":[null]}' });
    expect(describeErrorBody('<html><body><h1>Forbidden</h1>\n<p>no</p></body></html>')).toEqual({ message: 'Forbidden no' });
    expect(describeErrorBody('x'.repeat(400)).message).toBe(`${'x'.repeat(300)}… [truncated]`);
    expect(describeErrorBody('x'.repeat(300)).message).toBe('x'.repeat(300));
  });
});

describe('httpRequest — success paths', () => {
  it('sends a GET with the query and headers, manual redirects and a signal, and parses JSON', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { data: [1] }));
    const out = await httpRequest<{ data: number[] }>({
      service: 'music',
      method: 'get',
      url: URL_MUSIC,
      query: { ids: ['1', '2'] },
      headers: { Authorization: 'Bearer t' },
    });
    expect(out.status).toBe(200);
    expect(out.data).toEqual({ data: [1] });
    expect(out.text).toBe('{"data":[1]}');
    expect(out.bytes).toBeInstanceOf(Uint8Array);
    expect(out.url).toBe(`${URL_MUSIC}?ids=1,2`);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url.toString()).toBe(`${URL_MUSIC}?ids=1,2`);
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({ Authorization: 'Bearer t' });
    expect('body' in init).toBe(false);
  });

  it('reports the final URL the response carries when there is one', async () => {
    fetchMock.mockResolvedValueOnce(res(200, 'ok', {}, 'https://api.music.apple.com/final'));
    const out = await httpRequest({ service: 'music', method: 'GET', url: URL_MUSIC });
    expect(out.url).toBe('https://api.music.apple.com/final');
    expect(out.data).toBe('ok');
  });

  it('parses +json content types, returns null for an empty JSON body, and text when untyped', async () => {
    fetchMock.mockResolvedValueOnce(res(200, '{"a":1}', { 'content-type': 'application/vnd.api+json' }));
    expect((await httpRequest({ service: 'music', method: 'GET', url: URL_MUSIC })).data).toEqual({ a: 1 });
    fetchMock.mockResolvedValueOnce(res(200, '  ', { 'content-type': 'application/json' }));
    expect((await httpRequest({ service: 'music', method: 'GET', url: URL_MUSIC })).data).toBeNull();
    fetchMock.mockResolvedValueOnce(res(200, 'plain'));
    expect((await httpRequest({ service: 'music', method: 'GET', url: URL_MUSIC })).data).toBe('plain');
  });

  it('honours an explicit responseType', async () => {
    fetchMock.mockResolvedValueOnce(res(200, '{"a":1}'));
    expect((await httpRequest({ service: 'itunes', method: 'GET', url: 'https://itunes.apple.com/search', responseType: 'json' })).data).toEqual({ a: 1 });
    fetchMock.mockResolvedValueOnce(res(200, '{"a":1}', { 'content-type': 'application/json' }));
    expect((await httpRequest({ service: 'itunes', method: 'GET', url: 'https://itunes.apple.com/search', responseType: 'text' })).data).toBe('{"a":1}');
    fetchMock.mockResolvedValueOnce(res(200, 'abc'));
    const bytes = await httpRequest({ service: 'itunes', method: 'GET', url: 'https://itunes.apple.com/search', responseType: 'bytes' });
    expect(bytes.data).toBeUndefined();
    expect([...bytes.bytes]).toEqual([97, 98, 99]);
  });

  it('refuses a 2xx body that is not valid JSON', async () => {
    fetchMock.mockResolvedValueOnce(res(200, '<html>', { 'content-type': 'application/json' }));
    const err = (await rejection(httpRequest({ service: 'weather', method: 'GET', url: 'https://weatherkit.apple.com/api/v1/x' }))) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.message).toContain('/api/v1/x returned a body that is not valid JSON');
    expect(err.hint).toContain('Retry later');
  });

  it('serializes a json body with a Content-Type unless the caller set one', async () => {
    fetchMock.mockImplementation(async () => res(201, ''));
    await httpRequest({ service: 'music', method: 'POST', url: URL_MUSIC, json: { a: 1 } });
    let init = fetchMock.mock.calls[0]![1];
    expect(init.body).toBe('{"a":1}');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    await httpRequest({ service: 'music', method: 'POST', url: URL_MUSIC, json: [1], headers: { 'content-type': 'application/vnd.api+json' } });
    init = fetchMock.mock.calls[1]![1];
    expect(init.headers).toEqual({ 'content-type': 'application/vnd.api+json' });
    await httpRequest({ service: 'calendar', method: 'PUT', url: 'https://p1-caldav.icloud.com/x.ics', body: 'BEGIN:VCALENDAR' });
    init = fetchMock.mock.calls[2]![1];
    expect(init.body).toBe('BEGIN:VCALENDAR');
    expect(init.headers).toEqual({});
  });

  it('returns a listed okStatus instead of throwing', async () => {
    fetchMock.mockResolvedValueOnce(res(404, 'gone'));
    const out = await httpRequest({ service: 'calendar', method: 'GET', url: 'https://p1-caldav.icloud.com/a', okStatuses: [404, 412] });
    expect(out.status).toBe(404);
    expect(out.data).toBe('gone');
  });

  it('refuses a header fetch cannot carry BEFORE sending — definitive even for a write, and never quoting the value', async () => {
    for (const [headers, shown] of [
      [{ Authorization: 'Basic c2VjcmV0\nX-Injected: 1' }, 'Authorization'],
      [{ 'Music-User-Token': 'tok\u2713en-value' }, 'Music-User-Token'],
      [{ 'Bad\u00e9 Name': 'v' }, 'Bad??Name'],
    ] as const) {
      const err = (await rejection(httpRequest({ service: 'music', method: 'POST', url: URL_MUSIC, headers }))) as AppleToolError;
      expect(err).not.toBeInstanceOf(UnconfirmedWriteError);
      expect(err.code).toBe('INVALID_ARGUMENT');
      expect(err.message).toBe(`music: the ${shown} request header has a value (or name) HTTP cannot carry; nothing was sent.`);
      expect(err.message).not.toContain('c2VjcmV0');
      expect(err.hint).toContain('line break');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a disallowed URL before any network call', async () => {
    const err = await rejection(httpRequest({ service: 'music', method: 'GET', url: 'https://evil.example/' }));
    expect(err).toBeInstanceOf(AppleToolError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('httpRequest — debug logging', () => {
  it('logs request/response/failure lines to stderr, scrubbed, only when APPLE_DEBUG_LOG is on', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(res(200, 'ok'));
    await httpRequest({ service: 'music', method: 'GET', url: URL_MUSIC });
    expect(err).not.toHaveBeenCalled();

    process.env.APPLE_DEBUG_LOG = 'true';
    rememberSecret('super-secret-password');
    fetchMock.mockResolvedValueOnce(res(200, 'ok'));
    await httpRequest({ service: 'music', method: 'GET', url: URL_MUSIC, query: { token: 'q' } });
    const lines = err.mock.calls.map((c) => String(c[0]));
    expect(lines[0]).toBe('[aws-mcp] → GET https://api.music.apple.com/v1/catalog/us/songs');
    expect(lines[1]).toMatch(/^\[aws-mcp\] ← 200 GET \/v1\/catalog\/us\/songs \(\d+ ms, 2 B\)$/);
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED super-secret-password'));
    await rejection(httpRequest({ service: 'music', method: 'POST', url: URL_MUSIC }));
    const fail = err.mock.calls.map((c) => String(c[0])).find((l) => l.includes('✗'))!;
    expect(fail).toContain('could not connect');
    expect(fail).not.toContain('super-secret-password');
  });
});

describe('httpRequest — transport failures', () => {
  it('retries an idempotent request once after a connection failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(res(200, 'ok'));
    const out = await httpRequest({ service: 'contacts', method: 'PROPFIND', url: 'https://contacts.icloud.com/' });
    expect(out.data).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the one retry with a NETWORK_ERROR that names the cause', async () => {
    const cause = new Error('getaddrinfo ENOTFOUND');
    fetchMock.mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause }));
    const err = (await rejection(httpRequest({ service: 'contacts', method: 'REPORT', url: 'https://contacts.icloud.com/' }))) as TransportError;
    expect(err).toBeInstanceOf(TransportError);
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.message).toBe('contacts: REPORT / could not connect (fetch failed: getaddrinfo ENOTFOUND).');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('describes non-Error rejections and Errors with a non-Error cause', async () => {
    fetchMock.mockRejectedValueOnce('boom').mockRejectedValueOnce(Object.assign(new Error('x'), { cause: 'str' }));
    const err = (await rejection(httpRequest({ service: 'maps', method: 'GET', url: 'https://maps-api.apple.com/v1/token' }))) as TransportError;
    expect(err.message).toBe('maps: GET /v1/token could not connect (x).');
    fetchMock.mockRejectedValueOnce('boom');
    const write = (await rejection(httpRequest({ service: 'maps', method: 'POST', url: 'https://maps-api.apple.com/v1/token' }))) as UnconfirmedWriteError;
    expect(write.message).toContain('could not connect (boom)');
  });

  it('never retries a write whose outcome is unknown: UNCONFIRMED_WRITE', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const err = (await rejection(httpRequest({ service: 'music', method: 'POST', url: URL_MUSIC, json: {} }))) as UnconfirmedWriteError;
    expect(err).toBeInstanceOf(UnconfirmedWriteError);
    expect(err.code).toBe('UNCONFIRMED_WRITE');
    expect(err.message).toContain('may have been applied');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats an explicitly idempotent write as retryable, and an explicitly non-idempotent GET as a write', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(res(204));
    await httpRequest({ service: 'music', method: 'DELETE', url: URL_MUSIC, idempotent: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await rejection(httpRequest({ service: 'music', method: 'GET', url: URL_MUSIC, idempotent: false }))).toBeInstanceOf(UnconfirmedWriteError);
  });

  it('times out a hung read with TIMEOUT (no retry) and a hung write with UNCONFIRMED_WRITE', async () => {
    fetchMock.mockImplementation(hangUntilAborted());
    const read = (await rejection(httpRequest({ service: 'weather', method: 'GET', url: 'https://weatherkit.apple.com/a', timeoutMs: 5 }))) as TransportError;
    expect(read).toBeInstanceOf(TransportError);
    expect(read.code).toBe('TIMEOUT');
    expect(read.message).toContain('timed out after 5 ms');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const write = (await rejection(httpRequest({ service: 'weather', method: 'PATCH', url: 'https://weatherkit.apple.com/a', timeoutMs: 5 }))) as UnconfirmedWriteError;
    expect(write).toBeInstanceOf(UnconfirmedWriteError);
    expect(write.message).toContain('timed out after 5 ms; the change may have been applied');
  });

  it('uses APPLE_REQUEST_TIMEOUT_MS when no per-call timeout is given', async () => {
    process.env.APPLE_REQUEST_TIMEOUT_MS = '1000';
    vi.useFakeTimers();
    fetchMock.mockImplementation(hangUntilAborted());
    const p = rejection(httpRequest({ service: 'weather', method: 'GET', url: 'https://weatherkit.apple.com/a' }));
    await vi.advanceTimersByTimeAsync(1000);
    const err = (await p) as TransportError;
    expect(err.message).toContain('timed out after 1000 ms');
  });
});

describe('httpRequest — caller cancellation', () => {
  it('refuses to start when the caller already cancelled (nothing sent, so definitive even for a write)', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = (await rejection(withCallSignal(ac.signal, () => httpRequest({ service: 'music', method: 'POST', url: URL_MUSIC })))) as AppleToolError;
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.message).toBe('music: request cancelled by the caller.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a read cancelled mid-flight is NETWORK_ERROR (not retried); a write is UNCONFIRMED_WRITE', async () => {
    fetchMock.mockImplementation(hangUntilAborted());
    const ac = new AbortController();
    const read = withCallSignal(ac.signal, () => rejection(httpRequest({ service: 'music', method: 'GET', url: URL_MUSIC })));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    ac.abort();
    const r = (await read) as AppleToolError;
    expect(r).toBeInstanceOf(AppleToolError);
    expect(r).not.toBeInstanceOf(TransportError);
    expect(r.code).toBe('NETWORK_ERROR');
    expect(r.message).toBe('music: request cancelled by the caller.');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const ac2 = new AbortController();
    const write = withCallSignal(ac2.signal, () => rejection(httpRequest({ service: 'music', method: 'DELETE', url: URL_MUSIC })));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    ac2.abort();
    const w = (await write) as UnconfirmedWriteError;
    expect(w).toBeInstanceOf(UnconfirmedWriteError);
    expect(w.message).toContain('cancelled by the caller while in flight; the change may have been applied');
  });
});

describe('httpRequest — body read failures', () => {
  it('a read that loses the connection mid-body is NETWORK_ERROR; one that times out is TIMEOUT', async () => {
    fetchMock.mockImplementationOnce(async (_u, init) => brokenBody(200, init));
    const lost = (await rejection(httpRequest({ service: 'mail', method: 'GET', url: 'https://p1-caldav.icloud.com/a' }))) as TransportError;
    expect(lost).toBeInstanceOf(TransportError);
    expect(lost.code).toBe('NETWORK_ERROR');
    expect(lost.message).toContain('lost the connection reading the response');

    fetchMock.mockImplementationOnce(async (_u, init) => brokenBody(200, init, true));
    const slow = (await rejection(httpRequest({ service: 'mail', method: 'GET', url: 'https://p1-caldav.icloud.com/a', timeoutMs: 5 }))) as TransportError;
    expect(slow.code).toBe('TIMEOUT');
    expect(slow.message).toContain('timed out reading the response after 5 ms');
  });

  it('a write whose response body is lost is unconfirmed unless the status was a definitive 4xx', async () => {
    for (const status of [200, 302, 408, 500]) {
      fetchMock.mockImplementationOnce(async (_u, init) => brokenBody(status, init));
      const err = await rejection(httpRequest({ service: 'calendar', method: 'PUT', url: 'https://p1-caldav.icloud.com/a' }));
      expect(err, `status ${status}`).toBeInstanceOf(UnconfirmedWriteError);
    }
    fetchMock.mockImplementationOnce(async (_u, init) => brokenBody(412, init));
    const definitive = await rejection(httpRequest({ service: 'calendar', method: 'PUT', url: 'https://p1-caldav.icloud.com/a' }));
    expect(definitive).toBeInstanceOf(TransportError);
  });

  it('refuses a body over MAX_RESPONSE_BYTES', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      url: '',
      headers: new Headers(),
      arrayBuffer: async () => new ArrayBuffer(MAX_RESPONSE_BYTES + 1),
    } as unknown as Response);
    const err = (await rejection(httpRequest({ service: 'contacts', method: 'REPORT', url: 'https://p1-contacts.icloud.com/card/' }))) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.message).toContain(`larger than ${MAX_RESPONSE_BYTES} bytes`);
  });
});

describe('httpRequest — redirects', () => {
  it('follows a same-origin relative redirect for a GET', async () => {
    fetchMock.mockResolvedValueOnce(res(302, '', { location: '/us/browse' })).mockResolvedValueOnce(res(200, 'page'));
    const out = await httpRequest({ service: 'music', method: 'GET', url: 'https://music.apple.com/browse' });
    expect(out.data).toBe('page');
    expect(fetchMock.mock.calls[1]![0].toString()).toBe('https://music.apple.com/us/browse');
    expect(out.url).toBe('https://music.apple.com/us/browse');
  });

  it('turns a POST into a GET (dropping the body) on 303, and on 301/302 for POST', async () => {
    for (const status of [303, 301, 302]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(res(status, '', { location: 'https://p9-caldav.icloud.com/x' })).mockResolvedValueOnce(res(200, 'ok'));
      await httpRequest({ service: 'calendar', method: 'POST', url: 'https://caldav.icloud.com/', body: 'b' });
      const init = fetchMock.mock.calls[1]![1];
      expect(init.method, `status ${status}`).toBe('GET');
      expect('body' in init).toBe(false);
    }
  });

  it('keeps the method and body on 307/308, and on 303 for a GET, and on 302 for a PUT', async () => {
    for (const [status, method] of [
      [307, 'POST'],
      [308, 'PUT'],
      [302, 'PUT'],
    ] as const) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(res(status, '', { location: 'https://p9-caldav.icloud.com/x' })).mockResolvedValueOnce(res(201, ''));
      await httpRequest({ service: 'calendar', method, url: 'https://caldav.icloud.com/', body: 'b' });
      const init = fetchMock.mock.calls[1]![1];
      expect(init.method).toBe(method);
      expect(init.body).toBe('b');
    }
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(res(303, '', { location: '/y' })).mockResolvedValueOnce(res(200, ''));
    await httpRequest({ service: 'calendar', method: 'GET', url: 'https://caldav.icloud.com/' });
    expect(fetchMock.mock.calls[1]![1].method).toBe('GET');
  });

  it('keeps credentials on a hop within one family (iCloud partition host) and drops them when the family changes', async () => {
    fetchMock.mockResolvedValueOnce(res(302, '', { location: 'https://p42-caldav.icloud.com/123/' })).mockResolvedValueOnce(res(200, 'ok'));
    await httpRequest({ service: 'calendar', method: 'GET', url: 'https://caldav.icloud.com/', headers: { Authorization: 'Basic x' } });
    expect(fetchMock.mock.calls[1]![1].headers).toEqual({ Authorization: 'Basic x' });

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(res(302, '', { location: 'https://maps-api.apple.com/v1/x' })).mockResolvedValueOnce(res(200, 'ok'));
    await httpRequest({
      service: 'music',
      method: 'GET',
      url: 'https://api.music.apple.com/v1/a',
      headers: { Authorization: 'Bearer t', 'Music-User-Token': 'u', 'media-user-token': 'w', Cookie: 'c=1', Accept: 'application/json' },
    });
    expect(fetchMock.mock.calls[1]![1].headers).toEqual({ Accept: 'application/json' });
  });

  it('classifies hosts into credential families', () => {
    expect(credentialFamily('caldav.icloud.com')).toBe('icloud');
    expect(credentialFamily('P7-Contacts.iCloud.com')).toBe('icloud');
    expect(credentialFamily('icloud.com')).toBe('icloud');
    expect(credentialFamily('amp-api.music.apple.com')).toBe('music');
    expect(credentialFamily('music.apple.com')).toBe('music');
    expect(credentialFamily('weatherkit.apple.com')).toBe('weatherkit.apple.com');
  });

  it('refuses a redirect off the allowlist before the credential travels', async () => {
    fetchMock.mockResolvedValueOnce(res(302, '', { location: 'https://evil.example/steal' }));
    const err = (await rejection(httpRequest({ service: 'calendar', method: 'GET', url: 'https://caldav.icloud.com/', headers: { Authorization: 'Basic x' } }))) as AppleToolError;
    expect(err.message).toContain('refusing to contact https://evil.example');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a Location that is not a URL as an upstream error, not an internal one', async () => {
    fetchMock.mockResolvedValueOnce(res(302, '', { location: 'https://[not-a-host/x' }));
    const err = (await rejection(httpRequest({ service: 'music', method: 'GET', url: 'https://music.apple.com/a' }))) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(302);
    expect(err.message).toBe('music: /a redirected (HTTP 302) to a Location that is not a URL.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after five redirects', async () => {
    fetchMock.mockImplementation(async () => res(302, '', { location: '/loop' }));
    const err = (await rejection(httpRequest({ service: 'music', method: 'GET', url: 'https://music.apple.com/a' }))) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.message).toBe('music: too many redirects from /loop.');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('does not treat a 304 or a Location-less 3xx as a redirect', async () => {
    fetchMock.mockResolvedValueOnce(res(304, '', { location: '/x' }));
    const e304 = (await rejection(httpRequest({ service: 'music', method: 'GET', url: URL_MUSIC }))) as UpstreamError;
    expect(e304.status).toBe(304);
    fetchMock.mockResolvedValueOnce(res(300, 'choices'));
    const e300 = (await rejection(httpRequest({ service: 'music', method: 'GET', url: URL_MUSIC }))) as UpstreamError;
    expect(e300.status).toBe(300);
    expect(e300.message).toContain('— choices');
  });
});

describe('httpRequest — error statuses', () => {
  it('retries a 429 after Retry-After (capped), then succeeds', async () => {
    fetchMock.mockResolvedValueOnce(res(429, '', { 'retry-after': '3' })).mockResolvedValueOnce(res(200, 'ok'));
    expect((await httpRequest({ service: 'itunes', method: 'GET', url: 'https://itunes.apple.com/search' })).data).toBe('ok');
    expect(sleeps).toEqual([3000]);
    fetchMock.mockResolvedValueOnce(res(429, '', { 'retry-after': '600' })).mockResolvedValueOnce(res(200, 'ok'));
    await httpRequest({ service: 'itunes', method: 'GET', url: 'https://itunes.apple.com/search' });
    expect(sleeps).toEqual([3000, 10_000]);
  });

  it('retries a 429 even for a write (Apple refused to process it), then reports RATE_LIMITED', async () => {
    fetchMock.mockImplementation(async () => res(429, ''));
    const err = (await rejection(httpRequest({ service: 'music', method: 'POST', url: URL_MUSIC }))) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.status).toBe(429);
    expect(err.hint).toContain('Wait a minute');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2000]);
  });

  it('honours rateLimitRetries', async () => {
    fetchMock.mockImplementation(async () => res(429, ''));
    await rejection(httpRequest({ service: 'itunes', method: 'GET', url: 'https://itunes.apple.com/search', rateLimitRetries: 0 }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    await rejection(httpRequest({ service: 'itunes', method: 'GET', url: 'https://itunes.apple.com/search', rateLimitRetries: 3 }));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('retries one 502/503/504 for a read, sharing the single retry with connection failures', async () => {
    fetchMock.mockResolvedValueOnce(res(503, '')).mockResolvedValueOnce(res(200, 'ok'));
    expect((await httpRequest({ service: 'maps', method: 'GET', url: 'https://maps-api.apple.com/v1/x' })).data).toBe('ok');
    expect(sleeps).toEqual([1000]);
    fetchMock.mockResolvedValueOnce(res(502, '')).mockResolvedValueOnce(res(504, 'still down'));
    const err = (await rejection(httpRequest({ service: 'maps', method: 'GET', url: 'https://maps-api.apple.com/v1/x' }))) as UpstreamError;
    expect(err.status).toBe(504);
    expect(err.message).toBe('maps: GET /v1/x failed with HTTP 504 — still down');
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(res(503, ''));
    expect(((await rejection(httpRequest({ service: 'maps', method: 'GET', url: 'https://maps-api.apple.com/v1/x' }))) as UpstreamError).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a 5xx or 408 on a write is UNCONFIRMED_WRITE (scrubbed), never retried', async () => {
    rememberSecret('write-secret-123');
    fetchMock.mockResolvedValueOnce(json(500, { message: 'oops write-secret-123' }));
    const err = (await rejection(httpRequest({ service: 'contacts', method: 'PUT', url: 'https://p1-contacts.icloud.com/c.vcf' }))) as UnconfirmedWriteError;
    expect(err).toBeInstanceOf(UnconfirmedWriteError);
    expect(err.message).toBe('contacts: PUT /c.vcf got HTTP 500 — oops [REDACTED]; the change may have been applied.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(res(408, ''));
    const e408 = (await rejection(httpRequest({ service: 'contacts', method: 'PUT', url: 'https://p1-contacts.icloud.com/c.vcf' }))) as UnconfirmedWriteError;
    expect(e408.message).toBe('contacts: PUT /c.vcf got HTTP 408; the change may have been applied.');
  });

  it('lets classifyError map a status first, falling back to the defaults when it declines', async () => {
    const mapped = new UpstreamError('music', 403, 'mapped');
    const classifyError = vi.fn((status: number) => (status === 403 ? mapped : undefined));
    fetchMock.mockResolvedValueOnce(res(403, 'forbidden', { 'x-a': '1' }));
    expect(await rejection(httpRequest({ service: 'music', method: 'GET', url: URL_MUSIC, classifyError }))).toBe(mapped);
    expect(classifyError).toHaveBeenCalledWith(403, 'forbidden', expect.any(Headers));
    fetchMock.mockResolvedValueOnce(res(404, ''));
    const nf = (await rejection(httpRequest({ service: 'music', method: 'GET', url: URL_MUSIC, classifyError }))) as UpstreamError;
    expect(nf.code).toBe('NOT_FOUND');
    expect(nf.message).toBe('music: GET /v1/catalog/us/songs failed with HTTP 404');
  });

  it('maps 401 to CredentialsRejectedError with a scrubbed message', async () => {
    rememberSecret('Music-User-Token-value');
    fetchMock.mockResolvedValueOnce(json(401, { errors: [{ title: 'Unauthorized', detail: 'token Music-User-Token-value bad' }] }));
    const err = (await rejection(httpRequest({ service: 'music', method: 'GET', url: URL_MUSIC }))) as CredentialsRejectedError;
    expect(err).toBeInstanceOf(CredentialsRejectedError);
    expect(err.status).toBe(401);
    expect(err.message).toBe('music: GET /v1/catalog/us/songs failed with HTTP 401 — Unauthorized: token [REDACTED] bad');
    expect(err.hint).toContain('retrying will not help');
  });

  it('carries an upstream error code from the body when there is one', async () => {
    fetchMock.mockResolvedValueOnce(json(400, { errors: [{ code: '40005', title: 'Invalid Parameter Value' }] }));
    const err = (await rejection(httpRequest({ service: 'music', method: 'get', url: URL_MUSIC }))) as UpstreamError;
    expect(err.code).toBe('UPSTREAM_ERROR');
    expect(err.upstreamCode).toBe('40005');
    expect(err.message).toBe('music: GET /v1/catalog/us/songs failed with HTTP 400 — Invalid Parameter Value');
    fetchMock.mockResolvedValueOnce(json(400, { message: 'plain' }));
    const plain = (await rejection(httpRequest({ service: 'music', method: 'GET', url: URL_MUSIC }))) as UpstreamError;
    expect(plain.upstreamCode).toBeUndefined();
  });
});

describe('host allowlist mirrors the deployment egress list', () => {
  it('every host httpRequest may call is in mint.yaml egress.allow (else a hosted child is blocked by the proxy)', () => {
    const yaml = readFileSync(fileURLToPath(new URL('../mint.yaml', import.meta.url)), 'utf8');
    const section = yaml.slice(yaml.indexOf('egress:'));
    const allow = [...section.matchAll(/^\s*-\s*"?([^"\s]+)"?\s*$/gm)].map((m) => m[1]);
    for (const host of ALLOWED_HOSTS) expect(allow, host).toContain(host);
    for (const suffix of ALLOWED_HOST_SUFFIXES) expect(allow, suffix).toContain(`*${suffix}`);
    // An unused host is surface for nothing: this one was allowed here but not by the proxy.
    expect(isAllowedHost('amp-api-edge.music.apple.com')).toBe(false);
  });
});

describe('describeErrorBody — size', () => {
  it('caps a JSON error message at 500 characters, whatever field it came from', () => {
    const long = 'y'.repeat(2000);
    for (const body of [
      { errors: [{ title: 'T', detail: long }] },
      { error: { message: long } },
      { reason: long },
      { message: long },
    ]) {
      const { message } = describeErrorBody(JSON.stringify(body));
      expect(message.length).toBeLessThanOrEqual(500 + '… [truncated]'.length);
      expect(message.endsWith('… [truncated]')).toBe(true);
    }
    expect(describeErrorBody(JSON.stringify({ message: 'x'.repeat(500) })).message).toBe('x'.repeat(500));
  });
});

/** A streamed response whose chunks are served one per read; `failAfter` errors the stream after that many chunks. */
function streamed(
  status: number,
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
  opts: { failAfter?: number } = {},
): { response: Response; cancelled: () => boolean; served: () => number } {
  let i = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.failAfter !== undefined && i >= opts.failAfter) {
        controller.error(new Error('ECONNRESET mid-body'));
        return;
      }
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 }); // pull only when read, so `served` counts what the reader asked for
  return { response: new Response(stream, { status, headers }), cancelled: () => cancelled, served: () => i };
}

describe('httpRequest — bounded body reads', () => {
  const SIXTEEN_MB = new Uint8Array(16 * 1024 * 1024);

  it('assembles a multi-chunk body in order', async () => {
    const enc = new TextEncoder();
    const s = streamed(200, [enc.encode('{"a":'), enc.encode('[1,'), enc.encode('2]}')], { 'content-type': 'application/json' });
    fetchMock.mockResolvedValueOnce(s.response);
    const out = await httpRequest({ service: 'music', method: 'GET', url: URL_MUSIC });
    expect(out.data).toEqual({ a: [1, 2] });
    expect(out.bytes.byteLength).toBe(11);
  });

  it('refuses a declared Content-Length over the cap WITHOUT reading the body, and cancels it', async () => {
    const s = streamed(200, [SIXTEEN_MB], { 'content-length': String(MAX_RESPONSE_BYTES + 1) });
    fetchMock.mockResolvedValueOnce(s.response);
    const err = (await rejection(httpRequest({ service: 'contacts', method: 'REPORT', url: 'https://p1-contacts.icloud.com/card/' }))) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.status).toBe(200);
    expect(err.message).toBe(`contacts: response from /card/ is larger than ${MAX_RESPONSE_BYTES} bytes; refusing to read it.`);
    expect(s.served()).toBe(0);
    expect(s.cancelled()).toBe(true);
  });

  it('stops a stream that grows past the cap as soon as it does (no Content-Length, e.g. a compressed body)', async () => {
    const s = streamed(200, [SIXTEEN_MB, SIXTEEN_MB, SIXTEEN_MB, SIXTEEN_MB]);
    fetchMock.mockResolvedValueOnce(s.response);
    const err = (await rejection(httpRequest({ service: 'contacts', method: 'REPORT', url: 'https://p1-contacts.icloud.com/card/' }))) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.message).toContain('is larger than');
    expect(s.served()).toBe(3); // the third chunk crossed 32 MiB; the fourth was never pulled
    expect(s.cancelled()).toBe(true);
  });

  it('a write whose over-size response may mean it landed is UNCONFIRMED_WRITE; a definitive 4xx is not', async () => {
    fetchMock.mockResolvedValueOnce(streamed(201, [SIXTEEN_MB, SIXTEEN_MB, SIXTEEN_MB]).response);
    const landed = (await rejection(httpRequest({ service: 'calendar', method: 'PUT', url: 'https://p1-caldav.icloud.com/a.ics' }))) as UnconfirmedWriteError;
    expect(landed).toBeInstanceOf(UnconfirmedWriteError);
    expect(landed.message).toContain('(HTTP 201); the change may have been applied.');
    fetchMock.mockResolvedValueOnce(streamed(400, [], { 'content-length': String(MAX_RESPONSE_BYTES + 1) }).response);
    const refused = await rejection(httpRequest({ service: 'calendar', method: 'PUT', url: 'https://p1-caldav.icloud.com/a.ics' }));
    expect(refused).toBeInstanceOf(UpstreamError);
    expect(refused).not.toBeInstanceOf(UnconfirmedWriteError);
  });

  it('does not judge a body-less answer (HEAD, 204, 304) by the Content-Length of the body it did not send', async () => {
    // A HEAD response arrives with no body stream at all.
    const head = new Response(null, { status: 200, headers: { 'content-length': String(MAX_RESPONSE_BYTES * 4) } });
    fetchMock.mockResolvedValueOnce(head);
    const out = await httpRequest({ service: 'music', method: 'HEAD', url: URL_MUSIC });
    expect(out.status).toBe(200);
    expect(out.bytes.byteLength).toBe(0);
  });

  it('a response object with no stream is read whole and still checked (write → UNCONFIRMED_WRITE)', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      url: '',
      headers: new Headers(),
      arrayBuffer: async () => new ArrayBuffer(MAX_RESPONSE_BYTES + 1),
    } as unknown as Response);
    expect(await rejection(httpRequest({ service: 'music', method: 'POST', url: URL_MUSIC }))).toBeInstanceOf(UnconfirmedWriteError);
  });

  it('a stream that errors mid-body is a lost connection: NETWORK_ERROR for a read, UNCONFIRMED_WRITE for a write', async () => {
    fetchMock.mockResolvedValueOnce(streamed(200, [new Uint8Array(10), new Uint8Array(10)], {}, { failAfter: 1 }).response);
    const read = (await rejection(httpRequest({ service: 'maps', method: 'GET', url: 'https://maps-api.apple.com/v1/x' }))) as TransportError;
    expect(read).toBeInstanceOf(TransportError);
    expect(read.code).toBe('NETWORK_ERROR');
    expect(read.message).toContain('lost the connection reading the response');
    fetchMock.mockResolvedValueOnce(streamed(200, [new Uint8Array(10)], {}, { failAfter: 0 }).response);
    expect(await rejection(httpRequest({ service: 'music', method: 'POST', url: URL_MUSIC }))).toBeInstanceOf(UnconfirmedWriteError);
  });

  it('ignores a cancel() that itself fails while refusing an over-size body', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      url: '',
      headers: new Headers({ 'content-length': String(MAX_RESPONSE_BYTES * 2) }),
      body: { cancel: () => Promise.reject(new Error('already closed')) },
    } as unknown as Response);
    expect(await rejection(httpRequest({ service: 'music', method: 'GET', url: URL_MUSIC }))).toBeInstanceOf(UpstreamError);
    const reader = {
      read: async () => ({ done: false, value: SIXTEEN_MB }),
      cancel: () => Promise.reject(new Error('already closed')),
    };
    fetchMock.mockResolvedValueOnce({ status: 200, url: '', headers: new Headers(), body: { getReader: () => reader } } as unknown as Response);
    const err = (await rejection(httpRequest({ service: 'music', method: 'GET', url: URL_MUSIC }))) as UpstreamError;
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err.message).toContain('is larger than');
  });
});

describe('httpRequest — write-outcome guarantees hold whatever classifyError says', () => {
  it('a 5xx or 408 on a write is UNCONFIRMED_WRITE even when the service maps it (classifyError runs, but cannot override)', async () => {
    const classifyError = vi.fn(() => new UpstreamError('music', 500, 'mapped by the service'));
    for (const status of [500, 503, 408]) {
      fetchMock.mockResolvedValueOnce(res(status, ''));
      const err = await rejection(httpRequest({ service: 'music', method: 'PUT', url: URL_MUSIC, classifyError }));
      expect(err, `status ${status}`).toBeInstanceOf(UnconfirmedWriteError);
    }
    expect(classifyError).toHaveBeenCalledTimes(3); // consulted (side effects such as a latch still happen)…
    // …and its answer still stands for a read.
    fetchMock.mockResolvedValueOnce(res(500, ''));
    expect(((await rejection(httpRequest({ service: 'music', method: 'GET', url: URL_MUSIC, classifyError }))) as Error).message).toBe('mapped by the service');
    // And a 4xx on a write too.
    fetchMock.mockResolvedValueOnce(res(409, ''));
    expect(((await rejection(httpRequest({ service: 'music', method: 'PUT', url: URL_MUSIC, classifyError }))) as Error).message).toBe('mapped by the service');
  });
});

describe('httpRequest — redirect that drops the body', () => {
  it('drops the body headers along with the body, and keeps the rest', async () => {
    const sent: Array<Record<string, string>> = [];
    const replies = [res(303, '', { location: 'https://p9-caldav.icloud.com/x' }), res(200, 'ok')];
    fetchMock.mockImplementation(async (_u, init) => {
      sent.push({ ...(init.headers as Record<string, string>) });
      return replies.shift()!;
    });
    await httpRequest({
      service: 'calendar',
      method: 'POST',
      url: 'https://caldav.icloud.com/',
      json: { a: 1 },
      headers: { Authorization: 'Basic x', 'Content-Language': 'en', Depth: '0' },
    });
    expect(sent[0]).toEqual({ Authorization: 'Basic x', 'Content-Language': 'en', Depth: '0', 'Content-Type': 'application/json' });
    expect(sent[1]).toEqual({ Authorization: 'Basic x', Depth: '0' });
  });
});
