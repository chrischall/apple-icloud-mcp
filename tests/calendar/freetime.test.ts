import { describe, expect, it } from 'vitest';
import { computeFreeTime, mergeIntervals, parseClock } from '../../src/calendar/freetime.js';

const NY = 'America/New_York';
const t = (s: string) => new Date(s).getTime();

describe('mergeIntervals', () => {
  it('sorts, merges overlapping and touching intervals, drops empty ones', () => {
    expect(
      mergeIntervals([
        { start: 50, end: 60 },
        { start: 0, end: 10 },
        { start: 10, end: 20 },
        { start: 15, end: 18 },
        { start: 30, end: 30 },
      ]),
    ).toEqual([
      { start: 0, end: 20 },
      { start: 50, end: 60 },
    ]);
  });
});

describe('computeFreeTime', () => {
  it('subtracts busy time from working hours per day, skipping weekends and too-short gaps', () => {
    expect(parseClock('09:30')).toEqual({ hour: 9, minute: 30 });
    const r = computeFreeTime({
      from: new Date('2026-10-23T04:00:00Z'), // Fri
      to: new Date('2026-10-27T04:00:00Z'), // Tue (exclusive)
      zone: NY,
      workdayStart: { hour: 9, minute: 0 },
      workdayEnd: { hour: 17, minute: 0 },
      weekdaysOnly: true,
      minMinutes: 30,
      busy: [
        { start: t('2026-10-23T12:00:00Z'), end: t('2026-10-23T14:00:00Z') }, // 8-10 EDT (starts before work)
        { start: t('2026-10-23T16:00:00Z'), end: t('2026-10-23T16:20:00Z') }, // 12:00-12:20
        { start: t('2026-10-23T16:30:00Z'), end: t('2026-10-23T17:00:00Z') }, // 12:30-1:00 (gap of 10 min dropped)
        { start: t('2026-10-26T19:00:00Z'), end: t('2026-10-27T01:00:00Z') }, // Mon 3pm EDT onwards
      ],
    });
    expect(r.weekendDays).toBe(2);
    expect(r.outsideWindow).toBe(0);
    expect(r.days.map((d) => [d.date, d.dateDisplay, d.free.map((s) => [s.start, s.end, s.minutes])])).toEqual([
      [
        '2026-10-23',
        'Fri, Oct 23, 2026',
        [
          ['2026-10-23T10:00:00-04:00', '2026-10-23T12:00:00-04:00', 120],
          ['2026-10-23T13:00:00-04:00', '2026-10-23T17:00:00-04:00', 240],
        ],
      ],
      ['2026-10-26', 'Mon, Oct 26, 2026', [['2026-10-26T09:00:00-04:00', '2026-10-26T15:00:00-04:00', 360]]],
    ]);
    expect(r.days[0]!.free[0]).toMatchObject({ startDisplay: 'Fri, Oct 23, 2026, 10:00 AM EDT' });
  });

  it('never offers time before notBefore or outside the window, and counts days it had to leave out', () => {
    const r = computeFreeTime({
      from: new Date('2026-10-24T04:00:00Z'), // Sat
      to: new Date('2026-10-25T20:00:00Z'), // Sun 4pm
      zone: NY,
      notBefore: new Date('2026-10-24T22:00:00Z'), // Sat 6pm
      workdayStart: { hour: 9, minute: 0 },
      workdayEnd: { hour: 17, minute: 0 },
      weekdaysOnly: false,
      minMinutes: 30,
      busy: [],
    });
    expect(r.outsideWindow).toBe(1);
    expect(r.weekendDays).toBe(0);
    expect(r.days.map((d) => [d.date, d.free.map((s) => [s.start, s.end])])).toEqual([
      ['2026-10-25', [['2026-10-25T09:00:00-04:00', '2026-10-25T16:00:00-04:00']]],
    ]);
  });
});
