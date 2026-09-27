import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getDisplayTimeZone, isValidTimeZone } from '../config.js';
import { VCARD_CONTENT_TYPE, childUrl } from '../dav/client.js';
import { InvalidArgumentError, UnconfirmedWriteError, errorMessage } from '../errors.js';
import { formatDateOnly, parseDateInput, putInstant } from '../time.js';
import { CONFIRM_NOTE, confirmTokenParam, confirmWrite, stateRevision } from '../tools/_confirm.js';
import { ANNOTATIONS, compactObject, defineTool, jsonResponse, limitParam, offsetParam, pageInfo, pagedResponse } from '../tools/_shared.js';
import {
  contactNotFound,
  fetchCard,
  findInBook,
  invalidateBook,
  loadBook,
  normalizeId,
  openSession,
  reread,
  type Book,
  type CardEntry,
  type ContactsDeps,
  type ContactsSession,
} from './book.js';
import {
  addressComponents,
  applyAddressChange,
  applyScalars,
  applyValueChange,
  buildNewCard,
  digitsOf,
  setRev,
  type AddressChange,
  type ChangeOutcome,
  type NewContact,
  type ScalarEdits,
  type ValueChange,
} from './edit.js';
import { addressEntries, formatMonthDay, readContact, validMonthDay, valueEntries, type ContactView, type ValueKind } from './model.js';
import { VCard } from './vcard.js';

export type { ContactsDeps } from './book.js';

/**
 * iCloud Contacts over CardDAV: search, read, list groups, create, edit and
 * delete contacts. Reads search a per-process copy of the whole address book
 * that is re-validated against iCloud's collection version (ctag) on every
 * call; writes edit the card's raw vCard lines so everything the edit does not
 * touch is kept byte-for-byte.
 */

// ---------------------------------------------------------------------------
// Schema pieces
// ---------------------------------------------------------------------------

/** One line of text: no control characters at all. */
const SINGLE_LINE = /^[^\u0000-\u001f\u007f]*$/;
/** Text that may span lines (note, street): tab and line breaks allowed. */
const MULTI_LINE = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;
/** An email / phone / URL value: one line, and no backslash (it would read back as an escape). */
const PLAIN_VALUE = /^[^\u0000-\u001f\u007f\\]*$/;
const CONTROL_MSG = 'must not contain control characters';

const contactIdParam = z
  .string()
  .min(1)
  .max(255)
  .regex(/^(?!\.{1,2}$)[^/\\\u0000-\u001f\u007f]+$/, 'must be a contact id from apple_contacts_search')
  .describe('The contact id from apple_contacts_search or apple_contacts_create.');

function textParam(max: number, description: string, opts: { multiline?: boolean; min: number }) {
  return z
    .string()
    .min(opts.min)
    .max(max)
    .regex(opts.multiline ? MULTI_LINE : SINGLE_LINE, CONTROL_MSG)
    .optional()
    .describe(description);
}

const LABEL_DESC =
  'Label: home, work, other or any custom text (phones also mobile, iPhone, main, home fax, work fax, pager; URLs also homepage).';

const labelParam = (extra = '') => z.string().max(64).regex(SINGLE_LINE, CONTROL_MSG).optional().describe(LABEL_DESC + extra);

const entryIdParam = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9_~-]+$/, 'must be an entryId from apple_contacts_get')
  .optional()
  .describe('remove/replace: the entry\'s entryId from apple_contacts_get (preferred over target).');

const actionParam = z
  .enum(['add', 'remove', 'replace'])
  .describe('add a new entry; remove an entry; replace an entry\'s value and/or label.');

const VALUE_LIMITS: Readonly<Record<ValueKind, number>> = { email: 254, phone: 64, url: 2048 };
const VALUE_NOUN: Readonly<Record<ValueKind, string>> = { email: 'email address', phone: 'phone number', url: 'URL' };

function valueParam(kind: ValueKind, description: string) {
  return z.string().min(1).max(VALUE_LIMITS[kind]).regex(PLAIN_VALUE, `${CONTROL_MSG} or backslashes`).describe(description);
}

