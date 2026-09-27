import { currentCallSignal } from '@chrischall/mcp-utils';
import {
  ImapFlow,
  type AppendResponseObject,
  type CopyResponseObject,
  type FetchMessageObject,
  type FetchOptions,
  type FetchQueryObject,
  type ImapFlowError,
  type ImapFlowOptions,
  type ListOptions,
  type ListResponse,
  type Logger,
  type MailboxLockObject,
  type MailboxLockOptions,
  type MailboxObject,
  type SearchObject,
  type StatusObject,
  type StatusQuery,
  type StoreOptions,
} from 'imapflow';
import { isDebugLog } from '../config.js';
import {
  AppleToolError,
  CredentialsRejectedError,
  InvalidArgumentError,
  TransportError,
  UnconfirmedWriteError,
  scrub,
} from '../errors.js';
import { REJECTED_HINT, assertNotLatched, latchRejection } from '../icloud-auth.js';
import { VERSION } from '../version.js';
import {
  IMAP_HOST,
  IMAP_PORT,
  loginOrder,
  loginUser,
  mailProxyFor,
  mailTimeoutMs,
  rememberLoginForm,
  type LoginForm,
  type MailAccount,
} from './config.js';
import { ICLOUD_FOLDERS } from './format.js';

/**
 * The IMAP half of iCloud Mail: one connection per tool call (connect → work
 * → logout in `finally`). No pooled or long-lived sockets — a hosted child is
 * idled out after ten minutes and iCloud drops idle sessions silently, so a
 * pool would mostly hold dead connections.
 */

/** The slice of `ImapFlow` this module uses; tests inject a fake. */
export interface ImapClientLike {
  capabilities: Map<string, boolean | number>;
  mailbox: MailboxObject | false;
  /** imapflow's own "is the connection still up" (false once it has closed). */
  usable: boolean;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  on(event: 'error', listener: (err: Error) => void): unknown;
  list(options?: ListOptions): Promise<ListResponse[]>;
  status(path: string, query: StatusQuery): Promise<StatusObject | false>;
  getMailboxLock(path: string, options?: MailboxLockOptions): Promise<MailboxLockObject>;
  search(query: SearchObject, options?: { uid?: boolean }): Promise<number[] | false | undefined>;
  fetchAll(range: string, query: FetchQueryObject, options?: FetchOptions): Promise<FetchMessageObject[]>;
  fetchOne(seq: string, query: FetchQueryObject, options?: FetchOptions): Promise<FetchMessageObject | false | undefined>;
  messageFlagsAdd(range: string, flags: string[], options?: StoreOptions): Promise<boolean>;
  messageFlagsRemove(range: string, flags: string[], options?: StoreOptions): Promise<boolean>;
  messageCopy(range: string, destination: string, options?: { uid?: boolean }): Promise<CopyResponseObject | false>;
  messageMove(range: string, destination: string, options?: { uid?: boolean }): Promise<CopyResponseObject | false>;
  messageDelete(range: string, options?: { uid?: boolean }): Promise<boolean>;
  append(path: string, content: Buffer, flags?: string[], idate?: Date): Promise<AppendResponseObject | false>;
}

export type CreateImapClient = (options: ImapFlowOptions) => ImapClientLike;

export const defaultCreateImapClient: CreateImapClient = (options) => new ImapFlow(options);

/** What one connection's logger saw: the server's text for a failure imapflow swallows into `false`. */
export interface ImapLogState {
  lastServerText?: string;
  /** The whole error of the last failure imapflow logged (and possibly swallowed). */
  lastError?: unknown;
}

/**
 * imapflow's DEFAULT logger is pino at level trace on STDOUT, which would
 * corrupt the stdio JSON-RPC channel — so every client gets this one. It keeps
 * the server's answer from failures imapflow reports only as `false` (COPY,
 * STORE, SEARCH), so an error can say WHY; with APPLE_DEBUG_LOG it also
 * mirrors warnings to stderr, scrubbed.
 */
