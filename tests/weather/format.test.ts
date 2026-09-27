import { describe, expect, it } from 'vitest';
import {
  LEGAL_URL,
  attribution,
  compassPoint,
  conditionText,
  converter,
  percent,
  projectAlertDetail,
  projectAlertSummary,
  projectWeather,
  resolveUnits,
  roundTo,
  unitsLegend,
  upstreamInstant,
  type ProjectContext,
} from '../../src/weather/format.js';
import { alertDetail, alertSummary, sampleWeather } from './_fixtures.js';

const ZONE = 'America/New_York';
const CTX: ProjectContext = { zone: ZONE, units: 'metric', hours: 24, days: 7, sets: ['current', 'hourly', 'daily', 'nextHour', 'alerts'] };

describe('conditionText', () => {
  it('turns any CamelCase condition code into words', () => {
    expect(conditionText('MostlyCloudy')).toBe('Mostly cloudy');
    expect(conditionText('MixedRainAndSleet')).toBe('Mixed rain and sleet');
    expect(conditionText('Clear')).toBe('Clear');
    expect(conditionText('ScatteredThunderstorms')).toBe('Scattered thunderstorms');
    expect(conditionText('UVWarning')).toBe('Uv warning');
    expect(conditionText('Level2Storm')).toBe('Level2 storm');
    expect(conditionText('')).toBeUndefined();
    expect(conditionText(undefined)).toBeUndefined();
    expect(conditionText(42)).toBeUndefined();
  });
});

describe('compassPoint', () => {
  it('names the 16-point compass bearing, normalising any angle', () => {
    expect(compassPoint(0)).toBe('N');
    expect(compassPoint(11)).toBe('N');
    expect(compassPoint(12)).toBe('NNE');
    expect(compassPoint(225)).toBe('SW');
    expect(compassPoint(359)).toBe('N');
    expect(compassPoint(720)).toBe('N');
    expect(compassPoint(-45)).toBe('NW');
    expect(compassPoint('225')).toBeUndefined();
    expect(compassPoint(Number.NaN)).toBeUndefined();
  });
});

describe('numbers and units', () => {
  it('rounds without ever emitting -0', () => {
    expect(roundTo(-0.04, 1)).toBe(0);
    expect(Object.is(roundTo(-0.04, 1), -0)).toBe(false);
    expect(roundTo(18.98, 1)).toBe(19);
    expect(roundTo(1.005, 0)).toBe(1);
  });

  it('turns fractions into whole percentages', () => {
    expect(percent(0.555)).toBe(56);
    expect(percent(0)).toBe(0);
    expect(percent(1)).toBe(100);
    expect(percent(null)).toBeUndefined();
  });

  it('converts to metric (identity on Apple units, km for visibility)', () => {
    const c = converter('metric');
    expect(c.temperature(18.98)).toBe(19);
    expect(c.speed(16.96)).toBe(17);
    expect(c.amount(4.26)).toBe(4.3);
    expect(c.intensity(1.234)).toBe(1.23);
    expect(c.pressure(1013.62)).toBe(1013.6);
    expect(c.distance(16093.4)).toBe(16.1);
    expect(c.temperature(undefined)).toBeUndefined();
  });

  it('converts to imperial', () => {
    const c = converter('imperial');
    expect(c.temperature(18.98)).toBe(66.2);
    expect(c.temperature(-40)).toBe(-40);
    expect(c.speed(16.96)).toBe(10.5);
    expect(c.amount(25.4)).toBe(1);
    expect(c.intensity(1.234)).toBe(0.049);
    expect(c.pressure(1013.62)).toBe(29.93);
    expect(c.distance(16093.4)).toBe(10);
    expect(c.distance('far')).toBeUndefined();
  });

  it('resolves units from the argument, then APPLE_UNITS, then metric', () => {
    expect(resolveUnits('imperial')).toEqual({ system: 'imperial' });
    expect(resolveUnits(undefined)).toEqual({ system: 'metric' });
    process.env.APPLE_UNITS = 'Imperial';
    expect(resolveUnits(undefined)).toEqual({ system: 'imperial' });
    expect(resolveUnits('metric')).toEqual({ system: 'metric' });
    process.env.APPLE_UNITS = 'kelvin';
    expect(resolveUnits(undefined)).toEqual({ system: 'metric', warning: 'APPLE_UNITS "kelvin" is not "metric" or "imperial"; using metric.' });
    expect(resolveUnits(undefined, { APPLE_UNITS: 'metric' })).toEqual({ system: 'metric' });
  });

  it('labels every unit', () => {
    expect(unitsLegend('metric')).toMatchObject({ system: 'metric', temperature: '°C', windSpeed: 'km/h', visibility: 'km' });
    expect(unitsLegend('imperial')).toMatchObject({ system: 'imperial', temperature: '°F', windSpeed: 'mph', pressure: 'inHg' });
  });

  it('reads upstream instants strictly', () => {
    expect(upstreamInstant('2026-09-26T18:00:00Z')?.toISOString()).toBe('2026-09-26T18:00:00.000Z');
    expect(upstreamInstant('yesterday')).toBeUndefined();
    expect(upstreamInstant(0)).toBeUndefined();
  });
});

