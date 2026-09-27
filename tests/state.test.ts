import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STATE_SUBDIR, isStateCacheEnabled, stateCache } from '../src/state.js';

interface Rec {
  token: string;
  exp: number;
}

const validate = (raw: unknown): Rec | null => {
  const r = raw as Partial<Rec> | null;
  return r && typeof r.token === 'string' && typeof r.exp === 'number' ? { token: r.token, exp: r.exp } : null;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isStateCacheEnabled', () => {
  it('defaults on; APPLE_STATE_CACHE=false turns it off', () => {
    expect(isStateCacheEnabled({})).toBe(true);
    expect(isStateCacheEnabled()).toBe(true);
    expect(isStateCacheEnabled({ APPLE_STATE_CACHE: 'false' })).toBe(false);
    expect(isStateCacheEnabled({ APPLE_STATE_CACHE: '0' })).toBe(false);
    expect(isStateCacheEnabled({ APPLE_STATE_CACHE: 'junk' })).toBe(true);
  });
});

describe('stateCache', () => {
  it('round-trips a record under $MCP_DATA_DIR/.aws-mcp/, 0600, bound to the credential (never written)', () => {
    const cache = stateCache<Rec>('rt.json', 'credential-value-1', validate);
    expect(cache.load()).toBeNull();
    expect(cache.save({ token: 't1', exp: 5 })).toBe(true);
    expect(cache.load()).toEqual({ token: 't1', exp: 5 });
    const file = join(process.env.MCP_DATA_DIR!, STATE_SUBDIR, 'rt.json');
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain('credential-value-1');
  });

  it('discards a record bound to a different credential', () => {
    stateCache<Rec>('bound.json', 'old-credential', validate).save({ token: 't', exp: 1 });
    expect(stateCache<Rec>('bound.json', 'new-credential', validate).load()).toBeNull();
    expect(stateCache<Rec>('bound.json', 'old-credential', validate).load()).toEqual({ token: 't', exp: 1 });
  });

  it('returns null when the stored record fails validation', () => {
    stateCache<unknown>('shape.json', 'b', (raw) => raw).save({ nope: true });
    expect(stateCache<Rec>('shape.json', 'b', validate).load()).toBeNull();
  });

  it('clear removes the record, and clearing an absent one is harmless', () => {
    const cache = stateCache<Rec>('clear.json', 'b', validate);
    cache.save({ token: 't', exp: 1 });
    cache.clear();
    expect(cache.load()).toBeNull();
    expect(() => cache.clear()).not.toThrow();
  });

  it('reports a failed write on stderr and never throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aws-mcp-state-'));
    try {
      const notADir = join(dir, 'file');
      writeFileSync(notADir, 'x');
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const cache = stateCache<Rec>('fail.json', 'b', validate, { MCP_DATA_DIR: notADir });
      let wrote: boolean | undefined;
      expect(() => {
        wrote = cache.save({ token: 't', exp: 1 });
      }).not.toThrow();
      expect(wrote).toBe(false); // the caller can tell it was NOT written
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]![0])).toMatch(/^\[aws-mcp\] WARNING: could not write cache fail\.json: /);
      expect(cache.load()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op when APPLE_STATE_CACHE=false', () => {
    const env = { MCP_DATA_DIR: process.env.MCP_DATA_DIR, APPLE_STATE_CACHE: 'false' };
    const cache = stateCache<Rec>('off.json', 'b', validate, env);
    expect(cache.save({ token: 't', exp: 1 })).toBe(false);
    expect(cache.load()).toBeNull();
    cache.clear();
    expect(existsSync(join(process.env.MCP_DATA_DIR!, STATE_SUBDIR, 'off.json'))).toBe(false);
  });
});
