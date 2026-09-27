import { vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import { MusicClient } from '../../src/music/client.js';
import { registerMusicTools } from '../../src/music/tools.js';

/** A syntactically valid JWT with the given payload (unsigned — Apple is faked). */
export function fakeJwt(payload: Record<string, unknown>, header: Record<string, unknown> = { typ: 'JWT', alg: 'ES256', kid: 'TESTKID' }): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b(header)}.${b(payload)}.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU`;
}

export const FAR_FUTURE = 4102444800; // 2100-01-01
export const OFFICIAL_DEV = fakeJwt({ iss: 'TEAMID1234', iat: 1700000000, exp: FAR_FUTURE });
export const WEB_DEV = fakeJwt({ iss: 'AMPWebPlay', iat: 1700000000, exp: FAR_FUTURE, root_https_origin: ['apple.com'] });
export const USER_TOKEN = 'official-user-token-0123456789';
export const WEB_USER = 'web-media-user-token-0123456789';

export function p256Pem(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
}

/** Official profile with a pre-minted developer token (+ optional user token). */
export function useOfficial(opts: { user?: boolean } = {}): void {
  process.env.APPLE_MUSIC_DEVELOPER_TOKEN = OFFICIAL_DEV;
  if (opts.user ?? true) process.env.APPLE_MUSIC_USER_TOKEN = USER_TOKEN;
}

/** Web profile with an env-supplied web developer token (no scraping). */
export function useWeb(): void {
  process.env.APPLE_MUSIC_WEB_USER_TOKEN = WEB_USER;
  process.env.APPLE_MUSIC_WEB_DEVELOPER_TOKEN = WEB_DEV;
}

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------

export interface FakeReq {
  method: string;
  url: URL;
  host: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  query: URLSearchParams;
}

export interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** Throw from fetch instead of answering (a network failure). */
  fail?: boolean;
}

export type Handler = (req: FakeReq) => Reply | undefined | Promise<Reply | undefined>;

/**
 * Install a fetch stub. `handlers` are consulted in order; the first that
 * returns a reply answers. Unmatched requests answer 599 and are recorded in
 * `unmatched`, so a test that forgot a route fails on its assertions.
 */
export function installFetch(...handlers: Handler[]): { calls: FakeReq[]; unmatched: string[]; fn: ReturnType<typeof vi.fn> } {
  const calls: FakeReq[] = [];
  const unmatched: string[] = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const raw = init?.body === undefined ? undefined : String(init.body);
    let body: unknown = raw;
    if (raw !== undefined) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const req: FakeReq = { method: init?.method ?? 'GET', url, host: url.host, path: url.pathname, headers, body, query: url.searchParams };
    calls.push(req);
    for (const h of handlers) {
      const r = await h(req);
      if (r) {
        if (r.fail) throw new TypeError('fetch failed');
        const text = r.text ?? (r.json === undefined ? '' : JSON.stringify(r.json));
        const status = r.status ?? 200;
        const hdrs = { ...(r.json !== undefined ? { 'content-type': 'application/json;charset=utf-8' } : {}), ...(r.headers ?? {}) };
        return new Response(status === 204 || status === 304 ? null : text, { status, headers: hdrs });
      }
    }
    unmatched.push(`${req.method} ${url.host}${url.pathname}${url.search}`);
    return new Response('unmatched', { status: 599 });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, unmatched, fn };
}

/** A handler for one METHOD + path (string or RegExp), optionally host-scoped. */
export function route(method: string, path: string | RegExp, reply: Reply | ((req: FakeReq) => Reply | undefined), host?: string): Handler {
  return (req) => {
    if (req.method !== method) return undefined;
    if (host !== undefined && req.host !== host) return undefined;
    if (typeof path === 'string' ? req.path !== path : !path.test(req.path)) return undefined;
    return typeof reply === 'function' ? reply(req) : reply;
  };
}

// ---------------------------------------------------------------------------
// A stateful fake Apple Music library
// ---------------------------------------------------------------------------

export interface FakeTrack {
  id: string;
  type?: string;
  name?: string;
  artistName?: string;
  albumName?: string;
  catalogId?: string;
  durationInMillis?: number;
  releaseDate?: string;
  dateAdded?: string;
}

export interface FakePlaylist {
  name: string;
  description?: string;
  canEdit?: boolean;
  isPublic?: boolean;
  hasCatalog?: boolean;
  dateAdded?: string;
  tracks: FakeTrack[];
  parent?: string;
}

export function track(n: number, extra: Partial<FakeTrack> = {}): FakeTrack {
  return { id: `i.T${n}`, name: `Song ${n}`, artistName: `Artist ${n}`, albumName: `Album ${n}`, catalogId: String(1000 + n), durationInMillis: 180000 + n * 1000, ...extra };
}

function trackResource(t: FakeTrack): Record<string, unknown> {
  return {
    id: t.id,
    type: t.type ?? 'library-songs',
    href: `/v1/me/library/songs/${t.id}`,
    attributes: {
      ...(t.name !== undefined ? { name: t.name } : {}),
      ...(t.artistName !== undefined ? { artistName: t.artistName } : {}),
      ...(t.albumName !== undefined ? { albumName: t.albumName } : {}),
      ...(t.durationInMillis !== undefined ? { durationInMillis: t.durationInMillis } : {}),
      ...(t.releaseDate !== undefined ? { releaseDate: t.releaseDate } : {}),
      ...(t.dateAdded !== undefined ? { dateAdded: t.dateAdded } : {}),
      artwork: { url: 'https://example.invalid/{w}x{h}.jpg' },
      playParams: { id: t.id, kind: 'song', isLibrary: true, ...(t.catalogId ? { catalogId: t.catalogId } : {}) },
    },
  };
}

export class FakeLibrary {
  playlists = new Map<string, FakePlaylist>();
  folders = new Map<string, { name: string; parent?: string; dateAdded?: string }>([['p.playlistsroot', { name: 'Root' }]]);
  ratings = new Map<string, number>();
  items = new Map<string, Map<string, Record<string, unknown>>>();
  storefront = 'gb';
  /** Reads lag writes: when true, GETs return the state from before the last write. */
  lag = false;
  private snapshot: string | undefined;
  /** Include meta.total on track pages. */
  metaTotal = false;
  /** Answer 404 on the tracks of an empty playlist (Apple's quirk). */
  emptyTracks404 = true;
  private nextId = 1;
  writes: string[] = [];

  addPlaylist(id: string, p: Partial<FakePlaylist> & { tracks?: FakeTrack[] }): void {
    this.playlists.set(id, { name: p.name ?? id, tracks: p.tracks ?? [], canEdit: true, isPublic: false, dateAdded: '2025-01-02T03:04:05Z', ...p } as FakePlaylist);
  }

  private state(): { playlists: Map<string, FakePlaylist>; folders: FakeLibrary['folders'] } {
    if (this.lag && this.snapshot) {
      const s = JSON.parse(this.snapshot) as { playlists: [string, FakePlaylist][]; folders: [string, { name: string; parent?: string }][] };
      return { playlists: new Map(s.playlists), folders: new Map(s.folders) };
    }
    return { playlists: this.playlists, folders: this.folders };
  }

  private beforeWrite(what: string): void {
    this.writes.push(what);
    this.snapshot = JSON.stringify({ playlists: [...this.playlists], folders: [...this.folders] });
  }

  playlistResource(id: string, p: FakePlaylist): Record<string, unknown> {
    return {
      id,
      type: 'library-playlists',
      href: `/v1/me/library/playlists/${id}`,
      attributes: {
        name: p.name,
        canEdit: p.canEdit,
        isPublic: p.isPublic,
        hasCatalog: p.hasCatalog ?? false,
        ...(p.description !== undefined ? { description: { standard: p.description } } : {}),
        ...(p.dateAdded ? { dateAdded: p.dateAdded } : {}),
        playParams: { id, kind: 'playlist', isLibrary: true },
      },
    };
  }

  handler(): Handler {
    return (req) => {
      if (req.host !== 'api.music.apple.com' && req.host !== 'amp-api.music.apple.com') return undefined;
      const q = req.query;
      const limit = Number(q.get('limit') ?? 25);
      const offset = Number(q.get('offset') ?? 0);
      const st = this.state();
      let m: RegExpExecArray | null;
      const page = (all: unknown[], base: string): Reply => {
        const data = all.slice(offset, offset + limit);
        return {
          json: {
            data,
            ...(offset + limit < all.length ? { next: `${base}?offset=${offset + limit}` } : {}),
            ...(this.metaTotal ? { meta: { total: all.length } } : {}),
          },
        };
      };

      if (req.method === 'GET' && req.path === '/v1/me/storefront') return { json: { data: [{ id: this.storefront, type: 'storefronts' }] } };

      if ((m = /^\/v1\/me\/library\/playlists\/([^/]+)\/tracks$/.exec(req.path))) {
        const id = m[1]!;
        const p = st.playlists.get(id);
        if (req.method === 'GET') {
          if (!p) return { status: 404, json: { errors: [{ status: '404', code: '40400', title: 'Resource Not Found' }] } };
          if (p.tracks.length === 0 && this.emptyTracks404) return { status: 404, json: { errors: [{ status: '404', title: 'Resource Not Found' }] } };
          if (offset >= p.tracks.length && offset > 0) return { status: 404, json: { errors: [{ status: '404', title: 'Resource Not Found' }] } };
          return page(p.tracks.map(trackResource), req.path);
        }
        const live = this.playlists.get(id);
        if (!live) return { status: 404, json: { errors: [{ status: '404', title: 'Resource Not Found' }] } };
        if (req.method === 'POST') {
          this.beforeWrite(`append ${id}`);
          const data = (req.body as { data: Array<{ id: string; type: string }> }).data;
          for (const d of data) live.tracks.push(d.type.startsWith('library-') ? { id: d.id, type: d.type, name: `Lib ${d.id}` } : { id: `i.C${d.id}`, name: `Cat ${d.id}`, catalogId: d.id, type: d.type === 'music-videos' ? 'library-music-videos' : 'library-songs' });
          return { status: 204 };
        }
        if (req.method === 'DELETE') {
          this.beforeWrite(`remove ${id}`);
          // Apple's web player names every playlist item (music videos too) as ids[library-songs].
          const ids = new Set(q.get('ids[library-songs]')?.split(',') ?? []);
          if (q.get('mode') !== 'all') return { status: 400, json: { errors: [{ title: 'No mode supplied' }] } };
          live.tracks = live.tracks.filter((t) => !ids.has(t.id));
          return { status: 204 };
        }
        if (req.method === 'PUT') {
          this.beforeWrite(`replace ${id}`);
          const data = (req.body as { data: Array<{ id: string }> }).data;
          const byId = new Map(live.tracks.map((t) => [t.id, t]));
          live.tracks = data.map((d) => byId.get(d.id)!);
          return { status: 204 };
        }
      }
      if ((m = /^\/v1\/me\/library\/playlists\/([^/]+)\/parent$/.exec(req.path)) && req.method === 'PUT') {
        const live = this.playlists.get(m[1]!);
        if (!live) return { status: 404, json: { errors: [{ title: 'Resource Not Found' }] } };
        this.beforeWrite(`move ${m[1]}`);
        live.parent = (req.body as { data: Array<{ id: string }> }).data[0]!.id;
        return { status: 204 };
      }
      if ((m = /^\/v1\/me\/library\/playlists\/([^/]+)$/.exec(req.path))) {
        const id = m[1]!;
        if (req.method === 'GET') {
          const p = st.playlists.get(id);
          if (!p) return { status: 404, json: { errors: [{ status: '404', code: '40400', title: 'Resource Not Found', detail: 'Resource with requested id was not found' }] } };
          return { json: { data: [this.playlistResource(id, p)] } };
        }
        const live = this.playlists.get(id);
        if (!live) return { status: 404, json: { errors: [{ title: 'Resource Not Found' }] } };
        if (req.method === 'PATCH') {
          this.beforeWrite(`update ${id}`);
          const attrs = (req.body as { attributes: Record<string, unknown> }).attributes;
          if (typeof attrs.name === 'string') live.name = attrs.name;
          if (typeof attrs.description === 'string') live.description = attrs.description === '' ? undefined : attrs.description;
          if (typeof attrs.isPublic === 'boolean') live.isPublic = attrs.isPublic;
          return { status: 204 };
        }
        if (req.method === 'DELETE') {
          this.beforeWrite(`delete ${id}`);
          this.playlists.delete(id);
          return { status: 204 };
        }
      }
      if (req.method === 'GET' && req.path === '/v1/me/library/playlists') {
        const ids = q.get('ids');
        const all = [...st.playlists].filter(([id]) => !ids || ids.split(',').includes(id)).map(([id, p]) => this.playlistResource(id, p));
        return page(all, req.path);
      }
      if (req.method === 'POST' && req.path === '/v1/me/library/playlists') {
        this.beforeWrite('create playlist');
        const body = req.body as { attributes: Record<string, unknown>; relationships?: { tracks?: { data: Array<{ id: string; type: string }> }; parent?: { data: Array<{ id: string }> } } };
        const id = `p.NEW${this.nextId++}`;
        const tracks = (body.relationships?.tracks?.data ?? []).map((d) => (d.type.startsWith('library-') ? { id: d.id, name: `Lib ${d.id}` } : { id: `i.C${d.id}`, name: `Cat ${d.id}`, catalogId: d.id }));
        this.addPlaylist(id, { name: String(body.attributes.name), tracks, ...(body.relationships?.parent ? { parent: body.relationships.parent.data[0]!.id } : {}) });
        return { status: 201, json: { data: [{ id, type: 'library-playlists', attributes: { name: body.attributes.name } }] } };
      }
      if ((m = /^\/v1\/me\/library\/playlist-folders\/([^/]+)\/children$/.exec(req.path)) && req.method === 'GET') {
        const fid = m[1]!;
        if (!st.folders.has(fid)) return { status: 404, json: { errors: [{ title: 'Resource Not Found' }] } };
        const kids: unknown[] = [
          ...[...st.folders]
            .filter(([id, f]) => id !== 'p.playlistsroot' && (f.parent ?? 'p.playlistsroot') === fid)
            .map(([id, f]) => ({ id, type: 'library-playlist-folders', attributes: { name: f.name, ...(f.dateAdded ? { dateAdded: f.dateAdded } : {}) } })),
          ...[...st.playlists].filter(([, p]) => (p.parent ?? 'p.playlistsroot') === fid).map(([id, p]) => this.playlistResource(id, p)),
        ];
        if (kids.length === 0) return { status: 404, json: { errors: [{ title: 'Resource Not Found' }] } };
        return page(kids, req.path);
      }
      if ((m = /^\/v1\/me\/library\/playlist-folders\/([^/]+)$/.exec(req.path)) && req.method === 'GET') {
        const f = st.folders.get(m[1]!);
        if (!f) return { status: 404, json: { errors: [{ title: 'Resource Not Found' }] } };
        return { json: { data: [{ id: m[1], type: 'library-playlist-folders', attributes: { name: f.name } }] } };
      }
      if (req.method === 'POST' && req.path === '/v1/me/library/playlist-folders') {
        this.beforeWrite('create folder');
        const body = req.body as { attributes: { name: string }; relationships: { parent: { data: Array<{ id: string }> } } };
        const id = `p.F${this.nextId++}`;
        const parent = body.relationships.parent.data[0]!.id;
        this.folders.set(id, { name: body.attributes.name, ...(parent !== 'p.playlistsroot' ? { parent } : {}) });
        return { status: 201, json: { data: [{ id, type: 'library-playlist-folders', attributes: { name: body.attributes.name } }], meta: { total: 1 } } };
      }
      if ((m = /^\/v1\/me\/ratings\/([^/]+)\/([^/]+)$/.exec(req.path))) {
        const key = `${m[1]}/${m[2]}`;
        if (req.method === 'GET') {
          const v = this.ratings.get(key);
          return v === undefined ? { status: 404, json: { errors: [{ title: 'Resource Not Found' }] } } : { json: { data: [{ id: m[2], type: 'ratings', attributes: { value: v } }] } };
        }
        this.beforeWrite(`rate ${key}`);
        if (req.method === 'PUT') {
          this.ratings.set(key, (req.body as { attributes: { value: number } }).attributes.value);
          return { json: { data: [{ id: m[2], type: 'ratings', attributes: { value: this.ratings.get(key) } }] } };
        }
        if (req.method === 'DELETE') {
          this.ratings.delete(key);
          return { status: 204 };
        }
      }
      if ((m = /^\/v1\/me\/ratings\/([^/]+)$/.exec(req.path)) && req.method === 'GET') {
        const ids = (q.get('ids') ?? '').split(',');
        const data = ids.filter((id) => this.ratings.has(`${m![1]}/${id}`)).map((id) => ({ id, type: 'ratings', attributes: { value: this.ratings.get(`${m![1]}/${id}`) } }));
        return data.length === 0 ? { status: 404, json: { errors: [{ title: 'Resource Not Found' }] } } : { json: { data } };
      }
      if ((m = /^\/v1\/me\/library\/(songs|albums|music-videos|playlists)$/.exec(req.path)) && req.method === 'GET' && q.get('ids')) {
        const bucket = this.items.get(m[1]!) ?? new Map();
        const data = (q.get('ids') ?? '').split(',').filter((id) => bucket.has(id)).map((id) => bucket.get(id));
        return data.length === 0 ? { status: 404, json: { errors: [{ title: 'Resource Not Found' }] } } : { json: { data } };
      }
      if ((m = /^\/v1\/me\/library\/(songs|albums|music-videos|playlists)\/([^/]+)$/.exec(req.path)) && req.method === 'DELETE') {
        this.beforeWrite(`library delete ${m[2]}`);
        this.items.get(m[1]!)?.delete(m[2]!);
        return { status: 204 };
      }
      return undefined;
    };
  }
}

// ---------------------------------------------------------------------------
// Tool capture
// ---------------------------------------------------------------------------

export interface CapturedTool {
  cfg: { description: string; inputSchema: { safeParse: (v: unknown) => { success: boolean } }; annotations: Record<string, unknown>; title?: string };
  cb: (args: Record<string, unknown>, ctx?: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

export function captureTools(client: MusicClient = new MusicClient()): Map<string, CapturedTool> {
  const tools = new Map<string, CapturedTool>();
  const server = { registerTool: (name: string, cfg: CapturedTool['cfg'], cb: CapturedTool['cb']) => tools.set(name, { cfg, cb }) } as unknown as McpServer;
  registerMusicTools(server, { client });
  return tools;
}

export async function callTool(tools: Map<string, CapturedTool>, name: string, args: Record<string, unknown>, ctx: unknown = {}): Promise<{ data: Record<string, unknown>; isError: boolean; text: string }> {
  const t = tools.get(name);
  if (!t) throw new Error(`tool ${name} not registered`);
  const r = await t.cb(args, ctx);
  const text = r.content[0]!.text;
  return { data: JSON.parse(text) as Record<string, unknown>, isError: r.isError === true, text };
}
