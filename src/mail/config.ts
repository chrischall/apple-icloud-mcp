import { createHash } from 'node:crypto';
import { readEnvVar, type EnvSource } from '@chrischall/mcp-utils';
import { getRequestTimeoutMs } from '../config.js';
import { AppleToolError, ConfigError, rememberSecret } from '../errors.js';
import { resolveICloudCredentials, type ICloudCredentials } from '../icloud-auth.js';
import { stateCache, type StateCache } from '../state.js';

/**
 * iCloud Mail account + connection settings, resolved at CALL time.
 *
 * Apple's published settings (support.apple.com/en-us/102525):
 *   IMAP  imap.mail.me.com:993, implicit TLS; username = the NAME PART of the
 *         iCloud Mail address ("emilyparker"), the full address if that fails.
 *   SMTP  smtp.mail.me.com:587, STARTTLS; username = the FULL address.
 * Both take the same app-specific password as CalDAV/CardDAV.
 */

export const IMAP_HOST = 'imap.mail.me.com';
export const IMAP_PORT = 993;
export const SMTP_HOST = 'smtp.mail.me.com';
export const SMTP_PORT = 587;

/** Apple's own mail domains — the ones an Apple ID can double as a mailbox on. */
const ICLOUD_MAIL_DOMAIN_RE = /@(icloud|me|mac)\.com$/i;

/** Deliberately plain: one `@`, no whitespace, no angle brackets, a dot in the domain. */
export const EMAIL_RE = /^[^\s@<>"(),;:\\[\]]+@[^\s@<>"(),;:\\[\]]+\.[^\s@<>"(),;:\\[\]]+$/;

export const ADDRESS_HINT =
  'Set ICLOUD_MAIL_ADDRESS to your iCloud Mail address (e.g. name@icloud.com). It is needed when ICLOUD_USERNAME ' +
  '(your Apple ID) is not itself an @icloud.com, @me.com or @mac.com address.';

export interface MailAccount {
  /** The Apple ID + app-specific password (as `resolveICloudCredentials` returned them). */
  creds: ICloudCredentials;
  /** The iCloud Mail address: the From address and the SMTP login. */
  address: string;
  /** The name part of `address` — the IMAP login Apple documents first. */
  localPart: string;
  /** Where the address came from (names only). */
  addressSource: 'ICLOUD_MAIL_ADDRESS' | 'ICLOUD_USERNAME';
  /**
   * The pair the rejection latch is keyed on: the MAIL login + password. Keyed
   * on the mail address (not ICLOUD_USERNAME) so a typo in ICLOUD_MAIL_ADDRESS
   * that IMAP rejects cannot also latch Calendar/Contacts, which log in with
   * ICLOUD_USERNAME. When the two are the same address this is the same pair
   * the DAV services latch, which is right: it is the same credential.
   */
  latchCreds: ICloudCredentials;
}

/** Resolve the mail account from the environment. Throws `ConfigError` when unconfigured. No I/O. */
export function resolveMailAccount(env: EnvSource = process.env): MailAccount {
  const creds = resolveICloudCredentials('mail', env);
  const explicit = readEnvVar('ICLOUD_MAIL_ADDRESS', { env })?.trim();
  let address: string;
  let addressSource: MailAccount['addressSource'];
  if (explicit) {
    if (!EMAIL_RE.test(explicit)) {
      throw new ConfigError('mail', 'ICLOUD_MAIL_ADDRESS is not an email address.', ['ICLOUD_MAIL_ADDRESS'], ADDRESS_HINT);
    }
    address = explicit;
    addressSource = 'ICLOUD_MAIL_ADDRESS';
  } else if (ICLOUD_MAIL_DOMAIN_RE.test(creds.username.trim()) && EMAIL_RE.test(creds.username.trim())) {
    address = creds.username.trim();
    addressSource = 'ICLOUD_USERNAME';
  } else {
    throw new ConfigError(
      'mail',
      'iCloud Mail needs your iCloud Mail address: ICLOUD_USERNAME is not an @icloud.com, @me.com or @mac.com ' +
        'address and ICLOUD_MAIL_ADDRESS is not set.',
      ['ICLOUD_MAIL_ADDRESS'],
      ADDRESS_HINT,
    );
  }
  const localPart = address.slice(0, address.lastIndexOf('@'));
  return { creds, address, localPart, addressSource, latchCreds: { username: address, password: creds.password } };
}

/** Per-attempt connect / greeting / inactivity timeout (APPLE_REQUEST_TIMEOUT_MS, default 30 s). */
export function mailTimeoutMs(env: EnvSource = process.env): number {
  return getRequestTimeoutMs(env);
}

// ---------------------------------------------------------------------------
// Egress proxy
// ---------------------------------------------------------------------------

/**
 * The proxy a raw TCP mail connection must tunnel through, or undefined to
 * connect directly.
 *
 * imapflow and nodemailer open their own sockets, so Node's
 * NODE_USE_ENV_PROXY (which only covers fetch) does not reach them: on
 * mcp-host, where a fenced child's ONLY way out is the CONNECT proxy in
 * HTTPS_PROXY, a direct socket is silently dropped and looks like a timeout.
 * NO_PROXY is honoured the way curl/undici read it (exact host, a domain
 * suffix, or `*`).
 */
export function mailProxyFor(host: string, env: EnvSource = process.env): string | undefined {
  const raw = readEnvVar('HTTPS_PROXY', { env }) ?? readEnvVar('https_proxy', { env });
  if (raw === undefined) return undefined;
  if (bypassesProxy(host, readEnvVar('NO_PROXY', { env }) ?? readEnvVar('no_proxy', { env }))) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(
      'mail',
      'HTTPS_PROXY is set but is not a valid URL, so the mail connection cannot be tunnelled.',
      ['HTTPS_PROXY'],
      'Set HTTPS_PROXY to a URL like http://127.0.0.1:8080, or unset it to connect directly.',
    );
  }
  // A proxy password must never surface in an error or a log — in either spelling.
  if (url.password) {
    rememberSecret(url.password);
    try {
      rememberSecret(decodeURIComponent(url.password));
    } catch {
      // Not valid percent-encoding: the libraries use it as written, which is remembered above.
    }
  }
  return raw;
}

