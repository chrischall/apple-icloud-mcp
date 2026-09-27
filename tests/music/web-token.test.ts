import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppleToolError, ConfigError, scrub } from '../../src/errors.js';
import { httpRequest } from '../../src/http.js';
import { stateCache } from '../../src/state.js';
import {
  BROWSE_URL,
  RECHECK_INTERVAL_MS,
  REFRESH_WINDOW_MS,
  REJECTED_RECHECK_MS,
  WebTokenSource,
  findBundleScripts,
  pickWebToken,
  scrapeWebToken,
  type HttpFn,
} from '../../src/music/web-token.js';
import { fakeJwt, installFetch, route } from './_helpers.js';

const NOW = Date.UTC(2026, 8, 27, 12);
const sec = (ms: number) => Math.floor(ms / 1000);
const DAY = 86_400_000;

const tokenAt = (expMs: number, extra: Record<string, unknown> = {}) =>
  fakeJwt({ iss: 'AMPWebPlay', iat: sec(NOW) - 100, exp: sec(expMs), root_https_origin: ['apple.com'], ...extra });

const PAGE = `<html><head>
<script type="module" crossorigin src="/assets/index~1c4278bfb3.js"></script>
<link rel="stylesheet" href="/assets/index~d1db5b395e.css">
<script nomodule crossorigin id="vite-legacy-entry" data-src="/assets/index-legacy~dc41388d00.js"></script>
</head></html>`;

function bundle(...tokens: string[]): string {
  return tokens.map((t, i) => `const X${i}="${t}";`).join('function(){};');
}

function clearDisk(): void {
  stateCache('music-web-token.json', 'web-token-v1', (v) => v).clear();
}

beforeEach(() => clearDisk());
afterEach(() => clearDisk());

describe('findBundleScripts / pickWebToken', () => {
  it('finds the module bundle and ignores the legacy entry and the stylesheet', () => {
    expect(findBundleScripts(PAGE)).toEqual(['/assets/index~1c4278bfb3.js']);
    expect(findBundleScripts('<script src="https://music.apple.com/assets/index-abc123.js"></script><script src="/assets/index-abc123.js">')).toEqual([
      'https://music.apple.com/assets/index-abc123.js',
      '/assets/index-abc123.js',
    ]);
    expect(findBundleScripts('<html></html>')).toEqual([]);
  });

  it('matches tokens whose header starts {"typ" (eyJ0eXAi…), which an eyJh-only scan would miss', () => {
    const t = tokenAt(NOW + 30 * DAY);
    expect(t.startsWith('eyJ0eXAi')).toBe(true);
    expect(pickWebToken(bundle(t), NOW)).toEqual({ token: t, expiresAt: sec(NOW + 30 * DAY) * 1000 });
  });

  it('prefers iss AMPWebPlay, then the latest exp; falls back to apple.com-scoped tokens; skips expired and junk', () => {
    const older = tokenAt(NOW + 10 * DAY);
    const newer = tokenAt(NOW + 60 * DAY);
    const other = fakeJwt({ iss: 'M62YD85FTQ', exp: sec(NOW + 90 * DAY), root_https_origin: ['apple.com'] });
    const expired = tokenAt(NOW - DAY);
    const junk = 'eyJhbGciOiJ.eyJhYmM.c2ln';
    expect(pickWebToken(bundle(older, other, newer, expired, junk), NOW)?.token).toBe(newer);
    expect(pickWebToken(bundle(other), NOW)?.token).toBe(other);
    const wildcard = fakeJwt({ iss: 'x', exp: sec(NOW + DAY * 5), origin: '*.apple.com' });
    expect(pickWebToken(bundle(wildcard), NOW)?.token).toBe(wildcard);
    const foreign = fakeJwt({ iss: 'x', exp: sec(NOW + DAY * 5), root_https_origin: ['example.com'] });
    const noExp = fakeJwt({ iss: 'AMPWebPlay' });
    expect(pickWebToken(bundle(foreign, expired, noExp, junk), NOW)).toBeUndefined();
  });
});

