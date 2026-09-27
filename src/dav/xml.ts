import { DOMParser, type Element as XmlElement, type Node as XmlNode } from '@xmldom/xmldom';
import { InvalidArgumentError, UpstreamError } from '../errors.js';

/**
 * WebDAV XML for CalDAV (RFC 4791) and CardDAV (RFC 6352): request-body
 * builders with correct escaping, and a namespace-aware `207 Multi-Status`
 * reader.
 *
 * Why namespace-aware: iCloud writes DEFAULT namespaces
 * (`<multistatus xmlns="DAV:">`, `<calendar-data xmlns="urn:ietf:params:xml:ns:caldav">`)
 * while other servers use prefixes (`<d:multistatus xmlns:d="DAV:">`). Matching
 * on prefixes, or stripping them, reads one and misreads the other. Every
 * lookup here is by (namespace URI, local name).
 *
 * Safety: `@xmldom/xmldom` performs no I/O and does not expand entity
 * declarations from a DOCTYPE, so neither external entities (XXE) nor entity
 * expansion bombs can be triggered by a hostile response — pinned by tests.
 */

// ---------------------------------------------------------------------------
// Namespaces and property names
// ---------------------------------------------------------------------------

/** The XML namespaces DAV servers (and iCloud in particular) use. */
export const NS = {
  DAV: 'DAV:',
  CALDAV: 'urn:ietf:params:xml:ns:caldav',
  CARDDAV: 'urn:ietf:params:xml:ns:carddav',
  /** Apple's CalendarServer extensions (`getctag`, `source`, sharing). */
  CS: 'http://calendarserver.org/ns/',
  /** Apple iCal extensions (`calendar-color`, `calendar-order`). */
  APPLE: 'http://apple.com/ns/ical/',
} as const;

/** The two DAV services this module serves. */
export type DavService = 'calendar' | 'contacts';

/** A property (or element) name: `[namespaceUri, localName]`, e.g. `[NS.DAV, 'displayname']`. */
export type PropRef = readonly [namespace: string, name: string];

/** Clark notation `{namespace}local` — the unambiguous string form of a qualified name. */
export function clark(namespace: string, name: string): string {
  return `{${namespace}}${name}`;
}

const PREFIXES: Readonly<Record<string, string>> = {
  [NS.DAV]: 'd',
  [NS.CALDAV]: 'c',
  [NS.CARDDAV]: 'card',
  [NS.CS]: 'cs',
  [NS.APPLE]: 'ical',
};

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

// Characters XML 1.0 cannot carry at all, even escaped: C0 controls other
// than TAB/LF/CR, U+FFFE/U+FFFF, and unpaired surrogates.
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/**
 * Escape `text` for use in XML character data or a quoted attribute value.
 * Throws `InvalidArgumentError` for characters XML cannot represent at all
 * (a request the server could only answer with 400 is refused up front).
 */
export function escapeXml(text: string): string {
  if (ILLEGAL_XML_CHARS.test(text)) {
    throw new InvalidArgumentError('Text contains a control character that cannot be sent in an XML request.');
  }
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);
}

const NCNAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** Tracks the namespace prefixes a request body uses, so only those are declared. */
class Namespaces {
  private readonly used = new Map<string, string>();
  private extra = 0;

  /** `prefix:name` for a property, declaring its namespace. */
  q(namespace: string, name: string): string {
    if (!NCNAME.test(name)) throw new InvalidArgumentError(`"${name}" is not a valid XML element name.`);
    // `xmlns:x0=""` is not well-formed in XML 1.0 namespaces; DAV properties always have a namespace.
    if (namespace === '') throw new InvalidArgumentError(`"${name}" needs a namespace to be requested.`);
    let prefix = this.used.get(namespace);
    if (prefix === undefined) {
      prefix = PREFIXES[namespace] ?? `x${this.extra++}`;
      this.used.set(namespace, prefix);
    }
    return `${prefix}:${name}`;
  }

  /** The `xmlns:*` declarations for every namespace used so far. */
  declarations(): string {
    return [...this.used].map(([uri, prefix]) => ` xmlns:${prefix}="${escapeXml(uri)}"`).join('');
  }
}

