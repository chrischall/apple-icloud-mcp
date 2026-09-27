import { AppleToolError, errorMessage } from '../errors.js';
import { startOfDay } from '../time.js';
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
 * (`FREQ=WEEKLY;BYMONTHDAY=1`), or 500 EXDATEs in a row, makes it throw. Such
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
    const problem = ruleProblem(prop.getFirstValue() as Recur);
    if (problem) throw new UnexpandableRuleError(problem);
  }
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
 * The instances of a series (RRULE + RDATE − EXDATE, in start order) as a
 * `next()` that answers null at the end. Throws `UnexpandableRuleError`, up
 * front or mid-walk, instead of hanging or leaking an ical.js error.
 */
export function seriesWalker(master: Component): () => Time | null {
  refuseUnwalkable(master);
  const it = guarded(() => new ICAL.RecurExpansion({ component: master, dtstart: startTimeOf(master) }));
  // ical.js answers `undefined` (not null) once the set is exhausted.
  return () => guarded(() => (it.next() as Time | undefined) ?? null);
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

/** Shape of every natural instance of a series: the master's own length. */
interface SeriesShape {
  allDay: boolean;
  days: number;
  durationMs: number;
}

function seriesShape(master: Component, zone: string): SeriesShape {
  const s = componentSpan(master, zone);
  return {
    allDay: s.allDay,
    days: s.allDay ? daysBetween(s.startYmd as string, s.endYmd as string) + 1 : 0,
    durationMs: s.end.getTime() - s.start.getTime(),
  };
}

function naturalOccurrence(master: Component, t: Time, key: string, shape: SeriesShape, zone: string): Occurrence {
  let span: Span;
  if (shape.allDay) span = allDaySpan(ymdOf(t), shape.days, zone);
  else {
    const start = instantOf(t, zone);
    span = { allDay: false, start, end: new Date(start.getTime() + shape.durationMs) };
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
    const skipBelow = from.getTime() - shape.durationMs - ROUGH_MARGIN_MS;
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
      next = seriesWalker(master);
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
        stopOn(err); // mid-walk (e.g. 500 EXDATEs in a row): keep what was found
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
  const next = seriesWalker(master);
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

/**
 * How many RRULE instances fall before `before` — what a COUNT-bounded rule
 * has used up when it is split there. RDATE/EXDATE do not change COUNT.
 */
export function countRuleInstancesBefore(master: Component, before: Date, zone: string, maxSteps: number = MAX_EXPANSION_STEPS): number {
  const rule = ruleOf(master);
  if (!rule) return 0;
  refuseUnwalkable(master);
  const it = guarded(() => rule.iterator(startTimeOf(master)));
  let n = 0;
  for (let steps = 0; steps < maxSteps; steps++) {
    const t = guarded(() => it.next() as Time | null);
    if (!t) return n;
    if (roughStartMs(t) >= before.getTime() - ROUGH_MARGIN_MS && instantOf(t, zone).getTime() >= before.getTime()) return n;
    n += 1;
  }
  throw tooLong('the split point', maxSteps);
}
