import { decodeJwtPayload } from '../apple-keys.js';
import { AppleToolError, errorMessage, rememberSecret } from '../errors.js';
import type { HttpRequest, HttpResponse } from '../http.js';
import { stateCache } from '../state.js';
import { webDeveloperTokenOverride } from './credentials.js';

/**
 * The web-player developer token — the JWT music.apple.com's own JavaScript
 * sends to amp-api.music.apple.com.
 *
 * Apple embeds it as a string literal in the web player's module bundle
 * (`/assets/index~<hash>.js`), rotates it with each web deploy (about ten
 * weeks of life), and pins it to apple.com origins with a
 * `root_https_origin` claim — which is why every web call sends
 * `Origin: https://music.apple.com`.
 *
 * NOTE: the tokens in the bundle begin `eyJ0eXAi` (their header is
 * `{"typ":"JWT","alg":"ES256",…}`), so a scan for `eyJh…` (a header that
 * starts with `"alg"`) finds nothing. The scan below matches any JWT whose
 * payload is a JSON object (`eyJ…` . `eyJ…` . sig) and selects by claims.
 *
 * Cached in memory and on disk (`music-web-token.json`) and re-read when less
 * than a day of life remains, or once after a 401.
 */

export type HttpFn = <T = unknown>(req: HttpRequest) => Promise<HttpResponse<T>>;

export const WEB_ORIGIN = 'https://music.apple.com';
export const BROWSE_URL = 'https://music.apple.com/us/browse';
/** Re-read the bundle when the cached token has less than this long to live. */
export const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Inside the refresh window, re-read music.apple.com at most this often. If
 * Apple's live bundle still carries the old token (it has not deployed yet),
 * or the page cannot be read, re-reading 3 MB on every tool call would help
 * nobody.
 */
export const RECHECK_INTERVAL_MS = 60 * 60 * 1000;
/**
 * After a 401, re-read music.apple.com only if the token was last read longer
 * ago than this. A token read minutes ago is what Apple's live bundle carries
 * right now, so re-reading returns the same token — and when the 401 is really
 * about the media-user-token (signed out, expired), every tool call would
 * otherwise re-download ~5 MB of web player to fail the same way.
 */
export const REJECTED_RECHECK_MS = 10 * 60 * 1000;
const MAX_BUNDLES_TRIED = 3;
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const BUNDLE_RE = /(?:https:\/\/music\.apple\.com)?\/assets\/index[~-][A-Za-z0-9_]+\.js/g;
const BROWSER_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,*/*',
  'User-Agent': 'Mozilla/5.0 (compatible; apple-cloud-mcp; +https://github.com/chrischall/apple-cloud-mcp)',
};

export interface WebToken {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
  source: 'APPLE_MUSIC_WEB_DEVELOPER_TOKEN' | 'music.apple.com';
}

interface CachedToken {
  token: string;
  expiresAt: number;
  /** When music.apple.com was last read for it (epoch ms). */
  checkedAt?: number;
}

function validateCached(raw: unknown): CachedToken | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.token !== 'string' || typeof r.expiresAt !== 'number' || !/^eyJ/.test(r.token)) return null;
  return { token: r.token, expiresAt: r.expiresAt, ...(typeof r.checkedAt === 'number' ? { checkedAt: r.checkedAt } : {}) };
}

function diskCache() {
  return stateCache<CachedToken>('music-web-token.json', 'web-token-v1', validateCached);
}

/** Module script paths in the web player's HTML, in page order, de-duplicated. */
export function findBundleScripts(html: string): string[] {
  return [...new Set(html.match(BUNDLE_RE) ?? [])];
}

function isAppleOrigin(value: unknown): boolean {
  const list = Array.isArray(value) ? value : [value];
  return list.some((v) => typeof v === 'string' && (v === 'apple.com' || v.endsWith('.apple.com')));
}

/**
 * Pick the web-player token out of a bundle: prefer `iss: "AMPWebPlay"`,
 * else any token scoped to apple.com origins; among those, the latest
 * still-valid `exp`.
 */
export function pickWebToken(js: string, now: number): CachedToken | undefined {
  const preferred: CachedToken[] = [];
  const fallback: CachedToken[] = [];
  for (const token of new Set(js.match(JWT_RE) ?? [])) {
    const payload = decodeJwtPayload(token);
    const exp = payload?.exp;
    if (!payload || typeof exp !== 'number' || exp * 1000 <= now) continue;
    const entry = { token, expiresAt: exp * 1000 };
    if (payload.iss === 'AMPWebPlay') preferred.push(entry);
    else if (isAppleOrigin(payload.root_https_origin) || isAppleOrigin(payload.origin)) fallback.push(entry);
  }
  const pool = preferred.length > 0 ? preferred : fallback;
  return pool.sort((a, b) => b.expiresAt - a.expiresAt)[0];
}

