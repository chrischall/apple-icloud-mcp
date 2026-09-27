import { beforeEach, describe, expect, it } from 'vitest';
import { AppleToolError, InvalidArgumentError } from '../../src/errors.js';
import { occurrenceFor, planDelete, planUpdate, type UpdateInput } from '../../src/calendar/edit.js';
import { loadEvent } from '../../src/calendar/events.js';
import { eventParts, parseCalendar, textProp } from '../../src/calendar/ics.js';
import { FakeCalDav, HOME, NOW, NY_TZ, ics, vevent } from './fake-caldav.js';

const NY = 'America/New_York';
let dav: FakeCalDav;
const env = { zone: NY, now: NOW, newUid: () => 'NEW' };

beforeEach(() => {
  dav = new FakeCalDav().install();
  dav.addCalendar({ id: 'home', name: 'Home' }).addCalendar({ id: 'work', name: 'Work' }).addCalendar({ id: 'ro', name: 'Shared', privileges: ['read'] });
  dav.put('home', 'one.ics', ics(...vevent('UID:one', 'DTSTART:20261021T130000Z', 'DTEND:20261021T140000Z', 'SUMMARY:One')));
  dav.put(
    'work',
    's.ics',
    ics(
      ...NY_TZ,
      ...vevent('UID:s', 'DTSTART;TZID=America/New_York:20261019T090000', 'DTEND;TZID=America/New_York:20261019T091500', 'RRULE:FREQ=DAILY;COUNT=10', 'SUMMARY:Standup'),
      ...vevent('UID:s', 'RECURRENCE-ID;TZID=America/New_York:20261021T090000', 'DTSTART;TZID=America/New_York:20261021T100000', 'SUMMARY:Standup', 'ATTENDEE;CN=Ann:mailto:ann@x.com'),
    ),
  );
  dav.put(
    'home',
    'inv.ics',
    ics(
      ...vevent('UID:i', 'RECURRENCE-ID:20261022T130000Z', 'DTSTART:20261022T130000Z', 'SUMMARY:A', 'ATTENDEE:mailto:bob@x.com'),
      ...vevent('UID:i', 'RECURRENCE-ID:20261029T130000Z', 'DTSTART:20261029T130000Z', 'SUMMARY:A', 'ATTENDEE:/9/principal/'),
    ),
  );
  dav.put('ro', 'x.ics', ics(...vevent('UID:x', 'DTSTART:20261021T130000Z', 'SUMMARY:X')));
});

const load = (id: string) => loadEvent(dav.context(), id, NY);
const update = async (id: string, input: Partial<UpdateInput>) => planUpdate(await load(id), { span: 'thisEvent', ...input }, env);

