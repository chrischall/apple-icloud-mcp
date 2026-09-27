import { createHash } from 'node:crypto';
import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';
import { confirmationFromEnv, confirmTokenParam, requireConfirmationWithFallback } from '@chrischall/mcp-utils';

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
      subject: () => ({
        target: opts.target,
        ...(opts.revision !== undefined ? { revision: opts.revision } : {}),
        payload: opts.payload,
        preview: opts.preview,
      }),
    }),
  );
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
