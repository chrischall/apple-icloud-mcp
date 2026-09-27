import { createVerify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { decodeJwtPayload } from '../../src/apple-keys.js';
import { ConfigError, CredentialsRejectedError, UpstreamError, scrub } from '../../src/errors.js';
import type { HttpRequest, HttpResponse } from '../../src/http.js';
import {
  ACCESS_REJECTED_HINT,
  FORBIDDEN_HINT,
  MapsClient,
  QUOTA_HINT,
  TOKEN_REJECTED_HINT,
  classifyMapsError,
  exchangeMapsToken,
  keyFingerprint,
  mapsErrorDetail,
  type RequestFn,
} from '../../src/maps/client.js';
import { ACCESS_TOKEN, KEY, NOW, PRIVATE_PEM, PUBLIC_KEY, TEAM_ID, KEY_ID, fakeRequest, setKeyEnv } from './_helpers.js';

const tokenCalls = (request: ReturnType<typeof fakeRequest>) =>
  request.mock.calls.filter((c) => new URL(String((c[0] as HttpRequest).url)).pathname === '/v1/token').length;

describe('mapsErrorDetail', () => {
  it('reads the live wrapped shape with details', () => {
    expect(mapsErrorDetail('{"error":{"message":"Bad Request","details":["q is required",""]}}')).toBe('Bad Request (q is required)');
  });
  it('reads the documented bare shape and message-only / details-only bodies', () => {
    expect(mapsErrorDetail('{"message":"Not Authorized","details":[]}')).toBe('Not Authorized');
    expect(mapsErrorDetail('{"error":{"details":["only detail"]}}')).toBe('(only detail)');
  });
  it('falls back to the generic describer for other bodies', () => {
    expect(mapsErrorDetail('<html><body>Gateway timeout</body></html>')).toBe('Gateway timeout');
    expect(mapsErrorDetail('{"reason":"nope"}')).toBe('nope');
    expect(mapsErrorDetail('null')).toBe('null');
    expect(mapsErrorDetail('')).toBe('');
  });
});

describe('classifyMapsError', () => {
  it('maps 401/403 by phase', () => {
    const tok = classifyMapsError('GET', '/v1/token', 'token')(401, '{"error":{"message":"Not Authorized"}}');
    expect(tok).toBeInstanceOf(CredentialsRejectedError);
    expect((tok as CredentialsRejectedError).hint).toBe(TOKEN_REJECTED_HINT);
    expect((tok as Error).message).toBe('maps: GET /v1/token failed with HTTP 401 — Not Authorized');
    const d401 = classifyMapsError('GET', '/v1/geocode', 'data')(401, '');
    expect((d401 as CredentialsRejectedError).hint).toBe(ACCESS_REJECTED_HINT);
    expect((d401 as Error).message).toBe('maps: GET /v1/geocode failed with HTTP 401');
    const d403 = classifyMapsError('GET', '/v1/geocode', 'data')(403, '');
    expect((d403 as CredentialsRejectedError).hint).toBe(FORBIDDEN_HINT);
    expect((d403 as CredentialsRejectedError).status).toBe(403);
  });

  it('maps 400 to INVALID_ARGUMENT, 429 to RATE_LIMITED with the quota hint, and leaves the rest to the defaults', () => {
    const c = classifyMapsError('GET', '/v1/search', 'data');
    const bad = c(400, '{"error":{"message":"Invalid parameter","details":["includePoiCategories"]}}') as UpstreamError;
    expect(bad).toBeInstanceOf(UpstreamError);
    expect(bad.code).toBe('INVALID_ARGUMENT');
    expect(bad.message).toContain('Invalid parameter (includePoiCategories)');
    const limited = c(429, '') as UpstreamError;
    expect(limited.code).toBe('RATE_LIMITED');
    expect(limited.hint).toBe(QUOTA_HINT);
    expect(c(500, 'oops')).toBeUndefined();
    const missing = c(404, '{"error":{"message":"Not Found"}}') as UpstreamError;
    expect(missing.code).toBe('NOT_FOUND');
    expect(missing.hint).toMatch(/found nothing/);
  });

  it('a 429 at the token endpoint is the shared quota, not a key problem', () => {
    const limited = classifyMapsError('GET', '/v1/token', 'token')(429, '{"error":{"message":"Too Many Requests"}}') as UpstreamError;
    expect(limited).toBeInstanceOf(UpstreamError);
    expect(limited).not.toBeInstanceOf(CredentialsRejectedError);
    expect(limited.code).toBe('RATE_LIMITED');
    expect(limited.hint).toBe(QUOTA_HINT);
  });
});

describe('exchangeMapsToken', () => {
  it('signs a server_api JWT with the key and exchanges it', async () => {
    const request = fakeRequest({});
    const out = await exchangeMapsToken(KEY, request, NOW);
    expect(out).toEqual({ accessToken: ACCESS_TOKEN, expiresInSeconds: 1800 });
    const req = request.mock.calls[0]![0] as HttpRequest;
    expect(req.url).toBe('https://maps-api.apple.com/v1/token');
    expect(req.method).toBe('GET');
    const jwt = req.headers!.Authorization!.replace(/^Bearer /, '');
    const [h, p, s] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'ES256', typ: 'JWT', kid: KEY_ID });
    expect(decodeJwtPayload(jwt)).toEqual({ iss: TEAM_ID, iat: NOW / 1000, exp: NOW / 1000 + 3600, scope: 'server_api' });
    const ok = createVerify('SHA256').update(`${h}.${p}`).verify({ key: PUBLIC_KEY, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
    // Both tokens are scrubbed from anything that could reach a result or log.
    expect(scrub(`auth ${jwt} access ${ACCESS_TOKEN}`)).not.toContain(ACCESS_TOKEN);
    expect(scrub(`auth ${jwt}`)).not.toContain(s);
  });

  it('defaults the lifetime when Apple omits it', async () => {
    const request = fakeRequest({ '/v1/token': () => ({ data: { accessToken: 'tok-without-expiry-000' } }) });
    expect(await exchangeMapsToken(KEY, request, NOW)).toEqual({ accessToken: 'tok-without-expiry-000', expiresInSeconds: 1800 });
  });

  it('refuses a token response without an access token', async () => {
    const request = fakeRequest({ '/v1/token': () => ({ data: { expiresInSeconds: 1800 } }) });
    await expect(exchangeMapsToken(KEY, request, NOW)).rejects.toMatchObject({
      name: 'UpstreamError',
      message: 'maps: GET /v1/token answered without a usable accessToken.',
    });
    const nullBody = fakeRequest({ '/v1/token': () => ({ data: null }) });
    await expect(exchangeMapsToken(KEY, nullBody, NOW)).rejects.toBeInstanceOf(UpstreamError);
  });

  it('reports a rejected key with the token hint', async () => {
    const request = fakeRequest({ '/v1/token': () => ({ error: 401, body: '{"error":{"message":"Not Authorized","details":[]}}' }) });
    await expect(exchangeMapsToken(KEY, request, NOW)).rejects.toMatchObject({ code: 'CREDENTIALS_REJECTED', status: 401, hint: TOKEN_REJECTED_HINT });
  });
});

describe('keyFingerprint', () => {
  it('changes with any part of the key and never contains it', () => {
    const a = keyFingerprint(KEY);
    expect(a).toBe(keyFingerprint({ ...KEY, source: 'other' }));
    expect(keyFingerprint({ ...KEY, teamId: 'OTHERTEAM1' })).not.toBe(a);
    expect(keyFingerprint({ ...KEY, keyId: 'OTHERKEY01' })).not.toBe(a);
    expect(a).not.toContain(TEAM_ID);
  });
});

describe('MapsClient', () => {
  const geocodeOk = () => ({ data: { results: [] } });

  it('caches the access token across calls and sends it as Bearer', async () => {
    const request = fakeRequest({ '/v1/geocode': geocodeOk });
    const client = new MapsClient({ request, resolveKey: () => KEY, now: () => NOW });
    const r = await client.get('/v1/geocode', { q: 'x' });
    await client.get('/v1/geocode', { q: 'y' });
    expect(r).toEqual({ status: 200, data: { results: [] } });
    expect(tokenCalls(request)).toBe(1);
    const data = request.mock.calls[1]![0] as HttpRequest;
    expect(data.url).toBe('https://maps-api.apple.com/v1/geocode');
    expect(data.query).toEqual({ q: 'x' });
    expect(data.headers).toEqual({ Authorization: `Bearer ${ACCESS_TOKEN}` });
    expect(await client.accessToken()).toBe(ACCESS_TOKEN);
    expect(tokenCalls(request)).toBe(1);
  });

  it('re-exchanges once the token is within 60 s of expiry', async () => {
    let now = NOW;
    const request = fakeRequest({ '/v1/geocode': geocodeOk });
    const client = new MapsClient({ request, resolveKey: () => KEY, now: () => now });
    await client.get('/v1/geocode');
    now = NOW + (1800 - 61) * 1000;
    await client.get('/v1/geocode');
    expect(tokenCalls(request)).toBe(1);
    now = NOW + (1800 - 59) * 1000;
    await client.get('/v1/geocode');
    expect(tokenCalls(request)).toBe(2);
  });

  it('does not reuse a token minted from a different key', async () => {
    let key = KEY;
    const request = fakeRequest({ '/v1/geocode': geocodeOk });
    const client = new MapsClient({ request, resolveKey: () => key, now: () => NOW });
    await client.get('/v1/geocode');
    key = { ...KEY, keyId: 'ROTATED001' };
    await client.get('/v1/geocode');
    expect(tokenCalls(request)).toBe(2);
  });

  it('on a 401 from a data endpoint re-exchanges and replays exactly once', async () => {
    const tokens = [
      () => ({ data: { accessToken: 'first-token-000000', expiresInSeconds: 1800 } }),
      () => ({ data: { accessToken: 'second-token-00000', expiresInSeconds: 1800 } }),
    ];
    const request = fakeRequest({ '/v1/token': tokens, '/v1/geocode': [() => ({ error: 401 }), geocodeOk] });
    const client = new MapsClient({ request, resolveKey: () => KEY, now: () => NOW });
    await expect(client.get('/v1/geocode')).resolves.toEqual({ status: 200, data: { results: [] } });
    const auths = request.mock.calls
      .map((c) => c[0] as HttpRequest)
      .filter((r) => String(r.url).endsWith('/v1/geocode'))
      .map((r) => r.headers!.Authorization);
    expect(auths).toEqual(['Bearer first-token-000000', 'Bearer second-token-00000']);
  });

  it('concurrent calls refused together share ONE re-exchange (none invalidates the token another just fetched)', async () => {
    const tokens = [
      () => ({ data: { accessToken: 'expired-token-0000', expiresInSeconds: 1800 } }),
      () => ({ data: { accessToken: 'renewed-token-0000', expiresInSeconds: 1800 } }),
      () => ({ data: { accessToken: 'wasteful-token-000', expiresInSeconds: 1800 } }),
    ];
    const request = fakeRequest({
      '/v1/token': tokens,
      '/v1/geocode': (req) => (req.headers!.Authorization === 'Bearer expired-token-0000' ? { error: 401 } : geocodeOk()),
    });
    const client = new MapsClient({ request, resolveKey: () => KEY, now: () => NOW });
    await client.accessToken();
    const results = await Promise.all([client.get('/v1/geocode'), client.get('/v1/geocode'), client.get('/v1/geocode')]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(tokenCalls(request)).toBe(2);
    const replayAuths = request.mock.calls
      .map((c) => c[0] as HttpRequest)
      .filter((r) => String(r.url).endsWith('/v1/geocode'))
      .map((r) => r.headers!.Authorization);
    expect(replayAuths.filter((a) => a === 'Bearer renewed-token-0000')).toHaveLength(3);
  });

  it('a refusal that arrives AFTER another call renewed the token replays with that token — no third exchange', async () => {
    // Deterministic version of the race: call B's 401 is held until call A has
    // been refused, re-exchanged and succeeded. Invalidating on B's refusal
    // would throw away A's fresh token and exchange a third one.
    let exchanges = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const auths: string[] = [];
    const ok = <T>(data: unknown): HttpResponse<T> => ({ status: 200, headers: new Headers(), url: '', data: data as T, text: '', bytes: new Uint8Array() });
    const request = (async (req: HttpRequest) => {
      if (new URL(String(req.url)).pathname === '/v1/token') {
        exchanges += 1;
        return ok({ accessToken: `token-${exchanges}-000000`, expiresInSeconds: 1800 });
      }
      const auth = req.headers!.Authorization!;
      auths.push(auth);
      if (auth === 'Bearer token-1-000000') {
        if (auths.length === 2) await gate;
        throw req.classifyError!(401, '', new Headers())!;
      }
      return ok({ results: [] });
    }) as unknown as RequestFn;
    const client = new MapsClient({ request, resolveKey: () => KEY, now: () => NOW });
    await client.accessToken();
    const a = client.get('/v1/geocode');
    const b = client.get('/v1/geocode');
    await expect(a).resolves.toMatchObject({ status: 200 });
    release();
    await expect(b).resolves.toMatchObject({ status: 200 });
    expect(exchanges).toBe(2);
    expect(auths).toEqual(['Bearer token-1-000000', 'Bearer token-1-000000', 'Bearer token-2-000000', 'Bearer token-2-000000']);
  });

  it('reports a second 401 with the access hint', async () => {
    const request = fakeRequest({ '/v1/geocode': () => ({ error: 401 }) });
    const client = new MapsClient({ request, resolveKey: () => KEY, now: () => NOW });
    await expect(client.get('/v1/geocode')).rejects.toMatchObject({ code: 'CREDENTIALS_REJECTED', hint: ACCESS_REJECTED_HINT });
    expect(tokenCalls(request)).toBe(2);
  });

  it('does not replay a 403, or a refusal at the token endpoint itself', async () => {
    const forbidden = fakeRequest({ '/v1/geocode': () => ({ error: 403 }) });
    const c1 = new MapsClient({ request: forbidden, resolveKey: () => KEY, now: () => NOW });
    await expect(c1.get('/v1/geocode')).rejects.toMatchObject({ status: 403, hint: FORBIDDEN_HINT });
    expect(forbidden).toHaveBeenCalledTimes(2);

    const badKey = fakeRequest({ '/v1/token': () => ({ error: 401 }), '/v1/geocode': geocodeOk });
    const c2 = new MapsClient({ request: badKey, resolveKey: () => KEY, now: () => NOW });
    await expect(c2.get('/v1/geocode')).rejects.toMatchObject({ hint: TOKEN_REJECTED_HINT });
    expect(badKey).toHaveBeenCalledTimes(1);
  });

  it('passes other errors through untouched', async () => {
    const boom = new Error('network gone');
    const request = fakeRequest({
      '/v1/geocode': () => {
        throw boom;
      },
    });
    const client = new MapsClient({ request, resolveKey: () => KEY, now: () => NOW });
    await expect(client.get('/v1/geocode')).rejects.toBe(boom);
  });

  it('resolves the key from the environment at call time', async () => {
    const request = fakeRequest({ '/v1/geocode': geocodeOk });
    const client = new MapsClient({ request, now: () => NOW });
    expect(() => client.key()).toThrow(ConfigError);
    await expect(client.get('/v1/geocode')).rejects.toBeInstanceOf(ConfigError);
    expect(request).not.toHaveBeenCalled();
    setKeyEnv();
    expect(client.key()).toMatchObject({ teamId: TEAM_ID, keyId: KEY_ID });
    await expect(client.get('/v1/geocode')).resolves.toMatchObject({ status: 200 });
  });

  it('goes through httpRequest and global fetch by default', async () => {
    const fetchMock = vi.fn(async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/token') {
        return new Response(JSON.stringify({ accessToken: 'fetched-token-12345', expiresInSeconds: 1800 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fetched-token-12345');
      return new Response(JSON.stringify({ results: [{ name: 'Apple Park' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new MapsClient({ resolveKey: () => KEY });
    const res = await client.get('/v1/geocode', { q: 'Apple Park, Cupertino', limitToCountries: ['US', 'CA'] });
    expect(res.data).toEqual({ results: [{ name: 'Apple Park' }] });
    expect(String(fetchMock.mock.calls[1]![0])).toBe('https://maps-api.apple.com/v1/geocode?q=Apple%20Park,%20Cupertino&limitToCountries=US,CA');
    expect(client.now).toBe(Date.now);
    // A PEM never travels anywhere.
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(PRIVATE_PEM.split('\n')[1]);
  });
});
