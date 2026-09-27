/**
 * A small, LOSSLESS vCard 3.0 reader/editor for iCloud CardDAV cards.
 *
 * Why not a generic parser/serializer (ical.js reads vCards fine): a round
 * trip through one REWRITES the card — `item1.EMAIL;type=INTERNET;type=pref`
 * comes back as `ITEM1.EMAIL;TYPE=INTERNET,pref`, parameter order changes,
 * lines refold. iCloud and Apple's clients key labels, photos and grouped
 * properties off that exact text, so an edit here touches ONLY the lines it
 * changes: every other line keeps its original bytes (folding and line
 * endings included), and a changed or new line is folded at 75 octets on a
 * UTF-8 character boundary.
 *
 * Model: a card is a list of logical lines. Each keeps its original physical
 * text (`raw`) until it is edited; `toString()` emits `raw` for untouched
 * lines and re-renders only the edited ones. A line that is not a valid
 * content line (a blank line, garbage) is kept verbatim and never edited.
 */

/** One parameter of a content line (`type=INTERNET`, `X-APPLE-OMIT-YEAR=1604`). */
export interface VParam {
  /** Upper-cased name. A bare vCard 2.1 token (`;HOME`) reads as `TYPE`. */
  name: string;
  /** The values, comma-split, surrounding double quotes removed. */
  values: string[];
  /** The parameter exactly as written — reused when the line is re-rendered. */
  text: string;
}

/** A logical (unfolded) line of a card. */
export class VLine {
  /** Original physical text (fold breaks included, final line break excluded); undefined once edited. */
  raw: string | undefined;
  /** The line break that followed this line in the source ('' for the last line). */
  eolAfter: string;
  /** The group prefix as written (`item1`), if any. */
  group: string | undefined;
  /** The property name as written (`EMAIL`, `X-ABLabel`); '' for an opaque line. */
  readonly nameText: string;
  params: VParam[];
  /** The value exactly as written — still ESCAPED (see `unescapeText`). */
  value: string;
  /** The text before the value's colon, as written; dropped when params or group change. */
  private headText: string | undefined;

  constructor(init: {
    raw?: string;
    eolAfter?: string;
    group?: string;
    nameText: string;
    params?: VParam[];
    value: string;
    headText?: string;
  }) {
    this.raw = init.raw;
    this.eolAfter = init.eolAfter ?? '';
    this.group = init.group;
    this.nameText = init.nameText;
    this.params = init.params ?? [];
    this.value = init.value;
    this.headText = init.headText;
  }

  /** Upper-cased property name ('' for an opaque line). */
  get name(): string {
    return this.nameText.toUpperCase();
  }

  /** A line that could not be read as a content line; kept verbatim, never edited. */
  get opaque(): boolean {
    return this.nameText === '';
  }

  /** Every TYPE value, upper-cased, in order. */
  types(): string[] {
    return this.typeValues().map((v) => v.toUpperCase());
  }

  /**
   * Every TYPE value as written. A quoted list (`TYPE="work,voice"`, the
   * vCard 4 spelling) is split too: for TYPE a comma always separates values.
   */
  typeValues(): string[] {
    return this.params
      .filter((p) => p.name === 'TYPE')
      .flatMap((p) => p.values.flatMap((v) => v.split(',')))
      .map((v) => v.trim())
      .filter((v) => v !== '');
  }

  /** The first value of parameter `name` (upper-case name), if present. */
  paramValue(name: string): string | undefined {
    return this.params.find((p) => p.name === name)?.values[0];
  }

  /** The unfolded content line as it should be written now. */
  render(): string {
    const head =
      this.headText ?? `${this.group ? `${this.group}.` : ''}${this.nameText}${this.params.map((p) => `;${p.text}`).join('')}`;
    return `${head}:${this.value}`;
  }

  /** Replace the (already escaped) value. */
  setValue(value: string): void {
    if (value === this.value) return;
    this.value = value;
    this.raw = undefined;
  }

  /** Replace the parameter list (no-op when the texts are identical). */
  setParams(params: VParam[]): void {
    if (params.length === this.params.length && params.every((p, i) => p.text === (this.params[i] as VParam).text)) return;
    this.params = params;
    this.headText = undefined;
    this.raw = undefined;
  }

  /** Put the line into a group (`item3`). */
  setGroup(group: string): void {
    this.group = group;
    this.headText = undefined;
    this.raw = undefined;
  }
}

/** A `type=<value>` parameter in Apple's spelling (one `type=` per value). */
export function typeParam(value: string): VParam {
  return { name: 'TYPE', values: [value], text: `type=${value}` };
}

