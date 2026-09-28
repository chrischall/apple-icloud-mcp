import { addDaysYmd, formatDateOnly, putInstant, ymdInZone, zonedToInstant } from '../time.js';

/**
 * Free-time arithmetic: merge busy intervals, then subtract them from each
 * day's working hours in the request's zone (`zone`: the call's `timeZone`,
 * else DISPLAY_TZ; built per day, so DST changes move the working hours with
 * the clock, not with UTC). The busy intervals come already resolved: floating
 * events at their DISPLAY_TZ instants, all-day ones on this zone's days.
 */

export interface Interval {
  start: number;
  end: number;
}

/** Sort and merge overlapping or touching intervals; empty ones are dropped. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

export interface ClockTime {
  hour: number;
  minute: number;
}

/** `HH:MM` → `{hour, minute}` (the schema has already checked the shape). */
export function parseClock(value: string): ClockTime {
  const [hour, minute] = value.split(':').map(Number) as [number, number];
  return { hour, minute };
}

export interface FreeTimeOptions {
  from: Date;
  to: Date;
  zone: string;
  /** Nothing before this instant is offered: the tool passes "now", because a slot in the past can never be booked. */
  notBefore?: Date;
  workdayStart: ClockTime;
  workdayEnd: ClockTime;
  weekdaysOnly: boolean;
  minMinutes: number;
  /** Merged busy intervals. */
  busy: readonly Interval[];
}

export interface FreeDay {
  date: string;
  dateDisplay: string;
  free: Array<Record<string, unknown>>;
}

export interface FreeTimeResult {
  days: FreeDay[];
  /** Weekend days not considered (weekdaysOnly). */
  weekendDays: number;
  /** Days whose working hours fall outside the window (or are already past). */
  outsideWindow: number;
}

function gaps(start: number, end: number, busy: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let cursor = start;
  for (const b of busy) {
    if (b.end <= cursor) continue;
    if (b.start >= end) break;
    if (b.start > cursor) out.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor < end) out.push({ start: cursor, end });
  return out;
}

export function computeFreeTime(o: FreeTimeOptions): FreeTimeResult {
  const lower = Math.max(o.from.getTime(), o.notBefore?.getTime() ?? 0);
  const upper = o.to.getTime();
  const lastDay = ymdInZone(new Date(upper - 1), o.zone);
  const minMs = o.minMinutes * 60_000;
  const days: FreeDay[] = [];
  let weekendDays = 0;
  let outsideWindow = 0;
  for (let ymd = ymdInZone(o.from, o.zone); ymd <= lastDay; ymd = addDaysYmd(ymd, 1)) {
    const [year, month, day] = ymd.split('-').map(Number) as [number, number, number];
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (o.weekdaysOnly && (weekday === 0 || weekday === 6)) {
      weekendDays += 1;
      continue;
    }
    const start = Math.max(zonedToInstant({ year, month, day, ...o.workdayStart }, o.zone).getTime(), lower);
    const end = Math.min(zonedToInstant({ year, month, day, ...o.workdayEnd }, o.zone).getTime(), upper);
    if (end <= start) {
      outsideWindow += 1;
      continue;
    }
    const free = gaps(start, end, o.busy)
      .filter((g) => g.end - g.start >= minMs)
      .map((g) => {
        const slot: Record<string, unknown> = {};
        putInstant(slot, 'start', new Date(g.start), o.zone);
        putInstant(slot, 'end', new Date(g.end), o.zone);
        slot.minutes = Math.round((g.end - g.start) / 60_000);
        return slot;
      });
    days.push({ date: ymd, dateDisplay: formatDateOnly(ymd), free });
  }
  return { days, weekendDays, outsideWindow };
}
