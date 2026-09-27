import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerContext } from '@modelcontextprotocol/server';
import { createSpentTokenStore } from '@chrischall/mcp-utils';
import {
  CONFIRM_NOTE,
  MAX_SPENT_TOKENS,
  SPENT_TOKENS_FILE,
  confirmTokenParam,
  confirmWrite,
  createFileSpentTokenStore,
  resetSpentTokenMemory,
  stateRevision,
} from '../../src/tools/_confirm.js';
import { STATE_SUBDIR, stateCache } from '../../src/state.js';
import { jsonResponse } from '../../src/tools/_shared.js';
import { CAN_ASK_CTX, NO_ELICIT_CTX, callConfirmed, callPreview, type ToolResultLike } from './_confirm-helpers.js';

/**
 * A stand-in gated tool: reads the target (an event with an ETag), gates, then
 * "writes". `state` is what a fresh read returns, so a test can change it
 * between the phases the way another client editing the event would.
 */
function gatedTool(state: { title: string; etag?: string }, tool = 'apple_calendar_delete_event') {
  const write = vi.fn();
  const read = vi.fn(() => ({ ...state }));
  const handler = async (args: Record<string, unknown>, ctx?: unknown): Promise<ToolResultLike> => {
    const current = read();
    const gate = await confirmWrite(ctx as ServerContext, {
      tool,
      action: 'apple.calendar.event.delete',
      message: 'Delete this event?',
      target: `event:${String(args.eventId)}`,
      ...(current.etag !== undefined ? { revision: current.etag } : {}),
      payload: { eventId: args.eventId, span: args.span ?? 'thisEvent' },
      preview: { title: current.title, scope: 'this occurrence only' },
      args,
      confirmToken: args.confirmToken as string | undefined,
    });
    if (gate) return gate as ToolResultLike;
    write(args.eventId);
    return jsonResponse({ deleted: true }) as ToolResultLike;
  };
  return { handler, write, read };
}

const body = (r: ToolResultLike) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

describe('exports', () => {
  it('CONFIRM_NOTE explains both paths; confirmTokenParam is an optional string', () => {
    expect(CONFIRM_NOTE).toContain('confirmation prompt');
    expect(CONFIRM_NOTE).toContain('confirmToken');
    expect(CONFIRM_NOTE).toContain('MCP_CONFIRM_MODE');
    expect(confirmTokenParam.safeParse(undefined).success).toBe(true);
    expect(confirmTokenParam.safeParse('tok').success).toBe(true);
    expect(confirmTokenParam.safeParse(1).success).toBe(false);
  });
});

describe('stateRevision', () => {
  it('is a short, stable digest that rotates on any change', () => {
    const a = stateRevision(['i.1', 'i.2']);
    expect(a).toMatch(/^s1:[A-Za-z0-9_-]{22}$/);
    expect(stateRevision(['i.1', 'i.2'])).toBe(a);
    expect(stateRevision(['i.2', 'i.1'])).not.toBe(a);
    expect(stateRevision({ title: 'x' })).not.toBe(stateRevision({ title: 'y' }));
  });

  it('ignores object KEY order at any depth (two reads of an unchanged record must agree) but not array order', () => {
    const a = { id: 'p.1', attributes: { name: 'Mix', canEdit: true }, tracks: ['i.1', 'i.2'] };
    const b = { tracks: ['i.1', 'i.2'], attributes: { canEdit: true, name: 'Mix' }, id: 'p.1' };
    expect(stateRevision(b)).toBe(stateRevision(a));
    expect(stateRevision({ ...a, tracks: ['i.2', 'i.1'] })).not.toBe(stateRevision(a));
    expect(stateRevision({ ...a, attributes: { name: 'Mix 2', canEdit: true } })).not.toBe(stateRevision(a));
    // Undefined members are absent, as in JSON; Dates serialize through toJSON.
    expect(stateRevision({ x: 1, y: undefined })).toBe(stateRevision({ x: 1 }));
    expect(stateRevision({ at: new Date(0) })).toBe(stateRevision({ at: '1970-01-01T00:00:00.000Z' }));
  });

  it('handles values JSON cannot represent', () => {
    expect(stateRevision(undefined)).toMatch(/^s1:/);
    expect(stateRevision(() => 1)).toBe(stateRevision(undefined));
    expect(stateRevision(null)).not.toBe(stateRevision(undefined));
  });
});

