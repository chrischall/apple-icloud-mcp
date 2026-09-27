import { generateKeyPairSync } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import { vi } from 'vitest';
import { registerWeatherTools, type WeatherDeps } from '../../src/weather/tools.js';
import type { WeatherClient } from '../../src/weather/client.js';

/** One real P-256 key per test process (generation is the slow part). */
export const PEM = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
export const TEAM_ID = 'TEAM123456';
export const KEY_ID = 'KEY1234567';
export const SERVICE_ID = 'com.example.weather';

/** Configure WeatherKit in process.env (tests/_setup.ts blanks it before each test). */
export function setWeatherEnv(overrides: Record<string, string | undefined> = {}): void {
  const values: Record<string, string | undefined> = {
    APPLE_TEAM_ID: TEAM_ID,
    APPLE_KEY_ID: KEY_ID,
    APPLE_PRIVATE_KEY: PEM,
    APPLE_WEATHERKIT_SERVICE_ID: SERVICE_ID,
    ...overrides,
  };
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Saturday 26 Sep 2026, 2:35 PM EDT. */
export const NOW = Date.parse('2026-09-26T18:35:00Z');

const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');
const HOUR = 3_600_000;

export const METADATA = {
  attributionURL: 'https://developer.apple.com/weatherkit/data-source-attribution/',
  expireTime: '2026-09-26T18:40:00Z',
  latitude: 40.713,
  longitude: -74.006,
  readTime: '2026-09-26T18:35:00Z',
  units: 'm',
  version: 1,
};

export function currentWeather(): Record<string, unknown> {
  return {
    name: 'CurrentWeather',
    metadata: METADATA,
    asOf: '2026-09-26T18:35:00Z',
    cloudCover: 0.42,
    conditionCode: 'MostlyCloudy',
    daylight: true,
    humidity: 0.555,
    precipitationIntensity: 0,
    pressure: 1013.62,
    pressureTrend: 'steady',
    temperature: 18.98,
    temperatureApparent: 18.5,
    temperatureDewPoint: 9.6,
    uvIndex: 3,
    visibility: 16093.4,
    windDirection: 225,
    windGust: 30.1,
    windSpeed: 16.96,
  };
}

export function hour(i: number): Record<string, unknown> {
  return {
    forecastStart: iso(Date.parse('2026-09-26T18:00:00Z') + i * HOUR),
    cloudCover: 0.4,
    conditionCode: i % 2 === 0 ? 'PartlyCloudy' : 'Drizzle',
    daylight: true,
    humidity: 0.55,
    precipitationAmount: i % 2 === 0 ? 0 : 0.3,
    precipitationChance: i % 2 === 0 ? 0.05 : 0.6,
    precipitationType: i % 2 === 0 ? 'clear' : 'rain',
    pressure: 1013,
    temperature: 19 - i * 0.1,
    temperatureApparent: 18.6,
    temperatureDewPoint: 9,
    uvIndex: 3,
    visibility: 16000,
    windDirection: 220,
    windGust: 28,
    windSpeed: 15,
  };
}

/** Day `i` from Saturday 26 Sep 2026, rolled up in America/New_York (midnight = 04:00Z in EDT). */
export function day(i: number): Record<string, unknown> {
  const start = Date.parse('2026-09-26T04:00:00Z') + i * 24 * HOUR;
  return {
    forecastStart: iso(start),
    forecastEnd: iso(start + 24 * HOUR),
    conditionCode: 'Rain',
    maxUvIndex: 5,
    moonPhase: 'waxingGibbous',
    precipitationAmount: 4.26,
    precipitationChance: 0.71,
    precipitationType: 'rain',
    snowfallAmount: 0,
    sunrise: iso(start + 6 * HOUR + 50 * 60_000),
    sunset: iso(start + 18 * HOUR + 45 * 60_000),
    temperatureMax: 22.4,
    temperatureMin: 12.06,
    daytimeForecast: { forecastStart: iso(start + 11 * HOUR), conditionCode: 'Rain' },
  };
}

export const ALERT_ID = '4d8c5f4e-3c56-5b38-ae4c-6c34f7f3c8a2';

export function alertSummary(): Record<string, unknown> {
  return {
    id: ALERT_ID,
    areaId: 'NYZ072',
    areaName: 'New York (Manhattan)',
    certainty: 'likely',
    countryCode: 'US',
    description: 'Coastal Flood Advisory',
    detailsUrl: `https://weatherkit.apple.com/alertDetails/index.html?ids=${ALERT_ID}&lang=en-US&timezone=America/New_York`,
    effectiveTime: '2026-09-26T18:00:00Z',
    eventEndTime: '2026-09-27T02:00:00Z',
    eventOnsetTime: '2026-09-26T22:00:00Z',
    expireTime: '2026-09-27T02:00:00Z',
    issuedTime: '2026-09-26T17:48:00Z',
    responses: ['monitor', 'prepare'],
    severity: 'minor',
    source: 'National Weather Service',
    urgency: 'expected',
  };
}

export function nextHour(): Record<string, unknown> {
  return {
    name: 'NextHourForecast',
    metadata: METADATA,
    forecastStart: '2026-09-26T18:35:00Z',
    forecastEnd: '2026-09-26T19:35:00Z',
    minutes: [{ startTime: '2026-09-26T18:35:00Z', precipitationChance: 0, precipitationIntensity: 0 }],
    summary: [
      { startTime: '2026-09-26T18:35:00Z', endTime: '2026-09-26T19:05:00Z', condition: 'clear', precipitationChance: 0, precipitationIntensity: 0 },
      { startTime: '2026-09-26T19:05:00Z', condition: 'rain', precipitationChance: 0.8, precipitationIntensity: 1.234 },
    ],
  };
}

/** A realistic full weather payload. */
export function sampleWeather(opts: { hours?: number; days?: number; alerts?: Record<string, unknown>[] | null } = {}): Record<string, unknown> {
  const w: Record<string, unknown> = {
    currentWeather: currentWeather(),
    forecastHourly: { name: 'HourlyForecast', metadata: METADATA, hours: Array.from({ length: opts.hours ?? 24 }, (_, i) => hour(i)) },
    forecastDaily: {
      name: 'DailyForecast',
      metadata: METADATA,
      days: Array.from({ length: opts.days ?? 7 }, (_, i) => day(i)),
      learnMoreURL: 'https://weather.apple.com/',
    },
    forecastNextHour: nextHour(),
  };
  if (opts.alerts !== null) {
    w.weatherAlerts = {
      name: 'WeatherAlerts',
      metadata: METADATA,
      detailsUrl: `https://weatherkit.apple.com/alertDetails/index.html?ids=${ALERT_ID}`,
      alerts: opts.alerts ?? [alertSummary()],
    };
  }
  return w;
}

export function alertDetail(): Record<string, unknown> {
  return {
    name: 'WeatherAlert',
    metadata: METADATA,
    ...alertSummary(),
    phenomenon: 'Coastal Flood',
    significance: 'advisory',
    area: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-74, 40], [-73.9, 40.8], [-74, 40]]] } }] },
    messages: [{ language: 'en', text: '...COASTAL FLOOD ADVISORY IN EFFECT FROM 6 PM THIS EVENING...\n\n* WHAT...Up to one foot of inundation.' }],
  };
}

