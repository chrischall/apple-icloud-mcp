import type { ServiceName } from './config.js';
import { AppleToolError, ConfigError, CredentialsRejectedError, errorMessage } from './errors.js';

/**
 * The per-service health contract. Each service module exports one
 * `HealthProbe` from `src/<service>/health.ts`; `apple_healthcheck` runs them
 * all. A probe answers two separate questions, because conflating them sends
 * people to fix the wrong thing:
 *
 *  1. Is a credential configured, and from where? (never the value)
 *  2. Does the upstream accept it right now? (one cheap, read-only request)
 */
export interface ServiceHealth {
  service: ServiceName;
  /** Whether the environment holds what this service needs. */
  configured: boolean;
  /** Which variables supplied the credential (names only), plus safe detail. */
  credential?: { source: string; detail?: Record<string, unknown> };
  /** When not configured: the variables to set. */
  missing?: string[];
  /** Probe outcome; absent when nothing was probed (not configured). */
  ok?: boolean;
  /** What was probed, e.g. `GET /v1/me/storefront`. */
  probe?: string;
  /** Probe latency. */
  latencyMs?: number;
  error?: { code: string; message: string; status?: number };
  hint?: string;
  /** Extra facts worth knowing (a web-player token's expiry, which backend is active…). */
  notes?: string[];
}

export interface HealthProbe {
  service: ServiceName;
  check(): Promise<ServiceHealth>;
}

export interface ProbeSpec {
  service: ServiceName;
  /**
   * Resolve configuration WITHOUT network I/O. Throw `ConfigError` when the
   * service is not configured; return the credential source otherwise.
   */
  resolve: () => { source: string; detail?: Record<string, unknown>; notes?: string[] } | Promise<{ source: string; detail?: Record<string, unknown>; notes?: string[] }>;
  /** Human label for the probe request, e.g. `GET /v1/me/storefront`. */
  probe: string;
  /** Perform the probe; throw on failure. May return notes. */
  run: () => Promise<void | { notes?: string[] }>;
  /** Hint when the credential is rejected. */
  rejectedHint?: string;
}

/**
 * The standard probe: resolve → (not configured | run) → classify. Services
 * with one credential use this; a service with several paths can compose it.
 */
export function makeProbe(spec: ProbeSpec): HealthProbe {
  return {
    service: spec.service,
    async check(): Promise<ServiceHealth> {
      let resolved: Awaited<ReturnType<ProbeSpec['resolve']>>;
      try {
        resolved = await spec.resolve();
      } catch (err) {
        if (err instanceof ConfigError) {
          return {
            service: spec.service,
            configured: false,
            missing: err.missing,
            ...(err.hint ? { hint: err.hint } : {}),
            error: { code: err.code, message: errorMessage(err) },
          };
        }
        return failed(spec.service, true, undefined, err, spec);
      }
      const credential = { source: resolved.source, ...(resolved.detail ? { detail: resolved.detail } : {}) };
      const started = Date.now();
      try {
        const out = await spec.run();
        const notes = [...(resolved.notes ?? []), ...((out && out.notes) ?? [])];
        return {
          service: spec.service,
          configured: true,
          credential,
          ok: true,
          probe: spec.probe,
          latencyMs: Date.now() - started,
          ...(notes.length ? { notes } : {}),
        };
      } catch (err) {
        return { ...failed(spec.service, true, credential, err, spec), probe: spec.probe, latencyMs: Date.now() - started };
      }
    },
  };
}

function failed(
  service: ServiceName,
  configured: boolean,
  credential: ServiceHealth['credential'],
  err: unknown,
  spec: ProbeSpec,
): ServiceHealth {
  const error: ServiceHealth['error'] = {
    code: err instanceof AppleToolError ? err.code : 'INTERNAL_ERROR',
    message: errorMessage(err),
  };
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number') error.status = status;
  let hint: string | undefined;
  if (err instanceof CredentialsRejectedError) hint = spec.rejectedHint ?? err.hint;
  else if (err instanceof AppleToolError) hint = err.hint;
  return {
    service,
    configured,
    ...(credential ? { credential } : {}),
    ok: false,
    error,
    ...(hint ? { hint } : {}),
  };
}
