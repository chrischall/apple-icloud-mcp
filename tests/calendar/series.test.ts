import { describe, expect, it } from 'vitest';
import { AppleToolError, InvalidArgumentError } from '../../src/errors.js';
import { expandSeries, findOccurrence, singleOccurrence, type Occurrence } from '../../src/calendar/expand.js';
import {
  ICAL,
  eventParts,
  newCalendar,
  parseCalendar,
  readAttendees,
  serialize,
  startTimeOf,
  textProp,
  type Component,
  type EventParts,
} from '../../src/calendar/ics.js';
import {
  applyField,
  changedFields,
  checkShifted,
  continuationSeries,
  createOverride,
  editSeries,
  fieldSnapshot,
  isFirstInstance,
  occInstant,
  planTimes,
  recurrenceValue,
  rewriteDates,
  shiftRule,
  truncateSeries,
  wantsTimeChange,
  writeTimes,
  writeZoneFor,
  type FieldChanges,
  type SeriesEdit,
} from '../../src/calendar/series.js';
import { NY_TZ, ics, vevent } from './fake-caldav.js';

const NY = 'America/New_York';
const NOW = new Date('2026-10-20T16:00:00Z');

function load(...lines: string[]): { vcal: Component; parts: EventParts } {
  const vcal = parseCalendar(ics(...lines), 't');
  return { vcal, parts: eventParts(vcal) };
}

const unfold = (s: string) => s.replace(/\r\n /g, '');

describe('fields', () => {
  it('snapshots and applies every field', () => {
    const { parts } = load(...vevent('UID:a', 'DTSTART:20261020T130000Z', 'SUMMARY:T', 'ATTENDEE:mailto:x@y.com'));
    const comp = parts.master as Component;
    const ch: FieldChanges = { title: 'New', location: 'Here', notes: 'N', url: 'https://u.test/', alarms: [5], attendees: [{ email: 'z@y.com' }] };
    expect(changedFields(ch)).toEqual(['title', 'location', 'notes', 'url', 'alarms', 'attendees']);
    expect(changedFields({})).toEqual([]);
    expect(['title', 'location', 'notes', 'url', 'alarms'].map((f) => fieldSnapshot(comp, f as never))).toEqual(['T', '', '', '', '']);
    expect(fieldSnapshot(load(...vevent('UID:b', 'DTSTART:20261020T130000Z')).parts.master as Component, 'title')).toBe('');
    expect(fieldSnapshot(comp, 'attendees')).toBe('ATTENDEE:mailto:x@y.com');
    const who = { self: new Set<string>(), organizer: 'me@icloud.com' };
    for (const f of changedFields(ch)) applyField(comp, f, ch, who);
    expect([textProp(comp, 'summary'), textProp(comp, 'location'), textProp(comp, 'description'), textProp(comp, 'url')]).toEqual(['New', 'Here', 'N', 'https://u.test/']);
    expect(fieldSnapshot(comp, 'alarms')).toContain('TRIGGER:-PT5M');
    expect(readAttendees(comp).map((a) => a.email)).toEqual(['z@y.com']);
    expect(textProp(comp, 'organizer')).toBe('mailto:me@icloud.com');
    applyField(comp, 'attendees', { attendees: [] }, who);
    expect(comp.hasProperty('attendee')).toBe(false);
  });
});

describe('planTimes', () => {
  const timed = singleOccurrence(load(...vevent('UID:a', 'DTSTART:20261020T130000Z', 'DTEND:20261020T140000Z')).parts.master as Component, NY);
  const allDay = singleOccurrence(load(...vevent('UID:b', 'DTSTART;VALUE=DATE:20261020', 'DTEND;VALUE=DATE:20261022')).parts.master as Component, NY);

  it('is undefined when no time changes', () => {
    expect(wantsTimeChange({ timeZone: NY })).toBe(false);
    expect(planTimes(timed, {}, NY, false)).toBeUndefined();
  });

  it('moves a timed event keeping its length, or takes an explicit end', () => {
    expect(planTimes(timed, { startDate: '2026-10-21T10:00' }, NY, false)).toEqual({
      allDay: false,
      start: new Date('2026-10-21T14:00:00Z'),
      end: new Date('2026-10-21T15:00:00Z'),
      endGiven: false,
    });
    expect(planTimes(timed, { endDate: '2026-10-20T11:30' }, NY, false)).toMatchObject({ start: new Date('2026-10-20T13:00:00Z'), end: new Date('2026-10-20T15:30:00Z'), endGiven: true });
    expect(planTimes(timed, { isAllDay: false }, NY, false)).toMatchObject({ start: timed.start, end: timed.end });
    expect(planTimes(timed, { isAllDay: false, startDate: '2026-10-22' }, NY, false)).toMatchObject({ start: new Date('2026-10-22T04:00:00Z') });
    expect(() => planTimes(timed, { endDate: '2026-10-20T09:00' }, NY, false)).toThrow(/endDate must be after startDate/);
    expect(() => planTimes(timed, { startDate: '2026-10-22' }, NY, false)).toThrow(/has no time of day/);
  });

  it('converts between all-day and timed (not on a recurring event)', () => {
    expect(planTimes(timed, { isAllDay: true }, NY, false)).toMatchObject({ allDay: true, startYmd: '2026-10-20', endYmd: '2026-10-20' });
    expect(planTimes(allDay, { isAllDay: false, startDate: '2026-10-20T09:00' }, NY, false)).toMatchObject({
      allDay: false,
      start: new Date('2026-10-20T13:00:00Z'),
      end: new Date('2026-10-20T14:00:00Z'),
    });
    expect(() => planTimes(allDay, { isAllDay: false }, NY, false)).toThrow(/startDate is required/);
    expect(() => planTimes(allDay, { isAllDay: false, startDate: '2026-10-20T09:00' }, NY, true)).toThrow(/cannot be changed on a recurring event/);
  });

  it('moves an all-day event keeping its length; dates only', () => {
    expect(planTimes(allDay, { startDate: '2026-11-01' }, NY, false)).toMatchObject({ startYmd: '2026-11-01', endYmd: '2026-11-02', endGiven: false });
    expect(planTimes(allDay, { endDate: '2026-10-25' }, NY, true)).toMatchObject({ startYmd: '2026-10-20', endYmd: '2026-10-25', endGiven: true });
    expect(() => planTimes(allDay, { startDate: '2026-11-01T09:00' }, NY, false)).toThrow(/takes a date/);
    expect(() => planTimes(allDay, { endDate: '2026-10-19' }, NY, false)).toThrow(InvalidArgumentError);
  });
});

