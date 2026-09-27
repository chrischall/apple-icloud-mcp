import { describe, expect, it } from 'vitest';
import {
  PRODID,
  addressComponents,
  applyAddressChange,
  applyLabel,
  applyScalars,
  applyValueChange,
  buildNewCard,
  digitsOf,
  labelSpec,
  sameValue,
  setRev,
} from '../../src/contacts/edit.js';
import { addressEntries, readContact, readOrg, valueEntries } from '../../src/contacts/model.js';
import { VCard } from '../../src/contacts/vcard.js';
import { InvalidArgumentError } from '../../src/errors.js';
import { vcard } from './fake-icloud.js';

const parse = (...lines: string[]) => VCard.parse(vcard(...lines))!;
const body = (c: VCard) => c.toString().split('\r\n').slice(2, -2); // between VERSION and END

describe('labelSpec', () => {
  it('maps standard labels to TYPEs and everything else to an X-ABLabel', () => {
    expect(labelSpec('phone', 'Mobile')).toEqual({ types: ['CELL', 'VOICE'] });
    expect(labelSpec('phone', 'iPhone')).toEqual({ types: ['IPHONE', 'CELL', 'VOICE'] });
    expect(labelSpec('email', ' work ')).toEqual({ types: ['WORK'] });
    expect(labelSpec('email', 'mobile')).toEqual({ abLabel: '_$!<Mobile>!$_' });
    expect(labelSpec('url', 'homepage')).toEqual({ abLabel: '_$!<HomePage>!$_' });
    expect(labelSpec('address', 'other')).toEqual({ abLabel: '_$!<Other>!$_' });
    expect(labelSpec('phone', ' Gym, pool ')).toEqual({ abLabel: 'Gym, pool' });
  });
});

describe('applyLabel', () => {
  it('a TYPE label replaces label TYPEs, keeps INTERNET/pref and other params in place', () => {
    const c = parse('EMAIL;X-Keep=1;TYPE=INTERNET,HOME;type=pref:a@x.com');
    applyLabel(c, c.first('EMAIL')!, 'email', 'work');
    expect(body(c)).toEqual(['EMAIL;X-Keep=1;type=INTERNET;type=WORK;type=pref:a@x.com']);
  });

  it('a line with no TYPE params gets them appended after other params', () => {
    const c = parse('TEL;X-Keep=1:555');
    applyLabel(c, c.first('TEL')!, 'phone', 'home');
    expect(body(c)).toEqual(['TEL;X-Keep=1;type=HOME;type=VOICE:555']);
  });

  it('a TYPE label on a grouped line drops its X-ABLabel (keeping the group and X-ABADR)', () => {
    const c = parse('item1.ADR:;;1 St;;;;', 'item1.X-ABLabel:_$!<Other>!$_', 'item1.X-ABADR:us');
    applyLabel(c, c.first('ADR')!, 'address', 'home');
    expect(body(c)).toEqual(['item1.ADR;type=HOME:;;1 St;;;;', 'item1.X-ABADR:us']);
  });

  it('a custom label rewrites the existing X-ABLabel (dropping duplicates) and strips label TYPEs', () => {
    const c = parse('item2.TEL;type=CELL:555', 'item2.X-ABLabel:old', 'item2.X-ABLabel:dup');
    applyLabel(c, c.first('TEL')!, 'phone', 'Gym, pool');
    expect(body(c)).toEqual(['item2.TEL:555', 'item2.X-ABLabel:Gym\\, pool']);
  });

  it('a custom label on an ungrouped line puts it in a fresh group with an X-ABLabel after it', () => {
    const c = parse('item4.EMAIL:z@x.com', 'EMAIL;type=INTERNET;type=HOME:a@x.com', 'NOTE:x');
    applyLabel(c, c.all('EMAIL')[1]!, 'email', 'other');
    expect(body(c)).toEqual(['item4.EMAIL:z@x.com', 'item5.EMAIL;type=INTERNET:a@x.com', 'item5.X-ABLabel:_$!<Other>!$_', 'NOTE:x']);
  });

  it('a custom label on a grouped line without an X-ABLabel inserts one in that group', () => {
    const c = parse('item3.ADR:;;1 St;;;;', 'item3.X-ABADR:us');
    applyLabel(c, c.first('ADR')!, 'address', 'school');
    expect(body(c)).toEqual(['item3.ADR:;;1 St;;;;', 'item3.X-ABLabel:_$!<School>!$_', 'item3.X-ABADR:us']);
  });

  it('"" clears the label: label TYPEs and X-ABLabel both go', () => {
    const c = parse('item1.EMAIL;type=INTERNET;type=HOME:a@x.com', 'item1.X-ABLabel:x');
    applyLabel(c, c.first('EMAIL')!, 'email', ' ');
    expect(body(c)).toEqual(['item1.EMAIL;type=INTERNET:a@x.com']);
  });
});

