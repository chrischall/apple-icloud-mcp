import { readEnvVar, type EnvSource } from '@chrischall/mcp-utils';
import { compactObject } from '../tools/_shared.js';
import { formatDateOnly, putInstant, ymdInZone } from '../time.js';

/**
 * Turning WeatherKit's payload into the compact answer.
 *
 * WeatherKit is metric-only (°C, km/h, mm, mm/h, mb, metres, 0–1 fractions)
 * and names conditions by code (`MostlyCloudy`). The compact rung converts to
 * the requested unit system, rounds to a sensible precision, turns fractions
 * into percentages and codes into words — and says so in `attribution.notice`,
 * because Apple's terms ask that modified data be marked as modified. The
 * `full` rung is Apple's payload verbatim.
 *
 * Alert text is NEVER rewritten (Apple's terms: "You must not modify, change,
 * alter, or obscure the text of a severe weather alert"): descriptions and
 * messages pass through byte-for-byte.
 */

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

export const LEGAL_URL = 'https://developer.apple.com/weatherkit/data-source-attribution/';

/** What Apple requires wherever WeatherKit data is shown. */
export function attribution(modified: string | undefined): Record<string, string> {
  return {
    serviceName: 'Apple Weather',
    legalUrl: LEGAL_URL,
    requirements:
      "Show 'Apple Weather' with a link to legalUrl when presenting this data. For alerts, name the issuing agency " +
      '(source), link detailsUrl, and quote alert text without altering it.',
    ...(modified !== undefined ? { notice: modified } : {}),
  };
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export const UNIT_SYSTEMS = ['metric', 'imperial'] as const;
export type UnitSystem = (typeof UNIT_SYSTEMS)[number];

export interface ResolvedUnits {
  system: UnitSystem;
  /** Set when APPLE_UNITS held something unusable (reported, never fatal: a typo degrades a label). */
  warning?: string;
}

/** The per-call `units` argument, else `APPLE_UNITS`, else metric. */
export function resolveUnits(arg: UnitSystem | undefined, env: EnvSource = process.env): ResolvedUnits {
  if (arg !== undefined) return { system: arg };
  const raw = readEnvVar('APPLE_UNITS', { env });
  if (raw === undefined) return { system: 'metric' };
  const value = raw.toLowerCase();
  if ((UNIT_SYSTEMS as readonly string[]).includes(value)) return { system: value as UnitSystem };
  return { system: 'metric', warning: `APPLE_UNITS "${raw}" is not "metric" or "imperial"; using metric.` };
}

const SHARED_LEGEND = {
  percentages: 'humidity, cloudCover and precipitationChance are percentages (0–100)',
  windDirection: 'degrees the wind blows FROM (0 = north, 90 = east); windFrom is the compass point',
};

/** The units every converted number in a compact answer is in. */
export function unitsLegend(system: UnitSystem): Record<string, string> {
  return system === 'imperial'
    ? {
        system: 'imperial',
        temperature: '°F',
        windSpeed: 'mph',
        precipitationAmount: 'in',
        precipitationIntensity: 'in/h',
        pressure: 'inHg',
        visibility: 'mi',
        ...SHARED_LEGEND,
      }
    : {
        system: 'metric',
        temperature: '°C',
        windSpeed: 'km/h',
        precipitationAmount: 'mm',
        precipitationIntensity: 'mm/h',
        pressure: 'hPa (= mb)',
        visibility: 'km',
        ...SHARED_LEGEND,
      };
}

/** The units of Apple's own payload (the `full` rung). */
export const NATIVE_UNITS_LEGEND: Record<string, string> = {
  system: 'metric (Apple native, unconverted)',
  temperature: '°C',
  windSpeed: 'km/h',
  precipitationAmount: 'mm',
  precipitationIntensity: 'mm/h',
  pressure: 'mb',
  visibility: 'm',
  fractions: 'humidity, cloudCover and precipitationChance are fractions from 0 to 1',
  times: 'ISO-8601 UTC',
};

/** Round half away from zero-ish (Math.round), and never emit `-0`. */
export function roundTo(value: number, digits: number): number {
  const f = 10 ** digits;
  const r = Math.round(value * f) / f;
  return r === 0 ? 0 : r;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

export interface Converter {
  temperature(c: unknown): number | undefined;
  speed(kmh: unknown): number | undefined;
  amount(mm: unknown): number | undefined;
  intensity(mmPerHour: unknown): number | undefined;
  pressure(mb: unknown): number | undefined;
  distance(m: unknown): number | undefined;
}

const KM_PER_MILE = 1.609344;
const MM_PER_INCH = 25.4;
const INHG_PER_MB = 0.02952998307;

function convert(fn: (n: number) => number, digits: number): (v: unknown) => number | undefined {
  return (v) => {
    const n = num(v);
    return n === undefined ? undefined : roundTo(fn(n), digits);
  };
}

export function converter(system: UnitSystem): Converter {
  if (system === 'imperial') {
    return {
      temperature: convert((c) => (c * 9) / 5 + 32, 1),
      speed: convert((k) => k / KM_PER_MILE, 1),
      amount: convert((mm) => mm / MM_PER_INCH, 2),
      intensity: convert((mm) => mm / MM_PER_INCH, 3),
      pressure: convert((mb) => mb * INHG_PER_MB, 2),
      distance: convert((m) => m / 1000 / KM_PER_MILE, 1),
    };
  }
  return {
    temperature: convert((c) => c, 1),
    speed: convert((k) => k, 1),
    amount: convert((mm) => mm, 1),
    intensity: convert((mm) => mm, 2),
    pressure: convert((mb) => mb, 1),
    distance: convert((m) => m / 1000, 1),
  };
}

/** A 0–1 fraction as a whole percentage. */
export function percent(v: unknown): number | undefined {
  const n = num(v);
  return n === undefined ? undefined : roundTo(n * 100, 0);
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** 16-point compass name for a bearing in degrees. */
export function compassPoint(v: unknown): string | undefined {
  const n = num(v);
  if (n === undefined) return undefined;
  const normalized = ((n % 360) + 360) % 360;
  return COMPASS[Math.round(normalized / 22.5) % 16];
}

/**
 * WeatherKit condition codes are CamelCase words (`MostlyCloudy`,
 * `ScatteredThunderstorms`, `MixedRainAndSleet`); the REST docs do not
 * enumerate them, so this reads ANY code rather than looking it up — an
 * unknown future code still becomes readable words.
 */
export function conditionText(v: unknown): string | undefined {
  const code = str(v);
  if (code === undefined) return undefined;
  const words = code
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** An upstream ISO-8601 instant (always `Z` from WeatherKit), or undefined when absent/invalid. */
export function upstreamInstant(v: unknown): Date | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function instantFields(field: string, v: unknown, zone: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  putInstant(out, field, upstreamInstant(v), zone);
  return out;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** The user-facing data-set names, in canonical order, and Apple's name for each. */
export const WEATHER_SETS = ['current', 'hourly', 'daily', 'nextHour', 'alerts'] as const;
export type WeatherSet = (typeof WEATHER_SETS)[number];
export const APPLE_SET_NAME: Record<WeatherSet, string> = {
  current: 'currentWeather',
  hourly: 'forecastHourly',
  daily: 'forecastDaily',
  nextHour: 'forecastNextHour',
  alerts: 'weatherAlerts',
};

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${what} is not an object`);
  return v as Record<string, unknown>;
}

function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${what} is not an array`);
  return v;
}

export interface ProjectContext {
  zone: string;
  units: UnitSystem;
  /** How many hourly entries were asked for. */
  hours: number;
  /** How many daily entries were asked for. */
  days: number;
  /** The sets that were requested from Apple. */
  sets: readonly WeatherSet[];
}

function projectCurrent(cw: Record<string, unknown>, c: Converter, zone: string): Record<string, unknown> {
  return compactObject({
    ...instantFields('asOf', cw.asOf, zone),
    condition: conditionText(cw.conditionCode),
    temperature: c.temperature(cw.temperature),
    feelsLike: c.temperature(cw.temperatureApparent),
    dewPoint: c.temperature(cw.temperatureDewPoint),
    humidity: percent(cw.humidity),
    cloudCover: percent(cw.cloudCover),
    windSpeed: c.speed(cw.windSpeed),
    windGust: c.speed(cw.windGust),
    windDirection: num(cw.windDirection),
    windFrom: compassPoint(cw.windDirection),
    uvIndex: num(cw.uvIndex),
    visibility: c.distance(cw.visibility),
    pressure: c.pressure(cw.pressure),
    pressureTrend: str(cw.pressureTrend),
    precipitationIntensity: c.intensity(cw.precipitationIntensity),
    daylight: bool(cw.daylight),
  });
}

function projectHour(h: Record<string, unknown>, c: Converter, zone: string): Record<string, unknown> {
  return compactObject({
    ...instantFields('time', h.forecastStart, zone),
    condition: conditionText(h.conditionCode),
    temperature: c.temperature(h.temperature),
    feelsLike: c.temperature(h.temperatureApparent),
    precipitationChance: percent(h.precipitationChance),
    precipitationType: str(h.precipitationType),
    precipitationAmount: c.amount(h.precipitationAmount),
    windSpeed: c.speed(h.windSpeed),
  });
}

function projectDay(d: Record<string, unknown>, c: Converter, zone: string): Record<string, unknown> {
  const start = upstreamInstant(d.forecastStart);
  const end = upstreamInstant(d.forecastEnd);
  // Apple rolls days up in the `timezone` we sent (`zone`), so the day's
  // calendar date in `zone` is its date. It is read at the MIDDLE of the span,
  // not at forecastStart: a start that lands even a minute before local
  // midnight (an hour's DST disagreement, a 7 AM–7 AM "day") would otherwise
  // label every day with the previous date — an off-by-one nothing flags.
  const anchor =
    start !== undefined && end !== undefined && end.getTime() > start.getTime()
      ? new Date((start.getTime() + end.getTime()) / 2)
      : start;
  const date = anchor === undefined ? undefined : ymdInZone(anchor, zone);
  return compactObject({
    date,
    dateDisplay: date === undefined ? undefined : formatDateOnly(date),
    condition: conditionText(d.conditionCode),
    high: c.temperature(d.temperatureMax),
    low: c.temperature(d.temperatureMin),
    precipitationChance: percent(d.precipitationChance),
    precipitationType: str(d.precipitationType),
    precipitationAmount: c.amount(d.precipitationAmount),
    snowfallAmount: c.amount(d.snowfallAmount),
    ...instantFields('sunrise', d.sunrise, zone),
    ...instantFields('sunset', d.sunset, zone),
    uvIndexMax: num(d.maxUvIndex),
  });
}

function projectNextHour(nh: Record<string, unknown>, c: Converter, zone: string): Record<string, unknown> {
  const periods = arr(nh.summary, 'forecastNextHour.summary').map((p, i) => {
    const period = obj(p, `forecastNextHour.summary[${i}]`);
    return compactObject({
      ...instantFields('start', period.startTime, zone),
      ...instantFields('end', period.endTime, zone),
      precipitationType: str(period.condition),
      precipitationChance: percent(period.precipitationChance),
      precipitationIntensity: c.intensity(period.precipitationIntensity),
    });
  });
  return {
    ...instantFields('start', nh.forecastStart, zone),
    ...instantFields('end', nh.forecastEnd, zone),
    periods,
  };
}

/**
 * One alert summary. `description` and `source` pass through verbatim, and
 * `detailsUrl` is always carried — Apple's terms require both to be shown.
 */
export function projectAlertSummary(a: Record<string, unknown>, zone: string): Record<string, unknown> {
  const responses = Array.isArray(a.responses) ? a.responses.filter((r): r is string => typeof r === 'string') : undefined;
  return compactObject({
    id: str(a.id),
    description: a.description,
    severity: str(a.severity),
    urgency: str(a.urgency),
    certainty: str(a.certainty),
    source: a.source,
    areaName: a.areaName,
    ...instantFields('effective', a.effectiveTime, zone),
    ...instantFields('onset', a.eventOnsetTime, zone),
    ...instantFields('ends', a.eventEndTime, zone),
    ...instantFields('expires', a.expireTime, zone),
    responses: responses !== undefined && responses.length > 0 ? responses : undefined,
    detailsUrl: a.detailsUrl,
  });
}

function projectAlerts(wa: Record<string, unknown>, zone: string): Record<string, unknown> {
  const alerts = arr(wa.alerts, 'weatherAlerts.alerts').map((a, i) => projectAlertSummary(obj(a, `weatherAlerts.alerts[${i}]`), zone));
  return compactObject({ returned: alerts.length, detailsUrl: str(wa.detailsUrl), alerts });
}

export interface CompactWeather {
  current?: Record<string, unknown>;
  nextHour?: Record<string, unknown>;
  alerts?: Record<string, unknown>;
  daily?: { requested: number; returned: number; days: Record<string, unknown>[] };
  hourly?: { requested: number; returned: number; hours: Record<string, unknown>[] };
}

/**
 * Project the requested sets Apple actually returned. Throws when a data set
 * is structurally unusable (not an object, its list not an array), so the
 * caller's `projectOrRaw` hands back Apple's whole payload rather than a
 * compact answer with a silent hole in it.
 */
export function projectWeather(w: Record<string, unknown>, ctx: ProjectContext): CompactWeather {
  const c = converter(ctx.units);
  const out: CompactWeather = {};
  const has = (s: WeatherSet): boolean => ctx.sets.includes(s) && w[APPLE_SET_NAME[s]] !== undefined;
  if (has('current')) out.current = projectCurrent(obj(w.currentWeather, 'currentWeather'), c, ctx.zone);
  if (has('nextHour')) out.nextHour = projectNextHour(obj(w.forecastNextHour, 'forecastNextHour'), c, ctx.zone);
  if (has('alerts')) out.alerts = projectAlerts(obj(w.weatherAlerts, 'weatherAlerts'), ctx.zone);
  if (has('daily')) {
    const days = arr(obj(w.forecastDaily, 'forecastDaily').days, 'forecastDaily.days')
      .slice(0, ctx.days)
      .map((d, i) => projectDay(obj(d, `forecastDaily.days[${i}]`), c, ctx.zone));
    out.daily = { requested: ctx.days, returned: days.length, days };
  }
  if (has('hourly')) {
    const hours = arr(obj(w.forecastHourly, 'forecastHourly').hours, 'forecastHourly.hours')
      .slice(0, ctx.hours)
      .map((h, i) => projectHour(obj(h, `forecastHourly.hours[${i}]`), c, ctx.zone));
    out.hourly = { requested: ctx.hours, returned: hours.length, hours };
  }
  return out;
}

/**
 * The compact form of one full alert (`GET /api/v1/weatherAlert`): the summary
 * fields plus the agency's `messages`, passed through VERBATIM. Only the
 * `area` geometry (a GeoJSON polygon set, often large) and bookkeeping are
 * dropped; `full` keeps them.
 */
export function projectAlertDetail(a: Record<string, unknown>, zone: string): Record<string, unknown> {
  const summary = projectAlertSummary(a, zone);
  // Absent messages are reported by the tool; present-but-malformed ones throw
  // so the raw alert (text and all) is returned instead of a textless one.
  if (a.messages === undefined) return summary;
  return { ...summary, messages: arr(a.messages, 'weatherAlert.messages') };
}
