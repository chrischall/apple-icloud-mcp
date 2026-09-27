import { createHash } from 'node:crypto';
import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';
import {
  confirmKeyFromEnv,
  confirmationFromEnv,
  confirmTokenParam,
  createSpentTokenStore,
  readEnvVar,
  requireConfirmationWithFallback,
  type EnvSource,
  type SpentTokenStore,
} from '@chrischall/mcp-utils';
import { isStateCacheEnabled, stateCache } from '../state.js';

export { confirmTokenParam };

/** The sentence every confirm-gated tool's description ends with. */
export const CONFIRM_NOTE =
  'Asks the user to confirm first: a confirmation prompt where the client supports one; otherwise the first call '
  + 'performs NO write and returns a preview of exactly what would happen plus a confirmToken, and only a repeat '
  + 'call with that token proceeds (see MCP_CONFIRM_MODE).';

export interface ConfirmWriteOptions {
  /** The tool name the token is bound to; a token never crosses tools. */
  tool: string;
  /** `apple.<service>.<entity>.<verb>` action id. */
  action: string;
  /** Prompt text shown above the preview on a client that can be asked. */
  message: string;
  /** The primary thing acted on (`playlist:p.abc`, `event:<href>`, `mail:new`). */
  target: string;
  /**
   * A version of the target that changes when it is edited — an ETag, or
   * `stateRevision()` of the record as just read. Bound into the token, so a
   * phase-2 call against a target that changed in between is refused as
   * DRAFT_CHANGED instead of acting on a version nobody approved. Omit for a
   * create (nothing exists yet).
   */
  revision?: string;
  /** Exactly what the write will send; its hash is bound into the token. */
  payload: unknown;
  /** What the user sees: names, titles, dates, addresses — never only ids. */
  preview: Record<string, unknown>;
  /** The tool's validated arguments (bound into elicitation acceptance; `confirmToken` is stripped). */
  args: unknown;
  /** The phase-2 token from the tool's input, or undefined on phase 1. */
  confirmToken: string | undefined;
}

/**
 * Confirm-gate for a write that is irreversible or reaches another person
 * (a send, a delete, an invitation). A client that can show a prompt is asked;
 * one that cannot (claude.ai) gets the two-phase token flow governed by
 * `MCP_CONFIRM_MODE`: phase 1 performs no write and returns the preview plus a
 * `confirmToken`; only a repeat call with that token proceeds.
 *
 * Call it on EVERY invocation, after all reads and validation and immediately
 * before the write, with the freshly built payload and a freshly read
 * revision — the re-read is what makes a stale token fail.
 *
 * Returns `undefined` to proceed, otherwise the result to return unchanged.
 */
