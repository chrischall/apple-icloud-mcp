import { describe, expect, it, vi } from 'vitest';
import { InvalidArgumentError, UpstreamError } from '../../src/errors.js';
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
  rfcInstantOf,
  ruleOf,
  serialize,
  serializeForWrite,
  setAlarms,
  setAttendees,
  setEnd,
  setEventTimes,
  setTextProp,
  setTimeProp,
  skippedWall,
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
  type Timezone,
} from '../../src/calendar/ics.js';
import { zonedParts } from '../../src/time.js';
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
    // The library's lookup is case-sensitive, Intl's is not: a mis-cased zone still finds its definition, under its own name.
    expect(vtimezoneFor('america/new_york')?.getFirstPropertyValue('tzid')).toBe('america/new_york');
    expect(vtimezoneFor('america/new_york')?.toString()).toContain('TZOFFSETTO:-0400');
  });

  it('writes a mis-cased zone with its real TZID, never as UTC (a series would drift an hour at DST)', () => {
    const vcal = newCalendar();
    const wz = zoneForWrite(vcal, 'america/new_york');
    expect(wz.kind === 'tz' && wz.tz.tzid).toBe(NY);
    expect(zoneForWrite(vcal, 'EUROPE/LONDON')).toMatchObject({ kind: 'tz' });
    expect(vcal.getAllSubcomponents('vtimezone').map((z) => z.getFirstPropertyValue('tzid'))).toEqual([NY, 'Europe/London']);
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

  it('writes the true wall time next to every DST change, which reads back as the same instant', () => {
    // ical.js's own conversion took the offset at the UTC wall clock: an hour off for up to half a day around a change.
    // Dublin keeps winter as its "daylight" time (a negative DST), so ical.js reads its repeated hour the other way.
    for (const zone of ['America/New_York', 'Australia/Sydney', 'Europe/Berlin', 'Europe/Dublin', 'America/Santiago', 'Australia/Lord_Howe', 'America/Havana', 'Asia/Kolkata']) {
      const wz = zoneForWrite(newCalendar(), zone);
      const offsetAt = (ms: number) => {
        const p = zonedParts(new Date(ms), zone);
        return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - ms;
      };
      let checked = 0;
      for (let hour = Date.UTC(2026, 0, 1); hour < Date.UTC(2027, 0, 1); hour += 3_600_000) {
        const change = offsetAt(hour + 3_600_000) - offsetAt(hour);
        if (change === 0) continue;
        // Every quarter hour for 14 hours either side of the change.
        for (let ms = hour - 14 * 3_600_000; ms <= hour + 14 * 3_600_000; ms += 900_000) {
          const t = timeAt(new Date(ms), wz);
          const p = zonedParts(new Date(ms), zone);
          expect([t.year, t.month, t.day, t.hour, t.minute].map((n) => n + 0), `${zone} ${new Date(ms).toISOString()}`).toEqual([p.year, p.month, p.day, p.hour, p.minute]);
          const back = instantOf(t, zone).getTime();
          // The one exception: the pass of an hour a change repeats that ical.js does not read that wall time as.
          if (back !== ms) expect(Math.abs(back - ms), `${zone} ${new Date(ms).toISOString()}`).toBe(Math.abs(change));
          checked++;
        }
      }
      expect(checked, zone).toBeGreaterThan(zone === 'Asia/Kolkata' ? -1 : 200);
    }
  });

  it('takes the offset from the zone\'s own changes, also before its first one and for a zone without any', () => {
    const zoneOf = (vtimezone: string[]) => {
      const vcal = parseCalendar(['BEGIN:VCALENDAR', 'VERSION:2.0', ...vtimezone, 'BEGIN:VEVENT', 'UID:x', 'DTSTART;TZID=X/Test:20260101T000000', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'), 't');
      return { kind: 'tz' as const, tz: (vcal.getFirstSubcomponent('vevent')!.getFirstPropertyValue('dtstart') as Time).zone as Timezone };
    };
    // Its only observance starts in 2000 at +03:00, coming from +02:00. ical.js reads a wall time before it at offset
    // 0 (not the TZOFFSETFROM), so that is what a 1990 value has to be written as to read back.
    const late = zoneOf(['BEGIN:VTIMEZONE', 'TZID:X/Test', 'BEGIN:STANDARD', 'DTSTART:20000101T000000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0300', 'END:STANDARD', 'END:VTIMEZONE']);
    const old = timeAt(new Date('1990-06-01T12:00:00Z'), late);
    expect(old.toString()).toBe('1990-06-01T12:00:00');
    expect(instantOf(old, 'UTC').toISOString()).toBe('1990-06-01T12:00:00.000Z');
    expect(timeAt(new Date('2026-06-01T12:00:00Z'), late).toString()).toBe('2026-06-01T15:00:00');
    const none = zoneOf(['BEGIN:VTIMEZONE', 'TZID:X/Test', 'END:VTIMEZONE']);
    expect(timeAt(new Date('2026-06-01T12:00:00Z'), none).toString()).toBe('2026-06-01T12:00:00');
  });

  it('builds event times: the true wall time, in UTC for a single event when ical.js would read it as another instant', () => {
    const vcal = newCalendar();
    const ny = zoneForWrite(vcal, NY);
    const times = (start: string, end: string, wz: Parameters<typeof setEventTimes>[3], series: boolean) => {
      const ev = newEvent('t', new Date(0));
      const other = setEventTimes(ev, new Date(start), new Date(end), wz, series);
      return [startTimeOf(ev).toString(), endTimeOf(ev, startTimeOf(ev)).toString(), other];
    };
    // 01:30 EDT on the fall-back day (ical.js reads the wall time 01:30 as EST): a single event is written in UTC,
    // end and all; a series keeps the wall time, says it starts on the other pass, and ends an hour after it as read.
    expect(times('2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', ny, false)).toEqual(['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', false]);
    expect(times('2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', ny, true)).toEqual(['2026-11-01T01:30:00', '2026-11-01T02:30:00', true]);
    expect(times('2026-10-20T13:00:00Z', '2026-10-20T14:00:00Z', ny, false)).toEqual(['2026-10-20T09:00:00', '2026-10-20T10:00:00', false]);
    // Floating values are read in their zone, a repeated hour as its first pass: the second 01:30 has no floating
    // form, so a single event starting then takes UTC; an end then does too (never the same wall time as its start).
    const floating = { kind: 'floating' as const, zone: NY };
    expect(times('2026-11-01T06:30:00Z', '2026-11-01T07:30:00Z', floating, false)).toEqual(['2026-11-01T06:30:00Z', '2026-11-01T07:30:00Z', false]);
    expect(times('2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', floating, true)).toEqual(['2026-11-01T01:30:00', '2026-11-01T06:30:00Z', false]);
    expect(times('2026-10-20T13:00:00Z', '2026-10-20T14:00:00Z', floating, false)).toEqual(['2026-10-20T09:00:00', '2026-10-20T10:00:00', false]);
  });

  it('knows a wall time a DST change skips, reads it as RFC 5545 does, and ends it with DURATION', () => {
    const vcal = newCalendar();
    const ny = zoneForWrite(vcal, NY) as { kind: 'tz'; tz: Timezone };
    const at = (s: string) => {
      const [year, month, day, hour, minute] = s.split(/[-T:]/).map(Number) as [number, number, number, number, number];
      return ICAL.Time.fromData({ year, month, day, hour, minute, second: 0, isDate: false }, ny.tz);
    };
    // 02:30 on the spring-forward day: ical.js reads it as 06:30Z (01:30 EST), RFC 5545 as 07:30Z (03:30 EDT).
    const gap = at('2027-03-14T02:30:00');
    expect(skippedWall(gap)).toBe(true);
    expect(instantOf(gap, NY).toISOString()).toBe('2027-03-14T06:30:00.000Z');
    expect(rfcInstantOf(gap, NY).toISOString()).toBe('2027-03-14T07:30:00.000Z');
    for (const plain of [at('2027-03-14T03:30:00'), at('2026-11-01T01:30:00'), ICAL.Time.fromString('2027-03-14T02:30:00Z'), ICAL.Time.fromString('2027-03-14T02:30:00'), dateValue('2027-03-14')]) {
      expect(skippedWall(plain)).toBe(false);
      expect(rfcInstantOf(plain, NY).getTime()).toBe(instantOf(plain, NY).getTime());
    }
    // Readers disagree on such a start's instant, so a DTEND could not keep the length for both: DURATION does.
    const ev = newEvent('g', new Date(0));
    setTimeProp(ev, 'dtstart', gap);
    setEnd(ev, gap, 30 * 60_000, ny);
    expect(ev.hasProperty('dtend')).toBe(false);
    expect(String(ev.getFirstPropertyValue('duration'))).toBe('PT30M');
    // An ordinary start gets a DTEND again (and loses the DURATION).
    setTimeProp(ev, 'dtstart', at('2027-03-15T02:30:00'));
    setEnd(ev, at('2027-03-15T02:30:00'), 30 * 60_000, ny);
    expect(ev.hasProperty('duration')).toBe(false);
    expect(String(ev.getFirstPropertyValue('dtend'))).toBe('2027-03-15T03:00:00');
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

describe('serializeForWrite', () => {
  const build = (edit: (ev: Component) => void): Component => {
    const vcal = newCalendar();
    const ev = newEvent('U1', new Date('2026-10-20T16:00:00Z'));
    vcal.addSubcomponent(ev);
    setTimeProp(ev, 'dtstart', timeAt(new Date('2026-10-20T13:00:00Z'), zoneForWrite(vcal, NY)));
    edit(ev);
    return vcal;
  };

  it('returns the serialized text when it reads back as the same event', () => {
    const vcal = build((ev) => {
      setTextProp(ev, 'summary', 'Lunch');
      setTextProp(ev, 'description', 'line one\r\nline two\rline three');
      setTextProp(ev, 'url', 'https://x.test/a?b=c');
      ensureOrganizer(ev, 'me@icloud.com');
      setAttendees(ev, [{ email: 'ann@x.com', name: 'Ann' }], new Set());
    });
    expect(serializeForWrite(vcal)).toBe(serialize(vcal));
    // CR / CRLF in a text value is stored as an (escaped) LF, never as a raw CR.
    expect(serialize(vcal)).toContain('DESCRIPTION:line one\\nline two\\nline three');
  });

  it('stores a U+2028 / U+2029 separator in a text value as an escaped LF too (ical.js would write it raw)', () => {
    const vcal = build((ev) => setTextProp(ev, 'description', 'one\u2028two\u2029three'));
    const text = serializeForWrite(vcal);
    expect(text).toContain('DESCRIPTION:one\\ntwo\\nthree');
    expect(text).not.toMatch(/[\u2028\u2029]/);
  });

  it('refuses text in which a value would start another property: an injected ATTENDEE is an email iCloud sends', () => {
    const raw = (value: string) => build((ev) => ev.updatePropertyWithValue('url', value));
    const injected = raw('https://x.test/\r\nATTENDEE;RSVP=TRUE:mailto:victim@x.com');
    // ical.js writes a URI value unescaped: the text really does carry a second property.
    expect(serialize(injected)).toContain('\r\nATTENDEE;RSVP=TRUE:mailto:victim@x.com');
    expect(() => serializeForWrite(injected)).toThrow(InvalidArgumentError);
    expect(() => serializeForWrite(injected)).toThrow(/would change the event's structure .* Nothing was written/);
    // A replaced organizer, a second event, and a line that breaks the parse are all refused the same way.
    const organizer = build((ev) => ensureOrganizer(ev, 'me@icloud.com\r\nORGANIZER:mailto:boss@x.com'));
    expect(() => serializeForWrite(organizer)).toThrow(InvalidArgumentError);
    expect(() => serializeForWrite(raw('https://x.test/\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:evil'))).toThrow(InvalidArgumentError);
    expect(() => serializeForWrite(raw('https://x.test/\r\nnot a property'))).toThrow(InvalidArgumentError);
    // Through setTextProp a CRLF becomes a bare LF, which is refused as a line break inside a line.
    const viaSetter = build((ev) => setTextProp(ev, 'url', 'https://x.test/\r\nATTENDEE:mailto:victim@x.com'));
    expect(serialize(viaSetter)).toContain('URL:https://x.test/\nATTENDEE');
    expect(() => serializeForWrite(viaSetter)).toThrow(InvalidArgumentError);
  });

  it('refuses a raw CR or LF inside a line (a parser that splits on either would read a new property)', () => {
    const cr = build((ev) => ev.updatePropertyWithValue('summary', 'a\rATTENDEE:mailto:victim@x.com'));
    expect(serialize(cr)).toContain('SUMMARY:a\rATTENDEE');
    expect(() => serializeForWrite(cr)).toThrow(InvalidArgumentError);
    const lf = build((ev) => ev.updatePropertyWithValue('url', 'https://x.test/\nX-A:b'));
    expect(() => serializeForWrite(lf)).toThrow(InvalidArgumentError);
    const cn = build((ev) => setAttendees(ev, [{ email: 'ann@x.com', name: 'Ann\rX' }], new Set()));
    expect(() => serializeForWrite(cn)).toThrow(InvalidArgumentError);
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
    expect(text).toMatch(/^BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-\/\/chrischall\/\/apple-icloud-mcp\/\/EN\r\nCALSCALE:GREGORIAN\r\n/);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(text).toContain('SEQUENCE:0');
    expect(text).toContain('CREATED:20261020T160000Z');
  });
});
