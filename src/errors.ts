import { McpToolError, redactSecrets } from '@chrischall/mcp-utils';
import type { ServiceName } from './config.js';

/**
 * Error vocabulary shared by every service module.
 *
 * Every class here is an `McpToolError`, so `runMcp`'s wrapper (and
 * `toolErrorResult` in tools/_shared.ts) surfaces its `hint` as a trailing
 * "Hint: …" line. Each carries a stable `code` — callers branch on the code or
 * the class, NEVER on message text, which is free to be reworded.
 */

export type ErrorCode =
  | 'NOT_CONFIGURED'
  | 'CREDENTIALS_REJECTED'
  | 'UPSTREAM_ERROR'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'UNSUPPORTED'
  | 'UNCONFIRMED_WRITE';

export class AppleToolError extends McpToolError {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string, opts: { hint?: string; cause?: unknown } = {}) {
    super(message, opts);
    this.name = 'AppleToolError';
    this.code = code;
  }
}

/**
 * A service was called without the environment it needs. Thrown at CALL time,
 * never at registration: every tool must list and answer `tools/list` with an
 * empty environment (fleet CI boots the bundle with `env -i`), and the first
 * call is where "you have not set X" is actionable.
 */
export class ConfigError extends AppleToolError {
  readonly service: ServiceName;
  /** The env vars that would satisfy this — names only, never values. */
  readonly missing: string[];
  constructor(service: ServiceName, message: string, missing: string[], hint?: string) {
    super('NOT_CONFIGURED', message, { hint: hint ?? `Set ${missing.join(', ')} in the server's environment.` });
    this.name = 'ConfigError';
    this.service = service;
    this.missing = missing;
  }
}

/**
 * The upstream definitively refused the credential (401/403 on an
 * authenticated call). Retrying cannot fix it.
 */
export class CredentialsRejectedError extends AppleToolError {
  readonly service: ServiceName;
  readonly status: number;
  constructor(service: ServiceName, status: number, message: string, hint?: string) {
    super('CREDENTIALS_REJECTED', message, hint === undefined ? {} : { hint });
    this.name = 'CredentialsRejectedError';
    this.service = service;
    this.status = status;
  }
}

/** A non-2xx upstream answer that is not a credential problem. */
export class UpstreamError extends AppleToolError {
  readonly service: ServiceName;
  readonly status: number;
  /** A service-specific error code from the body, when the upstream sent one. */
  readonly upstreamCode?: string;
  constructor(
    service: ServiceName,
    status: number,
    message: string,
    opts: { hint?: string; upstreamCode?: string; code?: ErrorCode } = {},
  ) {
    super(opts.code ?? (status === 404 ? 'NOT_FOUND' : status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR'), message, {
      ...(opts.hint !== undefined ? { hint: opts.hint } : {}),
    });
    this.name = 'UpstreamError';
    this.service = service;
    this.status = status;
    if (opts.upstreamCode !== undefined) this.upstreamCode = opts.upstreamCode;
  }
}

/** The request never produced an HTTP answer (timeout, DNS, reset, proxy refusal). */
export class TransportError extends AppleToolError {
  readonly service: ServiceName;
  constructor(service: ServiceName, code: 'TIMEOUT' | 'NETWORK_ERROR', message: string, cause?: unknown) {
    super(code, message, {
      cause,
      hint:
        code === 'TIMEOUT'
          ? 'The request timed out. Retry once; if it keeps happening raise APPLE_REQUEST_TIMEOUT_MS.'
          : 'The upstream could not be reached. On a hosted deployment check the egress allowlist includes this host.',
    });
    this.name = 'TransportError';
    this.service = service;
  }
}

/** A bad argument the schema could not express (e.g. a date range that is too long). */
export class InvalidArgumentError extends AppleToolError {
  constructor(message: string, hint?: string) {
    super('INVALID_ARGUMENT', message, hint === undefined ? {} : { hint });
    this.name = 'InvalidArgumentError';
  }
}

/**
 * A write whose outcome is unknown: the request left, but no definitive answer
 * came back (timeout, 5xx, dropped connection). It MAY have landed. The tool
 * must say so and must not retry blindly — a retried create makes duplicates,
 * a retried send sends twice.
 */
export class UnconfirmedWriteError extends AppleToolError {
  readonly service: ServiceName;
  constructor(service: ServiceName, message: string, cause?: unknown) {
    super('UNCONFIRMED_WRITE', message, {
      cause,
      hint: 'The change may or may not have been applied. Check the current state (re-read it) before retrying.',
    });
    this.name = 'UnconfirmedWriteError';
    this.service = service;
  }
}

// ---------------------------------------------------------------------------
// Secret scrubbing
// ---------------------------------------------------------------------------

/**
 * Literal secrets this process has used. `redactSecrets` recognises SHAPES
 * (Bearer headers, JWTs, cookies) but not Apple's: a `Music-User-Token` is an
 * opaque blob in a header with no `x-` prefix, and an app-specific password is
 * `xxxx-xxxx-xxxx-xxxx`. So every credential a client sends is registered here
 * and scrubbed by value from anything that reaches a tool result or stderr.
 */
const secretLiterals = new Set<string>();

/** Register a credential value so `scrub` removes it wherever it appears. */
export function rememberSecret(value: string | undefined): void {
  // Short values would scrub ordinary words out of messages; nothing real is this short.
  if (value && value.length >= 8) secretLiterals.add(value);
}

/**
 * A PEM private-key block, in any armor (`PRIVATE KEY`, `EC PRIVATE KEY`, …)
 * and with real newlines, escaped `\n`s or none. `redactSecrets` has no rule
 * for one, and the developer key is remembered only in the form it arrived in
 * — the normalized PEM `apple-keys.ts` derives from it is a different string.
 * A block cut off before its END line (a truncated snippet) is redacted too:
 * the armor and the base64 run that follows it.
 */
// The body scan may not cross another BEGIN/END marker: unbounded, every
// BEGIN with no END after it re-scanned the rest of the text (quadratic on a
// body of repeated armor lines).
const PEM_PRIVATE_KEY_RE =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:(?:(?!-----(?:BEGIN|END) )[\s\S])*?-----END [A-Z0-9 ]*PRIVATE KEY-----|(?:[A-Za-z0-9+/=\s]|\\[rn])*)/g;

/** Shape-based redaction plus removal of every remembered literal secret. */
export function scrub(text: string): string {
  let out = text.replace(PEM_PRIVATE_KEY_RE, '[REDACTED PRIVATE KEY]');
  for (const secret of secretLiterals) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
    // A secret that travels base64-encoded on its own. (A Basic header encodes
    // `user:password` as ONE unit, which this does not match — the DAV client
    // remembers that whole token itself, and `redactSecrets` catches the
    // `Authorization: Basic …` header shape.)
    const b64 = Buffer.from(secret).toString('base64');
    if (out.includes(b64)) out = out.split(b64).join('[REDACTED]');
  }
  return redactSecrets(out);
}

/** Test seam. */
export function forgetSecrets(): void {
  secretLiterals.clear();
}

/** The message of any thrown value, scrubbed. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return scrub(err.message);
  return scrub(String(err));
}
