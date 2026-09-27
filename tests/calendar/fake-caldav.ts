import { vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { DavClient } from '../../src/dav/client.js';
import { rememberSecret } from '../../src/errors.js';
import type { CalendarContext } from '../../src/calendar/caldav.js';
import { registerCalendarTools, type CalendarDeps } from '../../src/calendar/tools.js';

/**
 * An in-memory iCloud CalDAV server behind a stubbed global `fetch`, so the
 * calendar tools run through the REAL `httpRequest` + `DavClient` stack
 * (allowlist, Basic auth, 207 parsing, 412 → PreconditionFailedError, 5xx on
 * a write → UnconfirmedWriteError). It answers:
 *
 *   PROPFIND https://caldav.icloud.com/            current-user-principal (discovery)
 *   PROPFIND <principal>                           calendar-home-set / calendar-user-address-set
 *   PROPFIND <home> Depth 1 / Depth 0              the calendars / the home itself
 *   REPORT   <calendar>                            calendar-query → every resource (the tools filter)
 *   GET / PUT / DELETE / MOVE <resource>           with ETag preconditions
 */

export const USER = 'me@icloud.com';
export const PASS = 'abcd-efgh-ijkl-mnop';
export const DSID = '123456789';
export const HOST = 'https://p34-caldav.icloud.com';
export const HOME = `${HOST}/${DSID}/calendars/`;
export const PRINCIPAL = `https://caldav.icloud.com/${DSID}/principal/`;

export interface FakeCalendar {
  id: string;
  name?: string;
  color?: string;
  order?: number;
  /** DAV privileges (local names); null omits the property. Default read + write. */
  privileges?: string[] | null;
  /** Supported components; null omits the property. Default VEVENT. */
  comps?: string[] | null;
  /** Extra resourcetype children, as XML. */
  extraTypes?: string;
  /** False = not a caldav:calendar collection at all. */
  isCalendar?: boolean;
  description?: string;
  timezone?: string;
}

export interface Stored {
  ics: string;
  etag: string;
}

export interface Reply {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/** Return a Reply to answer instead of the fake, throw to simulate a network failure, or undefined to carry on. */
export type Hook = (method: string, url: string, body: string, headers: Record<string, string>) => Reply | undefined;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class FakeCalDav {
  calendars: FakeCalendar[] = [];
  resources = new Map<string, Stored>();
  requests: Array<{ method: string; url: string; body: string; headers: Record<string, string> }> = [];
  addressSet = ['mailto:me@icloud.com', `/${DSID}/principal/`, 'urn:uuid:ME'];
  hooks: Hook[] = [];
  /** Omit ETag headers on GET (a server that does not send them). */
  noEtagOnGet = false;
  private counter = 0;

  calendarUrl(id: string): string {
    return `${HOME}${encodeURIComponent(id)}/`;
  }

  resourceUrl(calId: string, name: string): string {
    return `${this.calendarUrl(calId)}${encodeURIComponent(name)}`;
  }

  addCalendar(c: FakeCalendar): this {
    this.calendars.push(c);
    return this;
  }

  put(calId: string, name: string, ics: string): string {
    const etag = `"e${++this.counter}"`;
    this.resources.set(this.resourceUrl(calId, name), { ics, etag });
    return etag;
  }

  get(calId: string, name: string): Stored | undefined {
    return this.resources.get(this.resourceUrl(calId, name));
  }

  /** Requests other than the discovery/listing reads, as `METHOD path`. */
  writes(): string[] {
    return this.requests.filter((r) => ['PUT', 'DELETE', 'MOVE'].includes(r.method)).map((r) => `${r.method} ${new URL(r.url).pathname}`);
  }

  /** Like `getDavContext`, which registers the account id in every DAV path as a secret. */
  context(): CalendarContext {
    rememberSecret(DSID);
    return {
      client: new DavClient({ service: 'calendar', username: USER, password: PASS }),
      homeUrl: HOME,
      principalUrl: PRINCIPAL,
      source: 'memory',
    };
  }

  /** Stub global fetch with this server. */
  install(): this {
    vi.stubGlobal('fetch', vi.fn((input: unknown, init?: RequestInit) => this.fetch(String(input), init ?? {})));
    return this;
  }

  private multistatus(inner: string): Response {
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" ` +
        `xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">${inner}</d:multistatus>`,
      { status: 207, headers: { 'content-type': 'application/xml; charset=utf-8' } },
    );
  }

  private status(status: number, body = '', headers: Record<string, string> = {}): Response {
    return new Response(status === 204 ? null : body, { status, headers });
  }

  async fetch(url: string, init: RequestInit): Promise<Response> {
    const method = String(init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init.body === 'string' ? init.body : '';
    this.requests.push({ method, url, body, headers });
    for (const hook of this.hooks) {
      const reply = hook(method, url, body, headers);
      if (reply) return this.status(reply.status, reply.body ?? '', reply.headers ?? {});
    }
    const path = new URL(url).pathname;
    if (method === 'PROPFIND') return this.propfind(url, path, body, headers);
    if (method === 'REPORT') return this.report(url);
    const stored = this.resources.get(url);
    const ifMatch = headers['if-match'];
    const matches = (s: Stored | undefined) => ifMatch === undefined || (s !== undefined && (ifMatch === '*' || ifMatch === s.etag));
    if (method === 'GET') {
      if (!stored) return this.status(404, 'Not Found');
      return this.status(200, stored.ics, {
        'content-type': 'text/calendar; charset=utf-8',
        ...(this.noEtagOnGet ? {} : { etag: stored.etag }),
      });
    }
    if (method === 'PUT') {
      if (headers['if-none-match'] === '*' && stored) return this.status(412, '');
      if (!matches(stored)) return this.status(412, '');
      const etag = `"e${++this.counter}"`;
      this.resources.set(url, { ics: body, etag });
      return this.status(stored ? 204 : 201, '', { etag });
    }
    if (method === 'DELETE') {
      if (!stored) return this.status(404, '');
      if (!matches(stored)) return this.status(412, '');
      this.resources.delete(url);
      return this.status(204);
    }
    if (method === 'MOVE') {
      if (!stored) return this.status(404, '');
      if (!matches(stored)) return this.status(412, '');
      const dest = headers.destination as string;
      if (this.resources.has(dest) && headers.overwrite === 'F') return this.status(412, '');
      this.resources.delete(url);
      this.resources.set(dest, { ics: stored.ics, etag: `"e${++this.counter}"` });
      return this.status(201);
    }
    return this.status(405, 'Method Not Allowed');
  }

  private propfind(url: string, path: string, body: string, headers: Record<string, string>): Response {
    if (url === 'https://caldav.icloud.com/') {
      return this.multistatus(
        `<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/${DSID}/principal/</d:href>` +
          '</d:current-user-principal></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
      );
    }
    if (path === `/${DSID}/principal/`) {
      if (body.includes('calendar-home-set')) {
        return this.multistatus(
          `<d:response><d:href>/${DSID}/principal/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>${HOST}:443/${DSID}/calendars/</d:href>` +
            '</c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
        );
      }
      return this.multistatus(
        `<d:response><d:href>/${DSID}/principal/</d:href><d:propstat><d:prop><c:calendar-user-address-set>` +
          this.addressSet.map((h) => `<d:href>${esc(h)}</d:href>`).join('') +
          '</c:calendar-user-address-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
      );
    }
    const self =
      `<d:response><d:href>/${DSID}/calendars/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype>` +
      '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
    if (headers.depth === '0') return this.multistatus(self);
    const cals = this.calendars.map((c) => {
      const props: string[] = [];
      const missing: string[] = [];
      if (c.name !== undefined) props.push(`<d:displayname>${esc(c.name)}</d:displayname>`);
      else missing.push('<d:displayname/>');
      props.push(`<d:resourcetype><d:collection/>${c.isCalendar === false ? '' : '<c:calendar/>'}${c.extraTypes ?? ''}</d:resourcetype>`);
      if (c.color !== undefined) props.push(`<ic:calendar-color>${c.color}</ic:calendar-color>`);
      if (c.order !== undefined) props.push(`<ic:calendar-order>${c.order}</ic:calendar-order>`);
      const comps = c.comps === undefined ? ['VEVENT'] : c.comps;
      if (comps !== null) props.push(`<c:supported-calendar-component-set>${comps.map((n) => `<c:comp name="${n}"/>`).join('')}</c:supported-calendar-component-set>`);
      const privs = c.privileges === undefined ? ['read', 'write'] : c.privileges;
      if (privs !== null) {
        props.push(`<d:current-user-privilege-set>${privs.map((p) => `<d:privilege><d:${p}/></d:privilege>`).join('')}</d:current-user-privilege-set>`);
      }
      if (c.description !== undefined) props.push(`<c:calendar-description>${esc(c.description)}</c:calendar-description>`);
      else missing.push('<c:calendar-description/>');
      if (c.timezone !== undefined) props.push(`<c:calendar-timezone><![CDATA[${c.timezone}]]></c:calendar-timezone>`);
      return (
        `<d:response><d:href>/${DSID}/calendars/${encodeURIComponent(c.id)}/</d:href>` +
        `<d:propstat><d:prop>${props.join('')}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>` +
        `<d:propstat><d:prop>${missing.join('')}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`
      );
    });
    return this.multistatus(self + cals.join(''));
  }

  private report(url: string): Response {
    const inner = [
      `<d:response><d:href>${new URL(url).pathname}</d:href><d:propstat><d:prop><d:getetag/></d:prop>` +
        '<d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>',
    ];
    for (const [resUrl, stored] of this.resources) {
      if (!resUrl.startsWith(url)) continue;
      inner.push(
        `<d:response><d:href>${new URL(resUrl).pathname}</d:href><d:propstat><d:prop><d:getetag>${esc(stored.etag)}</d:getetag>` +
          `<c:calendar-data><![CDATA[${stored.ics}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
      );
    }
    return this.multistatus(inner.join(''));
  }
}

// ---------------------------------------------------------------------------
// Tool harness
// ---------------------------------------------------------------------------

export interface Registered {
  cfg: {
    description: string;
    inputSchema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } };
    annotations: Record<string, unknown>;
  };
  cb: (args: Record<string, unknown>, ctx?: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

export function captureTools(deps?: CalendarDeps): Map<string, Registered> {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, cfg: Registered['cfg'], cb: Registered['cb']) => tools.set(name, { cfg, cb }),
  } as unknown as McpServer;
  registerCalendarTools(server, deps);
  return tools;
}

/** 2026-10-20 (a Tuesday) 12:00 in New York. */
export const NOW = new Date('2026-10-20T16:00:00Z');

export interface Harness {
  dav: FakeCalDav;
  tools: Map<string, Registered>;
  uids: string[];
  call(name: string, args?: Record<string, unknown>, ctx?: unknown): Promise<{ json: any; isError: boolean; text: string }>;
}

export function harness(opts: { now?: Date; deps?: Partial<CalendarDeps> } = {}): Harness {
  const dav = new FakeCalDav().install();
  const uids: string[] = [];
  let n = 0;
  const tools = captureTools({
    context: async () => dav.context(),
    now: () => opts.now ?? NOW,
    newUid: () => {
      const uid = `UID-${++n}`;
      uids.push(uid);
      return uid;
    },
    ...opts.deps,
  });
  return {
    dav,
    tools,
    uids,
    async call(name, args = {}, ctx = {}) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`no tool ${name}`);
      const r = await tool.cb(args, ctx);
      const text = r.content[0]?.text ?? '';
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { json, isError: r.isError === true, text };
    },
  };
}

/** Wrap VEVENT lines in a VCALENDAR (CRLF). */
export function ics(...lines: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 14.2.1//EN', ...lines, 'END:VCALENDAR'].join('\r\n');
}

export function vevent(...lines: string[]): string[] {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
}

export const NY_TZ = [
  'BEGIN:VTIMEZONE',
  'TZID:America/New_York',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'DTSTART:20070311T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'TZNAME:EDT',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'DTSTART:20071104T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'TZNAME:EST',
  'END:STANDARD',
  'END:VTIMEZONE',
];
