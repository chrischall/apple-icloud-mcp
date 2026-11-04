/**
 * `_meta.mint` hints — the mcp-host context-groups contract. Inert data to
 * any other client: which group a tool belongs to (this server is "family":
 * the household's calendar, contacts, mail, music and weather), what kind of
 * ask it answers, the argument names a host fills for a range, and words a
 * person says that the tool's name and description lack.
 *
 * The shape is the host's contract (core `mintHintSchema`), so it is restated
 * here rather than imported — this server does not depend on the host.
 */

export type MintIntent = 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'family';
  intent: MintIntent;
  /** Only on a read (`readOnlyHint: true`) answering whats-new / whats-due / whats-on; at most one per intent. */
  canonical?: true;
  /** The argument taking the person's subject. This server publishes none: it has no listable set of subjects. */
  subject?: string;
  /** Argument names for the range a host asks about. */
  when?: { start: string; end: string };
  /** ≤ 8, each ≤ 40 characters, lowercase: words a person says, not tool names. */
  aliases?: string[];
}

/** A family-group hint for `intent`, with any extra fields. */
export function familyHint(intent: MintIntent, extra: Omit<MintHint, 'domain' | 'intent'> = {}): MintHint {
  return { domain: 'family', intent, ...extra };
}

export const MUSIC_ALIASES = ['music', 'songs', 'playlist', 'album', 'artist'];
export const CALENDAR_ALIASES = ['calendar', 'event', 'appointment', 'meeting'];
export const CONTACTS_ALIASES = ['contact', 'phone number', 'address book', 'email address'];
export const MAIL_ALIASES = ['email', 'mail', 'inbox'];
export const MAPS_ALIASES = ['directions', 'map', 'how far', 'drive', 'nearby'];
export const WEATHER_ALIASES = ['weather', 'forecast', 'rain', 'temperature'];
export const ITUNES_ALIASES = ['podcast', 'app store', 'itunes', 'charts'];
