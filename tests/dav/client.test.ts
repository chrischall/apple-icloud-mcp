import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AppleToolError,
  CredentialsRejectedError,
  InvalidArgumentError,
  UnconfirmedWriteError,
  UpstreamError,
  errorMessage,
  scrub,
} from '../../src/errors.js';
import type { HttpRequest, HttpResponse } from '../../src/http.js';
import { REJECTED_HINT } from '../../src/icloud-auth.js';
import { VERSION } from '../../src/version.js';
import {
  DAV_DISCOVERY_HOSTS,
  DavClient,
  ICALENDAR_CONTENT_TYPE,
  PreconditionFailedError,
  VCARD_CONTENT_TYPE,
  childUrl,
  isICloudUrl,
  lastPathSegment,
  sameResource,
  type DavRequestFn,
} from '../../src/dav/client.js';
import { NS, propfindBody } from '../../src/dav/xml.js';

const USER = 'someone@icloud.com';
const PASS = 'abcd-efgh-ijkl-mnop';
const TOKEN = Buffer.from(`${USER}:${PASS}`).toString('base64');
const HOME = 'https://p34-caldav.icloud.com/200385701/calendars/';

interface Scripted {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  /** The final URL (defaults to the request URL). */
  url?: string;
}

/**
 * A stand-in for httpRequest with its status contract: 2xx resolves; anything
 * else consults `classifyError` and, when that declines, throws a marker so a
 * test can see the default mapping was left to httpRequest.
 */
function fake(...script: Scripted[]) {
  const calls: HttpRequest[] = [];
  const request: DavRequestFn = async (req) => {
    calls.push(req);
    const next = script.shift();
    if (!next) throw new Error('unexpected request');
    const headers = new Headers(next.headers);
    const text = next.body ?? '';
    if (next.status >= 300) {
      const custom = req.classifyError?.(next.status, text, headers);
      if (custom) throw custom;
      throw new Error(`DEFAULT_MAPPING ${next.status}`);
    }
    const res: HttpResponse<unknown> = {
      status: next.status,
      headers,
      url: next.url ?? String(req.url),
      data: text,
      text,
      bytes: new TextEncoder().encode(text),
    };
    return res;
  };
  return { request, calls };
}

function client(request: DavRequestFn, extra: { onRefused?: (status: number, url: string) => void; service?: 'calendar' | 'contacts' } = {}) {
  return new DavClient({ service: extra.service ?? 'calendar', username: USER, password: PASS, request, ...extra });
}

const MS_EMPTY = '<multistatus xmlns="DAV:"/>';
const MS_HOME =
  '<multistatus xmlns="DAV:"><response><href>/200385701/calendars/</href><propstat><prop><resourcetype><collection/></resourcetype>' +
  '</prop><status>HTTP/1.1 200 OK</status></propstat></response>' +
  '<response><href>work/</href><propstat><prop><displayname>Work</displayname></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';

function header(req: HttpRequest, name: string): string | undefined {
  return req.headers?.[name];
}