describe('attribution', () => {
  it('always names Apple Weather and the legal link, plus a notice when data was modified', () => {
    expect(attribution(undefined)).toMatchObject({ serviceName: 'Apple Weather', legalUrl: LEGAL_URL });
    expect(attribution(undefined)).not.toHaveProperty('notice');
    expect(attribution('converted')).toMatchObject({ notice: 'converted' });
  });
});

describe('projectWeather', () => {
  it('projects every requested set in the display zone', () => {
    const out = projectWeather(sampleWeather(), CTX);
    expect(out.current).toEqual({
      asOf: '2026-09-26T14:35:00-04:00',
      asOfDisplay: 'Sat, Sep 26, 2026, 2:35 PM EDT',
      condition: 'Mostly cloudy',
      temperature: 19,
      feelsLike: 18.5,
      dewPoint: 9.6,
      humidity: 56,
      cloudCover: 42,
      windSpeed: 17,
      windGust: 30.1,
      windDirection: 225,
      windFrom: 'SW',
      uvIndex: 3,
      visibility: 16.1,
      pressure: 1013.6,
      pressureTrend: 'steady',
      precipitationIntensity: 0,
      daylight: true,
    });
    expect(out.hourly?.returned).toBe(24);
    expect(out.hourly?.hours[1]).toEqual({
      time: '2026-09-26T15:00:00-04:00',
      timeDisplay: 'Sat, Sep 26, 2026, 3:00 PM EDT',
      condition: 'Drizzle',
      temperature: 18.9,
      feelsLike: 18.6,
      precipitationChance: 60,
      precipitationType: 'rain',
      precipitationAmount: 0.3,
      windSpeed: 15,
    });
    expect(out.daily?.days[0]).toEqual({
      date: '2026-09-26',
      dateDisplay: 'Sat, Sep 26, 2026',
      condition: 'Rain',
      high: 22.4,
      low: 12.1,
      precipitationChance: 71,
      precipitationType: 'rain',
      precipitationAmount: 4.3,
      snowfallAmount: 0,
      sunrise: '2026-09-26T06:50:00-04:00',
      sunriseDisplay: 'Sat, Sep 26, 2026, 6:50 AM EDT',
      sunset: '2026-09-26T18:45:00-04:00',
      sunsetDisplay: 'Sat, Sep 26, 2026, 6:45 PM EDT',
      uvIndexMax: 5,
    });
    expect(out.nextHour).toEqual({
      start: '2026-09-26T14:35:00-04:00',
      startDisplay: 'Sat, Sep 26, 2026, 2:35 PM EDT',
      end: '2026-09-26T15:35:00-04:00',
      endDisplay: 'Sat, Sep 26, 2026, 3:35 PM EDT',
      periods: [
        {
          start: '2026-09-26T14:35:00-04:00',
          startDisplay: 'Sat, Sep 26, 2026, 2:35 PM EDT',
          end: '2026-09-26T15:05:00-04:00',
          endDisplay: 'Sat, Sep 26, 2026, 3:05 PM EDT',
          precipitationType: 'clear',
          precipitationChance: 0,
          precipitationIntensity: 0,
        },
        {
          start: '2026-09-26T15:05:00-04:00',
          startDisplay: 'Sat, Sep 26, 2026, 3:05 PM EDT',
          precipitationType: 'rain',
          precipitationChance: 80,
          precipitationIntensity: 1.23,
        },
      ],
    });
    expect(out.alerts).toMatchObject({ returned: 1, detailsUrl: expect.stringContaining('alertDetails'), alerts: [expect.objectContaining({ source: 'National Weather Service' })] });
  });

  it('slices to the requested hours and days and skips sets that were not requested', () => {
    const out = projectWeather(sampleWeather({ hours: 30, days: 10 }), { ...CTX, hours: 5, days: 3, sets: ['hourly', 'daily'] });
    expect(out.hourly).toMatchObject({ requested: 5, returned: 5 });
    expect(out.daily).toMatchObject({ requested: 3, returned: 3 });
    expect(out.current).toBeUndefined();
    expect(out.alerts).toBeUndefined();
  });

  it('leaves out sets Apple did not send', () => {
    expect(projectWeather({}, CTX)).toEqual({});
  });

  it('omits fields Apple left out instead of inventing them', () => {
    expect(projectWeather({ currentWeather: { conditionCode: 'Clear', daylight: 'yes' } }, CTX).current).toEqual({ condition: 'Clear' });
    const w = sampleWeather();
    (w.forecastDaily as { days: unknown[] }).days = [{ conditionCode: 'Clear' }];
    (w.forecastNextHour as Record<string, unknown>).forecastStart = undefined;
    const out = projectWeather(w, CTX);
    expect(out.daily?.days[0]).toEqual({ condition: 'Clear' });
    expect(out.nextHour).not.toHaveProperty('start');
  });

  it('dates each day by the middle of its span, so a start just before local midnight keeps its date', () => {
    const w = sampleWeather();
    (w.forecastDaily as { days: unknown[] }).days = [
      // Starts 23:00 EDT on 31 Oct: dated by forecastStart alone this would be the 31st.
      { conditionCode: 'Clear', forecastStart: '2026-11-01T03:00:00Z', forecastEnd: '2026-11-02T03:00:00Z' },
      // No end: the start decides (midnight EST on 2 Nov, after the fall-back).
      { conditionCode: 'Clear', forecastStart: '2026-11-02T05:00:00Z' },
      // A degenerate span (end not after start) also falls back to the start.
      { conditionCode: 'Clear', forecastStart: '2026-11-03T05:00:00Z', forecastEnd: '2026-11-03T05:00:00Z' },
    ];
    const days = projectWeather(w, CTX).daily!.days;
    expect(days.map((d) => d.date)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    expect(days[0]!.dateDisplay).toBe('Sun, Nov 1, 2026');
  });

  it.each([
    ['currentWeather', 'nope', /currentWeather is not an object/],
    ['forecastHourly', { hours: 'x' }, /forecastHourly.hours is not an array/],
    ['forecastHourly', { hours: [1] }, /forecastHourly.hours\[0\] is not an object/],
    ['forecastDaily', { days: null }, /forecastDaily.days is not an array/],
    ['forecastDaily', [], /forecastDaily is not an object/],
    ['forecastNextHour', { summary: [null] }, /forecastNextHour.summary\[0\] is not an object/],
    ['weatherAlerts', { alerts: {} }, /weatherAlerts.alerts is not an array/],
    ['weatherAlerts', { alerts: ['x'] }, /weatherAlerts.alerts\[0\] is not an object/],
  ])('throws on a structurally unusable %s so the caller falls back to the raw payload', (key, value, message) => {
    expect(() => projectWeather({ ...sampleWeather(), [key]: value }, CTX)).toThrow(message);
  });
});

describe('alert projections', () => {
  it('passes alert text through verbatim and keeps source + detailsUrl', () => {
    const a = projectAlertSummary(alertSummary(), ZONE);
    expect(a).toEqual({
      id: '4d8c5f4e-3c56-5b38-ae4c-6c34f7f3c8a2',
      description: 'Coastal Flood Advisory',
      severity: 'minor',
      urgency: 'expected',
      certainty: 'likely',
      source: 'National Weather Service',
      areaName: 'New York (Manhattan)',
      effective: '2026-09-26T14:00:00-04:00',
      effectiveDisplay: 'Sat, Sep 26, 2026, 2:00 PM EDT',
      onset: '2026-09-26T18:00:00-04:00',
      onsetDisplay: 'Sat, Sep 26, 2026, 6:00 PM EDT',
      ends: '2026-09-26T22:00:00-04:00',
      endsDisplay: 'Sat, Sep 26, 2026, 10:00 PM EDT',
      expires: '2026-09-26T22:00:00-04:00',
      expiresDisplay: 'Sat, Sep 26, 2026, 10:00 PM EDT',
      responses: ['monitor', 'prepare'],
      detailsUrl: expect.stringContaining('alertDetails'),
    });
  });

  it('drops empty or malformed responses', () => {
    expect(projectAlertSummary({ id: 'a', responses: [] }, ZONE)).toEqual({ id: 'a' });
    expect(projectAlertSummary({ id: 'a', responses: 'shelter' }, ZONE)).toEqual({ id: 'a' });
    expect(projectAlertSummary({ id: 'a', responses: [1, 'shelter'] }, ZONE)).toEqual({ id: 'a', responses: ['shelter'] });
  });

  it('keeps the detail messages verbatim and drops the area geometry', () => {
    const detail = alertDetail();
    const out = projectAlertDetail(detail, ZONE);
    expect(out.messages).toBe(detail.messages);
    expect(out).not.toHaveProperty('area');
    expect(out).not.toHaveProperty('phenomenon');
    expect(Object.keys(out).at(-1)).toBe('messages');
  });

  it('omits absent messages and throws on malformed ones', () => {
    const { messages: _m, ...rest } = alertDetail();
    expect(projectAlertDetail(rest, ZONE)).not.toHaveProperty('messages');
    expect(() => projectAlertDetail({ ...rest, messages: 'text' }, ZONE)).toThrow(/messages is not an array/);
  });
});
