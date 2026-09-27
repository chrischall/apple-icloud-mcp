import { beforeEach, describe, expect, it } from 'vitest';
import { DSID, NY_TZ, harness, ics, vevent, type Harness } from './fake-caldav.js';

let h: Harness;

beforeEach(() => {
  process.env.DISPLAY_TZ = 'America/New_York';
  h = harness();
  h.dav.addCalendar({ id: 'home', name: 'Home', color: '#FF2D55FF', order: 1 }).addCalendar({ id: 'work', name: 'Work', order: 0 });
  h.dav.put(
    'work',
    'standup.ics',
    ics(
      ...NY_TZ,
      ...vevent(
        'UID:standup',
        'DTSTART;TZID=America/New_York:20261019T090000',
        'DTEND;TZID=America/New_York:20261019T091500',
        'RRULE:FREQ=DAILY;COUNT=10',
        'EXDATE;TZID=America/New_York:20261021T090000',
        'SUMMARY:Standup',
      ),
      ...vevent('UID:standup', 'RECURRENCE-ID;TZID=America/New_York:20261022T090000', 'DTSTART;TZID=America/New_York:20261022T140000', 'DTEND;TZID=America/New_York:20261022T141500', 'SUMMARY:Standup (moved)'),
    ),
  );
  h.dav.put('home', 'bday.ics', ics(...vevent('UID:bday', 'DTSTART;VALUE=DATE:20201023', 'DTEND;VALUE=DATE:20201024', 'SUMMARY:Birthday', 'RRULE:FREQ=YEARLY')));
  h.dav.put('home', 'dentist.ics', ics(...vevent('UID:dentist', 'DTSTART:20261021T150000Z', 'DTEND:20261021T160000Z', 'SUMMARY:Dentist', 'LOCATION:Main St', `DESCRIPTION:${'x'.repeat(600)}`)));
});

describe('apple_calendar_list_calendars', () => {
  it('lists event calendars with the default for new events', async () => {
    h.dav.addCalendar({ id: 'todo', name: 'Reminders', comps: ['VTODO'] }).addCalendar({ id: 'sub', name: 'Holidays', extraTypes: '<cs:subscribed/>' });
    const r = await h.call('apple_calendar_list_calendars');
    expect(r.isError).toBe(false);
    expect(r.json).toEqual({
      count: 2,
      defaultForNewEvents: { id: 'work', name: 'Work', reason: expect.stringMatching(/first writable/) },
      notes: [
        '1 task (reminder) list(s) are not event calendars and are not listed.',
        "1 subscribed calendar(s) are not stored on iCloud's calendar server and are not listed.",
      ],
      calendars: [
        { id: 'work', name: 'Work', writable: true },
        { id: 'home', name: 'Home', color: '#FF2D55', writable: true },
      ],
    });
    expect(r.text).not.toContain(DSID);
  });

  it('says so when there is no usable default, or no calendar at all', async () => {
    process.env.ICLOUD_DEFAULT_CALENDAR = 'Nope';
    const r = await h.call('apple_calendar_list_calendars');
    expect(r.json.defaultForNewEvents).toBeUndefined();
    expect(r.json.notes[0]).toMatch(/^No default calendar for new events: ICLOUD_DEFAULT_CALENDAR "Nope"/);
    h.dav.calendars = [];
    const empty = await h.call('apple_calendar_list_calendars');
    expect(empty.json).toMatchObject({ count: 0, calendars: [] });
    expect(empty.json.notes).toContain('This iCloud account has no event calendars.');
  });
});

