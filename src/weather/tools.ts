import { parseLenient, projectOrRaw, resolveView, viewParam, type View } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getDisplayTimeZone, isValidTimeZone } from '../config.js';
import { InvalidArgumentError, UpstreamError, errorMessage } from '../errors.js';
import { addDaysYmd, startOfDay, ymdInZone, zoneOffsetMs } from '../time.js';
import { ANNOTATIONS, compactObject, defineTool, jsonResponse } from '../tools/_shared.js';
import { defaultWeatherClient, type WeatherClient, type WeatherQuery } from './client.js';
import {
  APPLE_SET_NAME,
  NATIVE_UNITS_LEGEND,
  UNIT_SYSTEMS,
  WEATHER_SETS,
  attribution,
  projectAlertDetail,
  projectWeather,
  resolveUnits,
  unitsLegend,
  type CompactWeather,
  type WeatherSet,
} from './format.js';
import { ALERT_RESPONSE, WEATHER_RESPONSE } from './schemas.js';

/**
 * `apple_weather_*` — WeatherKit REST, read-only.
 *
 * Two tools: the forecast bundle (`apple_weather_get`) and one alert's full
 * text (`apple_weather_get_alert`). Everything is read at call time; the
 * registrar only registers.
 */

export interface WeatherDeps {
  /** The WeatherKit client (default: the process-wide one, created on first call). */
  client?: WeatherClient;
  /** Clock (default `Date.now`): decides the hourly/daily windows. */
  now?: () => number;
}

const LABEL = 'aws-mcp';
const VIEWS: readonly View[] = ['compact', 'full'];
const DEFAULT_SETS: readonly WeatherSet[] = ['current', 'hourly', 'daily', 'alerts'];
export const DEFAULT_HOURS = 24;
export const DEFAULT_DAYS = 7;
/** The hourly range retried with when Apple refuses a longer one (8 days). */
export const SAFE_HOURLY_HOURS = 192;
const HOUR_MS = 3_600_000;

const SET_LABEL: Record<WeatherSet, string> = {
  current: 'current conditions',
  hourly: 'hourly forecast',
  daily: 'daily forecast',
  nextHour: 'next-hour precipitation forecast',
  alerts: 'severe-weather alert data',
};

// ---------------------------------------------------------------------------
// Shared parameters
// ---------------------------------------------------------------------------

const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

/** A path-safe BCP 47 language tag. */
function langParam(description: string) {
  return z.string().regex(LANG_RE, 'expected a BCP 47 language tag such as en or en-GB').optional().describe(description);
}

function timeZoneParam(description: string) {
  return z.string().min(1).optional().describe(description);
}

/**
 * The zone for this call — the argument, else the display zone — in its
 * canonical spelling (`america/new_york` → `America/New_York`: Intl is
 * case-insensitive, Apple's `timezone` parameter may not be). A bad argument
 * is an `InvalidArgumentError`.
 */
export function resolveZone(input: string | undefined): string {
  // Intl accepts fixed offsets ("+05:30"), but a fixed offset has no DST and
  // Apple's `timezone` wants a named zone — refuse rather than mis-roll days.
  if (input !== undefined && (FIXED_OFFSET_RE.test(input) || !isValidTimeZone(input))) {
    throw new InvalidArgumentError(
      `timeZone "${input}" is not an IANA time zone name.`,
      'Use a name such as America/New_York, Europe/London or Asia/Tokyo (not a fixed offset: it would ignore daylight saving).',
    );
  }
  // The default can never be an offset: getDisplayTimeZone only returns what
  // isValidTimeZone accepts, and that refuses bare offsets.
  return new Intl.DateTimeFormat('en-US', { timeZone: input ?? getDisplayTimeZone() }).resolvedOptions().timeZone;
}

const FIXED_OFFSET_RE = /^[+-]/;

/** Solar time moves one hour per 15° of longitude. */
const DEGREES_PER_HOUR = 15;
/**
 * How far (in hours) a defaulted zone may sit from a location's solar time
 * before the answer says so. Real zones stay within ~3 h of solar time (western
 * China, Galicia, western Alaska); a zone chosen for a different continent does not.
 */
export const FAR_ZONE_HOURS = 3.5;