describe('matching helpers', () => {
  it('digitsOf / sameValue', () => {
    expect(digitsOf('+1 (555) 123-4567')).toBe('15551234567');
    expect(sameValue('phone', '555-1234', '(555) 1234')).toBe(true);
    expect(sameValue('phone', 'call me', 'CALL ME')).toBe(true);
    expect(sameValue('phone', 'call me', '555')).toBe(false);
    expect(sameValue('email', ' A@X.com', 'a@x.COM ')).toBe(true);
  });

  it('addressComponents lists the set fields in ADR order', () => {
    expect(addressComponents({ country: 'US', street: '1 St', city: '' })).toEqual([
      ['street', '1 St'],
      ['city', ''],
      ['country', 'US'],
    ]);
  });
});

describe('applyValueChange', () => {
  const card = () =>
    parse(
      'EMAIL;type=INTERNET;type=HOME:a@x.com',
      'item1.EMAIL;type=INTERNET:b@x.com',
      'item1.X-ABLabel:_$!<Other>!$_',
      'EMAIL:dup@x.com',
      'EMAIL:dup@x.com',
      'TEL;type=CELL:+1 (555) 123-4567',
      'TEL:+44 555 123 4567',
      'TEL:12345',
    );

  it('add appends a labelled entry; an existing value is a no-op naming its entryId', () => {
    const c = card();
    const out = applyValueChange(c, 'email', { action: 'add', value: ' new@x.com ', label: 'work' }, 0);
    expect(out).toMatchObject({ field: 'emails', index: 0, action: 'add', status: 'applied', after: { value: 'new@x.com', label: 'work' } });
    expect(c.toString()).toContain('EMAIL;type=INTERNET;type=WORK:new@x.com\r\nEND:VCARD');
    const dup = applyValueChange(c, 'email', { action: 'add', value: 'A@X.COM' }, 1);
    expect(dup.status).toBe('no-op');
    expect(dup.reason).toContain('already on the contact');
    const plain = applyValueChange(c, 'url', { action: 'add', value: 'https://x.test', label: '' }, 2);
    expect(plain.after).toEqual({ entryId: plain.entryId, value: 'https://x.test' });
  });

  it('remove by target removes every match (with group siblings); by entryId exactly one', () => {
    const c = card();
    const both = applyValueChange(c, 'email', { action: 'remove', target: 'DUP@x.com' }, 0);
    expect(both.status).toBe('applied');
    expect(Array.isArray(both.before)).toBe(true);
    const id = valueEntries(c, 'email')[1]!.entry.entryId;
    const one = applyValueChange(c, 'email', { action: 'remove', entryId: id }, 1);
    expect(one).toMatchObject({ status: 'applied', entryId: id, before: { value: 'b@x.com', label: 'other' } });
    expect(c.toString()).not.toContain('X-ABLabel');
    expect(valueEntries(c, 'email').map((e) => e.entry.value)).toEqual(['a@x.com']);
  });

  it('an absent target is a no-op that lists what IS present', () => {
    const c = card();
    const byTarget = applyValueChange(c, 'email', { action: 'remove', target: 'nobody@x.com' }, 3);
    expect(byTarget).toMatchObject({ status: 'no-op', index: 3 });
    expect(byTarget.reason).toContain('matches "nobody@x.com"');
    expect(byTarget.present!.map((p) => (p as { value: string }).value)).toEqual(['a@x.com', 'b@x.com', 'dup@x.com', 'dup@x.com']);
    const byId = applyValueChange(c, 'phone', { action: 'replace', entryId: 'nope', value: '1' }, 0);
    expect(byId.reason).toContain('entryId "nope"');
  });

  it('phones match by digits, then by a unique ≥10-digit suffix (country code), never by short suffixes', () => {
    const c = card();
    expect(applyValueChange(c, 'phone', { action: 'replace', target: '555.123.4567', label: 'work' }, 0).status).toBe('no-op'); // ambiguous suffix (+1 and +44)
    expect(applyValueChange(c, 'phone', { action: 'replace', target: '15551234567', label: 'work' }, 0).status).toBe('applied');
    expect(applyValueChange(c, 'phone', { action: 'replace', target: '445551234567', label: 'home' }, 0).status).toBe('applied'); // exact digits
  });

  it('replace changes value and/or label; the same value+label is a no-op; several matches is a no-op', () => {
    const c = card();
    const r = applyValueChange(c, 'email', { action: 'replace', target: 'b@x.com', value: 'b2@x.com' }, 0);
    expect(r).toMatchObject({ status: 'applied', before: { value: 'b@x.com', label: 'other' }, after: { value: 'b2@x.com', label: 'other' } });
    expect(c.toString()).toContain('item1.EMAIL;type=INTERNET:b2@x.com\r\nitem1.X-ABLabel:_$!<Other>!$_');
    const l = applyValueChange(c, 'email', { action: 'replace', target: 'a@x.com', label: 'work' }, 1);
    expect(l.after).toMatchObject({ value: 'a@x.com', label: 'work' });
    const same = applyValueChange(c, 'email', { action: 'replace', target: 'a@x.com', value: 'a@x.com', label: 'work' }, 2);
    expect(same).toMatchObject({ status: 'no-op', reason: 'the entry already has that value and label' });
    const amb = applyValueChange(c, 'email', { action: 'replace', target: 'dup@x.com', value: 'z@x.com' }, 3);
    expect(amb).toMatchObject({ status: 'no-op' });
    expect(amb.reason).toContain('2 email entries match');
  });
});

