import { describe, expect, it } from 'vitest';
import {
  APP_PASSWORD_HINT,
  REJECTED_HINT,
  assertNotLatched,
  latchRejection,
  resetICloudLatch,
  resolveICloudCredentials,
} from '../src/icloud-auth.js';
import { ConfigError, CredentialsRejectedError, scrub } from '../src/errors.js';

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

  it('passes an unlatched pair', () => {
    expect(() => assertNotLatched(creds, 'calendar')).not.toThrow();
  });

  it('refuses a latched pair locally (case-insensitive username), until the password changes or the latch resets', () => {
    latchRejection(creds);
    let err: CredentialsRejectedError | undefined;
    try {
      assertNotLatched({ username: 'me@icloud.com', password: creds.password }, 'contacts');
    } catch (e) {
      err = e as CredentialsRejectedError;
    }
    expect(err).toBeInstanceOf(CredentialsRejectedError);
    expect(err!.service).toBe('contacts');
    expect(err!.status).toBe(401);
    expect(err!.hint).toBe(REJECTED_HINT);
    expect(err!.message).not.toContain(creds.password);
    // A rotated password is a different pair.
    expect(() => assertNotLatched({ ...creds, password: 'new1-new1-new1-new1' }, 'contacts')).not.toThrow();
    resetICloudLatch();
    expect(() => assertNotLatched(creds, 'contacts')).not.toThrow();
  });
});
