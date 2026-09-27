import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, CredentialsRejectedError, UpstreamError, scrub } from '../../src/errors.js';
import { stateCache } from '../../src/state.js';
import type { HttpRequest, HttpResponse } from '../../src/http.js';
import { DavClient, type DavRequestFn } from '../../src/dav/client.js';
import {
  ICLOUD_DAV_ROOTS,
  discover,
  forgetDavContext,
  getDavContext,
  validateDiscovery,
} from '../../src/dav/icloud.js';
import { NS } from '../../src/dav/xml.js';

const USER = 'someone@icloud.com';
const PASS = 'abcd-efgh-ijkl-mnop';
const DSID = '200385701';
const PRINCIPAL = `https://caldav.icloud.com/${DSID}/principal/`;
const HOME = `https://p34-caldav.icloud.com/${DSID}/calendars/`;
const CARD_PRINCIPAL = `https://contacts.icloud.com/${DSID}/principal/`;
const CARD_HOME = `https://p50-contacts.icloud.com/${DSID}/carddavhome/`;

interface Step {
  method: string;
  url: string;
  status: number;
  body?: string;
}

/** A scripted httpRequest stand-in that also checks each request's method + URL. */
function fake(...script: Step[]) {
  const calls: HttpRequest[] = [];
  const request: DavRequestFn = async (req) => {
    calls.push(req);
    const next = script.shift();
    if (!next) throw new Error(`unexpected request ${req.method} ${String(req.url)}`);
    expect(`${req.method} ${String(req.url)}`).toBe(`${next.method} ${next.url}`);
    const headers = new Headers();
    const text = next.body ?? '';
    if (next.status >= 300) {
      const custom = req.classifyError?.(next.status, text, headers);
      if (custom) throw custom;
      throw new UpstreamError(req.service, next.status, `DEFAULT_MAPPING ${next.status}`);
    }
    const res: HttpResponse<unknown> = { status: next.status, headers, url: String(req.url), data: text, text, bytes: new Uint8Array() };
    return res;
  };
  return { request, calls, remaining: script };
}

const principalAnswer = (href: string) =>
  '<multistatus xmlns="DAV:"><response xmlns="DAV:"><href>/</href><propstat><prop>' +
  `<current-user-principal xmlns="DAV:"><href xmlns="DAV:">${href}</href></current-user-principal>` +
  '</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';

const homeAnswer = (ns: string, name: string, href: string) =>
  `<multistatus xmlns="DAV:"><response><href>/${DSID}/principal/</href><propstat><prop>` +
  `<${name} xmlns="${ns}"><href xmlns="DAV:">${href}</href></${name}>` +
  '</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';

const NOT_FOUND_PROP = (name: string) =>
  `<multistatus xmlns="DAV:"><response><href>/</href><propstat><prop><${name}/></prop>` +
  '<status>HTTP/1.1 404 Not Found</status></propstat></response></multistatus>';

const RESOURCETYPE =
  `<multistatus xmlns="DAV:"><response><href>/${DSID}/calendars/</href><propstat><prop><resourcetype><collection/></resourcetype>` +
  '</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';

const calendarDiscovery = (): Step[] => [
  { method: 'PROPFIND', url: 'https://caldav.icloud.com/', status: 207, body: principalAnswer(`/${DSID}/principal/`) },
  {
    method: 'PROPFIND',
    url: PRINCIPAL,
    status: 207,
    body: homeAnswer(NS.CALDAV, 'calendar-home-set', `https://p34-caldav.icloud.com:443/${DSID}/calendars/`),
  },
];

const stateDir = () => join(process.env.MCP_DATA_DIR as string, '.apple-icloud-mcp');
const stateFile = (kind: string) => join(stateDir(), `dav-${kind}.json`);

function setCreds(user = USER, pass = PASS) {
  process.env.ICLOUD_USERNAME = user;
  process.env.ICLOUD_APP_PASSWORD = pass;
}

beforeEach(() => {
  rmSync(stateDir(), { recursive: true, force: true });
  forgetDavContext();
});

afterEach(() => {
  forgetDavContext(undefined, { memoryOnly: true });
});