describe('writing times', () => {
  it('writes in the requested zone, else the event\'s own; DATE for all-day', () => {
    const { vcal, parts } = load(...vevent('UID:a', 'DTSTART:20261020T130000Z', 'DURATION:PT1H'));
    const comp = parts.master as Component;
    expect(writeZoneFor(vcal, comp, {}, NY)).toEqual({ kind: 'utc' });
    const ny = writeZoneFor(vcal, comp, { timeZone: NY }, NY);
    expect(ny.kind).toBe('tz');
    writeTimes(comp, { allDay: false, start: new Date('2026-10-21T13:00:00Z'), end: new Date('2026-10-21T15:00:00Z'), endGiven: true }, ny);
    expect(comp.hasProperty('duration')).toBe(false);
    expect(unfold(serialize(vcal))).toContain('DTSTART;TZID=America/New_York:20261021T090000');
    writeTimes(comp, { allDay: true, start: NOW, end: NOW, startYmd: '2026-10-21', endYmd: '2026-10-22', endGiven: false }, ny);
    expect(serialize(vcal)).toContain('DTEND;VALUE=DATE:20261023');
    expect(writeZoneFor(vcal, comp, {}, NY).kind).toBe('tz');
  });

  it('rewrites date lists, keeping PERIOD values and dropping what fn rejects', () => {
    const { parts } = load(...vevent('UID:a', 'DTSTART:20261020T130000Z', 'RDATE;VALUE=PERIOD:20261021T130000Z/PT1H', 'RDATE:20261022T130000Z,20261023T130000Z'));
    const comp = parts.master as Component;
    rewriteDates(comp, 'rdate', (t) => (t.day === 22 ? undefined : t));
    const text = comp.toString();
    expect(text).toContain('RDATE;VALUE=PERIOD:20261021T130000Z/PT1H');
    expect(text).toContain('RDATE:20261023T130000Z');
    expect(text).not.toContain('20261022');
  });
});

describe('overrides', () => {
  it('pins a natural occurrence into an override in the master\'s own zone and type', () => {
    const { vcal, parts } = load(...NY_TZ, ...vevent('UID:s', 'DTSTART;TZID=America/New_York:20261019T090000', 'DURATION:PT15M', 'RRULE:FREQ=DAILY', 'EXDATE:20261025T130000Z'));
    const occ = findOccurrence(parts, '2026-10-20T13:00:00Z', NY) as Occurrence;
    expect(recurrenceValue(parts.master as Component, occ, NY).toString()).toBe('2026-10-20T09:00:00');
    const ovr = createOverride(vcal, parts.master as Component, occ, NY);
    const text = unfold(ovr.toString());
    expect(text).toContain('RECURRENCE-ID;TZID=America/New_York:20261020T090000');
    expect(text).toContain('DTSTART;TZID=America/New_York:20261020T090000');
    expect(text).toContain('DTEND;TZID=America/New_York:20261020T091500');
    expect(text).not.toMatch(/RRULE|EXDATE|DURATION/);

    const day = load(...vevent('UID:b', 'DTSTART;VALUE=DATE:20241023', 'DTEND;VALUE=DATE:20241025', 'RRULE:FREQ=YEARLY'));
    const bOcc = findOccurrence(day.parts, '2026-10-23', NY) as Occurrence;
    const bOvr = createOverride(day.vcal, day.parts.master as Component, bOcc, NY);
    expect(bOvr.toString()).toContain('RECURRENCE-ID;VALUE=DATE:20261023');
    expect(bOvr.toString()).toContain('DTEND;VALUE=DATE:20261025');
  });
});

