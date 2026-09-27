import { describe, expect, it } from 'vitest';
import { InvalidArgumentError, UpstreamError } from '../../src/errors.js';
import {
  ADDRESS_DATA_PROPS,
  CALENDAR_DATA_PROPS,
  NS,
  addressbookMultigetBody,
  addressbookQueryBody,
  calendarMultigetBody,
  calendarQueryBody,
  clark,
  davErrorConditions,
  escapeXml,
  hrefForRequest,
  parseMultistatus,
  parseStatusLine,
  parseXml,
  propfindBody,
  safeDecode,
  syncCollectionBody,
  toCalDavUtc,
} from '../../src/dav/xml.js';

const BASE = 'https://p34-caldav.icloud.com/200385701/calendars/';
const parse = (xml: string, baseUrl = BASE) => parseMultistatus(xml, { baseUrl, service: 'calendar' });

/** Parse a request body we built and return its root, failing the test if it is not well-formed. */
function root(xml: string) {
  expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
  const el = parseXml(xml);
  expect(el).toBeDefined();
  return el!;
}

function qnames(el: ReturnType<typeof root>): string[] {
  const out: string[] = [];
  const walk = (n: ReturnType<typeof root>) => {
    out.push(clark(n.namespaceURI ?? '', n.localName as string));
    for (let c = n.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) walk(c as ReturnType<typeof root>);
  };
  walk(el);
  return out;
}

