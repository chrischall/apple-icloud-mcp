import { describe, expect, it, vi } from 'vitest';
import {
  OFFSET_CACHE_LIMIT,
  addDaysYmd,
  formatDateOnly,
  formatInstant,
  formatOffset,
  parseDateInput,
  putInstant,
  startOfDay,
  ymdInZone,
  zoneOffsetMs,
  zonedParts,
  zonedToInstant,
} from '../src/time.js';
import { InvalidArgumentError } from '../src/errors.js';

const NY = 'America/New_York';
const ADL = 'Australia/Adelaide'; // +09:30 / +10:30 — a half-hour zone with DST
const LHI = 'Australia/Lord_Howe'; // +10:30 / +11:00 — a DST shift of only 30 minutes
const IST = 'Asia/Kolkata'; // +05:30, no DST
const H = 3_600_000;

const iso = (d: Date) => d.toISOString();

describe('zonedParts / zoneOffsetMs / formatOffset', () => {
  it('reads wall-clock fields and the weekday in a zone (24h clock, midnight is 0)', () => {
    expect(zonedParts(new Date('2026-07-28T03:31:09Z'), NY)).toEqual({
      year: 2026, month: 7, day: 27, hour: 23, minute: 31, second: 9, weekday: 1,
    });
    expect(zonedParts(new Date('2026-07-28T04:00:00Z'), NY)).toMatchObject({ day: 28, hour: 0, weekday: 2 });
    expect(zonedParts(new Date('2026-07-28T04:00:00Z'), NY)).toMatchObject({ day: 28, hour: 0 }); // cached formatter
  });

  it('computes offsets across DST and for half-hour zones, ignoring sub-second precision', () => {
    expect(zoneOffsetMs(Date.parse('2026-07-01T12:00:00.750Z'), NY)).toBe(-4 * H);
    expect(zoneOffsetMs(Date.parse('2026-01-15T12:00:00Z'), NY)).toBe(-5 * H);
    expect(zoneOffsetMs(Date.parse('2026-01-15T12:00:00Z'), ADL)).toBe(10.5 * H);
    expect(zoneOffsetMs(Date.parse('2026-07-15T12:00:00Z'), ADL)).toBe(9.5 * H);
    expect(zoneOffsetMs(Date.parse('2026-07-15T12:00:00Z'), IST)).toBe(5.5 * H);
    expect(zoneOffsetMs(Date.parse('1969-12-31T23:59:59.250Z'), 'UTC')).toBe(0);
  });

  it('formats offsets with sign and minutes', () => {
    expect(formatOffset(0)).toBe('+00:00');
    expect(formatOffset(-4 * H)).toBe('-04:00');
    expect(formatOffset(5.5 * H)).toBe('+05:30');
    expect(formatOffset(-2.5 * H)).toBe('-02:30');
    expect(formatOffset(10.5 * H)).toBe('+10:30');
  });
});