export function makeImapLogger(state: ImapLogState): Logger {
  const noop = (): void => undefined;
  const note = (level: string) => (obj: unknown): void => {
    const o = (obj ?? {}) as { msg?: unknown; err?: { responseText?: unknown; message?: unknown } };
    if (o.err !== undefined && o.err !== null) state.lastError = o.err;
    const text = o.err?.responseText ?? o.err?.message;
    if (typeof text === 'string' && text) state.lastServerText = text;
    if (isDebugLog()) console.error(`[apple-icloud-mcp] mail imap ${level}: ${scrub(String(o.msg ?? text ?? ''))}`);
  };
  return { trace: noop, debug: noop, info: noop, warn: note('warn'), error: note('error'), fatal: note('error') };
}

export function imapOptions(account: MailAccount, form: LoginForm, logger: Logger): ImapFlowOptions {
  const timeout = mailTimeoutMs();
  const proxy = mailProxyFor(IMAP_HOST);
  return {
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: loginUser(account, form), pass: account.creds.password },
    logger,
    ...(proxy !== undefined ? { proxy } : {}),
    // One command sequence per call: auto-IDLE would only add round trips (and IDLE-break races).
    disableAutoIdle: true,
    connectionTimeout: timeout,
    greetingTimeout: timeout,
    socketTimeout: timeout,
    clientInfo: { name: 'apple-icloud-mcp', version: VERSION },
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** RFC 5530 codes (plus the common THROTTLED) that mean "not now", not "wrong password". */
const TRANSIENT_AUTH_CODES = new Set(['UNAVAILABLE', 'INUSE', 'LIMIT', 'SERVERBUG', 'THROTTLED']);

/** A DEFINITIVE credential rejection: the server answered the login with a tagged NO. */
export function isAuthRejection(err: unknown): boolean {
  const e = err as ImapFlowError | undefined;
  return (
    !!e &&
    e.authenticationFailed === true &&
    e.responseStatus === 'NO' &&
    !TRANSIENT_AUTH_CODES.has(String(e.serverResponseCode ?? '').toUpperCase())
  );
}

const TIMEOUT_CODES = new Set(['ETIMEOUT', 'ETIMEDOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT']);

/** Map an imapflow failure onto the foundation's error vocabulary. `what` names the operation. */
export function mapImapError(err: unknown, what: string): Error {
  if (err instanceof AppleToolError) return err;
  const e = (err ?? {}) as ImapFlowError;
  const text = typeof e.responseText === 'string' && e.responseText ? e.responseText : e.message;
  if (e.code === 'NotFound' || e.mailboxMissing === true || e.serverResponseCode === 'NONEXISTENT') {
    return new AppleToolError('NOT_FOUND', `iCloud Mail: ${what} failed — that mailbox does not exist.`, {
      hint: 'Call apple_mail_list_mailboxes for the exact mailbox paths (aliases: inbox, sent, drafts, trash, junk, archive).',
    });
  }
  if (e.responseStatus === 'NO' || e.responseStatus === 'BAD') {
    const code = String(e.serverResponseCode ?? '').toUpperCase();
    return new AppleToolError(
      code === 'LIMIT' || code === 'THROTTLED' ? 'RATE_LIMITED' : 'UPSTREAM_ERROR',
      `iCloud Mail refused ${what}: ${text || e.responseStatus}.`,
      code === 'OVERQUOTA' ? { hint: 'The iCloud storage quota is full; free space in iCloud to receive or save mail.' } : {},
    );
  }
  if (typeof e.code === 'string' && TIMEOUT_CODES.has(e.code)) {
    return new TransportError('mail', 'TIMEOUT', `iCloud Mail (${IMAP_HOST}) timed out during ${what}.`, err);
  }
  if ((typeof e.code === 'string' && e.code) || e.tlsFailed === true) {
    return new TransportError('mail', 'NETWORK_ERROR', `iCloud Mail (${IMAP_HOST}:${IMAP_PORT}) connection failed during ${what}: ${text}.`, err);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * The same mapping for a write command: a transport failure after the command
 * left means the outcome is UNKNOWN (it may have been applied), which must be
 * said rather than reported as a plain failure.
 */
export function mapImapWriteError(err: unknown, what: string): Error {
  const mapped = mapImapError(err, what);
  if (mapped instanceof TransportError) {
    return new UnconfirmedWriteError('mail', `iCloud Mail: the connection failed during ${what}; it may or may not have been applied.`, err);
  }
  return mapped;
}

/**
 * imapflow's COPY, MOVE, STORE and EXPUNGE catch EVERY error — a server's tagged NO and a
 * connection that died with the command already sent (socket timeout, reset, a cancel's
 * close()) alike — log it, and return `false`. So a `false` alone does not mean "refused".
 * Given the session's recorded failure (cleared right before the command), return the
 * transport error to report when the `false` may hide a write the server DID apply, or
 * undefined when it is a definitive "not applied": a tagged NO/BAD, or no failure at all on a
 * connection that is still up (imapflow declined before sending, e.g. a flag the mailbox
 * cannot take). Anything else is an unknown outcome and must never read as "nothing changed".
 */
export function swallowedWriteFailure(session: ImapSession, what: string): TransportError | undefined {
  const e = session.lastError() as ImapFlowError | undefined;
  if (e ? e.responseStatus === 'NO' || e.responseStatus === 'BAD' : session.client.usable !== false) return undefined;
  const mapped = e ? mapImapError(e, what) : undefined;
  if (mapped instanceof TransportError) return mapped;
  const detail = typeof e?.message === 'string' && e.message ? `: ${e.message}` : '';
  return new TransportError('mail', 'NETWORK_ERROR', `iCloud Mail (${IMAP_HOST}:${IMAP_PORT}) connection failed during ${what}${detail}.`, e);
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface ImapSession {
  client: ImapClientLike;
  /** Which login form iCloud accepted. */
  loginAs: LoginForm;
  /** The server text of the last failure imapflow swallowed, if any. */
  lastServerText(): string | undefined;
  /** The error of the last failure imapflow logged, if any (see swallowedWriteFailure). */
  lastError(): unknown;
  /** Forget the recorded failure — before a write, so a stale one is never read as its outcome. */
  clearLastError(): void;
}

async function connect(create: CreateImapClient, account: MailAccount): Promise<ImapSession> {
  assertNotLatched(account.latchCreds, 'mail');
  const forms = loginOrder(account);
  for (const form of forms) {
    const state: ImapLogState = {};
    const client = create(imapOptions(account, form, makeImapLogger(state)));
    // imapflow emits 'error' after connect; with no listener Node would throw and kill the process.
    client.on('error', (err) => {
      if (isDebugLog()) console.error(`[apple-icloud-mcp] mail imap connection error: ${scrub(String(err?.message ?? err))}`);
    });
    try {
      await client.connect();
    } catch (err) {
      safeClose(client);
      if (isAuthRejection(err)) continue; // try the other login form
      throw mapImapError(err, 'sign-in');
    }
    rememberLoginForm(account, form);
    return {
      client,
      loginAs: form,
      lastServerText: () => state.lastServerText,
      lastError: () => state.lastError,
      clearLastError: () => {
        delete state.lastError;
      },
    };
  }
  // Every login form was refused: definitive. Latch it so a stale app-specific
  // password is not re-sent on every call (that locks Apple IDs).
  latchRejection(account.latchCreds);
  throw new CredentialsRejectedError(
    'mail',
    401,
    forms.length > 1
      ? 'iCloud Mail (IMAP) rejected the sign-in, both as the name part of the mail address and as the full address.'
      : `iCloud Mail (IMAP) rejected the sign-in as ${account.address}.`,
    forms.length > 1
      ? REJECTED_HINT
      : `${REJECTED_HINT} ICLOUD_MAIL_ADDRESS must be an address of this Apple ID's iCloud Mail (normally the @icloud.com one).`,
  );
}

function safeClose(client: ImapClientLike): void {
  try {
    client.close();
  } catch {
    // already closed
  }
}

/** Log out politely, but never let a dead connection hold the call open. */
export async function safeLogout(client: ImapClientLike, graceMs = 5000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.logout(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
        timer.unref();
      }),
    ]);
  } catch {
    // The session is over either way.
  } finally {
    clearTimeout(timer);
    safeClose(client);
  }
}

