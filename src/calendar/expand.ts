import { AppleToolError, errorMessage } from '../errors.js';
import { daysInMonth, startOfDay } from '../time.js';
import {
  ICAL,
  addDaysYmd,
  daysBetween,
  endTimeOf,
  instantOf,
  endAfter,
  endInstantOf,
  isRecurringMaster,
  lengthOf,
  occKey,
  roughMs,
  ruleOf,
  startTimeOf,
  ymdOf,
  type Component,
  type EventParts,
  type Length,
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
    // ical.js compares a DAILY rule's BYMONTHDAY with the day of the month as it stands: a count from the end never
    // matches, so those days would silently go missing (and a rule with nothing else would spin forever).
    if (monthDays.some((d) => d < 0)) return 'a negative BYMONTHDAY with FREQ=DAILY';
  }
  return undefined;
}

function refuseUnwalkable(master: Component): void {
  for (const prop of master.getAllProperties('rrule')) {
    const recur = prop.getFirstValue() as Recur;
    const problem = ruleProblem(recur) ?? sparseProblem(recur, startTimeOf(master)) ?? timeProblem(recur, startTimeOf(master));
    if (problem) throw new UnexpandableRuleError(problem);
  }
}

/** 400 Gregorian years: dates and weekdays repeat exactly after it (it is a whole number of weeks). */
const CYCLE_DAYS = 146_097;
/**
 * How much walking ical.js may do between two instances of a DAILY or WEEKLY
 * rule with day filters, in days stepped over with each step counting 30
 * more — times the times of day it tries on each (BYHOUR × BYMINUTE ×
 * BYSECOND): measured at about 7.5 µs a step plus 0.25 µs a day, this is a
 * quarter of a second. (A daily Feb 29 on a Monday, up to 40 years apart, is
 * under half of it.)
 */
export const MAX_GAP_COST = 1_000_000;
const STEP_COST = 30;
const WEEKDAY_NUMBERS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Month and day of every day of one cycle, from 1970-01-01. */
let cycleTable: { month: Uint8Array; day: Uint8Array } | undefined;

