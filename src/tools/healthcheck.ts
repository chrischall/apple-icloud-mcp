import type { McpServer } from '@modelcontextprotocol/server';
import { readEnvVar } from '@chrischall/mcp-utils';
import { z } from 'zod';
import { SERVICES, getDisplayTimeZone, getEnabledServices, getWriteMode, isValidTimeZone, type ServiceName } from '../config.js';
import { errorMessage } from '../errors.js';
import type { HealthProbe, ServiceHealth } from '../health.js';
import { VERSION } from '../version.js';
import { ANNOTATIONS, defineTool, jsonResponse } from './_shared.js';

/** How long one service's probe may take before it is reported as timed out. */
export const PROBE_TIMEOUT_MS = 20_000;

/**
 * `apple_healthcheck` — "is this connector working, and which parts?".
 *
 * Seven services with three kinds of credential (developer key, user token,
 * app-specific password) fail independently, so the answer is per service:
 * configured or not (and which variables to set), and whether Apple accepted
 * the credential just now. A service that is not configured is not a failure
 * — it is reported as `configured: false` with its missing variables — so
 * `ok` means "everything that IS configured works".
 */
export function registerHealthcheckTool(server: McpServer, probes: readonly HealthProbe[]): void {
  defineTool(server, {
    name: 'apple_healthcheck',
    service: 'core',
    access: 'read',
    title: 'Check Apple service credentials and connectivity',
    description:
      'Check which Apple services (Apple Music, iCloud Calendar, Contacts, Mail, Apple Maps, WeatherKit, iTunes) are ' +
      'configured and reachable. For each: whether credentials are set (and which variables to set if not), and ' +
      'whether Apple accepted them on a cheap read-only request. Also reports the write mode and display time zone. ' +
      'Run this first when a tool fails or to see what this server can do.',
    inputSchema: z.strictObject({
      services: z
        .array(z.enum(SERVICES))
        .min(1)
        .optional()
        .describe('Only check these services (default: every enabled service).'),
    }),
    annotations: { ...ANNOTATIONS.read, idempotentHint: true },
    handler: async (args) => {
      const { enabled, unknown } = getEnabledServices();
      const wanted = new Set<ServiceName>(args.services ?? SERVICES);
      const selected = probes.filter((p) => wanted.has(p.service) && enabled.has(p.service));
      const results = await Promise.all(selected.map((p) => runWithTimeout(p)));
      const disabled = [...wanted].filter((s) => !enabled.has(s));
      // An enabled service with no probe wired in must not vanish from the
      // report: a missing line reads as "nothing to check", not "not checked".
      const unchecked = [...wanted].filter((s) => enabled.has(s) && !selected.some((p) => p.service === s));
      const ok = results.every((r) => !r.configured || r.ok === true);
      const tzRaw = readEnvVar('DISPLAY_TZ');
      const zone = getDisplayTimeZone();
      // Validity, not equality: getDisplayTimeZone returns the CANONICAL
      // spelling, so `america/new_york` is honoured as `America/New_York`.
      const tzFromEnv = tzRaw !== undefined && isValidTimeZone(tzRaw);
      return jsonResponse({
        ok,
        version: VERSION,
        summary: {
          working: results.filter((r) => r.ok === true).map((r) => r.service),
          failing: results.filter((r) => r.configured && r.ok !== true).map((r) => r.service),
          notConfigured: results.filter((r) => !r.configured).map((r) => r.service),
          ...(disabled.length ? { disabled } : {}),
          ...(unchecked.length ? { unchecked } : {}),
        },
        config: {
          writeMode: getWriteMode(),
          displayTimeZone: zone,
          displayTimeZoneSource: tzFromEnv ? 'DISPLAY_TZ' : 'system',
          // A DISPLAY_TZ that was set but refused must say so: otherwise every
          // time is quietly rendered in the system zone (UTC on a hosted child).
          ...(tzRaw !== undefined && !tzFromEnv
            ? {
                displayTimeZoneWarning:
                  `DISPLAY_TZ "${tzRaw}" is not an IANA time zone name (e.g. America/New_York); using the system zone ${zone} instead.`,
              }
            : {}),
          ...(unknown.length ? { unknownServicesInAPPLE_SERVICES: unknown } : {}),
        },
        services: results,
      });
    },
  });
}

async function runWithTimeout(probe: HealthProbe): Promise<ServiceHealth> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ServiceHealth>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          service: probe.service,
          configured: true,
          ok: false,
          error: { code: 'TIMEOUT', message: `The ${probe.service} check did not finish within ${PROBE_TIMEOUT_MS / 1000} s.` },
          hint: 'Apple may be slow or unreachable from this host. Try again, and check the egress allowlist on a hosted deployment.',
        }),
      PROBE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([
      probe.check().catch(
        (err: unknown): ServiceHealth => ({
          service: probe.service,
          configured: true,
          ok: false,
          error: { code: 'INTERNAL_ERROR', message: errorMessage(err) },
        }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