describe('phone suffix matching', () => {
  it('matches a national number against its international form when unique', () => {
    const c = parse('TEL:+1 (555) 123-4567', 'TEL:123-4567');
    const out = applyValueChange(c, 'phone', { action: 'remove', target: '555-123-4567' }, 0);
    expect(out).toMatchObject({ status: 'applied', before: { value: '+1 (555) 123-4567' } });
    // A short target never suffix-matches.
    expect(applyValueChange(c, 'phone', { action: 'remove', target: '4567' }, 1).status).toBe('no-op');
    // The target may also be the longer one.
    const c2 = parse('TEL:555-123-4567');
    expect(applyValueChange(c2, 'phone', { action: 'remove', target: '+1 555 123 4567' }, 0).status).toBe('applied');
  });
});

describe('applyAddressChange', () => {
  const card = () =>
    parse(
      'item1.ADR;type=HOME:;;1 Main St;Springfield;IL;62701;USA',
      'item1.X-ABADR:us',
      'ADR;type=WORK:;;2 Office Rd;Chicago',
      'ADR:;;9 Dup;X;;;',
      'ADR:;;9 Dup;X;;;',
    );

  it('add writes the seven components escaped; a duplicate address is a no-op', () => {
    const c = card();
    const out = applyAddressChange(c, { action: 'add', street: '3 A; B\nFloor 2', city: 'Paris', country: 'France', label: 'other' }, 0);
    expect(out.status).toBe('applied');
    expect(c.toString()).toContain('item2.ADR:;;3 A\\; B\\nFloor 2;Paris;;;France\r\nitem2.X-ABLabel:_$!<Other>!$_');
    const dup = applyAddressChange(c, { action: 'add', street: '1 main st', city: 'springfield', state: 'IL', postalCode: '62701', country: 'usa' }, 1);
    expect(dup.status).toBe('no-op');
    expect(dup.reason).toContain('already on the contact');
  });

  it('replace merges components ("" clears one), keeps the rest byte-exact, and pads short ADR values', () => {
    const c = card();
    const r = applyAddressChange(c, { action: 'replace', target: '1 MAIN ST', street: '5 New St', postalCode: '' }, 0);
    expect(r).toMatchObject({ status: 'applied', before: { street: '1 Main St', postalCode: '62701' }, after: { street: '5 New St', city: 'Springfield' } });
    expect(c.toString()).toContain('item1.ADR;type=HOME:;;5 New St;Springfield;IL;;USA\r\nitem1.X-ABADR:us');
    const padded = applyAddressChange(c, { action: 'replace', target: '2 Office Rd, Chicago', country: 'US' }, 1);
    expect(padded.status).toBe('applied');
    expect(c.toString()).toContain('ADR;type=WORK:;;2 Office Rd;Chicago;;;US');
  });

  it('replace of the label only; same content is a no-op; ambiguous and absent targets are no-ops', () => {
    const c = card();
    const id = addressEntries(c)[1]!.entry.entryId;
    expect(applyAddressChange(c, { action: 'replace', entryId: id, label: 'home' }, 0).after).toMatchObject({ label: 'home' });
    expect(applyAddressChange(c, { action: 'replace', entryId: id, label: 'home' }, 1).status).toBe('no-op');
    const amb = applyAddressChange(c, { action: 'replace', target: '9 dup', city: 'Y' }, 2);
    expect(amb.reason).toContain('2 addresses match');
    const none = applyAddressChange(c, { action: 'remove', target: 'nowhere' }, 3);
    expect(none.status).toBe('no-op');
    expect(none.present).toHaveLength(4);
    const noStreet = parse('ADR:;;;Paris;;;France');
    expect(applyAddressChange(noStreet, { action: 'remove', target: 'Paris' }, 0).status).toBe('no-op');
    expect(applyAddressChange(noStreet, { action: 'remove', target: 'paris, FRANCE' }, 0).status).toBe('applied');
  });

  it('remove by entryId (with group siblings) and by target (every match)', () => {
    const c = card();
    const id = addressEntries(c)[0]!.entry.entryId;
    expect(applyAddressChange(c, { action: 'remove', entryId: id }, 0)).toMatchObject({ status: 'applied', entryId: id });
    expect(c.toString()).not.toContain('X-ABADR');
    const both = applyAddressChange(c, { action: 'remove', target: '9 Dup, X' }, 1);
    expect(Array.isArray(both.before)).toBe(true);
    expect(addressEntries(c)).toHaveLength(1);
  });
});

