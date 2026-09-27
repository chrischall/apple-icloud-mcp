import { describe, expect, it } from 'vitest';
import {
  addressEntries,
  baseEntryId,
  composeFormattedName,
  decodeAbLabel,
  formatAddress,
  formatMonthDay,
  formatRev,
  isGroupCard,
  labelFromTypes,
  parseRev,
  readBirthday,
  readContact,
  readName,
  readOrg,
  validMonthDay,
  valueEntries,
} from '../../src/contacts/model.js';
import { VCard, newLine } from '../../src/contacts/vcard.js';
import { formatDateOnly } from '../../src/time.js';
import { vcard } from './fake-icloud.js';

const card = (...lines: string[]) => VCard.parse(vcard(...lines))!;

describe('labels', () => {
  it('decodes Apple\'s wrapped built-in labels and keeps custom ones', () => {
    expect(decodeAbLabel('_$!<Mobile>!$_')).toBe('mobile');
    expect(decodeAbLabel('_$!<HomeFAX>!$_')).toBe('home fax');
    expect(decodeAbLabel('_$!<iPhone>!$_')).toBe('iPhone');
    expect(decodeAbLabel('_$!<Anniversary>!$_')).toBe('anniversary');
    expect(decodeAbLabel('Gym')).toBe('Gym');
  });

  it('reads labels from TYPE parameters', () => {
    expect(labelFromTypes('phone', ['IPHONE', 'CELL', 'VOICE'])).toBe('iPhone');
    expect(labelFromTypes('phone', ['HOME', 'FAX'])).toBe('home fax');
    expect(labelFromTypes('phone', ['WORK', 'FAX'])).toBe('work fax');
    expect(labelFromTypes('phone', ['FAX'])).toBe('fax');
    expect(labelFromTypes('phone', ['CELL', 'VOICE', 'PREF'])).toBe('mobile');
    expect(labelFromTypes('phone', ['MAIN'])).toBe('main');
    expect(labelFromTypes('phone', ['PAGER'])).toBe('pager');
    expect(labelFromTypes('phone', ['VOICE'])).toBeUndefined();
    expect(labelFromTypes('email', ['INTERNET', 'HOME'])).toBe('home');
    expect(labelFromTypes('email', ['INTERNET', 'WORK'])).toBe('work');
    expect(labelFromTypes('url', ['OTHER'])).toBe('other');
    expect(labelFromTypes('email', ['INTERNET', 'SCHOOL'])).toBe('school');
    expect(labelFromTypes('email', ['INTERNET', 'PREF', 'X400'])).toBeUndefined();
  });
});

