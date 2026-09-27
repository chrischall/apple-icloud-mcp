import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertHttpProxy,
  loginOrder,
  loginUser,
  mailProxyFor,
  mailTimeoutMs,
  rememberLoginForm,
  resetMailLoginMemory,
  resolveMailAccount,
} from '../../src/mail/config.js';
import { AppleToolError, ConfigError, scrub } from '../../src/errors.js';

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of PROXY_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetMailLoginMemory();
  process.env.APPLE_STATE_CACHE = 'false';
});
afterEach(() => {
  for (const k of PROXY_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveMailAccount', () => {
  it('needs the iCloud credentials', () => {
    expect(() => resolveMailAccount()).toThrow(ConfigError);
  });

  it('uses an @icloud.com Apple ID as the mail address', () => {
    process.env.ICLOUD_USERNAME = 'Jane.Doe@iCloud.com';
    process.env.ICLOUD_APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
    const a = resolveMailAccount();
    expect(a.address).toBe('Jane.Doe@iCloud.com');
    expect(a.localPart).toBe('Jane.Doe');
    expect(a.addressSource).toBe('ICLOUD_USERNAME');
    expect(a.latchCreds).toEqual({ username: 'Jane.Doe@iCloud.com', password: 'abcd-efgh-ijkl-mnop' });
  });

  it('accepts @me.com and @mac.com', () => {
    process.env.ICLOUD_APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
    process.env.ICLOUD_USERNAME = 'x@me.com';
    expect(resolveMailAccount().address).toBe('x@me.com');
    process.env.ICLOUD_USERNAME = 'x@mac.com';
    expect(resolveMailAccount().address).toBe('x@mac.com');
  });

  it('asks for ICLOUD_MAIL_ADDRESS when the Apple ID is not an iCloud address', () => {
    process.env.ICLOUD_USERNAME = 'jane@gmail.com';
    process.env.ICLOUD_APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
    try {
      resolveMailAccount();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).missing).toEqual(['ICLOUD_MAIL_ADDRESS']);
      expect((err as ConfigError).message).not.toContain('gmail');
    }
  });

  it('prefers ICLOUD_MAIL_ADDRESS and keys the latch on it', () => {
    process.env.ICLOUD_USERNAME = 'jane@gmail.com';
    process.env.ICLOUD_APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
    process.env.ICLOUD_MAIL_ADDRESS = '  jdoe@icloud.com ';
    const a = resolveMailAccount();
    expect(a).toMatchObject({ address: 'jdoe@icloud.com', localPart: 'jdoe', addressSource: 'ICLOUD_MAIL_ADDRESS' });
    expect(a.latchCreds.username).toBe('jdoe@icloud.com');
    expect(a.creds.username).toBe('jane@gmail.com');
  });

  it('refuses a malformed ICLOUD_MAIL_ADDRESS', () => {
    process.env.ICLOUD_USERNAME = 'jane@icloud.com';
    process.env.ICLOUD_APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
    process.env.ICLOUD_MAIL_ADDRESS = 'not an address';
    expect(() => resolveMailAccount()).toThrow(/ICLOUD_MAIL_ADDRESS is not an email address/);
  });
});

describe('mailTimeoutMs', () => {
  it('follows APPLE_REQUEST_TIMEOUT_MS', () => {
    expect(mailTimeoutMs()).toBe(30_000);
    process.env.APPLE_REQUEST_TIMEOUT_MS = '5000';
    expect(mailTimeoutMs()).toBe(5000);
  });
});

describe('mailProxyFor', () => {
  it('is undefined without HTTPS_PROXY', () => {
    expect(mailProxyFor('imap.mail.me.com')).toBeUndefined();
  });

  it('reads HTTPS_PROXY, then https_proxy', () => {
    process.env.https_proxy = 'http://127.0.0.1:9000';
    expect(mailProxyFor('imap.mail.me.com')).toBe('http://127.0.0.1:9000');
    process.env.HTTPS_PROXY = 'http://127.0.0.1:8080';
    expect(mailProxyFor('imap.mail.me.com')).toBe('http://127.0.0.1:8080');
  });

  it('honours NO_PROXY (exact, suffix, dotted, wildcard, with port) and no_proxy', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:8080';
    process.env.NO_PROXY = 'example.org, ,mail.me.com';
    expect(mailProxyFor('imap.mail.me.com')).toBeUndefined();
    expect(mailProxyFor('mail.me.com')).toBeUndefined();
    expect(mailProxyFor('api.music.apple.com')).toBe('http://127.0.0.1:8080');
    process.env.NO_PROXY = ', :993,.me.com:993';
    expect(mailProxyFor('imap.mail.me.com')).toBeUndefined();
    process.env.NO_PROXY = '*';
    expect(mailProxyFor('anything')).toBeUndefined();
    delete process.env.NO_PROXY;
    process.env.no_proxy = '*.mail.me.com';
    expect(mailProxyFor('smtp.mail.me.com')).toBeUndefined();
    expect(mailProxyFor('notmail.me.com')).toBe('http://127.0.0.1:8080');
  });

  it('refuses an unparseable proxy URL', () => {
    process.env.HTTPS_PROXY = 'not a url';
    expect(() => mailProxyFor('imap.mail.me.com')).toThrow(ConfigError);
  });

  it('remembers a proxy password so it is scrubbed, in both its decoded and URL spellings', () => {
    process.env.HTTPS_PROXY = 'http://user:s3cr3t%21pass@127.0.0.1:8080';
    mailProxyFor('imap.mail.me.com');
    expect(scrub('dial failed s3cr3t!pass')).toBe('dial failed [REDACTED]');
    expect(scrub('proxy http://user:s3cr3t%21pass@127.0.0.1:8080')).toBe('proxy http://user:[REDACTED]@127.0.0.1:8080');
  });

  it('a proxy password that is not valid percent-encoding is still remembered, never a crash', () => {
    process.env.HTTPS_PROXY = 'http://user:100%zzsecret@127.0.0.1:8080';
    expect(mailProxyFor('imap.mail.me.com')).toBe('http://user:100%zzsecret@127.0.0.1:8080');
    expect(scrub('auth 100%zzsecret refused')).toBe('auth [REDACTED] refused');
  });
});

