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

  describe('an occurrence at a time a DST change skips', () => {
    // Daily at 02:30, New York: on 2027-03-14 02:30 does not exist. ical.js reads it as 06:30Z, whose true wall time
    // is 01:30 — so rebuilding the value through its instant turned 02:30 into 01:30.
    const daily = (...extra: string[]) =>
      dav.put('home', 'gap.ics', ics(...NY_TZ, ...vevent('UID:gap', 'DTSTART;TZID=America/New_York:20270310T023000', 'DTEND;TZID=America/New_York:20270310T030000', 'RRULE:FREQ=DAILY;COUNT=10', 'SUMMARY:Pill', ...extra)));
    const DAY = 'home/gap.ics#occ=2027-03-14T06:30:00Z';

    it('keeps the value on a split, a single edit and a single delete there', async () => {
      daily();
      const split = await update(DAY, { span: 'futureEvents', title: 'Pill v2' });
      expect(split.puts[1]!.body).toContain('DTSTART;TZID=America/New_York:20270314T023000');
      const one = await update(DAY, { title: 'Pill (changed)' });
      expect(one.puts[0]!.body).toContain('RECURRENCE-ID;TZID=America/New_York:20270314T023000');
      expect(one.puts[0]!.body).toContain('DTSTART;TZID=America/New_York:20270314T023000');
      const gone = planDelete(await load(DAY), 'thisEvent', env);
      expect((gone.op as { body: string }).body).toContain('EXDATE;TZID=America/New_York:20270314T023000');
    });

    it('moves its override, its exclusion and the series by wall clock, also through that occurrence', async () => {
      daily('EXDATE;TZID=America/New_York:20270316T023000');
      dav.put('home', 'gap.ics', dav.get('home', 'gap.ics')!.ics.replace('END:VCALENDAR', ['BEGIN:VEVENT', 'UID:gap', 'RECURRENCE-ID;TZID=America/New_York:20270314T023000', 'DTSTART;TZID=America/New_York:20270314T090000', 'DTEND;TZID=America/New_York:20270314T093000', 'SUMMARY:Pill late', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')));
      const later = await update('home/gap.ics#occ=2027-03-10T07:30:00Z', { span: 'allEvents', startDate: '2027-03-10T03:30' });
      expect(later.puts[0]!.body).toContain('RECURRENCE-ID;TZID=America/New_York:20270314T033000');
      expect(later.puts[0]!.body).toContain('EXDATE;TZID=America/New_York:20270316T033000');
      const through = await update(DAY, { span: 'allEvents', startDate: '2027-03-14T04:00' });
      expect(through.puts[0]!.body).toContain('DTSTART;TZID=America/New_York:20270310T040000');
    });

    it('splits a Santiago series whose clocks jump at midnight on that Sunday', async () => {
      const santiago = 'America/Santiago';
      dav.put('home', 'cl.ics', ics(...vevent('UID:cl', 'DTSTART;TZID=America/Santiago:20270103T000000', 'DTEND;TZID=America/Santiago:20270103T010000', 'RRULE:FREQ=WEEKLY;BYDAY=SU', 'SUMMARY:C')));
      const loaded = await loadEvent(dav.context(), 'home/cl.ics#occ=2027-09-05T03:00:00Z', santiago);
      const split = planUpdate(loaded, { span: 'futureEvents', title: 'C2' }, { ...env, zone: santiago });
      expect(split.puts[1]!.body).toContain('DTSTART;TZID=America/Santiago:20270905T000000');
    });
  });

  it('moves the rule by the days DTSTART moves, not those of an RDATE at another time of day', async () => {
    // Every day at 09:00 plus a one-off at 23:30; everything an hour later, asked through the one-off (to 00:30).
    dav.put(
      'home',
      't3.ics',
      ics(...NY_TZ, ...vevent('UID:t3', 'DTSTART;TZID=America/New_York:20260105T090000', 'DTEND;TZID=America/New_York:20260105T093000', 'RRULE:FREQ=DAILY', 'RDATE;TZID=America/New_York:20260105T233000', 'EXDATE;VALUE=DATE:20270601', 'SUMMARY:T')),
    );
    const p = await update('home/t3.ics#occ=2026-01-06T04:30:00Z', { span: 'allEvents', startDate: '2026-01-06T00:30' });
    expect(p.puts[0]!.body).toContain('DTSTART;TZID=America/New_York:20260105T100000');
    expect(p.puts[0]!.body).toContain('EXDATE;VALUE=DATE:20270601');
    // Mondays plus a Wednesday 23:30, moved through the Wednesday to Thursday 00:30: still Mondays.
    dav.put(
      'home',
      't2.ics',
      ics(...NY_TZ, ...vevent('UID:t2', 'DTSTART;TZID=America/New_York:20261019T090000', 'DTEND;TZID=America/New_York:20261019T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4', 'RDATE;TZID=America/New_York:20261021T233000', 'SUMMARY:W')),
    );
    const w = await update('home/t2.ics#occ=2026-10-22T03:30:00Z', { span: 'allEvents', startDate: '2026-10-22T00:30' });
    expect(w.puts[0]!.body).toContain('RRULE:FREQ=WEEKLY;COUNT=4;BYDAY=MO');
    expect(w.puts[0]!.body).toContain('DTSTART;TZID=America/New_York:20261019T100000');
  });

  it('knows which occurrence comes first when the walk does not (floating DTSTART, an earlier UTC RDATE)', async () => {
    // DTSTART 09:00 floating is 13:00Z in New York; the RDATE at 10:00Z the same day comes first.
    dav.put('home', 'fl.ics', ics(...vevent('UID:fl', 'DTSTART:20261021T090000', 'DTEND:20261021T093000', 'RRULE:FREQ=DAILY;COUNT=3', 'RDATE:20261021T100000Z', 'SUMMARY:F')));
    const future = planDelete(await load('home/fl.ics#occ=2026-10-21T13:00:00Z'), 'futureEvents', env);
    expect(future.scope).toBe('this and all following occurrences');
    expect(keysOf((future.op as { body: string }).body)).toEqual(['2026-10-21T10:00:00Z']);
  });

  it('deletes a DATE occurrence of a timed series for good', async () => {
    dav.put('home', 'd.ics', ics(...NY_TZ, ...vevent('UID:d', 'DTSTART;TZID=America/New_York:20261021T090000', 'DTEND;TZID=America/New_York:20261021T100000', 'RRULE:FREQ=WEEKLY;COUNT=2', 'RDATE;VALUE=DATE:20261023', 'SUMMARY:D')));
    expect(keysOf(dav.get('home', 'd.ics')!.ics)).toEqual(['2026-10-21T13:00:00Z', '2026-10-23', '2026-10-28T13:00:00Z']);
    const one = planDelete(await load('home/d.ics#occ=2026-10-23'), 'thisEvent', env);
    expect(keysOf((one.op as { body: string }).body)).toEqual(['2026-10-21T13:00:00Z', '2026-10-28T13:00:00Z']);
  });

  it('does not repeat an RDATE the new series already has when a split carries DTSTART over', async () => {
    dav.put(
      'home',
      'y.ics',
      ics(...NY_TZ, ...vevent('UID:y', 'DTSTART;TZID=America/New_York:20261025T090000', 'DTEND;TZID=America/New_York:20261025T100000', 'RDATE;TZID=America/New_York:20261021T090000,20261023T090000,20261025T090000,20261027T090000', 'SUMMARY:Y')),
    );
    const split = await update('home/y.ics#occ=2026-10-23T13:00:00Z', { span: 'futureEvents', title: 'New' });
    expect(split.puts[1]!.body.match(/20261025T090000/g)).toHaveLength(1);
    expect(keysOf(split.puts[1]!.body)).toEqual(['2026-10-23T13:00:00Z', '2026-10-25T13:00:00Z', '2026-10-27T13:00:00Z']);
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
    const refusal = /some occurrences as time periods \(RDATE;VALUE=PERIOD\).*cannot retime, split or cut short\. Nothing was changed\./;
    await expect(update('home/per.ics#occ=2026-10-12T13:00:00Z', { span: 'allEvents', startDate: '2026-10-12T10:00' })).rejects.toThrow(refusal);
    await expect(update('home/per.ics#occ=2026-10-12T13:00:00Z', { span: 'allEvents', endDate: '2026-10-12T10:30', timeZone: 'Europe/Berlin' })).rejects.toThrow(refusal);
    // A new length too: the periods would keep theirs while the answer said "every occurrence".
    await expect(update('home/per.ics#occ=2026-10-12T13:00:00Z', { span: 'allEvents', endDate: '2026-10-12T10:30' })).rejects.toThrow(refusal);
    await expect(update('home/per.ics#occ=2026-10-14T13:00:00Z', { span: 'allEvents', endDate: '2026-10-14T09:30' })).rejects.toThrow(refusal);
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

  it('futureEvents at a UTC RDATE of a floating series ends its rule a second before that instant\'s wall time', async () => {
    dav.put('home', 'fr.ics', ics(...vevent('UID:fr', 'DTSTART:20261019T090000', 'DTEND:20261019T100000', 'RRULE:FREQ=DAILY;COUNT=5', 'RDATE:20261021T200000Z', 'SUMMARY:F')));
    const cut = planDelete(await load('home/fr.ics#occ=2026-10-21T20:00:00Z'), 'futureEvents', env);
    expect((cut.op as { body: string }).body).toContain('UNTIL=20261021T155959');
    expect(keysOf((cut.op as { body: string }).body)).toEqual(['2026-10-19T13:00:00Z', '2026-10-20T13:00:00Z', '2026-10-21T13:00:00Z']);
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

/** Each occurrence a written body expands to, with its length in minutes. */
const spansOf = (body: string, from = '2026-09-01', to = '2027-06-01') =>
  expandSeries(eventParts(parseCalendar(body, 't')), { from: new Date(`${from}T00:00:00Z`), to: new Date(`${to}T00:00:00Z`), zone: NY }).occurrences.map(
    (o) => `${o.occ} ${(o.end.getTime() - o.start.getTime()) / 60_000}`,
  );
const put = (name: string, ...lines: string[]) => dav.put('home', name, ics(...NY_TZ, ...vevent(...lines)));

describe('series times next to DST changes', () => {
  it('moves a series older than its VTIMEZONE\'s first observance keeping its length', async () => {
    // The library zone starts in 1970 and Apple's (NY_TZ) in 2007: ical.js reads a wall time before that at offset 0.
    dav.put('home', 'old.ics', ics(...vevent('UID:o', 'DTSTART;TZID=America/New_York:19690106T090000', 'DTEND;TZID=America/New_York:19690106T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'SUMMARY:O')));
    const lib = await update('home/old.ics#occ=2026-10-19T13:00:00Z', { span: 'allEvents', startDate: '2026-10-19T10:00' });
    expect(lib.puts[0]!.body).toContain('DTEND;TZID=America/New_York:19690106T110000');
    expect(spansOf(lib.puts[0]!.body, '2026-10-19', '2026-10-27')).toEqual(['2026-10-19T14:00:00Z 60', '2026-10-26T14:00:00Z 60']);
    put('old2.ics', 'UID:o2', 'DTSTART;TZID=America/New_York:20050103T090000', 'DTEND;TZID=America/New_York:20050103T100000', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'SUMMARY:O');
    const apple = await update('home/old2.ics#occ=2026-10-19T13:00:00Z', { span: 'allEvents', startDate: '2026-10-19T10:00' });
    expect(spansOf(apple.puts[0]!.body, '2026-10-19', '2026-10-27')).toEqual(['2026-10-19T14:00:00Z 60', '2026-10-26T14:00:00Z 60']);
  });

  it('keeps a series\' length when a split or a move puts its end on the repeated hour ical.js does not read', async () => {
    // Sundays 00:30–01:30: on 2026-11-01 the end is 01:30 EDT, whose wall time ical.js reads as 01:30 EST.
    put('w.ics', 'UID:w', 'DTSTART;TZID=America/New_York:20261004T003000', 'DTEND;TZID=America/New_York:20261004T013000', 'RRULE:FREQ=WEEKLY;BYDAY=SU', 'SUMMARY:W');
    const split = await update('home/w.ics#occ=2026-11-01T04:30:00Z', { span: 'futureEvents', location: 'Studio B' });
    expect(split.puts[1]!.body).toContain('DTEND:20261101T053000Z');
    expect(spansOf(split.puts[1]!.body, '2026-10-31', '2026-11-16')).toEqual(['2026-11-01T04:30:00Z 60', '2026-11-08T05:30:00Z 60', '2026-11-15T05:30:00Z 60']);
    put('d.ics', 'UID:d', 'DTSTART;TZID=America/New_York:20261031T003000', 'DTEND;TZID=America/New_York:20261031T013000', 'RRULE:FREQ=DAILY;COUNT=4', 'SUMMARY:D');
    const moved = await update('home/d.ics#occ=2026-10-31T04:30:00Z', { span: 'allEvents', startDate: '2026-11-01T00:30' });
    expect(spansOf(moved.puts[0]!.body).map((s) => s.split(' ')[1])).toEqual(['60', '60', '60', '60']);
    // An override that kept the series' length keeps it when the series moves onto that night.
    put('ov.ics', 'UID:ov', 'DTSTART;TZID=America/New_York:20261029T000000', 'DTEND;TZID=America/New_York:20261029T010000', 'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:V');
    const withOverride = dav.get('home', 'ov.ics')!.ics.replace('END:VCALENDAR', ['BEGIN:VEVENT', 'UID:ov', 'RECURRENCE-ID;TZID=America/New_York:20261101T000000', 'DTSTART;TZID=America/New_York:20261101T000000', 'DTEND:20261101T050000Z', 'SUMMARY:V2', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
    dav.put('home', 'ov.ics', withOverride);
    const all = await update('home/ov.ics#occ=2026-10-29T04:00:00Z', { span: 'allEvents', startDate: '2026-10-29T00:30' });
    expect(spansOf(all.puts[0]!.body).map((s) => s.split(' ')[1])).toEqual(['60', '60', '60', '60', '60']);
  });

  it('never makes a floating event, override or split zero-length in the repeated hour', async () => {
    dav.put('home', 'f.ics', ics(...vevent('UID:f', 'DTSTART:20261020T090000', 'DTEND:20261020T100000', 'SUMMARY:F')));
    for (const startDate of ['2026-11-01T01:30:00-05:00', '2026-11-01T01:30:00-04:00']) {
      const p = await update('home/f.ics', { startDate });
      const start = new Date(startDate).getTime();
      expect(p.result.occurrence.start.getTime()).toBe(start);
      expect(p.result.occurrence.end.getTime()).toBe(start + 3_600_000);
    }
    // A floating series is wall clock: 01:00–02:00 every day, which on the fall-back night is two hours. Its override
    // and a split keep those wall times, and a floating DTEND (never a UTC one next to a floating DTSTART).
    dav.put('home', 'fs.ics', ics(...vevent('UID:fs', 'DTSTART:20261029T010000', 'DTEND:20261029T020000', 'RRULE:FREQ=DAILY;COUNT=7', 'SUMMARY:S')));
    expect(spansOf(dav.get('home', 'fs.ics')!.ics, '2026-10-31', '2026-11-03')).toEqual(['2026-10-31T05:00:00Z 60', '2026-11-01T05:00:00Z 120', '2026-11-02T06:00:00Z 60']);
    const one = await update('home/fs.ics#occ=2026-11-01T05:00:00Z', { title: 'S2' });
    expect(one.puts[0]!.body).toContain('DTEND:20261101T020000\r\n');
    expect(spansOf(one.puts[0]!.body, '2026-11-01', '2026-11-02')).toEqual(['2026-11-01T05:00:00Z 120']);
    const split = await update('home/fs.ics#occ=2026-11-01T05:00:00Z', { span: 'futureEvents', title: 'S3' });
    expect(split.puts[1]!.body).toContain('DTEND:20261101T020000\r\n');
    expect(spansOf(split.puts[1]!.body).map((s) => s.split(' ')[1])).toEqual(['120', '60', '60', '60']);
  });

  it('names an RDATE on the unread pass of a repeated hour by its own value, so an edit replaces it and a delete removes it', async () => {
    // 05:30Z is 01:30 EDT, which as a New York wall time ical.js reads as 01:30 EST.
    put('r.ics', 'UID:r', 'DTSTART;TZID=America/New_York:20261025T090000', 'DTEND;TZID=America/New_York:20261025T100000', 'RRULE:FREQ=WEEKLY;COUNT=2', 'RDATE:20261101T053000Z', 'SUMMARY:Series');
    const edit = await update('home/r.ics#occ=2026-11-01T05:30:00Z', { title: 'Edited' });
    expect(edit.puts[0]!.body).toContain('RECURRENCE-ID:20261101T053000Z');
    expect(keysOf(edit.puts[0]!.body)).toEqual(['2026-10-25T13:00:00Z', '2026-11-01T05:30:00Z', '2026-11-01T14:00:00Z']);
    expect(edit.result.expected).toMatchObject({ title: 'Edited' });
    const gone = planDelete(await load('home/r.ics#occ=2026-11-01T05:30:00Z'), 'thisEvent', env);
    expect(keysOf((gone.op as { body: string }).body)).toEqual(['2026-10-25T13:00:00Z', '2026-11-01T14:00:00Z']);
  });

  describe('a series whose occurrence falls in a DST gap', () => {
    const gapSeries = () => put('g.ics', 'UID:g', 'DTSTART;TZID=America/New_York:20270310T023000', 'DTEND;TZID=America/New_York:20270310T030000', 'RRULE:FREQ=DAILY;COUNT=10', 'SUMMARY:Pill');
    const GAP = 'home/g.ics#occ=2027-03-14T06:30:00Z';

    it('gives an override or a split starting at the skipped time a DURATION, which every reader measures alike', async () => {
      gapSeries();
      const one = await update(GAP, { title: 'Pill (x)' });
      const ovr = one.puts[0]!.body.slice(one.puts[0]!.body.lastIndexOf('BEGIN:VEVENT'));
      expect(ovr).toContain('DTSTART;TZID=America/New_York:20270314T023000');
      expect(ovr).toContain('DURATION:PT30M');
      expect(ovr).not.toContain('DTEND');
      const split = await update(GAP, { span: 'futureEvents', title: 'Pill v2' });
      expect(split.puts[1]!.body).toContain('DURATION:PT30M');
      expect(spansOf(split.puts[1]!.body).map((s) => s.split(' ')[1])).toEqual(['30', '30', '30', '30', '30', '30']);
    });

    it('moves the series through its bare id by DTSTART\'s own wall time', async () => {
      put('b.ics', 'UID:b', 'DTSTART;TZID=America/New_York:20270314T023000', 'DTEND;TZID=America/New_York:20270314T033000', 'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:B');
      const later = await update('home/b.ics', { span: 'allEvents', startDate: '2027-03-14T04:00' });
      expect(later.puts[0]!.body).toContain('DTSTART;TZID=America/New_York:20270314T040000');
      const next = await update('home/b.ics', { span: 'allEvents', startDate: '2027-03-15T02:30' });
      expect(next.puts[0]!.body).toContain('DTSTART;TZID=America/New_York:20270315T023000');
      put('wk.ics', 'UID:wk', 'DTSTART;TZID=America/New_York:20270314T020000', 'DTEND;TZID=America/New_York:20270314T030000', 'RRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=4', 'SUMMARY:K');
      expect((await update('home/wk.ics', { span: 'allEvents', startDate: '2027-03-14T03:00' })).puts[0]!.body).toContain('DTSTART;TZID=America/New_York:20270314T030000');
      expect((await update('home/wk.ics', { span: 'allEvents', startDate: '2027-03-14T01:00' })).puts[0]!.body).toContain('DTSTART;TZID=America/New_York:20270314T010000');
      // Santiago skips midnight: a Sunday series from that Sunday, moved to 02:00.
      const santiago = 'America/Santiago';
      dav.put('home', 'cl.ics', ics(...vevent('UID:cl', 'DTSTART;TZID=America/Santiago:20260906T000000', 'DTEND;TZID=America/Santiago:20260906T010000', 'RRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=3', 'SUMMARY:C')));
      const cl = planUpdate(await loadEvent(dav.context(), 'home/cl.ics', santiago), { span: 'allEvents', startDate: '2026-09-06T02:00' }, { ...env, zone: santiago });
      expect(cl.puts[0]!.body).toContain('DTSTART;TZID=America/Santiago:20260906T020000');
    });

    it('changes the series\' zone through that occurrence keeping the instants of the others', async () => {
      gapSeries();
      // 02:30 New York is 01:30 Chicago on every other day (both zones change at 2 AM local, an hour apart).
      const chicago = 'America/Chicago';
      const input = { span: 'allEvents' as const, endDate: '2027-03-14T01:15', timeZone: chicago };
      const p = planUpdate(await loadEvent(dav.context(), GAP, chicago), input, { ...env, zone: chicago });
      expect(p.puts[0]!.body).toContain('DTSTART;TZID=America/Chicago:20270310T013000');
    });

    it('refuses to start or move a series to a wall time the clocks skip', async () => {
      gapSeries();
      await expect(update('home/g.ics#occ=2027-03-10T07:30:00Z', { span: 'allEvents', startDate: '2027-03-14T02:45' })).rejects.toThrow(/does not exist that day in America\/New_York/);
      await expect(update('home/g.ics#occ=2027-03-12T07:30:00Z', { span: 'futureEvents', startDate: '2027-03-14T02:45' })).rejects.toThrow(/does not exist that day/);
      // A single occurrence may: it is one instant, where the clocks put it (03:45 EDT).
      const one = await update('home/g.ics#occ=2027-03-12T07:30:00Z', { startDate: '2027-03-14T02:45' });
      expect(one.result.occurrence.start.toISOString()).toBe('2027-03-14T07:45:00.000Z');
    });

    it('ends a floating series just before its skipped-time occurrence by that occurrence\'s own wall time', async () => {
      dav.put('home', 'fg.ics', ics(...vevent('UID:fg', 'DTSTART:20270311T023000', 'DTEND:20270311T030000', 'RRULE:FREQ=DAILY;COUNT=7', 'SUMMARY:F')));
      const at = 'home/fg.ics#occ=2027-03-14T07:30:00Z';
      const split = await update(at, { span: 'futureEvents', title: 'F2' });
      expect(split.puts[0]!.body).toContain('UNTIL=20270314T022959');
      expect(keysOf(split.puts[0]!.body)).not.toContain('2027-03-14T07:30:00Z');
      expect(keysOf(split.puts[1]!.body)[0]).toBe('2027-03-14T07:30:00Z');
      const cut = planDelete(await load(at), 'futureEvents', env);
      expect(keysOf((cut.op as { body: string }).body)).toEqual(['2027-03-11T07:30:00Z', '2027-03-12T07:30:00Z', '2027-03-13T07:30:00Z']);
    });
  });

  it('measures a floating series\' length in wall clock, so a move from a skipped time keeps it', async () => {
    // 02:30–03:30 on the spring-forward day reads as zero length in New York (both walls land on 03:30 EDT), but the
    // series lasts an hour on every other day, and wherever it is read.
    dav.put('home', 'fg2.ics', ics(...vevent('UID:fg2', 'DTSTART:20270314T023000', 'DTEND:20270314T033000', 'RRULE:FREQ=DAILY;COUNT=4', 'SUMMARY:F')));
    const p = await update('home/fg2.ics', { span: 'allEvents', startDate: '2027-03-14T04:00' });
    expect(p.puts[0]!.body).toContain('DTSTART:20270314T040000\r\nDTEND:20270314T050000\r\n');
    // A new end given on the fall-back night whose wall time comes before the start's (01:15 EST after 01:30 EDT):
    // the time between them, as a wall length from the start.
    dav.put('home', 'fe.ics', ics(...vevent('UID:fe', 'DTSTART:20261029T013000', 'DTEND:20261029T023000', 'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:F')));
    const end = await update('home/fe.ics#occ=2026-11-01T05:30:00Z', { span: 'allEvents', endDate: '2026-11-01T01:15:00-05:00' });
    expect(end.puts[0]!.body).toContain('DTSTART:20261029T013000\r\nDTEND:20261029T021500\r\n');
    // On any other day the wall length is the length asked for.
    const plain = await update('home/fe.ics#occ=2026-10-29T05:30:00Z', { span: 'allEvents', endDate: '2026-10-29T02:00' });
    expect(plain.puts[0]!.body).toContain('DTSTART:20261029T013000\r\nDTEND:20261029T020000\r\n');
  });

  it('moves an UNTIL written another way than the series by the bound ical.js compares, keeping the last occurrence', async () => {
    // Floating 20:00 daily bounded by a UTC UNTIL (compared by its fields), 540 instances: past the check's sample.
    dav.put('home', 'u1.ics', ics(...vevent('UID:u1', 'DTSTART:20270104T200000', 'DTEND:20270104T210000', 'RRULE:FREQ=DAILY;UNTIL=20280630T235959Z', 'SUMMARY:U')));
    const later = await update('home/u1.ics', { span: 'allEvents', startDate: '2027-01-05T20:00' });
    expect(later.puts[0]!.body).toContain('RRULE:FREQ=DAILY;UNTIL=20280701T235959\r\n');
    // Its last occurrence moves with it, to Jul 1 20:00 (00:00Z the next day).
    expect(keysOf(later.puts[0]!.body, '2028-06-29', '2028-07-05').at(-1)).toBe('2028-07-02T00:00:00Z');
    // Zoned 21:00 daily bounded by a floating UNTIL (compared as 21:00 UTC, so it ends 08-22): an hour later, still 08-22.
    put('u2.ics', 'UID:u2', 'DTSTART;TZID=America/New_York:20270101T210000', 'DTEND;TZID=America/New_York:20270101T220000', 'RRULE:FREQ=DAILY;UNTIL=20280823T210000', 'SUMMARY:U');
    const lastBefore = keysOf(dav.get('home', 'u2.ics')!.ics, '2028-08-20', '2028-08-26').at(-1);
    expect(lastBefore).toBe('2028-08-23T01:00:00Z');
    const hour = await update('home/u2.ics', { span: 'allEvents', startDate: '2027-01-01T22:00' });
    expect(hour.puts[0]!.body).toContain('UNTIL=20280823T220000Z');
    expect(keysOf(hour.puts[0]!.body, '2028-08-20', '2028-08-26').at(-1)).toBe('2028-08-23T02:00:00Z');
  });

  it('changes the zone of a series starting at a skipped time without moving it, where the new zone skips the same hour', async () => {
    const zoneOnly = async (zoneName: string, id: string) => planUpdate(await loadEvent(dav.context(), id, zoneName), { span: 'allEvents', endDate: '2027-03-14T03:30', timeZone: zoneName }, { ...env, zone: zoneName });
    put('tor.ics', 'UID:tor', 'DTSTART;TZID=America/New_York:20270314T023000', 'DTEND;TZID=America/New_York:20270314T033000', 'RRULE:FREQ=DAILY;COUNT=4', 'SUMMARY:T');
    expect((await zoneOnly('America/Toronto', 'home/tor.ics')).puts[0]!.body).toContain('DTSTART;TZID=America/Toronto:20270314T023000');
    put('tor2.ics', 'UID:tor2', 'DTSTART;TZID=America/New_York:20270312T023000', 'DTEND;TZID=America/New_York:20270312T033000', 'RRULE:FREQ=DAILY;COUNT=6', 'SUMMARY:T');
    expect((await zoneOnly('America/Toronto', 'home/tor2.ics#occ=2027-03-14T06:30:00Z')).puts[0]!.body).toContain('DTSTART;TZID=America/Toronto:20270312T023000');
    dav.put('home', 'ber.ics', ics(...vevent('UID:ber', 'DTSTART;TZID=Europe/Berlin:20270328T023000', 'DTEND;TZID=Europe/Berlin:20270328T033000', 'RRULE:FREQ=WEEKLY;COUNT=4', 'SUMMARY:B')));
    const paris = planUpdate(await loadEvent(dav.context(), 'home/ber.ics', 'Europe/Paris'), { span: 'allEvents', endDate: '2027-03-28T03:30', timeZone: 'Europe/Paris' }, { ...env, zone: 'Europe/Paris' });
    expect(paris.puts[0]!.body).toContain('DTSTART;TZID=Europe/Paris:20270328T023000');
  });

  it('keeps a UTC RDATE on the first pass of the repeated hour where it is when the series changes', async () => {
    put('fp.ics', 'UID:fp', 'DTSTART;TZID=America/New_York:20261028T013000', 'DTEND;TZID=America/New_York:20261028T023000', 'RRULE:FREQ=WEEKLY;COUNT=2', 'RDATE:20261101T053000Z', 'SUMMARY:P');
    const longer = await update('home/fp.ics#occ=2026-10-28T05:30:00Z', { span: 'allEvents', endDate: '2026-10-28T03:00' });
    expect(longer.puts[0]!.body).toContain('RDATE:20261101T053000Z');
    expect(keysOf(longer.puts[0]!.body, '2026-10-27', '2026-11-06')).toEqual(['2026-10-28T05:30:00Z', '2026-11-01T05:30:00Z', '2026-11-04T06:30:00Z']);
    // A day later: 01:30 EDT on 11-02 does not exist twice, so it takes the series' zone.
    const day = await update('home/fp.ics#occ=2026-10-28T05:30:00Z', { span: 'allEvents', startDate: '2026-10-29T01:30' });
    expect(day.puts[0]!.body).toContain('RDATE;TZID=America/New_York:20261102T013000');
  });

  it('says when a series moved by an explicit offset starts on the other pass of a repeated hour', async () => {
    put('n.ics', 'UID:n', 'DTSTART;TZID=America/New_York:20261029T090000', 'DTEND;TZID=America/New_York:20261029T100000', 'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:N');
    const p = await update('home/n.ics#occ=2026-11-01T14:00:00Z', { span: 'allEvents', startDate: '2026-11-01T01:30:00-04:00' });
    expect(p.notes).toEqual([expect.stringMatching(/^This occurrence is now at Sun, Nov 1, 2026, 1:30 AM EST, not .*1:30 AM EDT: that wall-clock time comes twice/)]);
    // Not for an override: its own start is written exactly where it was asked.
    const edited = await update('home/n.ics#occ=2026-11-01T14:00:00Z', { title: 'N2' });
    dav.put('home', 'n.ics', edited.puts[0]!.body);
    const through = await update('home/n.ics#occ=2026-11-01T14:00:00Z', { span: 'allEvents', startDate: '2026-11-01T01:30:00-04:00' });
    expect(through.notes).toEqual([]);
    expect(through.result.occurrence.start.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    // Nor for a time given with a fraction of a second.
    const frac = await update('home/n.ics#occ=2026-10-29T13:00:00Z', { span: 'allEvents', startDate: '2026-10-29T10:00:00.250' });
    expect(frac.notes).toEqual([]);
  });
});

describe('all-day dates in a timed series (RDATE;VALUE=DATE)', () => {
  it('deletes the occurrence at 8 PM whose instant is midnight UTC, keeping the all-day date', async () => {
    put('p1.ics', 'UID:p1', 'DTSTART;TZID=America/New_York:20261021T200000', 'DTEND;TZID=America/New_York:20261021T210000', 'RRULE:FREQ=DAILY;COUNT=5', 'RDATE;VALUE=DATE:20261023', 'SUMMARY:P');
    const gone = planDelete(await load('home/p1.ics#occ=2026-10-23T00:00:00Z'), 'thisEvent', env);
    expect(keysOf((gone.op as { body: string }).body)).toEqual(['2026-10-22T00:00:00Z', '2026-10-23', '2026-10-24T00:00:00Z', '2026-10-25T00:00:00Z', '2026-10-26T00:00:00Z']);
  });

  it('deletes an all-day date by its midnight in the series\' zone, and refuses when that is also a timed occurrence', async () => {
    put('d2.ics', 'UID:d2', 'DTSTART;TZID=America/New_York:20261021T090000', 'DTEND;TZID=America/New_York:20261021T100000', 'RRULE:FREQ=WEEKLY;COUNT=2', 'RDATE;VALUE=DATE:20261023', 'SUMMARY:D');
    const one = planDelete(await load('home/d2.ics#occ=2026-10-23'), 'thisEvent', env);
    expect((one.op as { body: string }).body).toContain('EXDATE;TZID=America/New_York:20261023T000000');
    put('m.ics', 'UID:m', 'DTSTART;TZID=America/New_York:20261021T000000', 'DTEND;TZID=America/New_York:20261021T003000', 'RRULE:FREQ=DAILY;COUNT=5', 'RDATE;VALUE=DATE:20261023', 'SUMMARY:M');
    await expect(load('home/m.ics#occ=2026-10-23').then((l) => planDelete(l, 'thisEvent', env))).rejects.toThrow(
      /cannot be deleted on its own: the exclusion \(EXDATE\) that removes it also matches 2026-10-23T04:00:00Z — another occurrence on the same date, or at the same midnight/,
    );
  });

  it('refuses a delete whose exclusion also matches another occurrence, however dense the series', async () => {
    // Every minute for four days, plus an all-day date: thousands of instances next to the one deleted.
    put('dm.ics', 'UID:dm', 'DTSTART;TZID=America/New_York:20261021T000000', 'DURATION:PT1M', 'RRULE:FREQ=MINUTELY;UNTIL=20261025T000000Z', 'RDATE;VALUE=DATE:20261023', 'SUMMARY:M');
    await expect(load('home/dm.ics#occ=2026-10-23').then((l) => planDelete(l, 'thisEvent', env))).rejects.toThrow(/also matches 2026-10-23T04:00:00Z/);
    // An all-day series with a timed RDATE: a DATE exclusion removes every instance on its date.
    dav.put('home', 'at.ics', ics(...NY_TZ, ...vevent('UID:at', 'DTSTART;VALUE=DATE:20261019', 'DTEND;VALUE=DATE:20261020', 'RRULE:FREQ=DAILY;COUNT=7', 'RDATE;TZID=America/New_York:20261022T150000', 'SUMMARY:A')));
    await expect(load('home/at.ics#occ=2026-10-22').then((l) => planDelete(l, 'thisEvent', env))).rejects.toThrow(
      /also matches 2026-10-22T19:00:00Z — another occurrence on the same date, or at the same midnight/,
    );
    // Only a series mixing the two kinds is checked; a plain one deletes as before.
    const plain = planDelete(await load('work/s.ics#occ=2026-10-22T13:00:00Z'), 'thisEvent', env);
    expect(plain.scope).toBe('this occurrence only');
  });

  it('refuses to edit one alone, split at one, or move the series through one (fields through it are fine)', async () => {
    put('d3.ics', 'UID:d3', 'DTSTART;TZID=America/New_York:20261021T090000', 'DTEND;TZID=America/New_York:20261021T100000', 'RRULE:FREQ=WEEKLY;COUNT=2', 'RDATE;VALUE=DATE:20261023', 'SUMMARY:D');
    const id = 'home/d3.ics#occ=2026-10-23';
    await expect(update(id, { title: 'X' })).rejects.toThrow(/an all-day date added to a timed series \(an RDATE\), so it cannot be changed on its own/);
    put('d4.ics', 'UID:d4', 'DTSTART;TZID=America/New_York:20261021T090000', 'DTEND;TZID=America/New_York:20261021T100000', 'RDATE;VALUE=DATE:20261023', 'RDATE;TZID=America/New_York:20261025T090000', 'SUMMARY:D');
    await expect(update('home/d4.ics#occ=2026-10-23', { span: 'futureEvents', title: 'N' })).rejects.toThrow(/so a new series cannot start at it/);
    await expect(update(id, { span: 'allEvents', startDate: '2026-10-24T10:00' })).rejects.toThrow(/the series cannot be moved through it/);
    expect((await update(id, { span: 'allEvents', title: 'All' })).puts[0]!.body).toContain('SUMMARY:All');
    // An all-day series with a timed RDATE: the same, the other way round.
    dav.put('home', 't.ics', ics(...NY_TZ, ...vevent('UID:t', 'DTSTART;VALUE=DATE:20261021', 'RRULE:FREQ=WEEKLY;COUNT=2', 'RDATE;TZID=America/New_York:20261023T090000', 'SUMMARY:T')));
    await expect(update('home/t.ics#occ=2026-10-23T13:00:00Z', { title: 'X' })).rejects.toThrow(/a timed one added to an all-day series/);
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