describe('entries', () => {
  const c = card(
    'EMAIL;type=INTERNET;type=HOME;type=pref:a@x.com',
    'item1.EMAIL;type=INTERNET;type=HOME:b@x.com',
    'item1.X-ABLabel:_$!<Other>!$_',
    'item2.EMAIL;type=INTERNET;type=WORK:c@x.com',
    'item2.X-ABLabel:',
    'EMAIL;PREF=1:d@x.com',
    'EMAIL:d@x.com',
    'TEL;VALUE=uri:tel:+15551234567',
    'item3.URL;type=pref:http\\://www.apple.com',
    'item3.X-ABLabel:_$!<HomePage>!$_',
    'item4.ADR;type=HOME:PO 1;Apt 2;1 Main St\\nFloor 3;Springfield;IL;62701;USA',
    'item4.X-ABADR:us',
    'ADR:;;;;;;',
    'ADR:;;2 Side St',
  );

  it('reads values with labels (X-ABLabel wins over TYPE; an empty one falls back), preferred flags and unique ids', () => {
    const emails = valueEntries(c, 'email').map((e) => e.entry);
    expect(emails.map((e) => [e.value, e.label, e.preferred])).toEqual([
      ['a@x.com', 'home', true],
      ['b@x.com', 'other', undefined],
      ['c@x.com', 'work', undefined],
      ['d@x.com', undefined, true],
      ['d@x.com', undefined, undefined],
    ]);
    expect(new Set(emails.map((e) => e.entryId)).size).toBe(5);
    expect(valueEntries(c, 'phone')[0]!.entry.value).toBe('+15551234567');
    expect(valueEntries(c, 'url')[0]!.entry).toMatchObject({ value: 'http://www.apple.com', label: 'homepage', preferred: true });
  });

  it('duplicate lines get ~2, ~3 suffixes on the same base id', () => {
    const dup = card('EMAIL:x@x.com', 'EMAIL:x@x.com', 'EMAIL:x@x.com');
    const ids = valueEntries(dup, 'email').map((e) => e.entry.entryId);
    const base = baseEntryId(dup.first('EMAIL')!);
    expect(ids).toEqual([base, `${base}~2`, `${base}~3`]);
  });

  it('entry ids depend on property, group (case-insensitively) and raw value', () => {
    const a = baseEntryId(newLine({ group: 'ITEM1', nameText: 'EMAIL', value: 'x' }));
    expect(a).toBe(baseEntryId(newLine({ group: 'item1', nameText: 'email', value: 'x' })));
    expect(a).not.toBe(baseEntryId(newLine({ nameText: 'EMAIL', value: 'x' })));
    expect(a).not.toBe(baseEntryId(newLine({ group: 'item1', nameText: 'EMAIL', value: 'y' })));
  });

  it('reads addresses into components with a one-line form', () => {
    const [full, empty, short] = addressEntries(c).map((e) => e.entry);
    expect(full).toMatchObject({
      label: 'home',
      poBox: 'PO 1',
      extended: 'Apt 2',
      street: '1 Main St\nFloor 3',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      country: 'USA',
      formatted: 'PO Box PO 1, Apt 2, 1 Main St, Floor 3, Springfield, IL 62701, USA',
    });
    expect(empty).toEqual({ entryId: empty!.entryId, formatted: '' });
    expect(short!.formatted).toBe('2 Side St');
  });

  it('formatAddress drops empty parts', () => {
    expect(formatAddress({ city: 'Paris', country: 'France' })).toBe('Paris, France');
    expect(formatAddress({ postalCode: '75001' })).toBe('75001');
    expect(formatAddress({})).toBe('');
  });
});

describe('names and organization', () => {
  it('reads N and ORG components (unescaped, missing ones empty)', () => {
    const c = card('N:O\\,Brien;Pat;Q;Dr.;Jr.', 'ORG:Acme\\; Co;R&D;Labs');
    expect(readName(c)).toEqual({ family: 'O,Brien', given: 'Pat', middle: 'Q', prefix: 'Dr.', suffix: 'Jr.' });
    expect(readOrg(c)).toEqual({ organization: 'Acme; Co', department: 'R&D, Labs' });
    expect(readName(card())).toEqual({ family: '', given: '', middle: '', prefix: '', suffix: '' });
    expect(readOrg(card())).toEqual({ organization: '', department: '' });
  });

  it('composes the formatted name like Apple (company cards show the company)', () => {
    expect(composeFormattedName(card('N:Doe;Jane;;;', 'ORG:Acme;'))).toBe('Jane Doe');
    expect(composeFormattedName(card('N:Doe;Jane;;;', 'ORG:Acme;', 'X-ABShowAs:COMPANY'))).toBe('Acme');
    expect(composeFormattedName(card('N:Doe;Jane;;;', 'X-ABShowAs:COMPANY'))).toBe('Jane Doe');
    expect(composeFormattedName(card('N:;;;;', 'ORG:Acme;'))).toBe('Acme');
    expect(composeFormattedName(card('N:;;;;'))).toBe('');
  });
});

