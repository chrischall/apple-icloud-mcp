import { readEnvVar } from '@chrischall/mcp-utils';
import { errorMessage } from '../errors.js';
import { makeProbe, type HealthProbe } from '../health.js';
import { REJECTED_HINT, resolveICloudCredentials } from '../icloud-auth.js';
import { NS } from '../dav/xml.js';
import { chooseTargetCalendar, defaultContext, listCalendars, type ContextFactory } from './caldav.js';

/**
 * `calendarHealth`: are iCloud credentials configured (no network), and does
 * CalDAV accept them right now — discovery (cached after the first run) plus
 * one Depth-0 PROPFIND of the calendar home. When ICLOUD_DEFAULT_CALENDAR is
 * set, the calendars are listed too and a default that is not one of THIS
 * account's calendars is reported (it is deployment-wide; calendars are per
 * account, so it can be right for one person and wrong for the next).
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
      const notes = [`Calendar home reached (discovery: ${ctx.source ?? 'discovered'}).`];
      if (readEnvVar('ICLOUD_DEFAULT_CALENDAR') !== undefined) {
        const { calendars } = await listCalendars(ctx);
        try {
          const chosen = chooseTargetCalendar(calendars, undefined);
          notes.push(chosen.warning ?? `ICLOUD_DEFAULT_CALENDAR is "${chosen.calendar.name}".`);
        } catch (err) {
          notes.push(`New events have no default calendar: ${errorMessage(err)}`);
        }
      }
      return { notes };
    },
    rejectedHint: REJECTED_HINT,
  });
}

export const calendarHealth: HealthProbe = createCalendarHealth();