describe('scrapeWebToken', () => {
  it('reads the page, then the bundle, with the page URL as base', async () => {
    const t = tokenAt(NOW + 30 * DAY);
    const { calls } = installFetch(
      route('GET', '/us/browse', { text: PAGE, headers: { 'content-type': 'text/html' } }, 'music.apple.com'),
      route('GET', '/assets/index~1c4278bfb3.js', { text: bundle(t) }, 'music.apple.com'),
    );
    const got = await scrapeWebToken(httpRequest as HttpFn, () => NOW);
    expect(got.token).toBe(t);
    expect(calls.map((c) => c.url.toString())).toEqual([BROWSE_URL, 'https://music.apple.com/assets/index~1c4278bfb3.js']);
    expect(calls[0]!.headers['user-agent']).toMatch(/Mozilla/);
  });

  it('falls back to the default base when the transport reports no final URL, and tries at most three bundles', async () => {
    const seen: string[] = [];
    const http: HttpFn = async (req) => {
      const url = String(req.url);
      seen.push(url);
      const text = url === BROWSE_URL ? '/assets/index~a.js /assets/index~b.js /assets/index~c.js /assets/index~d.js' : 'no tokens here';
      return { status: 200, headers: new Headers(), url: '', data: text as never, text, bytes: new Uint8Array() };
    };
    await expect(scrapeWebToken(http, () => NOW)).rejects.toThrow(/no unexpired AMPWebPlay token/);
    expect(seen).toEqual([BROWSE_URL, 'https://music.apple.com/assets/index~a.js', 'https://music.apple.com/assets/index~b.js', 'https://music.apple.com/assets/index~c.js']);
  });

  it('says what went wrong when the page has no bundle', async () => {
    installFetch(route('GET', '/us/browse', { text: '<html></html>' }));
    const err = await scrapeWebToken(httpRequest as HttpFn, () => NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppleToolError);
    expect((err as AppleToolError).message).toMatch(/no \/assets\/index~….js module script/);
    expect((err as AppleToolError).hint).toMatch(/APPLE_MUSIC_WEB_DEVELOPER_TOKEN/);
  });
});

