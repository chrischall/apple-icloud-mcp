import { AppleToolError, CredentialsRejectedError, InvalidArgumentError, UpstreamError, errorMessage } from '../errors.js';
import { listCalendars, fetchEvent, queryCalendars, type CalendarContext, type CalendarInfo, type EventResource } from './caldav.js';
import {
  expandSeries,
  findOccurrence,
  isRecurringResource,
  singleOccurrence,
  MAX_EXPANSION_STEPS,
  MAX_OCCURRENCES_PER_SERIES,
  type ExpandResult,
  type Occurrence,
} from './expand.js';
import { decodeIdPart, formatEventId, parseEventId, type ParsedEventId } from './ids.js';
import { eventParts, instantOf, occKey, parseCalendar, startTimeOf, textProp, type Component, type EventParts, type Time } from './ics.js';
import type { Window } from './window.js';

/**
 * From calendars to occurrences: query each calendar for the window, parse
 * every resource, expand recurrences, and account for everything that could
 * not be read. Nothing that failed is allowed to look like "no events".
 */

export interface Row {
  occurrence: Occurrence;
  resource: EventResource;
  /** `<calendarId>/<file>`. */
  baseId: string;
}

export interface Collected {
  rows: Row[];
  /** Human-readable statements about anything missing or cut short. */
  notes: string[];
  /** Calendars whose query failed (their events are missing). */
  failed: Array<{ calendar: string; error: string }>;
  /** Whether every event in the window, in every searched calendar, is accounted for. */
  complete: boolean;
}

/** The title of a series (only a series with a master can be cut short). */
function titleOf(parts: EventParts): string {
  return textProp(parts.master as Component, 'summary') ?? '(untitled)';
}

/**
 * Query `calendars` for the window and expand everything in it.
 *
 * `strict` (free-time): any calendar that fails fails the call, because a
 * missing calendar would turn its busy time into "free". Otherwise a failed
 * calendar is reported in `failed` + `notes` and the rest is returned —
 * unless EVERY calendar failed, or a credential was rejected, which is thrown.
 */
export async function collectOccurrences(
  ctx: CalendarContext,
  calendars: readonly CalendarInfo[],
  win: Window,
  opts: { strict?: boolean } = {},
): Promise<Collected> {
  const outcomes = await queryCalendars(ctx, calendars, win.from, win.to);
  const failures = outcomes.filter((o) => !o.ok);
  for (const f of failures) {
    if (opts.strict || f.error instanceof CredentialsRejectedError || failures.length === outcomes.length) throw f.error;
  }
  const rows: Row[] = [];
  const notes: string[] = [];
  const failed = failures.map((f) => ({ calendar: f.calendar.name, error: errorMessage(f.error) }));
  for (const f of failed) notes.push(`Calendar "${f.calendar}" could not be searched (${f.error}); its events are MISSING from this answer.`);
  let complete = failed.length === 0;
  for (const outcome of outcomes) {
    if (!outcome.ok) continue;
    const { calendar, resources } = outcome.result;
    let unreadable = outcome.result.unreadable;
    for (const resource of resources) {
      let parts: EventParts;
      let expanded: ExpandResult;
      try {
        parts = eventParts(parseCalendar(resource.ics, `an event in "${calendar.name}"`));
        // Inside the try: one resource that cannot be expanded must not take the whole answer down with it.
        expanded = expandSeries(parts, { from: win.from, to: win.to, zone: win.zone });
      } catch (err) {
        console.error(`[apple-icloud-mcp] WARNING: calendar: an event in "${calendar.name}" could not be read: ${errorMessage(err)}`);
        unreadable += 1;
        continue;
      }
      if (!parts.master && parts.overrides.length === 0) continue; // e.g. a VTODO in an event calendar
      const baseId = formatEventId(calendar.id, resource.name);
      if (expanded.truncated === 'rule') {
        notes.push(
          `"${titleOf(parts)}" repeats by a rule that cannot be expanded (${expanded.ruleProblem as string}); only its first ` +
            'occurrence and any individually changed ones are listed, so later occurrences may be MISSING.',
        );
        complete = false;
      } else if (expanded.truncated === 'occurrences') {
        notes.push(`"${titleOf(parts)}" repeats more than ${MAX_OCCURRENCES_PER_SERIES} times in this window; only the first ${MAX_OCCURRENCES_PER_SERIES} are included.`);
        complete = false;
      } else if (expanded.truncated === 'steps') {
        notes.push(
          `"${titleOf(parts)}" has more than ${MAX_EXPANSION_STEPS} occurrences before or in this window, so its occurrences here could not all be computed and some are MISSING.`,
        );
        complete = false;
      }
      for (const occurrence of expanded.occurrences) rows.push({ occurrence, resource, baseId });
    }
    if (unreadable > 0) {
      notes.push(`${unreadable} event(s) in "${calendar.name}" could not be read (malformed iCalendar) and are not listed.`);
      complete = false;
    }
    if (outcome.result.truncatedByServer) {
      notes.push(`iCloud cut the results for "${calendar.name}" short (too many matches); some of its events in this window are MISSING. Query a shorter window.`);
      complete = false;
    }
  }
  rows.sort(compareRows);
  return { rows, notes, failed, complete };
}