function scrapeError(why: string): AppleToolError {
  return new AppleToolError('UPSTREAM_ERROR', `music (web): could not read the web-player developer token from music.apple.com — ${why}.`, {
    hint:
      'Apple may have changed the music.apple.com web player. As a workaround set APPLE_MUSIC_WEB_DEVELOPER_TOKEN to the ' +
      'Bearer token a signed-in browser sends to amp-api.music.apple.com (DevTools → Network), or use the official API.',
  });
}

/** Fetch music.apple.com, find its module bundle, and extract the web-player token. */
export async function scrapeWebToken(http: HttpFn, now: () => number): Promise<CachedToken> {
  const page = await http<string>({ service: 'music', method: 'GET', url: BROWSE_URL, headers: BROWSER_HEADERS, responseType: 'text' });
  const scripts = findBundleScripts(page.text);
  if (scripts.length === 0) throw scrapeError('no /assets/index~….js module script was found in the page');
  for (const src of scripts.slice(0, MAX_BUNDLES_TRIED)) {
    const bundle = await http<string>({
      service: 'music',
      method: 'GET',
      url: new URL(src, page.url || BROWSE_URL),
      headers: { ...BROWSER_HEADERS, Accept: '*/*' },
      responseType: 'text',
    });
    const picked = pickWebToken(bundle.text, now());
    if (picked) return picked;
  }
  throw scrapeError('the web player bundle holds no unexpired AMPWebPlay token');
}

/**
 * The web developer token source. One per client; single-flights the scrape
 * so concurrent tool calls share one fetch of the 3 MB bundle.
 */
export class WebTokenSource {
  private cached: CachedToken | undefined;
  private inFlight: Promise<CachedToken> | undefined;

  constructor(
    private readonly http: HttpFn,
    private readonly now: () => number,
  ) {}

  /** A usable token: the env override, else the cached one, else a fresh scrape. */
  async get(): Promise<WebToken> {
    const override = webDeveloperTokenOverride(process.env, this.now());
    if (override) return { ...override, source: 'APPLE_MUSIC_WEB_DEVELOPER_TOKEN' };
    // Not a type predicate: "not fresh" must not narrow the value to undefined.
    const fresh = (t: CachedToken): boolean => {
      const now = this.now();
      if (t.expiresAt - now > REFRESH_WINDOW_MS) return true;
      return t.expiresAt > now && t.checkedAt !== undefined && now - t.checkedAt < RECHECK_INTERVAL_MS;
    };
    const memory = this.cached;
    if (memory && fresh(memory)) return { token: memory.token, expiresAt: memory.expiresAt, source: 'music.apple.com' };
    const stored = diskCache().load();
    if (stored && fresh(stored)) {
      this.cached = stored;
      rememberSecret(stored.token);
      return { token: stored.token, expiresAt: stored.expiresAt, source: 'music.apple.com' };
    }
    const stale = [memory, stored].find((t): t is CachedToken => !!t && t.expiresAt > this.now());
    try {
      const scraped = await this.scrape();
      return { token: scraped.token, expiresAt: scraped.expiresAt, source: 'music.apple.com' };
    } catch (err) {
      if (stale) {
        // Still valid, just inside the refresh window: keep working, say why on stderr.
        console.error(`[apple-cloud-mcp] WARNING: could not refresh the Apple Music web-player token (${errorMessage(err)}); using the cached one until it expires.`);
        const kept = { ...stale, checkedAt: this.now() };
        this.cached = kept;
        diskCache().save(kept);
        return { token: kept.token, expiresAt: kept.expiresAt, source: 'music.apple.com' };
      }
      throw err;
    }
  }

  private scrape(): Promise<CachedToken> {
    if (!this.inFlight) {
      const p = scrapeWebToken(this.http, this.now)
        .then((picked) => {
          const t = { ...picked, checkedAt: this.now() };
          rememberSecret(t.token);
          this.cached = t;
          diskCache().save(t);
          return t;
        })
        .finally(() => {
          this.inFlight = undefined;
        });
      this.inFlight = p;
    }
    return this.inFlight;
  }

  /**
   * Forget the token after a 401. Returns whether a retry can use a DIFFERENT
   * token — false for the env override, which only its owner can change, and
   * false for a token read from music.apple.com moments ago (re-reading would
   * fetch the same one; see REJECTED_RECHECK_MS).
   */
  invalidate(): boolean {
    if (webDeveloperTokenOverride(process.env, this.now())) return false;
    const checkedAt = this.cached?.checkedAt;
    if (checkedAt !== undefined && this.now() - checkedAt < REJECTED_RECHECK_MS) return false;
    this.cached = undefined;
    diskCache().clear();
    return true;
  }

  /** What is known without network I/O (for the healthcheck). */
  peek(): { source: WebToken['source']; expiresAt?: number } {
    const override = webDeveloperTokenOverride(process.env, this.now());
    if (override) return { source: 'APPLE_MUSIC_WEB_DEVELOPER_TOKEN', expiresAt: override.expiresAt };
    const known = this.cached ?? diskCache().load() ?? undefined;
    return known ? { source: 'music.apple.com', expiresAt: known.expiresAt } : { source: 'music.apple.com' };
  }
}
