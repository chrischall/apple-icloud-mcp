import { AppleToolError, ConfigError, errorMessage } from '../errors.js';
import { makeProbe, type HealthProbe, type ServiceHealth } from '../health.js';
import { formatInstant } from '../time.js';
import { getDisplayTimeZone } from '../config.js';
import type { Backend, MusicClient } from './client.js';
import { defaultMusicClient } from './common.js';
import { ENV, OFFICIAL_SETUP, USER_TOKEN_HOWTO, WEB_SETUP, officialUserToken, resolveOfficialDev, webUserToken } from './credentials.js';
import { firstDataId } from './project.js';

/**
 * `musicHealth` — which Apple Music profiles are configured (never a value),
 * and whether Apple accepts them right now:
 *  - official developer token: `GET /v1/test`, Apple's documented
 *    connectivity check (200 for a valid token, 401 otherwise). Not a catalog
 *    item: an id Apple withdraws answers 404, which would fail the probe for a
 *    setup that works;
 *  - official Music User Token: the account storefront;
 *  - web: the account storefront on amp-api.
 * Each backend is probed DIRECTLY — no fallback between them — so a rejected
 * official key is reported even when web mode would have covered for it, and
 * each is probed whatever the others answered: one failure never hides whether
 * the other credentials work. Every result is a note; the first failure is the
 * reported error.
 */

export const PROBE_LABEL = 'official: GET /v1/test (+ GET /v1/me/storefront with a user token); web: GET /v1/me/storefront';

async function probe(c: MusicClient, b: Backend, path: string): Promise<string | undefined> {
  const res = await c.send(b, { path });
  if (res.status === 401) throw c.rejected401(b, 'GET', path, res.text);
  try {
    return firstDataId(JSON.parse(res.text) as unknown);
  } catch {
    return undefined;
  }
}

/** A failed backend probe, one line: `CREDENTIALS_REJECTED (HTTP 401): message`. */
function failureNote(err: unknown): string {
  const code = err instanceof AppleToolError ? err.code : 'INTERNAL_ERROR';
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return `FAILED — ${code}${typeof status === 'number' ? ` (HTTP ${status})` : ''}: ${errorMessage(err)}`;
}

export function makeMusicHealth(getClient: () => MusicClient = defaultMusicClient): HealthProbe {
  return {
    service: 'music',
    async check(): Promise<ServiceHealth> {
      // Per check: the configuration notes and what each backend answered, kept even when a failure
      // makes the probe throw (makeProbe reports only the error then).
      const seen: ProbeNotes = { config: [], results: [] };
      const h = await musicProbe(getClient, seen).check();
      if (h.ok === false && seen.results.length > 0) h.notes = [...seen.config, ...seen.results];
      return h;
    },
  };
}

interface ProbeNotes {
  config: string[];
  results: string[];
}

function musicProbe(getClient: () => MusicClient, seen: ProbeNotes): HealthProbe {
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
        if (!userToken) notes.push(`Official API: catalog only — set APPLE_MUSIC_USER_TOKEN for your library (${USER_TOKEN_HOWTO}).`);
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
      seen.config = notes;
      return { source: sources.join('; '), detail, notes };
    },
    probe: PROBE_LABEL,
    run: async () => {
      const c = getClient();
      const { results } = seen;
      const failures: unknown[] = [];
      const failed = (label: string, err: unknown): void => {
        failures.push(err);
        results.push(`${label}: ${failureNote(err)}`);
      };
      const attempt = async (label: string, run: () => Promise<string | undefined>): Promise<void> => {
        try {
          const sf = await run();
          results.push(`${label}: OK${sf ? ` (storefront ${sf})` : ''}`);
        } catch (err) {
          failed(label, err);
        }
      };
      const official = resolveOfficialDev(process.env, c.now());
      if (official.status === 'broken') failed('official', official.error);
      if (official.status === 'ok') {
        await attempt('official developer token', async () => {
          await probe(c, c.officialBackend(official.dev), '/v1/test');
          return undefined;
        });
        const userToken = officialUserToken();
        if (userToken) await attempt('official library', () => probe(c, c.officialBackend(official.dev, userToken), '/v1/me/storefront'));
      }
      const web = webUserToken();
      if (web) await attempt('web', () => probe(c, c.webBackend(web), '/v1/me/storefront'));
      if (failures.length > 0) throw failures[0];
      return { notes: results };
    },
  });
}

/** The probe `apple_healthcheck` runs for Apple Music. */
export const musicHealth: HealthProbe = makeMusicHealth();