const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>';

/** Build `<root …>inner</root>` with every namespace the body used declared on the root. */
function document(ns: Namespaces, root: string, inner: string): string {
  // `root` is qualified first so its namespace is declared even when unused inside.
  return `${XML_DECL}<${root}${ns.declarations()}>${inner}</${root}>`;
}

function propElement(ns: Namespaces, props: readonly PropRef[]): string {
  if (props.length === 0) throw new InvalidArgumentError('A DAV request needs at least one property.');
  return `<${ns.q(NS.DAV, 'prop')}>${props.map(([u, n]) => `<${ns.q(u, n)}/>`).join('')}</${ns.q(NS.DAV, 'prop')}>`;
}

/**
 * The value to put in a multiget `<href>`: an ABSOLUTE PATH. iCloud answers a
 * multiget whose hrefs are absolute URIs (`https://p50-contacts.icloud.com:443/…`)
 * with 400 Bad Request and the same body with `/27015122/carddavhome/card/x.vcf`
 * with 207, so a full URL is reduced to its path (+ query); a path or a
 * relative reference is used as given. Percent-encoding is kept verbatim.
 */
export function hrefForRequest(href: string): string {
  if (/^https?:\/\//i.test(href)) {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      throw new InvalidArgumentError(`"${href}" is not a valid URL.`);
    }
    return url.pathname + url.search;
  }
  if (href.length === 0) throw new InvalidArgumentError('An empty href cannot be requested.');
  return href;
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/**
 * A `PROPFIND` body asking for `props`, e.g.
 * `propfindBody([[NS.DAV, 'displayname'], [NS.CS, 'getctag']])`.
 */
export function propfindBody(props: readonly PropRef[]): string {
  const ns = new Namespaces();
  const root = ns.q(NS.DAV, 'propfind');
  return document(ns, root, propElement(ns, props));
}

/** Properties a calendar-query / calendar-multiget returns by default: the ETag and the iCalendar text. */
export const CALENDAR_DATA_PROPS: readonly PropRef[] = [
  [NS.DAV, 'getetag'],
  [NS.CALDAV, 'calendar-data'],
];

/** Properties an addressbook-query / addressbook-multiget returns by default: the ETag and the vCard text. */
export const ADDRESS_DATA_PROPS: readonly PropRef[] = [
  [NS.DAV, 'getetag'],
  [NS.CARDDAV, 'address-data'],
];

/**
 * Format an instant as a CalDAV UTC date-time, `YYYYMMDDTHHMMSSZ` (RFC 4791
 * §9.9 requires `time-range` values in UTC). The format has whole seconds:
 * milliseconds are dropped (rounded DOWN), or rounded UP with
 * `{roundUp: true}` — what an exclusive END bound needs so the window never
 * shrinks. Throws `InvalidArgumentError` for an invalid Date or a year outside
 * 0000–9999.
 */
