import { describe, expect, it } from 'vitest';
import { UpstreamError } from '../../src/errors.js';
import { captureTools, harness, useContactsEnv, vcard, BOOK, DSID } from './fake-icloud.js';
import { CAN_ASK_CTX, NO_ELICIT_CTX, callConfirmed, callPreview } from '../tools/_confirm-helpers.js';

useContactsEnv();

const JOHN = vcard(
  'PRODID:-//Apple Inc.//iPhone OS 17.0//EN',
  'N:Appleseed;John;;;',
  'FN:John Appleseed',
  'ORG:Apple Inc.;',
  'TITLE:Engineer',
  'EMAIL;type=INTERNET;type=HOME;type=pref:john@example.com',
  'item1.EMAIL;type=INTERNET:john@other.com',
  'item1.X-ABLabel:_$!<Other>!$_',
  'TEL;type=CELL;type=VOICE;type=pref:+1 (555) 123-4567',
  'item2.ADR;type=HOME;type=pref:;;1 Infinite Loop;Cupertino;CA;95014;United States',
  'item2.X-ABADR:us',
  'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcp',
  ' LCwxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIy',
  'X-SOMETHING-APPLE;x-param=1:keep me exactly',
  'UID:JOHN-UID',
  'REV:2023-01-15T10:20:30Z',
);
const FAMILY = vcard('FN:Family', 'X-ADDRESSBOOKSERVER-KIND:group', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:JOHN-UID', 'UID:FAMILY');
const BARE = vcard('FN:Bare', 'N:Bare;;;;', 'UID:BARE');

const CARDS = { 'JOHN-UID.vcf': JOHN, 'FAMILY.vcf': FAMILY, 'BARE.vcf': BARE };

describe('apple_contacts_create', () => {
  it('PUTs a new vCard 3.0 with If-None-Match *, re-reads it, and returns the verified record', async () => {
    const h = harness(CARDS);
    const r = await h.call('apple_contacts_create', {
      givenName: 'Ada',
      familyName: 'Lovelace',
      nickname: 'Countess',
      jobTitle: 'Analyst',
      note: 'Line one\nLine two',
      birthday: '1815-12-10',
      emails: [{ value: 'ada@x.com', label: 'home' }],
      phones: [{ value: '+44 20 1234 5678', label: 'mobile' }],
      urls: [{ value: 'https://ada.test' }],
      addresses: [{ street: '1 St', city: 'London', country: 'UK', label: 'work' }],
    });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ created: true, id: 'NEW-UID-1', verified: true });
    expect(r.json.warnings).toBeUndefined();
    expect(r.json.contact).toMatchObject({
      id: 'NEW-UID-1',
      name: 'Ada Lovelace',
      birthday: '1815-12-10',
      emails: [{ value: 'ada@x.com', label: 'home' }],
      lastModified: '2026-09-27T12:00:00-04:00',
    });
    const put = h.fake.calls.find((c) => c.method === 'PUT')!;
    expect(String(put.url)).toBe(`${BOOK}NEW-UID-1.vcf`);
    expect(put.headers).toMatchObject({ 'If-None-Match': '*', 'Content-Type': 'text/vcard; charset=utf-8' });
    expect(put.body).toContain('\r\nNOTE:Line one\\nLine two\r\n');
    expect(h.fake.log().slice(-2)).toEqual([`PUT /${DSID}/carddavhome/card/NEW-UID-1.vcf`, `GET /${DSID}/carddavhome/card/NEW-UID-1.vcf`]);
    // The next read sees it (the cached book was dropped).
    const s = await h.call('apple_contacts_search', { query: 'lovelace' });
    expect(s.json.total).toBe(1);
  });

  it('an organization-only contact, with a duplicate email reported as a warning', async () => {
    const h = harness(CARDS);
    const r = await h.call('apple_contacts_create', { organization: 'Acme', emails: [{ value: 'a@acme.test' }, { value: 'A@ACME.test' }] });
    expect(r.json).toMatchObject({ created: true, verified: true, contact: { name: 'Acme', isCompany: true } });
    expect(r.json.warnings).toEqual([expect.stringMatching(/^emails\[1\] was not added: this email is already on the contact/)]);
  });

  it('validates before touching iCloud', async () => {
    const h = harness(CARDS);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ nickname: 'x' }, /at least a givenName, a familyName or an organization/],
      [{ givenName: '  ' }, /at least a givenName/],
      [{ givenName: 'A', birthday: '2023-02-30' }, /birthday "2023-02-30" is not a valid date/],
      [{ givenName: 'A', birthday: '--02-30' }, /not a valid month and day/],
      [{ givenName: 'A', emails: [{ value: 'not-an-email' }] }, /emails\[0\]: "not-an-email" is not an email address/],
      [{ givenName: 'A', phones: [{ value: 'call me' }] }, /phones\[0\]: "call me" has no digits/],
      [{ givenName: 'A', urls: [{ value: 'a b' }] }, /urls\[0\]: "a b" is not a URL/],
    ];
    for (const [args, msg] of cases) {
      const r = await h.call('apple_contacts_create', args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.json.error.message).toMatch(msg);
    }
    expect(h.fake.calls).toHaveLength(0);
  });

  it('schema: no empty strings, entry shapes are strict, at most 20 entries', () => {
    const s = captureTools().get('apple_contacts_create')!.cfg.inputSchema;
    expect(s.safeParse({ givenName: 'A' }).success).toBe(true);
    expect(s.safeParse({ givenName: '' }).success).toBe(false);
    expect(s.safeParse({ givenName: 'A', birthday: '1990-1-1' }).success).toBe(false);
    expect(s.safeParse({ givenName: 'A', birthday: '--05-12' }).success).toBe(true);
    expect(s.safeParse({ givenName: 'A', emails: [{ value: 'a@x', extra: 1 }] }).success).toBe(false);
    expect(s.safeParse({ givenName: 'A', emails: [{ value: 'a\\b@x' }] }).success).toBe(false);
    expect(s.safeParse({ givenName: 'A', emails: [] }).success).toBe(false);
    expect(s.safeParse({ givenName: 'A', phones: Array.from({ length: 21 }, () => ({ value: '1' })) }).success).toBe(false);
    expect(s.safeParse({ givenName: 'A', addresses: [{ street: '' }] }).success).toBe(false);
    expect(s.safeParse({ givenName: 'A', addresses: [{ street: '1 St\nFloor 2', label: 'home' }] }).success).toBe(true);
    expect(s.safeParse({ givenName: 'A', note: 'tab\there\r\nok' }).success).toBe(true);
    expect(s.safeParse({ givenName: 'A\nB' }).success).toBe(false);
  });

  it('an unknown outcome names the id to check before retrying (a retry could duplicate)', async () => {
    const h = harness(CARDS);
    const { UnconfirmedWriteError } = await import('../../src/errors.js');
    const real = h.fake.request;
    const tools = captureTools({
      request: async (req) => {
        if (req.method === 'PUT') throw new UnconfirmedWriteError('contacts', 'contacts: PUT /x timed out; the change may have been applied.');
        return real(req);
      },
      newUid: () => 'UID-X',
    });
    const res = await tools.get('apple_contacts_create')!.cb({ givenName: 'A' }, {});
    const err = JSON.parse(res.content[0]!.text).error;
    expect(err.code).toBe('UNCONFIRMED_WRITE');
    expect(err.message).toContain('Check with apple_contacts_get (contactId "UID-X") before creating it again');
  });

  it('a definitive refusal is passed through as-is', async () => {
    const h = harness(CARDS);
    h.fake.fail({ method: 'PUT', status: 403 });
    const r = await h.call('apple_contacts_create', { givenName: 'A' });
    expect(r.json.error).toMatchObject({ code: 'UPSTREAM_ERROR', status: 403 });
  });

  it('not yet visible after the PUT → verified:false with a lag warning, showing what was written', async () => {
    const h = harness(CARDS);
    h.fake.hideAfterPut = true;
    const r = await h.call('apple_contacts_create', { givenName: 'Ada' });
    expect(r.json).toMatchObject({ created: true, verified: false, contact: { id: 'NEW-UID-1', name: 'Ada' } });
    expect(r.json.warnings).toEqual([expect.stringContaining('not visible yet')]);
  });

  it('iCloud storing something different → verified:false naming the field', async () => {
    const h = harness(CARDS);
    h.fake.onPut = (_name, body) => body.replace('FN:Ada', 'FN:Someone Else');
    const r = await h.call('apple_contacts_create', { givenName: 'Ada' });
    expect(r.json.verified).toBe(false);
    expect(r.json.warnings).toEqual(['After re-reading, name is not what was written: expected "Ada", iCloud has "Someone Else".']);
  });

  it('a failed re-read is a warning, not a failure of the write', async () => {
    const h = harness(CARDS);
    h.fake.fail({ method: 'GET', url: 'NEW-UID-1.vcf', status: 500 });
    const r = await h.call('apple_contacts_create', { givenName: 'Ada' });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ created: true, verified: false });
    expect(r.json.warnings[0]).toContain('re-reading the contact to verify it failed');
  });

  it('defaults: a random upper-case UUID and the real clock', async () => {
    const h = harness(CARDS);
    const tools = captureTools({ request: h.fake.request });
    const res = await tools.get('apple_contacts_create')!.cb({ givenName: 'Real' }, {});
    const out = JSON.parse(res.content[0]!.text);
    expect(out.id).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    expect(out.verified).toBe(true);
  });
});

