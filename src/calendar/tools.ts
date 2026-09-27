import { randomUUID } from 'node:crypto';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { accessAllowed } from '../config.js';
import { AppleToolError, InvalidArgumentError, UnconfirmedWriteError, errorMessage, scrub } from '../errors.js';
import { ICALENDAR_CONTENT_TYPE, childUrl } from '../dav/client.js';
import { CONFIRM_NOTE, confirmTokenParam, confirmWrite, stateRevision } from '../tools/_confirm.js';
import { ANNOTATIONS, compactObject, defineTool, jsonResponse, limitParam, offsetParam, pageInfo, pagedResponse } from '../tools/_shared.js';
import {
  chooseTargetCalendar,
  assertWritable,
  defaultContext,
  fetchEvent,
  listCalendars,
  resolveCalendars,
  selfAddresses,
  type CalendarContext,
  type CalendarInfo,
  type ContextFactory,
} from './caldav.js';
import { buildNewEvent, checkRecurrenceStart, resolveNewTimes, type CreateInput } from './create.js';
import { occurrenceFor, planDelete, planUpdate, type PutOp, type Span, type UpdatePlan } from './edit.js';
import { assertOffset, collectOccurrences, loadEvent, type Row } from './events.js';
import { findOccurrence, overlaps, type Occurrence } from './expand.js';
import { LIST_NOTES_CHARS, formatOccurrence, whenLabel } from './format.js';
import { computeFreeTime, mergeIntervals, parseClock } from './freetime.js';
import { formatEventId, parseEventId } from './ids.js';
import { WEEKDAYS, eventParts, isSelf, parseCalendar, serialize, textProp } from './ics.js';
import type { Identity } from './series.js';
import { resolveWindow, resolveZone, windowJson, type Window } from './window.js';

/**
 * iCloud Calendar over CalDAV: list/search/read events, create/update/delete
 * them, and find free time. See the module files for the rules each layer
 * enforces; this file owns the tool surface, the confirm gate, the writes and
 * their verification.
 */

export interface CalendarDeps {
  /** The account's DAV client + calendar home (default: `getDavContext('calendar')`, which reads the env now). */
  context?: ContextFactory;
  /** Clock (default: the real one). */
  now?: () => Date;
  /** UID for new events and split-off series (default: an upper-case random UUID). */
  newUid?: () => string;
}

const MAX_RANGE_DAYS = 366;
const MAX_FREE_TIME_DAYS = 31;

// ---------------------------------------------------------------------------
// Schema pieces
// ---------------------------------------------------------------------------

const DATES_NOTE =
  'Dates are ISO-8601: YYYY-MM-DD, or YYYY-MM-DDTHH:MM[:SS] with an optional Z or ±HH:MM. A time without an offset is ' +
  'wall-clock time in timeZone (default DISPLAY_TZ), never UTC.';

const timeZoneParam = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe('IANA time zone (e.g. America/New_York) for dates you pass without an offset and for the times returned. Default: DISPLAY_TZ.');

const dateParam = (what: string) => z.string().min(1).max(40).optional().describe(what);

const windowShape = {
  fromDate: dateParam('Start of the window (inclusive). Default: the start of today.'),
  toDate: dateParam('End of the window (EXCLUSIVE). Do not combine with daysAhead.'),
  daysAhead: z.number().int().min(1).max(MAX_RANGE_DAYS).optional().describe('Window length in days from fromDate (instead of toDate).'),
};

const calendarsParam = z
  .array(z.string().min(1).max(200))
  .min(1)
  .max(50)
  .optional()
  .describe('Calendars to include, by name or id (from apple_calendar_list_calendars). Default: every event calendar.');

const eventIdParam = z
  .string()
  .min(3)
  .max(1024)
  .describe('Event id exactly as list/search printed it. A recurring occurrence\'s id ends in "#occ=…".');

const spanParam = z
  .enum(['thisEvent', 'futureEvents', 'allEvents'])
  .optional()
  .describe(
    'For a recurring event: thisEvent (default, the one occurrence the id names), futureEvents (it and every later one), ' +
      'or allEvents (the whole series; required when eventId has no "#occ=").',
  );

const textField = (what: string, max: number) => z.string().max(max).optional().describe(what);

const urlField = z
  .string()
  .max(2000)
  .refine((v) => v === '' || URL.canParse(v), 'must be an absolute URL')
  .optional();

const alarmsParam = z
  .array(z.number().int().min(0).max(40_320))
  .max(5)
  .optional()
  .describe('Alerts, in minutes before the start (0–40320, at most 5).');

