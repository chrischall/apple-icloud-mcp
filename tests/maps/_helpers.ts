import { createVerify, generateKeyPairSync } from 'node:crypto';
import { vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import type { DeveloperKey } from '../../src/apple-keys.js';
import type { HttpRequest, HttpResponse } from '../../src/http.js';
import { MapsClient, type RequestFn } from '../../src/maps/client.js';
import { SNAPSHOT_ORIGIN } from '../../src/maps/snapshot.js';
import { registerMapsTools, type MapsDeps } from '../../src/maps/tools.js';

/** A real P-256 key, so JWTs and snapshot signatures can be verified. */
const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
export const PRIVATE_PEM = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
export const PUBLIC_KEY = pair.publicKey;

export const TEAM_ID = 'TEAM123456';
export const KEY_ID = 'KEY9876543';

export const KEY: DeveloperKey = { teamId: TEAM_ID, keyId: KEY_ID, privateKeyPem: PRIVATE_PEM, source: 'test' };

/** Put a usable Maps key into the environment (the path real deployments take). */
export function setKeyEnv(): void {
  process.env.APPLE_TEAM_ID = TEAM_ID;
  process.env.APPLE_KEY_ID = KEY_ID;
  process.env.APPLE_PRIVATE_KEY = PRIVATE_PEM;
}

/** 2026-10-03 12:00 EDT. */
export const NOW = Date.parse('2026-10-03T16:00:00Z');

export const ACCESS_TOKEN = 'maps-access-token-abcdef123456';

export type Reply = { status?: number; data: unknown } | { error: number; body?: string };

export type Route = (req: HttpRequest, url: URL) => Reply;

/**
 * A fake `httpRequest`: routes by path, answers `/v1/token` by default, and
 * turns `{error}` replies into whatever the request's `classifyError` makes
 * of them — the same hook the real `httpRequest` consults.
 */
export function fakeRequest(routes: Record<string, Route | Route[]>) {
  const counters = new Map<string, number>();
  const fn = vi.fn(async (req: HttpRequest): Promise<HttpResponse<unknown>> => {
    const url = new URL(String(req.url));
    const path = url.pathname;
    let entry = routes[path];
    if (entry === undefined && path === '/v1/token') {
      entry = () => ({ data: { accessToken: ACCESS_TOKEN, expiresInSeconds: 1800 } });
    }
    if (entry === undefined) throw new Error(`unexpected request to ${path}`);
    let route: Route;
    if (Array.isArray(entry)) {
      const n = counters.get(path) ?? 0;
      counters.set(path, n + 1);
      route = entry[Math.min(n, entry.length - 1)]!;
    } else {
      route = entry;
    }
    const reply = route(req, url);
    if ('error' in reply) {
      const err = req.classifyError?.(reply.error, reply.body ?? '', new Headers());
      throw err ?? new Error(`unclassified HTTP ${reply.error}`);
    }
    return { status: reply.status ?? 200, headers: new Headers(), url: url.toString(), data: reply.data, text: '', bytes: new Uint8Array() };
  });
  return fn as typeof fn & RequestFn;
}

export interface CapturedTool {
  cfg: { title?: string; description: string; inputSchema: { safeParse: (v: unknown) => { success: boolean } }; annotations: Record<string, unknown> };
  cb: (args: Record<string, unknown>, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

export function fakeServer(): { tools: Map<string, CapturedTool>; server: McpServer } {
  const tools = new Map<string, CapturedTool>();
  const server = {
    registerTool: (name: string, cfg: CapturedTool['cfg'], cb: CapturedTool['cb']) => tools.set(name, { cfg, cb }),
  } as unknown as McpServer;
  return { tools, server };
}

export interface Harness {
  request: ReturnType<typeof fakeRequest>;
  client: MapsClient;
  tools: Map<string, CapturedTool>;
  call: (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; json: Record<string, any> }>;
  /** The requests made to data endpoints (token exchanges excluded). */
  dataCalls: () => HttpRequest[];
}

export function harness(routes: Record<string, Route | Route[]>, deps: Partial<MapsDeps> = {}): Harness {
  const request = fakeRequest(routes);
  const client = new MapsClient({ request, resolveKey: () => KEY, now: () => NOW });
  const { tools, server } = fakeServer();
  registerMapsTools(server, { client, ...deps });
  return {
    request,
    client,
    tools,
    call: async (name, args) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool ${name} not registered`);
      const res = await tool.cb(args, {});
      return { isError: res.isError === true, json: JSON.parse(res.content[0]!.text) as Record<string, any> };
    },
    dataCalls: () =>
      request.mock.calls.map((c) => c[0] as HttpRequest).filter((r) => new URL(String(r.url)).pathname !== '/v1/token'),
  };
}

/** Verify a signed snapshot URL the way Apple does: ES256 (raw r‖s) over the path+query before `&signature=`. */
export function verifySnapshotUrl(url: string): boolean {
  const u = url.slice(SNAPSHOT_ORIGIN.length);
  const at = u.lastIndexOf('&signature=');
  const signed = u.slice(0, at);
  const sig = Buffer.from(u.slice(at + '&signature='.length), 'base64url');
  return createVerify('SHA256').update(signed).verify({ key: PUBLIC_KEY, dsaEncoding: 'ieee-p1363' }, sig);
}