describe('editSeries', () => {
  const series = () =>
    load(
      ...NY_TZ,
      ...vevent(
        'UID:s',
        'DTSTART;TZID=America/New_York:20261019T090000',
        'DTEND;TZID=America/New_York:20261019T091500',
        'RRULE:FREQ=DAILY;UNTIL=20261030T130000Z',
        'EXDATE;TZID=America/New_York:20261021T090000',
        'RDATE;TZID=America/New_York:20261101T090000',
        'SUMMARY:Standup',
        'LOCATION:Room 1',
      ),
      // Inherits the title, has its own location, not re-timed.
      ...vevent('UID:s', 'RECURRENCE-ID;TZID=America/New_York:20261022T090000', 'DTSTART;TZID=America/New_York:20261022T090000', 'DTEND;TZID=America/New_York:20261022T093000', 'SUMMARY:Standup', 'LOCATION:Room 2'),
      // Re-timed and retitled.
      ...vevent('UID:s', 'RECURRENCE-ID;TZID=America/New_York:20261023T090000', 'DTSTART;TZID=America/New_York:20261023T140000', 'DTEND;TZID=America/New_York:20261023T141500', 'SUMMARY:Moved'),
      // Not re-timed, same length as the series.
      ...vevent('UID:s', 'RECURRENCE-ID;TZID=America/New_York:20261026T090000', 'DTSTART;TZID=America/New_York:20261026T090000', 'DTEND;TZID=America/New_York:20261026T091500', 'SUMMARY:Standup'),
    );

  const edit = (l: ReturnType<typeof series>, target: Occurrence, over: Partial<SeriesEdit>): SeriesEdit => ({
    vcal: l.vcal,
    master: l.parts.master as Component,
    overrides: l.parts.overrides,
    target,
    times: undefined,
    timeInput: {},
    fields: {},
    who: undefined,
    zone: NY,
    now: NOW,
    ...over,
  });

  it('shifts DTSTART, EXDATE, RDATE, UNTIL and every RECURRENCE-ID by the wall-clock delta', () => {
    const l = series();
    const target = findOccurrence(l.parts, '2026-10-20T13:00:00Z', NY) as Occurrence;
    const times = planTimes(target, { startDate: '2026-10-20T10:00' }, NY, true);
    const key = editSeries(edit(l, target, { times, timeInput: { startDate: '2026-10-20T10:00' }, fields: { title: 'Sync' } }));
    expect(key).toBe('2026-10-20T14:00:00Z');
    const text = unfold(serialize(l.vcal));
    expect(text).toContain('DTSTART;TZID=America/New_York:20261019T100000');
    expect(text).toContain('DTEND;TZID=America/New_York:20261019T101500');
    expect(text).toContain('EXDATE;TZID=America/New_York:20261021T100000');
    expect(text).toContain('RDATE;TZID=America/New_York:20261101T100000');
    expect(text).toContain('UNTIL=20261030T140000Z');
    expect(text).toContain('RECURRENCE-ID;TZID=America/New_York:20261022T100000');
    // Not re-timed: follows the series (keeping its own 30-minute length).
    expect(text).toContain('DTSTART;TZID=America/New_York:20261022T100000');
    expect(text).toContain('DTEND;TZID=America/New_York:20261022T103000');
    // Re-timed: keeps its time.
    expect(text).toContain('DTSTART;TZID=America/New_York:20261023T140000');
    // Across the DST change the wall clock still moves 9 → 10.
    expect(text).toContain('RECURRENCE-ID;TZID=America/New_York:20261026T100000');
    const titles = eventParts(l.vcal).overrides.map((o) => textProp(o, 'summary'));
    expect(titles).toEqual(['Sync', 'Moved', 'Sync']);
    // The whole series still lines up: exceptions still hit their occurrences.
    const occs = expandSeries(eventParts(l.vcal), { from: new Date('2026-10-19T00:00:00Z'), to: new Date('2026-11-03T00:00:00Z'), zone: NY }).occurrences;
    expect(occs.map((o) => o.occ)).not.toContain('2026-10-21T14:00:00Z');
    expect(occs.filter((o) => o.isOverride)).toHaveLength(3);
    expect(occs.find((o) => o.occ === '2026-11-01T15:00:00Z')).toBeDefined();
  });

  it('takes a new length and a new zone (mapping wall clock to wall clock), and re-times the target override exactly', () => {
    const BERLIN = 'Europe/Berlin';
    const l = series();
    const target = findOccurrence(l.parts, '2026-10-23T13:00:00Z', BERLIN) as Occurrence;
    // The target was re-timed to 2 PM New York; the series is asked to run 15:00–16:00 Berlin from its natural slot.
    const input = { startDate: '2026-10-23T15:00', endDate: '2026-10-23T16:00', timeZone: BERLIN };
    const times = planTimes(target, input, BERLIN, true);
    const key = editSeries({ ...edit(l, target, { times, timeInput: input, fields: { location: 'Hall' } }), zone: BERLIN });
    expect(key).toBe('2026-10-23T13:00:00Z');
    const text = unfold(serialize(l.vcal));
    expect(text).toContain('DTSTART;TZID=Europe/Berlin:20261019T150000');
    expect(text).toContain('DTEND;TZID=Europe/Berlin:20261019T160000');
    expect(text).toContain('DTSTART;TZID=Europe/Berlin:20261023T150000');
    // Oct 26: Berlin has left summer time, New York has not — the exception still lands on its occurrence.
    expect(text).toContain('RECURRENCE-ID;TZID=Europe/Berlin:20261026T150000');
    expect(text).toContain('EXDATE;TZID=Europe/Berlin:20261021T150000');
    // Room 2 was the override's own; the last override has no location of its own either (not inherited).
    const locations = eventParts(l.vcal).overrides.map((o) => textProp(o, 'location'));
    expect(locations).toEqual(['Room 2', 'Hall', undefined]);
    const occs = expandSeries(eventParts(l.vcal), { from: new Date('2026-10-19T00:00:00Z'), to: new Date('2026-10-31T00:00:00Z'), zone: BERLIN }).occurrences;
    expect(occs.filter((o) => o.isOverride).map((o) => o.occ)).toEqual(['2026-10-22T13:00:00Z', '2026-10-23T13:00:00Z', '2026-10-26T14:00:00Z']);
    expect(occs.map((o) => o.occ)).not.toContain('2026-10-21T13:00:00Z');
  });

  it('changes only the length when only endDate is given, even through a re-timed override', () => {
    const l = series();
    const target = findOccurrence(l.parts, '2026-10-23T13:00:00Z', NY) as Occurrence;
    const times = planTimes(target, { endDate: '2026-10-23T14:45' }, NY, true);
    expect(editSeries(edit(l, target, { times, timeInput: { endDate: '2026-10-23T14:45' } }))).toBe('2026-10-23T13:00:00Z');
    const text = unfold(serialize(l.vcal));
    expect(text).toContain('DTSTART;TZID=America/New_York:20261019T090000');
    // The new length is measured on the occurrence it was asked through: 2:00–2:45 PM → 45 minutes.
    expect(text).toContain('DTEND;TZID=America/New_York:20261019T094500');
    expect(text).toContain('DTEND;TZID=America/New_York:20261023T144500');
  });

  it('moves the whole series through its bare id (timed and all-day)', () => {
    const l = series();
    const target = { ...singleOccurrence(l.parts.master as Component, NY), master: l.parts.master, recurring: true };
    const input = { startDate: '2026-10-19T08:30' };
    expect(editSeries(edit(l, target, { times: planTimes(target, input, NY, true), timeInput: input }))).toBeUndefined();
    expect(unfold(serialize(l.vcal))).toContain('DTSTART;TZID=America/New_York:20261019T083000');

    const d = load(...vevent('UID:b', 'DTSTART;VALUE=DATE:20261019', 'RRULE:FREQ=WEEKLY'));
    const dt = { ...singleOccurrence(d.parts.master as Component, NY), master: d.parts.master, recurring: true };
    const dInput = { startDate: '2026-10-21' };
    editSeries({ ...edit(d as never, dt, { times: planTimes(dt, dInput, NY, true), timeInput: dInput }), vcal: d.vcal, master: d.parts.master as Component, overrides: [] });
    expect(serialize(d.vcal)).toContain('DTSTART;VALUE=DATE:20261021');
  });

  it('edits fields only, through the bare series id', () => {
    const l = series();
    const target = { ...singleOccurrence(l.parts.master as Component, NY), master: l.parts.master, recurring: true };
    expect(editSeries(edit(l, target, { fields: { notes: 'agenda' } }))).toBeUndefined();
    const occ = findOccurrence(l.parts, '2026-10-20T13:00:00Z', NY) as Occurrence;
    expect(editSeries(edit(l, occ, { fields: { url: 'https://x.test/' } }))).toBe('2026-10-20T13:00:00Z');
    expect(eventParts(l.vcal).overrides.every((o) => textProp(o, 'description') === 'agenda')).toBe(true);
  });

  it('shifts all-day series by days and floating/date UNTILs', () => {
    const l = load(
      ...vevent('UID:b', 'DTSTART;VALUE=DATE:20261019', 'DTEND;VALUE=DATE:20261020', 'RRULE:FREQ=WEEKLY;UNTIL=20261130', 'EXDATE;VALUE=DATE:20261026'),
      ...vevent('UID:b', 'RECURRENCE-ID;VALUE=DATE:20261102', 'DTSTART;VALUE=DATE:20261102', 'DTEND;VALUE=DATE:20261104'),
    );
    const target = findOccurrence(l.parts, '2026-11-09', NY) as Occurrence;
    const input = { startDate: '2026-11-10', endDate: '2026-11-11' };
    const times = planTimes(target, input, NY, true);
    editSeries({ vcal: l.vcal, master: l.parts.master as Component, overrides: l.parts.overrides, target, times, timeInput: input, fields: {}, who: undefined, zone: NY, now: NOW });
    const text = serialize(l.vcal);
    expect(text).toContain('DTSTART;VALUE=DATE:20261020');
    expect(text).toContain('DTEND;VALUE=DATE:20261022');
    expect(text).toContain('UNTIL=20261201');
    expect(text).toContain('EXDATE;VALUE=DATE:20261027');
    // A 2-day override (not the series' 1 day) keeps its own length.
    expect(text).toContain('RECURRENCE-ID;VALUE=DATE:20261103');
    expect(text).toContain('DTEND;VALUE=DATE:20261105');

    const f = load(...vevent('UID:f', 'DTSTART:20261019T090000', 'RRULE:FREQ=DAILY;UNTIL=20261030T090000'));
    const ft = findOccurrence(f.parts, '2026-10-20T13:00:00Z', NY) as Occurrence;
    editSeries({ vcal: f.vcal, master: f.parts.master as Component, overrides: [], target: ft, times: planTimes(ft, { startDate: '2026-10-20T08:00' }, NY, true), timeInput: { startDate: '2026-10-20T08:00' }, fields: {}, who: undefined, zone: NY, now: NOW });
    expect(serialize(f.vcal)).toContain('UNTIL=20261030T080000');

    const r = load(...vevent('UID:r', 'DTSTART:20261019T130000Z', 'RDATE:20261022T130000Z'));
    const rt = findOccurrence(r.parts, '2026-10-22T13:00:00Z', NY) as Occurrence;
    editSeries({ vcal: r.vcal, master: r.parts.master as Component, overrides: [], target: rt, times: planTimes(rt, { startDate: '2026-10-22T10:00' }, NY, true), timeInput: { startDate: '2026-10-22T10:00' }, fields: {}, who: undefined, zone: NY, now: NOW });
    expect(serialize(r.vcal)).toContain('RDATE:20261022T140000Z');
  });
});

