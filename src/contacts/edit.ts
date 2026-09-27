import { InvalidArgumentError } from '../errors.js';
import {
  ENTRY_FIELD,
  ENTRY_PROPERTY,
  OMIT_YEAR,
  addressEntries,
  composeFormattedName,
  formatAddress,
  formatRev,
  readBirthday,
  valueEntries,
  type AddressEntry,
  type EntryKind,
  type Located,
  type ValueEntry,
  type ValueKind,
} from './model.js';
import { VCard, VLine, escapeText, makeParam, newLine, splitUnescaped, typeParam, unescapeText, type VParam } from './vcard.js';

/**
 * Surgical edits to a parsed card. Each operation touches only the lines it
 * must — the rest of the card (photos, Apple X- properties, other entries)
 * is written back exactly as it was read.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Scalar fields. `''` clears the field; undefined leaves it alone. */
export interface ScalarEdits {
  givenName?: string;
  familyName?: string;
  middleName?: string;
  nickname?: string;
  organization?: string;
  department?: string;
  jobTitle?: string;
  note?: string;
  /** `YYYY-MM-DD`, `--MM-DD`, or `''` to clear. */
  birthday?: string;
}

export type ChangeAction = 'add' | 'remove' | 'replace';

/** A change to one email / phone / URL entry. */
export interface ValueChange {
  action: ChangeAction;
  value?: string;
  /** `''` on replace clears the label. */
  label?: string;
  target?: string;
  entryId?: string;
}

