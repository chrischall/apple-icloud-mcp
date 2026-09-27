import { AppleToolError, InvalidArgumentError } from '../errors.js';
import { parseDateInput, startOfDay, ymdInZone } from '../time.js';
import { hasPeriodDates, rulePosition, seriesWalker, type Occurrence } from './expand.js';
import {
  ICAL,
  WEEKDAYS,
  addDaysYmd,
  addTimeProp,
  cloneComponent,
  dateValue,
  daysBetween,
  endTimeOf,
  ensureOrganizer,
  instantOf,
  occKey,
  ruleOf,
  setAlarms,
  setAttendees,
  setTextProp,
  setTimeProp,
  startTimeOf,
  textProp,
  timeAt,
  touch,
  wallTime,
  ymdOf,
  zoneForWrite,
  zoneOfTime,
  type Component,
  type Property,
  type Recur,
  type Time,
  type WriteZone,
} from './ics.js';

/**
 * The editing primitives behind update and delete: resolving the requested
 * times against an occurrence, writing them, applying field changes, and the
 * three series operations — an override for one occurrence, a shift of the
 * whole series, and a split into "before" and "from here on".
 *
 * Series edits move EXDATEs, RDATEs, UNTIL and every override's RECURRENCE-ID
 * together with DTSTART, by the same WALL-CLOCK delta in the series' zone.
 * Moving DTSTART alone would orphan every exception: a deleted occurrence
 * would reappear and a moved one would show twice.
 */

// ---------------------------------------------------------------------------
// Field changes
// ---------------------------------------------------------------------------

export interface FieldChanges {
  title?: string;
  location?: string;
  notes?: string;
  url?: string;
  /** Minutes before the start; replaces every alarm. */
  alarms?: number[];
  /** Replaces the invitees. */
  attendees?: Array<{ email: string; name?: string }>;
}

export const FIELD_NAMES = ['title', 'location', 'notes', 'url', 'alarms', 'attendees'] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

/** Who the account is, for attendee edits (from the principal's calendar-user-address-set). */
export interface Identity {
  self: ReadonlySet<string>;
  organizer: string;
}

/** A comparable snapshot of one field of a component (to tell customised overrides from inherited ones). */
export function fieldSnapshot(comp: Component, field: FieldName): string {
  switch (field) {
    case 'title':
      return textProp(comp, 'summary') ?? '';
    case 'location':
      return textProp(comp, 'location') ?? '';
    case 'notes':
      return textProp(comp, 'description') ?? '';
    case 'url':
      return textProp(comp, 'url') ?? '';
    case 'alarms':
      return comp
        .getAllSubcomponents('valarm')
        .map((a) => a.toString())
        .join('\n');
    default:
      return comp
        .getAllProperties('attendee')
        .map((p: Property) => p.toICALString())
        .sort()
        .join('\n');
  }
}

/** Apply one field change to a component. */
export function applyField(comp: Component, field: FieldName, ch: FieldChanges, who: Identity | undefined): void {
  switch (field) {
    case 'title':
      return setTextProp(comp, 'summary', ch.title);
    case 'location':
      return setTextProp(comp, 'location', ch.location);
    case 'notes':
      return setTextProp(comp, 'description', ch.notes);
    case 'url':
      return setTextProp(comp, 'url', ch.url);
    case 'alarms':
      return setAlarms(comp, ch.alarms as number[]);
    default: {
      const list = ch.attendees as NonNullable<FieldChanges['attendees']>;
      const id = who as Identity;
      setAttendees(comp, list, id.self);
      if (list.length > 0) ensureOrganizer(comp, id.organizer);
    }
  }
}

/** The fields a change set touches. */
export function changedFields(ch: FieldChanges): FieldName[] {
  return FIELD_NAMES.filter((f) => ch[f] !== undefined);
}

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

export interface TimeInput {
  startDate?: string;
  endDate?: string;
  isAllDay?: boolean;
  /** When given, the zone new times are written in (and read in, for offset-less input). */
  timeZone?: string;
}

