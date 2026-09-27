import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppleToolError, CredentialsRejectedError, InvalidArgumentError, UpstreamError } from '../../src/errors.js';
import { listCalendars } from '../../src/calendar/caldav.js';
import { assertOffset, collectOccurrences, compareRows, loadEvent, type Row } from '../../src/calendar/events.js';
import { textProp } from '../../src/calendar/ics.js';
import { resolveWindow } from '../../src/calendar/window.js';
import { FakeCalDav, NOW, NY_TZ, ics, vevent } from './fake-caldav.js';

const NY = 'America/New_York';
let dav: FakeCalDav;

beforeEach(() => {
  dav = new FakeCalDav().install();
  dav.addCalendar({ id: 'home', name: 'Home' }).addCalendar({ id: 'work', name: 'Work' });
});

const win = (args: { fromDate?: string; daysAhead?: number } = {}) => resolveWindow(args, { zone: NY, now: NOW, defaultDays: 7, maxDays: 366 });

async function collect(opts: { strict?: boolean } = {}, w = win()) {
  const ctx = dav.context();
  const { calendars } = await listCalendars(ctx);
  return collectOccurrences(ctx, calendars, w, opts);
}

describe('collectOccurrences', () => {
  it('expands every calendar, sorted by start, title, then id', async () => {
    dav.put('home', 'b.ics', ics(...vevent('UID:b', 'DTSTART:20261021T130000Z', 'SUMMARY:Beta')));
    dav.put('home', 'a.ics', ics(...vevent('UID:a', 'DTSTART:20261021T130000Z', 'SUMMARY:Alpha')));
    dav.put('work', 'z.ics', ics(...vevent('UID:z', 'DTSTART:20261021T130000Z')));
    dav.put('work', 'y.ics', ics(...vevent('UID:y', 'DTSTART:20261021T130000Z')));
    dav.put('work', 's.ics', ics(...vevent('UID:s', 'DTSTART:20261020T130000Z', 'RRULE:FREQ=DAILY;COUNT=2', 'SUMMARY:Daily')));
    dav.put('work', 'todo.ics', ics('BEGIN:VTODO', 'UID:t', 'END:VTODO'));
    const r = await collect();
    expect(r.complete).toBe(true);
    expect(r.failed).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(r.rows.map((x) => `${x.baseId}${x.occurrence.occ ? '#' + x.occurrence.occ : ''}`)).toEqual([
      'work/s.ics#2026-10-20T13:00:00Z',
      'work/y.ics',
      'work/z.ics',
      'home/a.ics',
      'home/b.ics',
      'work/s.ics#2026-10-21T13:00:00Z',
    ]);
  });

  it('reports unreadable resources and truncated series instead of hiding them', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dav.put('home', 'bad.ics', 'not ical at all');
    dav.put('home', 'hourly.ics', ics(...vevent('UID:h', 'DTSTART:20261020T000000Z', 'RRULE:FREQ=HOURLY', 'SUMMARY:Ping')));
    dav.put('work', 'inv.ics', ics(...vevent('UID:i', 'RECURRENCE-ID:20261021T000000Z', 'DTSTART:20261021T000000Z', 'RRULE:FREQ=HOURLY')));
    const r = await collect({}, win({ daysAhead: 366 }));
    expect(r.complete).toBe(false);
    expect(r.notes).toEqual([
      '"Ping" repeats more than 1000 times in this window; only the first 1000 are included.',
      '1 event(s) in "Home" could not be read (malformed iCalendar) and are not listed.',
    ]);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/not valid iCalendar/));
    expect(r.rows.filter((x) => x.baseId === 'home/hourly.ics')).toHaveLength(1000);
  });

  it('keeps listing everything else when one series has a rule that cannot be walked, and says so', async () => {
    // Would spin forever inside ical.js (no day ever matches), and arrives in someone else's invitation.
    dav.put('home', 'evil.ics', ics(...vevent('UID:e', 'DTSTART:20261021T130000Z', 'RRULE:FREQ=DAILY;BYMONTH=4;BYMONTHDAY=31', 'SUMMARY:Invite')));
    dav.put('work', 'ok.ics', ics(...vevent('UID:k', 'DTSTART:20261022T130000Z', 'SUMMARY:Fine')));
    const r = await collect();
    expect(r.complete).toBe(false);
    expect(r.notes).toEqual([
      '"Invite" repeats by a rule that cannot be expanded (BYMONTH and BYMONTHDAY name a day that never occurs); only its first occurrence and any individually changed ones are listed, so later occurrences may be MISSING.',
    ]);
    expect(r.rows.map((x) => x.baseId)).toEqual(['home/evil.ics', 'work/ok.ics']);
  });

  it('says when iCloud cut a calendar\'s results short, and calls the answer incomplete', async () => {
    dav.put('home', 'a.ics', ics(...vevent('UID:a', 'DTSTART:20261021T130000Z', 'SUMMARY:A')));
    dav.hooks.push((method, url) => {
      if (method !== 'REPORT' || !url.includes('/home/')) return undefined;
      return {
        status: 207,
        body:
          `<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><response><href>${new URL(url).pathname}</href>` +
          '<status>HTTP/1.1 507 Insufficient Storage</status></response></multistatus>',
      };
    });
    const r = await collect();
    expect(r.complete).toBe(false);
    expect(r.notes).toEqual(['iCloud cut the results for "Home" short (too many matches); some of its events in this window are MISSING. Query a shorter window.']);
  });

  it('counts an event whose times cannot be computed as unreadable, not as a failed listing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Year 0000 parses as iCalendar but has no calendar date to put it on.
    dav.put('home', 'y0.ics', ics(...vevent('UID:y', 'DTSTART;VALUE=DATE:00000101', 'RRULE:FREQ=YEARLY')));
    dav.put('work', 'ok.ics', ics(...vevent('UID:k', 'DTSTART:20261022T130000Z', 'SUMMARY:Fine')));
    const r = await collect();
    expect(r.notes).toEqual(['1 event(s) in "Home" could not be read (malformed iCalendar) and are not listed.']);
    expect(r.rows.map((x) => x.baseId)).toEqual(['work/ok.ics']);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/an event in "Home" could not be read: .*is not a calendar date/));
  });

  it('reports a series it could not walk to the window', async () => {
    dav.put('home', 'old.ics', ics(...vevent('UID:o', 'DTSTART:20260901T000000Z', 'RRULE:FREQ=MINUTELY')));
    const r = await collect();
    expect(r.complete).toBe(false);
    expect(r.notes).toEqual([
      '"(untitled)" has more than 50000 occurrences before or in this window, so its occurrences here could not all be computed and some are MISSING.',
    ]);
  });

  it('lists the occurrences of a master-less resource (an invitation to single occurrences)', async () => {
    dav.put('home', 'x.ics', ics(...vevent('UID:x', 'RECURRENCE-ID:20261020T150000Z', 'DTSTART:20261020T150000Z', 'SUMMARY:Only an override')));
    const r = await collect();
    expect(r.rows).toHaveLength(1);
  });

  it('reports a calendar that failed and returns the rest, but throws when all fail, in strict mode, or on rejected credentials', async () => {
    dav.put('home', 'a.ics', ics(...vevent('UID:a', 'DTSTART:20261021T130000Z')));
    dav.hooks.push((m, url) => (m === 'REPORT' && url.includes('/work/') ? { status: 400, body: 'broken' } : undefined));
    const r = await collect();
    expect(r.complete).toBe(false);
    expect(r.rows).toHaveLength(1);
    expect(r.failed).toEqual([{ calendar: 'Work', error: expect.stringMatching(/REPORT .* failed with HTTP 400/) }]);
    expect(r.notes[0]).toMatch(/^Calendar "Work" could not be searched \(.*\); its events are MISSING from this answer\.$/);
    await expect(collect({ strict: true })).rejects.toBeInstanceOf(UpstreamError);
    dav.hooks.unshift((m) => (m === 'REPORT' ? { status: 400 } : undefined));
    await expect(collect()).rejects.toBeInstanceOf(UpstreamError);
  });

  it('throws a rejected credential even when other calendars answered', async () => {
    dav.hooks.push((m, url) => (m === 'REPORT' && url.includes('/work/') ? { status: 401 } : undefined));
    await expect(collect()).rejects.toBeInstanceOf(CredentialsRejectedError);
  });
});