describe('confirmWrite — two-phase token flow (client without elicitation)', () => {
  it('phase 1 performs NO write and returns the preview plus a token', async () => {
    const { handler, write } = gatedTool({ title: 'Standup', etag: '"e1"' });
    const p1 = await callPreview(handler, { eventId: 'home/abc.ics' });
    expect(p1.status).toBe('confirmation-required');
    expect(p1.action).toBe('apple.calendar.event.delete');
    expect(p1.preview).toEqual({ title: 'Standup', scope: 'this occurrence only' });
    expect(typeof p1.confirmToken).toBe('string');
    expect(p1.instruction).toContain('Show this preview to the user');
    expect(write).not.toHaveBeenCalled();
  });

  it('phase 2 with the token proceeds exactly once (re-running the read)', async () => {
    const { handler, write, read } = gatedTool({ title: 'Standup', etag: '"e1"' });
    const result = await callConfirmed(handler, { eventId: 'home/abc.ics' });
    expect(result.isError).toBeUndefined();
    expect(body(result)).toEqual({ deleted: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1); // history cleared between phases: this is phase 2's read
  });

  it('a token acts once: reuse is TOKEN_REUSED and writes nothing', async () => {
    const { handler, write } = gatedTool({ title: 'Standup', etag: '"e1"' });
    const args = { eventId: 'home/abc.ics' };
    const { confirmToken } = await callPreview(handler, args);
    await handler({ ...args, confirmToken }, NO_ELICIT_CTX);
    const again = await handler({ ...args, confirmToken }, NO_ELICIT_CTX);
    expect(again.isError).toBe(true);
    expect(body(again)).toMatchObject({ status: 'confirmation-rejected', error: 'TOKEN_REUSED', dispatched: false });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('refuses when the target changed between the phases (revision rotated) and re-offers a fresh preview', async () => {
    const state = { title: 'Standup', etag: '"e1"' };
    const { handler, write } = gatedTool(state);
    const args = { eventId: 'home/abc.ics' };
    const { confirmToken } = await callPreview(handler, args);
    state.etag = '"e2"';
    state.title = 'Standup (moved)';
    const r = await handler({ ...args, confirmToken }, NO_ELICIT_CTX);
    expect(r.isError).toBe(true);
    const b = body(r);
    expect(b).toMatchObject({ error: 'DRAFT_CHANGED', reason: 'revision-changed', preview: { title: 'Standup (moved)' } });
    expect(typeof b.confirmToken).toBe('string');
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses when the arguments changed between the phases (bound into the token)', async () => {
    const { handler, write } = gatedTool({ title: 'Standup' });
    const { confirmToken } = await callPreview(handler, { eventId: 'home/abc.ics', span: 'thisEvent' });
    const r = await handler({ eventId: 'home/abc.ics', span: 'allEvents', confirmToken }, NO_ELICIT_CTX);
    expect(body(r)).toMatchObject({ error: 'DRAFT_CHANGED', reason: 'payload-changed' });
    expect(write).not.toHaveBeenCalled();
  });

  it('a token never crosses tools or targets', async () => {
    const a = gatedTool({ title: 'Standup' }, 'apple_calendar_delete_event');
    const b = gatedTool({ title: 'Standup' }, 'apple_contacts_delete');
    const { confirmToken } = await callPreview(a.handler, { eventId: 'x' });
    expect(body(await b.handler({ eventId: 'x', confirmToken }, NO_ELICIT_CTX))).toMatchObject({ error: 'TOKEN_INVALID' });
    expect(body(await a.handler({ eventId: 'y', confirmToken }, NO_ELICIT_CTX))).toMatchObject({ error: 'TOKEN_INVALID' });
    expect(a.write).not.toHaveBeenCalled();
    expect(b.write).not.toHaveBeenCalled();
  });

  it('MCP_CONFIRM_MODE=auto lets the model confirm after reviewing; refuse sends the user to the Apple app', async () => {
    process.env.MCP_CONFIRM_MODE = 'auto';
    const auto = gatedTool({ title: 'Standup' });
    expect((await callPreview(auto.handler, { eventId: 'x' })).instruction).toContain('MCP_CONFIRM_MODE=auto');

    process.env.MCP_CONFIRM_MODE = 'refuse';
    const refuse = gatedTool({ title: 'Standup' });
    const r = await refuse.handler({ eventId: 'x' }, NO_ELICIT_CTX);
    expect(body(r)).toMatchObject({ confirmed: false, dispatched: false, reason: 'confirmation-unsupported' });
    expect(String(body(r).note)).toContain('Make this change in the Apple app (Music, Calendar, Contacts or Mail) instead.');
    expect(refuse.write).not.toHaveBeenCalled();
  });
});

describe('confirmWrite — real prompt (client with form elicitation)', () => {
  it('asks with the preview, and proceeds only on an accepted prompt bound to the same action + args', async () => {
    const { handler, write } = gatedTool({ title: 'Standup', etag: '"e1"' });
    const args = { eventId: 'home/abc.ics' };
    const ask = (await handler(args, CAN_ASK_CTX)) as unknown as {
      resultType: string;
      requestState: string;
      inputRequests: { confirmation: { method: string; params: { message: string } } };
    };
    expect(ask.resultType).toBe('input_required');
    expect(ask.inputRequests.confirmation.method).toBe('elicitation/create');
    expect(ask.inputRequests.confirmation.params.message).toContain('Delete this event?');
    expect(ask.inputRequests.confirmation.params.message).toContain('Standup');
    expect(write).not.toHaveBeenCalled();

    const answered = (action: string, confirmed: boolean) => ({
      mcpReq: {
        ...CAN_ASK_CTX.mcpReq,
        inputResponses: { confirmation: { action, content: { confirmed } } },
        requestState: () => ask.requestState,
      },
    });
    const declined = await handler(args, answered('decline', false));
    expect(body(declined)).toMatchObject({ confirmed: false, cancelled: true });
    expect(write).not.toHaveBeenCalled();

    const accepted = await handler(args, answered('accept', true));
    expect(body(accepted)).toEqual({ deleted: true });
    expect(write).toHaveBeenCalledTimes(1);

    // An acceptance minted for other arguments is not honoured: it asks again.
    const other = (await handler({ eventId: 'home/other.ics' }, answered('accept', true))) as unknown as { resultType: string };
    expect(other.resultType).toBe('input_required');
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('spent confirm tokens survive a restart (MCP_CONFIRM_SECRET shared across processes)', () => {
  const SECRET = 'a-shared-secret-of-at-least-some-length';
  const spentPath = () => join(process.env.MCP_DATA_DIR!, STATE_SUBDIR, SPENT_TOKENS_FILE);
  /** A new process's view: nothing in memory, the same data dir. */
  const freshStore = () => createFileSpentTokenStore({ memory: createSpentTokenStore() });

  beforeEach(() => {
    resetSpentTokenMemory();
    freshStore().clear();
  });

  it('a used send token is refused after a restart instead of sending again', async () => {
    process.env.MCP_CONFIRM_SECRET = SECRET;
    const { handler, write } = gatedTool({ title: 'Lunch?' }, 'apple_mail_send'); // no revision, like mail:new
    const args = { eventId: 'new' };
    const { confirmToken } = await callPreview(handler, args);
    expect(body(await handler({ ...args, confirmToken }, NO_ELICIT_CTX))).toEqual({ deleted: true });
    expect(write).toHaveBeenCalledTimes(1);

    resetSpentTokenMemory(); // the child restarts; the key is the same, so the token still verifies
    const replay = await handler({ ...args, confirmToken }, NO_ELICIT_CTX);
    expect(replay.isError).toBe(true);
    expect(body(replay)).toMatchObject({ status: 'confirmation-rejected', error: 'TOKEN_REUSED', dispatched: false });
    expect(write).toHaveBeenCalledTimes(1);

    // Control: the file is the ONLY thing that remembered it. Without it the
    // restarted process would have accepted the replay — the bug this closes.
    resetSpentTokenMemory();
    freshStore().clear();
    expect(body(await handler({ ...args, confirmToken }, NO_ELICIT_CTX))).toEqual({ deleted: true });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('records only a digest of the nonce and its expiry, 0600, bound to the key', () => {
    process.env.MCP_CONFIRM_SECRET = SECRET;
    const exp = Date.now() + 60_000;
    freshStore().add('nonce-one', exp);
    const raw = readFileSync(spentPath(), 'utf8');
    expect(raw).not.toContain('nonce-one');
    expect(raw).not.toContain(SECRET);
    expect(statSync(spentPath()).mode & 0o777).toBe(0o600);
    expect(Object.values((JSON.parse(raw) as { state: { spent: Record<string, number> } }).state.spent)).toEqual([exp]);

    const restarted = freshStore();
    expect(restarted.has('nonce-one')).toBe(true);
    expect(restarted.has('nonce-two')).toBe(false);
    expect(restarted.size).toBe(1);
    // A rotated secret invalidates every token anyway, and discards the record.
    process.env.MCP_CONFIRM_SECRET = `${SECRET}-rotated`;
    expect(freshStore().has('nonce-one')).toBe(false);
  });

  it('keeps an in-memory mirror, prunes expired entries on write, and caps the file', () => {
    process.env.MCP_CONFIRM_SECRET = SECRET;
    vi.useFakeTimers({ now: Date.parse('2026-09-27T12:00:00Z') });
    const now = Date.now();
    const memory = createSpentTokenStore();
    const store = createFileSpentTokenStore({ memory });
    store.add('old', now + 1000);
    store.add('old', now + 2000); // the same token twice is one entry
    expect(store.size).toBe(1);
    store.prune(now + 5000);
    expect(memory.size).toBe(0); // prune is memory-only…
    expect(store.has('old')).toBe(true); // …the file still has it until the next write
    vi.setSystemTime(now + 5000);
    store.add('new', now + 600_000);
    expect(freshStore().has('old')).toBe(false); // expired: dropped on that write
    expect(freshStore().has('new')).toBe(true);
    expect(store.size).toBe(1);

    for (let i = 0; i < MAX_SPENT_TOKENS + 3; i++) store.add(`n${i}`, now + 700_000 + i);
    const entries = (JSON.parse(readFileSync(spentPath(), 'utf8')) as { state: { spent: Record<string, number> } }).state.spent;
    expect(Object.keys(entries)).toHaveLength(MAX_SPENT_TOKENS);
    const restarted = freshStore();
    expect(restarted.has('new')).toBe(false); // the soonest to expire went first
    expect(restarted.has('n0')).toBe(false);
    expect(restarted.has('n3')).toBe(true);
    expect(restarted.has(`n${MAX_SPENT_TOKENS + 2}`)).toBe(true);
    expect(store.size).toBe(MAX_SPENT_TOKENS + 4); // memory still refuses every one of them

    store.clear();
    expect(store.size).toBe(0);
    expect(freshStore().has('n3')).toBe(false);
  });

  it('ignores a corrupt or tampered record', () => {
    process.env.MCP_CONFIRM_SECRET = SECRET;
    freshStore().add('x', Date.now() + 60_000); // establishes the key binding's file
    const binding = (JSON.parse(readFileSync(spentPath(), 'utf8')) as { boundTo: unknown }).boundTo;
    const put = (state: unknown) => writeFileSync(spentPath(), JSON.stringify({ v: 1, boundTo: binding, state }));
    put(null);
    expect(freshStore().size).toBe(0);
    put({ spent: [] });
    expect(freshStore().size).toBe(0);
    put({ spent: 'nope' });
    expect(freshStore().size).toBe(0);
    put({ spent: { a: 'soon', b: 5 } });
    expect(freshStore().size).toBe(1);
  });

  it('with APPLE_STATE_CACHE=false it is single-use per process only, and warns once when a shared secret makes that matter', async () => {
    process.env.APPLE_STATE_CACHE = 'false';
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { handler, write } = gatedTool({ title: 'Lunch?' }, 'apple_mail_send');
    const args = { eventId: 'new' };
    // No secret: a restart invalidates the token anyway — nothing to warn about.
    let { confirmToken } = await callPreview(handler, args);
    await handler({ ...args, confirmToken }, NO_ELICIT_CTX);
    expect(err).not.toHaveBeenCalled();

    process.env.MCP_CONFIRM_SECRET = SECRET;
    ({ confirmToken } = await callPreview(handler, args));
    await handler({ ...args, confirmToken }, NO_ELICIT_CTX);
    expect(body(await handler({ ...args, confirmToken }, NO_ELICIT_CTX))).toMatchObject({ error: 'TOKEN_REUSED' });
    ({ confirmToken } = await callPreview(handler, args));
    await handler({ ...args, confirmToken }, NO_ELICIT_CTX);
    expect(write).toHaveBeenCalledTimes(3);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toBe(
      '[aws-mcp] WARNING: APPLE_STATE_CACHE=false, so a used confirmToken is remembered by this process only. ' +
        'With MCP_CONFIRM_SECRET set, a restart before it expires would accept it again.',
    );
    expect(() => statSync(spentPath())).toThrow(); // nothing written
    vi.restoreAllMocks();
  });

  it('falls back to the in-memory mirror when the file cannot be written, with a warning', () => {
    process.env.MCP_CONFIRM_SECRET = SECRET;
    const dir = mkdtempSync(join(tmpdir(), 'aws-mcp-spent-'));
    try {
      const notADir = join(dir, 'file');
      writeFileSync(notADir, 'x');
      process.env.MCP_DATA_DIR = notADir;
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const store = createFileSpentTokenStore();
      store.add('n1', Date.now() + 60_000);
      store.add('n2', Date.now() + 60_000);
      expect(store.has('n1')).toBe(true);
      expect(store.has('n2')).toBe(true);
      const ours = err.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('confirmToken'));
      expect(ours).toEqual([
        '[aws-mcp] WARNING: could not record a used confirmToken on disk; it is remembered by this process only. ' +
          'With MCP_CONFIRM_SECRET set, a restart before it expires would accept it again.',
      ]);
      vi.restoreAllMocks();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never touches the data dir for a phase-1 call or a prompted client', async () => {
    const { handler } = gatedTool({ title: 'Standup' });
    await callPreview(handler, { eventId: 'x' });
    await handler({ eventId: 'x' }, CAN_ASK_CTX);
    expect(() => statSync(spentPath())).toThrow();
    expect(stateCache(SPENT_TOKENS_FILE, 'any', (x) => x).load()).toBeNull();
  });
});
