import { describe, expect, it, vi } from 'vitest';
import { matchesQuery, resolveZone } from '../../src/contacts/tools.js';
import { readContact } from '../../src/contacts/model.js';
import { VCard } from '../../src/contacts/vcard.js';
import { captureTools, harness, useContactsEnv, vcard } from './fake-icloud.js';

useContactsEnv();

const JOHN = vcard(
  'PRODID:-//Apple Inc.//iPhone OS 17.0//EN',
  'N:Appleseed;John;;;',
  'FN:John Appleseed',
  'NICKNAME:Johnny',
  'ORG:Apple Inc.;Engineering',
  'TITLE:Engineer',
  'EMAIL;type=INTERNET;type=HOME;type=pref:john@example.com',
  'item1.EMAIL;type=INTERNET:john@other.com',
  'item1.X-ABLabel:_$!<Other>!$_',
  'TEL;type=CELL;type=VOICE;type=pref:+1 (555) 123-4567',
  'item2.ADR;type=HOME;type=pref:;;1 Infinite Loop;Cupertino;CA;95014;United States',
  'item2.X-ABADR:us',
  'item3.URL;type=pref:http\\://www.apple.com',
  'item3.X-ABLabel:_$!<HomePage>!$_',
  'BDAY;X-APPLE-OMIT-YEAR=1604:1604-05-12',
  'NOTE:Met at WWDC',
  'PHOTO;ENCODING=b;TYPE=JPEG:AAAA',
  'UID:JOHN-UID',
  'REV:2023-01-15T10:20:30Z',
);
const JOSE = vcard('N:Núñez;José;;;', 'FN:José Núñez', 'EMAIL:jose@x.com', 'BDAY:1980-07-04', 'UID:JOSE-UID');
const ACME = vcard('N:;;;;', 'FN:', 'ORG:Acme;', 'X-ABShowAs:COMPANY', 'TEL;type=WORK:555-0100', 'UID:ACME-UID');
const NOUID = vcard('N:Zed;Zoe;;;', 'FN:Zoe Zed');
const FAMILY = vcard(
  'N:Family;;;;',
  'FN:Family',
  'X-ADDRESSBOOKSERVER-KIND:group',
  'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:JOHN-UID',
  'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:NOUID',
  'UID:FAMILY-UID',
);
const WORK = vcard('FN:Work', 'X-ADDRESSBOOKSERVER-KIND:group', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:ACME-UID', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:JOHN-UID');

const BOOK_CARDS = {
  'JOHN-UID.vcf': JOHN,
  'JOSE-UID.vcf': JOSE,
  'ACME-UID.vcf': ACME,
  'NOUID.vcf': NOUID,
  'FAMILY-UID.vcf': FAMILY,
  'WORK.vcf': WORK,
};

const TOOLS = ['apple_contacts_search', 'apple_contacts_get', 'apple_contacts_list_groups', 'apple_contacts_create', 'apple_contacts_update', 'apple_contacts_delete'];

