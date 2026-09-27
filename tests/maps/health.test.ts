import { describe, expect, it, vi } from 'vitest';
import { TOKEN_REJECTED_HINT } from '../../src/maps/client.js';
import { createMapsHealth, mapsHealth } from '../../src/maps/health.js';
import { KEY, KEY_ID, NOW, TEAM_ID, fakeRequest, setKeyEnv } from './_helpers.js';

describe('mapsHealth', () => {
  it('reports "not configured" with the variables to set, without any network I/O', async () => {
    const health = await mapsHealth.check();
    expect(health).toMatchObject({ service: 'maps', configured: false });
    expect(health.missing).toEqual([
      'APPLE_TEAM_ID',
      'APPLE_KEY_ID (or APPLE_MAPS_KEY_ID)',
      'APPLE_PRIVATE_KEY (or APPLE_MAPS_PRIVATE_KEY / APPLE_PRIVATE_KEY_PATH)',
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('probes with one fresh token exchange and reports the key source', async () => {
    const request = fakeRequest({});
    const health = await createMapsHealth({ request, resolveKey: () => KEY, now: () => NOW }).check();
    expect(health).toMatchObject({
      service: 'maps',
      configured: true,
      ok: true,
      probe: 'GET /v1/token',
      credential: { source: 'test', detail: { teamId: TEAM_ID, keyId: KEY_ID } },
    });
    expect(health.notes?.[0]).toBe('Apple issued a Maps access token valid for 1800 s.');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected key with the Maps hint', async () => {
    const request = fakeRequest({ '/v1/token': () => ({ error: 401, body: '{"error":{"message":"Not Authorized","details":[]}}' }) });
    const health = await createMapsHealth({ request, resolveKey: () => KEY, now: () => NOW }).check();
    expect(health).toMatchObject({
      configured: true,
      ok: false,
      hint: TOKEN_REJECTED_HINT,
      error: { code: 'CREDENTIALS_REJECTED', status: 401, message: 'maps: GET /v1/token failed with HTTP 401 — Not Authorized' },
    });
  });

  it('defaults to the environment, httpRequest and the real clock', async () => {
    setKeyEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accessToken: 'health-token-123456', expiresInSeconds: 900 }), { status: 200 })),
    );
    const health = await mapsHealth.check();
    expect(health).toMatchObject({ configured: true, ok: true, credential: { source: 'APPLE_KEY_ID + APPLE_PRIVATE_KEY' } });
    expect(health.notes?.[0]).toBe('Apple issued a Maps access token valid for 900 s.');
  });
});
