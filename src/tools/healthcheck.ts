import type { McpServer } from '@modelcontextprotocol/server';
import { readEnvVar } from '@chrischall/mcp-utils';
import { z } from 'zod';
import { SERVICES, getDisplayTimeZone, getEnabledServices, getWriteMode, type ServiceName } from '../config.js';
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
      const ok = results.every((r) => !r.configured || r.ok === true);
      const tzRaw = readEnvVar('DISPLAY_TZ');
      const zone = getDisplayTimeZone();
      return jsonResponse({
        ok,
        version: VERSION,
        summary: {
          working: results.filter((r) => r.ok === true).map((r) => r.service),
          failing: results.filter((r) => r.configured && r.ok !== true).map((r) => r.service),
          notConfigured: results.filter((r) => !r.configured).map((r) => r.service),
          ...(disabled.length ? { disabled } : {}),
        },
        config: {
          writeMode: getWriteMode(),
          displayTimeZone: zone,
          displayTimeZoneSource: tzRaw !== undefined && tzRaw === zone ? 'DISPLAY_TZ' : 'system',
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
          error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) },
        }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
