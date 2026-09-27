import { describe, expect, it } from 'vitest';
import { formatReport, runDoctor } from '../src/doctor.js';
import { rememberSecret } from '../src/errors.js';
import type { HealthProbe, ServiceHealth } from '../src/health.js';
import { healthReport } from '../src/tools/healthcheck.js';
import { VERSION } from '../src/version.js';
import { HEALTH_PROBES } from '../src/registry.js';

const fixed = (health: ServiceHealth): HealthProbe => ({ service: health.service, check: async () => health });

const itunesOk = fixed({
  service: 'itunes',
  configured: true,
  credential: { source: 'none needed' },
  ok: true,
  probe: 'GET /search',
  latencyMs: 42,
  notes: ['rate limited to ~20 calls a minute'],
});
const mailRejected = fixed({
  service: 'mail',
  configured: true,
  credential: { source: 'ICLOUD_USERNAME + ICLOUD_APP_PASSWORD' },
  ok: false,
  error: { code: 'CREDENTIALS_REJECTED', message: 'iCloud refused the app-specific password', status: 401 },
  hint: 'Create a new app-specific password at appleid.apple.com.',
});
const musicMissing = fixed({ service: 'music', configured: false, missing: ['APPLE_MUSIC_WEB_USER_TOKEN'] });

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) }, out, err };
}

describe('doctor', () => {
  it('prints each service and exits 0 when every configured service works', async () => {
    process.env.DISPLAY_TZ = 'America/New_York';
    process.env.APPLE_WRITE_MODE = 'none';
    const c = capture();
    expect(await runDoctor([], [itunesOk, musicMissing], c.io)).toBe(0);
    const text = c.out.join('');
    expect(text).toContain(`apple-icloud-mcp ${VERSION} — Apple service check`);
    expect(text).toContain('Write mode: none · Display time zone: America/New_York (from DISPLAY_TZ)');
    expect(text).toContain('  ✓ itunes    working (none needed · GET /search · 42 ms)');
    expect(text).toContain('note: rate limited to ~20 calls a minute');
    expect(text).toContain('  · music     not configured — set APPLE_MUSIC_WEB_USER_TOKEN');
    expect(text).toContain('Every configured service works (itunes).');
    expect(c.err).toEqual([]);
  });

  it('shows a failing service with its code, status and hint, and exits 1', async () => {
    const c = capture();
    expect(await runDoctor([], [itunesOk, mailRejected], c.io)).toBe(1);
    const text = c.out.join('');
    expect(text).toContain('  ✗ mail      FAILING — CREDENTIALS_REJECTED 401: iCloud refused the app-specific password');
    expect(text).toContain('→ Create a new app-specific password at appleid.apple.com.');
    expect(text).toContain('1 configured service is failing: mail.');
  });

  it('checks only the services named on the command line', async () => {
    const c = capture();
    expect(await runDoctor(['itunes'], [itunesOk, mailRejected], c.io)).toBe(0);
    expect(c.out.join('')).not.toContain('mail');
  });

  it('prints the raw report with --json', async () => {
    const c = capture();
    expect(await runDoctor(['--json'], [itunesOk], c.io)).toBe(0);
    const report = JSON.parse(c.out.join(''));
    expect(report).toEqual(await healthReport([itunesOk]));
    expect(report.summary.working).toEqual(['itunes']);
  });

  it('refuses an unknown argument with usage on stderr, exit 2, and probes nothing', async () => {
    const c = capture();
    let probed = false;
    const spy: HealthProbe = { service: 'itunes', check: async () => ((probed = true), await itunesOk.check()) };
    expect(await runDoctor(['icloud-drive'], [spy], c.io)).toBe(2);
    expect(c.err.join('')).toContain('Unknown argument "icloud-drive"');
    expect(c.err.join('')).toContain('Usage: apple-icloud-mcp doctor');
    expect(c.out).toEqual([]);
    expect(probed).toBe(false);
  });

  it('prints usage for --help and -h', async () => {
    for (const flag of ['--help', '-h']) {
      const c = capture();
      expect(await runDoctor([flag], [itunesOk], c.io)).toBe(0);
      expect(c.out.join('')).toContain('Usage: apple-icloud-mcp doctor [service…] [--json]');
    }
  });

  it('scrubs remembered secrets from what it prints', async () => {
    rememberSecret('abcd-efgh-ijkl-mnop');
    const leaky = fixed({
      service: 'calendar',
      configured: true,
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'bad pair abcd-efgh-ijkl-mnop' },
    });
    for (const argv of [[], ['--json']]) {
      const c = capture();
      await runDoctor(argv, [leaky], c.io);
      expect(c.out.join('')).not.toContain('abcd-efgh-ijkl-mnop');
    }
  });

  it('writes to the process streams by default', async () => {
    const writes: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => (writes.push(String(chunk)), true)) as typeof process.stdout.write;
    const originalErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => (writes.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      expect(await runDoctor([], [itunesOk])).toBe(0);
      expect(await runDoctor(['nope'], [itunesOk])).toBe(2);
    } finally {
      process.stdout.write = original;
      process.stderr.write = originalErr;
    }
    expect(writes.join('')).toContain('✓ itunes');
    expect(writes.join('')).toContain('Unknown argument "nope"');
  });

  it('checks every registered service by default (iTunes needs no credentials)', async () => {
    process.env.APPLE_SERVICES = 'itunes';
    const c = capture();
    // Nothing is stubbed: iTunes' probe would reach the network, which the
    // suite refuses — so it reports a failure, and the exit status says so.
    expect(await runDoctor([], HEALTH_PROBES, c.io)).toBe(1);
    const text = c.out.join('');
    expect(text).toContain('✗ itunes');
    for (const s of ['music', 'calendar', 'contacts', 'mail', 'maps', 'weather']) {
      expect(text).toContain(`  - ${s.padEnd(9)} disabled by APPLE_SERVICES`);
    }
  });
});

describe('formatReport edge cases', () => {
  const base = {
    ok: true,
    version: VERSION,
    config: { writeMode: 'all' as const, displayTimeZone: 'UTC', displayTimeZoneSource: 'system' as const },
  };

  it('says when nothing is configured', () => {
    const text = formatReport({
      ...base,
      summary: { working: [], failing: [], notConfigured: ['music'] },
      services: [{ service: 'music', configured: false }],
    });
    expect(text).toContain('  · music     not configured\n');
    expect(text).toContain('No service is configured yet');
    expect(text).toContain('Display time zone: UTC (system)');
  });

  it('reports warnings, unchecked services and a failure with no error detail', () => {
    const text = formatReport({
      ...base,
      ok: false,
      config: {
        ...base.config,
        displayTimeZoneWarning: 'DISPLAY_TZ "Mars/Olympus" is not an IANA time zone name',
        unknownServicesInAPPLE_SERVICES: ['drive'],
      },
      summary: { working: [], failing: ['maps', 'weather'], notConfigured: [], unchecked: ['itunes'] },
      services: [
        { service: 'maps', configured: true, ok: false },
        { service: 'weather', configured: true, ok: true },
      ],
    });
    expect(text).toContain('Warning: DISPLAY_TZ "Mars/Olympus"');
    expect(text).toContain('Warning: APPLE_SERVICES names unknown services: drive');
    expect(text).toContain('  ✗ maps      FAILING — failed');
    expect(text).toContain('  ✓ weather   working\n');
    expect(text).toContain('  ? itunes    enabled, but no check exists for it');
    expect(text).toContain('2 configured services are failing: maps, weather.');
  });
});
