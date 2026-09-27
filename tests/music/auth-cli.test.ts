import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import {
  AUTH_TIMEOUT_MS,
  MAX_BODY_BYTES,
  SHARED_TOKEN_DEFAULT_DAYS,
  SHARED_TOKEN_MAX_DAYS,
  openInBrowser,
  runMusicAuthCli,
  signInPage,
} from '../../src/music/auth-cli.js';
import { OFFICIAL_DEV, p256Pem } from './_helpers.js';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  createServer: undefined as undefined | ((...a: unknown[]) => unknown),
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: (...a: unknown[]) => (mocks.createServer ? mocks.createServer(...a) : (actual.createServer as (...x: unknown[]) => unknown)(...a)),
  };
});

interface Res {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function send(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: opts.method ?? 'GET', headers: opts.headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const KEY_ENV = () => ({ APPLE_TEAM_ID: 'TEAM123456', APPLE_KEY_ID: 'KEY1234567', APPLE_PRIVATE_KEY: p256Pem() });
const TOKEN = 'AmXyZ0123456789+/abcdefghijklmnop=';

function start(argv: string[] = ['--no-open'], extra: Parameters<typeof runMusicAuthCli>[1] = {}) {
  const out: string[] = [];
  const errs: string[] = [];
  let resolveUrl: (u: string) => void = () => undefined;
  const urlP = new Promise<string>((r) => (resolveUrl = r));
  const done = runMusicAuthCli(argv, {
    stdout: (t) => out.push(t),
    stderr: (t) => errs.push(t),
    env: KEY_ENV(),
    onListening: (u) => resolveUrl(u),
    ...extra,
  });
  return { out, errs, done, urlP };
}

function origin(url: string): string {
  return new URL(url).origin;
}

beforeEach(() => {
  mocks.spawn.mockReset();
  mocks.createServer = undefined;
});
afterEach(() => {
  mocks.createServer = undefined;
});

describe('runMusicAuthCli: arguments and configuration', () => {
  it('--help prints usage (to real stderr by default) and exits 0', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await runMusicAuthCli(['-h'])).toBe(0);
    expect(String(write.mock.calls[0]?.[0])).toMatch(/Usage: apple-icloud-mcp music-auth \[--no-open\]/);
    write.mockRestore();
  });

  it('an unknown argument exits 2', async () => {
    const errs: string[] = [];
    expect(await runMusicAuthCli(['--bogus'], { stderr: (t) => errs.push(t) })).toBe(2);
    expect(errs[0]).toMatch(/Unknown argument: --bogus/);
  });

  it('without a developer key it explains what to set and exits 1', async () => {
    const errs: string[] = [];
    expect(await runMusicAuthCli([], { stderr: (t) => errs.push(t), env: {} })).toBe(1);
    expect(errs[0]).toMatch(/^Cannot start Apple Music sign-in: .*APPLE_TEAM_ID.*\n.*Media Services/s);
    // Someone without the key is told how to sign in without it — never to obtain the .p8.
    expect(errs[0]).toMatch(/No Apple Developer key\? Ask whoever runs the server for a developer token .*--print-developer-token.*APPLE_MUSIC_DEVELOPER_TOKEN=<that token> npx apple-icloud-mcp music-auth/);
  });

  it('a set-but-broken developer credential is reported as itself, without the "no key?" advice', async () => {
    const errs: string[] = [];
    expect(await runMusicAuthCli([], { stderr: (t) => errs.push(t), env: { APPLE_MUSIC_DEVELOPER_TOKEN: 'garbage' } })).toBe(1);
    expect(errs[0]).toMatch(/not a JWT/);
    expect(errs[0]).not.toMatch(/No Apple Developer key/);
  });

  it('a listener that cannot start exits 1', async () => {
    mocks.createServer = () => {
      const s = new EventEmitter() as EventEmitter & { listen: () => void };
      s.listen = () => s.emit('error', new Error('EACCES'));
      return s;
    };
    const errs: string[] = [];
    expect(await runMusicAuthCli(['--no-open'], { stderr: (t) => errs.push(t), env: KEY_ENV() })).toBe(1);
    expect(errs[0]).toMatch(/Cannot start the local sign-in page: EACCES/);
  });
});

