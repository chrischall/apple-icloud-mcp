import { formatDateOnly, formatInstant, putInstant } from '../time.js';
import { compactObject } from '../tools/_shared.js';
import type { Occurrence } from './expand.js';
import { formatOccurrenceId } from './ids.js';
import {
  describeRule,
  instantOf,
  isSelf,
  readAlarms,
  readAttendees,
  readOrganizer,
  ruleOf,
  startTimeOf,
  textProp,
  tzidOf,
  ymdOf,
  type Component,
  type Person,
  type Time,
} from './ics.js';
import type { CallZones } from './window.js';

/**
 * The JSON shape of one event occurrence. Instants are emitted with an
 * explicit offset plus a `…Display` label in the request's zone (`zone`: the
 * call's `timeZone`, else DISPLAY_TZ); a floating value is read in the
 * display zone first (`displayZone`, see `CallZones`). All-day events carry
 * INCLUSIVE `startDate` / `endDate` (`YYYY-MM-DD`), because iCalendar's
 * exclusive all-day DTEND reads as one day too many to everyone else.
 */

/** How much of an event's notes a `full` list row carries. */
export const LIST_NOTES_CHARS = 500;

/** How much of an event's notes a `compact` list row carries. */
export const COMPACT_NOTES_CHARS = 200;

export interface FormatContext extends CallZones {
  calendar: { id: string; name: string };
  /** The series (resource) id, `<calendarId>/<file>`. */
  baseId: string;
  /** Truncate notes to this many characters (list/search); omit for the full text. */
  notesLimit?: number;
}

/** A time value as a label in `zones.zone`, a floating one read in `zones.displayZone` (a DATE is zone-free). */
export function timeLabel(t: Time, zones: CallZones): string {
  return t.isDate ? formatDateOnly(ymdOf(t)) : formatInstant(instantOf(t, zones.displayZone), zones.zone).display;
}

/** `{rule, summary}` for a recurring master, or a summary alone for an RDATE-only series. */
export function recurrenceOf(master: Component, zones: CallZones): { rule?: string; summary: string } | undefined {
  const rule = ruleOf(master);
  if (rule) {
    const until = rule.until ? timeLabel(rule.until, zones) : undefined;
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
  const alarms = readAlarms(comp, o.start, o.end, fc.displayZone);
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
  const recurrence = o.master ? recurrenceOf(o.master, fc) : undefined;
  if (recurrence) out.recurrence = recurrence;
  if (o.occ !== undefined) out.occurrenceOf = fc.baseId;
  if (organizer) out.organizer = organizer;
  if (attendees.length > 0) out.attendees = attendees;
  if (alarms.length > 0) out.alarms = alarms;
  const modified = comp.getFirstPropertyValue('last-modified') as Time | null;
  if (modified) putInstant(out, 'lastModified', instantOf(modified, fc.displayZone), fc.zone);
  return out;
}

/** Keys a `compact` list row leaves out (`full` and apple_calendar_get_event carry them). */
const COMPACT_DROPS = ['url', 'organizer', 'attendees', 'alarms', 'lastModified', 'lastModifiedDisplay'];

/**
 * A `compact` list/search row: the full row minus the attendee list, the
 * organizer, alerts, url, lastModified and the raw repeat rule (its
 * plain-English summary stays), with notes cut to COMPACT_NOTES_CHARS.
 * `attendeeCount` replaces the list, and `myStatus` is the account's own
 * reply when its ATTENDEE entry can be recognised from `self` (the addresses
 * known without another request) — absent, never guessed, when it cannot.
 */
export function formatCompactOccurrence(o: Occurrence, fc: FormatContext, self: ReadonlySet<string>): Record<string, unknown> {
  const out = formatOccurrence(o, { ...fc, notesLimit: COMPACT_NOTES_CHARS });
  for (const key of COMPACT_DROPS) delete out[key];
  if (out.recurrence) out.recurrence = { summary: (out.recurrence as { summary: string }).summary };
  const attendees = o.comp.getAllProperties('attendee');
  if (attendees.length > 0) {
    out.attendeeCount = attendees.length;
    const mine = attendees.find((p) => isSelf(p, self));
    if (mine) {
      const partstat = mine.getFirstParameter('partstat');
      out.myStatus = typeof partstat === 'string' ? partstat.toLowerCase() : 'needs-action';
    }
  }
  return out;
}

/** A person as a preview shows them: `Name <email>`, else whichever of the two is known. */
export function personLabel(p: Person): string {
  if (p.name !== undefined && p.email !== undefined) return `${p.name} <${p.email}>`;
  return p.email ?? p.name ?? '(no address)';
}

/**
 * Everything iCloud's invitation (or update) email carries about an
 * occurrence, for a confirm preview: title, time and zone, location, url,
 * the WHOLE notes, how it repeats, organizer and attendees. The person
 * approving an email must see all of what it sends — a preview without the
 * notes approves a message whose body nobody read.
 */
export function invitationSummary(o: Occurrence, zones: CallZones): Record<string, unknown> {
  const { zone } = zones;
  const comp = o.comp;
  const organizer = readOrganizer(comp);
  const attendees = readAttendees(comp);
  const recurrence = o.master ? recurrenceOf(o.master, zones) : undefined;
  return compactObject({
    event: textProp(comp, 'summary') ?? '(untitled)',
    when: whenLabel(o, zone),
    timeZone: o.allDay ? undefined : zone,
    location: textProp(comp, 'location'),
    url: textProp(comp, 'url'),
    notes: textProp(comp, 'description'),
    repeats: recurrence?.summary,
    organizer: organizer ? personLabel(organizer) : undefined,
    attendees: attendees.length > 0 ? attendees.map(personLabel).join(', ') : undefined,
  });
}

/** One-line "when" for previews: `Mon, Oct 20, 2026, 9:00 AM EDT – 10:00 AM EDT` or an all-day range. */
export function whenLabel(o: Occurrence, zone: string): string {
  if (o.allDay) {
    const first = formatDateOnly(o.startYmd as string);
    return o.startYmd === o.endYmd ? `${first} (all day)` : `${first} – ${formatDateOnly(o.endYmd as string)} (all day)`;
  }
  return `${formatInstant(o.start, zone).display} – ${formatInstant(o.end, zone).display}`;
}
