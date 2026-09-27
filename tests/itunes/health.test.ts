import { afterEach, describe, expect, it, vi } from 'vitest';
import { createItunesClient, resetDefaultItunesClient } from '../../src/itunes/client.js';
import { HEALTH_MAX_WAIT_MS, HEALTH_PROBE_ID, itunesHealth, makeItunesHealth } from '../../src/itunes/health.js';
import { ARTIST, envelope, itunesResponse } from './fixtures.js';

function stubFetch(response: Response | Error) {
  const fn = vi.fn(async (_url: unknown, _init?: unknown) => {
    if (response instanceof Error) throw response;
    return response.clone();
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  resetDefaultItunesClient();
});

describe('itunesHealth', () => {
  it('is always configured (no credential) and probes one fresh lookup', async () => {
    const fetch = stubFetch(itunesResponse(envelope([ARTIST])));
    const client = createItunesClient({ now: () => 0 });
    // A cached answer must not stand in for the probe.
    await client.itunes('lookup', { id: HEALTH_PROBE_ID });
    const health = await makeItunesHealth(() => client).check();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1]?.[0])).toBe(`https://itunes.apple.com/lookup?id=${HEALTH_PROBE_ID}`);
    expect(health).toMatchObject({
      service: 'itunes',
      configured: true,
      credential: { source: 'none' },
      ok: true,
      probe: `GET https://itunes.apple.com/lookup?id=${HEALTH_PROBE_ID}`,
    });
    expect(health.notes?.[0]).toContain('No credential needed');
  });

  it('an empty answer for the stable id is a failure', async () => {
    stubFetch(itunesResponse(envelope([])));
    const health = await makeItunesHealth(() => createItunesClient({ now: () => 0 })).check();
    expect(health).toMatchObject({ configured: true, ok: false, error: { code: 'UPSTREAM_ERROR' } });
    expect(health.error?.message).toContain(`probe lookup of id ${HEALTH_PROBE_ID} returned no results`);
    expect(health.hint).toContain('degraded');
  });

  it('does not queue past the healthcheck timeout: a saturated budget is reported as RATE_LIMITED at once', async () => {
    const fetch = stubFetch(itunesResponse(envelope([ARTIST])));
    const sleep = vi.fn(async () => undefined);
    const client = createItunesClient({ now: () => 0, sleep });
    for (let i = 0; i < 20; i++) await client.itunes('lookup', { id: String(i + 1) });
    // A tool call could still queue up to 30 s; the probe (20 s healthcheck budget) must not.
    const health = await makeItunesHealth(() => client).check();
    expect(health).toMatchObject({ configured: true, ok: false, error: { code: 'RATE_LIMITED' } });
    expect(health.error?.message).toContain('could start in 60 s');
    expect(health.hint).toContain('Retry in about 60 seconds');
    expect(sleep).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(20);
    expect(HEALTH_MAX_WAIT_MS).toBeLessThan(20_000);
  });

  it('a network failure is reported, not thrown', async () => {
    stubFetch(new TypeError('fetch failed'));
    const health = await makeItunesHealth(() => createItunesClient({ now: () => 0 })).check();
    expect(health).toMatchObject({ configured: true, ok: false, error: { code: 'NETWORK_ERROR' } });
  });

  it('the exported probe uses the module-wide client', async () => {
    stubFetch(itunesResponse(envelope([ARTIST])));
    const health = await itunesHealth.check();
    expect(itunesHealth.service).toBe('itunes');
    expect(health.ok).toBe(true);
  });
});
