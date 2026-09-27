import { stateRevision } from '../tools/_confirm.js';
import type { TrackRef } from './ids.js';
import { catalogIdOf, type AppleResource } from './project.js';

/**
 * What this process wrote to each library playlist recently.
 *
 * Apple's library reads lag its writes (seconds, sometimes longer), and every
 * playlist REWRITE (reorder, remove tracks) is computed from a fresh read and
 * replaces the whole list. A rewrite computed from a read that does not show
 * this process's earlier changes yet would silently undo them: a dedupe then a
 * sort brings the duplicates back; an add then a sort drops the new tracks.
 *
 * So EVERY write within PLAYLIST_WRITE_TTL_MS is kept (not only the latest —
 * two quick adds, or a remove then an add, each need checking), and a read is
 * "behind" when it fails to show any of them:
 *  - a rewrite records the order it replaced; a read that is still exactly
 *    that order does not show it;
 *  - an append (or a create with tracks) records what the read must contain
 *    once it shows: at least N copies of each track it added. It never records
 *    "the order before" — the append's own read may already be stale.
 * A rewrite that goes through was checked against every earlier entry (its
 * read showed them all), so it supersedes them; an UNCONFIRMED one is added
 * alongside instead, since it may not have landed.
 *
 * In memory only, on the MusicClient: a hosted child serves one person, and a
 * caller that outlives the process chains with `expectedRevision` instead.
 */

export const PLAYLIST_WRITE_TTL_MS = 2 * 60 * 1000;

export type PlaylistWrite = {
  /** When the write was sent (client clock). */
  at: number;
  /** What it was, for the refusal ("reorder (dedupe)", "remove tracks", "add tracks", "create playlist with 150 tracks"). */
  what: string;
} & (
  | {
      /** Revision of the track order the write replaced. */
      before: string;
    }
  | {
      /** Track key (see trackKeys) → the fewest copies a read that shows the write lists. */
      expects: Record<string, number>;
    }
);

type Entry = PlaylistWrite & { seq: number };

/** The keys a track in a read answers to: its library id, and its catalog id when Apple reports one. */
function trackKeys(t: AppleResource): string[] {
  const catalog = catalogIdOf(t);
  return catalog !== undefined ? [`lib:${t.id}`, `cat:${catalog}`] : [`lib:${t.id}`];
}

/** The key an appended reference shows up under: a library id as itself, a catalog id as the track's catalog id. */
function refKey(ref: TrackRef): string {
  return ref.type.startsWith('library-') ? `lib:${ref.id}` : `cat:${ref.id}`;
}

function keyCounts(tracks: readonly AppleResource[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tracks) for (const k of trackKeys(t)) counts.set(k, (counts.get(k) ?? 0) + 1);
  return counts;
}

export class PlaylistWriteLog {
  private readonly entries = new Map<string, Entry[]>();
  private seq = 0;

  /** The entries still within the TTL (older ones are dropped). */
  private live(playlistId: string, now: number): Entry[] {
    const kept = (this.entries.get(playlistId) ?? []).filter((w) => now - w.at <= PLAYLIST_WRITE_TTL_MS);
    if (kept.length > 0) this.entries.set(playlistId, kept);
    else this.entries.delete(playlistId);
    return kept;
  }

  /**
   * A position in the log. Take it in the same synchronous step as the
   * `pending()` check a rewrite passed, and hand it to `recordRewrite`: the
   * entries up to it are the ones that read was shown to include.
   */
  mark(): number {
    return this.seq;
  }

  /**
   * Record a write that replaced the order `before` (a revision). With
   * `supersedes` (a `mark()` taken when its read passed `pending()`), the
   * entries up to that mark are dropped: the read showed them, and the rewrite
   * replaced the whole list. Without it (an unconfirmed write) they stay.
   */
  recordRewrite(playlistId: string, write: { at: number; what: string; before: string }, supersedes?: number): void {
    const kept = (this.entries.get(playlistId) ?? []).filter((w) => supersedes === undefined || w.seq > supersedes);
    this.entries.set(playlistId, [...kept, { ...write, seq: ++this.seq }]);
  }