describe('applyScalars', () => {
  it('edits N components in place, recomputes FN, and leaves untouched components byte-exact', () => {
    const c = parse('N:O\\,Brien;Pat;;Dr.;', 'FN:Dr. Pat O,Brien', 'ORG:Acme;Sales');
    applyScalars(c, { givenName: 'Patricia', middleName: 'Q' });
    expect(body(c)).toEqual(['N:O\\,Brien;Patricia;Q;Dr.;', 'FN:Dr. Patricia Q O\\,Brien', 'ORG:Acme;Sales']);
  });

  it('creates N, FN and ORG when missing; clearing the organization entirely removes ORG', () => {
    const c = parse('UID:1');
    applyScalars(c, { familyName: 'Doe', organization: 'Acme', department: 'R&D' });
    expect(body(c)).toEqual(['UID:1', 'N:Doe;;;;', 'ORG:Acme;R&D', 'FN:Doe']);
    applyScalars(c, { organization: '', department: '' });
    expect(body(c)).toEqual(['UID:1', 'N:Doe;;;;', 'FN:Doe']);
  });

  it('an unchanged value writes nothing', () => {
    const text = vcard('N:Doe;Jane;;;', 'FN:Jane Doe', 'TITLE:CEO', 'ORG:Acme;');
    const c = VCard.parse(text)!;
    applyScalars(c, { givenName: 'Jane', jobTitle: 'CEO', organization: 'Acme', birthday: '' });
    expect(c.toString()).toBe(text);
    const withBday = vcard('FN:x', 'BDAY:1990-01-01');
    const b = VCard.parse(withBday)!;
    applyScalars(b, { birthday: '1990-01-01' });
    expect(b.toString()).toBe(withBday);
  });

  it('refuses to leave a card with neither a name nor an organization', () => {
    const c = parse('N:Doe;;;;', 'FN:Doe');
    expect(() => applyScalars(c, { familyName: '' })).toThrow(InvalidArgumentError);
  });

  it('sets, replaces and clears single text fields (escaped; newlines in notes)', () => {
    const c = parse('FN:x', 'TITLE:Old', 'NOTE:a', 'NOTE:b');
    applyScalars(c, { jobTitle: 'New, better', nickname: 'Nick', note: '' });
    expect(body(c)).toEqual(['FN:x', 'TITLE:New\\, better', 'NICKNAME:Nick']);
    applyScalars(c, { note: 'l1\nl2', nickname: '' });
    expect(body(c)).toEqual(['FN:x', 'TITLE:New\\, better', 'NOTE:l1\\nl2']);
  });

  it('birthday: set (full / no year), replace in place, drop duplicates, clear', () => {
    const c = parse('FN:x');
    applyScalars(c, { birthday: '1990-02-03' });
    expect(body(c)).toEqual(['FN:x', 'BDAY;value=date:1990-02-03']);
    applyScalars(c, { birthday: '--05-12' });
    expect(body(c)).toEqual(['FN:x', 'BDAY;X-APPLE-OMIT-YEAR=1604:1604-05-12']);
    const d = parse('FN:x', 'item1.BDAY:1990-01-01', 'BDAY:1991-01-01');
    applyScalars(d, { birthday: '1990-01-01' }); // same value, but a duplicate line → rewritten
    expect(body(d)).toEqual(['FN:x', 'item1.BDAY;value=date:1990-01-01']);
    applyScalars(d, { birthday: '' });
    expect(body(d)).toEqual(['FN:x']);
  });
});

