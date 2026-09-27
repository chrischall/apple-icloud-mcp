import { beforeEach, describe, expect, it } from 'vitest';
import { NO_ELICIT_CTX, callConfirmed, callPreview, type GatedHandler } from '../tools/_confirm-helpers.js';
import { eventParts, parseCalendar, textProp } from '../../src/calendar/ics.js';
import { DSID, HOME, NY_TZ, harness, ics, vevent, type Harness } from './fake-caldav.js';

let h: Harness;
const gated = (name: string) => h.tools.get(name)!.cb as unknown as GatedHandler;
const json = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);
const unfold = (s: string) => s.replace(/\r\n /g, '');

/** A hook that fires only once a write (PUT/DELETE/MOVE) has happened. */
function afterWrite(fn: (method: string, url: string) => { status: number; body?: string } | undefined) {
  let wrote = false;
  h.dav.hooks.push((method, url) => {
    if (['PUT', 'DELETE', 'MOVE'].includes(method)) {
      wrote = true;
      return undefined;
    }
    return wrote ? fn(method, url) : undefined;
  });
}

beforeEach(() => {
  process.env.DISPLAY_TZ = 'America/New_York';
  h = harness();
  h.dav.addCalendar({ id: 'home', name: 'Home', order: 1 }).addCalendar({ id: 'work', name: 'Work', order: 0 }).addCalendar({ id: 'ro', name: 'Shared', privileges: ['read'], order: 2 });
});