function calendarCycle(): NonNullable<typeof cycleTable> {
  if (cycleTable) return cycleTable;
  const t = { month: new Uint8Array(CYCLE_DAYS), day: new Uint8Array(CYCLE_DAYS) };
  let [y, m, d] = [1970, 1, 1];
  let length = daysInMonth(y, m);
  for (let i = 0; i < CYCLE_DAYS; i++) {
    [t.month[i], t.day[i]] = [m, d];
    if (++d > length) {
      [d, m, y] = m === 12 ? [1, 1, y + 1] : [1, m + 1, y];
      length = daysInMonth(y, m);
    }
  }
  return (cycleTable = t);
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const sparseCache = new Map<string, string | undefined>();
const ratioCache = new Map<string, number>();

/** A rule check's answer, computed once per key (listings build walkers often); each cache is bounded. */
function cached<T>(cache: Map<string, T>, key: string, compute: () => T): T {
  if (cache.has(key)) return cache.get(key) as T;
  const answer = compute();
  if (cache.size >= 1000) cache.clear();
  cache.set(key, answer);
  return answer;
}

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
  // Weekday filters alone repeat every week: a week of steps settles them, with no calendar to build.
  const cycle = freq === 'DAILY' && months.length + monthDays.length === 0 ? 7 : CYCLE_DAYS;
  const origin = ((Math.floor(Date.UTC(dtstart.year, dtstart.month - 1, dtstart.day) / 86_400_000) % CYCLE_DAYS) + CYCLE_DAYS) % CYCLE_DAYS;
  // ical.js tries every time of day the rule expands to on each day it steps on, matching or not.
  const stepCost = STEP_COST * TIME_PARTS.reduce((n, part) => n * Math.max(1, recur.getComponent(part).length), 1);
  // Keyed by what decides the answer (not COUNT/UNTIL): events with the same rule share it.
  const key = [freq, recur.interval, recur.wkst, months, monthDays, days, origin % cycle, stepCost].join('|');
  return cached(sparseCache, key, () => {
    const t = cycle === 7 ? undefined : calendarCycle();
    const weekday = (i: number) => (4 + i) % 7; // day i of the cycle; 1970-01-01 was a Thursday
    // The candidate days of one step, as offsets from DTSTART: the BYDAY days of its week (from WKST) for WEEKLY.
    const dow = weekday(origin);
    const wkst = recur.wkst - 1; // ical.js numbers weekdays from 1 = Sunday
    const inWeek = (w: number) => (w - wkst + 7) % 7;
    const offsets = freq === 'WEEKLY' ? (days.length > 0 ? days : [dow]).map((w) => inWeek(w) - inWeek(dow)).sort((a, b) => a - b) : [0];
    // As ical.js matches them: a DAILY rule's BYMONTHDAY against the day of the month as it stands (ruleProblem
    // refuses a negative one, which would never match).
    const matches = (i: number): boolean =>
      (months.length === 0 || months.includes((t as NonNullable<typeof t>).month[i] as number)) &&
      (freq === 'WEEKLY' ||
        ((monthDays.length === 0 || monthDays.includes((t as NonNullable<typeof t>).day[i] as number)) && (days.length === 0 || days.includes(weekday(i)))));
    const steps = cycle / gcd(step, cycle);
    let first: { k: number; at: number } | undefined;
    let last = { k: 0, at: 0 };
    let costliest = 0;
    const cost = (from: { k: number; at: number }, to: { k: number; at: number }) => (to.k - from.k) * stepCost + (to.at - from.at);
    for (let k = 0; k < steps; k++) {
      for (const off of offsets) {
        const at = k * step + off;
        if (!matches((((origin + at) % CYCLE_DAYS) + CYCLE_DAYS) % CYCLE_DAYS)) continue;
        if (first === undefined) first = { k, at };
        else costliest = Math.max(costliest, cost(last, { k, at }));
        last = { k, at };
      }
    }
    if (first === undefined) return `FREQ=${freq} whose day filters never match a day it steps on`;
    return Math.max(costliest, cost(last, { k: first.k + steps, at: first.at + steps * step })) > MAX_GAP_COST ? tooFar : undefined;
  });
}

const TIME_PARTS = ['BYHOUR', 'BYMINUTE', 'BYSECOND'];
/**
 * Steps ical.js may take, on average, per instance of a sub-daily rule its
 * time filters thin out: at 1–2 µs a step, a walk to `MAX_EXPANSION_STEPS`
 * instances stays under a second.
 */
export const MAX_STEPS_PER_INSTANCE = 10;

/**
 * Why a sub-daily rule's time filters make it too costly (or impossible) to
 * walk, or undefined. ical.js steps such a rule by INTERVAL — or, when it
 * lists its own unit (BYSECOND for SECONDLY, BYMINUTE for MINUTELY, BYHOUR
 * for HOURLY), through that list and then one of the next unit — and checks
 * each step against the coarser parts, with no bound: `FREQ=SECONDLY;
 * BYHOUR=3;BYMINUTE=0;BYSECOND=0` tries all 1440 minutes of a day for its one
 * instance (a listing of a series from 1990 took half a minute), and
 * `FREQ=MINUTELY;INTERVAL=1440;BYHOUR=3` from midnight never reaches 3 AM at
 * all. The times of day it steps on repeat within a day, so one day of them,
 * walked here, gives both answers. Cached like `sparseProblem`.
 */