describe('setRev', () => {
  it('replaces REV in place, or appends one', () => {
    const now = new Date('2026-09-27T16:00:00.500Z');
    const a = parse('FN:x', 'REV:2020-01-01T00:00:00Z', 'NOTE:y');
    setRev(a, now);
    expect(body(a)).toEqual(['FN:x', 'REV:2026-09-27T16:00:00Z', 'NOTE:y']);
    const b = parse('FN:x');
    setRev(b, now);
    expect(body(b)).toEqual(['FN:x', 'REV:2026-09-27T16:00:00Z']);
  });
});

describe('buildNewCard', () => {
  const now = new Date('2026-09-27T16:00:00Z');

  it('writes a vCard 3.0 person card with labelled entries, skipping duplicates', () => {
    const { card, skipped } = buildNewCard(
      {
        givenName: 'Ada',
        familyName: 'Lovelace',
        organization: 'Analytical Engines',
        emails: [{ value: 'ada@x.com', label: 'home' }, { value: 'ADA@x.com' }],
        phones: [{ value: '+44 20 1234 5678', label: 'mobile' }],
        urls: [{ value: 'https://ada.test', label: 'homepage' }],
        addresses: [{ street: '1 St', city: 'London', label: 'work' }],
        birthday: '1815-12-10',
      },
      'UID-1',
      now,
    );
    expect(card.toString()).toBe(
      [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `PRODID:${PRODID}`,
        'N:Lovelace;Ada;;;',
        'FN:Ada Lovelace',
        'UID:UID-1',
        'ORG:Analytical Engines;',
        'BDAY;value=date:1815-12-10',
        'EMAIL;type=INTERNET;type=HOME:ada@x.com',
        'TEL;type=CELL;type=VOICE:+44 20 1234 5678',
        'item1.URL:https://ada.test',
        'item1.X-ABLabel:_$!<HomePage>!$_',
        'ADR;type=WORK:;;1 St;London;;;',
        'REV:2026-09-27T16:00:00Z',
        'END:VCARD',
        '',
      ].join('\r\n'),
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ field: 'emails', index: 1, status: 'no-op' });
  });

  it('no organization and no name: no company flag (the tool refuses this before building)', () => {
    const { card } = buildNewCard({ nickname: 'x' }, 'U', now);
    expect(card.toString()).not.toContain('X-ABShowAs');
  });

  it('an organization-only card is shown as a company', () => {
    const { card } = buildNewCard({ organization: 'Acme' }, 'U', now);
    const v = readContact(card);
    expect(v).toMatchObject({ name: 'Acme', isCompany: true, organization: 'Acme' });
    expect(card.toString()).toContain('X-ABShowAs:COMPANY');
  });
});

