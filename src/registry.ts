import type { McpServer } from '@modelcontextprotocol/server';
import type { HealthProbe } from './health.js';
import { registerCalendarTools } from './calendar/tools.js';
import { calendarHealth } from './calendar/health.js';
import { registerContactsTools } from './contacts/tools.js';
import { contactsHealth } from './contacts/health.js';
import { registerItunesTools } from './itunes/tools.js';
import { itunesHealth } from './itunes/health.js';
import { registerMailTools } from './mail/tools.js';
import { mailHealth } from './mail/health.js';
import { registerMapsTools } from './maps/tools.js';
import { mapsHealth } from './maps/health.js';
import { registerMusicTools } from './music/tools.js';
import { musicHealth } from './music/health.js';
import { registerWeatherTools } from './weather/tools.js';
import { weatherHealth } from './weather/health.js';
import { registerHealthcheckTool } from './tools/healthcheck.js';

/**
 * Every service this server registers, in one list — the entry point serves
 * it, and tests/manifest-roster.test.ts registers it to check manifest.json.
 *
 * Each registrar is wrapped so it is called with the server ONLY: runMcp
 * passes its own `deps` as the second argument, and a module's optional deps
 * parameter must never receive another module's (or runMcp's) value.
 */
export const HEALTH_PROBES: readonly HealthProbe[] = [
  musicHealth,
  calendarHealth,
  contactsHealth,
  mailHealth,
  mapsHealth,
  weatherHealth,
  itunesHealth,
];

export const REGISTRARS: ReadonlyArray<(server: McpServer) => void> = [
  (server) => registerHealthcheckTool(server, HEALTH_PROBES),
  (server) => registerMusicTools(server),
  (server) => registerCalendarTools(server),
  (server) => registerContactsTools(server),
  (server) => registerMailTools(server),
  (server) => registerMapsTools(server),
  (server) => registerWeatherTools(server),
  (server) => registerItunesTools(server),
];
