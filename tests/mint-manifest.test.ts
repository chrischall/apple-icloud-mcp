import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ALLOWED_HOSTS, ALLOWED_HOST_SUFFIXES } from '../src/http.js';

// mint.yaml is what mcp-host proposes when this package is registered. mcp-host
// validates it (packages/core/src/mint-manifest-schema.ts, registration.ts
// authFieldSchema): a help text over 300 chars is silently CUT, more than 8
// auth fields or a bad name is refused, and a YAML alias voids the file. None
// of that fails here unless something checks it — this does.
const yaml = readFileSync(fileURLToPath(new URL('../mint.yaml', import.meta.url)), 'utf8');
const lines = yaml.split('\n');

interface Entry {
  section: 'env' | 'auth';
  name: string;
  fields: Record<string, string>;
}

/** A small reader for exactly this file's shape (flat lists of maps; `help: >-` folded blocks). */
function entries(): Entry[] {
  const out: Entry[] = [];
  let section: 'env' | 'auth' | undefined;
  let current: Entry | undefined;
  let folding: string | undefined;
  for (const raw of lines) {
    if (/^\S/.test(raw)) {
      section = raw.startsWith('env:') ? 'env' : raw.startsWith('auth:') ? 'auth' : undefined;
      folding = undefined;
      continue;
    }
    if (!section) continue;
    const item = /^\s*- name: (\S+)$/.exec(raw);
    if (item) {
      current = { section, name: item[1]!, fields: {} };
      out.push(current);
      folding = undefined;
      continue;
    }
    const kv = /^\s+([a-z]+): ?(.*)$/.exec(raw);
    if (current && kv && !raw.startsWith('      ' + ' '.repeat(section === 'env' ? 0 : 2) + ' ')) {
      const [, key, value] = kv as unknown as [string, string, string];
      if (value === '>-') {
        folding = key;
        current.fields[key] = '';
      } else {
        folding = undefined;
        current.fields[key] = value.startsWith('"') ? (JSON.parse(value) as string) : value;
      }
      continue;
    }
    if (current && folding && raw.trim()) {
      current.fields[folding] = (current.fields[folding] ? current.fields[folding] + ' ' : '') + raw.trim();
    }
  }
  return out;
}

describe('mint.yaml (mcp-host registration proposal)', () => {
  const all = entries();
  const auth = all.filter((e) => e.section === 'auth');

  it('declares at most 8 auth fields, each a valid field', () => {
    expect(auth.length).toBeGreaterThan(0);
    expect(auth.length).toBeLessThanOrEqual(8);
    for (const f of auth) {
      expect(f.name, f.name).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
      expect(f.fields.label?.length ?? 0, `${f.name} label`).toBeGreaterThan(0);
      expect(f.fields.label!.length, `${f.name} label`).toBeLessThanOrEqual(120);
      expect(['text', 'password']).toContain(f.fields.type);
      expect(['principal', 'user']).toContain(f.fields.persist);
      if (f.fields.autofill) expect(['one-time-code', 'username', 'current-password']).toContain(f.fields.autofill);
    }
  });

  it('keeps every help text within 300 characters (mcp-host cuts longer ones)', () => {
    for (const e of all) {
      expect(e.fields.help?.length ?? 0, `${e.name} help`).toBeGreaterThan(0);
      expect(e.fields.help!.length, `${e.name} help`).toBeLessThanOrEqual(300);
    }
  });

  it('never declares a name twice, nor a reserved one', () => {
    const names = all.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    const reserved = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'NODE_OPTIONS', 'MCP_DATA_DIR', 'MCP_BLOB_BASE_URL', 'MCP_BLOB_SIGNING_KEY', 'MCP_HOST_METER_FILE'];
    for (const n of names) {
      expect(reserved).not.toContain(n);
      expect(n).not.toMatch(/^(LD_|DYLD_)/);
    }
  });

  it('marks secret-shaped owner env as secret and gives none of them a default', () => {
    for (const e of all.filter((x) => x.section === 'env')) {
      if (/KEY$|SECRET$|PASSWORD$|TOKEN$/.test(e.name) && !e.name.endsWith('_KEY_ID')) expect(e.fields.secret, e.name).toBe('true');
      expect(e.fields.default, e.name).toBeUndefined();
    }
  });

  it('uses no YAML anchors or aliases (they void the whole file)', () => {
    for (const l of lines) {
      if (l.trim().startsWith('#')) continue;
      expect(l, l).not.toMatch(/:\s+[&*][A-Za-z]/);
      expect(l, l).not.toMatch(/^\s*-\s+[&*][A-Za-z]/);
    }
  });

  it('allows exactly the hosts the code contacts: the HTTPS allowlist plus the two iCloud Mail hosts', () => {
    const egress = yaml.slice(yaml.indexOf('egress:'));
    const listed = [...egress.matchAll(/^\s+- "?([^"\n]+)"?$/gm)].map((m) => m[1]!).sort();
    const expected = [
      ...ALLOWED_HOSTS,
      ...ALLOWED_HOST_SUFFIXES.map((s) => `*${s}`),
      'imap.mail.me.com',
      'smtp.mail.me.com',
    ].sort();
    expect(listed).toEqual(expected);
  });
});
