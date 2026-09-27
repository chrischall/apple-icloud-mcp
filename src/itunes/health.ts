import { AppleToolError } from '../errors.js';
import { makeProbe, type HealthProbe } from '../health.js';
import { getDefaultItunesClient, type ItunesClient } from './client.js';

/**
 * iTunes Search needs no credential, so this service is always configured; the
 * probe is one lookup of a stable id (Jack Johnson, Apple's own documentation
 * example) through the module's throttle, bypassing the cache so it really
 * reaches Apple.
 *
 * The probe waits at most HEALTH_MAX_WAIT_MS for a throttle slot. A tool call
 * may queue for up to 30 s, but the healthcheck gives each probe 20 s in all:
 * queueing that long would be reported as a TIMEOUT ("did not finish") — a
 * false account of an idle, reachable Apple — while the abandoned probe still
 * spent a slot later. Refusing up front reports RATE_LIMITED with the wait.
 */
export const HEALTH_PROBE_ID = '909253';
export const HEALTH_MAX_WAIT_MS = 5_000;

export function makeItunesHealth(getClient: () => ItunesClient = getDefaultItunesClient): HealthProbe {
  return makeProbe({
    service: 'itunes',
    resolve: () => ({
      source: 'none',
      notes: [
        'No credential needed. Apple allows about 20 iTunes Search/Lookup requests a minute per IP address (shared by ' +
          'everyone on a hosted deployment); this server spaces its requests to stay under that and caches answers for an hour.',
      ],
    }),
    probe: `GET https://itunes.apple.com/lookup?id=${HEALTH_PROBE_ID}`,
    run: async () => {
      const res = await getClient().itunes('lookup', { id: HEALTH_PROBE_ID }, { fresh: true, maxWaitMs: HEALTH_MAX_WAIT_MS });
      if (res.data.results.length === 0) {
        throw new AppleToolError('UPSTREAM_ERROR', `itunes: the probe lookup of id ${HEALTH_PROBE_ID} returned no results.`, {
          hint: 'Apple answered but found nothing for a long-standing id; the service may be degraded. Retry later.',
        });
      }
    },
  });
}

export const itunesHealth: HealthProbe = makeItunesHealth();
