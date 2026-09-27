import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
  SERVICES,
  WRITE_MODES,
  accessAllowed,
  canonicalTimeZone,
  getDisplayTimeZone,
  getEnabledServices,
  getRequestTimeoutMs,
  getWriteMode,
  isDebugLog,
  isServiceEnabled,
  isValidTimeZone,
  resetConfigWarnings,
  systemTimeZone,
} from '../src/config.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getEnabledServices / isServiceEnabled', () => {
  it('enables every service when APPLE_SERVICES is unset (or a placeholder)', () => {
    expect([...getEnabledServices({}).enabled]).toEqual([...SERVICES]);
    expect(getEnabledServices({}).unknown).toEqual([]);
    expect([...getEnabledServices({ APPLE_SERVICES: '${APPLE_SERVICES}' }).enabled]).toEqual([...SERVICES]);
    expect([...getEnabledServices({ APPLE_SERVICES: '  ' }).enabled]).toEqual([...SERVICES]);
  });

  it('parses comma/space separated names case-insensitively and reports unknown entries verbatim', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = getEnabledServices({ APPLE_SERVICES: ' Music, calendar  WEATHER,,Musik ' });
    expect([...r.enabled].sort()).toEqual(['calendar', 'music', 'weather']);
    expect(r.unknown).toEqual(['Musik']);
    expect([...getEnabledServices({ APPLE_SERVICES: ',maps,' }).enabled]).toEqual(['maps']);
    expect(err).toHaveBeenCalledTimes(1);
  });

  it('warns once per value on stderr that a misspelled entry leaves the intended service UNREGISTERED', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = { APPLE_SERVICES: 'music,calender' };
    expect([...getEnabledServices(env).enabled]).toEqual(['music']);
    expect(isServiceEnabled('calendar', env)).toBe(false);
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0]![0]).toBe(
      '[apple-icloud-mcp] WARNING: APPLE_SERVICES names no such service: "calender" — ignored, so a misspelled service ' +
        'registers NO tools. Registered services: music. Valid names: music, calendar, contacts, mail, maps, weather, itunes.',
    );
    // Every entry unknown: nothing but the healthcheck is registered, and it says so.
    getEnabledServices({ APPLE_SERVICES: 'calender contcts' });
    expect(err).toHaveBeenCalledTimes(2);
    expect(String(err.mock.calls[1]![0])).toContain('"calender", "contcts"');
    expect(String(err.mock.calls[1]![0])).toContain('Registered services: none.');
    // A clean value never warns; a reset warns again.
    getEnabledServices({ APPLE_SERVICES: 'music' });
    expect(err).toHaveBeenCalledTimes(2);
    resetConfigWarnings();
    getEnabledServices(env);
    expect(err).toHaveBeenCalledTimes(3);
  });

  it('reads process.env by default', () => {
    process.env.APPLE_SERVICES = 'maps';
    expect(isServiceEnabled('maps')).toBe(true);
    expect(isServiceEnabled('music')).toBe(false);
    expect([...getEnabledServices().enabled]).toEqual(['maps']);
  });

  it('accepts an explicit env for isServiceEnabled', () => {
    expect(isServiceEnabled('mail', { APPLE_SERVICES: 'mail' })).toBe(true);
    expect(isServiceEnabled('mail', { APPLE_SERVICES: 'itunes' })).toBe(false);
  });
});

describe('getWriteMode / accessAllowed', () => {
  it('defaults to all when unset', () => {
    expect(getWriteMode({})).toBe('all');
    expect(getWriteMode()).toBe('all');
    expect(WRITE_MODES).toEqual(['none', 'additive', 'all']);
  });

  it('accepts each mode case-insensitively', () => {
    expect(getWriteMode({ APPLE_WRITE_MODE: 'NONE' })).toBe('none');
    expect(getWriteMode({ APPLE_WRITE_MODE: ' Additive ' })).toBe('additive');
    expect(getWriteMode({ APPLE_WRITE_MODE: 'all' })).toBe('all');
  });

  it('fails CLOSED to none on an unrecognized value, warning once per value', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(getWriteMode({ APPLE_WRITE_MODE: 'everything' })).toBe('none');
    expect(getWriteMode({ APPLE_WRITE_MODE: 'everything' })).toBe('none');
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toContain('unrecognized APPLE_WRITE_MODE "everything"');
    expect(getWriteMode({ APPLE_WRITE_MODE: 'yes' })).toBe('none');
    expect(err).toHaveBeenCalledTimes(2);
    resetConfigWarnings();
    getWriteMode({ APPLE_WRITE_MODE: 'yes' });
    expect(err).toHaveBeenCalledTimes(3);
  });

  it('gates by mode: reads always, additive only in additive/all, all only in all', () => {
    for (const [mode, read, additive, all] of [
      ['none', true, false, false],
      ['additive', true, true, false],
      ['all', true, true, true],
    ] as const) {
      const env = { APPLE_WRITE_MODE: mode };
      expect(accessAllowed('read', env)).toBe(read);
      expect(accessAllowed('additive', env)).toBe(additive);
      expect(accessAllowed('all', env)).toBe(all);
    }
    // Unset → all; bad value → none.
    expect(accessAllowed('all', {})).toBe(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(accessAllowed('additive', { APPLE_WRITE_MODE: 'typo' })).toBe(false);
    expect(accessAllowed('read', { APPLE_WRITE_MODE: 'typo' })).toBe(true);
  });

  it('reads process.env by default', () => {
    process.env.APPLE_WRITE_MODE = 'additive';
    expect(accessAllowed('additive')).toBe(true);
    expect(accessAllowed('all')).toBe(false);
  });
});

