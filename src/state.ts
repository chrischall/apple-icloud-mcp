import { parseBoolEnv, type EnvSource } from '@chrischall/mcp-utils';
import { createFileStatePersistence, resolveStateFile, type SyncStatePersistence } from '@chrischall/mcp-utils/session';

/**
 * Small on-disk caches that survive a restart — worth having because a hosted
 * child idles out after ten minutes and every cold start would otherwise
 * repeat work (scraping the Apple Music web-player token, iCloud's DAV
 * discovery round trips).
 *
 * Files live under `$MCP_DATA_DIR/.aws-mcp/` (mcp-host injects MCP_DATA_DIR;
 * a local install falls back to `$HOME`), are written atomically with mode
 * 0600, and are BOUND to the credential they were derived from via a salted
 * digest — rotate the credential and the stale record is discarded, and the
 * credential itself is never written.
 *
 * `APPLE_STATE_CACHE=false` turns every cache off. A failed write is reported
 * to stderr and is never fatal: everything cached here can be re-derived.
 */

export const STATE_SUBDIR = '.aws-mcp';

export function isStateCacheEnabled(env: EnvSource = process.env): boolean {
  return parseBoolEnv('APPLE_STATE_CACHE', { env, default: true });
}

export interface StateCache<T> {
  load(): T | null;
  save(value: T): void;
  clear(): void;
}

const NOOP: StateCache<never> = {
  load: () => null,
  save: () => undefined,
  clear: () => undefined,
};

/**
 * A JSON cache file `fileName` bound to `boundTo` (a credential, or a digest
 * of several joined with NUL). Returns a no-op cache when caching is off.
 */
export function stateCache<T>(
  fileName: string,
  boundTo: string,
  validate: (raw: unknown) => T | null,
  env: EnvSource = process.env,
): StateCache<T> {
  if (!isStateCacheEnabled(env)) return NOOP as StateCache<T>;
  const filePath = resolveStateFile({ env, subdir: STATE_SUBDIR, fileName });
  const store: SyncStatePersistence<T> = createFileStatePersistence<T>({ filePath, boundTo, validate });
  return {
    load: () => store.load(),
    save: (value) => {
      try {
        store.save(value);
      } catch (err) {
        console.error(`[aws-mcp] WARNING: could not write cache ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    clear: () => {
      try {
        store.clear();
      } catch {
        // Nothing to clear, or the directory is read-only — both harmless.
      }
    },
  };
}