describe('shiftRule', () => {
  const rule = (text: string) => ICAL.Recur.fromString(text);

  it('moves plain weekdays with the occurrences, wrapping around the week', () => {
    expect(shiftRule(rule('FREQ=WEEKLY;BYDAY=MO,WE'), 1, false)).toMatchObject({ note: 'The repeat days moved with it: MO,WE → TU,TH.' });
    expect(shiftRule(rule('FREQ=WEEKLY;BYDAY=MO,WE'), 1, false).rule.toString()).toBe('FREQ=WEEKLY;BYDAY=TU,TH');
    expect(shiftRule(rule('FREQ=WEEKLY;BYDAY=SU,MO'), -1, false).rule.toString()).toBe('FREQ=WEEKLY;BYDAY=SA,SU');
    expect(shiftRule(rule('FREQ=DAILY;BYDAY=FR'), 10, false).rule.toString()).toBe('FREQ=DAILY;BYDAY=MO');
    expect(shiftRule(rule('FREQ=MONTHLY;BYDAY=MO'), 1, false).rule.toString()).toBe('FREQ=MONTHLY;BYDAY=TU');
  });

  it('turns the week start with the days of an every-Nth-week rule, so no day changes week', () => {
    const moved = shiftRule(rule('FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU'), 1, false);
    expect(moved.rule.toString()).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=TU');
    expect(moved.note).toBe('The repeat days moved with it: SA,SU → SU,MO. Its weeks now start on TU instead of MO (WKST), so it keeps the same weeks.');
    expect(shiftRule(rule('FREQ=WEEKLY;INTERVAL=3;BYDAY=MO;WKST=SU'), -1, false).rule.toString()).toBe('FREQ=WEEKLY;INTERVAL=3;BYDAY=SU;WKST=SA');
    // Back to Monday, the default week start.
    expect(shiftRule(rule('FREQ=WEEKLY;INTERVAL=2;BYDAY=SA;WKST=SU'), 1, false).rule.toString()).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=SU');
    // Every week, or every other day: the week start plays no part and is left alone.
    expect(shiftRule(rule('FREQ=WEEKLY;BYDAY=SA'), 1, false).rule.toString()).toBe('FREQ=WEEKLY;BYDAY=SU');
    expect(shiftRule(rule('FREQ=DAILY;INTERVAL=2;BYDAY=SA'), 1, false).rule.toString()).toBe('FREQ=DAILY;INTERVAL=2;BYDAY=SU');
  });

  it('leaves a rule alone when nothing it pins moves', () => {
    const noDays = rule('FREQ=MONTHLY;INTERVAL=2');
    expect(shiftRule(noDays, 5, true)).toEqual({ rule: noDays });
    const pinned = rule('FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9');
    expect(shiftRule(pinned, 0, false)).toEqual({ rule: pinned });
    const byMonthDay = rule('FREQ=MONTHLY;BYMONTHDAY=15');
    expect(shiftRule(byMonthDay, 0, true)).toEqual({ rule: byMonthDay });
  });

  it('refuses a move the rule cannot follow, naming the part that pins it', () => {
    const cases: Array<[string, number, boolean, RegExp]> = [
      ['FREQ=MONTHLY;BYMONTHDAY=15', 1, false, /fixes which dates it falls on \(BYMONTHDAY\)/],
      ['FREQ=MONTHLY;BYDAY=2TU', 1, false, /fixes which dates it falls on \(a numbered BYDAY\)/],
      ['FREQ=YEARLY;BYMONTH=10;BYDAY=-1FR', 7, false, /\(BYMONTH, a numbered BYDAY\)/],
      ['FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=-1', -1, false, /\(BYSETPOS\)/],
      ['FREQ=DAILY;BYHOUR=9,17', 0, true, /fixes the time of day \(BYHOUR\)/],
      ['FREQ=MONTHLY;INTERVAL=2;BYDAY=MO', 1, false, /repeats on named days every 2 months/],
      ['FREQ=YEARLY;INTERVAL=3;BYDAY=FR', -1, false, /repeats on named days every 3 years/],
    ];
    for (const [text, days, timeShifted, message] of cases) {
      expect(() => shiftRule(rule(text), days, timeShifted), text).toThrow(message);
      expect(() => shiftRule(rule(text), days, timeShifted), text).toThrow(AppleToolError);
    }
  });
});