/** The new times for an occurrence, resolved and validated. */
export interface TimePlan {
  allDay: boolean;
  start: Date;
  end: Date;
  startYmd?: string;
  endYmd?: string;
  /** Whether endDate was given (a series then takes the new length; otherwise it keeps its own). */
  endGiven: boolean;
}

export function wantsTimeChange(t: TimeInput): boolean {
  return t.startDate !== undefined || t.endDate !== undefined || t.isAllDay !== undefined;
}

/**
 * Resolve new start/end for `target` from the request; undefined when no
 * time was asked to change. Unchanged parts keep their current values (a
 * moved start keeps the event's length).
 */
export function planTimes(target: Occurrence, input: TimeInput, zone: string, recurring: boolean): TimePlan | undefined {
  if (!wantsTimeChange(input)) return undefined;
  const allDay = input.isAllDay ?? target.allDay;
  if (recurring && allDay !== target.allDay) {
    throw new InvalidArgumentError(
      'isAllDay cannot be changed on a recurring event: every occurrence, exception and exclusion would change type with it.',
      'Delete the series and create it again with the other kind of time.',
    );
  }
  const endGiven = input.endDate !== undefined;
  if (allDay) {
    const day = (value: string, field: string): string => {
      const p = parseDateInput(value, field, zone);
      if (!p.dateOnly) throw new InvalidArgumentError(`${field} "${value}" has a time of day, but an all-day event takes a date (YYYY-MM-DD).`);
      return p.ymd;
    };
    const oldStart = target.allDay ? (target.startYmd as string) : ymdInZone(target.start, zone);
    const oldLength = target.allDay ? daysBetween(target.startYmd as string, target.endYmd as string) : 0;
    const startYmd = input.startDate !== undefined ? day(input.startDate, 'startDate') : oldStart;
    const endYmd = input.endDate !== undefined ? day(input.endDate, 'endDate') : addDaysYmd(startYmd, oldLength);
    if (endYmd < startYmd) {
      throw new InvalidArgumentError(`endDate ${endYmd} is before startDate ${startYmd}. For an all-day event endDate is the LAST day (inclusive).`);
    }
    return { allDay: true, start: startOfDay(startYmd, zone), end: startOfDay(addDaysYmd(endYmd, 1), zone), startYmd, endYmd, endGiven };
  }
  const at = (value: string, field: string): Date => {
    const p = parseDateInput(value, field, zone);
    if (p.dateOnly && input.isAllDay === undefined) {
      throw new InvalidArgumentError(
        `${field} "${value}" has no time of day. Pass a date-time (e.g. ${value}T09:00), or isAllDay: true to make it an all-day event.`,
      );
    }
    return p.instant;
  };
  let start: Date;
  if (input.startDate !== undefined) start = at(input.startDate, 'startDate');
  else if (!target.allDay) start = target.start;
  else throw new InvalidArgumentError('startDate is required to turn an all-day event into a timed one.');
  let end: Date;
  if (input.endDate !== undefined) end = at(input.endDate, 'endDate');
  else if (input.startDate === undefined) end = target.end;
  else end = new Date(start.getTime() + (target.allDay ? 3_600_000 : target.end.getTime() - target.start.getTime()));
  // Without endDate the end is derived (unchanged, or start + the current length), so only a given one can be wrong.
  if (endGiven && end.getTime() <= start.getTime()) throw new InvalidArgumentError('endDate must be after startDate.');
  return { allDay: false, start, end, endGiven };
}

/** The zone to write a component's new times in: the requested one, else the zone it already uses. */
export function writeZoneFor(vcal: Component, comp: Component, input: TimeInput, zone: string): WriteZone {
  const start = startTimeOf(comp);
  if (input.timeZone !== undefined || start.isDate) return zoneForWrite(vcal, zone);
  return zoneOfTime(start, zone);
}

/** Write DTSTART / DTEND (DURATION is replaced by DTEND). */
export function writeTimes(comp: Component, plan: TimePlan, wz: WriteZone): void {
  comp.removeAllProperties('duration');
  if (plan.allDay) {
    setTimeProp(comp, 'dtstart', dateValue(plan.startYmd as string));
    setTimeProp(comp, 'dtend', dateValue(addDaysYmd(plan.endYmd as string, 1)));
  } else {
    setTimeProp(comp, 'dtstart', timeAt(plan.start, wz));
    setTimeProp(comp, 'dtend', timeAt(plan.end, wz));
  }
}

