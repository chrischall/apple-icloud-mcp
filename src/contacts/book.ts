import { AppleToolError, UpstreamError } from '../errors.js';
import { DavClient, childUrl, lastPathSegment, sameResource, type DavRequestFn } from '../dav/client.js';
import { getDavContext } from '../dav/icloud.js';
import { ADDRESS_DATA_PROPS, NS, addressbookQueryBody, clark } from '../dav/xml.js';
import { readContact, type ContactView } from './model.js';
import { VCard } from './vcard.js';

/**
 * The iCloud address book over CardDAV.
 *
 *   discovery (dav/icloud.ts) → the account's CardDAV home on its partition host
 *   PROPFIND <home> Depth 1   → the collection whose resourcetype is carddav:addressbook
 *                               (in practice exactly one, `<home>card/`)
 *   PROPFIND <book> Depth 0   → getctag (the collection's version)
 *   REPORT   <book> Depth 1   → an UNFILTERED addressbook-query: every card with its ETag
 *
 * Whether iCloud honours a filtered addressbook-query is unverified, so
 * search happens locally over the whole book. The download is cached per
 * process, keyed by the collection's getctag: every read re-checks the ctag
 * (one cheap PROPFIND) and reuses the cache only while it is unchanged and at
 * most `BOOK_TTL_MS` old — so a read never serves a book another client has
 * changed since. Writes go straight to the card (GET for the current text +
 * ETag, then a conditional PUT/DELETE) and drop the cache.
 */

/** How long a downloaded book is reused while its ctag is unchanged. */
export const BOOK_TTL_MS = 5 * 60_000;

export interface ContactsDeps {
  /** The DAV request function (default `httpRequest`); tests inject a fake iCloud. */
  request?: DavRequestFn;
  /** New contact UIDs (default `randomUUID().toUpperCase()`). */
  newUid?: () => string;
  /** The clock for REV stamps (default `new Date()`). */
  now?: () => Date;
}

/** One card in the address book. */
export interface CardEntry {
  /** The resource name without `.vcf` — the contact id tools use. */
  id: string;
  /** The card's absolute URL (on the partition host). */
  url: string;
  etag?: string;
  /** The vCard text exactly as iCloud sent it. */
  raw: string;
  card: VCard;
  view: ContactView;
}

export interface Book {
  url: string;
  /** getctag (or sync-token) at download time; undefined when iCloud reported neither. */
  version?: string;
  loadedAt: number;
  contacts: CardEntry[];
  groups: CardEntry[];
  /** Members that came back without readable vCard data (never silently dropped: tools report it). */
  unreadable: number;
  /**
   * iCloud answered the listing for the address book itself with an error
   * status — RFC 6352 §8.6.1's 507 marks a result the server TRUNCATED. The
   * cards present are real, but the book is not all there (tools say so).
   */
  truncated: boolean;
}

export interface ContactsSession {
  client: DavClient;
  homeUrl: string;
  bookUrl: string;
}

/** Per CardDAV home: the address book found under it (and its version when just listed). */
const bookUrls = new Map<string, string>();
/** Per address book URL: the last download. */
const books = new Map<string, Book>();

/** Test seam: forget every cached address-book location and download. */
export function resetContactsCache(): void {
  bookUrls.clear();
  books.clear();
}

/** Drop the cached download of `bookUrl` — after any write, so the next read fetches afresh. */
export function invalidateBook(bookUrl: string): void {
  books.delete(bookUrl);
}

/** The id a card URL stands for: its last path segment without `.vcf`. */
export function cardIdFromUrl(url: string): string {
  return lastPathSegment(url).replace(/\.vcf$/i, '');
}

const ADDRESSBOOK = clark(NS.CARDDAV, 'addressbook');

/**
 * Find the address book under the CardDAV home (Depth 1). Prefers the one
 * named `card` (iCloud's) when several exist; none at all is an
 * `UpstreamError` — never a guessed URL.
 */