describe('review fixes: FN is rewritten only when the composed name changes', () => {
  it('a name edit that changes nothing leaves a custom FN alone (it used to be rewritten to "Given Family")', () => {
    const text = vcard('N:Appleseed;John;;;', 'FN:Johnny Appleseed', 'ORG:Acme;');
    const c = VCard.parse(text)!;
    applyScalars(c, { givenName: 'John', familyName: 'Appleseed' });
    expect(c.toString()).toBe(text);
  });

  it('an organization change on a person card keeps a custom FN; on a company card it follows the company', () => {
    const person = parse('N:Appleseed;John;;;', 'FN:Appleseed John', 'ORG:Acme;');
    applyScalars(person, { organization: 'NewCo' });
    expect(body(person)).toEqual(['N:Appleseed;John;;;', 'FN:Appleseed John', 'ORG:NewCo;']);
    const company = parse('N:;;;;', 'FN:Acme', 'ORG:Acme;', 'X-ABShowAs:COMPANY');
    applyScalars(company, { organization: 'Acme Corp' });
    expect(body(company)).toEqual(['N:;;;;', 'FN:Acme Corp', 'ORG:Acme Corp;', 'X-ABShowAs:COMPANY']);
  });

  it('a real name change replaces even a custom FN; an org change fills an EMPTY FN; a derived FN follows the org', () => {
    const renamed = parse('N:Appleseed;John;;;', 'FN:Johnny');
    applyScalars(renamed, { givenName: 'Jon' });
    expect(body(renamed)).toEqual(['N:Appleseed;Jon;;;', 'FN:Jon Appleseed']);
    const empty = parse('N:Doe;Jane;;;', 'FN:');
    applyScalars(empty, { department: 'Sales' });
    expect(body(empty)).toEqual(['N:Doe;Jane;;;', 'FN:Jane Doe', 'ORG:;Sales']);
    const orgOnly = parse('FN:Acme', 'ORG:Acme;');
    applyScalars(orgOnly, { organization: 'Acme Two' });
    expect(body(orgOnly)).toEqual(['FN:Acme Two', 'ORG:Acme Two;']);
  });
});

