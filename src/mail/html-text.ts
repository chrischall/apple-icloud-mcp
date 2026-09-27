/**
 * A small, dependency-free HTML → readable text converter for mail bodies.
 *
 * "Safe" in three senses:
 *  - it never executes or fetches anything (it is a tokenizer, not a DOM);
 *  - every scan is linear — no backtracking regex runs over attacker-supplied
 *    markup, and no step re-reads output it already produced (links do not
 *    nest, and a link's text is compared with its target only when it is short
 *    enough to be equal), so a hostile message cannot stall the server;
 *  - content a mail client would NOT show is dropped: `<script>`, `<style>`,
 *    `<head>`/`<title>`, templates, and elements hidden with `hidden`,
 *    `display:none`, `visibility:hidden`, `font-size:0` or `opacity:0`. Hidden
 *    text is a common prompt-injection carrier ("invisible instructions" in a
 *    newsletter); the reader should see what the human sees.
 *
 * An element is only skipped when its end is known: its closing tag (matched
 * up front with a per-name stack), or — for `<p>` and `<li>` — the tag that
 * ends it implicitly, as a browser reads it: a start tag that closes it
 * (`<p hidden>x<p>shown`) or the end tag of an element it sits in
 * (`<div><p hidden>x</div>shown`). Mail HTML is
 * routinely unbalanced, and skipping to the end of the document because one
 * `</div>` was missing would silently drop the rest of the message. `/>` counts
 * only on void and SVG/MathML elements: a browser ignores it on a `<div/>`,
 * which stays open until its `</div>`.
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
      // A comment ends at the first `-->` — which may overlap its opening, so `<!-->` and `<!--->`
      // are empty comments — or at `--!>`, as the HTML tokenizer reads them. Searching for `-->`
      // only after `<!--` made those forms swallow visible text up to some later comment.
      const dash = html.indexOf('-->', lt + 2);
      const bang = html.indexOf('--!>', lt + 4);
      if (dash !== -1 && (bang === -1 || dash < bang)) i = dash + 3;
      else i = bang === -1 ? len : bang + 4;
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
    // A browser ignores `/>` on an ordinary element (`<div/>` opens a div); it counts only on
    // void elements and in SVG/MathML.
    const selfClosing = /\/\s*$/.test(attrs) && (VOID.has(name) || name === 'svg' || name === 'math');
    tokens.push({ kind: 'open', name, attrs, selfClosing });
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

/** Elements that bound HTML's "button scope": a `<p>` outside one of these is not closed from inside it. */
const BUTTON_SCOPE = new Set(['applet', 'caption', 'html', 'table', 'td', 'th', 'marquee', 'object', 'template', 'button']);
/**
 * Start tags that close an open `<p>` (HTML's "close a p element"). Not `table`: in quirks
 * mode — most mail, which has no doctype — a table nests inside the paragraph.
 */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main',
  'menu', 'nav', 'ol', 'p', 'pre', 'listing', 'xmp', 'section', 'search', 'summary', 'ul', 'li', 'dd', 'dt',
]);
/**
 * What stops a new `<li>` from closing an open one: the list-item scope (a nested list) and
 * the other structural elements a browser will not close past (every "special" element but
 * address, div and p).
 */
const LI_SCOPE = new Set([
  ...BUTTON_SCOPE, 'ol', 'ul', 'menu', 'dir', 'article', 'aside', 'blockquote', 'center', 'details', 'dl', 'dd', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup', 'main', 'nav', 'section', 'summary',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'listing', 'xmp', 'iframe', 'noscript', 'select', 'textarea',
  'tbody', 'thead', 'tfoot', 'tr',
]);

/**
 * Index of the token that ends each open tag: its matching close tag (same name,
 * nesting-aware), or for `<p>`/`<li>` the token before the start tag that closes it
 * implicitly. Opens whose end is unknown are absent.
 */
function matchCloses(tokens: Token[]): Map<number, number> {
  const stacks = new Map<string, number[]>();
  const match = new Map<number, number>();
  /** Is an element named in `scope` still open that was opened after token `idx`? */
  const openSince = (scope: ReadonlySet<string>, idx: number): boolean => {
    for (const name of scope) {
      const s = stacks.get(name);
      if (s && (s[s.length - 1] as number) > idx) return true;
    }
    return false;
  };
  const closeImplicitly = (name: string, scope: ReadonlySet<string>, at: number): void => {
    const s = stacks.get(name);
    const open = s?.[s.length - 1];
    if (open === undefined || openSince(scope, open)) return;
    s?.pop();
    match.set(open, at - 1);
  };
  /**
   * An end tag closes everything still open inside the element it ends: a browser
   * "generates implied end tags", so an unclosed <p>/<li> in a <div> or <td> ends at
   * that </div> or </td>. Without this, a hidden <p> stayed open until some later
   * start tag closed it, and everything visible in between was dropped.
   */
  const endInside = (name: string, outer: number, at: number): void => {
    const s = stacks.get(name);
    while (s && s.length && (s[s.length - 1] as number) > outer) match.set(s.pop() as number, at - 1);
  };
  tokens.forEach((t, idx) => {
    if (t.kind === 'open') {
      if (CLOSES_P.has(t.name)) closeImplicitly('p', BUTTON_SCOPE, idx);
      if (t.name === 'li') closeImplicitly('li', LI_SCOPE, idx);
      if (t.selfClosing || VOID.has(t.name)) return;
      let s = stacks.get(t.name);
      if (!s) stacks.set(t.name, (s = []));
      s.push(idx);
    } else if (t.kind === 'close') {
      const open = stacks.get(t.name)?.pop();
      if (open === undefined) return;
      match.set(open, idx);
      endInside('p', open, idx);
      endInside('li', open, idx);
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
  /** Characters written so far. */
  chars = 0;

  /** Current trailing text (for newline bookkeeping). */
  private lastChars(): string {
    return this.tail;
  }

  push(s: string): void {
    if (!s) return;
    this.parts.push(s);
    this.chars += s.length;
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
  // Links do not nest (a browser closes an open <a> when the next one starts), so at most one is open.
  let anchor: { href: string | undefined; mark: number; start: number } | undefined;
  const endAnchor = (): void => {
    const a = anchor;
    anchor = undefined;
    if (!a?.href || !/^(https?:|mailto:)/i.test(a.href) || a.href.length > MAX_LINK_CHARS) return;
    const target = a.href.replace(/^mailto:/i, '');
    // The text can only BE the target when it is about as long (whitespace collapses; a few
    // line breaks may ride along). Longer text is compared with nothing — rebuilding it for
    // every link is what made a pile of links around a long body quadratic.
    if (out.chars - a.start > 2 * a.href.length + 16) {
      out.text(` (${a.href})`);
      return;
    }
    const label = out.since(a.mark).replace(/\s+/g, ' ').trim();
    if (label !== target && label !== a.href) out.text(label ? ` (${a.href})` : a.href);
  };
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
          endAnchor();
          anchor = { href: attrs.get('href')?.trim(), mark: out.length(), start: out.chars };
          break;
        default:
          if (t.name === 'pre') preDepth++;
          if (PARAGRAPH.has(t.name)) out.breakLines(2);
          else if (BLOCK.has(t.name)) out.breakLines(1);
      }
      continue;
    }
    // close tag
    if (t.name === 'a') {
      endAnchor();
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