async function findAddressBook(client: DavClient, homeUrl: string): Promise<{ url: string; version?: string }> {
  const listing = await client.propfind(
    homeUrl,
    [
      [NS.DAV, 'resourcetype'],
      [NS.DAV, 'displayname'],
      [NS.CS, 'getctag'],
      [NS.DAV, 'sync-token'],
    ],
    1,
  );
  const candidates = listing.responses.filter(
    (r) => !sameResource(r.url, homeUrl) && r.status === undefined && r.props.childNames(NS.DAV, 'resourcetype').includes(ADDRESSBOOK),
  );
  const chosen = candidates.find((r) => lastPathSegment(r.url) === 'card') ?? candidates[0];
  if (!chosen) {
    throw new UpstreamError('contacts', 207, 'contacts: iCloud listed no address book under this account\'s CardDAV home.', {
      hint: 'Check that Contacts is turned on for this Apple ID in iCloud settings.',
    });
  }
  const version = versionOf(chosen.props);
  return { url: chosen.url, ...(version !== undefined ? { version } : {}) };
}

function versionOf(props: { text(ns: string, name: string): string | undefined }): string | undefined {
  return props.text(NS.CS, 'getctag') || props.text(NS.DAV, 'sync-token') || undefined;
}

/** The collection's current version (PROPFIND Depth 0 getctag + sync-token). */
async function bookVersion(client: DavClient, bookUrl: string): Promise<string | undefined> {
  const res = await client.propfind(
    bookUrl,
    [
      [NS.CS, 'getctag'],
      [NS.DAV, 'sync-token'],
    ],
    0,
  );
  const self = res.responses.find((r) => sameResource(r.url, bookUrl)) ?? res.responses[0];
  return self ? versionOf(self.props) : undefined;
}

function isNotFound(err: unknown): boolean {
  return err instanceof UpstreamError && (err.status === 404 || err.status === 410);
}

/**
 * Credentials → client → discovered home → address book URL. No book
 * download. The book URL is cached per home for the life of the process.
 */
export async function openSession(deps: ContactsDeps = {}): Promise<ContactsSession & { version?: string; fresh: boolean }> {
  const ctx = await getDavContext('contacts', deps.request ? { request: deps.request } : {});
  const known = bookUrls.get(ctx.homeUrl);
  if (known !== undefined) return { client: ctx.client, homeUrl: ctx.homeUrl, bookUrl: known, fresh: false };
  const found = await findAddressBook(ctx.client, ctx.homeUrl);
  bookUrls.set(ctx.homeUrl, found.url);
  return {
    client: ctx.client,
    homeUrl: ctx.homeUrl,
    bookUrl: found.url,
    fresh: true,
    ...(found.version !== undefined ? { version: found.version } : {}),
  };
}

/** Build a CardEntry from a card's text, or undefined when it is not a vCard. */
export function toEntry(url: string, raw: string, etag: string | undefined): CardEntry | undefined {
  const card = VCard.parse(raw);
  if (!card) return undefined;
  return { id: cardIdFromUrl(url), url, raw, card, view: readContact(card), ...(etag ? { etag } : {}) };
}

async function download(session: ContactsSession, version: string | undefined): Promise<Book> {
  const res = await session.client.report(session.bookUrl, addressbookQueryBody(ADDRESS_DATA_PROPS), 1);
  const contacts: CardEntry[] = [];
  const groups: CardEntry[] = [];
  let unreadable = res.skipped;
  let truncated = false;
  for (const r of res.responses) {
    if (sameResource(r.url, session.bookUrl)) {
      // iCloud lists the collection itself. With an error status it is the
      // server saying the answer is incomplete (507 = truncated).
      if (r.status !== undefined && r.status >= 400) truncated = true;
      continue;
    }
    // A response-level status (`<href/><status>`) carries no card data: a
    // member iCloud could not return. Counted, never silently dropped.
    const raw = r.status === undefined ? r.props.rawText(NS.CARDDAV, 'address-data') : undefined;
    // XML indentation before BEGIN:VCARD would read as a folded line. These
    // cards are only ever displayed (writes GET the card afresh), so dropping
    // it changes nothing that is written back.
    const entry = raw === undefined ? undefined : toEntry(r.url, raw.replace(/^[ \t\r\n]+/, ''), r.props.text(NS.DAV, 'getetag'));
    if (!entry) {
      unreadable += 1;
      continue;
    }
    (entry.view.kind === 'group' ? groups : contacts).push(entry);
  }
  const book: Book = {
    url: session.bookUrl,
    loadedAt: Date.now(),
    contacts,
    groups,
    unreadable,
    truncated,
    ...(version !== undefined ? { version } : {}),
  };
  books.set(session.bookUrl, book);
  return book;
}

