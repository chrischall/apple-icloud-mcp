import { stateRevision } from '../tools/_confirm.js';

/**
 * What this process last wrote to each library playlist, for a short while.
 *
 * Apple's library reads lag its writes (seconds, sometimes longer), and every
 * playlist REWRITE (reorder, remove tracks) is computed from a fresh read and
 * replaces the whole list. A rewrite computed from a read that does not show
 * this process's previous change yet would silently undo it: a dedupe then a
 * sort brings the duplicates back; an add then a sort drops the new tracks.
 * So each write records the order it replaced, and a rewrite whose fresh read
 * still shows exactly that order within PLAYLIST_WRITE_TTL_MS is refused
 * rather than rebuilt from the stale list.
 *
 * In memory only, on the MusicClient: a hosted child serves one person, and a
 * caller that outlives the process chains with `expectedRevision` instead.
 */

export const PLAYLIST_WRITE_TTL_MS = 2 * 60 * 1000;

export interface PlaylistWrite {
  /** When the write was sent (client clock). */
  at: number;
  /** What it was, for the refusal ("reorder (dedupe)", "remove tracks", "add tracks"). */
  what: string;
  /** Revision of the track order the write replaced. */
  before: string;
}

export class PlaylistWriteLog {
  private readonly entries = new Map<string, PlaylistWrite>();

  record(playlistId: string, write: PlaylistWrite): void {
    this.entries.set(playlistId, write);
  }

  /** The recent write that a read at `revision` does not show yet (the read is still the pre-write order). */
  pending(playlistId: string, revision: string, now: number): PlaylistWrite | undefined {
    const w = this.entries.get(playlistId);
    if (!w) return undefined;
    if (now - w.at > PLAYLIST_WRITE_TTL_MS) {
      this.entries.delete(playlistId);
      return undefined;
    }
    return revision === w.before ? w : undefined;
  }
}

/** The revision of a track order — what apple_music_get_playlist returns and `expectedRevision` takes. */
export function trackRevision(tracks: readonly { id: string }[]): string {
  return stateRevision(tracks.map((t) => t.id));
}