describe('DavClient requests', () => {
  it('registers the password and the Basic token as secrets', () => {
    client(fake().request);
    expect(scrub(`pw ${PASS} header Basic ${TOKEN}`)).not.toContain(PASS);
    expect(scrub(`Authorization: Basic ${TOKEN}`)).not.toContain(TOKEN);
    const c = new DavClient({ service: 'contacts', username: USER, password: PASS });
    expect(c.username).toBe(USER);
    // The credential is not an enumerable field: serialising a client cannot leak it.
    expect(JSON.stringify(c)).not.toContain(PASS);
    expect(JSON.stringify(c)).not.toContain(TOKEN);
    expect(Object.keys(c).sort()).toEqual(['service', 'username']);
  });

  it('PROPFIND sends Depth, XML content type, Prefer minimal, Basic auth and a UA; parses 207', async () => {
    const f = fake({ status: 207, body: MS_HOME });
    const c = client(f.request);
    expect(c.service).toBe('calendar');
    const ms = await c.propfind(HOME, [[NS.DAV, 'resourcetype'], [NS.DAV, 'displayname']], 1);
    const req = f.calls[0]!;
    expect(req.method).toBe('PROPFIND');
    expect(req.service).toBe('calendar');
    expect(String(req.url)).toBe(HOME);
    expect(req.responseType).toBe('text');
    expect(header(req, 'Depth')).toBe('1');
    expect(header(req, 'Content-Type')).toBe('application/xml; charset=utf-8');
    expect(header(req, 'Prefer')).toBe('return=minimal');
    expect(header(req, 'Authorization')).toBe(`Basic ${TOKEN}`);
    expect(header(req, 'User-Agent')).toBe(`apple-icloud-mcp/${VERSION}`);
    expect(req.body).toBe(propfindBody([[NS.DAV, 'resourcetype'], [NS.DAV, 'displayname']]));
    expect(ms.responses.map((r) => r.url)).toEqual([HOME, `${HOME}work/`]);
    expect(ms.skipped).toBe(0);
  });

  it('PROPFIND accepts a complete XML body; hrefs resolve against the FINAL (redirected) URL', async () => {
    const f = fake({ status: 207, body: MS_HOME, url: 'https://p99-caldav.icloud.com/200385701/calendars/' });
    const ms = await client(f.request).propfind('https://caldav.icloud.com/x/', '<custom/>', 0);
    expect(f.calls[0]!.body).toBe('<custom/>');
    expect(header(f.calls[0]!, 'Depth')).toBe('0');
    expect(ms.url).toBe('https://p99-caldav.icloud.com/200385701/calendars/');
    expect(ms.responses[1]!.url).toBe('https://p99-caldav.icloud.com/200385701/calendars/work/');
  });

  it('REPORT sends the body as given', async () => {
    const f = fake({ status: 207, body: MS_EMPTY });
    const ms = await client(f.request).report(`${HOME}work/`, '<c:calendar-query/>', 1);
    expect(f.calls[0]!.method).toBe('REPORT');
    expect(f.calls[0]!.body).toBe('<c:calendar-query/>');
    expect(ms.responses).toEqual([]);
  });

  it('a 207 body that is not a multistatus is an UpstreamError, never an empty listing', async () => {
    const f = fake({ status: 207, body: '<html><body>Sign in</body></html>' });
    await expect(client(f.request).propfind(HOME, [[NS.DAV, 'resourcetype']], 0)).rejects.toSatisfy(
      (e: unknown) => e instanceof UpstreamError && e.status === 207 && /multistatus/.test(e.message),
    );
  });

  it('warns on stderr (without content) when malformed responses were skipped', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const body = '<multistatus xmlns="DAV:"><response><status>HTTP/1.1 200 OK</status></response></multistatus>';
    const ms = await client(fake({ status: 207, body }).request).report(HOME, '<x/>', 1);
    expect(ms.skipped).toBe(1);
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/calendar: a REPORT answer held 1 malformed <response>/));
    spy.mockRestore();
  });

  it('refuses a bad Depth or a relative URL before sending anything', async () => {
    const f = fake();
    const c = client(f.request);
    await expect(c.propfind(HOME, [[NS.DAV, 'resourcetype']], 2 as 0)).rejects.toThrow(/Depth must be 0 or 1/);
    await expect(c.get('/relative/path.ics')).rejects.toThrow(InvalidArgumentError);
    expect(f.calls).toHaveLength(0);
  });

  it('GET returns body, ETag and content type (absent headers are absent keys)', async () => {
    const f = fake(
      { status: 200, body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', headers: { ETag: '"lreo54jn"', 'Content-Type': 'text/calendar; charset=UTF-8' } },
      { status: 200, body: 'x' },
    );
    const c = client(f.request);
    expect(await c.get(`${HOME}work/1.ics`)).toEqual({
      body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
      etag: '"lreo54jn"',
      contentType: 'text/calendar; charset=UTF-8',
    });
    expect(f.calls[0]!.method).toBe('GET');
    expect(f.calls[0]!.body).toBeUndefined();
    expect(header(f.calls[0]!, 'Depth')).toBeUndefined();
    expect(await c.get(`${HOME}work/2.ics`)).toEqual({ body: 'x' });
  });

  it('PUT create: If-None-Match *, content type, returns status + ETag', async () => {
    const f = fake({ status: 201, headers: { etag: '"new1"' } }, { status: 204 });
    const c = client(f.request);
    expect(await c.put(`${HOME}work/u.ics`, 'BEGIN:VCALENDAR', ICALENDAR_CONTENT_TYPE, { ifNoneMatch: '*' })).toEqual({
      status: 201,
      etag: '"new1"',
    });
    const req = f.calls[0]!;
    expect(req.method).toBe('PUT');
    expect(req.body).toBe('BEGIN:VCALENDAR');
    expect(header(req, 'Content-Type')).toBe('text/calendar; charset=utf-8');
    expect(header(req, 'If-None-Match')).toBe('*');
    expect(header(req, 'If-Match')).toBeUndefined();
    expect(await c.put(`${HOME}c/u.vcf`, 'BEGIN:VCARD', VCARD_CONTENT_TYPE)).toEqual({ status: 204 });
    expect(header(f.calls[1]!, 'If-None-Match')).toBeUndefined();
  });

  it('PUT update: If-Match is sent verbatim when quoted, quoted when bare, * as is, refused when unsafe', async () => {
    const f = fake({ status: 204 }, { status: 204 }, { status: 204 }, { status: 204 }, { status: 204 });
    const c = client(f.request);
    await c.put(`${HOME}a.ics`, 'x', ICALENDAR_CONTENT_TYPE, { ifMatch: '"abc"' });
    await c.put(`${HOME}a.ics`, 'x', ICALENDAR_CONTENT_TYPE, { ifMatch: ' W/"weak" ' });
    await c.put(`${HOME}a.ics`, 'x', ICALENDAR_CONTENT_TYPE, { ifMatch: 'bare-tag' });
    // `If-Match: *` means "any current version" — quoting it would name an ETag that never matches.
    await c.put(`${HOME}a.ics`, 'x', ICALENDAR_CONTENT_TYPE, { ifMatch: '*' });
    // obs-text (0x80–0xFF) is a legal etagc and a legal header byte.
    await c.put(`${HOME}a.ics`, 'x', ICALENDAR_CONTENT_TYPE, { ifMatch: '"caf\u00e9"' });
    expect(f.calls.map((r) => header(r, 'If-Match'))).toEqual(['"abc"', 'W/"weak"', '"bare-tag"', '*', '"caf\u00e9"']);
    for (const h of f.calls.map((r) => header(r, 'If-Match')!)) expect(() => new Headers({ 'If-Match': h })).not.toThrow();
    // Beyond Latin-1 `fetch` refuses the header before sending — on a PUT that would read as
    // "may have been applied". Spaces are not etagc either.
    for (const bad of ['', '  ', 'a"b', 'two words', '"a b"', '"line\nbreak"', 'ctl\u0001', '"\u2603"', '\u2603', '"x\u0100"']) {
      await expect(c.put(`${HOME}a.ics`, 'x', ICALENDAR_CONTENT_TYPE, { ifMatch: bad })).rejects.toThrow(/not a valid entity tag/);
    }
    await expect(c.put(`${HOME}a.ics`, 'x', ICALENDAR_CONTENT_TYPE, { ifNoneMatch: '"x"' as '*' })).rejects.toThrow(
      /only supports "\*"/,
    );
    expect(f.calls).toHaveLength(5);
  });

  it('DELETE with and without If-Match', async () => {
    const f = fake({ status: 204 }, { status: 204 });
    const c = client(f.request);
    expect(await c.delete(`${HOME}a.ics`, { ifMatch: '"e1"' })).toEqual({ status: 204 });
    expect(await c.delete(`${HOME}b.ics`)).toEqual({ status: 204 });
    expect(f.calls.map((r) => [r.method, header(r, 'If-Match')])).toEqual([
      ['DELETE', '"e1"'],
      ['DELETE', undefined],
    ]);
  });

  it('DELETE / MOVE answered 207 Multi-Status (partly done) is an error, never success', async () => {
    const partial =
      '<multistatus xmlns="DAV:"><response><href>/200385701/calendars/work/locked.ics</href>' +
      '<status>HTTP/1.1 423 Locked</status></response></multistatus>';
    const f = fake({ status: 207, body: partial }, { status: 207, body: partial });
    const c = client(f.request);
    const del = (await c.delete(`${HOME}work/`, { ifMatch: '"e"' }).catch((e: unknown) => e)) as UpstreamError;
    expect(del).toBeInstanceOf(UpstreamError);
    expect(del.status).toBe(207);
    expect(del.code).toBe('UPSTREAM_ERROR');
    expect(del.message).toMatch(/DELETE \/200385701\/calendars\/work\/ was only partly carried out.*could not delete/);
    expect(del.hint).toMatch(/Re-read/);
    const mv = (await c.move(`${HOME}work/`, `${HOME}home/`).catch((e: unknown) => e)) as UpstreamError;
    expect(mv).toBeInstanceOf(UpstreamError);
    expect(mv.message).toMatch(/MOVE .* could not move/);
    expect(f.calls).toHaveLength(2);
  });

  it('MOVE: absolute Destination on the same host, Overwrite F by default, T on request', async () => {
    const f = fake({ status: 201 }, { status: 204 });
    const c = client(f.request);
    expect(await c.move(`${HOME}home/a.ics`, `${HOME}work/a.ics`, { ifMatch: '"e"' })).toEqual({ status: 201 });
    expect(f.calls[0]!.method).toBe('MOVE');
    expect(header(f.calls[0]!, 'Destination')).toBe(`${HOME}work/a.ics`);
    expect(header(f.calls[0]!, 'Overwrite')).toBe('F');
    expect(header(f.calls[0]!, 'If-Match')).toBe('"e"');
    await c.move(`${HOME}home/b.ics`, `${HOME}work/b.ics`, { overwrite: true });
    expect(header(f.calls[1]!, 'Overwrite')).toBe('T');
    expect(header(f.calls[1]!, 'If-Match')).toBeUndefined();
    await expect(c.move(`${HOME}home/a.ics`, 'https://p1-caldav.icloud.com/x/a.ics')).rejects.toThrow(/same host/);
    await expect(c.move(`${HOME}home/a.ics`, 'nope')).rejects.toThrow(InvalidArgumentError);
    expect(f.calls).toHaveLength(2);
  });
});

