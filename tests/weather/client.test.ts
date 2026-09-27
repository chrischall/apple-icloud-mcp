import { describe, expect, it } from 'vitest';
import { ConfigError, CredentialsRejectedError, UpstreamError } from '../../src/errors.js';
import { resolveWeatherAuth } from '../../src/weather/auth.js';
import {
  ALERT_NOT_FOUND_HINT,
  classifyWeatherError,
  createWeatherClient,
  defaultWeatherClient,
  formatCoordinate,
  rejectedHint,
  type WeatherQuery,
} from '../../src/weather/client.js';
import { ALERT_ID, NOW, SERVICE_ID, TEAM_ID, authHeader, decodeJwt, queueFetch, sampleWeather, setWeatherEnv } from './_fixtures.js';

const QUERY: WeatherQuery = {
  language: 'en',
  latitude: 40.7128,
  longitude: -74.006,
  timezone: 'America/New_York',
  dataSets: ['currentWeather', 'forecastHourly'],
  countryCode: 'US',
  hourlyStart: '2026-09-26T18:00:00Z',
  hourlyEnd: '2026-09-27T18:00:00Z',
};

async function rejects(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
}

describe('formatCoordinate', () => {
  it('uses four decimals and never exponent notation or -0', () => {
    expect(formatCoordinate(37.3349)).toBe('37.3349');
    expect(formatCoordinate(-122.009)).toBe('-122.0090');
    expect(formatCoordinate(1e-7)).toBe('0.0000');
    expect(formatCoordinate(-0.00001)).toBe('0.0000');
    expect(formatCoordinate(12.345678)).toBe('12.3457');
    expect(formatCoordinate(-90)).toBe('-90.0000');
  });
});

