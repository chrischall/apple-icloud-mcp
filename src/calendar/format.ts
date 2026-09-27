import { formatDateOnly, formatInstant, putInstant } from '../time.js';
import { compactObject } from '../tools/_shared.js';
import type { Occurrence } from './expand.js';
import { formatOccurrenceId } from './ids.js';
import {
  describeRule,
  instantOf,
  readAlarms,
  readAttendees,
  readOrganizer,
  ruleOf,
  startTimeOf,
  textProp,
  tzidOf,
  ymdOf,
  type Component,
  type Time,
} from './ics.js';

/**
 * The JSON shape of one event occurrence. Instants are emitted with an
 * explicit offset plus a `…Display` label in the display zone; all-day events
 * carry INCLUSIVE `startDate` / `endDate` (`YYYY-MM-DD`), because iCalendar's
 * exclusive all-day DTEND reads as one day too many to everyone else.
 */

/** How much of an event's notes a list row carries. */
export const LIST_NOTES_CHARS = 500;

export interface FormatContext {
  calendar: { id: string; name: string };
  /** The series (resource) id, `<calendarId>/<file>`. */
  baseId: string;
  zone: string;
  /** Truncate notes to this many characters (list/search); omit for the full text. */
  notesLimit?: number;
}

/** A time value as a label in `zone` (a DATE is zone-free). */
export function timeLabel(t: Time, zone: string): string {
  return t.isDate ? formatDateOnly(ymdOf(t)) : formatInstant(instantOf(t, zone), zone).display;
}

/** `{rule, summary}` for a recurring master, or a summary alone for an RDATE-only series. */
export function recurrenceOf(master: Component, zone: string): { rule?: string; summary: string } | undefined {
  const rule = ruleOf(master);
  if (rule) {
    const until = rule.until ? timeLabel(rule.until, zone) : undefined;
    return { rule: rule.toString(), summary: describeRule(rule, until) };
  }
  return master.hasProperty('rdate') ? { summary: 'On specific dates (RDATE)' } : undefined;
}

/** Format an occurrence for a response. */
export function formatOccurrence(o: Occurrence, fc: FormatContext): Record<string, unknown> {
  const comp = o.comp;
  const out: Record<string, unknown> = {
    id: o.occ !== undefined ? formatOccurrenceId(fc.baseId, o.occ) : fc.baseId,
    calendar: fc.calendar.name,
    calendarId: fc.calendar.id,
    title: textProp(comp, 'summary') ?? '',
    isAllDay: o.allDay,
  };
  if (o.allDay) {
    out.startDate = o.startYmd;
    out.startDateDisplay = formatDateOnly(o.startYmd as string);
    out.endDate = o.endYmd;
    out.endDateDisplay = formatDateOnly(o.endYmd as string);
  } else {
    putInstant(out, 'start', o.start, fc.zone);
    putInstant(out, 'end', o.end, fc.zone);
    const tzid = tzidOf(startTimeOf(comp));
    if (tzid !== undefined && tzid !== fc.zone) out.eventTimeZone = tzid;
  }
  let notes = textProp(comp, 'description');
  let notesTruncated: true | undefined;
  if (notes !== undefined && fc.notesLimit !== undefined && notes.length > fc.notesLimit) {
    notes = notes.slice(0, fc.notesLimit);
    notesTruncated = true;
  }
  const status = textProp(comp, 'status');
  const transp = textProp(comp, 'transp');
  const organizer = readOrganizer(comp);
  const attendees = readAttendees(comp);
  const alarms = readAlarms(comp, o.start, o.end, fc.zone);
  Object.assign(
    out,
    compactObject({
      location: textProp(comp, 'location'),
      notes,
      notesTruncated,
      url: textProp(comp, 'url'),
      status: status?.toLowerCase(),
      transparency: transp?.toLowerCase(),
    }),
  );
  out.recurring = o.recurring;
  const recurrence = o.master ? recurrenceOf(o.master, fc.zone) : undefined;
  if (recurrence) out.recurrence = recurrence;
  if (o.occ !== undefined) out.occurrenceOf = fc.baseId;
  if (organizer) out.organizer = organizer;
  if (attendees.length > 0) out.attendees = attendees;
  if (alarms.length > 0) out.alarms = alarms;
  const modified = comp.getFirstPropertyValue('last-modified') as Time | null;
  if (modified) putInstant(out, 'lastModified', instantOf(modified, fc.zone), fc.zone);
  return out;
}

/** One-line "when" for previews: `Mon, Oct 20, 2026, 9:00 AM EDT – 10:00 AM EDT` or an all-day range. */
export function whenLabel(o: Occurrence, zone: string): string {
  if (o.allDay) {
    const first = formatDateOnly(o.startYmd as string);
    return o.startYmd === o.endYmd ? `${first} (all day)` : `${first} – ${formatDateOnly(o.endYmd as string)} (all day)`;
  }
  return `${formatInstant(o.start, zone).display} – ${formatInstant(o.end, zone).display}`;
}
