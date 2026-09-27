import { describe, expect, it } from 'vitest';
import { AppleToolError } from '../../src/errors.js';
import {
  UnexpandableRuleError,
  expandSeries,
  findOccurrence,
  hasPeriodDates,
  isRecurringResource,
  overlaps,
  rulePosition,
  ruleProblem,
  seriesWalker,
  singleOccurrence,
  type Occurrence,
} from '../../src/calendar/expand.js';
import { ICAL } from '../../src/calendar/ics.js';
import { eventParts, parseCalendar, textProp, type Component, type EventParts } from '../../src/calendar/ics.js';
import { NY_TZ, ics, vevent } from './fake-caldav.js';

const NY = 'America/New_York';

function parts(...lines: string[]): EventParts {
  return eventParts(parseCalendar(ics(...lines), 'test'));
}

const d = (s: string) => new Date(s);

const STANDUP = [
  ...NY_TZ,
  ...vevent(
    'UID:s',
    'DTSTART;TZID=America/New_York:20261019T090000',
    'DTEND;TZID=America/New_York:20261019T091500',
    'RRULE:FREQ=DAILY;COUNT=10',
    'EXDATE;TZID=America/New_York:20261021T090000',
    'SUMMARY:Standup',
  ),
  ...vevent('UID:s', 'RECURRENCE-ID;TZID=America/New_York:20261022T090000', 'DTSTART;TZID=America/New_York:20261022T140000', 'DTEND;TZID=America/New_York:20261022T141500', 'SUMMARY:Moved'),
  // Its natural slot (Oct 27) is past the window below, but it was moved INTO it.
  ...vevent('UID:s', 'RECURRENCE-ID:20261027T130000Z', 'DTSTART:20261020T200000Z', 'DTEND:20261020T210000Z', 'SUMMARY:Pulled in'),
];