describe('DavClient error mapping', () => {
  it('401 latches the credentials, fires onRefused, and later calls never reach the network', async () => {
    const denied = vi.fn();
    const f = fake({ status: 401 });
    const c = client(f.request, { onRefused: denied });
    const err = await c.get(`${HOME}a.ics`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialsRejectedError);
    expect((err as CredentialsRejectedError).status).toBe(401);
    expect((err as CredentialsRejectedError).hint).toBe(REJECTED_HINT);
    expect(errorMessage(err)).not.toContain(PASS);
    expect(denied).toHaveBeenCalledWith(401, `${HOME}a.ics`);
    await expect(client(f.request).propfind(HOME, [[NS.DAV, 'resourcetype']], 0)).rejects.toThrow(/already rejected/);
    expect(f.calls).toHaveLength(1);
  });

  it('a bare 403 on a discovery host is a credential rejection (latched)', async () => {
    expect([...DAV_DISCOVERY_HOSTS]).toEqual(['caldav.icloud.com', 'contacts.icloud.com']);
    const denied = vi.fn();
    const f = fake({ status: 403, body: 'Forbidden' });
    const err = await client(f.request, { onRefused: denied, service: 'contacts' })
      .propfind('https://Contacts.iCloud.com/', [[NS.DAV, 'current-user-principal']], 0)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialsRejectedError);
    expect((err as CredentialsRejectedError).status).toBe(403);
    expect((err as CredentialsRejectedError).service).toBe('contacts');
    expect(denied).toHaveBeenCalledWith(403, 'https://contacts.icloud.com/');
    await expect(client(f.request).get(`${HOME}a.ics`)).rejects.toBeInstanceOf(CredentialsRejectedError);
    expect(f.calls).toHaveLength(1);
  });

  // A CDN/WAF refusal page is not iCloud judging the password (mcp-host#1015):
  // latching on it would refuse a working Apple ID locally for a day.
  it('a CloudFront block page on a discovery host is an UpstreamError, NOT latched', async () => {
    const BLOCK =
      '<HTML><HEAD><TITLE>ERROR: The request could not be satisfied</TITLE></HEAD><BODY><H1>403 ERROR</H1>' +
      'Request blocked. We can\'t connect to the server for this app or website at this time.' +
      '<PRE>Generated by cloudfront (CloudFront)\nRequest ID: AbCdEf==</PRE></BODY></HTML>';
    const denied = vi.fn();
    const f = fake({ status: 403, body: BLOCK }, { status: 207, body: MS_EMPTY });
    const err = await client(f.request, { onRefused: denied, service: 'contacts' })
      .propfind('https://contacts.icloud.com/', [[NS.DAV, 'current-user-principal']], 0)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).not.toBeInstanceOf(CredentialsRejectedError);
    expect((err as UpstreamError).status).toBe(403);
    expect((err as UpstreamError).message).toMatch(/CDN\/WAF \(CloudFront\)/);
    expect((err as UpstreamError).hint).toMatch(/not a rejected password/);
    expect(denied).not.toHaveBeenCalled();
    // Not latched: the next request is sent rather than refused locally.
    await expect(client(f.request).propfind(HOME, [[NS.DAV, 'resourcetype']], 0)).resolves.toBeDefined();
    expect(f.calls).toHaveLength(2);
  });

  it('a bare 403 on a partition host is an UpstreamError, NOT latched, and flags cached discovery', async () => {
    const denied = vi.fn();
    const f = fake({ status: 403 }, { status: 207, body: MS_EMPTY });
    const c = client(f.request, { onRefused: denied });
    const err = await c.put(`${HOME}work/a.ics`, 'x', ICALENDAR_CONTENT_TYPE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).not.toBeInstanceOf(CredentialsRejectedError);
    expect((err as UpstreamError).status).toBe(403);
    expect((err as UpstreamError).hint).toMatch(/read-only/);
    expect(denied).toHaveBeenCalledWith(403, `${HOME}work/a.ics`);
    await expect(c.propfind(HOME, [[NS.DAV, 'resourcetype']], 0)).resolves.toBeDefined();
  });

  it('a 403 carrying a DAV:error names the condition and never latches', async () => {
    const denied = vi.fn();
    const f = fake(
      { status: 403, body: '<D:error xmlns:D="DAV:"><D:need-privileges/></D:error>' },
      { status: 403, body: '<error xmlns="DAV:"><no-uid-conflict xmlns="urn:ietf:params:xml:ns:caldav"/></error>' },
      { status: 409, body: '<error xmlns="DAV:"><valid-sync-token/></error>' },
      { status: 400, body: '<error xmlns="DAV:"><something-else/></error>' },
      { status: 207, body: MS_EMPTY },
    );
    const c = client(f.request, { onRefused: denied });
    const e1 = (await c.put(`${HOME}sub/a.ics`, 'x', ICALENDAR_CONTENT_TYPE).catch((e: unknown) => e)) as UpstreamError;
    expect(e1).toBeInstanceOf(UpstreamError);
    expect(e1.upstreamCode).toBe('need-privileges');
    expect(e1.message).toMatch(/HTTP 403: need-privileges/);
    expect(e1.hint).toMatch(/read-only or subscribed/);
    const e2 = (await c.put(`${HOME}a/b.ics`, 'x', ICALENDAR_CONTENT_TYPE).catch((e: unknown) => e)) as UpstreamError;
    expect(e2.upstreamCode).toBe('no-uid-conflict');
    expect(e2.hint).toMatch(/same UID/);
    const e3 = (await c.report(HOME, '<x/>', 0).catch((e: unknown) => e)) as UpstreamError;
    expect(e3.status).toBe(409);
    expect(e3.upstreamCode).toBe('valid-sync-token');
    expect(e3.hint).toMatch(/sync token has expired/);
    const e4 = (await c.report(HOME, '<x/>', 0).catch((e: unknown) => e)) as UpstreamError;
    expect(e4.upstreamCode).toBe('something-else');
    expect(e4.hint).toBeUndefined();
    expect(denied).not.toHaveBeenCalled();
    await expect(c.propfind(HOME, [[NS.DAV, 'resourcetype']], 0)).resolves.toBeDefined();
  });

  it('uid-conflict gets the same hint as no-uid-conflict', async () => {
    const f = fake({ status: 403, body: '<error xmlns="DAV:"><uid-conflict/></error>' });
    const e = (await client(f.request).put(`${HOME}a.ics`, 'x', ICALENDAR_CONTENT_TYPE).catch((x: unknown) => x)) as UpstreamError;
    expect(e.hint).toMatch(/same UID/);
  });

  it('412 on a conditional request is a typed PreconditionFailedError naming what failed', async () => {
    const f = fake({ status: 412 }, { status: 412 }, { status: 412 }, { status: 412 }, { status: 412 });
    const c = client(f.request);
    const changed = (await c.put(`${HOME}a.ics`, 'x', ICALENDAR_CONTENT_TYPE, { ifMatch: '"e"' }).catch((e: unknown) => e)) as PreconditionFailedError;
    expect(changed).toBeInstanceOf(PreconditionFailedError);
    expect(changed).toBeInstanceOf(UpstreamError);
    expect(changed.name).toBe('PreconditionFailedError');
    expect(changed.status).toBe(412);
    expect(changed.code).toBe('UPSTREAM_ERROR');
    expect(changed.preconditions).toEqual(['if-match']);
    expect(changed.message).toMatch(/changed on iCloud since it was read.*nothing was changed/);
    expect(changed.hint).toMatch(/Re-read/);
    const exists = (await c.put(`${HOME}a.ics`, 'x', ICALENDAR_CONTENT_TYPE, { ifNoneMatch: '*' }).catch((e: unknown) => e)) as PreconditionFailedError;
    expect(exists.preconditions).toEqual(['if-none-match']);
    expect(exists.message).toMatch(/already exists on iCloud/);
    expect(exists.hint).toMatch(/instead of creating it again/);
    const gone = (await c.delete(`${HOME}a.ics`, { ifMatch: '"e"' }).catch((e: unknown) => e)) as PreconditionFailedError;
    expect(gone.preconditions).toEqual(['if-match']);
    const dest = (await c.move(`${HOME}a/x.ics`, `${HOME}b/x.ics`).catch((e: unknown) => e)) as PreconditionFailedError;
    expect(dest.preconditions).toEqual(['overwrite']);
    expect(dest.message).toMatch(/destination already exists/);
    const either = (await c.move(`${HOME}a/x.ics`, `${HOME}b/x.ics`, { ifMatch: 'e' }).catch((e: unknown) => e)) as PreconditionFailedError;
    expect(either.preconditions).toEqual(['overwrite', 'if-match']);
    expect(either.message).toMatch(/since it was read.*, or the destination already exists/);
  });

  it('leaves everything else to httpRequest’s default mapping (404/410, unconditional 412, 5xx even with a DAV body)', async () => {
    const refused = vi.fn();
    const f = fake(
      { status: 404 },
      { status: 412, body: '<error xmlns="DAV:"><x/></error>' },
      { status: 412 },
      { status: 500, body: '<error xmlns="DAV:"><x/></error>' },
      { status: 412 },
      { status: 410 },
      { status: 404, body: '<error xmlns="DAV:"><gone-for-a-reason/></error>' },
    );
    const c = client(f.request, { onRefused: refused });
    await expect(c.get(`${HOME}a.ics`)).rejects.toThrow('DEFAULT_MAPPING 404');
    expect(refused).toHaveBeenLastCalledWith(404, `${HOME}a.ics`);
    await expect(c.report(HOME, '<uid-filter/>', 1)).rejects.toThrow(UpstreamError); // DAV body names the condition
    await expect(c.report(HOME, '<uid-filter/>', 1)).rejects.toThrow('DEFAULT_MAPPING 412');
    await expect(c.put(`${HOME}a.ics`, 'x', ICALENDAR_CONTENT_TYPE)).rejects.toThrow('DEFAULT_MAPPING 500');
    await expect(c.move(`${HOME}a.ics`, `${HOME}b.ics`, { overwrite: true })).rejects.toThrow('DEFAULT_MAPPING 412');
    await expect(c.propfind(`${HOME}old/`, [[NS.DAV, 'resourcetype']], 0)).rejects.toThrow('DEFAULT_MAPPING 410');
    expect(refused).toHaveBeenLastCalledWith(410, `${HOME}old/`);
    await expect(c.get(`${HOME}b.ics`)).rejects.toSatisfy((e: unknown) => e instanceof UpstreamError && e.upstreamCode === 'gone-for-a-reason');
    expect(refused).toHaveBeenCalledTimes(2);
  });

  it('a 408 is left to httpRequest even with a DAV:error body (a write may have landed)', async () => {
    const refused = vi.fn();
    const f = fake({ status: 408, body: '<error xmlns="DAV:"><x/></error>' });
    await expect(client(f.request, { onRefused: refused }).put(`${HOME}a.ics`, 'x', ICALENDAR_CONTENT_TYPE)).rejects.toThrow(
      'DEFAULT_MAPPING 408',
    );
    expect(refused).not.toHaveBeenCalled();
  });

  it('refuses up front when the pair is already latched', async () => {
    const f = fake({ status: 401 });
    await client(f.request).get(`${HOME}a.ics`).catch(() => undefined);
    const again = fake();
    await expect(client(again.request).put(`${HOME}a.ics`, 'x', ICALENDAR_CONTENT_TYPE)).rejects.toBeInstanceOf(CredentialsRejectedError);
    expect(again.calls).toHaveLength(0);
  });
});