describe('apple_calendar_create_event', () => {
  it('creates a timed event (default 1 hour, zone written with its VTIMEZONE) and verifies it', async () => {
    const r = await h.call('apple_calendar_create_event', { title: 'Lunch', startDate: '2026-10-22T12:30', alarms: [10], location: 'Cafe', url: 'https://x.test/' });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ created: true, verified: true, eventId: 'work/UID-1.ics' });
    expect(r.json.notes).toEqual(['Calendar: "Work" (the first writable calendar not shared with other people (set ICLOUD_DEFAULT_CALENDAR or pass calendar to choose)).']);
    expect(r.json.event).toMatchObject({ title: 'Lunch', start: '2026-10-22T12:30:00-04:00', end: '2026-10-22T13:30:00-04:00', recurring: false, alarms: [10], location: 'Cafe' });
    const stored = unfold(h.dav.get('work', 'UID-1.ics')!.ics);
    expect(stored).toContain('DTSTART;TZID=America/New_York:20261022T123000');
    expect(stored.indexOf('BEGIN:VTIMEZONE')).toBeLessThan(stored.indexOf('BEGIN:VEVENT'));
    const put = h.dav.requests.find((q) => q.method === 'PUT')!;
    expect(put.headers['if-none-match']).toBe('*');
    expect(put.headers['content-type']).toBe('text/calendar; charset=utf-8');
  });

  it('creates an all-day recurring event in a named calendar', async () => {
    const r = await h.call('apple_calendar_create_event', {
      calendar: 'home',
      title: 'Trip',
      startDate: '2026-11-02',
      endDate: '2026-11-03',
      recurrence: { frequency: 'weekly', byWeekday: ['MO'], until: '2026-12-31' },
    });
    expect(r.json.event).toMatchObject({ isAllDay: true, startDate: '2026-11-02', endDate: '2026-11-03', recurring: true, recurrence: { rule: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231' } });
    expect(r.json.notes).toEqual(['Calendar: "Home" (named in the request).', 'This id names the whole series; list the events to get the id of one occurrence.']);
    expect(h.dav.get('home', 'UID-1.ics')!.ics).toContain('DTEND;VALUE=DATE:20261104');
  });

  it('writes UNTIL in UTC for timed series: through the end of a bare date, or an exact time', async () => {
    const a = await h.call('apple_calendar_create_event', { title: 'A', startDate: '2026-10-22T09:00', recurrence: { frequency: 'daily', until: '2026-10-25' } });
    expect(a.json.event.recurrence.rule).toBe('FREQ=DAILY;UNTIL=20261026T035959Z');
    const b = await h.call('apple_calendar_create_event', { title: 'B', startDate: '2026-10-22T09:00', recurrence: { frequency: 'daily', interval: 2, until: '2026-10-30T09:00Z' } });
    expect(b.json.event.recurrence.rule).toBe('FREQ=DAILY;INTERVAL=2;UNTIL=20261030T090000Z');
    const c = await h.call('apple_calendar_create_event', { title: 'C', startDate: '2026-10-22', isAllDay: false, recurrence: { frequency: 'monthly', count: 3 } });
    expect(c.json.event).toMatchObject({ start: '2026-10-22T00:00:00-04:00', end: '2026-10-22T01:00:00-04:00', recurrence: { summary: 'Every month, 3 times' } });
  });

  it('refuses impossible times and calendars before writing anything', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ startDate: '2026-10-22T09:00', isAllDay: true }, /has a time of day, but an all-day event takes a date/],
      [{ startDate: '2026-10-22', endDate: '2026-10-23T10:00' }, /endDate .* has a time of day/],
      [{ startDate: '2026-10-22', endDate: '2026-10-21' }, /is before startDate/],
      [{ startDate: '2026-10-22T09:00', endDate: '2026-10-22T09:00' }, /must be after startDate/],
      [{ startDate: '2026-10-22', recurrence: { frequency: 'daily', until: '2026-10-21' } }, /before the event's first day/],
      [{ startDate: '2026-10-22T09:00', recurrence: { frequency: 'daily', until: '2026-10-22T08:00' } }, /before the event starts/],
      [{ startDate: '22/10/2026' }, /startDate "22\/10\/2026" is not a valid date/],
      [{ startDate: '2026-10-22T09:00', calendar: 'Shared' }, /"Shared" is read-only/],
      [{ startDate: '2026-10-22T09:00', calendar: 'Nope' }, /calendar "Nope" is not one of your event calendars/],
      // The start is always the first occurrence (RFC 5545): one off the rule's weekdays would be a stray extra.
      [{ startDate: '2026-10-22T09:00', recurrence: { frequency: 'weekly', byWeekday: ['MO', 'WE'] } }, /startDate 2026-10-22 is a Thu, which is not one of recurrence\.byWeekday \(MO, WE\)/],
      [{ startDate: '2026-10-24', recurrence: { frequency: 'monthly', byWeekday: ['MO'] } }, /startDate 2026-10-24 is a Sat/],
    ];
    for (const [args, message] of cases) {
      const r = await h.call('apple_calendar_create_event', { title: 'X', ...args });
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.json.error.message).toMatch(message);
    }
    expect(h.dav.writes()).toEqual([]);
  });

  it('checks the start against byWeekday on the calendar date in the zone, not in UTC', async () => {
    // 02:00Z on Thursday is still Wednesday evening in New York.
    const r = await h.call('apple_calendar_create_event', { title: 'W', startDate: '2026-10-22T02:00:00Z', recurrence: { frequency: 'weekly', byWeekday: ['WE'] } });
    expect(r.json).toMatchObject({ created: true, event: { start: '2026-10-21T22:00:00-04:00', recurrence: { rule: 'FREQ=WEEKLY;BYDAY=WE' } } });
  });

  it('with attendees: asks first (iCloud emails invitations), then writes ORGANIZER + ATTENDEEs', async () => {
    const args = { title: 'Party', startDate: '2026-10-24T18:00', location: '', attendees: [{ email: 'ann@x.com', name: 'Ann' }, { email: 'bob@x.com' }] };
    const preview = await callPreview(gated('apple_calendar_create_event'), args);
    expect(preview.preview).toEqual({
      event: 'Party',
      when: 'Sat, Oct 24, 2026, 6:00 PM EDT – Sat, Oct 24, 2026, 7:00 PM EDT',
      timeZone: 'America/New_York',
      organizer: 'me@icloud.com',
      attendees: 'Ann <ann@x.com>, bob@x.com',
      calendar: 'Work',
      notice: 'iCloud will email each attendee an invitation — with everything above — as soon as the event is saved.',
    });
    expect(h.dav.writes()).toEqual([]);
    const done = json(await callConfirmed(gated('apple_calendar_create_event'), args));
    expect(done).toMatchObject({ created: true, verified: true });
    expect(done.notes).toContain("iCloud sends the invitations itself; each attendee's reply shows up in their status on this event.");
    // callConfirmed previews again first, so the confirmed call is the third to mint a UID.
    const stored = unfold(h.dav.get('work', 'UID-3.ics')!.ics);
    expect(stored).toContain('ORGANIZER:mailto:me@icloud.com');
    expect(stored).toContain('ATTENDEE;CN=Ann;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:ann@x.com');
  });

  it('with attendees and a repeat rule, the preview says how it repeats', async () => {
    const preview = await callPreview(gated('apple_calendar_create_event'), {
      title: 'Sync',
      startDate: '2026-10-26T10:00',
      location: 'Room 1',
      recurrence: { frequency: 'weekly' },
      attendees: [{ email: 'ann@x.com' }],
    });
    expect(preview.preview).toMatchObject({ location: 'Room 1', repeats: 'Every week' });
  });

  it('with attendees, the preview shows EVERYTHING the invitation carries: the whole notes and the url', async () => {
    const notes = `Agenda: ${'private detail '.repeat(300)}`.trim();
    const args = { title: 'Lunch with Sam', startDate: '2026-10-27T12:30', notes, url: 'https://evil.example/?d=SECRET', attendees: [{ email: 'sam@x.com' }] };
    const preview = await callPreview(gated('apple_calendar_create_event'), args);
    expect(preview.preview).toMatchObject({ notes, url: 'https://evil.example/?d=SECRET', attendees: 'sam@x.com', organizer: 'me@icloud.com' });
    expect((preview.preview.notes as string).length).toBe(notes.length);
  });

  it('stores notes line breaks as line breaks (CRLF and CR as LF), never as a raw CR', async () => {
    await h.call('apple_calendar_create_event', { title: 'N', startDate: '2026-10-24T18:00', notes: 'one\r\ntwo\rthree\nfour' });
    const stored = h.dav.get('work', 'UID-1.ics')!.ics;
    expect(unfold(stored)).toContain('DESCRIPTION:one\\ntwo\\nthree\\nfour\r\n');
    expect(stored).not.toMatch(/\r(?!\n)/);
    expect((await h.call('apple_calendar_get_event', { eventId: 'work/UID-1.ics' })).json.event.notes).toBe('one\ntwo\nthree\nfour');
  });

  it('refuses a value that would inject iCalendar lines — even past the schema — before any write or confirmation', async () => {
    // The handler is called directly here, WITHOUT the schema (which refuses these first): this is the second line.
    process.env.APPLE_WRITE_MODE = 'additive';
    const inject = 'https://x.test/\r\nORGANIZER:mailto:me@icloud.com\r\nATTENDEE;RSVP=TRUE:mailto:victim@x.com';
    const viaUrl = await h.call('apple_calendar_create_event', { title: 'Reminder', startDate: '2026-10-24T18:00', url: inject });
    expect(viaUrl.json.error).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/would change the event's structure/) });
    expect(h.dav.writes()).toEqual([]);
    // A CR in a TEXT value is stored as an escaped line break: it stays inside the title and cannot start a property.
    const viaTitle = await h.call('apple_calendar_create_event', { title: 'Reminder\rATTENDEE:mailto:victim@x.com', startDate: '2026-10-24T18:00' });
    expect(viaTitle.json).toMatchObject({ created: true, event: { title: 'Reminder\nATTENDEE:mailto:victim@x.com' } });
    const stored = h.dav.get('work', 'UID-2.ics')!.ics;
    expect(stored).toContain('SUMMARY:Reminder\\nATTENDEE:mailto:victim@x.com');
    expect(stored).not.toMatch(/^ATTENDEE/m);
    expect(stored).not.toMatch(/\r(?!\n)/);
    h.dav.resources.clear();
    h.dav.requests = [];
    process.env.APPLE_WRITE_MODE = 'all';
    // With real attendees the refusal comes before the confirm gate: the gate would have shown only the real ones.
    const gated = await h.call('apple_calendar_create_event', { title: 'P', startDate: '2026-10-24T18:00', url: inject, attendees: [{ email: 'ann@x.com' }] }, NO_ELICIT_CTX);
    expect(gated.json.error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    const viaName = await h.call('apple_calendar_create_event', { title: 'P', startDate: '2026-10-24T18:00', attendees: [{ email: 'ann@x.com', name: 'Ann\rATTENDEE:mailto:v@x.com' }] }, NO_ELICIT_CTX);
    expect(viaName.json.error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(h.dav.writes()).toEqual([]);
  });

  it('writes a mis-cased timeZone as its real zone (TZID + VTIMEZONE), so a series follows DST', async () => {
    const r = await h.call('apple_calendar_create_event', { title: 'Standup', startDate: '2026-10-22T09:00', timeZone: 'america/new_york', recurrence: { frequency: 'weekly', count: 4 } });
    expect(r.json).toMatchObject({ created: true, verified: true });
    const stored = unfold(h.dav.get('work', 'UID-1.ics')!.ics);
    expect(stored).toContain('DTSTART;TZID=America/New_York:20261022T090000');
    expect(stored).toContain('TZID:America/New_York');
    const list = await h.call('apple_calendar_list_events', { fromDate: '2026-10-22', daysAhead: 21, timeZone: 'AMERICA/NEW_YORK' });
    expect(list.json.window.timeZone).toBe('America/New_York');
    expect(list.json.events.map((e: { start: string }) => e.start)).toEqual([
      '2026-10-22T09:00:00-04:00',
      '2026-10-29T09:00:00-04:00',
      '2026-11-05T09:00:00-05:00',
    ]);
  });

  it('names a shared target calendar, prefers one nobody else sees by default, and refuses shared ones in additive mode', async () => {
    h.dav.calendars = [
      { id: 'fam', name: 'Family (shared by Mom)', order: 0, extraTypes: '<cs:shared/>' },
      { id: 'team', name: 'Team', order: 1, extraTypes: '<cs:shared-owner/>' },
      { id: 'home', name: 'Home', order: 2 },
    ];
    const byDefault = await h.call('apple_calendar_create_event', { title: 'Therapy', startDate: '2026-10-27T12:30' });
    expect(byDefault.json).toMatchObject({ created: true, eventId: 'home/UID-1.ics' });
    expect(byDefault.json.notes).toEqual(['Calendar: "Home" (the first writable calendar not shared with other people (set ICLOUD_DEFAULT_CALENDAR or pass calendar to choose)).']);
    const named = await h.call('apple_calendar_create_event', { title: 'Dinner', startDate: '2026-10-27T18:30', calendar: 'Family (shared by Mom)' });
    expect(named.json.notes).toContain('"Family (shared by Mom)" is shared with you by someone else: everyone it is shared with sees the events in it.');
    const preview = await callPreview(gated('apple_calendar_create_event'), { title: 'Sync', startDate: '2026-10-27T10:00', calendar: 'team', attendees: [{ email: 'ann@x.com' }] });
    expect(preview.preview).toMatchObject({ calendar: 'Team', calendarShared: '"Team" is a calendar you share with other people: they see the events in it.' });

    process.env.APPLE_WRITE_MODE = 'additive';
    const before = h.dav.writes().length;
    for (const calendar of ['Family (shared by Mom)', 'Team']) {
      const r = await h.call('apple_calendar_create_event', { title: 'X', startDate: '2026-10-27T18:30', calendar });
      expect(r.json.error, calendar).toMatchObject({ code: 'UNSUPPORTED', message: expect.stringMatching(/APPLE_WRITE_MODE=additive never allows\. Nothing was created\.$/) });
    }
    // When every writable calendar is shared, the default is one of them — and additive mode refuses it too.
    h.dav.calendars = h.dav.calendars.filter((c) => c.id !== 'home');
    const onlyShared = await h.call('apple_calendar_create_event', { title: 'X', startDate: '2026-10-27T18:30' });
    expect(onlyShared.json.error.message).toMatch(/^"Family \(shared by Mom\)" is shared with you/);
    expect(h.dav.writes().length).toBe(before);
    h.dav.calendars.push({ id: 'home', name: 'Home', order: 2 });
    expect((await h.call('apple_calendar_create_event', { title: 'Mine', startDate: '2026-10-27T18:30' })).json.eventId).toMatch(/^home\//);
  });

  it('falls back from an ICLOUD_DEFAULT_CALENDAR this account does not have, with a warning', async () => {
    process.env.ICLOUD_DEFAULT_CALENDAR = 'Someone else\'s';
    const r = await h.call('apple_calendar_create_event', { title: 'T', startDate: '2026-10-27T18:30' });
    expect(r.json).toMatchObject({ created: true, verified: true, eventId: 'work/UID-1.ics' });
    expect(r.json.warnings).toEqual(['ICLOUD_DEFAULT_CALENDAR "Someone else\'s" is not one of this account\'s event calendars, so the automatic default "Work" is used instead.']);
    process.env.ICLOUD_DEFAULT_CALENDAR = 'home';
    expect((await h.call('apple_calendar_create_event', { title: 'T', startDate: '2026-10-27T18:30' })).json).toMatchObject({ eventId: 'home/UID-2.ics', notes: ['Calendar: "Home" (ICLOUD_DEFAULT_CALENDAR).'] });
  });

  it('never sends invitations in APPLE_WRITE_MODE=additive', async () => {
    process.env.APPLE_WRITE_MODE = 'additive';
    const r = await h.call('apple_calendar_create_event', { title: 'P', startDate: '2026-10-24T18:00', attendees: [{ email: 'ann@x.com' }] });
    expect(r.json.error).toMatchObject({ code: 'UNSUPPORTED', message: expect.stringMatching(/APPLE_WRITE_MODE=additive never allows/) });
    const plain = await h.call('apple_calendar_create_event', { title: 'P', startDate: '2026-10-24T18:00', attendees: [] });
    expect(plain.json.created).toBe(true);
  });

  it('reports an unverifiable create honestly', async () => {
    afterWrite((m) => (m === 'GET' ? { status: 404 } : undefined));
    const notYet = await h.call('apple_calendar_create_event', { title: 'Lag', startDate: '2026-10-24T18:00' });
    expect(notYet.json).toMatchObject({ created: true, verified: false, warnings: [expect.stringMatching(/not visible on a re-read yet/)] });
    expect(notYet.json.event.title).toBe('Lag');
    h.dav.hooks = [];
    afterWrite((m) => (m === 'GET' ? { status: 400, body: 'odd' } : undefined));
    const failed = await h.call('apple_calendar_create_event', { title: 'Odd', startDate: '2026-10-24T18:00' });
    expect(failed.json.warnings[0]).toMatch(/re-reading it to verify failed \(.*HTTP 400/);
    h.dav.hooks = [];
    afterWrite((m) =>
      m === 'GET' ? { status: 200, body: ics(...vevent('UID:x', 'DTSTART:20261024T220000Z', 'DTEND:20261024T230000Z', 'SUMMARY:Renamed by the server')) } : undefined,
    );
    const drift = await h.call('apple_calendar_create_event', { title: 'Mine', startDate: '2026-10-24T18:00' });
    expect(drift.json.verified).toBe(false);
    expect(drift.json.warnings).toEqual(['title reads back as "Renamed by the server", not "Mine" as written.']);
    h.dav.hooks = [];
    afterWrite((m) => (m === 'GET' ? { status: 200, body: ics('BEGIN:VTODO', 'END:VTODO') } : undefined));
    const empty = await h.call('apple_calendar_create_event', { title: 'T', startDate: '2026-10-24T18:00' });
    expect(empty.json.warnings[0]).toMatch(/changed occurrence is not visible/);
  });

  it('turns write failures into precise errors', async () => {
    h.dav.hooks.push((m) => (m === 'PUT' ? { status: 412 } : undefined));
    const exists = await h.call('apple_calendar_create_event', { title: 'X', startDate: '2026-10-24T18:00' });
    expect(exists.json.error).toMatchObject({ code: 'UPSTREAM_ERROR', status: 412, message: expect.stringMatching(/already exists/) });
    h.dav.hooks = [(m) => (m === 'PUT' ? { status: 503 } : undefined)];
    const unknown = await h.call('apple_calendar_create_event', { title: 'X', startDate: '2026-10-24T18:00' });
    expect(unknown.json.error).toMatchObject({ code: 'UNCONFIRMED_WRITE' });
    expect(unknown.text).not.toContain(DSID);
  });
});

// ---------------------------------------------------------------------------

function seed(): void {
  h.dav.put('home', 'one.ics', ics(...vevent('UID:one', 'DTSTART:20261021T130000Z', 'DTEND:20261021T140000Z', 'SUMMARY:One', 'LOCATION:Old')));
  h.dav.put(
    'work',
    's.ics',
    ics(
      ...NY_TZ,
      ...vevent('UID:s', 'DTSTART;TZID=America/New_York:20261019T090000', 'DTEND;TZID=America/New_York:20261019T091500', 'RRULE:FREQ=DAILY;COUNT=10', 'SUMMARY:Standup'),
    ),
  );
  h.dav.put(
    'home',
    'meet.ics',
    ics(
      ...vevent(
        'UID:meet',
        'DTSTART:20261023T140000Z',
        'DTEND:20261023T150000Z',
        'SUMMARY:Review',
        'ORGANIZER:mailto:me@icloud.com',
        'ATTENDEE;CN=Ann;PARTSTAT=ACCEPTED:mailto:ann@x.com',
        'ATTENDEE:mailto:bob@x.com',
        'ATTENDEE:urn:uuid:someone',
      ),
    ),
  );
}

describe('apple_calendar_update_event', () => {
  beforeEach(seed);

  it('updates a plain event in place with If-Match and returns before/after', async () => {
    const r = await h.call('apple_calendar_update_event', { eventId: 'home/one.ics', title: 'Uno', location: '', startDate: '2026-10-21T10:00' });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ updated: true, verified: true, applied: 'this event', eventId: 'home/one.ics' });
    expect(r.json.changes).toEqual({
      title: { before: 'One', after: 'Uno' },
      location: { before: 'Old', after: null },
      start: { before: '2026-10-21T09:00:00-04:00', after: '2026-10-21T10:00:00-04:00' },
      end: { before: '2026-10-21T10:00:00-04:00', after: '2026-10-21T11:00:00-04:00' },
    });
    const put = h.dav.requests.find((q) => q.method === 'PUT')!;
    expect(put.headers['if-match']).toBe('"e1"');
    expect(h.dav.get('home', 'one.ics')!.ics).toContain('SEQUENCE:1');
  });

  it('asks first when the event has attendees, listing them and the whole event as they will receive it', async () => {
    const preview = await callPreview(gated('apple_calendar_update_event'), { eventId: 'home/meet.ics', title: 'Review v2' });
    expect(preview.preview).toEqual({
      event: 'Review',
      when: 'Fri, Oct 23, 2026, 10:00 AM EDT – Fri, Oct 23, 2026, 11:00 AM EDT',
      calendar: 'Home',
      applies: 'this event',
      changes: ['title: "Review" → "Review v2"'],
      attendees: 'Ann <ann@x.com>, bob@x.com, (no address)',
      sentToAttendees: {
        event: 'Review v2',
        when: 'Fri, Oct 23, 2026, 10:00 AM EDT – Fri, Oct 23, 2026, 11:00 AM EDT',
        timeZone: 'America/New_York',
        organizer: 'me@icloud.com',
        attendees: 'Ann <ann@x.com>, bob@x.com, (no address)',
      },
      notice: 'iCloud will email the attendees about this change, with the event as shown in sentToAttendees.',
    });
    expect(h.dav.writes()).toEqual([]);
    const done = json(await callConfirmed(gated('apple_calendar_update_event'), { eventId: 'home/meet.ics', title: 'Review v2' }));
    expect(done).toMatchObject({ updated: true, verified: true, event: { title: 'Review v2' } });
  });

  it('replacing attendees reads the account identity and keeps existing replies', async () => {
    const args = { eventId: 'home/one.ics', attendees: [{ email: 'cy@x.com', name: 'Cy' }] };
    const preview = await callPreview(gated('apple_calendar_update_event'), args);
    expect(preview.preview.attendees).toBe('Cy <cy@x.com>');
    const done = json(await callConfirmed(gated('apple_calendar_update_event'), args));
    expect(done.changes.attendees).toEqual({ before: null, after: [{ name: 'Cy', email: 'cy@x.com', status: 'needs-action', role: 'required' }] });
    expect(h.dav.get('home', 'one.ics')!.ics).toContain('ORGANIZER:mailto:me@icloud.com');
    expect(h.dav.requests.some((q) => q.method === 'PROPFIND' && q.body.includes('calendar-user-address-set'))).toBe(true);
    // Clearing them: the preview shows who is being removed (they get a cancellation).
    const clear = await callPreview(gated('apple_calendar_update_event'), { eventId: 'home/meet.ics', attendees: [] });
    expect(clear.preview.attendees).toBe('Ann <ann@x.com>, bob@x.com, (no address)');
    expect((clear.preview.sentToAttendees as Record<string, unknown>).attendees).toBeUndefined();
    // Replacing some: everyone emailed — the new list, then those it drops.
    const swap = await callPreview(gated('apple_calendar_update_event'), { eventId: 'home/meet.ics', attendees: [{ email: 'ann@x.com' }, { email: 'di@x.com' }] });
    expect(swap.preview.attendees).toBe('Ann <ann@x.com>, di@x.com, bob@x.com, (no address)');
  });

  it('inviting people to an event that already has notes and a link shows them — the new invitees receive both', async () => {
    h.dav.put('home', 'notes.ics', ics(...vevent('UID:n', 'DTSTART:20261023T140000Z', 'DTEND:20261023T150000Z', 'SUMMARY:Plan', 'DESCRIPTION:layoffs list', 'URL:https://intra.example/doc')));
    const p = await callPreview(gated('apple_calendar_update_event'), { eventId: 'home/notes.ics', attendees: [{ email: 'sam@x.com' }] });
    expect(p.preview.changes).toEqual(['attendees: null → [{"email":"sam@x.com","status":"needs-action","role":"required"}]']);
    expect(p.preview.sentToAttendees).toMatchObject({ event: 'Plan', notes: 'layoffs list', url: 'https://intra.example/doc', attendees: 'sam@x.com', organizer: 'me@icloud.com' });
  });

  it('refuses a value that would inject iCalendar lines on every update path — before any write', async () => {
    // Called without the schema (which refuses these first): the checked serializer is the second line.
    const url = 'https://x.test/\r\nORGANIZER:mailto:me@icloud.com\r\nATTENDEE:mailto:victim@x.com';
    const cases: Array<Record<string, unknown>> = [
      { eventId: 'home/one.ics', url }, // a plain event (no attendees: no confirm gate at all)
      { eventId: 'work/s.ics#occ=2026-10-22T13:00:00Z', url }, // one occurrence → a new override
      { eventId: 'work/s.ics', span: 'allEvents', url }, // the whole series
      { eventId: 'work/s.ics#occ=2026-10-23T13:00:00Z', span: 'futureEvents', url }, // a split: both halves are checked
      { eventId: 'home/one.ics', calendar: 'Work', url }, // a move plus a change
      { eventId: 'home/one.ics', attendees: [{ email: 'ann@x.com', name: 'Ann\rATTENDEE:mailto:victim@x.com' }] }, // a raw CR in a CN parameter
    ];
    for (const args of cases) {
      const r = await h.call('apple_calendar_update_event', args);
      expect(r.json.error, JSON.stringify(args)).toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringMatching(/Nothing was written/) });
    }
    expect(h.dav.writes()).toEqual([]);
  });

  it('refuses to rewrite an event that ALREADY holds a raw CR in a value, and says the stored event may be the cause', async () => {
    // Written by another app: the request itself is clean, so the error must not send the caller hunting through it.
    h.dav.put('home', 'cr.ics', ics(...vevent('UID:cr', 'DTSTART:20261023T140000Z', 'DTEND:20261023T150000Z', 'SUMMARY:Has\rCR')));
    const r = await h.call('apple_calendar_update_event', { eventId: 'home/cr.ics', location: 'Room 1' });
    expect(r.json.error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringMatching(/or one already stored in the event.*Nothing was written\.$/),
      hint: expect.stringMatching(/the stored event already holds one/),
    });
    expect(h.dav.writes()).toEqual([]);
  });

  it('keeps a series in its zone when timeZone is mis-cased (never rewritten as UTC)', async () => {
    const r = await h.call('apple_calendar_update_event', { eventId: 'work/s.ics', span: 'allEvents', startDate: '2026-10-19T10:00', timeZone: 'america/new_york' });
    expect(r.json).toMatchObject({ updated: true, verified: true });
    const stored = unfold(h.dav.get('work', 's.ics')!.ics);
    expect(stored).toContain('DTSTART;TZID=America/New_York:20261019T100000');
    expect(stored).not.toMatch(/DTSTART:\d{8}T\d{6}Z/);
  });

  it('says so when it moves an event into a shared calendar', async () => {
    h.dav.addCalendar({ id: 'fam', name: 'Family', order: 3, extraTypes: '<cs:shared/>' });
    const r = await h.call('apple_calendar_update_event', { eventId: 'home/one.ics', calendar: 'Family' });
    expect(r.json).toMatchObject({ eventId: 'fam/one.ics', notes: ['"Family" is shared with you by someone else: everyone it is shared with sees the events in it.'] });
    const p = await callPreview(gated('apple_calendar_update_event'), { eventId: 'home/meet.ics', calendar: 'Family' });
    expect(p.preview).toMatchObject({ calendar: 'Home → Family', calendarShared: '"Family" is shared with you by someone else: everyone it is shared with sees the events in it.' });
  });

  it('refuses to change the invitees of an event someone else organises', async () => {
    h.dav.put('home', 'theirs.ics', ics(...vevent('UID:t', 'DTSTART:20261023T140000Z', 'SUMMARY:Their meeting', 'ORGANIZER:mailto:boss@x.com', `ATTENDEE:/${DSID}/principal/`)));
    const r = await h.call('apple_calendar_update_event', { eventId: 'home/theirs.ics', attendees: [{ email: 'friend@x.com' }] });
    expect(r.json.error).toMatchObject({ code: 'UNSUPPORTED', message: expect.stringMatching(/Only the organizer can change who is invited/) });
    expect(h.dav.writes()).toEqual([]);
  });

  it('edits one occurrence through an override, keeping its id', async () => {
    const r = await h.call('apple_calendar_update_event', { eventId: 'work/s.ics#occ=2026-10-22T13:00:00Z', title: 'Standup (demo)', startDate: '2026-10-22T09:30' });
    expect(r.json).toMatchObject({ applied: 'this occurrence only', eventId: 'work/s.ics#occ=2026-10-22T13:00:00Z', verified: true });
    const list = await h.call('apple_calendar_list_events', { fromDate: '2026-10-22', daysAhead: 1 });
    expect(list.json.events.map((e: { title: string; start: string }) => [e.title, e.start])).toEqual([['Standup (demo)', '2026-10-22T09:30:00-04:00']]);
  });

  it('refuses a bare series id without allEvents, and edits the whole series with it', async () => {
    const bare = await h.call('apple_calendar_update_event', { eventId: 'work/s.ics', title: 'x' });
    expect(bare.json.error.message).toMatch(/recurring series/);
    const all = await h.call('apple_calendar_update_event', { eventId: 'work/s.ics', span: 'allEvents', startDate: '2026-10-19T08:00' });
    expect(all.json).toMatchObject({ applied: 'every occurrence of the series', eventId: 'work/s.ics', verified: true });
    expect(all.json.event).toMatchObject({ start: '2026-10-19T08:00:00-04:00' });
  });

  it('splits a series for futureEvents and reports the new series id', async () => {
    const r = await h.call('apple_calendar_update_event', { eventId: 'work/s.ics#occ=2026-10-23T13:00:00Z', span: 'futureEvents', startDate: '2026-10-23T10:00' });
    expect(r.json).toMatchObject({
      applied: 'this and all following occurrences',
      eventId: 'work/UID-1.ics#occ=2026-10-23T14:00:00Z',
      newSeriesId: 'work/UID-1.ics',
      verified: true,
      notes: [expect.stringMatching(/The series was split/)],
    });
    expect(h.dav.writes()).toEqual([`PUT /${DSID}/calendars/work/s.ics`, `PUT /${DSID}/calendars/work/UID-1.ics`]);
  });

  it('restores the original series when the continuation is refused, and says what happened otherwise', async () => {
    const args = { eventId: 'work/s.ics#occ=2026-10-23T13:00:00Z', span: 'futureEvents', title: 'Later' };
    const original = h.dav.get('work', 's.ics')!.ics;
    h.dav.hooks.push((m, url) => (m === 'PUT' && url.includes('UID-') ? { status: 403, body: '<error xmlns="DAV:"><need-privileges/></error>' } : undefined));
    const restored = await h.call('apple_calendar_update_event', args);
    expect(restored.json.error.message).toMatch(/^Nothing was changed \(the original series was restored\): creating the new series failed:/);
    expect(h.dav.get('work', 's.ics')!.ics).toBe(original);

    // Now the restore fails too (it is the PUT that carries the original COUNT=10 rule back).
    h.dav.hooks.push((m, url, body) => (m === 'PUT' && url.endsWith('/s.ics') && body.includes('COUNT=10') ? { status: 500 } : undefined));
    const stuck = await h.call('apple_calendar_update_event', args);
    expect(stuck.json.error.message).toMatch(/new series could not be created, and restoring the original failed/);

    // A server that sends no ETag for the truncating PUT: the restore falls back to If-Match: *.
    h.dav.put('work', 's.ics', original);
    h.dav.hooks = [
      (m, url, body) => (m === 'PUT' && url.endsWith('/s.ics') && body.includes('UNTIL=') ? { status: 204 } : undefined),
      (m, url) => (m === 'PUT' && url.includes('UID-') ? { status: 400 } : undefined),
    ];
    const noEtag = await h.call('apple_calendar_update_event', args);
    expect(noEtag.json.error.message).toMatch(/^Nothing was changed/);
    const restore = h.dav.requests.filter((q) => q.method === 'PUT').pop()!;
    expect(restore.headers['if-match']).toBe('*');

    h.dav.put('work', 's.ics', original); // the failed restore left it ended early
    h.dav.hooks = [(m, url) => (m === 'PUT' && url.includes('UID-') ? { status: 504 } : undefined)];
    const unknown = await h.call('apple_calendar_update_event', args);
    expect(unknown.json.error).toMatchObject({ code: 'UNCONFIRMED_WRITE', message: expect.stringMatching(/may or may not have succeeded/) });
  });

  it('says the new series was NOT created when the first write of a split has an unknown outcome', async () => {
    // The truncating PUT lands on iCloud, but the reply is lost (503): the continuation is never attempted.
    h.dav.hooks.push((m, url, body) => {
      if (m === 'PUT' && url.endsWith('/s.ics') && body.includes('UNTIL=')) {
        h.dav.put('work', 's.ics', body);
        return { status: 503 };
      }
      return undefined;
    });
    const r = await h.call('apple_calendar_update_event', { eventId: 'work/s.ics#occ=2026-10-23T13:00:00Z', span: 'futureEvents', title: 'Later' });
    expect(r.json.error).toMatchObject({
      code: 'UNCONFIRMED_WRITE',
      message: expect.stringMatching(
        /^Ending the original series before this occurrence may or may not have happened, and the new series \(this occurrence and the ones after it\) was NOT created\. If the series now ends before this occurrence, those occurrences are gone and must be created again: /,
      ),
    });
    expect(h.dav.requests.filter((q) => q.method === 'PUT' && q.url.includes('UID-'))).toEqual([]);

    // A definite refusal of that write changed nothing, and says only that.
    h.dav.hooks = [(m, url) => (m === 'PUT' && url.endsWith('/s.ics') ? { status: 403, body: '<error xmlns="DAV:"><need-privileges/></error>' } : undefined)];
    const refused = await h.call('apple_calendar_update_event', { eventId: 'work/s.ics#occ=2026-10-20T13:00:00Z', span: 'futureEvents', title: 'Later' });
    expect(refused.json.error.message).not.toMatch(/new series/);
    expect(h.dav.requests.filter((q) => q.method === 'PUT' && q.url.includes('UID-'))).toEqual([]);
  });

  it('restores a split series with attendees at a SEQUENCE above the shortened one they were sent, and says they were emailed', async () => {
    h.dav.put(
      'work',
      'team.ics',
      ics(
        ...NY_TZ,
        ...vevent(
          'UID:team',
          'SEQUENCE:3',
          'DTSTART;TZID=America/New_York:20261019T090000',
          'DTEND;TZID=America/New_York:20261019T091500',
          'RRULE:FREQ=DAILY;COUNT=10',
          'SUMMARY:Standup',
          'ORGANIZER:mailto:me@icloud.com',
          'ATTENDEE;CN=Ann;PARTSTAT=ACCEPTED:mailto:ann@x.com',
        ),
        ...vevent('UID:team', 'SEQUENCE:7', 'RECURRENCE-ID;TZID=America/New_York:20261020T090000', 'DTSTART;TZID=America/New_York:20261020T100000', 'DTEND;TZID=America/New_York:20261020T101500', 'SUMMARY:Standup', 'ORGANIZER:mailto:me@icloud.com', 'ATTENDEE;CN=Ann;PARTSTAT=ACCEPTED:mailto:ann@x.com'),
        ...vevent('UID:team', 'RECURRENCE-ID;TZID=America/New_York:20261025T090000', 'DTSTART;TZID=America/New_York:20261025T100000', 'DTEND;TZID=America/New_York:20261025T101500', 'SUMMARY:Standup', 'ORGANIZER:mailto:me@icloud.com', 'ATTENDEE;CN=Ann;PARTSTAT=ACCEPTED:mailto:ann@x.com'),
      ),
    );
    h.dav.hooks.push((m, url) => (m === 'PUT' && url.includes('UID-') ? { status: 403, body: '<error xmlns="DAV:"><need-privileges/></error>' } : undefined));
    const args = { eventId: 'work/team.ics#occ=2026-10-23T13:00:00Z', span: 'futureEvents', title: 'Later' };
    const r = json(await callConfirmed(gated('apple_calendar_update_event'), args));
    expect(r.error.message).toMatch(
      /^The original series was restored, but iCloud had already emailed its attendees the shortened series, so they were sent that and then the restored one: creating the new series failed:/,
    );
    const puts = h.dav.requests.filter((q) => q.method === 'PUT' && q.url.endsWith('/team.ics'));
    expect(puts).toHaveLength(2);
    const [shortened, restore] = puts as [{ body: string }, { body: string }];
    const sequences = (body: string) => eventParts(parseCalendar(body, 't')).overrides.concat(eventParts(parseCalendar(body, 't')).master!).map((c) => Number(c.getFirstPropertyValue('sequence')));
    expect(shortened.body).toContain('UNTIL=');
    // Every component of the restore is above the highest SEQUENCE the shortened series (or the original) carried.
    expect(Math.max(...sequences(shortened.body))).toBe(7);
    expect(sequences(restore.body)).toEqual([8, 8, 8]);
    // Otherwise it is the original series: the rule, both overrides and the attendees are back.
    const stored = eventParts(parseCalendar(h.dav.get('work', 'team.ics')!.ics, 't'));
    expect(String(stored.master!.getFirstPropertyValue('rrule'))).toBe('FREQ=DAILY;COUNT=10');
    expect(stored.overrides).toHaveLength(2);
    expect(stored.master!.getAllProperties('attendee')).toHaveLength(1);
  });

  it('moves an event with WebDAV MOVE, then applies the other changes at the new place', async () => {
    const r = await h.call('apple_calendar_update_event', { eventId: 'home/one.ics', calendar: 'Work', notes: 'moved' });
    expect(r.json).toMatchObject({ eventId: 'work/one.ics', verified: true, changes: { calendar: { before: 'Home', after: 'Work' }, notes: { before: null, after: 'moved' } } });
    const move = h.dav.requests.find((q) => q.method === 'MOVE')!;
    expect(move.headers).toMatchObject({ destination: `${HOME}work/one.ics`, overwrite: 'F', 'if-match': '"e1"' });
    expect(h.dav.get('home', 'one.ics')).toBeUndefined();
    expect(h.dav.get('work', 'one.ics')!.ics).toContain('DESCRIPTION:moved');
    const alone = await h.call('apple_calendar_update_event', { eventId: 'work/one.ics', calendar: 'home' });
    expect(alone.json).toMatchObject({ eventId: 'home/one.ics', verified: true });
    expect(h.dav.writes().slice(-1)).toEqual([`MOVE /${DSID}/calendars/work/one.ics`]);
  });

  it('says the event moved when the follow-up change fails', async () => {
    h.dav.noEtagOnGet = true;
    h.dav.hooks.push((m) => (m === 'PUT' ? { status: 412 } : undefined));
    const r = await h.call('apple_calendar_update_event', { eventId: 'home/one.ics', calendar: 'Work', title: 'x' });
    expect(r.json.error.message).toMatch(/^The event was moved to "Work", but applying the other changes failed:/);
    expect(h.dav.requests.find((q) => q.method === 'MOVE')!.headers['if-match']).toBe('*');
  });

  it('says the other changes were NOT applied when a MOVE has an unknown outcome', async () => {
    h.dav.hooks.push((m) => (m === 'MOVE' ? { status: 504 } : undefined));
    const r = await h.call('apple_calendar_update_event', { eventId: 'home/one.ics', calendar: 'Work', title: 'x' });
    expect(r.json.error).toMatchObject({
      code: 'UNCONFIRMED_WRITE',
      message: expect.stringMatching(/^Moving the event to "Work" may or may not have happened, and the other changes were NOT applied: /),
    });
    expect(h.dav.requests.filter((q) => q.method === 'PUT')).toEqual([]);
    // A move alone: the MOVE's own error says it all.
    const alone = await h.call('apple_calendar_update_event', { eventId: 'home/one.ics', calendar: 'Work' });
    expect(alone.json.error.code).toBe('UNCONFIRMED_WRITE');
    expect(alone.json.error.message).not.toMatch(/other changes/);
    // A definite refusal changed nothing.
    h.dav.hooks = [(m) => (m === 'MOVE' ? { status: 403 } : undefined)];
    const refused = await h.call('apple_calendar_update_event', { eventId: 'home/one.ics', calendar: 'Work', title: 'x' });
    expect(refused.json.error.message).not.toMatch(/other changes/);
  });

  it('reports a concurrent change as "changed since read"', async () => {
    h.dav.hooks.push((m) => (m === 'PUT' ? { status: 412 } : undefined));
    const r = await h.call('apple_calendar_update_event', { eventId: 'home/one.ics', title: 'x' });
    expect(r.json.error.message).toMatch(/changed on iCloud since it was read/);
  });

  it('warns when the change does not read back as written', async () => {
    afterWrite((m) => (m === 'GET' ? { status: 200, body: ics(...vevent('UID:one', 'DTSTART:20261021T130000Z', 'DTEND:20261021T140000Z', 'SUMMARY:One')) } : undefined));
    const r = await h.call('apple_calendar_update_event', { eventId: 'home/one.ics', title: 'Uno' });
    expect(r.json).toMatchObject({ verified: false, warnings: ['title reads back as "One", not "Uno" as written.'] });
    expect(r.json.changes).toEqual({});
  });

  it('reads attendees back by who is invited: iCloud adding the organizer or filling in replies is not a lost write', async () => {
    const args = { eventId: 'home/one.ics', attendees: [{ email: 'cy@x.com', name: 'Cy' }] };
    const served = (...attendees: string[]) =>
      ics(...vevent('UID:one', 'DTSTART:20261021T130000Z', 'DTEND:20261021T140000Z', 'SUMMARY:One', 'ORGANIZER:mailto:me@icloud.com', ...attendees));
    afterWrite((m) =>
      m === 'GET'
        ? { status: 200, body: served(`ATTENDEE;PARTSTAT=ACCEPTED;EMAIL=me@icloud.com:/${DSID}/principal/`, 'ATTENDEE;CN=Cy;PARTSTAT=TENTATIVE;SCHEDULE-STATUS=1.2:mailto:CY@x.com') }
        : undefined,
    );
    const ok = json(await callConfirmed(gated('apple_calendar_update_event'), args));
    expect(ok).toMatchObject({ updated: true, verified: true });
    expect(ok.warnings).toBeUndefined();

    h.dav.hooks = [];
    seed();
    afterWrite((m) => (m === 'GET' ? { status: 200, body: served('ATTENDEE:mailto:someone-else@x.com') } : undefined));
    const lost = json(await callConfirmed(gated('apple_calendar_update_event'), args));
    expect(lost.verified).toBe(false);
    expect(lost.warnings).toEqual([expect.stringMatching(/^attendees reads back as \[\{"email":"someone-else@x\.com"/)]);
  });

  it('checks that cleared attendees are gone, not mistaking one without an e-mail for the organizer', async () => {
    const args = { eventId: 'home/meet.ics', attendees: [] };
    const served = (...lines: string[]) => ics(...vevent('UID:meet', 'DTSTART:20261023T140000Z', 'DTEND:20261023T150000Z', 'SUMMARY:Review', ...lines));
    afterWrite((m) => (m === 'GET' ? { status: 200, body: served() } : undefined));
    expect(json(await callConfirmed(gated('apple_calendar_update_event'), args))).toMatchObject({ verified: true });

    h.dav.hooks = [];
    seed();
    afterWrite((m) => (m === 'GET' ? { status: 200, body: served('ORGANIZER;CN=Boss:urn:uuid:boss', 'ATTENDEE:urn:uuid:left-behind') } : undefined));
    const stuck = json(await callConfirmed(gated('apple_calendar_update_event'), args));
    expect(stuck.verified).toBe(false);
    expect(stuck.warnings).toEqual(['attendees reads back as [{"status":"needs-action"}], not null as written.']);
  });

  it('names fields that read back missing, or still present after being cleared', async () => {
    afterWrite((m) => (m === 'GET' ? { status: 200, body: ics(...vevent('UID:one', 'DTSTART:20261021T130000Z', 'DTEND:20261021T140000Z', 'SUMMARY:One', 'LOCATION:Old')) } : undefined));
    const cleared = await h.call('apple_calendar_update_event', { eventId: 'home/one.ics', location: '', notes: 'N' });
    expect(cleared.json.warnings).toEqual(['location reads back as "Old", not null as written.', 'notes reads back as null, not "N" as written.']);
  });

  it('moves an event with attendees only after asking, naming both calendars (no ETag: revision from content)', async () => {
    h.dav.noEtagOnGet = true;
    const args = { eventId: 'home/meet.ics', calendar: 'Work' };
    const preview = await callPreview(gated('apple_calendar_update_event'), args);
    expect(preview.preview).toMatchObject({ calendar: 'Home → Work', changes: ['calendar: "Home" → "Work"'] });
    const done = json(await callConfirmed(gated('apple_calendar_update_event'), args));
    expect(done).toMatchObject({ eventId: 'work/meet.ics', verified: true });
  });

  it('refuses a no-op and a stale occurrence', async () => {
    expect((await h.call('apple_calendar_update_event', { eventId: 'home/one.ics' })).json.error.message).toMatch(/Nothing to change/);
    expect((await h.call('apple_calendar_update_event', { eventId: 'work/s.ics#occ=2026-10-19T14:00:00Z', title: 'x' })).json.error.code).toBe('NOT_FOUND');
  });

  it('gates an occurrence edit when only another occurrence has attendees', async () => {
    h.dav.put(
      'work',
      'x.ics',
      ics(
        ...vevent('UID:x', 'DTSTART:20261019T130000Z', 'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:X'),
        ...vevent('UID:x', 'RECURRENCE-ID:20261021T130000Z', 'DTSTART:20261021T130000Z', 'SUMMARY:X', 'ATTENDEE:mailto:a@x.com'),
      ),
    );
    const p = await callPreview(gated('apple_calendar_update_event'), { eventId: 'work/x.ics#occ=2026-10-20T13:00:00Z', title: 'Y' });
    expect(p.preview.attendees).toBeUndefined();
    expect(p.preview.applies).toBe('this occurrence only');
  });
});