// ---------------------------------------------------------------------------
// Date-list helpers (EXDATE / RDATE)
// ---------------------------------------------------------------------------

/**
 * Rewrite every date value of `name` through `fn` (undefined drops it). A
 * property holding non-date values (an RDATE PERIOD) is kept as it was.
 */
export function rewriteDates(comp: Component, name: string, fn: (t: Time) => Time | undefined): void {
  const keep: Property[] = [];
  const times: Time[] = [];
  for (const prop of comp.getAllProperties(name)) {
    const values = prop.getValues();
    if (values.every((v) => v instanceof ICAL.Time)) times.push(...(values as Time[]));
    else keep.push(prop);
  }
  comp.removeAllProperties(name);
  for (const prop of keep) comp.addProperty(prop);
  for (const t of times) {
    const next = fn(t);
    if (next) addTimeProp(comp, name, next);
  }
}

// ---------------------------------------------------------------------------
// One occurrence → an override
// ---------------------------------------------------------------------------

/** The value an occurrence's RECURRENCE-ID / EXDATE takes in the master's own zone and type. */
export function recurrenceValue(master: Component, target: Occurrence, zone: string): Time {
  const rid = target.recurrenceTime as Time;
  const start = startTimeOf(master);
  if (start.isDate) return dateValue(ymdOf(rid));
  return timeAt(instantOf(rid, zone), zoneOfTime(start, zone));
}

/** An override component for a natural occurrence, added to `vcal` (a copy of the master, pinned to that one instance). */
export function createOverride(vcal: Component, master: Component, target: Occurrence, zone: string): Component {
  const ovr = cloneComponent(master);
  for (const name of ['rrule', 'rdate', 'exdate', 'exrule', 'duration']) ovr.removeAllProperties(name);
  setTimeProp(ovr, 'recurrence-id', recurrenceValue(master, target, zone));
  const wz = zoneOfTime(startTimeOf(master), zone);
  writeTimes(
    ovr,
    { allDay: target.allDay, start: target.start, end: target.end, ...(target.allDay ? { startYmd: target.startYmd, endYmd: target.endYmd } : {}), endGiven: false },
    wz,
  );
  vcal.addSubcomponent(ovr);
  return ovr;
}

// ---------------------------------------------------------------------------
// The whole series
// ---------------------------------------------------------------------------

export interface SeriesEdit {
  vcal: Component;
  master: Component;
  /** The overrides that belong to this series (all of them, or those carried into a split). */
  overrides: Component[];
  /** The occurrence the request was made through (natural, override, or the series' first instance). */
  target: Occurrence;
  times: TimePlan | undefined;
  timeInput: TimeInput;
  fields: FieldChanges;
  who: Identity | undefined;
  zone: string;
  now: Date;
  /** Where to say what else changed with the series (its repeat days). */
  notes?: string[];
  /** Where to queue the check that the series moved as a whole (`checkShifted`), to run after the caller's own; run at once when absent. */
  checks?: Array<() => void>;
}

/** Wall-clock seconds of an instant in a write zone (UTC fields for UTC, local fields otherwise). */
function wallSeconds(instant: Date, wz: WriteZone): number {
  const t = timeAt(instant, wz);
  return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second) / 1000;
}

const DAY_PINNING_PARTS = ['BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYSETPOS', 'BYMONTH'];
const TIME_PINNING_PARTS = ['BYHOUR', 'BYMINUTE', 'BYSECOND'];

function cannotShift(rule: Recur, why: string): AppleToolError {
  return new AppleToolError(
    'UNSUPPORTED',
    `calendar: this series repeats by a rule (${rule.toString()}) that ${why}, so moving every occurrence cannot be done by moving its start. Nothing was changed.`,
    { hint: 'Change only what the rule leaves free (e.g. the time of day), edit one occurrence (span "thisEvent"), or delete the series and create it again.' },
  );
}

