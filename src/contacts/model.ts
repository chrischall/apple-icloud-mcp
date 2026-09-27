import { createHash } from 'node:crypto';
import { VCard, VLine, splitUnescaped, unescapeText } from './vcard.js';

/**
 * What a vCard SAYS, read into plain values: names, organization, labelled
 * emails/phones/URLs/addresses (each with a stable `entryId`), birthday,
 * note, group membership. Read-only — edits live in edit.ts and work on the
 * raw lines.
 */

export type ValueKind = 'email' | 'phone' | 'url';
export type EntryKind = ValueKind | 'address';

/** The vCard property behind each kind of entry. */
export const ENTRY_PROPERTY: Readonly<Record<EntryKind, string>> = { email: 'EMAIL', phone: 'TEL', url: 'URL', address: 'ADR' };
/** The tool-argument / response field for each kind. */
export const ENTRY_FIELD: Readonly<Record<EntryKind, 'emails' | 'phones' | 'urls' | 'addresses'>> = {
  email: 'emails',
  phone: 'phones',
  url: 'urls',
  address: 'addresses',
};

interface EntryBase {
  /** Stable handle for update: a short hash of property + group + raw value. */
  entryId: string;
  label?: string;
  preferred?: true;
}

export interface ValueEntry extends EntryBase {
  value: string;
}

