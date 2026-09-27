import { parseBoolEnv, readEnvVar, readIntEnv, type EnvSource } from '@chrischall/mcp-utils';

/**
 * Deployment-wide settings, read from the environment on every call rather
 * than cached at import: tests flip them per case, and a long-lived hosted
 * child should see the value it was spawned with, not the one a module saw
 * first.
 *
 * Everything here is hardened by `readEnvVar` — blank, `"undefined"`,
 * `"null"` and an unexpanded `${VAR}` placeholder all read as UNSET, because
 * MCP hosts routinely pass an env block through without substituting it.
 */

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/** Every Apple service this server can talk to. The order is the display order. */
export const SERVICES = ['music', 'calendar', 'contacts', 'mail', 'maps', 'weather', 'itunes'] as const;
export type ServiceName = (typeof SERVICES)[number];

export interface EnabledServices {
  enabled: ReadonlySet<ServiceName>;
  /** Entries of APPLE_SERVICES that name no service — reported, never guessed at. */
  unknown: string[];
}

let warnedServices: string | undefined;

/**
 * `APPLE_SERVICES` narrows which services register tools (comma or space
 * separated, case-insensitive). Unset means all of them. It exists so a
 * deployment that only wants Apple Music does not hand the model fifty tools
 * it cannot use.
 *
 * It is an ALLOWLIST, so a misspelled entry does not fail open: the service
 * the operator meant to KEEP (`calender`) is simply left UNREGISTERED, and its
 * tools are missing from the menu. The unknown entry is ignored rather than
 * failing the boot, but it is reported — once on stderr, naming the entry and
 * the services that ARE registered, and in apple_healthcheck's
 * `unknownServicesInAPPLE_SERVICES` — so a missing service is traceable to it.
 */
export function getEnabledServices(env: EnvSource = process.env): EnabledServices {
  const raw = readEnvVar('APPLE_SERVICES', { env });
  if (raw === undefined) return { enabled: new Set(SERVICES), unknown: [] };
  const enabled = new Set<ServiceName>();
  const unknown: string[] = [];
  for (const part of raw.split(/[\s,]+/)) {
    const name = part.trim().toLowerCase();
    if (!name) continue;
    if ((SERVICES as readonly string[]).includes(name)) enabled.add(name as ServiceName);
    else unknown.push(part.trim());
  }
  if (unknown.length > 0 && warnedServices !== raw) {
    warnedServices = raw;
    console.error(
      `[apple-cloud-mcp] WARNING: APPLE_SERVICES names no such service: ${unknown.map((u) => `"${u}"`).join(', ')} — ignored, ` +
        'so a misspelled service registers NO tools. ' +
        `Registered services: ${enabled.size > 0 ? [...enabled].join(', ') : 'none'}. Valid names: ${SERVICES.join(', ')}.`,
    );
  }
  return { enabled, unknown };
}

export function isServiceEnabled(service: ServiceName, env: EnvSource = process.env): boolean {
  return getEnabledServices(env).enabled.has(service);
}

// ---------------------------------------------------------------------------
// Write mode (structural gate)
// ---------------------------------------------------------------------------

/**
 * `APPLE_WRITE_MODE`:
 *  - `none`     — read tools only.
 *  - `additive` — reads, plus writes that only ADD to your own account
 *                 (create a playlist, append tracks, create an event or a
 *                 contact). Nothing existing is modified or removed and
 *                 nothing is sent to another person.
 *  - `all`      — everything (default).
 *
 * Structural: a tool above the mode is not REGISTERED, so no prompt injection
 * or host setting can call it. An unrecognised value fails CLOSED to `none` —
 * a typo must never widen the surface while looking configured.
 */
export const WRITE_MODES = ['none', 'additive', 'all'] as const;
export type WriteMode = (typeof WRITE_MODES)[number];

/** What a tool needs to be registered: a read, an additive write, or any write. */
export type ToolAccess = 'read' | 'additive' | 'all';

let warnedWriteMode: string | undefined;

export function getWriteMode(env: EnvSource = process.env): WriteMode {
  const raw = readEnvVar('APPLE_WRITE_MODE', { env });
  if (raw === undefined) return 'all';
  const mode = raw.toLowerCase();
  if ((WRITE_MODES as readonly string[]).includes(mode)) return mode as WriteMode;
  if (warnedWriteMode !== raw) {
    warnedWriteMode = raw;
    console.error(
      `[apple-cloud-mcp] WARNING: unrecognized APPLE_WRITE_MODE "${raw}" — failing closed to "none" ` +
        '(read-only). Valid values: none, additive, all.',
    );
  }
  return 'none';
}

