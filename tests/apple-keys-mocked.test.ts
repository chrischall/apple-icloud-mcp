import { describe, expect, it, vi } from 'vitest';

// Key shapes node:crypto cannot be made to produce from a real key: an
// asymmetric key with no reported type, and an EC key whose explicit curve
// parameters OpenSSL could not match to a named curve.
const fakeKey = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, createPrivateKey: () => fakeKey.current };
});

const { validateEcKey } = await import('../src/apple-keys.js');

describe('validateEcKey (shapes only a mock can produce)', () => {
  it('reports a key with no asymmetric type as non-EC', () => {
    fakeKey.current = { asymmetricKeyType: undefined };
    expect(validateEcKey('x')).toBe('it is a non-EC key, not an EC (ES256) key');
  });

  it('refuses an EC key on an unnamed (explicit-parameter) curve instead of assuming P-256', () => {
    fakeKey.current = { asymmetricKeyType: 'ec', asymmetricKeyDetails: {} };
    expect(validateEcKey('x')).toBe('it uses an unnamed curve, not P-256');
    fakeKey.current = { asymmetricKeyType: 'ec' };
    expect(validateEcKey('x')).toBe('it uses an unnamed curve, not P-256');
  });
});
