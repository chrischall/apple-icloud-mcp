import { z } from 'zod';

/**
 * Loose schemas for the WeatherKit fields this module READS, for
 * `parseLenient`: a drift is warned about on stderr (naming the field) and the
 * raw payload flows on, so an Apple change degrades the answer instead of
 * breaking it. Fields Apple documents as REQUIRED are required here, so their
 * disappearance is what gets reported; unknown keys pass through untouched.
 *
 * Source: developer.apple.com/documentation/weatherkitrestapi (crawled
 * 2026-09-26).
 */

const metadata = z.looseObject({ temporarilyUnavailable: z.boolean().optional() }).optional();

const currentWeather = z.looseObject({
  metadata,
  asOf: z.string(),
  conditionCode: z.string(),
  humidity: z.number(),
  precipitationIntensity: z.number(),
  pressure: z.number(),
  pressureTrend: z.string(),
  temperature: z.number(),
  temperatureApparent: z.number(),
  temperatureDewPoint: z.number(),
  uvIndex: z.number(),
  visibility: z.number(),
  windSpeed: z.number(),
  cloudCover: z.number().optional(),
  daylight: z.boolean().optional(),
  windDirection: z.number().optional(),
  windGust: z.number().optional(),
});

const hour = z.looseObject({
  forecastStart: z.string(),
  conditionCode: z.string(),
  precipitationChance: z.number(),
  precipitationType: z.string(),
  temperature: z.number(),
  temperatureApparent: z.number(),
  windSpeed: z.number(),
  precipitationAmount: z.number().optional(),
});

const day = z.looseObject({
  forecastStart: z.string(),
  conditionCode: z.string(),
  maxUvIndex: z.number(),
  precipitationAmount: z.number(),
  precipitationChance: z.number(),
  precipitationType: z.string(),
  snowfallAmount: z.number(),
  temperatureMax: z.number(),
  temperatureMin: z.number(),
  sunrise: z.string().optional(),
  sunset: z.string().optional(),
});

const period = z.looseObject({
  startTime: z.string(),
  condition: z.string(),
  precipitationChance: z.number(),
  precipitationIntensity: z.number(),
  endTime: z.string().optional(),
});

/** The fields of a `WeatherAlertSummary` this module reads (shared by the alert detail). */
const alertSummaryFields = {
  id: z.string(),
  description: z.string(),
  severity: z.string(),
  source: z.string(),
  certainty: z.string(),
  effectiveTime: z.string(),
  expireTime: z.string(),
  responses: z.array(z.string()),
  urgency: z.string().optional(),
  areaName: z.string().optional(),
  detailsUrl: z.string().optional(),
  eventOnsetTime: z.string().optional(),
  eventEndTime: z.string().optional(),
};

export const WEATHER_RESPONSE = z.looseObject({
  currentWeather: currentWeather.optional(),
  forecastHourly: z.looseObject({ metadata, hours: z.array(hour) }).optional(),
  forecastDaily: z.looseObject({ metadata, days: z.array(day) }).optional(),
  forecastNextHour: z
    .looseObject({ metadata, forecastStart: z.string().optional(), forecastEnd: z.string().optional(), summary: z.array(period) })
    .optional(),
  weatherAlerts: z
    .looseObject({ metadata, detailsUrl: z.string().optional(), alerts: z.array(z.looseObject(alertSummaryFields)) })
    .optional(),
});

/**
 * `WeatherAlert` is documented as `{area, messages}` only; the summary fields
 * are optional here because whether the detail repeats them is not documented.
 */
export const ALERT_RESPONSE = z.looseObject({
  messages: z.array(z.looseObject({ language: z.string().optional(), text: z.string().optional() })),
  id: alertSummaryFields.id.optional(),
  description: alertSummaryFields.description.optional(),
  severity: alertSummaryFields.severity.optional(),
  source: alertSummaryFields.source.optional(),
  detailsUrl: alertSummaryFields.detailsUrl,
});