describe('ordering and paging helpers', () => {
  it('breaks start ties by title then id', () => {
    const at = new Date('2026-10-20T13:00:00Z');
    const row = (baseId: string, title: string | undefined, occ?: string): Row =>
      ({
        baseId,
        resource: {} as never,
        occurrence: { start: at, occ, comp: { getFirstPropertyValue: () => title ?? null } } as never,
      }) as Row;
    const rows = [row('c/2', 'B'), row('c/1', undefined, '2026-10-20T13:00:00Z'), row('c/1', undefined), row('c/0', 'B')];
    expect(rows.sort(compareRows).map((r) => [r.baseId, r.occurrence.occ, textProp(r.occurrence.comp, 'summary')])).toEqual([
      ['c/1', undefined, undefined],
      ['c/1', '2026-10-20T13:00:00Z', undefined],
      ['c/0', undefined, 'B'],
      ['c/2', undefined, 'B'],
    ]);
  });

  it('refuses an offset past the end of a non-empty result', () => {
    expect(() => assertOffset(5, 5)).toThrow(/offset 5 is past the end: 5 events matched this window \(valid offsets 0–4\)/);
    expect(() => assertOffset(1, 1)).toThrow(/1 event matched/);
    expect(() => assertOffset(0, 0)).not.toThrow();
    expect(() => assertOffset(3, 0)).not.toThrow();
    expect(() => assertOffset(2, 3)).not.toThrow();
  });
});

