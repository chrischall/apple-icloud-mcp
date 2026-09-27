import { ConfigError, errorMessage } from '../errors.js';
import { makeProbe, type HealthProbe } from '../health.js';
import { formatInstant } from '../time.js';
import { getDisplayTimeZone } from '../config.js';
import type { Backend, MusicClient } from './client.js';
import { defaultMusicClient } from './common.js';
import { ENV, OFFICIAL_SETUP, WEB_SETUP, officialUserToken, resolveOfficialDev, webUserToken } from './credentials.js';
import { firstDataId } from './project.js';

/**
 * `musicHealth` — which Apple Music profiles are configured (never a value),
 * and whether Apple accepts them right now:
 *  - official: a catalog read (a stable song id), plus the account storefront
 *    when a Music User Token is set;
 *  - web: the account storefront on amp-api.
 * Each backend is probed DIRECTLY — no fallback between them — so a rejected
 * official key is reported even when web mode would have covered for it.
 */

export const PROBE_SONG_ID = '1440833851';
export const PROBE_LABEL =
  `official: GET /v1/catalog/us/songs/${PROBE_SONG_ID} (+ GET /v1/me/storefront with a user token); web: GET /v1/me/storefront`;

async function probe(c: MusicClient, b: Backend, path: string): Promise<string | undefined> {
  const res = await c.send(b, { path });
  if (res.status === 401) throw c.rejected401(b, 'GET', path, res.text);
  try {
    return firstDataId(JSON.parse(res.text) as unknown);
  } catch {
    return undefined;
  }
}

export function makeMusicHealth(getClient: () => MusicClient = defaultMusicClient): HealthProbe {
  return makeProbe({
    service: 'music',
    resolve: () => {
      const c = getClient();
      const official = resolveOfficialDev(process.env, c.now());
      const userToken = officialUserToken();
      const web = webUserToken();
      if (official.status === 'absent' && !web) {
        throw new ConfigError(
          'music',
          'Apple Music is not configured.',
          ['APPLE_TEAM_ID + APPLE_KEY_ID + APPLE_PRIVATE_KEY (or APPLE_MUSIC_DEVELOPER_TOKEN)', ENV.webUserToken],
          `${OFFICIAL_SETUP} Or: ${WEB_SETUP}`,
        );
      }
      const zone = getDisplayTimeZone();
      const sources: string[] = [];
      const notes: string[] = [];
      const detail: Record<string, unknown> = {};
      if (official.status === 'ok') {
        sources.push(`official: ${official.dev.source}${userToken ? ` + ${ENV.userToken}` : ''}`);
        detail.official = { developerToken: official.dev.source, userToken: userToken !== undefined };
        if (official.dev.kind === 'env-token') notes.push(`APPLE_MUSIC_DEVELOPER_TOKEN expires ${formatInstant(new Date(official.dev.expiresAt), zone).display}.`);
        if (!userToken) notes.push('Official API: catalog only — set APPLE_MUSIC_USER_TOKEN for your library (run `npx @chrischall/aws-mcp music-auth`).');
      } else if (official.status === 'broken') {
        sources.push('official: misconfigured');
        detail.official = { error: errorMessage(official.error) };
      }
      if (web) {
        sources.push(`web: ${ENV.webUserToken}`);
        try {
          const peek = c.web.peek();
          detail.web = { enabled: true, developerToken: peek.source, ...(peek.expiresAt !== undefined ? { developerTokenExpires: formatInstant(new Date(peek.expiresAt), zone).iso } : {}) };
          notes.push(
            peek.expiresAt !== undefined
              ? `Web-player developer token (${peek.source}) expires ${formatInstant(new Date(peek.expiresAt), zone).display}; it is re-read from music.apple.com a day before.`
              : 'The web-player developer token will be read from music.apple.com on first use.',
          );
        } catch (err) {
          detail.web = { enabled: true, error: errorMessage(err) };
        }
        notes.push("Web-player mode uses Apple's unofficial web-player API, which Apple may change or block without notice.");
      } else {
        detail.web = { enabled: false };
      }
      return { source: sources.join('; '), detail, notes };
    },
    probe: PROBE_LABEL,
    run: async () => {
      const c = getClient();
      const notes: string[] = [];
      const official = resolveOfficialDev(process.env, c.now());
      if (official.status === 'broken') throw official.error;
      if (official.status === 'ok') {
        await probe(c, c.officialBackend(official.dev), `/v1/catalog/us/songs/${PROBE_SONG_ID}`);
        notes.push('official catalog: OK');
        const userToken = officialUserToken();
        if (userToken) {
          const sf = await probe(c, c.officialBackend(official.dev, userToken), '/v1/me/storefront');
          notes.push(`official library: OK${sf ? ` (storefront ${sf})` : ''}`);
        }
      }
      const web = webUserToken();
      if (web) {
        const sf = await probe(c, c.webBackend(web), '/v1/me/storefront');
        notes.push(`web: OK${sf ? ` (storefront ${sf})` : ''}`);
      }
      return { notes };
    },
  });
}

/** The probe `apple_healthcheck` runs for Apple Music. */
export const musicHealth: HealthProbe = makeMusicHealth();