describe('DavClient.probe', () => {
  it('answers ok for a reachable collection', async () => {
    const f = fake({ status: 207, body: MS_HOME });
    expect(await client(f.request).probe(HOME)).toEqual({ ok: true });
    expect(f.calls[0]!.method).toBe('PROPFIND');
    expect(header(f.calls[0]!, 'Depth')).toBe('0');
    expect(f.calls[0]!.body).toContain('<d:resourcetype/>');
  });

  it('answers 403/404/410 without throwing and WITHOUT latching', async () => {
    const denied = vi.fn();
    const f = fake({ status: 403 }, { status: 404 }, { status: 410 }, { status: 207, body: MS_EMPTY });
    const c = client(f.request, { onRefused: denied });
    expect(await c.probe('https://caldav.icloud.com/')).toEqual({ ok: false, status: 403 });
    expect(await c.probe(HOME)).toEqual({ ok: false, status: 404 });
    expect(await c.probe(HOME)).toEqual({ ok: false, status: 410 });
    expect(denied).not.toHaveBeenCalled();
    expect(await c.probe(HOME)).toEqual({ ok: true });
  });

  it('a 401 is definitive even on a probe: it latches, fires onRefused and throws — the pair is not sent again', async () => {
    const denied = vi.fn();
    const f = fake({ status: 401 });
    const c = client(f.request, { onRefused: denied });
    const err = await c.probe(HOME).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialsRejectedError);
    expect((err as CredentialsRejectedError).message).toContain('HTTP 401 on PROPFIND /200385701/calendars/');
    expect(denied).toHaveBeenCalledWith(401, HOME);
    const again = fake();
    await expect(client(again.request).probe(HOME)).rejects.toBeInstanceOf(CredentialsRejectedError);
    expect(again.calls).toHaveLength(0);
  });

  it('throws anything else', async () => {
    await expect(client(fake({ status: 500 }).request).probe(HOME)).rejects.toThrow('DEFAULT_MAPPING 500');
  });
});