export function confirmWrite(
  ctx: ServerContext,
  opts: ConfirmWriteOptions,
): Promise<InputRequiredResult | CallToolResult | undefined> {
  return requireConfirmationWithFallback(
    ctx,
    confirmationFromEnv({
      action: opts.action,
      message: opts.message,
      details: opts.preview,
      unsupportedNote: 'Make this change in the Apple app (Music, Calendar, Contacts or Mail) instead.',
      tool: opts.tool,
      confirmToken: opts.confirmToken,
      args: opts.args,
      // Built per call: the data dir, APPLE_STATE_CACHE and the key are read now.
      spent: createFileSpentTokenStore(),
      subject: () => ({
        target: opts.target,
        ...(opts.revision !== undefined ? { revision: opts.revision } : {}),
        payload: opts.payload,
        preview: opts.preview,
      }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Spent tokens: single use that survives a restart
// ---------------------------------------------------------------------------

/**
 * mcp-utils remembers a used token's nonce in process memory only, while
 * MCP_CONFIRM_SECRET (which mint.yaml proposes for hosted deployments) makes
 * the token itself valid in every process that shares the secret. So after a
 * restart inside the token's lifetime — a crash, a redeploy, the child dying
 * right after the SMTP hand-off — an already-used token verified again. For a
 * target with no revision to rotate (a new mail, an invitation-sending create)
 * that replayed the whole write: a second email nobody approved.
 *
 * The store below records each spent token on disk as well
 * (`$MCP_DATA_DIR/.apple-cloud-mcp/confirm-spent.json`, 0600): a SHA-256 of its nonce
 * and the time it would have expired anyway — nothing that could be replayed.
 * The file is bound to (a digest of) the HMAC key, so rotating the secret
 * discards it, and so does a restart without a secret — every earlier token is
 * TOKEN_INVALID under the new random key then anyway. Expired entries are
 * pruned on every write and the file is capped at {@link MAX_SPENT_TOKENS}.
 *
 * An in-memory mirror is ALWAYS kept as well, so single use within the process
 * never depends on the disk. With APPLE_STATE_CACHE=false, or when the file
 * cannot be written, only the mirror remains — reported once on stderr when a
 * shared secret makes that matter.
 */
export const SPENT_TOKENS_FILE = 'confirm-spent.json';

/** Most spent tokens kept on disk; the ones expiring soonest go first. */
export const MAX_SPENT_TOKENS = 500;

interface SpentRecord {
  /** sha256(nonce), base64url → epoch ms at which the token expires. */
  spent: Record<string, number>;
}

function validateSpent(raw: unknown): SpentRecord | null {
  const spent = (raw as { spent?: unknown } | null)?.spent;
  if (typeof spent !== 'object' || spent === null || Array.isArray(spent)) return null;
  return { spent: Object.fromEntries(Object.entries(spent).filter(([, exp]) => Number.isFinite(exp))) };
}

const nonceDigest = (nonce: string): string => createHash('sha256').update(nonce).digest('base64url');

/** The process-wide mirror, keyed by nonce digest like the file — and all there is when nothing persists. */
const processSpent = createSpentTokenStore();

const warned = new Set<'disabled' | 'write'>();

function warnOnce(kind: 'disabled' | 'write', env: EnvSource): void {
  // Without a shared secret a restart invalidates every token anyway, so the
  // memory-only store loses nothing and there is nothing to warn about.
  if (warned.has(kind) || readEnvVar('MCP_CONFIRM_SECRET', { env }) === undefined) return;
  warned.add(kind);
  console.error(
    `[apple-cloud-mcp] WARNING: ${kind === 'disabled' ? 'APPLE_STATE_CACHE=false, so a' : 'could not record a'} used confirmToken ` +
      `${kind === 'disabled' ? 'is' : 'on disk; it is'} remembered by this process only. With MCP_CONFIRM_SECRET set, ` +
      'a restart before it expires would accept it again.',
  );
}

export interface FileSpentTokenStoreOptions {
  env?: EnvSource;
  /** The in-memory mirror; defaults to the process-wide one. Tests pass a fresh one to simulate a restart. */
  memory?: SpentTokenStore;
}

/**
 * A {@link SpentTokenStore} backed by `confirm-spent.json` plus an in-memory
 * mirror. `has` consults both (the file is re-read, so a token spent by an
 * earlier process — or a sibling sharing the data dir — counts); `add` writes
 * both. Only phase-2 calls touch it, so the extra reads cost nothing. With
 * APPLE_STATE_CACHE=false the file side is a no-op and this is the mirror alone.
 */
export function createFileSpentTokenStore(options: FileSpentTokenStoreOptions = {}): SpentTokenStore {
  const env = options.env ?? process.env;
  const memory = options.memory ?? processSpent;
  const key = createHash('sha256').update(confirmKeyFromEnv(env)).digest('hex');
  const file = stateCache<SpentRecord>(SPENT_TOKENS_FILE, `confirm-spent-v1:${key}`, validateSpent, env);
  const onDisk = (): Record<string, number> => file.load()?.spent ?? {};
  return {
    has: (nonce) => {
      const d = nonceDigest(nonce);
      return memory.has(d) || Object.hasOwn(onDisk(), d);
    },
    add: (nonce, expiresAtMs) => {
      const d = nonceDigest(nonce);
      memory.add(d, expiresAtMs);
      const now = Date.now();
      const kept = Object.entries(onDisk())
        .filter(([other, exp]) => other !== d && exp >= now)
        .sort(([, a], [, b]) => b - a)
        .slice(0, MAX_SPENT_TOKENS - 1);
      if (!file.save({ spent: Object.fromEntries([[d, expiresAtMs], ...kept]) })) {
        warnOnce(isStateCacheEnabled(env) ? 'write' : 'disabled', env);
      }
    },
    prune: (now) => memory.prune(now), // the file is pruned on every write
    clear: () => {
      memory.clear();
      file.clear();
    },
    /** Distinct spent tokens known to either copy. */
    get size() {
      return memory.size + Object.keys(onDisk()).filter((d) => !memory.has(d)).length;
    },
  };
}

/** Test seam: forget the in-memory spent tokens (what a restart does) and the warnings. */
export function resetSpentTokenMemory(): void {
  processSpent.clear();
  warned.clear();
}

/**
 * A revision string for a record as just read, for `ConfirmWriteOptions.revision`
 * when the upstream offers no ETag. Any change to the value rotates it; a
 * change in the ORDER of an object's keys does not (array order still counts —
 * a reordered playlist is a different playlist). Two reads of an unchanged
 * record must agree, and an upstream is free to serialize keys in any order:
 * a digest of raw `JSON.stringify` output would refuse a phase-2 confirm as
 * DRAFT_CHANGED on nothing but that.
 */
export function stateRevision(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
  return `s1:${createHash('sha256').update(canonical ?? 'undefined').digest('base64url').slice(0, 22)}`;
}