export function timeProblem(recur: Recur, dtstart: Time): string | undefined {
  const freq = String(recur.freq);
  if (!SUB_DAILY.has(freq)) return undefined;
  const [hours, minutes, seconds] = TIME_PARTS.map((part) => recur.getComponent(part).map(Number)) as [number[], number[], number[]];
  // The coarser parts filter; HOURLY has none (BYMINUTE/BYSECOND add instances to each hour instead).
  const filters: Array<(tod: number) => boolean> = [];
  if (hours.length > 0 && freq !== 'HOURLY') filters.push((tod) => hours.includes(Math.floor(tod / 3600)));
  if (minutes.length > 0 && freq === 'SECONDLY') filters.push((tod) => minutes.includes(Math.floor(tod / 60) % 60));
  if (filters.length === 0) return undefined;
  const [own, unit] = freq === 'SECONDLY' ? [seconds, 1] : [minutes, 60];
  // Seconds per step, and where in the day the walk starts.
  const step = own.length > 0 ? unit * 60 : (unit * recur.interval) % 86_400 || 86_400;
  const origin = dtstart.hour * 3600 + dtstart.minute * 60 + dtstart.second;
  const key = [freq, step, hours, minutes, origin].join('|');
  // Steps per instance (ical.js runs through its own list at every step, matching or not: the list multiplies steps
  // and instances alike); Infinity when no step ever matches.
  const ratio = cached(ratioCache, key, () => {
    const period = 86_400 / gcd(step, 86_400);
    let matches = 0;
    for (let k = 0; k < period; k++) {
      const tod = (origin + k * step) % 86_400;
      if (filters.every((f) => f(tod))) matches += 1;
    }
    return matches === 0 ? Number.POSITIVE_INFINITY : period / matches;
  });
  if (ratio === Number.POSITIVE_INFINITY) return `FREQ=${freq} whose time filters never match a time it steps on`;
  // Refused even when COUNT or UNTIL bounds it: estimating that walk means modelling every list ical.js runs through
  // (a MINUTELY rule steps its BYSECOND list too), and no calendar app writes such rules — invitations do.
  return ratio > MAX_STEPS_PER_INSTANCE ? `FREQ=${freq} with time filters that skip too many of the times it steps on` : undefined;
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
export function seriesWalker(master: Component, zone: string): SeriesWalk {
  refuseUnwalkable(master);
  const dtstart = startTimeOf(master);
  // Inside the guard: an RDATE/EXDATE value is decoded on first read, and a malformed one throws.
  const excluded = guarded(() => exclusions(master, zone));
  if (!master.hasProperty('rrule')) return listWalk(master, dtstart, zone, excluded);
  const { view, odd } = guarded(() => walkView(master, dtstart));
  const it = guarded(() => new ICAL.RecurExpansion({ component: view, dtstart }));
  const repeated = repeats(odd, zone);
  let skipped = 0;
  const next = (): Time | null => {
    for (;;) {
      // ical.js answers `undefined` (not null) once the set is exhausted.
      const t = guarded(() => (it.next() as Time | undefined) ?? null);
      if (!t) return null;
      const r = roughStartMs(t);
      if (!repeated(t, r) && !excluded(t, r)) return t;
      if (++skipped > MAX_SKIPPED) throw new UnexpandableRuleError(`more than ${MAX_SKIPPED} excluded occurrences`);
    }
  };
  return Object.assign(next, { exact: odd.length === 0 });
}

/**
 * The walk of a series without an RRULE: DTSTART and its RDATEs (RFC 5545
 * §3.8.5.3 makes DTSTART an instance whatever else the set holds; ical.js
 * yields it only through a rule), sorted by instant here — the list is
 * finite. Not ical.js's: it starts such a list at DTSTART's place, found by a
 * binary search on its own sort key, where a value written another way can
 * tie with DTSTART (floating 09:00 against 09:00Z, a DATE against midnight
 * UTC) and the search can land past it. Each instant once; EXDATEs apply.
 */
function listWalk(master: Component, dtstart: Time, zone: string, excluded: (t: Time, rough: number) => boolean): SeriesWalk {
  const values = guarded(() => [...rdateStarts(master), dtstart]);
  const sorted = guarded(() => values.map((t) => ({ t, at: instantOf(t, zone).getTime() }))).sort((a, b) => a.at - b.at);
  const given = new Set<string>();
  let i = 0;
  const next = (): Time | null => {
    while (i < sorted.length) {
      const t = (sorted[i++] as { t: Time }).t;
      const key = occKey(t, zone);
      if (given.has(key)) continue;
      given.add(key);
      if (!excluded(t, roughStartMs(t))) return t;
    }
    return null;
  };
  return Object.assign(next, { exact: true });
}

/**
 * A series' walk. `exact`: the instances come in exact start order. ical.js
 * orders a floating or DATE value as though it were UTC, so a series that
 * mixes those with fixed values (an RDATE written another way than DTSTART)
 * can come out up to a zone offset (or a day) out of order.
 */
export interface SeriesWalk {
  (): Time | null;
  exact: boolean;
}

/** Instances one walk may skip (excluded or repeated) in all: its bound, like the steps its callers count. */
export const MAX_SKIPPED = MAX_EXPANSION_STEPS;

/**
 * Whether an instance repeats one already given. Values written alike come
 * out in exact order (ical.js sorts on what `roughStartMs` computes, exact
 * between them), so a repeat directly follows its twin among those of its
 * kind. A twin written another way — a fixed value for a floating one — can
 * only involve an RDATE of another kind than DTSTART: those few are looked up
 * by key, and only for an instance near one. (A DATE is never the same
 * occurrence as a date-time.)
 */
function repeats(odd: Time[], zone: string): (t: Time, rough: number) => boolean {
  const last = new Map<string, number>();
  const timed = odd.filter((t) => !t.isDate);
  const nearby = timed.map(roughStartMs).sort((a, b) => a - b);
  const keys = new Set(timed.map((t) => occKey(t, zone)));
  const given = new Set<string>();
  return (t, r) => {
    const kind = kindOf(t);
    if (last.get(kind) === r) return true;
    last.set(kind, r);
    if (kind === 'date' || !near(nearby, r)) return false;
    const key = occKey(t, zone);
    if (!keys.has(key)) return false;
    if (given.has(key)) return true;
    given.add(key);
    return false;
  };
}

/** Whether a sorted list holds a value within ROUGH_MARGIN_MS of `r`. */
function near(sorted: number[], r: number): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) < r - ROUGH_MARGIN_MS) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && (sorted[lo] as number) <= r + ROUGH_MARGIN_MS;
}

