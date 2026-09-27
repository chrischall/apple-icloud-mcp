import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP_PASSWORD_HINT,
  LATCH_FILE,
  LATCH_TTL_MS,
  MAX_PERSISTED_LATCHES,
  REJECTED_HINT,
  assertNotLatched,
  latchRejection,
  resetICloudLatch,
  resolveICloudCredentials,
} from '../src/icloud-auth.js';
import { ConfigError, CredentialsRejectedError, scrub } from '../src/errors.js';
import { STATE_SUBDIR, stateCache } from '../src/state.js';

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (e) {
    return e as ConfigError;
  }
  throw new Error('expected a ConfigError');
}

describe('resolveICloudCredentials', () => {
  it('names both missing variables, per service, with the app-specific password hint', () => {
    const err = configError(() => resolveICloudCredentials('calendar', {}));
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.service).toBe('calendar');
    expect(err.missing).toEqual(['ICLOUD_USERNAME', 'ICLOUD_APP_PASSWORD']);
    expect(err.message).toBe(
      'iCloud calendar needs an Apple ID and an app-specific password; ICLOUD_USERNAME and ICLOUD_APP_PASSWORD are not set.',
    );
    expect(err.hint).toBe(APP_PASSWORD_HINT);
  });

  it('names a single missing variable, treating placeholders as unset', () => {
    const err = configError(() => resolveICloudCredentials('mail', { ICLOUD_USERNAME: 'me@icloud.com', ICLOUD_APP_PASSWORD: '${ICLOUD_APP_PASSWORD}' }));
    expect(err.missing).toEqual(['ICLOUD_APP_PASSWORD']);
    expect(err.message).toMatch(/ICLOUD_APP_PASSWORD is not set\.$/);
    const noUser = configError(() => resolveICloudCredentials('contacts', { ICLOUD_APP_PASSWORD: 'abcd-efgh-ijkl-mnop' }));
    expect(noUser.missing).toEqual(['ICLOUD_USERNAME']);
  });

  it('returns the pair and registers the password for scrubbing', () => {
    const creds = resolveICloudCredentials('contacts', { ICLOUD_USERNAME: ' me@icloud.com ', ICLOUD_APP_PASSWORD: 'abcd-efgh-ijkl-mnop' });
    expect(creds).toEqual({ username: 'me@icloud.com', password: 'abcd-efgh-ijkl-mnop' });
    expect(scrub('pw abcd-efgh-ijkl-mnop')).toBe('pw [REDACTED]');
  });

  it('reads process.env by default', () => {
    process.env.ICLOUD_USERNAME = 'a@me.com';
    process.env.ICLOUD_APP_PASSWORD = 'wxyz-wxyz-wxyz-wxyz';
    expect(resolveICloudCredentials('mail').username).toBe('a@me.com');
  });
});