export function toCalDavUtc(input: Date, opts: { roundUp?: boolean } = {}): string {
  const ms = input.getTime();
  if (Number.isNaN(ms)) throw new InvalidArgumentError('A calendar time range needs a valid date.');
  const date = opts.roundUp && ms % 1000 !== 0 ? new Date(Math.ceil(ms / 1000) * 1000) : input;
  const year = date.getUTCFullYear();
  if (year < 0 || year > 9999) throw new InvalidArgumentError(`Year ${year} is outside the range CalDAV can express.`);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${p(year, 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  );
}

/** Options for `calendarQueryBody`. */
export interface CalendarQueryOptions {
  /**
   * Only components overlapping this window (either bound may be open). The
   * server returns the MASTER of a recurring series whose recurrence set
   * overlaps — expand it client-side: iCloud's server-side `expand` turns
   * all-day events into UTC date-times, so it is deliberately not offered.
   */
  timeRange?: { start?: Date; end?: Date };
  /** Component to match inside VCALENDAR (default `VEVENT`). */
  component?: 'VEVENT' | 'VTODO';
  /** Properties to return (default: getetag + calendar-data). */
  props?: readonly PropRef[];
}

/**
 * A CalDAV `calendar-query` REPORT body (send with Depth 1 to the calendar
 * collection). iCloud also lists the collection itself among the results —
 * skip the response whose URL is the collection's (`sameResource`).
 *
 * Deliberately no UID filter: iCloud answers a UID `prop-filter` with 412.
 * Address an event by its resource name (`<uid>.ics`) instead.
 */
export function calendarQueryBody(opts: CalendarQueryOptions = {}): string {
  const ns = new Namespaces();
  const root = ns.q(NS.CALDAV, 'calendar-query');
  const prop = propElement(ns, opts.props ?? CALENDAR_DATA_PROPS);
  const comp = ns.q(NS.CALDAV, 'comp-filter');
  let range = '';
  if (opts.timeRange) {
    const { start, end } = opts.timeRange;
    if (start === undefined && end === undefined) {
      throw new InvalidArgumentError('A calendar time range needs a start, an end, or both.');
    }
    // Formatting validates each bound (invalid Date, year out of range). The
    // end is rounded UP to a whole second: truncating it would drop an event
    // starting inside that last second, and could turn start < end into equal
    // values the server matches nothing against.
    const startText = start === undefined ? undefined : toCalDavUtc(start);
    const endText = end === undefined ? undefined : toCalDavUtc(end, { roundUp: true });
    if (start !== undefined && end !== undefined && start.getTime() >= end.getTime()) {
      throw new InvalidArgumentError('A calendar time range must end after it starts.');
    }
    const attrs = (startText ? ` start="${startText}"` : '') + (endText ? ` end="${endText}"` : '');
    range = `<${ns.q(NS.CALDAV, 'time-range')}${attrs}/>`;
  }
  const component = opts.component ?? 'VEVENT';
  // The type says so, but it is interpolated into an attribute: check at run time too.
  if (component !== 'VEVENT' && component !== 'VTODO') {
    throw new InvalidArgumentError('A calendar query can only match VEVENT or VTODO components.');
  }
  const filter =
    `<${ns.q(NS.CALDAV, 'filter')}><${comp} name="VCALENDAR"><${comp} name="${component}">${range}</${comp}></${comp}>` +
    `</${ns.q(NS.CALDAV, 'filter')}>`;
  return document(ns, root, prop + filter);
}

function multigetBody(namespace: string, rootName: string, hrefs: readonly string[], props: readonly PropRef[]): string {
  if (hrefs.length === 0) throw new InvalidArgumentError('A multiget needs at least one href.');
  const ns = new Namespaces();
  const root = ns.q(namespace, rootName);
  const prop = propElement(ns, props);
  const href = ns.q(NS.DAV, 'href');
  return document(ns, root, prop + hrefs.map((h) => `<${href}>${escapeXml(hrefForRequest(h))}</${href}>`).join(''));
}

/**
 * A CalDAV `calendar-multiget` REPORT body for the given resources (URLs or
 * absolute paths — both are sent as absolute paths, see `hrefForRequest`).
 * An href that does not exist comes back as a response with `status: 404`.
 * Batch about 100 hrefs per request.
 */
export function calendarMultigetBody(hrefs: readonly string[], props: readonly PropRef[] = CALENDAR_DATA_PROPS): string {
  return multigetBody(NS.CALDAV, 'calendar-multiget', hrefs, props);
}

/**
 * An UNFILTERED CardDAV `addressbook-query` REPORT body: every card in the
 * address book in one response (send with Depth 1). Must be sent as REPORT —
 * iCloud rejects this body on PROPFIND. Server-side filtering is not offered:
 * whether iCloud honours `prop-filter` is unverified, so search locally.
 */
export function addressbookQueryBody(props: readonly PropRef[] = ADDRESS_DATA_PROPS): string {
  const ns = new Namespaces();
  const root = ns.q(NS.CARDDAV, 'addressbook-query');
  return document(ns, root, propElement(ns, props));
}

/** A CardDAV `addressbook-multiget` REPORT body (hrefs sent as absolute paths). Batch about 100 per request. */
export function addressbookMultigetBody(hrefs: readonly string[], props: readonly PropRef[] = ADDRESS_DATA_PROPS): string {
  return multigetBody(NS.CARDDAV, 'addressbook-multiget', hrefs, props);
}

/** Options for `syncCollectionBody`. */
export interface SyncCollectionOptions {
  /** The token from the previous sync; omit (or '') for an initial full listing. */
  syncToken?: string;
  /** Properties per changed member (default: getetag + getcontenttype). */
  props?: readonly PropRef[];
  /**
   * Ask for at most this many results. A server that stops early answers the
   * collection's own href with `status: 507` — call again with the new token.
   */
  limit?: number;
}

/**
 * A WebDAV `sync-collection` REPORT body (RFC 6578). Send it with **Depth 0**:
 * the RFC defines the report only for Depth 0 (the member depth is the
 * body's `sync-level`, always 1 here); a Depth 1 sample is also reported to
 * work on iCloud. The answer lists changed members with their props,
 * deleted members as responses with `status: 404`, and the next token in
 * `DavMultistatus.syncToken`. An expired token is refused with 403/409
 * `valid-sync-token` (surfaced as `UpstreamError.upstreamCode`) — fall back
 * to a full listing.
 */
export function syncCollectionBody(opts: SyncCollectionOptions = {}): string {
  const ns = new Namespaces();
  const root = ns.q(NS.DAV, 'sync-collection');
  const tokenName = ns.q(NS.DAV, 'sync-token');
  const token = opts.syncToken ? `<${tokenName}>${escapeXml(opts.syncToken)}</${tokenName}>` : `<${tokenName}/>`;
  const level = `<${ns.q(NS.DAV, 'sync-level')}>1</${ns.q(NS.DAV, 'sync-level')}>`;
  let limit = '';
  if (opts.limit !== undefined) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      throw new InvalidArgumentError('A sync-collection limit must be a positive integer.');
    }
    limit = `<${ns.q(NS.DAV, 'limit')}><${ns.q(NS.DAV, 'nresults')}>${opts.limit}</${ns.q(NS.DAV, 'nresults')}></${ns.q(NS.DAV, 'limit')}>`;
  }
  const prop = propElement(ns, opts.props ?? [[NS.DAV, 'getetag'], [NS.DAV, 'getcontenttype']]);
  return document(ns, root, token + level + limit + prop);
}