/**
 * Hours between `zone`'s UTC offset at `nowMs` and local solar time at
 * `longitude`, measured around the 24-hour circle (so +14 and -10 are 0 apart).
 */
export function zoneDistanceHours(zone: string, longitude: number, nowMs: number): number {
  const d = (((zoneOffsetMs(nowMs, zone) / HOUR_MS - longitude / DEGREES_PER_HOUR) % 24) + 24) % 24;
  return Math.min(d, 24 - d);
}

/** An instant as WeatherKit's query parameters expect it: UTC, whole seconds, `Z`. */
export function apiInstant(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerWeatherTools(server: McpServer, deps: WeatherDeps = {}): void {
  const client = (): WeatherClient => deps.client ?? defaultWeatherClient();
  const now = deps.now ?? Date.now;

  defineTool(server, {
    name: 'apple_weather_get',
    service: 'weather',
    access: 'read',
    title: 'Get the weather forecast (Apple Weather)',
    description:
      'Weather forecast for a place from Apple Weather (WeatherKit): current conditions, hourly (up to 240 h), daily ' +
      '(up to 10 days), next-hour rain, severe-weather alerts (need countryCode). Returns temperature, feels-like, ' +
      'rain/snow chance and amount, wind, humidity, UV, sunrise/sunset. Takes latitude/longitude — use ' +
      "apple_maps_geocode first to turn a place name into coordinates. Days roll over in timeZone: pass the place's " +
      'own zone when it differs from yours. Needs APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY ' +
      'and APPLE_WEATHERKIT_SERVICE_ID. Show the returned attribution with the data.',
    inputSchema: z.strictObject({
      latitude: z.number().min(-90).max(90).describe('Latitude in decimal degrees, -90 to 90 (e.g. 40.7128).'),
      longitude: z.number().min(-180).max(180).describe('Longitude in decimal degrees, -180 to 180 (e.g. -74.006).'),
      dataSets: z
        .array(z.enum(WEATHER_SETS))
        .min(1)
        .optional()
        .describe(
          'What to fetch (default current, hourly, daily, alerts): current = conditions now; hourly = hour by hour; ' +
            'daily = day by day; nextHour = minute-level precipitation for the next hour (some regions only); ' +
            'alerts = severe-weather alerts (needs countryCode).',
        ),
      hours: z
        .number()
        .int()
        .min(1)
        .max(240)
        .optional()
        .describe(`Hours of hourly forecast from the current hour (default ${DEFAULT_HOURS}, max 240). Needs "hourly" in dataSets.`),
      days: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe(`Days of daily forecast starting today in timeZone (default ${DEFAULT_DAYS}, max 10). Needs "daily" in dataSets.`),
      timeZone: timeZoneParam(
        'IANA time zone (e.g. America/New_York) that times are shown in and that days roll over in. Default: the ' +
          "server's display zone (DISPLAY_TZ). For a place in another zone pass that place's zone.",
      ),
      countryCode: z
        .string()
        .regex(/^[A-Za-z]{2}$/, 'expected a two-letter ISO 3166-1 country code')
        .optional()
        .describe('Two-letter ISO country code of the location (e.g. US, GB). Required for severe-weather alerts; without it alerts are skipped, with a note.'),
      units: z
        .enum(UNIT_SYSTEMS)
        .optional()
        .describe('metric (°C, km/h, mm, hPa, km) or imperial (°F, mph, in, inHg, mi). Default: APPLE_UNITS, else metric.'),
      lang: langParam(
        'Language of alert descriptions, as a BCP 47 tag such as en, en-GB, fr or ja (default en). Condition words are always English.',
      ),
      view: viewParam(VIEWS, {
        note:
          'compact converts units, rounds, turns fractions into percentages and condition codes into words, and drops ' +
          'minute-by-minute next-hour data, day-part forecasts, moon and twilight times; "full" is Apple\'s payload verbatim (metric, UTC).',
      }),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const nowMs = now();
      const zone = resolveZone(args.timeZone);
      const units = resolveUnits(args.units);
      const view = resolveView(args.view, VIEWS);
      const asked = args.dataSets ?? DEFAULT_SETS;
      const requested = WEATHER_SETS.filter((s) => asked.includes(s));
      if (args.hours !== undefined && !requested.includes('hourly')) {
        throw new InvalidArgumentError('hours applies to the hourly forecast, but "hourly" is not in dataSets.', 'Add "hourly" to dataSets, or leave hours out.');
      }
      if (args.days !== undefined && !requested.includes('daily')) {
        throw new InvalidArgumentError('days applies to the daily forecast, but "daily" is not in dataSets.', 'Add "daily" to dataSets, or leave days out.');
      }
      const countryCode = args.countryCode?.toUpperCase();
      const notes: string[] = [];
      if (units.warning !== undefined) notes.push(units.warning);
      let sets: WeatherSet[] = requested;
      if (requested.includes('alerts') && countryCode === undefined) {
        if (requested.length === 1) {
          throw new InvalidArgumentError(
            'Severe-weather alerts need countryCode (the two-letter country of the location).',
            'Pass countryCode, e.g. "US" or "GB".',
          );
        }
        sets = requested.filter((s) => s !== 'alerts');
        notes.push(
          'Severe-weather alerts were NOT checked: Apple needs countryCode for them. Call again with countryCode ' +
            '(e.g. "US") to include alerts.',
        );
      }
      if (view === 'full' && args.units === 'imperial') {
        notes.push('units "imperial" applies to view "compact"; view "full" is Apple\'s metric payload, unconverted.');
      }
      // Apple rolls DAYS up at midnight in `timezone`. A defaulted zone that is
      // a continent away from the location silently shifts every day's high,
      // low and rain chance onto someone else's calendar — say so.
      if (args.timeZone === undefined) {
        const apart = zoneDistanceHours(zone, args.longitude, nowMs);
        if (apart > FAR_ZONE_HOURS) {
          notes.push(
            `No timeZone was given, so days roll over at midnight in ${zone} (the server's display zone) and times are ` +
              `shown there — about ${Math.round(apart)} h from local time at longitude ${args.longitude}. If this place ` +
              "uses another zone, call again with its timeZone (e.g. Asia/Tokyo) to get the place's own days.",
          );
        }
      }

      const hours = args.hours ?? DEFAULT_HOURS;
      const days = args.days ?? DEFAULT_DAYS;
      const language = args.lang ?? 'en';
      const query: WeatherQuery = {
        language,
        latitude: args.latitude,
        longitude: args.longitude,
        timezone: zone,
        dataSets: sets.map((s) => APPLE_SET_NAME[s]),
        ...(countryCode !== undefined ? { countryCode } : {}),
        ...(sets.includes('hourly') ? hourlyWindow(nowMs, hours) : {}),
        ...(sets.includes('daily') ? dailyWindow(nowMs, days, zone) : {}),
      };
      let raw: Record<string, unknown>;
      let hoursAsked = hours;
      try {
        raw = await client().getWeather(query);
      } catch (err) {
        // Apple has been seen to 400 an hourly range reaching past ~8–9 days
        // even though 10 are documented. Rather than fail the whole call, retry
        // ONCE with an 8-day range and say so (the shortfall note below then
        // states exactly how many hours came back).
        if (!(err instanceof UpstreamError && err.status === 400 && sets.includes('hourly') && hours > SAFE_HOURLY_HOURS)) throw err;
        raw = await client().getWeather({ ...query, ...hourlyWindow(nowMs, SAFE_HOURLY_HOURS) });
        hoursAsked = SAFE_HOURLY_HOURS;
        notes.push(
          `Apple refused an hourly range of ${hours} hours (HTTP 400), so it was requested again with ${SAFE_HOURLY_HOURS} hours.`,
        );
      }
      const weather = parseLenient(WEATHER_RESPONSE, raw, { label: LABEL, context: 'GET /api/v1/weather' }) as Record<string, unknown>;

      // A requested set Apple did not send is said out loud — absence is not "none".
      let noActiveAlerts = false;
      const unavailable = new Set<WeatherSet>();
      for (const s of sets) {
        const data = weather[APPLE_SET_NAME[s]];
        if (data === undefined) {
          if (s === 'alerts') {
            const verdict = await alertCoverage(client(), args.latitude, args.longitude, countryCode as string);
            notes.push(verdict.note);
            noActiveAlerts = verdict.covered;
          } else {
            notes.push(
              `Apple returned no ${SET_LABEL[s]} for this location` +
                (s === 'nextHour' ? ' (Apple offers next-hour precipitation only in some regions).' : '.'),
            );
          }
        } else if (isRecord(data) && isRecord(data.metadata) && data.metadata.temporarilyUnavailable === true) {
          unavailable.add(s);
          notes.push(`Apple reports its ${SET_LABEL[s]} as temporarily unavailable from the data provider; it may be incomplete.`);
        }
      }

      const head = {
        location: { latitude: args.latitude, longitude: args.longitude, ...(countryCode !== undefined ? { countryCode } : {}) },
        timeZone: zone,
        dataSets: sets,
      };
      const native = (extra: string[]) => {
        const all = [...notes, ...extra];
        return jsonResponse({
          ...head,
          view: 'full',
          units: NATIVE_UNITS_LEGEND,
          ...(all.length > 0 ? { notes: all } : {}),
          attribution: attribution(undefined),
          weather: raw,
        });
      };
      if (view === 'full') return native([]);

      const projected = projectOrRaw(
        weather,
        (w): CompactWeather => projectWeather(w, { zone, units: units.system, hours, days, sets }),
        { label: LABEL, context: 'GET /api/v1/weather' },
      );
      if (projected === weather) {
        return native([
          'Could not summarise Apple\'s answer (its shape has changed), so it is returned unconverted under "weather" (metric, UTC times).',
        ]);
      }
      const compact = projected as CompactWeather;
      if (noActiveAlerts) {
        compact.alerts = { returned: 0, alerts: [] };
      } else if (compact.alerts !== undefined && compact.alerts.returned === 0) {
        if (unavailable.has('alerts')) {
          // An empty list from a provider that says it is unavailable is not
          // "no alerts" — drop the list rather than let it read as one.
          delete compact.alerts;
          notes.push(
            'Apple listed no severe-weather alerts but flags its alert data as temporarily unavailable, so whether ' +
              'any alert is in effect here is UNKNOWN. Check again shortly or consult the local weather agency.',
          );
        } else {
          notes.push(`No active severe-weather alerts reported by Apple for this location (country ${countryCode as string}).`);
        }
      }
      if (compact.hourly !== undefined && compact.hourly.returned < hours) {
        notes.push(
          hoursAsked < hours
            ? `Apple returned ${compact.hourly.returned} of the ${hours} hours requested, because the retry asked for only ${hoursAsked}.`
            : `Apple returned ${compact.hourly.returned} of the ${hours} hours requested; its hourly forecast does not reach further.`,
        );
      }
      if (compact.daily !== undefined && compact.daily.returned < days) {
        notes.push(`Apple returned ${compact.daily.returned} of the ${days} days requested; its daily forecast does not reach further.`);
      }
      return jsonResponse({
        ...head,
        view: 'compact',
        units: unitsLegend(units.system),
        ...(notes.length > 0 ? { notes } : {}),
        attribution: attribution(
          `Converted to ${units.system} units and rounded by this server from Apple Weather data; view "full" returns Apple's unmodified data.`,
        ),
        // Alerts before the long forecast lists, so a truncated read still reaches them.
        ...compactObject({ current: compact.current, nextHour: compact.nextHour, alerts: compact.alerts, daily: compact.daily, hourly: compact.hourly }),
      });
    },
  });

  defineTool(server, {
    name: 'apple_weather_get_alert',
    service: 'weather',
    access: 'read',
    title: 'Get a severe-weather alert (Apple Weather)',
    description:
      "Get one severe-weather alert's full official text from Apple Weather (WeatherKit), unmodified, by its id (the " +
      'alerts[].id from apple_weather_get called with countryCode). Returns the issuing agency (source), severity, ' +
      'effective/expiry times, detailsUrl and the messages verbatim. Apple serves an alert only while it is active; an ' +
      'expired one is NOT_FOUND. Needs APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY and APPLE_WEATHERKIT_SERVICE_ID.',
    inputSchema: z.strictObject({
      alertId: z
        .string()
        .regex(/^[A-Za-z0-9-]{1,128}$/, 'expected an alert id (a UUID) from apple_weather_get')
        .describe('The alert id (a UUID), from alerts[].id in an apple_weather_get result.'),
      lang: langParam('Language of the alert text, as a BCP 47 tag such as en, en-GB, fr or ja (default en).'),
      timeZone: timeZoneParam("IANA time zone (e.g. America/New_York) the alert's times are shown in. Default: the server's display zone (DISPLAY_TZ)."),
      view: viewParam(VIEWS, {
        note: 'compact drops the alert area geometry (GeoJSON) and bookkeeping fields; the alert text is verbatim in both.',
      }),
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const zone = resolveZone(args.timeZone);
      const view = resolveView(args.view, VIEWS);
      const language = args.lang ?? 'en';
      const raw = await client().getAlert(language, args.alertId);
      const alert = parseLenient(ALERT_RESPONSE, raw, { label: LABEL, context: 'GET /api/v1/weatherAlert' }) as Record<string, unknown>;
      const notes: string[] = [];
      if (alert.messages === undefined || (Array.isArray(alert.messages) && alert.messages.length === 0)) {
        notes.push('Apple returned no message text for this alert; its detailsUrl (when present) links the full text.');
      }
      // Apple documents this endpoint as {area, messages} only. Its terms still
      // require the issuing agency and the details link wherever an alert is
      // shown, so name where to find whichever is missing.
      const missingTerms = ['source', 'detailsUrl'].filter((k) => typeof alert[k] !== 'string' || alert[k] === '');
      if (missingTerms.length > 0) {
        notes.push(
          `Apple's alert detail did not include ${missingTerms.join(' or ')}. The alert's entry in apple_weather_get ` +
            '(called with countryCode) carries the issuing agency (source) and detailsUrl, which must be shown with the alert.',
        );
      }
      const head = { alertId: args.alertId, language, timeZone: zone };
      const native = (extra: string[]) => {
        const all = [...notes, ...extra];
        return jsonResponse({ ...head, view: 'full', ...(all.length > 0 ? { notes: all } : {}), attribution: attribution(undefined), alert: raw });
      };
      if (view === 'full') return native([]);
      const projected = projectOrRaw(alert, (a) => projectAlertDetail(a, zone), { label: LABEL, context: 'GET /api/v1/weatherAlert' });
      if (projected === alert) {
        return native(['Could not summarise Apple\'s answer (its shape has changed), so it is returned verbatim under "alert".']);
      }
      return jsonResponse({ ...head, view: 'compact', ...(notes.length > 0 ? { notes } : {}), attribution: attribution(undefined), alert: projected });
    },
  });
}

/** The hourly window: from the start of the current (UTC) hour, `hours` long. */
export function hourlyWindow(nowMs: number, hours: number): Pick<WeatherQuery, 'hourlyStart' | 'hourlyEnd'> {
  const start = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  return { hourlyStart: apiInstant(start), hourlyEnd: apiInstant(start + hours * HOUR_MS) };
}

/** The daily window: from midnight today in `zone` to midnight `days` days later (DST-correct). */
export function dailyWindow(nowMs: number, days: number, zone: string): Pick<WeatherQuery, 'dailyStart' | 'dailyEnd'> {
  const today = ymdInZone(new Date(nowMs), zone);
  return {
    dailyStart: apiInstant(startOfDay(today, zone).getTime()),
    dailyEnd: apiInstant(startOfDay(addDaysYmd(today, days), zone).getTime()),
  };
}

/**
 * Apple sometimes sends no `weatherAlerts` set at all. That alone cannot say
 * whether there are no alerts or no alert SERVICE here, and those must not be
 * confused — so ask the availability endpoint which it is. A failed check is
 * reported as "unknown", never as "no alerts".
 */
async function alertCoverage(
  client: WeatherClient,
  latitude: number,
  longitude: number,
  countryCode: string,
): Promise<{ covered: boolean; note: string }> {
  try {
    const available = await client.getAvailability(latitude, longitude, countryCode);
    if (available.includes('weatherAlerts')) {
      return {
        covered: true,
        note: 'No active severe-weather alerts: Apple sent no alert data, and its availability check lists alert coverage for this location.',
      };
    }
    return {
      covered: false,
      note:
        `Apple does not provide severe-weather alerts for this location (country ${countryCode}). This is NOT ` +
        'confirmation that none are in effect — check the local weather agency.',
    };
  } catch (err) {
    return {
      covered: false,
      note:
        'Apple sent no alert data and the follow-up coverage check failed ' +
        `(${errorMessage(err)}), so whether any severe-weather alert is in effect here is UNKNOWN.`,
    };
  }
}
