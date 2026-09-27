import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOOK_TTL_MS,
  MULTIGET_BATCH,
  cardIdFromUrl,
  contactNotFound,
  fetchCard,
  findInBook,
  invalidateBook,
  loadBook,
  normalizeId,
  openSession,
  reread,
  toEntry,
} from '../../src/contacts/book.js';
import { ConfigError, CredentialsRejectedError, UpstreamError } from '../../src/errors.js';
import { BOOK, DSID, FakeICloud, HOME, useContactsEnv, vcard } from './fake-icloud.js';

useContactsEnv();

const ANN = vcard('N:Lee;Ann;;;', 'FN:Ann Lee', 'UID:ANN');
const BOB = vcard('N:Roe;Bob;;;', 'FN:Bob Roe', 'UID:BOB');
const FAMILY = vcard('N:Family;;;;', 'FN:Family', 'X-ADDRESSBOOKSERVER-KIND:group', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:ANN');

afterEach(() => {
  vi.useRealTimers();
});

describe('small helpers', () => {
  it('ids from URLs and arguments', () => {
    expect(cardIdFromUrl(`${BOOK}ABC-1.vcf`)).toBe('ABC-1');
    expect(cardIdFromUrl(`${BOOK}with%20space.VCF`)).toBe('with space');
    expect(cardIdFromUrl(`${BOOK}no-extension`)).toBe('no-extension');
    expect(normalizeId(' ABC.vcf ')).toBe('ABC');
    expect(contactNotFound('X')).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('toEntry parses a card (ETag optional) and refuses non-vCards', () => {
    expect(toEntry(`${BOOK}A.vcf`, ANN, '"e1"')).toMatchObject({ id: 'A', etag: '"e1"', view: { name: 'Ann Lee' } });
    expect(toEntry(`${BOOK}A.vcf`, ANN, undefined)!.etag).toBeUndefined();
    expect(toEntry(`${BOOK}A.vcf`, 'not a card', '"e"')).toBeUndefined();
  });
});

describe('openSession', () => {
  it('reads credentials at call time (ConfigError when unset, before any request)', async () => {
    delete process.env.ICLOUD_APP_PASSWORD;
    await expect(openSession()).rejects.toBeInstanceOf(ConfigError);
  });

  it('discovers the address book (the carddav:addressbook collection, preferring `card`) once per home', async () => {
    const fake = new FakeICloud();
    fake.collections = [
      { name: 'other-book', addressbook: true },
      { name: 'card', addressbook: true },
      { name: 'not-a-book', addressbook: false },
    ];
    const first = await openSession({ request: fake.request });
    expect(first).toMatchObject({ homeUrl: HOME, bookUrl: BOOK, fresh: true, version: 'ctag-1' });
    const again = await openSession({ request: fake.request });
    expect(again).toMatchObject({ bookUrl: BOOK, fresh: false });
    expect(again.version).toBeUndefined();
    expect(fake.log()).toEqual([
      'PROPFIND /',
      `PROPFIND /${DSID}/principal/`,
      `PROPFIND /${DSID}/carddavhome/`,
    ]);
    expect(fake.calls[2]!.headers!.Depth).toBe('1');
  });

  it('falls back to the first address book when none is named `card`, with sync-token as its version', async () => {
    const fake = new FakeICloud();
    fake.collections = [{ name: 'contacts', addressbook: true }];
    fake.syncTokenOnly = true;
    const s = await openSession({ request: fake.request });
    expect(s.bookUrl).toBe(`${HOME}contacts/`);
    expect(s.version).toBe('tok-1');
  });

  it('an account with no address book is an error, never a guessed URL', async () => {
    const fake = new FakeICloud();
    fake.collections = [{ name: 'x', addressbook: false }];
    await expect(openSession({ request: fake.request })).rejects.toThrow(/no address book/);
  });
});

describe('loadBook', () => {
  it('downloads every card once, splits groups from contacts, then reuses the download while the ctag is unchanged', async () => {
    const fake = new FakeICloud({ 'ANN.vcf': ANN, 'BOB.vcf': BOB, 'FAMILY.vcf': FAMILY });
    const a = await loadBook({ request: fake.request });
    expect(a.cached).toBe(false);
    expect(a.book.contacts.map((c) => c.id).sort()).toEqual(['ANN', 'BOB']);
    expect(a.book.groups.map((g) => g.id)).toEqual(['FAMILY']);
    expect(a.book.unreadable).toBe(0);
    expect(a.book.contacts[0]!.etag).toMatch(/^"e\d+"$/);
    const b = await loadBook({ request: fake.request });
    expect(b.cached).toBe(true);
    expect(fake.log().slice(-1)).toEqual([`PROPFIND /${DSID}/carddavhome/card/`]);
    // Someone else changes the book → the ctag moves → a fresh download.
    fake.cards.set('NEW.vcf', { body: vcard('FN:New', 'UID:NEW'), etag: '"n"' });
    fake.ctag += 1;
    const c = await loadBook({ request: fake.request });
    expect(c.cached).toBe(false);
    expect(c.book.contacts).toHaveLength(3);
  });

  it('re-downloads after BOOK_TTL_MS even when the ctag is unchanged, and after invalidateBook', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-27T12:00:00Z') });
    const fake = new FakeICloud({ 'ANN.vcf': ANN });
    await loadBook({ request: fake.request });
    vi.setSystemTime(Date.now() + BOOK_TTL_MS - 1);
    expect((await loadBook({ request: fake.request })).cached).toBe(true);
    vi.setSystemTime(Date.now() + 2);
    expect((await loadBook({ request: fake.request })).cached).toBe(false);
    invalidateBook(BOOK);
    expect((await loadBook({ request: fake.request })).cached).toBe(false);
  });

  it('never reuses a download when iCloud reports no collection version', async () => {
    const fake = new FakeICloud({ 'ANN.vcf': ANN });
    fake.reportCtag = false;
    await loadBook({ request: fake.request });
    expect((await loadBook({ request: fake.request })).cached).toBe(false);
  });

  it('counts members it cannot read (no data, not a vCard, a status-only response, a malformed response)', async () => {
    const fake = new FakeICloud({ 'ANN.vcf': ANN, 'BAD.vcf': 'garbage' });
    fake.extraReport =
      `<response><href>/${DSID}/carddavhome/card/GONE.vcf</href><status>HTTP/1.1 404 Not Found</status></response>` +
      `<response><href>/${DSID}/carddavhome/card/NODATA.vcf</href><propstat><prop><getetag>"x"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response>` +
      '<response><propstat><prop/><status>HTTP/1.1 200 OK</status></propstat></response>';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { book } = await loadBook({ request: fake.request });
    expect(book.contacts.map((c) => c.id)).toEqual(['ANN']);
    expect(book.unreadable).toBe(4);
    errors.mockRestore();
  });

  it('rediscovers the address book once when the cached one is gone (404)', async () => {
    const fake = new FakeICloud({ 'ANN.vcf': ANN });
    await loadBook({ request: fake.request });
    fake.collections = [{ name: 'card2', addressbook: true, ctag: 'moved' }];
    const { book, session } = await loadBook({ request: fake.request });
    expect(session.bookUrl).toBe(`${HOME}card2/`);
    expect(book.version).toBe('moved');
  });

  it('any other failure of the version check propagates (never an empty book)', async () => {
    const fake = new FakeICloud({ 'ANN.vcf': ANN });
    await loadBook({ request: fake.request });
    fake.fail({ method: 'PROPFIND', url: '/card/', status: 500 });
    await expect(loadBook({ request: fake.request })).rejects.toBeInstanceOf(UpstreamError);
    fake.fail({ method: 'PROPFIND', url: '/card/', status: 401 });
    await expect(loadBook({ request: fake.request })).rejects.toBeInstanceOf(CredentialsRejectedError);
  });

  it('a version answer without the collection itself falls back to its first response, or to none', async () => {
    const fake = new FakeICloud({ 'ANN.vcf': ANN });
    await loadBook({ request: fake.request });
    const ms = (inner: string) => `<multistatus xmlns="DAV:">${inner}</multistatus>`;
    const other = ms(
      '<response><href>/elsewhere/</href><propstat><prop><getctag xmlns="http://calendarserver.org/ns/">ctag-1</getctag></prop><status>HTTP/1.1 200 OK</status></propstat></response>',
    );
    const realRequest = fake.request;
    let answer = other;
    const wrapped: typeof fake.request = async (req) => {
      if (req.method === 'PROPFIND' && String(req.url) === BOOK) {
        return { status: 207, headers: new Headers(), url: BOOK, data: answer, text: answer, bytes: new Uint8Array() };
      }
      return realRequest(req);
    };
    expect((await loadBook({ request: wrapped })).cached).toBe(true);
    answer = ms('');
    expect((await loadBook({ request: wrapped })).cached).toBe(false);
  });
});

describe('findInBook', () => {
  it('matches exactly, then case-insensitively only when unambiguous', async () => {
    const fake = new FakeICloud({ 'Ann.vcf': ANN, 'ann.vcf': BOB, 'Bob.vcf': BOB, 'FAMILY.vcf': FAMILY });
    const { book } = await loadBook({ request: fake.request });
    expect(findInBook(book, 'Ann')!.id).toBe('Ann');
    expect(findInBook(book, 'ANN')).toBeUndefined();
    expect(findInBook(book, 'bob')!.id).toBe('Bob');
    expect(findInBook(book, 'family')!.id).toBe('FAMILY');
    expect(findInBook(book, 'zzz')).toBeUndefined();
  });
});

describe('fetchCard / reread', () => {
  it('GETs <book>/<id>.vcf directly with its ETag', async () => {
    const fake = new FakeICloud({ 'ANN.vcf': ANN });
    const s = await openSession({ request: fake.request });
    const e = await fetchCard(s, 'ANN', { request: fake.request });
    expect(e).toMatchObject({ id: 'ANN', url: `${BOOK}ANN.vcf`, raw: ANN });
    expect(e.etag).toBe(fake.cards.get('ANN.vcf')!.etag);
    expect(fake.log().slice(-1)).toEqual([`GET /${DSID}/carddavhome/card/ANN.vcf`]);
  });

  it('finds a card whose resource is not named <id>.vcf through the listing', async () => {
    const fake = new FakeICloud({ 'odd-name': ANN });
    const s = await openSession({ request: fake.request });
    const e = await fetchCard(s, 'odd-name', { request: fake.request });
    expect(e.url).toBe(`${BOOK}odd-name`);
  });

  it('NOT_FOUND when no card has that id — or the listed one vanished in between', async () => {
    const fake = new FakeICloud({ 'odd-name': ANN, 'STALE.vcf': BOB });
    const s = await openSession({ request: fake.request });
    await expect(fetchCard(s, 'nobody', { request: fake.request })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Listed under the same URL that just 404'd.
    fake.fail({ method: 'GET', url: 'STALE.vcf', status: 404 });
    await expect(fetchCard(s, 'STALE', { request: fake.request })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Listed elsewhere, then deleted before the second GET.
    invalidateBook(BOOK);
    fake.fail({ method: 'GET', url: 'odd-name', status: 410 });
    await expect(fetchCard(s, 'odd-name', { request: fake.request })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('other failures propagate from either GET', async () => {
    const fake = new FakeICloud({ 'odd-name': ANN });
    const s = await openSession({ request: fake.request });
    fake.fail({ method: 'GET', url: 'X.vcf', status: 500 });
    await expect(fetchCard(s, 'X', { request: fake.request })).rejects.toMatchObject({ status: 500 });
    fake.fail({ method: 'GET', url: '/card/odd-name', status: 403 });
    await expect(fetchCard(s, 'odd-name', { request: fake.request })).rejects.toMatchObject({ status: 403 });
  });

  it('a body that is not a vCard is an UpstreamError', async () => {
    const fake = new FakeICloud({ 'BAD.vcf': '<html>oops</html>' });
    const s = await openSession({ request: fake.request });
    await expect(fetchCard(s, 'BAD', { request: fake.request })).rejects.toThrow(/not a vCard/);
  });

  it('reread: the card, undefined when absent, errors otherwise', async () => {
    const fake = new FakeICloud({ 'ANN.vcf': ANN });
    const s = await openSession({ request: fake.request });
    expect((await reread(s, `${BOOK}ANN.vcf`))!.id).toBe('ANN');
    expect(await reread(s, `${BOOK}NOPE.vcf`)).toBeUndefined();
    fake.fail({ method: 'GET', status: 500 });
    await expect(reread(s, `${BOOK}ANN.vcf`)).rejects.toMatchObject({ status: 500 });
  });
});

describe('review fixes: the listing itself', () => {
  it('a 507 on the address book\'s own response marks the download truncated (RFC 6352 §8.6.1)', async () => {
    const fake = new FakeICloud({ 'ANN.vcf': ANN });
    const plain = await loadBook({ request: fake.request });
    expect(plain.book.truncated).toBe(false);
    invalidateBook(BOOK);
    fake.extraReport = `<response><href>/${DSID}/carddavhome/card/</href><status>HTTP/1.1 507 Insufficient Storage</status></response>`;
    const { book } = await loadBook({ request: fake.request });
    expect(book.truncated).toBe(true);
    expect(book.unreadable).toBe(0);
    expect(book.contacts.map((c) => c.id)).toEqual(['ANN']);
  });

  it('XML indentation before BEGIN:VCARD does not make a card unreadable', async () => {
    const fake = new FakeICloud();
    const indented = '\n      ' + ANN.split('\r\n').join('\r\n');
    fake.extraReport =
      `<response><href>/${DSID}/carddavhome/card/INDENT.vcf</href><propstat><prop><getetag>"i"</getetag>` +
      `<address-data xmlns="urn:ietf:params:xml:ns:carddav">${indented}</address-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>`;
    const { book } = await loadBook({ request: fake.request });
    expect(book.unreadable).toBe(0);
    expect(book.contacts.map((c) => [c.id, c.view.name])).toEqual([['INDENT', 'Ann Lee']]);
  });
});

describe('review fixes: a book too large for one answer is fetched in batches', () => {
  const big = (name: string, kb: number) => vcard(`N:${name};;;;`, `FN:${name}`, `PHOTO;ENCODING=b;TYPE=JPEG:${'A'.repeat(kb * 1024)}`, `UID:${name}`);
  const reports = (fake: FakeICloud) => fake.calls.filter((c) => c.method === 'REPORT').map((c) => String(c.body));

  it('falls back to an ETag listing + addressbook-multiget batches of MULTIGET_BATCH, then caches by ctag as before', async () => {
    const cards: Record<string, string> = { 'FAMILY.vcf': FAMILY };
    for (let i = 0; i < 2 * MULTIGET_BATCH + 10; i++) cards[`P${i}.vcf`] = vcard(`FN:P${i}`, `UID:P${i}`);
    const fake = new FakeICloud(cards);
    fake.maxResponseBytes = 40_000; // the full book is larger, one batch of 100 fits
    const a = await loadBook({ request: fake.request });
    expect(a.book).toMatchObject({ unreadable: 0, tooLarge: 0, truncated: false });
    expect(a.book.contacts).toHaveLength(2 * MULTIGET_BATCH + 10);
    expect(a.book.groups.map((g) => g.id)).toEqual(['FAMILY']);
    expect(a.book.contacts[0]!.etag).toMatch(/^"e\d+"$/);
    const [full, listing, ...gets] = reports(fake);
    expect(full).toContain('address-data');
    expect(listing).toContain('addressbook-query');
    expect(listing).not.toContain('address-data');
    expect(gets.every((g) => g.includes('addressbook-multiget'))).toBe(true);
    // Hrefs are sent as absolute paths (iCloud refuses absolute URIs in a multiget).
    expect(fake.multigets.map((m) => m.length)).toEqual([MULTIGET_BATCH, MULTIGET_BATCH, 11]);
    expect(fake.multigets[0]![0]).toMatch(new RegExp(`^/${DSID}/carddavhome/card/`));
    expect((await loadBook({ request: fake.request })).cached).toBe(true);
  });

  it('halves a batch that is still too large; a single card too large alone is counted in tooLarge, not a failed book', async () => {
    const fake = new FakeICloud({ 'ANN.vcf': ANN, 'BOB.vcf': BOB, 'HUGE.vcf': big('HUGE', 40), 'FAMILY.vcf': FAMILY });
    fake.maxResponseBytes = 20_000;
    const { book } = await loadBook({ request: fake.request });
    expect(book.contacts.map((c) => c.id).sort()).toEqual(['ANN', 'BOB']);
    expect(book.groups.map((g) => g.id)).toEqual(['FAMILY']);
    expect(book).toMatchObject({ tooLarge: 1, unreadable: 0 });
    expect(fake.multigets.map((m) => m.length)).toEqual([4, 2, 2, 1, 1]);
  });

  it('counts what the batched path could not read: error members of the listing, cards a multiget left out or answered 404', async () => {
    const fake = new FakeICloud({ 'ANN.vcf': ANN, 'BOB.vcf': BOB, 'HUGE.vcf': big('HUGE', 40) });
    fake.maxResponseBytes = 20_000;
    fake.extraListing =
      `<response><href>/${DSID}/carddavhome/card/</href><status>HTTP/1.1 507 Insufficient Storage</status></response>` +
      `<response><href>/${DSID}/carddavhome/card/GONE.vcf</href><propstat><prop><getetag>"g"</getetag></prop><status>HTTP/1.1 200 OK</status></propstat></response>` +
      `<response><href>/${DSID}/carddavhome/card/DENIED.vcf</href><status>HTTP/1.1 403 Forbidden</status></response>`;
    fake.multigetOmits.add('BOB.vcf');
    // A member nobody asked for is ignored (it is never counted twice).
    fake.extraMultiget = `<response><href>/${DSID}/carddavhome/card/ANN.vcf</href><propstat><prop><address-data xmlns="urn:ietf:params:xml:ns:carddav">${'x'}</address-data></prop><status>HTTP/1.1 200 OK</status></propstat></response>`;
    const { book } = await loadBook({ request: fake.request });
    expect(book.contacts.map((c) => c.id)).toEqual(['ANN']);
    // DENIED (listing status), BOB (left out), GONE (404 in the multiget).
    expect(book).toMatchObject({ truncated: true, unreadable: 3, tooLarge: 1 });
  });

  it('any other failure of a batch is an error, never a partial book', async () => {
    const fake = new FakeICloud({ 'ANN.vcf': ANN, 'HUGE.vcf': big('HUGE', 40) });
    fake.maxResponseBytes = 20_000;
    let reportsSeen = 0;
    const request: typeof fake.request = async (req) => {
      if (req.method === 'REPORT' && ++reportsSeen === 3) throw new UpstreamError('contacts', 503, 'contacts: REPORT failed with HTTP 503');
      return fake.request(req);
    };
    await expect(loadBook({ request })).rejects.toMatchObject({ status: 503 });
    // Nothing was cached from the failed attempt.
    fake.maxResponseBytes = undefined;
    expect((await loadBook({ request: fake.request })).cached).toBe(false);
  });
});

