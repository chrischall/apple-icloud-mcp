import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialsRejectedError, UpstreamError } from '../../src/errors.js';
import { createWeatherClient } from '../../src/weather/client.js';
import { FAR_ZONE_HOURS, apiInstant, dailyWindow, hourlyWindow, resolveZone, zoneDistanceHours } from '../../src/weather/tools.js';
import {
  ALERT_ID,
  NOW,
  alertDetail,
  alertSummary,
  call,
  captureTools,
  fakeClient,
  sampleWeather,
  setWeatherEnv,
  type FakeClient,
} from './_fixtures.js';

const GET = 'apple_weather_get';
const ALERT = 'apple_weather_get_alert';
const NYC = { latitude: 40.7128, longitude: -74.006 };

let client: FakeClient;
let tools: ReturnType<typeof captureTools>;

beforeEach(() => {
  process.env.DISPLAY_TZ = 'America/New_York';
  client = fakeClient();
  tools = captureTools({ client, now: () => NOW });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registration', () => {
  it('registers both read tools with an EMPTY environment (no config read at registration)', () => {
    delete process.env.DISPLAY_TZ;
    const t = captureTools();
    expect([...t.keys()]).toEqual([GET, ALERT]);
    for (const { cfg } of t.values()) {
      expect(cfg.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
      expect(cfg.description.length).toBeLessThanOrEqual(600);
      expect(cfg.title).toBeTruthy();
    }
    expect(t.get(GET)!.cfg.description).toMatch(/apple_maps_geocode/);
  });

  it('stays registered in read-only mode and disappears when the service is disabled', () => {
    process.env.APPLE_WRITE_MODE = 'none';
    expect(captureTools().size).toBe(2);
    process.env.APPLE_SERVICES = 'music,maps';
    expect(captureTools().size).toBe(0);
  });
});

describe('apple_weather_get schema', () => {
  const schema = () => tools.get(GET)!.cfg.inputSchema;

  it('accepts a full valid call', () => {
    expect(
      schema().safeParse({
        ...NYC,
        dataSets: ['current', 'nextHour'],
        hours: 240,
        days: 10,
        timeZone: 'Europe/London',
        countryCode: 'gb',
        units: 'imperial',
        lang: 'en-GB',
        view: 'full',
      }).success,
    ).toBe(true);
  });

  it.each([
    [{ ...NYC, bogus: 1 }, 'an unknown argument'],
    [{ latitude: 91, longitude: 0 }, 'latitude > 90'],
    [{ latitude: 0, longitude: -181 }, 'longitude < -180'],
    [{ longitude: 0 }, 'a missing latitude'],
    [{ ...NYC, hours: 0 }, 'hours 0'],
    [{ ...NYC, hours: 241 }, 'hours 241'],
    [{ ...NYC, hours: 1.5 }, 'fractional hours'],
    [{ ...NYC, days: 11 }, 'days 11'],
    [{ ...NYC, dataSets: [] }, 'empty dataSets'],
    [{ ...NYC, dataSets: ['radar'] }, 'an unknown data set'],
    [{ ...NYC, countryCode: 'USA' }, 'a three-letter country'],
    [{ ...NYC, lang: 'en/../x' }, 'a path-unsafe lang'],
    [{ ...NYC, units: 'kelvin' }, 'unknown units'],
    [{ ...NYC, view: 'raw' }, 'the raw view'],
    [{ ...NYC, timeZone: '' }, 'an empty timeZone'],
  ] as Array<[Record<string, unknown>, string]>)('rejects %j (%s)', (args, _why) => {
    expect(schema().safeParse(args).success).toBe(false);
  });
});

describe('apple_weather_get', () => {
  it('fetches the default sets for the display zone and says alerts were skipped without countryCode', async () => {
    const { json, text, isError } = await call(tools, GET, NYC);
    expect(isError).toBe(false);
    expect(client.getWeather).toHaveBeenCalledWith({
      language: 'en',
      latitude: 40.7128,
      longitude: -74.006,
      timezone: 'America/New_York',
      dataSets: ['currentWeather', 'forecastHourly', 'forecastDaily'],
      hourlyStart: '2026-09-26T18:00:00Z',
      hourlyEnd: '2026-09-27T18:00:00Z',
      dailyStart: '2026-09-26T04:00:00Z',
      dailyEnd: '2026-10-03T04:00:00Z',
    });
    expect(json.dataSets).toEqual(['current', 'hourly', 'daily']);
    expect(json.view).toBe('compact');
    expect(json.timeZone).toBe('America/New_York');
    expect(json.location).toEqual({ latitude: 40.7128, longitude: -74.006 });
    expect(json.notes).toEqual([expect.stringMatching(/alerts were NOT checked/)]);
    expect(json.units.temperature).toBe('°C');
    expect(json.attribution).toMatchObject({ serviceName: 'Apple Weather', legalUrl: 'https://developer.apple.com/weatherkit/data-source-attribution/' });
    expect(json.attribution.notice).toMatch(/Converted to metric/);
    expect(json.current.temperature).toBe(19);
    expect(json.current.asOf).toBe('2026-09-26T14:35:00-04:00');
    expect(json.hourly).toMatchObject({ requested: 24, returned: 24 });
    expect(json.daily).toMatchObject({ requested: 7, returned: 7 });
    expect(json.daily.days[6].date).toBe('2026-10-02');
    expect(json).not.toHaveProperty('alerts');
    expect(json).not.toHaveProperty('nextHour');
    // Facts (notes, attribution, units) before the data; the long lists last.
    const order = ['"notes":', '"attribution":', '"current":', '"daily":', '"hourly":'].map((k) => text.indexOf(k));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(Object.keys(json).at(-1)).toBe('hourly');
  });

  it('includes alerts (country upper-cased), converts to imperial and localises the zone', async () => {
    const { json } = await call(tools, GET, {
      ...NYC,
      dataSets: ['alerts', 'current', 'current'],
      countryCode: 'us',
      units: 'imperial',
      timeZone: 'america/chicago',
      lang: 'es',
    });
    expect(client.getWeather).toHaveBeenCalledWith({
      language: 'es',
      latitude: 40.7128,
      longitude: -74.006,
      timezone: 'America/Chicago',
      dataSets: ['currentWeather', 'weatherAlerts'],
      countryCode: 'US',
    });
    expect(json.location.countryCode).toBe('US');
    expect(json).not.toHaveProperty('notes');
    expect(json.units.temperature).toBe('°F');
    expect(json.current.temperature).toBe(66.2);
    expect(json.current.asOf).toBe('2026-09-26T13:35:00-05:00');
    expect(json.alerts.returned).toBe(1);
    expect(json.alerts.alerts[0]).toMatchObject({
      id: ALERT_ID,
      description: 'Coastal Flood Advisory',
      source: 'National Weather Service',
      detailsUrl: expect.stringContaining(ALERT_ID),
      effective: '2026-09-26T13:00:00-05:00',
    });
    const keys = Object.keys(json);
    expect(keys.indexOf('alerts')).toBeGreaterThan(keys.indexOf('current'));
  });

  it('computes the daily window at midnight in the requested zone', async () => {
    await call(tools, GET, { ...NYC, dataSets: ['daily'], days: 1, timeZone: 'Asia/Tokyo' });
    // 18:35Z on the 26th is 03:35 on the 27th in Tokyo.
    expect(client.getWeather).toHaveBeenCalledWith(
      expect.objectContaining({ dataSets: ['forecastDaily'], dailyStart: '2026-09-26T15:00:00Z', dailyEnd: '2026-09-27T15:00:00Z' }),
    );
    const q = client.getWeather.mock.calls[0]![0] as Record<string, unknown>;
    expect(q).not.toHaveProperty('hourlyStart');
  });

  it('takes the unit system from APPLE_UNITS, and reports an unusable value', async () => {
    process.env.APPLE_UNITS = 'imperial';
    expect((await call(tools, GET, NYC)).json.units.system).toBe('imperial');
    process.env.APPLE_UNITS = 'furlongs';
    const { json } = await call(tools, GET, NYC);
    expect(json.units.system).toBe('metric');
    expect(json.notes[0]).toMatch(/APPLE_UNITS "furlongs"/);
  });

  it.each([
    [{ ...NYC, timeZone: 'Mars/Olympus_Mons' }, /not an IANA time zone/],
    [{ ...NYC, timeZone: '+05:30' }, /not an IANA time zone/],
    [{ ...NYC, dataSets: ['current'], hours: 12 }, /"hourly" is not in dataSets/],
    [{ ...NYC, dataSets: ['current'], days: 3 }, /"daily" is not in dataSets/],
    [{ ...NYC, dataSets: ['alerts'] }, /need countryCode/],
  ])('refuses %j before calling Apple', async (args, message) => {
    const { isError, json } = await call(tools, GET, args);
    expect(isError).toBe(true);
    expect(json.error.code).toBe('INVALID_ARGUMENT');
    expect(json.error.message).toMatch(message);
    expect(client.getWeather).not.toHaveBeenCalled();
  });

  it('asks only for alerts when that is all that was requested', async () => {
    client.getWeather.mockResolvedValueOnce({ weatherAlerts: { alerts: [alertSummary()] } });
    const { json } = await call(tools, GET, { ...NYC, dataSets: ['alerts'], countryCode: 'US' });
    expect(client.getWeather).toHaveBeenCalledWith(expect.objectContaining({ dataSets: ['weatherAlerts'], countryCode: 'US' }));
    expect(json.alerts.returned).toBe(1);
  });

  it('says so when Apple reports no active alerts', async () => {
    client.getWeather.mockResolvedValueOnce(sampleWeather({ alerts: [] }));
    const { json } = await call(tools, GET, { ...NYC, countryCode: 'US' });
    expect(json.alerts).toEqual({ returned: 0, detailsUrl: expect.any(String), alerts: [] });
    expect(json.notes).toEqual(['No active severe-weather alerts reported by Apple for this location (country US).']);
    expect(client.getAvailability).not.toHaveBeenCalled();
  });

  it('never turns a missing alert set into an empty alerts list, even where Apple lists alert coverage', async () => {
    // Whether WeatherKit omits the set when no alert is active is unverified,
    // so a missing set is at most "probably none" — never a structured "none".
    client.getWeather.mockResolvedValueOnce(sampleWeather({ alerts: null }));
    const { json } = await call(tools, GET, { ...NYC, countryCode: 'US' });
    expect(client.getAvailability).toHaveBeenCalledWith(40.7128, -74.006, 'US');
    expect(json).not.toHaveProperty('alerts');
    expect(json.notes).toEqual([expect.stringMatching(/^Apple sent no severe-weather alert data .*lists alert coverage.*PROBABLY no active alerts.*NOT confirmation/)]);
    expect(json.notes.join(' ')).not.toMatch(/No active/);
  });

  it('never reports "no alerts" where Apple has no alert coverage', async () => {
    client.getWeather.mockResolvedValueOnce(sampleWeather({ alerts: null }));
    client.getAvailability.mockResolvedValueOnce(['currentWeather']);
    const { json } = await call(tools, GET, { ...NYC, countryCode: 'BR' });
    expect(json).not.toHaveProperty('alerts');
    expect(json.notes).toEqual([expect.stringMatching(/does not provide severe-weather alerts .*country BR.*NOT confirmation/)]);
  });

  it('reports alert status as UNKNOWN when the coverage check fails', async () => {
    client.getWeather.mockResolvedValueOnce(sampleWeather({ alerts: null }));
    client.getAvailability.mockRejectedValueOnce(new CredentialsRejectedError('weather', 401, 'weather: rejected'));
    const { json, isError } = await call(tools, GET, { ...NYC, countryCode: 'US', view: 'full' });
    expect(isError).toBe(false);
    expect(json.notes).toEqual([expect.stringMatching(/coverage check failed \(weather: rejected\).*UNKNOWN/)]);
  });

  it('names every requested set Apple did not send, and data flagged temporarily unavailable', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = sampleWeather();
    delete w.currentWeather;
    delete w.forecastNextHour;
    (w.forecastHourly as Record<string, unknown>).metadata = { temporarilyUnavailable: true };
    (w.forecastDaily as Record<string, unknown>).metadata = 'n/a';
    client.getWeather.mockResolvedValueOnce(w);
    const { json } = await call(tools, GET, { ...NYC, dataSets: ['current', 'hourly', 'daily', 'nextHour'] });
    expect(json.notes).toEqual([
      'Apple returned no current conditions for this location.',
      'Apple reports its hourly forecast as temporarily unavailable from the data provider; it may be incomplete.',
      'Apple returned no next-hour precipitation forecast for this location (Apple offers next-hour precipitation only in some regions).',
    ]);
    expect(json).not.toHaveProperty('current');
    expect(json.hourly.returned).toBe(24);
    // The malformed daily metadata was reported as drift on stderr, not fatal.
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unexpected GET \/api\/v1\/weather shape/));
  });

  it('says when Apple returned fewer hours or days than asked, and slices when it returned more', async () => {
    client.getWeather.mockResolvedValueOnce(sampleWeather({ hours: 200, days: 8 }));
    const short = await call(tools, GET, { ...NYC, hours: 240, days: 10 });
    expect(short.json.hourly).toMatchObject({ requested: 240, returned: 200 });
    expect(short.json.notes).toContain('Apple returned 200 of the 240 hours requested; its hourly forecast does not reach further.');
    expect(short.json.notes).toContain('Apple returned 8 of the 10 days requested; its daily forecast does not reach further.');
    client.getWeather.mockResolvedValueOnce(sampleWeather({ hours: 30 }));
    const long = await call(tools, GET, { ...NYC, hours: 6 });
    expect(long.json.hourly).toMatchObject({ requested: 6, returned: 6 });
    expect(long.json.hourly.hours).toHaveLength(6);
  });

  it('retries once with an 8-day hourly range when Apple refuses a longer one', async () => {
    client.getWeather
      .mockRejectedValueOnce(new UpstreamError('weather', 400, 'weather: GET /api/v1/weather failed with HTTP 400', { code: 'INVALID_ARGUMENT' }))
      .mockResolvedValueOnce(sampleWeather({ hours: 192 }));
    const { json, isError } = await call(tools, GET, { ...NYC, hours: 240 });
    expect(isError).toBe(false);
    expect(client.getWeather).toHaveBeenCalledTimes(2);
    expect(client.getWeather.mock.calls[0]![0]).toMatchObject({ hourlyEnd: '2026-10-06T18:00:00Z' });
    expect(client.getWeather.mock.calls[1]![0]).toMatchObject({ hourlyStart: '2026-09-26T18:00:00Z', hourlyEnd: '2026-10-04T18:00:00Z', dailyEnd: '2026-10-03T04:00:00Z' });
    expect(json.hourly).toMatchObject({ requested: 240, returned: 192 });
    expect(json.notes).toContain('Apple refused an hourly range of 240 hours (HTTP 400), so it was requested again with 192 hours.');
    // The shortfall is OUR retry, not the end of Apple's forecast — say which.
    expect(json.notes).toContain('Apple returned 192 of the 240 hours requested, because the retry asked for only 192.');
    expect(json.notes.join(' ')).not.toMatch(/does not reach further/);
  });

  it.each([
    ['a 400 on a short hourly range', { ...NYC, hours: 192 }, new UpstreamError('weather', 400, 'bad', { code: 'INVALID_ARGUMENT' })],
    ['a 400 without hourly', { ...NYC, dataSets: ['current'] }, new UpstreamError('weather', 400, 'bad', { code: 'INVALID_ARGUMENT' })],
    ['a 500 on a long range', { ...NYC, hours: 240 }, new UpstreamError('weather', 500, 'boom')],
    ['a non-upstream failure', { ...NYC, hours: 240 }, new Error('socket')],
  ])('does not retry %s', async (_label, args, error) => {
    client.getWeather.mockRejectedValueOnce(error);
    const { isError } = await call(tools, GET, args);
    expect(isError).toBe(true);
    expect(client.getWeather).toHaveBeenCalledTimes(1);
  });

  it('does not call an empty alert list "none" when Apple flags its alert data as unavailable', async () => {
    const w = sampleWeather({ alerts: [] });
    (w.weatherAlerts as Record<string, unknown>).metadata = { temporarilyUnavailable: true };
    client.getWeather.mockResolvedValueOnce(w);
    const { json } = await call(tools, GET, { ...NYC, countryCode: 'US' });
    expect(json).not.toHaveProperty('alerts');
    expect(json.notes).toEqual([
      'Apple reports its severe-weather alert data as temporarily unavailable from the data provider; it may be incomplete.',
      expect.stringMatching(/temporarily unavailable, so whether any alert is in effect here is UNKNOWN/),
    ]);
    expect(json.notes.join(' ')).not.toMatch(/No active/);
    expect(client.getAvailability).not.toHaveBeenCalled();
  });

  it('keeps alerts Apple did list even when it flags the data as unavailable', async () => {
    const w = sampleWeather();
    (w.weatherAlerts as Record<string, unknown>).metadata = { temporarilyUnavailable: true };
    client.getWeather.mockResolvedValueOnce(w);
    const { json } = await call(tools, GET, { ...NYC, countryCode: 'US', dataSets: ['alerts'] });
    expect(json.alerts.returned).toBe(1);
    expect(json.notes).toEqual([expect.stringMatching(/alert data as temporarily unavailable/)]);
  });

  it('warns when the DEFAULTED zone is a continent away from the location, and only then', async () => {
    const tokyo = { latitude: 35.6812, longitude: 139.7671 };
    const far = await call(tools, GET, { ...tokyo, dataSets: ['daily'] });
    expect(far.json.timeZone).toBe('America/New_York');
    expect(far.json.notes).toEqual([
      expect.stringMatching(/^No timeZone was given, so days roll over at midnight in America\/New_York .*about 11 h from local time at longitude 139\.7671/),
    ]);
    // A zone the caller chose is taken as meant.
    const chosen = await call(tools, GET, { ...tokyo, dataSets: ['daily'], timeZone: 'America/New_York' });
    expect(chosen.json).not.toHaveProperty('notes');
    // A neighbouring zone (Chicago under New York time) is close enough to stay quiet.
    const chicago = await call(tools, GET, { latitude: 41.88, longitude: -87.63, dataSets: ['daily'] });
    expect(chicago.json).not.toHaveProperty('notes');
  });

  it('never sends a fixed-offset DISPLAY_TZ to Apple as the rollup zone', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.DISPLAY_TZ = '+05:30';
    const { isError, json } = await call(tools, GET, NYC);
    expect(isError).toBe(false);
    const sent = (client.getWeather.mock.calls[0]![0] as { timezone: string }).timezone;
    expect(sent).not.toMatch(/^[+-]/);
    expect(json.timeZone).toBe(sent);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/DISPLAY_TZ "\+05:30" is not a known IANA zone/));
  });

  it('never lets the bearer token reach an error result, even when Apple echoes it back', async () => {
    setWeatherEnv();
    let sent = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        sent = (init!.headers as Record<string, string>).Authorization!.replace(/^Bearer /, '');
        // Glued to other characters so only the by-value scrub (not the JWT shape match) can catch it.
        return new Response(JSON.stringify({ reason: `rejected x${sent}x` }), { status: 401, headers: { 'content-type': 'application/json' } });
      }),
    );
    const t = captureTools({ client: createWeatherClient({ now: () => NOW }), now: () => NOW });
    const { isError, text, json } = await call(t, GET, NYC);
    expect(isError).toBe(true);
    expect(json.error.code).toBe('CREDENTIALS_REJECTED');
    expect(sent.length).toBeGreaterThan(100);
    expect(text).not.toContain(sent);
    expect(json.error.message).toContain('rejected x[REDACTED]x');
  });

  it('projects the next-hour forecast when asked', async () => {
    const { json } = await call(tools, GET, { ...NYC, dataSets: ['nextHour'] });
    expect(json.nextHour.periods[1]).toMatchObject({ precipitationType: 'rain', precipitationChance: 80 });
  });

  it('returns Apple’s payload verbatim for view "full"', async () => {
    const raw = sampleWeather();
    client.getWeather.mockResolvedValueOnce(raw);
    const { json } = await call(tools, GET, { ...NYC, view: 'full', units: 'imperial', countryCode: 'US' });
    expect(json.view).toBe('full');
    expect(json.weather).toEqual(raw);
    expect(json.units.system).toMatch(/Apple native/);
    expect(json.attribution).not.toHaveProperty('notice');
    expect(json.notes).toEqual([expect.stringMatching(/units "imperial" applies to view "compact"/)]);
    expect(Object.keys(json).at(-1)).toBe('weather');
  });

  it('carries no notes key on a clean full answer', async () => {
    const { json } = await call(tools, GET, { ...NYC, view: 'full', countryCode: 'US' });
    expect(json).not.toHaveProperty('notes');
    expect(Object.keys(json)).toEqual(['location', 'timeZone', 'dataSets', 'view', 'units', 'attribution', 'weather']);
  });

  it('falls back to the raw payload (and says so) when Apple’s shape defeats the projection', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const raw = sampleWeather();
    (raw.forecastHourly as Record<string, unknown>).hours = 'not a list';
    client.getWeather.mockResolvedValueOnce(raw);
    const { json, isError } = await call(tools, GET, NYC);
    expect(isError).toBe(false);
    expect(json.view).toBe('full');
    expect(json.weather).toEqual(raw);
    expect(json.notes).toContain('Could not summarise Apple\'s answer (its shape has changed), so it is returned unconverted under "weather" (metric, UTC times).');
    expect(warn).toHaveBeenCalled();
  });

  it('turns an unconfigured server into a NOT_CONFIGURED error, not an empty answer', async () => {
    const t = captureTools();
    const { isError, json } = await call(t, GET, NYC);
    expect(isError).toBe(true);
    expect(json.error.code).toBe('NOT_CONFIGURED');
    expect(json.error.service).toBe('weather');
    expect(json.error.missing).toContain('APPLE_WEATHERKIT_SERVICE_ID');
  });

  it('surfaces an upstream failure as an error result', async () => {
    client.getWeather.mockRejectedValueOnce(new CredentialsRejectedError('weather', 401, 'weather: GET /api/v1/weather failed with HTTP 401', 'fix the key'));
    const { isError, json } = await call(tools, GET, NYC);
    expect(isError).toBe(true);
    expect(json.error).toMatchObject({ code: 'CREDENTIALS_REJECTED', status: 401, hint: 'fix the key' });
  });

  it('works end to end over the default client and a stubbed fetch, scrubbing nothing it should keep', async () => {
    setWeatherEnv();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(sampleWeather()), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const t = captureTools();
    const { json, isError } = await call(t, GET, { ...NYC, dataSets: ['current'] });
    expect(isError).toBe(false);
    expect(json.current.condition).toBe('Mostly cloudy');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/^https:\/\/weatherkit\.apple\.com\/api\/v1\/weather\/en\/40\.7128\/-74\.0060\?dataSets=currentWeather&timezone=America%2FNew_York$/);
  });
});