describe('expandSeries', () => {
  it('expands a zoned series across a DST change, honouring EXDATE and overrides matched by instant', () => {
    const p = parts(...STANDUP);
    const r = expandSeries(p, { from: d('2026-10-19T04:00:00Z'), to: d('2026-10-24T04:00:00Z'), zone: NY });
    expect(r.truncated).toBeUndefined();
    expect(r.occurrences.map((o) => [o.occ, o.start.toISOString(), textProp(o.comp, 'summary'), o.isOverride])).toEqual([
      ['2026-10-19T13:00:00Z', '2026-10-19T13:00:00.000Z', 'Standup', false],
      ['2026-10-20T13:00:00Z', '2026-10-20T13:00:00.000Z', 'Standup', false],
      ['2026-10-22T13:00:00Z', '2026-10-22T18:00:00.000Z', 'Moved', true],
      ['2026-10-23T13:00:00Z', '2026-10-23T13:00:00.000Z', 'Standup', false],
      ['2026-10-27T13:00:00Z', '2026-10-20T20:00:00.000Z', 'Pulled in', true],
    ]);
    // After the DST change (Nov 1) the wall clock holds at 9 AM: 14:00Z.
    const later = expandSeries(parts(...NY_TZ, ...vevent('UID:w', 'DTSTART;TZID=America/New_York:20261030T090000', 'RRULE:FREQ=DAILY;COUNT=5')), {
      from: d('2026-10-01T00:00:00Z'),
      to: d('2026-12-01T00:00:00Z'),
      zone: NY,
    });
    expect(later.occurrences.map((o) => o.start.toISOString())).toEqual([
      '2026-10-30T13:00:00.000Z',
      '2026-10-31T13:00:00.000Z',
      '2026-11-01T14:00:00.000Z',
      '2026-11-02T14:00:00.000Z',
      '2026-11-03T14:00:00.000Z',
    ]);
  });

  it('skips overrides that do not overlap and natural occurrences outside the window', () => {
    const p = parts(...STANDUP);
    const r = expandSeries(p, { from: d('2026-10-23T00:00:00Z'), to: d('2026-10-26T04:00:00Z'), zone: NY });
    expect(r.occurrences.map((o) => o.occ)).toEqual(['2026-10-23T13:00:00Z', '2026-10-24T13:00:00Z', '2026-10-25T13:00:00Z']);
  });

  it('expands all-day series in the display zone with their length', () => {
    const p = parts(...vevent('UID:b', 'DTSTART;VALUE=DATE:20241023', 'DTEND;VALUE=DATE:20241025', 'RRULE:FREQ=YEARLY'));
    const r = expandSeries(p, { from: d('2026-10-24T03:00:00Z'), to: d('2026-10-24T05:00:00Z'), zone: NY });
    expect(r.occurrences).toHaveLength(1);
    const o = r.occurrences[0]!;
    expect([o.occ, o.startYmd, o.endYmd, o.start.toISOString(), o.end.toISOString()]).toEqual([
      '2026-10-23',
      '2026-10-23',
      '2026-10-24',
      '2026-10-23T04:00:00.000Z',
      '2026-10-25T04:00:00.000Z',
    ]);
  });

  it('reports the caps instead of silently stopping', () => {
    const hourly = parts(...vevent('UID:h', 'DTSTART:20261020T000000Z', 'RRULE:FREQ=HOURLY'));
    const capped = expandSeries(hourly, { from: d('2026-10-20T00:00:00Z'), to: d('2026-10-21T00:00:00Z'), zone: NY, maxOccurrences: 5 });
    expect(capped.truncated).toBe('occurrences');
    expect(capped.occurrences).toHaveLength(5);
    const old = parts(...vevent('UID:o', 'DTSTART:20000101T000000Z', 'RRULE:FREQ=DAILY'));
    const stepped = expandSeries(old, { from: d('2026-10-20T00:00:00Z'), to: d('2026-10-21T00:00:00Z'), zone: NY, maxSteps: 100 });
    expect(stepped).toEqual({ occurrences: [], truncated: 'steps' });
  });

  it('handles single events, override-only resources and odd spans', () => {
    const single = parts(...vevent('UID:x', 'DTSTART:20261020T130000Z', 'DTEND:20261020T120000Z'));
    const r = expandSeries(single, { from: d('2026-10-20T00:00:00Z'), to: d('2026-10-21T00:00:00Z'), zone: NY });
    expect(r.occurrences[0]).toMatchObject({ recurring: false, isOverride: false });
    expect(r.occurrences[0]!.end).toEqual(r.occurrences[0]!.start); // an end before the start is clamped
    expect(expandSeries(single, { from: d('2026-10-21T00:00:00Z'), to: d('2026-10-22T00:00:00Z'), zone: NY }).occurrences).toEqual([]);

    const invite = parts(...vevent('UID:i', 'RECURRENCE-ID:20261020T130000Z', 'DTSTART:20261020T150000Z', 'DTEND:20261020T160000Z'));
    const inv = expandSeries(invite, { from: d('2026-10-20T00:00:00Z'), to: d('2026-10-21T00:00:00Z'), zone: NY });
    expect(inv.occurrences[0]).toMatchObject({ occ: '2026-10-20T13:00:00Z', isOverride: true, recurring: true });
    expect(inv.occurrences[0]!.master).toBeUndefined();

    const mixed = parts(...vevent('UID:m', 'DTSTART;VALUE=DATE:20261020', 'DTEND:20261020T120000Z'));
    expect(singleOccurrence(mixed.master as Component, NY)).toMatchObject({ allDay: true, startYmd: '2026-10-20', endYmd: '2026-10-20' });
    const backwards = parts(...vevent('UID:m', 'DTSTART;VALUE=DATE:20261020', 'DTEND;VALUE=DATE:20261020'));
    expect(singleOccurrence(backwards.master as Component, NY)).toMatchObject({ startYmd: '2026-10-20', endYmd: '2026-10-20' });
  });

  it('knows which resources are recurring', () => {
    expect(isRecurringResource(parts(...STANDUP))).toBe(true);
    expect(isRecurringResource(parts(...vevent('UID:x', 'DTSTART:20261020T130000Z')))).toBe(false);
    expect(isRecurringResource(parts(...vevent('UID:i', 'RECURRENCE-ID:20261020T130000Z', 'DTSTART:20261020T150000Z')))).toBe(true);
    expect(isRecurringResource({ overrides: [] })).toBe(false);
  });
});