describe('WebTokenSource', () => {
  function scrapeRoutes(token: () => string) {
    return installFetch(
      route('GET', '/us/browse', { text: PAGE }),
      route('GET', '/assets/index~1c4278bfb3.js', () => ({ text: bundle(token()) })),
    );
  }

  it('uses APPLE_MUSIC_WEB_DEVELOPER_TOKEN when set (no scrape), and will not "refresh" it', async () => {
    const t = tokenAt(NOW + 30 * DAY);
    process.env.APPLE_MUSIC_WEB_DEVELOPER_TOKEN = t;
    const { calls } = installFetch();
    const src = new WebTokenSource(httpRequest as HttpFn, () => NOW);
    expect(await src.get()).toEqual({ token: t, expiresAt: sec(NOW + 30 * DAY) * 1000, source: 'APPLE_MUSIC_WEB_DEVELOPER_TOKEN' });
    expect(src.invalidate()).toBe(false);
    expect(src.peek()).toEqual({ source: 'APPLE_MUSIC_WEB_DEVELOPER_TOKEN', expiresAt: sec(NOW + 30 * DAY) * 1000 });
    expect(calls).toHaveLength(0);
  });

  it('scrapes once, single-flights concurrent callers, caches in memory and on disk, and scrubs the token', async () => {
    const t = tokenAt(NOW + 30 * DAY);
    const { calls } = scrapeRoutes(() => t);
    const src = new WebTokenSource(httpRequest as HttpFn, () => NOW);
    expect(src.peek()).toEqual({ source: 'music.apple.com' });
    const [a, b] = await Promise.all([src.get(), src.get()]);
    expect(a.token).toBe(t);
    expect(b.token).toBe(t);
    expect(calls).toHaveLength(2);
    await src.get();
    expect(calls).toHaveLength(2);
    expect(scrub(`Bearer x ${t}`)).not.toContain(t);
    expect(src.peek()).toEqual({ source: 'music.apple.com', expiresAt: sec(NOW + 30 * DAY) * 1000 });

    // A second process (new source) reads the disk cache without scraping.
    const src2 = new WebTokenSource(httpRequest as HttpFn, () => NOW);
    expect(src2.peek().expiresAt).toBe(sec(NOW + 30 * DAY) * 1000);
    expect((await src2.get()).token).toBe(t);
    expect(calls).toHaveLength(2);
  });

  it('inside the refresh window it re-reads at most hourly; invalidate() re-reads unless the token was read moments ago', async () => {
    let current = tokenAt(NOW + REFRESH_WINDOW_MS / 2);
    const { calls } = scrapeRoutes(() => current);
    let now = NOW;
    const src = new WebTokenSource(httpRequest as HttpFn, () => now);
    await src.get();
    expect(calls).toHaveLength(2);
    await src.get(); // checked moments ago: no re-read even though it expires within a day
    expect(calls).toHaveLength(2);
    current = tokenAt(NOW + 40 * DAY);
    now = NOW + RECHECK_INTERVAL_MS + 1;
    expect((await src.get()).token).toBe(current);
    expect(calls).toHaveLength(4);
    // Just read from music.apple.com: a re-read would return this same token, so a 401 must not
    // download the web player again (a signed-out media-user-token would do that on every call).
    now += REJECTED_RECHECK_MS - 1;
    expect(src.invalidate()).toBe(false);
    expect(src.peek()).toEqual({ source: 'music.apple.com', expiresAt: sec(NOW + 40 * DAY) * 1000 });
    await src.get();
    expect(calls).toHaveLength(4);
    // Read long enough ago: forget it everywhere and re-read.
    now += 2;
    expect(src.invalidate()).toBe(true);
    expect(src.peek()).toEqual({ source: 'music.apple.com' });
    await src.get();
    expect(calls).toHaveLength(6);
  });

  it('a token restored from disk keeps its read time, so a 401 right after a restart does not re-read either', async () => {
    const t = tokenAt(NOW + 30 * DAY);
    const { calls } = scrapeRoutes(() => t);
    await new WebTokenSource(httpRequest as HttpFn, () => NOW).get();
    expect(calls).toHaveLength(2);
    const restarted = new WebTokenSource(httpRequest as HttpFn, () => NOW + 1000);
    await restarted.get();
    expect(restarted.invalidate()).toBe(false);
    const later = new WebTokenSource(httpRequest as HttpFn, () => NOW + REJECTED_RECHECK_MS);
    await later.get();
    expect(later.invalidate()).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('keeps a still-valid cached token (with a warning) when a refresh fails, backs off, and throws when nothing valid is left', async () => {
    const soon = tokenAt(NOW + REFRESH_WINDOW_MS / 2);
    let fail = false;
    const { calls } = installFetch(
      () => (fail ? { status: 404, text: 'gone' } : undefined),
      route('GET', '/us/browse', { text: PAGE }),
      route('GET', '/assets/index~1c4278bfb3.js', { text: bundle(soon) }),
    );
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let now = NOW;
    const src = new WebTokenSource(httpRequest as HttpFn, () => now);
    await src.get();
    fail = true;
    now = NOW + RECHECK_INTERVAL_MS + 1;
    expect((await src.get()).token).toBe(soon);
    expect(warn.mock.calls.some((c) => /could not refresh the Apple Music web-player token/.test(String(c[0])))).toBe(true);
    const afterFailure = calls.length;
    now += 1000;
    expect((await src.get()).token).toBe(soon); // backed off: no new attempt within the hour
    expect(calls).toHaveLength(afterFailure);
    // A new process sees the same back-off on disk.
    expect((await new WebTokenSource(httpRequest as HttpFn, () => now).get()).token).toBe(soon);
    expect(calls).toHaveLength(afterFailure);
    now = NOW + REFRESH_WINDOW_MS; // past its expiry
    await expect(src.get()).rejects.toThrow(/HTTP 404/);
    warn.mockRestore();
  });

  it('refuses a broken override instead of scraping around it', async () => {
    process.env.APPLE_MUSIC_WEB_DEVELOPER_TOKEN = 'garbage';
    const src = new WebTokenSource(httpRequest as HttpFn, () => NOW);
    await expect(src.get()).rejects.toBeInstanceOf(ConfigError);
  });

  it('ignores an unusable disk record', async () => {
    stateCache('music-web-token.json', 'web-token-v1', (v) => v).save({ token: 'not-a-jwt', expiresAt: NOW + 50 * DAY });
    const t = tokenAt(NOW + 30 * DAY);
    const { calls } = scrapeRoutes(() => t);
    const src = new WebTokenSource(httpRequest as HttpFn, () => NOW);
    expect((await src.get()).token).toBe(t);
    expect(calls).toHaveLength(2);
    stateCache('music-web-token.json', 'web-token-v1', (v) => v).save('nonsense');
    expect(new WebTokenSource(httpRequest as HttpFn, () => NOW).peek()).toEqual({ source: 'music.apple.com' });
  });

  it('works with the disk cache disabled (APPLE_STATE_CACHE=false)', async () => {
    process.env.APPLE_STATE_CACHE = 'false';
    const t = tokenAt(NOW + 30 * DAY);
    const { calls } = scrapeRoutes(() => t);
    await new WebTokenSource(httpRequest as HttpFn, () => NOW).get();
    await new WebTokenSource(httpRequest as HttpFn, () => NOW).get();
    expect(calls).toHaveLength(4);
  });
});