// ---------------------------------------------------------------------------
// Multistatus reader
// ---------------------------------------------------------------------------

/**
 * The properties of one `<response>`. Every lookup is by namespace URI +
 * local name. A property is PRESENT only when it sits in a 2xx `<propstat>`:
 * one the server listed under `404 Not Found` (or 403) is missing, and every
 * accessor except `status()` treats it as absent.
 */
export interface DavProps {
  /** Whether the property is present (in a 2xx propstat). */
  has(namespace: string, name: string): boolean;
  /**
   * The propstat status the server gave this property (200, 404, 403, …), or
   * undefined when the response did not mention it at all.
   */
  status(namespace: string, name: string): number | undefined;
  /**
   * The property's text content with surrounding XML whitespace trimmed
   * (CDATA and entities decoded); undefined when absent, `''` when present
   * but empty. Use `rawText` for a byte-exact payload.
   */
  text(namespace: string, name: string): string | undefined;
  /**
   * The text content exactly as sent (CRLF line endings preserved — line-end
   * normalisation is off, so `calendar-data` / `address-data` arrive as the
   * server wrote them).
   */
  rawText(namespace: string, name: string): string | undefined;
  /** The `DAV:href` values nested anywhere inside the property, trimmed, as sent. */
  hrefs(namespace: string, name: string): string[];
  /**
   * Those hrefs resolved to absolute URLs against the URL of the request that
   * produced them — the partition host, not the discovery host. Use these for
   * follow-up requests; unparseable hrefs are skipped.
   */
  urls(namespace: string, name: string): string[];
  /** Clark names (`{DAV:}collection`) of the property's direct child elements, e.g. of `resourcetype`. */
  childNames(namespace: string, name: string): string[];
  /**
   * The `name` attributes of `<comp>` children, upper-cased — by default of
   * CalDAV `supported-calendar-component-set` (`['VEVENT', 'VTODO']`).
   */
  compNames(namespace?: string, name?: string): string[];
  /**
   * Clark names of the privileges in a privilege set — by default
   * `DAV:current-user-privilege-set` → e.g. `['{DAV:}read', '{DAV:}write']`.
   * Aggregates are EXPANDED (RFC 3744 §3.12), after the privileges as listed:
   * `{DAV:}all` adds read, write, unlock and their parts; `{DAV:}write` adds
   * `write-properties`, `write-content`, `bind` and `unbind`. So "can I add
   * an event here?" is `privileges().includes('{DAV:}bind')` and "can I edit
   * one?" is `.includes('{DAV:}write-content')`, whichever form the server used.
   */
  privileges(namespace?: string, name?: string): string[];
  /** The property's DOM element, for anything the accessors above do not cover. */
  element(namespace: string, name: string): XmlElement | undefined;
}

