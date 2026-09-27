import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { callConfirmed, type GatedHandler } from '../tools/_confirm-helpers.js';
import { captureTools, useMailEnv } from './harness.js';

/**
 * The DEFAULT imapflow / nodemailer factories, exercised without leaving the
 * machine: HTTPS_PROXY points at a loopback proxy that refuses every CONNECT
 * (as mcp-host's egress proxy refuses a host outside the allowlist).
 */

useMailEnv();

let proxy: Server;
const seen: string[] = [];

beforeEach(async () => {
  seen.length = 0;
  proxy = createServer();
  proxy.on('connect', (req, socket: Socket) => {
    seen.push(String(req.url));
    socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  process.env.HTTPS_PROXY = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((r) => proxy.close(r));
});

describe('default factories', () => {
  it('IMAP goes through the proxy to imap.mail.me.com:993 and a refusal is a network error', async () => {
    const tools = captureTools();
    const r = await tools.get('apple_mail_list_mailboxes')?.cb({}, {});
    const out = JSON.parse(r?.content[0]?.text as string);
    expect(r?.isError).toBe(true);
    expect(out.error).toMatchObject({ code: 'NETWORK_ERROR', service: 'mail' });
    expect(out.error.hint).toMatch(/egress allowlist/);
    expect(seen).toEqual(['imap.mail.me.com:993']);
  });

  it('SMTP goes through the proxy to smtp.mail.me.com:587 and a refusal means nothing was sent', async () => {
    const tools = captureTools();
    const send = tools.get('apple_mail_send')?.cb as unknown as GatedHandler;
    const r = await callConfirmed(send, { to: ['a@b.com'], subject: 's', body: 'b' });
    const out = JSON.parse(r.content[0]?.text as string);
    expect(out.error).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(out.error.message).toMatch(/failed during connect: Invalid response from proxy: 403\. Nothing was sent\./);
    expect(seen).toEqual(['smtp.mail.me.com:587']);
  });
});