/**
 * Run `fn` on a freshly signed-in IMAP connection and always log out. Errors
 * from `fn` pass through (map them where the operation is known); a caller
 * cancellation closes the socket so a cancelled call stops costing CPU.
 */
export async function withImap<T>(
  create: CreateImapClient,
  account: MailAccount,
  fn: (session: ImapSession) => Promise<T>,
): Promise<T> {
  const session = await connect(create, account);
  const signal = currentCallSignal();
  const onAbort = (): void => safeClose(session.client);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fn(session);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await safeLogout(session.client);
  }
}

// ---------------------------------------------------------------------------
// Mailboxes
// ---------------------------------------------------------------------------

/** The aliases every mailbox argument accepts, and the special-use flag each stands for. */
export const MAILBOX_ALIASES: Record<string, string> = {
  inbox: '\\Inbox',
  sent: '\\Sent',
  drafts: '\\Drafts',
  trash: '\\Trash',
  junk: '\\Junk',
  archive: '\\Archive',
};

/**
 * Turn a mailbox argument into a server path. `inbox` needs no lookup; the
 * other aliases (and, with `mustExist`, any path) are checked against LIST. A
 * path that does not exist is left for SELECT to reject unless `mustExist` —
 * which the move DESTINATION needs, because imapflow's COPY swallows the
 * server's "no such mailbox" into a bare `false`.
 */
