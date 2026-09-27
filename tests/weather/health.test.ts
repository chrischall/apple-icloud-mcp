import { describe, expect, it } from 'vitest';
import { CredentialsRejectedError } from '../../src/errors.js';
import { makeWeatherHealth, weatherHealth } from '../../src/weather/health.js';
import { KEY_ID, SERVICE_ID, TEAM_ID, fakeClient, queueFetch, setWeatherEnv } from './_fixtures.js';

describe('weatherHealth', () => {
  it('reports the missing variables without any network I/O', async () => {
    const { fn } = queueFetch();
    const health = await weatherHealth.check();
    expect(health).toMatchObject({ service: 'weather', configured: false });
    expect(health.missing).toContain('APPLE_WEATHERKIT_SERVICE_ID');
    expect(health.missing).toContain('APPLE_TEAM_ID');
    expect(health.hint).toMatch(/Services ID/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('probes the availability endpoint over the default client', async () => {
    setWeatherEnv();
    const { calls } = queueFetch({ body: ['currentWeather', 'forecastDaily', 'weatherAlerts'] });
    const health = await weatherHealth.check();
    expect(health).toMatchObject({
      service: 'weather',
      configured: true,
      ok: true,
      probe: 'GET /api/v1/availability/37.3349/-122.0090?country=US',
      credential: {
        source: 'APPLE_KEY_ID + APPLE_PRIVATE_KEY + APPLE_WEATHERKIT_SERVICE_ID',
        detail: { teamId: TEAM_ID, keyId: KEY_ID, serviceId: SERVICE_ID },
      },
      notes: ['WeatherKit data sets at the probe location: currentWeather, forecastDaily, weatherAlerts.'],
    });
    expect(calls[0]!.url).toBe('https://weatherkit.apple.com/api/v1/availability/37.3349/-122.0090?country=US');
    expect(JSON.stringify(health)).not.toContain('PRIVATE KEY');
  });

  it('reports an empty availability list as "none"', async () => {
    setWeatherEnv();
    const client = fakeClient();
    client.getAvailability.mockResolvedValueOnce([]);
    const health = await makeWeatherHealth(() => client).check();
    expect(health.notes).toEqual(['WeatherKit data sets at the probe location: none.']);
  });

  it('reports a rejected credential with the WeatherKit hint', async () => {
    setWeatherEnv();
    // The shared default client may hold a cached token from an earlier test,
    // in which case it replays once with a fresh one — so queue two refusals.
    queueFetch({ status: 401, body: { reason: 'NOT_ENABLED' } }, { status: 401, body: { reason: 'NOT_ENABLED' } });
    const health = await makeWeatherHealth().check();
    expect(health).toMatchObject({ configured: true, ok: false, error: { code: 'CREDENTIALS_REJECTED', status: 401 } });
    expect(health.hint).toMatch(/WeatherKit enabled/);
  });

  it('reports a failing probe from an injected client', async () => {
    setWeatherEnv();
    const client = fakeClient();
    client.getAvailability.mockRejectedValueOnce(new CredentialsRejectedError('weather', 403, 'weather: refused', 'the hint'));
    const health = await makeWeatherHealth(() => client).check();
    expect(health).toMatchObject({ ok: false, error: { code: 'CREDENTIALS_REJECTED', status: 403 }, hint: 'the hint' });
  });
});