describe('runMusicAuthCli --print-developer-token: a developer token to hand out instead of the .p8', () => {
  function run(argv: string[], env: Record<string, string> = KEY_ENV(), now = Date.parse('2026-09-27T12:00:00Z')) {
    const out: string[] = [];
    const errs: string[] = [];
    mocks.createServer = vi.fn();
    const code = runMusicAuthCli(argv, { stdout: (t) => out.push(t), stderr: (t) => errs.push(t), env, now: () => now });
    return { code, out, errs };
  }
  const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>;

  it(`prints APPLE_MUSIC_DEVELOPER_TOKEN=… signed by the key, valid ${SHARED_TOKEN_DEFAULT_DAYS} days by default, and starts no sign-in page`, async () => {
    const env = KEY_ENV();
    const { code, out, errs } = run(['--print-developer-token'], env);
    expect(await code).toBe(0);
    expect(out).toHaveLength(1);
    const m = /^APPLE_MUSIC_DEVELOPER_TOKEN=(eyJ[\w-]+)\.([\w-]+)\.([\w-]+)\n$/.exec(out[0]!)!;
    expect(m).not.toBeNull();
    expect(decode(m[1]!)).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' });
    const payload = decode(m[2]!);
    expect(payload).toMatchObject({ iss: 'TEAM123456', iat: Date.parse('2026-09-27T12:00:00Z') / 1000 });
    expect((payload.exp as number) - (payload.iat as number)).toBe(SHARED_TOKEN_DEFAULT_DAYS * 86400);
    // A real ES256 signature from the private key (what Apple checks).
    const pub = createPublicKey(createPrivateKey(env.APPLE_PRIVATE_KEY));
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3]!, 'base64url'))).toBe(true);
    // One line of explanation on stderr; the key itself is never printed.
    expect(errs).toHaveLength(1);
    expect(errs[0]!.trimEnd().split('\n')).toHaveLength(1);
    expect(errs[0]).toMatch(/valid until 2026-10-04T12:00:00\.000Z \(7 days\).*instead of the \.p8.*APPLE_MUSIC_DEVELOPER_TOKEN=<token> npx apple-icloud-mcp music-auth/);
    expect(errs[0]).not.toContain('PRIVATE KEY');
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it.each([
    [['--days', '30'], 30, '(30 days)'],
    [['--days=1'], 1, '(1 day)'],
    [['--days', String(SHARED_TOKEN_MAX_DAYS)], SHARED_TOKEN_MAX_DAYS, `(${SHARED_TOKEN_MAX_DAYS} days)`],
  ])('%j sets the lifetime', async (days, n, label) => {
    const { code, out, errs } = run(['--print-developer-token', ...days]);
    expect(await code).toBe(0);
    const payload = decode(out[0]!.split('.')[1]!);
    expect((payload.exp as number) - (payload.iat as number)).toBe(n * 86400);
    expect(errs[0]).toContain(label);
  });

  it.each([['0'], [String(SHARED_TOKEN_MAX_DAYS + 1)], ['1.5'], ['abc'], ['-3'], ['']])('refuses --days %s (exit 2, nothing printed)', async (days) => {
    const { code, out, errs } = run(['--print-developer-token', `--days=${days}`]);
    expect(await code).toBe(2);
    expect(out).toEqual([]);
    expect(errs[0]).toMatch(new RegExp(`--days must be a whole number from 1 to ${SHARED_TOKEN_MAX_DAYS}`));
  });

  it('refuses flags that do not go together, and --days with no value', async () => {
    for (const argv of [['--days', '3'], ['--print-developer-token', '--no-open'], ['--print-developer-token', '--days']]) {
      const { code, out, errs } = run(argv);
      expect(await code, argv.join(' ')).toBe(2);
      expect(out).toEqual([]);
      expect(errs[0]).toMatch(/--days applies only to --print-developer-token|--no-open does not apply|--days needs a number/);
    }
  });

  it('needs the key: nothing configured, or only a pre-minted token, exits 1', async () => {
    const none = run(['--print-developer-token'], {});
    expect(await none.code).toBe(1);
    expect(none.errs[0]).toMatch(/^Cannot mint a developer token: .*APPLE_TEAM_ID/s);
    expect(none.out).toEqual([]);
    const pre = run(['--print-developer-token'], { ...KEY_ENV(), APPLE_MUSIC_DEVELOPER_TOKEN: OFFICIAL_DEV });
    expect(await pre.code).toBe(1);
    expect(pre.errs[0]).toMatch(/APPLE_MUSIC_DEVELOPER_TOKEN is set, so this server signs with that token.*Share that token itself \(it expires 2100-01-01T00:00:00\.000Z\)/);
    expect(pre.out).toEqual([]);
  });

  it('--help documents it', async () => {
    const errs: string[] = [];
    expect(await runMusicAuthCli(['--help'], { stderr: (t) => errs.push(t) })).toBe(0);
    expect(errs[0]).toMatch(/music-auth --print-developer-token \[--days N\]/);
    expect(errs[0]).toMatch(/never the \.p8/);
  });

  it('the printed token is enough for someone WITHOUT the key to run the sign-in', async () => {
    const minted = run(['--print-developer-token'], KEY_ENV(), Date.now());
    expect(await minted.code).toBe(0);
    mocks.createServer = undefined;
    const token = /^APPLE_MUSIC_DEVELOPER_TOKEN=(.+)\n$/.exec(minted.out[0]!)![1]!;
    const { out, done, urlP } = start(['--no-open'], { env: { APPLE_MUSIC_DEVELOPER_TOKEN: token } });
    const url = await urlP;
    const page = await send(url);
    expect(/var DEV = "([^"]+)"/.exec(page.body)![1]).toBe(token);
    const tokenPath = /var TOKEN_URL = "([^"]+)"/.exec(page.body)![1]!;
    await send(`${origin(url)}${tokenPath}`, { method: 'POST', headers: { Origin: origin(url), 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    expect(await done).toBe(0);
    expect(out).toEqual([`APPLE_MUSIC_USER_TOKEN=${TOKEN}\n`]);
  });
});