describe('DavClient over the real httpRequest (fetch stubbed)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(...responses: Array<() => Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fn = vi.fn(async (url: URL | string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      const next = responses.shift();
      if (!next) throw new Error('unexpected fetch');
      return next();
    });
    vi.stubGlobal('fetch', fn);
    return calls;
  }

  const real = () => new DavClient({ service: 'calendar', username: USER, password: PASS });

  it('follows a redirect to the partition host and resolves hrefs against it', async () => {
    const calls = stubFetch(
      () => new Response(null, { status: 301, headers: { Location: 'https://p34-caldav.icloud.com/200385701/calendars/' } }),
      () => new Response(MS_HOME, { status: 207, headers: { 'Content-Type': 'text/xml; charset=utf-8' } }),
    );
    const ms = await real().propfind('https://caldav.icloud.com/200385701/calendars/', [[NS.DAV, 'resourcetype']], 1);
    expect(calls.map((c) => [c.url, c.init.method])).toEqual([
      ['https://caldav.icloud.com/200385701/calendars/', 'PROPFIND'],
      ['https://p34-caldav.icloud.com/200385701/calendars/', 'PROPFIND'],
    ]);
    expect(calls[0]!.init.redirect).toBe('manual');
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe(`Basic ${TOKEN}`);
    expect(ms.responses[1]!.url).toBe('https://p34-caldav.icloud.com/200385701/calendars/work/');
  });

  it('a redirect off Apple is refused before the credential travels (httpRequest re-checks every hop)', async () => {
    const calls = stubFetch(() => new Response(null, { status: 302, headers: { Location: 'https://evil.example.com/steal' } }));
    await expect(real().propfind(HOME, [[NS.DAV, 'resourcetype']], 0)).rejects.toThrow(/not an allowed Apple host/);
    expect(calls.map((c) => c.url)).toEqual([HOME]);
  });

  it('401 is mapped by the client (latched, REJECTED_HINT), not by the generic default', async () => {
    stubFetch(() => new Response('Unauthorized', { status: 401 }));
    const err = (await real().get(`${HOME}a.ics`).catch((e: unknown) => e)) as CredentialsRejectedError;
    expect(err).toBeInstanceOf(CredentialsRejectedError);
    expect(err.hint).toBe(REJECTED_HINT);
    await expect(real().get(`${HOME}a.ics`)).rejects.toThrow(/already rejected/);
  });

  it('a PUT answered 503 is an UnconfirmedWriteError (may have landed), never retried', async () => {
    const calls = stubFetch(() => new Response('busy', { status: 503 }));
    await expect(real().put(`${HOME}a.ics`, 'x', ICALENDAR_CONTENT_TYPE, { ifNoneMatch: '*' })).rejects.toBeInstanceOf(
      UnconfirmedWriteError,
    );
    expect(calls).toHaveLength(1);
  });

  it('a PUT answered 408 (with or without a DAV:error body) is an UnconfirmedWriteError', async () => {
    const calls = stubFetch(() => new Response('<error xmlns="DAV:"><x/></error>', { status: 408 }));
    await expect(real().put(`${HOME}a.ics`, 'x', ICALENDAR_CONTENT_TYPE, { ifNoneMatch: '*' })).rejects.toBeInstanceOf(
      UnconfirmedWriteError,
    );
    expect(calls).toHaveLength(1);
  });

  it('a DELETE answered 207 through the real httpRequest is an UpstreamError, not success', async () => {
    stubFetch(() => new Response('<multistatus xmlns="DAV:"/>', { status: 207, headers: { 'Content-Type': 'application/xml' } }));
    await expect(real().delete(`${HOME}work/`)).rejects.toSatisfy((e: unknown) => e instanceof UpstreamError && e.status === 207);
  });

  it('a PUT answered 412 is a PreconditionFailedError', async () => {
    stubFetch(() => new Response('', { status: 412 }));
    await expect(real().put(`${HOME}a.ics`, 'x', ICALENDAR_CONTENT_TYPE, { ifMatch: '"old"' })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
  });

  it('refuses a host outside iCloud before sending credentials — even another allowlisted Apple host', async () => {
    const calls = stubFetch();
    await expect(real().get('https://evil.example.com/a.ics')).rejects.toThrow(/only https:\/\/\*\.icloud\.com/);
    await expect(real().get('https://api.music.apple.com/v1/x')).rejects.toThrow(/refusing to send iCloud credentials/);
    await expect(real().get('http://p34-caldav.icloud.com/a.ics')).rejects.toThrow(AppleToolError);
    await expect(real().get('https://icloud.com/a.ics')).rejects.toThrow(AppleToolError);
    await expect(real().get('https://p34-caldav.icloud.com.evil.example/a.ics')).rejects.toThrow(AppleToolError);
    expect(calls).toHaveLength(0);
  });

  it('isICloudUrl', () => {
    expect(isICloudUrl(new URL('https://P34-CalDAV.iCloud.com:443/x'))).toBe(true);
    expect(isICloudUrl(new URL('https://caldav.icloud.com/'))).toBe(true);
    expect(isICloudUrl(new URL('https://.icloud.com/'))).toBe(false);
  });
});

