import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppleToolError, InvalidArgumentError, UpstreamError } from '../../src/errors.js';
import { DavClient } from '../../src/dav/client.js';
import { forgetDavContext } from '../../src/dav/icloud.js';
import {
  assertWritable,
  chooseTargetCalendar,
  defaultContext,
  fetchEvent,
  listCalendars,
  queryCalendar,
  queryCalendars,
  resolveCalendar,
  resolveCalendars,
  selfAddresses,
  type CalendarInfo,
} from '../../src/calendar/caldav.js';
import { DSID, FakeCalDav, HOME, PASS, PRINCIPAL, USER, ics, vevent } from './fake-caldav.js';

let dav: FakeCalDav;

beforeEach(() => {
  dav = new FakeCalDav().install();
});

afterEach(() => {
  forgetDavContext(undefined, { memoryOnly: true });
});

const cal = (id: string, name: string, extra: Partial<CalendarInfo> = {}): CalendarInfo => ({ id, name, url: `${HOME}${id}/`, ...extra });

describe('listCalendars', () => {
  it('keeps event calendars only, reads their properties, and orders them like Apple does', async () => {
    dav
      .addCalendar({ id: 'home', name: 'Home', color: '#FF2D55FF', order: 2, description: 'mine', timezone: 'BEGIN:VCALENDAR\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Paris\r\nEND:VTIMEZONE\r\nEND:VCALENDAR' })
      .addCalendar({ id: 'work', name: 'Work', order: 1, color: 'blue' })
      .addCalendar({ id: 'shared', name: 'Team', privileges: ['read'], extraTypes: '<cs:shared/>', order: 1 })
      .addCalendar({ id: 'any', comps: null, privileges: null, order: 7.5 as never })
      .addCalendar({ id: 'todo', name: 'Reminders', comps: ['VTODO'] })
      .addCalendar({ id: 'sub', name: 'Holidays', extraTypes: '<cs:subscribed/>', isCalendar: false })
      .addCalendar({ id: 'inbox', name: 'Inbox', isCalendar: false, extraTypes: '<c:schedule-inbox/>' });
    const { calendars, skipped } = await listCalendars(dav.context());
    expect(skipped).toEqual({ taskLists: 1, subscribed: 1 });
    expect(calendars).toEqual([
      { id: 'shared', name: 'Team', url: `${HOME}shared/`, order: 1, writable: false, shared: true },
      { id: 'work', name: 'Work', url: `${HOME}work/`, order: 1, writable: true },
      { id: 'home', name: 'Home', url: `${HOME}home/`, color: '#FF2D55', description: 'mine', order: 2, writable: true, timeZone: 'Europe/Paris' },
      { id: 'any', name: 'any', url: `${HOME}any/` },
    ]);
    const [req] = dav.requests;
    expect(req).toMatchObject({ method: 'PROPFIND', url: HOME });
    expect(req!.headers.depth).toBe('1');
  });

  it('skips status-form responses and escapes odd ids', async () => {
    dav.hooks.push((method) =>
      method === 'PROPFIND'
        ? {
            status: 207,
            body:
              '<multistatus xmlns="DAV:"><response><href>/x/</href><status>HTTP/1.1 404 Not Found</status></response>' +
              `<response><href>/${DSID}/calendars/a%2Fb%23c/</href><propstat><prop><resourcetype><collection/>` +
              '<calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>',
          }
        : undefined,
    );
    const { calendars } = await listCalendars(dav.context());
    expect(calendars.map((c) => [c.id, c.name])).toEqual([['a%2Fb%23c', 'a/b#c']]);
    expect(resolveCalendar(calendars, 'a/b#c', 'calendar').name).toBe('a/b#c');
  });
});