describe('discover', () => {
  it('walks root → principal → home (Depth 0) and lands on the partition host', async () => {
    const f = fake(...calendarDiscovery());
    const client = new DavClient({ service: 'calendar', username: USER, password: PASS, request: f.request });
    const found = await discover(client, 'calendar');
    expect(found).toEqual({ principalUrl: PRINCIPAL, homeUrl: HOME });
    expect(f.calls.map((c) => c.headers?.Depth)).toEqual(['0', '0']);
    expect(f.calls[0]!.body).toContain('<d:current-user-principal/>');
    expect(f.calls[1]!.body).toContain('<c:calendar-home-set/>');
    expect(ICLOUD_DAV_ROOTS).toEqual({ calendar: 'https://caldav.icloud.com/', contacts: 'https://contacts.icloud.com/' });
    // The account id in every DAV path is scrubbed from errors and logs from now on.
    expect(scrub(`PUT /${DSID}/calendars/x.ics failed`)).toBe('PUT /[REDACTED]/calendars/x.ics failed');
  });

  it('contacts: addressbook-home-set, a trailing slash added, the first response carrying the prop wins', async () => {
    const root =
      '<multistatus xmlns="DAV:"><response><href>/other/</href><propstat><prop><displayname>x</displayname></prop>' +
      '<status>HTTP/1.1 200 OK</status></propstat></response>' +
      `<response><href>/</href><propstat><prop><current-user-principal><href>/${DSID}/principal/</href></current-user-principal></prop>` +
      '<status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';
    const f = fake(
      { method: 'PROPFIND', url: 'https://contacts.icloud.com/', status: 207, body: root },
      {
        method: 'PROPFIND',
        url: CARD_PRINCIPAL,
        status: 207,
        body: homeAnswer(NS.CARDDAV, 'addressbook-home-set', `https://p50-contacts.icloud.com:443/${DSID}/carddavhome`),
      },
    );
    const client = new DavClient({ service: 'contacts', username: USER, password: PASS, request: f.request });
    expect(await discover(client, 'contacts')).toEqual({ principalUrl: CARD_PRINCIPAL, homeUrl: CARD_HOME });
    expect(f.calls[1]!.body).toContain('<card:addressbook-home-set/>');
  });

  it('a principal path without a numeric account id is not registered as a secret', async () => {
    const f = fake(
      { method: 'PROPFIND', url: 'https://caldav.icloud.com/', status: 207, body: principalAnswer('/principals/abc/') },
      {
        method: 'PROPFIND',
        url: 'https://caldav.icloud.com/principals/abc/',
        status: 207,
        body: homeAnswer(NS.CALDAV, 'calendar-home-set', 'https://p1-caldav.icloud.com/'),
      },
    );
    const client = new DavClient({ service: 'calendar', username: USER, password: PASS, request: f.request });
    expect(await discover(client, 'calendar')).toEqual({
      principalUrl: 'https://caldav.icloud.com/principals/abc/',
      homeUrl: 'https://p1-caldav.icloud.com/',
    });
    expect(scrub('principals abc')).toBe('principals abc');
  });

  it('scrubs the account id as soon as the principal is known — even when the next step fails', async () => {
    const f = fake(
      { method: 'PROPFIND', url: 'https://caldav.icloud.com/', status: 207, body: principalAnswer(`/${DSID}/principal/`) },
      { method: 'PROPFIND', url: PRINCIPAL, status: 500 },
    );
    const client = new DavClient({ service: 'calendar', username: USER, password: PASS, request: f.request });
    // Nothing registered yet (tests/_setup.ts forgets secrets before each test).
    expect(scrub(`PROPFIND /${DSID}/principal/`)).toContain(DSID);
    await expect(discover(client, 'calendar')).rejects.toThrow('DEFAULT_MAPPING 500');
    expect(scrub(`calendar: PROPFIND /${DSID}/principal/ failed with HTTP 500`)).toBe(
      'calendar: PROPFIND /[REDACTED]/principal/ failed with HTTP 500',
    );
  });

  it('refuses to guess when the principal is missing', async () => {
    const f = fake({ method: 'PROPFIND', url: 'https://caldav.icloud.com/', status: 207, body: NOT_FOUND_PROP('current-user-principal') });
    const client = new DavClient({ service: 'calendar', username: USER, password: PASS, request: f.request });
    await expect(discover(client, 'calendar')).rejects.toSatisfy(
      (e: unknown) => e instanceof UpstreamError && /current-user-principal/.test(e.message),
    );
  });

  it('refuses to guess when the home set is missing, with a per-service hint', async () => {
    for (const [kind, root, principal, name, hint] of [
      ['calendar', 'https://caldav.icloud.com/', PRINCIPAL, 'calendar-home-set', /Calendars is turned on/],
      ['contacts', 'https://contacts.icloud.com/', CARD_PRINCIPAL, 'addressbook-home-set', /Contacts is turned on/],
    ] as const) {
      const f = fake(
        { method: 'PROPFIND', url: root, status: 207, body: principalAnswer(`/${DSID}/principal/`) },
        { method: 'PROPFIND', url: principal, status: 207, body: NOT_FOUND_PROP(name) },
      );
      const client = new DavClient({ service: kind, username: USER, password: PASS, request: f.request });
      const err = (await discover(client, kind).catch((e: unknown) => e)) as UpstreamError;
      expect(err).toBeInstanceOf(UpstreamError);
      expect(err.message).toContain(name);
      expect(err.hint).toMatch(hint);
    }
  });

  it('refuses a home set that points outside iCloud (even to another Apple host)', async () => {
    for (const href of ['https://evil.example.com/cal/', 'https://api.music.apple.com/cal/', 'http://p34-caldav.icloud.com/cal/']) {
      const f = fake(
        { method: 'PROPFIND', url: 'https://caldav.icloud.com/', status: 207, body: principalAnswer(`/${DSID}/principal/`) },
        { method: 'PROPFIND', url: PRINCIPAL, status: 207, body: homeAnswer(NS.CALDAV, 'calendar-home-set', href) },
      );
      const client = new DavClient({ service: 'calendar', username: USER, password: PASS, request: f.request });
      await expect(discover(client, 'calendar')).rejects.toSatisfy(
        (e: unknown) => e instanceof UpstreamError && /outside iCloud/.test(e.message) && /only ever sent/.test(e.hint ?? ''),
      );
    }
  });

  it('bad credentials at the root latch (401 and the bare 403 iCloud sends for non-Apple usernames)', async () => {
    for (const status of [401, 403]) {
      const user = `user${status}@example.com`;
      const f = fake({ method: 'PROPFIND', url: 'https://caldav.icloud.com/', status });
      const client = new DavClient({ service: 'calendar', username: user, password: PASS, request: f.request });
      await expect(discover(client, 'calendar')).rejects.toBeInstanceOf(CredentialsRejectedError);
      const again = fake();
      const second = new DavClient({ service: 'calendar', username: user, password: PASS, request: again.request });
      await expect(discover(second, 'calendar')).rejects.toThrow(/already rejected/);
      expect(again.calls).toHaveLength(0);
    }
  });
});