describe('zonedToInstant', () => {
  it('resolves an ordinary wall time, defaulting omitted fields to zero', () => {
    expect(iso(zonedToInstant({ year: 2026, month: 10, day: 3, hour: 16, minute: 30 }, NY))).toBe('2026-10-03T20:30:00.000Z');
    expect(iso(zonedToInstant({ year: 2026, month: 10, day: 3 }, NY))).toBe('2026-10-03T04:00:00.000Z');
    expect(iso(zonedToInstant({ year: 2026, month: 1, day: 3, hour: 9, minute: 5, second: 7, millisecond: 250 }, NY))).toBe('2026-01-03T14:05:07.250Z');
    expect(iso(zonedToInstant({ year: 2026, month: 10, day: 3, hour: 9 }, IST))).toBe('2026-10-03T03:30:00.000Z');
  });

  it('moves a time in the New York spring-forward gap forward by the gap (02:30 → 03:30 EDT)', () => {
    const t = zonedToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY);
    expect(iso(t)).toBe('2026-03-08T07:30:00.000Z');
    expect(formatInstant(t, NY).iso).toBe('2026-03-08T03:30:00-04:00');
  });

  it('picks the EARLIER instant for a time in the New York fall-back overlap', () => {
    const t = zonedToInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY);
    expect(iso(t)).toBe('2026-11-01T05:30:00.000Z');
    expect(formatInstant(t, NY).iso).toBe('2026-11-01T01:30:00-04:00');
    // The hour after the overlap is unambiguous.
    expect(iso(zonedToInstant({ year: 2026, month: 11, day: 1, hour: 2, minute: 30 }, NY))).toBe('2026-11-01T07:30:00.000Z');
  });

  it('handles the gap and overlap in a half-hour zone (Adelaide)', () => {
    const gap = zonedToInstant({ year: 2026, month: 10, day: 4, hour: 2, minute: 30 }, ADL);
    expect(formatInstant(gap, ADL).iso).toBe('2026-10-04T03:30:00+10:30');
    const overlap = zonedToInstant({ year: 2026, month: 4, day: 5, hour: 2, minute: 30 }, ADL);
    expect(iso(overlap)).toBe('2026-04-04T16:00:00.000Z');
    expect(formatInstant(overlap, ADL).iso).toBe('2026-04-05T02:30:00+10:30');
  });

  it('handles a 30-minute DST shift (Lord Howe)', () => {
    const gap = zonedToInstant({ year: 2026, month: 10, day: 4, hour: 2, minute: 15 }, LHI);
    expect(formatInstant(gap, LHI).iso).toBe('2026-10-04T02:45:00+11:00');
    const overlap = zonedToInstant({ year: 2026, month: 4, day: 5, hour: 1, minute: 45 }, LHI);
    expect(iso(overlap)).toBe('2026-04-04T14:45:00.000Z');
  });

  it('does not map two-digit years into the 1900s', () => {
    const t = zonedToInstant({ year: 50, month: 3, day: 1, hour: 12 }, 'UTC');
    expect(t.getUTCFullYear()).toBe(50);
    expect(zonedParts(t, 'UTC')).toMatchObject({ year: 50, month: 3, day: 1, hour: 12 });
  });
});

describe('cached zone offsets', () => {
  // Intl, read afresh: what zonedParts / zoneOffsetMs / zonedToInstant returned before the cache.
  const fresh = (zone: string) => new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
  const refParts = (t: number, zone: string) => {
    const o: Record<string, string> = {};
    for (const p of fresh(zone).formatToParts(new Date(t))) o[p.type] = p.value;
    return { year: +o.year!, month: +o.month!, day: +o.day!, hour: +o.hour!, minute: +o.minute!, second: +o.second!, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday!) };
  };
  const refOffset = (t: number, zone: string) => {
    const p = refParts(t, zone);
    const u = new Date(0);
    u.setUTCFullYear(p.year, p.month - 1, p.day);
    u.setUTCHours(p.hour, p.minute, p.second, 0);
    return u.getTime() - (t - new Date(t).getUTCMilliseconds());
  };
  const refInstant = (w: { year: number; month: number; day: number; hour: number; minute: number }, zone: string) => {
    const local = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
    const DAY = 86_400_000;
    const hits = [...new Set([refOffset(local - DAY, zone), refOffset(local, zone), refOffset(local + DAY, zone)])]
      .map((off) => local - off)
      .filter((t) => { const p = refParts(t, zone); return p.day === w.day && p.hour === w.hour && p.minute === w.minute; });
    return hits.length ? Math.min(...hits) : local - refOffset(local - DAY, zone);
  };
  // Each zone around a change: a UTC-hour one (New York), half-hour zones whose changes fall inside a UTC hour
  // (Lord Howe's 30-minute shift, Adelaide, Chatham's +12:45), Kathmandu's 1986 move to +05:45, and Samoa's
  // skipped 2011-12-30.
  const CHANGES: [string, string][] = [
    [NY, '2026-03-08T07:00:00Z'], [NY, '2026-11-01T06:00:00Z'],
    [LHI, '2026-10-03T15:30:00Z'], [LHI, '2026-04-04T15:00:00Z'],
    [ADL, '2026-10-03T16:30:00Z'], ['Pacific/Chatham', '2026-09-26T14:00:00Z'],
    ['Asia/Kathmandu', '1985-12-31T18:30:00Z'], ['Pacific/Apia', '2011-12-30T10:00:00Z'],
  ];

  it('reads the same offsets and wall fields as Intl on both sides of each change', () => {
    for (const [zone, at] of CHANGES) {
      const mid = Date.parse(at);
      for (let t = mid - 26 * H; t <= mid + 26 * H; t += 7 * 60_000 + 13_250) {
        expect([zone, t, zoneOffsetMs(t, zone)]).toEqual([zone, t, refOffset(t, zone)]);
        expect([zone, t, zonedParts(new Date(t), zone)]).toEqual([zone, t, refParts(t, zone)]);
      }
    }
  });

  it('resolves every wall time of the days around each change as before', () => {
    for (const [zone, at] of CHANGES) {
      const first = zonedParts(new Date(Date.parse(at) - 26 * H), zone);
      for (let i = 0; i < 4 * 24 * 4; i++) {
        const w = { year: first.year, month: first.month, day: first.day + Math.floor(i / 96), hour: Math.floor((i % 96) / 4), minute: (i % 4) * 15 };
        const norm = new Date(Date.UTC(w.year, w.month - 1, w.day));
        const wall = { ...w, month: norm.getUTCMonth() + 1, day: norm.getUTCDate(), year: norm.getUTCFullYear() };
        expect([zone, wall, zonedToInstant(wall, zone).getTime()]).toEqual([zone, wall, refInstant(wall, zone)]);
      }
    }
  });

  it('reads Intl once or twice per zone and hour, not for every value (#18)', () => {
    const calls = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      // An hour of consecutive seconds in Tokyo, which no other test here reads.
      for (let s = 0; s < 3600; s++) zonedToInstant({ year: 2026, month: 10, day: 20, hour: 9, minute: Math.floor(s / 60), second: s % 60 }, 'Asia/Tokyo');
      expect(calls.mock.calls.length).toBeLessThanOrEqual(12);
    } finally {
      calls.mockRestore();
    }
  });

  it('stays correct past its bound, and leaves an invalid date to Intl', () => {
    const zone = 'Etc/GMT+3';
    for (let h = 0; h <= OFFSET_CACHE_LIMIT; h++) expect(zoneOffsetMs(h * H, zone)).toBe(-3 * H);
    expect(zoneOffsetMs(0, zone)).toBe(-3 * H);
    expect(() => zoneOffsetMs(Number.NaN, NY)).toThrow(RangeError);
    expect(() => zonedParts(new Date(Number.NaN), NY)).toThrow(RangeError);
  });
});