describe('RDATE values', () => {
  const window = { from: d('2026-09-01T00:00:00Z'), to: d('2027-01-01T00:00:00Z'), zone: NY };
  const keys = (p: EventParts) => expandSeries(p, window).occurrences.map((o) => o.occ);

  it('lists DTSTART first in a series of RDATEs only (RFC 5545), once, unless an EXDATE removes it', () => {
    const timed = ['DTSTART;TZID=America/New_York:20261005T090000', 'DTEND;TZID=America/New_York:20261005T100000'];
    expect(keys(parts(...NY_TZ, ...vevent('UID:r', ...timed, 'RDATE;TZID=America/New_York:20261007T090000,20261009T090000')))).toEqual([
      '2026-10-05T13:00:00Z',
      '2026-10-07T13:00:00Z',
      '2026-10-09T13:00:00Z',
    ]);
    expect(keys(parts(...vevent('UID:a', 'DTSTART;VALUE=DATE:20261005', 'DTEND;VALUE=DATE:20261006', 'RDATE;VALUE=DATE:20261007,20261009')))).toEqual([
      '2026-10-05',
      '2026-10-07',
      '2026-10-09',
    ]);
    // Already among the RDATEs (as a split's continuation writes it): listed once.
    expect(keys(parts(...vevent('UID:b', 'DTSTART:20261005T130000Z', 'RDATE:20261005T130000Z,20261007T130000Z')))).toEqual(['2026-10-05T13:00:00Z', '2026-10-07T13:00:00Z']);
    // Removed by an EXDATE, as any other instance.
    expect(keys(parts(...vevent('UID:c', 'DTSTART:20261005T130000Z', 'RDATE:20261007T130000Z', 'EXDATE:20261005T130000Z')))).toEqual(['2026-10-07T13:00:00Z']);
    // An RDATE before DTSTART keeps its place in start order.
    expect(keys(parts(...vevent('UID:e', 'DTSTART:20261005T130000Z', 'RDATE:20261003T130000Z,20261007T130000Z')))).toEqual([
      '2026-10-03T13:00:00Z',
      '2026-10-05T13:00:00Z',
      '2026-10-07T13:00:00Z',
    ]);
    const first = findOccurrence(parts(...vevent('UID:f', 'DTSTART:20261005T130000Z', 'DTEND:20261005T140000Z', 'RDATE:20261007T130000Z')), '2026-10-05T13:00:00Z', NY);
    expect(first?.end.toISOString()).toBe('2026-10-05T14:00:00.000Z');
  });

  it('reads an RDATE PERIOD as an instance with its own length, in start order among the others', () => {
    const p = parts(
      ...NY_TZ,
      ...vevent(
        'UID:p',
        'DTSTART;TZID=America/New_York:20261005T090000',
        'DTEND;TZID=America/New_York:20261005T100000',
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'RDATE;VALUE=PERIOD:20261016T130000Z/PT30M,20261014T130000Z/20261014T150000Z',
        'RDATE;VALUE=PERIOD;TZID=America/New_York:20261021T090000/PT2H',
        'RDATE:20261022T130000Z',
      ),
    );
    expect(hasPeriodDates(p.master as Component)).toBe(true);
    expect(expandSeries(p, window).occurrences.map((o) => [o.occ, o.start.toISOString(), o.end.toISOString()])).toEqual([
      ['2026-10-05T13:00:00Z', '2026-10-05T13:00:00.000Z', '2026-10-05T14:00:00.000Z'],
      ['2026-10-12T13:00:00Z', '2026-10-12T13:00:00.000Z', '2026-10-12T14:00:00.000Z'],
      ['2026-10-14T13:00:00Z', '2026-10-14T13:00:00.000Z', '2026-10-14T15:00:00.000Z'],
      ['2026-10-16T13:00:00Z', '2026-10-16T13:00:00.000Z', '2026-10-16T13:30:00.000Z'],
      ['2026-10-19T13:00:00Z', '2026-10-19T13:00:00.000Z', '2026-10-19T14:00:00.000Z'],
      ['2026-10-21T13:00:00Z', '2026-10-21T13:00:00.000Z', '2026-10-21T15:00:00.000Z'],
      ['2026-10-22T13:00:00Z', '2026-10-22T13:00:00.000Z', '2026-10-22T14:00:00.000Z'],
    ]);
    const found = findOccurrence(p, '2026-10-14T13:00:00Z', NY) as Occurrence;
    expect([found.start.toISOString(), found.end.toISOString()]).toEqual(['2026-10-14T13:00:00.000Z', '2026-10-14T15:00:00.000Z']);
    expect(hasPeriodDates(parts(...vevent('UID:n', 'DTSTART:20261005T130000Z', 'RDATE:20261007T130000Z')).master as Component)).toBe(false);
  });

  it('finds a long PERIOD instance that started well before the window, and ignores PERIOD lengths on an all-day series', () => {
    const long = parts(...vevent('UID:l', 'DTSTART:20260901T130000Z', 'DTEND:20260901T140000Z', 'RDATE;VALUE=PERIOD:20261001T000000Z/P20D'));
    const r = expandSeries(long, { from: d('2026-10-15T00:00:00Z'), to: d('2026-10-16T00:00:00Z'), zone: NY });
    expect(r.occurrences.map((o) => [o.occ, o.end.toISOString()])).toEqual([['2026-10-01T00:00:00Z', '2026-10-21T00:00:00.000Z']]);
    const allDay = parts(...vevent('UID:d', 'DTSTART;VALUE=DATE:20261005', 'DTEND;VALUE=DATE:20261006', 'RDATE;VALUE=PERIOD:20261008T130000Z/PT5H'));
    expect(expandSeries(allDay, window).occurrences.map((o) => [o.occ, o.startYmd, o.endYmd])).toEqual([
      ['2026-10-05', '2026-10-05', '2026-10-05'],
      // A date-time value on an all-day series keys by its instant, as a plain DATE-TIME RDATE there does; it lasts the series' one day.
      ['2026-10-08T13:00:00Z', '2026-10-08', '2026-10-08'],
    ]);
  });
});