describe('validateDiscovery', () => {
  it('accepts only https Apple URLs with a collection home', () => {
    expect(validateDiscovery({ principalUrl: PRINCIPAL, homeUrl: HOME })).toEqual({ principalUrl: PRINCIPAL, homeUrl: HOME });
    expect(validateDiscovery({ principalUrl: PRINCIPAL, homeUrl: HOME, extra: 1 })).toEqual({ principalUrl: PRINCIPAL, homeUrl: HOME });
    expect(validateDiscovery(null)).toBeNull();
    expect(validateDiscovery('x')).toBeNull();
    expect(validateDiscovery({})).toBeNull();
    expect(validateDiscovery({ principalUrl: 1, homeUrl: HOME })).toBeNull();
    expect(validateDiscovery({ principalUrl: 'not a url', homeUrl: HOME })).toBeNull();
    expect(validateDiscovery({ principalUrl: PRINCIPAL, homeUrl: 'http://p34-caldav.icloud.com/1/calendars/' })).toBeNull();
    expect(validateDiscovery({ principalUrl: PRINCIPAL, homeUrl: 'https://evil.example.com/1/calendars/' })).toBeNull();
    expect(validateDiscovery({ principalUrl: 'https://music.apple.com/1/principal/', homeUrl: HOME })).toBeNull();
    expect(validateDiscovery({ principalUrl: PRINCIPAL, homeUrl: 'https://p34-caldav.icloud.com/1/calendars' })).toBeNull();
  });
});