describe('apple_calendar_delete_event', () => {
  beforeEach(seed);

  it('always asks, then deletes with If-Match and verifies it is gone', async () => {
    const preview = await callPreview(gated('apple_calendar_delete_event'), { eventId: 'home/one.ics' });
    expect(preview.preview).toEqual({ event: 'One', when: 'Wed, Oct 21, 2026, 9:00 AM EDT – Wed, Oct 21, 2026, 10:00 AM EDT', calendar: 'Home', deletes: 'this event' });
    expect(h.dav.writes()).toEqual([]);
    const done = json(await callConfirmed(gated('apple_calendar_delete_event'), { eventId: 'home/one.ics' }));
    expect(done).toEqual({ deleted: true, verified: true, eventId: 'home/one.ics', applied: 'this event', title: 'One', when: expect.any(String), calendar: 'Home' });
    expect(h.dav.requests.find((q) => q.method === 'DELETE')!.headers['if-match']).toBe('"e1"');
  });

  it('refuses to rewrite an event that ALREADY holds a raw CR when deleting one or later occurrences', async () => {
    // Stored by another app: a bare CR inside DESCRIPTION that a lenient parser would read as an ATTENDEE line — which
    // the confirmation preview (built from the parsed event) never shows.
    h.dav.put(
      'work',
      'cr.ics',
      ics(
        ...NY_TZ,
        ...vevent('UID:cr', 'DTSTART;TZID=America/New_York:20261019T090000', 'DTEND;TZID=America/New_York:20261019T091500', 'RRULE:FREQ=DAILY;COUNT=10', 'SUMMARY:Standup', 'DESCRIPTION:hello\rATTENDEE:mailto:evil@example.com'),
      ),
    );
    for (const span of ['thisEvent', 'futureEvents'] as const) {
      // Refused before any preview or token: there is nothing it could confirm.
      const r = await h.call('apple_calendar_delete_event', { eventId: 'work/cr.ics#occ=2026-10-22T13:00:00Z', span }, NO_ELICIT_CTX);
      expect(r.json.error).toMatchObject({ code: 'INVALID_ARGUMENT', hint: expect.stringMatching(/the stored event already holds one/) });
    }
    expect(h.dav.writes()).toEqual([]);
  });

  it('deletes one occurrence with an EXDATE and checks it no longer exists', async () => {
    const done = json(await callConfirmed(gated('apple_calendar_delete_event'), { eventId: 'work/s.ics#occ=2026-10-22T13:00:00Z' }));
    expect(done).toMatchObject({ deleted: true, verified: true, applied: 'this occurrence only' });
    expect(h.dav.get('work', 's.ics')!.ics).toContain('EXDATE;TZID=America/New_York:20261022T090000');
    const series = json(await callConfirmed(gated('apple_calendar_delete_event'), { eventId: 'work/s.ics', span: 'allEvents' }));
    expect(series.applied).toMatch(/^the whole series \(\d+ occurrences in the next year\)$/);
  });

  it('deletes an occurrence two values name (a PERIOD on a rule instance) entirely, and verifies it', async () => {
    h.dav.put('home', 'dup.ics', ics(...vevent('UID:dup', 'DTSTART:20261026T130000Z', 'DTEND:20261026T140000Z', 'RRULE:FREQ=WEEKLY;COUNT=3', 'RDATE;VALUE=PERIOD:20261102T130000Z/PT3H', 'SUMMARY:W')));
    const listed = await h.call('apple_calendar_list_events', { fromDate: '2026-10-25', toDate: '2026-11-15', calendars: ['Home'] });
    expect(listed.json.events.filter((e: { id: string }) => e.id.startsWith('home/dup.ics')).map((e: { id: string }) => e.id)).toEqual([
      'home/dup.ics#occ=2026-10-26T13:00:00Z',
      'home/dup.ics#occ=2026-11-02T13:00:00Z',
      'home/dup.ics#occ=2026-11-09T13:00:00Z',
    ]);
    const done = json(await callConfirmed(gated('apple_calendar_delete_event'), { eventId: 'home/dup.ics#occ=2026-11-02T13:00:00Z' }));
    expect(done).toMatchObject({ deleted: true, verified: true, applied: 'this occurrence only' });
    expect(done.warnings).toBeUndefined();
  });

  it('warns when the deletion does not read back yet, or cannot be checked', async () => {
    h.dav.hooks.push((m) => (m === 'DELETE' ? { status: 204 } : undefined)); // accepted but not applied (yet)
    const lag = json(await callConfirmed(gated('apple_calendar_delete_event'), { eventId: 'home/one.ics' }));
    expect(lag).toMatchObject({ verified: false, warnings: [expect.stringMatching(/still shows on a re-read/)] });

    h.dav.hooks = [(m) => (m === 'PUT' ? { status: 204 } : undefined)];
    const occ = json(await callConfirmed(gated('apple_calendar_delete_event'), { eventId: 'work/s.ics#occ=2026-10-22T13:00:00Z' }));
    expect(occ).toMatchObject({ verified: false, warnings: [expect.stringMatching(/occurrence still shows/)] });

    h.dav.hooks = [];
    afterWrite((m) => (m === 'GET' ? { status: 400 } : undefined));
    const odd = json(await callConfirmed(gated('apple_calendar_delete_event'), { eventId: 'work/s.ics#occ=2026-10-23T13:00:00Z' }));
    expect(odd.warnings[0]).toMatch(/re-reading to verify it failed/);

    h.dav.hooks = [];
    afterWrite((m) => (m === 'GET' ? { status: 404 } : undefined));
    const vanished = json(await callConfirmed(gated('apple_calendar_delete_event'), { eventId: 'work/s.ics#occ=2026-10-24T13:00:00Z' }));
    expect(vanished).toMatchObject({ verified: false });
  });

  it('refuses a stale token when the event changed between preview and confirmation', async () => {
    const { confirmToken } = await callPreview(gated('apple_calendar_delete_event'), { eventId: 'home/one.ics' });
    h.dav.put('home', 'one.ics', ics(...vevent('UID:one', 'DTSTART:20261021T130000Z', 'SUMMARY:One (edited)')));
    const r = await gated('apple_calendar_delete_event')({ eventId: 'home/one.ics', confirmToken }, NO_ELICIT_CTX);
    expect(json(r)).toMatchObject({ status: 'confirmation-rejected', error: 'DRAFT_CHANGED' });
    expect(h.dav.get('home', 'one.ics')).toBeDefined();
  });

  it('explains when "this and following" is the whole series (no ETag: revision from content)', async () => {
    h.dav.noEtagOnGet = true;
    const done = json(await callConfirmed(gated('apple_calendar_delete_event'), { eventId: 'work/s.ics#occ=2026-10-19T13:00:00Z', span: 'futureEvents' }));
    expect(done).toMatchObject({ deleted: true, verified: true, notes: [expect.stringMatching(/deletes the whole series/)] });
    expect(h.dav.requests.find((q) => q.method === 'DELETE')!.headers['if-match']).toBe('*');
  });

  it('describes the notice for events with attendees', async () => {
    const p = await callPreview(gated('apple_calendar_delete_event'), { eventId: 'home/meet.ics' });
    expect(p.preview).toMatchObject({ attendees: 'Ann, bob@x.com, (unknown)', notice: expect.stringMatching(/cancellation/) });
    const parts = eventParts(parseCalendar(h.dav.get('home', 'meet.ics')!.ics, 't'));
    expect(textProp(parts.master!, 'summary')).toBe('Review');
  });
});
