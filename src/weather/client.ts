import { CredentialsRejectedError, UpstreamError } from '../errors.js';
import { describeErrorBody, httpRequest, type QueryValue } from '../http.js';
import { createWeatherTokenCache, resolveWeatherAuth, SERVICE_ID_VAR, type WeatherAuth, type WeatherTokenCache } from './auth.js';

/**
 * A thin client for the WeatherKit REST API (`https://weatherkit.apple.com`).
 *
 * Every call resolves the credential from the environment first (so an
 * unconfigured server still lists its tools and fails only when used), then
 * goes out through `httpRequest` — the allowlist, timeouts, retries and
 * scrubbing live there. What this layer adds is WeatherKit's own error
 * vocabulary (`{"reason":"NOT_ENABLED"}` on a token Apple will not honour) and
 * one replay of a rejected CACHED token with a freshly minted one.
 */

export const WEATHERKIT_BASE = 'https://weatherkit.apple.com';

export interface WeatherQuery {
  /** BCP 47 language tag (path segment). */
  language: string;
  latitude: number;
  longitude: number;
  /** IANA zone Apple rolls daily forecasts up in (required by Apple). */
  timezone: string;
  /** Apple data-set names (`currentWeather`, `forecastHourly`, …). */
  dataSets: readonly string[];
  countryCode?: string;
  hourlyStart?: string;
  hourlyEnd?: string;
  dailyStart?: string;
  dailyEnd?: string;
}

export interface WeatherClient {
  /** `GET /api/v1/weather/{language}/{lat}/{lng}` — the raw `Weather` object. */
  getWeather(query: WeatherQuery): Promise<Record<string, unknown>>;
  /** `GET /api/v1/weatherAlert/{language}/{id}` — the raw `WeatherAlert` object. */
  getAlert(language: string, id: string): Promise<Record<string, unknown>>;
  /** `GET /api/v1/availability/{lat}/{lng}?country=` — the data sets Apple offers there. */
  getAvailability(latitude: number, longitude: number, country: string): Promise<string[]>;
}

export interface WeatherClientOptions {
  /** The HTTP seam (default `httpRequest`). */
  request?: typeof httpRequest;
  /** Clock for token minting (default `Date.now`). */
  now?: () => number;
}

/**
 * A coordinate as a path segment: 4 decimals (~11 m — far finer than any
 * forecast grid), never exponent notation (`String(1e-7)` is `1e-7`), never
 * `-0.0000`.
 */
export function formatCoordinate(value: number): string {
  return (Math.round(value * 1e4) / 1e4 + 0).toFixed(4);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** WeatherKit's error body is `{"reason":"NOT_ENABLED"}`; return that reason when it looks like a code. */
function upstreamReason(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    const reason = isPlainObject(parsed) ? parsed.reason : undefined;
    return typeof reason === 'string' && /^[A-Z][A-Z0-9_ ]*$/.test(reason) ? reason : undefined;
  } catch {
    return undefined;
  }
}

/** Why Apple refused the token, in terms of the variables the operator controls. */
export function rejectedHint(auth: WeatherAuth): string {
  const prefixed = auth.serviceId.startsWith(`${auth.key.teamId}.`)
    ? ` ${SERVICE_ID_VAR} starts with the Team ID — set it to the Services ID alone (the Team ID prefix is added for you).`
    : '';
  return (
    'WeatherKit refused the developer token. Check that the key (APPLE_KEY_ID / APPLE_WEATHERKIT_KEY_ID) has ' +
    'WeatherKit enabled, that APPLE_TEAM_ID is the team that owns it, and that APPLE_WEATHERKIT_SERVICE_ID is a ' +
    'Services ID registered in that team (e.g. com.example.weather). A key that was only just enabled for ' +
    `WeatherKit can take a while to start working.${prefixed}`
  );
}

const QUOTA_HINT =
  'Apple is throttling WeatherKit requests (the free tier is 500,000 calls a month per developer membership). ' +
  'Wait before retrying.';

const BAD_REQUEST_HINT =
  'Apple rejected the request parameters. Check latitude/longitude, lang and timeZone (an IANA name). Apple has ' +
  'been seen to refuse hourly ranges longer than about 8–9 days — try fewer hours.';

/**
 * Map WeatherKit's failure statuses. 401 and 403 are both token refusals
 * (`MISSING JWT`, `NOT_ENABLED`); anything unlisted falls through to
 * `httpRequest`'s defaults.
 */