describe('overlaps', () => {
  it('treats zero-length events as points', () => {
    const at = (s: string) => ({ start: d(s), end: d(s) });
    expect(overlaps(at('2026-10-20T00:00:00Z'), d('2026-10-20T00:00:00Z'), d('2026-10-21T00:00:00Z'))).toBe(true);
    expect(overlaps(at('2026-10-21T00:00:00Z'), d('2026-10-20T00:00:00Z'), d('2026-10-21T00:00:00Z'))).toBe(false);
    expect(overlaps(at('2026-10-19T23:59:59Z'), d('2026-10-20T00:00:00Z'), d('2026-10-21T00:00:00Z'))).toBe(false);
    expect(overlaps({ start: d('2026-10-19T23:00:00Z'), end: d('2026-10-20T00:00:00Z') }, d('2026-10-20T00:00:00Z'), d('2026-10-21T00:00:00Z'))).toBe(false);
  });
});

describe('findOccurrence', () => {
  it('finds overrides and natural occurrences, never another one', () => {
    const p = parts(...STANDUP);
    expect(findOccurrence(p, '2026-10-22T13:00:00Z', NY)).toMatchObject({ isOverride: true, occ: '2026-10-22T13:00:00Z' });
    expect(findOccurrence(p, '2026-10-20T13:00:00Z', NY)).toMatchObject({ isOverride: false, occ: '2026-10-20T13:00:00Z' });
    expect(findOccurrence(p, '2026-10-21T13:00:00Z', NY)).toBeUndefined(); // EXDATE'd
    expect(findOccurrence(p, '2026-10-20T13:30:00Z', NY)).toBeUndefined(); // no such slot
    expect(findOccurrence(p, '2026-12-01T13:00:00Z', NY)).toBeUndefined(); // after COUNT ran out
    expect(findOccurrence(p, '2026-10-20', NY)).toBeUndefined(); // wrong type
  });

  it('finds all-day occurrences by date', () => {
    const p = parts(...vevent('UID:b', 'DTSTART;VALUE=DATE:20241023', 'RRULE:FREQ=YEARLY'));
    expect(findOccurrence(p, '2026-10-23', NY)).toMatchObject({ allDay: true, startYmd: '2026-10-23' });
  });

  it('answers undefined for a non-recurring or master-less resource, and refuses to walk forever', () => {
    expect(findOccurrence(parts(...vevent('UID:x', 'DTSTART:20261020T130000Z')), '2026-10-20T13:00:00Z', NY)).toBeUndefined();
    expect(findOccurrence(parts(...vevent('UID:i', 'RECURRENCE-ID:20261020T130000Z', 'DTSTART:20261020T150000Z')), '2026-10-21T13:00:00Z', NY)).toBeUndefined();
    const old = parts(...vevent('UID:o', 'DTSTART:20000101T000000Z', 'RRULE:FREQ=DAILY'));
    expect(() => findOccurrence(old, '2026-10-20T00:00:00Z', NY, 10)).toThrow(AppleToolError);
    expect(() => findOccurrence(old, '2026-10-20T00:00:00Z', NY, 10)).toThrow(/more than 10 occurrences/);
  });
});