  /**
   * Record an append of `added` (the references that landed, or may have).
   * The copies a later read must show are counted from the best lower bound
   * known: the append's own read (`read`, empty for a new playlist) or what an
   * earlier live append already expects, whichever is higher — then plus the
   * copies this append added.
   */
  recordAppend(playlistId: string, write: { at: number; what: string }, read: readonly AppleResource[], added: readonly TrackRef[], now: number): void {
    if (added.length === 0) return;
    const live = this.live(playlistId, now);
    const counts = keyCounts(read);
    const expects: Record<string, number> = {};
    for (const ref of added) {
      const k = refKey(ref);
      if (expects[k] === undefined) {
        const earlier = live.map((w) => ('expects' in w ? (w.expects[k] ?? 0) : 0));
        expects[k] = Math.max(counts.get(k) ?? 0, ...earlier);
      }
      expects[k] += 1;
    }
    this.entries.set(playlistId, [...live, { ...write, expects, seq: ++this.seq }]);
  }

  /** The (oldest) recent write that a read of `tracks` does not show yet. */
  pending(playlistId: string, tracks: readonly AppleResource[], now: number): PlaylistWrite | undefined {
    const live = this.live(playlistId, now);
    if (live.length === 0) return undefined;
    const revision = trackRevision(tracks);
    const counts = keyCounts(tracks);
    const behind = live.find((w) =>
      'before' in w ? revision === w.before : Object.entries(w.expects).some(([k, n]) => (counts.get(k) ?? 0) < n),
    );
    if (!behind) return undefined;
    const { seq, ...write } = behind;
    void seq;
    return write;
  }
}

/**
 * The ids of `added` that `after` does not show: each track key must appear at
 * least as often as it did in `before` plus the copies appended. (A count that
 * merely matches can be another write's track showing instead of this one.)
 */
export function unshownAppends(before: readonly AppleResource[], added: readonly TrackRef[], after: readonly AppleResource[]): string[] {
  const was = keyCounts(before);
  const now = keyCounts(after);
  const want = new Map<string, number>();
  for (const ref of added) {
    const k = refKey(ref);
    want.set(k, (want.get(k) ?? was.get(k) ?? 0) + 1);
  }
  // Keys are `lib:<id>` / `cat:<id>`: the id is what follows the 4-character prefix.
  return [...want].filter(([k, n]) => (now.get(k) ?? 0) < n).map(([k]) => k.slice(4));
}

/** The revision of a track order — what apple_music_get_playlist returns and `expectedRevision` takes. */
export function trackRevision(tracks: readonly { id: string }[]): string {
  return stateRevision(tracks.map((t) => t.id));
}

// ---------------------------------------------------------------------------
// Playlist attributes (name / description / isPublic)
// ---------------------------------------------------------------------------

export type PlaylistAttributes = { name?: string; description?: string; isPublic?: boolean };
type AttributeKey = keyof PlaylistAttributes;

export interface PendingAttribute {
  field: AttributeKey;
  /** What this process last set it to. */
  value: string | boolean;
  /** What the read shows instead. */
  reads: string | boolean | undefined;
  at: number;
  what: string;
}

/**
 * What this process last set each playlist attribute to, for
 * PLAYLIST_WRITE_TTL_MS. `apple_music_update_playlist` sends the complete set
 * {name, description, isPublic} back (as Apple's web player does), built from a
 * fresh read — so a read that does not show a change made moments ago would
 * PATCH the old value back: a rename undone, a playlist made private published
 * again. Such a read is refused rather than merged over (an overlay could mask
 * a change made elsewhere since).
 */
export class PlaylistAttributeLog {
  private readonly entries = new Map<string, Map<AttributeKey, { value: string | boolean; at: number; what: string }>>();

  record(playlistId: string, write: { at: number; what: string }, attributes: PlaylistAttributes): void {
    const fields = this.entries.get(playlistId) ?? new Map<AttributeKey, { value: string | boolean; at: number; what: string }>();
    for (const [k, v] of Object.entries(attributes) as Array<[AttributeKey, string | boolean | undefined]>) {
      if (v !== undefined) fields.set(k, { value: v, ...write });
    }
    this.entries.set(playlistId, fields);
  }

  /**
   * The recorded values a read (`playlistFields` of a fresh GET) does not show
   * yet. A field the read does not report at all cannot be compared and is not
   * pending (it is not sent back either); a description reads as "" when absent.
   */
  pending(playlistId: string, read: PlaylistAttributes, now: number): PendingAttribute[] {
    const fields = this.entries.get(playlistId);
    if (!fields) return [];
    const out: PendingAttribute[] = [];
    for (const [field, w] of [...fields]) {
      if (now - w.at > PLAYLIST_WRITE_TTL_MS) {
        fields.delete(field);
        continue;
      }
      const reads = field === 'description' ? (read.description ?? '') : read[field];
      if (reads !== undefined && reads !== w.value) out.push({ field, value: w.value, reads, at: w.at, what: w.what });
    }
    if (fields.size === 0) this.entries.delete(playlistId);
    return out;
  }
}