describe('rejection latch', () => {
  const creds = { username: 'Me@iCloud.com', password: 'abcd-efgh-ijkl-mnop' };
  const latchPath = () => join(process.env.MCP_DATA_DIR!, STATE_SUBDIR, LATCH_FILE);
  const refusal = (c = creds, service: 'calendar' | 'contacts' | 'mail' = 'contacts'): CredentialsRejectedError | undefined => {
    try {
      assertNotLatched(c, service);
    } catch (e) {
      return e as CredentialsRejectedError;
    }
    return undefined;
  };
  /** What a new process sees: nothing in memory, the same $MCP_DATA_DIR. */
  const restart = () => resetICloudLatch({ memoryOnly: true });

  it('passes an unlatched pair', () => {
    expect(() => assertNotLatched(creds, 'calendar')).not.toThrow();
  });

  it('refuses a latched pair locally (case-insensitive username), until the password changes or the latch resets', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-27T12:00:00Z') });
    latchRejection(creds);
    const err = refusal({ username: 'me@icloud.com', password: creds.password });
    expect(err).toBeInstanceOf(CredentialsRejectedError);
    expect(err!.service).toBe('contacts');
    expect(err!.status).toBe(401);
    expect(err!.hint).toBe(REJECTED_HINT);
    expect(err!.message).toBe(
      'iCloud already rejected this ICLOUD_USERNAME / ICLOUD_APP_PASSWORD pair at 2026-09-27T12:00:00.000Z; ' +
        'not retrying it before 2026-09-28T12:00:00.000Z unless it changes.',
    );
    expect(err!.message).not.toContain(creds.password);
    // A rotated password is a different pair.
    expect(() => assertNotLatched({ ...creds, password: 'new1-new1-new1-new1' }, 'contacts')).not.toThrow();
    resetICloudLatch();
    expect(() => assertNotLatched(creds, 'contacts')).not.toThrow();
    expect(existsSync(latchPath())).toBe(false); // the full reset clears the disk copy too
  });

  it('the hint states what the latch really does: 24 hours or a changed pair, surviving a restart', () => {
    expect(REJECTED_HINT).toContain('for 24 hours');
    expect(REJECTED_HINT).toContain('until the username or password changes');
    expect(REJECTED_HINT).toContain('survives a restart unless APPLE_STATE_CACHE=false');
    expect(LATCH_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('survives a restart (a hosted cold start) without writing the credential, and says it was remembered', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-27T12:00:00Z') });
    latchRejection(creds);
    const raw = readFileSync(latchPath(), 'utf8');
    expect(raw).not.toContain(creds.password);
    expect(raw.toLowerCase()).not.toContain(creds.username.toLowerCase());
    expect(raw).not.toContain('abcd');

    restart();
    const err = refusal(creds, 'calendar');
    expect(err).toBeInstanceOf(CredentialsRejectedError);
    expect(err!.message).toContain('at 2026-09-27T12:00:00.000Z (remembered from an earlier run of this server)');
    // Served from memory from here on, still labelled as restored.
    expect(refusal(creds)!.message).toContain('remembered from an earlier run');
    // A changed pair is not refused after the restart either.
    restart();
    expect(refusal({ ...creds, password: 'new1-new1-new1-new1' })).toBeUndefined();
    expect(refusal({ ...creds, username: 'other@icloud.com' })).toBeUndefined();
  });

  it('expires after 24 hours so one attempt goes through, in memory and after a restart; a new rejection re-latches', () => {
    const t0 = Date.parse('2026-09-27T12:00:00Z');
    vi.useFakeTimers({ now: t0 });
    latchRejection(creds);
    vi.setSystemTime(t0 + LATCH_TTL_MS - 1);
    expect(refusal()).toBeDefined();
    restart();
    expect(refusal()).toBeDefined();
    vi.setSystemTime(t0 + LATCH_TTL_MS);
    expect(refusal()).toBeUndefined(); // memory copy expired
    restart();
    expect(refusal()).toBeUndefined(); // disk copy expired
    // The retry is rejected again: latched afresh, from now.
    latchRejection(creds);
    restart();
    expect(refusal()!.message).toContain(`at ${new Date(t0 + LATCH_TTL_MS).toISOString()}`);
  });

  it('keeps one entry per pair, drops expired entries on write, and bounds the file', () => {
    const t0 = Date.parse('2026-09-27T12:00:00Z');
    vi.useFakeTimers({ now: t0 });
    const entries = () => (JSON.parse(readFileSync(latchPath(), 'utf8')) as { state: { rejected: unknown[] } }).state.rejected;
    latchRejection(creds);
    vi.setSystemTime(t0 + 1000);
    latchRejection(creds);
    expect(entries()).toHaveLength(1);
    vi.setSystemTime(t0 + LATCH_TTL_MS + 1000);
    latchRejection({ ...creds, password: 'b-b-b-b' });
    expect(entries()).toHaveLength(1); // the expired pair was dropped
    const pairs = Array.from({ length: MAX_PERSISTED_LATCHES + 3 }, (_, i) => ({ username: `u${i}@icloud.com`, password: `p${i}` }));
    for (const p of pairs) latchRejection(p);
    expect(entries()).toHaveLength(MAX_PERSISTED_LATCHES);
    restart();
    expect(refusal(pairs[0])).toBeUndefined(); // oldest evicted
    expect(refusal(pairs[3])).toBeDefined();
    expect(refusal(pairs.at(-1))).toBeDefined();
  });

  it('ignores a latch dated in the future beyond clock skew, honours one within it', () => {
    const t0 = Date.parse('2026-09-27T12:00:00Z');
    vi.useFakeTimers({ now: t0 + 60 * 60 * 1000 });
    latchRejection(creds);
    vi.setSystemTime(t0); // the clock was set back an hour
    restart();
    expect(refusal()).toBeUndefined();
    vi.setSystemTime(t0 + 60 * 1000);
    latchRejection(creds);
    vi.setSystemTime(t0);
    expect(refusal()).toBeDefined(); // a minute of skew still counts (memory)
    restart();
    expect(refusal()).toBeDefined(); // and on disk
  });

  it('with APPLE_STATE_CACHE=false it is in memory only (a restart forgets it) and writes nothing', () => {
    process.env.APPLE_STATE_CACHE = 'false';
    latchRejection(creds);
    expect(refusal()).toBeDefined();
    expect(existsSync(latchPath())).toBe(false);
    restart();
    expect(refusal()).toBeUndefined();
  });

  it('tolerates a corrupt or tampered file: bad records are ignored, never fatal', () => {
    const file = stateCache<unknown>(LATCH_FILE, 'icloud-rejected-v1', (x) => x);
    file.save(null);
    restart();
    expect(refusal()).toBeUndefined();
    file.save({ rejected: 'nope' });
    restart();
    expect(refusal()).toBeUndefined();
    // One genuine entry among junk still counts.
    latchRejection(creds);
    const good = (JSON.parse(readFileSync(latchPath(), 'utf8')) as { state: { rejected: unknown[] } }).state.rejected[0];
    file.save({ rejected: ['x', null, { salt: 1 }, { salt: 'a', digest: 2 }, { salt: 'a', digest: 'b', latchedAt: 'x' }, good] });
    restart();
    expect(refusal()).toBeDefined();
    // A record bound to something else is not ours.
    stateCache<unknown>(LATCH_FILE, 'other-binding', (x) => x).save({ rejected: [good] });
    restart();
    expect(refusal()).toBeUndefined();
  });
});