describe('runMusicAuthCli: the local sign-in page', () => {
  it('serves the MusicKit page on a nonce path and prints the token posted back from the same origin', async () => {
    const { out, errs, done, urlP } = start();
    const url = await urlP;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}\/$/);
    expect(errs[0]).toContain(url);
    expect(errs[0]).toMatch(/stops in 5 min/);
    const page = await send(url);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).toContain('https://js-cdn.music.apple.com/musickit/v3/musickit.js');
    const dev = /var DEV = "([^"]+)"/.exec(page.body)![1]!;
    const payload = JSON.parse(Buffer.from(dev.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    expect(payload.iss).toBe('TEAM123456');
    const tokenPath = /var TOKEN_URL = "([^"]+)"/.exec(page.body)![1]!;
    expect(tokenPath).toBe(`${new URL(url).pathname}token`);
    expect((await send(url.replace(/\/$/, ''))).status).toBe(200);
    const posted = await send(`${origin(url)}${tokenPath}`, { method: 'POST', headers: { Origin: origin(url), 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    expect(posted.status).toBe(200);
    expect(posted.body).toMatch(/you can close this tab/);
    expect(await done).toBe(0);
    expect(out).toEqual([`APPLE_MUSIC_USER_TOKEN=${TOKEN}\n`]);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('refuses everything that is not the page GET or a same-origin JSON token POST', async () => {
    const { done, urlP, out } = start();
    const url = await urlP;
    const o = origin(url);
    const tokenUrl = `${url}token`;
    const json = { 'Content-Type': 'application/json', Origin: o };
    expect((await send(url, { headers: { Host: 'evil.example' } })).status).toBe(421);
    expect((await send(`${o}/wrong/`)).status).toBe(404);
    expect((await send(`${o}/`)).status).toBe(404);
    const postPage = await send(url, { method: 'POST' });
    expect(postPage.status).toBe(405);
    expect(postPage.headers.allow).toBe('GET');
    const getToken = await send(tokenUrl);
    expect(getToken.status).toBe(405);
    expect(getToken.headers.allow).toBe('POST');
    expect((await send(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    expect((await send(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await send(tokenUrl, { method: 'POST', headers: { Origin: o, 'Content-Type': 'text/plain' }, body: TOKEN })).status).toBe(415);
    expect((await send(tokenUrl, { method: 'POST', headers: { Origin: o }, body: TOKEN })).status).toBe(415);
    expect((await send(tokenUrl, { method: 'POST', headers: json, body: 'x'.repeat(MAX_BODY_BYTES + 1) })).status).toBe(413);
    expect((await send(tokenUrl, { method: 'POST', headers: json, body: '{not json' })).status).toBe(400);
    expect((await send(tokenUrl, { method: 'POST', headers: json, body: JSON.stringify({ token: 'short' }) })).status).toBe(400);
    expect((await send(tokenUrl, { method: 'POST', headers: json, body: JSON.stringify({ token: 42 }) })).status).toBe(400);
    expect(out).toEqual([]);

    // A browser that abandons a POST mid-body is dropped without an answer.
    await new Promise<void>((resolve) => {
      const u = new URL(tokenUrl);
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { ...json, 'Content-Length': '100' }, agent: false });
      req.on('error', () => resolve());
      req.write('{"tok');
      setTimeout(() => {
        req.destroy();
        setTimeout(resolve, 50);
      }, 20);
    });

    const ok = await send(tokenUrl, { method: 'POST', headers: { ...json, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ token: TOKEN }) });
    expect(ok.status).toBe(200);
    expect(await done).toBe(0);
    expect(out).toEqual([`APPLE_MUSIC_USER_TOKEN=${TOKEN}\n`]);
  });

  it('accepts exactly one token: a second POST racing the first is refused with 409 and never printed', async () => {
    const actual = await vi.importActual<typeof import('node:http')>('node:http');
    let listener: ((req: unknown, res: unknown) => void) | undefined;
    mocks.createServer = (...a: unknown[]) => {
      listener = a[0] as typeof listener;
      return (actual.createServer as (...x: unknown[]) => unknown)(...a);
    };
    let url = '';
    let second: Promise<number> | undefined;
    // Deliver the racing request from inside the first one's stdout write, i.e. after the first token was taken.
    const racing = (): Promise<number> =>
      new Promise((resolve) => {
        const req = Readable.from([Buffer.from(JSON.stringify({ token: `${TOKEN}-second` }))]) as Readable & Record<string, unknown>;
        Object.assign(req, {
          method: 'POST',
          url: `${new URL(url).pathname}token`,
          headers: { host: new URL(url).host, origin: origin(url), 'content-type': 'application/json' },
        });
        const res = { writeHead: (status: number) => resolve(status), end: () => undefined, once: () => undefined };
        listener!(req, res);
      });
    const { out, done, urlP } = start(['--no-open'], {
      stdout: (t) => {
        out.push(t);
        second ??= racing();
      },
    });
    url = await urlP;
    const first = await send(`${url}token`, { method: 'POST', headers: { Origin: origin(url), 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    expect(first.status).toBe(200);
    expect(await done).toBe(0);
    expect(await second).toBe(409);
    expect(out).toEqual([`APPLE_MUSIC_USER_TOKEN=${TOKEN}\n`]);
  });

  it('opens the browser unless --no-open, uses APPLE_MUSIC_DEVELOPER_TOKEN when set, and prints to real stdout by default', async () => {
    const opened: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let resolveUrl: (u: string) => void = () => undefined;
    const urlP = new Promise<string>((r) => (resolveUrl = r));
    const done = runMusicAuthCli([], { stderr: () => undefined, env: { APPLE_MUSIC_DEVELOPER_TOKEN: OFFICIAL_DEV }, open: (u) => opened.push(u), onListening: (u) => resolveUrl(u) });
    const url = await urlP;
    expect(opened).toEqual([url]);
    const page = await send(url);
    expect(page.body).toContain(`var DEV = "${OFFICIAL_DEV}"`);
    await send(`${url}token`, { method: 'POST', headers: { Origin: origin(url), 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    expect(await done).toBe(0);
    expect(write).toHaveBeenCalledWith(`APPLE_MUSIC_USER_TOKEN=${TOKEN}\n`);
    write.mockRestore();
  });

  it('uses the platform launcher by default', async () => {
    mocks.spawn.mockImplementation(() => ({ on: vi.fn(), unref: vi.fn() }));
    const { done, urlP } = start([]);
    const url = await urlP;
    expect(mocks.spawn).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([url]), { stdio: 'ignore', detached: true });
    await send(`${url}token`, { method: 'POST', headers: { Origin: origin(url), 'Content-Type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
    expect(await done).toBe(0);
  });

  it('gives up after the timeout', async () => {
    const { done, errs } = start(['--no-open'], { timeoutMs: 30 });
    expect(await done).toBe(1);
    expect(errs.at(-1)).toMatch(/Timed out waiting for the Apple Music sign-in/);
    expect(AUTH_TIMEOUT_MS).toBe(300_000);
  });
});

describe('openInBrowser', () => {
  it('uses open / cmd start / xdg-open and never throws', () => {
    const child = { on: vi.fn(), unref: vi.fn() };
    mocks.spawn.mockReturnValue(child);
    openInBrowser('http://x/', 'darwin');
    expect(mocks.spawn).toHaveBeenLastCalledWith('open', ['http://x/'], { stdio: 'ignore', detached: true });
    openInBrowser('http://x/', 'win32');
    expect(mocks.spawn).toHaveBeenLastCalledWith('cmd', ['/c', 'start', '""', 'http://x/'], { stdio: 'ignore', detached: true });
    openInBrowser('http://x/', 'linux');
    expect(mocks.spawn).toHaveBeenLastCalledWith('xdg-open', ['http://x/'], { stdio: 'ignore', detached: true });
    openInBrowser('http://x/');
    const onError = child.on.mock.calls[0]![1] as () => void;
    expect(onError()).toBeUndefined();
    expect(child.unref).toHaveBeenCalled();
    mocks.spawn.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(() => openInBrowser('http://x/', 'linux')).not.toThrow();
  });

  it('the page escapes < in embedded values', () => {
    expect(signInPage('a</script>b', '/n/token')).toContain('"a\\u003c/script>b"');
  });
});
