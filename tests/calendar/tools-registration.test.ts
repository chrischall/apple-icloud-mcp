import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CONFIRM_NOTE } from '../../src/tools/_confirm.js';
import { AppleToolError, InvalidArgumentError } from '../../src/errors.js';
import { forgetDavContext } from '../../src/dav/icloud.js';
import { partial } from '../../src/calendar/tools.js';
import { FakeCalDav, PASS, USER, captureTools } from './fake-caldav.js';

const READ_TOOLS = [
  'apple_calendar_list_calendars',
  'apple_calendar_list_events',
  'apple_calendar_search_events',
  'apple_calendar_get_event',
  'apple_calendar_find_free_time',
];

describe('registration', () => {
  it('registers every tool with an empty environment and no I/O', () => {
    const tools = captureTools();
    expect([...tools.keys()].sort()).toEqual(
      [...READ_TOOLS, 'apple_calendar_create_event', 'apple_calendar_update_event', 'apple_calendar_delete_event'].sort(),
    );
    for (const [name, t] of tools) {
      expect(t.cfg.description.length, name).toBeLessThanOrEqual(620);
      expect(t.cfg.annotations.openWorldHint, name).toBe(true);
      expect(t.cfg.annotations.readOnlyHint, name).toBe(READ_TOOLS.includes(name));
    }
    expect(tools.get('apple_calendar_create_event')!.cfg.annotations).toMatchObject({ destructiveHint: false, idempotentHint: false });
    expect(tools.get('apple_calendar_update_event')!.cfg.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
    expect(tools.get('apple_calendar_delete_event')!.cfg.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
    // Delete always asks. Create and update ask only when iCloud will email attendees, and their descriptions must say
    // so: the generic note ("the first call performs NO write") would have a model use a plain create as a dry run.
    expect(tools.get('apple_calendar_delete_event')!.cfg.description.endsWith(CONFIRM_NOTE)).toBe(true);
    for (const [name, verb] of [['apple_calendar_create_event', 'creates'], ['apple_calendar_update_event', 'changes']] as const) {
      const description = tools.get(name)!.cfg.description;
      expect(description.includes(CONFIRM_NOTE), name).toBe(false);
      expect(description, name).toMatch(/attendees it asks first \(iCloud emails them\)/);
      expect(description.endsWith(`Without attendees the first call ${verb} the event immediately.`), name).toBe(true);
    }
  });

  it('follows APPLE_WRITE_MODE and APPLE_SERVICES', () => {
    process.env.APPLE_WRITE_MODE = 'none';
    expect([...captureTools().keys()].sort()).toEqual([...READ_TOOLS].sort());
    process.env.APPLE_WRITE_MODE = 'additive';
    expect([...captureTools().keys()].sort()).toEqual([...READ_TOOLS, 'apple_calendar_create_event'].sort());
    process.env.APPLE_WRITE_MODE = 'all';
    process.env.APPLE_SERVICES = 'music';
    expect(captureTools().size).toBe(0);
  });
});

describe('input schemas', () => {
  const tools = captureTools();
  const ok = (tool: string, args: unknown) => tools.get(tool)!.cfg.inputSchema.safeParse(args).success;

  it('describe every argument, nested ones included', () => {
    const undescribed: string[] = [];
    const walk = (node: Record<string, unknown>, path: string): void => {
      for (const [key, child] of Object.entries((node.properties ?? {}) as Record<string, Record<string, unknown>>)) {
        if (typeof child.description !== 'string' || child.description.length === 0) undescribed.push(`${path}.${key}`);
        walk(child, `${path}.${key}`);
        if (child.items) walk(child.items as Record<string, unknown>, `${path}.${key}[]`);
      }
    };
    for (const [name, t] of tools) walk(z.toJSONSchema(t.cfg.inputSchema as never) as Record<string, unknown>, name);
    expect(undescribed).toEqual([]);
    expect(tools.get('apple_calendar_update_event')!.cfg.inputSchema.safeParse({ eventId: 'a/b.ics' }).success).toBe(true);
  });

  it('refuse unknown arguments on every tool', () => {
    for (const name of tools.keys()) expect(ok(name, { daysAhaed: 27 }), name).toBe(false);
    expect(ok('apple_calendar_list_calendars', {})).toBe(true);
  });

  it('bound windows, paging and time arguments', () => {
    expect(ok('apple_calendar_list_events', { daysAhead: 366, limit: 500, offset: 0 })).toBe(true);
    expect(ok('apple_calendar_list_events', { daysAhead: 367 })).toBe(false);
    expect(ok('apple_calendar_list_events', { daysAhead: 0 })).toBe(false);
    expect(ok('apple_calendar_list_events', { limit: 0 })).toBe(false);
    expect(ok('apple_calendar_list_events', { limit: 501 })).toBe(false);
    expect(ok('apple_calendar_list_events', { offset: -1 })).toBe(false);
    expect(ok('apple_calendar_list_events', { calendars: [] })).toBe(false);
    expect(ok('apple_calendar_search_events', {})).toBe(false);
    expect(ok('apple_calendar_search_events', { query: '' })).toBe(false);
    expect(ok('apple_calendar_find_free_time', { daysAhead: 31, workdayStart: '08:30', workdayEnd: '18:00', minDurationMinutes: 15 })).toBe(true);
    expect(ok('apple_calendar_find_free_time', { daysAhead: 32 })).toBe(false);
    expect(ok('apple_calendar_find_free_time', { workdayStart: '8:30' })).toBe(false);
    expect(ok('apple_calendar_find_free_time', { workdayEnd: '24:00' })).toBe(false);
    expect(ok('apple_calendar_find_free_time', { minDurationMinutes: 4 })).toBe(false);
    for (const tool of ['apple_calendar_list_events', 'apple_calendar_search_events']) {
      const q = tool === 'apple_calendar_search_events' ? { query: 'x' } : {};
      expect(ok(tool, { ...q, view: 'compact' }), tool).toBe(true);
      expect(ok(tool, { ...q, view: 'full' }), tool).toBe(true);
      expect(ok(tool, { ...q, view: 'raw' }), tool).toBe(false);
    }
    expect(ok('apple_calendar_get_event', { eventId: 'a/b.ics', view: 'compact' })).toBe(false);
  });

  it('refuse line breaks and control characters in anything written into the event (they would inject iCalendar lines)', () => {
    const base = { title: 'T', startDate: '2026-10-20T09:00' };
    const INJECT = '\r\nATTENDEE;RSVP=TRUE:mailto:victim@x.com';
    for (const tool of ['apple_calendar_create_event', 'apple_calendar_update_event']) {
      const b = tool === 'apple_calendar_create_event' ? base : { eventId: 'a/b.ics' };
      // URL.canParse alone accepts every one of these (the WHATWG parser strips tab, CR and LF, and encodes the rest).
      for (const url of [`https://x.test/${INJECT}`, 'https://x.test/\n', 'https://x.test/\tx', 'https://x.test/ x', 'https://x.test/\u0085', 'https://x.test/\u2028']) {
        expect(URL.canParse(url), url).toBe(true);
        expect(ok(tool, { ...b, url }), `${tool} ${JSON.stringify(url)}`).toBe(false);
      }
      for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'ftp://x.test/']) expect(ok(tool, { ...b, url }), url).toBe(false);
      for (const url of ['https://x.test/a?b=c#d', 'http://x.test', 'mailto:ann@x.com']) expect(ok(tool, { ...b, url }), url).toBe(true);
      for (const field of ['title', 'location']) {
        expect(ok(tool, { ...b, [field]: `Lunch${INJECT}` }), field).toBe(false);
        expect(ok(tool, { ...b, [field]: 'Lunch\rx' }), field).toBe(false);
        expect(ok(tool, { ...b, [field]: 'Lunch\tx' }), field).toBe(false);
        expect(ok(tool, { ...b, [field]: 'Lunch — Café ☕' }), field).toBe(true);
      }
      expect(ok(tool, { ...b, notes: 'Line one\r\nLine two\n\tindented\rthree' })).toBe(true);
      for (const bad of ['a\u0000b', 'a\u0007b', 'a\u000bb', 'a\u000cb', 'a\u001bb', 'a\u007fb']) expect(ok(tool, { ...b, notes: bad }), JSON.stringify(bad)).toBe(false);
      expect(ok(tool, { ...b, attendees: [{ email: 'a@x.com', name: 'Ann\r\nATTENDEE:mailto:v@x.com' }] })).toBe(false);
      expect(ok(tool, { ...b, attendees: [{ email: 'a@x.com', name: 'Ann B.' }] })).toBe(true);
    }
  });

  it('validate event fields', () => {
    const base = { title: 'T', startDate: '2026-10-20T09:00' };
    expect(ok('apple_calendar_create_event', base)).toBe(true);
    expect(ok('apple_calendar_create_event', { startDate: '2026-10-20' })).toBe(false);
    expect(ok('apple_calendar_create_event', { ...base, title: '' })).toBe(false);
    expect(ok('apple_calendar_create_event', { ...base, url: 'not a url' })).toBe(false);
    expect(ok('apple_calendar_create_event', { ...base, url: 'https://ok.test/' })).toBe(true);
    expect(ok('apple_calendar_update_event', { eventId: 'a/b.ics', url: '' })).toBe(true);
    expect(ok('apple_calendar_create_event', { ...base, alarms: [1, 2, 3, 4, 5, 6] })).toBe(false);
    expect(ok('apple_calendar_create_event', { ...base, alarms: [-5] })).toBe(false);
    expect(ok('apple_calendar_create_event', { ...base, recurrence: { frequency: 'weekly', count: 2, until: '2026-12-01' } })).toBe(false);
    expect(ok('apple_calendar_create_event', { ...base, recurrence: { frequency: 'hourly' } })).toBe(false);
    expect(ok('apple_calendar_create_event', { ...base, recurrence: { frequency: 'weekly', byWeekday: ['XX'] } })).toBe(false);
    expect(ok('apple_calendar_create_event', { ...base, recurrence: { frequency: 'weekly', extra: 1 } })).toBe(false);
    expect(ok('apple_calendar_create_event', { ...base, attendees: [{ email: 'a@x.com' }, { email: 'A@x.com' }] })).toBe(false);
    expect(ok('apple_calendar_create_event', { ...base, attendees: [{ email: 'nope' }] })).toBe(false);
    expect(ok('apple_calendar_create_event', { ...base, attendees: [{ email: 'a@x.com', role: 'chair' }] })).toBe(false);
    expect(ok('apple_calendar_update_event', { eventId: 'a/b.ics', span: 'thisOne' })).toBe(false);
    expect(ok('apple_calendar_update_event', { eventId: 'a/b.ics', attendees: [] })).toBe(true);
    expect(ok('apple_calendar_delete_event', { eventId: 'a/b.ics', span: 'allEvents', confirmToken: 'x' })).toBe(true);
    expect(ok('apple_calendar_delete_event', { eventId: 'a/b.ics', title: 'x' })).toBe(false);
    expect(ok('apple_calendar_get_event', { eventId: 'a/b.ics', includeIcs: true })).toBe(true);
  });
});

