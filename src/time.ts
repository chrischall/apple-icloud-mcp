import { InvalidArgumentError } from './errors.js';

/**
 * Zone-correct date handling, with no dependency beyond `Intl`.
 *
 * Two rules every tool follows, both learned the hard way in the sibling
 * servers:
 *
 *  1. **An input with no offset is wall-clock time in the display zone, never
 *     UTC.** `2026-10-03T16:30` means 4:30 PM where the user is. A hosted
 *     child runs in UTC, so reading it as the process zone would silently
 *     shift every event by the UTC offset.
 *  2. **Every emitted instant carries an explicit offset plus a `…Display`
 *     sibling with the weekday**, so a reader never has to guess which zone a
 *     value is in — mixing naive and `Z` values in one payload moved a
 *     10:38 PM event onto the next calendar day in ofw-mcp.
 *
 * Parsing is strict and consumes the WHOLE string. A lenient parser that ate
 * only the leading `YYYY-MM-DD` of `2026-08-18T16:30` turned a timed event
 * into midnight and then failed with a misleading ordering error.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

/**
 * `Date.UTC` without its two-digit-year quirk: `Date.UTC(50, 0, 1)` is 1950, so
 * every year 0001–0099 would silently become a date in the 1900s. Month and day
 * overflow exactly as they do in `Date.UTC`.
 */
function utcMs(year: number, monthIndex: number, day: number, h: number, mi: number, s: number, ms: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, monthIndex, day);
  d.setUTCHours(h, mi, s, ms);
  return d.getTime();
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    partsFormatters.set(zone, f);
  }
  return f;
}

/** The wall-clock fields of `date` in `zone`. */
export function zonedParts(date: Date, zone: string): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of partsFormatter(zone).formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS.indexOf(out.weekday as string),
  };
}

/** The zone's UTC offset at `instantMs`, in milliseconds (e.g. -4h for EDT). */
export function zoneOffsetMs(instantMs: number, zone: string): number {
  const d = new Date(instantMs);
  const p = zonedParts(d, zone);
  const asUtc = utcMs(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
  // Compare at whole-second precision: the formatter drops milliseconds.
  return asUtc - (instantMs - d.getUTCMilliseconds());
}

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
}

/**
 * The instant at which the wall clock in `zone` reads `wall`.
 *
 * DST edges are resolved the way calendar apps do it: a time that occurs
 * twice (the fall-back hour) is the EARLIER one; a time that does not exist
 * (the spring-forward gap) is moved FORWARD by the gap (02:30 → 03:30).
 */
export function zonedToInstant(wall: WallClock, zone: string): Date {
  const h = wall.hour ?? 0;
  const mi = wall.minute ?? 0;
  const s = wall.second ?? 0;
  const ms = wall.millisecond ?? 0;
  const local = utcMs(wall.year, wall.month - 1, wall.day, h, mi, s, ms);
  const DAY = 86_400_000;
  const offsets = [...new Set([zoneOffsetMs(local - DAY, zone), zoneOffsetMs(local, zone), zoneOffsetMs(local + DAY, zone)])];
  const matches: number[] = [];
  for (const off of offsets) {
    const t = local - off;
    const p = zonedParts(new Date(t), zone);
    if (p.year === wall.year && p.month === wall.month && p.day === wall.day && p.hour === h && p.minute === mi && p.second === s) {
      matches.push(t);
    }
  }
  if (matches.length > 0) return new Date(Math.min(...matches));
  // In a gap: apply the offset in force BEFORE the transition, which lands
  // the requested wall time shifted forward by the size of the gap.
  return new Date(local - zoneOffsetMs(local - DAY, zone));
}

/** `-04:00` style offset from milliseconds. */
export function formatOffset(offsetMs: number): string {
  const totalMin = Math.round(offsetMs / 60_000);
  const sign = totalMin < 0 ? '-' : '+';
  const abs = Math.abs(totalMin);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

const displayFormatters = new Map<string, Intl.DateTimeFormat>();

function displayFormatter(zone: string): Intl.DateTimeFormat {
  let f = displayFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    });
    displayFormatters.set(zone, f);
  }
  return f;
}

export interface FormattedInstant {
  /** ISO-8601 with an explicit offset, e.g. `2026-07-27T23:31:09-04:00`. */
  iso: string;
  /** Human label with weekday and zone, e.g. `Mon, Jul 27, 2026, 11:31 PM EDT`. */
  display: string;
}

/** Render an instant in `zone`. */
export function formatInstant(date: Date, zone: string): FormattedInstant {
  const p = zonedParts(date, zone);
  const iso =
    `${String(p.year).padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}` +
    formatOffset(zoneOffsetMs(date.getTime(), zone));
  return { iso, display: displayFormatter(zone).format(date) };
}

/**
 * Add `<field>` and `<field>Display` to `target` for an instant. The helper
 * every module uses so the pairing is spelled one way everywhere.
 */
export function putInstant(target: Record<string, unknown>, field: string, date: Date | undefined, zone: string): void {
  if (!date) return;
  const f = formatInstant(date, zone);
  target[field] = f.iso;
  target[`${field}Display`] = f.display;
}

const dateOnlyFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  weekday: 'short',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The parts of a real `YYYY-MM-DD` calendar date, or a thrown error naming the
 * function and the value. These helpers take dates from upstream payloads as
 * well as from `parseDateInput`, and `Date` arithmetic silently rolls a bad one
 * over (`2026-02-30` → March 2; `--03-15`, a birthday without a year, → a date
 * in 1 BC) — a label with the wrong weekday that nothing flags.
 */