function rowId(r: Row): string {
  return r.occurrence.occ !== undefined ? `${r.baseId}#occ=${r.occurrence.occ}` : r.baseId;
}

/** Start, then title, then id — a stable order, so paging never skips or repeats an event. */
export function compareRows(a: Row, b: Row): number {
  const byStart = a.occurrence.start.getTime() - b.occurrence.start.getTime();
  if (byStart !== 0) return byStart;
  const byTitle = (textProp(a.occurrence.comp, 'summary') ?? '').localeCompare(textProp(b.occurrence.comp, 'summary') ?? '');
  return byTitle !== 0 ? byTitle : rowId(a).localeCompare(rowId(b));
}

/** Refuse an offset past the end of a non-empty result (it would read exactly like "nothing there"). */
export function assertOffset(offset: number, total: number): void {
  if (offset > 0 && offset >= total && total > 0) {
    throw new InvalidArgumentError(
      `offset ${offset} is past the end: ${total} event${total === 1 ? '' : 's'} matched this window (valid offsets 0–${total - 1}).`,
    );
  }
}

// ---------------------------------------------------------------------------
// One event, by id
// ---------------------------------------------------------------------------

export interface LoadedEvent {
  id: ParsedEventId;
  calendars: CalendarInfo[];
  calendar: CalendarInfo;
  resource: EventResource;
  vcal: Component;
  parts: EventParts;
  recurring: boolean;
  /**
   * What the id names: the occurrence (for `#occ=`), the single event, or —
   * for a bare series id — the series' first instance (for display only).
   */
  target: Occurrence;
}

/**
 * Resolve an event id to its resource and occurrence. An `#occ=` that the
 * series does not have is NOT_FOUND — never a fall-back to another occurrence.
 */
export async function loadEvent(ctx: CalendarContext, eventId: string, zone: string): Promise<LoadedEvent> {
  const id = parseEventId(eventId);
  const { calendars } = await listCalendars(ctx);
  const calendar = calendars.find((c) => decodeIdPart(c.id) === id.calendarId);
  if (!calendar) {
    throw new AppleToolError('NOT_FOUND', `calendar: event ${eventId} names calendar "${id.calendarId}", which is not one of your event calendars.`, {
      hint: 'List the events again to get current ids.',
    });
  }
  const resource = await fetchEvent(ctx, calendar, id.resourceName, id.baseId);
  const vcal = parseCalendar(resource.ics, `event ${id.baseId}`);
  const parts = eventParts(vcal);
  if (!parts.master && parts.overrides.length === 0) {
    throw new UpstreamError('calendar', 200, `calendar: ${id.baseId} holds no event (VEVENT).`);
  }
  const recurring = isRecurringResource(parts);
  let target: Occurrence;
  if (id.occ !== undefined) {
    if (!recurring) {
      throw new InvalidArgumentError(`${eventId} names one occurrence, but this event is not recurring.`, `Use the id without "#occ=…": ${id.baseId}`);
    }
    const found = findOccurrence(parts, id.occ, zone);
    if (!found) {
      throw new AppleToolError(
        'NOT_FOUND',
        `calendar: the occurrence ${id.occ} of ${id.baseId} does not exist — it may have been deleted, or the series changed. Nothing was changed.`,
        { hint: 'List the events over the date you want and use that occurrence id.' },
      );
    }
    target = found;
  } else if (parts.master) {
    target = singleOccurrence(parts.master, zone);
    if (recurring) target = { ...target, master: parts.master, recurring: true };
  } else {
    // Only overrides (occurrences of a series held elsewhere, e.g. an invitation): show the earliest.
    const first = [...parts.overrides].sort((a, b) => instantOf(startTimeOf(a), zone).getTime() - instantOf(startTimeOf(b), zone).getTime())[0] as Component;
    target = findOccurrence(parts, occKey(first.getFirstPropertyValue('recurrence-id') as Time, zone), zone) as Occurrence;
  }
  return { id, calendars, calendar, resource, vcal, parts, recurring, target };
}
