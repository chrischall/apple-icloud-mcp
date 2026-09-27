import { describe, expect, it, vi } from 'vitest';
import type { ServerContext } from '@modelcontextprotocol/server';
import { CONFIRM_NOTE, confirmTokenParam, confirmWrite, stateRevision } from '../../src/tools/_confirm.js';
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