/** A `<name>=<value>` parameter written as given. */
export function makeParam(name: string, value: string): VParam {
  return { name: name.toUpperCase(), values: [value], text: `${name}=${value}` };
}

/** A new line (rendered on output), e.g. `newLine({ nameText: 'EMAIL', params: [typeParam('INTERNET')], value })`. */
export function newLine(init: { group?: string; nameText: string; params?: VParam[]; value: string }): VLine {
  return new VLine(init);
}

// ---------------------------------------------------------------------------
// Escaping (RFC 2426 §4: backslash, newline, comma and semicolon)
// ---------------------------------------------------------------------------

/** Escape text for a TEXT value or one component of a structured value. */
export function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

/**
 * Undo `escapeText`. `\n`/`\N` become a newline and any other escaped
 * character stands for itself — Apple's own exports escape more than the
 * RFC asks (`URL:http\://…`). A trailing lone backslash is kept.
 */
export function unescapeText(value: string): string {
  return value.replace(/\\([\s\S])/g, (_m, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Split an (escaped) value on unescaped `sep` — structured `;` or list `,`. Components stay escaped. */
export function splitUnescaped(value: string, sep: ';' | ','): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string;
    if (c === '\\' && i + 1 < value.length) {
      cur += c + (value[i + 1] as string);
      i += 1;
    } else if (c === sep) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

/** Longest line, in octets, excluding the line break (RFC 2425 §5.8.1). */
export const FOLD_OCTETS = 75;

/**
 * Fold a content line at 75 octets. Continuation lines start with one space
 * (which counts toward their 75), and a fold never splits a UTF-8 sequence
 * (iteration is per code point, so a surrogate pair stays whole).
 */
export function foldLine(line: string, eol: string): string {
  if (Buffer.byteLength(line, 'utf8') <= FOLD_OCTETS) return line;
  const chunks: string[] = [];
  let cur = '';
  let bytes = 0;
  let limit = FOLD_OCTETS;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > limit) {
      chunks.push(cur);
      cur = '';
      bytes = 0;
      limit = FOLD_OCTETS - 1;
    }
    cur += ch;
    bytes += size;
  }
  chunks.push(cur);
  return chunks.join(`${eol} `);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function indexOfUnquoted(s: string, ch: string): number {
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') quoted = !quoted;
    else if (c === ch && !quoted) return i;
  }
  return -1;
}

function splitQuoted(s: string, sep: string): string[] {
  const out: string[] = [];
  let quoted = false;
  let cur = '';
  for (const c of s) {
    if (c === '"') quoted = !quoted;
    if (c === sep && !quoted) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

function parseParam(text: string): VParam {
  const eq = indexOfUnquoted(text, '=');
  if (eq < 0) return { name: 'TYPE', values: [unquote(text)], text };
  return { name: text.slice(0, eq).toUpperCase(), values: splitQuoted(text.slice(eq + 1), ',').map(unquote), text };
}

const TOKEN = /^[A-Za-z0-9-]+$/;

interface ParsedContent {
  group?: string;
  nameText: string;
  params: VParam[];
  value: string;
  headText: string;
}

/** Read `[group.]NAME[;param…]:value`, or undefined when the line is not a content line. */
export function parseContentLine(line: string): ParsedContent | undefined {
  const colon = indexOfUnquoted(line, ':');
  if (colon <= 0) return undefined;
  const headText = line.slice(0, colon);
  const [first, ...paramTexts] = splitQuoted(headText, ';') as [string, ...string[]];
  const dot = first.indexOf('.');
  const group = dot >= 0 ? first.slice(0, dot) : undefined;
  const nameText = dot >= 0 ? first.slice(dot + 1) : first;
  if (!TOKEN.test(nameText) || (group !== undefined && !TOKEN.test(group))) return undefined;
  return {
    ...(group !== undefined ? { group } : {}),
    nameText,
    params: paramTexts.map(parseParam),
    value: line.slice(colon + 1),
    headText,
  };
}

/** A parsed card: its lines in order plus what is needed to write it back byte-for-byte. */
export class VCard {
  readonly lines: VLine[];
  /** The line break used for new lines: the source's first one, else CRLF. */
  readonly eol: string;
  private readonly bom: string;

  private constructor(lines: VLine[], eol: string, bom: string) {
    this.lines = lines;
    this.eol = eol;
    this.bom = bom;
  }

  /**
   * Parse the text of one vCard resource. Returns undefined when the text
   * holds no `BEGIN:VCARD` … `END:VCARD` pair (not a vCard at all).
   */
  static parse(text: string): VCard | undefined {
    const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
    const body = text.slice(bom.length);
    const pieces = body.split(/(\r\n|\r|\n)/);
    const logical: Array<{ raw: string; unfolded: string; eolAfter: string }> = [];
    let eol: string | undefined;
    for (let i = 0; i < pieces.length; i += 2) {
      const physical = pieces[i] as string;
      const sep = pieces[i + 1] ?? '';
      if (sep !== '' && eol === undefined) eol = sep;
      const last = logical[logical.length - 1];
      if (last !== undefined && (physical.startsWith(' ') || physical.startsWith('\t'))) {
        // A continuation: the break and the one leading blank are not content.
        last.raw += last.eolAfter + physical;
        last.unfolded += physical.slice(1);
        last.eolAfter = sep;
        continue;
      }
      // The empty piece after the final line break.
      if (physical === '' && sep === '' && i > 0) continue;
      logical.push({ raw: physical, unfolded: physical, eolAfter: sep });
    }
    const lines = logical.map(({ raw, unfolded, eolAfter }) => {
      const parsed = parseContentLine(unfolded);
      return parsed
        ? new VLine({ raw, eolAfter, ...parsed })
        : new VLine({ raw, eolAfter, nameText: '', value: '' });
    });
    const card = new VCard(lines, eol ?? '\r\n', bom);
    return card.bounds() ? card : undefined;
  }

  /** Indexes of the first BEGIN:VCARD and the END:VCARD that closes it. */
  private bounds(): { begin: number; end: number } | undefined {
    const isMarker = (l: VLine, name: string) => l.name === name && l.value.trim().toUpperCase() === 'VCARD';
    const begin = this.lines.findIndex((l) => isMarker(l, 'BEGIN'));
    if (begin < 0) return undefined;
    const offset = this.lines.slice(begin + 1).findIndex((l) => isMarker(l, 'END'));
    return offset < 0 ? undefined : { begin, end: begin + 1 + offset };
  }

  private end(): number {
    return (this.bounds() as { end: number }).end;
  }

  /** The content lines of the card (between BEGIN and END), opaque lines excluded. */
  properties(): VLine[] {
    const { begin, end } = this.bounds() as { begin: number; end: number };
    return this.lines.slice(begin + 1, end).filter((l) => !l.opaque);
  }

  /** Every property line named `name` (case-insensitive), in order. */
  all(name: string): VLine[] {
    const upper = name.toUpperCase();
    return this.properties().filter((l) => l.name === upper);
  }

  /** The first property line named `name`. */
  first(name: string): VLine | undefined {
    return this.all(name)[0];
  }

  /** The other lines in `line`'s group (none when it has no group). */
  siblings(line: VLine): VLine[] {
    if (line.group === undefined) return [];
    const g = line.group.toLowerCase();
    return this.properties().filter((l) => l !== line && l.group?.toLowerCase() === g);
  }

  /** Insert `line` just before END:VCARD. */
  append(line: VLine): void {
    line.eolAfter = this.eol;
    this.lines.splice(this.end(), 0, line);
  }

  /** Insert `line` right after `anchor` (which must be a property line of this card). */
  insertAfter(anchor: VLine, line: VLine): void {
    line.eolAfter = this.eol;
    this.lines.splice(this.lines.indexOf(anchor) + 1, 0, line);
  }

  /** Remove `line` from the card. */
  remove(line: VLine): void {
    const i = this.lines.indexOf(line);
    if (i >= 0) this.lines.splice(i, 1);
  }

  /**
   * Remove an entry line together with the Apple extension lines of its group
   * (`itemN.X-ABLabel`, `itemN.X-ABADR`) — a label left behind would attach
   * to nothing, or to whatever reuses the group name later.
   */
  removeEntry(line: VLine): void {
    for (const s of this.siblings(line)) if (s.name.startsWith('X-')) this.remove(s);
    this.remove(line);
  }

  /** A group name not used on this card (`item<N+1>`). */
  nextGroup(): string {
    let max = 0;
    for (const l of this.properties()) {
      const m = /^item(\d+)$/i.exec(l.group ?? '');
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `item${max + 1}`;
  }

  /** The card's text: untouched lines byte-for-byte, edited ones re-rendered and folded. */
  toString(): string {
    return this.bom + this.lines.map((l) => (l.raw ?? foldLine(l.render(), this.eol)) + l.eolAfter).join('');
  }
}