describe('editSeries and the repeat rule', () => {
  const at = (t: string) => t.replace(/\r\n /g, '');

  it('moves a weekly series on named days to the new days, keeping every exception on an occurrence', () => {
    const l = load(
      ...NY_TZ,
      ...vevent(
        'UID:w',
        'DTSTART;TZID=America/New_York:20261019T090000',
        'DTEND;TZID=America/New_York:20261019T100000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO,WE',
        'EXDATE;TZID=America/New_York:20261026T090000',
        'SUMMARY:Gym',
      ),
    );
    const target = findOccurrence(l.parts, '2026-10-21T13:00:00Z', NY) as Occurrence;
    const input = { startDate: '2026-10-22T09:00' };
    const notes: string[] = [];
    const key = editSeries({ vcal: l.vcal, master: l.parts.master as Component, overrides: [], target, times: planTimes(target, input, NY, true), timeInput: input, fields: {}, who: undefined, zone: NY, now: NOW, notes });
    expect(key).toBe('2026-10-22T13:00:00Z');
    expect(notes).toEqual(['The repeat days moved with it: MO,WE → TU,TH.']);
    const text = at(serialize(l.vcal));
    expect(text).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU,TH');
    expect(text).toContain('EXDATE;TZID=America/New_York:20261027T090000');
    const occs = expandSeries(eventParts(l.vcal), { from: new Date('2026-10-19T00:00:00Z'), to: new Date('2026-11-02T00:00:00Z'), zone: NY }).occurrences;
    // Tue 20, Thu 22, (Tue 27 excluded), Thu 29 — no stray Monday, and the exclusion still hits.
    expect(occs.map((o) => o.occ)).toEqual(['2026-10-20T13:00:00Z', '2026-10-22T13:00:00Z', '2026-10-29T13:00:00Z']);
    expect(findOccurrence(eventParts(l.vcal), key as string, NY)).toBeDefined();
  });

  it('counts a move past midnight as a move to the next day', () => {
    const l = load(
      ...NY_TZ,
      ...vevent('UID:n', 'DTSTART;TZID=America/New_York:20261019T230000', 'DTEND;TZID=America/New_York:20261019T233000', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'SUMMARY:Late'),
    );
    // 11 PM Monday New York → 1 AM Tuesday.
    const target = findOccurrence(l.parts, '2026-10-27T03:00:00Z', NY) as Occurrence;
    expect(target).toBeDefined();
    const input = { startDate: '2026-10-27T01:00' };
    editSeries({ vcal: l.vcal, master: l.parts.master as Component, overrides: [], target, times: planTimes(target, input, NY, true), timeInput: input, fields: {}, who: undefined, zone: NY, now: NOW });
    expect(serialize(l.vcal)).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU');
  });

  it('refuses to move a series whose rule pins its dates, before changing anything', () => {
    const l = load(...vevent('UID:m', 'DTSTART:20261015T130000Z', 'DTEND:20261015T140000Z', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=15', 'SUMMARY:Rent'));
    const before = serialize(l.vcal);
    const target = findOccurrence(l.parts, '2026-11-15T13:00:00Z', NY) as Occurrence;
    expect(target).toBeDefined();
    const input = { startDate: '2026-11-16T09:00' };
    expect(() =>
      editSeries({ vcal: l.vcal, master: l.parts.master as Component, overrides: [], target, times: planTimes(target, input, NY, true), timeInput: input, fields: {}, who: undefined, zone: NY, now: NOW }),
    ).toThrow(/BYMONTHDAY/);
    expect(serialize(l.vcal)).toBe(before);
    // Only the time of day: allowed.
    const later = { startDate: '2026-11-15T11:00' };
    editSeries({ vcal: l.vcal, master: l.parts.master as Component, overrides: [], target, times: planTimes(target, later, NY, true), timeInput: later, fields: {}, who: undefined, zone: NY, now: NOW });
    expect(serialize(l.vcal)).toContain('RRULE:FREQ=MONTHLY;BYMONTHDAY=15');
  });

  it('moves UNTIL by the wall clock, so a move across a DST change keeps the last occurrence', () => {
    const l = load(
      ...NY_TZ,
      ...vevent('UID:u', 'DTSTART;TZID=America/New_York:20270307T090000', 'DTEND;TZID=America/New_York:20270307T100000', 'RRULE:FREQ=WEEKLY;UNTIL=20270704T130000Z'),
    );
    const target = { ...singleOccurrence(l.parts.master as Component, NY), master: l.parts.master, recurring: true };
    // Mar 7 is EST, Mar 15 EDT: the instant moves 8 days minus an hour, the wall clock 8 days.
    const input = { startDate: '2027-03-15T09:00' };
    editSeries({ vcal: l.vcal, master: l.parts.master as Component, overrides: [], target, times: planTimes(target, input, NY, true), timeInput: input, fields: {}, who: undefined, zone: NY, now: NOW });
    expect(serialize(l.vcal)).toContain('UNTIL=20270712T130000Z');
    const occs = expandSeries(eventParts(l.vcal), { from: new Date('2027-07-01T00:00:00Z'), to: new Date('2027-07-20T00:00:00Z'), zone: NY }).occurrences;
    expect(occs.map((o) => o.occ)).toEqual(['2027-07-05T13:00:00Z', '2027-07-12T13:00:00Z']);
  });
});

describe('editSeries and values of the other type', () => {
  const keys = (vcal: Component) =>
    expandSeries(eventParts(parseCalendar(serialize(vcal), 't')), { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2027-03-01T00:00:00Z'), zone: NY }).occurrences.map(
      (o) => o.startYmd ?? o.start.toISOString(),
    );
  const moveAll = (l: { vcal: Component; parts: EventParts }, occ: string, startDate: string) => {
    const target = findOccurrence(l.parts, occ, NY) as Occurrence;
    const input = { startDate };
    editSeries({ vcal: l.vcal, master: l.parts.master as Component, overrides: l.parts.overrides, target, times: planTimes(target, input, NY, true), timeInput: input, fields: {}, who: undefined, zone: NY, now: NOW });
  };

  it('moves a DATE-TIME UNTIL of an all-day series by whole days, keeping the final occurrence', () => {
    const l = load(...vevent('UID:a', 'DTSTART;VALUE=DATE:20261005', 'DTEND;VALUE=DATE:20261006', 'RRULE:FREQ=WEEKLY;UNTIL=20261026T035959Z'));
    expect(keys(l.vcal)).toEqual(['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
    moveAll(l, '2026-10-05', '2026-10-07');
    expect(serialize(l.vcal)).toContain('UNTIL=20261028T035959Z');
    expect(keys(l.vcal)).toEqual(['2026-10-07', '2026-10-14', '2026-10-21', '2026-10-28']);
  });

  it('moves a DATE UNTIL or EXDATE of a timed series by the days its occurrences move', () => {
    const u = load(
      ...NY_TZ,
      ...vevent('UID:t', 'DTSTART;TZID=America/New_York:20261005T090000', 'DTEND;TZID=America/New_York:20261005T100000', 'RRULE:FREQ=WEEKLY;UNTIL=20261020'),
    );
    expect(keys(u.vcal)).toEqual(['2026-10-05T13:00:00.000Z', '2026-10-12T13:00:00.000Z', '2026-10-19T13:00:00.000Z']);
    moveAll(u, '2026-10-05T13:00:00Z', '2026-10-06T09:00');
    expect(keys(u.vcal)).toEqual(['2026-10-06T13:00:00.000Z', '2026-10-13T13:00:00.000Z', '2026-10-20T13:00:00.000Z']);

    const x = load(
      ...NY_TZ,
      ...vevent('UID:x', 'DTSTART;TZID=America/New_York:20261005T090000', 'DTEND;TZID=America/New_York:20261005T100000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE;VALUE=DATE:20261012'),
    );
    expect(keys(x.vcal)).toEqual(['2026-10-05T13:00:00.000Z', '2026-10-19T13:00:00.000Z', '2026-10-26T13:00:00.000Z']);
    moveAll(x, '2026-10-05T13:00:00Z', '2026-10-06T09:00');
    expect(serialize(x.vcal)).toContain('EXDATE;VALUE=DATE:20261013');
    expect(keys(x.vcal)).toEqual(['2026-10-06T13:00:00.000Z', '2026-10-20T13:00:00.000Z', '2026-10-27T13:00:00.000Z']);
  });
});

describe('checkShifted', () => {
  const rule = ICAL.Recur.fromString('FREQ=MONTHLY');

  it('accepts a series whose every instance moved by the shift', () => {
    expect(() => checkShifted(['2026-10-31', '2026-12-31'], ['2026-10-31', '2026-12-31'], rule)).not.toThrow();
    expect(() => checkShifted([], [], undefined)).not.toThrow();
  });

  it('refuses one that gains, drops or re-days an occurrence, naming the first', () => {
    expect(() => checkShifted(['2026-10-31'], ['2026-10-31', '2026-11-30'], rule)).toThrow(
      'occurrence 2 should become no occurrence, but the rewritten series would have one on 2026-11-30',
    );
    expect(() => checkShifted(['2026-10-31', '2026-12-01'], ['2026-10-31'], undefined)).toThrow(
      'calendar: this series cannot be moved by moving its start: occurrence 2 should become an occurrence on 2026-12-01, but the rewritten series would have none',
    );
    expect(() => checkShifted(['2026-10-31'], ['2026-11-01'], rule)).toThrow(AppleToolError);
  });
});

describe('splitting', () => {
  it('knows the first instance and the instant of an #occ value', () => {
    const { parts } = load(...vevent('UID:s', 'DTSTART:20261019T130000Z', 'RRULE:FREQ=DAILY'));
    const master = parts.master as Component;
    expect(isFirstInstance(master, '2026-10-19T13:00:00Z', NY)).toBe(true);
    expect(isFirstInstance(master, '2026-10-20T13:00:00Z', NY)).toBe(false);
    const empty = load(...vevent('UID:e', 'DTSTART:20261019T130000Z', 'RRULE:FREQ=DAILY;COUNT=1', 'EXDATE:20261019T130000Z'));
    expect(isFirstInstance(empty.parts.master as Component, '2026-10-19T13:00:00Z', NY)).toBe(true);
    expect(occInstant('2026-10-19', NY).toISOString()).toBe('2026-10-19T04:00:00.000Z');
    expect(occInstant('2026-10-19T13:00:00Z', NY).toISOString()).toBe('2026-10-19T13:00:00.000Z');
  });

  it('ends a series before an occurrence and continues it in a new one', () => {
    const l = load(
      ...NY_TZ,
      ...vevent(
        'UID:s',
        'DTSTART;TZID=America/New_York:20261019T090000',
        'DURATION:PT15M',
        'RRULE:FREQ=DAILY;COUNT=10',
        'EXDATE;TZID=America/New_York:20261020T090000,20261024T090000',
        'RDATE:20261201T140000Z',
        'RDATE:20261018T200000Z',
      ),
      ...vevent('UID:s', 'RECURRENCE-ID;TZID=America/New_York:20261021T090000', 'DTSTART;TZID=America/New_York:20261021T100000'),
      ...vevent('UID:s', 'RECURRENCE-ID;TZID=America/New_York:20261025T090000', 'DTSTART;TZID=America/New_York:20261025T100000'),
    );
    const master = l.parts.master as Component;
    const target = findOccurrence(l.parts, '2026-10-23T13:00:00Z', NY) as Occurrence;
    const carried = l.parts.overrides.slice(1);
    const next = continuationSeries(l.vcal, master, carried, target, 4, { uid: 'NEW', now: NOW, zone: NY });
    const removed = truncateSeries(l.vcal, master, l.parts.overrides, target, NY, NOW);
    expect(removed).toHaveLength(1);
    const oldText = unfold(serialize(l.vcal));
    expect(oldText).toContain('RRULE:FREQ=DAILY;UNTIL=20261023T125959Z');
    expect(oldText).toContain('EXDATE;TZID=America/New_York:20261020T090000');
    expect(oldText).not.toContain('20261024T090000');
    expect(oldText).toContain('RDATE:20261018T200000Z');
    expect(oldText).not.toContain('20261201T140000Z');
    expect(oldText).toContain('RECURRENCE-ID;TZID=America/New_York:20261021T090000');
    expect(oldText).not.toContain('20261025T090000');
    const newText = unfold(serialize(next.vcal));
    expect(newText).toContain('PRODID:-//Apple Inc.//macOS 14.2.1//EN');
    expect(newText.indexOf('BEGIN:VTIMEZONE')).toBeLessThan(newText.indexOf('BEGIN:VEVENT'));
    expect(newText).toContain('UID:NEW');
    expect(newText).toContain('DTSTART;TZID=America/New_York:20261023T090000');
    // The series' length as it was written (a DURATION, which RFC 5545 applies to each instance nominally).
    expect(newText).toContain('DURATION:PT15M');
    expect(newText).toContain('RRULE:FREQ=DAILY;COUNT=6');
    expect(newText).toContain('EXDATE;TZID=America/New_York:20261024T090000');
    expect(newText).not.toContain('20261020T090000');
    expect(newText).toContain('RDATE:20261201T140000Z');
    expect(next.overrides.map((o) => o.getFirstPropertyValue('uid'))).toEqual(['NEW']);
    // The continuation's first instance is the split occurrence.
    expect(findOccurrence({ master: next.master, overrides: next.overrides }, '2026-10-23T13:00:00Z', NY)).toBeDefined();
  });

  it('splits all-day and floating series, and a rule without COUNT', () => {
    const d = load(...vevent('UID:d', 'DTSTART;VALUE=DATE:20261019', 'RRULE:FREQ=DAILY'));
    const dt = findOccurrence(d.parts, '2026-10-22', NY) as Occurrence;
    const dn = continuationSeries(d.vcal, d.parts.master as Component, [], dt, 3, { uid: 'D2', now: NOW, zone: NY });
    truncateSeries(d.vcal, d.parts.master as Component, [], dt, NY, NOW);
    expect(serialize(d.vcal)).toContain('RRULE:FREQ=DAILY;UNTIL=20261021');
    expect(serialize(dn.vcal)).toContain('DTSTART;VALUE=DATE:20261022');
    expect(serialize(dn.vcal)).toContain('DTEND;VALUE=DATE:20261023');
    expect(serialize(dn.vcal)).toContain('RRULE:FREQ=DAILY\r\n');

    const f = load(...vevent('UID:f', 'DTSTART:20261019T090000', 'RRULE:FREQ=DAILY'));
    truncateSeries(f.vcal, f.parts.master as Component, [], findOccurrence(f.parts, '2026-10-22T13:00:00Z', NY) as Occurrence, NY, NOW);
    expect(serialize(f.vcal)).toContain('UNTIL=20261022T085959');

    const r = load(...vevent('UID:r', 'DTSTART:20261019T130000Z', 'RDATE:20261022T130000Z,20261025T130000Z'));
    const rt = findOccurrence(r.parts, '2026-10-22T13:00:00Z', NY) as Occurrence;
    const rn = continuationSeries(r.vcal, r.parts.master as Component, [], rt, 0, { uid: 'R2', now: NOW, zone: NY });
    truncateSeries(r.vcal, r.parts.master as Component, [], rt, NY, NOW);
    expect(serialize(r.vcal)).not.toContain('RDATE');
    expect(serialize(rn.vcal)).toContain('RDATE:20261022T130000Z,20261025T130000Z'.split(',')[1]);
    expect(startTimeOf(rn.master).toString()).toBe('2026-10-22T13:00:00Z');
    expect(new ICAL.Component(newCalendar().toJSON()).name).toBe('vcalendar');
  });
});