export interface AddressFields {
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

/** A change to one postal address. A replace MERGES the given components into the address. */
export interface AddressChange extends AddressFields {
  action: ChangeAction;
  label?: string;
  target?: string;
  entryId?: string;
}

/** What happened to one change object. */
export interface ChangeOutcome {
  field: 'emails' | 'phones' | 'urls' | 'addresses';
  /** Position of the change in its argument array. */
  index: number;
  action: ChangeAction;
  status: 'applied' | 'no-op';
  /** Why a change did nothing. */
  reason?: string;
  /** The entry acted on, as it was (remove/replace), or the entry created (add). */
  entryId?: string;
  before?: PublicEntry | PublicEntry[];
  after?: PublicEntry;
  /** For a no-op whose target was absent: what IS there. */
  present?: PublicEntry[];
}

/** An entry as reported back (value or address components, label, entryId). */
export type PublicEntry = ValueEntry | AddressEntry;

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Labels that are written as TYPE parameters (Apple's own spelling). */
const TYPE_LABELS: Readonly<Record<EntryKind, Readonly<Record<string, readonly string[]>>>> = {
  email: { home: ['HOME'], work: ['WORK'] },
  phone: {
    mobile: ['CELL', 'VOICE'],
    cell: ['CELL', 'VOICE'],
    iphone: ['IPHONE', 'CELL', 'VOICE'],
    home: ['HOME', 'VOICE'],
    work: ['WORK', 'VOICE'],
    main: ['MAIN'],
    'home fax': ['HOME', 'FAX'],
    'work fax': ['WORK', 'FAX'],
    fax: ['FAX'],
    pager: ['PAGER'],
  },
  address: { home: ['HOME'], work: ['WORK'] },
  url: { home: ['HOME'], work: ['WORK'] },
};

/** Apple's built-in labels written as `itemN.X-ABLabel` (anything else is written as custom text). */
const WRAPPED_LABELS: Readonly<Record<string, string>> = {
  home: '_$!<Home>!$_',
  work: '_$!<Work>!$_',
  other: '_$!<Other>!$_',
  mobile: '_$!<Mobile>!$_',
  main: '_$!<Main>!$_',
  'home fax': '_$!<HomeFAX>!$_',
  'work fax': '_$!<WorkFAX>!$_',
  'other fax': '_$!<OtherFAX>!$_',
  pager: '_$!<Pager>!$_',
  homepage: '_$!<HomePage>!$_',
  'home page': '_$!<HomePage>!$_',
  school: '_$!<School>!$_',
};

type LabelSpec = { types: readonly string[] } | { abLabel: string };

/** How `label` is written for `kind`: TYPE parameters, or an X-ABLabel (built-in or custom text). */
export function labelSpec(kind: EntryKind, label: string): LabelSpec {
  const key = label.trim().toLowerCase();
  const types = TYPE_LABELS[kind][key];
  if (types) return { types };
  return { abLabel: WRAPPED_LABELS[key] ?? label.trim() };
}

/** TYPE values kept across a relabel: they are not labels. */
const KEPT_TYPES = new Set(['INTERNET', 'PREF']);

/** Replace a line's label TYPEs with `labelTypes`, keeping INTERNET/pref and every other parameter. */
function setLabelTypes(line: VLine, labelTypes: readonly string[]): void {
  const kept = line.typeValues().filter((v) => KEPT_TYPES.has(v.toUpperCase()));
  const internet = kept.filter((v) => v.toUpperCase() === 'INTERNET');
  const pref = kept.filter((v) => v.toUpperCase() === 'PREF');
  const typeParams = [...internet, ...labelTypes, ...pref].map(typeParam);
  const firstType = line.params.findIndex((p) => p.name === 'TYPE');
  const others = line.params.filter((p) => p.name !== 'TYPE');
  const at = firstType < 0 ? others.length : firstType;
  line.setParams([...others.slice(0, at), ...typeParams, ...others.slice(at)]);
}

/**
 * Give `line` the label `label` (`''` = no label). A TYPE label replaces the
 * label TYPEs and drops any X-ABLabel; anything else is written as the
 * group's X-ABLabel, putting an ungrouped line into a fresh `itemN` group.
 */
export function applyLabel(card: VCard, line: VLine, kind: EntryKind, label: string): void {
  const labelLines = card.siblings(line).filter((s) => s.name === 'X-ABLABEL');
  if (label.trim() === '') {
    setLabelTypes(line, []);
    for (const l of labelLines) card.remove(l);
    return;
  }
  const spec = labelSpec(kind, label);
  if ('types' in spec) {
    setLabelTypes(line, spec.types);
    for (const l of labelLines) card.remove(l);
    return;
  }
  setLabelTypes(line, []);
  const value = escapeText(spec.abLabel);
  const [first, ...extra] = labelLines;
  if (first) {
    first.setValue(value);
    for (const l of extra) card.remove(l);
    return;
  }
  if (line.group === undefined) line.setGroup(card.nextGroup());
  card.insertAfter(line, newLine({ group: line.group as string, nameText: 'X-ABLabel', value }));
}

/** A new entry line (appended before END:VCARD), labelled. Returns the property line. */
function appendEntry(card: VCard, kind: EntryKind, rawValue: string, label: string | undefined): VLine {
  const base = kind === 'email' ? [typeParam('INTERNET')] : [];
  const line = newLine({ nameText: ENTRY_PROPERTY[kind], params: base, value: rawValue });
  card.append(line);
  if (label !== undefined && label.trim() !== '') applyLabel(card, line, kind, label);
  return line;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export function digitsOf(s: string): string {
  return s.replace(/\D/g, '');
}

/** Case-insensitive, whitespace- and comma-collapsed form of an address or street. */
function addressKey(s: string): string {
  return s.toLowerCase().replace(/[\s,]+/g, ' ').trim();
}

/** Whether two entry values name the same thing (emails/URLs ignore case; phones compare digits). */
export function sameValue(kind: ValueKind, a: string, b: string): boolean {
  if (kind === 'phone') {
    const da = digitsOf(a);
    const db = digitsOf(b);
    if (da !== '' || db !== '') return da === db;
  }
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Minimum digits in the shorter number for a country-code-tolerant (suffix) phone match. */
const PHONE_SUFFIX_MIN_DIGITS = 10;

function matchValueTarget(kind: ValueKind, entries: Located<ValueEntry>[], target: string): Located<ValueEntry>[] {
  const exact = entries.filter((e) => sameValue(kind, e.entry.value, target));
  if (exact.length > 0 || kind !== 'phone') return exact;
  // `555-123-4567` for `+1 (555) 123-4567`: one number's digits end the
  // other's, with at least ten digits on the shorter side, and only when a
  // single entry matches that way.
  const t = digitsOf(target);
  const suffix = entries.filter((e) => {
    const d = digitsOf(e.entry.value);
    const [short, long] = d.length <= t.length ? [d, t] : [t, d];
    return short.length >= PHONE_SUFFIX_MIN_DIGITS && long.endsWith(short);
  });
  return suffix.length === 1 ? suffix : [];
}

function matchAddressTarget(entries: Located<AddressEntry>[], target: string): Located<AddressEntry>[] {
  const key = addressKey(target);
  // A target of only spaces/commas would otherwise match every address that has no street.
  if (key === '') return [];
  return entries.filter((e) => addressKey(e.entry.formatted) === key || addressKey(e.entry.street ?? '') === key);
}

function strip<E extends { entryId: string }>(entries: Located<E>[]): E[] {
  return entries.map((e) => e.entry);
}

/**
 * The entries a change's `entryId` names, as they are on the card NOW.
 *
 * The id is looked up in `initial` — the entries as they were before this
 * request changed anything — because that is the card the caller read the
 * id from. Resolving it against the edited card instead would let an earlier
 * change move ids under a later one: identical lines are numbered `id`,
 * `id~2`, `id~3` in card order, so removing `id` renumbers the rest and a
 * following "remove `id~2`" would take out the entry that WAS `id~3`. A line
 * an earlier change already removed yields `gone`.
 */
function resolveEntryId<E extends { entryId: string }>(
  entries: Located<E>[],
  initial: Located<E>[] | undefined,
  entryId: string,
): { matches: Located<E>[]; gone: boolean } {
  if (initial === undefined) return { matches: entries.filter((e) => e.entry.entryId === entryId), gone: false };
  const named = initial.filter((e) => e.entry.entryId === entryId);
  const matches = entries.filter((e) => named.some((n) => n.line === e.line));
  return { matches, gone: named.length > 0 && matches.length === 0 };
}

function alreadyRemoved(field: ChangeOutcome['field'], index: number, action: ChangeAction, kind: EntryKind, entryId: string, present: PublicEntry[]): ChangeOutcome {
  return {
    field,
    index,
    action,
    status: 'no-op',
    reason: `the ${NOUN[kind]} with entryId "${entryId}" was already removed by an earlier change in this request; nothing more was changed for it`,
    present,
  };
}

// ---------------------------------------------------------------------------
// Entry changes
// ---------------------------------------------------------------------------

const NOUN: Readonly<Record<EntryKind, string>> = { email: 'email', phone: 'phone number', url: 'URL', address: 'address' };

function findLine<E extends { entryId: string }>(list: Located<E>[], line: VLine): E {
  return (list.find((e) => e.line === line) as Located<E>).entry;
}

function sameEntry(a: PublicEntry, b: PublicEntry): boolean {
  return JSON.stringify({ ...a, entryId: '' }) === JSON.stringify({ ...b, entryId: '' });
}

function notFound(
  field: ChangeOutcome['field'],
  index: number,
  action: ChangeAction,
  kind: EntryKind,
  change: { target?: string; entryId?: string },
  present: PublicEntry[],
): ChangeOutcome {
  const reason =
    change.entryId !== undefined
      ? `no ${NOUN[kind]} on this contact has entryId "${change.entryId}"`
      : `no ${NOUN[kind]} on this contact matches "${change.target}"`;
  return { field, index, action, status: 'no-op', reason: `${reason}; nothing was changed for this entry`, present };
}

/**
 * Apply one email / phone / URL change. Never throws for an absent target —
 * that is a reported no-op. Pass `initial` (the card's entries before the
 * first change of a request) when applying several changes in a row, so each
 * `entryId` names the entry the caller read it from.
 */
export function applyValueChange(
  card: VCard,
  kind: ValueKind,
  change: ValueChange,
  index: number,
  initial?: Located<ValueEntry>[],
): ChangeOutcome {
  const field = ENTRY_FIELD[kind];
  const entries = valueEntries(card, kind);
  const { action } = change;
  if (action === 'add') {
    const value = (change.value as string).trim();
    const dup = entries.find((e) => sameValue(kind, e.entry.value, value));
    if (dup) {
      return {
        field,
        index,
        action,
        status: 'no-op',
        reason: `this ${NOUN[kind]} is already on the contact (entryId ${dup.entry.entryId}); use replace to change its label`,
        entryId: dup.entry.entryId,
      };
    }
    const line = appendEntry(card, kind, value, change.label);
    const after = findLine(valueEntries(card, kind), line);
    return { field, index, action, status: 'applied', entryId: after.entryId, after };
  }
  let matches: Located<ValueEntry>[];
  if (change.entryId !== undefined) {
    const found = resolveEntryId(entries, initial, change.entryId);
    if (found.gone) return alreadyRemoved(field, index, action, kind, change.entryId, strip(entries));
    matches = found.matches;
  } else {
    matches = matchValueTarget(kind, entries, change.target as string);
  }
  if (matches.length === 0) return notFound(field, index, action, kind, change, strip(entries));
  if (action === 'remove') {
    // Several matches only for a target, and then they are the same value.
    for (const m of matches) card.removeEntry(m.line);
    const before = strip(matches);
    return { field, index, action, status: 'applied', entryId: (before[0] as ValueEntry).entryId, before: before.length === 1 ? (before[0] as ValueEntry) : before };
  }
  if (matches.length > 1) {
    return {
      field,
      index,
      action,
      status: 'no-op',
      reason: `${matches.length} ${NOUN[kind]} entries match "${change.target}"; pass the entryId of the one to replace`,
      present: strip(entries),
    };
  }
  const { line, entry: before } = matches[0] as Located<ValueEntry>;
  if (change.value !== undefined) line.setValue(change.value.trim());
  if (change.label !== undefined) applyLabel(card, line, kind, change.label);
  const after = findLine(valueEntries(card, kind), line);
  if (sameEntry(before, after)) {
    return { field, index, action, status: 'no-op', reason: 'the entry already has that value and label', entryId: before.entryId };
  }
  return { field, index, action, status: 'applied', entryId: before.entryId, before, after };
}

const ADR_INDEX: Readonly<Record<keyof AddressFields, number>> = { street: 2, city: 3, state: 4, postalCode: 5, country: 6 };

function addressFieldsOf(change: AddressFields): Array<[keyof AddressFields, string]> {
  return (Object.keys(ADR_INDEX) as Array<keyof AddressFields>)
    .filter((k) => change[k] !== undefined)
    .map((k) => [k, change[k] as string]);
}

/** The ADR value for components (7 components, escaped). */
function adrValue(comps: readonly string[]): string {
  return comps.map((c) => escapeText(c)).join(';');
}

/**
 * Apply one postal-address change (a replace MERGES the given components;
 * `''` clears one). `initial` as for `applyValueChange`.
 */
export function applyAddressChange(card: VCard, change: AddressChange, index: number, initial?: Located<AddressEntry>[]): ChangeOutcome {
  const field = 'addresses';
  const entries = addressEntries(card);
  const { action } = change;
  const fields = addressFieldsOf(change);
  if (action === 'add') {
    const comps = ['', '', '', '', '', '', ''];
    for (const [k, v] of fields) comps[ADR_INDEX[k]] = v.trim();
    const formatted = formatAddress({ street: comps[2], city: comps[3], state: comps[4], postalCode: comps[5], country: comps[6] });
    const dup = entries.find((e) => addressKey(e.entry.formatted) === addressKey(formatted));
    if (dup) {
      return {
        field,
        index,
        action,
        status: 'no-op',
        reason: `this address is already on the contact (entryId ${dup.entry.entryId}); use replace to change its label`,
        entryId: dup.entry.entryId,
      };
    }
    const line = appendEntry(card, 'address', adrValue(comps), change.label);
    const after = findLine(addressEntries(card), line);
    return { field, index, action, status: 'applied', entryId: after.entryId, after };
  }
  let matches: Located<AddressEntry>[];
  if (change.entryId !== undefined) {
    const found = resolveEntryId(entries, initial, change.entryId);
    if (found.gone) return alreadyRemoved(field, index, action, 'address', change.entryId, strip(entries));
    matches = found.matches;
  } else {
    matches = matchAddressTarget(entries, change.target as string);
  }
  if (matches.length === 0) return notFound(field, index, action, 'address', change, strip(entries));
  // A target can match by street alone, so several matches may be DIFFERENT
  // addresses (the same street in two cities). Removing them all would delete
  // an address nobody named; only exact duplicates go together.
  const distinct = new Set(matches.map((m) => addressKey(m.entry.formatted))).size;
  if (action === 'remove' && distinct === 1) {
    for (const m of matches) card.removeEntry(m.line);
    const before = strip(matches);
    return { field, index, action, status: 'applied', entryId: (before[0] as AddressEntry).entryId, before: before.length === 1 ? (before[0] as AddressEntry) : before };
  }
  if (matches.length > 1) {
    return {
      field,
      index,
      action,
      status: 'no-op',
      reason: `${matches.length} addresses match "${change.target}"; pass the entryId of the one to ${action}`,
      present: strip(entries),
    };
  }
  const { line, entry: before } = matches[0] as Located<AddressEntry>;
  if (fields.length > 0) {
    // Untouched components keep their text exactly as written (still escaped).
    const comps = splitUnescaped(line.value, ';');
    while (comps.length < 7) comps.push('');
    for (const [k, v] of fields) comps[ADR_INDEX[k]] = escapeText(v.trim());
    line.setValue(comps.join(';'));
  }
  if (change.label !== undefined) applyLabel(card, line, 'address', change.label);
  const after = findLine(addressEntries(card), line);
  if (sameEntry(before, after)) {
    return { field, index, action, status: 'no-op', reason: 'the address already has those components and label', entryId: before.entryId };
  }
  return { field, index, action, status: 'applied', entryId: before.entryId, before, after };
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/**
 * Set (or, with `''`, remove) a single-valued text property. `dropExtra`
 * also removes any further lines of it — for a property whose lines are READ
 * together (NICKNAME: every line is shown), where one left behind would make
 * the result read as more than was asked for.
 */
function setText(card: VCard, name: string, nameText: string, value: string, dropExtra = false): void {
  const lines = card.all(name);
  if (value === '') {
    for (const l of lines) card.remove(l);
    return;
  }
  const [first, ...rest] = lines;
  if (dropExtra) for (const l of rest) card.remove(l);
  if (first === undefined) {
    card.append(newLine({ nameText, value: escapeText(value) }));
  } else if (unescapeText(first.value) !== value) {
    first.setValue(escapeText(value));
  }
}

/**
 * Set components of a structured property (N, ORG), keeping the others'
 * text exactly. `minComps` pads the value (N always has five). Returns
 * whether the card changed.
 */
function setComponents(card: VCard, name: string, updates: ReadonlyMap<number, string>, minComps: number): boolean {
  if (updates.size === 0) return false;
  const line = card.first(name);
  const comps = line ? splitUnescaped(line.value, ';') : [];
  while (comps.length < minComps) comps.push('');
  let changed = false;
  for (const [i, v] of updates) {
    if (unescapeText(comps[i] as string) !== v) {
      comps[i] = escapeText(v);
      changed = true;
    }
  }
  if (!changed) return false;
  if (!line) {
    // Only reached by setting a non-empty component: a fresh line was all empty.
    card.append(newLine({ nameText: name, value: comps.join(';') }));
  } else if (name === 'ORG' && comps.every((c) => unescapeText(c).trim() === '')) {
    card.remove(line); // an organization cleared completely
  } else {
    line.setValue(comps.join(';'));
  }
  return true;
}

/** Birthday input (`YYYY-MM-DD` / `--MM-DD`) → the BDAY params + value Apple writes. */
function birthdayLine(value: string): { params: VParam[]; value: string } {
  if (value.startsWith('--')) {
    return { params: [makeParam('X-APPLE-OMIT-YEAR', OMIT_YEAR)], value: `${OMIT_YEAR}-${value.slice(2)}` };
  }
  return { params: [makeParam('value', 'date')], value };
}

function setBirthday(card: VCard, value: string): void {
  const lines = card.all('BDAY');
  const [first, ...rest] = lines;
  if (value === '') {
    for (const l of lines) card.remove(l);
    return;
  }
  if (first && readBirthday(first) === value && rest.length === 0) return;
  for (const l of rest) card.remove(l);
  const next = birthdayLine(value);
  if (first) {
    first.setParams(next.params);
    first.setValue(next.value);
  } else {
    card.append(newLine({ nameText: 'BDAY', params: next.params, value: next.value }));
  }
}

/**
 * Apply scalar edits. When a name or organization edit changes the name
 * Apple's clients would compose, FN is rewritten to it (a stale FN would keep
 * showing the old name). FN is left alone when the edit changes nothing, or
 * changes only the organization of a card whose FN is not simply its composed
 * name — a custom FN ("Appleseed, John", "Mom") is the user's own text and is
 * not rewritten by an edit that did not touch the name. Throws
 * `InvalidArgumentError` — before anything is sent — when the result would
 * have neither a name nor an organization.
 */
export function applyScalars(card: VCard, edits: ScalarEdits): void {
  const composedBefore = composeFormattedName(card);
  const n = new Map<number, string>();
  if (edits.familyName !== undefined) n.set(0, edits.familyName.trim());
  if (edits.givenName !== undefined) n.set(1, edits.givenName.trim());
  if (edits.middleName !== undefined) n.set(2, edits.middleName.trim());
  const nameChanged = setComponents(card, 'N', n, 5);
  const org = new Map<number, string>();
  if (edits.organization !== undefined) org.set(0, edits.organization.trim());
  if (edits.department !== undefined) org.set(1, edits.department.trim());
  const orgChanged = setComponents(card, 'ORG', org, 2);
  if (nameChanged || orgChanged) {
    const composed = composeFormattedName(card);
    if (composed === '') {
      throw new InvalidArgumentError(
        'That would leave the contact with neither a name nor an organization. Nothing was changed.',
        'Keep at least one of givenName, familyName or organization.',
      );
    }
    const fnLine = card.first('FN');
    const fn = fnLine ? unescapeText(fnLine.value).trim() : '';
    // An empty FN is always filled; otherwise FN follows the composed name
    // when the name itself changed, or when FN was just the composed name.
    const stale = composed !== composedBefore && (nameChanged || fn === composedBefore);
    if (fn === '' || stale) setText(card, 'FN', 'FN', composed);
  }
  if (edits.nickname !== undefined) setText(card, 'NICKNAME', 'NICKNAME', edits.nickname.trim(), true);
  if (edits.jobTitle !== undefined) setText(card, 'TITLE', 'TITLE', edits.jobTitle.trim());
  if (edits.note !== undefined) setText(card, 'NOTE', 'NOTE', edits.note);
  if (edits.birthday !== undefined) setBirthday(card, edits.birthday);
}

/** Stamp REV with `now` (replacing an existing REV in place). */
export function setRev(card: VCard, now: Date): void {
  const rev = card.first('REV');
  if (rev) rev.setValue(formatRev(now));
  else card.append(newLine({ nameText: 'REV', value: formatRev(now) }));
}

// ---------------------------------------------------------------------------
// New card
// ---------------------------------------------------------------------------

/** PRODID written on cards this server creates. */
export const PRODID = '-//chrischall//apple-icloud-mcp//EN';

export interface NewContact extends ScalarEdits {
  emails?: Array<{ value: string; label?: string }>;
  phones?: Array<{ value: string; label?: string }>;
  urls?: Array<{ value: string; label?: string }>;
  addresses?: Array<AddressFields & { label?: string }>;
}

/**
 * A new vCard 3.0 for `input`, with `uid` and REV `now`. Built by applying
 * the same edits `update` uses to a skeleton, so a created card and an edited
 * one are written identically. Returns the card and any entry that was
 * skipped as a duplicate of an earlier one.
 */
export function buildNewCard(input: NewContact, uid: string, now: Date): { card: VCard; skipped: ChangeOutcome[] } {
  const eol = '\r\n';
  const skeleton = ['BEGIN:VCARD', 'VERSION:3.0', `PRODID:${PRODID}`, 'N:;;;;', 'FN:', `UID:${uid}`, 'END:VCARD', ''].join(eol);
  const card = VCard.parse(skeleton) as VCard;
  const personal = [input.givenName, input.familyName, input.middleName].some((v) => (v ?? '').trim() !== '');
  if (!personal && (input.organization ?? '').trim() !== '') card.append(newLine({ nameText: 'X-ABShowAs', value: 'COMPANY' }));
  applyScalars(card, input);
  const outcomes: ChangeOutcome[] = [];
  const kinds: Array<[ValueKind, Array<{ value: string; label?: string }> | undefined]> = [
    ['email', input.emails],
    ['phone', input.phones],
    ['url', input.urls],
  ];
  for (const [kind, list] of kinds) {
    (list ?? []).forEach((e, i) => outcomes.push(applyValueChange(card, kind, { action: 'add', ...e }, i)));
  }
  (input.addresses ?? []).forEach((a, i) => outcomes.push(applyAddressChange(card, { action: 'add', ...a }, i)));
  setRev(card, now);
  return { card, skipped: outcomes.filter((o) => o.status === 'no-op') };
}

/** The address components a change sets, in ADR order (for validation). */
export function addressComponents(change: AddressFields): Array<[keyof AddressFields, string]> {
  return addressFieldsOf(change);
}