describe('apple_contacts_update', () => {
  it('edits only the affected lines (photo, X- props and grouping byte-for-byte), bumps REV, sends If-Match', async () => {
    const h = harness(CARDS);
    const etag = h.fake.cards.get('JOHN-UID.vcf')!.etag;
    const r = await h.call('apple_contacts_update', {
      contactId: 'JOHN-UID',
      jobTitle: 'Senior Engineer',
      emails: [
        { action: 'replace', target: 'JOHN@OTHER.COM', value: 'john@new.com' },
        { action: 'remove', target: 'ghost@x.com' },
      ],
      phones: [{ action: 'add', value: '555 0100', label: 'gym' }],
    });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ updated: true, id: 'JOHN-UID', verified: true });
    expect(r.json.changes).toEqual([
      { field: 'jobTitle', before: 'Engineer', after: 'Senior Engineer' },
      expect.objectContaining({ field: 'emails', action: 'replace', status: 'applied', before: expect.objectContaining({ value: 'john@other.com', label: 'other' }), after: expect.objectContaining({ value: 'john@new.com', label: 'other' }) }),
      expect.objectContaining({ field: 'phones', action: 'add', after: expect.objectContaining({ value: '555 0100', label: 'gym' }) }),
    ]);
    expect(r.json.noops).toEqual([
      expect.objectContaining({ field: 'emails', index: 1, status: 'no-op', present: [expect.objectContaining({ value: 'john@example.com' }), expect.objectContaining({ value: 'john@new.com' })] }),
    ]);
    const put = h.fake.calls.find((c) => c.method === 'PUT')!;
    expect(put.headers!['If-Match']).toBe(etag);
    const expected = JOHN.replace('TITLE:Engineer', 'TITLE:Senior Engineer')
      .replace('item1.EMAIL;type=INTERNET:john@other.com', 'item1.EMAIL;type=INTERNET:john@new.com')
      .replace('REV:2023-01-15T10:20:30Z', 'REV:2026-09-27T16:00:00Z')
      .replace('END:VCARD', 'item3.TEL:555 0100\r\nitem3.X-ABLabel:gym\r\nEND:VCARD');
    expect(put.body).toBe(expected);
    expect(r.json.contact.jobTitle).toBe('Senior Engineer');
    expect(r.json.contact.groups).toBeUndefined();
  });

  it('name edits recompute FN and report the display-name change; "" clears a field; birthday set', async () => {
    const h = harness(CARDS);
    const r = await h.call('apple_contacts_update', { contactId: 'JOHN-UID', givenName: 'Jonathan', organization: '', birthday: '--02-29' });
    expect(r.json.changes).toEqual([
      { field: 'name', before: 'John Appleseed', after: 'Jonathan Appleseed' },
      { field: 'givenName', before: 'John', after: 'Jonathan' },
      { field: 'organization', before: 'Apple Inc.' },
      { field: 'birthday', after: '--02-29' },
    ]);
    const body = h.fake.cards.get('JOHN-UID.vcf')!.body;
    expect(body).toContain('\r\nFN:Jonathan Appleseed\r\n');
    expect(body).not.toContain('ORG:');
    expect(body).toContain('BDAY;X-APPLE-OMIT-YEAR=1604:1604-02-29');
  });

  it('addresses and URLs: replace merges, add, remove by entryId', async () => {
    const h = harness(CARDS);
    const got = await h.call('apple_contacts_get', { contactId: 'JOHN-UID' });
    const adr = got.json.addresses[0].entryId;
    const r = await h.call('apple_contacts_update', {
      contactId: 'JOHN-UID',
      addresses: [
        { action: 'replace', entryId: adr, street: '2 Apple Park Way', label: 'work' },
        { action: 'add', city: 'Austin', state: 'TX' },
      ],
      urls: [{ action: 'add', value: 'https://apple.com', label: 'homepage' }],
    });
    expect(r.json.verified).toBe(true);
    expect(r.json.contact.addresses.map((a: { formatted: string; label?: string }) => [a.formatted, a.label])).toEqual([
      ['2 Apple Park Way, Cupertino, CA 95014, United States', 'work'],
      ['Austin, TX', undefined],
    ]);
    const again = await h.call('apple_contacts_update', { contactId: 'JOHN-UID', addresses: [{ action: 'remove', target: 'austin, tx' }] });
    expect(again.json.changes[0]).toMatchObject({ field: 'addresses', action: 'remove', status: 'applied' });
  });

  it('nothing to change → updated:false, nothing written, no-ops listed', async () => {
    const h = harness(CARDS);
    const r = await h.call('apple_contacts_update', { contactId: 'JOHN-UID', jobTitle: 'Engineer', phones: [{ action: 'remove', target: '000-000-0000' }] });
    expect(r.json).toMatchObject({ updated: false, id: 'JOHN-UID', changes: [], contact: { jobTitle: 'Engineer' } });
    expect(r.json.noops).toHaveLength(1);
    expect(h.fake.calls.some((c) => c.method === 'PUT')).toBe(false);
    const quiet = await h.call('apple_contacts_update', { contactId: 'JOHN-UID', jobTitle: 'Engineer' });
    expect(quiet.json.noops).toBeUndefined();
  });

  it('a card changed since it was read → 412 → PreconditionFailed error telling to re-read', async () => {
    const h = harness(CARDS);
    const real = h.fake.request;
    const tools = captureTools({
      request: async (req) => {
        const res = await real(req);
        // Someone edits the card between our GET and our PUT.
        if (req.method === 'GET') h.fake.cards.set('JOHN-UID.vcf', { body: JOHN, etag: '"changed"' });
        return res;
      },
      now: () => new Date('2026-09-27T16:00:00Z'),
    });
    const res = await tools.get('apple_contacts_update')!.cb({ contactId: 'JOHN-UID', jobTitle: 'X' }, {});
    const err = JSON.parse(res.content[0]!.text).error;
    expect(err).toMatchObject({ code: 'UPSTREAM_ERROR', status: 412 });
    expect(err.message).toContain('changed on iCloud since it was read');
    expect(err.hint).toContain('Re-read');
  });

  it('without an ETag the PUT is unconditional and says so', async () => {
    const h = harness(CARDS);
    h.fake.sendEtags = false;
    const r = await h.call('apple_contacts_update', { contactId: 'BARE', jobTitle: 'Chef' });
    expect(r.json.updated).toBe(true);
    expect(r.json.warnings).toEqual([expect.stringContaining('no ETag')]);
    expect(h.fake.calls.find((c) => c.method === 'PUT')!.headers!['If-Match']).toBeUndefined();
  });

  it('verification catches what iCloud did not store', async () => {
    const h = harness(CARDS);
    h.fake.onPut = (_n, body) => body.replace('TITLE:Chef', 'TITLE:Cook');
    const r = await h.call('apple_contacts_update', { contactId: 'BARE', jobTitle: 'Chef' });
    expect(r.json.verified).toBe(false);
    expect(r.json.warnings).toEqual(['After re-reading, jobTitle is not what was written: expected "Chef", iCloud has "Cook".']);
    h.fake.onPut = (_n, body) => body.replace('EMAIL;type=INTERNET:x@y.z', '');
    const e = await h.call('apple_contacts_update', { contactId: 'BARE', emails: [{ action: 'add', value: 'x@y.z' }] });
    expect(e.json.warnings[0]).toContain('After re-reading, emails is not what was written');
    h.fake.onPut = (_n, body) => body.replace(';;1 St;;;;', ';;2 St;;;;');
    const a = await h.call('apple_contacts_update', { contactId: 'BARE', addresses: [{ action: 'add', street: '1 St' }] });
    expect(a.json.warnings[0]).toContain('addresses');
  });

  it('verification reports a dropped or a surviving field as null / its value', async () => {
    const h = harness({ 'NOTED.vcf': vcard('FN:Noted', 'N:Noted;;;;', 'NOTE:keep?', 'UID:NOTED') });
    h.fake.onPut = (_n, body) => body.replace('TITLE:Chef\r\n', '');
    const dropped = await h.call('apple_contacts_update', { contactId: 'NOTED', jobTitle: 'Chef' });
    expect(dropped.json.warnings).toEqual(['After re-reading, jobTitle is not what was written: expected "Chef", iCloud has null.']);
    h.fake.onPut = (_n, body) => body.replace('END:VCARD', 'NOTE:keep?\r\nEND:VCARD');
    const survived = await h.call('apple_contacts_update', { contactId: 'NOTED', note: '' });
    expect(survived.json.warnings).toEqual(['After re-reading, note is not what was written: expected null, iCloud has "keep?".']);
  });

  it('an edit that is not visible on re-read reports verified:false and shows what was written', async () => {
    const h = harness(CARDS);
    const real = h.fake.request;
    let put = false;
    const tools = captureTools({
      request: async (req) => {
        if (req.method === 'PUT') put = true;
        if (put && req.method === 'GET') throw new UpstreamError('contacts', 404, 'contacts: GET failed with HTTP 404');
        return real(req);
      },
      now: () => new Date('2026-09-27T16:00:00Z'),
    });
    const res = await tools.get('apple_contacts_update')!.cb({ contactId: 'BARE', jobTitle: 'Chef' }, {});
    const out = JSON.parse(res.content[0]!.text);
    expect(out).toMatchObject({ updated: true, verified: false, contact: { jobTitle: 'Chef' } });
    expect(out.warnings).toEqual([expect.stringContaining('not visible yet')]);
  });

  it('refuses groups, unknown ids, and an empty or contradictory request — before writing', async () => {
    const h = harness(CARDS);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ contactId: 'JOHN-UID' }, /Nothing to update/],
      [{ contactId: 'JOHN-UID', birthday: '1990-13-01' }, /not a valid date/],
      [{ contactId: 'JOHN-UID', emails: [{ action: 'add' }] }, /emails\[0\]: add needs a value/],
      [{ contactId: 'JOHN-UID', emails: [{ action: 'add', value: 'a@b.c', target: 'x' }] }, /add takes no target or entryId/],
      [{ contactId: 'JOHN-UID', phones: [{ action: 'remove' }] }, /phones\[0\]: remove needs exactly one of entryId/],
      [{ contactId: 'JOHN-UID', phones: [{ action: 'remove', target: '1', entryId: 'x' }] }, /needs exactly one/],
      [{ contactId: 'JOHN-UID', urls: [{ action: 'remove', target: 'x', value: 'y' }] }, /remove takes only entryId or target/],
      [{ contactId: 'JOHN-UID', urls: [{ action: 'remove', target: 'x', label: 'y' }] }, /remove takes only/],
      [{ contactId: 'JOHN-UID', emails: [{ action: 'replace', target: 'x' }] }, /replace needs a new value, a new label, or both/],
      [{ contactId: 'JOHN-UID', emails: [{ action: 'replace', target: 'x', value: 'bad' }] }, /is not an email address/],
      [{ contactId: 'JOHN-UID', addresses: [{ action: 'add', city: ' ' }] }, /addresses\[0\]: add needs at least one of/],
      [{ contactId: 'JOHN-UID', addresses: [{ action: 'remove', target: 'x', city: 'y' }] }, /remove takes only entryId or target \(no address fields/],
      [{ contactId: 'JOHN-UID', addresses: [{ action: 'remove', target: 'x', label: 'y' }] }, /remove takes only/],
      [{ contactId: 'JOHN-UID', addresses: [{ action: 'replace', target: 'x' }] }, /replace needs at least one address field or a label/],
      [{ contactId: 'JOHN-UID', addresses: [{ action: 'replace' , city: 'x' }] }, /needs exactly one of entryId/],
    ];
    for (const [args, msg] of cases) {
      const r = await h.call('apple_contacts_update', args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(r.json.error.message).toMatch(msg);
    }
    expect(h.fake.calls).toHaveLength(0);
    const grp = await h.call('apple_contacts_update', { contactId: 'FAMILY', jobTitle: 'x' });
    expect(grp.json.error.message).toContain('is the contact group "Family"');
    const nf = await h.call('apple_contacts_update', { contactId: 'NOPE', jobTitle: 'x' });
    expect(nf.json.error.code).toBe('NOT_FOUND');
    const unnamed = await h.call('apple_contacts_update', { contactId: 'BARE', familyName: '' });
    expect(unnamed.json.error.message).toContain('neither a name nor an organization');
    expect(h.fake.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('schema: "" allowed for scalars (clears), change objects strict, action required', () => {
    const s = captureTools().get('apple_contacts_update')!.cfg.inputSchema;
    expect(s.safeParse({ contactId: 'A', note: '' }).success).toBe(true);
    expect(s.safeParse({ contactId: 'A', birthday: '' }).success).toBe(true);
    expect(s.safeParse({ contactId: 'A', emails: [{ value: 'a@b.c' }] }).success).toBe(false);
    expect(s.safeParse({ contactId: 'A', emails: [{ action: 'upsert', value: 'a@b.c' }] }).success).toBe(false);
    expect(s.safeParse({ contactId: 'A', emails: [{ action: 'remove', entryId: 'bad id!' }] }).success).toBe(false);
    expect(s.safeParse({ contactId: 'A', emails: [{ action: 'remove', entryId: 'abc_-~2' }] }).success).toBe(true);
    expect(s.safeParse({ contactId: 'A', addresses: [{ action: 'replace', entryId: 'x', postalCode: '' }] }).success).toBe(true);
    expect(s.safeParse({ contactId: 'A', addresses: [{ action: 'add', city: 'x', value: 'y' }] }).success).toBe(false);
    expect(s.safeParse({ contactId: 'A', phones: [] }).success).toBe(false);
  });
});

