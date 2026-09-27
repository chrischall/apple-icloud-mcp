import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readEnvVar, type EnvSource } from '@chrischall/mcp-utils';
import type { ServiceName } from './config.js';
import { ConfigError, CredentialsRejectedError, rememberSecret } from './errors.js';
import { stateCache } from './state.js';

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
  'password changes; generate a new one at appleid.apple.com and update ICLOUD_APP_PASSWORD. Repeated failed ' +
  'sign-ins can lock the account, so this server will not send the rejected pair again for 24 hours, or until the ' +
  'username or password changes; the refusal survives a restart unless APPLE_STATE_CACHE=false.';

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
 * refused locally for {@link LATCH_TTL_MS} (24 h), or until the pair changes.
 * Transient failures (timeouts, 5xx) never latch.
 *
 * The latch is kept in memory AND on disk (`icloud-rejected.json` under
 * `$MCP_DATA_DIR/.apple-icloud-mcp`, via `state.ts`). The disk copy is the one that
 * matters on mcp-host: a child is stopped after ten idle minutes, and
 * `persist: user` credentials are re-injected into every new one, so a latch
 * that lived only in memory re-sent a revoked password on every cold start.
 * The file holds a salted digest of each rejected pair's fingerprint plus
 * when it was latched — never the username or the password — and is ignored
 * when `APPLE_STATE_CACHE=false` (the latch then lasts only as long as the
 * process).
 *
 * Why it expires: a spurious 401 (an Apple outage, a proxy mangling the
 * header) must not lock iCloud out until someone rotates the password. After
 * 24 h ONE attempt is allowed through; if iCloud rejects it again it re-latches.
 */
export const LATCH_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How far in the FUTURE a latch time may lie and still count. A record dated
 * later than that (the clock was set back, or the file was edited) is ignored
 * rather than honoured until some arbitrary date.
 */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Most rejected pairs remembered on disk (newest kept). */
export const MAX_PERSISTED_LATCHES = 16;

export const LATCH_FILE = 'icloud-rejected.json';

interface PersistedLatch {
  /** Random per entry. */
  salt: string;
  /** HMAC-SHA256(salt, fingerprint) — the fingerprint itself is not written either. */
  digest: string;
  /** Epoch ms. */
  latchedAt: number;
}

interface LatchRecord {
  rejected: PersistedLatch[];
}

interface Latch {
  latchedAt: number;
  /** Read back from disk, i.e. latched by an earlier process. */
  restored: boolean;
}

const rejected = new Map<string, Latch>();
/** The disk record as first read by this process (lazy: the check runs before every DAV request). */
let persisted: PersistedLatch[] | undefined;

function fingerprint(creds: ICloudCredentials): string {
  return createHash('sha256').update(`${creds.username.toLowerCase()}\u0000${creds.password}`).digest('hex');
}

function saltedDigest(salt: string, fp: string): string {
  return createHmac('sha256', salt).update(fp).digest('hex');
}

function isActive(latchedAt: number, now: number): boolean {
  return latchedAt <= now + CLOCK_SKEW_MS && now - latchedAt < LATCH_TTL_MS;
}

function validateLatchRecord(raw: unknown): LatchRecord | null {
  const list = (raw as { rejected?: unknown } | null)?.rejected;
  if (!Array.isArray(list)) return null;
  return {
    rejected: list.filter(
      (e): e is PersistedLatch =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as PersistedLatch).salt === 'string' &&
        typeof (e as PersistedLatch).digest === 'string' &&
        Number.isFinite((e as PersistedLatch).latchedAt),
    ),
  };
}

function latchFile() {
  // Bound to a fixed label, not a credential: one file holds every rejected
  // pair (the DAV username pair and the mail address pair differ).
  return stateCache<LatchRecord>(LATCH_FILE, 'icloud-rejected-v1', validateLatchRecord);
}

function readPersisted(): PersistedLatch[] {
  return latchFile().load()?.rejected ?? [];
}

/** When `fp` was latched, if it still is. */
function activeLatch(fp: string, now: number): Latch | undefined {
  const mem = rejected.get(fp);
  if (mem !== undefined) {
    if (isActive(mem.latchedAt, now)) return mem;
    rejected.delete(fp);
  }
  persisted ??= readPersisted();
  const hit = persisted.find((e) => isActive(e.latchedAt, now) && saltedDigest(e.salt, fp) === e.digest);
  if (hit === undefined) return undefined;
  const latch = { latchedAt: hit.latchedAt, restored: true };
  rejected.set(fp, latch);
  return latch;
}

export function latchRejection(creds: ICloudCredentials): void {
  const fp = fingerprint(creds);
  const now = Date.now();
  rejected.set(fp, { latchedAt: now, restored: false });
  const salt = randomBytes(16).toString('hex');
  // Re-read rather than trust the memo: keep what is still active, drop this
  // pair's older entry, newest last, bounded.
  const next = [
    ...readPersisted().filter((e) => isActive(e.latchedAt, now) && saltedDigest(e.salt, fp) !== e.digest),
    { salt, digest: saltedDigest(salt, fp), latchedAt: now },
  ].slice(-MAX_PERSISTED_LATCHES);
  latchFile().save({ rejected: next });
  persisted = next;
}

export function assertNotLatched(creds: ICloudCredentials, service: ICloudService): void {
  const now = Date.now();
  const latch = activeLatch(fingerprint(creds), now);
  if (latch !== undefined) {
    const at = new Date(latch.latchedAt).toISOString();
    const until = new Date(latch.latchedAt + LATCH_TTL_MS).toISOString();
    throw new CredentialsRejectedError(
      service,
      401,
      `iCloud already rejected this ICLOUD_USERNAME / ICLOUD_APP_PASSWORD pair at ${at}` +
        `${latch.restored ? ' (remembered from an earlier run of this server)' : ''}; ` +
        `not retrying it before ${until} unless it changes.`,
      REJECTED_HINT,
    );
  }
}

/**
 * Test seam: forget every latch — in memory AND on disk. `memoryOnly`
 * forgets only what this process holds, which is what a restart does.
 */
export function resetICloudLatch(opts: { memoryOnly?: boolean } = {}): void {
  rejected.clear();
  persisted = undefined;
  if (!opts.memoryOnly) latchFile().clear();
}
