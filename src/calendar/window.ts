import { canonicalTimeZone, getDisplayTimeZone } from '../config.js';
import { InvalidArgumentError } from '../errors.js';
import { addDaysYmd, formatInstant, parseDateInput, putInstant, startOfDay, ymdInZone, zonedParts, zonedToInstant } from '../time.js';

/**
 * The query window of list / search / free-time, and the rules that keep a
 * windowed answer honest:
 *  - the window is ALWAYS stated in the response, on an empty result too;
 *  - `toDate` and `daysAhead` set the same end and are never both accepted;
 *  - a window longer than the maximum is REFUSED, never clipped — a silently
 *    shortened window reads exactly like a complete answer.
 */

export interface WindowArgs {
  fromDate?: string;
  toDate?: string;
  daysAhead?: number;
}

export interface Window {
  from: Date;
  /** Exclusive. */
  to: Date;
  zone: string;
}

/**
 * The zone for a call: the `timeZone` argument in its CANONICAL spelling,
 * else DISPLAY_TZ (read now, already canonical). The name travels on — into
 * TZIDs, VTIMEZONE lookups and responses — where `america/new_york` is not
 * the identifier `America/New_York` is, although `Intl` accepts both.
 */
export function resolveZone(timeZone: string | undefined): string {
  if (timeZone === undefined) return getDisplayTimeZone();
  const canonical = canonicalTimeZone(timeZone);
  if (canonical === undefined) {
    throw new InvalidArgumentError(`timeZone "${timeZone}" is not a known IANA time zone.`, 'Use a zone like America/New_York or Europe/London.');
  }
  return canonical;
}

/** `instant` moved by `days` calendar days at the same wall-clock time in `zone` (DST-safe). */
export function addDaysWall(instant: Date, days: number, zone: string): Date {
  const p = zonedParts(instant, zone);
  const ymd = addDaysYmd(ymdInZone(instant, zone), days);
  const [year, month, day] = ymd.split('-').map(Number) as [number, number, number];
  return zonedToInstant(
    { year, month, day, hour: p.hour, minute: p.minute, second: p.second, millisecond: instant.getUTCMilliseconds() },
    zone,
  );
}

export function resolveWindow(args: WindowArgs, opts: { zone: string; now: Date; defaultDays: number; maxDays: number }): Window {
  const { zone, now, defaultDays, maxDays } = opts;
  if (args.toDate !== undefined && args.daysAhead !== undefined) {
    throw new InvalidArgumentError(
      'Pass either toDate or daysAhead, not both — they set the same end of the window and would disagree.',
      'daysAhead: N means toDate = fromDate + N days.',
    );
  }
  const from = args.fromDate !== undefined ? parseDateInput(args.fromDate, 'fromDate', zone).instant : startOfDay(ymdInZone(now, zone), zone);
  let to: Date;
  if (args.toDate !== undefined) {
    to = parseDateInput(args.toDate, 'toDate', zone).instant;
    if (to.getTime() <= from.getTime()) {
      throw new InvalidArgumentError(
        `toDate (${formatInstant(to, zone).display}) must be after fromDate (${formatInstant(from, zone).display}); toDate is exclusive.`,
      );
    }
    if (to.getTime() > addDaysWall(from, maxDays, zone).getTime()) {
      throw new InvalidArgumentError(
        `The window from fromDate to toDate is longer than the ${maxDays}-day maximum. It is refused rather than shortened, ` +
          'so a partial answer is never mistaken for a whole one.',
        `Query it in chunks of at most ${maxDays} days.`,
      );
    }
  } else {
    // daysAhead is bounded by its schema (1 … maxDays), so this never exceeds the maximum.
    to = addDaysWall(from, args.daysAhead ?? defaultDays, zone);
  }
  return { from, to, zone };
}

/** `{from, fromDisplay, to, toDisplay, timeZone}` — stated on every windowed response. */
export function windowJson(w: Window): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  putInstant(out, 'from', w.from, w.zone);
  putInstant(out, 'to', w.to, w.zone);
  out.timeZone = w.zone;
  return out;
}
