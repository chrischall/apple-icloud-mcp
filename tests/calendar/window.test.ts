import { beforeEach, describe, expect, it } from 'vitest';
import { InvalidArgumentError } from '../../src/errors.js';
import { addDaysWall, resolveWindow, resolveZone, windowJson } from '../../src/calendar/window.js';

const NY = 'America/New_York';
const NOW = new Date('2026-10-20T16:00:00Z');
const opts = { zone: NY, now: NOW, defaultDays: 7, maxDays: 31 };

beforeEach(() => {
  process.env.DISPLAY_TZ = 'Europe/London';
});

describe('resolveZone', () => {
  it('reads DISPLAY_TZ at call time and validates an explicit zone', () => {
    expect(resolveZone(undefined)).toBe('Europe/London');
    process.env.DISPLAY_TZ = 'Asia/Tokyo';
    expect(resolveZone(undefined)).toBe('Asia/Tokyo');
    expect(resolveZone(NY)).toBe(NY);
    // The canonical spelling, not the one typed: it travels on as an iCalendar TZID, where case matters.
    expect(resolveZone('america/new_york')).toBe(NY);
    expect(resolveZone('US/Eastern')).toBe(NY);
    expect(() => resolveZone('-04:00')).toThrow(InvalidArgumentError);
    expect(() => resolveZone('Nowhere/Land')).toThrow(/not a known IANA time zone/);
  });
});

describe('addDaysWall', () => {
  it('keeps the wall clock across a DST change', () => {
    const nineAm = new Date('2026-10-31T13:00:00.250Z');
    expect(addDaysWall(nineAm, 2, NY).toISOString()).toBe('2026-11-02T14:00:00.250Z');
  });
});

describe('resolveWindow', () => {
  it('defaults to the start of today plus defaultDays', () => {
    const w = resolveWindow({}, opts);
    expect([w.from.toISOString(), w.to.toISOString()]).toEqual(['2026-10-20T04:00:00.000Z', '2026-10-27T04:00:00.000Z']);
    expect(windowJson(w)).toEqual({
      from: '2026-10-20T00:00:00-04:00',
      fromDisplay: 'Tue, Oct 20, 2026, 12:00 AM EDT',
      to: '2026-10-27T00:00:00-04:00',
      toDisplay: 'Tue, Oct 27, 2026, 12:00 AM EDT',
      timeZone: NY,
    });
  });

  it('takes fromDate + daysAhead or toDate (exclusive), offset-less input as wall clock in the zone', () => {
    const a = resolveWindow({ fromDate: '2026-11-01T08:00', daysAhead: 1 }, opts);
    expect([a.from.toISOString(), a.to.toISOString()]).toEqual(['2026-11-01T13:00:00.000Z', '2026-11-02T13:00:00.000Z']);
    const b = resolveWindow({ fromDate: '2026-10-01', toDate: '2026-11-01' }, opts);
    expect([b.from.toISOString(), b.to.toISOString()]).toEqual(['2026-10-01T04:00:00.000Z', '2026-11-01T04:00:00.000Z']);
  });

  it('refuses both ends, an end not after the start, and an over-long window (never clipped)', () => {
    expect(() => resolveWindow({ toDate: '2026-10-21', daysAhead: 1 }, opts)).toThrow(/either toDate or daysAhead, not both/);
    expect(() => resolveWindow({ fromDate: '2026-10-21', toDate: '2026-10-21' }, opts)).toThrow(/must be after fromDate/);
    expect(() => resolveWindow({ fromDate: '2026-10-01', toDate: '2026-11-01T00:00:01' }, opts)).toThrow(/longer than the 31-day maximum/);
    // Exactly 31 calendar days across the November DST change is fine.
    expect(resolveWindow({ fromDate: '2026-10-15', toDate: '2026-11-15' }, opts).to.toISOString()).toBe('2026-11-15T05:00:00.000Z');
    expect(() => resolveWindow({ fromDate: 'Oct 1' }, opts)).toThrow(/fromDate "Oct 1" is not a valid date/);
  });
});