function valueChangeSchema(kind: ValueKind, targetRule: string) {
  return z.strictObject({
    action: actionParam,
    value: valueParam(kind, `add/replace: the ${VALUE_NOUN[kind]}.`).optional(),
    label: labelParam(' On replace, "" removes the label.'),
    target: z
      .string()
      .min(1)
      .max(VALUE_LIMITS[kind])
      .optional()
      .describe(`remove/replace: the entry's current value (${targetRule}). Use entryId instead when you have it.`),
    entryId: entryIdParam,
  });
}

const addressFields = (min: number) => ({
  street: textParam(500, 'Street (a line break separates street lines).', { multiline: true, min }),
  city: textParam(200, 'City.', { min }),
  state: textParam(200, 'State, province or region.', { min }),
  postalCode: textParam(50, 'Postal / ZIP code.', { min }),
  country: textParam(200, 'Country.', { min }),
});

const addressChangeSchema = z.strictObject({
  action: actionParam,
  ...addressFields(0),
  label: labelParam(' On replace, "" removes the label.'),
  target: z
    .string()
    .min(1)
    .max(1000)
    .optional()
    .describe('remove/replace: the address\'s street, or its one-line "formatted" form from apple_contacts_get (case-insensitive).'),
  entryId: entryIdParam,
});

const newValueSchema = (kind: ValueKind) =>
  z.strictObject({ value: valueParam(kind, `The ${VALUE_NOUN[kind]}.`), label: labelParam() });

const newAddressSchema = z.strictObject({ ...addressFields(1), label: labelParam() });

const BIRTHDAY_DESC = 'Birthday as YYYY-MM-DD, or --MM-DD when the year is unknown.';

function scalarFields(min: number) {
  const clear = min === 0 ? ' An empty string clears it.' : '';
  return {
    givenName: textParam(200, `First (given) name.${clear}`, { min }),
    familyName: textParam(200, `Last (family) name.${clear}`, { min }),
    middleName: textParam(200, `Middle name.${clear}`, { min }),
    nickname: textParam(200, `Nickname.${clear}`, { min }),
    organization: textParam(200, `Company or organization.${clear}`, { min }),
    department: textParam(200, `Department within the organization.${clear}`, { min }),
    jobTitle: textParam(200, `Job title.${clear}`, { min }),
    note: textParam(10_000, `Free-text note (may span lines).${clear}`, { multiline: true, min }),
    birthday: z
      .string()
      .regex(min === 0 ? /^(|\d{4}-\d{2}-\d{2}|--\d{2}-\d{2})$/ : /^(\d{4}-\d{2}-\d{2}|--\d{2}-\d{2})$/, 'must be YYYY-MM-DD or --MM-DD')
      .optional()
      .describe(`${BIRTHDAY_DESC}${clear}`),
  };
}

const timeZoneParam = z
  .string()
  .min(1)
  .max(64)
  .optional()
  .describe('IANA time zone for lastModified (default: DISPLAY_TZ).');

const CREDS = 'Requires ICLOUD_USERNAME + ICLOUD_APP_PASSWORD (an app-specific password).';

export const SEARCH_LIMIT_DEFAULT = 25;
export const SEARCH_LIMIT_MAX = 200;
const MAX_NEW_ENTRIES = 20;
const MAX_CHANGES = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveZone(tz: string | undefined): string {
  if (tz === undefined) return getDisplayTimeZone();
  if (!isValidTimeZone(tz)) {
    throw new InvalidArgumentError(`timeZone "${tz}" is not a known IANA time zone.`, 'Use a zone like America/New_York or Europe/London.');
  }
  return tz;
}

/** Fold case and accents: `José` matches `jose`. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const PHONE_QUERY = /^[\d\s()+\-.]+$/;

/**
 * Whether a contact matches a search: every word of the query appears in one
 * of its names, nickname, organization, department, job title or emails; or,
 * for a query that looks like a phone number (3+ digits), one of its phone
 * numbers contains those digits.
 */
