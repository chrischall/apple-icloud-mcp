import { AppleToolError, errorMessage } from '../errors.js';
import { daysInMonth, startOfDay } from '../time.js';
import {
  ICAL,
  addDaysYmd,
  daysBetween,
  endTimeOf,
  instantOf,
  isRecurringMaster,
  occKey,
  ruleOf,
  startTimeOf,
  ymdOf,
  type Component,
  type EventParts,
  type Recur,
  type Time,
} from './ics.js';

/**
 * Client-side recurrence expansion. iCloud accepts CalDAV's server-side
 * `expand` but turns all-day events into UTC date-times (shifting their day
 * for anyone not in UTC), so a calendar-query returns MASTER events and the
 * occurrences are computed here with ical.js — RRULE, RDATE and EXDATE, plus
 * the per-occurrence override components (RECURRENCE-ID), matched to the
 * instances they replace by INSTANT, whatever zone each side was written in.
 *
 * Two bounds keep a hostile or runaway rule (FREQ=MINUTELY since 1990) from
 * pinning the CPU, and both are REPORTED, never silent:
 *  - at most `MAX_OCCURRENCES_PER_SERIES` occurrences of one series per window;
 *  - at most `MAX_EXPANSION_STEPS` rule instances walked from the series start.
 */

export const MAX_OCCURRENCES_PER_SERIES = 1000;
export const MAX_EXPANSION_STEPS = 50_000;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Walking a rule safely
// ---------------------------------------------------------------------------

/**
 * A repeat rule this server will not walk. ical.js's iterator has no bound
 * for sub-monthly frequencies: a rule whose day filters can never match
 * (`FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30`) spins forever in one synchronous
 * call — the whole server stops answering — and a rule RFC 5545 forbids
 * (`FREQ=WEEKLY;BYMONTHDAY=1`) or a malformed value makes it throw; the walk
 * itself stops after `MAX_SKIPPED_IN_A_ROW` excluded instances in a row. Such
 * a rule usually arrives in someone else's invitation, and it must cost that
 * one event its occurrences, never the whole calendar.
 */
export class UnexpandableRuleError extends AppleToolError {
  readonly reason: string;
  constructor(reason: string) {
    super('UNSUPPORTED', `calendar: this event's repeat rule cannot be expanded (${reason}).`, {
      hint: 'Open the event in Apple Calendar to see or change its occurrences.',
    });
    this.name = 'UnexpandableRuleError';
    this.reason = reason;
  }
}