/**
 * Refuse to move, split or cut short a series that lists some instances as
 * periods (RDATE;VALUE=PERIOD, each with a length of its own): those values
 * are read, but not rewritten here, and keeping them as they were would
 * leave them behind a move or on the wrong side of a split. Nothing is
 * changed.
 */
function refusePeriodDates(master: Component): void {
  if (!hasPeriodDates(master)) return;
  throw new AppleToolError(
    'UNSUPPORTED',
    'calendar: this series lists some occurrences as time periods (RDATE;VALUE=PERIOD), which this server can read but cannot move, split or cut short. Nothing was changed.',
    { hint: 'Change or delete one occurrence (span "thisEvent"), change the whole series without moving it, or make this change in Apple Calendar.' },
  );
}

/**
 * The series' rule after its occurrences move by `dayShift` calendar days
 * (and, when `timeShifted`, to another time of day). An RRULE is not anchored
 * to DTSTART alone: `BYDAY=MO,WE` keeps generating Mondays and Wednesdays
 * wherever DTSTART goes, so a series moved a day later would keep its old
 * days (plus an extra first one) while its exceptions moved — every
 * exception orphaned. Plain weekdays move with the shift; parts that pin
 * dates or times the shift cannot carry are refused.
 */
export function shiftRule(rule: Recur, dayShift: number, timeShifted: boolean): { rule: Recur; note?: string } {
  if (timeShifted) {
    const pinned = TIME_PINNING_PARTS.filter((p) => rule.getComponent(p).length > 0);
    if (pinned.length > 0) throw cannotShift(rule, `fixes the time of day (${pinned.join(', ')})`);
  }
  if (dayShift === 0) return { rule };
  const days = rule.getComponent('BYDAY').map(String);
  const pinned = DAY_PINNING_PARTS.filter((p) => rule.getComponent(p).length > 0);
  if (days.some((d) => !/^[A-Z]{2}$/i.test(d))) pinned.push('a numbered BYDAY');
  if (pinned.length > 0) throw cannotShift(rule, `fixes which dates it falls on (${pinned.join(', ')})`);
  if (days.length === 0) return { rule };
  const freq = String(rule.freq);
  const interval = rule.interval;
  if (interval > 1 && (freq === 'MONTHLY' || freq === 'YEARLY')) {
    // Every Nth month/year counts whole months/years: a day moved across the end of one lands in a skipped one.
    throw cannotShift(rule, `repeats on named days every ${interval} ${freq === 'MONTHLY' ? 'months' : 'years'} (a day moved past the end of one would land in a skipped one)`);
  }
  const turn = (d: string) => WEEKDAYS[((WEEKDAYS.indexOf(d.toUpperCase() as (typeof WEEKDAYS)[number]) + dayShift) % 7 + 7) % 7] as string;
  const r = rule.clone();
  const moved = days.map(turn);
  r.setComponent('BYDAY', moved);
  let note = `The repeat days moved with it: ${days.join(',')} → ${moved.join(',')}.`;
  if (freq === 'WEEKLY' && interval > 1) {
    // Every other week counts weeks from WKST (default Monday): a day moved across that boundary lands in a skipped
    // week. Turning the week start with the days keeps every occurrence in the week it belonged to.
    const wkst = WEEKDAYS[(rule.wkst + 5) % 7] as string;
    const next = turn(wkst);
    r.wkst = ICAL.Recur.icalDayToNumericDay(next);
    note += ` Its weeks now start on ${next} instead of ${wkst} (WKST), so it keeps the same weeks.`;
  }
  return { rule: r, note };
}

/** How many of a series' first instances `checkShifted` compares at most… */
export const SHIFT_CHECK_INSTANCES = 400;
/** …and how many days past the series' start it looks, whichever bound comes first. */
export const SHIFT_CHECK_DAYS = 3653;

