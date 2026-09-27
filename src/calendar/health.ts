import { readEnvVar } from '@chrischall/mcp-utils';
import { makeProbe, type HealthProbe } from '../health.js';
import { REJECTED_HINT, resolveICloudCredentials } from '../icloud-auth.js';
import { NS } from '../dav/xml.js';
import { defaultContext, type ContextFactory } from './caldav.js';

/**
 * `calendarHealth`: are iCloud credentials configured (no network), and does
 * CalDAV accept them right now — discovery (cached after the first run) plus
 * one Depth-0 PROPFIND of the calendar home.
 */
export function createCalendarHealth(context: ContextFactory = defaultContext): HealthProbe {
  return makeProbe({
    service: 'calendar',
    probe: 'CalDAV discovery + PROPFIND calendar home (Depth 0)',
    resolve: () => {
      const creds = resolveICloudCredentials('calendar');
      const defaultCalendar = readEnvVar('ICLOUD_DEFAULT_CALENDAR');
      return {
        source: 'ICLOUD_USERNAME + ICLOUD_APP_PASSWORD',
        detail: { appleId: creds.username, ...(defaultCalendar !== undefined ? { defaultCalendar } : {}) },
      };
    },
    run: async () => {
      const ctx = await context();
      await ctx.client.propfind(ctx.homeUrl, [[NS.DAV, 'resourcetype']], 0);
      return { notes: [`Calendar home reached (discovery: ${ctx.source ?? 'discovered'}).`] };
    },
    rejectedHint: REJECTED_HINT,
  });
}

export const calendarHealth: HealthProbe = createCalendarHealth();
