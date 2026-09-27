import { describe, expect, it, vi } from 'vitest';
import { UpstreamError } from '../../src/errors.js';
import {
  ICAL,
  addTimeProp,
  boundedTimezone,
  buildRule,
  cloneComponent,
  dateValue,
  daysBetween,
  describeRule,
  emailOf,
  endTimeOf,
  ensureOrganizer,
  eventParts,
  injectMissingTimezones,
  instantOf,
  isRecurringMaster,
  isSelf,
  newCalendar,
  newEvent,
  normalizeAddress,
  occKey,
  parseCalendar,
  readAlarms,
  readAttendees,
  readOrganizer,
  ruleOf,
  serialize,
  setAlarms,
  setAttendees,
  setTextProp,
  setTimeProp,
  startTimeOf,
  textProp,
  timeAt,
  timeValues,
  touch,
  tzidOf,
  utcStamp,
  vtimezoneFor,
  wallTime,
  ymdOf,
  zoneForWrite,
  zoneOfTime,
  type Component,
  type Time,
} from '../../src/calendar/ics.js';
import { NY_TZ, ics, vevent } from './fake-caldav.js';

const NY = 'America/New_York';

function event(...lines: string[]): Component {
  const vcal = parseCalendar(ics(...vevent(...lines)), 'test');
  return vcal.getFirstSubcomponent('vevent') as Component;
}

describe('parseCalendar', () => {
  it('refuses text that is not iCalendar, and a component that is not a VCALENDAR', () => {
    expect(() => parseCalendar('garbage', 'x')).toThrow(UpstreamError);
    expect(() => parseCalendar('garbage', 'event x')).toThrow(/event x is not valid iCalendar/);
    expect(() => parseCalendar('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:A\r\nEND:VCARD', 'x')).toThrow(/holds a VCARD, not a VCALENDAR/);
  });

  it('injects a VTIMEZONE for a TZID that has none, so the time is not read as floating (UTC)', () => {
    const vcal = parseCalendar(
      ics(...vevent('UID:a', 'DTSTART;TZID=America/New_York:20261020T090000', 'BEGIN:VALARM', 'TRIGGER;TZID=Europe/Berlin:20261020T080000', 'END:VALARM')),
      'x',
    );
    const tzids = vcal.getAllSubcomponents('vtimezone').map((z) => z.getFirstPropertyValue('tzid'));
    expect(tzids).toEqual([NY, 'Europe/Berlin']);
    const start = startTimeOf(vcal.getFirstSubcomponent('vevent') as Component);
    expect(instantOf(start, 'UTC').toISOString()).toBe('2026-10-20T13:00:00.000Z');
  });

  it('keeps a VTIMEZONE the resource defines, and leaves an unknown TZID alone (floating)', () => {
    const vcal = parseCalendar(
      ics(...NY_TZ, ...vevent('UID:a', 'DTSTART;TZID=America/New_York:20261020T090000', 'DTEND;TZID=Eastern Standard Time:20261020T100000')),
      'x',
    );
    expect(vcal.getAllSubcomponents('vtimezone')).toHaveLength(1);
    const ev = vcal.getFirstSubcomponent('vevent') as Component;
    const end = ev.getFirstPropertyValue('dtend') as Time;
    expect(end.zone).toBe(ICAL.Timezone.localTimezone);
    // Floating: wall clock in the display zone.
    expect(instantOf(end, NY).toISOString()).toBe('2026-10-20T14:00:00.000Z');
  });
});

