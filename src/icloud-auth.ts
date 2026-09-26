import { createHash } from 'node:crypto';
import { readEnvVar, type EnvSource } from '@chrischall/mcp-utils';
import type { ServiceName } from './config.js';
import { ConfigError, CredentialsRejectedError, rememberSecret } from './errors.js';

/**
 * iCloud credentials for the standard protocols — CalDAV (Calendar), CardDAV
 * (Contacts) and IMAP/SMTP (Mail).
 *
 *   ICLOUD_USERNAME      the Apple ID email address
 *   ICLOUD_APP_PASSWORD  an APP-SPECIFIC password (appleid.apple.com → Sign-In
 *                        and Security → App-Specific Passwords), never the
 *                        Apple ID password: iCloud's DAV and mail servers
 *                        accept only app-specific passwords, which need no 2FA
 *                        round trip and can be revoked on their own.
 *
 * Changing the Apple ID password revokes every app-specific password, which
 * is the usual cause of a working setup suddenly returning 401.
 */

export type ICloudService = Extract<ServiceName, 'calendar' | 'contacts' | 'mail'>;

export interface ICloudCredentials {
  username: string;
  password: string;
}

export const APP_PASSWORD_HINT =
  'Set ICLOUD_USERNAME to your Apple ID email and ICLOUD_APP_PASSWORD to an app-specific password ' +
  '(appleid.apple.com → Sign-In and Security → App-Specific Passwords). The regular Apple ID password does not work here.';

export const REJECTED_HINT =
  'iCloud rejected ICLOUD_USERNAME / ICLOUD_APP_PASSWORD. App-specific passwords are revoked whenever the Apple ID ' +
  'password changes; generate a new one at appleid.apple.com and update ICLOUD_APP_PASSWORD. This server will not ' +
  'retry the rejected pair until it changes (repeated failed sign-ins can lock the account).';

export function resolveICloudCredentials(service: ICloudService, env: EnvSource = process.env): ICloudCredentials {
  const username = readEnvVar('ICLOUD_USERNAME', { env });
  const password = readEnvVar('ICLOUD_APP_PASSWORD', { env });
  const missing: string[] = [];
  if (!username) missing.push('ICLOUD_USERNAME');
  if (!password) missing.push('ICLOUD_APP_PASSWORD');
  if (missing.length > 0) {
    throw new ConfigError(
      service,
      `iCloud ${service} needs an Apple ID and an app-specific password; ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set.`,
      missing,
      APP_PASSWORD_HINT,
    );
  }
  rememberSecret(password);
  return { username: username as string, password: password as string };
}

/**
 * The rejection latch. Nothing downstream remembers a failed sign-in, so
 * without this a stale app-specific password would be re-sent on every tool
 * call — and repeated failures are what gets an Apple ID locked. A pair that
 * iCloud DEFINITIVELY rejected (401/403, or an IMAP/SMTP auth failure) is
 * refused locally until the environment changes or the process restarts.
 * Transient failures (timeouts, 5xx) never latch.
 */
const rejected = new Set<string>();

function fingerprint(creds: ICloudCredentials): string {
  return createHash('sha256').update(`${creds.username.toLowerCase()}\u0000${creds.password}`).digest('hex');
}

export function latchRejection(creds: ICloudCredentials): void {
  rejected.add(fingerprint(creds));
}

export function assertNotLatched(creds: ICloudCredentials, service: ICloudService): void {
  if (rejected.has(fingerprint(creds))) {
    throw new CredentialsRejectedError(
      service,
      401,
      `iCloud already rejected this ICLOUD_USERNAME / ICLOUD_APP_PASSWORD pair; not retrying it.`,
      REJECTED_HINT,
    );
  }
}

/** Test seam. */
export function resetICloudLatch(): void {
  rejected.clear();
}
