import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withCallSignal } from '@chrischall/mcp-utils';
import { ImapFlow } from 'imapflow';
import { resetMailLoginMemory, resolveMailAccount } from '../../src/mail/config.js';
import {
  defaultCreateImapClient,
  imapOptions,
  isAuthRejection,
  makeImapLogger,
  mapImapError,
  mapImapWriteError,
  openMailbox,
  resolveMailbox,
  safeLogout,
  uidSet,
  withImap,
  type ImapClientLike,
} from '../../src/mail/imap.js';
import {
  AppleToolError,
  CredentialsRejectedError,
  InvalidArgumentError,
  TransportError,
  UnconfirmedWriteError,
} from '../../src/errors.js';
import { FakeMailServer, imapError } from './fake-imap.js';

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of PROXY_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetMailLoginMemory();
  process.env.ICLOUD_USERNAME = 'me@icloud.com';
  process.env.ICLOUD_APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
  process.env.APPLE_STATE_CACHE = 'false';
});
afterEach(() => {
  for (const k of PROXY_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('imapOptions / default client', () => {
  it('connects to imap.mail.me.com:993 with TLS, no stdout logger, no auto-IDLE, bounded timeouts', () => {
    const account = resolveMailAccount();
    const logger = makeImapLogger({});
    const o = imapOptions(account, 'local', logger);
    expect(o).toMatchObject({
      host: 'imap.mail.me.com',
      port: 993,
      secure: true,
      auth: { user: 'me', pass: 'abcd-efgh-ijkl-mnop' },
      disableAutoIdle: true,
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 30_000,
      clientInfo: { name: 'apple-icloud-mcp' },
    });
    expect(o.logger).toBe(logger);
    expect(o.proxy).toBeUndefined();
    expect(imapOptions(account, 'full', logger).auth?.user).toBe('me@icloud.com');
  });

  it('tunnels through HTTPS_PROXY', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:3128';
    expect(imapOptions(resolveMailAccount(), 'local', makeImapLogger({})).proxy).toBe('http://127.0.0.1:3128');
  });

  it('the default factory builds a real ImapFlow without connecting', () => {
    const c = defaultCreateImapClient(imapOptions(resolveMailAccount(), 'local', makeImapLogger({})));
    expect(c).toBeInstanceOf(ImapFlow);
    expect((c as unknown as ImapFlow).options.logger).not.toBe(undefined);
  });
});

describe('makeImapLogger', () => {
  it('is silent on stdout, remembers the server text, mirrors to stderr only in debug mode', () => {
    const log = vi.spyOn(console, 'log');
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const state: { lastServerText?: string } = {};
    const logger = makeImapLogger(state);
    logger.trace?.({ msg: 'x' });
    logger.debug({ msg: 'x' });
    logger.info({ msg: 'x' });
    logger.warn({ err: { responseText: 'Mailbox is full' } });
    expect(state.lastServerText).toBe('Mailbox is full');
    logger.error({ err: { message: 'boom' } });
    expect(state.lastServerText).toBe('boom');
    logger.warn(undefined);
    logger.warn({ err: { responseText: '' } });
    expect(state.lastServerText).toBe('boom');
    expect(err).not.toHaveBeenCalled();
    process.env.APPLE_DEBUG_LOG = 'true';
    process.env.ICLOUD_APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
    resolveMailAccount(); // remembers the password for scrubbing
    logger.fatal?.({ msg: 'login abcd-efgh-ijkl-mnop failed' });
    logger.warn({ err: { responseText: 'server text' } });
    logger.warn({});
    expect(err.mock.calls.map((c) => c[0])).toEqual([
      '[apple-icloud-mcp] mail imap error: login [REDACTED] failed',
      '[apple-icloud-mcp] mail imap warn: server text',
      '[apple-icloud-mcp] mail imap warn: ',
    ]);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('isAuthRejection / mapImapError', () => {
  it('only a tagged NO on login is a definitive rejection', () => {
    expect(isAuthRejection(imapError({ authenticationFailed: true, responseStatus: 'NO', serverResponseCode: 'AUTHENTICATIONFAILED' }))).toBe(true);
    expect(isAuthRejection(imapError({ authenticationFailed: true, responseStatus: 'NO' }))).toBe(true);
    expect(isAuthRejection(imapError({ authenticationFailed: true, responseStatus: 'NO', serverResponseCode: 'unavailable' }))).toBe(false);
    // A throttled sign-in is "not now" (mapImapError calls it RATE_LIMITED): never latched as a bad password.
    expect(isAuthRejection(imapError({ authenticationFailed: true, responseStatus: 'NO', serverResponseCode: 'THROTTLED' }))).toBe(false);
    expect(isAuthRejection(imapError({ authenticationFailed: true, code: 'NoConnection' }))).toBe(false);
    expect(isAuthRejection(imapError({ authenticationFailed: true, responseStatus: 'BAD' }))).toBe(false);
    expect(isAuthRejection(undefined)).toBe(false);
  });

  it('maps imapflow failures onto the foundation errors', () => {
    const tool = new AppleToolError('NOT_FOUND', 'x');
    expect(mapImapError(tool, 'w')).toBe(tool);
    for (const missing of [{ code: 'NotFound' }, { mailboxMissing: true }, { serverResponseCode: 'NONEXISTENT', responseStatus: 'NO' }]) {
      const e = mapImapError(imapError(missing), 'opening');
      expect((e as AppleToolError).code).toBe('NOT_FOUND');
    }
    const no = mapImapError(imapError({ responseStatus: 'NO', responseText: 'Over quota', serverResponseCode: 'OVERQUOTA' }), 'saving');
    expect(no).toMatchObject({ code: 'UPSTREAM_ERROR', message: 'iCloud Mail refused saving: Over quota.' });
    expect((no as AppleToolError).hint).toMatch(/storage quota/);
    const bad = mapImapError(imapError({ responseStatus: 'BAD' }, ''), 'x');
    expect(bad.message).toBe('iCloud Mail refused x: BAD.');
    expect((mapImapError(imapError({ responseStatus: 'NO', serverResponseCode: 'LIMIT' }), 'x') as AppleToolError).code).toBe('RATE_LIMITED');
    expect((mapImapError(imapError({ responseStatus: 'NO', serverResponseCode: 'THROTTLED' }), 'x') as AppleToolError).code).toBe('RATE_LIMITED');
    for (const code of ['ETIMEOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT', 'ETIMEDOUT']) {
      const e = mapImapError(imapError({ code }), 'sign-in');
      expect(e).toBeInstanceOf(TransportError);
      expect((e as TransportError).code).toBe('TIMEOUT');
    }
    const net = mapImapError(imapError({ code: 'EPROXY' }, 'Invalid response from proxy: 403'), 'sign-in');
    expect(net).toBeInstanceOf(TransportError);
    expect(net.message).toContain('Invalid response from proxy: 403');
    expect((mapImapError(imapError({ tlsFailed: true }, 'bad cert'), 'x') as TransportError).code).toBe('NETWORK_ERROR');
    const plain = new TypeError('bug');
    expect(mapImapError(plain, 'x')).toBe(plain);
    expect(mapImapError('weird', 'x').message).toBe('weird');
    expect(mapImapError(null, 'x').message).toBe('null');
  });

  it('turns a transport failure during a write into an unconfirmed write', () => {
    expect(mapImapWriteError(imapError({ code: 'NoConnection' }), 'moving')).toBeInstanceOf(UnconfirmedWriteError);
    expect((mapImapWriteError(imapError({ responseStatus: 'NO' }), 'moving') as AppleToolError).code).toBe('UPSTREAM_ERROR');
  });
});

describe('withImap', () => {
  it('signs in with the name part, runs, logs out, and remembers the form', async () => {
    const server = new FakeMailServer();
    const account = resolveMailAccount();
    const out = await withImap(server.factory, account, async (s) => {
      expect(s.loginAs).toBe('local');
      expect(s.lastServerText()).toBeUndefined();
      return 'done';
    });
    expect(out).toBe('done');
    expect(server.created.map((o) => o.auth?.user)).toEqual(['me']);
    expect(server.clients[0]?.loggedOut).toBe(true);
    expect(server.clients[0]?.closed).toBe(true);
    expect(server.clients[0]?.errorListeners).toHaveLength(1);
  });

  it('falls back to the full address and starts there next time', async () => {
    const server = new FakeMailServer();
    server.acceptUsers = ['me@icloud.com'];
    const account = resolveMailAccount();
    await withImap(server.factory, account, async (s) => expect(s.loginAs).toBe('full'));
    await withImap(server.factory, account, async () => undefined);
    expect(server.created.map((o) => o.auth?.user)).toEqual(['me', 'me@icloud.com', 'me@icloud.com']);
    expect(server.clients[0]?.closed).toBe(true);
  });

  it('latches a definitive rejection of both forms and never re-sends the pair', async () => {
    const server = new FakeMailServer();
    server.acceptUsers = [];
    const account = resolveMailAccount();
    await expect(withImap(server.factory, account, async () => 1)).rejects.toBeInstanceOf(CredentialsRejectedError);
    expect(server.created).toHaveLength(2);
    await expect(withImap(server.factory, account, async () => 1)).rejects.toThrow(/already rejected/);
    expect(server.created).toHaveLength(2);
  });

  it('a custom-domain address signs in with the full address only, never the name part', async () => {
    process.env.ICLOUD_MAIL_ADDRESS = 'me@mydomain.example';
    const server = new FakeMailServer();
    server.acceptUsers = ['me@mydomain.example'];
    await withImap(server.factory, resolveMailAccount(), async (s) => expect(s.loginAs).toBe('full'));
    expect(server.created.map((o) => o.auth?.user)).toEqual(['me@mydomain.example']);

    const refused = new FakeMailServer();
    refused.acceptUsers = [];
    const err = await withImap(refused.factory, resolveMailAccount(), async () => 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialsRejectedError);
    expect((err as CredentialsRejectedError).message).toBe('iCloud Mail (IMAP) rejected the sign-in as me@mydomain.example.');
    expect((err as CredentialsRejectedError).hint).toMatch(/ICLOUD_MAIL_ADDRESS must be an address of this Apple ID/);
    // One attempt, and "me" (someone else's me@icloud.com) was never tried.
    expect(refused.created.map((o) => o.auth?.user)).toEqual(['me@mydomain.example']);
  });

  it('does not latch a transient failure', async () => {
    const server = new FakeMailServer();
    server.connectError = imapError({ code: 'CONNECT_TIMEOUT' }, 'Connection timed out');
    const account = resolveMailAccount();
    await expect(withImap(server.factory, account, async () => 1)).rejects.toMatchObject({ code: 'TIMEOUT' });
    server.connectError = imapError({ authenticationFailed: true, responseStatus: 'NO', serverResponseCode: 'UNAVAILABLE' });
    await expect(withImap(server.factory, account, async () => 1)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    server.connectError = undefined;
    await expect(withImap(server.factory, account, async () => 1)).resolves.toBe(1);
  });

  it('logs out even when the work fails, and passes the error through', async () => {
    const server = new FakeMailServer();
    const boom = new Error('boom');
    await expect(withImap(server.factory, resolveMailAccount(), async () => Promise.reject(boom))).rejects.toBe(boom);
    expect(server.clients[0]?.loggedOut).toBe(true);
  });

  it('closes the socket when the caller cancels', async () => {
    const server = new FakeMailServer();
    const ac = new AbortController();
    const client = await withCallSignal(ac.signal, () =>
      withImap(server.factory, resolveMailAccount(), async ({ client }) => {
        ac.abort();
        return client;
      }),
    );
    expect(server.callsOf('close').length).toBeGreaterThanOrEqual(2);
    expect((client as unknown as { closed: boolean }).closed).toBe(true);
  });

  it('keeps an error listener that logs only in debug mode', async () => {
    const server = new FakeMailServer();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await withImap(server.factory, resolveMailAccount(), async ({ client }) => {
      const listener = (client as unknown as { errorListeners: Array<(e: Error) => void> }).errorListeners[0] as (e: Error) => void;
      listener(new Error('socket reset'));
      expect(spy).not.toHaveBeenCalled();
      process.env.APPLE_DEBUG_LOG = '1';
      listener(new Error('socket reset'));
      listener(undefined as unknown as Error);
    });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      '[apple-icloud-mcp] mail imap connection error: socket reset',
      '[apple-icloud-mcp] mail imap connection error: undefined',
    ]);
  });
});

describe('safeLogout', () => {
  it('closes even when logout throws or hangs', async () => {
    const server = new FakeMailServer();
    const c1 = server.factory({});
    server.override('logout', () => Promise.reject(new Error('dead')), 1);
    await safeLogout(c1);
    expect(server.callsOf('close')).toHaveLength(1);
    const c2 = server.factory({});
    server.override('logout', () => new Promise(() => undefined), 1);
    await safeLogout(c2, 5);
    expect(server.callsOf('close')).toHaveLength(2);
    const c3 = server.factory({});
    server.override('close', () => {
      throw new Error('already closed');
    }, 1);
    await expect(safeLogout(c3)).resolves.toBeUndefined();
  });
});

describe('resolveMailbox', () => {
  const client = (server: FakeMailServer): ImapClientLike => server.factory({});

  it('maps inbox without a lookup and literal paths without one', async () => {
    const server = new FakeMailServer();
    const c = client(server);
    expect(await resolveMailbox(c, ' InBoX ')).toBe('INBOX');
    expect(await resolveMailbox(c, 'Work/Receipts')).toBe('Work/Receipts');
    expect(server.callsOf('list')).toHaveLength(0);
  });

  it('resolves aliases through LIST: exact path, iCloud name, then special-use flag', async () => {
    const server = new FakeMailServer();
    const c = client(server);
    expect(await resolveMailbox(c, 'trash')).toBe('Deleted Messages');
    expect(await resolveMailbox(c, 'Archive')).toBe('Archive');
    expect(await resolveMailbox(c, 'sent')).toBe('Sent Messages');
    server.mailboxes.delete('Junk');
    server.addMailbox('Spam', { specialUse: '\\Junk' });
    expect(await resolveMailbox(c, 'junk')).toBe('Spam');
    server.mailboxes.delete('Spam');
    await expect(resolveMailbox(c, 'junk')).rejects.toThrow(/no junk mailbox/);
  });

  it('checks existence when asked, allowing a unique case-insensitive match', async () => {
    const server = new FakeMailServer();
    server.addMailbox('Work');
    const c = client(server);
    expect(await resolveMailbox(c, 'Work', { mustExist: true })).toBe('Work');
    expect(await resolveMailbox(c, 'work', { mustExist: true })).toBe('Work');
    await expect(resolveMailbox(c, 'Nope', { mustExist: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (let i = 0; i < 45; i++) server.addMailbox(`Folder ${i}`);
    server.addMailbox('WORK');
    try {
      await resolveMailbox(c, 'work', { mustExist: true });
      expect.unreachable();
    } catch (err) {
      expect((err as AppleToolError).hint).toMatch(/Existing mailboxes: INBOX, .*, …\.$/);
    }
  });
});

describe('openMailbox', () => {
  it('examines for reads, selects for writes, and returns the uidValidity', async () => {
    const server = new FakeMailServer();
    const c = server.factory({}) as unknown as { readOnly: boolean } & ImapClientLike;
    const r = await openMailbox(c, 'INBOX', { write: false });
    expect(r.uidValidity).toBe(1001);
    expect(c.readOnly).toBe(true);
    await openMailbox(c, 'INBOX', { write: true, uidValidity: 1001 });
    expect(c.readOnly).toBe(false);
  });

  it('refuses stale uids and releases the lock', async () => {
    const server = new FakeMailServer();
    const c = server.factory({});
    await expect(openMailbox(c, 'INBOX', { write: false, uidValidity: 999 })).rejects.toBeInstanceOf(InvalidArgumentError);
    expect(server.callsOf('release')).toHaveLength(1);
  });

  it('fails cleanly if no mailbox ends up selected', async () => {
    const server = new FakeMailServer();
    const c = server.factory({});
    server.override('getMailboxLock', () => ({ path: 'INBOX', release: () => server.calls.push({ method: 'release', args: [] }) }), 1);
    await expect(openMailbox(c, 'INBOX', { write: false })).rejects.toThrow(/could not be opened/);
    expect(server.callsOf('release')).toHaveLength(1);
  });
});

describe('uidSet', () => {
  it('joins uids', () => {
    expect(uidSet([3, 9, 12])).toBe('3,9,12');
  });
});
