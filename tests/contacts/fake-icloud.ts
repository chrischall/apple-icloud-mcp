import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach } from 'vitest';
import { UpstreamError } from '../../src/errors.js';
import type { HttpRequest, HttpResponse } from '../../src/http.js';
import type { DavRequestFn } from '../../src/dav/client.js';
import { forgetDavContext } from '../../src/dav/icloud.js';
import { resetContactsCache, type ContactsDeps } from '../../src/contacts/book.js';
import { registerContactsTools } from '../../src/contacts/tools.js';

export const USER = 'someone@icloud.com';
export const PASS = 'abcd-efgh-ijkl-mnop';
export const DSID = '27015122';
export const HOST = 'https://p50-contacts.icloud.com';
export const HOME = `${HOST}/${DSID}/carddavhome/`;
export const BOOK = `${HOME}card/`;
export const PRINCIPAL = `https://contacts.icloud.com/${DSID}/principal/`;

const CRLF = '\r\n';

/** Build a vCard text from lines (CRLF, trailing CRLF). */
export function vcard(...lines: string[]): string {
  return ['BEGIN:VCARD', 'VERSION:3.0', ...lines, 'END:VCARD', ''].join(CRLF);
}

export interface Failure {
  method?: string;
  /** The URL ends with this. */
  url?: string;
  status: number;
  body?: string;
  /** How many times it fires (default 1). */
  times?: number;
}

interface Card {
  body: string;
  etag: string;
}

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A stateful stand-in for iCloud CardDAV behind `httpRequest`: discovery,
 * the home listing, getctag, the unfiltered addressbook-query, and
 * GET / PUT (If-Match, If-None-Match) / DELETE on cards. Non-2xx answers go
 * through the request's `classifyError` then the default mapping, like
 * `httpRequest`.
 */
export class FakeICloud {
  readonly cards = new Map<string, Card>();
  ctag = 1;
  private etagSeq = 100;
  readonly calls: HttpRequest[] = [];
  readonly failures: Failure[] = [];
  /** Report getctag on the book (false → neither getctag nor sync-token, unless syncTokenOnly). */
  reportCtag = true;
  /** Report a sync-token instead of getctag. */
  syncTokenOnly = false;
  /** Send ETags on GET / in listings. */
  sendEtags = true;
  /** Extra raw <response> elements appended to the REPORT answer. */
  extraReport = '';
  /** Cards that exist (GET works) but are left out of the REPORT answer — a truncated listing. */
  readonly unlisted = new Set<string>();
  /** The home listing's collections (name → is an address book). */
  collections: Array<{ name: string; addressbook: boolean; ctag?: string }> = [{ name: 'card', addressbook: true }];
  /** Hook to transform what a PUT stores (simulate iCloud rewriting a card). */
  onPut?: (name: string, body: string) => string;
  /** When set, PUT succeeds but the card does not appear (lagging read). */
  hideAfterPut = false;
  /** When set, DELETE succeeds but the card stays. */
  keepAfterDelete = false;

  constructor(cards: Record<string, string> = {}) {
    for (const [name, body] of Object.entries(cards)) this.cards.set(name, { body, etag: this.nextEtag() });
  }

  private nextEtag(): string {
    this.etagSeq += 1;
    return `"e${this.etagSeq}"`;
  }

  fail(f: Failure): this {
    this.failures.push({ times: 1, ...f });
    return this;
  }

  /** Requests made, as `METHOD path`. */
  log(): string[] {
    return this.calls.map((c) => `${c.method} ${new URL(String(c.url)).pathname}`);
  }

  readonly request: DavRequestFn = async (req) => {
    this.calls.push(req);
    const url = new URL(String(req.url));
    const method = req.method.toUpperCase();
    const failure = this.failures.find((f) => (f.method === undefined || f.method === method) && (f.url === undefined || url.href.endsWith(f.url)) && (f.times ?? 1) > 0);
    if (failure) {
      failure.times = (failure.times ?? 1) - 1;
      return this.answer(req, failure.status, failure.body ?? '', new Headers());
    }
    return this.route(req, url, method);
  };