describe('apple_calendar_list_events', () => {
  it('expands, sorts and pages with the window and paging facts before the data', async () => {
    const r = await h.call('apple_calendar_list_events', { daysAhead: 5, limit: 2 });
    expect(r.isError).toBe(false);
    expect(Object.keys(r.json)).toEqual([
      'returned',
      'total',
      'offset',
      'limit',
      'nextOffset',
      'hasMore',
      'totalMatched',
      'complete',
      'window',
      'calendarsSearched',
      'notes',
      'events',
    ]);
    // complete = every match is in THIS payload; a first page of several is not.
    expect(r.json).toMatchObject({ returned: 2, total: 6, totalMatched: 6, nextOffset: 2, hasMore: true, complete: false, calendarsSearched: ['Work', 'Home'] });
    expect((await h.call('apple_calendar_list_events', { daysAhead: 5 })).json.complete).toBe(true);
    expect(r.json.window).toEqual({
      from: '2026-10-20T00:00:00-04:00',
      fromDisplay: 'Tue, Oct 20, 2026, 12:00 AM EDT',
      to: '2026-10-25T00:00:00-04:00',
      toDisplay: 'Sun, Oct 25, 2026, 12:00 AM EDT',
      timeZone: 'America/New_York',
    });
    expect(r.json.events.map((e: { id: string }) => e.id)).toEqual(['work/standup.ics#occ=2026-10-20T13:00:00Z', 'home/dentist.ics']);
    expect(r.json.events[1]).toMatchObject({ notesTruncated: true, location: 'Main St' });
    expect(r.json.events[1].notes).toHaveLength(500);
    const page2 = await h.call('apple_calendar_list_events', { daysAhead: 5, limit: 10, offset: 2 });
    expect(page2.json.events.map((e: { title: string }) => e.title)).toEqual(['Standup (moved)', 'Birthday', 'Standup', 'Standup']);
    expect(page2.json).toMatchObject({ nextOffset: null, hasMore: false, complete: false });
    expect(page2.json.events[1]).toMatchObject({ isAllDay: true, startDate: '2026-10-23', endDate: '2026-10-23', recurrence: { summary: 'Every year' } });
  });

  it('filters by calendar, shows events in another zone, and states an empty window', async () => {
    const r = await h.call('apple_calendar_list_events', { calendars: ['home'], fromDate: '2026-10-21', toDate: '2026-10-22', timeZone: 'Europe/London' });
    expect(r.json.calendarsSearched).toEqual(['Home']);
    expect(r.json.events.map((e: { title: string; start: string }) => [e.title, e.start])).toEqual([['Dentist', '2026-10-21T16:00:00+01:00']]);
    const none = await h.call('apple_calendar_list_events', { fromDate: '2027-01-05', daysAhead: 1 });
    expect(none.json).toMatchObject({ returned: 0, total: 0, events: [] });
    expect(none.json.notes).toEqual([
      'No events in Tue, Jan 5, 2027, 12:00 AM EST – Wed, Jan 6, 2027, 12:00 AM EST in "Work", "Home".',
      'Only Tue, Jan 5, 2027, 12:00 AM EST – Wed, Jan 6, 2027, 12:00 AM EST was searched; nothing outside that window was examined.',
    ]);
  });

  it('refuses bad arguments rather than guessing', async () => {
    const past = await h.call('apple_calendar_list_events', { daysAhead: 5, offset: 6 });
    expect(past.isError).toBe(true);
    expect(past.json.error).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/valid offsets 0–5/) });
    const both = await h.call('apple_calendar_list_events', { toDate: '2026-11-01', daysAhead: 3 });
    expect(both.json.error.message).toMatch(/not both/);
    const long = await h.call('apple_calendar_list_events', { fromDate: '2026-01-01', toDate: '2027-01-03' });
    expect(long.json.error.message).toMatch(/366-day maximum/);
    const zone = await h.call('apple_calendar_list_events', { timeZone: 'EST' });
    expect(zone.isError).toBe(false);
    const badZone = await h.call('apple_calendar_list_events', { timeZone: 'Mars/Base' });
    expect(badZone.json.error.code).toBe('INVALID_ARGUMENT');
    const cal = await h.call('apple_calendar_list_events', { calendars: ['Nope'] });
    expect(cal.json.error.message).toMatch(/calendars entry "Nope" is not one of your event calendars/);
  });

  it('reports a failed calendar loudly and the answer as incomplete', async () => {
    h.dav.hooks.push((m, url) => (m === 'REPORT' && url.includes('/home/') ? { status: 500, body: 'boom' } : undefined));
    const r = await h.call('apple_calendar_list_events', { daysAhead: 5 });
    expect(r.json.complete).toBe(false);
    expect(r.json.failedCalendars).toEqual([{ calendar: 'Home', error: expect.stringMatching(/HTTP 500/) }]);
    expect(r.json.notes[0]).toMatch(/Calendar "Home" could not be searched/);
    expect(r.json.events.every((e: { calendar: string }) => e.calendar === 'Work')).toBe(true);
  });

  it('works for an account with no calendars (and says what it searched)', async () => {
    h.dav.calendars = [];
    const r = await h.call('apple_calendar_list_events', {});
    expect(r.json.notes[0]).toMatch(/in \(no calendars\)\.$/);
  });

  it('surfaces a missing configuration as an error, never an empty list', async () => {
    const bare = harness({ deps: { context: async () => (await import('../../src/calendar/caldav.js')).defaultContext() } });
    const r = await bare.call('apple_calendar_list_events', {});
    expect(r.isError).toBe(true);
    expect(r.json.error).toMatchObject({ code: 'NOT_CONFIGURED', missing: ['ICLOUD_USERNAME', 'ICLOUD_APP_PASSWORD'] });
  });
});

