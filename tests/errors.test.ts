import { describe, expect, it } from 'vitest';
import { McpToolError } from '@chrischall/mcp-utils';
import {
  AppleToolError,
  ConfigError,
  CredentialsRejectedError,
  InvalidArgumentError,
  TransportError,
  UnconfirmedWriteError,
  UpstreamError,
  errorMessage,
  forgetSecrets,
  rememberSecret,
  scrub,
} from '../src/errors.js';

describe('error classes', () => {
  it('AppleToolError is an McpToolError carrying a stable code, hint and cause', () => {
    const cause = new Error('root');
    const e = new AppleToolError('UNSUPPORTED', 'nope', { hint: 'try x', cause });
    expect(e).toBeInstanceOf(McpToolError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('AppleToolError');
    expect(e.code).toBe('UNSUPPORTED');
    expect(e.message).toBe('nope');
    expect(e.hint).toBe('try x');
    expect(e.cause).toBe(cause);
    const bare = new AppleToolError('NOT_FOUND', 'gone');
    expect(bare.hint).toBeUndefined();
  });

  it('ConfigError names the missing variables and defaults its hint to them', () => {
    const e = new ConfigError('music', 'Music is not set up.', ['APPLE_TEAM_ID', 'APPLE_KEY_ID']);
    expect(e).toBeInstanceOf(AppleToolError);
    expect(e.name).toBe('ConfigError');
    expect(e.code).toBe('NOT_CONFIGURED');
    expect(e.service).toBe('music');
    expect(e.missing).toEqual(['APPLE_TEAM_ID', 'APPLE_KEY_ID']);
    expect(e.hint).toBe("Set APPLE_TEAM_ID, APPLE_KEY_ID in the server's environment.");
    expect(new ConfigError('mail', 'm', ['X'], 'custom').hint).toBe('custom');
  });

  it('CredentialsRejectedError carries service + status, hint optional', () => {
    const e = new CredentialsRejectedError('calendar', 401, 'rejected', 'rotate it');
    expect(e.code).toBe('CREDENTIALS_REJECTED');
    expect(e.name).toBe('CredentialsRejectedError');
    expect(e.service).toBe('calendar');
    expect(e.status).toBe(401);
    expect(e.hint).toBe('rotate it');
    expect(new CredentialsRejectedError('calendar', 403, 'x').hint).toBeUndefined();
  });

  it('UpstreamError derives its code from the status unless one is given', () => {
    expect(new UpstreamError('maps', 404, 'x').code).toBe('NOT_FOUND');
    expect(new UpstreamError('maps', 429, 'x').code).toBe('RATE_LIMITED');
    expect(new UpstreamError('maps', 500, 'x').code).toBe('UPSTREAM_ERROR');
    expect(new UpstreamError('maps', 400, 'x', { code: 'INVALID_ARGUMENT' }).code).toBe('INVALID_ARGUMENT');
    const e = new UpstreamError('music', 400, 'bad', { hint: 'h', upstreamCode: '40005' });
    expect(e.name).toBe('UpstreamError');
    expect(e.service).toBe('music');
    expect(e.status).toBe(400);
    expect(e.hint).toBe('h');
    expect(e.upstreamCode).toBe('40005');
    const plain = new UpstreamError('music', 400, 'bad');
    expect(plain.hint).toBeUndefined();
    expect(plain.upstreamCode).toBeUndefined();
  });

  it('TransportError picks a hint per code', () => {
    const t = new TransportError('weather', 'TIMEOUT', 'slow', new Error('x'));
    expect(t.code).toBe('TIMEOUT');
    expect(t.name).toBe('TransportError');
    expect(t.service).toBe('weather');
    expect(t.hint).toContain('APPLE_REQUEST_TIMEOUT_MS');
    const n = new TransportError('weather', 'NETWORK_ERROR', 'down');
    expect(n.code).toBe('NETWORK_ERROR');
    expect(n.hint).toContain('egress allowlist');
  });

  it('InvalidArgumentError has an optional hint', () => {
    const e = new InvalidArgumentError('bad range', 'shorten it');
    expect(e.code).toBe('INVALID_ARGUMENT');
    expect(e.name).toBe('InvalidArgumentError');
    expect(e.hint).toBe('shorten it');
    expect(new InvalidArgumentError('x').hint).toBeUndefined();
  });

  it('UnconfirmedWriteError tells the caller to re-read before retrying', () => {
    const cause = new Error('reset');
    const e = new UnconfirmedWriteError('contacts', 'maybe landed', cause);
    expect(e.code).toBe('UNCONFIRMED_WRITE');
    expect(e.name).toBe('UnconfirmedWriteError');
    expect(e.service).toBe('contacts');
    expect(e.cause).toBe(cause);
    expect(e.hint).toContain('re-read');
  });
});

describe('scrub / rememberSecret', () => {
  it('removes remembered literals and their base64 form, then applies shape redaction', () => {
    rememberSecret('abcd-efgh-ijkl-mnop');
    const b64 = Buffer.from('abcd-efgh-ijkl-mnop').toString('base64');
    const out = scrub(`pw=abcd-efgh-ijkl-mnop twice abcd-efgh-ijkl-mnop b64 ${b64} Authorization: Bearer xyz123abcdefghijklmnopqrstuvwxyz`);
    expect(out).not.toContain('abcd-efgh-ijkl-mnop');
    expect(out).not.toContain(b64);
    expect(out).not.toContain('xyz123');
    expect(out.match(/\[REDACTED\]/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it('ignores short or empty values (they would scrub ordinary words)', () => {
    rememberSecret('short');
    rememberSecret('');
    rememberSecret(undefined);
    expect(scrub('a short note')).toBe('a short note');
  });

  it('forgetSecrets clears the registry', () => {
    rememberSecret('verysecretvalue');
    expect(scrub('verysecretvalue')).toBe('[REDACTED]');
    forgetSecrets();
    expect(scrub('verysecretvalue')).toBe('verysecretvalue');
  });

  it('redacts a PEM private key in any armor and line-break form', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49\n-----END PRIVATE KEY-----';
    expect(scrub(`key: ${pem} end`)).toBe('key: [REDACTED PRIVATE KEY] end');
    const escaped = '-----BEGIN EC PRIVATE KEY-----\\nMHcCAQEEI\\n-----END EC PRIVATE KEY-----';
    expect(scrub(`{"k":"${escaped}"}`)).toBe('{"k":"[REDACTED PRIVATE KEY]"}');
    // A public key or certificate is not a secret and stays.
    const pub = '-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----';
    expect(scrub(pub)).toBe(pub);
  });

  it('stays linear on a body of repeated armor lines with no END (no quadratic rescans)', () => {
    // The unbounded form took ~0.9 s on this input (and grows quadratically); the bounded one ~5 ms.
    const hostile = '-----BEGIN PRIVATE KEY-----!'.repeat(6000) + 'x'.repeat(120_000);
    const started = Date.now();
    const out = scrub(hostile);
    expect(Date.now() - started).toBeLessThan(400);
    expect(out).not.toContain('-----BEGIN PRIVATE KEY-----');
  });

  it('redacts two complete keys separately, keeping the text between them', () => {
    const k = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----';
    expect(scrub(`${k} mid ${k}`)).toBe('[REDACTED PRIVATE KEY] mid [REDACTED PRIVATE KEY]');
  });

  it('redacts a PEM private key cut off before its END line (armor and the base64 run after it)', () => {
    expect(scrub('snippet: -----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49\nAgEGCCqG')).toBe('snippet: [REDACTED PRIVATE KEY]');
    expect(scrub('{"k":"-----BEGIN EC PRIVATE KEY-----\\nMHcCAQEEI\\nAAAA"}')).toBe('{"k":"[REDACTED PRIVATE KEY]"}');
  });

  it('errorMessage scrubs Errors and non-Errors alike', () => {
    rememberSecret('app-specific-pw-1234');
    expect(errorMessage(new Error('login app-specific-pw-1234 failed'))).toBe('login [REDACTED] failed');
    expect(errorMessage('raw app-specific-pw-1234')).toBe('raw [REDACTED]');
    expect(errorMessage(42)).toBe('42');
  });
});