function bypassesProxy(host: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const h = host.toLowerCase();
  for (const part of noProxy.split(/[\s,]+/)) {
    const entry = part.trim().toLowerCase().replace(/:\d+$/, '');
    if (!entry) continue;
    if (entry === '*') return true;
    const bare = entry.replace(/^\*?\./, '');
    if (h === bare || h.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/** Only HTTP CONNECT proxies can carry SMTP here (nodemailer needs an extra module for SOCKS). */
export function assertHttpProxy(proxy: string): URL {
  const url = new URL(proxy);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppleToolError(
      'UNSUPPORTED',
      `Sending mail through a ${url.protocol.replace(/:$/, '')} proxy is not supported; SMTP needs an http:// CONNECT proxy.`,
      { hint: 'Point HTTPS_PROXY at an HTTP CONNECT proxy, or unset it to connect directly.' },
    );
  }
  return url;
}

// ---------------------------------------------------------------------------
// Which IMAP login form works (remembered per process, and across restarts)
// ---------------------------------------------------------------------------

export type LoginForm = 'local' | 'full';

const workingForm = new Map<string, LoginForm>();

function credentialKey(account: MailAccount): string {
  return `${account.address.toLowerCase()}\u0000${account.creds.password}`;
}

function formKey(account: MailAccount): string {
  return createHash('sha256').update(credentialKey(account)).digest('hex');
}

/**
 * The on-disk memory of the working form. A hosted child restarts after every
 * ten idle minutes; for an account where only the full address works, each
 * cold start would otherwise spend one FAILED sign-in on the name part first —
 * and failed sign-ins are what get an Apple ID locked. Bound to the address +
 * password (salted digest; neither is written), so rotating either forgets it.
 */
function loginCache(account: MailAccount): StateCache<{ form: LoginForm }> {
  return stateCache<{ form: LoginForm }>('mail-login.json', credentialKey(account), (raw) => {
    const form = (raw as { form?: unknown } | null)?.form;
    return form === 'local' || form === 'full' ? { form } : null;
  });
}

/**
 * Login forms to try, the one that worked last time first.
 *
 * The name-part form exists only for Apple's own domains: iCloud reads a bare name as
 * `<name>@icloud.com`. For any other address (an iCloud+ custom domain) the name part
 * names a DIFFERENT Apple account, so trying it would spend a failed sign-in — the
 * thing that locks Apple IDs — on a stranger's account. Only the full address is tried.
 */
export function loginOrder(account: MailAccount): LoginForm[] {
  if (!ICLOUD_MAIL_DOMAIN_RE.test(account.address)) return ['full'];
  const key = formKey(account);
  let form = workingForm.get(key);
  if (form === undefined) {
    form = loginCache(account).load()?.form;
    if (form !== undefined) workingForm.set(key, form);
  }
  return form === 'full' ? ['full', 'local'] : ['local', 'full'];
}

export function rememberLoginForm(account: MailAccount, form: LoginForm): void {
  const key = formKey(account);
  if (workingForm.get(key) === form) return;
  workingForm.set(key, form);
  loginCache(account).save({ form });
}

export function loginUser(account: MailAccount, form: LoginForm): string {
  return form === 'local' ? account.localPart : account.address;
}

/** Test seam. */
export function resetMailLoginMemory(): void {
  workingForm.clear();
}