describe('review fixes: the department of an ORG with more than two units', () => {
  // readOrg shows every unit after the organization as the department, so an
  // edit must replace all of them — otherwise what is stored is not what was asked.
  it('clearing the department clears every unit after the organization', () => {
    const c = parse('N:Doe;Jane;;;', 'FN:Jane Doe', 'ORG:Acme;Eng;Platform');
    expect(readOrg(c)).toEqual({ organization: 'Acme', department: 'Eng, Platform' });
    applyScalars(c, { department: '' });
    expect(body(c)).toEqual(['N:Doe;Jane;;;', 'FN:Jane Doe', 'ORG:Acme;']);
    expect(readOrg(c).department).toBe('');
  });

  it('a new department replaces every unit, even one equal to the current first unit', () => {
    const c = parse('N:Doe;Jane;;;', 'FN:Jane Doe', 'ORG:Acme;Eng;Platform');
    applyScalars(c, { department: 'Sales' });
    expect(body(c)).toEqual(['N:Doe;Jane;;;', 'FN:Jane Doe', 'ORG:Acme;Sales']);
    const same = parse('N:Doe;Jane;;;', 'FN:Jane Doe', 'ORG:Acme;Eng;Platform');
    applyScalars(same, { department: 'Eng' });
    expect(body(same)).toEqual(['N:Doe;Jane;;;', 'FN:Jane Doe', 'ORG:Acme;Eng']);
  });

  it('the department as shown is left exactly as stored (units and all), also beside an organization change', () => {
    const c = parse('N:Doe;Jane;;;', 'FN:Jane Doe', 'ORG:Acme;Eng;Platform');
    applyScalars(c, { organization: 'NewCo', department: 'Eng, Platform' });
    expect(body(c)).toEqual(['N:Doe;Jane;;;', 'FN:Jane Doe', 'ORG:NewCo;Eng;Platform']);
    expect(readOrg(c)).toEqual({ organization: 'NewCo', department: 'Eng, Platform' });
    const untouched = vcard('N:Doe;Jane;;;', 'FN:Jane Doe', 'ORG:Acme;Eng;Platform');
    const u = VCard.parse(untouched)!;
    applyScalars(u, { department: ' Eng, Platform ' });
    expect(u.toString()).toBe(untouched);
  });

  it('clearing organization and department removes the ORG line', () => {
    const c = parse('N:Doe;Jane;;;', 'FN:Jane Doe', 'ORG:Acme;Eng;Platform');
    applyScalars(c, { organization: '', department: '' });
    expect(body(c)).toEqual(['N:Doe;Jane;;;', 'FN:Jane Doe']);
  });
});

describe('review fixes: NICKNAME is one value', () => {
  it('setting it drops the other NICKNAME lines (all of them are read, so they would still show)', () => {
    const c = parse('FN:x', 'NICKNAME:Bobby', 'NICKNAME:B');
    applyScalars(c, { nickname: 'Bob' });
    expect(body(c)).toEqual(['FN:x', 'NICKNAME:Bob']);
    expect(readContact(c).nickname).toBe('Bob');
  });
});