describe('default dependencies', () => {
  let dav: FakeCalDav;
  beforeEach(() => {
    process.env.DISPLAY_TZ = 'America/New_York';
    process.env.ICLOUD_USERNAME = USER;
    process.env.ICLOUD_APP_PASSWORD = PASS;
    process.env.APPLE_STATE_CACHE = 'false';
    dav = new FakeCalDav().install().addCalendar({ id: 'home', name: 'Home' });
  });
  afterEach(() => forgetDavContext(undefined, { memoryOnly: true }));

  it('discover the account from the environment, use the real clock and random UIDs', async () => {
    const tools = captureTools();
    const list = await tools.get('apple_calendar_list_calendars')!.cb({}, {});
    expect(JSON.parse(list.content[0]!.text)).toMatchObject({ count: 1 });
    const created = await tools.get('apple_calendar_create_event')!.cb({ title: 'T', startDate: '2030-01-02T09:00' }, {});
    const out = JSON.parse(created.content[0]!.text);
    expect(out.eventId).toMatch(/^home\/[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\.ics$/);
    const events = await tools.get('apple_calendar_list_events')!.cb({}, {});
    expect(JSON.parse(events.content[0]!.text).window.timeZone).toBe('America/New_York');
    expect(dav.requests[0]!.url).toBe('https://caldav.icloud.com/');
  });
});

describe('partial', () => {
  it('keeps the code of a tool error and names what already happened', () => {
    const a = partial(new InvalidArgumentError('bad'), 'Moved, but:');
    expect([a.code, a.message]).toEqual(['INVALID_ARGUMENT', 'Moved, but: bad']);
    const b = partial(new Error('boom'), 'Moved, but:');
    expect(b).toBeInstanceOf(AppleToolError);
    expect([b.code, b.message]).toEqual(['UPSTREAM_ERROR', 'Moved, but: boom']);
  });
});
