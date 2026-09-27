import { describe, expect, it } from 'vitest';
import { makeProbe } from '../src/health.js';
import {
  ConfigError,
  CredentialsRejectedError,
  InvalidArgumentError,
  TransportError,
  UpstreamError,
  rememberSecret,
} from '../src/errors.js';

describe('makeProbe', () => {
  it('reports an unconfigured service with its missing variables and hint, without probing', async () => {
    let ran = false;
    const probe = makeProbe({
      service: 'mail',
      resolve: () => {
        throw new ConfigError('mail', 'no creds', ['ICLOUD_USERNAME'], 'set it');
      },
      probe: 'IMAP STATUS INBOX',
      run: async () => {
        ran = true;
      },
    });
    expect(probe.service).toBe('mail');
    expect(await probe.check()).toEqual({
      service: 'mail',
      configured: false,
      missing: ['ICLOUD_USERNAME'],
      hint: 'set it',
      error: { code: 'NOT_CONFIGURED', message: 'no creds' },
    });
    expect(ran).toBe(false);
  });

  it('reports a configuration that is SET but unusable as configured-and-failing, not as absent', async () => {
    process.env.APPLE_PRIVATE_KEY = 'an RSA key, say';
    process.env.APPLE_PRIVATE_KEY_PATH = '/nonexistent.p8';
    let ran = false;
    const probe = (missing: string[], hint?: string) =>
      makeProbe({
        service: 'maps',
        resolve: () => {
          throw new ConfigError('maps', 'The private key in APPLE_PRIVATE_KEY is unusable: it is a rsa key.', missing, hint);
        },
        probe: 'GET /v1/token',
        run: async () => {
          ran = true;
        },
      });
    expect(await probe(['APPLE_PRIVATE_KEY'], 'paste the .p8').check()).toEqual({
      service: 'maps',
      configured: true,
      ok: false,
      error: { code: 'NOT_CONFIGURED', message: 'The private key in APPLE_PRIVATE_KEY is unusable: it is a rsa key.' },
      hint: 'paste the .p8',
    });
    expect((await probe(['APPLE_PRIVATE_KEY', 'APPLE_PRIVATE_KEY_PATH'], '').check())).not.toHaveProperty('hint');
    expect(ran).toBe(false);
    // Any variable named that is NOT set (or a descriptive entry that is not a
    // bare name) means something is genuinely missing.
    expect((await probe(['APPLE_PRIVATE_KEY', 'APPLE_TEAM_ID']).check()).configured).toBe(false);
    expect((await probe(['APPLE_KEY_ID (or APPLE_MAPS_KEY_ID)']).check()).configured).toBe(false);
    expect((await probe([]).check()).configured).toBe(false);
  });

  it('omits an empty hint on an unconfigured service', async () => {
    const probe = makeProbe({
      service: 'mail',
      resolve: () => {
        throw new ConfigError('mail', 'no creds', [], '');
      },
      probe: 'x',
      run: async () => undefined,
    });
    const out = await probe.check();
    expect(out.configured).toBe(false);
    expect('hint' in out).toBe(false);
  });

  it('treats any other resolve failure as configured-but-failing', async () => {
    const generic = makeProbe({
      service: 'music',
      resolve: async () => {
        throw new Error('boom');
      },
      probe: 'GET /v1/me/storefront',
      run: async () => undefined,
    });
    expect(await generic.check()).toEqual({
      service: 'music',
      configured: true,
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'boom' },
    });
    const apple = makeProbe({
      service: 'music',
      resolve: () => {
        throw new InvalidArgumentError('token expired', 'mint a new one');
      },
      probe: 'x',
      run: async () => undefined,
    });
    expect(await apple.check()).toEqual({
      service: 'music',
      configured: true,
      ok: false,
      error: { code: 'INVALID_ARGUMENT', message: 'token expired' },
      hint: 'mint a new one',
    });
  });

  it('reports a working service with its credential source, detail, notes and latency', async () => {
    const probe = makeProbe({
      service: 'music',
      resolve: async () => ({ source: 'APPLE_KEY_ID + APPLE_PRIVATE_KEY', detail: { userToken: true }, notes: ['official'] }),
      probe: 'GET /v1/me/storefront',
      run: async () => ({ notes: ['storefront us'] }),
    });
    const out = await probe.check();
    expect(out).toMatchObject({
      service: 'music',
      configured: true,
      credential: { source: 'APPLE_KEY_ID + APPLE_PRIVATE_KEY', detail: { userToken: true } },
      ok: true,
      probe: 'GET /v1/me/storefront',
      notes: ['official', 'storefront us'],
    });
    expect(typeof out.latencyMs).toBe('number');
  });

  it('omits detail and notes when there are none', async () => {
    const probe = makeProbe({ service: 'itunes', resolve: () => ({ source: 'none' }), probe: 'GET /lookup', run: async () => undefined });
    const out = await probe.check();
    expect(out.credential).toEqual({ source: 'none' });
    expect('notes' in out).toBe(false);
    const empty = makeProbe({ service: 'itunes', resolve: () => ({ source: 'none', notes: [] }), probe: 'x', run: async () => ({}) });
    expect('notes' in (await empty.check())).toBe(false);
  });

  it('classifies a rejected credential with the probe-specific hint and the HTTP status', async () => {
    const withHint = makeProbe({
      service: 'calendar',
      resolve: () => ({ source: 'ICLOUD_USERNAME + ICLOUD_APP_PASSWORD' }),
      probe: 'PROPFIND /',
      run: async () => {
        throw new CredentialsRejectedError('calendar', 401, 'rejected', 'generic hint');
      },
      rejectedHint: 'generate a new app-specific password',
    });
    const out = await withHint.check();
    expect(out).toMatchObject({
      configured: true,
      credential: { source: 'ICLOUD_USERNAME + ICLOUD_APP_PASSWORD' },
      ok: false,
      probe: 'PROPFIND /',
      error: { code: 'CREDENTIALS_REJECTED', message: 'rejected', status: 401 },
      hint: 'generate a new app-specific password',
    });
    expect(typeof out.latencyMs).toBe('number');

    const fallback = makeProbe({
      service: 'calendar',
      resolve: () => ({ source: 's' }),
      probe: 'x',
      run: async () => {
        throw new CredentialsRejectedError('calendar', 403, 'rejected', 'generic hint');
      },
    });
    expect((await fallback.check()).hint).toBe('generic hint');

    const none = makeProbe({
      service: 'calendar',
      resolve: () => ({ source: 's' }),
      probe: 'x',
      run: async () => {
        throw new CredentialsRejectedError('calendar', 403, 'rejected');
      },
    });
    expect('hint' in (await none.check())).toBe(false);
  });

  it('carries other Apple errors with their own hint, and non-Errors as text, scrubbed', async () => {
    rememberSecret('probe-secret-value');
    const upstream = makeProbe({
      service: 'weather',
      resolve: () => ({ source: 's' }),
      probe: 'GET /api/v1/availability',
      run: async () => {
        throw new UpstreamError('weather', 500, 'down probe-secret-value');
      },
    });
    const out = await upstream.check();
    expect(out.error).toEqual({ code: 'UPSTREAM_ERROR', message: 'down [REDACTED]', status: 500 });
    expect('hint' in out).toBe(false);

    const timeout = makeProbe({
      service: 'weather',
      resolve: () => ({ source: 's' }),
      probe: 'x',
      run: async () => {
        throw new TransportError('weather', 'TIMEOUT', 'slow');
      },
    });
    expect((await timeout.check()).hint).toContain('APPLE_REQUEST_TIMEOUT_MS');

    const odd = makeProbe({
      service: 'weather',
      resolve: () => ({ source: 's' }),
      probe: 'x',
      run: async () => {
        throw { status: 'not-a-number', toString: () => 'weird' };
      },
    });
    expect((await odd.check()).error).toEqual({ code: 'INTERNAL_ERROR', message: 'weird' });
  });

  it('survives a probe that rejects with nothing at all (Promise.reject(), throw undefined / null)', async () => {
    for (const thrown of [undefined, null]) {
      const bare = makeProbe({
        service: 'maps',
        resolve: () => ({ source: 's' }),
        probe: 'GET /v1/token',
        run: () => Promise.reject(thrown),
      });
      expect(await bare.check()).toMatchObject({
        service: 'maps',
        configured: true,
        ok: false,
        probe: 'GET /v1/token',
        error: { code: 'INTERNAL_ERROR', message: String(thrown) },
      });
    }
  });
});