describe('WeatherKit client over httpRequest', () => {
  it('GETs the weather with the documented path, query and bearer token', async () => {
    setWeatherEnv();
    const { calls } = queueFetch({ body: sampleWeather() });
    const client = createWeatherClient({ now: () => NOW });
    const data = await client.getWeather(QUERY);
    expect(Object.keys(data)).toContain('currentWeather');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://weatherkit.apple.com/api/v1/weather/en/40.7128/-74.0060?dataSets=currentWeather,forecastHourly' +
        '&timezone=America%2FNew_York&countryCode=US&hourlyStart=2026-09-26T18%3A00%3A00Z&hourlyEnd=2026-09-27T18%3A00%3A00Z',
    );
    const init = calls[0]!.init;
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Accept).toBe('application/json');
    const { header, payload } = decodeJwt(authHeader(init));
    expect(header).toMatchObject({ alg: 'ES256', id: `${TEAM_ID}.${SERVICE_ID}` });
    expect(payload.sub).toBe(SERVICE_ID);
  });

  it('omits optional query parameters that were not given and percent-encodes path segments', async () => {
    setWeatherEnv();
    const { calls } = queueFetch({ body: {} });
    await createWeatherClient({ now: () => NOW }).getWeather({ language: 'en-GB', latitude: 0, longitude: 0, timezone: 'UTC', dataSets: ['currentWeather'] });
    expect(calls[0]!.url).toBe('https://weatherkit.apple.com/api/v1/weather/en-GB/0.0000/0.0000?dataSets=currentWeather&timezone=UTC');
  });

  it('reuses the cached token across calls', async () => {
    setWeatherEnv();
    let now = NOW;
    const { calls } = queueFetch({ body: {} }, { body: {} });
    const client = createWeatherClient({ now: () => now });
    await client.getWeather(QUERY);
    now += 30_000;
    await client.getWeather(QUERY);
    expect(authHeader(calls[1]!.init)).toBe(authHeader(calls[0]!.init));
  });

  it('replays ONCE with a fresh token when Apple rejects a cached one', async () => {
    setWeatherEnv();
    let now = NOW;
    const { calls } = queueFetch({ body: {} }, { status: 401, body: { reason: 'NOT_ENABLED' } }, { body: sampleWeather() });
    const client = createWeatherClient({ now: () => now });
    await client.getWeather(QUERY);
    now += 30_000;
    const data = await client.getWeather(QUERY);
    expect(data).toHaveProperty('currentWeather');
    expect(calls).toHaveLength(3);
    expect(authHeader(calls[1]!.init)).toBe(authHeader(calls[0]!.init));
    expect(authHeader(calls[2]!.init)).not.toBe(authHeader(calls[1]!.init));
  });

  it('does not replay a rejection of a token minted for this call, and forgets that token', async () => {
    setWeatherEnv();
    let now = NOW;
    const { calls } = queueFetch({ status: 401, body: { reason: 'NOT_ENABLED' } }, { body: {} });
    const client = createWeatherClient({ now: () => now });
    const err = await rejects(client.getWeather(QUERY));
    expect(err).toBeInstanceOf(CredentialsRejectedError);
    expect((err as CredentialsRejectedError).status).toBe(401);
    expect(err.message).toMatch(/HTTP 401 — NOT_ENABLED/);
    expect((err as CredentialsRejectedError).hint).toMatch(/WeatherKit enabled/);
    expect(calls).toHaveLength(1);
    now += 30_000;
    await client.getWeather(QUERY);
    expect(authHeader(calls[1]!.init)).not.toBe(authHeader(calls[0]!.init));
  });

  it('gives up after the single replay is rejected too', async () => {
    setWeatherEnv();
    let now = NOW;
    const { calls } = queueFetch({ body: {} }, { status: 401, body: { reason: 'NOT_ENABLED' } }, { status: 403, body: { reason: 'NOT_ENABLED' } });
    const client = createWeatherClient({ now: () => now });
    await client.getWeather(QUERY);
    now += 30_000;
    const err = await rejects(client.getWeather(QUERY));
    expect(err).toBeInstanceOf(CredentialsRejectedError);
    expect((err as CredentialsRejectedError).status).toBe(403);
    expect(calls).toHaveLength(3);
  });

  it('does not replay a non-credential failure', async () => {
    setWeatherEnv();
    let now = NOW;
    const { calls } = queueFetch({ body: {} }, { status: 400, body: { reason: 'BAD_REQUEST' } });
    const client = createWeatherClient({ now: () => now });
    await client.getWeather(QUERY);
    now += 30_000;
    const err = await rejects(client.getWeather(QUERY));
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('INVALID_ARGUMENT');
    expect((err as UpstreamError).upstreamCode).toBe('BAD_REQUEST');
    expect(calls).toHaveLength(2);
  });

  it('maps 429 (after httpRequest’s own retry) to RATE_LIMITED with the quota hint', async () => {
    setWeatherEnv();
    queueFetch({ status: 429, text: '' }, { status: 429, text: '' });
    const err = await rejects(createWeatherClient({ now: () => NOW }).getWeather(QUERY));
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('RATE_LIMITED');
    expect((err as UpstreamError).hint).toMatch(/500,000 calls a month/);
    expect((err as UpstreamError).upstreamCode).toBeUndefined();
  });

  it('leaves other statuses to the default mapping', async () => {
    setWeatherEnv();
    queueFetch({ status: 500, text: 'Internal Server Error' });
    const err = await rejects(createWeatherClient({ now: () => NOW }).getWeather(QUERY));
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('UPSTREAM_ERROR');
    expect((err as UpstreamError).status).toBe(500);
  });

  it('refuses a weather body that is not an object (never an empty answer)', async () => {
    setWeatherEnv();
    queueFetch({ text: '' }, { body: [] });
    const client = createWeatherClient({ now: () => NOW });
    const empty = await rejects(client.getWeather(QUERY));
    expect(empty).toBeInstanceOf(UpstreamError);
    expect(empty.message).toMatch(/returned no weather object/);
    await expect(client.getWeather(QUERY)).rejects.toThrow(/returned no weather object/);
  });

  it('fetches an alert by language and id', async () => {
    setWeatherEnv();
    const { calls } = queueFetch({ body: { messages: [] } });
    const alert = await createWeatherClient({ now: () => NOW }).getAlert('en', ALERT_ID);
    expect(alert).toEqual({ messages: [] });
    expect(calls[0]!.url).toBe(`https://weatherkit.apple.com/api/v1/weatherAlert/en/${ALERT_ID}`);
  });

  it('maps a 404 alert to NOT_FOUND with the expiry hint, and a non-object alert to an error', async () => {
    setWeatherEnv();
    queueFetch({ status: 404, text: '' }, { body: 'nope' });
    const client = createWeatherClient({ now: () => NOW });
    const err = await rejects(client.getAlert('en', ALERT_ID));
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).code).toBe('NOT_FOUND');
    expect((err as UpstreamError).hint).toBe(ALERT_NOT_FOUND_HINT);
    expect(err.message).toBe('weather: GET /api/v1/weatherAlert failed with HTTP 404');
    await expect(client.getAlert('en', ALERT_ID)).rejects.toThrow(/returned no alert object/);
  });

  it('maps a 404 on the weather path to a language hint', async () => {
    setWeatherEnv();
    queueFetch({ status: 404, body: { reason: 'NOT_FOUND' } });
    const err = await rejects(createWeatherClient({ now: () => NOW }).getWeather(QUERY));
    expect((err as UpstreamError).hint).toMatch(/language tag/);
    expect((err as UpstreamError).upstreamCode).toBe('NOT_FOUND');
  });

  it('reads the availability list and refuses anything that is not a list of names', async () => {
    setWeatherEnv();
    const { calls } = queueFetch({ body: ['currentWeather', 'weatherAlerts'] }, { body: { x: 1 } }, { body: ['ok', 3] });
    const client = createWeatherClient({ now: () => NOW });
    expect(await client.getAvailability(37.3349, -122.009, 'US')).toEqual(['currentWeather', 'weatherAlerts']);
    expect(calls[0]!.url).toBe('https://weatherkit.apple.com/api/v1/availability/37.3349/-122.0090?country=US');
    await expect(client.getAvailability(1, 2, 'US')).rejects.toThrow(/did not return a list/);
    await expect(client.getAvailability(1, 2, 'US')).rejects.toThrow(/did not return a list/);
  });

  it('throws ConfigError before any network I/O when unconfigured', async () => {
    const { fn } = queueFetch();
    await expect(createWeatherClient().getWeather(QUERY)).rejects.toBeInstanceOf(ConfigError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('uses an injected request function', async () => {
    setWeatherEnv();
    const seen: unknown[] = [];
    const client = createWeatherClient({
      now: () => NOW,
      request: (async (req: unknown) => {
        seen.push(req);
        return { status: 200, headers: new Headers(), url: '', data: ['currentWeather'], text: '', bytes: new Uint8Array() };
      }) as never,
    });
    expect(await client.getAvailability(1, 2, 'GB')).toEqual(['currentWeather']);
    expect(seen[0]).toMatchObject({ service: 'weather', method: 'GET', query: { country: 'GB' }, responseType: 'json' });
  });

  it('keeps one process-wide default client', () => {
    expect(defaultWeatherClient()).toBe(defaultWeatherClient());
  });
});

describe('classifyWeatherError', () => {
  it('tolerates non-JSON and non-code bodies', () => {
    setWeatherEnv();
    const auth = resolveWeatherAuth();
    const html = classifyWeatherError(400, '<html>Bad</html>', auth, 'GET /x', 'nf') as UpstreamError;
    expect(html.upstreamCode).toBeUndefined();
    expect(html.message).toBe('weather: GET /x failed with HTTP 400 — Bad');
    const lower = classifyWeatherError(400, '{"reason":"bad thing"}', auth, 'GET /x', 'nf') as UpstreamError;
    expect(lower.upstreamCode).toBeUndefined();
    const arr = classifyWeatherError(404, '[1]', auth, 'GET /x', 'nf') as UpstreamError;
    expect(arr.upstreamCode).toBeUndefined();
    expect(arr.hint).toBe('nf');
    expect(classifyWeatherError(502, '', auth, 'GET /x', 'nf')).toBeUndefined();
  });

  it('points out a Services ID that was prefixed with the Team ID', () => {
    setWeatherEnv({ APPLE_WEATHERKIT_SERVICE_ID: `${TEAM_ID}.${SERVICE_ID}` });
    const auth = resolveWeatherAuth();
    expect(rejectedHint(auth)).toMatch(/starts with the Team ID/);
    const err = classifyWeatherError(403, '{"reason":"NOT_ENABLED"}', auth, 'GET /x', 'nf') as CredentialsRejectedError;
    expect(err).toBeInstanceOf(CredentialsRejectedError);
    expect(err.hint).toMatch(/starts with the Team ID/);
    setWeatherEnv();
    expect(rejectedHint(resolveWeatherAuth())).not.toMatch(/starts with the Team ID/);
  });
});