describe('apple_calendar_search_events', () => {
  it('matches title, location or notes case-insensitively within the (default 30-day) window', async () => {
    const r = await h.call('apple_calendar_search_events', { query: 'main st' });
    expect(r.json.events.map((e: { title: string }) => e.title)).toEqual(['Dentist']);
    expect(r.json.window.to).toBe('2026-11-19T00:00:00-05:00');
    const standups = await h.call('apple_calendar_search_events', { query: 'STANDUP', limit: 3 });
    expect(standups.json).toMatchObject({ total: 8, returned: 3, limit: 3 });
    const none = await h.call('apple_calendar_search_events', { query: 'zebra', fromDate: '2025-01-01', daysAhead: 10 });
    expect(none.json.notes[0]).toMatch(/^No events matching "zebra" \(title, location or notes\) in Wed, Jan 1, 2025/);
  });
});

describe('apple_calendar_get_event', () => {
  it('returns one occurrence in full, and the raw iCalendar with account ids redacted', async () => {
    const r = await h.call('apple_calendar_get_event', { eventId: 'home/dentist.ics', includeIcs: true });
    expect(r.json.event.notes).toHaveLength(600);
    expect(r.json.event.notesTruncated).toBeUndefined();
    expect(r.json.notes).toBeUndefined();
    expect(r.json.ics).toContain('SUMMARY:Dentist');
    const moved = await h.call('apple_calendar_get_event', { eventId: 'work/standup.ics#occ=2026-10-22T13:00:00Z' });
    expect(moved.json.event).toMatchObject({ title: 'Standup (moved)', start: '2026-10-22T14:00:00-04:00', occurrenceOf: 'work/standup.ics' });
    expect(moved.json.ics).toBeUndefined();
  });

  it('redacts the account id from the raw iCalendar even where a line fold splits it', async () => {
    // iCloud rewrites the owner's ATTENDEE to a principal path carrying the account id; folded at 75 octets,
    // the id straddles two lines and a scrub of the folded text would miss it.
    const attendee = `ATTENDEE;CN=Johnny Appleseed;CUTYPE=INDIVIDUAL;EMAIL=me@icloud.com;PARTSTAT=ACCEPTED:/${DSID}/principal/`;
    const cut = attendee.indexOf(DSID) + 4;
    const folded = `${attendee.slice(0, cut)}\r\n ${attendee.slice(cut)}`;
    h.dav.put('home', 'mine.ics', ics(...vevent('UID:mine', 'DTSTART:20261021T150000Z', 'DTEND:20261021T160000Z', 'SUMMARY:Mine', folded)));
    const r = await h.call('apple_calendar_get_event', { eventId: 'home/mine.ics', includeIcs: true });
    expect(r.text).not.toContain(DSID);
    expect(r.text).not.toContain(DSID.slice(4));
    expect(r.json.ics).toContain('PARTSTAT=ACCEPTED:/[REDACTED]/principal/');
  });

  it('round-trips ids of a calendar whose id needs escaping (list → get)', async () => {
    h.dav.addCalendar({ id: 'we%ird#cal', name: 'Weird', order: 5 });
    h.dav.put('we%ird#cal', 'odd.ics', ics(...vevent('UID:odd', 'DTSTART:20261021T190000Z', 'DTEND:20261021T200000Z', 'SUMMARY:Odd one')));
    const list = await h.call('apple_calendar_list_events', { calendars: ['Weird'] });
    const [row] = list.json.events;
    expect(row).toMatchObject({ id: 'we%25ird%23cal/odd.ics', calendarId: 'we%25ird%23cal' });
    const got = await h.call('apple_calendar_get_event', { eventId: row.id });
    expect(got.json.event).toMatchObject({ title: 'Odd one', calendar: 'Weird' });
  });

  it('describes a bare series id as the series and says how to get an occurrence', async () => {
    const r = await h.call('apple_calendar_get_event', { eventId: 'work/standup.ics' });
    expect(r.json.event).toMatchObject({ id: 'work/standup.ics', recurring: true, start: '2026-10-19T09:00:00-04:00' });
    expect(r.json.notes[0]).toMatch(/names the whole recurring series/);
  });

  it('refuses unknown ids and occurrences — never a neighbouring one', async () => {
    const gone = await h.call('apple_calendar_get_event', { eventId: 'work/standup.ics#occ=2026-10-21T13:00:00Z' });
    expect(gone.json.error.code).toBe('NOT_FOUND');
    const bad = await h.call('apple_calendar_get_event', { eventId: 'nonsense' });
    expect(bad.json.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('apple_calendar_find_free_time', () => {
  beforeEach(() => {
    h.dav.put('home', 'free.ics', ics(...vevent('UID:f', 'DTSTART:20261021T170000Z', 'DTEND:20261021T180000Z', 'TRANSP:TRANSPARENT', 'SUMMARY:Optional')));
    h.dav.put('home', 'cxl.ics', ics(...vevent('UID:c', 'DTSTART:20261021T180000Z', 'DTEND:20261021T190000Z', 'STATUS:CANCELLED')));
    h.dav.put(
      'home',
      'declined.ics',
      ics(...vevent('UID:d', 'DTSTART:20261021T190000Z', 'DTEND:20261021T200000Z', 'ORGANIZER:mailto:boss@x.com', `ATTENDEE;PARTSTAT=DECLINED;EMAIL=me@icloud.com:/${DSID}/principal/`)),
    );
    h.dav.put(
      'home',
      'accepted.ics',
      ics(...vevent('UID:a', 'DTSTART:20261021T200000Z', 'DTEND:20261021T203000Z', `ATTENDEE:/${DSID}/principal/`, 'ATTENDEE;PARTSTAT=DECLINED:mailto:other@x.com')),
    );
  });

  it('offers working-hour gaps around real busy time from now on', async () => {
    const r = await h.call('apple_calendar_find_free_time', { daysAhead: 2 });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      workday: { start: '09:00', end: '17:00' },
      weekdaysOnly: true,
      includeAllDay: false,
      minDurationMinutes: 30,
      calendarsSearched: ['Work', 'Home'],
      complete: true,
    });
    expect(r.json.days.map((d: { date: string; free: Array<{ start: string; end: string }> }) => [d.date, d.free.map((s) => `${s.start.slice(11, 16)}-${s.end.slice(11, 16)}`)])).toEqual([
      ['2026-10-20', ['12:00-17:00']],
      ['2026-10-21', ['09:00-11:00', '12:00-16:00', '16:30-17:00']],
    ]);
    expect(r.json.busyBlocks).toBe(3); // standup Tue, dentist + accepted Wed (Wed's standup is excluded)
    expect(r.json.freeSlots).toBe(4);
    expect(r.json.freeMinutes).toBe(300 + 120 + 240 + 30);
    expect(r.json.notes).toContain('Times before now are not offered.');
  });

  it('can let all-day events block, include weekends and use other hours', async () => {
    const r = await h.call('apple_calendar_find_free_time', {
      fromDate: '2026-10-23',
      toDate: '2026-10-26',
      includeAllDay: true,
      weekdaysOnly: false,
      workdayStart: '08:00',
      workdayEnd: '12:00',
      minDurationMinutes: 60,
      calendars: ['Home'],
    });
    expect(r.json.days.map((d: { date: string; free: unknown[] }) => [d.date, d.free.length])).toEqual([
      ['2026-10-23', 0],
      ['2026-10-24', 1],
      ['2026-10-25', 1],
    ]);
    expect(r.json.notes).not.toContain('Times before now are not offered.');
    const weekend = await h.call('apple_calendar_find_free_time', { fromDate: '2026-10-24', daysAhead: 2 });
    expect(weekend.json.days).toEqual([]);
    expect(weekend.json.notes).toContain('2 weekend day(s) were skipped (weekdaysOnly).');
    const late = await h.call('apple_calendar_find_free_time', { fromDate: '2026-10-22T18:00', daysAhead: 1 });
    expect(late.json.notes).toContain('1 day(s) are not listed because their working hours fall outside the window or have passed.');
  });

  it('refuses inverted hours, over-long windows and partial data', async () => {
    const hours = await h.call('apple_calendar_find_free_time', { workdayStart: '17:00', workdayEnd: '09:00' });
    expect(hours.json.error.message).toMatch(/workdayEnd must be later than workdayStart/);
    const long = await h.call('apple_calendar_find_free_time', { fromDate: '2026-10-01', toDate: '2026-11-15' });
    expect(long.json.error.message).toMatch(/31-day maximum/);
    h.dav.hooks.push((m, url) => (m === 'REPORT' && url.includes('/home/') ? { status: 500 } : undefined));
    const partial = await h.call('apple_calendar_find_free_time', {});
    expect(partial.isError).toBe(true);
  });
});