describe('assertHttpProxy', () => {
  it('accepts http and https proxies', () => {
    expect(assertHttpProxy('http://127.0.0.1:1').hostname).toBe('127.0.0.1');
    expect(assertHttpProxy('https://proxy.local:1').protocol).toBe('https:');
  });
  it('refuses SOCKS for SMTP', () => {
    expect(() => assertHttpProxy('socks5://127.0.0.1:1080')).toThrow(AppleToolError);
    expect(() => assertHttpProxy('socks5://127.0.0.1:1080')).toThrow(/socks5 proxy is not supported/);
  });
});

describe('login form memory across restarts', () => {
  it('persists the working form, bound to the credential, and forgets it when the password changes', () => {
    process.env.APPLE_STATE_CACHE = 'true';
    process.env.ICLOUD_USERNAME = 'persist@icloud.com';
    process.env.ICLOUD_APP_PASSWORD = 'aaaa-bbbb-cccc-dddd';
    const a = resolveMailAccount();
    expect(loginOrder(a)).toEqual(['local', 'full']);
    rememberLoginForm(a, 'full');
    rememberLoginForm(a, 'full'); // unchanged: no second write
    resetMailLoginMemory(); // a new process
    expect(loginOrder(a)).toEqual(['full', 'local']);
    const file = join(process.env.MCP_DATA_DIR as string, '.apple-cloud-mcp', 'mail-login.json');
    const stored = readFileSync(file, 'utf8');
    expect(stored).not.toContain('aaaa-bbbb-cccc-dddd');
    expect(stored).not.toContain('persist@icloud.com');
    process.env.ICLOUD_APP_PASSWORD = 'eeee-ffff-gggg-hhhh';
    resetMailLoginMemory();
    expect(loginOrder(resolveMailAccount())).toEqual(['local', 'full']);
    writeFileSync(file, JSON.stringify({ junk: true }));
    resetMailLoginMemory();
    expect(loginOrder(a)).toEqual(['local', 'full']);
    rememberLoginForm(a, 'full');
    rememberLoginForm(a, 'local');
    resetMailLoginMemory();
    expect(loginOrder(a)).toEqual(['local', 'full']);
    expect(readFileSync(file, 'utf8')).toContain('"local"');
    // A correctly bound record whose value is not a login form is ignored.
    const envelope = JSON.parse(readFileSync(file, 'utf8')) as { state: { form: string } };
    envelope.state.form = 'bogus';
    writeFileSync(file, JSON.stringify(envelope));
    resetMailLoginMemory();
    expect(loginOrder(a)).toEqual(['local', 'full']);
    rmSync(file, { force: true });
  });
});

describe('login form memory', () => {
  it('signs in with the full address only when it is not an Apple mail domain', () => {
    // The name part of a custom-domain address would name a different iCloud account.
    process.env.ICLOUD_USERNAME = 'jane@icloud.com';
    process.env.ICLOUD_APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
    process.env.ICLOUD_MAIL_ADDRESS = 'jane@janedoe.dev';
    expect(loginOrder(resolveMailAccount())).toEqual(['full']);
    process.env.ICLOUD_MAIL_ADDRESS = 'jane@Me.com';
    expect(loginOrder(resolveMailAccount())).toEqual(['local', 'full']);
  });

  it('tries the name part first, then remembers what worked', () => {
    process.env.ICLOUD_USERNAME = 'jane@icloud.com';
    process.env.ICLOUD_APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
    const a = resolveMailAccount();
    expect(loginOrder(a)).toEqual(['local', 'full']);
    expect(loginUser(a, 'local')).toBe('jane');
    expect(loginUser(a, 'full')).toBe('jane@icloud.com');
    rememberLoginForm(a, 'full');
    expect(loginOrder(a)).toEqual(['full', 'local']);
    rememberLoginForm(a, 'local');
    expect(loginOrder(a)).toEqual(['local', 'full']);
    rememberLoginForm(a, 'full');
    resetMailLoginMemory();
    expect(loginOrder(a)).toEqual(['local', 'full']);
  });
});