describe('rulePosition', () => {
  it('counts rule instances (EXDATE included, as COUNT does) and finds the next one', () => {
    const p = parts(...STANDUP);
    const master = p.master as Component;
    expect(rulePosition(master, d('2026-10-23T13:00:00Z'), NY)).toEqual({ before: 4, next: d('2026-10-23T13:00:00Z') });
    expect(rulePosition(master, d('2026-10-23T12:00:00Z'), NY)).toEqual({ before: 4, next: d('2026-10-23T13:00:00Z') });
    expect(rulePosition(master, d('2027-01-01T00:00:00Z'), NY)).toEqual({ before: 10 });
    expect(rulePosition(parts(...vevent('UID:x', 'DTSTART:20261020T130000Z', 'RDATE:20261021T130000Z')).master as Component, d('2030-01-01T00:00:00Z'), NY)).toEqual({ before: 0 });
    // An RDATE is not a rule instance: past a COUNT, the rule has none left.
    const extra = parts(...vevent('UID:r', 'DTSTART:20261005T130000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'RDATE:20261104T140000Z')).master as Component;
    expect(rulePosition(extra, d('2026-11-04T14:00:00Z'), NY)).toEqual({ before: 3 });
    const old = parts(...vevent('UID:o', 'DTSTART:20000101T000000Z', 'RRULE:FREQ=DAILY')).master as Component;
    expect(() => rulePosition(old, d('2026-10-20T00:00:00Z'), NY, 10)).toThrow(/the split point could not be located/);
  });
});

describe('rules that cannot be walked', () => {
  const rule = (text: string) => ICAL.Recur.fromString(text);

  it('names what ical.js would hang or throw on, and passes ordinary rules', () => {
    expect(ruleProblem(rule('FREQ=HOURLY;BYMONTH=2;BYMONTHDAY=30'))).toBe('FREQ=HOURLY limited to certain days');
    expect(ruleProblem(rule('FREQ=MINUTELY;BYDAY=MO'))).toBe('FREQ=MINUTELY limited to certain days');
    expect(ruleProblem(rule('FREQ=MONTHLY;BYWEEKNO=3'))).toBe('BYWEEKNO with FREQ=MONTHLY');
    expect(ruleProblem(rule('FREQ=DAILY;BYYEARDAY=100'))).toBe('BYYEARDAY with FREQ=DAILY');
    expect(ruleProblem(rule('FREQ=WEEKLY;BYMONTHDAY=1'))).toBe('BYMONTHDAY with FREQ=WEEKLY');
    expect(ruleProblem(rule('FREQ=DAILY;BYDAY=1MO'))).toBe('a numbered BYDAY with FREQ=DAILY');
    expect(ruleProblem(rule('FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30'))).toBe('BYMONTH and BYMONTHDAY name a day that never occurs');
    expect(ruleProblem(rule('FREQ=DAILY;BYMONTH=4,6;BYMONTHDAY=-31'))).toBe('BYMONTH and BYMONTHDAY name a day that never occurs');
    for (const ok of [
      'FREQ=HOURLY;BYHOUR=9,17',
      'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29',
      'FREQ=DAILY;BYMONTHDAY=31',
      'FREQ=WEEKLY;BYDAY=MO,WE;BYMONTH=6',
      'FREQ=MONTHLY;BYDAY=2TU',
      'FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO',
      'FREQ=YEARLY;BYYEARDAY=100',
    ]) {
      expect(ruleProblem(rule(ok)), ok).toBeUndefined();
    }
  });

  it('lists the first instance and the overrides of a rule it refuses to walk, and says why', () => {
    // FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30 spins forever inside ical.js: it must never reach it.
    const p = parts(
      ...vevent('UID:z', 'DTSTART:20261020T130000Z', 'DTEND:20261020T140000Z', 'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30', 'SUMMARY:Z'),
      ...vevent('UID:z', 'RECURRENCE-ID:20261022T130000Z', 'DTSTART:20261022T150000Z', 'SUMMARY:Z moved'),
    );
    const r = expandSeries(p, { from: d('2026-10-19T00:00:00Z'), to: d('2026-10-26T00:00:00Z'), zone: NY });
    expect(r).toMatchObject({ truncated: 'rule', ruleProblem: 'BYMONTH and BYMONTHDAY name a day that never occurs' });
    expect(r.occurrences.map((o) => [o.occ, o.isOverride])).toEqual([
      ['2026-10-20T13:00:00Z', false],
      ['2026-10-22T13:00:00Z', true],
    ]);
    expect(() => seriesWalker(p.master as Component)).toThrow(UnexpandableRuleError);
    expect(() => findOccurrence(p, '2026-10-21T13:00:00Z', NY)).toThrow(/repeat rule cannot be expanded \(BYMONTH and BYMONTHDAY/);
    // An override is found without walking the rule at all.
    expect(findOccurrence(p, '2026-10-22T13:00:00Z', NY)).toMatchObject({ isOverride: true });
    expect(() => rulePosition(p.master as Component, d('2026-10-22T13:00:00Z'), NY)).toThrow(UnexpandableRuleError);
  });

  it('turns an ical.js failure (at the start or mid-walk) into a reported stop, keeping what it found', () => {
    // ical.js refuses to construct this iterator ("Malformed values in BYDAY combined with BYMONTHDAY parts").
    const malformed = parts(...vevent('UID:m', 'DTSTART:20261020T130000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=31;BYDAY=MO;BYMONTH=2'));
    const r1 = expandSeries(malformed, { from: d('2026-10-19T00:00:00Z'), to: d('2026-10-26T00:00:00Z'), zone: NY });
    expect(r1).toMatchObject({ truncated: 'rule', ruleProblem: expect.stringMatching(/Malformed values/) });
    expect(r1.occurrences).toHaveLength(1);
    expect(() => rulePosition(malformed.master as Component, d('2026-10-22T13:00:00Z'), NY)).toThrow(/Malformed values/);
    // ical.js gives up after 500 excluded instances in a row.
    const exdates = Array.from({ length: 600 }, (_, i) => `EXDATE:${new Date(Date.UTC(2026, 9, 21 + i, 13)).toISOString().replace(/[-:]|\.000/g, '')}`);
    const holey = parts(...vevent('UID:e', 'DTSTART:20261020T130000Z', 'DTEND:20261020T140000Z', 'RRULE:FREQ=DAILY', ...exdates));
    const r2 = expandSeries(holey, { from: d('2026-10-19T00:00:00Z'), to: d('2026-10-26T00:00:00Z'), zone: NY });
    expect(r2).toMatchObject({ truncated: 'rule', ruleProblem: expect.stringMatching(/max tries/) });
    expect(r2.occurrences.map((o) => o.occ)).toEqual(['2026-10-20T13:00:00Z']);
  });

  it('skips instances far before the window cheaply, still finding an override moved into it from there', () => {
    const p = parts(
      ...vevent('UID:y', 'DTSTART;VALUE=DATE:19900101', 'DTEND;VALUE=DATE:19900102', 'RRULE:FREQ=DAILY', 'SUMMARY:Daily'),
      // The 1995-06-01 instance was moved into the window.
      ...vevent('UID:y', 'RECURRENCE-ID;VALUE=DATE:19950601', 'DTSTART;VALUE=DATE:20261021', 'DTEND;VALUE=DATE:20261022', 'SUMMARY:Moved far'),
    );
    const r = expandSeries(p, { from: d('2026-10-20T04:00:00Z'), to: d('2026-10-22T04:00:00Z'), zone: NY });
    expect(r.truncated).toBeUndefined();
    expect(r.occurrences.map((o) => [o.occ, o.startYmd, textProp(o.comp, 'summary')])).toEqual([
      ['2026-10-20', '2026-10-20', 'Daily'],
      ['2026-10-21', '2026-10-21', 'Daily'],
      ['1995-06-01', '2026-10-21', 'Moved far'],
    ]);
    expect(findOccurrence(p, '2026-10-21', NY)).toMatchObject({ startYmd: '2026-10-21', isOverride: false });
    expect(rulePosition(p.master as Component, d('2026-10-21T04:00:00Z'), NY).before).toBe(13442);
  });
});