describe('review fixes: entryIds resolve against the card as the caller read it', () => {
  const three = () => parse('EMAIL;type=HOME:a@x.com', 'EMAIL;type=WORK:a@x.com', 'item1.EMAIL:a@x.com', 'item1.X-ABLabel:gym');
  const labels = (c: VCard) => valueEntries(c, 'email').map((e) => e.entry.label);

  it('without a snapshot, removing `id` renumbers `id~2`/`id~3` (the old behaviour this guards against)', () => {
    const c = parse('EMAIL;type=HOME:a@x.com', 'EMAIL;type=WORK:a@x.com', 'EMAIL;type=OTHER:a@x.com');
    const ids = valueEntries(c, 'email').map((e) => e.entry.entryId);
    applyValueChange(c, 'email', { action: 'remove', entryId: ids[0] }, 0);
    applyValueChange(c, 'email', { action: 'remove', entryId: ids[1] }, 1);
    expect(labels(c)).toEqual(['work']); // the OTHER entry went, not WORK
  });

  it('with the snapshot, `id` then `id~2` removes exactly the first two entries the caller saw', () => {
    const c = parse('EMAIL;type=HOME:a@x.com', 'EMAIL;type=WORK:a@x.com', 'EMAIL;type=OTHER:a@x.com');
    const initial = valueEntries(c, 'email');
    const ids = initial.map((e) => e.entry.entryId);
    expect(ids[1]).toBe(`${ids[0]}~2`);
    const first = applyValueChange(c, 'email', { action: 'remove', entryId: ids[0] }, 0, initial);
    const second = applyValueChange(c, 'email', { action: 'remove', entryId: ids[1] }, 1, initial);
    expect(first).toMatchObject({ status: 'applied', before: { label: 'home' } });
    expect(second).toMatchObject({ status: 'applied', before: { label: 'work' } });
    expect(labels(c)).toEqual(['other']);
  });

  it('a later change still finds an entry an earlier one relabelled into a new group (its id changed)', () => {
    const c = parse('EMAIL:a@x.com', 'EMAIL:b@x.com');
    const initial = valueEntries(c, 'email');
    const aId = initial[0]!.entry.entryId;
    applyValueChange(c, 'email', { action: 'replace', entryId: aId, label: 'gym' }, 0, initial);
    expect(valueEntries(c, 'email')[0]!.entry.entryId).not.toBe(aId);
    const out = applyValueChange(c, 'email', { action: 'replace', entryId: aId, value: 'a2@x.com' }, 1, initial);
    expect(out).toMatchObject({ status: 'applied', after: { value: 'a2@x.com', label: 'gym' } });
  });

  it('an entry an earlier change removed is a reported no-op, for values and addresses alike', () => {
    const c = three();
    const initial = valueEntries(c, 'email');
    const id = initial[2]!.entry.entryId;
    applyValueChange(c, 'email', { action: 'remove', entryId: id }, 0, initial);
    const again = applyValueChange(c, 'email', { action: 'replace', entryId: id, value: 'z@x.com' }, 1, initial);
    expect(again).toMatchObject({ status: 'no-op', index: 1 });
    expect(again.reason).toContain('already removed by an earlier change in this request');
    expect(again.present).toHaveLength(2);
    const unknown = applyValueChange(c, 'email', { action: 'remove', entryId: 'nope' }, 2, initial);
    expect(unknown.reason).toContain('has entryId "nope"');

    const a = parse('ADR:;;1 St;A;;;', 'ADR:;;2 St;B;;;');
    const adrs = addressEntries(a);
    const adrId = adrs[0]!.entry.entryId;
    expect(applyAddressChange(a, { action: 'remove', entryId: adrId }, 0, adrs).status).toBe('applied');
    const gone = applyAddressChange(a, { action: 'replace', entryId: adrId, city: 'C' }, 1, adrs);
    expect(gone).toMatchObject({ status: 'no-op' });
    expect(gone.reason).toContain('address with entryId');
    expect(applyAddressChange(a, { action: 'replace', entryId: adrs[1]!.entry.entryId, city: 'C' }, 2, adrs).status).toBe('applied');
  });
});

describe('review fixes: address targets never reach an address nobody named', () => {
  it('removing by a street shared by two DIFFERENT addresses is an ambiguity no-op', () => {
    const c = parse('ADR;type=HOME:;;1 Main St;Springfield;;;', 'ADR;type=WORK:;;1 Main St;Shelbyville;;;');
    const out = applyAddressChange(c, { action: 'remove', target: '1 main st' }, 0);
    expect(out).toMatchObject({ status: 'no-op' });
    expect(out.reason).toBe('2 addresses match "1 main st"; pass the entryId of the one to remove');
    expect(addressEntries(c)).toHaveLength(2);
  });

  it('a target of only spaces and commas matches nothing (it used to match every street-less address)', () => {
    const c = parse('ADR:;;;Paris;;;France', 'ADR:;;;Lyon;;;France');
    expect(applyAddressChange(c, { action: 'remove', target: ' , ' }, 0).status).toBe('no-op');
    expect(addressEntries(c)).toHaveLength(2);
  });
});

describe('review fixes: relabelling a quoted TYPE list keeps pref/INTERNET', () => {
  it('splits the list before deciding what to keep', () => {
    const c = parse('EMAIL;TYPE="INTERNET,HOME,pref":a@x.com');
    applyLabel(c, c.first('EMAIL')!, 'email', 'work');
    expect(body(c)).toEqual(['EMAIL;type=INTERNET;type=WORK;type=pref:a@x.com']);
  });
});