describe('time zones a resource defines', () => {
  const zone = (tzid: string, daylightRule: string) => [
    'BEGIN:VTIMEZONE',
    `TZID:${tzid}`,
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:-0500',
    'TZOFFSETTO:-0400',
    'DTSTART:20070311T020000',
    `RRULE:${daylightRule}`,
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0400',
    'TZOFFSETTO:-0500',
    'DTSTART:20071104T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ];

  it('accepts yearly observance rules and refuses unbounded ones', () => {
    const parsed = parseCalendar(ics(...zone('Z', 'FREQ=YEARLY;BYMONTH=3;BYDAY=2SU')), 'x').getFirstSubcomponent('vtimezone') as Component;
    expect(boundedTimezone(parsed)).toBe(true);
    const raw = (rule: string) => ICAL.Component.fromString(ics(...zone('Z', rule))).getFirstSubcomponent('vtimezone') as Component;
    expect(boundedTimezone(raw('FREQ=YEARLY;BYMONTH=3;BYDAY=2SU'))).toBe(true);
    expect(boundedTimezone(raw('FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30'))).toBe(false);
    expect(boundedTimezone(raw('FREQ=MINUTELY'))).toBe(false);
    expect(boundedTimezone(raw('FREQ=YEARLY;BYMONTH=3;BYHOUR=0,1,2,3'))).toBe(false);
  });

  it('replaces a definition ical.js would never finish evaluating, instead of hanging on it', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // This DAYLIGHT rule never matches a day: evaluating the zone as written spins forever inside ical.js.
    const known = parseCalendar(
      ics(...zone(NY, 'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30'), ...vevent('UID:a', 'DTSTART;TZID=America/New_York:20261020T090000')),
      'event k',
    );
    expect(instantOf(startTimeOf(known.getFirstSubcomponent('vevent') as Component), NY).toISOString()).toBe('2026-10-20T13:00:00.000Z');
    expect(known.getAllSubcomponents('vtimezone')).toHaveLength(1);
    expect(serialize(known)).not.toContain('FREQ=DAILY');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/event k defines time zone "America\/New_York" with a rule that cannot be evaluated safely/));
    // Not a zone the library knows: dropped, and the time is read as floating (wall clock in the display zone).
    const unknown = parseCalendar(ics(...zone('Evil/Zone', 'FREQ=MINUTELY'), ...vevent('UID:b', 'DTSTART;TZID=Evil/Zone:20261020T090000')), 'x');
    expect(unknown.getAllSubcomponents('vtimezone')).toEqual([]);
    expect(instantOf(startTimeOf(unknown.getFirstSubcomponent('vevent') as Component), NY).toISOString()).toBe('2026-10-20T13:00:00.000Z');
  });
});

describe('eventParts', () => {
  it('splits master and overrides, ignoring VEVENTs without DTSTART and a second master', () => {
    const vcal = parseCalendar(
      ics(
        ...vevent('UID:a', 'DTSTART:20261020T130000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:first'),
        ...vevent('UID:a', 'DTSTART:20261021T130000Z', 'SUMMARY:second master'),
        ...vevent('UID:a', 'RECURRENCE-ID:20261022T130000Z', 'DTSTART:20261022T150000Z'),
        ...vevent('UID:a', 'SUMMARY:no start'),
      ),
      'x',
    );
    const parts = eventParts(vcal);
    expect(textProp(parts.master as Component, 'summary')).toBe('first');
    expect(parts.overrides).toHaveLength(1);
    expect(isRecurringMaster(parts.master as Component)).toBe(true);
    expect(eventParts(parseCalendar(ics(), 'x'))).toEqual({ overrides: [] });
  });

  it('knows RDATE-only series are recurring', () => {
    expect(isRecurringMaster(event('DTSTART:20261020T130000Z', 'RDATE:20261025T130000Z'))).toBe(true);
    expect(isRecurringMaster(event('DTSTART:20261020T130000Z'))).toBe(false);
  });
});