describe('birthday and revision', () => {
  const bday = (line: string) => readBirthday(card(line).first('BDAY')!);

  it('reads full dates in basic, extended and date-time forms', () => {
    expect(bday('BDAY;value=date:1970-01-31')).toBe('1970-01-31');
    expect(bday('BDAY:19700131')).toBe('1970-01-31');
    expect(bday('BDAY:1970-01-31T00:00:00Z')).toBe('1970-01-31');
  });

  it('reads a birthday without a year (Apple 1604, the param, or --MMDD)', () => {
    expect(bday('BDAY;X-APPLE-OMIT-YEAR=1604:1604-05-12')).toBe('--05-12');
    expect(bday('BDAY:1604-02-29')).toBe('--02-29');
    expect(bday('BDAY;X-APPLE-OMIT-YEAR=1900:1900-05-12')).toBe('--05-12');
    expect(bday('BDAY:--0512')).toBe('--05-12');
    expect(bday('BDAY:--05-12')).toBe('--05-12');
  });

  it('is undefined for impossible or unreadable dates', () => {
    expect(bday('BDAY:1970-02-30')).toBeUndefined();
    expect(bday('BDAY:2001-02-29')).toBeUndefined();
    expect(bday('BDAY:--13-01')).toBeUndefined();
    expect(bday('BDAY:someday')).toBeUndefined();
  });

  it('validMonthDay allows Feb 29 when the year is unknown or leap', () => {
    expect(validMonthDay(2, 29)).toBe(true);
    expect(validMonthDay(2, 29, 2024)).toBe(true);
    expect(validMonthDay(2, 29, 2023)).toBe(false);
    expect(validMonthDay(0, 1)).toBe(false);
    expect(validMonthDay(1, 0)).toBe(false);
    expect(validMonthDay(4, 31)).toBe(false);
  });

  it('reads year 0000 as "no year" (some exporters write it), Feb 29 included', () => {
    expect(bday('BDAY:0000-05-12')).toBe('--05-12');
    expect(bday('BDAY:00000512')).toBe('--05-12');
    expect(bday('BDAY:0000-02-29')).toBe('--02-29');
    expect(bday('BDAY:0000-02-30')).toBeUndefined();
  });

  it('validMonthDay uses the real calendar for years 0–99 (Date.UTC would read them as 1900–1999)', () => {
    expect(validMonthDay(2, 29, 0)).toBe(true); // year 0 is leap; 1900 is not
    expect(validMonthDay(2, 29, 1900)).toBe(false);
    expect(validMonthDay(2, 29, 4)).toBe(true);
    expect(validMonthDay(2, 29, 1)).toBe(false);
  });

  it('every full date readBirthday returns is one formatDateOnly can show (it never throws on a stored card)', () => {
    for (const y of ['0000', '0001', '0004', '0099', '0100', '1604', '1900', '2000', '2024', '9999']) {
      for (const md of ['01-01', '02-28', '02-29', '12-31']) {
        const v = bday(`BDAY:${y}-${md}`);
        if (v !== undefined && !v.startsWith('--')) expect(() => formatDateOnly(v)).not.toThrow();
      }
    }
  });

  it('formats a month-day', () => {
    expect(formatMonthDay('--05-12')).toBe('May 12');
    expect(formatMonthDay('--02-29')).toBe('February 29');
  });

  it('parses REV only when it names its zone', () => {
    expect(parseRev('2023-01-15T10:20:30Z')!.toISOString()).toBe('2023-01-15T10:20:30.000Z');
    expect(parseRev('20230115T102030Z')!.toISOString()).toBe('2023-01-15T10:20:30.000Z');
    expect(parseRev('2023-01-15T10:20:30.123z')!.toISOString()).toBe('2023-01-15T10:20:30.000Z');
    expect(parseRev('2023-01-15T10:20:30+0530')!.toISOString()).toBe('2023-01-15T04:50:30.000Z');
    expect(parseRev('2023-01-15T10:20:30-04:00')!.toISOString()).toBe('2023-01-15T14:20:30.000Z');
    expect(parseRev('2023-01-15T10:20:30+01')!.toISOString()).toBe('2023-01-15T09:20:30.000Z');
    expect(parseRev('2023-01-15T10:20:30')).toBeUndefined();
    expect(parseRev('2023-01-15')).toBeUndefined();
    expect(parseRev('2023-13-45T99:99:99Z')).toBeUndefined();
  });

  it('formats REV as whole-second UTC', () => {
    expect(formatRev(new Date('2026-09-27T16:00:00.789Z'))).toBe('2026-09-27T16:00:00Z');
  });
});