describe('apple_contacts_delete', () => {
  it('phase 1 previews (name, organization, emails, phones, addresses) and deletes nothing', async () => {
    const h = harness(CARDS);
    const tool = h.tools.get('apple_contacts_delete')!;
    const p = await callPreview(tool.cb as never, { contactId: 'JOHN-UID' });
    expect(p.preview).toEqual({
      Contact: 'John Appleseed',
      Organization: 'Apple Inc.',
      'Job title': 'Engineer',
      Emails: 'john@example.com, john@other.com',
      Phones: '+1 (555) 123-4567',
      Addresses: '1 Infinite Loop, Cupertino, CA 95014, United States',
      'Contact id': 'JOHN-UID',
    });
    expect(h.fake.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(h.fake.cards.has('JOHN-UID.vcf')).toBe(true);
  });

  it('phase 2 re-reads, DELETEs with If-Match and verifies it is gone', async () => {
    const h = harness(CARDS);
    const tool = h.tools.get('apple_contacts_delete')!;
    const etag = h.fake.cards.get('JOHN-UID.vcf')!.etag;
    const res = await callConfirmed(tool.cb as never, { contactId: 'JOHN-UID' }, { clearMocks: false });
    const out = JSON.parse(res.content[0]!.text);
    expect(out).toEqual({ deleted: true, id: 'JOHN-UID', name: 'John Appleseed', verified: true });
    const del = h.fake.calls.find((c) => c.method === 'DELETE')!;
    expect(del.headers!['If-Match']).toBe(etag);
    expect(h.fake.cards.has('JOHN-UID.vcf')).toBe(false);
    const s = await h.call('apple_contacts_search', { query: 'john' });
    expect(s.json.total).toBe(0);
  });

  it('a token minted before the card changed is refused (bound to its ETag)', async () => {
    const h = harness(CARDS);
    const tool = h.tools.get('apple_contacts_delete')!;
    const p = await callPreview(tool.cb as never, { contactId: 'BARE' });
    h.fake.cards.set('BARE.vcf', { body: BARE.replace('FN:Bare', 'FN:Changed'), etag: '"new"' });
    const res = await tool.cb({ contactId: 'BARE', confirmToken: p.confirmToken }, NO_ELICIT_CTX);
    expect(res.content[0]!.text).toContain('DRAFT_CHANGED');
    expect(h.fake.cards.has('BARE.vcf')).toBe(true);
  });

  it('a minimal card previews only what it has; no ETag → unconditional DELETE; still visible → verified:false', async () => {
    const h = harness(CARDS);
    h.fake.sendEtags = false;
    h.fake.keepAfterDelete = true;
    const tool = h.tools.get('apple_contacts_delete')!;
    const p = await callPreview(tool.cb as never, { contactId: 'BARE' });
    expect(p.preview).toEqual({ Contact: 'Bare', 'Contact id': 'BARE' });
    const res = await callConfirmed(tool.cb as never, { contactId: 'BARE' });
    const out = JSON.parse(res.content[0]!.text);
    expect(out).toMatchObject({ deleted: true, verified: false, warnings: [expect.stringContaining('still returns the contact')] });
    expect(h.fake.calls.find((c) => c.method === 'DELETE')!.headers!['If-Match']).toBeUndefined();
  });

  it('a failed check after the delete is a warning', async () => {
    const h = harness(CARDS);
    const tool = h.tools.get('apple_contacts_delete')!;
    const { confirmToken } = await callPreview(tool.cb as never, { contactId: 'BARE' });
    const real = h.fake.request;
    let deleted = false;
    const tools = captureTools({
      request: async (req) => {
        if (req.method === 'DELETE') deleted = true;
        if (deleted && req.method === 'GET') throw new Error('network down');
        return real(req);
      },
    });
    const res = await tools.get('apple_contacts_delete')!.cb({ contactId: 'BARE', confirmToken }, NO_ELICIT_CTX);
    const out = JSON.parse(res.content[0]!.text);
    expect(out).toMatchObject({ deleted: true, verified: false });
    expect(out.warnings[0]).toContain('checking that the contact is gone failed: network down');
  });

  it('refuses a group id and a missing contact; elicitation-capable clients are asked', async () => {
    const h = harness(CARDS);
    const grp = await h.call('apple_contacts_delete', { contactId: 'FAMILY' });
    expect(grp.json.error.message).toContain('is the contact group');
    const nf = await h.call('apple_contacts_delete', { contactId: 'NOPE' });
    expect(nf.json.error.code).toBe('NOT_FOUND');
    const ask = await h.tools.get('apple_contacts_delete')!.cb({ contactId: 'BARE' }, CAN_ASK_CTX);
    expect((ask as { resultType?: string }).resultType).toBe('input_required');
    expect(JSON.stringify(ask)).toContain('Permanently delete the contact \\"Bare\\"');
    expect(h.fake.cards.has('BARE.vcf')).toBe(true);
  });
});

describe('review fixes: write tools', () => {
  it('create refuses an address with no components (it used to write an empty ADR:;;;;;; line)', async () => {
    const h = harness(CARDS);
    for (const addresses of [[{ label: 'home' }], [{ city: '  ' }], [{ street: '1 St' }, {}]]) {
      const r = await h.call('apple_contacts_create', { givenName: 'A', addresses });
      expect(r.isError, JSON.stringify(addresses)).toBe(true);
      expect(r.json.error.message).toMatch(/addresses\[\d\]: an address needs at least one of street/);
    }
    expect(h.fake.calls).toHaveLength(0);
  });

  it('update: entryIds of identical entries name the entries the caller read, across the whole request', async () => {
    const card = vcard('N:Dup;Dee;;;', 'FN:Dee Dup', 'EMAIL;type=INTERNET;type=HOME:d@x.com', 'EMAIL;type=INTERNET;type=WORK:d@x.com', 'EMAIL;type=INTERNET;type=OTHER:d@x.com', 'UID:DUP');
    const h = harness({ 'DUP.vcf': card });
    const got = await h.call('apple_contacts_get', { contactId: 'DUP' });
    const [home, work] = got.json.emails as Array<{ entryId: string; label: string }>;
    expect([home!.label, work!.label]).toEqual(['home', 'work']);
    const r = await h.call('apple_contacts_update', {
      contactId: 'DUP',
      emails: [
        { action: 'remove', entryId: home!.entryId },
        { action: 'remove', entryId: work!.entryId },
      ],
    });
    expect(r.json).toMatchObject({ updated: true, verified: true });
    expect(r.json.contact.emails.map((e: { label: string }) => e.label)).toEqual(['other']);
  });

  it('update: re-sending the current name keeps a custom display name — nothing is written', async () => {
    const card = vcard('N:Appleseed;John;;;', 'FN:Johnny A.', 'UID:CUSTOM');
    const h = harness({ 'CUSTOM.vcf': card });
    const r = await h.call('apple_contacts_update', { contactId: 'CUSTOM', givenName: 'John', familyName: 'Appleseed' });
    expect(r.json).toMatchObject({ updated: false, contact: { name: 'Johnny A.' } });
    expect(h.fake.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('update and delete answer with the card\'s own id when the argument differed in case or carried .vcf', async () => {
    const h = harness(CARDS);
    const u = await h.call('apple_contacts_update', { contactId: 'bare.vcf', jobTitle: 'Chef' });
    expect(u.json).toMatchObject({ updated: true, id: 'BARE', contact: { id: 'BARE' } });
    const tool = h.tools.get('apple_contacts_delete')!;
    const p = await callPreview(tool.cb as never, { contactId: 'bare' });
    expect(p.preview['Contact id']).toBe('BARE');
    const res = await tool.cb({ contactId: 'bare', confirmToken: p.confirmToken }, NO_ELICIT_CTX);
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ deleted: true, id: 'BARE', verified: true });
  });
});
