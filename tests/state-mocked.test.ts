import { afterEach, describe, expect, it, vi } from 'vitest';

// Failure shapes the real file store does not produce on demand: a write that
// throws a non-Error, and a clear() that throws at all.
const store = vi.hoisted(() => ({
  save: vi.fn<(v: unknown) => void>(),
  clear: vi.fn<() => void>(),
  load: vi.fn(() => null),
}));

vi.mock('@chrischall/mcp-utils/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chrischall/mcp-utils/session')>();
  return { ...actual, createFileStatePersistence: () => store };
});

// tests/_setup.ts already imported src/state.js (through src/icloud-auth.js,
// whose latch persists through it) before this file's mock was registered, so
// the cached instance holds the REAL store. Drop it and import a fresh one.
vi.resetModules();
const { stateCache } = await import('../src/state.js');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stateCache (failure shapes)', () => {
  it('reports a non-Error write failure as text', () => {
    store.save.mockImplementation(() => {
      throw 'disk full';
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(stateCache('x.json', 'b', (r) => r).save({ a: 1 })).toBe(false);
    expect(err).toHaveBeenCalledWith('[apple-cloud-mcp] WARNING: could not write cache x.json: disk full');
  });

  it('swallows a failing clear (nothing to clear, or a read-only directory)', () => {
    store.clear.mockImplementation(() => {
      throw new Error('EROFS');
    });
    expect(() => stateCache('x.json', 'b', (r) => r).clear()).not.toThrow();
    expect(store.clear).toHaveBeenCalled();
  });
});