describe('apple_weather_get_alert', () => {
  const schema = () => tools.get(ALERT)!.cfg.inputSchema;

  it('validates the id before it can reach a URL path', () => {
    expect(schema().safeParse({ alertId: ALERT_ID }).success).toBe(true);
    expect(schema().safeParse({ alertId: ALERT_ID, lang: 'fr', timeZone: 'Europe/Paris', view: 'full' }).success).toBe(true);
    expect(schema().safeParse({ alertId: '../weather/en/1/2' }).success).toBe(false);
    expect(schema().safeParse({ alertId: 'a b' }).success).toBe(false);
    expect(schema().safeParse({ alertId: '' }).success).toBe(false);
    expect(schema().safeParse({ alertId: ALERT_ID, extra: true }).success).toBe(false);
  });

  it('returns the alert text verbatim with its summary, without the area geometry', async () => {
    const { json, isError } = await call(tools, ALERT, { alertId: ALERT_ID });
    expect(isError).toBe(false);
    expect(client.getAlert).toHaveBeenCalledWith('en', ALERT_ID);
    expect(json.alertId).toBe(ALERT_ID);
    expect(json.view).toBe('compact');
    expect(json.attribution.serviceName).toBe('Apple Weather');
    expect(json.alert.messages).toEqual(alertDetail().messages);
    expect(json.alert.source).toBe('National Weather Service');
    expect(json.alert.effective).toBe('2026-09-26T14:00:00-04:00');
    expect(json.alert).not.toHaveProperty('area');
    expect(json).not.toHaveProperty('notes');
  });

  it('uses the requested language and zone', async () => {
    const { json } = await call(tools, ALERT, { alertId: ALERT_ID, lang: 'fr-CA', timeZone: 'America/Los_Angeles' });
    expect(client.getAlert).toHaveBeenCalledWith('fr-CA', ALERT_ID);
    expect(json.language).toBe('fr-CA');
    expect(json.alert.effective).toBe('2026-09-26T11:00:00-07:00');
  });

  it('returns Apple’s alert verbatim for view "full"', async () => {
    const { json } = await call(tools, ALERT, { alertId: ALERT_ID, view: 'full' });
    expect(json.view).toBe('full');
    expect(json.alert).toEqual(alertDetail());
  });

  it('says when Apple sent no message text', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { messages: _m, ...noMessages } = alertDetail();
    client.getAlert.mockResolvedValueOnce(noMessages);
    const absent = await call(tools, ALERT, { alertId: ALERT_ID });
    expect(absent.json.notes).toEqual([expect.stringMatching(/no message text/)]);
    expect(absent.json.alert).not.toHaveProperty('messages');
    client.getAlert.mockResolvedValueOnce({ ...noMessages, messages: [] });
    const empty = await call(tools, ALERT, { alertId: ALERT_ID, view: 'full' });
    expect(empty.json.notes).toEqual([expect.stringMatching(/no message text/)]);
    expect(warn).toHaveBeenCalled();
  });

  it('falls back to the raw alert when its messages are malformed', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    client.getAlert.mockResolvedValueOnce({ ...alertDetail(), messages: 'TEXT' });
    const { json } = await call(tools, ALERT, { alertId: ALERT_ID });
    expect(json.view).toBe('full');
    expect(json.alert.messages).toBe('TEXT');
    expect(json.notes).toEqual(['Could not summarise Apple\'s answer (its shape has changed), so it is returned verbatim under "alert".']);
    expect(warn).toHaveBeenCalled();
  });

  it('says when the alert detail lacks the agency or details link Apple requires with it', async () => {
    // The documented shape: {area, messages} and nothing else.
    client.getAlert.mockResolvedValueOnce({ area: { type: 'FeatureCollection' }, messages: [{ language: 'en', text: 'TEXT' }] });
    const { json } = await call(tools, ALERT, { alertId: ALERT_ID });
    expect(json.alert).toEqual({ messages: [{ language: 'en', text: 'TEXT' }] });
    expect(json.notes).toEqual([expect.stringMatching(/did not include source or detailsUrl\. .*apple_weather_get/)]);
    client.getAlert.mockResolvedValueOnce({ ...alertDetail(), detailsUrl: '' });
    const partial = await call(tools, ALERT, { alertId: ALERT_ID });
    expect(partial.json.notes).toEqual([expect.stringMatching(/did not include detailsUrl\./)]);
  });

  it('refuses a bad timeZone', async () => {
    const { isError, json } = await call(tools, ALERT, { alertId: ALERT_ID, timeZone: 'Nowhere/Land' });
    expect(isError).toBe(true);
    expect(json.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('window helpers', () => {
  it('formats API instants without milliseconds', () => {
    expect(apiInstant(Date.parse('2026-09-26T18:00:00.123Z'))).toBe('2026-09-26T18:00:00Z');
  });

  it('starts the hourly window at the current UTC hour', () => {
    expect(hourlyWindow(NOW, 3)).toEqual({ hourlyStart: '2026-09-26T18:00:00Z', hourlyEnd: '2026-09-26T21:00:00Z' });
  });

  it('keeps day boundaries at local midnight across a DST change', () => {
    // New York falls back on 1 Nov 2026: that day is 25 h long.
    expect(dailyWindow(Date.parse('2026-10-31T16:00:00Z'), 2, 'America/New_York')).toEqual({
      dailyStart: '2026-10-31T04:00:00Z',
      dailyEnd: '2026-11-02T05:00:00Z',
    });
  });

  it('measures how far a zone sits from solar time, around the 24-hour circle', () => {
    const winter = Date.parse('2026-01-15T12:00:00Z');
    expect(zoneDistanceHours('UTC', 0, winter)).toBe(0);
    expect(zoneDistanceHours('America/New_York', -74.006, winter)).toBeCloseTo(0.07, 2); // EST -5 vs solar -4.93
    expect(zoneDistanceHours('Pacific/Kiritimati', -157.4, winter)).toBeCloseTo(0.49, 2); // +14 is -10 on the circle
    expect(zoneDistanceHours('America/New_York', 139.7671, winter)).toBeCloseTo(9.68, 2);
    expect(zoneDistanceHours('Asia/Shanghai', 75.99, winter)).toBeLessThan(FAR_ZONE_HOURS); // Kashgar on Beijing time
  });

  it('resolves the zone: default display zone, canonical spelling, and refusals', () => {
    expect(resolveZone(undefined)).toBe('America/New_York');
    process.env.DISPLAY_TZ = 'europe/berlin';
    expect(resolveZone(undefined)).toBe('Europe/Berlin');
    expect(resolveZone('europe/london')).toBe('Europe/London');
    expect(resolveZone('US/Eastern')).toBe('America/New_York');
    expect(() => resolveZone('-04:00')).toThrow(/not an IANA time zone/);
    expect(() => resolveZone('+0530')).toThrow(/not an IANA time zone/);
    // U+2212 MINUS SIGN: Intl accepts it and resolves it to "-04:00".
    expect(() => resolveZone('\u221204:00')).toThrow(/not an IANA time zone/);
    expect(() => resolveZone('Mars/Olympus_Mons')).toThrow(/not an IANA time zone/);
  });
});
