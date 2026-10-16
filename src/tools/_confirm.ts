import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';
import {
  confirmTokenParam,
  confirmWrite as sharedConfirmWrite,
  createFileSpentTokenStore,
  createSpentTokenStore,
  readEnvVar,
  spentTokenStoreFromEnv,
  type EnvSource,
  type SpentTokenStore,
} from '@chrischall/mcp-utils';
import { resolveStateFile } from '@chrischall/mcp-utils/session';
import { STATE_SUBDIR, isStateCacheEnabled } from '../state.js';

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
  /** The tool's validated arguments (bound into the token and the prompt's acceptance; `confirmToken` is stripped). */
  args: object;
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
 * A thin wrapper over mcp-utils' `confirmWrite` (chrischall/fleet-audit#1217),
 * which binds the arguments AND the state the user was shown (target,
 * revision, payload, preview) on both rails — so an acceptance given while
 * "position 1" was one song cannot remove whatever sits there when the retry
 * re-reads the playlist. The preview gains the shared `willSend` field (the
 * payload). What this wrapper adds: the single-account `account: undefined`,
 * the Apple-app refusal hint, and the spent-token store choice below.
 *
 * Returns `undefined` to proceed, otherwise the result to return unchanged.
 */
export function confirmWrite(
  ctx: ServerContext,
  opts: ConfirmWriteOptions,
): Promise<InputRequiredResult | CallToolResult | undefined> {
  return sharedConfirmWrite(ctx, {
    tool: opts.tool,
    action: opts.action,
    message: opts.message,
    // Single-account server: every write acts as the one set of credentials in the env
    // (ICLOUD_USERNAME / the Apple Music user token), so there is no principal to choose between.
    account: undefined,
    target: opts.target,
    ...(opts.revision !== undefined ? { revision: opts.revision } : {}),
    payload: opts.payload,
    preview: opts.preview,
    args: opts.args,
    confirmToken: opts.confirmToken,
    unsupportedNote: 'Make this change in the Apple app (Music, Calendar, Contacts or Mail) instead.',
    // Chosen per call: the data dir, APPLE_STATE_CACHE and the key are read now.
    spent: spentTokenStore(),
  });
}

// ---------------------------------------------------------------------------
// Spent tokens: single use that survives a restart
// ---------------------------------------------------------------------------

/**
 * A stable key — MCP_CONFIRM_SECRET, or the MCP_HOST_CONFIRM_SECRET mcp-host
 * derives per child beside an absolute MCP_DATA_DIR — makes a token valid in
 * every process that shares it, so a used one must be remembered on disk or a
 * restart inside its lifetime (a crash, a redeploy, the child dying right
 * after the SMTP hand-off) would accept it again: for a target with no
 * revision to rotate (a new mail) that is a second email nobody approved.
 *
 * mcp-utils' durable store does this (`$MCP_DATA_DIR/.mcp-confirm/spent`, one
 * O_EXCL-claimed 0600 file per spent nonce, failing closed when it cannot
 * look). On top of it this server keeps two things of its own:
 *
 * - `APPLE_STATE_CACHE=false` opts out of every on-disk file, this one too:
 *   spends are then remembered by this process only — reported once on stderr
 *   when a stable key makes that matter.
 * - A local install with MCP_CONFIRM_SECRET but no absolute MCP_DATA_DIR keeps
 *   its spends beside the other state caches
 *   (`$HOME/.apple-icloud-mcp/confirm-spent/`), in the same shared format.
 *
 * Without a stable key a restart invalidates every token anyway, so the
 * process-wide in-memory store is enough.
 */
export const SPENT_TOKENS_DIR = 'confirm-spent';

/** The process-wide in-memory store, when nothing persists. */
const processSpent = createSpentTokenStore();

const localStores = new Map<string, SpentTokenStore>();

let warnedDisabled = false;

/**
 * Whether the confirm key outlives the process — the same rule as mcp-utils'
 * `confirmKeyFromEnv`: the operator's MCP_CONFIRM_SECRET, else mcp-host's
 * per-child MCP_HOST_CONFIRM_SECRET, which counts only beside an absolute
 * MCP_DATA_DIR.
 */
function hasStableConfirmKey(env: EnvSource): boolean {
  if (readEnvVar('MCP_CONFIRM_SECRET', { env }) !== undefined) return true;
  return readEnvVar('MCP_HOST_CONFIRM_SECRET', { env }) !== undefined && isAbsolute(readEnvVar('MCP_DATA_DIR', { env }) ?? '');
}

/** The spent-token store for a gated call, per the rules above. */
export function spentTokenStore(env: EnvSource = process.env): SpentTokenStore {
  if (!isStateCacheEnabled(env)) {
    if (!warnedDisabled && hasStableConfirmKey(env)) {
      warnedDisabled = true;
      console.error(
        '[apple-icloud-mcp] WARNING: APPLE_STATE_CACHE=false, so a used confirmToken is remembered by this process only. '
          + "With MCP_CONFIRM_SECRET (or mcp-host's MCP_HOST_CONFIRM_SECRET) set, a restart before it expires would accept it again.",
      );
    }
    return processSpent;
  }
  const shared = spentTokenStoreFromEnv(env);
  if (shared) return shared;
  if (!hasStableConfirmKey(env)) return processSpent;
  const dir = join(dirname(resolveStateFile({ env, subdir: STATE_SUBDIR, fileName: SPENT_TOKENS_DIR })), SPENT_TOKENS_DIR);
  let store = localStores.get(dir);
  if (!store) {
    store = createFileSpentTokenStore(dir);
    localStores.set(dir, store);
  }
  return store;
}

/** Test seam: forget the in-memory spent tokens (what a restart does) and the warning. */
export function resetSpentTokenMemory(): void {
  processSpent.clear();
  warnedDisabled = false;
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