describe('formatInstant / putInstant', () => {
  it('renders ISO with an explicit offset plus a display label with weekday and zone', () => {
    expect(formatInstant(new Date('2026-07-28T03:31:09Z'), NY)).toEqual({
      iso: '2026-07-27T23:31:09-04:00',
      display: 'Mon, Jul 27, 2026, 11:31 PM EDT',
    });
    expect(formatInstant(new Date('2026-01-28T03:31:09Z'), NY).iso).toBe('2026-01-27T22:31:09-05:00');
    expect(formatInstant(new Date('2026-07-28T03:31:09Z'), 'UTC')).toEqual({
      iso: '2026-07-28T03:31:09+00:00',
      display: 'Tue, Jul 28, 2026, 3:31 AM UTC',
    });
    expect(formatInstant(new Date('2026-07-28T03:31:09Z'), IST).iso).toBe('2026-07-28T09:01:09+05:30');
  });

  it('pads years below 1000 to four digits', () => {
    expect(formatInstant(zonedToInstant({ year: 50, month: 3, day: 1 }, 'UTC'), 'UTC').iso).toBe('0050-03-01T00:00:00+00:00');
  });

  it('putInstant sets <field> and <field>Display, and skips an absent date', () => {
    const target: Record<string, unknown> = {};
    putInstant(target, 'start', new Date('2026-07-28T03:31:09Z'), NY);
    expect(target).toEqual({ start: '2026-07-27T23:31:09-04:00', startDisplay: 'Mon, Jul 27, 2026, 11:31 PM EDT' });
    putInstant(target, 'end', undefined, NY);
    expect('end' in target).toBe(false);
  });
});

