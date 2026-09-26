import { minifiedResult } from '@chrischall/mcp-utils';
import type {
  CallToolResult,
  InputRequiredResult,
  McpServer,
  ServerContext,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { accessAllowed, isServiceEnabled, type ServiceName, type ToolAccess } from '../config.js';
import { AppleToolError, ConfigError, CredentialsRejectedError, UpstreamError, errorMessage, scrub } from '../errors.js';

/**
 * The seam every tool in this server is registered through.
 *
 * `defineTool` decides — at REGISTRATION — whether a tool exists at all: its
 * service must be enabled (`APPLE_SERVICES`) and its access level allowed by
 * `APPLE_WRITE_MODE`. A write the mode forbids is not refused; it is absent,
 * so nothing (a prompt injection included) can call it.
 *
 * It also wraps every handler so that a thrown error becomes a STRUCTURED
 * error result (`{error:{code,message,hint,…}}`, `isError: true`), scrubbed of
 * every credential this process has used. An error must never render as an
 * empty result, and it must never carry a token.
 */

export type ToolResult = CallToolResult | InputRequiredResult;

export interface ToolDefinition<S extends z.ZodType<Record<string, unknown>>> {
  name: string;
  /** Which service's switch governs this tool; `core` tools are always registered. */
  service: ServiceName | 'core';
  access: ToolAccess;
  title?: string;
  description: string;
  /** Always a `z.strictObject(...)`: an unknown argument is an error, never silently dropped. */
  inputSchema: S;
  annotations: ToolAnnotations;
  handler: (args: z.infer<S>, ctx: ServerContext) => Promise<ToolResult>;
}

/** Registers `def` if its service is enabled and its access is allowed. Returns whether it registered. */
export function defineTool<S extends z.ZodType<Record<string, unknown>>>(server: McpServer, def: ToolDefinition<S>): boolean {
  if (def.service !== 'core' && !isServiceEnabled(def.service)) return false;
  if (!accessAllowed(def.access)) return false;
  server.registerTool(
    def.name,
    {
      ...(def.title !== undefined ? { title: def.title } : {}),
      description: def.description,
      inputSchema: def.inputSchema,
      annotations: def.annotations,
    },
    (async (args: z.infer<S>, ctx: ServerContext) => {
      try {
        return await def.handler(args, ctx);
      } catch (err) {
        return toolErrorResult(err);
      }
    }) as never,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** A successful JSON result, minified (indentation is ~20% of a large payload and nothing reads it). */
export function jsonResponse(data: unknown): CallToolResult {
  return minifiedResult(data);
}

/** A structured failure: the JSON payload plus `isError`, for refusals that carry recovery data. */
export function jsonErrorResponse(data: unknown): CallToolResult {
  const r = minifiedResult(data);
  return { ...r, content: r.content.map((c) => (c.type === 'text' ? { ...c, text: scrub(c.text) } : c)), isError: true };
}

/** Convert any thrown value to a structured, scrubbed error result. */
export function toolErrorResult(err: unknown): CallToolResult {
  const error: Record<string, unknown> = {};
  if (err instanceof AppleToolError) {
    error.code = err.code;
    error.message = errorMessage(err);
    if (err.hint) error.hint = scrub(err.hint);
    if (err instanceof ConfigError) {
      error.service = err.service;
      error.missing = err.missing;
    } else if (err instanceof CredentialsRejectedError || err instanceof UpstreamError) {
      error.service = err.service;
      error.status = err.status;
      if (err instanceof UpstreamError && err.upstreamCode !== undefined) error.upstreamCode = err.upstreamCode;
    } else if ('service' in err && typeof (err as { service?: unknown }).service === 'string') {
      error.service = (err as { service: string }).service;
    }
  } else {
    error.code = 'INTERNAL_ERROR';
    error.message = errorMessage(err);
    const hint = (err as { hint?: unknown } | null)?.hint;
    if (typeof hint === 'string') error.hint = scrub(hint);
  }
  return jsonErrorResponse({ error });
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

/**
 * Annotation presets. Every tool reaches a live Apple API, so `openWorldHint`
 * is always true. An unannotated tool is published as destructive by default,
 * so every tool sets these explicitly.
 */
export const ANNOTATIONS = {
  /** Reads nothing but reads. */
  read: { readOnlyHint: true, openWorldHint: true },
  /** Adds something new; existing data untouched. Repeating it adds again. */
  additive: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  /** Sets a reversible flag or relationship (rate, favorite, move); repeating is a no-op. */
  toggle: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  /** Overwrites fields of an existing item in place. */
  update: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  /** Removes something. */
  remove: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  /** Sends something to another person; cannot be recalled. */
  send: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
} as const satisfies Record<string, ToolAnnotations>;

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

export const offsetParam = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe('Zero-based index of the first item to return (default 0). Use the nextOffset from the previous page.');

/** A `limit` parameter with a documented default and hard maximum. Below 1 is refused, never clamped. */
export function limitParam(defaultLimit: number, max: number): z.ZodOptional<z.ZodNumber> {
  return z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`Maximum items to return (default ${defaultLimit}, max ${max}).`);
}

export interface PageInfo {
  /** How many items this response holds. */
  returned: number;
  /** Total matching items, when known. */
  total?: number;
  offset: number;
  limit: number;
  /** The offset to pass for the next page, or null when this is the last page. */
  nextOffset: number | null;
  hasMore: boolean;
}

/**
 * Paging facts for a slice. When `total` is known it decides `hasMore`;
 * otherwise `hasMore` must be supplied (e.g. from an upstream `next` link) —
 * a full page with no total is NOT assumed to be the last.
 */
export function pageInfo(o: { offset: number; limit: number; returned: number; total?: number; hasMore?: boolean }): PageInfo {
  const hasMore = o.total !== undefined ? o.offset + o.returned < o.total : (o.hasMore ?? false);
  return {
    returned: o.returned,
    ...(o.total !== undefined ? { total: o.total } : {}),
    offset: o.offset,
    limit: o.limit,
    nextOffset: hasMore ? o.offset + o.returned : null,
    hasMore,
  };
}

/**
 * Assemble a list response with the paging facts FIRST and the data array
 * LAST. Key order is what `JSON.stringify` emits, and a reader that sees only
 * the head of a large response (a truncated preview, a script that pulls one
 * key) must reach "this is a slice" before the first record.
 */
export function pagedResponse(
  page: PageInfo,
  key: string,
  items: unknown[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...page, ...extra, [key]: items };
}

/** Drop `undefined` members so optional fields are ABSENT rather than null (an absent field is not a claim). */
export function compactObject<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}
