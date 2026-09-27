import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError } from '@chrischall/mcp-utils';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { z } from 'zod';
import {
  ANNOTATIONS,
  compactObject,
  defineTool,
  jsonErrorResponse,
  jsonResponse,
  limitParam,
  offsetParam,
  pageInfo,
  pagedResponse,
  toolErrorResult,
} from '../../src/tools/_shared.js';
import {
  AppleToolError,
  ConfigError,
  CredentialsRejectedError,
  InvalidArgumentError,
  TransportError,
  UnconfirmedWriteError,
  UpstreamError,
  rememberSecret,
} from '../../src/errors.js';

type Registered = { cfg: Record<string, unknown>; cb: (args: unknown, ctx: unknown) => Promise<unknown> };

function fakeServer(): { server: McpServer; tools: Map<string, Registered> } {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, cfg: Record<string, unknown>, cb: Registered['cb']) => tools.set(name, { cfg, cb }),
  } as unknown as McpServer;
  return { server, tools };
}

function parse(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
}

const schema = z.strictObject({ id: z.string().describe('An id.') });

describe('defineTool', () => {
  it('registers an allowed tool with its title, description, schema and annotations', async () => {
    const { server, tools } = fakeServer();
    const handler = vi.fn(async (args: { id: string }, ctx: unknown) => jsonResponse({ got: args.id, ctx }));
    const ok = defineTool(server, {
      name: 'apple_music_thing',
      service: 'music',
      access: 'read',
      title: 'Thing',
      description: 'Does a thing.',
      inputSchema: schema,
      annotations: ANNOTATIONS.read,
      handler,
    });
    expect(ok).toBe(true);
    const t = tools.get('apple_music_thing')!;
    expect(t.cfg).toEqual({ title: 'Thing', description: 'Does a thing.', inputSchema: schema, annotations: ANNOTATIONS.read });
    const res = await t.cb({ id: 'x' }, 'ctx');
    expect(parse(res)).toEqual({ got: 'x', ctx: 'ctx' });
    expect(handler).toHaveBeenCalledWith({ id: 'x' }, 'ctx');
  });

  it('omits the title when none is given', () => {
    const { server, tools } = fakeServer();
    defineTool(server, { name: 't', service: 'maps', access: 'read', description: 'd', inputSchema: schema, annotations: ANNOTATIONS.read, handler: async () => jsonResponse({}) });
    expect('title' in tools.get('t')!.cfg).toBe(false);
  });

  it('does not register a tool whose service is disabled by APPLE_SERVICES — but always registers core tools', () => {
    process.env.APPLE_SERVICES = 'maps';
    const { server, tools } = fakeServer();
    const base = { description: 'd', inputSchema: schema, annotations: ANNOTATIONS.read, handler: async () => jsonResponse({}) };
    expect(defineTool(server, { ...base, name: 'music_tool', service: 'music', access: 'read' })).toBe(false);
    expect(defineTool(server, { ...base, name: 'maps_tool', service: 'maps', access: 'read' })).toBe(true);
    expect(defineTool(server, { ...base, name: 'core_tool', service: 'core', access: 'read' })).toBe(true);
    expect([...tools.keys()]).toEqual(['maps_tool', 'core_tool']);
  });

  it('does not register a write the write mode forbids (structural gate)', () => {
    const base = { description: 'd', inputSchema: schema, handler: async () => jsonResponse({}) };
    for (const [mode, expected] of [
      ['none', ['r']],
      ['additive', ['r', 'a']],
      ['all', ['r', 'a', 'w']],
    ] as const) {
      process.env.APPLE_WRITE_MODE = mode;
      const { server, tools } = fakeServer();
      defineTool(server, { ...base, name: 'r', service: 'music', access: 'read', annotations: ANNOTATIONS.read });
      defineTool(server, { ...base, name: 'a', service: 'music', access: 'additive', annotations: ANNOTATIONS.additive });
      defineTool(server, { ...base, name: 'w', service: 'music', access: 'all', annotations: ANNOTATIONS.remove });
      expect([...tools.keys()]).toEqual(expected);
    }
  });

  it('turns a thrown error into a structured, scrubbed isError result (never an empty result)', async () => {
    rememberSecret('app-pw-abcd-efgh');
    const { server, tools } = fakeServer();
    defineTool(server, {
      name: 't',
      service: 'calendar',
      access: 'read',
      description: 'd',
      inputSchema: schema,
      annotations: ANNOTATIONS.read,
      handler: async () => {
        throw new UpstreamError('calendar', 500, 'broke with app-pw-abcd-efgh');
      },
    });
    const res = (await tools.get('t')!.cb({ id: 'x' }, {})) as { isError?: boolean };
    expect(res.isError).toBe(true);
    expect(parse(res)).toEqual({ error: { code: 'UPSTREAM_ERROR', message: 'broke with [REDACTED]', service: 'calendar', status: 500 } });
  });

  it('works end to end through a real MCP server: strict schemas refuse unknown arguments', async () => {
    const harness = await createTestHarness((server) => {
      defineTool(server, {
        name: 'apple_itunes_echo',
        service: 'itunes',
        access: 'read',
        description: 'Echo.',
        inputSchema: schema,
        annotations: ANNOTATIONS.read,
        handler: async (args) => jsonResponse({ id: args.id }),
      });
    });
    try {
      expect((await harness.listTools()).map((t) => t.name)).toEqual(['apple_itunes_echo']);
      const ok = await harness.callTool('apple_itunes_echo', { id: 'a' });
      expect(parse(ok)).toEqual({ id: 'a' });
      const bad = await harness.callTool('apple_itunes_echo', { id: 'a', extra: true });
      expect(bad.isError).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

describe('results', () => {
  it('jsonResponse is minified JSON; whitespace inside values survives', () => {
    const r = jsonResponse({ a: 1, body: 'line 1\n\nline 2' });
    expect(r.content).toEqual([{ type: 'text', text: '{"a":1,"body":"line 1\\n\\nline 2"}' }]);
    expect(r.isError).toBeUndefined();
  });

  it('jsonErrorResponse marks isError and scrubs remembered secrets', () => {
    rememberSecret('refusal-secret-99');
    const r = jsonErrorResponse({ result: 'REFUSED', detail: 'refusal-secret-99' });
    expect(r).toEqual({ content: [{ type: 'text', text: '{"result":"REFUSED","detail":"[REDACTED]"}' }], isError: true });
  });

  it('jsonErrorResponse scrubs strings at any depth and stays valid JSON when a redaction shape runs to the end of the text', () => {
    rememberSecret('deep-secret-value');
    // A Cookie value runs to the next ; , or whitespace — minified JSON has none
    // before its closing quote and braces, so a text-only scrub ate them.
    const r = jsonErrorResponse({
      error: { message: 'upstream echoed Cookie: session=abc123' },
      list: ['deep-secret-value', { nested: 'x deep-secret-value' }, 7, null, true],
    });
    const parsed = JSON.parse(r.content[0]!.type === 'text' ? (r.content[0] as { text: string }).text : '');
    expect(parsed).toEqual({
      error: { message: 'upstream echoed Cookie: session=[REDACTED]' },
      list: ['[REDACTED]', { nested: 'x [REDACTED]' }, 7, null, true],
    });
    expect(r.isError).toBe(true);
  });

  it('jsonErrorResponse keeps key-based redaction (a secret under a secret-named key), and scrubs null-prototype objects', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { hint: 'Authorization: Bearer abcdefghijklmnop' });
    const text = (jsonErrorResponse({ access_token: 'opaque-value', bare, when: new Date(0) }).content[0] as { text: string }).text;
    expect(JSON.parse(text)).toEqual({
      access_token: '[REDACTED]',
      bare: { hint: 'Authorization: Bearer [REDACTED]' },
      when: '1970-01-01T00:00:00.000Z',
    });
  });

  describe('toolErrorResult', () => {
    const errorOf = (err: unknown) => {
      const r = toolErrorResult(err);
      expect(r.isError).toBe(true);
      return parse(r).error as Record<string, unknown>;
    };

    it('ConfigError → service + missing + hint', () => {
      expect(errorOf(new ConfigError('weather', 'no key', ['APPLE_TEAM_ID']))).toEqual({
        code: 'NOT_CONFIGURED',
        message: 'no key',
        hint: "Set APPLE_TEAM_ID in the server's environment.",
        service: 'weather',
        missing: ['APPLE_TEAM_ID'],
      });
    });

    it('CredentialsRejectedError / UpstreamError → service + status (+ upstreamCode)', () => {
      expect(errorOf(new CredentialsRejectedError('music', 403, 'no', 'renew'))).toEqual({
        code: 'CREDENTIALS_REJECTED',
        message: 'no',
        hint: 'renew',
        service: 'music',
        status: 403,
      });
      expect(errorOf(new UpstreamError('music', 400, 'bad', { upstreamCode: '40005' }))).toEqual({
        code: 'UPSTREAM_ERROR',
        message: 'bad',
        service: 'music',
        status: 400,
        upstreamCode: '40005',
      });
      expect(errorOf(new UpstreamError('music', 404, 'gone'))).toEqual({ code: 'NOT_FOUND', message: 'gone', service: 'music', status: 404 });
    });

    it('other service-bearing errors carry the service; errors without one do not', () => {
      expect(errorOf(new TransportError('maps', 'TIMEOUT', 'slow'))).toMatchObject({ code: 'TIMEOUT', service: 'maps' });
      expect(errorOf(new UnconfirmedWriteError('contacts', 'maybe'))).toMatchObject({ code: 'UNCONFIRMED_WRITE', service: 'contacts' });
      expect(errorOf(new InvalidArgumentError('bad', 'fix'))).toEqual({ code: 'INVALID_ARGUMENT', message: 'bad', hint: 'fix' });
      expect(errorOf(new AppleToolError('UNSUPPORTED', 'no'))).toEqual({ code: 'UNSUPPORTED', message: 'no' });
      const oddService = Object.assign(new AppleToolError('UNSUPPORTED', 'no'), { service: 7 });
      expect(errorOf(oddService)).toEqual({ code: 'UNSUPPORTED', message: 'no' });
    });

    it('anything else is INTERNAL_ERROR, keeping a string hint (e.g. mcp-utils McpToolError), scrubbed', () => {
      rememberSecret('hint-secret-12345');
      expect(errorOf(new McpToolError('shape drift', { hint: 'upstream changed hint-secret-12345' }))).toEqual({
        code: 'INTERNAL_ERROR',
        message: 'shape drift',
        hint: 'upstream changed [REDACTED]',
      });
      expect(errorOf(new Error('plain'))).toEqual({ code: 'INTERNAL_ERROR', message: 'plain' });
      expect(errorOf(Object.assign(new Error('odd'), { hint: 5 }))).toEqual({ code: 'INTERNAL_ERROR', message: 'odd' });
      expect(errorOf(null)).toEqual({ code: 'INTERNAL_ERROR', message: 'null' });
      expect(errorOf('text')).toEqual({ code: 'INTERNAL_ERROR', message: 'text' });
    });

    it('scrubs the hint of an Apple error too', () => {
      rememberSecret('apple-hint-secret');
      expect(errorOf(new InvalidArgumentError('m', 'see apple-hint-secret'))).toMatchObject({ hint: 'see [REDACTED]' });
    });
  });
});

describe('ANNOTATIONS', () => {
  it('annotates every kind of tool explicitly, all open-world', () => {
    expect(ANNOTATIONS.read).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(ANNOTATIONS.additive).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(ANNOTATIONS.toggle).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    expect(ANNOTATIONS.update).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
    expect(ANNOTATIONS.remove).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true });
    expect(ANNOTATIONS.send).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  });
});

describe('paging', () => {
  it('offsetParam is an optional non-negative integer', () => {
    expect(offsetParam.safeParse(undefined).success).toBe(true);
    expect(offsetParam.safeParse(0).success).toBe(true);
    expect(offsetParam.safeParse(-1).success).toBe(false);
    expect(offsetParam.safeParse(1.5).success).toBe(false);
    expect(offsetParam.description).toContain('nextOffset');
  });

  it('limitParam refuses (never clamps) out-of-range values and documents default and max', () => {
    const p = limitParam(25, 100);
    expect(p.safeParse(undefined).success).toBe(true);
    expect(p.safeParse(1).success).toBe(true);
    expect(p.safeParse(100).success).toBe(true);
    expect(p.safeParse(0).success).toBe(false);
    expect(p.safeParse(101).success).toBe(false);
    expect(p.safeParse(2.5).success).toBe(false);
    expect(p.description).toBe('Maximum items to return (default 25, max 100).');
  });

  it('pageInfo derives hasMore from the total when known', () => {
    expect(pageInfo({ offset: 0, limit: 10, returned: 10, total: 25 })).toEqual({
      returned: 10, total: 25, offset: 0, limit: 10, nextOffset: 10, hasMore: true,
    });
    expect(pageInfo({ offset: 20, limit: 10, returned: 5, total: 25, hasMore: true })).toEqual({
      returned: 5, total: 25, offset: 20, limit: 10, nextOffset: null, hasMore: false,
    });
  });

  it('pageInfo always moves nextOffset forward: an empty page that claims more advances by limit, never loops', () => {
    // Upstream says there is a next page but returned nothing on this one.
    expect(pageInfo({ offset: 50, limit: 25, returned: 0, hasMore: true })).toEqual({
      returned: 0, offset: 50, limit: 25, nextOffset: 75, hasMore: true,
    });
    // A total that says more exist, but an empty page: step past the window, bounded by the total.
    expect(pageInfo({ offset: 10, limit: 25, returned: 0, total: 100 })).toMatchObject({ nextOffset: 35, hasMore: true });
    expect(pageInfo({ offset: 90, limit: 25, returned: 0, total: 100 })).toMatchObject({ nextOffset: null, hasMore: false });
    expect(pageInfo({ offset: 0, limit: 10, returned: 0, total: 0 })).toMatchObject({ nextOffset: null, hasMore: false });
  });

  it('pageInfo trusts an explicit hasMore without a total, and never assumes a full page is the last', () => {
    expect(pageInfo({ offset: 5, limit: 5, returned: 5, hasMore: true })).toEqual({
      returned: 5, offset: 5, limit: 5, nextOffset: 10, hasMore: true,
    });
    expect(pageInfo({ offset: 0, limit: 5, returned: 3 })).toEqual({ returned: 3, offset: 0, limit: 5, nextOffset: null, hasMore: false });
  });

  it('pagedResponse puts paging facts first, then notes, and the data array LAST', () => {
    const r = pagedResponse(pageInfo({ offset: 0, limit: 2, returned: 2, total: 3 }), 'events', [{ id: 1 }, { id: 2 }], { window: 'x', note: 'n' });
    expect(Object.keys(r)).toEqual(['returned', 'total', 'offset', 'limit', 'nextOffset', 'hasMore', 'window', 'note', 'events']);
    const text = JSON.stringify(r);
    expect(text.indexOf('"hasMore"')).toBeLessThan(text.indexOf('"events"'));
    expect(Object.keys(pagedResponse(pageInfo({ offset: 0, limit: 1, returned: 0, total: 0 }), 'items', []))).toEqual([
      'returned', 'total', 'offset', 'limit', 'nextOffset', 'hasMore', 'items',
    ]);
  });

  it('compactObject drops only undefined', () => {
    expect(compactObject({ a: undefined, b: null, c: 0, d: '', e: false, f: 'x' })).toEqual({ b: null, c: 0, d: '', e: false, f: 'x' });
  });
});