describe('URL helpers', () => {
  it('sameResource ignores the default port, a trailing slash and escape spelling', () => {
    expect(sameResource('https://p34-caldav.icloud.com:443/1/calendars/home/', 'https://P34-caldav.icloud.com/1/calendars/home')).toBe(true);
    expect(sameResource('https://h.icloud.com/a%40b/', 'https://h.icloud.com/a@b/')).toBe(true);
    expect(sameResource('https://h.icloud.com/a/', 'https://h.icloud.com/a/b/')).toBe(false);
    expect(sameResource('https://h.icloud.com/a/', 'https://g.icloud.com/a/')).toBe(false);
    expect(sameResource('https://h.icloud.com/a/', 'http://h.icloud.com/a/')).toBe(false);
    expect(sameResource('not a url', 'not a url')).toBe(false);
    expect(sameResource('https://h.icloud.com/%ZZ/', 'https://h.icloud.com/%ZZ')).toBe(true);
  });

  it('lastPathSegment decodes and ignores a trailing slash', () => {
    expect(lastPathSegment('https://h.icloud.com/1/calendars/home/')).toBe('home');
    expect(lastPathSegment('https://h.icloud.com/1/card/A%20B.vcf')).toBe('A B.vcf');
    expect(lastPathSegment('https://h.icloud.com/')).toBe('');
    expect(lastPathSegment('https://h.icloud.com/x/%E0%A4%A')).toBe('%E0%A4%A');
    expect(() => lastPathSegment('relative')).toThrow(InvalidArgumentError);
  });

  it('childUrl encodes the name, adds a slash for collections, and refuses escapes', () => {
    expect(childUrl(HOME, 'work', { collection: true })).toBe(`${HOME}work/`);
    expect(childUrl(`${HOME}work`, 'A B@c.ics')).toBe(`${HOME}work/A%20B%40c.ics`);
    expect(childUrl(`${HOME}work/?x=1#f`, 'e.ics')).toBe(`${HOME}work/e.ics`);
    expect(childUrl(HOME, 'foo:bar.ics')).toBe(`${HOME}foo%3Abar.ics`);
    expect(childUrl(HOME, '%2e%2e')).toBe(`${HOME}%252e%252e`);
    for (const bad of ['', '.', '..', 'a/b', 'a\\b']) {
      expect(() => childUrl(HOME, bad)).toThrow(/not a valid item name/);
    }
    expect(() => childUrl('nope', 'a')).toThrow(InvalidArgumentError);
  });
});