describe('time zones', () => {
  it('builds VTIMEZONEs, renamed to the TZID that references them', () => {
    expect(vtimezoneFor('Nowhere/Land')).toBeUndefined();
    expect(vtimezoneFor('US/Eastern')?.getFirstPropertyValue('tzid')).toBe('US/Eastern');
    expect(vtimezoneFor(NY, 'X')?.getFirstPropertyValue('tzid')).toBe('X');
  });

  it('chooses a write zone: UTC aliases and unknown zones as UTC, an IANA zone by its canonical TZID (added once)', () => {
    const vcal = newCalendar();
    expect(zoneForWrite(vcal, 'UTC')).toEqual({ kind: 'utc' });
    expect(zoneForWrite(vcal, 'Etc/GMT')).toEqual({ kind: 'utc' });
    expect(zoneForWrite(vcal, 'Mars/Olympus')).toEqual({ kind: 'utc' });
    const wz = zoneForWrite(vcal, 'US/Eastern');
    expect(wz.kind).toBe('tz');
    expect(wz.kind === 'tz' && wz.tz.tzid).toBe(NY);
    zoneForWrite(vcal, NY);
    expect(vcal.getAllSubcomponents('vtimezone')).toHaveLength(1);
  });

  it('describes the zone of a value', () => {
    const utc = timeAt(new Date('2026-10-20T13:00:00Z'), { kind: 'utc' });
    const floating = timeAt(new Date('2026-10-20T13:00:00Z'), { kind: 'floating', zone: NY });
    const vcal = newCalendar();
    const tz = zoneForWrite(vcal, NY);
    const zoned = timeAt(new Date('2026-10-20T13:00:00Z'), tz);
    expect(zoneOfTime(utc, NY)).toEqual({ kind: 'utc' });
    expect(zoneOfTime(floating, NY)).toEqual({ kind: 'floating', zone: NY });
    expect(zoneOfTime(zoned, NY)).toEqual(tz);
    expect(tzidOf(zoned)).toBe(NY);
    expect(tzidOf(utc)).toBeUndefined();
    expect(tzidOf(floating)).toBeUndefined();
    expect(tzidOf(dateValue('2026-10-20'))).toBeUndefined();
    expect(zoned.toString()).toBe('2026-10-20T09:00:00');
    expect(floating.toString()).toBe('2026-10-20T09:00:00');
    expect(utc.toString()).toBe('2026-10-20T13:00:00Z');
  });

  it('collects TZIDs from nested components', () => {
    const vcal = newCalendar();
    const ev = newEvent('u', new Date('2026-01-01T00:00:00Z'));
    vcal.addSubcomponent(ev);
    const alarm = new ICAL.Component('valarm');
    const p = alarm.addPropertyWithValue('x-thing', 'v');
    p.setParameter('tzid', 'Europe/Paris');
    ev.addSubcomponent(alarm);
    injectMissingTimezones(vcal);
    expect(vcal.getAllSubcomponents('vtimezone').map((z) => z.getFirstPropertyValue('tzid'))).toEqual(['Europe/Paris']);
  });
});

describe('values and instants', () => {
  it('converts dates, floating and zoned values', () => {
    expect(ymdOf(dateValue('0999-01-02'))).toBe('0999-01-02');
    expect(instantOf(dateValue('2026-10-20'), NY).toISOString()).toBe('2026-10-20T04:00:00.000Z');
    expect(occKey(dateValue('2026-10-20'), NY)).toBe('2026-10-20');
    expect(occKey(timeAt(new Date('2026-10-20T13:00:00.900Z'), { kind: 'utc' }), NY)).toBe('2026-10-20T13:00:00Z');
    expect(utcStamp(new Date('2026-10-20T13:00:00.123Z'))).toBe('2026-10-20T13:00:00Z');
    expect(daysBetween('2026-10-20', '2026-11-02')).toBe(13);
  });

  it('builds values from wall-clock fields in each kind of zone', () => {
    const wall = new Date('2026-10-20T09:30:00Z'); // carries 09:30 as fields
    const vcal = newCalendar();
    const tz = zoneForWrite(vcal, NY);
    expect(wallTime(wall, { kind: 'utc' }).toString()).toBe('2026-10-20T09:30:00Z');
    expect(wallTime(wall, { kind: 'floating', zone: NY }).toString()).toBe('2026-10-20T09:30:00');
    const zoned = wallTime(wall, tz);
    expect([zoned.toString(), instantOf(zoned, 'UTC').toISOString()]).toEqual(['2026-10-20T09:30:00', '2026-10-20T13:30:00.000Z']);
  });

  it('writes TZID parameters only for zoned date-times', () => {
    const vcal = newCalendar();
    const tz = zoneForWrite(vcal, NY);
    const ev = new ICAL.Component('vevent');
    const at = new Date('2026-10-20T13:00:00Z');
    setTimeProp(ev, 'dtstart', timeAt(at, tz));
    setTimeProp(ev, 'dtend', timeAt(at, { kind: 'utc' }));
    setTimeProp(ev, 'recurrence-id', dateValue('2026-10-20'));
    setTimeProp(ev, 'x-float', timeAt(at, { kind: 'floating', zone: NY }));
    addTimeProp(ev, 'exdate', timeAt(at, tz));
    addTimeProp(ev, 'exdate', timeAt(at, { kind: 'utc' }));
    addTimeProp(ev, 'rdate', dateValue('2026-10-21'));
    addTimeProp(ev, 'rdate', timeAt(at, { kind: 'floating', zone: NY }));
    const text = ev.toString();
    expect(text).toContain('DTSTART;TZID=America/New_York:20261020T090000');
    expect(text).toContain('DTEND:20261020T130000Z');
    expect(text).toContain('RECURRENCE-ID;VALUE=DATE:20261020');
    expect(text).toContain('EXDATE;TZID=America/New_York:20261020T090000');
    expect(text).toContain('EXDATE:20261020T130000Z');
    expect(text).toContain('RDATE;VALUE=DATE:20261021');
    expect(text).toContain('RDATE:20261020T090000');
    expect(timeValues(ev, 'exdate')).toHaveLength(2);
    const withPeriod = event('DTSTART:20261020T130000Z', 'RDATE;VALUE=PERIOD:20261021T130000Z/PT1H');
    expect(timeValues(withPeriod, 'rdate')).toEqual([]);
  });

  it('finds the end: DTEND, DURATION, a day for a date, else the start', () => {
    const withEnd = event('DTSTART:20261020T130000Z', 'DTEND:20261020T140000Z');
    expect(endTimeOf(withEnd, startTimeOf(withEnd)).toString()).toBe('2026-10-20T14:00:00Z');
    const withDuration = event('DTSTART:20261020T130000Z', 'DURATION:PT90M');
    expect(endTimeOf(withDuration, startTimeOf(withDuration)).toString()).toBe('2026-10-20T14:30:00Z');
    const date = event('DTSTART;VALUE=DATE:20261020');
    expect(endTimeOf(date, startTimeOf(date)).toString()).toBe('2026-10-21');
    const bare = event('DTSTART:20261020T130000Z');
    expect(endTimeOf(bare, startTimeOf(bare)).toString()).toBe('2026-10-20T13:00:00Z');
  });
});