export function classifyWeatherError(
  status: number,
  bodyText: string,
  auth: WeatherAuth,
  context: string,
  notFoundHint: string,
): Error | undefined {
  const { message } = describeErrorBody(bodyText);
  const what = `weather: ${context} failed with HTTP ${status}${message ? ` — ${message}` : ''}`;
  const reason = upstreamReason(bodyText);
  const code = reason === undefined ? {} : { upstreamCode: reason };
  if (status === 401 || status === 403) return new CredentialsRejectedError('weather', status, what, rejectedHint(auth));
  if (status === 400) return new UpstreamError('weather', 400, what, { ...code, code: 'INVALID_ARGUMENT', hint: BAD_REQUEST_HINT });
  if (status === 404) return new UpstreamError('weather', 404, what, { ...code, hint: notFoundHint });
  if (status === 429) return new UpstreamError('weather', 429, what, { ...code, hint: QUOTA_HINT });
  return undefined;
}

const GENERIC_NOT_FOUND =
  'WeatherKit did not recognise this request path. Check lang is a supported language tag (e.g. en, en-GB).';

export const ALERT_NOT_FOUND_HINT =
  'Apple only serves an alert while it is active: this one may have expired, or the id is wrong. Get current alert ' +
  'ids from apple_weather_get with countryCode set (the alerts data set).';

export function createWeatherClient(opts: WeatherClientOptions = {}): WeatherClient {
  const request = opts.request ?? httpRequest;
  const tokens: WeatherTokenCache = createWeatherTokenCache(opts.now ?? Date.now);

  async function get(path: string, query: Record<string, QueryValue>, context: string, notFoundHint: string): Promise<unknown> {
    const auth = resolveWeatherAuth();
    const send = async (token: string): Promise<unknown> => {
      try {
        const res = await request({
          service: 'weather',
          method: 'GET',
          url: `${WEATHERKIT_BASE}${path}`,
          query,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          responseType: 'json',
          classifyError: (status, bodyText) => classifyWeatherError(status, bodyText, auth, context, notFoundHint),
        });
        return res.data;
      } catch (err) {
        // A token Apple refused must not be served again from the cache.
        if (err instanceof CredentialsRejectedError) tokens.invalidate();
        throw err;
      }
    };
    const first = await tokens.get(auth);
    try {
      return await send(first.token);
    } catch (err) {
      // A CACHED token may have gone stale on Apple's side (clock skew, a key
      // edited in the portal): re-mint and replay exactly once. A token minted
      // for this very call being refused is definitive — replaying it would
      // only double the failed requests.
      if (first.fresh || !(err instanceof CredentialsRejectedError)) throw err;
      const second = await tokens.get(auth);
      return send(second.token);
    }
  }

  return {
    async getWeather(q) {
      const path = `/api/v1/weather/${encodeURIComponent(q.language)}/${formatCoordinate(q.latitude)}/${formatCoordinate(q.longitude)}`;
      const data = await get(
        path,
        {
          dataSets: q.dataSets,
          timezone: q.timezone,
          countryCode: q.countryCode,
          hourlyStart: q.hourlyStart,
          hourlyEnd: q.hourlyEnd,
          dailyStart: q.dailyStart,
          dailyEnd: q.dailyEnd,
        },
        'GET /api/v1/weather',
        GENERIC_NOT_FOUND,
      );
      if (!isPlainObject(data)) {
        throw new UpstreamError('weather', 200, 'weather: GET /api/v1/weather returned no weather object.', {
          hint: 'Apple returned an empty or malformed answer. Retry shortly.',
        });
      }
      return data;
    },

    async getAlert(language, id) {
      const path = `/api/v1/weatherAlert/${encodeURIComponent(language)}/${encodeURIComponent(id)}`;
      const data = await get(path, {}, 'GET /api/v1/weatherAlert', ALERT_NOT_FOUND_HINT);
      if (!isPlainObject(data)) {
        throw new UpstreamError('weather', 200, 'weather: GET /api/v1/weatherAlert returned no alert object.', {
          hint: 'Apple returned an empty or malformed answer. Retry shortly.',
        });
      }
      return data;
    },

    async getAvailability(latitude, longitude, country) {
      const path = `/api/v1/availability/${formatCoordinate(latitude)}/${formatCoordinate(longitude)}`;
      const data = await get(path, { country }, 'GET /api/v1/availability', GENERIC_NOT_FOUND);
      if (!Array.isArray(data) || !data.every((s) => typeof s === 'string')) {
        throw new UpstreamError('weather', 200, 'weather: GET /api/v1/availability did not return a list of data sets.', {
          hint: 'Apple returned an unexpected answer. Retry shortly.',
        });
      }
      return data as string[];
    },
  };
}

let defaultClient: WeatherClient | undefined;

/** The process-wide client (one token cache), created on first use — never at import. */
export function defaultWeatherClient(): WeatherClient {
  defaultClient ??= createWeatherClient();
  return defaultClient;
}