describe('date-only helpers', () => {
  it('formatDateOnly labels a calendar date with its weekday, with no zone involved', () => {
    expect(formatDateOnly('2026-07-27')).toBe('Mon, Jul 27, 2026');
    expect(formatDateOnly('2028-02-29')).toBe('Tue, Feb 29, 2028');
    expect(formatDateOnly('0050-03-01')).toBe('Tue, Mar 1, 50');
    expect(formatDateOnly('1950-03-01')).toBe('Wed, Mar 1, 1950');
  });

  it('refuses anything that is not a real YYYY-MM-DD date instead of rolling it over into a wrong label', () => {
    for (const bad of ['2026-02-30', '--03-15', '2026-7-01', '2026-07-01T00:00:00Z', '0000-01-01', '2026-13-01', '2026-01-00', '']) {
      for (const [name, call] of [
        ['formatDateOnly', () => formatDateOnly(bad)],
        ['addDaysYmd', () => addDaysYmd(bad, 1)],
        ['startOfDay', () => startOfDay(bad, NY)],
      ] as const) {
        let err: unknown;
        try {
          call();
        } catch (e) {
          err = e;
        }
        expect(err, `${name}(${bad})`).toBeInstanceOf(InvalidArgumentError);
        expect((err as Error).message).toBe(`${name}: "${bad}" is not a calendar date (YYYY-MM-DD).`);
      }
    }
  });

  it('ymdInZone gives the calendar date of an instant in the zone', () => {
    expect(ymdInZone(new Date('2026-10-04T02:00:00Z'), NY)).toBe('2026-10-03');
    expect(ymdInZone(new Date('2026-10-04T02:00:00Z'), 'UTC')).toBe('2026-10-04');
    expect(ymdInZone(zonedToInstant({ year: 50, month: 3, day: 1 }, 'UTC'), 'UTC')).toBe('0050-03-01');
  });

  it('addDaysYmd does zone-free calendar arithmetic across months, years and leap days', () => {
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysYmd('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDaysYmd('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysYmd('2026-03-08', 0)).toBe('2026-03-08');
    expect(addDaysYmd('0050-02-28', 1)).toBe('0050-03-01');
  });

  it('startOfDay is local midnight, or the first instant that exists when midnight is skipped', () => {
    expect(iso(startOfDay('2026-03-08', NY))).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(startOfDay('2026-11-01', NY))).toBe('2026-11-01T04:00:00.000Z');
    expect(iso(startOfDay('2026-10-04', ADL))).toBe('2026-10-03T14:30:00.000Z');
    // Santiago and Beirut move their clocks AT midnight: that day starts at 01:00.
    expect(formatInstant(startOfDay('2026-09-06', 'America/Santiago'), 'America/Santiago').iso).toBe('2026-09-06T01:00:00-03:00');
    expect(iso(startOfDay('2026-03-29', 'Asia/Beirut'))).toBe('2026-03-28T22:00:00.000Z');
  });
});