describe('text and stamps', () => {
  it('reads absent and empty text as undefined, and "" clears', () => {
    const ev = event('DTSTART:20261020T130000Z', 'LOCATION:', 'SUMMARY:Hi');
    expect(textProp(ev, 'location')).toBeUndefined();
    expect(textProp(ev, 'description')).toBeUndefined();
    expect(textProp(ev, 'summary')).toBe('Hi');
    setTextProp(ev, 'summary', 'New');
    expect(textProp(ev, 'summary')).toBe('New');
    setTextProp(ev, 'summary', '');
    expect(ev.hasProperty('summary')).toBe(false);
    setTextProp(ev, 'location', undefined);
    expect(ev.hasProperty('location')).toBe(false);
  });

  it('bumps SEQUENCE and restamps', () => {
    const now = new Date('2026-10-20T16:00:00Z');
    const a = event('DTSTART:20261020T130000Z', 'SEQUENCE:4');
    touch(a, now);
    expect(a.getFirstPropertyValue('sequence')).toBe(5);
    const b = event('DTSTART:20261020T130000Z');
    touch(b, now);
    expect(b.getFirstPropertyValue('sequence')).toBe(1);
    expect(String(b.getFirstPropertyValue('dtstamp'))).toBe('2026-10-20T16:00:00Z');
    expect(String(b.getFirstPropertyValue('last-modified'))).toBe('2026-10-20T16:00:00Z');
  });
});