describe('registration', () => {
  it('registers all six tools with an empty environment and does no I/O doing so', () => {
    delete process.env.ICLOUD_USERNAME;
    delete process.env.ICLOUD_APP_PASSWORD;
    const tools = captureTools();
    expect([...tools.keys()]).toEqual(TOOLS);
    expect(fetch).not.toHaveBeenCalled();
    for (const [name, t] of tools) {
      expect(t.cfg.description.length, name).toBeLessThanOrEqual(700);
      expect(t.cfg.description, name).toContain('ICLOUD_');
      expect(t.cfg.inputSchema.safeParse({ bogus: 1 }).success, `${name} must refuse unknown keys`).toBe(false);
    }
    expect(tools.get('apple_contacts_search')!.cfg.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.get('apple_contacts_create')!.cfg.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tools.get('apple_contacts_update')!.cfg.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
    expect(tools.get('apple_contacts_delete')!.cfg.annotations).toMatchObject({ destructiveHint: true });
    expect(tools.get('apple_contacts_delete')!.cfg.description).toMatch(/confirmToken/);
  });

  it('APPLE_WRITE_MODE decides which writes exist', () => {
    process.env.APPLE_WRITE_MODE = 'additive';
    expect([...captureTools().keys()]).toEqual(TOOLS.slice(0, 4));
    process.env.APPLE_WRITE_MODE = 'none';
    expect([...captureTools().keys()]).toEqual(TOOLS.slice(0, 3));
    process.env.APPLE_SERVICES = 'music';
    expect([...captureTools().keys()]).toEqual([]);
  });

  it('a tool called without credentials answers NOT_CONFIGURED naming the variables', async () => {
    delete process.env.ICLOUD_APP_PASSWORD;
    const tools = captureTools();
    const res = await tools.get('apple_contacts_search')!.cb({}, {});
    expect(res.isError).toBe(true);
    const err = JSON.parse(res.content[0]!.text).error;
    expect(err).toMatchObject({ code: 'NOT_CONFIGURED', service: 'contacts', missing: ['ICLOUD_APP_PASSWORD'] });
  });
});

describe('schemas', () => {
  const schema = (name: string) => captureTools().get(name)!.cfg.inputSchema;

  it('search: optional query/group, limit 1–200, offset ≥ 0, no control characters', () => {
    const s = schema('apple_contacts_search');
    expect(s.safeParse({}).success).toBe(true);
    expect(s.safeParse({ query: 'a', group: 'Family', limit: 200, offset: 0 }).success).toBe(true);
    expect(s.safeParse({ limit: 0 }).success).toBe(false);
    expect(s.safeParse({ limit: 201 }).success).toBe(false);
    expect(s.safeParse({ offset: -1 }).success).toBe(false);
    expect(s.safeParse({ query: 'a\u0000' }).success).toBe(false);
    expect(s.safeParse({ group: '' }).success).toBe(false);
  });

  it('get / delete: a contact id that cannot escape the address book', () => {
    const g = schema('apple_contacts_get');
    expect(g.safeParse({ contactId: 'ABC-123' }).success).toBe(true);
    expect(g.safeParse({ contactId: 'ABC', timeZone: 'Europe/Paris' }).success).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'x\ny']) expect(g.safeParse({ contactId: bad }).success, bad).toBe(false);
    expect(g.safeParse({}).success).toBe(false);
    const d = schema('apple_contacts_delete');
    expect(d.safeParse({ contactId: 'A', confirmToken: 't' }).success).toBe(true);
  });

  it('list_groups takes no arguments', () => {
    expect(schema('apple_contacts_list_groups').safeParse({}).success).toBe(true);
  });
});

describe('matchesQuery', () => {
  const view = readContact(VCard.parse(JOHN)!);

  it('every word must match some field; accents and case are folded', () => {
    expect(matchesQuery(view, '')).toBe(true);
    expect(matchesQuery(view, 'john apple')).toBe(true);
    expect(matchesQuery(view, 'JOHNNY')).toBe(true);
    expect(matchesQuery(view, 'engineering')).toBe(true);
    expect(matchesQuery(view, 'other.com')).toBe(true);
    expect(matchesQuery(view, 'john zebra')).toBe(false);
    expect(matchesQuery(readContact(VCard.parse(JOSE)!), 'jose nunez')).toBe(true);
  });

  it('a phone-looking query of 3+ digits matches phone digits', () => {
    expect(matchesQuery(view, '555 123')).toBe(true);
    expect(matchesQuery(view, '(555) 123-4567')).toBe(true);
    expect(matchesQuery(view, '999')).toBe(false);
    expect(matchesQuery(view, '55')).toBe(false);
    expect(matchesQuery(view, 'x555')).toBe(false);
  });
});

