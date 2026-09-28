import { describe, expect, it } from 'vitest';
import { expandSeries, singleOccurrence } from '../../src/calendar/expand.js';
import {
  COMPACT_NOTES_CHARS,
  formatCompactOccurrence,
  formatOccurrence,
  invitationSummary,
  personLabel,
  recurrenceOf,
  timeLabel,
  whenLabel,
} from '../../src/calendar/format.js';
import { dateValue, eventParts, parseCalendar, timeAt, type Component } from '../../src/calendar/ics.js';
import { NY_TZ, ics, vevent } from './fake-caldav.js';

const NY = 'America/New_York';
/** Both zones of a call made without `timeZone`. */
const NYZ = { zone: NY, displayZone: NY };
const CAL = { id: 'home', name: 'Home' };

function master(...lines: string[]): Component {
  return eventParts(parseCalendar(ics(...lines), 't')).master as Component;
}

describe('formatOccurrence', () => {
  it('formats a full timed event with its own zone, people, alarms and stamps', () => {
    const m = master(
      ...vevent(
        'UID:x',
        'DTSTART;TZID=Europe/Berlin:20261020T150000',
        'DTEND;TZID=Europe/Berlin:20261020T160000',
        'SUMMARY:Call',
        'LOCATION:Online',
        'DESCRIPTION:0123456789',
        'URL:https://example.com/x',
        'STATUS:TENTATIVE',
        'TRANSP:TRANSPARENT',
        'ORGANIZER;CN=Boss:mailto:boss@x.com',
        'ATTENDEE;PARTSTAT=ACCEPTED:mailto:a@x.com',
        'LAST-MODIFIED:20261001T120000Z',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER:-PT10M',
        'END:VALARM',
      ),
    );
    const out = formatOccurrence(singleOccurrence(m, NY), { calendar: CAL, baseId: 'home/x.ics', ...NYZ, notesLimit: 4 });
    expect(out).toEqual({
      id: 'home/x.ics',
      calendar: 'Home',
      calendarId: 'home',
      title: 'Call',
      isAllDay: false,
      start: '2026-10-20T09:00:00-04:00',
      startDisplay: 'Tue, Oct 20, 2026, 9:00 AM EDT',
      end: '2026-10-20T10:00:00-04:00',
      endDisplay: 'Tue, Oct 20, 2026, 10:00 AM EDT',
      eventTimeZone: 'Europe/Berlin',
      location: 'Online',
      notes: '0123',
      notesTruncated: true,
      url: 'https://example.com/x',
      status: 'tentative',
      transparency: 'transparent',
      recurring: false,
      organizer: { name: 'Boss', email: 'boss@x.com' },
      attendees: [{ email: 'a@x.com', status: 'accepted' }],
      alarms: [10],
      lastModified: '2026-10-01T08:00:00-04:00',
      lastModifiedDisplay: 'Thu, Oct 1, 2026, 8:00 AM EDT',
    });
    // Full notes when no limit; no eventTimeZone when it is the zone times are shown in.
    const full = formatOccurrence(singleOccurrence(m, 'Europe/Berlin'), { calendar: CAL, baseId: 'home/x.ics', zone: 'Europe/Berlin', displayZone: 'Europe/Berlin' });
    expect(full.notes).toBe('0123456789');
    expect(full.notesTruncated).toBeUndefined();
    expect(full.eventTimeZone).toBeUndefined();
  });

  it('formats a bare all-day occurrence of a recurring series', () => {
    const m = master(...vevent('UID:b', 'DTSTART;VALUE=DATE:20241023', 'RRULE:FREQ=YEARLY;UNTIL=20301023', 'DESCRIPTION:short'));
    const [o] = expandSeries({ master: m, overrides: [] }, { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-11-01T00:00:00Z'), zone: NY }).occurrences;
    expect(formatOccurrence(o!, { calendar: CAL, baseId: 'home/b.ics', ...NYZ, notesLimit: 500 })).toEqual({
      id: 'home/b.ics#occ=2026-10-23',
      calendar: 'Home',
      calendarId: 'home',
      title: '',
      isAllDay: true,
      startDate: '2026-10-23',
      startDateDisplay: 'Fri, Oct 23, 2026',
      endDate: '2026-10-23',
      endDateDisplay: 'Fri, Oct 23, 2026',
      notes: 'short',
      recurring: true,
      recurrence: { rule: 'FREQ=YEARLY;UNTIL=20301023', summary: 'Every year, until Wed, Oct 23, 2030' },
      occurrenceOf: 'home/b.ics',
    });
  });

  it('describes recurrence: until as a time, RDATE-only, and none', () => {
    const withUntil = master(...NY_TZ, ...vevent('UID:u', 'DTSTART;TZID=America/New_York:20261020T090000', 'RRULE:FREQ=WEEKLY;UNTIL=20261231T140000Z'));
    expect(recurrenceOf(withUntil, NYZ)).toEqual({ rule: 'FREQ=WEEKLY;UNTIL=20261231T140000Z', summary: 'Every week, until Thu, Dec 31, 2026, 9:00 AM EST' });
    expect(recurrenceOf(master(...vevent('UID:r', 'DTSTART:20261020T130000Z', 'RDATE:20261022T130000Z')), NYZ)).toEqual({ summary: 'On specific dates (RDATE)' });
    expect(recurrenceOf(master(...vevent('UID:n', 'DTSTART:20261020T130000Z')), NYZ)).toBeUndefined();
    expect(recurrenceOf(master(...vevent('UID:d', 'DTSTART:20261020T130000Z', 'RRULE:FREQ=DAILY')), NYZ)).toEqual({ rule: 'FREQ=DAILY', summary: 'Every day' });
  });
});

describe('the zone times are shown in and the zone floating values are read in', () => {
  const LONDON = { zone: 'Europe/London', displayZone: NY };

  it('reads a floating UNTIL, alert and stamp in DISPLAY_TZ, and shows them in the request\'s zone', () => {
    const m = master(
      ...vevent(
        'UID:f',
        'DTSTART:20261020T090000',
        'DTEND:20261020T100000',
        'RRULE:FREQ=DAILY;UNTIL=20261030T100000',
        'LAST-MODIFIED:20261001T080000',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER;VALUE=DATE-TIME:20261020T084500',
        'END:VALARM',
      ),
    );
    // 10:00 in New York is 14:00Z: 2 PM in London (on GMT again by the 30th).
    expect(timeLabel(m.getFirstPropertyValue('rrule').until, LONDON)).toBe('Fri, Oct 30, 2026, 2:00 PM GMT');
    expect(recurrenceOf(m, LONDON)?.summary).toBe('Every day, until Fri, Oct 30, 2026, 2:00 PM GMT');
    const [o] = expandSeries({ master: m, overrides: [] }, { from: new Date('2026-10-20T00:00:00Z'), to: new Date('2026-10-21T00:00:00Z'), zone: NY, dayZone: 'Europe/London' }).occurrences;
    const out = formatOccurrence(o!, { calendar: CAL, baseId: 'home/f.ics', ...LONDON });
    expect(out).toMatchObject({
      id: 'home/f.ics#occ=2026-10-20T13:00:00Z',
      start: '2026-10-20T14:00:00+01:00',
      // 08:45 in New York, a quarter of an hour before the start (in London's reading it would be 5 hours 15 before).
      alarms: [15],
      lastModified: '2026-10-01T13:00:00+01:00',
    });
    expect(out).not.toHaveProperty('eventTimeZone');
    expect(invitationSummary(o!, LONDON)).toMatchObject({ timeZone: 'Europe/London', repeats: 'Every day, until Fri, Oct 30, 2026, 2:00 PM GMT' });
  });
});

describe('labels', () => {
  it('labels times and spans', () => {
    expect(timeLabel(dateValue('2026-10-20'), NYZ)).toBe('Tue, Oct 20, 2026');
    expect(timeLabel(timeAt(new Date('2026-10-20T13:00:00Z'), { kind: 'utc' }), NYZ)).toBe('Tue, Oct 20, 2026, 9:00 AM EDT');
    const one = singleOccurrence(master(...vevent('UID:a', 'DTSTART;VALUE=DATE:20261020')), NY);
    expect(whenLabel(one, NY)).toBe('Tue, Oct 20, 2026 (all day)');
    const two = singleOccurrence(master(...vevent('UID:a', 'DTSTART;VALUE=DATE:20261020', 'DTEND;VALUE=DATE:20261022')), NY);
    expect(whenLabel(two, NY)).toBe('Tue, Oct 20, 2026 – Wed, Oct 21, 2026 (all day)');
    const timed = singleOccurrence(master(...vevent('UID:a', 'DTSTART:20261020T130000Z', 'DTEND:20261020T140000Z')), NY);
    expect(whenLabel(timed, NY)).toBe('Tue, Oct 20, 2026, 9:00 AM EDT – Tue, Oct 20, 2026, 10:00 AM EDT');
  });
});

describe('formatCompactOccurrence', () => {
  const SELF = new Set(['/123/principal/', 'mailto:me@icloud.com']);

  it('drops the heavy fields, keeps an attendee count and my own reply, and cuts notes to 200 characters', () => {
    const m = master(
      ...NY_TZ,
      ...vevent(
        'UID:x',
        'DTSTART;TZID=America/New_York:20261020T090000',
        'DTEND;TZID=America/New_York:20261020T100000',
        'RRULE:FREQ=WEEKLY;COUNT=5',
        'SUMMARY:Sync',
        'LOCATION:Room 1',
        `DESCRIPTION:${'z'.repeat(300)}`,
        'URL:https://zoom.example/j/1',
        'ORGANIZER;CN=Boss:mailto:boss@x.com',
        'ATTENDEE;PARTSTAT=ACCEPTED:mailto:a@x.com',
        'ATTENDEE;PARTSTAT=TENTATIVE;EMAIL=me@icloud.com:/123/principal/',
        'LAST-MODIFIED:20261001T120000Z',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'TRIGGER:-PT10M',
        'END:VALARM',
      ),
    );
    const [o] = expandSeries({ master: m, overrides: [] }, { from: new Date('2026-10-20T00:00:00Z'), to: new Date('2026-10-21T00:00:00Z'), zone: NY }).occurrences;
    const out = formatCompactOccurrence(o!, { calendar: CAL, baseId: 'home/x.ics', ...NYZ }, SELF);
    expect(out).toEqual({
      id: 'home/x.ics#occ=2026-10-20T13:00:00Z',
      calendar: 'Home',
      calendarId: 'home',
      title: 'Sync',
      isAllDay: false,
      start: '2026-10-20T09:00:00-04:00',
      startDisplay: 'Tue, Oct 20, 2026, 9:00 AM EDT',
      end: '2026-10-20T10:00:00-04:00',
      endDisplay: 'Tue, Oct 20, 2026, 10:00 AM EDT',
      location: 'Room 1',
      notes: 'z'.repeat(COMPACT_NOTES_CHARS),
      notesTruncated: true,
      recurring: true,
      recurrence: { summary: 'Every week, 5 times' },
      occurrenceOf: 'home/x.ics',
      attendeeCount: 2,
      myStatus: 'tentative',
    });
  });

  it('leaves myStatus out when my entry is not recognisable, and says needs-action when I have not replied', () => {
    const lines = ['UID:y', 'DTSTART:20261020T130000Z', 'SUMMARY:Plain'];
    const plain = formatCompactOccurrence(singleOccurrence(master(...vevent(...lines)), NY), { calendar: CAL, baseId: 'home/y.ics', ...NYZ }, SELF);
    expect(plain).not.toHaveProperty('attendeeCount');
    expect(plain).not.toHaveProperty('recurrence');
    const strangers = master(...vevent(...lines, 'ATTENDEE:mailto:a@x.com'));
    expect(formatCompactOccurrence(singleOccurrence(strangers, NY), { calendar: CAL, baseId: 'home/y.ics', ...NYZ }, SELF)).toMatchObject({ attendeeCount: 1 });
    expect(formatCompactOccurrence(singleOccurrence(strangers, NY), { calendar: CAL, baseId: 'home/y.ics', ...NYZ }, SELF)).not.toHaveProperty('myStatus');
    const invited = master(...vevent(...lines, 'ATTENDEE:mailto:ME@icloud.com'));
    expect(formatCompactOccurrence(singleOccurrence(invited, NY), { calendar: CAL, baseId: 'home/y.ics', ...NYZ }, SELF)).toMatchObject({ myStatus: 'needs-action' });
  });
});

describe('invitation previews', () => {
  it('labels people by name and address', () => {
    expect(personLabel({ name: 'Ann', email: 'ann@x.com' })).toBe('Ann <ann@x.com>');
    expect(personLabel({ email: 'ann@x.com' })).toBe('ann@x.com');
    expect(personLabel({ name: 'Ann' })).toBe('Ann');
    expect(personLabel({})).toBe('(no address)');
  });

  it('carries everything the invitation email does: notes in full, url, zone, repeat rule, organizer and attendees', () => {
    const notes = 'n'.repeat(5000);
    const m = master(
      ...vevent(
        'UID:x',
        'DTSTART:20261020T130000Z',
        'DTEND:20261020T140000Z',
        'RRULE:FREQ=DAILY;COUNT=2',
        'SUMMARY:Lunch',
        'LOCATION:Cafe',
        `DESCRIPTION:${notes}`,
        'URL:https://x.test/',
        'ORGANIZER:mailto:me@icloud.com',
        'ATTENDEE;CN=Ann:mailto:ann@x.com',
        'ATTENDEE:mailto:bob@x.com',
      ),
    );
    const o = { ...singleOccurrence(m, NY), master: m, recurring: true };
    expect(invitationSummary(o, NYZ)).toEqual({
      event: 'Lunch',
      when: 'Tue, Oct 20, 2026, 9:00 AM EDT – Tue, Oct 20, 2026, 10:00 AM EDT',
      timeZone: NY,
      location: 'Cafe',
      url: 'https://x.test/',
      notes,
      repeats: 'Every day, 2 times',
      organizer: 'me@icloud.com',
      attendees: 'Ann <ann@x.com>, bob@x.com',
    });
    const allDay = master(...vevent('UID:a', 'DTSTART;VALUE=DATE:20261020'));
    expect(invitationSummary(singleOccurrence(allDay, NY), NYZ)).toEqual({ event: '(untitled)', when: 'Tue, Oct 20, 2026 (all day)' });
  });
});
