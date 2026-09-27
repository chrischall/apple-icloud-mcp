import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_TIMEOUT_MS, MAX_BODY_BYTES, openInBrowser, runMusicAuthCli, signInPage } from '../../src/music/auth-cli.js';
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
    expect(String(write.mock.calls[0]?.[0])).toMatch(/Usage: aws-mcp music-auth \[--no-open\]/);
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
