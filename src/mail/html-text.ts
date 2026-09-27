/**
 * A small, dependency-free HTML → readable text converter for mail bodies.
 *
 * "Safe" in three senses:
 *  - it never executes or fetches anything (it is a tokenizer, not a DOM);
 *  - every scan is linear — no backtracking regex runs over attacker-supplied
 *    markup, so a hostile message cannot stall the server;
 *  - content a mail client would NOT show is dropped: `<script>`, `<style>`,
 *    `<head>`/`<title>`, templates, and elements hidden with `hidden`,
 *    `display:none`, `visibility:hidden`, `font-size:0` or `opacity:0`. Hidden
 *    text is a common prompt-injection carrier ("invisible instructions" in a
 *    newsletter); the reader should see what the human sees.
 *
 * An element is only skipped when its closing tag exists (matched up front
 * with a per-name stack). Mail HTML is routinely unbalanced, and skipping to
 * the end of the document because one `</div>` was missing would silently
 * drop the rest of the message.
 */

type Token =
  | { kind: 'text'; text: string }
  | { kind: 'open'; name: string; attrs: string; selfClosing: boolean }
  | { kind: 'close'; name: string };

/** Elements whose content is raw text (not markup) and never shown. */
const RAW_DROP = new Set(['script', 'style']);
/** Elements whose (tokenized) content is never shown. */
const SKIP_CONTENT = new Set(['head', 'title', 'template', 'noscript', 'svg', 'math', 'object', 'iframe', 'canvas']);
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
/** Blocks that stand apart by a blank line. */
const PARAGRAPH = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table', 'ul', 'ol', 'dl']);
/** Blocks that start on their own line. */
const BLOCK = new Set([
  'div', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'main', 'tr', 'address', 'form', 'fieldset',
  'dt', 'dd', 'center', 'figure', 'figcaption', 'caption', 'tbody', 'thead', 'tfoot',
]);

/** Invisible padding characters newsletters stuff into preheaders. */
const INVISIBLE_RE = /[­͏​-‍⁠﻿]/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', sbquo: '‚',
  ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»', bull: '•', middot: '·', deg: '°', euro: '€',
  pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', times: '×', divide: '÷', plusmn: '±', frac12: '½',
  frac14: '¼', frac34: '¾', iexcl: '¡', iquest: '¿', shy: '­', zwnj: '‌', zwj: '‍', dagger: '†',
  rarr: '→', larr: '←', uarr: '↑', darr: '↓', hearts: '♥', check: '✓',
};

/** Decode HTML character references (named subset + all numeric forms). Unknown names are left as written. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g, (whole, dec, hex, name) => {
    if (name !== undefined) return NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    const cp = dec !== undefined ? Number(dec) : parseInt(hex, 16);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
    return String.fromCodePoint(cp);
  });
}

const NAME_RE = /[a-zA-Z][a-zA-Z0-9:-]*/y;

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const lower = html.toLowerCase();
  const len = html.length;
  let i = 0;
  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      tokens.push({ kind: 'text', text: html.slice(i) });
      break;
    }
    if (lt > i) tokens.push({ kind: 'text', text: html.slice(i, lt) });
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    const next = html[lt + 1];
    if (next === '!' || next === '?') {
      const end = html.indexOf('>', lt);
      i = end === -1 ? len : end + 1;
      continue;
    }
    const closing = next === '/';
    NAME_RE.lastIndex = lt + (closing ? 2 : 1);
    const m = NAME_RE.exec(html);
    if (!m) {
      tokens.push({ kind: 'text', text: '<' });
      i = lt + 1;
      continue;
    }
    const name = m[0].toLowerCase();
    const j = tagEnd(html, NAME_RE.lastIndex);
    if (j === -1) {
      // End of input inside a tag (or inside a quoted attribute value): a browser renders
      // nothing from here on, and neither does this. Emitting it as text would dump raw
      // markup — hidden elements included — into what the reader sees.
      break;
    }
    const attrs = html.slice(NAME_RE.lastIndex, j);
    i = j + 1;
    if (closing) {
      tokens.push({ kind: 'close', name });
      continue;
    }
    if (RAW_DROP.has(name)) {
      const end = lower.indexOf(`</${name}`, i);
      if (end === -1) {
        i = len;
      } else {
        const gt = html.indexOf('>', end);
        i = gt === -1 ? len : gt + 1;
      }
      continue;
    }
    tokens.push({ kind: 'open', name, attrs, selfClosing: /\/\s*$/.test(attrs) });
  }
  return tokens;
}

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/**
 * Index of the `>` that ends a tag whose attributes start at `from`, or -1 at end of
 * input. Follows the HTML tokenizer's attribute states: a quote opens a quoted value
 * ONLY right after `=` (whitespace allowed). Anywhere else — `title=it's`, `alt=Don't`
 * — it is an ordinary character. Treating every quote as an opener made one stray
 * apostrophe run the scan past the real `>` (to the end of the document, or to some
 * later quote), so the markup after it was mis-tokenized and hidden text leaked out.
 */
function tagEnd(html: string, from: number): number {
  let state: 'name' | 'eq' | 'unquoted' | '"' | "'" = 'name';
  for (let j = from; j < html.length; j++) {
    const c = html[j] as string;
    if (state === '"' || state === "'") {
      if (c === state) state = 'name';
      continue;
    }
    if (c === '>') return j;
    if (state === 'unquoted') {
      if (isSpace(c)) state = 'name';
    } else if (state === 'eq') {
      if (c === '"' || c === "'") state = c;
      else if (!isSpace(c)) state = 'unquoted';
    } else if (c === '=') state = 'eq';
  }
  return -1;
}