export interface FakeClient extends WeatherClient {
  getWeather: ReturnType<typeof vi.fn> & WeatherClient['getWeather'];
  getAlert: ReturnType<typeof vi.fn> & WeatherClient['getAlert'];
  getAvailability: ReturnType<typeof vi.fn> & WeatherClient['getAvailability'];
}

export function fakeClient(): FakeClient {
  return {
    getWeather: vi.fn(async () => sampleWeather()),
    getAlert: vi.fn(async () => alertDetail()),
    getAvailability: vi.fn(async () => ['currentWeather', 'forecastDaily', 'forecastHourly', 'weatherAlerts']),
  } as unknown as FakeClient;
}

export interface CapturedTool {
  cfg: { title?: string; description: string; inputSchema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }; annotations: Record<string, unknown> };
  cb: (args: Record<string, unknown>, ctx?: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

/** Register the weather tools on a fake server and return them by name. */
export function captureTools(deps?: WeatherDeps): Map<string, CapturedTool> {
  const tools = new Map<string, CapturedTool>();
  const server = {
    registerTool: (name: string, cfg: CapturedTool['cfg'], cb: CapturedTool['cb']) => tools.set(name, { cfg, cb }),
  } as unknown as McpServer;
  registerWeatherTools(server, deps);
  return tools;
}

/** Call a captured tool and parse its JSON payload. */
export async function call(
  tools: Map<string, CapturedTool>,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string; json: Record<string, any> }> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  const result = await tool.cb(args, {});
  const text = result.content[0]!.text;
  return { isError: result.isError === true, text, json: JSON.parse(text) as Record<string, any> };
}

/** Decode a JWT's header and payload (no verification). */
export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = token.split('.') as [string, string];
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>,
  };
}

/** A fetch stub answering each call with the next queued response (JSON bodies by default). */
export function queueFetch(...responses: Array<{ status?: number; body?: unknown; text?: string } | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error(`unexpected extra fetch: ${String(input)}`);
    if (next instanceof Error) throw next;
    const text = next.text ?? JSON.stringify(next.body ?? null);
    return new Response(text, { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

export function authHeader(init: RequestInit): string {
  return (init.headers as Record<string, string>).Authorization!.replace(/^Bearer /, '');
}
