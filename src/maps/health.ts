import { resolveDeveloperKey, type DeveloperKey } from '../apple-keys.js';
import { makeProbe, type HealthProbe } from '../health.js';
import { httpRequest } from '../http.js';
import { TOKEN_REJECTED_HINT, exchangeMapsToken, type RequestFn } from './client.js';

/**
 * Apple Maps health: is a developer key configured (no I/O), and does Apple
 * accept it right now — one fresh `GET /v1/token` exchange, deliberately NOT
 * served from the tools' token cache (a cached token proves nothing about
 * the key today).
 */

export interface MapsHealthOptions {
  resolveKey?: () => DeveloperKey;
  request?: RequestFn;
  now?: () => number;
}

export function createMapsHealth(opts: MapsHealthOptions = {}): HealthProbe {
  const resolveKey = opts.resolveKey ?? (() => resolveDeveloperKey('maps'));
  const request = opts.request ?? httpRequest;
  const now = opts.now ?? Date.now;
  return makeProbe({
    service: 'maps',
    resolve: () => {
      const key = resolveKey();
      // Team and key ids are identifiers (they appear in every snapshot URL), not secrets.
      return { source: key.source, detail: { teamId: key.teamId, keyId: key.keyId } };
    },
    probe: 'GET /v1/token',
    run: async () => {
      const token = await exchangeMapsToken(resolveKey(), request, now());
      return {
        notes: [
          `Apple issued a Maps access token valid for ${token.expiresInSeconds} s.`,
          'Snapshot URLs (apple_maps_snapshot_url) are signed locally with the same key and are not probed.',
        ],
      };
    },
    rejectedHint: TOKEN_REJECTED_HINT,
  });
}

export const mapsHealth: HealthProbe = createMapsHealth();