const SUB_DAILY = new Set(['SECONDLY', 'MINUTELY', 'HOURLY']);
const DAY_FILTERS = ['BYDAY', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYMONTH'];
/** Days per month in a leap year: a BYMONTH/BYMONTHDAY pair that fits none of these never occurs. */
const MAX_MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Why ical.js cannot walk `recur` safely, or undefined when it can. MONTHLY
 * and YEARLY iterations carry ical.js's own give-up counter; the finer
 * frequencies do not, so their day filters are checked here:
 *  - a sub-daily rule limited to certain days is refused outright (even a
 *    satisfiable one can take minutes: `FREQ=SECONDLY;BYMONTH=12` walks every
 *    second of the year to reach December);
 *  - the combinations RFC 5545 §3.3.10 forbids are refused;
 *  - a DAILY rule must name a month/day pair that exists.
 */
export function ruleProblem(recur: Recur): string | undefined {
  const freq = String(recur.freq);
  const has = (part: string) => recur.getComponent(part).length > 0;
  if (SUB_DAILY.has(freq) && DAY_FILTERS.some(has)) return `FREQ=${freq} limited to certain days`;
  if (has('BYWEEKNO') && freq !== 'YEARLY') return `BYWEEKNO with FREQ=${freq}`;
  if (has('BYYEARDAY') && freq !== 'YEARLY') return `BYYEARDAY with FREQ=${freq}`;
  if (has('BYMONTHDAY') && freq === 'WEEKLY') return 'BYMONTHDAY with FREQ=WEEKLY';
  if (freq !== 'MONTHLY' && freq !== 'YEARLY' && recur.getComponent('BYDAY').some((d) => /\d/.test(String(d)))) {
    return `a numbered BYDAY with FREQ=${freq}`;
  }
  const monthDays = recur.getComponent('BYMONTHDAY').map(Number);
  if (freq === 'DAILY' && monthDays.length > 0) {
    const months = has('BYMONTH') ? recur.getComponent('BYMONTH').map(Number) : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const fits = months.some((m) => monthDays.some((d) => Math.abs(d) <= (MAX_MONTH_DAYS[m - 1] as number)));
    if (!fits) return 'BYMONTH and BYMONTHDAY name a day that never occurs';
  }
  return undefined;
}

function refuseUnwalkable(master: Component): void {
  for (const prop of master.getAllProperties('rrule')) {
    const recur = prop.getFirstValue() as Recur;
    const problem = ruleProblem(recur) ?? sparseProblem(recur, startTimeOf(master));
    if (problem) throw new UnexpandableRuleError(problem);
  }
}

/** 400 Gregorian years: dates and weekdays repeat exactly after it (it is a whole number of weeks). */
const CYCLE_DAYS = 146_097;
/**
 * How much walking ical.js may do between two instances of a DAILY or WEEKLY
 * rule with day filters, in days stepped over with each step counting 30
 * more: measured at about 7.5 µs a step plus 0.25 µs a day, this is a
 * quarter of a second. (A daily Feb 29 on a Monday, up to 40 years apart, is
 * under half of it.)
 */
export const MAX_GAP_COST = 1_000_000;
const STEP_COST = 30;
const WEEKDAY_NUMBERS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Month, day, days in that month and weekday (0 = Sunday) of every day of one cycle, from 1970-01-01. */
let cycleTable: { month: Uint8Array; day: Uint8Array; monthLength: Uint8Array; weekday: Uint8Array } | undefined;

function calendarCycle(): NonNullable<typeof cycleTable> {
  if (cycleTable) return cycleTable;
  const t = { month: new Uint8Array(CYCLE_DAYS), day: new Uint8Array(CYCLE_DAYS), monthLength: new Uint8Array(CYCLE_DAYS), weekday: new Uint8Array(CYCLE_DAYS) };
  let [y, m, d] = [1970, 1, 1];
  let length = daysInMonth(y, m);
  for (let i = 0; i < CYCLE_DAYS; i++) {
    [t.month[i], t.day[i], t.monthLength[i], t.weekday[i]] = [m, d, length, (4 + i) % 7]; // 1970-01-01 was a Thursday
    if (++d > length) {
      [d, m, y] = m === 12 ? [1, 1, y + 1] : [1, m + 1, y];
      length = daysInMonth(y, m);
    }
  }
  return (cycleTable = t);
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const sparseCache = new Map<string, string | undefined>();

/**
 * Why a DAILY or WEEKLY rule with day filters cannot be walked, or undefined.
 * ical.js gives up on a MONTHLY/YEARLY rule that stops matching, but walks
 * the days of these one step at a time, in ONE call, until one matches: a
 * rule that never matches again spins forever (`FREQ=DAILY;INTERVAL=7;
 * BYDAY=TU` from a Monday lands on Mondays only; `FREQ=WEEKLY;INTERVAL=20871;
 * BYMONTH=6` on one date every 400 years), and one whose matches are ages
 * apart costs seconds per instance. The days such a rule steps on repeat
 * within one 400-year cycle, so walking that cycle once (without ical.js)
 * finds the costliest gap between its instances (`MAX_GAP_COST`). Cached per
 * rule and start, as listings build walkers often.
 */
export function sparseProblem(recur: Recur, dtstart: Time): string | undefined {
  const freq = String(recur.freq);
  const months = recur.getComponent('BYMONTH').map(Number);
  const monthDays = recur.getComponent('BYMONTHDAY').map(Number);
  const days = recur.getComponent('BYDAY').map((v) => WEEKDAY_NUMBERS[String(v).toUpperCase()] as number);
  // A WEEKLY rule's BYDAY picks days in each week; only its BYMONTH filters them (ruleProblem refuses BYMONTHDAY there).
  const filtered = freq === 'DAILY' ? months.length + monthDays.length + days.length > 0 : freq === 'WEEKLY' && months.length > 0;
  if (!filtered) return undefined;
  const tooFar = `FREQ=${freq} with day filters that skip too many of the days it steps on`;
  const step = (freq === 'WEEKLY' ? 7 : 1) * recur.interval;
  if (step > MAX_GAP_COST) return tooFar;
  const origin = ((Math.floor(Date.UTC(dtstart.year, dtstart.month - 1, dtstart.day) / 86_400_000) % CYCLE_DAYS) + CYCLE_DAYS) % CYCLE_DAYS;
  const key = `${recur.toString()}@${origin}`;
  if (sparseCache.has(key)) return sparseCache.get(key);
  const t = calendarCycle();
  // The candidate days of one step, as offsets from DTSTART: the BYDAY days of its week (from WKST) for WEEKLY.
  const dow = t.weekday[origin] as number;
  const wkst = recur.wkst - 1; // ical.js numbers weekdays from 1 = Sunday
  const inWeek = (w: number) => (w - wkst + 7) % 7;
  const offsets = freq === 'WEEKLY' ? (days.length > 0 ? days : [dow]).map((w) => inWeek(w) - inWeek(dow)).sort((a, b) => a - b) : [0];
  const matches = (i: number): boolean =>
    (months.length === 0 || months.includes(t.month[i] as number)) &&
    (freq === 'WEEKLY' ||
      ((monthDays.length === 0 || monthDays.some((md) => (md > 0 ? md : (t.monthLength[i] as number) + 1 + md) === t.day[i])) &&
        (days.length === 0 || days.includes(t.weekday[i] as number))));
  const steps = CYCLE_DAYS / gcd(step, CYCLE_DAYS);
  let first: { k: number; at: number } | undefined;
  let last = { k: 0, at: 0 };
  let costliest = 0;
  const cost = (from: { k: number; at: number }, to: { k: number; at: number }) => (to.k - from.k) * STEP_COST + (to.at - from.at);
  for (let k = 0; k < steps; k++) {
    for (const off of offsets) {
      const at = k * step + off;
      if (!matches((((origin + at) % CYCLE_DAYS) + CYCLE_DAYS) % CYCLE_DAYS)) continue;
      if (first === undefined) first = { k, at };
      else costliest = Math.max(costliest, cost(last, { k, at }));
      last = { k, at };
    }
  }
  let problem: string | undefined;
  if (first === undefined) problem = `FREQ=${freq} whose day filters never match a day it steps on`;
  else if (Math.max(costliest, cost(last, { k: first.k + steps, at: first.at + steps * step })) > MAX_GAP_COST) problem = tooFar;
  if (sparseCache.size >= 1000) sparseCache.clear();
  sparseCache.set(key, problem);
  return problem;
}

/** Run an ical.js step, turning its errors into `UnexpandableRuleError`. */
function guarded<T>(step: () => T): T {
  try {
    return step();
  } catch (err) {
    throw new UnexpandableRuleError(errorMessage(err));
  }
}

/**
 * The instances of a series (DTSTART, RRULE and RDATE, less EXDATE; in start
 * order, each instant once) as a `next()` that answers null at the end.
 * `zone` resolves floating values, as occurrence keys do. Throws
 * `UnexpandableRuleError`, up front or mid-walk, instead of hanging or
 * leaking an ical.js error.
 *
 * ical.js orders the RRULE's instances and the RDATEs, but not the rest:
 *  - an RDATE equal to an instance the rule (or DTSTART) also gives comes
 *    out twice, so the walk skips an instant it has just given;
 *  - its EXDATE pointer moves once per instance and never looks back, so an
 *    EXDATE matching nothing let the NEXT excluded instance through, and a
 *    duplicate's second copy slipped past the EXDATE the first one used. It
 *    sees no EXDATE here: `exclusions` applies them, to every copy.
 */
export function seriesWalker(master: Component, zone: string): () => Time | null {
  refuseUnwalkable(master);
  const dtstart = startTimeOf(master);
  // Inside the guard: an RDATE/EXDATE value is decoded on first read, and a malformed one throws.
  const { view, mixed } = guarded(() => walkView(master, dtstart));
  const it = guarded(() => new ICAL.RecurExpansion({ component: view, dtstart }));
  const excluded = guarded(() => exclusions(master, zone));
  // A repeat comes right after its twin when every value is written alike (ical.js orders them exactly); a floating
  // value's twin written as a fixed one can be up to a zone offset away, so mixed series keep a window of instances.
  let lastRough: number | undefined;
  const recent: Array<{ t: Time; r: number }> = [];
  const repeated = (t: Time, r: number): boolean => {
    if (!mixed) {
      const repeat = r === lastRough;
      lastRough = r;
      return repeat;
    }
    while (recent.length > 0 && (recent[0] as { r: number }).r < r - ROUGH_MARGIN_MS) recent.shift();
    if (recent.some((p) => sameOccurrence(p.t, p.r, t, r, zone))) return true;
    recent.push({ t, r });
    return false;
  };
  return () => {
    for (let skipped = 0; ; skipped++) {
      if (skipped > MAX_SKIPPED_IN_A_ROW) throw new UnexpandableRuleError(`more than ${MAX_SKIPPED_IN_A_ROW} excluded occurrences in a row`);
      // ical.js answers `undefined` (not null) once the set is exhausted.
      const t = guarded(() => (it.next() as Time | undefined) ?? null);
      if (!t) return null;
      const r = roughStartMs(t);
      if (!repeated(t, r) && !excluded(t, r)) return t;
    }
  };
}

/** Consecutive instances a walk skips (excluded or repeated) before it gives up: a bound on one `next()`. */
export const MAX_SKIPPED_IN_A_ROW = 10_000;

/**
 * The master as ical.js's RecurExpansion should see it (it reads a component
 * through `hasProperty`/`getAllProperties`, once, as it starts):
 *  - no EXDATE: `exclusions` applies them;
 *  - an RDATE PERIOD comes back from ical.js as an ICAL.Period, whose
 *    `compare` means "overlaps" and which is no Time — the walk crashed on
 *    it — so each becomes its start (its end: `SeriesShape.periodEnds`);
 *  - ical.js yields DTSTART only through an RRULE's iterator, so a series of
 *    RDATEs alone never listed its first instance, which RFC 5545 §3.8.5.3
 *    makes DTSTART whatever else the set holds: without an RRULE, DTSTART
 *    joins the dates (a repeat of one is skipped; an EXDATE still removes it).
 */
function walkView(master: Component, dtstart: Time): { view: Component; mixed: boolean } {
  const dates = rdateValues(master).map((v) => (v instanceof ICAL.Period ? v.start : v));
  if (!master.hasProperty('rrule')) dates.push(dtstart);
  const rdate = [{ getValues: () => dates }];
  const props = (name: string) => (name === 'rdate' ? rdate : name === 'exdate' ? [] : master.getAllProperties(name));
  const view = { hasProperty: (name: string) => props(name).length > 0, getAllProperties: props } as unknown as Component;
  // The RRULE's instances are written like DTSTART.
  return { view, mixed: dates.some((t) => kindOf(t) !== kindOf(dtstart)) };
}

type Period = InstanceType<typeof ICAL.Period>;

function rdateValues(master: Component): Array<Time | Period> {
  return master.getAllProperties('rdate').flatMap((p) => p.getValues() as Array<Time | Period>);
}

/** Whether the master lists some instances as periods (RDATE;VALUE=PERIOD), each with a length of its own. */
export function hasPeriodDates(master: Component): boolean {
  return guarded(() => rdateValues(master)).some((v) => v instanceof ICAL.Period);
}

/** How a value is written: a DATE, a floating (zone-less) date-time, or one that fixes an instant (UTC or a TZID). */
function kindOf(t: Time): 'date' | 'floating' | 'fixed' {
  if (t.isDate) return 'date';
  return t.zone === ICAL.Timezone.localTimezone ? 'floating' : 'fixed';
}

/**
 * Whether two values (with their `roughStartMs`) are the same occurrence —
 * the same `#occ=` key. Values written alike compare on the rough value,
 * which is exact between them; a floating and a fixed value compare as
 * instants in `zone`; a DATE is never the same occurrence as a date-time.
 */
function sameOccurrence(a: Time, ra: number, b: Time, rb: number, zone: string): boolean {
  const ka = kindOf(a);
  const kb = kindOf(b);
  if (ka === kb) return ra === rb;
  if (ka === 'date' || kb === 'date') return false;
  return occKey(a, zone) === occKey(b, zone);
}

/**
 * Whether an instance is one the master's EXDATEs remove, as ical.js decides
 * it for a single EXDATE: a DATE removes every instance on that day (by the
 * instance's own date), a date-time removes the instance at that instant (a
 * DATE instance: at its midnight, read as UTC). A floating value against a
 * fixed one compares as instants in `zone`, like occurrence keys.
 */
function exclusions(master: Component, zone: string): (t: Time, rough: number) => boolean {
  const values = master.getAllProperties('exdate').flatMap((p) => p.getValues() as Time[]);
  if (values.length === 0) return () => false;
  const days = new Set<string>();
  const rough = { floating: new Set<number>(), fixed: new Set<number>() };
  const keys = { floating: new Set<string>(), fixed: new Set<string>() };
  for (const v of values) {
    const kind = kindOf(v);
    if (kind === 'date') days.add(ymdOf(v));
    else {
      rough[kind].add(roughStartMs(v));
      keys[kind].add(occKey(v, zone));
    }
  }
  return (t, r) => {
    if (days.has(ymdOf(t))) return true;
    const kind = kindOf(t);
    if (kind === 'date') return rough.fixed.has(r) || rough.floating.has(r);
    if (rough[kind].has(r)) return true;
    const other = keys[kind === 'fixed' ? 'floating' : 'fixed'];
    return other.size > 0 && other.has(occKey(t, zone));
  };
}

/**
 * The instant a value denotes, cheaply and only roughly: exact for UTC and
 * zoned values, and for a DATE or floating value its wall clock read as UTC —
 * within 14 hours of the truth. Used to skip instances far from a window
 * without the per-instance zone arithmetic (`instantOf`) that made a daily
 * series from 1990 cost over a second per listing.
 */
function roughStartMs(t: Time): number {
  if (t.isDate || t.zone === ICAL.Timezone.localTimezone) return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  return t.toUnixTime() * 1000;
}

/** Margin for `roughStartMs` comparisons: covers any zone offset and a DST hour. */
const ROUGH_MARGIN_MS = 2 * DAY_MS;

export interface Occurrence {
  /** The VEVENT the fields come from (an override, or the master). */
  comp: Component;
  /** The series master, for an occurrence of a recurring series that has one. */
  master?: Component;
  allDay: boolean;
  /** Instants. For an all-day occurrence: the day boundaries in the display zone. */
  start: Date;
  end: Date;
  /** All-day only: the first and LAST day (inclusive). */
  startYmd?: string;
  endYmd?: string;
  /** The `#occ=` value, for an occurrence of a recurring series. */
  occ?: string;
  /** The occurrence's ORIGINAL start (its RECURRENCE-ID), for an occurrence of a recurring series. */
  recurrenceTime?: Time;
  /** True when an override component supplies this occurrence. */
  isOverride: boolean;
  recurring: boolean;
}

interface Span {
  allDay: boolean;
  start: Date;
  end: Date;
  startYmd?: string;
  endYmd?: string;
}

function allDaySpan(startYmd: string, days: number, zone: string): Span {
  const endExclusive = addDaysYmd(startYmd, days);
  return {
    allDay: true,
    start: startOfDay(startYmd, zone),
    end: startOfDay(endExclusive, zone),
    startYmd,
    endYmd: addDaysYmd(endExclusive, -1),
  };
}

/** The span of a component from its own DTSTART / DTEND (or DURATION). */
function componentSpan(comp: Component, zone: string): Span {
  const startT = startTimeOf(comp);
  const endT = endTimeOf(comp, startT);
  if (startT.isDate) {
    const startYmd = ymdOf(startT);
    // An all-day DTEND is exclusive; one on or before DTSTART (or a date-time) means one day.
    const days = endT.isDate ? daysBetween(startYmd, ymdOf(endT)) : 1;
    return allDaySpan(startYmd, Math.max(1, days), zone);
  }
  const start = instantOf(startT, zone);
  const end = instantOf(endT, zone);
  return { allDay: false, start, end: end.getTime() < start.getTime() ? start : end };
}

function recurrenceIdOf(comp: Component): Time {
  return comp.getFirstPropertyValue('recurrence-id') as Time;
}

function overrideOccurrence(ovr: Component, master: Component | undefined, key: string, zone: string): Occurrence {
  return {
    comp: ovr,
    ...(master ? { master } : {}),
    ...componentSpan(ovr, zone),
    occ: key,
    recurrenceTime: recurrenceIdOf(ovr),
    isOverride: true,
    recurring: true,
  };
}

/** Shape of every natural instance of a series: the master's own length, or a PERIOD RDATE's. */
interface SeriesShape {
  allDay: boolean;
  days: number;
  durationMs: number;
  /** A timed instance's end instant (ms) by its `#occ=` key, for an instance an RDATE PERIOD gives its own length. */
  periodEnds: Map<string, number>;
  /** The longest any instance lasts (ms). */
  longestMs: number;
}

function seriesShape(master: Component, zone: string): SeriesShape {
  const s = componentSpan(master, zone);
  const durationMs = s.end.getTime() - s.start.getTime();
  const periodEnds = new Map<string, number>();
  let longestMs = durationMs;
  let values: Array<Time | Period> = [];
  try {
    values = rdateValues(master);
  } catch {
    // A malformed RDATE value: the walk reports it (`UnexpandableRuleError`), keeping what it can list.
  }
  for (const v of values) {
    if (!(v instanceof ICAL.Period) || s.allDay) continue;
    const start = instantOf(v.start, zone).getTime();
    const end = Math.max(start, instantOf(v.getEnd(), zone).getTime());
    periodEnds.set(occKey(v.start, zone), end);
    longestMs = Math.max(longestMs, end - start);
  }
  return {
    allDay: s.allDay,
    days: s.allDay ? daysBetween(s.startYmd as string, s.endYmd as string) + 1 : 0,
    durationMs,
    periodEnds,
    longestMs,
  };
}

function naturalOccurrence(master: Component, t: Time, key: string, shape: SeriesShape, zone: string): Occurrence {
  let span: Span;
  if (shape.allDay) span = allDaySpan(ymdOf(t), shape.days, zone);
  else {
    const start = instantOf(t, zone);
    span = { allDay: false, start, end: new Date(shape.periodEnds.get(key) ?? start.getTime() + shape.durationMs) };
  }
  return { comp: master, master, ...span, occ: key, recurrenceTime: t, isOverride: false, recurring: true };
}

/** The single occurrence of a non-recurring event. */
export function singleOccurrence(master: Component, zone: string): Occurrence {
  return { comp: master, ...componentSpan(master, zone), isOverride: false, recurring: false };
}

/** Whether an occurrence overlaps `[from, to)`; a zero-length one must start inside it. */
export function overlaps(o: { start: Date; end: Date }, from: Date, to: Date): boolean {
  const s = o.start.getTime();
  const e = o.end.getTime();
  if (e === s) return s >= from.getTime() && s < to.getTime();
  return s < to.getTime() && e > from.getTime();
}

export interface ExpandOptions {
  from: Date;
  /** Exclusive. */
  to: Date;
  zone: string;
  maxOccurrences?: number;
  maxSteps?: number;
}

export interface ExpandResult {
  occurrences: Occurrence[];
  /**
   * Why expansion stopped early, when it did: too many occurrences in the
   * window, too many steps to reach it, or a rule that cannot be walked
   * (`ruleProblem` says why; only the occurrences found before it — at least
   * the first instance — and the override components are listed).
   */
  truncated?: 'occurrences' | 'steps' | 'rule';
  ruleProblem?: string;
}

/** Whether a resource is a recurring series (a master with RRULE/RDATE, or override components only). */
export function isRecurringResource(parts: EventParts): boolean {
  return parts.master ? isRecurringMaster(parts.master) : parts.overrides.length > 0;
}

/**
 * Every occurrence of a resource that overlaps `[from, to)`, in start order
 * for the natural instances (callers sort the merged list anyway).
 */
export function expandSeries(parts: EventParts, opts: ExpandOptions): ExpandResult {
  const { from, to, zone } = opts;
  const { master, overrides } = parts;
  if (master && !isRecurringMaster(master)) {
    const single = singleOccurrence(master, zone);
    return { occurrences: overlaps(single, from, to) ? [single] : [] };
  }
  const maxOccurrences = opts.maxOccurrences ?? MAX_OCCURRENCES_PER_SERIES;
  const maxSteps = opts.maxSteps ?? MAX_EXPANSION_STEPS;
  const byKey = new Map<string, Component>();
  for (const o of overrides) byKey.set(occKey(recurrenceIdOf(o), zone), o);
  const visited = new Set<string>();
  const out: Occurrence[] = [];
  let truncated: ExpandResult['truncated'];
  let problem: string | undefined;

  if (master) {
    const shape = seriesShape(master, zone);
    // An instance starting before this cannot reach the window (see roughStartMs).
    const skipBelow = from.getTime() - shape.longestMs - ROUGH_MARGIN_MS;
    const consider = (t: Time): 'next' | 'stop' => {
      const key = occKey(t, zone);
      const natural = naturalOccurrence(master, t, key, shape, zone);
      // Instances come in start order: past the window, only moved overrides can still matter (below).
      if (natural.start.getTime() >= to.getTime()) return 'stop';
      const ovr = byKey.get(key);
      let occ = natural;
      if (ovr) {
        visited.add(key);
        occ = overrideOccurrence(ovr, master, key, zone);
      }
      if (!overlaps(occ, from, to)) return 'next';
      if (out.length >= maxOccurrences) {
        truncated = 'occurrences';
        return 'stop';
      }
      out.push(occ);
      return 'next';
    };
    // Only the walker's own calls are guarded: they throw nothing but UnexpandableRuleError.
    const stopOn = (err: unknown): void => {
      truncated = 'rule';
      problem = (err as UnexpandableRuleError).reason;
    };
    let next: (() => Time | null) | undefined;
    try {
      next = seriesWalker(master, zone);
    } catch (err) {
      stopOn(err);
      // DTSTART is always an instance (RFC 5545), even of a rule that cannot be walked.
      consider(startTimeOf(master));
    }
    for (let steps = 0; next; steps++) {
      if (steps >= maxSteps) {
        truncated = 'steps';
        break;
      }
      let t: Time | null;
      try {
        t = next();
      } catch (err) {
        stopOn(err); // mid-walk (e.g. an ical.js failure, or too many excluded instances in a row): keep what was found
        break;
      }
      if (!t) break;
      // Skipped instances are not marked visited: an override of one that moved INTO the window is still found below.
      if (roughStartMs(t) < skipBelow) continue;
      if (consider(t) === 'stop') break;
    }
  }
  // Overrides the walk did not reach: moved in from beyond the window, or of a series we only hold part of.
  for (const [key, ovr] of byKey) {
    if (visited.has(key)) continue;
    const occ = overrideOccurrence(ovr, master, key, zone);
    if (overlaps(occ, from, to)) out.push(occ);
  }
  return { occurrences: out, ...(truncated ? { truncated } : {}), ...(problem !== undefined ? { ruleProblem: problem } : {}) };
}

function tooLong(what: string, maxSteps: number): AppleToolError {
  return new AppleToolError('UNSUPPORTED', `calendar: ${what} could not be located: the series has more than ${maxSteps} occurrences before it.`, {
    hint: 'Edit or delete the series in Apple Calendar instead.',
  });
}

/**
 * The occurrence a `#occ=` value names, or undefined when the series has no
 * such occurrence (deleted, or moved more than the id can follow). Never a
 * fallback to another occurrence.
 */
export function findOccurrence(parts: EventParts, occ: string, zone: string, maxSteps: number = MAX_EXPANSION_STEPS): Occurrence | undefined {
  const { master, overrides } = parts;
  for (const o of overrides) {
    if (occKey(recurrenceIdOf(o), zone) === occ) return overrideOccurrence(o, master, occ, zone);
  }
  if (!master || !isRecurringMaster(master)) return undefined;
  const shape = seriesShape(master, zone);
  const target = occ.length === 10 ? startOfDay(occ, zone).getTime() : Date.parse(occ);
  const next = seriesWalker(master, zone);
  for (let steps = 0; steps < maxSteps; steps++) {
    const t = next();
    if (!t) return undefined;
    if (roughStartMs(t) < target - ROUGH_MARGIN_MS) continue;
    const key = occKey(t, zone);
    if (key === occ) return naturalOccurrence(master, t, key, shape, zone);
    if (instantOf(t, zone).getTime() > target) return undefined;
  }
  throw tooLong(`occurrence ${occ}`, maxSteps);
}

/** Where an instant falls among a series' RRULE instances (RDATE and EXDATE aside). */
export interface RulePosition {
  /** How many rule instances come before it — what a COUNT-bounded rule has used up when it is split there. */
  before: number;
  /** The first rule instance at or after it; undefined when the rule (or its COUNT/UNTIL) ends before it. */
  next?: Date;
}

/**
 * Where `at` falls among the RRULE's own instances. RDATE/EXDATE do not
 * change COUNT, and an RDATE is not a rule instance: a series cannot be
 * split at one, and ending the series before one must not extend a rule that
 * already ends earlier.
 */
export function rulePosition(master: Component, at: Date, zone: string, maxSteps: number = MAX_EXPANSION_STEPS): RulePosition {
  const rule = ruleOf(master);
  if (!rule) return { before: 0 };
  refuseUnwalkable(master);
  const it = guarded(() => rule.iterator(startTimeOf(master)));
  let n = 0;
  for (let steps = 0; steps < maxSteps; steps++) {
    const t = guarded(() => it.next() as Time | null);
    if (!t) return { before: n };
    if (roughStartMs(t) >= at.getTime() - ROUGH_MARGIN_MS) {
      const instant = instantOf(t, zone);
      if (instant.getTime() >= at.getTime()) return { before: n, next: instant };
    }
    n += 1;
  }
  throw tooLong('the split point', maxSteps);
}