describe('people', () => {
  const ev = () =>
    event(
      'DTSTART:20261020T130000Z',
      'ORGANIZER;CN=Boss:mailto:boss@x.com',
      'ATTENDEE;CN=Ann;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:ann@x.com',
      'ATTENDEE;ROLE=OPT-PARTICIPANT:MAILTO:bob@x.com',
      'ATTENDEE;CN=Me;EMAIL=me@icloud.com;PARTSTAT=DECLINED;ROLE=X-ODD:/123/principal/',
      'ATTENDEE;CN=:urn:uuid:nobody',
    );

  it('reads organizer and attendees, e-mail from mailto: or the EMAIL parameter', () => {
    const e = ev();
    expect(readOrganizer(e)).toEqual({ name: 'Boss', email: 'boss@x.com' });
    expect(readAttendees(e)).toEqual([
      { name: 'Ann', email: 'ann@x.com', status: 'accepted', role: 'required' },
      { email: 'bob@x.com', status: 'needs-action', role: 'optional' },
      { name: 'Me', email: 'me@icloud.com', status: 'declined', role: 'x-odd' },
      { status: 'needs-action' },
    ]);
    expect(readOrganizer(event('DTSTART:20261020T130000Z'))).toBeUndefined();
    expect(readOrganizer(event('DTSTART:20261020T130000Z', 'ORGANIZER:/123/principal/'))).toBeUndefined();
    const emptyEmail = event('DTSTART:20261020T130000Z', 'ATTENDEE;EMAIL="":/1/principal/');
    expect(emailOf(emptyEmail.getFirstProperty('attendee') as never)).toBeUndefined();
  });

  it('normalises addresses and recognises the owner', () => {
    expect(normalizeAddress('MAILTO:Me@iCloud.com')).toBe('mailto:me@icloud.com');
    expect(normalizeAddress('https://caldav.icloud.com/123/principal/')).toBe('/123/principal/');
    expect(normalizeAddress('urn:uuid:X')).toBe('urn:uuid:X');
    const self = new Set(['/123/principal/', 'mailto:ann@x.com']);
    const [ann, bob, me, nobody] = ev().getAllProperties('attendee');
    expect(isSelf(ann as never, self)).toBe(true);
    expect(isSelf(bob as never, self)).toBe(false);
    expect(isSelf(me as never, self)).toBe(true);
    expect(isSelf(nobody as never, self)).toBe(false);
    expect(isSelf(me as never, new Set(['mailto:me@icloud.com']))).toBe(true);
  });

  it('replaces invitees, keeping existing entries (their PARTSTAT) and the owner while anyone is invited', () => {
    const e = ev();
    setAttendees(e, [{ email: 'ANN@x.com', name: 'Ann B.' }, { email: 'bob@x.com' }, { email: 'cy@x.com', name: 'Cy' }, { email: 'di@x.com' }], new Set(['/123/principal/']));
    const text = e.toString().replace(/\r\n /g, '');
    expect(text).toContain('ATTENDEE;CN=Ann B.;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:ann@x.com');
    expect(text).toContain('/123/principal/');
    expect(text).toContain('ATTENDEE;CN=Cy;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:cy@x.com');
    expect(text).toContain('ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:di@x.com');
    expect(text).not.toContain('urn:uuid:nobody');
    expect(readAttendees(e).map((a) => a.email)).toEqual(['me@icloud.com', 'ann@x.com', 'bob@x.com', 'cy@x.com', 'di@x.com']);
    setAttendees(e, [], new Set(['/123/principal/']));
    expect(e.hasProperty('attendee')).toBe(false);
  });

  it('sets ORGANIZER only when absent', () => {
    const e = event('DTSTART:20261020T130000Z');
    ensureOrganizer(e, 'me@icloud.com');
    ensureOrganizer(e, 'other@x.com');
    expect(readOrganizer(e)).toEqual({ email: 'me@icloud.com' });
  });
});

describe('alarms', () => {
  it('reads relative, END-relative and absolute triggers; skips ACTION:NONE and trigger-less alarms', () => {
    const e = event(
      'DTSTART:20261020T130000Z',
      'DTEND:20261020T140000Z',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT15M',
      'END:VALARM',
      'BEGIN:VALARM',
      'ACTION:AUDIO',
      'TRIGGER;RELATED=END:-PT30M',
      'END:VALARM',
      'BEGIN:VALARM',
      'TRIGGER;VALUE=DATE-TIME:20261020T120000Z',
      'END:VALARM',
      'BEGIN:VALARM',
      'ACTION:NONE',
      'TRIGGER;VALUE=DATE-TIME:19760401T005545Z',
      'END:VALARM',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'END:VALARM',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:PT5M',
      'END:VALARM',
    );
    const start = new Date('2026-10-20T13:00:00Z');
    const end = new Date('2026-10-20T14:00:00Z');
    expect(readAlarms(e, start, end, NY)).toEqual([15, -30, 60, -5]);
  });

  it('replaces every alarm', () => {
    const e = event('DTSTART:20261020T130000Z', 'BEGIN:VALARM', 'ACTION:NONE', 'TRIGGER:-PT1M', 'END:VALARM');
    setAlarms(e, [0, 90]);
    const start = new Date('2026-10-20T13:00:00Z');
    expect(readAlarms(e, start, start, NY)).toEqual([0, 90]);
    expect(e.toString()).toContain('TRIGGER:-PT1H30M');
    setAlarms(e, []);
    expect(e.getAllSubcomponents('valarm')).toEqual([]);
  });
});