/**
 * A series' first instances — at most `max`, none on or after the day
 * `horizon` (YYYY-MM-DD) — and the instance that stopped the walk there
 * (`stop`; absent when the series ended first). Bounded by days as well as by
 * count because ical.js has no loop limits: a sparse rule a listing walks
 * happily (Feb 29 when it is a Monday) walked to 400 instances runs through
 * millennia of calendar in one synchronous call. The walk stops at the first
 * instance past a bound, so it costs at most one of the rule's own gaps.
 */
function leadingInstances(master: Component, zone: string, max: number, horizon: string): { instances: Time[]; stop?: Time } {
  const next = seriesWalker(master, zone);
  const instances: Time[] = [];
  for (let t = next(); t; t = next()) {
    if (instances.length >= max || ymdOf(t) >= horizon) return { instances, stop: t };
    instances.push(t);
  }
  return { instances };
}

/**
 * Days of slack at a cut: ical.js orders a DATE or floating value as if it
 * were UTC, so in a series that mixes them with fixed values the walk's
 * order can stray from the days' by up to a day.
 */
const CUT_SLACK_DAYS = 2;

/**
 * `checkShifted` over a bounded sample: `sample` is the old series' leading
 * instances and `shift` how each one moves. Every instance the walk did not
 * read comes after `sample.stop`, so it moves to that one's day or later
 * (less the slack): the days before that are compared, as sorted lists, with
 * the rewritten series' days before it — read to a day past it, so a stray
 * one is not missed. The rewritten series is walked only until it has shown
 * one day more than expected.
 */
function checkShiftedSample(
  sample: { instances: Time[]; stop?: Time },
  shift: (t: Time) => Time,
  master: Component,
  rule: Recur | undefined,
  zone: string,
): void {
  const moved = sample.instances.map((t) => ymdOf(shift(t))).sort();
  const before = sample.stop && addDaysYmd(ymdOf(shift(sample.stop)), -CUT_SLACK_DAYS);
  const expected = before === undefined ? moved : moved.filter((day) => day < before);
  const next = seriesWalker(master, zone);
  const actual: string[] = [];
  while (actual.length <= expected.length) {
    const t = next();
    if (!t) break;
    const day = ymdOf(t);
    if (before === undefined || day < before) actual.push(day);
    else if (day >= addDaysYmd(before, CUT_SLACK_DAYS)) break;
  }
  checkShifted(expected, actual.sort(), rule);
}

/**
 * Refuse a series move whose rewritten series does not put every instance
 * on its old day moved by the shift: `expected` is the old instances' days
 * moved, `actual` the new series' (both its first instances, by wall-clock
 * day). A rule that repeats by a calendar position the move cannot carry —
 * monthly on the 30th moved to the 31st, yearly on Feb 29 — or a value the
 * move could not follow otherwise gains, drops or re-days occurrences while
 * its exceptions stay on the old ones. Checked in memory: nothing is written.
 */
export function checkShifted(expected: readonly string[], actual: readonly string[], rule: Recur | undefined): void {
  const i = expected.findIndex((day, k) => actual[k] !== day);
  const at = i >= 0 ? i : expected.length < actual.length ? expected.length : -1;
  if (at < 0) return;
  const was = expected[at] === undefined ? 'no occurrence' : `an occurrence on ${expected[at]}`;
  const is = actual[at] === undefined ? 'none' : `one on ${actual[at]}`;
  throw new AppleToolError(
    'UNSUPPORTED',
    `calendar: this series${rule ? ` (${rule.toString()})` : ''} cannot be moved by moving its start: occurrence ${at + 1} should become ${was}, ` +
      `but the rewritten series would have ${is}, so occurrences would be gained or lost. Nothing was changed.`,
    { hint: 'Change only the time of day, edit one occurrence (span "thisEvent"), or delete the series and create it again.' },
  );
}

/**
 * Apply a change to every occurrence of a series. Returns the new `#occ=` of
 * the target (undefined when it was addressed by its bare series id).
 *
 * Times move by a WALL-CLOCK delta: an RRULE is wall-clock arithmetic in its
 * DTSTART's zone, so instance k of the old series and instance k of the new
 * one differ by exactly (new DTSTART wall clock − old DTSTART wall clock) —
 * also when the zone changes and the two zones switch DST on different
 * dates, where shifting instants would misalign every exception in between.
 * The delta is measured from the target's NATURAL slot (its RECURRENCE-ID):
 * a new startDate says where this occurrence of the series should now be.
 */