const attendeesParam = z
  .array(
    z.strictObject({
      email: z.email().max(320).describe('Their e-mail address (where iCloud sends the invitation).'),
      name: z.string().min(1).max(200).optional().describe('Their name, as shown to other attendees.'),
    }),
  )
  .max(50)
  .refine((list) => new Set(list.map((a) => a.email.toLowerCase())).size === list.length, 'attendees must not repeat an email');

const recurrenceParam = z
  .strictObject({
    frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']).describe('How often it repeats.'),
    interval: z.number().int().min(1).max(999).optional().describe('Every N periods (default 1).'),
    count: z.number().int().min(1).max(1000).optional().describe('Stop after this many occurrences.'),
    until: z.string().min(1).max(40).optional().describe('Last date it may occur (inclusive). Not with count.'),
    byWeekday: z.array(z.enum(WEEKDAYS)).min(1).max(7).optional().describe('Weekdays it falls on, e.g. ["MO","WE"].'),
  })
  .refine((r) => r.count === undefined || r.until === undefined, 'pass count or until, not both')
  .optional()
  .describe('Make it repeat.');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function windowLabel(w: Window): string {
  const j = windowJson(w);
  return `${String(j.fromDisplay)} – ${String(j.toDisplay)}`;
}

/** A list/search row: notes cut to LIST_NOTES_CHARS (get_event returns them whole). */
function formatRow(row: Row, zone: string): Record<string, unknown> {
  return formatOccurrence(row.occurrence, { calendar: row.resource.calendar, baseId: row.baseId, zone, notesLimit: LIST_NOTES_CHARS });
}

function calendarJson(c: CalendarInfo): Record<string, unknown> {
  return compactObject({ id: c.id, name: c.name, color: c.color, writable: c.writable, shared: c.shared, description: c.description, timeZone: c.timeZone });
}

/** Re-throw a failure that happened after part of a write went through, saying exactly what did. */
export function partial(err: unknown, done: string): AppleToolError {
  const code = err instanceof AppleToolError ? err.code : 'UPSTREAM_ERROR';
  return new AppleToolError(code, `${done} ${errorMessage(err)}`, {
    hint: 'Re-read the event (apple_calendar_get_event or list_events) to see its current state before retrying.',
    cause: err,
  });
}

async function put(ctx: CalendarContext, op: PutOp): Promise<string | undefined> {
  const res = await ctx.client.put(op.url, op.body, ICALENDAR_CONTENT_TYPE, op.ifNoneMatch ? { ifNoneMatch: '*' } : { ifMatch: op.ifMatch as string });
  return res.etag;
}

const COMPARED_FIELDS: Record<string, string[]> = {
  title: ['title'],
  location: ['location'],
  notes: ['notes'],
  url: ['url'],
  alarms: ['alarms'],
  attendees: ['attendees'],
  startDate: ['isAllDay', 'start', 'end', 'startDate', 'endDate'],
  endDate: ['isAllDay', 'start', 'end', 'startDate', 'endDate'],
  isAllDay: ['isAllDay', 'start', 'end', 'startDate', 'endDate'],
  calendar: ['calendar'],
};

/** The output keys an update's arguments can change. */
function comparedKeys(args: Record<string, unknown>): string[] {
  const keys = new Set<string>();
  for (const [arg, outKeys] of Object.entries(COMPARED_FIELDS)) if (args[arg] !== undefined) for (const k of outKeys) keys.add(k);
  return [...keys];
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function emailsOf(list: unknown): string[] {
  return ((list as Array<{ email?: string }> | undefined) ?? []).map((a) => (a.email ?? '').toLowerCase());
}

/**
 * Whether a re-read field matches what was written. Attendees are compared by
 * who is invited: iCloud's scheduling fills in replies, and may list the
 * organizer as an attendee of their own event — neither means the write was
 * lost.
 */
function readsBack(key: string, actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  if (key !== 'attendees') return same(actual[key], expected[key]);
  const want = new Set(emailsOf(expected.attendees));
  const got = emailsOf(actual.attendees);
  // Undefined when there is no organizer e-mail: an attendee without an e-mail ('') must not pass as the organizer.
  const organizer = (actual.organizer as { email?: string } | undefined)?.email?.toLowerCase();
  return [...want].every((e) => got.includes(e)) && got.every((e) => want.has(e) || e === organizer);
}

function diff(before: Record<string, unknown>, after: Record<string, unknown>, keys: string[]): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const k of keys) if (!same(before[k], after[k])) out[k] = { before: before[k] ?? null, after: after[k] ?? null };
  return out;
}

interface Verification {
  verified: boolean;
  after: Record<string, unknown>;
  warnings: string[];
}

/**
 * Re-read what was written and compare the fields that were meant to
 * change. iCloud's reads can briefly lag its writes, so "not visible yet" is
 * a warning, not a failure: the write itself was acknowledged.
 */
