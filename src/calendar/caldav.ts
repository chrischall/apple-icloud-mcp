import { mapWithConcurrency, readEnvVar } from '@chrischall/mcp-utils';
import { AppleToolError, InvalidArgumentError, UpstreamError } from '../errors.js';
import { childUrl, lastPathSegment, sameResource, type DavClient } from '../dav/client.js';
import { getDavContext } from '../dav/icloud.js';
import { NS, calendarQueryBody, clark } from '../dav/xml.js';
import { decodeIdPart, encodeIdPart } from './ids.js';
import { normalizeAddress } from './ics.js';

/**
 * The CalDAV side of the calendar tools: which calendars exist, which events
 * a window holds, and one event resource by id. Built on `src/dav/*`
 * (discovery, Basic auth, the credential latch, 207 parsing).
 */

/** What the tools need from a DAV context (`getDavContext('calendar')` by default). */
export interface CalendarContext {
  client: DavClient;
  homeUrl: string;
  principalUrl: string;
  /** Where discovery came from (`discovered` / `memory` / `disk`), when known. */
  source?: string;
}

export type ContextFactory = () => Promise<CalendarContext>;

/** Reads ICLOUD_USERNAME / ICLOUD_APP_PASSWORD now and returns the account's client + calendar home. */
export const defaultContext: ContextFactory = () => getDavContext('calendar');

export interface CalendarInfo {
  /** The id tools print and accept (the collection's last path segment, escaped). */
  id: string;
  name: string;
  url: string;
  color?: string;
  description?: string;
  order?: number;
  /** Whether the account may add/edit events here; undefined when iCloud did not say. */
  writable?: boolean;
  /** Shared with this account by someone else. */
  shared?: boolean;
  /** The calendar's own zone (`calendar-timezone`), informational. */
  timeZone?: string;
}

export interface CalendarListing {
  calendars: CalendarInfo[];
  /** Collections that are not event calendars: task (VTODO-only) lists and subscribed (webcal) calendars. */
  skipped: { taskLists: number; subscribed: number };
}

const CALENDAR_PROPS = [
  [NS.DAV, 'displayname'],
  [NS.DAV, 'resourcetype'],
  [NS.DAV, 'current-user-privilege-set'],
  [NS.APPLE, 'calendar-color'],
  [NS.APPLE, 'calendar-order'],
  [NS.CALDAV, 'supported-calendar-component-set'],
  [NS.CALDAV, 'calendar-description'],
  [NS.CALDAV, 'calendar-timezone'],
] as const;

/**
 * The account's event calendars (PROPFIND the home, Depth 1): the home
 * itself, inbox/outbox/notification collections, task lists and subscribed
 * calendars are left out (and counted). Ordered as Apple orders them.
 */
export async function listCalendars(ctx: CalendarContext): Promise<CalendarListing> {
  const listing = await ctx.client.propfind(ctx.homeUrl, CALENDAR_PROPS, 1);
  const calendars: CalendarInfo[] = [];
  const skipped = { taskLists: 0, subscribed: 0 };
  for (const r of listing.responses) {
    if (sameResource(r.url, ctx.homeUrl) || r.status !== undefined) continue;
    const types = r.props.childNames(NS.DAV, 'resourcetype');
    if (types.includes(clark(NS.CS, 'subscribed'))) {
      skipped.subscribed += 1;
      continue;
    }
    if (!types.includes(clark(NS.CALDAV, 'calendar'))) continue;
    const comps = r.props.compNames();
    // No component set means "any component" (RFC 4791 §5.2.3).
    if (comps.length > 0 && !comps.includes('VEVENT')) {
      skipped.taskLists += 1;
      continue;
    }
    const segment = lastPathSegment(r.url);
    const color = /^#[0-9A-Fa-f]{6}/.exec(r.props.text(NS.APPLE, 'calendar-color') ?? '')?.[0];
    const orderText = r.props.text(NS.APPLE, 'calendar-order');
    const order = orderText !== undefined && /^-?\d+$/.test(orderText) ? Number(orderText) : undefined;
    const privs = r.props.privileges();
    const tzid = /^TZID:(.+)$/m.exec(r.props.text(NS.CALDAV, 'calendar-timezone') ?? '')?.[1];
    calendars.push({
      id: encodeIdPart(segment),
      name: r.props.text(NS.DAV, 'displayname') || segment,
      url: r.url,
      ...(color ? { color } : {}),
      ...(r.props.text(NS.CALDAV, 'calendar-description') ? { description: r.props.text(NS.CALDAV, 'calendar-description') as string } : {}),
      ...(order !== undefined ? { order } : {}),
      ...(r.props.has(NS.DAV, 'current-user-privilege-set')
        ? { writable: privs.includes(clark(NS.DAV, 'bind')) || privs.includes(clark(NS.DAV, 'write-content')) }
        : {}),
      ...(types.includes(clark(NS.CS, 'shared')) ? { shared: true } : {}),
      ...(tzid ? { timeZone: tzid.trim() } : {}),
    });
  }
  const rank = (c: CalendarInfo) => c.order ?? Number.MAX_SAFE_INTEGER;
  calendars.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return { calendars, skipped };
}