  private answer(req: HttpRequest, status: number, text: string, headers: Headers): HttpResponse<unknown> {
    if (status >= 300) {
      const custom = req.classifyError?.(status, text, headers);
      if (custom) throw custom;
      throw new UpstreamError(req.service, status, `contacts: ${req.method} failed with HTTP ${status}`);
    }
    return { status, headers, url: String(req.url), data: text, text, bytes: new Uint8Array() };
  }

  private versionXml(ctag?: string): string {
    if (this.syncTokenOnly) return `<sync-token>tok-${this.ctag}</sync-token>`;
    return this.reportCtag ? `<getctag xmlns="http://calendarserver.org/ns/">${ctag ?? `ctag-${this.ctag}`}</getctag>` : '';
  }

  private ms(inner: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?><multistatus xmlns="DAV:">${inner}</multistatus>`;
  }

  private route(req: HttpRequest, url: URL, method: string): HttpResponse<unknown> {
    const path = url.pathname;
    const h = (req.headers ?? {}) as Record<string, string>;
    if (method === 'PROPFIND' && url.host === 'contacts.icloud.com' && path === '/') {
      return this.answer(
        req,
        207,
        this.ms(`<response><href>/</href><propstat><prop><current-user-principal><href>/${DSID}/principal/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response>`),
        new Headers(),
      );
    }
    if (method === 'PROPFIND' && path === `/${DSID}/principal/`) {
      return this.answer(
        req,
        207,
        this.ms(
          `<response><href>/${DSID}/principal/</href><propstat><prop><addressbook-home-set xmlns="urn:ietf:params:xml:ns:carddav"><href xmlns="DAV:">${HOST}:443/${DSID}/carddavhome/</href></addressbook-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
        ),
        new Headers(),
      );
    }
    if (method === 'PROPFIND' && path === `/${DSID}/carddavhome/`) {
      const self = `<response><href>/${DSID}/carddavhome/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>`;
      if (h.Depth === '0') return this.answer(req, 207, this.ms(self), new Headers());
      const kids = this.collections
        .map(
          (c) =>
            `<response><href>/${DSID}/carddavhome/${c.name}/</href><propstat><prop><resourcetype><collection/>${c.addressbook ? '<addressbook xmlns="urn:ietf:params:xml:ns:carddav"/>' : ''}</resourcetype>` +
            this.versionXml(c.ctag) +
            `</prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
        )
        .join('');
      return this.answer(req, 207, this.ms(self + kids), new Headers());
    }
    const book = this.collections.find((c) => c.addressbook) ?? { name: 'card' };
    const bookPath = `/${DSID}/carddavhome/${book.name}/`;
    if (method === 'PROPFIND' && path === bookPath) {
      const version = this.versionXml();
      const props = version
        ? `<propstat><prop>${version}</prop><status>HTTP/1.1 200 OK</status></propstat>`
        : `<propstat><prop><getctag xmlns="http://calendarserver.org/ns/"/><sync-token/></prop><status>HTTP/1.1 404 Not Found</status></propstat>`;
      return this.answer(req, 207, this.ms(`<response><href>${bookPath}</href>${props}</response>`), new Headers());
    }
    if (method === 'REPORT' && path === bookPath) {
      const self = `<response><href>${bookPath}</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>`;
      const items = [...this.cards]
        .filter(([name]) => !this.unlisted.has(name))
        .map(
          ([name, c]) =>
            `<response><href>${bookPath}${encodeURIComponent(name)}</href><propstat><prop>${this.sendEtags ? `<getetag>${xmlEscape(c.etag)}</getetag>` : ''}` +
            `<address-data xmlns="urn:ietf:params:xml:ns:carddav"><![CDATA[${c.body}]]></address-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
        )
        .join('');
      return this.answer(req, 207, this.ms(self + items + this.extraReport), new Headers());
    }
    if (path.startsWith(bookPath) && path.length > bookPath.length) {
      const name = decodeURIComponent(path.slice(bookPath.length));
      const card = this.cards.get(name);
      if (method === 'GET') {
        if (!card) return this.answer(req, 404, 'Not Found', new Headers());
        const headers = new Headers({ 'content-type': 'text/vcard; charset=utf-8' });
        if (this.sendEtags) headers.set('etag', card.etag);
        return this.answer(req, 200, card.body, headers);
      }
      if (method === 'PUT') {
        if (h['If-None-Match'] === '*' && card) return this.answer(req, 412, '', new Headers());
        if (h['If-Match'] !== undefined && (!card || card.etag !== h['If-Match'])) return this.answer(req, 412, '', new Headers());
        const etag = this.nextEtag();
        const body = this.onPut ? this.onPut(name, req.body as string) : (req.body as string);
        if (!this.hideAfterPut) this.cards.set(name, { body, etag });
        this.ctag += 1;
        return this.answer(req, card ? 204 : 201, '', new Headers(this.sendEtags ? { etag } : {}));
      }
      if (method === 'DELETE') {
        if (!card) return this.answer(req, 404, '', new Headers());
        if (h['If-Match'] !== undefined && card.etag !== h['If-Match']) return this.answer(req, 412, '', new Headers());
        if (!this.keepAfterDelete) this.cards.delete(name);
        this.ctag += 1;
        return this.answer(req, 204, '', new Headers());
      }
    }
    // Anything else under the account (a moved book, a deleted card's old path) is gone.
    if (path.startsWith(`/${DSID}/carddavhome/`)) return this.answer(req, 404, 'Not Found', new Headers());
    throw new Error(`FakeICloud: unexpected ${method} ${url.href}`);
  }
}