describe('resolving calendars', () => {
  const all = [cal('home', 'Home'), cal('work', 'Work'), cal('w2', 'work')];

  it('matches an id, then a unique case-insensitive name', () => {
    expect(resolveCalendar(all, 'home', 'calendar').id).toBe('home');
    expect(resolveCalendar(all, ' HOME ', 'calendar').id).toBe('home');
    expect(resolveCalendar(all, 'w2', 'calendar').id).toBe('w2');
  });

  it('refuses an ambiguous name and an unknown one, listing what exists', () => {
    expect(() => resolveCalendar(all, 'WORK', 'calendar')).toThrow(/matches 2 calendars with that name: "Work" \(id work\), "work" \(id w2\)/);
    expect(() => resolveCalendar(all, 'Nope', 'calendars entry')).toThrow(InvalidArgumentError);
    expect(() => resolveCalendar(all, 'Nope', 'calendars entry')).toThrow(/calendars entry "Nope" is not one of your event calendars\. Available: "Home"/);
    expect(() => resolveCalendar([], 'Nope', 'calendar')).toThrow(/Available: \(none\)/);
  });

  it('resolves a list (deduplicated) or everything', () => {
    expect(resolveCalendars(all, undefined)).toEqual(all);
    expect(resolveCalendars(all, ['home', 'Home', 'w2']).map((c) => c.id)).toEqual(['home', 'w2']);
  });

  it('chooses where a new event goes: the request, then ICLOUD_DEFAULT_CALENDAR, then the first writable', () => {
    const mixed = [cal('ro', 'Read only', { writable: false }), cal('unknown', 'Unknown'), cal('rw', 'Writable', { writable: true })];
    expect(chooseTargetCalendar(mixed, 'Unknown')).toEqual({ calendar: mixed[1], reason: 'named in the request' });
    expect(chooseTargetCalendar(mixed, undefined).calendar.id).toBe('rw');
    expect(chooseTargetCalendar([mixed[0]!, mixed[1]!], undefined).calendar.id).toBe('unknown');
    process.env.ICLOUD_DEFAULT_CALENDAR = 'read ONLY';
    expect(chooseTargetCalendar(mixed, undefined)).toEqual({ calendar: mixed[0], reason: 'ICLOUD_DEFAULT_CALENDAR' });
    process.env.ICLOUD_DEFAULT_CALENDAR = 'Gone';
    expect(() => chooseTargetCalendar(mixed, undefined)).toThrow(/ICLOUD_DEFAULT_CALENDAR "Gone" is not one of your event calendars/);
    delete process.env.ICLOUD_DEFAULT_CALENDAR;
    expect(() => chooseTargetCalendar([mixed[0]!], undefined)).toThrow(/no writable event calendar/);
  });

  it('refuses writes to a read-only calendar up front', () => {
    expect(() => assertWritable(cal('ro', 'RO', { writable: false }))).toThrow(/"RO" is read-only/);
    expect(() => assertWritable(cal('rw', 'RW'))).not.toThrow();
  });
});

describe('queryCalendar', () => {
  it('sends a UTC time-range widened by a day and returns every resource but the collection itself', async () => {
    dav.addCalendar({ id: 'home', name: 'Home' });
    dav.put('home', 'a.ics', ics(...vevent('UID:a', 'DTSTART:20261020T130000Z')));
    const home = cal('home', 'Home');
    const r = await queryCalendar(dav.context(), home, new Date('2026-10-20T04:00:00Z'), new Date('2026-10-21T04:00:00Z'));
    expect(r.resources).toEqual([expect.objectContaining({ name: 'a.ics', url: `${HOME}home/a.ics`, etag: '"e1"', calendar: home })]);
    expect(r.unreadable).toBe(0);
    expect(r.truncatedByServer).toBeUndefined();
    const report = dav.requests.find((q) => q.method === 'REPORT')!;
    expect(report.body).toContain('<c:time-range start="20261019T040000Z" end="20261022T040000Z"/>');
    expect(report.headers.depth).toBe('1');
  });

  it('counts responses without calendar data or without an href as unreadable, and skips 404s', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dav.hooks.push((method) =>
      method === 'REPORT'
        ? {
            status: 207,
            body:
              '<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
              `<response><href>/${DSID}/calendars/home/gone.ics</href><status>HTTP/1.1 404 Not Found</status></response>` +
              `<response><href>/${DSID}/calendars/home/empty.ics</href><propstat><prop><c:calendar-data> </c:calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>` +
              `<response><href>/${DSID}/calendars/home/none.ics</href><propstat><prop><getetag>"x"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response>` +
              '<response><propstat><prop/><status>HTTP/1.1 200 OK</status></propstat></response>' +
              `<response><href>/${DSID}/calendars/home/ok.ics</href><propstat><prop><c:calendar-data>BEGIN:VCALENDAR</c:calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>` +
              '</multistatus>',
          }
        : undefined,
    );
    const r = await queryCalendar(dav.context(), cal('home', 'Home'), new Date('2026-10-20T00:00:00Z'), new Date('2026-10-21T00:00:00Z'));
    expect(r.resources.map((x) => [x.name, x.etag])).toEqual([['ok.ics', undefined]]);
    expect(r.unreadable).toBe(3);
    expect(errSpy).toHaveBeenCalled();
  });

  it('notices a result the server cut short (507 on the calendar itself)', async () => {
    dav.hooks.push((method) =>
      method === 'REPORT'
        ? {
            status: 207,
            body:
              '<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
              `<response><href>/${DSID}/calendars/home/</href><status>HTTP/1.1 507 Insufficient Storage</status></response>` +
              `<response><href>/${DSID}/calendars/home/ok.ics</href><propstat><prop><c:calendar-data>BEGIN:VCALENDAR</c:calendar-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>` +
              '</multistatus>',
          }
        : undefined,
    );
    const r = await queryCalendar(dav.context(), cal('home', 'Home'), new Date('2026-10-20T00:00:00Z'), new Date('2026-10-21T00:00:00Z'));
    expect(r).toMatchObject({ truncatedByServer: true, unreadable: 0 });
    expect(r.resources.map((x) => x.name)).toEqual(['ok.ics']);
  });

  it('keeps each calendar\'s outcome when querying several', async () => {
    dav.hooks.push((method, url) => (method === 'REPORT' && url.includes('/bad/') ? { status: 400, body: 'nope' } : undefined));
    const out = await queryCalendars(dav.context(), [cal('home', 'Home'), cal('bad', 'Bad')], new Date('2026-10-20T00:00:00Z'), new Date('2026-10-21T00:00:00Z'));
    expect(out[0]).toMatchObject({ ok: true });
    expect(out[1]).toMatchObject({ ok: false, calendar: { id: 'bad' } });
    expect((out[1] as { error: unknown }).error).toBeInstanceOf(UpstreamError);
  });
});