function available(all: readonly CalendarInfo[]): string {
  return all.length === 0 ? '(none)' : all.map((c) => `"${c.name}" (id ${c.id})`).join(', ');
}

/** The calendar a name or id refers to: an exact id first, then a case-insensitive name. */
export function resolveCalendar(all: readonly CalendarInfo[], ref: string, argName: string): CalendarInfo {
  const byId = all.find((c) => c.id === ref || decodeIdPart(c.id) === ref);
  if (byId) return byId;
  const wanted = ref.trim().toLowerCase();
  const byName = all.filter((c) => c.name.trim().toLowerCase() === wanted);
  if (byName.length === 1) return byName[0] as CalendarInfo;
  if (byName.length > 1) {
    throw new InvalidArgumentError(
      `${argName} "${ref}" matches ${byName.length} calendars with that name: ${available(byName)}.`,
      'Pass the calendar id instead of its name.',
    );
  }
  throw new InvalidArgumentError(`${argName} "${ref}" is not one of your event calendars. Available: ${available(all)}.`, 'Use apple_calendar_list_calendars to see them.');
}

/** Every calendar named in `refs` (deduplicated, in order), or all of them. */
export function resolveCalendars(all: readonly CalendarInfo[], refs: readonly string[] | undefined): CalendarInfo[] {
  if (refs === undefined) return [...all];
  const out: CalendarInfo[] = [];
  for (const ref of refs) {
    const cal = resolveCalendar(all, ref, 'calendars entry');
    if (!out.includes(cal)) out.push(cal);
  }
  return out;
}

/**
 * The calendar a new event goes into: `calendar` if given, else
 * ICLOUD_DEFAULT_CALENDAR (read now), else the first writable one. A named
 * calendar that does not exist is an error listing the real ones — never a
 * silent fall-back to another calendar.
 */
export function chooseTargetCalendar(all: readonly CalendarInfo[], ref: string | undefined): { calendar: CalendarInfo; reason: string } {
  if (ref !== undefined) return { calendar: resolveCalendar(all, ref, 'calendar'), reason: 'named in the request' };
  const fromEnv = readEnvVar('ICLOUD_DEFAULT_CALENDAR');
  if (fromEnv !== undefined) return { calendar: resolveCalendar(all, fromEnv, 'ICLOUD_DEFAULT_CALENDAR'), reason: 'ICLOUD_DEFAULT_CALENDAR' };
  const first = all.find((c) => c.writable === true) ?? all.find((c) => c.writable === undefined);
  if (!first) {
    throw new AppleToolError('NOT_FOUND', `calendar: there is no writable event calendar to add the event to. Calendars: ${available(all)}.`, {
      hint: 'Create a calendar in Apple Calendar, or pass calendar explicitly.',
    });
  }
  return { calendar: first, reason: 'the first writable calendar (set ICLOUD_DEFAULT_CALENDAR or pass calendar to choose)' };
}

/** Refuse up front to write into a calendar iCloud says is read-only. */
export function assertWritable(cal: CalendarInfo): void {
  if (cal.writable === false) {
    throw new AppleToolError('UNSUPPORTED', `calendar: "${cal.name}" is read-only for this account (shared read-only or subscribed).`, {
      hint: 'Choose a calendar you own; apple_calendar_list_calendars shows which are writable.',
    });
  }
}

/** One iCalendar resource (an event, possibly a whole recurring series). */
export interface EventResource {
  calendar: CalendarInfo;
  /** The resource's file name (`<uid>.ics`). */
  name: string;
  url: string;
  etag?: string;
  ics: string;
}