export interface Registered {
  cfg: {
    title?: string;
    description: string;
    inputSchema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } };
    annotations: Record<string, unknown>;
  };
  cb: (args: Record<string, unknown>, ctx?: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

export function captureTools(deps?: ContactsDeps): Map<string, Registered> {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, cfg: Registered['cfg'], cb: Registered['cb']) => tools.set(name, { cfg, cb }),
  } as unknown as McpServer;
  registerContactsTools(server, deps);
  return tools;
}

/** Credentials, a fixed zone, no disk cache, and clean discovery/book caches around every test. */
export function useContactsEnv(): void {
  beforeEach(() => {
    process.env.ICLOUD_USERNAME = USER;
    process.env.ICLOUD_APP_PASSWORD = PASS;
    process.env.DISPLAY_TZ = 'America/New_York';
    process.env.APPLE_STATE_CACHE = 'false';
    forgetDavContext(undefined, { memoryOnly: true });
    resetContactsCache();
  });
  afterEach(() => {
    forgetDavContext(undefined, { memoryOnly: true });
    resetContactsCache();
  });
}

export interface Harness {
  fake: FakeICloud;
  tools: Map<string, Registered>;
  call(name: string, args?: Record<string, unknown>, ctx?: unknown): Promise<{ json: any; isError: boolean; text: string }>;
}

export const FIXED_NOW = new Date('2026-09-27T16:00:00.000Z');

export function harness(cards: Record<string, string> = {}, deps: Partial<ContactsDeps> = {}): Harness {
  // Each harness is a different "iCloud": never let one's cached book answer for another.
  resetContactsCache();
  const fake = new FakeICloud(cards);
  let n = 0;
  const tools = captureTools({
    request: fake.request,
    newUid: () => `NEW-UID-${++n}`,
    now: () => FIXED_NOW,
    ...deps,
  });
  return {
    fake,
    tools,
    async call(name, args = {}, ctx = {}) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`no tool ${name}`);
      const res = await tool.cb(args, ctx);
      const text = res.content[0]?.text ?? '';
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { json, isError: res.isError === true, text };
    },
  };
}