describe('planUpdate', () => {
  it('refuses requests that change nothing or misuse timeZone, and read-only calendars', async () => {
    await expect(update('home/one.ics', {})).rejects.toThrow(/Nothing to change/);
    await expect(update('home/one.ics', { timeZone: NY, title: 'x' })).rejects.toThrow(/timeZone only applies together with startDate or endDate/);
    await expect(update('ro/x.ics', { title: 'y' })).rejects.toThrow(/"Shared" is read-only/);
    // Naming the calendar it is already in, and nothing else, is a no-op — not a write with nothing to send.
    await expect(update('home/one.ics', { calendar: 'Home' })).rejects.toThrow('Nothing to change: the event is already in "Home".');
  });

  it('moves a series on named weekdays to the new days, and says so', async () => {
    dav.put(
      'home',
      'gym.ics',
      ics(...NY_TZ, ...vevent('UID:g', 'DTSTART;TZID=America/New_York:20261019T070000', 'DTEND;TZID=America/New_York:20261019T080000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'SUMMARY:Gym')),
    );
    const p = await update('home/gym.ics#occ=2026-10-21T11:00:00Z', { span: 'allEvents', startDate: '2026-10-22T07:00' });
    expect(p.result.eventId).toBe('home/gym.ics#occ=2026-10-22T11:00:00Z');
    expect(p.notes).toEqual(['The repeat days moved with it: MO,WE → TU,TH.']);
    expect(p.puts[0]!.body).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU,TH');
  });

  it('refuses, before writing, an edit that would leave the occurrence off the series\' rule', async () => {
    // Every other week, Monday and Sunday (weeks start Monday): moving the Sunday a day later lands it in an off week.
    dav.put(
      'home',
      'alt.ics',
      ics(
        ...NY_TZ,
        ...vevent('UID:a', 'DTSTART;TZID=America/New_York:20261019T090000', 'DTEND;TZID=America/New_York:20261019T100000', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;WKST=MO', 'SUMMARY:Alt'),
      ),
    );
    await expect(update('home/alt.ics#occ=2026-10-25T13:00:00Z', { span: 'allEvents', startDate: '2026-10-26T09:00' })).rejects.toThrow(
      /would no longer fall on the series' repeat rule.*Nothing was changed/,
    );
    await expect(update('home/alt.ics#occ=2026-10-25T13:00:00Z', { span: 'allEvents', startDate: '2026-10-26T09:00' })).rejects.toThrow(AppleToolError);
  });

  it('plans a single event: fields, times, a move, and a move alone', async () => {
    const p = await update('home/one.ics', { title: 'Uno', startDate: '2026-10-21T10:00' });
    expect(p).toMatchObject({ span: 'single', scope: 'this event', notifiesAttendees: false, result: { eventId: 'home/one.ics' } });
    expect(p.puts).toHaveLength(1);
    expect(p.puts[0]).toMatchObject({ url: `${HOME}home/one.ics`, ifMatch: '"e1"' });
    expect(p.result.expected).toMatchObject({ title: 'Uno', start: '2026-10-21T10:00:00-04:00', end: '2026-10-21T11:00:00-04:00' });
    expect(p.before).toMatchObject({ title: 'One' });

    const moved = await update('home/one.ics', { calendar: 'Work' });
    expect(moved.move?.id).toBe('work');
    expect(moved.puts).toEqual([]);
    expect(moved.result).toMatchObject({ calendar: { id: 'work' }, eventId: 'work/one.ics' });
    expect((await update('home/one.ics', { calendar: 'home', notes: 'n' })).move).toBeUndefined();
    await expect(update('home/one.ics', { calendar: 'Shared' })).rejects.toThrow(/read-only/);
  });

  it('writes without If-Match only as "*" when iCloud sent no ETag', async () => {
    dav.noEtagOnGet = true;
    expect((await update('home/one.ics', { title: 'x' })).puts[0]!.ifMatch).toBe('*');
  });

  it('requires an occurrence id (or allEvents) for a series, and allEvents to move one', async () => {
    await expect(update('work/s.ics', { title: 'x' })).rejects.toThrow(/is a recurring series/);
    await expect(update('work/s.ics', { title: 'x', span: 'futureEvents' })).rejects.toThrow(InvalidArgumentError);
    await expect(update('work/s.ics#occ=2026-10-20T13:00:00Z', { calendar: 'Home' })).rejects.toThrow(/moves the whole series; pass span: "allEvents"/);
    const all = await update('work/s.ics', { span: 'allEvents', calendar: 'Home' });
    expect(all).toMatchObject({ span: 'allEvents', move: { id: 'home' }, puts: [], result: { eventId: 'home/s.ics' } });
  });

  it('thisEvent: creates an override for a natural occurrence, edits an existing one', async () => {
    const natural = await update('work/s.ics#occ=2026-10-20T13:00:00Z', { location: 'Room 9' });
    expect(natural).toMatchObject({ span: 'thisEvent', scope: 'this occurrence only', result: { eventId: 'work/s.ics#occ=2026-10-20T13:00:00Z' } });
    expect(natural.notifiesAttendees).toBe(true); // another occurrence of the series has attendees
    const written = eventParts(parseCalendar(natural.puts[0]!.body, 't'));
    expect(written.overrides).toHaveLength(2);
    const existing = await update('work/s.ics#occ=2026-10-21T13:00:00Z', { startDate: '2026-10-21T11:00' });
    expect(eventParts(parseCalendar(existing.puts[0]!.body, 't')).overrides).toHaveLength(1);
    expect(existing.result.expected).toMatchObject({ start: '2026-10-21T11:00:00-04:00' });
  });

  it('futureEvents on the first occurrence is the whole series; later, it splits', async () => {
    const first = await update('work/s.ics#occ=2026-10-19T13:00:00Z', { span: 'futureEvents', title: 'All' });
    expect(first).toMatchObject({ span: 'allEvents', notes: [expect.stringMatching(/first occurrence/)] });
    const split = await update('work/s.ics#occ=2026-10-23T13:00:00Z', { span: 'futureEvents', startDate: '2026-10-23T09:30' });
    expect(split.span).toBe('futureEvents');
    expect(split.newSeriesId).toBe('work/NEW.ics');
    expect(split.puts.map((p) => [p.url, p.ifMatch, p.ifNoneMatch])).toEqual([
      [`${HOME}work/s.ics`, '"e2"', undefined],
      [`${HOME}work/NEW.ics`, undefined, '*'],
    ]);
    expect(split.result).toMatchObject({ resourceName: 'NEW.ics', eventId: 'work/NEW.ics#occ=2026-10-23T13:30:00Z' });
    expect(split.puts[0]!.body).toContain('UNTIL=20261023T125959Z');
    expect(split.puts[1]!.body).toContain('COUNT=6');
  });

  it('allEvents with new attendees fetches nothing itself but needs an identity', async () => {
    const who = { self: new Set(['mailto:me@icloud.com']), organizer: 'me@icloud.com' };
    const p = planUpdate(await load('home/one.ics'), { span: 'thisEvent', attendees: [{ email: 'z@x.com' }] }, { ...env, who });
    expect(p.notifiesAttendees).toBe(true);
    expect(p.result.expected.attendees).toEqual([{ email: 'z@x.com', status: 'needs-action', role: 'required' }]);
  });

  it('occurrences of a series held elsewhere: one at a time for times, fields for some or all', async () => {
    await expect(update('home/inv.ics', { span: 'allEvents', startDate: '2026-10-22T10:00' })).rejects.toBeInstanceOf(AppleToolError);
    const all = await update('home/inv.ics', { span: 'allEvents', title: 'B' });
    expect(eventParts(parseCalendar(all.puts[0]!.body, 't')).overrides.map((o) => textProp(o, 'summary'))).toEqual(['B', 'B']);
    const future = await update('home/inv.ics#occ=2026-10-29T13:00:00Z', { span: 'futureEvents', title: 'C' });
    expect(eventParts(parseCalendar(future.puts[0]!.body, 't')).overrides.map((o) => textProp(o, 'summary'))).toEqual(['A', 'C']);
    const one = await update('home/inv.ics#occ=2026-10-22T13:00:00Z', { startDate: '2026-10-22T10:00' });
    expect(one.result.expected).toMatchObject({ start: '2026-10-22T10:00:00-04:00' });
  });
});

describe('planDelete', () => {
  it('deletes a single event or a whole series, counting what is lost', async () => {
    expect(planDelete(await load('home/one.ics'), 'thisEvent', env)).toMatchObject({
      span: 'single',
      scope: 'this event',
      op: { kind: 'delete', url: `${HOME}home/one.ics`, ifMatch: '"e1"' },
      verify: { gone: true },
      preview: { event: 'One', calendar: 'Home', deletes: 'this event' },
    });
    const all = planDelete(await load('work/s.ics'), 'allEvents', env);
    expect(all).toMatchObject({ span: 'allEvents', op: { kind: 'delete' } });
    expect(all.scope).toBe('the whole series (8 occurrences in the next year)'); // Oct 21–28: the rest of the 10
    expect(all.preview).toMatchObject({ repeats: 'Every day, 10 times' });
    const first = planDelete(await load('work/s.ics#occ=2026-10-19T13:00:00Z'), 'futureEvents', env);
    expect(first).toMatchObject({ span: 'allEvents', op: { kind: 'delete' }, notes: [expect.stringMatching(/first occurrence/)] });
  });

  it('says "1 occurrence" and marks a capped count', async () => {
    dav.put('home', 'last.ics', ics(...vevent('UID:l', 'DTSTART:20261021T130000Z', 'RRULE:FREQ=DAILY;COUNT=1')));
    expect(planDelete(await load('home/last.ics'), 'allEvents', env).scope).toBe('the whole series (1 occurrence in the next year)');
    dav.put('home', 'hourly.ics', ics(...vevent('UID:h', 'DTSTART:20261021T130000Z', 'RRULE:FREQ=HOURLY')));
    expect(planDelete(await load('home/hourly.ics'), 'allEvents', env).scope).toBe('the whole series (1000+ occurrences in the next year)');
  });

  it('thisEvent adds an EXDATE (and drops the override); futureEvents truncates', async () => {
    const one = planDelete(await load('work/s.ics#occ=2026-10-21T13:00:00Z'), 'thisEvent', env);
    expect(one).toMatchObject({ scope: 'this occurrence only', op: { kind: 'put' }, verify: { occ: '2026-10-21T13:00:00Z' } });
    const body = (one.op as { body: string }).body;
    expect(body).toContain('EXDATE;TZID=America/New_York:20261021T090000');
    expect(body).not.toContain('RECURRENCE-ID');
    expect(one.preview).toMatchObject({ attendees: 'Ann', notice: expect.stringMatching(/cancellation/) });
    const natural = planDelete(await load('work/s.ics#occ=2026-10-22T13:00:00Z'), 'thisEvent', env);
    expect((natural.op as { body: string }).body).toContain('RECURRENCE-ID');
    const future = planDelete(await load('work/s.ics#occ=2026-10-22T13:00:00Z'), 'futureEvents', env);
    expect(future.scope).toBe('this and all following occurrences');
    expect((future.op as { body: string }).body).toContain('UNTIL=20261022T125959Z');
  });

  it('master-less resources: removes overrides, and the resource when none is left', async () => {
    const one = planDelete(await load('home/inv.ics#occ=2026-10-22T13:00:00Z'), 'thisEvent', env);
    expect(one.op.kind).toBe('put');
    expect(one.preview.attendees).toBe('bob@x.com');
    const future = planDelete(await load('home/inv.ics#occ=2026-10-22T13:00:00Z'), 'futureEvents', env);
    expect(future).toMatchObject({ op: { kind: 'delete' }, notes: ['No occurrence would be left, so the whole event is deleted.'] });
    const later = planDelete(await load('home/inv.ics#occ=2026-10-29T13:00:00Z'), 'thisEvent', env);
    expect(later.preview.attendees).toBe('(unknown)');
    const laterOn = planDelete(await load('home/inv.ics#occ=2026-10-29T13:00:00Z'), 'futureEvents', env);
    expect(laterOn.op.kind).toBe('put');
    expect(eventParts(parseCalendar((laterOn.op as { body: string }).body, 't')).overrides).toHaveLength(1);
    dav.noEtagOnGet = true;
    expect(planDelete(await load('home/one.ics'), 'thisEvent', env).op).toMatchObject({ ifMatch: '*' });
  });

  it('deletes the whole resource when the last occurrence goes, instead of leaving an empty series', async () => {
    dav.put('home', 'last.ics', ics(...vevent('UID:l', 'DTSTART:20261021T130000Z', 'RRULE:FREQ=DAILY;COUNT=2', 'EXDATE:20261022T130000Z', 'SUMMARY:L')));
    const plan = planDelete(await load('home/last.ics#occ=2026-10-21T13:00:00Z'), 'thisEvent', env);
    expect(plan).toMatchObject({ op: { kind: 'delete' }, verify: { gone: true }, notes: ['No occurrence would be left, so the whole event is deleted.'] });
  });

  it('keeps a series whose rule cannot be walked when one changed occurrence goes (it may have more)', async () => {
    dav.put(
      'home',
      'odd.ics',
      ics(
        ...vevent('UID:o', 'DTSTART:20261021T130000Z', 'RRULE:FREQ=HOURLY;BYMONTH=10', 'SUMMARY:Odd'),
        ...vevent('UID:o', 'RECURRENCE-ID:20261021T130000Z', 'DTSTART:20261021T150000Z', 'SUMMARY:Odd moved'),
      ),
    );
    const plan = planDelete(await load('home/odd.ics#occ=2026-10-21T13:00:00Z'), 'thisEvent', env);
    expect(plan.op.kind).toBe('put');
    expect((plan.op as { body: string }).body).toContain('EXDATE:20261021T130000Z');
    expect(planDelete(await load('home/odd.ics'), 'allEvents', env).scope).toBe(
      'the whole series (its repeat rule cannot be expanded, so its occurrences cannot be counted)',
    );
    // A natural occurrence of such a series cannot be located at all.
    await expect(load('home/odd.ics#occ=2026-10-21T14:00:00Z')).rejects.toThrow(/repeat rule cannot be expanded \(FREQ=HOURLY limited to certain days\)/);
  });

  it('refuses a bare series id without allEvents, and read-only calendars', async () => {
    expect(() => planDelete({} as never, 'thisEvent', env)).toThrow();
    await expect(load('work/s.ics').then((l) => planDelete(l, 'thisEvent', env))).rejects.toThrow(/is a recurring series/);
    await expect(load('ro/x.ics').then((l) => planDelete(l, 'allEvents', env))).rejects.toThrow(/read-only/);
  });
});

describe('occurrenceFor', () => {
  it('builds the series view for a bare id and a plain view for a single event', () => {
    const series = eventParts(parseCalendar(ics(...vevent('UID:s', 'DTSTART:20261019T130000Z', 'RRULE:FREQ=DAILY')), 't'));
    expect(occurrenceFor(series, undefined, NY)).toMatchObject({ recurring: true, master: series.master });
    const single = eventParts(parseCalendar(ics(...vevent('UID:x', 'DTSTART:20261019T130000Z')), 't'));
    expect(occurrenceFor(single, undefined, NY)).toMatchObject({ recurring: false });
    expect(occurrenceFor(series, '2026-10-20T13:00:00Z', NY)).toMatchObject({ occ: '2026-10-20T13:00:00Z' });
  });
});