describe('recurrence rules', () => {
  const rule = (s: string) => ICAL.Recur.fromString(s);

  it('phrases common rules in plain English', () => {
    expect(describeRule(rule('FREQ=DAILY'))).toBe('Every day');
    expect(describeRule(rule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE'))).toBe('Every 2 weeks on Monday and Wednesday');
    expect(describeRule(rule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'))).toBe('Every weekday');
    expect(describeRule(rule('FREQ=DAILY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR'))).toBe('Every 2 days on weekdays');
    expect(describeRule(rule('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'))).toBe(
      'Every month on Monday, Tuesday, Wednesday, Thursday and Friday (also BYSETPOS)',
    );
    expect(describeRule(rule('FREQ=MONTHLY;BYDAY=2TU;COUNT=4'))).toBe('Every month on the second Tuesday, 4 times');
    expect(describeRule(rule('FREQ=MONTHLY;BYDAY=-1FR;COUNT=1'))).toBe('Every month on the last Friday, 1 time');
    expect(describeRule(rule('FREQ=MONTHLY;BYDAY=-2SU'))).toBe('Every month on the second-to-last Sunday');
    expect(describeRule(rule('FREQ=MONTHLY;BYMONTHDAY=15,-1,-3'))).toBe('Every month on day 15, the last day and the third-to-last day');
    expect(describeRule(rule('FREQ=YEARLY;BYMONTH=3;BYDAY=2SU'), 'Fri, Dec 31, 2027')).toBe(
      'Every year on the second Sunday in March, until Fri, Dec 31, 2027',
    );
    expect(describeRule(rule('FREQ=HOURLY;INTERVAL=3'))).toBe('Every 3 hours');
  });

  it('names what it cannot phrase instead of dropping it', () => {
    const odd = ICAL.Recur.fromData({ freq: 'FORTNIGHTLY' as never, byday: ['XX', '7ZZ', 'what'], bymonth: [13] });
    expect(describeRule(odd)).toBe('Every fortnightly on XX, the 7th ZZ and what in 13');
    const ordinals = [6, 11, 12, 13, 21, 22, 23, 24].map((n) => describeRule(ICAL.Recur.fromData({ freq: 'YEARLY', byday: [`${n}MO`] })));
    expect(ordinals).toEqual([
      'Every year on the 6th Monday',
      'Every year on the 11th Monday',
      'Every year on the 12th Monday',
      'Every year on the 13th Monday',
      'Every year on the 21st Monday',
      'Every year on the 22nd Monday',
      'Every year on the 23rd Monday',
      'Every year on the 24th Monday',
    ]);
    expect(describeRule(ICAL.Recur.fromData({ freq: 'MONTHLY', byday: ['+1MO'] }))).toBe('Every month on the first Monday');
  });

  it('builds rules from tool input', () => {
    expect(buildRule({ frequency: 'weekly', interval: 2, byWeekday: ['WE', 'MO'] }, undefined).toString()).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE');
    expect(buildRule({ frequency: 'daily', interval: 1, count: 3, byWeekday: [] }, undefined).toString()).toBe('FREQ=DAILY;COUNT=3');
    expect(buildRule({ frequency: 'yearly' }, dateValue('2030-01-01')).toString()).toBe('FREQ=YEARLY;UNTIL=20300101');
    expect(ruleOf(event('DTSTART:20261020T130000Z'))).toBeUndefined();
    expect(ruleOf(event('DTSTART:20261020T130000Z', 'RRULE:FREQ=DAILY'))?.freq).toBe('DAILY');
  });
});

describe('building', () => {
  it('builds calendars and events, clones deeply, and serialises zones first', () => {
    const vcal = newCalendar();
    const ev = newEvent('U1', new Date('2026-10-20T16:00:00Z'));
    vcal.addSubcomponent(ev);
    setTimeProp(ev, 'dtstart', timeAt(new Date('2026-10-20T13:00:00Z'), zoneForWrite(vcal, NY)));
    const copy = cloneComponent(ev);
    copy.updatePropertyWithValue('uid', 'U2');
    expect(ev.getFirstPropertyValue('uid')).toBe('U1');
    const text = serialize(vcal);
    expect(text.indexOf('BEGIN:VTIMEZONE')).toBeLessThan(text.indexOf('BEGIN:VEVENT'));
    expect(text).toMatch(/^BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-\/\/chrischall\/\/aws-mcp\/\/EN\r\nCALSCALE:GREGORIAN\r\n/);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(text).toContain('SEQUENCE:0');
    expect(text).toContain('CREATED:20261020T160000Z');
  });
});