/** Whether a tool needing `access` is registered under the current write mode. */
export function accessAllowed(access: ToolAccess, env: EnvSource = process.env): boolean {
  if (access === 'read') return true;
  const mode = getWriteMode(env);
  if (mode === 'all') return true;
  return mode === 'additive' && access === 'additive';
}

// ---------------------------------------------------------------------------
// Time zone
// ---------------------------------------------------------------------------

/**
 * Whether `zone` is an IANA time zone this runtime knows.
 *
 * A bare UTC offset (`-04:00`, `+0530`) is refused even though current `Intl`
 * accepts one: it is not an IANA zone and it has no DST, so `DISPLAY_TZ=-04:00`
 * meant as "New York" would be an hour wrong from November to March — the exact
 * failure the no-fixed-offsets rule exists to prevent. `Etc/GMT+5` (an IANA
 * name for a fixed offset) stays valid for anyone who really means it.
 */
export function isValidTimeZone(zone: string): boolean {
  return canonicalTimeZone(zone) !== undefined;
}

/**
 * The runtime's canonical spelling of an IANA zone (`america/new_york` →
 * `America/New_York`, `US/Eastern` → `America/New_York`), or undefined when
 * `zone` is not one. The offset check runs on what `Intl` RESOLVED, not on the
 * input: `Intl` also accepts `−04:00` spelled with U+2212 MINUS SIGN and
 * reports it back as `-04:00`, which an ASCII-only input check waved through.
 */
export function canonicalTimeZone(zone: string): string | undefined {
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
    return /^[+\-\u2212]/.test(resolved) ? undefined : resolved;
  } catch {
    return undefined;
  }
}

let warnedTz: string | undefined;

/**
 * The zone every `…Display` value is rendered in, and the zone an input with
 * NO offset (`2026-10-03T16:30`) is read as wall-clock time in.
 *
 * `DISPLAY_TZ` wins; otherwise the runtime's own zone (which honours `TZ`).
 * A hosted child usually runs in UTC, so a deployment for a person should set
 * DISPLAY_TZ — the healthcheck reports which zone is in force and why.
 * An unrecognised DISPLAY_TZ falls back rather than throwing: a typo degrades
 * a label, it must not break every tool. Never a fixed offset — DST comes from
 * the IANA database.
 */
export function getDisplayTimeZone(env: EnvSource = process.env): string {
  const raw = readEnvVar('DISPLAY_TZ', { env });
  if (raw !== undefined) {
    // The canonical spelling, not the one typed: the zone name travels on
    // (an iCalendar TZID, a healthcheck report) where `america/new_york`
    // is not the same identifier as `America/New_York`.
    const canonical = canonicalTimeZone(raw);
    if (canonical !== undefined) return canonical;
    if (warnedTz !== raw) {
      warnedTz = raw;
      console.error(`[apple-cloud-mcp] WARNING: DISPLAY_TZ "${raw}" is not a known IANA zone — using the system zone.`);
    }
  }
  return systemTimeZone();
}

/** The runtime's resolved zone, `UTC` when it cannot say. */
export function systemTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && isValidTimeZone(zone) ? zone : 'UTC';
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Longest accepted APPLE_REQUEST_TIMEOUT_MS. A hosted child is idled out after 10 minutes anyway. */
export const MAX_REQUEST_TIMEOUT_MS = 600_000;

/**
 * Per-attempt request timeout (`APPLE_REQUEST_TIMEOUT_MS`, default 30 s,
 * 1 s – 10 min; anything else falls back to the default). The ceiling is not
 * cosmetic: `setTimeout` treats a delay above 2^31-1 ms as 1 ms, so an
 * unbounded value would time out every request instantly.
 */
export function getRequestTimeoutMs(env: EnvSource = process.env): number {
  const v = readIntEnv('APPLE_REQUEST_TIMEOUT_MS', {
    env,
    default: DEFAULT_REQUEST_TIMEOUT_MS,
    min: 1000,
    max: MAX_REQUEST_TIMEOUT_MS,
  });
  /* v8 ignore next -- readIntEnv returns the default when unset or invalid */
  return v ?? DEFAULT_REQUEST_TIMEOUT_MS;
}

/** `APPLE_DEBUG_LOG` — log every upstream request/response line to stderr (secrets redacted). */
export function isDebugLog(env: EnvSource = process.env): boolean {
  return parseBoolEnv('APPLE_DEBUG_LOG', { env });
}

/** Test seam: forget which bad values were already warned about. */
export function resetConfigWarnings(): void {
  warnedServices = undefined;
  warnedWriteMode = undefined;
  warnedTz = undefined;
}