async function verifyOccurrence(
  ctx: CalendarContext,
  target: { calendar: CalendarInfo; resourceName: string; eventId: string; expected: Record<string, unknown> },
  keys: string[],
  zone: string,
): Promise<Verification> {
  const unverified = (why: string): Verification => ({ verified: false, after: target.expected, warnings: [why] });
  const id = parseEventId(target.eventId);
  let parsedOcc: Occurrence | undefined;
  try {
    const res = await fetchEvent(ctx, target.calendar, target.resourceName, id.baseId);
    parsedOcc = occurrenceFor(eventParts(parseCalendar(res.ics, `event ${id.baseId}`)), id.occ, zone);
  } catch (err) {
    return unverified(
      err instanceof AppleToolError && err.code === 'NOT_FOUND'
        ? 'iCloud accepted the write, but the event is not visible on a re-read yet (its reads can lag writes). Check again shortly.'
        : `iCloud accepted the write, but re-reading it to verify failed (${errorMessage(err)}).`,
    );
  }
  if (!parsedOcc) return unverified('iCloud accepted the write, but the changed occurrence is not visible on a re-read yet. Check again shortly.');
  const actual = formatOccurrence(parsedOcc, { calendar: target.calendar, baseId: id.baseId, zone });
  const warnings: string[] = [];
  for (const k of keys) {
    if (!readsBack(k, actual, target.expected)) {
      warnings.push(`${k} reads back as ${JSON.stringify(actual[k] ?? null)}, not ${JSON.stringify(target.expected[k] ?? null)} as written.`);
    }
  }
  return { verified: warnings.length === 0, after: actual, warnings };
}