export function matchesQuery(v: ContactView, query: string): boolean {
  const q = fold(query.trim());
  if (q === '') return true;
  const fields = [v.name, v.givenName, v.middleName, v.familyName, v.nickname, v.organization, v.department, v.jobTitle, ...v.emails.map((e) => e.value)]
    .filter((f): f is string => f !== undefined)
    .map(fold);
  if (q.split(/\s+/).every((t) => fields.some((f) => f.includes(t)))) return true;
  const digits = digitsOf(query);
  return PHONE_QUERY.test(query.trim()) && digits.length >= 3 && v.phones.some((p) => digitsOf(p.value).includes(digits));
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** By display name, then id (ids are unique within a book, so this is a total order). */
function byName(a: CardEntry, b: CardEntry): number {
  return collator.compare(a.view.name, b.view.name) || (a.id < b.id ? -1 : 1);
}

function memberKey(e: CardEntry): string {
  return (e.view.uid ?? e.id).toLowerCase();
}

function groupNamesOf(book: Book, entry: CardEntry): string[] {
  const key = memberKey(entry);
  return book.groups
    .filter((g) => g.view.members.includes(key))
    .map((g) => g.view.name)
    .sort(collator.compare);
}

/** What a read from `book` must admit about the book itself: unreadable cards, a truncated listing. */
function bookWarnings(book: Book): Record<string, unknown> {
  const warnings: string[] = [];
  if (book.truncated) {
    warnings.push(
      'iCloud returned only part of the address book (it marked its answer as truncated), so contacts and groups may be missing from this result.',
    );
  }
  if (book.unreadable > 0) warnings.push(`${book.unreadable} card(s) in the address book could not be read and are not included.`);
  return warnings.length > 0 ? { warnings } : {};
}

/** The contacts of `book` that belong to any of `groups` (by UID, or by id for a card without one). */
function membersOf(book: Book, groups: readonly CardEntry[]): CardEntry[] {
  const members = new Set(groups.flatMap((g) => g.view.members));
  return book.contacts.filter((c) => members.has(memberKey(c)));
}

function summaryRow(e: CardEntry): Record<string, unknown> {
  const v = e.view;
  return compactObject({
    id: e.id,
    name: v.name,
    organization: v.organization,
    jobTitle: v.jobTitle,
    emails: v.emails.map((x) => compactObject({ value: x.value, label: x.label })),
    phones: v.phones.map((x) => compactObject({ value: x.value, label: x.label })),
  });
}

/** The full record of one contact, as `apple_contacts_get` and the write tools return it. */
export function contactDetail(entry: CardEntry, zone: string, groups?: string[]): Record<string, unknown> {
  const v = entry.view;
  const out: Record<string, unknown> = compactObject({
    id: entry.id,
    name: v.name,
    givenName: v.givenName,
    middleName: v.middleName,
    familyName: v.familyName,
    namePrefix: v.namePrefix,
    nameSuffix: v.nameSuffix,
    nickname: v.nickname,
    organization: v.organization,
    department: v.department,
    jobTitle: v.jobTitle,
    isCompany: v.isCompany,
  });
  if (v.birthday !== undefined) {
    out.birthday = v.birthday;
    out.birthdayDisplay = v.birthday.startsWith('--') ? formatMonthDay(v.birthday) : formatDateOnly(v.birthday);
  }
  out.emails = v.emails;
  out.phones = v.phones;
  out.addresses = v.addresses;
  out.urls = v.urls;
  if (v.note !== undefined) out.note = v.note;
  if (groups !== undefined) out.groups = groups;
  out.hasPhoto = v.hasPhoto;
  putInstant(out, 'lastModified', v.lastModified, zone);
  if (v.uid !== undefined) out.uid = v.uid;
  return out;
}

function refuseGroup(entry: CardEntry): void {
  if (entry.view.kind === 'group') {
    throw new InvalidArgumentError(
      `"${entry.id}" is the contact group "${entry.view.name}", not a contact.`,
      `List its members with apple_contacts_search and group: "${entry.view.name}".`,
    );
  }
}

function validateBirthday(value: string | undefined): void {
  if (value === undefined || value === '') return;
  if (value.startsWith('--')) {
    const [m, d] = value.slice(2).split('-').map(Number) as [number, number];
    if (!validMonthDay(m, d)) throw new InvalidArgumentError(`birthday "${value}" is not a valid month and day.`);
    return;
  }
  parseDateInput(value, 'birthday', 'UTC');
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

function validateValue(kind: ValueKind, value: string, where: string): void {
  const v = value.trim();
  if (kind === 'email' && !EMAIL_SHAPE.test(v)) throw new InvalidArgumentError(`${where}: "${value}" is not an email address.`);
  if (kind === 'phone' && !/\d/.test(v)) throw new InvalidArgumentError(`${where}: "${value}" has no digits, so it is not a phone number.`);
  if (kind === 'url' && (v === '' || /\s/.test(v))) throw new InvalidArgumentError(`${where}: "${value}" is not a URL (no spaces allowed).`);
}

function validateTargeting(where: string, c: { action: string; target?: string; entryId?: string }): void {
  const has = (c.target !== undefined ? 1 : 0) + (c.entryId !== undefined ? 1 : 0);
  if (c.action === 'add') {
    if (has > 0) throw new InvalidArgumentError(`${where}: add takes no target or entryId — it creates a new entry.`);
  } else if (has !== 1) {
    throw new InvalidArgumentError(
      `${where}: ${c.action} needs exactly one of entryId (from apple_contacts_get) or target (the entry's current value).`,
    );
  }
}

function validateValueChange(kind: ValueKind, field: string, i: number, c: ValueChange): void {
  const where = `${field}[${i}]`;
  validateTargeting(where, c);
  if (c.action === 'add' && c.value === undefined) throw new InvalidArgumentError(`${where}: add needs a value.`);
  if (c.action === 'remove' && (c.value !== undefined || c.label !== undefined)) {
    throw new InvalidArgumentError(`${where}: remove takes only entryId or target (no value or label).`);
  }
  if (c.action === 'replace' && c.value === undefined && c.label === undefined) {
    throw new InvalidArgumentError(`${where}: replace needs a new value, a new label, or both.`);
  }
  if (c.value !== undefined) validateValue(kind, c.value, where);
}

function validateAddressChange(i: number, c: AddressChange): void {
  const where = `addresses[${i}]`;
  validateTargeting(where, c);
  const comps = addressComponents(c);
  if (c.action === 'add' && !comps.some(([, v]) => v.trim() !== '')) {
    throw new InvalidArgumentError(`${where}: add needs at least one of street, city, state, postalCode or country.`);
  }
  if (c.action === 'remove' && (comps.length > 0 || c.label !== undefined)) {
    throw new InvalidArgumentError(`${where}: remove takes only entryId or target (no address fields or label).`);
  }
  if (c.action === 'replace' && comps.length === 0 && c.label === undefined) {
    throw new InvalidArgumentError(`${where}: replace needs at least one address field or a label.`);
  }
}

const VALUE_FIELDS: ReadonlyArray<[ValueKind, 'emails' | 'phones' | 'urls']> = [
  ['email', 'emails'],
  ['phone', 'phones'],
  ['url', 'urls'],
];

const SCALAR_KEYS = ['givenName', 'familyName', 'middleName', 'nickname', 'organization', 'department', 'jobTitle', 'note', 'birthday'] as const;

function pickScalars(args: Record<string, unknown>): ScalarEdits {
  const out: ScalarEdits = {};
  for (const k of SCALAR_KEYS) if (typeof args[k] === 'string') out[k] = args[k] as string;
  return out;
}

/** Fields compared after a write, and how each is compared. */
type Comparable = 'name' | (typeof SCALAR_KEYS)[number] | 'emails' | 'phones' | 'urls' | 'addresses';

function comparableValue(v: ContactView, field: Comparable): unknown {
  switch (field) {
    case 'emails':
    case 'phones':
    case 'urls':
      return v[field].map((e) => `${e.value.toLowerCase()}|${e.label ?? ''}`).sort();
    case 'addresses':
      return v.addresses.map((e) => `${e.formatted.toLowerCase()}|${e.label ?? ''}`).sort();
    default:
      return v[field];
  }
}

/** Warnings for every field whose re-read value differs from what was written. */
function verifyFields(expected: ContactView, stored: ContactView, fields: readonly Comparable[]): string[] {
  const out: string[] = [];
  for (const f of new Set(fields)) {
    const want = comparableValue(expected, f);
    const got = comparableValue(stored, f);
    if (JSON.stringify(want) !== JSON.stringify(got)) {
      out.push(`After re-reading, ${f} is not what was written: expected ${JSON.stringify(want ?? null)}, iCloud has ${JSON.stringify(got ?? null)}.`);
    }
  }
  return out;
}

async function verifyWrite(
  session: ContactsSession,
  url: string,
  expected: ContactView,
  fields: readonly Comparable[],
  warnings: string[],
): Promise<{ verified: boolean; stored?: CardEntry }> {
  let stored: CardEntry | undefined;
  try {
    stored = await reread(session, url);
  } catch (err) {
    warnings.push(`The change was accepted, but re-reading the contact to verify it failed: ${errorMessage(err)}`);
    return { verified: false };
  }
  if (!stored) {
    warnings.push('iCloud accepted the change, but the contact is not visible yet (iCloud can lag). Check again with apple_contacts_get.');
    return { verified: false };
  }
  const diffs = verifyFields(expected, stored.view, fields);
  warnings.push(...diffs);
  return { verified: diffs.length === 0, stored };
}

function optionalWarnings(warnings: string[]): Record<string, unknown> {
  return warnings.length > 0 ? { warnings } : {};
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerContactsTools(server: McpServer, deps: ContactsDeps = {}): void {
  const newUid = deps.newUid ?? (() => randomUUID().toUpperCase());
  const now = deps.now ?? (() => new Date());

  defineTool(server, {
    name: 'apple_contacts_search',
    service: 'contacts',
    access: 'read',
    title: 'Search iCloud Contacts',
    description:
      'Search the user\'s iCloud Contacts (address book) by name, nickname, company, job title, email, or phone number ' +
      'digits — optionally only within one contact group. Omit query to list everyone. Returns the total number of matches ' +
      'and a page of rows sorted by name: id, name, organization, job title, emails and phones with labels. Use ' +
      `apple_contacts_get with an id for addresses, birthday, note and entryIds. ${CREDS}`,
    inputSchema: z.strictObject({
      query: z
        .string()
        .max(200)
        .regex(SINGLE_LINE, CONTROL_MSG)
        .optional()
        .describe('Text to find (case- and accent-insensitive; every word must match). Omit or "" to list all contacts.'),
      group: z
        .string()
        .min(1)
        .max(200)
        .regex(SINGLE_LINE, CONTROL_MSG)
        .optional()
        .describe('Only contacts in this group (its name, as apple_contacts_list_groups shows it).'),
      limit: limitParam(SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX),
      offset: offsetParam,
    }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const limit = args.limit ?? SEARCH_LIMIT_DEFAULT;
      const offset = args.offset ?? 0;
      const query = args.query ?? '';
      const { book } = await loadBook(deps);
      let pool = book.contacts;
      if (args.group !== undefined) {
        const wanted = fold(args.group.trim());
        const groups = book.groups.filter((g) => fold(g.view.name) === wanted);
        if (groups.length === 0) {
          const names = book.groups.map((g) => g.view.name).sort(collator.compare);
          const listed = names.length ? `Groups: ${names.join(', ')}.` : 'The address book has no groups.';
          throw new InvalidArgumentError(
            book.truncated
              ? `No contact group named "${args.group}" was listed, but iCloud returned only part of the address book, so it may exist. ${listed}`
              : `There is no contact group named "${args.group}". ${listed}`,
            'List groups with apple_contacts_list_groups.',
          );
        }
        pool = membersOf(book, groups);
      }
      const matched = pool.filter((c) => matchesQuery(c.view, query)).sort(byName);
      const total = matched.length;
      if (total > 0 && offset >= total) {
        throw new InvalidArgumentError(
          `offset ${offset} is past the end of the results: ${total} contact(s) matched (valid offsets 0–${total - 1}).`,
        );
      }
      const page = matched.slice(offset, offset + limit);
      const scope =
        args.group !== undefined
          ? `the ${pool.length} contact(s) in the group "${args.group}"`
          : `all ${book.contacts.length} contact(s) in the iCloud address book`;
      let note: string | undefined;
      if (total === 0) {
        if (query.trim() !== '') {
          note = `No contact matched "${query}" (searched ${scope} by name, nickname, organization, department, job title, email and phone digits).`;
        } else {
          note = args.group !== undefined ? `The group "${args.group}" has no contacts.` : 'The iCloud address book has no contacts.';
        }
      }
      const extra: Record<string, unknown> = {
        ...(query.trim() !== '' ? { query } : {}),
        ...(args.group !== undefined ? { group: args.group } : {}),
        searched: scope,
        ...(note !== undefined ? { note } : {}),
        ...bookWarnings(book),
      };
      return jsonResponse(pagedResponse(pageInfo({ offset, limit, returned: page.length, total }), 'contacts', page.map(summaryRow), extra));
    },
  });

  defineTool(server, {
    name: 'apple_contacts_get',
    service: 'contacts',
    access: 'read',
    title: 'Get an iCloud contact',
    description:
      'Get one iCloud contact in full by id (from apple_contacts_search): names, organization, job title, emails, phones, ' +
      'postal addresses and URLs — each with its label and an entryId that apple_contacts_update can target — birthday, ' +
      `note, the contact groups it belongs to, whether it has a photo, and when it was last modified. ${CREDS}`,
    inputSchema: z.strictObject({ contactId: contactIdParam, timeZone: timeZoneParam }),
    annotations: ANNOTATIONS.read,
    handler: async (args) => {
      const zone = resolveZone(args.timeZone);
      const id = normalizeId(args.contactId);
      const { session, book } = await loadBook(deps);
      let entry = findInBook(book, id);
      // A truncated listing is not proof of absence: ask for the card itself.
      if (!entry && book.truncated) entry = await reread(session, childUrl(session.bookUrl, `${id}.vcf`));
      if (!entry) throw contactNotFound(id);
      refuseGroup(entry);
      return jsonResponse({ ...contactDetail(entry, zone, groupNamesOf(book, entry)), ...bookWarnings(book) });
    },
  });

  defineTool(server, {
    name: 'apple_contacts_list_groups',
    service: 'contacts',
    access: 'read',
    title: 'List iCloud contact groups',
    description:
      'List the contact groups in iCloud Contacts (e.g. Family, Work): each group\'s id, name and member count. Pass a ' +
      `group name to apple_contacts_search to list its members. ${CREDS}`,
    inputSchema: z.strictObject({}),
    annotations: ANNOTATIONS.read,
    handler: async () => {
      const { book } = await loadBook(deps);
      const groups = [...book.groups]
        .sort(byName)
        // Counted the way apple_contacts_search's group filter counts: member
        // lines naming a card that is not in the book (a deleted contact) do
        // not count, so the two tools agree.
        .map((g) => ({ id: g.id, name: g.view.name, memberCount: membersOf(book, [g]).length }));
      return jsonResponse({
        returned: groups.length,
        total: groups.length,
        ...(groups.length === 0 ? { note: 'The iCloud address book has no contact groups.' } : {}),
        ...bookWarnings(book),
        groups,
      });
    },
  });

  defineTool(server, {
    name: 'apple_contacts_create',
    service: 'contacts',
    access: 'additive',
    title: 'Create an iCloud contact',
    description:
      'Create a new contact in iCloud Contacts. Needs a givenName, familyName or organization; optional middleName, ' +
      'nickname, department, jobTitle, note, birthday (YYYY-MM-DD, or --MM-DD without a year), and lists of emails, phones, ' +
      'urls and postal addresses, each with an optional label (home, work, mobile, other or custom text). Returns the new ' +
      `contact's id and details as re-read from iCloud (verified). ${CREDS} Available when APPLE_WRITE_MODE is additive or all.`,
    inputSchema: z.strictObject({
      ...scalarFields(1),
      emails: z.array(newValueSchema('email')).min(1).max(MAX_NEW_ENTRIES).optional().describe('Email addresses.'),
      phones: z.array(newValueSchema('phone')).min(1).max(MAX_NEW_ENTRIES).optional().describe('Phone numbers.'),
      urls: z.array(newValueSchema('url')).min(1).max(MAX_NEW_ENTRIES).optional().describe('Web addresses.'),
      addresses: z.array(newAddressSchema).min(1).max(MAX_NEW_ENTRIES).optional().describe('Postal addresses.'),
    }),
    annotations: ANNOTATIONS.additive,
    handler: async (args) => {
      if (![args.givenName, args.familyName, args.organization].some((v) => (v ?? '').trim() !== '')) {
        throw new InvalidArgumentError('A contact needs at least a givenName, a familyName or an organization.');
      }
      validateBirthday(args.birthday);
      for (const [kind, field] of VALUE_FIELDS) {
        (args[field] ?? []).forEach((e, i) => validateValue(kind, e.value, `${field}[${i}]`));
      }
      (args.addresses ?? []).forEach((a, i) => {
        if (!addressComponents(a).some(([, v]) => v.trim() !== '')) {
          throw new InvalidArgumentError(`addresses[${i}]: an address needs at least one of street, city, state, postalCode or country.`);
        }
      });
      const input: NewContact = args;
      const session = await openSession(deps);
      const uid = newUid();
      const { card, skipped } = buildNewCard(input, uid, now());
      const url = childUrl(session.bookUrl, `${uid}.vcf`);
      try {
        await session.client.put(url, card.toString(), VCARD_CONTENT_TYPE, { ifNoneMatch: '*' });
      } catch (err) {
        if (err instanceof UnconfirmedWriteError) {
          invalidateBook(session.bookUrl);
          throw new UnconfirmedWriteError(
            'contacts',
            `${err.message} Check with apple_contacts_get (contactId "${uid}") before creating it again — a retry could make a duplicate.`,
            err,
          );
        }
        throw err;
      }
      invalidateBook(session.bookUrl);
      const warnings = skipped.map((s) => `${s.field}[${s.index}] was not added: ${s.reason}.`);
      const expected = readContact(card);
      const fields: Comparable[] = ['name', ...SCALAR_KEYS.filter((k) => args[k] !== undefined), ...VALUE_FIELDS.map(([, f]) => f), 'addresses'];
      const { verified, stored } = await verifyWrite(session, url, expected, fields, warnings);
      const shown: CardEntry = stored ?? { id: uid, url, raw: card.toString(), card, view: expected };
      return jsonResponse({
        created: true,
        id: uid,
        verified,
        ...optionalWarnings(warnings),
        contact: contactDetail(shown, getDisplayTimeZone()),
      });
    },
  });

  defineTool(server, {
    name: 'apple_contacts_update',
    service: 'contacts',
    access: 'all',
    title: 'Edit an iCloud contact',
    description:
      'Edit an existing iCloud contact in place. Scalar fields (givenName, familyName, middleName, nickname, organization, ' +
      'department, jobTitle, note, birthday) replace the current value; "" clears it. emails/phones/urls/addresses take ' +
      'change objects {action: add|remove|replace} aimed at one entry by entryId (from apple_contacts_get) or current ' +
      'value; an absent target is a reported no-op listing what is there. The rest of the card is kept byte-for-byte. ' +
      `Returns before/after, re-read to verify. ${CREDS} Needs APPLE_WRITE_MODE=all.`,
    inputSchema: z.strictObject({
      contactId: contactIdParam,
      ...scalarFields(0),
      emails: z
        .array(valueChangeSchema('email', 'case-insensitive'))
        .min(1)
        .max(MAX_CHANGES)
        .optional()
        .describe('Changes to email addresses, applied in order.'),
      phones: z
        .array(valueChangeSchema('phone', 'compared by digits only'))
        .min(1)
        .max(MAX_CHANGES)
        .optional()
        .describe('Changes to phone numbers, applied in order.'),
      urls: z
        .array(valueChangeSchema('url', 'case-insensitive'))
        .min(1)
        .max(MAX_CHANGES)
        .optional()
        .describe('Changes to web addresses, applied in order.'),
      addresses: z
        .array(addressChangeSchema)
        .min(1)
        .max(MAX_CHANGES)
        .optional()
        .describe('Changes to postal addresses, applied in order. replace merges the given fields; "" clears one.'),
    }),
    annotations: ANNOTATIONS.update,
    handler: async (args) => {
      const scalars = pickScalars(args);
      const hasChanges = VALUE_FIELDS.some(([, f]) => args[f] !== undefined) || args.addresses !== undefined;
      if (Object.keys(scalars).length === 0 && !hasChanges) {
        throw new InvalidArgumentError('Nothing to update: pass at least one field or change.');
      }
      validateBirthday(scalars.birthday);
      for (const [kind, field] of VALUE_FIELDS) {
        (args[field] ?? []).forEach((c, i) => validateValueChange(kind, field, i, c));
      }
      (args.addresses ?? []).forEach((c, i) => validateAddressChange(i, c));

      const session = await openSession(deps);
      const current = await fetchCard(session, normalizeId(args.contactId), deps);
      refuseGroup(current);
      // The card's own id (the argument may have differed in case or carried `.vcf`).
      const { id } = current;
      const card = VCard.parse(current.raw) as VCard;
      // entryIds name entries of the card as the caller read it; resolve them
      // against that, not against the card as earlier changes left it.
      const initialAddresses = addressEntries(card);
      const initialValues = new Map(VALUE_FIELDS.map(([kind]) => [kind, valueEntries(card, kind)] as const));
      applyScalars(card, scalars);
      const outcomes: ChangeOutcome[] = [];
      for (const [kind, field] of VALUE_FIELDS) {
        (args[field] ?? []).forEach((c, i) => outcomes.push(applyValueChange(card, kind, c, i, initialValues.get(kind))));
      }
      (args.addresses ?? []).forEach((c, i) => outcomes.push(applyAddressChange(card, c, i, initialAddresses)));

      const before = current.view;
      const after = readContact(card);
      const scalarFieldsChanged = (['name', ...SCALAR_KEYS] as const).filter((f) => before[f] !== after[f]);
      const scalarChanges = scalarFieldsChanged.map((f) => compactObject({ field: f, before: before[f], after: after[f] }));
      const applied = outcomes.filter((o) => o.status === 'applied');
      const noops = outcomes.filter((o) => o.status === 'no-op');
      const zone = getDisplayTimeZone();
      if (scalarChanges.length === 0 && applied.length === 0) {
        return jsonResponse({
          updated: false,
          id,
          note: 'Nothing was written: every requested value was already in place, or its target was not found.',
          changes: [],
          ...(noops.length ? { noops } : {}),
          contact: contactDetail(current, zone),
        });
      }
      setRev(card, now());
      const warnings: string[] = [];
      if (current.etag === undefined) {
        warnings.push('iCloud sent no ETag for this contact, so the update could not be made conditional on it being unchanged.');
      }
      await session.client.put(current.url, card.toString(), VCARD_CONTENT_TYPE, current.etag !== undefined ? { ifMatch: current.etag } : {});
      invalidateBook(session.bookUrl);
      const fields: Comparable[] = [...scalarFieldsChanged, ...applied.map((o) => o.field)];
      const { verified, stored } = await verifyWrite(session, current.url, after, fields, warnings);
      const shown: CardEntry = stored ?? { ...current, raw: card.toString(), card, view: after };
      return jsonResponse({
        updated: true,
        id,
        verified,
        changes: [...scalarChanges, ...applied],
        ...(noops.length ? { noops } : {}),
        ...optionalWarnings(warnings),
        contact: contactDetail(shown, zone),
      });
    },
  });

  defineTool(server, {
    name: 'apple_contacts_delete',
    service: 'contacts',
    access: 'all',
    title: 'Delete an iCloud contact',
    description:
      'Permanently delete one contact from iCloud Contacts (on every device) by id. The preview shows its name, ' +
      `organization, emails and phones. ${CREDS} Needs APPLE_WRITE_MODE=all. ${CONFIRM_NOTE}`,
    inputSchema: z.strictObject({ contactId: contactIdParam, confirmToken: confirmTokenParam }),
    annotations: ANNOTATIONS.remove,
    handler: async (args, ctx) => {
      const session = await openSession(deps);
      const current = await fetchCard(session, normalizeId(args.contactId), deps);
      refuseGroup(current);
      const { id, view: v } = current;
      const preview = compactObject({
        Contact: v.name,
        Organization: v.organization,
        'Job title': v.jobTitle,
        Emails: v.emails.length ? v.emails.map((e) => e.value).join(', ') : undefined,
        Phones: v.phones.length ? v.phones.map((p) => p.value).join(', ') : undefined,
        Addresses: v.addresses.length ? v.addresses.map((a) => a.formatted).join(' | ') : undefined,
        'Contact id': id,
      });
      const gate = await confirmWrite(ctx, {
        tool: 'apple_contacts_delete',
        action: 'apple.contacts.contact.delete',
        message: `Permanently delete the contact "${v.name}" from iCloud Contacts on all devices? This cannot be undone here.`,
        target: `contact:${id}`,
        revision: current.etag ?? stateRevision(current.raw),
        payload: { contactId: id },
        preview,
        args,
        confirmToken: args.confirmToken,
      });
      if (gate) return gate;
      await session.client.delete(current.url, current.etag !== undefined ? { ifMatch: current.etag } : {});
      invalidateBook(session.bookUrl);
      const warnings: string[] = [];
      let verified = false;
      try {
        const still = await reread(session, current.url);
        verified = still === undefined;
        if (still) warnings.push('iCloud accepted the delete but still returns the contact; it may take a moment to disappear.');
      } catch (err) {
        warnings.push(`The delete was accepted, but checking that the contact is gone failed: ${errorMessage(err)}`);
      }
      return jsonResponse({ deleted: true, id, name: v.name, verified, ...optionalWarnings(warnings) });
    },
  });
}