describe('parseDateInput', () => {
  it('reads a bare date as the start of that day in the zone', () => {
    expect(parseDateInput('2026-10-03', 'fromDate', NY)).toEqual({
      instant: new Date('2026-10-03T04:00:00Z'),
      dateOnly: true,
      ymd: '2026-10-03',
      hasOffset: false,
      skipped: false,
    });
    expect(parseDateInput('  2026-10-03 ', 'fromDate', 'UTC').ymd).toBe('2026-10-03');
  });

  it('reads an offset-less date-time as WALL-CLOCK time in the zone, never UTC', () => {
    const p = parseDateInput('2026-10-03T16:30', 'startDate', NY);
    expect(iso(p.instant)).toBe('2026-10-03T20:30:00.000Z');
    expect(p).toMatchObject({ dateOnly: false, ymd: '2026-10-03', hasOffset: false });
    expect(iso(parseDateInput('2026-10-03 16:30:15', 'startDate', NY).instant)).toBe('2026-10-03T20:30:15.000Z');
    expect(iso(parseDateInput('2026-10-03T16:30:15.5', 'startDate', NY).instant)).toBe('2026-10-03T20:30:15.500Z');
    expect(iso(parseDateInput('2026-10-03T16:30:15.123456789', 'startDate', NY).instant)).toBe('2026-10-03T20:30:15.123Z');
    expect(iso(parseDateInput('2026-10-03T16:30', 'startDate', IST).instant)).toBe('2026-10-03T11:00:00.000Z');
  });

  it('applies DST resolution to wall-clock input, and says when the clocks skip the time given', () => {
    expect(parseDateInput('2026-03-08T02:30', 'startDate', NY)).toMatchObject({ instant: new Date('2026-03-08T07:30:00.000Z'), skipped: true });
    expect(parseDateInput('2026-11-01T01:30', 'startDate', NY)).toMatchObject({ instant: new Date('2026-11-01T05:30:00.000Z'), skipped: false });
    // Santiago skips midnight; Samoa skipped a whole day (2011-12-30).
    expect(parseDateInput('2026-09-06T00:15', 'startDate', 'America/Santiago').skipped).toBe(true);
    expect(parseDateInput('2011-12-30T10:00', 'startDate', 'Pacific/Apia').skipped).toBe(true);
    expect(parseDateInput('2026-03-08T02:30-05:00', 'startDate', NY).skipped).toBe(false);
  });

  it('honours Z and every offset spelling, and reports the date of the instant in the zone', () => {
    expect(iso(parseDateInput('2026-10-03T16:30Z', 'd', NY).instant)).toBe('2026-10-03T16:30:00.000Z');
    expect(iso(parseDateInput('2026-10-03T16:30:00z', 'd', NY).instant)).toBe('2026-10-03T16:30:00.000Z');
    expect(iso(parseDateInput('2026-10-03T16:30+05', 'd', NY).instant)).toBe('2026-10-03T11:30:00.000Z');
    expect(iso(parseDateInput('2026-10-03T16:30+0530', 'd', NY).instant)).toBe('2026-10-03T11:00:00.000Z');
    expect(iso(parseDateInput('2026-10-03T16:30-04:00', 'd', 'UTC').instant)).toBe('2026-10-03T20:30:00.000Z');
    const late = parseDateInput('2026-10-04T02:00:00Z', 'd', NY);
    expect(late).toMatchObject({ ymd: '2026-10-03', hasOffset: true, dateOnly: false });
  });

  it('accepts leap days in leap years and handles years below 100 without 1900s arithmetic', () => {
    expect(parseDateInput('2028-02-29', 'd', 'UTC').ymd).toBe('2028-02-29');
    expect(parseDateInput('2000-02-29', 'd', 'UTC').ymd).toBe('2000-02-29');
    const early = parseDateInput('0050-03-01T10:00', 'd', 'UTC');
    expect(early.instant.getUTCFullYear()).toBe(50);
    expect(early.ymd).toBe('0050-03-01');
    expect(parseDateInput('0004-02-29', 'd', 'UTC').ymd).toBe('0004-02-29');
    expect(parseDateInput('0050-03-01T10:00+01:00', 'd', 'UTC').instant.getUTCFullYear()).toBe(50);
  });

  function parseError(value: string): InvalidArgumentError {
    try {
      parseDateInput(value, 'startDate', NY);
    } catch (e) {
      return e as InvalidArgumentError;
    }
    throw new Error(`expected "${value}" to be refused`);
  }

  it.each([
    ['tomorrow', 'expected YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM]'],
    ['2026-10-03Z', 'expected YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM]'],
    ['2026-10-03+02:00', 'expected YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM]'],
    ['2026-1-03', 'expected YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM]'],
    ['2026-10-03T16', 'expected YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM]'],
    ['2026-10-03T16:30 EDT', 'expected YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM]'],
    ['2026-10-03T16:30:00.1234567890', 'expected YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM]'],
    ['0000-01-01', 'year 0000 is out of range'],
    ['2026-00-10', 'month 00 is out of range'],
    ['2026-13-10', 'month 13 is out of range'],
    ['2026-10-00', 'day 00 does not exist in 2026-10'],
    ['2026-02-29', 'day 29 does not exist in 2026-02'],
    ['1900-02-29', 'day 29 does not exist in 1900-02'],
    ['2026-04-31', 'day 31 does not exist in 2026-04'],
    ['2026-10-03T24:00', 'hour 24 is out of range'],
    ['2026-10-03T16:60', 'minute 60 is out of range'],
    ['2026-10-03T16:30:60', 'second 60 is out of range'],
    ['2026-10-03T16:30+19:00', 'offset +19:00 is out of range'],
    ['2026-10-03T16:30-05:60', 'offset -05:60 is out of range'],
  ])('refuses %s (%s), naming the field, the value and the zone', (value, why) => {
    const err = parseError(value);
    expect(err).toBeInstanceOf(InvalidArgumentError);
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(err.message).toBe(`startDate "${value}" is not a valid date: ${why}.`);
    expect(err.hint).toContain(`local time in ${NY}`);
  });
});