export function editSeries(e: SeriesEdit): string | undefined {
  const { vcal, master, overrides, target, times, zone } = e;
  const oldMaster = cloneComponent(master);
  const mStart = startTimeOf(master);
  const allDay = mStart.isDate;
  let shift: (t: Time) => Time = (t) => t;
  const touched = new Set<Component>([master]);

  if (times) {
    // A new length alone leaves every instance where it was (a PERIOD keeps its own length); a new start or zone moves them.
    if (e.timeInput.startDate !== undefined || e.timeInput.timeZone !== undefined) refusePeriodDates(master);
    // The instances before the change, to check the rewritten series against (see checkShifted).
    const sample = leadingInstances(master, zone, SHIFT_CHECK_INSTANCES, addDaysYmd(ymdOf(mStart), SHIFT_CHECK_DAYS));
    const oldWz = zoneOfTime(mStart, zone);
    const newWz = e.timeInput.timeZone !== undefined && !allDay ? zoneForWrite(vcal, zone) : oldWz;
    const mEnd = endTimeOf(master, mStart);
    const moved = e.timeInput.startDate !== undefined;
    const ref = target.recurrenceTime;
    const refYmd = ref ? ymdOf(ref) : (target.startYmd as string);
    const refStart = ref ? instantOf(ref, zone) : target.start;
    const deltaDays = moved && allDay ? daysBetween(refYmd, times.startYmd as string) : 0;
    const refWall = allDay ? 0 : wallSeconds(refStart, oldWz);
    const deltaWall = allDay ? 0 : wallSeconds(moved ? times.start : refStart, newWz) - refWall;
    // Every instance has the same time of day, so the shift moves each one by the same number of calendar days.
    const dayShift = allDay ? deltaDays : Math.floor((refWall + deltaWall) / 86_400) - Math.floor(refWall / 86_400);
    const rule = ruleOf(master);
    const shifted = rule ? shiftRule(rule, dayShift, deltaWall % 86_400 !== 0) : undefined;
    if (shifted?.note) e.notes?.push(shifted.note);
    shift = (t) => {
      // Every value moves by the SERIES' day shift, whatever its own type: an all-day series can carry a DATE-TIME
      // UNTIL/EXDATE (some writers emit UTC ones), a timed one a DATE EXDATE/UNTIL. Moving those by the other kind's
      // delta (always 0) left them behind — dropping the final occurrence, or bringing an excluded one back.
      if (t.isDate || allDay) {
        const c = t.clone();
        c.adjust(allDay ? deltaDays : dayShift, 0, 0, 0);
        return c;
      }
      return wallTime(new Date((wallSeconds(instantOf(t, zone), oldWz) + deltaWall) * 1000), newWz);
    };
    // Lengths: the series keeps its own unless endDate was given.
    const oldDays = allDay ? daysBetween(ymdOf(mStart), ymdOf(mEnd)) : 0;
    const oldMs = allDay ? 0 : instantOf(mEnd, zone).getTime() - instantOf(mStart, zone).getTime();
    let newDays = oldDays;
    let newMs = oldMs;
    if (times.endGiven) {
      if (allDay) newDays = daysBetween(times.startYmd as string, times.endYmd as string) + 1;
      else newMs = times.end.getTime() - times.start.getTime();
    }
    const withEnd = (comp: Component, start: Time, days: number, ms: number) => {
      comp.removeAllProperties('duration');
      setTimeProp(comp, 'dtstart', start);
      setTimeProp(comp, 'dtend', start.isDate ? dateValue(addDaysYmd(ymdOf(start), days)) : timeAt(new Date(instantOf(start, zone).getTime() + ms), newWz));
    };
    const newStart = shift(mStart);
    withEnd(master, newStart, newDays, newMs);
    rewriteDates(master, 'exdate', shift);
    rewriteDates(master, 'rdate', shift);
    if (shifted) {
      const r = shifted.rule === rule ? shifted.rule.clone() : shifted.rule;
      const until = r.until;
      if (until) {
        // UNTIL moves like the last instance it bounds: by the WALL-CLOCK delta. Moving it by DTSTART's instant delta
        // is an hour off when the move crosses a DST change, and drops the final occurrence.
        if (until.isDate) r.until = shift(until);
        else r.until = timeAt(instantOf(shift(until), zone), until.zone === ICAL.Timezone.utcTimezone ? { kind: 'utc' } : { kind: 'floating', zone });
      }
      (master.getFirstProperty('rrule') as Property).setValue(r);
    }
    for (const ovr of overrides) {
      const rid = ovr.getFirstPropertyValue('recurrence-id') as Time;
      const oStart = startTimeOf(ovr);
      const oEnd = endTimeOf(ovr, oStart);
      const retimed = occKey(oStart, zone) !== occKey(rid, zone);
      setTimeProp(ovr, 'recurrence-id', shift(rid));
      if (ovr === target.comp) writeTimes(ovr, times, newWz);
      else if (!retimed) {
        const days = allDay ? daysBetween(ymdOf(oStart), ymdOf(oEnd)) : 0;
        const ms = allDay ? 0 : instantOf(oEnd, zone).getTime() - instantOf(oStart, zone).getTime();
        withEnd(ovr, shift(oStart), days === oldDays ? newDays : days, ms === oldMs ? newMs : ms);
      }
      touched.add(ovr);
    }
    const check = () => checkShiftedSample(sample, shift, master, rule, zone);
    if (e.checks) e.checks.push(check);
    else check();
  }

  for (const field of changedFields(e.fields)) {
    const inherited = fieldSnapshot(oldMaster, field);
    applyField(master, field, e.fields, e.who);
    for (const ovr of overrides) {
      // An override keeps a value it was individually given; one that inherited the series' value follows the change.
      if (ovr === target.comp || fieldSnapshot(ovr, field) === inherited) {
        applyField(ovr, field, e.fields, e.who);
        touched.add(ovr);
      }
    }
  }
  for (const comp of touched) touch(comp, e.now);
  return target.recurrenceTime ? occKey(shift(target.recurrenceTime), zone) : undefined;
}