describe('loadEvent', () => {
  beforeEach(() => {
    dav.put(
      'work',
      's.ics',
      ics(
        ...NY_TZ,
        ...vevent('UID:s', 'DTSTART;TZID=America/New_York:20261019T090000', 'RRULE:FREQ=DAILY;COUNT=5', 'SUMMARY:Standup'),
        ...vevent('UID:s', 'RECURRENCE-ID;TZID=America/New_York:20261021T090000', 'DTSTART;TZID=America/New_York:20261021T100000'),
      ),
    );
    dav.put('home', 'one.ics', ics(...vevent('UID:one', 'DTSTART:20261021T130000Z', 'SUMMARY:One')));
    dav.put('home', 'inv.ics', ics(
      ...vevent('UID:i', 'RECURRENCE-ID:20261025T130000Z', 'DTSTART:20261025T130000Z', 'SUMMARY:Later'),
      ...vevent('UID:i', 'RECURRENCE-ID:20261022T130000Z', 'DTSTART:20261022T130000Z', 'SUMMARY:Earlier'),
    ));
    dav.put('home', 'empty.ics', ics('BEGIN:VTODO', 'UID:t', 'END:VTODO'));
  });

  it('loads occurrences, single events and series', async () => {
    const ctx = dav.context();
    const occ = await loadEvent(ctx, 'work/s.ics#occ=2026-10-21T13:00:00Z', NY);
    expect(occ).toMatchObject({ recurring: true, calendar: { id: 'work' }, resource: { etag: '"e1"' }, target: { isOverride: true } });
    const natural = await loadEvent(ctx, 'work/s.ics#occ=2026-10-22T13:00:00Z', NY);
    expect(natural.target).toMatchObject({ isOverride: false, occ: '2026-10-22T13:00:00Z' });
    const series = await loadEvent(ctx, 'work/s.ics', NY);
    expect(series.target).toMatchObject({ recurring: true, isOverride: false });
    expect(series.target.occ).toBeUndefined();
    expect(series.target.master).toBe(series.parts.master);
    const single = await loadEvent(ctx, 'home/one.ics', NY);
    expect(single).toMatchObject({ recurring: false, target: { recurring: false } });
    const invite = await loadEvent(ctx, 'home/inv.ics', NY);
    expect(textProp(invite.target.comp, 'summary')).toBe('Earlier');
    expect(invite.target.occ).toBe('2026-10-22T13:00:00Z');
  });

  it('refuses what it cannot resolve — never a different occurrence', async () => {
    const ctx = dav.context();
    await expect(loadEvent(ctx, 'nope/one.ics', NY)).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringMatching(/names calendar "nope"/) });
    await expect(loadEvent(ctx, 'home/missing.ics', NY)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(loadEvent(ctx, 'home/empty.ics', NY)).rejects.toThrow(/holds no event/);
    await expect(loadEvent(ctx, 'home/one.ics#occ=2026-10-21T13:00:00Z', NY)).rejects.toBeInstanceOf(InvalidArgumentError);
    const gone = await loadEvent(ctx, 'work/s.ics#occ=2026-10-19T14:00:00Z', NY).catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(AppleToolError);
    expect(gone).toMatchObject({ code: 'NOT_FOUND', message: expect.stringMatching(/does not exist .* Nothing was changed/) });
  });
});