export interface CalendarQueryResult {
  calendar: CalendarInfo;
  resources: EventResource[];
  /** Responses that carried no calendar-data (reported, not hidden). */
  unreadable: number;
  /**
   * The server cut the result short: it answered `507 Insufficient Storage`
   * for the calendar itself (RFC 4918's "number of matches within limits"),
   * so events are missing from `resources`.
   */
  truncatedByServer?: true;
}

/** A day of slack on each side of the server-side query: iCloud evaluates floating/all-day values in its own zone. */
const QUERY_SLACK_MS = 86_400_000;

/**
 * Every event resource in `cal` with an instance in `[from, to)` (widened by
 * a day each side; the caller filters exactly). Recurring series come back
 * as masters for client-side expansion.
 */
export async function queryCalendar(ctx: CalendarContext, cal: CalendarInfo, from: Date, to: Date): Promise<CalendarQueryResult> {
  const body = calendarQueryBody({
    timeRange: { start: new Date(from.getTime() - QUERY_SLACK_MS), end: new Date(to.getTime() + QUERY_SLACK_MS) },
  });
  const ms = await ctx.client.report(cal.url, body, 1);
  const resources: EventResource[] = [];
  let unreadable = 0;
  let truncatedByServer = false;
  for (const r of ms.responses) {
    // iCloud lists the collection itself among the results — as a 507 when it truncated them.
    if (sameResource(r.url, cal.url)) {
      truncatedByServer ||= r.status === 507;
      continue;
    }
    if (r.status === 404) continue;
    const ics = r.props.rawText(NS.CALDAV, 'calendar-data');
    if (ics === undefined || ics.trim() === '') {
      unreadable += 1;
      continue;
    }
    const etag = r.props.text(NS.DAV, 'getetag');
    resources.push({ calendar: cal, name: lastPathSegment(r.url), url: r.url, ...(etag ? { etag } : {}), ics });
  }
  return { calendar: cal, resources, unreadable: unreadable + ms.skipped, ...(truncatedByServer ? { truncatedByServer: true as const } : {}) };
}

export type QueryOutcome = { ok: true; result: CalendarQueryResult } | { ok: false; calendar: CalendarInfo; error: unknown };

/** Query several calendars, four at a time, keeping each one's outcome (the caller decides what a failure means). */
export async function queryCalendars(ctx: CalendarContext, cals: readonly CalendarInfo[], from: Date, to: Date): Promise<QueryOutcome[]> {
  return mapWithConcurrency(cals, 4, async (cal): Promise<QueryOutcome> => {
    try {
      return { ok: true, result: await queryCalendar(ctx, cal, from, to) };
    } catch (error) {
      return { ok: false, calendar: cal, error };
    }
  });
}

/** GET one event resource. A missing one is NOT_FOUND with a message that names it. */
export async function fetchEvent(ctx: CalendarContext, cal: CalendarInfo, name: string, displayId: string): Promise<EventResource> {
  const url = childUrl(cal.url, name);
  try {
    const got = await ctx.client.get(url);
    return { calendar: cal, name, url, ...(got.etag ? { etag: got.etag } : {}), ics: got.body };
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 404) {
      throw new AppleToolError('NOT_FOUND', `calendar: event ${displayId} was not found in "${cal.name}" — it may have been deleted or moved.`, {
        hint: 'List the events again to get current ids.',
      });
    }
    throw err;
  }
}

/**
 * The account owner's calendar-user addresses (`calendar-user-address-set`
 * on the principal, plus the Apple ID), normalised — how "is this attendee
 * me?" is answered. iCloud rewrites the owner's ATTENDEE to a principal path,
 * which is in this set too.
 */
export async function selfAddresses(ctx: CalendarContext): Promise<{ addresses: Set<string>; organizer: string }> {
  const ms = await ctx.client.propfind(ctx.principalUrl, [[NS.CALDAV, 'calendar-user-address-set']], 0);
  const hrefs = ms.responses.flatMap((r) => r.props.hrefs(NS.CALDAV, 'calendar-user-address-set'));
  const addresses = new Set(hrefs.map(normalizeAddress));
  const username = ctx.client.username;
  if (username.includes('@')) addresses.add(`mailto:${username.toLowerCase()}`);
  const mailtos = hrefs.filter((h) => /^mailto:/i.test(h)).map((h) => h.slice(7));
  const organizer = mailtos.find((m) => m.toLowerCase() === username.toLowerCase()) ?? mailtos[0] ?? username;
  return { addresses, organizer };
}