/** A value just before an occurrence, for UNTIL: the day before (DATE), or one second before. */
function untilBefore(master: Component, occInstant: Date, occ: string, zone: string): Time {
  const start = startTimeOf(master);
  if (start.isDate) return dateValue(addDaysYmd(occ, -1));
  const before = new Date(occInstant.getTime() - 1000);
  return timeAt(before, start.zone === ICAL.Timezone.localTimezone ? { kind: 'floating', zone } : { kind: 'utc' });
}

/** The instant an `#occ=` value names. */
export function occInstant(occ: string, zone: string): Date {
  return occ.length === 10 ? startOfDay(occ, zone) : new Date(Date.parse(occ));
}

/** Whether the series has no instance before the occurrence (so "this and following" means "all"). */
export function isFirstInstance(master: Component, occ: string, zone: string): boolean {
  const first = seriesWalker(master, zone)();
  return !first || instantOf(first, zone).getTime() >= occInstant(occ, zone).getTime();
}

/**
 * End a series just before `occ`: the rule gets an UNTIL (COUNT is replaced,
 * RFC 5545 allows only one), and EXDATE/RDATE values and overrides from
 * `occ` on are removed. Returns the removed overrides.
 */
export function truncateSeries(vcal: Component, master: Component, overrides: readonly Component[], occ: string, zone: string, now: Date): Component[] {
  refusePeriodDates(master);
  const at = occInstant(occ, zone);
  const before = (t: Time) => instantOf(t, zone).getTime() < at.getTime();
  const rule = ruleOf(master);
  // A rule whose COUNT/UNTIL already ends before `occ` (an occurrence added by RDATE) stays as it is: replacing its
  // COUNT by an UNTIL just before `occ` would EXTEND it, adding occurrences to a series being cut short.
  if (rule && rulePosition(master, at, zone).next !== undefined) {
    const r = rule.clone();
    r.count = null;
    r.until = untilBefore(master, at, occ, zone);
    (master.getFirstProperty('rrule') as Property).setValue(r);
  }
  rewriteDates(master, 'exdate', (t) => (before(t) ? t : undefined));
  rewriteDates(master, 'rdate', (t) => (before(t) ? t : undefined));
  // Without an RRULE, DTSTART is an instance like the RDATEs (seriesWalker) and an RDATE can come before it, so a cut
  // at or before it has to remove it too.
  const start = startTimeOf(master);
  if (!rule && !before(start)) addTimeProp(master, 'exdate', start.clone());
  const removed: Component[] = [];
  for (const ovr of overrides) {
    if (!before(ovr.getFirstPropertyValue('recurrence-id') as Time)) {
      vcal.removeSubcomponent(ovr);
      removed.push(ovr);
    }
  }
  // DTSTART left alone, and an override of it kept: DTSTART becomes its one RDATE so the event stays a series —
  // as a single event the override (an edit already made to that occurrence) would no longer apply.
  if (!rule && !master.hasProperty('rdate') && removed.length < overrides.length) addTimeProp(master, 'rdate', start.clone());
  touch(master, now);
  return removed;
}