describe('escaping and names', () => {
  it('clark() builds {ns}name', () => {
    expect(clark(NS.DAV, 'href')).toBe('{DAV:}href');
    expect(clark('', 'x')).toBe('{}x');
  });

  it('escapes the five XML specials and leaves the rest', () => {
    expect(escapeXml(`a&b<c>d"e'f\tg\nh\ri 😀`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f\tg\nh\ri 😀');
  });

  it('refuses characters XML cannot carry', () => {
    expect(() => escapeXml('a\u0001b')).toThrow(InvalidArgumentError);
    expect(() => escapeXml('a\uFFFEb')).toThrow(InvalidArgumentError);
    expect(() => escapeXml('lone \uD83D high')).toThrow(InvalidArgumentError);
    expect(() => escapeXml('lone \uDE00 low')).toThrow(InvalidArgumentError);
  });
});

describe('request bodies', () => {
  it('propfindBody declares only the namespaces it uses, with stable prefixes', () => {
    const body = propfindBody([
      [NS.DAV, 'displayname'],
      [NS.CS, 'getctag'],
      [NS.APPLE, 'calendar-color'],
      [NS.CALDAV, 'supported-calendar-component-set'],
      ['urn:example:one', 'a'],
      ['urn:example:two', 'b'],
      ['urn:example:one', 'c'],
    ]);
    expect(body).toContain('<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"');
    expect(body).toContain('xmlns:ical="http://apple.com/ns/ical/"');
    expect(body).toContain('xmlns:c="urn:ietf:params:xml:ns:caldav"');
    expect(body).toContain('xmlns:x0="urn:example:one" xmlns:x1="urn:example:two"');
    expect(body).toContain('<x0:a/><x1:b/><x0:c/>');
    expect(body).not.toContain('carddav');
    expect(qnames(root(body))).toEqual([
      '{DAV:}propfind',
      '{DAV:}prop',
      '{DAV:}displayname',
      '{http://calendarserver.org/ns/}getctag',
      '{http://apple.com/ns/ical/}calendar-color',
      '{urn:ietf:params:xml:ns:caldav}supported-calendar-component-set',
      '{urn:example:one}a',
      '{urn:example:two}b',
      '{urn:example:one}c',
    ]);
  });

  it('refuses an empty property list and invalid element names', () => {
    expect(() => propfindBody([])).toThrow(InvalidArgumentError);
    expect(() => propfindBody([[NS.DAV, 'bad name']])).toThrow(/not a valid XML element name/);
    expect(() => propfindBody([[NS.DAV, '1abc']])).toThrow(InvalidArgumentError);
    // `xmlns:x0=""` would not be well-formed XML 1.0 namespaces.
    expect(() => propfindBody([['', 'plain']])).toThrow(/needs a namespace/);
  });

  it('escapes a namespace URI', () => {
    const body = propfindBody([['urn:x?a=1&b=2', 'p']]);
    expect(body).toContain('xmlns:x0="urn:x?a=1&amp;b=2"');
    expect(root(body).localName).toBe('propfind');
  });

  it('toCalDavUtc formats UTC with padding', () => {
    expect(toCalDavUtc(new Date('2024-01-25T05:06:07.999Z'))).toBe('20240125T050607Z');
    expect(toCalDavUtc(new Date('2026-11-01T01:30:00-04:00'))).toBe('20261101T053000Z');
    const early = new Date(0);
    early.setUTCFullYear(5, 0, 1);
    expect(toCalDavUtc(early)).toBe('00050101T000000Z');
  });

  it('toCalDavUtc rounds DOWN by default and UP on request (only when there are milliseconds)', () => {
    expect(toCalDavUtc(new Date('2024-01-25T05:06:07.001Z'), { roundUp: true })).toBe('20240125T050608Z');
    expect(toCalDavUtc(new Date('2024-12-31T23:59:59.500Z'), { roundUp: true })).toBe('20250101T000000Z');
    expect(toCalDavUtc(new Date('2024-01-25T05:06:07.000Z'), { roundUp: true })).toBe('20240125T050607Z');
    expect(() => toCalDavUtc(new Date('x'), { roundUp: true })).toThrow(/valid date/);
    expect(() => toCalDavUtc(new Date('9999-12-31T23:59:59.500Z'), { roundUp: true })).toThrow(/Year 10000/);
  });

  it('toCalDavUtc refuses invalid dates and years CalDAV cannot express', () => {
    expect(() => toCalDavUtc(new Date('nope'))).toThrow(/valid date/);
    expect(() => toCalDavUtc(new Date('+010000-01-01T00:00:00Z'))).toThrow(/Year 10000/);
    const bc = new Date(0);
    bc.setUTCFullYear(-1);
    expect(() => toCalDavUtc(bc)).toThrow(/Year -1/);
  });

  it('calendarQueryBody without a range filters VCALENDAR/VEVENT and asks for etag + data', () => {
    const body = calendarQueryBody();
    expect(body).toBe(
      '<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:">' +
        '<d:prop><d:getetag/><c:calendar-data/></d:prop>' +
        '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"></c:comp-filter></c:comp-filter></c:filter>' +
        '</c:calendar-query>',
    );
    root(body);
  });

  it('calendarQueryBody with a time range emits UTC bounds', () => {
    const body = calendarQueryBody({
      timeRange: { start: new Date('2024-01-25T00:00:00Z'), end: new Date('2024-01-26T00:00:00-05:00') },
    });
    expect(body).toContain('<c:time-range start="20240125T000000Z" end="20240126T050000Z"/>');
    const el = root(body);
    const tr = el.getElementsByTagNameNS(NS.CALDAV, 'time-range').item(0)!;
    expect(tr.getAttribute('start')).toBe('20240125T000000Z');
  });

  it('calendarQueryBody accepts open-ended ranges, another component and custom props', () => {
    expect(calendarQueryBody({ timeRange: { start: new Date('2024-01-25T00:00:00Z') } })).toContain(
      '<c:time-range start="20240125T000000Z"/>',
    );
    expect(calendarQueryBody({ timeRange: { end: new Date('2024-01-25T00:00:00Z') } })).toContain(
      '<c:time-range end="20240125T000000Z"/>',
    );
    const todo = calendarQueryBody({ component: 'VTODO', props: [[NS.DAV, 'getetag']] });
    expect(todo).toContain('<c:comp-filter name="VTODO">');
    expect(todo).toContain('<d:prop><d:getetag/></d:prop>');
    expect(todo).not.toContain('calendar-data');
  });

  it('calendarQueryBody never shrinks the window: the END is rounded up to a whole second', () => {
    // An event starting at 10:00:00 is inside [09:00, 10:00:00.5); truncating the end would exclude it.
    expect(
      calendarQueryBody({ timeRange: { start: new Date('2024-01-25T09:00:00.900Z'), end: new Date('2024-01-25T10:00:00.500Z') } }),
    ).toContain('<c:time-range start="20240125T090000Z" end="20240125T100001Z"/>');
    // A sub-second window stays a non-empty range instead of collapsing to start == end.
    expect(
      calendarQueryBody({ timeRange: { start: new Date('2024-01-25T10:00:00.200Z'), end: new Date('2024-01-25T10:00:00.700Z') } }),
    ).toContain('start="20240125T100000Z" end="20240125T100001Z"');
  });

  it('calendarQueryBody refuses a component other than VEVENT/VTODO even when the type is bypassed', () => {
    expect(() => calendarQueryBody({ component: 'VEVENT"/><x a="' as 'VEVENT' })).toThrow(/VEVENT or VTODO/);
    expect(() => calendarQueryBody({ component: 'VJOURNAL' as 'VTODO' })).toThrow(InvalidArgumentError);
  });

  it('calendarQueryBody refuses empty, inverted and invalid ranges', () => {
    expect(() => calendarQueryBody({ timeRange: {} })).toThrow(/start, an end, or both/);
    const t = new Date('2024-01-25T00:00:00Z');
    expect(() => calendarQueryBody({ timeRange: { start: t, end: t } })).toThrow(/end after it starts/);
    expect(() => calendarQueryBody({ timeRange: { start: t, end: new Date('2024-01-24T00:00:00Z') } })).toThrow(
      InvalidArgumentError,
    );
    expect(() => calendarQueryBody({ timeRange: { start: new Date('x'), end: t } })).toThrow(/valid date/);
    expect(() => calendarQueryBody({ timeRange: { start: t, end: new Date('x') } })).toThrow(/valid date/);
  });

  it('multiget bodies send absolute PATHS (iCloud 400s on absolute URIs), escaped', () => {
    const body = calendarMultigetBody([
      'https://p34-caldav.icloud.com:443/200385701/calendars/home/1.ics',
      '/200385701/calendars/home/a%20b&c.ics',
      'relative.ics',
      'https://p34-caldav.icloud.com/x/y.ics?q=1',
    ]);
    expect(body).toContain('<d:href>/200385701/calendars/home/1.ics</d:href>');
    expect(body).toContain('<d:href>/200385701/calendars/home/a%20b&amp;c.ics</d:href>');
    expect(body).toContain('<d:href>relative.ics</d:href>');
    expect(body).toContain('<d:href>/x/y.ics?q=1</d:href>');
    expect(body).toContain('<c:calendar-multiget xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:">');
    expect(body).toContain('<d:prop><d:getetag/><c:calendar-data/></d:prop>');
    const el = root(body);
    expect(el.getElementsByTagNameNS(NS.DAV, 'href').item(1)!.textContent).toBe('/200385701/calendars/home/a%20b&c.ics');
  });

  it('multiget refuses an empty list, an empty href and an unparseable URL', () => {
    expect(() => calendarMultigetBody([])).toThrow(/at least one href/);
    expect(() => addressbookMultigetBody([''])).toThrow(/empty href/);
    expect(() => hrefForRequest('https://')).toThrow(/not a valid URL/);
    expect(hrefForRequest('HTTPS://p1-contacts.icloud.com/a/b.vcf')).toBe('/a/b.vcf');
  });

  it('addressbook bodies (query unfiltered; multiget) with defaults and custom props', () => {
    const q = addressbookQueryBody();
    expect(q).toBe(
      '<?xml version="1.0" encoding="utf-8"?><card:addressbook-query xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:d="DAV:">' +
        '<d:prop><d:getetag/><card:address-data/></d:prop></card:addressbook-query>',
    );
    expect(q).not.toContain('filter');
    root(q);
    expect(addressbookQueryBody([[NS.DAV, 'getetag']])).toContain('<d:prop><d:getetag/></d:prop>');
    const m = addressbookMultigetBody(['/1/carddavhome/card/A.vcf']);
    expect(m).toContain('<card:addressbook-multiget');
    expect(m).toContain('<d:href>/1/carddavhome/card/A.vcf</d:href>');
    expect(addressbookMultigetBody(['/a.vcf'], [[NS.DAV, 'getetag']])).not.toContain('address-data');
    expect(calendarMultigetBody(['/a.ics'], [[NS.DAV, 'getetag']])).not.toContain('calendar-data');
    expect(ADDRESS_DATA_PROPS).toHaveLength(2);
    expect(CALENDAR_DATA_PROPS).toHaveLength(2);
  });

  it('syncCollectionBody: initial, incremental (escaped), limited, custom props — in RFC 6578 order', () => {
    const initial = syncCollectionBody();
    expect(initial).toBe(
      '<?xml version="1.0" encoding="utf-8"?><d:sync-collection xmlns:d="DAV:"><d:sync-token/><d:sync-level>1</d:sync-level>' +
        '<d:prop><d:getetag/><d:getcontenttype/></d:prop></d:sync-collection>',
    );
    expect(syncCollectionBody({ syncToken: '' })).toContain('<d:sync-token/>');
    const inc = syncCollectionBody({ syncToken: 'HwoQ<&>', limit: 10, props: [[NS.DAV, 'getetag']] });
    expect(inc).toContain(
      '<d:sync-token>HwoQ&lt;&amp;&gt;</d:sync-token><d:sync-level>1</d:sync-level><d:limit><d:nresults>10</d:nresults></d:limit><d:prop><d:getetag/></d:prop>',
    );
    expect(qnames(root(inc))).toEqual([
      '{DAV:}sync-collection',
      '{DAV:}sync-token',
      '{DAV:}sync-level',
      '{DAV:}limit',
      '{DAV:}nresults',
      '{DAV:}prop',
      '{DAV:}getetag',
    ]);
  });

  it('syncCollectionBody refuses a non-positive or fractional limit', () => {
    expect(() => syncCollectionBody({ limit: 0 })).toThrow(/positive integer/);
    expect(() => syncCollectionBody({ limit: 1.5 })).toThrow(InvalidArgumentError);
  });
});

describe('parseStatusLine / safeDecode / parseXml', () => {
  it('reads status lines', () => {
    expect(parseStatusLine('HTTP/1.1 200 OK')).toBe(200);
    expect(parseStatusLine('  HTTP/1.1 404 Not Found\n')).toBe(404);
    expect(parseStatusLine('HTTP/2 507')).toBe(507);
    expect(parseStatusLine('http/1.0 403 Forbidden')).toBe(403);
    expect(parseStatusLine('OK')).toBeUndefined();
    expect(parseStatusLine('HTTP/1.1 20 OK')).toBeUndefined();
  });

  it('decodes percent-escapes and leaves malformed ones alone', () => {
    expect(safeDecode('/a%20b/c%40d.ics')).toBe('/a b/c@d.ics');
    expect(safeDecode('/a%20b%ZZ')).toBe('/a b%ZZ');
    expect(safeDecode('/x%E0%A4%A')).toBe('/x%E0%A4%A');
    expect(safeDecode('/x%E0%A4/y%20z')).toBe('/x%E0%A4/y z');
  });

  it('parseXml returns undefined for anything that is not well-formed XML', () => {
    expect(parseXml('')).toBeUndefined();
    expect(parseXml('hello')).toBeUndefined();
    expect(parseXml('{"a":1}')).toBeUndefined();
    expect(parseXml('<a><b></a>')).toBeUndefined();
    expect(parseXml('<a/><b/>')).toBeUndefined();
    expect(parseXml('\uFEFF<?xml version="1.0"?>\n<a xmlns="DAV:"/>')!.localName).toBe('a');
  });

  it('parseXml tolerates whitespace (and a BOM) before the XML declaration', () => {
    expect(parseXml('\r\n  <?xml version="1.0" encoding="UTF-8"?><a xmlns="DAV:"/>')!.localName).toBe('a');
    expect(parseXml('\uFEFF\n<?xml version="1.0"?><a xmlns="DAV:"/>')!.localName).toBe('a');
    expect(parseXml('\n<a xmlns="DAV:"/>')!.localName).toBe('a');
    expect(parseXml(' \n ')).toBeUndefined();
  });
});

// Aurinko's captured iCloud discovery answers (default namespaces throughout).
const PRINCIPAL_ANSWER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<multistatus xmlns="DAV:"><response xmlns="DAV:"><href>/</href><propstat><prop>' +
  '<current-user-principal xmlns="DAV:"><href xmlns="DAV:">/200385701/principal/</href></current-user-principal>' +
  '</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';

describe('parseMultistatus', () => {
  it('reads iCloud default-namespace documents and resolves hrefs against the request URL', () => {
    const ms = parse(PRINCIPAL_ANSWER, 'https://caldav.icloud.com/');
    expect(ms.url).toBe('https://caldav.icloud.com/');
    expect(ms.skipped).toBe(0);
    expect(ms.syncToken).toBeUndefined();
    expect(ms.responses).toHaveLength(1);
    const r = ms.responses[0]!;
    expect(r.href).toBe('/');
    expect(r.url).toBe('https://caldav.icloud.com/');
    expect(r.status).toBeUndefined();
    expect('status' in r).toBe(false);
    expect(r.props.has(NS.DAV, 'current-user-principal')).toBe(true);
    expect(r.props.status(NS.DAV, 'current-user-principal')).toBe(200);
    expect(r.props.hrefs(NS.DAV, 'current-user-principal')).toEqual(['/200385701/principal/']);
    expect(r.props.urls(NS.DAV, 'current-user-principal')).toEqual(['https://caldav.icloud.com/200385701/principal/']);
  });

  it('resolves an absolute partition-host href as given (the home-set switch)', () => {
    const xml =
      '<multistatus xmlns="DAV:"><response><href>/200385701/principal/</href><propstat><prop>' +
      '<calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">https://p34-caldav.icloud.com:443/200385701/calendars/</href></calendar-home-set>' +
      '</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';
    const r = parse(xml, 'https://caldav.icloud.com/200385701/principal/').responses[0]!;
    expect(r.props.urls(NS.CALDAV, 'calendar-home-set')).toEqual(['https://p34-caldav.icloud.com/200385701/calendars/']);
    expect(r.props.has(NS.DAV, 'calendar-home-set')).toBe(false);
  });

  it('reads prefixed documents the same way', () => {
    const xml =
      '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/">' +
      '<D:response><D:href>/200385701/calendars/work/</D:href><D:propstat><D:prop>' +
      '<D:displayname>Work &amp; Life</D:displayname>' +
      '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>' +
      '<C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name="vtodo"/><C:comp/><D:other/></C:supported-calendar-component-set>' +
      '<A:calendar-color>#FF2D55FF</A:calendar-color>' +
      '<CS:getctag>HwoQEgwAAGay9UzE</CS:getctag>' +
      '<D:current-user-privilege-set><D:privilege><D:read/></D:privilege><D:privilege><D:write/><D:bind/></D:privilege><D:other/></D:current-user-privilege-set>' +
      '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>';
    const p = parse(xml).responses[0]!.props;
    expect(p.text(NS.DAV, 'displayname')).toBe('Work & Life');
    expect(p.childNames(NS.DAV, 'resourcetype')).toEqual(['{DAV:}collection', '{urn:ietf:params:xml:ns:caldav}calendar']);
    expect(p.compNames()).toEqual(['VEVENT', 'VTODO']);
    expect(p.compNames(NS.CALDAV, 'supported-calendar-component-set')).toEqual(['VEVENT', 'VTODO']);
    expect(p.text(NS.APPLE, 'calendar-color')).toBe('#FF2D55FF');
    expect(p.text(NS.CS, 'getctag')).toBe('HwoQEgwAAGay9UzE');
    const expanded = [
      '{DAV:}read',
      '{DAV:}write',
      '{DAV:}bind',
      '{DAV:}read-acl',
      '{DAV:}read-current-user-privilege-set',
      '{DAV:}write-properties',
      '{DAV:}write-content',
      '{DAV:}unbind',
      '{DAV:}write-acl',
    ];
    expect(p.privileges()).toEqual(expanded);
    expect(p.privileges(NS.DAV, 'current-user-privilege-set')).toEqual(expanded);
    expect(p.element(NS.DAV, 'displayname')!.localName).toBe('displayname');
  });

  it('keeps CDATA calendar-data byte-exact in rawText (CRLF preserved) and trims in text', () => {
    const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-NOTE:a & b <c>\r\nEND:VCALENDAR\r\n';
    const xml =
      '<multistatus xmlns="DAV:"><response><href>/c/1.ics</href><propstat><prop><getetag>"lreo54jn"</getetag>' +
      `<calendar-data xmlns="urn:ietf:params:xml:ns:caldav"><![CDATA[${ics}]]></calendar-data>` +
      '</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';
    const p = parse(xml).responses[0]!.props;
    expect(p.rawText(NS.CALDAV, 'calendar-data')).toBe(ics);
    expect(p.text(NS.CALDAV, 'calendar-data')).toBe(ics.trimEnd());
    expect(p.text(NS.DAV, 'getetag')).toBe('"lreo54jn"');
  });

  it('decodes entity-encoded payloads (no CDATA)', () => {
    const xml =
      '<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:response><d:href>/1/card/A.vcf</d:href>' +
      '<d:propstat><d:prop><card:address-data>BEGIN:VCARD&#13;\nFN:Tom &amp; Jerry &lt;TJ&gt;&#13;\nEND:VCARD&#13;\n</card:address-data>' +
      '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
    const p = parse(xml).responses[0]!.props;
    expect(p.rawText(NS.CARDDAV, 'address-data')).toBe('BEGIN:VCARD\r\nFN:Tom & Jerry <TJ>\r\nEND:VCARD\r\n');
  });

  it('treats properties in a 404 propstat as missing, not present', () => {
    const xml =
      '<multistatus xmlns="DAV:"><response><href>/c/</href>' +
      '<propstat><prop><displayname>Home</displayname></prop><status>HTTP/1.1 200 OK</status></propstat>' +
      '<propstat><prop><getctag xmlns="http://calendarserver.org/ns/"/><resourcetype/></prop><status>HTTP/1.1 404 Not Found</status></propstat>' +
      '</response></multistatus>';
    const p = parse(xml).responses[0]!.props;
    expect(p.has(NS.DAV, 'displayname')).toBe(true);
    expect(p.has(NS.CS, 'getctag')).toBe(false);
    expect(p.status(NS.CS, 'getctag')).toBe(404);
    expect(p.status(NS.DAV, 'sync-token')).toBeUndefined();
    expect(p.text(NS.CS, 'getctag')).toBeUndefined();
    expect(p.rawText(NS.CS, 'getctag')).toBeUndefined();
    expect(p.element(NS.CS, 'getctag')).toBeUndefined();
    expect(p.hrefs(NS.CS, 'getctag')).toEqual([]);
    expect(p.urls(NS.CS, 'getctag')).toEqual([]);
    expect(p.childNames(NS.DAV, 'resourcetype')).toEqual([]);
    expect(p.compNames()).toEqual([]);
    expect(p.privileges()).toEqual([]);
  });

  it('a property listed twice keeps its successful entry, whichever comes first', () => {
    const xml = (a: string, b: string) =>
      '<multistatus xmlns="DAV:"><response><href>/c/</href>' +
      `<propstat><prop><displayname>X</displayname></prop><status>HTTP/1.1 ${a}</status></propstat>` +
      `<propstat><prop><displayname>Y</displayname></prop><status>HTTP/1.1 ${b}</status></propstat>` +
      '</response></multistatus>';
    const first = parse(xml('200 OK', '404 Not Found')).responses[0]!.props;
    expect(first.text(NS.DAV, 'displayname')).toBe('X');
    expect(first.status(NS.DAV, 'displayname')).toBe(200);
    const second = parse(xml('404 Not Found', '200 OK')).responses[0]!.props;
    expect(second.text(NS.DAV, 'displayname')).toBe('Y');
    const both = parse(xml('404 Not Found', '403 Forbidden')).responses[0]!.props;
    expect(both.status(NS.DAV, 'displayname')).toBe(403);
  });

  it('ignores a propstat without a readable status', () => {
    const xml =
      '<multistatus xmlns="DAV:"><response><href>/c/</href>' +
      '<propstat><prop><displayname>X</displayname></prop></propstat>' +
      '<propstat><prop><getetag>"e"</getetag></prop><status>garbage</status></propstat>' +
      '<propstat><prop><sync-token>t</sync-token></prop><status>HTTP/1.1 200 OK</status></propstat>' +
      '</response></multistatus>';
    const p = parse(xml).responses[0]!.props;
    expect(p.status(NS.DAV, 'displayname')).toBeUndefined();
    expect(p.status(NS.DAV, 'getetag')).toBeUndefined();
    expect(p.text(NS.DAV, 'sync-token')).toBe('t');
  });

  it('reads the status form (missing multiget href, sync deletion) incl. several hrefs sharing one status', () => {
    const xml =
      '<multistatus xmlns="DAV:">' +
      '<response><href>/c/gone.ics</href><status>HTTP/1.1 404 Not Found</status></response>' +
      '<response><href>/c/a.ics</href><href>/c/b%20c.ics</href><status>HTTP/1.1 404 Not Found</status></response>' +
      '<response><href>/c/</href><status>HTTP/1.1 507 Insufficient Storage</status></response>' +
      '<sync-token>\n  HwoQ-next  \n</sync-token>' +
      '<responsedescription>ignored</responsedescription>' +
      '</multistatus>';
    const ms = parse(xml, 'https://p34-caldav.icloud.com/1/calendars/c/');
    expect(ms.syncToken).toBe('HwoQ-next');
    expect(ms.responses.map((r) => [r.href, r.status])).toEqual([
      ['/c/gone.ics', 404],
      ['/c/a.ics', 404],
      ['/c/b%20c.ics', 404],
      ['/c/', 507],
    ]);
    expect(ms.responses[2]!.decodedHref).toBe('/c/b c.ics');
    expect(ms.responses[2]!.url).toBe('https://p34-caldav.icloud.com/c/b%20c.ics');
    expect(ms.responses[0]!.props.has(NS.DAV, 'getetag')).toBe(false);
  });

  it('uses only the first href of a propstat-form response', () => {
    const xml =
      '<multistatus xmlns="DAV:"><response><href>/a/</href><href>/b/</href>' +
      '<propstat><prop><displayname>A</displayname></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';
    const ms = parse(xml);
    expect(ms.responses.map((r) => r.href)).toEqual(['/a/']);
  });

  it('tolerates pretty-printed documents with comments between elements', () => {
    const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <!-- a comment -->
  <d:response>
    <d:href>
      /c/home/
    </d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype>
          <d:collection/>
        </d:resourcetype>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
    const r = parse(xml).responses[0]!;
    expect(r.href).toBe('/c/home/');
    expect(r.props.childNames(NS.DAV, 'resourcetype')).toEqual(['{DAV:}collection']);
  });

  it('reads an answer that starts with whitespace before <?xml … ?> (instead of calling it "not XML")', () => {
    const ms = parse(`\n${PRINCIPAL_ANSWER}`, 'https://caldav.icloud.com/');
    expect(ms.responses[0]!.props.urls(NS.DAV, 'current-user-principal')).toEqual(['https://caldav.icloud.com/200385701/principal/']);
  });

  it('privileges() expands DAV:all and DAV:write, without repeating what the server listed', () => {
    const set = (privs: string) =>
      parse(
        '<multistatus xmlns="DAV:"><response><href>/c/</href><propstat><prop><current-user-privilege-set>' +
          privs +
          '</current-user-privilege-set></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>',
      ).responses[0]!.props.privileges();
    const all = set('<privilege><all/></privilege>');
    for (const p of ['read', 'write', 'write-content', 'write-properties', 'bind', 'unbind', 'unlock', 'read-acl', 'write-acl']) {
      expect(all).toContain(`{DAV:}${p}`);
    }
    expect(all[0]).toBe('{DAV:}all');
    expect(new Set(all).size).toBe(all.length);
    expect(set('<privilege><write/></privilege><privilege><bind/></privilege>')).toEqual([
      '{DAV:}write',
      '{DAV:}bind',
      '{DAV:}write-properties',
      '{DAV:}write-content',
      '{DAV:}unbind',
      '{DAV:}write-acl',
    ]);
    // A read-only (shared or subscribed) calendar: nothing implies a write privilege.
    const readOnly = set('<privilege><read/></privilege><privilege><read-free-busy xmlns="urn:ietf:params:xml:ns:caldav"/></privilege>');
    expect(readOnly).toEqual([
      '{DAV:}read',
      '{urn:ietf:params:xml:ns:caldav}read-free-busy',
      '{DAV:}read-acl',
      '{DAV:}read-current-user-privilege-set',
    ]);
    expect(readOnly.some((p) => /write|bind/.test(p))).toBe(false);
  });

  it('omits an empty top-level sync-token', () => {
    expect(parse('<multistatus xmlns="DAV:"><sync-token> </sync-token></multistatus>').syncToken).toBeUndefined();
  });

  it('skips malformed responses and counts them instead of failing the whole answer', () => {
    const xml =
      '<multistatus xmlns="DAV:">' +
      '<response><propstat><prop><displayname>no href</displayname></prop><status>HTTP/1.1 200 OK</status></propstat></response>' +
      '<response><href>  </href><status>HTTP/1.1 200 OK</status></response>' +
      '<response><href>/ok/</href><href></href><status>HTTP/1.1 404 Not Found</status></response>' +
      '<response><href>http://[bad</href><status>HTTP/1.1 404 Not Found</status></response>' +
      '<response><href>/bad-status/</href><status>teapot</status></response>' +
      '<response><href>/good/</href><propstat><prop><displayname>Good</displayname></prop><status>HTTP/1.1 200 OK</status></propstat></response>' +
      '</multistatus>';
    const ms = parse(xml);
    expect(ms.skipped).toBe(5);
    expect(ms.responses).toHaveLength(1);
    expect(ms.responses[0]!.props.text(NS.DAV, 'displayname')).toBe('Good');
  });

  it('hrefs() skips empty href elements; urls() skips unresolvable ones; elements in no namespace are {}name', () => {
    const xml =
      '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/x/</d:href><d:propstat><d:prop>' +
      '<d:group-member-set><d:href>/a/</d:href><d:href> </d:href><d:href>http://[bad</d:href><d:x><d:href>/nested/</d:href></d:x></d:group-member-set>' +
      '<plain>no namespace</plain>' +
      '<d:resourcetype><bare/></d:resourcetype>' +
      '<d:current-user-privilege-set><d:privilege><loose/></d:privilege></d:current-user-privilege-set>' +
      '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';
    const p = parse(xml, 'https://p1-contacts.icloud.com/1/').responses[0]!.props;
    expect(p.hrefs(NS.DAV, 'group-member-set')).toEqual(['/a/', 'http://[bad', '/nested/']);
    expect(p.urls(NS.DAV, 'group-member-set')).toEqual(['https://p1-contacts.icloud.com/a/', 'https://p1-contacts.icloud.com/nested/']);
    expect(p.text('', 'plain')).toBe('no namespace');
    expect(p.childNames(NS.DAV, 'resourcetype')).toEqual(['{}bare']);
    expect(p.privileges()).toEqual(['{}loose']);
  });

  it('refuses a body that is not XML, or not a multistatus, as an UpstreamError (never an empty listing)', () => {
    const notXml = () => parseMultistatus('<html><body><p>Service Unavailable<br></body></html>', { baseUrl: BASE, service: 'contacts', status: 200 });
    expect(notXml).toThrow(UpstreamError);
    try {
      notXml();
    } catch (err) {
      const e = err as UpstreamError;
      expect(e.service).toBe('contacts');
      expect(e.status).toBe(200);
      expect(e.message).toMatch(/not XML/);
    }
    try {
      parse('<html><body>Login</body></html>');
      expect.unreachable();
    } catch (err) {
      const e = err as UpstreamError;
      expect(e.status).toBe(207);
      expect(e.message).toMatch(/a <html> document/);
    }
    expect(() => parse('')).toThrow(UpstreamError);
    expect(() => parse('<error xmlns="DAV:"><need-privileges/></error>')).toThrow(/a <error> document/);
    expect(() => parse('<multistatus/>')).toThrow(UpstreamError);
  });

  it('never resolves external entities or expands DOCTYPE entities (XXE / billion laughs)', () => {
    const xxe =
      '<?xml version="1.0"?><!DOCTYPE m [<!ENTITY xxe SYSTEM "file:///etc/passwd"><!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]>' +
      '<multistatus xmlns="DAV:"><response><href>/x/</href><propstat><prop><displayname>&xxe;&b;</displayname></prop>' +
      '<status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';
    const name = parse(xxe).responses[0]!.props.text(NS.DAV, 'displayname');
    expect(name).not.toMatch(/root:/);
    expect(name).not.toContain('aaaa');
  });
});

describe('davErrorConditions', () => {
  it('lists the condition names of a DAV:error body', () => {
    expect(
      davErrorConditions('<?xml version="1.0"?><D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:need-privileges><D:resource><D:href>/x</D:href></D:resource></D:need-privileges><C:no-uid-conflict/></D:error>'),
    ).toEqual(['need-privileges', 'no-uid-conflict']);
    expect(davErrorConditions('<error xmlns="DAV:"><valid-sync-token/></error>')).toEqual(['valid-sync-token']);
  });

  it('is empty for anything else', () => {
    expect(davErrorConditions('')).toEqual([]);
    expect(davErrorConditions('Forbidden')).toEqual([]);
    expect(davErrorConditions('an error occurred')).toEqual([]);
    expect(davErrorConditions('<html><body>error</body></html>')).toEqual([]);
    expect(davErrorConditions('<error xmlns="urn:other"><x/></error>')).toEqual([]);
  });
});