/**
 * The master as ical.js's RecurExpansion should see it (it reads a component
 * through `hasProperty`/`getAllProperties`, once, as it starts):
 *  - no EXDATE: `exclusions` applies them;
 *  - an RDATE PERIOD comes back from ical.js as an ICAL.Period, whose
 *    `compare` means "overlaps" and which is no Time — the walk crashed on
 *    it — so each becomes its start (its end: `SeriesShape.periodEnds`).
 */
function walkView(master: Component, dtstart: Time): { view: Component; odd: Time[] } {
  const dates = rdateStarts(master);
  // The RRULE's instances are written like DTSTART; these are not.
  const odd = dates.filter((t) => kindOf(t) !== kindOf(dtstart));
  const rdate = [{ getValues: () => dates }];
  const props = (name: string) => (name === 'rdate' ? rdate : name === 'exdate' ? [] : master.getAllProperties(name));
  const view = { hasProperty: (name: string) => props(name).length > 0, getAllProperties: props } as unknown as Component;
  return { view, odd };
}

type Period = InstanceType<typeof ICAL.Period>;

function rdateValues(master: Component): Array<Time | Period> {
  return master.getAllProperties('rdate').flatMap((p) => p.getValues() as Array<Time | Period>);
}

/** The instants the RDATEs add, each as its start (an RDATE PERIOD's length: `SeriesShape.periodEnds`). */
function rdateStarts(master: Component): Time[] {
  return rdateValues(master).map((v) => (v instanceof ICAL.Period ? v.start : v));
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
 * Whether an instance is one the master's EXDATEs remove, as ical.js decides
 * it for a single EXDATE: a DATE removes every instance on that day (by the
 * instance's own date), a date-time removes the instance at that instant.
 * Values written another way than the instance — floating against fixed —
 * compare as instants, like occurrence keys; that costs zone arithmetic, so
 * only for an instance near such an EXDATE. A DATE instance (an all-day date
 * in a timed series) is removed by a date-time at the midnight that starts
 * its date, by that value's own wall clock — as this server writes one
 * (`recurrenceValue`), and as other writers do in their own zone. Not by its
 * instant: midnight in the display zone, or in UTC, is also the instant of
 * a timed occurrence (8 PM in New York is midnight UTC), which one EXDATE
 * would then remove with it.
 */
function exclusions(master: Component, zone: string): (t: Time, rough: number) => boolean {
  const values = master.getAllProperties('exdate').flatMap((p) => p.getValues() as Time[]);
  if (values.length === 0) return () => false;
  const days = new Set<string>();
  const midnights = new Set<string>();
  const rough = { floating: new Set<number>(), fixed: new Set<number>() };
  const timed = values.filter((v) => !v.isDate);
  const sorted = (kind: 'floating' | 'fixed') => timed.filter((v) => kindOf(v) === kind).map(roughStartMs).sort((a, b) => a - b);
  const across = { fixed: sorted('floating'), floating: sorted('fixed') };
  let instants: Set<number> | undefined;
  for (const v of values) {
    const kind = kindOf(v);
    if (kind === 'date') days.add(ymdOf(v));
    else {
      rough[kind].add(roughStartMs(v));
      if (v.hour === 0 && v.minute === 0 && v.second === 0) midnights.add(ymdOf(v));
    }
  }
  return (t, r) => {
    if (days.has(ymdOf(t))) return true;
    const kind = kindOf(t);
    if (kind === 'date') return midnights.has(ymdOf(t));
    if (rough[kind].has(r)) return true;
    if (!near(across[kind], r)) return false;
    instants ??= new Set(timed.map((v) => instantOf(v, zone).getTime()));
    return instants.has(instantOf(t, zone).getTime());
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
  /**
   * Instants. For an all-day occurrence: the day boundaries in the request's
   * zone (`dayZone`), so a window keeps the days it was asked for; its key
   * (`occ`, the date) depends on no zone.
   */
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

function allDaySpan(startYmd: string, days: number, dayZone: string): Span {
  const endExclusive = addDaysYmd(startYmd, days);
  return {
    allDay: true,
    start: startOfDay(startYmd, dayZone),
    end: startOfDay(endExclusive, dayZone),
    startYmd,
    endYmd: addDaysYmd(endExclusive, -1),
  };
}

/**
 * The span of a component from its own DTSTART / DTEND (or DURATION): an
 * all-day one between midnights in `dayZone` (the request's), a timed one read
 * in `zone` (the display zone, which reads floating values).
 */
function componentSpan(comp: Component, zone: string, dayZone: string): Span {
  const startT = startTimeOf(comp);
  const endT = endTimeOf(comp, startT);
  if (startT.isDate) {
    const startYmd = ymdOf(startT);
    // An all-day DTEND is exclusive; one on or before DTSTART (or a date-time) means one day.
    const days = endT.isDate ? daysBetween(startYmd, ymdOf(endT)) : 1;
    return allDaySpan(startYmd, Math.max(1, days), dayZone);
  }
  const start = instantOf(startT, zone);
  const end = endInstantOf(comp, zone);
  return { allDay: false, start, end: end.getTime() < start.getTime() ? start : end };
}

function recurrenceIdOf(comp: Component): Time {
  return comp.getFirstPropertyValue('recurrence-id') as Time;
}

function overrideOccurrence(ovr: Component, master: Component | undefined, key: string, zone: string, dayZone: string): Occurrence {
  return {
    comp: ovr,
    ...(master ? { master } : {}),
    ...componentSpan(ovr, zone, dayZone),
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
  length: Length;
  /** A timed instance's end instant (ms) by its `#occ=` key, for an instance an RDATE PERIOD gives its own length. */
  periodEnds: Map<string, number>;
  /** The longest any instance lasts (ms). */
  longestMs: number;
}

function seriesShape(master: Component, zone: string): SeriesShape {
  // Only its kind and days are used: no day boundary is drawn here.
  const s = componentSpan(master, zone, zone);
  // Every instance lasts the series' own length (RFC 5545 §3.8.5.3; see Length).
  const length = s.allDay ? { ms: 0 } : lengthOf(master, zone);
  const periodEnds = new Map<string, number>();
  // A DURATION's day is 25 hours across a DST change.
  let longestMs = Math.max(0, roughMs(length)) + ('ms' in length ? 0 : 3_600_000);
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
    length,
    periodEnds,
    longestMs,
  };
}

/**
 * A natural instance of a series. An all-day series' days are bounded in
 * `dayZone`; a timed series' instances are read in `zone` — a DATE one (an
 * RDATE;VALUE=DATE) too, at its midnight there: the walk is ordered in that
 * zone, and a start from another could end it before an instance it has yet
 * to give.
 */
function naturalOccurrence(master: Component, t: Time, key: string, shape: SeriesShape, zone: string, dayZone: string): Occurrence {
  let span: Span;
  if (shape.allDay) span = allDaySpan(ymdOf(t), shape.days, dayZone);
  else {
    const start = instantOf(t, zone);
    const length = shape.length;
    const end = shape.periodEnds.get(key) ?? ('ms' in length ? start.getTime() + length.ms : endAfter(t, length, zone).getTime());
    span = { allDay: false, start, end: new Date(Math.max(start.getTime(), end)) };
  }
  return { comp: master, master, ...span, occ: key, recurrenceTime: t, isOverride: false, recurring: true };
}

/** The single occurrence of a non-recurring event (floating times read in `zone`, all-day days bounded in `dayZone`). */
export function singleOccurrence(master: Component, zone: string, dayZone: string = zone): Occurrence {
  return { comp: master, ...componentSpan(master, zone, dayZone), isOverride: false, recurring: false };
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
  /** The display zone: reads floating values, and so makes every `#occ=` key. */
  zone: string;
  /** Where an all-day occurrence's days begin and end: the zone the window was asked in. Default: `zone`. */
  dayZone?: string;
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
  const dayZone = opts.dayZone ?? zone;
  const { master, overrides } = parts;
  if (master && !isRecurringMaster(master)) {
    const single = singleOccurrence(master, zone, dayZone);
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
    // Instances come in start order — to within ROUGH_MARGIN_MS when the walk's order can stray (see SeriesWalk).
    let slack = 0;
    const consider = (t: Time): 'next' | 'stop' => {
      const key = occKey(t, zone);
      const natural = naturalOccurrence(master, t, key, shape, zone, dayZone);
      // Past the window, only moved overrides can still matter (below).
      if (natural.start.getTime() >= to.getTime() + slack) return 'stop';
      if (natural.start.getTime() >= to.getTime()) return 'next';
      const ovr = byKey.get(key);
      let occ = natural;
      if (ovr) {
        visited.add(key);
        occ = overrideOccurrence(ovr, master, key, zone, dayZone);
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
    let next: SeriesWalk | undefined;
    try {
      next = seriesWalker(master, zone);
      if (!next.exact) slack = ROUGH_MARGIN_MS;
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
        stopOn(err); // mid-walk (e.g. an ical.js failure, or too many excluded instances): keep what was found
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
    const occ = overrideOccurrence(ovr, master, key, zone, dayZone);
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
 * fallback to another occurrence. `zone` is the display zone the key was
 * made in; `opts.dayZone` bounds an all-day occurrence's days (default `zone`).
 */
export function findOccurrence(
  parts: EventParts,
  occ: string,
  zone: string,
  opts: { dayZone?: string; maxSteps?: number } = {},
): Occurrence | undefined {
  const { master, overrides } = parts;
  const dayZone = opts.dayZone ?? zone;
  const maxSteps = opts.maxSteps ?? MAX_EXPANSION_STEPS;
  for (const o of overrides) {
    if (occKey(recurrenceIdOf(o), zone) === occ) return overrideOccurrence(o, master, occ, zone, dayZone);
  }
  if (!master || !isRecurringMaster(master)) return undefined;
  const shape = seriesShape(master, zone);
  const target = occ.length === 10 ? startOfDay(occ, zone).getTime() : Date.parse(occ);
  const next = seriesWalker(master, zone);
  // Past the target it is not coming — later, when the walk's order can stray (see SeriesWalk).
  const past = target + (next.exact ? 0 : ROUGH_MARGIN_MS);
  for (let steps = 0; steps < maxSteps; steps++) {
    const t = next();
    if (!t) return undefined;
    if (roughStartMs(t) < target - ROUGH_MARGIN_MS) continue;
    const key = occKey(t, zone);
    if (key === occ) return naturalOccurrence(master, t, key, shape, zone, dayZone);
    if (instantOf(t, zone).getTime() > past) return undefined;
  }
  throw tooLong(`occurrence ${occ}`, maxSteps);
}

/**
 * The series' first instance (null when it has none): the walk's first, or —
 * when its order can stray (see SeriesWalk) — the earliest nearby. Values
 * written alike come out in exact order, so that is the first of one of the
 * kinds the series holds near the start (DTSTART's, and its RDATEs'): the
 * walk reads on only until each of those has shown one, not through every
 * instance nearby — a dense rule has thousands.
 */
export function firstInstance(master: Component, zone: string, maxSteps: number = MAX_EXPANSION_STEPS): Time | null {
  const next = seriesWalker(master, zone);
  const first = next();
  if (!first || next.exact) return first;
  // An instance can come before `first` only if its rough start is within ROUGH_MARGIN_MS of it.
  const through = roughStartMs(first) + ROUGH_MARGIN_MS;
  const nearby = rdateStarts(master).filter((t) => roughStartMs(t) <= through);
  const kinds = new Set([kindOf(startTimeOf(master)), ...nearby.map(kindOf)]);
  const firsts = new Map([[kindOf(first), first]]);
  for (let steps = 0; [...kinds].some((kind) => !firsts.has(kind)); steps++) {
    if (steps >= maxSteps) throw tooLong("the series' first occurrence", maxSteps);
    const t = next();
    if (!t || roughStartMs(t) > through) break;
    if (!firsts.has(kindOf(t))) firsts.set(kindOf(t), t);
  }
  let earliest = first;
  for (const t of firsts.values()) if (instantOf(t, zone).getTime() < instantOf(earliest, zone).getTime()) earliest = t;
  return earliest;
}

/**
 * The other instances (their keys) an EXDATE `value` meant for occurrence
 * `occ` (at `at`) would also remove. Only a series that mixes all-day dates
 * and timed instances has any: a DATE EXDATE removes every instance on its
 * date, and a date-time one at midnight both the timed instance there and a
 * DATE instance of that date (see `exclusions`). Walked once, without an
 * occurrence cap, through the instances that could collide (within
 * ROUGH_MARGIN_MS of the occurrence).
 */
export function alsoExcluded(master: Component, value: Time, occ: string, at: Date, zone: string, maxSteps: number = MAX_EXPANSION_STEPS): string[] {
  const kind = startTimeOf(master).isDate;
  if (!guarded(() => rdateStarts(master)).some((t) => t.isDate !== kind)) return [];
  // A master holding that one EXDATE, as `exclusions` reads it (EXDATE is the only property it asks for).
  const one = { getAllProperties: () => [{ getValues: () => [value] }] } as unknown as Component;
  const hit = exclusions(one, zone);
  const next = seriesWalker(master, zone);
  const out: string[] = [];
  for (let steps = 0; steps < maxSteps; steps++) {
    const t = next();
    if (!t) return out;
    const r = roughStartMs(t);
    if (r < at.getTime() - ROUGH_MARGIN_MS) continue;
    if (r > at.getTime() + ROUGH_MARGIN_MS) return out;
    const key = occKey(t, zone);
    if (key !== occ && hit(t, r)) out.push(key);
  }
  throw tooLong(`the occurrences next to ${occ}`, maxSteps);
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