/** Index of each open tag's matching close tag (same name, nesting-aware). Unmatched opens are absent. */
function matchCloses(tokens: Token[]): Map<number, number> {
  const stacks = new Map<string, number[]>();
  const match = new Map<number, number>();
  tokens.forEach((t, idx) => {
    if (t.kind === 'open' && !t.selfClosing && !VOID.has(t.name)) {
      let s = stacks.get(t.name);
      if (!s) stacks.set(t.name, (s = []));
      s.push(idx);
    } else if (t.kind === 'close') {
      const open = stacks.get(t.name)?.pop();
      if (open !== undefined) match.set(open, idx);
    }
  });
  return match;
}

/**
 * One attribute. A quoted value runs to its closing quote; an unquoted one runs to
 * whitespace and may contain quotes (`alt=Don't`), as the HTML tokenizer reads it.
 */
const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseAttrs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(ATTR_RE)) {
    const key = (m[1] as string).toLowerCase();
    if (!out.has(key)) out.set(key, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return out;
}

const HIDDEN_STYLE_RE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:[a-z%]*)?\s*(?:!important\s*)?(?:;|$)|opacity\s*:\s*0(?:\.0*)?\s*(?:!important\s*)?(?:;|$))/i;

function isHidden(attrs: Map<string, string>): boolean {
  if (attrs.has('hidden')) return true;
  if (attrs.get('aria-hidden')?.toLowerCase() === 'true' && attrs.has('style')) {
    // aria-hidden alone is a screen-reader hint (decorative icons); with a style it is usually a hidden preheader.
    return HIDDEN_STYLE_RE.test(attrs.get('style') as string);
  }
  const style = attrs.get('style');
  return style !== undefined && HIDDEN_STYLE_RE.test(style);
}

/**
 * Longest link target printed after its text. Generous on purpose: sign-in, verification
 * and password-reset links routinely run to several hundred characters, and a reader who
 * is asked for "the link in that email" must get it. Beyond this it is tracking bulk.
 */
const MAX_LINK_CHARS = 2048;

class TextOut {
  private parts: string[] = [];
  private tail = '';

  /** Current trailing text (for newline bookkeeping). */
  private lastChars(): string {
    return this.tail;
  }

  push(s: string): void {
    if (!s) return;
    this.parts.push(s);
    this.tail = (this.tail + s).slice(-2);
  }

  text(s: string): void {
    let t = s;
    const last = this.lastChars();
    if (last === '' || last.endsWith('\n') || last.endsWith(' ')) t = t.replace(/^ +/, '');
    this.push(t);
  }

  /** Ensure the output ends with at least `n` newlines (never at the very start). */
  breakLines(n: number): void {
    if (this.parts.length === 0) return;
    const last = this.lastChars();
    const have = last.endsWith('\n\n') ? 2 : last.endsWith('\n') ? 1 : 0;
    if (have < n) this.push('\n'.repeat(n - have));
  }

  length(): number {
    return this.parts.length;
  }

  since(mark: number): string {
    return this.parts.slice(mark).join('');
  }

  toString(): string {
    return this.parts.join('');
  }
}

/** Convert an HTML mail body to readable plain text. */
export function htmlToText(html: string): string {
  const tokens = tokenize(html);
  const match = matchCloses(tokens);
  const out = new TextOut();
  const anchors: Array<{ href: string | undefined; mark: number }> = [];
  let preDepth = 0;
  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx] as Token;
    if (t.kind === 'text') {
      const decoded = decodeEntities(t.text).replace(INVISIBLE_RE, '');
      if (preDepth > 0) out.push(decoded.replace(/\r\n?/g, '\n'));
      else out.text(decoded.replace(/[ \t\n\r\f]+/g, ' ').replace(/ /g, ' '));
      continue;
    }
    if (t.kind === 'open') {
      const attrs = parseAttrs(t.attrs);
      const close = match.get(idx);
      if (close !== undefined && (SKIP_CONTENT.has(t.name) || isHidden(attrs))) {
        idx = close;
        continue;
      }
      switch (t.name) {
        case 'br':
          out.push('\n');
          break;
        case 'hr':
          out.breakLines(1);
          out.push('---');
          out.breakLines(1);
          break;
        case 'li':
          out.breakLines(1);
          out.push('• ');
          break;
        case 'td':
        case 'th':
          out.text(' ');
          break;
        case 'img': {
          const alt = attrs.get('alt')?.replace(/\s+/g, ' ').trim();
          if (alt) out.text(` [${alt}]`);
          break;
        }
        case 'a':
          if (!t.selfClosing) anchors.push({ href: attrs.get('href')?.trim(), mark: out.length() });
          break;
        default:
          if (t.name === 'pre' && !t.selfClosing) preDepth++;
          if (PARAGRAPH.has(t.name)) out.breakLines(2);
          else if (BLOCK.has(t.name)) out.breakLines(1);
      }
      continue;
    }
    // close tag
    if (t.name === 'a') {
      const a = anchors.pop();
      if (a?.href && /^(https?:|mailto:)/i.test(a.href) && a.href.length <= MAX_LINK_CHARS) {
        const label = out.since(a.mark).replace(/\s+/g, ' ').trim();
        const target = a.href.replace(/^mailto:/i, '');
        if (label !== target && label !== a.href) out.text(label ? ` (${a.href})` : a.href);
      }
      continue;
    }
    if (t.name === 'pre' && preDepth > 0) preDepth--;
    if (PARAGRAPH.has(t.name)) out.breakLines(2);
    else if (BLOCK.has(t.name) || t.name === 'li') out.breakLines(1);
  }
  return out
    .toString()
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
