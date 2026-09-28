import { InvalidArgumentError } from '../errors.js';
import { formatDateOnly, formatInstant, parseDateInput, startOfDay, ymdInZone } from '../time.js';
import {
  addDaysYmd,
  buildRule,
  dateValue,
  ensureOrganizer,
  instantOf,
  newCalendar,
  newEvent,
  otherPassNote,
  setAlarms,
  setAttendees,
  setEventTimes,
  setTextProp,
  setTimeProp,
  skippedStartError,
  startTimeOf,
  timeAt,
  zoneForWrite,
  type Component,
  type RecurrenceInput,
  type Time,
} from './ics.js';

/**
 * Building a brand-new event. Everything the caller passes is validated here,
 * BEFORE any write and before the confirm gate, and every date is parsed
 * strictly (`parseDateInput`: a format error is reported as a format error,
 * never as a misleading ordering error).
 */

export interface AttendeeInput {
  email: string;
  name?: string;
}

export interface CreateInput {
  title: string;
  startDate: string;
  endDate?: string;
  isAllDay?: boolean;
  location?: string;
  notes?: string;
  url?: string;
  alarms?: number[];
  recurrence?: RecurrenceInput & { until?: string };
  attendees?: AttendeeInput[];
}

export interface NewEventTimes {
  allDay: boolean;
  start: Date;
  end: Date;
  /** All-day: first and last day, inclusive. */
  startYmd?: string;
  endYmd?: string;
  /** Timed: the start was a wall-clock time the zone skips at a DST change (`start` is where it would have been). */
  startSkipped?: boolean;
}

/** Resolve the start/end of a new event (validation only; nothing is built). */
export function resolveNewTimes(input: Pick<CreateInput, 'startDate' | 'endDate' | 'isAllDay'>, zone: string): NewEventTimes {
  const start = parseDateInput(input.startDate, 'startDate', zone);
  // A bare date with no isAllDay means an all-day event: a one-hour event at midnight is never what that asks for.
  const allDay = input.isAllDay ?? start.dateOnly;
  if (allDay) {
    if (!start.dateOnly) {
      throw new InvalidArgumentError(`startDate "${input.startDate}" has a time of day, but an all-day event takes a date (YYYY-MM-DD).`);
    }
    let endYmd = start.ymd;
    if (input.endDate !== undefined) {
      const end = parseDateInput(input.endDate, 'endDate', zone);
      if (!end.dateOnly) {
        throw new InvalidArgumentError(`endDate "${input.endDate}" has a time of day, but an all-day event takes a date (YYYY-MM-DD) — its last day.`);
      }
      endYmd = end.ymd;
    }
    if (endYmd < start.ymd) {
      throw new InvalidArgumentError(`endDate ${endYmd} is before startDate ${start.ymd}. For an all-day event endDate is the LAST day (inclusive).`);
    }
    return { allDay: true, start: startOfDay(start.ymd, zone), end: startOfDay(addDaysYmd(endYmd, 1), zone), startYmd: start.ymd, endYmd };
  }
  const startAt = start.instant;
  // Default length one real hour: instant arithmetic, so a DST change inside it does not stretch it.
  const endAt = input.endDate !== undefined ? parseDateInput(input.endDate, 'endDate', zone).instant : new Date(startAt.getTime() + 3_600_000);
  if (endAt.getTime() <= startAt.getTime()) {
    throw new InvalidArgumentError(
      `endDate (${formatInstant(endAt, zone).display}) must be after startDate (${formatInstant(startAt, zone).display}).`,
    );
  }
  return { allDay: false, start: startAt, end: endAt, ...(start.skipped ? { startSkipped: true } : {}) };
}

/** The UNTIL value for a new rule, of the type RFC 5545 requires for the series' DTSTART. */
function untilValue(until: string, times: NewEventTimes, zone: string): Time {
  const p = parseDateInput(until, 'recurrence.until', zone);
  if (times.allDay) {
    if (p.ymd < (times.startYmd as string)) throw new InvalidArgumentError(`recurrence.until ${p.ymd} is before the event's first day.`);
    return dateValue(p.ymd);
  }
  // A bare date means "through that day": the last second of it in the zone.
  const at = p.dateOnly ? new Date(startOfDay(addDaysYmd(p.ymd, 1), zone).getTime() - 1000) : p.instant;
  if (at.getTime() < times.start.getTime()) throw new InvalidArgumentError(`recurrence.until (${until}) is before the event starts.`);
  return timeAt(at, { kind: 'utc' });
}

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * Refuse a repeat rule whose weekdays leave out the first day. RFC 5545 makes
 * DTSTART the first occurrence whatever the rule says, so a Tuesday start
 * with `byWeekday: ["MO","WE"]` would add a stray Tuesday to the series —
 * shown by every calendar app, and asked for by nobody.
 */
export function checkRecurrenceStart(recurrence: CreateInput['recurrence'], times: NewEventTimes, zone: string): void {
  if (recurrence !== undefined && times.startSkipped) throw skippedStartError(zone);
  const days = recurrence?.byWeekday;
  if (days === undefined || days.length === 0) return;
  const ymd = times.allDay ? (times.startYmd as string) : ymdInZone(times.start, zone);
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  const weekday = WEEKDAY_CODES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] as string;
  if (!days.includes(weekday)) {
    throw new InvalidArgumentError(
      `startDate ${ymd} is a ${formatDateOnly(ymd).slice(0, 3)}, which is not one of recurrence.byWeekday (${days.join(', ')}). ` +
        'The start is always the first occurrence, so it would add a stray extra one.',
      'Start the event on one of those weekdays.',
    );
  }
}

/** Build the VCALENDAR for a new event. `organizer` is required when attendees are given. */
export function buildNewEvent(
  input: CreateInput,
  opts: { zone: string; now: Date; uid: string; times: NewEventTimes; organizer?: string; notes?: string[] },
): Component {
  const { zone, times } = opts;
  const vcal = newCalendar();
  const ev = newEvent(opts.uid, opts.now);
  vcal.addSubcomponent(ev);
  setTextProp(ev, 'summary', input.title);
  if (times.allDay) {
    setTimeProp(ev, 'dtstart', dateValue(times.startYmd as string));
    setTimeProp(ev, 'dtend', dateValue(addDaysYmd(times.endYmd as string, 1)));
  } else {
    if (setEventTimes(ev, times.start, times.end, zoneForWrite(vcal, zone), input.recurrence !== undefined)) opts.notes?.push(otherPassNote(instantOf(startTimeOf(ev), zone), times.start, zone));
  }
  setTextProp(ev, 'location', input.location);
  setTextProp(ev, 'description', input.notes);
  setTextProp(ev, 'url', input.url);
  if (input.recurrence) {
    const until = input.recurrence.until !== undefined ? untilValue(input.recurrence.until, times, zone) : undefined;
    ev.addPropertyWithValue('rrule', buildRule(input.recurrence, until));
  }
  if (input.attendees && input.attendees.length > 0) {
    ensureOrganizer(ev, opts.organizer as string);
    setAttendees(ev, input.attendees, new Set());
  }
  if (input.alarms && input.alarms.length > 0) setAlarms(ev, input.alarms);
  return vcal;
}
