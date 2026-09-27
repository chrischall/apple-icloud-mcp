import { describe, expect, it } from 'vitest';
import {
  FOLD_OCTETS,
  VCard,
  VLine,
  escapeText,
  foldLine,
  makeParam,
  newLine,
  parseContentLine,
  splitUnescaped,
  typeParam,
  unescapeText,
} from '../../src/contacts/vcard.js';

const CRLF = '\r\n';

describe('escaping', () => {
  it('escapes backslash, newlines, comma and semicolon', () => {
    expect(escapeText('a\\b\nc\r\nd\re,f;g')).toBe('a\\\\b\\nc\\nd\\ne\\,f\\;g');
  });

  it('unescapes \\n, \\N and any other escaped character; keeps a trailing lone backslash', () => {
    expect(unescapeText('a\\nb\\Nc\\,d\\;e\\\\f http\\://x \\')).toBe('a\nb\nc,d;e\\f http://x \\');
  });

  it('splits on unescaped separators only, keeping escapes', () => {
    expect(splitUnescaped('a\\;b;c;;d\\', ';')).toEqual(['a\\;b', 'c', '', 'd\\']);
    expect(splitUnescaped('x\\,y,z', ',')).toEqual(['x\\,y', 'z']);
  });
});

describe('foldLine', () => {
  it('leaves a line of up to 75 octets alone', () => {
    const line = 'x'.repeat(FOLD_OCTETS);
    expect(foldLine(line, CRLF)).toBe(line);
  });

  it('folds at 75 octets, continuation lines carrying one space within their 75', () => {
    const line = 'y'.repeat(200);
    const folded = foldLine(line, CRLF);
    const parts = folded.split(CRLF);
    expect(parts[0]).toHaveLength(75);
    expect(parts[1]).toBe(' ' + 'y'.repeat(74));
    expect(parts.every((p) => Buffer.byteLength(p) <= 75)).toBe(true);
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(line);
  });

  it('never splits a UTF-8 sequence or a surrogate pair', () => {
    const line = 'NOTE:' + 'é😀'.repeat(40);
    const parts = foldLine(line, '\n').split('\n');
    for (const p of parts) {
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(75);
      expect(p).not.toMatch(/[\uD800-\uDBFF]$/); // no dangling high surrogate
    }
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(line);
  });
});

describe('parseContentLine', () => {
  it('reads group, name, params (quoted, bare 2.1 tokens, lists) and value', () => {
    const p = parseContentLine('item1.EMAIL;type=INTERNET;type=HOME,"pref";X-LABEL="a;b:c,d";WORK:me@x.com')!;
    expect(p.group).toBe('item1');
    expect(p.nameText).toBe('EMAIL');
    expect(p.params.map((x) => [x.name, x.values])).toEqual([
      ['TYPE', ['INTERNET']],
      ['TYPE', ['HOME', 'pref']],
      ['X-LABEL', ['a;b:c,d']],
      ['TYPE', ['WORK']],
    ]);
    expect(p.value).toBe('me@x.com');
    expect(p.headText).toBe('item1.EMAIL;type=INTERNET;type=HOME,"pref";X-LABEL="a;b:c,d";WORK');
  });

  it('refuses lines that are not content lines', () => {
    expect(parseContentLine('no colon here')).toBeUndefined();
    expect(parseContentLine(':value')).toBeUndefined();
    expect(parseContentLine('BAD NAME:x')).toBeUndefined();
    expect(parseContentLine('bad!group.EMAIL:x')).toBeUndefined();
    expect(parseContentLine('.EMAIL:x')).toBeUndefined();
  });

  it('a value may contain colons', () => {
    expect(parseContentLine('URL:https://x.test/a:b')!.value).toBe('https://x.test/a:b');
  });
});

describe('VCard.parse / toString', () => {
  const APPLE = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'N:Appleseed;John;;;',
    'FN:John Appleseed',
    'NOTE:a long note that was folded by the',
    '  server at some point',
    '\tand with a tab continuation',
    'item1.EMAIL;type=INTERNET:j@x.com',
    'item1.X-ABLabel:_$!<Other>!$_',
    'this line is garbage',
    '',
    'END:VCARD',
    '',
  ].join(CRLF);

  it('round-trips byte-for-byte, folds, garbage and blank lines included', () => {
    const card = VCard.parse(APPLE)!;
    expect(card.toString()).toBe(APPLE);
    expect(card.eol).toBe(CRLF);
    expect(card.first('note')!.value).toBe('a long note that was folded by the server at some pointand with a tab continuation');
    expect(card.properties().map((l) => l.name)).toEqual(['VERSION', 'N', 'FN', 'NOTE', 'EMAIL', 'X-ABLABEL']);
  });

  it('keeps a BOM, LF line endings and a missing final newline', () => {
    const text = '\uFEFFBEGIN:VCARD\nVERSION:3.0\nFN:X\nEND:VCARD';
    const card = VCard.parse(text)!;
    expect(card.eol).toBe('\n');
    card.first('FN')!.setValue('Y');
    expect(card.toString()).toBe('\uFEFFBEGIN:VCARD\nVERSION:3.0\nFN:Y\nEND:VCARD');
  });

  it('keeps mixed line endings exactly', () => {
    const text = 'BEGIN:VCARD\r\nVERSION:3.0\nFN:X\rEND:VCARD\r\n';
    expect(VCard.parse(text)!.toString()).toBe(text);
  });

  it('is undefined for text that holds no complete vCard', () => {
    expect(VCard.parse('')).toBeUndefined();
    expect(VCard.parse('\r\n')).toBeUndefined();
    expect(VCard.parse('BEGIN:VCARD\r\nFN:x\r\n')).toBeUndefined();
    expect(VCard.parse('FN:x\r\nEND:VCARD\r\n')).toBeUndefined();
    expect(VCard.parse('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')).toBeUndefined();
  });

  it('a leading continuation-looking line with nothing before it is its own line', () => {
    const card = VCard.parse(' stray\r\nBEGIN:VCARD\r\nFN:x\r\nEND:VCARD\r\n')!;
    expect(card.lines[0]!.opaque).toBe(true);
  });

  it('only reads properties between BEGIN and the END that closes it', () => {
    const card = VCard.parse('X-BEFORE:1\r\nBEGIN:VCARD\r\nFN:in\r\nEND:VCARD\r\nFN:after\r\n')!;
    expect(card.all('FN').map((l) => l.value)).toEqual(['in']);
    expect(card.all('X-BEFORE')).toEqual([]);
  });

  it('a text with no line break at all is not a vCard', () => {
    expect(VCard.parse('BEGIN:VCARD')).toBeUndefined();
  });
});