/** One `<response>` of a multistatus. */
export interface DavResponse {
  /** The href exactly as the server sent it: XML entities decoded, percent-encoding kept. */
  href: string;
  /** `href` percent-decoded (a malformed escape is left as-is) — for display and deriving ids. */
  decodedHref: string;
  /** `href` resolved against the request URL — use this for any follow-up request. */
  url: string;
  /**
   * The response-level status of the `<href>…<status>` form: 404 for a
   * multiget href that does not exist or a member a sync-collection reports
   * deleted, 507 on a truncated sync. Absent for the usual propstat form.
   */
  status?: number;
  props: DavProps;
}

/** A parsed `207 Multi-Status` body. */
export interface DavMultistatus {
  /** The request URL (after redirects) that relative hrefs were resolved against. */
  url: string;
  responses: DavResponse[];
  /** The top-level `<sync-token>` of a sync-collection answer. */
  syncToken?: string;
  /**
   * `<response>` elements ignored as malformed (no href, an unparseable
   * status or href). Reported so a caller can say its listing may be
   * incomplete rather than presenting it as whole.
   */
  skipped: number;
}

/** Options for `parseMultistatus`. */
export interface ParseMultistatusOptions {
  /** The URL of the request; hrefs are resolved against it. */
  baseUrl: string;
  /** Which service's request this answers (for the error on an unreadable body). */
  service: DavService;
  /** The HTTP status that carried the body (default 207), for the error. */
  status?: number;
}

const ELEMENT_NODE = 1;
const XML_WS = /^[ \t\r\n]+|[ \t\r\n]+$/g;

function trimXml(s: string): string {
  return s.replace(XML_WS, '');
}

/** An element's text. The DOM types allow null only for documents and doctypes, never elements. */
function textOf(el: XmlElement): string {
  return el.textContent as string;
}

/** An element's Clark name; an element in no namespace is `{}name`. */
function nameOf(el: XmlElement): string {
  return clark(el.namespaceURI ?? '', el.localName as string);
}

function childElements(node: XmlNode): XmlElement[] {
  const out: XmlElement[] = [];
  for (let c = node.firstChild; c !== null; c = c.nextSibling) {
    if (c.nodeType === ELEMENT_NODE) out.push(c as XmlElement);
  }
  return out;
}

function is(el: XmlElement, namespace: string, name: string): boolean {
  return el.namespaceURI === namespace && el.localName === name;
}

function firstChild(el: XmlElement, namespace: string, name: string): XmlElement | undefined {
  return childElements(el).find((c) => is(c, namespace, name));
}

/** `HTTP/1.1 404 Not Found` → 404; undefined when the line is not a status line. */
export function parseStatusLine(line: string): number | undefined {
  const m = /^HTTP\/\d(?:\.\d)?[ \t]+(\d{3})\b/i.exec(trimXml(line));
  return m ? Number(m[1]) : undefined;
}

/** Percent-decode a path, leaving any malformed escape sequence as it was. */
export function safeDecode(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
}