export async function resolveMailbox(client: ImapClientLike, input: string, opts: { mustExist?: boolean } = {}): Promise<string> {
  const name = input.trim();
  const key = name.toLowerCase();
  if (key === 'inbox') return 'INBOX';
  const flag = MAILBOX_ALIASES[key];
  if (flag === undefined && !opts.mustExist) return name;
  const list = await client.list();
  const exact = list.find((m) => m.path === name);
  if (exact) return exact.path;
  if (flag !== undefined) {
    const canonical = ICLOUD_FOLDERS[key] as string;
    const hit = list.find((m) => m.path === canonical) ?? list.find((m) => m.specialUse === flag);
    if (hit) return hit.path;
    throw new AppleToolError('NOT_FOUND', `This account has no ${key} mailbox (looked for "${canonical}" and a ${flag} folder).`, {
      hint: 'Call apple_mail_list_mailboxes for the exact mailbox paths.',
    });
  }
  const folded = list.filter((m) => m.path.toLowerCase() === key);
  if (folded.length === 1) return (folded[0] as ListResponse).path;
  const known = list.map((m) => m.path).slice(0, 40);
  throw new AppleToolError('NOT_FOUND', `Mailbox "${name}" does not exist.`, {
    hint: `Existing mailboxes: ${known.join(', ')}${list.length > known.length ? ', …' : ''}.`,
  });
}

/**
 * SELECT (or EXAMINE, for reads — so nothing can set \Seen by accident) a
 * mailbox and check the caller's UIDVALIDITY. A UID means something only
 * together with the mailbox's UIDVALIDITY: after a renumbering an old UID can
 * name a DIFFERENT message, and acting on it would read, flag or move the
 * wrong mail.
 */
export async function openMailbox(
  client: ImapClientLike,
  path: string,
  opts: { write: boolean; uidValidity?: number | undefined },
): Promise<{ box: MailboxObject; lock: MailboxLockObject; uidValidity: number }> {
  const lock = await client.getMailboxLock(path, { readOnly: !opts.write });
  const box = client.mailbox;
  if (!box) {
    lock.release();
    throw new AppleToolError('UPSTREAM_ERROR', `iCloud Mail: "${path}" could not be opened.`);
  }
  const uidValidity = Number(box.uidValidity);
  if (opts.uidValidity !== undefined && opts.uidValidity !== uidValidity) {
    lock.release();
    throw new InvalidArgumentError(
      `The UIDs for "${box.path}" are out of date: the mailbox was renumbered (uidValidity is now ${uidValidity}, not ${opts.uidValidity}), so they may name different messages.`,
      'Search the mailbox again and use the new uids and uidValidity.',
    );
  }
  return { box, lock, uidValidity };
}

/** A UID set for a command: `5,9,12`. */
export function uidSet(uids: readonly number[]): string {
  return uids.join(',');
}
