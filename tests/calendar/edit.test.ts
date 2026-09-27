import { beforeEach, describe, expect, it } from 'vitest';
import { AppleToolError, InvalidArgumentError } from '../../src/errors.js';
import { occurrenceFor, planDelete, planUpdate, type UpdateInput } from '../../src/calendar/edit.js';
import { loadEvent } from '../../src/calendar/events.js';
import { expandSeries } from '../../src/calendar/expand.js';
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
/** The `#occ=` keys a written body expands to between two dates. */
const keysOf = (body: string, from = '2026-09-01', to = '2027-06-01') =>
  expandSeries(eventParts(parseCalendar(body, 't')), { from: new Date(`${from}T00:00:00Z`), to: new Date(`${to}T00:00:00Z`), zone: NY }).occurrences.map((o) => o.occ);

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

  it('moves an every-other-week series across the week boundary by turning WKST with its days', async () => {
    // Every other week, Monday and Sunday (weeks start Monday): moving the Sunday a day later puts it on a Monday, which
    // with WKST=MO would start the NEXT (skipped) week. The week start turns with the days, so every week is kept.
    dav.put(
      'home',
      'alt.ics',
      ics(
        ...NY_TZ,
        ...vevent('UID:a', 'DTSTART;TZID=America/New_York:20261019T090000', 'DTEND;TZID=America/New_York:20261019T100000', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;WKST=MO', 'SUMMARY:Alt'),
      ),
    );
    const p = await update('home/alt.ics#occ=2026-10-25T13:00:00Z', { span: 'allEvents', startDate: '2026-10-26T09:00' });
    expect(p.result.eventId).toBe('home/alt.ics#occ=2026-10-26T13:00:00Z');
    expect(p.notes).toEqual(['The repeat days moved with it: MO,SU → TU,MO. Its weeks now start on TU instead of MO (WKST), so it keeps the same weeks.']);
    expect(p.puts[0]!.body).toContain('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,MO;WKST=TU');
    expect(keysOf(p.puts[0]!.body, '2026-10-01', '2026-11-20')).toEqual([
      '2026-10-20T13:00:00Z',
      '2026-10-26T13:00:00Z',
      '2026-11-03T14:00:00Z',
      '2026-11-09T14:00:00Z',
      '2026-11-17T14:00:00Z',
    ]);
  });

  it('moves an every-other-weekend series a day later without orphaning its exclusion', async () => {
    dav.put(
      'home',
      'wk.ics',
      ics(
        ...NY_TZ,
        ...vevent(
          'UID:wk',
          'DTSTART;TZID=America/New_York:20261003T100000',
          'DTEND;TZID=America/New_York:20261003T110000',
          'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU',
          'EXDATE;TZID=America/New_York:20261018T100000',
          'SUMMARY:Weekend',
        ),
      ),
    );
    expect(keysOf(dav.get('home', 'wk.ics')!.ics, '2026-10-01', '2026-11-20')).toEqual([
      '2026-10-03T14:00:00Z',
      '2026-10-04T14:00:00Z',
      '2026-10-17T14:00:00Z',
      '2026-10-31T14:00:00Z',
      '2026-11-01T15:00:00Z',
      '2026-11-14T15:00:00Z',
      '2026-11-15T15:00:00Z',
    ]);
    const p = await update('home/wk.ics#occ=2026-10-03T14:00:00Z', { span: 'allEvents', startDate: '2026-10-04T10:00' });
    expect(p.puts[0]!.body).toContain('EXDATE;TZID=America/New_York:20261019T100000');
    // Every occurrence one wall-clock day later; the excluded Sunday Oct 18 is now the excluded Monday Oct 19.
    expect(keysOf(p.puts[0]!.body, '2026-10-01', '2026-11-20')).toEqual([
      '2026-10-04T14:00:00Z',
      '2026-10-05T14:00:00Z',
      '2026-10-18T14:00:00Z',
      '2026-11-01T15:00:00Z',
      '2026-11-02T15:00:00Z',
      '2026-11-15T15:00:00Z',
      '2026-11-16T15:00:00Z',
    ]);
  });

  it('refuses, before writing, a series move that would leave the occurrence off the rule or change the others', async () => {
    // Monthly on the 30th (no February): moved a day later it would repeat on the 31st, which most months lack.
    dav.put('home', 'm30.ics', ics(...NY_TZ, ...vevent('UID:m', 'DTSTART;TZID=America/New_York:20261030T090000', 'DTEND;TZID=America/New_York:20261030T100000', 'RRULE:FREQ=MONTHLY', 'SUMMARY:Rent')));
    // Nov 30 → Dec 1: the rewritten series (from Oct 31, monthly) has no Dec 1 at all.
    await expect(update('home/m30.ics#occ=2026-11-30T14:00:00Z', { span: 'allEvents', startDate: '2026-12-01T09:00' })).rejects.toThrow(
      /would no longer fall on the series' repeat rule.*Nothing was changed/,
    );
    // Oct 30 → Oct 31: the occurrence itself lands, but Nov 30 would become Dec 31 instead of Dec 1.
    const moved = update('home/m30.ics#occ=2026-10-30T13:00:00Z', { span: 'allEvents', startDate: '2026-10-31T09:00' });
    await expect(moved).rejects.toThrow(AppleToolError);
    await expect(moved).rejects.toThrow(
      'calendar: this series (FREQ=MONTHLY) cannot be moved by moving its start: occurrence 2 should become an occurrence on 2026-12-01, ' +
        'but the rewritten series would have one on 2026-12-31, so occurrences would be gained or lost. Nothing was changed.',
    );
    // Only the time of day: every occurrence keeps its day.
    const later = await update('home/m30.ics#occ=2026-10-30T13:00:00Z', { span: 'allEvents', startDate: '2026-10-30T11:00' });
    expect(later.result.eventId).toBe('home/m30.ics#occ=2026-10-30T15:00:00Z');
  });

  it('checks a series move over a bounded sample, so a sparse rule does not walk for centuries', async () => {
    // Rules a listing walks happily but whose 400th instance lies centuries (or millennia) away. ical.js has no loop
    // limits, so an unbounded sample blocked the whole server for seconds to forever on a time-of-day change.
    const rules = [
      'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29',
      'FREQ=MONTHLY;BYMONTHDAY=29;BYMONTH=2',
      'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29',
      'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29;BYDAY=MO',
    ];
    for (const [i, rule] of rules.entries()) {
      dav.put('home', `leap${i}.ics`, ics(...NY_TZ, ...vevent(`UID:leap${i}`, 'DTSTART;TZID=America/New_York:20280229T090000', 'DTEND;TZID=America/New_York:20280229T100000', `RRULE:${rule}`, 'SUMMARY:Leap')));
      const started = performance.now();
      const p = await update(`home/leap${i}.ics#occ=2028-02-29T14:00:00Z`, { span: 'allEvents', startDate: '2028-02-29T11:00' });
      expect(performance.now() - started).toBeLessThan(5000);
      expect(p.result.eventId).toBe(`home/leap${i}.ics#occ=2028-02-29T16:00:00Z`);
      expect(p.puts[0]!.body).toContain('DTSTART;TZID=America/New_York:20280229T110000');
    }
    // Nothing at all within the bounds (the first instance excluded, the next one 16 years on): nothing to compare.
    dav.put(
      'home',
      'far.ics',
      ics(
        ...NY_TZ,
        ...vevent('UID:far', 'DTSTART;TZID=America/New_York:20280229T090000', 'DTEND;TZID=America/New_York:20280229T100000', 'RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29;BYDAY=MO', 'EXDATE;TZID=America/New_York:20280229T090000', 'SUMMARY:Far'),
      ),
    );
    const far = await update('home/far.ics#occ=2044-02-29T14:00:00Z', { span: 'allEvents', startDate: '2044-02-29T11:00' });
    expect(far.result.eventId).toBe('home/far.ics#occ=2044-02-29T16:00:00Z');
  });

  it('checks a sparse series up to the instance that stopped the sample, catching a move that loses or adds occurrences', async () => {
    // Every five years on the 28th: moved onto the 29th it would keep only the leap years (2033/2038/2043 lost).
    dav.put('home', 'm60.ics', ics(...NY_TZ, ...vevent('UID:m60', 'DTSTART;TZID=America/New_York:20280228T090000', 'DTEND;TZID=America/New_York:20280228T100000', 'RRULE:FREQ=MONTHLY;INTERVAL=60', 'SUMMARY:M')));
    await expect(update('home/m60.ics', { span: 'allEvents', startDate: '2028-02-29T09:00' })).rejects.toThrow(
      /occurrence 2 should become an occurrence on 2033-03-01, but the rewritten series would have none.*Nothing was changed/,
    );
    // And the other way: from the 29th (only leap years) onto the 28th would ADD 2033/2038/2043.
    dav.put('home', 'p60.ics', ics(...NY_TZ, ...vevent('UID:p60', 'DTSTART;TZID=America/New_York:20280229T090000', 'DTEND;TZID=America/New_York:20280229T100000', 'RRULE:FREQ=MONTHLY;INTERVAL=60', 'SUMMARY:P')));
    await expect(update('home/p60.ics', { span: 'allEvents', startDate: '2028-02-28T09:00' })).rejects.toThrow(/occurrence 2 should become no occurrence, but the rewritten series would have one on 2033-02-28/);
  });

  it('does not refuse a sound move of a timed series that also holds a DATE value at the sample cut', async () => {
    // ical.js orders the DATE (midnight, read as UTC) before the previous evening's 21:00 New York instance.
    dav.put(
      'home',
      'dr.ics',
      ics(...NY_TZ, ...vevent('UID:dr', 'DTSTART;TZID=America/New_York:20261019T210000', 'DTEND;TZID=America/New_York:20261019T220000', 'RRULE:FREQ=DAILY', 'RDATE;VALUE=DATE:20271121', 'SUMMARY:D')),
    );
    const p = await update('home/dr.ics', { span: 'allEvents', startDate: '2026-10-19T21:30' });
    expect(p.puts[0]!.body).toContain('DTSTART;TZID=America/New_York:20261019T213000');
  });

  it('moves a late-evening series across DST changes by wall clock, neither refusing nor re-daying it', async () => {
    // A daily 23:30 moved to 23:15: every occurrence keeps its day, also the ones next to a DST change.
    dav.put('home', 'late.ics', ics(...NY_TZ, ...vevent('UID:late', 'DTSTART;TZID=America/New_York:20261019T233000', 'DTEND;TZID=America/New_York:20261019T234500', 'RRULE:FREQ=DAILY', 'SUMMARY:L')));
    const p = await update('home/late.ics', { span: 'allEvents', startDate: '2026-10-19T23:15' });
    expect(p.puts[0]!.body).toContain('DTSTART;TZID=America/New_York:20261019T231500');
    // Weekdays at 23:45 from a Saturday, moved to 00:45 the same Saturday: the same day, so the same weekdays.
    dav.put(
      'home',
      'wd.ics',
      ics(...NY_TZ, ...vevent('UID:wd', 'DTSTART;TZID=America/New_York:20270313T234500', 'DTEND;TZID=America/New_York:20270314T000000', 'RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', 'SUMMARY:W')),
    );
    const wd = await update('home/wd.ics', { span: 'allEvents', startDate: '2027-03-13T00:45' });
    expect(wd.puts[0]!.body).toContain('DTSTART;TZID=America/New_York:20270313T004500');
    expect(wd.puts[0]!.body).toContain('RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR');
  });

  it('refuses, at once, to move a series whose rule would spin ical.js forever', async () => {
    dav.put('home', 'spin.ics', ics(...NY_TZ, ...vevent('UID:spin', 'DTSTART;TZID=America/New_York:20261019T090000', 'DTEND;TZID=America/New_York:20261019T100000', 'RRULE:FREQ=DAILY;INTERVAL=7;BYDAY=TU', 'SUMMARY:S')));
    await expect(update('home/spin.ics', { span: 'allEvents', startDate: '2026-10-19T10:00' })).rejects.toThrow(/day filters never match a day it steps on/);
  });

  it('compares a sample cut in the middle of a day only up to that day, so it does not refuse a sound move', async () => {
    // Twice a day from a 17:00 start: the 400th instance is a 09:00, so the sample stops before that day's 17:00.
    dav.put(
      'home',
      'twice.ics',
      ics(...NY_TZ, ...vevent('UID:tw', 'DTSTART;TZID=America/New_York:20261019T170000', 'DTEND;TZID=America/New_York:20261019T171500', 'RRULE:FREQ=DAILY;BYHOUR=9,17', 'SUMMARY:Pills')),
    );
    const p = await update('home/twice.ics#occ=2026-10-19T21:00:00Z', { span: 'allEvents', startDate: '2026-10-20T17:00' });
    expect(p.result.eventId).toBe('home/twice.ics#occ=2026-10-20T21:00:00Z');
    expect(keysOf(p.puts[0]!.body, '2026-10-19', '2026-10-22')).toEqual(['2026-10-20T21:00:00Z', '2026-10-21T13:00:00Z', '2026-10-21T21:00:00Z']);
  });

  it('refuses to split a series at an occurrence its rule does not produce (an RDATE)', async () => {
    // A Monday series with an extra Wednesday, and one with an extra occurrence past its COUNT.
    dav.put(
      'home',
      'm.ics',
      ics(...NY_TZ, ...vevent('UID:m', 'DTSTART;TZID=America/New_York:20261005T090000', 'DTEND;TZID=America/New_York:20261005T100000', 'RRULE:FREQ=WEEKLY;COUNT=6', 'RDATE;TZID=America/New_York:20261014T090000', 'SUMMARY:M')),
    );
    dav.put(
      'home',
      'c.ics',
      ics(...NY_TZ, ...vevent('UID:c', 'DTSTART;TZID=America/New_York:20261005T090000', 'DTEND;TZID=America/New_York:20261005T100000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'RDATE;TZID=America/New_York:20261104T090000', 'SUMMARY:C')),
    );
    for (const id of ['home/m.ics#occ=2026-10-14T13:00:00Z', 'home/c.ics#occ=2026-11-04T14:00:00Z']) {
      const refused = update(id, { span: 'futureEvents', title: 'T' });
      await expect(refused).rejects.toThrow(AppleToolError);
      await expect(refused).rejects.toThrow(/added to the series individually \(an RDATE\).*cannot be split at it\. Nothing was changed\./);
      // One occurrence, or the whole series, is still fine.
      expect((await update(id, { title: 'T' })).span).toBe('thisEvent');
    }
    // A rule occurrence after the RDATE still splits, and the RDATE stays with the earlier half.
    const split = await update('home/m.ics#occ=2026-10-19T13:00:00Z', { span: 'futureEvents', title: 'T' });
    expect(keysOf(split.puts[0]!.body)).toEqual(['2026-10-05T13:00:00Z', '2026-10-12T13:00:00Z', '2026-10-14T13:00:00Z']);
    expect(keysOf(split.puts[1]!.body)).toEqual(['2026-10-19T13:00:00Z', '2026-10-26T13:00:00Z', '2026-11-02T14:00:00Z', '2026-11-09T14:00:00Z']);
  });

  it('splits a series of RDATEs only, listing the split occurrence once', async () => {
    dav.put('home', 'r.ics', ics(...vevent('UID:r', 'DTSTART:20261019T130000Z', 'DTEND:20261019T140000Z', 'RDATE:20261022T130000Z,20261025T130000Z,20261028T130000Z', 'SUMMARY:R')));
    const split = await update('home/r.ics#occ=2026-10-25T13:00:00Z', { span: 'futureEvents', title: 'T' });
    expect(split.span).toBe('futureEvents');
    expect(keysOf(split.puts[1]!.body)).toEqual(['2026-10-25T13:00:00Z', '2026-10-28T13:00:00Z']);
    expect(keysOf(split.puts[0]!.body)).not.toContain('2026-10-25T13:00:00Z');
  });

  it('refuses to move, split or cut short a series with PERIOD RDATEs, and still edits one occurrence or its fields', async () => {
    dav.put(
      'home',
      'per.ics',
      ics(...NY_TZ, ...vevent('UID:per', 'DTSTART;TZID=America/New_York:20261005T090000', 'DTEND;TZID=America/New_York:20261005T100000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'RDATE;VALUE=PERIOD:20261014T130000Z/PT2H', 'SUMMARY:P')),
    );
    const refusal = /some occurrences as time periods \(RDATE;VALUE=PERIOD\).*cannot move, split or cut short\. Nothing was changed\./;
    await expect(update('home/per.ics#occ=2026-10-12T13:00:00Z', { span: 'allEvents', startDate: '2026-10-12T10:00' })).rejects.toThrow(refusal);
    await expect(update('home/per.ics#occ=2026-10-12T13:00:00Z', { span: 'allEvents', endDate: '2026-10-12T10:30', timeZone: 'Europe/Berlin' })).rejects.toThrow(refusal);
    // A new length alone moves nothing: the natural occurrences get it, the period keeps its own.
    const longer = await update('home/per.ics#occ=2026-10-12T13:00:00Z', { span: 'allEvents', endDate: '2026-10-12T10:30' });
    expect(longer.puts[0]!.body).toContain('DTEND;TZID=America/New_York:20261005T103000');
    expect(longer.puts[0]!.body).toContain('RDATE;VALUE=PERIOD:20261014T130000Z/PT2H');
    await expect(update('home/per.ics#occ=2026-10-12T13:00:00Z', { span: 'futureEvents', title: 'T' })).rejects.toThrow(refusal);
    const loaded = await load('home/per.ics#occ=2026-10-12T13:00:00Z');
    expect(() => planDelete(loaded, 'futureEvents', env)).toThrow(refusal);
    // One occurrence (the period's own, with its two hours), or every occurrence's details, is fine.
    const one = await update('home/per.ics#occ=2026-10-14T13:00:00Z', { title: 'Long one' });
    expect(one.puts[0]!.body).toContain('RECURRENCE-ID;TZID=America/New_York:20261014T090000');
    expect(one.puts[0]!.body).toContain('DTEND;TZID=America/New_York:20261014T110000');
    const all = await update('home/per.ics#occ=2026-10-12T13:00:00Z', { span: 'allEvents', title: 'Renamed' });
    expect(all.puts[0]!.body).toContain('RDATE;VALUE=PERIOD:20261014T130000Z/PT2H');
    expect(planDelete(await load('home/per.ics#occ=2026-10-14T13:00:00Z'), 'thisEvent', env).op).toMatchObject({ kind: 'put' });
  });

  it('cuts a series of RDATEs only short after its DTSTART, not deleting it whole from its first RDATE', async () => {
    dav.put('home', 'ro.ics', ics(...vevent('UID:ro', 'DTSTART:20261019T130000Z', 'DTEND:20261019T140000Z', 'RDATE:20261022T130000Z,20261025T130000Z', 'SUMMARY:R')));
    const future = planDelete(await load('home/ro.ics#occ=2026-10-22T13:00:00Z'), 'futureEvents', env);
    expect(future.scope).toBe('this and all following occurrences');
    // What is left is its first occurrence, DTSTART, as a single event.
    const body = (future.op as { body: string }).body;
    expect(body).toContain('DTSTART:20261019T130000Z');
    expect(body).not.toContain('RDATE');
  });

  it('keeps an edit to DTSTART of a series of RDATEs only when the rest of it is cut away', async () => {
    dav.put('home', 'ro.ics', ics(...vevent('UID:ro', 'DTSTART:20261026T130000Z', 'DTEND:20261026T140000Z', 'RDATE:20261028T130000Z,20261030T130000Z', 'SUMMARY:Checkup')));
    const moved = await update('home/ro.ics#occ=2026-10-26T13:00:00Z', { startDate: '2026-10-26T15:00', title: 'Checkup (moved)' });
    dav.put('home', 'ro.ics', moved.puts[0]!.body);
    // Deleting "this and following" from the second: the moved first one stays moved.
    const cut = planDelete(await load('home/ro.ics#occ=2026-10-28T13:00:00Z'), 'futureEvents', env);
    const left = eventParts(parseCalendar((cut.op as { body: string }).body, 't'));
    expect(expandSeries(left, { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z'), zone: NY }).occurrences.map((o) => [o.occ, o.start.toISOString(), textProp(o.comp, 'summary')])).toEqual([
      ['2026-10-26T13:00:00Z', '2026-10-26T19:00:00.000Z', 'Checkup (moved)'],
    ]);
    // Splitting there: the same, in the original half.
    const split = await update('home/ro.ics#occ=2026-10-28T13:00:00Z', { span: 'futureEvents', title: 'Later' });
    expect(keysOf(split.puts[1]!.body)).toEqual(['2026-10-28T13:00:00Z', '2026-10-30T13:00:00Z']);
    const first = eventParts(parseCalendar(split.puts[0]!.body, 't'));
    expect(expandSeries(first, { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z'), zone: NY }).occurrences.map((o) => textProp(o.comp, 'summary'))).toEqual(['Checkup (moved)']);
  });

  it('cuts DTSTART of a series of RDATEs only when an RDATE comes before it, on the right side of a split', async () => {
    // Listed 10-15, 10-19 (DTSTART), 10-22.
    dav.put('home', 'g.ics', ics(...vevent('UID:g', 'DTSTART:20261019T130000Z', 'DTEND:20261019T140000Z', 'RDATE:20261015T130000Z,20261022T130000Z', 'SUMMARY:G')));
    const fromStart = planDelete(await load('home/g.ics#occ=2026-10-19T13:00:00Z'), 'futureEvents', env);
    expect(keysOf((fromStart.op as { body: string }).body)).toEqual(['2026-10-15T13:00:00Z']);
    const split = await update('home/g.ics#occ=2026-10-19T13:00:00Z', { span: 'futureEvents', title: 'Renamed' });
    expect(keysOf(split.puts[0]!.body)).toEqual(['2026-10-15T13:00:00Z']);
    expect(keysOf(split.puts[1]!.body)).toEqual(['2026-10-19T13:00:00Z', '2026-10-22T13:00:00Z']);
    // From an RDATE before DTSTART: DTSTART goes too, and into the new series on a split.
    dav.put('home', 'h.ics', ics(...vevent('UID:h', 'DTSTART:20261019T130000Z', 'DTEND:20261019T140000Z', 'RDATE:20261013T130000Z,20261015T130000Z,20261022T130000Z', 'SUMMARY:H')));
    const fromEarlier = planDelete(await load('home/h.ics#occ=2026-10-15T13:00:00Z'), 'futureEvents', env);
    expect(keysOf((fromEarlier.op as { body: string }).body)).toEqual(['2026-10-13T13:00:00Z']);
    const early = await update('home/h.ics#occ=2026-10-15T13:00:00Z', { span: 'futureEvents', title: 'X' });
    expect(keysOf(early.puts[0]!.body)).toEqual(['2026-10-13T13:00:00Z']);
    expect(keysOf(early.puts[1]!.body)).toEqual(['2026-10-15T13:00:00Z', '2026-10-19T13:00:00Z', '2026-10-22T13:00:00Z']);
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

  it('futureEvents at an RDATE ends the series there without extending its rule', async () => {
    // Weekly COUNT=3 (Oct 5, 12, 19) plus an RDATE on Wed Nov 4: rewriting COUNT as an UNTIL before Nov 4 would ADD
    // Oct 26 and Nov 2 to a series being cut short.
    dav.put(
      'home',
      'r.ics',
      ics(...NY_TZ, ...vevent('UID:r', 'DTSTART;TZID=America/New_York:20261005T090000', 'DTEND;TZID=America/New_York:20261005T100000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'RDATE;TZID=America/New_York:20261104T090000', 'SUMMARY:R')),
    );
    const past = planDelete(await load('home/r.ics#occ=2026-11-04T14:00:00Z'), 'futureEvents', env);
    expect((past.op as { body: string }).body).toContain('RRULE:FREQ=WEEKLY;COUNT=3');
    expect(keysOf((past.op as { body: string }).body)).toEqual(['2026-10-05T13:00:00Z', '2026-10-12T13:00:00Z', '2026-10-19T13:00:00Z']);
    // An RDATE among rule occurrences: the rule ends before it, so the later ones go too.
    dav.put(
      'home',
      'm.ics',
      ics(...NY_TZ, ...vevent('UID:m', 'DTSTART;TZID=America/New_York:20261005T090000', 'DTEND;TZID=America/New_York:20261005T100000', 'RRULE:FREQ=WEEKLY;COUNT=6', 'RDATE;TZID=America/New_York:20261014T090000', 'SUMMARY:M')),
    );
    const mid = planDelete(await load('home/m.ics#occ=2026-10-14T13:00:00Z'), 'futureEvents', env);
    expect(keysOf((mid.op as { body: string }).body)).toEqual(['2026-10-05T13:00:00Z', '2026-10-12T13:00:00Z']);
  });

  it('refuses to rewrite an event that already holds a raw CR (thisEvent / futureEvents), writing nothing', async () => {
    dav.put(
      'work',
      'cr.ics',
      ics(...NY_TZ, ...vevent('UID:cr', 'DTSTART;TZID=America/New_York:20261019T090000', 'DTEND;TZID=America/New_York:20261019T091500', 'RRULE:FREQ=DAILY;COUNT=10', 'SUMMARY:Standup\rATTENDEE:mailto:victim@x.com')),
    );
    for (const span of ['thisEvent', 'futureEvents'] as const) {
      const loaded = await load('work/cr.ics#occ=2026-10-22T13:00:00Z');
      expect(() => planDelete(loaded, span, env)).toThrow(InvalidArgumentError);
      expect(() => planDelete(loaded, span, env)).toThrow(/already stored in the event/);
    }
    // The whole series is a plain DELETE, with no body to check.
    expect(planDelete(await load('work/cr.ics'), 'allEvents', env).op.kind).toBe('delete');
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