describe('apple_contacts_search', () => {
  it('lists everyone sorted by name, paging facts before the rows, groups excluded', async () => {
    const h = harness(BOOK_CARDS);
    const r = await h.call('apple_contacts_search', {});
    expect(r.isError).toBe(false);
    expect(Object.keys(r.json)).toEqual(['returned', 'total', 'offset', 'limit', 'nextOffset', 'hasMore', 'searched', 'contacts']);
    expect(r.json).toMatchObject({ returned: 4, total: 4, hasMore: false, nextOffset: null, searched: 'all 4 contact(s) in the iCloud address book' });
    expect(r.json.contacts.map((c: { name: string }) => c.name)).toEqual(['Acme', 'John Appleseed', 'José Núñez', 'Zoe Zed']);
    expect(r.json.contacts[1]).toEqual({
      id: 'JOHN-UID',
      name: 'John Appleseed',
      organization: 'Apple Inc.',
      jobTitle: 'Engineer',
      emails: [
        { value: 'john@example.com', label: 'home' },
        { value: 'john@other.com', label: 'other' },
      ],
      phones: [{ value: '+1 (555) 123-4567', label: 'mobile' }],
    });
    expect(r.json.contacts[3]).toEqual({ id: 'NOUID', name: 'Zoe Zed', emails: [], phones: [] });
  });

  it('ties on the name sort by id', async () => {
    const same = (uid: string) => vcard('N:Same;Sam;;;', 'FN:Sam Same', `UID:${uid}`);
    const h = harness({ 'B.vcf': same('B'), 'C.vcf': same('C'), 'A.vcf': same('A'), 'D.vcf': same('D') });
    const r = await h.call('apple_contacts_search', { query: 'sam' });
    expect(r.json.contacts.map((c: { id: string }) => c.id)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('pages with limit/offset, and refuses an offset past the end rather than returning an empty page', async () => {
    const h = harness(BOOK_CARDS);
    const p = await h.call('apple_contacts_search', { limit: 3, offset: 1 });
    expect(p.json).toMatchObject({ returned: 3, total: 4, offset: 1, limit: 3, hasMore: false, nextOffset: null });
    const q = await h.call('apple_contacts_search', { limit: 2 });
    expect(q.json).toMatchObject({ returned: 2, hasMore: true, nextOffset: 2 });
    const past = await h.call('apple_contacts_search', { offset: 4 });
    expect(past.isError).toBe(true);
    expect(past.json.error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(past.json.error.message).toContain('valid offsets 0–3');
  });

  it('searches names, company, email and phone digits; an empty result says what was searched', async () => {
    const h = harness(BOOK_CARDS);
    expect((await h.call('apple_contacts_search', { query: 'acme' })).json.contacts.map((c: { id: string }) => c.id)).toEqual(['ACME-UID']);
    expect((await h.call('apple_contacts_search', { query: '555-0100' })).json.total).toBe(1);
    const none = await h.call('apple_contacts_search', { query: 'nobody at all', offset: 3 });
    expect(none.isError).toBe(false);
    expect(none.json).toMatchObject({ returned: 0, total: 0, query: 'nobody at all', contacts: [] });
    expect(none.json.notes).toEqual([
      'No contact matched "nobody at all" (searched all 4 contact(s) in the iCloud address book by name, nickname, organization, department, job title, email and phone digits).',
    ]);
    // One fleet-wide key for "why is this empty": `notes`, never a singular `note`.
    expect(none.json).not.toHaveProperty('note');
  });

  it('filters by group (case-insensitive name), matching members by UID — or the id for a card without one', async () => {
    const h = harness(BOOK_CARDS);
    const fam = await h.call('apple_contacts_search', { group: 'family' });
    expect(fam.json).toMatchObject({ total: 2, group: 'family', searched: 'the 2 contact(s) in the group "family"' });
    expect(fam.json.contacts.map((c: { id: string }) => c.id)).toEqual(['JOHN-UID', 'NOUID']);
    const workJohn = await h.call('apple_contacts_search', { group: 'Work', query: 'john' });
    expect(workJohn.json.total).toBe(1);
  });

  it('an unknown group is an error listing the groups (never an empty list)', async () => {
    const h = harness(BOOK_CARDS);
    const r = await h.call('apple_contacts_search', { group: 'Friends' });
    expect(r.isError).toBe(true);
    expect(r.json.error.message).toBe('There is no contact group named "Friends". Groups: Family, Work.');
    const bare = harness({ 'JOHN-UID.vcf': JOHN });
    const r2 = await bare.call('apple_contacts_search', { group: 'Friends' });
    expect(r2.json.error.message).toContain('The address book has no groups.');
  });

  it('an empty address book or group says so; unreadable cards are reported, not silently dropped', async () => {
    const empty = harness({});
    const r = await empty.call('apple_contacts_search', {});
    expect(r.json).toMatchObject({ total: 0, notes: ['The iCloud address book has no contacts.'] });
    expect(r.json).not.toHaveProperty('note');
    const h = harness({ ...BOOK_CARDS, 'BROKEN.vcf': 'not a vcard' });
    const w = await h.call('apple_contacts_search', { query: 'john' });
    expect(w.json.warnings).toEqual(['1 card(s) in the address book could not be read and are not included.']);
    const g = await harness({ 'E.vcf': vcard('FN:Empty', 'X-ADDRESSBOOKSERVER-KIND:group') }).call('apple_contacts_search', { group: 'Empty' });
    expect(g.json.notes).toEqual(['The group "Empty" has no contacts.']);
    expect(g.json).not.toHaveProperty('note');
  });

  it('upstream failures are errors, never an empty result', async () => {
    const h = harness(BOOK_CARDS);
    h.fake.fail({ method: 'REPORT', status: 500 });
    const r = await h.call('apple_contacts_search', {});
    expect(r.isError).toBe(true);
    expect(r.json.contacts).toBeUndefined();
  });
});

describe('apple_contacts_get', () => {
  it('returns the full record with entryIds, birthday display, groups and lastModified in the display zone', async () => {
    const h = harness(BOOK_CARDS);
    const r = await h.call('apple_contacts_get', { contactId: 'JOHN-UID.vcf' });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({
      id: 'JOHN-UID',
      name: 'John Appleseed',
      givenName: 'John',
      familyName: 'Appleseed',
      nickname: 'Johnny',
      organization: 'Apple Inc.',
      department: 'Engineering',
      jobTitle: 'Engineer',
      birthday: '--05-12',
      birthdayDisplay: 'May 12',
      note: 'Met at WWDC',
      groups: ['Family', 'Work'],
      hasPhoto: true,
      lastModified: '2023-01-15T05:20:30-05:00',
      lastModifiedDisplay: 'Sun, Jan 15, 2023, 5:20 AM EST',
      uid: 'JOHN-UID',
    });
    expect(r.json.emails[0]).toEqual({ entryId: expect.any(String), label: 'home', preferred: true, value: 'john@example.com' });
    expect(r.json.urls[0]).toMatchObject({ value: 'http://www.apple.com', label: 'homepage' });
    expect(r.json.addresses[0]).toMatchObject({ city: 'Cupertino', formatted: '1 Infinite Loop, Cupertino, CA 95014, United States' });
    expect(r.json.photo).toBeUndefined();
    expect(r.text).not.toContain('AAAA');
  });

  it('a full birthday gets a dated display; timeZone overrides the display zone; a bad zone is refused', async () => {
    const h = harness(BOOK_CARDS);
    const jose = await h.call('apple_contacts_get', { contactId: 'JOSE-UID' });
    expect(jose.json).toMatchObject({ birthday: '1980-07-04', birthdayDisplay: 'Fri, Jul 4, 1980', groups: [] });
    expect(jose.json.lastModified).toBeUndefined();
    const paris = await h.call('apple_contacts_get', { contactId: 'JOHN-UID', timeZone: 'Europe/Paris' });
    expect(paris.json.lastModified).toBe('2023-01-15T11:20:30+01:00');
    const bad = await h.call('apple_contacts_get', { contactId: 'JOHN-UID', timeZone: 'Mars/Base' });
    expect(bad.json.error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    const offset = await h.call('apple_contacts_get', { contactId: 'JOHN-UID', timeZone: '\u221204:00' });
    expect(offset.json.error).toMatchObject({ code: 'INVALID_ARGUMENT' });
    const lower = await h.call('apple_contacts_get', { contactId: 'JOHN-UID', timeZone: 'europe/paris' });
    expect(lower.json.lastModified).toBe('2023-01-15T11:20:30+01:00');
  });

  it('a timeZone argument resolves to its canonical IANA spelling, the one DISPLAY_TZ resolves to', () => {
    expect(resolveZone('europe/paris')).toBe('Europe/Paris');
    expect(resolveZone('AMERICA/NEW_YORK')).toBe('America/New_York');
    expect(resolveZone('US/Eastern')).toBe('America/New_York');
    process.env.DISPLAY_TZ = 'asia/tokyo'; // useContactsEnv resets it before each test
    expect(resolveZone(undefined)).toBe('Asia/Tokyo');
    expect(() => resolveZone('Mars/Base')).toThrow(/not a known IANA time zone/);
  });

  it('an unknown id is NOT_FOUND; a group id is refused with a pointer', async () => {
    const h = harness(BOOK_CARDS);
    const nf = await h.call('apple_contacts_get', { contactId: 'NOPE' });
    expect(nf.json.error).toMatchObject({ code: 'NOT_FOUND' });
    const grp = await h.call('apple_contacts_get', { contactId: 'FAMILY-UID' });
    expect(grp.json.error.message).toBe('"FAMILY-UID" is the contact group "Family", not a contact.');
    expect(grp.json.error.hint).toContain('group: "Family"');
  });

  it('a card without a UID has no uid field (group membership then goes by its id)', async () => {
    const h = harness(BOOK_CARDS);
    const r = await h.call('apple_contacts_get', { contactId: 'NOUID' });
    expect(r.json).toMatchObject({ id: 'NOUID', name: 'Zoe Zed', groups: ['Family'] });
    expect(r.json.uid).toBeUndefined();
  });

  it('reuses the downloaded book while its ctag is unchanged', async () => {
    const h = harness(BOOK_CARDS);
    await h.call('apple_contacts_get', { contactId: 'JOHN-UID' });
    await h.call('apple_contacts_get', { contactId: 'JOSE-UID' });
    expect(h.fake.log().filter((l) => l.startsWith('REPORT'))).toHaveLength(1);
  });
});

describe('apple_contacts_list_groups', () => {
  it('lists groups by name with member counts', async () => {
    const h = harness(BOOK_CARDS);
    const r = await h.call('apple_contacts_list_groups', {});
    expect(r.json).toEqual({
      returned: 2,
      total: 2,
      groups: [
        { id: 'FAMILY-UID', name: 'Family', memberCount: 2 },
        { id: 'WORK', name: 'Work', memberCount: 2 },
      ],
    });
  });

  it('says when there are none, and reports unreadable cards', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = harness({ 'JOHN-UID.vcf': JOHN, 'BAD.vcf': 'nope' });
    const r = await h.call('apple_contacts_list_groups', {});
    expect(r.json).toEqual({
      returned: 0,
      total: 0,
      notes: ['The iCloud address book has no contact groups.'],
      warnings: ['1 card(s) in the address book could not be read and are not included.'],
      groups: [],
    });
    errors.mockRestore();
  });
});

describe('review fixes: truncated listings and group counts', () => {
  const TRUNCATED = `<response><href>/27015122/carddavhome/card/</href><status>HTTP/1.1 507 Insufficient Storage</status></response>`;

  it('a truncated listing is said out loud on search and list_groups (never passed off as the whole book)', async () => {
    const h = harness(BOOK_CARDS);
    h.fake.extraReport = TRUNCATED;
    const s = await h.call('apple_contacts_search', { query: 'nobody' });
    expect(s.json.total).toBe(0);
    expect(s.json.warnings).toEqual([expect.stringContaining('iCloud returned only part of the address book')]);
    // Paging facts still come first; the data array last.
    expect(Object.keys(s.json).at(-1)).toBe('contacts');
    const g = await h.call('apple_contacts_list_groups', {});
    expect(g.json.warnings).toEqual([expect.stringContaining('may be missing')]);
    const missing = await h.call('apple_contacts_search', { group: 'Friends' });
    expect(missing.json.error.message).toBe(
      'No contact group named "Friends" was listed, but iCloud returned only part of the address book, so it may exist. Groups: Family, Work.',
    );
  });

  it('get: a contact left out of a truncated listing is fetched directly, with the warning', async () => {
    const h = harness(BOOK_CARDS);
    h.fake.extraReport = TRUNCATED;
    h.fake.unlisted.add('JOSE-UID.vcf');
    const r = await h.call('apple_contacts_get', { contactId: 'JOSE-UID' });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ id: 'JOSE-UID', name: 'José Núñez', groups: [] });
    expect(r.json.warnings).toEqual([expect.stringContaining('only part of the address book')]);
    expect(h.fake.log().slice(-1)).toEqual(['GET /27015122/carddavhome/card/JOSE-UID.vcf']);
    const nf = await h.call('apple_contacts_get', { contactId: 'NOPE' });
    expect(nf.json.error.code).toBe('NOT_FOUND');
  });

  it('get: a complete listing is authoritative — no extra GET for an unknown id', async () => {
    const h = harness(BOOK_CARDS);
    h.fake.unlisted.add('JOSE-UID.vcf');
    const r = await h.call('apple_contacts_get', { contactId: 'JOSE-UID' });
    expect(r.json.error.code).toBe('NOT_FOUND');
    expect(h.fake.calls.some((c) => c.method === 'GET')).toBe(false);
  });

  it('memberCount counts the members search would list (a member line naming a deleted card does not count)', async () => {
    const stale = vcard(
      'FN:Book Club',
      'X-ADDRESSBOOKSERVER-KIND:group',
      'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:JOHN-UID',
      'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:DELETED-LONG-AGO',
      'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:john-uid',
    );
    const h = harness({ ...BOOK_CARDS, 'CLUB.vcf': stale });
    const g = await h.call('apple_contacts_list_groups', {});
    expect(g.json.groups).toContainEqual({ id: 'CLUB', name: 'Book Club', memberCount: 1 });
    const s = await h.call('apple_contacts_search', { group: 'Book Club' });
    expect(s.json.total).toBe(1);
  });
});