/**
 * A new series continuing the old one from `occ`: a copy of the master with
 * a new UID, starting at that occurrence's original slot, keeping the rule
 * (a COUNT reduced by the `used` instances before the split) and the
 * exceptions from there on. `carried` overrides move over with it.
 */
export function continuationSeries(
  source: Component,
  master: Component,
  carried: readonly Component[],
  target: Occurrence,
  used: number,
  opts: { uid: string; now: Date; zone: string },
): { vcal: Component; master: Component; overrides: Component[] } {
  refusePeriodDates(master);
  const { zone } = opts;
  const vcal = new ICAL.Component(['vcalendar', [], []]);
  for (const prop of source.getAllProperties()) vcal.addProperty(new ICAL.Property(JSON.parse(JSON.stringify(prop.toJSON()))));
  for (const tz of source.getAllSubcomponents('vtimezone')) vcal.addSubcomponent(cloneComponent(tz));
  const next = cloneComponent(master);
  // Attach it first: its zoned values resolve their TZID through the VCALENDAR that holds the VTIMEZONEs.
  vcal.addSubcomponent(next);
  next.updatePropertyWithValue('uid', opts.uid);
  const stamp = ICAL.Time.fromJSDate(opts.now, true);
  next.updatePropertyWithValue('created', stamp);
  next.updatePropertyWithValue('sequence', 0);
  const at = occInstant(target.occ as string, zone);
  const first = recurrenceValue(master, target, zone);
  const start = startTimeOf(master);
  const end = endTimeOf(master, start);
  next.removeAllProperties('duration');
  setTimeProp(next, 'dtstart', first);
  setTimeProp(
    next,
    'dtend',
    first.isDate
      ? dateValue(addDaysYmd(ymdOf(first), daysBetween(ymdOf(start), ymdOf(end))))
      : timeAt(new Date(instantOf(first, zone).getTime() + instantOf(end, zone).getTime() - instantOf(start, zone).getTime()), zoneOfTime(start, zone)),
  );
  const rule = ruleOf(next);
  if (rule?.count) {
    const r = rule.clone();
    r.count = rule.count - used;
    (next.getFirstProperty('rrule') as Property).setValue(r);
  }
  const from = (t: Time) => (instantOf(t, zone).getTime() >= at.getTime() ? t : undefined);
  rewriteDates(next, 'exdate', from);
  rewriteDates(next, 'rdate', from);
  // Without an RRULE the old DTSTART is an instance like any RDATE (seriesWalker): one after the split goes with it.
  if (!rule && instantOf(start, zone).getTime() > at.getTime()) addTimeProp(next, 'rdate', start.clone());
  const overrides = carried.map((ovr) => {
    const c = cloneComponent(ovr);
    c.updatePropertyWithValue('uid', opts.uid);
    vcal.addSubcomponent(c);
    return c;
  });
  return { vcal, master: next, overrides };
}
