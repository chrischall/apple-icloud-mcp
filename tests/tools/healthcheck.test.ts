import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import type { z } from 'zod';
import { ICLOUD_SERVICES, PROBE_TIMEOUT_MS, registerHealthcheckTool } from '../../src/tools/healthcheck.js';
import { assertNotLatched, latchRejection } from '../../src/icloud-auth.js';
import type { HealthProbe, ServiceHealth } from '../../src/health.js';
import { ANNOTATIONS } from '../../src/tools/_shared.js';
import { rememberSecret } from '../../src/errors.js';
import { SERVICES, systemTimeZone, type ServiceName } from '../../src/config.js';
import { VERSION } from '../../src/version.js';

type Registered = { cfg: { inputSchema: z.ZodType; annotations: unknown; title: string; description: string }; cb: (args: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> };

function register(probes: HealthProbe[]): Registered {
  const tools = new Map<string, Registered>();
  const server = { registerTool: (name: string, cfg: Registered['cfg'], cb: Registered['cb']) => tools.set(name, { cfg, cb }) } as unknown as McpServer;
  registerHealthcheckTool(server, probes);
  expect([...tools.keys()]).toEqual(['apple_healthcheck']);
  return tools.get('apple_healthcheck')!;
}

async function run(probes: HealthProbe[], args: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const res = await register(probes).cb(args, {});
  expect(res.isError).toBeUndefined();
  return JSON.parse(res.content[0]!.text) as Record<string, any>;
}

const fixed = (health: ServiceHealth): HealthProbe => ({ service: health.service, check: async () => health });
const working = (service: ServiceName): HealthProbe => fixed({ service, configured: true, credential: { source: 's' }, ok: true, probe: 'GET /x', latencyMs: 1 });
const unconfigured = (service: ServiceName): HealthProbe => fixed({ service, configured: false, missing: ['X'] });
const failing = (service: ServiceName): HealthProbe =>
  fixed({ service, configured: true, ok: false, error: { code: 'CREDENTIALS_REJECTED', message: 'no', status: 401 } });

describe('apple_healthcheck registration', () => {
  it('is a read-only, idempotent core tool with a strict schema', () => {
    const t = register([]);
    expect(t.cfg.title).toBe('Check Apple service credentials and connectivity');
    expect(t.cfg.description).toContain('Run this first when a tool fails');
    expect(t.cfg.annotations).toEqual({ ...ANNOTATIONS.read, idempotentHint: true });
    const s = t.cfg.inputSchema;
    expect(s.safeParse({}).success).toBe(true);
    expect(s.safeParse({ services: ['music', 'mail'] }).success).toBe(true);
    expect(s.safeParse({ services: [] }).success).toBe(false);
    expect(s.safeParse({ services: ['icloud-drive'] }).success).toBe(false);
    expect(s.safeParse({ verbose: true }).success).toBe(false);
  });

  it('registers even when APPLE_SERVICES and APPLE_WRITE_MODE are restrictive', () => {
    process.env.APPLE_SERVICES = 'maps';
    process.env.APPLE_WRITE_MODE = 'none';
    register([]);
  });
});

describe('apple_healthcheck results', () => {
  it('reports each service, with ok meaning "everything configured works"', async () => {
    const out = await run([working('music'), unconfigured('calendar'), working('maps')]);
    expect(out.ok).toBe(true);
    expect(out.version).toBe(VERSION);
    expect(out.summary).toEqual({
      working: ['music', 'maps'],
      failing: [],
      notConfigured: ['calendar'],
      unchecked: ['contacts', 'mail', 'weather', 'itunes'],
    });
    expect(out.services.map((s: ServiceHealth) => s.service)).toEqual(['music', 'calendar', 'maps']);
    expect(out.config).toEqual({ writeMode: 'all', displayTimeZone: systemTimeZone(), displayTimeZoneSource: 'system' });
  });

  it('is not ok when a configured service fails', async () => {
    const out = await run([working('music'), failing('contacts')]);
    expect(out.ok).toBe(false);
    expect(out.summary).toEqual({
      working: ['music'],
      failing: ['contacts'],
      notConfigured: [],
      unchecked: ['calendar', 'mail', 'maps', 'weather', 'itunes'],
    });
  });

  it('names enabled services it had no probe for as unchecked, instead of leaving them out', async () => {
    const one = await run([], { services: ['music'] });
    expect(one.summary).toEqual({ working: [], failing: [], notConfigured: [], unchecked: ['music'] });
    expect(one.services).toEqual([]);
    const every = SERVICES.map((s) => working(s));
    const full = await run(every);
    expect('unchecked' in full.summary).toBe(false);
    process.env.APPLE_SERVICES = 'maps';
    const narrowed = await run([]);
    expect(narrowed.summary.unchecked).toEqual(['maps']);
    expect(narrowed.summary.disabled).toEqual(['music', 'calendar', 'contacts', 'mail', 'weather', 'itunes']);
  });

  it('checks only the requested services, and names requested services APPLE_SERVICES disabled', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.APPLE_SERVICES = 'music, weather, bogus';
    const probes = [working('music'), working('weather'), working('mail')];
    const some = await run(probes, { services: ['music', 'mail'] });
    expect(some.services.map((s: ServiceHealth) => s.service)).toEqual(['music']);
    expect(some.summary.disabled).toEqual(['mail']);
    expect('unchecked' in some.summary).toBe(false);
    expect(some.config.unknownServicesInAPPLE_SERVICES).toEqual(['bogus']);
    const all = await run(probes);
    expect(all.services.map((s: ServiceHealth) => s.service)).toEqual(['music', 'weather']);
    expect(all.summary.disabled).toEqual(['calendar', 'contacts', 'mail', 'maps', 'itunes']);
    expect(warn).toHaveBeenCalledTimes(1); // and once on stderr, however often it is read
    vi.restoreAllMocks();
  });

  it('reports the write mode and where the display zone came from', async () => {
    process.env.APPLE_WRITE_MODE = 'additive';
    process.env.DISPLAY_TZ = 'America/New_York';
    const out = await run([]);
    expect(out.config).toEqual({ writeMode: 'additive', displayTimeZone: 'America/New_York', displayTimeZoneSource: 'DISPLAY_TZ' });
  });

  it('honours a DISPLAY_TZ spelled in another case or as an alias, reporting the canonical name', async () => {
    process.env.DISPLAY_TZ = 'america/new_york';
    const out = await run([]);
    expect(out.config).toEqual({ writeMode: 'all', displayTimeZone: 'America/New_York', displayTimeZoneSource: 'DISPLAY_TZ' });
    process.env.DISPLAY_TZ = 'US/Eastern';
    expect((await run([])).config.displayTimeZone).toBe('America/New_York');
  });

  it('says so when DISPLAY_TZ was set but refused (a bare offset or a typo)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.DISPLAY_TZ = '-04:00';
    const out = await run([]);
    expect(out.config.displayTimeZone).toBe(systemTimeZone());
    expect(out.config.displayTimeZoneSource).toBe('system');
    expect(out.config.displayTimeZoneWarning).toBe(
      `DISPLAY_TZ "-04:00" is not an IANA time zone name (e.g. America/New_York); using the system zone ${systemTimeZone()} instead.`,
    );
    vi.restoreAllMocks();
  });

  it('turns a probe that throws into a scrubbed INTERNAL_ERROR for that service only', async () => {
    rememberSecret('probe-leak-secret');
    const throwing: HealthProbe = {
      service: 'mail',
      check: async () => {
        throw new Error('imap said probe-leak-secret');
      },
    };
    const rejecting: HealthProbe = { service: 'contacts', check: () => Promise.reject('plain') };
    const out = await run([throwing, rejecting, working('music')]);
    expect(out.ok).toBe(false);
    expect(out.services[0]).toEqual({ service: 'mail', configured: true, ok: false, error: { code: 'INTERNAL_ERROR', message: 'imap said [REDACTED]' } });
    expect(out.services[1].error).toEqual({ code: 'INTERNAL_ERROR', message: 'plain' });
    expect(out.summary.failing).toEqual(['mail', 'contacts']);
  });

  it('reports a probe that hangs as TIMEOUT after PROBE_TIMEOUT_MS without holding up the others', async () => {
    vi.useFakeTimers();
    const hanging: HealthProbe = { service: 'weather', check: () => new Promise<ServiceHealth>(() => undefined) };
    const pending = register([hanging, working('maps')]).cb({}, {});
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const out = JSON.parse((await pending).content[0]!.text) as Record<string, any>;
    expect(out.ok).toBe(false);
    expect(out.services[0]).toEqual({
      service: 'weather',
      configured: true,
      ok: false,
      error: { code: 'TIMEOUT', message: `The weather check did not finish within ${PROBE_TIMEOUT_MS / 1000} s.` },
      hint: 'Apple may be slow or unreachable from this host. Try again, and check the egress allowlist on a hosted deployment.',
    });
    expect(out.services[1].ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  /** Probes that record when they start and settle only when the test says so, with the result it gives. */
  function gatedProbes() {
    const events: string[] = [];
    const gates = new Map<ServiceName, (health?: Partial<ServiceHealth>) => void>();
    const gated = (service: ServiceName): HealthProbe => ({
      service,
      check: () => {
        events.push(`start ${service}`);
        return new Promise<ServiceHealth>((resolve) => {
          gates.set(service, (health = { configured: true, ok: true }) => {
            events.push(`end ${service}`);
            resolve({ service, configured: true, ...health });
          });
        });
      },
    });
    return { events, gated, open: (s: ServiceName, health?: Partial<ServiceHealth>) => gates.get(s)!(health) };
  }

  it('runs the iCloud probes (one shared password) one at a time while no verdict is in, everything else alongside', async () => {
    expect([...ICLOUD_SERVICES]).toEqual(['calendar', 'contacts', 'mail']);
    const { events, gated, open } = gatedProbes();
    const pending = register([gated('mail'), gated('music'), gated('calendar'), gated('contacts'), gated('maps')]).cb({}, {});
    await vi.waitFor(() => expect(events).toEqual(['start mail', 'start music', 'start maps']));
    open('music');
    // A 5xx says nothing about the password: the next iCloud probe still waits its turn.
    open('mail', { ok: false, error: { code: 'UPSTREAM_ERROR', message: '503', status: 503 } });
    await vi.waitFor(() => expect(events.at(-1)).toBe('start calendar'));
    expect(events).not.toContain('start contacts');
    // Neither does a result with no error at all.
    open('calendar', { configured: false, missing: ['ICLOUD_USERNAME'] });
    await vi.waitFor(() => expect(events.at(-1)).toBe('start contacts'));
    open('contacts');
    open('maps');
    const out = JSON.parse((await pending).content[0]!.text) as Record<string, any>;
    // Reported in the order the probes were given, not the order they ran.
    expect(out.services.map((r: ServiceHealth) => r.service)).toEqual(['mail', 'music', 'calendar', 'contacts', 'maps']);
    expect(out.summary.failing).toEqual(['mail']);
    expect(out.summary.notConfigured).toEqual(['calendar']);
  });

  it('runs the remaining iCloud probes together once one has answered ok: the pair works, nothing left to protect', async () => {
    const { events, gated, open } = gatedProbes();
    const pending = register([gated('calendar'), gated('contacts'), gated('mail')]).cb({}, {});
    await vi.waitFor(() => expect(events).toEqual(['start calendar']));
    open('calendar');
    await vi.waitFor(() => expect(events).toEqual(['start calendar', 'end calendar', 'start contacts', 'start mail']));
    open('mail');
    open('contacts');
    const out = JSON.parse((await pending).content[0]!.text) as Record<string, any>;
    expect(out.summary.working).toEqual(['calendar', 'contacts', 'mail']);
  });

  it('an unreachable iCloud costs two probe timeouts, not three (the whole report must beat a 60 s client timeout)', async () => {
    vi.useFakeTimers();
    const started: Array<[ServiceName, number]> = [];
    const hanging = (service: ServiceName): HealthProbe => ({
      service,
      check: () => {
        started.push([service, Date.now()]);
        return new Promise<ServiceHealth>(() => undefined);
      },
    });
    const t0 = Date.now();
    const pending = register([hanging('calendar'), hanging('contacts'), hanging('mail')]).cb({}, {});
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(2 * PROBE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    // Contacts waited for calendar's verdict; once that timed out, mail did not wait for contacts'.
    expect(started).toEqual([
      ['calendar', t0],
      ['contacts', t0 + PROBE_TIMEOUT_MS],
      ['mail', t0 + PROBE_TIMEOUT_MS],
    ]);
    const out = JSON.parse((await pending).content[0]!.text) as Record<string, any>;
    expect(out.services.map((r: ServiceHealth) => r.error?.code)).toEqual(['TIMEOUT', 'TIMEOUT', 'TIMEOUT']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends a revoked iCloud password once per healthcheck: the first rejection latches before the next probe', async () => {
    const creds = { username: 'me@icloud.com', password: 'dead-dead-dead-dead' };
    let sent = 0;
    const icloudProbe = (service: 'calendar' | 'contacts' | 'mail'): HealthProbe => ({
      service,
      check: async () => {
        try {
          assertNotLatched(creds, service);
        } catch {
          return { service, configured: true, ok: false, error: { code: 'CREDENTIALS_REJECTED', message: 'latched', status: 401 } };
        }
        sent++;
        await new Promise((r) => setTimeout(r, 5)); // the round trip to iCloud
        latchRejection(creds);
        return { service, configured: true, ok: false, error: { code: 'CREDENTIALS_REJECTED', message: '401', status: 401 } };
      },
    });
    const out = await run([icloudProbe('calendar'), icloudProbe('contacts'), icloudProbe('mail'), working('music')]);
    expect(sent).toBe(1);
    expect(out.summary.failing).toEqual(['calendar', 'contacts', 'mail']);
    expect(out.services.slice(1, 3).map((r: ServiceHealth) => r.error?.message)).toEqual(['latched', 'latched']);
  });

  it('a hanging iCloud probe times out on its own clock, then the next iCloud probe runs', async () => {
    vi.useFakeTimers();
    const hanging: HealthProbe = { service: 'calendar', check: () => new Promise<ServiceHealth>(() => undefined) };
    const contacts = vi.fn(async (): Promise<ServiceHealth> => ({ service: 'contacts', configured: true, ok: true }));
    const pending = register([hanging, { service: 'contacts', check: contacts }]).cb({}, {});
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(contacts).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const out = JSON.parse((await pending).content[0]!.text) as Record<string, any>;
    expect(contacts).toHaveBeenCalledTimes(1);
    expect(out.services[0].error.code).toBe('TIMEOUT');
    expect(out.services[1].ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers through a real MCP server and refuses an unknown argument', async () => {
    const harness = await createTestHarness((server) => registerHealthcheckTool(server, [working('itunes')]));
    try {
      const ok = await harness.callTool('apple_healthcheck', {});
      expect(JSON.parse((ok.content[0] as { text: string }).text).summary.working).toEqual(['itunes']);
      const bad = await harness.callTool('apple_healthcheck', { extra: 1 });
      expect(bad.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });
});
