import { makeProbe, type HealthProbe } from '../health.js';
import { resolveWeatherAuth } from './auth.js';
import { defaultWeatherClient, formatCoordinate, type WeatherClient } from './client.js';

/** Apple Park — a location every WeatherKit data set covers. */
export const PROBE_LATITUDE = 37.3349;
export const PROBE_LONGITUDE = -122.009;
export const PROBE_COUNTRY = 'US';

/**
 * WeatherKit health: configuration is resolved without network I/O (key +
 * Services ID), then ONE cheap authenticated read — the availability list for
 * a fixed location — proves Apple accepts the token.
 */
export function makeWeatherHealth(getClient: () => WeatherClient = defaultWeatherClient): HealthProbe {
  return makeProbe({
    service: 'weather',
    resolve: () => {
      const auth = resolveWeatherAuth();
      return { source: auth.source, detail: { teamId: auth.key.teamId, keyId: auth.key.keyId, serviceId: auth.serviceId } };
    },
    probe: `GET /api/v1/availability/${formatCoordinate(PROBE_LATITUDE)}/${formatCoordinate(PROBE_LONGITUDE)}?country=${PROBE_COUNTRY}`,
    run: async () => {
      const sets = await getClient().getAvailability(PROBE_LATITUDE, PROBE_LONGITUDE, PROBE_COUNTRY);
      return { notes: [`WeatherKit data sets at the probe location: ${sets.length > 0 ? sets.join(', ') : 'none'}.`] };
    },
  });
}

export const weatherHealth: HealthProbe = makeWeatherHealth();