/** The account's identity, fetched only when attendees are involved. */
async function identity(ctx: CalendarContext): Promise<Identity> {
  const me = await selfAddresses(ctx);
  return { self: me.addresses, organizer: me.organizer };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCalendarTools(server: McpServer, deps: CalendarDeps = {}): void {
  const context = deps.context ?? defaultContext;
  const now = deps.now ?? (() => new Date());
  const newUid = deps.newUid ?? (() => randomUUID().toUpperCase());

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_calendar_list_calendars',
    title: 'List your iCloud calendars',
    service: 'calendar',
    access: 'read',
    description:
      'List your iCloud calendars (event calendars only): id, name, color, whether you can add events to it, and which one new ' +
      'events go into by default. Use the name or id with the other apple_calendar_* tools. Needs ICLOUD_USERNAME and ' +
      'ICLOUD_APP_PASSWORD (an app-specific password).',
    inputSchema: z.strictObject({}),
    annotations: ANNOTATIONS.read,
    handler: async () => {
      const ctx = await context();
      const { calendars, skipped } = await listCalendars(ctx);
      const notes: string[] = [];
      let defaultForNewEvents: Record<string, unknown> | undefined;
      try {
        const chosen = chooseTargetCalendar(calendars, undefined);
        defaultForNewEvents = { id: chosen.calendar.id, name: chosen.calendar.name, reason: chosen.reason };
      } catch (err) {
        notes.push(`No default calendar for new events: ${errorMessage(err)}`);
      }
      if (skipped.taskLists > 0) notes.push(`${skipped.taskLists} task (reminder) list(s) are not event calendars and are not listed.`);
      if (skipped.subscribed > 0) notes.push(`${skipped.subscribed} subscribed calendar(s) are not stored on iCloud's calendar server and are not listed.`);
      if (calendars.length === 0) notes.push('This iCloud account has no event calendars.');
      return jsonResponse({
        count: calendars.length,
        ...(defaultForNewEvents ? { defaultForNewEvents } : {}),
        ...(notes.length ? { notes } : {}),
        calendars: calendars.map(calendarJson),
      });
    },
  });

  // -------------------------------------------------------------------------
  const listOrSearch = async (
    args: { fromDate?: string; toDate?: string; daysAhead?: number; calendars?: string[]; limit?: number; offset?: number; timeZone?: string },
    opts: { defaultDays: number; defaultLimit: number; query?: string },
  ) => {
    const zone = resolveZone(args.timeZone);
    const win = resolveWindow(args, { zone, now: now(), defaultDays: opts.defaultDays, maxDays: MAX_RANGE_DAYS });
    const ctx = await context();
    const { calendars } = await listCalendars(ctx);
    const selected = resolveCalendars(calendars, args.calendars);
    const collected = await collectOccurrences(ctx, selected, win);
    let rows = collected.rows;
    const notes = [...collected.notes];
    if (opts.query !== undefined) {
      const q = opts.query.toLowerCase();
      rows = rows.filter((r) =>
        ['summary', 'location', 'description'].some((p) => (textProp(r.occurrence.comp, p) ?? '').toLowerCase().includes(q)),
      );
    }
    const offset = args.offset ?? 0;
    const limit = args.limit ?? opts.defaultLimit;
    assertOffset(offset, rows.length);
    const page = rows.slice(offset, offset + limit).map((r) => formatRow(r, zone));
    const names = selected.map((c) => `"${c.name}"`).join(', ') || '(no calendars)';
    const scope = opts.query !== undefined ? `events matching "${opts.query}" (title, location or notes)` : 'events';
    if (rows.length === 0) notes.push(`No ${scope} in ${windowLabel(win)} in ${names}.`);
    notes.push(`Only ${windowLabel(win)} was searched; nothing outside that window was examined.`);
    const paging = pageInfo({ offset, limit, returned: page.length, total: rows.length });
    return jsonResponse(
      pagedResponse(paging, 'events', page, {
        totalMatched: rows.length,
        // Every matching event in the window is in THIS payload: nothing on another page, nothing missing.
        complete: collected.complete && !paging.hasMore && offset === 0,
        window: windowJson(win),
        calendarsSearched: selected.map((c) => c.name),
        ...(collected.failed.length ? { failedCalendars: collected.failed } : {}),
        notes,
      }),
    );
  };

  defineTool(server, {
    name: 'apple_calendar_list_events',
    title: 'List iCloud Calendar events in a date range',
    service: 'calendar',
    access: 'read',
    description:
      'List iCloud Calendar events (appointments, meetings) in a date window, recurring events expanded into occurrences, ' +
      'sorted by start. Window: fromDate (default today) + toDate (exclusive) or daysAhead (default 7), max 366 days; the ' +
      'window is always stated. Filter by calendars; page with limit/offset (totalMatched, nextOffset). Each event has an id ' +
      'for get/update/delete. ' +
      DATES_NOTE,
    inputSchema: z.strictObject({
      ...windowShape,
      calendars: calendarsParam,
      limit: limitParam(100, 500),
      offset: offsetParam,
      timeZone: timeZoneParam,
    }),
    annotations: ANNOTATIONS.read,
    handler: (args) => listOrSearch(args, { defaultDays: 7, defaultLimit: 100 }),
  });

  defineTool(server, {
    name: 'apple_calendar_search_events',
    title: 'Search iCloud Calendar events',
    service: 'calendar',
    access: 'read',
    description:
      'Search iCloud Calendar events by text (case-insensitive match in title, location or notes) within a date window: ' +
      'fromDate (default today; may be in the past) + toDate or daysAhead (default 30), max 366 days. Only that window is ' +
      'searched, and the response says so. Returns matching occurrences sorted by start, with ids. ' +
      DATES_NOTE,
    inputSchema: z.strictObject({
      query: z.string().min(1).max(200).describe('Text to find in the title, location or notes.'),
      ...windowShape,
      calendars: calendarsParam,
      limit: limitParam(50, 500),
      offset: offsetParam,
      timeZone: timeZoneParam,
    }),
    annotations: ANNOTATIONS.read,
    handler: ({ query, ...args }) => listOrSearch(args, { defaultDays: 30, defaultLimit: 50, query }),
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_calendar_get_event',
    title: 'Get an iCloud Calendar event',
    service: 'calendar',
    access: 'read',
    description:
      'Get one iCloud Calendar event in full (notes untruncated, attendees, alerts, recurrence rule in plain English) by the ' +
      'id list/search returned. An id ending in "#occ=…" is that one occurrence; a bare recurring id describes the series. ' +
      'includeIcs adds the raw iCalendar (lines unfolded, account ids redacted).',
    inputSchema: z.strictObject({
      eventId: eventIdParam,
      includeIcs: z.boolean().optional().describe('Also return the raw iCalendar text of the whole event resource.'),
      timeZone: timeZoneParam,
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const zone = resolveZone(args.timeZone);
      const ctx = await context();
      const loaded = await loadEvent(ctx, args.eventId, zone);
      const event = formatOccurrence(loaded.target, { calendar: loaded.calendar, baseId: loaded.id.baseId, zone });
      const notes: string[] = [];
      if (loaded.recurring && loaded.id.occ === undefined) {
        notes.push(
          'This id names the whole recurring series; start/end are its first occurrence. List the events over a date to get ' +
            'the id of one occurrence.',
        );
      }
      return jsonResponse({
        event,
        ...(notes.length ? { notes } : {}),
        // Unfolded first: a line fold can split the account id (DSID) in a principal path, and scrub matches it whole.
        ...(args.includeIcs ? { ics: scrub(loaded.resource.ics.replace(/\r?\n[ \t]/g, '')) } : {}),
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_calendar_create_event',
    title: 'Create an iCloud Calendar event',
    service: 'calendar',
    access: 'additive',
    description:
      'Create an iCloud Calendar event: title, startDate/endDate (timed default 1 hour; all-day endDate = last day), ' +
      'location, notes, url, alarms, recurrence, attendees. Goes into calendar, else ICLOUD_DEFAULT_CALENDAR, else the first ' +
      'writable one. Attendees make iCloud email invitations (APPLE_WRITE_MODE=all only), so then it asks first. ' +
      CONFIRM_NOTE,
    inputSchema: z.strictObject({
      calendar: z.string().min(1).max(200).optional().describe('Calendar name or id. Default: ICLOUD_DEFAULT_CALENDAR, else the first writable calendar.'),
      title: z.string().min(1).max(1000).describe('Event title.'),
      startDate: z.string().min(1).max(40).describe('Start: YYYY-MM-DDTHH:MM (timed) or YYYY-MM-DD (all-day).'),
      endDate: dateParam('End (timed; default start + 1 hour) or LAST day (all-day, inclusive; default the start day).'),
      isAllDay: z.boolean().optional().describe('All-day event. Default: true when startDate is a bare date.'),
      timeZone: timeZoneParam,
      location: textField('Location.', 1000),
      notes: textField('Notes.', 20_000),
      url: urlField.describe('A link to attach.'),
      alarms: alarmsParam,
      recurrence: recurrenceParam,
      attendees: attendeesParam.optional().describe('People to invite. iCloud emails each one an invitation.'),
      confirmToken: confirmTokenParam,
    }),
    annotations: ANNOTATIONS.additive,
    handler: async (args, ctx: ServerContext) => {
      const zone = resolveZone(args.timeZone);
      const invites = args.attendees ?? [];
      if (invites.length > 0 && !accessAllowed('all')) {
        throw new AppleToolError(
          'UNSUPPORTED',
          'An event with attendees makes iCloud email invitations to other people, which APPLE_WRITE_MODE=additive never allows. Nothing was created.',
          { hint: 'Create it without attendees, or set APPLE_WRITE_MODE=all.' },
        );
      }
      const input: CreateInput = compactObject({
        title: args.title,
        startDate: args.startDate,
        endDate: args.endDate,
        isAllDay: args.isAllDay,
        location: args.location,
        notes: args.notes,
        url: args.url,
        alarms: args.alarms,
        recurrence: args.recurrence,
        attendees: args.attendees,
      }) as CreateInput;
      const times = resolveNewTimes(input, zone);
      checkRecurrenceStart(input.recurrence, times, zone);
      const dav = await context();
      const { calendars } = await listCalendars(dav);
      const { calendar, reason } = chooseTargetCalendar(calendars, args.calendar);
      assertWritable(calendar);
      const who = invites.length > 0 ? await identity(dav) : undefined;
      const uid = newUid();
      const stamp = now();
      const vcal = buildNewEvent(input, { zone, now: stamp, uid, times, ...(who ? { organizer: who.organizer } : {}) });
      const draft = occurrenceFor(eventParts(vcal), undefined, zone) as Occurrence;
      const planned = formatOccurrence(draft, { calendar, baseId: formatEventId(calendar.id, `${uid}.ics`), zone });

      if (invites.length > 0) {
        const gate = await confirmWrite(ctx, {
          tool: 'apple_calendar_create_event',
          action: 'apple.calendar.event.create',
          message: `Create "${args.title}" and have iCloud email an invitation to ${invites.length} ${invites.length === 1 ? 'person' : 'people'}?`,
          target: `calendar:${calendar.id}/new`,
          payload: { calendar: calendar.id, ...input },
          preview: compactObject({
            event: args.title,
            when: whenLabel(draft, zone),
            calendar: calendar.name,
            location: args.location || undefined,
            repeats: (planned.recurrence as { summary: string } | undefined)?.summary,
            invitations: invites.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', '),
            organizer: (who as Identity).organizer,
            notice: 'iCloud will email each attendee an invitation as soon as the event is saved.',
          }),
          args,
          confirmToken: args.confirmToken,
        });
        if (gate) return gate;
      }

      const url = childUrl(calendar.url, `${uid}.ics`);
      await dav.client.put(url, serialize(vcal), ICALENDAR_CONTENT_TYPE, { ifNoneMatch: '*' });
      const check = await verifyOccurrence(
        dav,
        { calendar, resourceName: `${uid}.ics`, eventId: String(planned.id), expected: planned },
        ['title', 'isAllDay', 'start', 'end', 'startDate', 'endDate'],
        zone,
      );
      const notes: string[] = [`Calendar: "${calendar.name}" (${reason}).`];
      if (args.recurrence) notes.push('This id names the whole series; list the events to get the id of one occurrence.');
      if (invites.length > 0) notes.push('iCloud sends the invitations itself; each attendee\'s reply shows up in their status on this event.');
      return jsonResponse({
        created: true,
        verified: check.verified,
        eventId: planned.id,
        ...(check.warnings.length ? { warnings: check.warnings } : {}),
        notes,
        event: check.after,
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_calendar_update_event',
    title: 'Change an iCloud Calendar event',
    service: 'calendar',
    access: 'all',
    description:
      'Change an iCloud Calendar event: title, startDate/endDate, isAllDay, location, notes, url ("" clears), alarms, ' +
      'attendees (full new list), calendar (moves it). Recurring: span thisEvent (default, "#occ=" id), futureEvents (splits ' +
      'the series) or allEvents. Returns before/after. With attendees iCloud emails them, so it asks first. ' +
      CONFIRM_NOTE,
    inputSchema: z.strictObject({
      eventId: eventIdParam,
      span: spanParam,
      title: z.string().min(1).max(1000).optional().describe('New title.'),
      startDate: dateParam('New start. Moving only the start keeps the event\'s length.'),
      endDate: dateParam('New end (all-day: the LAST day, inclusive).'),
      isAllDay: z.boolean().optional().describe('Switch between all-day and timed (not for recurring events).'),
      timeZone: timeZoneParam.describe(
        'IANA time zone. With startDate/endDate: offset-less dates are read in it AND the event is stored in it from now on ' +
          '(a repeating event then follows its daylight-saving changes). Omit it to keep the event\'s own zone. Times are ' +
          'returned in it. Default: DISPLAY_TZ.',
      ),
      location: textField('New location ("" clears).', 1000),
      notes: textField('New notes ("" clears).', 20_000),
      url: urlField.describe('New link ("" clears).'),
      alarms: alarmsParam,
      attendees: attendeesParam.optional().describe('The complete new list of invitees ([] removes everyone). iCloud emails them.'),
      calendar: z.string().min(1).max(200).optional().describe('Move the event to this calendar (name or id).'),
      confirmToken: confirmTokenParam,
    }),
    annotations: ANNOTATIONS.update,
    handler: async (args, ctx: ServerContext) => {
      const zone = resolveZone(args.timeZone);
      const dav = await context();
      const loaded = await loadEvent(dav, args.eventId, zone);
      const who = args.attendees !== undefined ? await identity(dav) : undefined;
      const stamp = now();
      const plan: UpdatePlan = planUpdate(loaded, { ...args, span: args.span ?? 'thisEvent' }, { zone, now: stamp, newUid, ...(who ? { who } : {}) });
      const keys = comparedKeys(args);
      const expectedChanges = diff(plan.before, plan.result.expected, keys);

      if (plan.notifiesAttendees) {
        const attendees = (plan.result.expected.attendees ?? plan.before.attendees) as Array<{ name?: string; email?: string }> | undefined;
        const gate = await confirmWrite(ctx, {
          tool: 'apple_calendar_update_event',
          action: 'apple.calendar.event.update',
          message: `Change "${String(plan.before.title)}" (${plan.scope})? It has attendees, so iCloud will email them the update.`,
          target: `event:${loaded.id.baseId}`,
          revision: loaded.resource.etag ?? stateRevision(loaded.resource.ics),
          payload: { ...args, confirmToken: undefined, span: plan.span },
          preview: compactObject({
            event: plan.before.title,
            when: whenLabel(loaded.target, zone),
            calendar: plan.move ? `${loaded.calendar.name} → ${plan.move.name}` : loaded.calendar.name,
            applies: plan.scope,
            changes: Object.entries(expectedChanges).map(([k, v]) => `${k}: ${JSON.stringify(v.before)} → ${JSON.stringify(v.after)}`),
            attendees: attendees?.map((a) => a.name ?? a.email ?? '(unknown)').join(', '),
            notice: 'iCloud will email the attendees about this change.',
          }),
          args,
          confirmToken: args.confirmToken,
        });
        if (gate) return gate;
      }

      let first = plan.puts[0];
      let firstEtag: string | undefined;
      if (plan.move) {
        const dest = childUrl(plan.move.url, loaded.resource.name);
        await dav.client.move(loaded.resource.url, dest, { ifMatch: loaded.resource.etag ?? '*' });
        if (first) {
          try {
            const moved = await dav.client.get(dest);
            first = { ...first, url: dest, ifMatch: moved.etag ?? '*' };
            await put(dav, first);
          } catch (err) {
            throw partial(err, `The event was moved to "${plan.move.name}", but applying the other changes failed:`);
          }
        }
      } else {
        firstEtag = await put(dav, first as PutOp);
      }
      const second = plan.puts[1];
      if (second) {
        try {
          await put(dav, second);
        } catch (err) {
          if (err instanceof UnconfirmedWriteError) {
            throw partial(
              err,
              `The original series now ends before this occurrence, but creating the new series ${plan.newSeriesId as string} may or may not have succeeded:`,
            );
          }
          // A definitive refusal: nothing was created, so put the original series back as it was — over our own
          // truncation (its ETag). Only when iCloud sent no ETag for that write is it restored unconditionally.
          try {
            await dav.client.put(loaded.resource.url, loaded.resource.ics, ICALENDAR_CONTENT_TYPE, { ifMatch: firstEtag ?? '*' });
          } catch (rollbackErr) {
            throw partial(
              err,
              `The original series was ended before this occurrence, the new series could not be created, and restoring the original failed (${errorMessage(rollbackErr)}). The failure:`,
            );
          }
          throw partial(err, 'Nothing was changed (the original series was restored): creating the new series failed:');
        }
      }

      const check = await verifyOccurrence(dav, plan.result, keys, zone);
      return jsonResponse({
        updated: true,
        verified: check.verified,
        applied: plan.scope,
        eventId: plan.result.eventId,
        ...(plan.newSeriesId ? { newSeriesId: plan.newSeriesId } : {}),
        changes: diff(plan.before, check.after, keys),
        ...(check.warnings.length ? { warnings: check.warnings } : {}),
        ...(plan.notes.length ? { notes: plan.notes } : {}),
        event: check.after,
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_calendar_delete_event',
    title: 'Delete an iCloud Calendar event',
    service: 'calendar',
    access: 'all',
    description:
      'Delete an iCloud Calendar event. Recurring: span thisEvent (default; the one occurrence an "#occ=" id names), ' +
      'futureEvents (it and all later ones) or allEvents (the whole series). Calendar has no trash. If the event has ' +
      'attendees iCloud emails them a cancellation. ' +
      CONFIRM_NOTE,
    inputSchema: z.strictObject({
      eventId: eventIdParam,
      span: spanParam,
      timeZone: timeZoneParam,
      confirmToken: confirmTokenParam,
    }),
    annotations: ANNOTATIONS.remove,
    handler: async (args, ctx: ServerContext) => {
      const zone = resolveZone(args.timeZone);
      const dav = await context();
      const loaded = await loadEvent(dav, args.eventId, zone);
      const span: Span = args.span ?? 'thisEvent';
      const plan = planDelete(loaded, span, { zone, now: now() });
      const gate = await confirmWrite(ctx, {
        tool: 'apple_calendar_delete_event',
        action: 'apple.calendar.event.delete',
        message: `Permanently delete "${String(plan.preview.event)}" (${plan.scope})? Calendar has no trash; it cannot be undone.`,
        target: `event:${loaded.id.baseId}`,
        revision: loaded.resource.etag ?? stateRevision(loaded.resource.ics),
        payload: { eventId: args.eventId, span: plan.span },
        preview: plan.preview,
        args,
        confirmToken: args.confirmToken,
      });
      if (gate) return gate;

      const op = plan.op;
      if (op.kind === 'delete') await dav.client.delete(op.url, { ifMatch: op.ifMatch });
      else await dav.client.put(op.url, op.body, ICALENDAR_CONTENT_TYPE, { ifMatch: op.ifMatch });

      let verified = false;
      const warnings: string[] = [];
      try {
        const res = await fetchEvent(dav, loaded.calendar, loaded.resource.name, loaded.id.baseId);
        if ('occ' in plan.verify) {
          verified = findOccurrence(eventParts(parseCalendar(res.ics, `event ${loaded.id.baseId}`)), plan.verify.occ, zone) === undefined;
          if (!verified) warnings.push('iCloud accepted the change, but the occurrence still shows on a re-read (reads can lag writes). Check again shortly.');
        } else {
          warnings.push('iCloud accepted the delete, but the event still shows on a re-read (reads can lag writes). Check again shortly.');
        }
      } catch (err) {
        verified = err instanceof AppleToolError && err.code === 'NOT_FOUND' && 'gone' in plan.verify;
        if (!verified) warnings.push(`iCloud accepted the change, but re-reading to verify it failed (${errorMessage(err)}).`);
      }
      return jsonResponse({
        deleted: true,
        verified,
        eventId: args.eventId,
        applied: plan.scope,
        title: plan.preview.event,
        when: plan.preview.when,
        calendar: plan.preview.calendar,
        ...(warnings.length ? { warnings } : {}),
        ...(plan.notes.length ? { notes: plan.notes } : {}),
      });
    },
  });

  // -------------------------------------------------------------------------
  defineTool(server, {
    name: 'apple_calendar_find_free_time',
    title: 'Find free time in your iCloud Calendar',
    service: 'calendar',
    access: 'read',
    description:
      'Find free time in your iCloud calendars: open slots per day within working hours (workdayStart/workdayEnd, default ' +
      '09:00–17:00, weekdays only by default) at least minDurationMinutes long (default 30). Busy = events not marked free, ' +
      'not cancelled and not declined by you; all-day events block only with includeAllDay. Window max 31 days. ' +
      DATES_NOTE,
    inputSchema: z.strictObject({
      fromDate: windowShape.fromDate,
      toDate: windowShape.toDate,
      daysAhead: z.number().int().min(1).max(MAX_FREE_TIME_DAYS).optional().describe('Window length in days from fromDate (default 7).'),
      minDurationMinutes: z.number().int().min(5).max(1440).optional().describe('Shortest slot worth reporting (default 30).'),
      workdayStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM').optional().describe('Working day start, HH:MM (default 09:00).'),
      workdayEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM').optional().describe('Working day end, HH:MM (default 17:00).'),
      weekdaysOnly: z.boolean().optional().describe('Skip Saturdays and Sundays (default true).'),
      includeAllDay: z.boolean().optional().describe('Let all-day events block the whole day (default false).'),
      calendars: calendarsParam,
      timeZone: timeZoneParam,
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const zone = resolveZone(args.timeZone);
      const at = now();
      const win = resolveWindow(args, { zone, now: at, defaultDays: 7, maxDays: MAX_FREE_TIME_DAYS });
      const workdayStart = parseClock(args.workdayStart ?? '09:00');
      const workdayEnd = parseClock(args.workdayEnd ?? '17:00');
      if (workdayEnd.hour * 60 + workdayEnd.minute <= workdayStart.hour * 60 + workdayStart.minute) {
        throw new InvalidArgumentError('workdayEnd must be later than workdayStart (working hours cannot run past midnight).');
      }
      const minMinutes = args.minDurationMinutes ?? 30;
      const weekdaysOnly = args.weekdaysOnly ?? true;
      const includeAllDay = args.includeAllDay ?? false;
      const dav = await context();
      const { calendars } = await listCalendars(dav);
      const selected = resolveCalendars(calendars, args.calendars);
      const collected = await collectOccurrences(dav, selected, win, { strict: true });
      const me = await selfAddresses(dav);
      const busy = mergeIntervals(
        collected.rows
          .filter(({ occurrence: o }) => {
            const comp = o.comp;
            if ((textProp(comp, 'transp') ?? '').toUpperCase() === 'TRANSPARENT') return false;
            if ((textProp(comp, 'status') ?? '').toUpperCase() === 'CANCELLED') return false;
            if (o.allDay && !includeAllDay) return false;
            const mine = comp.getAllProperties('attendee').find((p) => isSelf(p, me.addresses));
            return String(mine?.getFirstParameter('partstat') ?? '').toUpperCase() !== 'DECLINED';
          })
          .map(({ occurrence: o }) => ({ start: o.start.getTime(), end: o.end.getTime() })),
      );
      const free = computeFreeTime({
        from: win.from,
        to: win.to,
        zone,
        ...(win.fromDefaulted ? { notBefore: at } : {}),
        workdayStart,
        workdayEnd,
        weekdaysOnly,
        minMinutes,
        busy,
      });
      const slots = free.days.reduce((n, d) => n + d.free.length, 0);
      const minutes = free.days.reduce((n, d) => n + d.free.reduce((m, s) => m + (s.minutes as number), 0), 0);
      const notes = [...collected.notes];
      notes.push(
        'Busy = events not marked free (transparent), not cancelled and not declined by you' +
          (includeAllDay ? '; all-day events block their whole day.' : '; all-day events do not block time (includeAllDay: true to change that).'),
      );
      if (win.fromDefaulted) notes.push('Times before now are not offered.');
      if (free.weekendDays > 0) notes.push(`${free.weekendDays} weekend day(s) were skipped (weekdaysOnly).`);
      if (free.outsideWindow > 0) notes.push(`${free.outsideWindow} day(s) are not listed because their working hours fall outside the window or have passed.`);
      return jsonResponse({
        window: windowJson(win),
        workday: { start: args.workdayStart ?? '09:00', end: args.workdayEnd ?? '17:00' },
        weekdaysOnly,
        includeAllDay,
        minDurationMinutes: minMinutes,
        calendarsSearched: selected.map((c) => c.name),
        busyBlocks: busy.filter((b) => overlaps({ start: new Date(b.start), end: new Date(b.end) }, win.from, win.to)).length,
        freeSlots: slots,
        freeMinutes: minutes,
        complete: collected.complete,
        notes,
        days: free.days,
      });
    },
  });
}