describe('getDavContext', () => {
  it('is a ConfigError (at call time) without credentials, and sends nothing', async () => {
    const f = fake();
    const err = (await getDavContext('calendar', { request: f.request }).catch((e: unknown) => e)) as ConfigError;
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.service).toBe('calendar');
    expect(err.missing).toEqual(['ICLOUD_USERNAME', 'ICLOUD_APP_PASSWORD']);
    expect(f.calls).toHaveLength(0);
  });

  it('discovers once, then serves from memory; the disk record never holds the password', async () => {
    setCreds();
    const f = fake(...calendarDiscovery());
    const first = await getDavContext('calendar', { request: f.request });
    expect(first.source).toBe('discovered');
    expect(first.homeUrl).toBe(HOME);
    expect(first.principalUrl).toBe(PRINCIPAL);
    expect(first.client).toBeInstanceOf(DavClient);
    expect(first.client.service).toBe('calendar');
    const second = await getDavContext('calendar', { request: f.request });
    expect(second.source).toBe('memory');
    expect(second.homeUrl).toBe(HOME);
    expect(f.calls).toHaveLength(2);
    const file = readFileSync(stateFile('calendar'), 'utf8');
    expect(file).toContain(HOME);
    expect(file).not.toContain(PASS);
    expect(file).not.toContain(Buffer.from(`${USER}:${PASS}`).toString('base64'));
  });

  it('after a restart, trusts a disk record only after one cheap PROPFIND of the home', async () => {
    setCreds();
    await getDavContext('calendar', { request: fake(...calendarDiscovery()).request });
    forgetDavContext(undefined, { memoryOnly: true });
    const f = fake({ method: 'PROPFIND', url: HOME, status: 207, body: RESOURCETYPE });
    const ctx = await getDavContext('calendar', { request: f.request });
    expect(ctx.source).toBe('disk');
    expect(ctx.homeUrl).toBe(HOME);
    expect(f.calls[0]!.headers?.Depth).toBe('0');
    expect((await getDavContext('calendar', { request: f.request })).source).toBe('memory');
    expect(f.calls).toHaveLength(1);
  });

  it('a correctly BOUND disk record pointing off iCloud is refused (validateDiscovery runs on load) — no probe', async () => {
    setCreds();
    // The same binding getDavContext uses, so only validation can reject the record.
    const digest = createHash('sha256').update(`dav\u0000calendar\u0000${USER}\u0000${PASS}`).digest('hex');
    const raw = stateCache<unknown>('dav-calendar.json', digest, (x) => x);
    // Control: a VALID record under this binding is used, so the binding matches getDavContext's.
    const other = `https://p99-caldav.icloud.com/${DSID}/calendars/`;
    raw.save({ principalUrl: PRINCIPAL, homeUrl: other });
    const control = await getDavContext('calendar', { request: fake({ method: 'PROPFIND', url: other, status: 207, body: RESOURCETYPE }).request });
    expect(control.source).toBe('disk');
    expect(control.homeUrl).toBe(other);
    forgetDavContext(undefined, { memoryOnly: true });
    // Now the same binding with a home off iCloud: only validation can reject it.
    raw.save({ principalUrl: PRINCIPAL, homeUrl: 'https://api.music.apple.com/x/' });
    const f = fake(...calendarDiscovery());
    const ctx = await getDavContext('calendar', { request: f.request });
    expect(ctx.source).toBe('discovered');
    expect(ctx.homeUrl).toBe(HOME);
    expect(f.calls.map((c) => String(c.url))).toEqual(['https://caldav.icloud.com/', PRINCIPAL]);
  });

  it('a corrupt disk record is ignored and replaced by a fresh discovery', async () => {
    setCreds();
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(stateFile('calendar'), '{not json');
    const ctx = await getDavContext('calendar', { request: fake(...calendarDiscovery()).request });
    expect(ctx.source).toBe('discovered');
    expect(readFileSync(stateFile('calendar'), 'utf8')).toContain(HOME);
  });

  it('rediscovers once when the cached home is gone (404) or refused (403) — and saves the new home', async () => {
    for (const status of [404, 403]) {
      setCreds();
      rmSync(stateDir(), { recursive: true, force: true });
      forgetDavContext(undefined, { memoryOnly: true });
      await getDavContext('calendar', { request: fake(...calendarDiscovery()).request });
      forgetDavContext(undefined, { memoryOnly: true });
      const moved = `https://p77-caldav.icloud.com/${DSID}/calendars/`;
      const f = fake(
        { method: 'PROPFIND', url: HOME, status },
        { method: 'PROPFIND', url: 'https://caldav.icloud.com/', status: 207, body: principalAnswer(`/${DSID}/principal/`) },
        { method: 'PROPFIND', url: PRINCIPAL, status: 207, body: homeAnswer(NS.CALDAV, 'calendar-home-set', moved) },
      );
      const ctx = await getDavContext('calendar', { request: f.request });
      expect(f.remaining).toHaveLength(0);
      expect(ctx.source).toBe('discovered');
      expect(ctx.homeUrl).toBe(moved);
      expect(readFileSync(stateFile('calendar'), 'utf8')).toContain(moved);
    }
  });

  it('a 401 from the cached home latches at once: a revoked pair is sent ONCE on a cold start, not again to rediscover', async () => {
    setCreds();
    await getDavContext('calendar', { request: fake(...calendarDiscovery()).request });
    expect(existsSync(stateFile('calendar'))).toBe(true);
    forgetDavContext(undefined, { memoryOnly: true }); // cold start: memory gone, disk record kept
    const f = fake({ method: 'PROPFIND', url: HOME, status: 401 });
    await expect(getDavContext('calendar', { request: f.request })).rejects.toBeInstanceOf(CredentialsRejectedError);
    expect(f.calls.map((c) => `${c.method} ${String(c.url)}`)).toEqual([`PROPFIND ${HOME}`]); // the root was NOT asked
    expect(existsSync(stateFile('calendar'))).toBe(false);
    const again = fake();
    await expect(getDavContext('calendar', { request: again.request })).rejects.toThrow(/already rejected/);
    expect(again.calls).toHaveLength(0);
  });

  it('a refusal through a returned client drops the cached discovery, so the next call rediscovers', async () => {
    setCreds();
    const f = fake(
      ...calendarDiscovery(),
      { method: 'PUT', url: `${HOME}work/a.ics`, status: 403 },
      ...calendarDiscovery(),
    );
    const ctx = await getDavContext('calendar', { request: f.request });
    expect(existsSync(stateFile('calendar'))).toBe(true);
    await expect(ctx.client.put(`${HOME}work/a.ics`, 'x', 'text/calendar')).rejects.toBeInstanceOf(UpstreamError);
    expect(existsSync(stateFile('calendar'))).toBe(false);
    const next = await getDavContext('calendar', { request: f.request });
    expect(next.source).toBe('discovered');
    expect(f.remaining).toHaveLength(0);
  });

  it('the home answering 404 through a returned client drops the cache; a missing CHILD does not', async () => {
    setCreds();
    const f = fake(
      ...calendarDiscovery(),
      { method: 'GET', url: `${HOME}work/missing.ics`, status: 404 },
      { method: 'PROPFIND', url: HOME, status: 404 },
      ...calendarDiscovery(),
    );
    const ctx = await getDavContext('calendar', { request: f.request });
    await expect(ctx.client.get(`${HOME}work/missing.ics`)).rejects.toThrow('DEFAULT_MAPPING 404');
    const still = await getDavContext('calendar', { request: f.request });
    expect(still.source).toBe('memory');
    await expect(still.client.propfind(HOME, [[NS.DAV, 'resourcetype']], 1)).rejects.toThrow('DEFAULT_MAPPING 404');
    expect(existsSync(stateFile('calendar'))).toBe(false);
    expect((await getDavContext('calendar', { request: f.request })).source).toBe('discovered');
    expect(f.remaining).toHaveLength(0);
  });

  it('a 404 during discovery itself (before the home is known) drops nothing and is reported', async () => {
    setCreds();
    const f = fake({ method: 'PROPFIND', url: 'https://caldav.icloud.com/', status: 404 });
    await expect(getDavContext('calendar', { request: f.request })).rejects.toThrow('DEFAULT_MAPPING 404');
  });

  it('concurrent first calls share one discovery', async () => {
    setCreds();
    const f = fake(...calendarDiscovery());
    const [a, b] = await Promise.all([
      getDavContext('calendar', { request: f.request }),
      getDavContext('calendar', { request: f.request }),
    ]);
    expect(a.homeUrl).toBe(HOME);
    expect(b.homeUrl).toBe(HOME);
    expect(f.calls).toHaveLength(2);
  });

  it('a failed discovery is not cached: the next call tries again', async () => {
    setCreds();
    const f = fake(
      { method: 'PROPFIND', url: 'https://caldav.icloud.com/', status: 500 },
      ...calendarDiscovery(),
    );
    await expect(getDavContext('calendar', { request: f.request })).rejects.toThrow('DEFAULT_MAPPING 500');
    expect((await getDavContext('calendar', { request: f.request })).source).toBe('discovered');
  });

  it('keeps accounts and kinds apart; a rotated password ignores the old disk record', async () => {
    setCreds();
    await getDavContext('calendar', { request: fake(...calendarDiscovery()).request });
    const contacts = fake(
      { method: 'PROPFIND', url: 'https://contacts.icloud.com/', status: 207, body: principalAnswer(`/${DSID}/principal/`) },
      { method: 'PROPFIND', url: CARD_PRINCIPAL, status: 207, body: homeAnswer(NS.CARDDAV, 'addressbook-home-set', CARD_HOME) },
    );
    expect((await getDavContext('contacts', { request: contacts.request })).homeUrl).toBe(CARD_HOME);
    forgetDavContext(undefined, { memoryOnly: true });
    setCreds(USER, 'wxyz-wxyz-wxyz-wxyz');
    const rotated = fake(...calendarDiscovery());
    expect((await getDavContext('calendar', { request: rotated.request })).source).toBe('discovered');
    expect(rotated.calls).toHaveLength(2);
  });

  it('reads credentials from deps.env and uses httpRequest (fetch) when no request is injected', async () => {
    const env = { ...process.env, ICLOUD_USERNAME: USER, ICLOUD_APP_PASSWORD: PASS, APPLE_STATE_CACHE: 'false' };
    const bodies = [principalAnswer(`/${DSID}/principal/`), homeAnswer(NS.CALDAV, 'calendar-home-set', HOME)];
    const fetched: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | string) => {
        fetched.push(String(url));
        return new Response(bodies.shift(), { status: 207, headers: { 'Content-Type': 'application/xml' } });
      }),
    );
    const ctx = await getDavContext('calendar', { env });
    expect(ctx.homeUrl).toBe(HOME);
    expect(fetched).toEqual(['https://caldav.icloud.com/', PRINCIPAL]);
    // APPLE_STATE_CACHE=false: nothing on disk.
    expect(existsSync(stateFile('calendar'))).toBe(false);
  });

  it('forgetDavContext clears one kind or both, memory and disk, and tolerates missing credentials', async () => {
    setCreds();
    await getDavContext('calendar', { request: fake(...calendarDiscovery()).request });
    expect(existsSync(stateFile('calendar'))).toBe(true);
    forgetDavContext('contacts');
    expect(existsSync(stateFile('calendar'))).toBe(true);
    forgetDavContext('calendar');
    expect(existsSync(stateFile('calendar'))).toBe(false);
    const f = fake(...calendarDiscovery());
    expect((await getDavContext('calendar', { request: f.request })).source).toBe('discovered');
    delete process.env.ICLOUD_USERNAME;
    expect(() => forgetDavContext()).not.toThrow();
  });
});