describe('time zones', () => {
  it('recognizes IANA zones, case-insensitively, and refuses junk', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('america/new_york')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Etc/GMT+5')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('refuses a bare UTC offset even though Intl would accept one (no DST → wrong half the year)', () => {
    expect(isValidTimeZone('-04:00')).toBe(false);
    expect(isValidTimeZone('+05:30')).toBe(false);
    expect(isValidTimeZone(' +0000')).toBe(false);
    // U+2212 MINUS SIGN: Intl accepts it and resolves it to "-04:00", so an
    // ASCII-only check on the input would let it through.
    expect(isValidTimeZone('\u221204:00')).toBe(false);
  });

  it('canonicalTimeZone gives the runtime spelling of a zone, or undefined for anything else', () => {
    expect(canonicalTimeZone('europe/london')).toBe('Europe/London');
    expect(canonicalTimeZone('Etc/UTC')).toBe('UTC');
    expect(canonicalTimeZone('-04:00')).toBeUndefined();
    expect(canonicalTimeZone('Nowhere/Land')).toBeUndefined();
  });

  it('reports DISPLAY_TZ in its canonical spelling (case, aliases), not as typed', () => {
    expect(getDisplayTimeZone({ DISPLAY_TZ: 'america/new_york' })).toBe('America/New_York');
    expect(getDisplayTimeZone({ DISPLAY_TZ: 'US/Eastern' })).toBe('America/New_York');
    expect(getDisplayTimeZone({ DISPLAY_TZ: 'utc' })).toBe('UTC');
  });

  it('uses DISPLAY_TZ when it is a valid zone', () => {
    expect(getDisplayTimeZone({ DISPLAY_TZ: 'Europe/Paris' })).toBe('Europe/Paris');
    process.env.DISPLAY_TZ = 'Australia/Adelaide';
    expect(getDisplayTimeZone()).toBe('Australia/Adelaide');
  });

  it('falls back to the system zone for an unset or invalid DISPLAY_TZ, warning once per bad value', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sys = systemTimeZone();
    expect(getDisplayTimeZone({})).toBe(sys);
    expect(err).not.toHaveBeenCalled();
    expect(getDisplayTimeZone({ DISPLAY_TZ: 'Nowhere/Land' })).toBe(sys);
    expect(getDisplayTimeZone({ DISPLAY_TZ: 'Nowhere/Land' })).toBe(sys);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toContain('DISPLAY_TZ "Nowhere/Land" is not a known IANA zone');
    expect(getDisplayTimeZone({ DISPLAY_TZ: '-05:00' })).toBe(sys);
    expect(err).toHaveBeenCalledTimes(2);
    resetConfigWarnings();
    getDisplayTimeZone({ DISPLAY_TZ: '-05:00' });
    expect(err).toHaveBeenCalledTimes(3);
  });

  it('systemTimeZone returns the runtime zone, or UTC when the runtime cannot say', () => {
    expect(isValidTimeZone(systemTimeZone())).toBe(true);
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions');
    spy.mockReturnValue({ timeZone: undefined } as unknown as Intl.ResolvedDateTimeFormatOptions);
    expect(systemTimeZone()).toBe('UTC');
    spy.mockReturnValue({ timeZone: 'Not/AZone' } as unknown as Intl.ResolvedDateTimeFormatOptions);
    expect(systemTimeZone()).toBe('UTC');
    spy.mockReturnValue({ timeZone: 'Asia/Tokyo' } as unknown as Intl.ResolvedDateTimeFormatOptions);
    expect(systemTimeZone()).toBe('Asia/Tokyo');
  });
});

describe('getRequestTimeoutMs', () => {
  it('defaults to 30 s', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(getRequestTimeoutMs({})).toBe(30_000);
    expect(getRequestTimeoutMs()).toBe(30_000);
  });

  it('honours a valid override and ignores junk or values below 1 s', () => {
    expect(getRequestTimeoutMs({ APPLE_REQUEST_TIMEOUT_MS: '5000' })).toBe(5000);
    expect(getRequestTimeoutMs({ APPLE_REQUEST_TIMEOUT_MS: '999' })).toBe(30_000);
    expect(getRequestTimeoutMs({ APPLE_REQUEST_TIMEOUT_MS: '5s' })).toBe(30_000);
    expect(getRequestTimeoutMs({ APPLE_REQUEST_TIMEOUT_MS: '${X}' })).toBe(30_000);
  });

  it('caps the timeout at 10 minutes (setTimeout reads a delay past 2^31-1 ms as 1 ms)', () => {
    expect(MAX_REQUEST_TIMEOUT_MS).toBe(600_000);
    expect(getRequestTimeoutMs({ APPLE_REQUEST_TIMEOUT_MS: '600000' })).toBe(600_000);
    expect(getRequestTimeoutMs({ APPLE_REQUEST_TIMEOUT_MS: '600001' })).toBe(30_000);
    expect(getRequestTimeoutMs({ APPLE_REQUEST_TIMEOUT_MS: '3000000000' })).toBe(30_000);
  });
});

describe('isDebugLog', () => {
  it('is off by default and on for truthy values', () => {
    expect(isDebugLog({})).toBe(false);
    expect(isDebugLog()).toBe(false);
    expect(isDebugLog({ APPLE_DEBUG_LOG: 'true' })).toBe(true);
    expect(isDebugLog({ APPLE_DEBUG_LOG: '1' })).toBe(true);
    expect(isDebugLog({ APPLE_DEBUG_LOG: 'off' })).toBe(false);
  });
});
