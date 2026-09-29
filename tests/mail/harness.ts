import { afterEach, beforeEach, vi } from 'vitest';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { resetMailLoginMemory } from '../../src/mail/config.js';
import type { SmtpSubmission, SmtpSubmitResult, SmtpTransportOptions } from '../../src/mail/smtp.js';
import { registerMailTools, type MailDeps } from '../../src/mail/tools.js';
import { FakeMailServer } from './fake-imap.js';

export interface Registered {
  cfg: { description: string; inputSchema: { safeParse: (v: unknown) => { success: boolean } }; annotations: Record<string, unknown>; title?: string };
  cb: (args: Record<string, unknown>, ctx?: unknown) => Promise<CallToolResult>;
}

export function captureTools(deps?: MailDeps): Map<string, Registered> {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, cfg: Registered['cfg'], cb: Registered['cb']) => tools.set(name, { cfg, cb }),
  } as unknown as McpServer;
  registerMailTools(server, deps);
  return tools;
}

export interface Harness {
  imap: FakeMailServer;
  tools: Map<string, Registered>;
  smtpOptions: SmtpTransportOptions[];
  submitted: SmtpSubmission[];
  submit: ReturnType<typeof vi.fn<(m: SmtpSubmission) => Promise<SmtpSubmitResult>>>;
  call(name: string, args?: Record<string, unknown>, ctx?: unknown): Promise<{ json: any; isError: boolean; text: string }>;
}

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];

/** Blank proxy env, iCloud creds and a fixed display zone around every test in the file. */
export function useMailEnv(): void {
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = {};
    for (const k of PROXY_VARS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetMailLoginMemory();
    process.env.ICLOUD_USERNAME = 'me@icloud.com';
    process.env.ICLOUD_APP_PASSWORD = 'abcd-efgh-ijkl-mnop';
    process.env.DISPLAY_TZ = 'America/New_York';
    // The remembered IMAP login form is persisted; keep each test independent of the last.
    process.env.APPLE_STATE_CACHE = 'false';
  });
  afterEach(() => {
    for (const k of PROXY_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
  });
}

export function harness(): Harness {
  const imap = new FakeMailServer();
  const smtpOptions: SmtpTransportOptions[] = [];
  const submitted: SmtpSubmission[] = [];
  const submit = vi.fn(async (m: SmtpSubmission): Promise<SmtpSubmitResult> => {
    submitted.push(m);
    return { accepted: m.to, rejected: [], response: '250 2.0.0 OK' };
  });
  const tools = captureTools({
    createImapClient: imap.factory,
    createSmtpTransport: (o) => {
      smtpOptions.push(o);
      return { submit };
    },
  });
  return {
    imap,
    tools,
    smtpOptions,
    submitted,
    submit,
    async call(name, args = {}, ctx = {}) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool ${name} not registered`);
      const result = await tool.cb(args, ctx);
      const first = result.content[0];
      const text = first?.type === 'text' ? first.text : '';
      return { json: JSON.parse(text), isError: result.isError === true, text };
    },
  };
}
