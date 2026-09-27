import { SERVICES, type ServiceName } from './config.js';
import { scrub } from './errors.js';
import type { HealthProbe, ServiceHealth } from './health.js';
import { isJson, scrubDeep } from './tools/_shared.js';
import { healthReport, type HealthReport } from './tools/healthcheck.js';

/**
 * `apple-icloud-mcp doctor [service…] [--json]` — the `apple_healthcheck`
 * report from a terminal, with no MCP client in the loop. It runs the same
 * probes the same way (one cheap read-only request per configured service,
 * iCloud's one at a time so a revoked password is sent once), so a setup can
 * be checked before it is wired into Claude, and a failing one debugged
 * without guessing whether the client or the credentials are at fault.
 *
 * Exit status: 0 when every configured service works, 1 when one fails,
 * 2 for a usage error. Services named on the command line must also each be
 * configured, enabled and working for a 0: "is calendar working?" must not
 * pass because calendar was never checked. Output is scrubbed of every
 * remembered secret, and an unrecognised argument is never echoed (it could
 * be a password pasted in the wrong place).
 */
export interface DoctorIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

const USAGE =
  `Usage: apple-icloud-mcp doctor [service…] [--json]\n` +
  `  Checks each Apple service's credentials with one read-only request.\n` +
  `  service: ${SERVICES.join(', ')} (default: all enabled)\n` +
  `  --json:  print the apple_healthcheck report as JSON\n` +
  `  Exit 0 when every configured (and every named) service works, 1 otherwise, 2 for a usage error.\n` +
  `  Reads the shell environment only — not the env block of an MCP client's config.\n`;

export async function runDoctor(
  argv: readonly string[],
  probes: readonly HealthProbe[],
  io: DoctorIo = { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) },
): Promise<number> {
  let json = false;
  const services: ServiceName[] = [];
  for (const [i, arg] of argv.entries()) {
    if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') {
      io.out(USAGE);
      return 0;
    } else if ((SERVICES as readonly string[]).includes(arg)) services.push(arg as ServiceName);
    else {
      io.err(`Argument ${i + 1} is not a service name or option.\n${USAGE}`);
      return 2;
    }
  }
  const report = await healthReport(probes, services.length ? services : undefined);
  io.out(json ? `${jsonText(report)}\n` : scrub(formatReport(report)));
  const named = services.every((s) => report.summary.working.includes(s));
  return report.ok && named ? 0 : 1;
}

/**
 * The report as indented JSON, scrubbed value by value first — some
 * redaction shapes run to the next `;`, `,` or space and would eat a closing
 * quote in serialized JSON — and then as text only if that still parses
 * (the same two passes as `jsonErrorResponse`).
 */
function jsonText(report: HealthReport): string {
  const text = JSON.stringify(scrubDeep(report), null, 2);
  const scrubbed = scrub(text);
  return isJson(scrubbed) ? scrubbed : text;
}

/** The report as a few aligned lines per service, worst news last. */
export function formatReport(report: HealthReport): string {
  const c = report.config;
  const lines = [
    `apple-icloud-mcp ${report.version} — Apple service check`,
    `Write mode: ${c.writeMode} · Display time zone: ${c.displayTimeZone} (${c.displayTimeZoneSource === 'DISPLAY_TZ' ? 'from DISPLAY_TZ' : 'system'})`,
  ];
  if (c.displayTimeZoneWarning) lines.push(`Warning: ${c.displayTimeZoneWarning}`);
  if (c.unknownServicesInAPPLE_SERVICES) {
    lines.push(`Warning: APPLE_SERVICES names unknown services: ${c.unknownServicesInAPPLE_SERVICES.join(', ')}`);
  }
  lines.push('');
  const pad = (s: string) => s.padEnd(9);
  const indent = ' '.repeat(4 + 9 + 1);
  for (const r of report.services) lines.push(...formatService(r, pad, indent));
  for (const s of report.summary.disabled ?? []) lines.push(`  - ${pad(s)} disabled by APPLE_SERVICES`);
  for (const s of report.summary.unchecked ?? []) lines.push(`  ? ${pad(s)} enabled, but no check exists for it`);
  lines.push('');
  const { working, failing, notConfigured, disabled = [] } = report.summary;
  if (failing.length) {
    lines.push(`${failing.length} configured service${failing.length === 1 ? ' is' : 's are'} failing: ${failing.join(', ')}.`);
  } else if (working.length) {
    lines.push(`Every configured service works (${working.join(', ')}).`);
  } else if (notConfigured.length) {
    lines.push('No service is configured yet: set the variables listed above.');
  } else if (disabled.length) {
    lines.push(`Nothing was checked: ${disabled.join(', ')} ${disabled.length === 1 ? 'is' : 'are'} left out by APPLE_SERVICES. Add ${disabled.length === 1 ? 'it' : 'them'} there to check.`);
  } else {
    lines.push('Nothing was checked.');
  }
  return `${lines.join('\n')}\n`;
}

function formatService(r: ServiceHealth, pad: (s: string) => string, indent: string): string[] {
  const out: string[] = [];
  if (!r.configured) {
    out.push(`  · ${pad(r.service)} not configured${r.missing?.length ? ` — set ${r.missing.join(', ')}` : ''}`);
  } else if (r.ok) {
    out.push(`  ✓ ${pad(r.service)} working${r.latencyMs !== undefined ? ` (${r.latencyMs} ms)` : ''}`);
  } else {
    const what = r.error ? `${r.error.code}${r.error.status ? ` ${r.error.status}` : ''}: ${r.error.message}` : 'failed';
    out.push(`  ✗ ${pad(r.service)} FAILING — ${what}`);
  }
  // One fact per line: a source or probe can itself hold "official: …;
  // web: …", which a single ` · `-joined line made hard to read.
  if (r.configured && r.credential?.source && r.credential.source !== 'none') {
    out.push(`${indent}credential: ${r.credential.source}`);
  }
  if (r.configured && r.probe) out.push(`${indent}checked: ${r.probe}`);
  if (r.hint) out.push(`${indent}→ ${r.hint}`);
  for (const n of r.notes ?? []) out.push(`${indent}note: ${n}`);
  return out;
}