describe('editing', () => {
  const base = () =>
    VCard.parse(
      [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:X',
        'item1.EMAIL;type=INTERNET:a@x.com',
        'item1.X-ABLabel:custom',
        'ITEM1.X-ABADR:us',
        'item7.TEL:1',
        'item7.URL:http://grouped-with-a-phone',
        'EMAIL:b@x.com',
        'END:VCARD',
        '',
      ].join(CRLF),
    )!;

  it('setValue re-renders only that line (folded), keeping its original head', () => {
    const card = base();
    const email = card.first('EMAIL')!;
    email.setValue('a@x.com'); // unchanged → still raw
    expect(email.raw).toBeDefined();
    email.setValue('z'.repeat(100) + '@x.com');
    const out = card.toString();
    expect(out).toContain(`item1.EMAIL;type=INTERNET:${'z'.repeat(49)}\r\n ${'z'.repeat(51)}@x.com\r\n`);
    expect(out).toContain('item1.X-ABLabel:custom\r\n');
  });

  it('setParams is a no-op for identical texts, re-renders otherwise; setGroup re-renders', () => {
    const card = base();
    const email = card.all('EMAIL')[1]!;
    email.setParams([]);
    expect(email.raw).toBeDefined();
    const grouped = card.first('EMAIL')!;
    grouped.setParams([{ name: 'TYPE', values: ['INTERNET'], text: 'type=INTERNET' }]);
    expect(grouped.raw).toBeDefined();
    email.setParams([typeParam('HOME'), makeParam('X-Foo', 'bar')]);
    expect(email.render()).toBe('EMAIL;type=HOME;X-Foo=bar:b@x.com');
    expect(email.types()).toEqual(['HOME']);
    expect(email.paramValue('X-FOO')).toBe('bar');
    expect(email.paramValue('NOPE')).toBeUndefined();
    email.setGroup('item9');
    expect(email.render()).toBe('item9.EMAIL;type=HOME;X-Foo=bar:b@x.com');
  });

  it('siblings are case-insensitive by group; an ungrouped line has none', () => {
    const card = base();
    const grouped = card.first('EMAIL')!;
    expect(card.siblings(grouped).map((l) => l.name)).toEqual(['X-ABLABEL', 'X-ABADR']);
    expect(card.siblings(card.all('EMAIL')[1]!)).toEqual([]);
  });

  it('removeEntry drops the line and only the X- lines of its group', () => {
    const card = base();
    card.removeEntry(card.first('EMAIL')!);
    card.removeEntry(card.first('TEL')!);
    const out = card.toString();
    expect(out).not.toContain('a@x.com');
    expect(out).not.toContain('X-ABLabel');
    expect(out).not.toContain('X-ABADR');
    expect(out).toContain('item7.URL:http://grouped-with-a-phone');
    card.remove(newLine({ nameText: 'NOTE', value: 'not in the card' })); // no-op
  });

  it('append goes before END, insertAfter right after its anchor; nextGroup skips used numbers', () => {
    const card = base();
    expect(card.nextGroup()).toBe('item8');
    const fn = card.first('FN')!;
    card.insertAfter(fn, newLine({ nameText: 'NICKNAME', value: 'Nick' }));
    card.append(newLine({ group: 'item8', nameText: 'X-ABLabel', value: 'x' }));
    const lines = card.toString().split(CRLF);
    expect(lines[3]).toBe('NICKNAME:Nick');
    expect(lines[lines.length - 3]).toBe('item8.X-ABLabel:x');
    expect(lines[lines.length - 2]).toBe('END:VCARD');
    expect(VCard.parse('BEGIN:VCARD\r\nEND:VCARD\r\n')!.nextGroup()).toBe('item1');
  });

  it('a VLine built by hand defaults its line ending and params', () => {
    const l = new VLine({ nameText: 'FN', value: 'x' });
    expect(l.eolAfter).toBe('');
    expect(l.params).toEqual([]);
    expect(l.opaque).toBe(false);
    expect(l.render()).toBe('FN:x');
  });
});