describe('fetchEvent', () => {
  it('gets a resource with its ETag (or without, when none is sent)', async () => {
    dav.put('home', 'a b.ics', 'BEGIN:VCALENDAR');
    const home = cal('home', 'Home');
    expect(await fetchEvent(dav.context(), home, 'a b.ics', 'home/a b.ics')).toEqual({ calendar: home, name: 'a b.ics', url: `${HOME}home/a%20b.ics`, etag: '"e1"', ics: 'BEGIN:VCALENDAR' });
    dav.noEtagOnGet = true;
    expect((await fetchEvent(dav.context(), home, 'a b.ics', 'x')).etag).toBeUndefined();
  });

  it('turns a 404 into NOT_FOUND naming the event, and passes other failures through', async () => {
    const home = cal('home', 'Home');
    const err = await fetchEvent(dav.context(), home, 'missing.ics', 'home/missing.ics').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppleToolError);
    expect(err).toMatchObject({ code: 'NOT_FOUND', message: expect.stringMatching(/event home\/missing\.ics was not found in "Home"/) });
    dav.hooks.push(() => ({ status: 400, body: 'bad' }));
    await expect(fetchEvent(dav.context(), home, 'x.ics', 'x')).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe('selfAddresses', () => {
  it('reads the calendar-user-address-set and picks the organizer address', async () => {
    const me = await selfAddresses(dav.context());
    expect([...me.addresses]).toEqual(['mailto:me@icloud.com', `/${DSID}/principal/`, 'urn:uuid:ME']);
    expect(me.organizer).toBe('me@icloud.com');
    expect(dav.requests[0]).toMatchObject({ method: 'PROPFIND', url: PRINCIPAL });

    dav.addressSet = ['mailto:Alias@me.com', 'mailto:other@me.com'];
    const other = await selfAddresses(dav.context());
    expect(other.organizer).toBe('Alias@me.com');
    expect(other.addresses.has('mailto:me@icloud.com')).toBe(true);

    dav.addressSet = [];
    const client = new DavClient({ service: 'calendar', username: 'plainname', password: PASS });
    const bare = await selfAddresses({ client, homeUrl: HOME, principalUrl: PRINCIPAL });
    expect(bare).toEqual({ addresses: new Set(), organizer: 'plainname' });
  });
});

describe('defaultContext', () => {
  it('reads the credentials now and discovers the calendar home', async () => {
    await expect(defaultContext()).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    process.env.ICLOUD_USERNAME = USER;
    process.env.ICLOUD_APP_PASSWORD = PASS;
    process.env.APPLE_STATE_CACHE = 'false';
    const ctx = await defaultContext();
    expect(ctx.homeUrl).toBe(HOME);
    expect(ctx.principalUrl).toBe(PRINCIPAL);
    expect(ctx.source).toBe('discovered');
  });
});