/** The address components this server reads and writes (ADR: pobox;ext;street;city;region;postal;country). */
export interface AddressParts {
  poBox?: string;
  extended?: string;
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface AddressEntry extends EntryBase, AddressParts {
  /** One line: `street, city, state postalCode, country` (street line breaks become commas). */
  formatted: string;
}

export interface Located<E> {
  line: VLine;
  entry: E;
}

/** Everything the tools present about one card. Optional fields are absent when the card has none. */
export interface ContactView {
  kind: 'contact' | 'group';
  /** The UID (without a `urn:uuid:` prefix), which group memberships reference. */
  uid?: string;
  /** The name to show: FN, else composed from N, else organization, email or phone. */
  name: string;
  givenName?: string;
  familyName?: string;
  middleName?: string;
  namePrefix?: string;
  nameSuffix?: string;
  nickname?: string;
  organization?: string;
  department?: string;
  jobTitle?: string;
  /** Apple's "show as company" flag (X-ABShowAs:COMPANY). */
  isCompany?: true;
  /** `YYYY-MM-DD`, or `--MM-DD` when the year is not known. */
  birthday?: string;
  emails: ValueEntry[];
  phones: ValueEntry[];
  urls: ValueEntry[];
  addresses: AddressEntry[];
  note?: string;
  hasPhoto: boolean;
  /** REV, when it carries a zone designator (Z or an offset). */
  lastModified?: Date;
  /** For a group card: the UIDs of its members (lower-cased). */
  members: string[];
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Apple's built-in labels, as written in `itemN.X-ABLabel:_$!<Name>!$_`. */
const WRAPPED_TO_LABEL: Readonly<Record<string, string>> = {
  home: 'home',
  work: 'work',
  other: 'other',
  mobile: 'mobile',
  main: 'main',
  homefax: 'home fax',
  workfax: 'work fax',
  otherfax: 'other fax',
  pager: 'pager',
  homepage: 'homepage',
  school: 'school',
  iphone: 'iPhone',
};

/** `_$!<Mobile>!$_` → `mobile`; a custom label is returned as written. */
export function decodeAbLabel(value: string): string {
  const m = /^_\$!<(.*)>!\$_$/.exec(value);
  if (!m) return value;
  const inner = m[1] as string;
  return WRAPPED_TO_LABEL[inner.toLowerCase()] ?? inner.toLowerCase();
}

/** TYPE values that say nothing about the label. */
const NON_LABEL_TYPES = new Set(['INTERNET', 'PREF', 'VOICE', 'X400']);

/** The label a line's TYPE parameters express (`TEL;type=CELL;type=VOICE` → `mobile`). */
export function labelFromTypes(kind: EntryKind, types: readonly string[]): string | undefined {
  const t = new Set(types);
  if (kind === 'phone') {
    if (t.has('IPHONE')) return 'iPhone';
    if (t.has('FAX')) return t.has('HOME') ? 'home fax' : t.has('WORK') ? 'work fax' : 'fax';
    if (t.has('CELL')) return 'mobile';
    if (t.has('MAIN')) return 'main';
    if (t.has('PAGER')) return 'pager';
  }
  if (t.has('HOME')) return 'home';
  if (t.has('WORK')) return 'work';
  if (t.has('OTHER')) return 'other';
  const rest = types.filter((x) => !NON_LABEL_TYPES.has(x));
  return rest.length > 0 ? (rest[0] as string).toLowerCase() : undefined;
}

/** A line's label: its group's X-ABLabel when there is one (Apple's rule), else its TYPEs. */
export function readLabel(card: VCard, line: VLine, kind: EntryKind): string | undefined {
  const ab = card.siblings(line).find((s) => s.name === 'X-ABLABEL');
  if (ab !== undefined) {
    const decoded = decodeAbLabel(unescapeText(ab.value).trim());
    if (decoded !== '') return decoded;
  }
  return labelFromTypes(kind, line.types());
}

function isPreferred(line: VLine): boolean {
  return line.types().includes('PREF') || line.paramValue('PREF') !== undefined;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/** The entryId of a line: property, group and raw value (duplicates get `~2`, `~3`… in card order). */
export function baseEntryId(line: VLine): string {
  return createHash('sha256')
    .update(`${line.name}\u0000${(line.group ?? '').toLowerCase()}\u0000${line.value}`)
    .digest('base64url')
    .slice(0, 10);
}

function withEntryIds<E>(card: VCard, kind: EntryKind, build: (line: VLine, base: EntryBase) => E): Located<E>[] {
  const seen = new Map<string, number>();
  return card.all(ENTRY_PROPERTY[kind]).map((line) => {
    const id = baseEntryId(line);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    const label = readLabel(card, line, kind);
    const base: EntryBase = {
      entryId: n === 1 ? id : `${id}~${n}`,
      ...(label !== undefined ? { label } : {}),
      ...(isPreferred(line) ? { preferred: true as const } : {}),
    };
    return { line, entry: build(line, base) };
  });
}

/** Read the value of an EMAIL / TEL / URL line. */
export function readValue(kind: ValueKind, line: VLine): string {
  const v = unescapeText(line.value).trim();
  return kind === 'phone' ? v.replace(/^tel:/i, '') : v;
}

/** The emails, phones or URLs of a card, in card order. */
export function valueEntries(card: VCard, kind: ValueKind): Located<ValueEntry>[] {
  return withEntryIds(card, kind, (line, base) => ({ ...base, value: readValue(kind, line) }));
}

const ADR_FIELDS = ['poBox', 'extended', 'street', 'city', 'state', 'postalCode', 'country'] as const;

/** An ADR value's seven components, unescaped and trimmed. */
export function readAddressParts(line: VLine): Required<AddressParts> {
  const comps = splitUnescaped(line.value, ';');
  const out = {} as Required<AddressParts>;
  ADR_FIELDS.forEach((f, i) => {
    out[f] = unescapeText(comps[i] ?? '').trim();
  });
  return out;
}

/** `street, city, state postalCode, country` with empty parts dropped. */
export function formatAddress(p: AddressParts): string {
  const street = [p.poBox ? `PO Box ${p.poBox}` : '', p.extended ?? '', ...(p.street ?? '').split(/\n+/)]
    .map((s) => s.trim())
    .filter(Boolean);
  const region = [p.state, p.postalCode].map((s) => (s ?? '').trim()).filter(Boolean).join(' ');
  return [...street, (p.city ?? '').trim(), region, (p.country ?? '').trim()].filter(Boolean).join(', ');
}

/** The postal addresses of a card, in card order. */
export function addressEntries(card: VCard): Located<AddressEntry>[] {
  return withEntryIds(card, 'address', (line, base) => {
    const parts = readAddressParts(line);
    const present: AddressParts = {};
    for (const f of ADR_FIELDS) if (parts[f] !== '') present[f] = parts[f];
    return { ...base, ...present, formatted: formatAddress(parts) };
  });
}

// ---------------------------------------------------------------------------
// Names, birthday, revision
// ---------------------------------------------------------------------------

/** N's five components (family;given;middle;prefix;suffix), unescaped. */
export function readName(card: VCard): { family: string; given: string; middle: string; prefix: string; suffix: string } {
  const n = card.first('N');
  const c = n ? splitUnescaped(n.value, ';').map((s) => unescapeText(s).trim()) : [];
  return { family: c[0] ?? '', given: c[1] ?? '', middle: c[2] ?? '', prefix: c[3] ?? '', suffix: c[4] ?? '' };
}

/** ORG's organization and department, unescaped. */
export function readOrg(card: VCard): { organization: string; department: string } {
  const org = card.first('ORG');
  const c = org ? splitUnescaped(org.value, ';').map((s) => unescapeText(s).trim()) : [];
  return { organization: c[0] ?? '', department: c.slice(1).filter(Boolean).join(', ') };
}

export function isCompanyCard(card: VCard): boolean {
  return (card.first('X-ABSHOWAS')?.value ?? '').trim().toUpperCase() === 'COMPANY';
}

/**
 * The formatted name Apple's clients write: the company for a card shown as
 * a company, else prefix given middle family suffix, else the company.
 * `''` when the card has neither a name nor an organization.
 */
export function composeFormattedName(card: VCard): string {
  const n = readName(card);
  const { organization } = readOrg(card);
  const personal = [n.prefix, n.given, n.middle, n.family, n.suffix].filter(Boolean).join(' ');
  if (isCompanyCard(card) && organization) return organization;
  return personal || organization;
}

/** Month names for a birthday without a year. */
const MONTH_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });

/** `May 12` for `--05-12`. */
export function formatMonthDay(mmdd: string): string {
  const [m, d] = mmdd.replace(/^--/, '').split('-').map(Number) as [number, number];
  return MONTH_DAY.format(new Date(Date.UTC(2000, m - 1, d)));
}

/** Year Apple writes for a birthday whose year is unknown (a leap year, so Feb 29 survives). */
export const OMIT_YEAR = '1604';

/** Whether month/day exist (Feb 29 allowed when `year` is a leap year or unknown). */
export function validMonthDay(month: number, day: number, year?: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const y = year ?? 2000;
  return day <= new Date(Date.UTC(y, month, 0)).getUTCDate();
}

/**
 * BDAY → `YYYY-MM-DD`, or `--MM-DD` when the year is unknown (Apple writes
 * `BDAY;X-APPLE-OMIT-YEAR=1604:1604-05-12`). Accepts basic and extended forms
 * and a trailing time part. Undefined when unreadable.
 */
export function readBirthday(line: VLine): string | undefined {
  const v = unescapeText(line.value).trim();
  const noYear = /^--(\d{2})-?(\d{2})$/.exec(v);
  if (noYear) {
    const [, mo, d] = noYear as unknown as [string, string, string];
    return validMonthDay(Number(mo), Number(d)) ? `--${mo}-${d}` : undefined;
  }
  const full = /^(\d{4})-?(\d{2})-?(\d{2})(?:T.*)?$/.exec(v);
  if (!full) return undefined;
  const [, y, mo, d] = full as unknown as [string, string, string, string];
  const omitted = y === OMIT_YEAR || y === line.paramValue('X-APPLE-OMIT-YEAR');
  if (!validMonthDay(Number(mo), Number(d), omitted ? undefined : Number(y))) return undefined;
  return omitted ? `--${mo}-${d}` : `${y}-${mo}-${d}`;
}

/** REV → Date, only when it names its zone (`Z` or an offset); basic or extended form. */
export function parseRev(value: string): Date | undefined {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):?(\d{2}):?(\d{2})(?:[.,]\d+)?(Z|[+-]\d{2}(?::?\d{2})?)$/i.exec(value.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, zone] = m as unknown as [string, string, string, string, string, string, string, string];
  let off = zone.toUpperCase();
  if (off !== 'Z') {
    const digits = off.slice(1).replace(':', '');
    off = `${off[0]}${digits.slice(0, 2)}:${digits.slice(2) || '00'}`;
  }
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${off}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** `2026-09-27T12:34:56Z` — the REV form this server writes. */
export function formatRev(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

function stripUrn(uid: string): string {
  return uid.replace(/^urn:uuid:/i, '').trim();
}

// ---------------------------------------------------------------------------
// The whole card
// ---------------------------------------------------------------------------

/** Whether a card is an Apple contact GROUP (a separate card listing member UIDs), not a person. */
export function isGroupCard(card: VCard): boolean {
  const kind = (card.first('X-ADDRESSBOOKSERVER-KIND') ?? card.first('KIND'))?.value.trim().toLowerCase();
  return kind === 'group';
}

function text(card: VCard, name: string): string {
  const l = card.first(name);
  return l ? unescapeText(l.value).trim() : '';
}

function opt(value: string): string | undefined {
  return value === '' ? undefined : value;
}

/** Read a card into a `ContactView`. */
export function readContact(card: VCard): ContactView {
  const n = readName(card);
  const { organization, department } = readOrg(card);
  const nickname = card
    .all('NICKNAME')
    .flatMap((l) => splitUnescaped(l.value, ',').map((s) => unescapeText(s).trim()))
    .filter(Boolean)
    .join(', ');
  const emails = valueEntries(card, 'email').map((e) => e.entry);
  const phones = valueEntries(card, 'phone').map((e) => e.entry);
  const fn = text(card, 'FN');
  const company = isCompanyCard(card);
  const personal = [n.prefix, n.given, n.middle, n.family, n.suffix].filter(Boolean).join(' ');
  const name =
    (company && organization) ||
    fn ||
    personal ||
    organization ||
    nickname ||
    emails[0]?.value ||
    phones[0]?.value ||
    '(no name)';
  const bday = card.first('BDAY');
  const birthday = bday ? readBirthday(bday) : undefined;
  const uid = stripUrn(text(card, 'UID'));
  const rev = card.first('REV');
  const lastModified = rev ? parseRev(unescapeText(rev.value)) : undefined;
  const group = isGroupCard(card);
  const members = group
    ? [...card.all('X-ADDRESSBOOKSERVER-MEMBER'), ...card.all('MEMBER')]
        .map((l) => stripUrn(unescapeText(l.value)).toLowerCase())
        .filter(Boolean)
    : [];
  const view: ContactView = {
    kind: group ? 'group' : 'contact',
    name,
    emails,
    phones,
    urls: valueEntries(card, 'url').map((e) => e.entry),
    addresses: addressEntries(card).map((e) => e.entry),
    hasPhoto: card.all('PHOTO').some((l) => l.value.trim() !== ''),
    members,
  };
  const optional: Partial<ContactView> = {
    uid: opt(uid),
    givenName: opt(n.given),
    familyName: opt(n.family),
    middleName: opt(n.middle),
    namePrefix: opt(n.prefix),
    nameSuffix: opt(n.suffix),
    nickname: opt(nickname),
    organization: opt(organization),
    department: opt(department),
    jobTitle: opt(text(card, 'TITLE')),
    birthday,
    note: opt(text(card, 'NOTE')),
    lastModified,
  };
  for (const [k, v] of Object.entries(optional)) if (v !== undefined) (view as unknown as Record<string, unknown>)[k] = v;
  if (company) view.isCompany = true;
  return view;
}