function ymdParts(ymd: string, fn: string): [number, number, number] {
  const m = YMD_RE.exec(ymd);
  const [y, mo, d] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  if (!m || y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
    throw new InvalidArgumentError(`${fn}: "${ymd}" is not a calendar date (YYYY-MM-DD).`);
  }
  return [y, mo, d];
}

/** `Mon, Jul 27, 2026` for a calendar date (`YYYY-MM-DD`), with no zone involved. */
export function formatDateOnly(ymd: string): string {
  const [y, m, d] = ymdParts(ymd, 'formatDateOnly');
  return dateOnlyFormatter.format(new Date(utcMs(y, m - 1, d, 0, 0, 0, 0)));
}

/** `YYYY-MM-DD` of `date` in `zone`. */
export function ymdInZone(date: Date, zone: string): string {
  const p = zonedParts(date, zone);
  return `${String(p.year).padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Calendar arithmetic on a `YYYY-MM-DD` string (zone-free). */
export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymdParts(ymd, 'addDaysYmd');
  const t = new Date(utcMs(y, m - 1, d + days, 0, 0, 0, 0));
  return `${String(t.getUTCFullYear()).padStart(4, '0')}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** Midnight at the start of `ymd` in `zone`. */
export function startOfDay(ymd: string, zone: string): Date {
  const [y, m, d] = ymdParts(ymd, 'startOfDay');
  return zonedToInstant({ year: y, month: m, day: d }, zone);
}

export interface ParsedDateInput {
  /** The instant. For a date-only input: the start of that day in the zone. */
  instant: Date;
  /** True for `YYYY-MM-DD` with no time part. */
  dateOnly: boolean;
  /** The calendar date: as written for date-only input, else the date of the instant in the zone. */
  ymd: string;
  /** True when the input fixed its own instant with `Z` or `±HH:MM`. */
  hasOffset: boolean;
}

const DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|z|[+-]\d{2}(?::?\d{2})?)?)?$/;

/** Days in `month` (1–12) of `year`, proleptic Gregorian — years 0–99 are NOT shifted to the 1900s. */
export function daysInMonth(year: number, month: number): number {
  return new Date(utcMs(year, month, 0, 0, 0, 0, 0)).getUTCDate();
}

/**
 * Parse a user-supplied date or date-time.
 *
 * Accepted: `YYYY-MM-DD`, `YYYY-MM-DDTHH:MM[:SS[.fff]]`, optionally followed
 * by `Z` or `±HH[:MM]`. A space may replace the `T`. Anything else — including
 * an offset on a bare date — throws `InvalidArgumentError` naming the field
 * and the value, BEFORE any ordering check could misreport it.
 */
export function parseDateInput(value: string, field: string, zone: string): ParsedDateInput {
  const m = DATE_RE.exec(value.trim());
  const bad = (why: string): never => {
    throw new InvalidArgumentError(
      `${field} "${value}" is not a valid date: ${why}.`,
      `Use YYYY-MM-DD for a date, or YYYY-MM-DDTHH:MM (local time in ${zone}), optionally with Z or an offset like -04:00.`,
    );
  };
  if (!m) return bad('expected YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM]');
  const [, ys, mos, ds, hs, mis, ss, frac, off] = m as unknown as [string, string, string, string, string?, string?, string?, string?, string?];
  const year = Number(ys);
  const month = Number(mos);
  const day = Number(ds);
  // Year 0000 (1 BC) has no faithful rendering: Intl prints it as year 1.
  if (year < 1) return bad(`year ${ys} is out of range`);
  if (month < 1 || month > 12) return bad(`month ${mos} is out of range`);
  if (day < 1 || day > daysInMonth(year, month)) return bad(`day ${ds} does not exist in ${ys}-${mos}`);
  const ymdWritten = `${ys}-${mos}-${ds}`;
  if (hs === undefined) {
    return { instant: startOfDay(ymdWritten, zone), dateOnly: true, ymd: ymdWritten, hasOffset: false };
  }
  const hour = Number(hs);
  const minute = Number(mis);
  const second = ss === undefined ? 0 : Number(ss);
  const millisecond = frac === undefined ? 0 : Math.floor(Number(`0.${frac}`) * 1000);
  if (hour > 23) return bad(`hour ${hs} is out of range`);
  if (minute > 59) return bad(`minute ${mis} is out of range`);
  if (second > 59) return bad(`second ${ss} is out of range`);
  let instant: Date;
  if (off !== undefined) {
    let offsetMin = 0;
    if (off !== 'Z' && off !== 'z') {
      const sign = off.startsWith('-') ? -1 : 1;
      const digits = off.slice(1).replace(':', '');
      const oh = Number(digits.slice(0, 2));
      const om = digits.length > 2 ? Number(digits.slice(2)) : 0;
      if (oh > 18 || om > 59) return bad(`offset ${off} is out of range`);
      offsetMin = sign * (oh * 60 + om);
    }
    instant = new Date(utcMs(year, month - 1, day, hour, minute, second, millisecond) - offsetMin * 60_000);
  } else {
    instant = zonedToInstant({ year, month, day, hour, minute, second, millisecond }, zone);
  }
  return { instant, dateOnly: false, ymd: ymdInZone(instant, zone), hasOffset: off !== undefined };
}
