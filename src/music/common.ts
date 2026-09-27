import { resolveView, viewParam, type View } from '@chrischall/mcp-utils';
import { z } from 'zod';
import { MusicClient, type MusicSession } from './client.js';
import { isRecord } from './project.js';
import type { HttpFn } from './web-token.js';

/** Test seams for the Apple Music tools; every member is optional (runMcp passes nothing). */
export interface MusicDeps {
  /** A ready client (tests); otherwise one is built lazily. */
  client?: MusicClient;
  /** Replaces `httpRequest` for a lazily-built client. */
  http?: HttpFn;
  /** Clock for a lazily-built client. */
  now?: () => number;
}

let defaultClient: MusicClient | undefined;

/** The process-wide client (lazily built; no I/O at construction). */
export function defaultMusicClient(): MusicClient {
  defaultClient ??= new MusicClient();
  return defaultClient;
}

/** Test seam: drop the process-wide client and its caches. */
export function resetDefaultMusicClient(): void {
  defaultClient = undefined;
}

/** How a registrar gets its client: injected, built from injected parts, or the shared default. */
export function clientGetter(deps?: MusicDeps): () => MusicClient {
  if (deps?.client) {
    const c = deps.client;
    return () => c;
  }
  if (deps?.http || deps?.now) {
    let c: MusicClient | undefined;
    return () => (c ??= new MusicClient({ ...(deps.http ? { http: deps.http } : {}), ...(deps.now ? { now: deps.now } : {}) }));
  }
  return defaultMusicClient;
}

export const MUSIC_VIEWS = ['compact', 'full'] as const satisfies readonly View[];

export function musicViewParam(note?: string) {
  return viewParam(MUSIC_VIEWS, {
    note:
      note ??
      'compact keeps ids (library and catalog), names, artist/album, duration, dates and flags; full is Apple\'s record verbatim (artwork, previews, playParams).',
  });
}

export function viewOf(value: string | undefined): View {
  return resolveView(value, MUSIC_VIEWS);
}

export const storefrontParam = z
  .string()
  .regex(/^[A-Za-z]{2}$/, 'a two-letter storefront code')
  .optional()
  .describe("Two-letter Apple Music storefront (country catalog), e.g. us, gb, jp. Default: APPLE_MUSIC_STOREFRONT, else your account's storefront, else us.");

/** `{backend}` plus any fallback notes, for the head of a response. */
export function head(s: MusicSession, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { backend: s.backend.name, ...extra };
}

/** Attach `notes` only when there are some. */
export function notesField(notes: Array<string | undefined>): { notes?: string[] } {
  const list = notes.filter((n): n is string => typeof n === 'string' && n.length > 0);
  return list.length > 0 ? { notes: list } : {};
}

export function uniq<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Prefix each projected track with its 1-based absolute position (a non-record from a raw fallback passes through). */
export function withPositions(list: unknown[], offset: number): unknown[] {
  return list.map((t, i) => (isRecord(t) ? { position: offset + i + 1, ...t } : t));
}