describe('readContact', () => {
  it('reads a full Apple card', () => {
    const v = readContact(
      card(
        'N:Appleseed;John;Q;Mr.;III',
        'FN:John Appleseed',
        'NICKNAME:Johnny,J',
        'NICKNAME:Jay',
        'ORG:Apple Inc.;Engineering',
        'TITLE:Engineer',
        'NOTE:Line 1\\nLine 2',
        'BDAY;value=date:1970-01-31',
        'PHOTO;ENCODING=b;TYPE=JPEG:AAAA',
        'UID:urn:uuid:ABC-123',
        'REV:2023-01-15T10:20:30Z',
        'URL:https://apple.com',
        'ADR;type=WORK:;;1 Apple Park Way;Cupertino;CA;95014;USA',
      ),
    );
    expect(v.urls.map((u) => u.value)).toEqual(['https://apple.com']);
    expect(v.addresses.map((a) => [a.label, a.city])).toEqual([['work', 'Cupertino']]);
    expect(v).toMatchObject({
      kind: 'contact',
      uid: 'ABC-123',
      name: 'John Appleseed',
      givenName: 'John',
      familyName: 'Appleseed',
      middleName: 'Q',
      namePrefix: 'Mr.',
      nameSuffix: 'III',
      nickname: 'Johnny, J, Jay',
      organization: 'Apple Inc.',
      department: 'Engineering',
      jobTitle: 'Engineer',
      note: 'Line 1\nLine 2',
      birthday: '1970-01-31',
      hasPhoto: true,
      members: [],
    });
    expect(v.lastModified!.toISOString()).toBe('2023-01-15T10:20:30.000Z');
    expect(v.isCompany).toBeUndefined();
  });

  it('derives a display name when FN is empty (iCloud serves some cards that way)', () => {
    expect(readContact(card('N:Doe;Jane;;;', 'FN:')).name).toBe('Jane Doe');
    expect(readContact(card('N:;;;;', 'FN:', 'ORG:Acme;')).name).toBe('Acme');
    expect(readContact(card('FN:', 'NICKNAME:Ace')).name).toBe('Ace');
    expect(readContact(card('EMAIL:x@y.z')).name).toBe('x@y.z');
    expect(readContact(card('TEL:555')).name).toBe('555');
    expect(readContact(card()).name).toBe('(no name)');
    const company = readContact(card('N:Doe;Jane;;;', 'FN:Jane Doe', 'ORG:Acme;', 'X-ABShowAs:company'));
    expect(company.name).toBe('Acme');
    expect(company.isCompany).toBe(true);
  });

  it('an empty PHOTO is no photo; an unzoned REV is omitted; an unreadable BDAY is omitted', () => {
    const v = readContact(card('FN:x', 'PHOTO:', 'REV:2023-01-15T10:20:30', 'BDAY:soon'));
    expect(v.hasPhoto).toBe(false);
    expect(v.lastModified).toBeUndefined();
    expect(v.birthday).toBeUndefined();
    expect(v.uid).toBeUndefined();
  });

  it('reads Apple groups and vCard 4 groups with their member UIDs', () => {
    const apple = card(
      'N:Family;;;;',
      'FN:Family',
      'X-ADDRESSBOOKSERVER-KIND:group',
      'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:AAA-1',
      'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:',
      'X-ADDRESSBOOKSERVER-MEMBER:bbb-2',
    );
    expect(isGroupCard(apple)).toBe(true);
    expect(readContact(apple)).toMatchObject({ kind: 'group', name: 'Family', members: ['aaa-1', 'bbb-2'] });
    const v4 = card('FN:Team', 'KIND:group', 'MEMBER:urn:uuid:CCC');
    expect(readContact(v4)).toMatchObject({ kind: 'group', members: ['ccc'] });
    expect(isGroupCard(card('FN:x', 'KIND:individual'))).toBe(false);
  });
});

describe('review fixes: a quoted TYPE list is read as a list', () => {
  it('TYPE="work,voice" (vCard 4 spelling) labels a phone "work" and marks pref', () => {
    const c = card('TEL;TYPE="work,voice,pref":555', 'EMAIL;TYPE=" HOME , ":a@x.com');
    const [tel] = valueEntries(c, 'phone');
    expect(tel!.entry).toMatchObject({ label: 'work', preferred: true });
    expect(c.first('TEL')!.types()).toEqual(['WORK', 'VOICE', 'PREF']);
    expect(c.first('EMAIL')!.typeValues()).toEqual(['HOME']);
  });
});