/**
 * The whole address book, current as of this call: the ctag is checked on
 * every call and the cached download reused only while it matches (and is
 * younger than `BOOK_TTL_MS`). If the cached book URL has gone away (404),
 * the address book is looked up again once.
 */
export async function loadBook(deps: ContactsDeps = {}): Promise<{ session: ContactsSession; book: Book; cached: boolean }> {
  let opened = await openSession(deps);
  let version: string | undefined;
  if (opened.fresh) {
    version = opened.version;
  } else {
    try {
      version = await bookVersion(opened.client, opened.bookUrl);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      bookUrls.delete(opened.homeUrl);
      books.delete(opened.bookUrl);
      opened = await openSession(deps);
      version = opened.version;
    }
  }
  const session: ContactsSession = { client: opened.client, homeUrl: opened.homeUrl, bookUrl: opened.bookUrl };
  const cached = books.get(session.bookUrl);
  if (cached && version !== undefined && cached.version === version && Date.now() - cached.loadedAt < BOOK_TTL_MS) {
    return { session, book: cached, cached: true };
  }
  return { session, book: await download(session, version), cached: false };
}

/** Find a card by id in a downloaded book (exact, then case-insensitive when unambiguous). */
export function findInBook(book: Book, id: string): CardEntry | undefined {
  const all = [...book.contacts, ...book.groups];
  const exact = all.find((e) => e.id === id);
  if (exact) return exact;
  const loose = all.filter((e) => e.id.toLowerCase() === id.toLowerCase());
  return loose.length === 1 ? loose[0] : undefined;
}

/** The error for an id that names no card. */
export function contactNotFound(id: string): AppleToolError {
  return new AppleToolError('NOT_FOUND', `No contact with id "${id}" exists in the iCloud address book.`, {
    hint: 'Use apple_contacts_search to find the contact and its id. It may have been deleted on another device.',
  });
}

/** Normalise a contact id argument: a trailing `.vcf` is accepted and dropped. */
export function normalizeId(id: string): string {
  return id.trim().replace(/\.vcf$/i, '');
}

async function getEntry(session: ContactsSession, url: string): Promise<CardEntry> {
  const { body, etag } = await session.client.get(url);
  const entry = toEntry(url, body, etag);
  if (!entry) {
    throw new UpstreamError('contacts', 200, 'contacts: iCloud returned something that is not a vCard for this contact.', {
      hint: 'The card may be damaged; view it in the Contacts app or on iCloud.com.',
    });
  }
  return entry;
}

/**
 * Read one card FRESH from iCloud (GET — current text and ETag), for a write.
 * Tries `<book>/<id>.vcf` directly; a card whose resource is named otherwise
 * is found through the address book listing. An id that names nothing is a
 * NOT_FOUND error.
 */
export async function fetchCard(session: ContactsSession, id: string, deps: ContactsDeps = {}): Promise<CardEntry> {
  const direct = childUrl(session.bookUrl, `${id}.vcf`);
  try {
    return await getEntry(session, direct);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  const { book } = await loadBook(deps);
  const listed = findInBook(book, id);
  if (!listed || sameResource(listed.url, direct)) throw contactNotFound(id);
  try {
    return await getEntry(session, listed.url);
  } catch (err) {
    if (isNotFound(err)) throw contactNotFound(id);
    throw err;
  }
}

/**
 * GET a card again after a write, to verify it. Resolves undefined when it is
 * not (yet) there, so the caller can say "not yet visible" rather than failed.
 */
export async function reread(session: ContactsSession, url: string): Promise<CardEntry | undefined> {
  try {
    return await getEntry(session, url);
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}