function resolve(href: string, base: string): string | undefined {
  try {
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
}

class Props implements DavProps {
  private readonly byName = new Map<string, { el: XmlElement; status: number }>();

  constructor(private readonly baseUrl: string) {}

  add(el: XmlElement, status: number): void {
    const key = nameOf(el);
    const prior = this.byName.get(key);
    // A property listed twice keeps its successful entry.
    if (prior && isSuccess(prior.status) && !isSuccess(status)) return;
    this.byName.set(key, { el, status });
  }

  private present(namespace: string, name: string): XmlElement | undefined {
    const entry = this.byName.get(clark(namespace, name));
    return entry && isSuccess(entry.status) ? entry.el : undefined;
  }

  has(namespace: string, name: string): boolean {
    return this.present(namespace, name) !== undefined;
  }

  status(namespace: string, name: string): number | undefined {
    return this.byName.get(clark(namespace, name))?.status;
  }

  rawText(namespace: string, name: string): string | undefined {
    const el = this.present(namespace, name);
    return el === undefined ? undefined : textOf(el);
  }

  text(namespace: string, name: string): string | undefined {
    const raw = this.rawText(namespace, name);
    return raw === undefined ? undefined : trimXml(raw);
  }

  hrefs(namespace: string, name: string): string[] {
    const el = this.present(namespace, name);
    if (!el) return [];
    const out: string[] = [];
    const list = el.getElementsByTagNameNS(NS.DAV, 'href');
    for (let i = 0; i < list.length; i++) {
      const value = trimXml(textOf(list.item(i) as XmlElement));
      if (value) out.push(value);
    }
    return out;
  }

  urls(namespace: string, name: string): string[] {
    return this.hrefs(namespace, name)
      .map((h) => resolve(h, this.baseUrl))
      .filter((u): u is string => u !== undefined);
  }

  childNames(namespace: string, name: string): string[] {
    const el = this.present(namespace, name);
    return el ? childElements(el).map(nameOf) : [];
  }

  compNames(namespace: string = NS.CALDAV, name = 'supported-calendar-component-set'): string[] {
    const el = this.present(namespace, name);
    if (!el) return [];
    return childElements(el)
      .filter((c) => is(c, NS.CALDAV, 'comp'))
      .map((c) => (c.getAttribute('name') ?? '').toUpperCase())
      .filter((n) => n.length > 0);
  }

  privileges(namespace: string = NS.DAV, name = 'current-user-privilege-set'): string[] {
    const el = this.present(namespace, name);
    if (!el) return [];
    const out: string[] = [];
    const add = (p: string) => {
      if (!out.includes(p)) out.push(p);
    };
    for (const priv of childElements(el).filter((c) => is(c, NS.DAV, 'privilege'))) {
      for (const p of childElements(priv)) add(nameOf(p));
    }
    // Expand aggregates (iterating `out` while it grows: `all` adds `write`, which adds its parts).
    for (let i = 0; i < out.length; i++) {
      for (const implied of AGGREGATE_PRIVILEGES[out[i] as string] ?? []) add(implied);
    }
    return out;
  }

  element(namespace: string, name: string): XmlElement | undefined {
    return this.present(namespace, name);
  }
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/** RFC 3744 §3.12 privilege aggregation (plus §3.9: `write` contains `bind`/`unbind` on a collection). */
const AGGREGATE_PRIVILEGES: Readonly<Record<string, readonly string[]>> = {
  [clark(NS.DAV, 'all')]: [
    clark(NS.DAV, 'read'),
    clark(NS.DAV, 'write'),
    clark(NS.DAV, 'unlock'),
  ],
  [clark(NS.DAV, 'read')]: [clark(NS.DAV, 'read-acl'), clark(NS.DAV, 'read-current-user-privilege-set')],
  [clark(NS.DAV, 'write')]: [
    clark(NS.DAV, 'write-properties'),
    clark(NS.DAV, 'write-content'),
    clark(NS.DAV, 'bind'),
    clark(NS.DAV, 'unbind'),
    clark(NS.DAV, 'write-acl'),
  ],
};

/**
 * Parse XML into a DOM, or undefined when it is not well-formed XML. No
 * DOCTYPE entity is ever expanded or fetched; line endings are left as sent.
 */
export function parseXml(xml: string): XmlElement | undefined {
  try {
    const doc = new DOMParser({
      locator: false,
      // Keep CRLF inside calendar-data / address-data exactly as the server sent it.
      normalizeLineEndings: (s: string) => s,
      // Recoverable problems (an unknown entity, a stray `&`) are not worth
      // failing a whole listing over, and their messages quote document
      // content — so they are not logged. Fatal ones still throw.
      onError: () => undefined,
      // A BOM, or whitespace some stacks emit before `<?xml \u2026?>`, would make an
      // otherwise complete answer "not XML" (the declaration must come first).
    }).parseFromString(xml.replace(/^\uFEFF?[ \t\r\n]*/, ''), 'text/xml');
    // A document without a root element is a fatal error, so a returned document has one.
    return doc.documentElement as XmlElement;
  } catch {
    return undefined;
  }
}

/**
 * Read a `207 Multi-Status` body. A body that is not XML, or whose root is
 * not `DAV:multistatus`, is an `UpstreamError` — never an empty listing. A
 * single malformed `<response>` (no href, unreadable status) is skipped and
 * counted in `skipped` rather than failing the whole answer.
 */
export function parseMultistatus(xml: string, opts: ParseMultistatusOptions): DavMultistatus {
  const root = parseXml(xml);
  if (!root || !is(root, NS.DAV, 'multistatus')) {
    const what = root ? `a <${root.localName}> document` : 'a body that is not XML';
    throw new UpstreamError(
      opts.service,
      opts.status ?? 207,
      `${opts.service}: expected a WebDAV multistatus answer but got ${what} (${xml.length} characters).`,
      { hint: 'iCloud may be having trouble, or something between this server and iCloud answered instead. Retry shortly.' },
    );
  }
  const responses: DavResponse[] = [];
  let skipped = 0;
  let syncToken: string | undefined;
  for (const child of childElements(root)) {
    if (is(child, NS.DAV, 'sync-token')) {
      syncToken = trimXml(textOf(child));
      continue;
    }
    if (!is(child, NS.DAV, 'response')) continue;
    const parsed = parseResponse(child, opts.baseUrl);
    if (parsed === undefined) skipped += 1;
    else responses.push(...parsed);
  }
  return { url: opts.baseUrl, responses, ...(syncToken ? { syncToken } : {}), skipped };
}

function parseResponse(el: XmlElement, baseUrl: string): DavResponse[] | undefined {
  const hrefs = childElements(el)
    .filter((c) => is(c, NS.DAV, 'href'))
    .map((c) => trimXml(textOf(c)));
  if (hrefs.length === 0 || hrefs.some((h) => h.length === 0)) return undefined;
  const urls = hrefs.map((h) => resolve(h, baseUrl));
  if (urls.some((u) => u === undefined)) return undefined;

  const statusEl = firstChild(el, NS.DAV, 'status');
  let status: number | undefined;
  if (statusEl) {
    status = parseStatusLine(textOf(statusEl));
    if (status === undefined) return undefined;
  }
  const props = new Props(baseUrl);
  for (const propstat of childElements(el).filter((c) => is(c, NS.DAV, 'propstat'))) {
    const psStatusEl = firstChild(propstat, NS.DAV, 'status');
    const psStatus = psStatusEl ? parseStatusLine(textOf(psStatusEl)) : undefined;
    // A propstat without a readable status cannot say whether its props exist: ignore it.
    if (psStatus === undefined) continue;
    for (const prop of childElements(propstat).filter((c) => is(c, NS.DAV, 'prop'))) {
      for (const p of childElements(prop)) props.add(p, psStatus);
    }
  }
  // Several hrefs share one status only in the status form (RFC 4918 §14.24).
  const list = status === undefined ? hrefs.slice(0, 1) : hrefs;
  return list.map((href, i) => ({
    href,
    decodedHref: safeDecode(href),
    url: urls[i] as string,
    ...(status !== undefined ? { status } : {}),
    props,
  }));
}

/**
 * The precondition / postcondition names in a WebDAV `<DAV:error>` body
 * (RFC 4918 §16), e.g. `['need-privileges']`, `['valid-sync-token']`,
 * `['no-uid-conflict']`. Empty when the body is not an error document.
 */
export function davErrorConditions(body: string): string[] {
  if (!body.includes('error')) return [];
  const root = parseXml(body);
  if (!root || !is(root, NS.DAV, 'error')) return [];
  return childElements(root).map((c) => c.localName as string);
}
