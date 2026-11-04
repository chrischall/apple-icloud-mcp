import { afterEach, describe, expect, it } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { REGISTRARS } from '../src/registry.js';

/**
 * Context-group hints (`_meta.mint`, the mcp-host context-groups contract),
 * read off `tools/list` — what a host sees — in the mode that registers every
 * tool (an empty environment: every service, APPLE_WRITE_MODE default).
 */

interface Listed {
  name: string;
  inputSchema: { properties?: Record<string, { enum?: unknown[] }> };
  annotations?: { readOnlyHint?: boolean };
  _meta?: { mint?: Record<string, unknown> };
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function served(): Promise<Listed[]> {
  const h = await createTestHarness((server) => {
    for (const register of REGISTRARS) register(server);
  });
  close = h.close;
  const { tools } = await h.client.listTools();
  return tools as unknown as Listed[];
}

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];

/** The intent every tool declares — this table is the assertion, so a new tool cannot skip the decision. */
const EXPECTED_INTENT: Record<string, string> = {
  // Apple Music — reads look things up; every write changes the library.
  apple_music_list_playlists: 'lookup',
  apple_music_get_playlist: 'lookup',
  apple_music_list_folders: 'lookup',
  apple_music_search_library: 'lookup',
  apple_music_list_library: 'lookup',
  apple_music_get_history: 'lookup',
  apple_music_get_recommendations: 'lookup',
  apple_music_get_replay: 'lookup',
  apple_music_get_ratings: 'lookup',
  apple_music_search_catalog: 'lookup',
  apple_music_get_catalog_items: 'lookup',
  apple_music_get_charts: 'lookup',
  apple_music_create_playlist: 'change',
  apple_music_add_playlist_tracks: 'change',
  apple_music_create_folder: 'change',
  apple_music_add_to_library: 'change',
  apple_music_add_favorites: 'change',
  apple_music_set_rating: 'change',
  apple_music_update_playlist: 'change',
  apple_music_remove_playlist_tracks: 'change',
  apple_music_reorder_playlist: 'change',
  apple_music_move_playlist: 'change',
  apple_music_delete_playlist: 'change',
  apple_music_remove_from_library: 'change',
  apple_music_remove_favorites: 'change',
  // iCloud Calendar — the event list is the one "what's on" answer.
  apple_calendar_list_calendars: 'lookup',
  apple_calendar_list_events: 'whats-on',
  apple_calendar_search_events: 'lookup',
  apple_calendar_get_event: 'lookup',
  apple_calendar_find_free_time: 'lookup',
  apple_calendar_create_event: 'change',
  apple_calendar_update_event: 'change',
  apple_calendar_delete_event: 'change',
  // iCloud Contacts
  apple_contacts_search: 'lookup',
  apple_contacts_get: 'lookup',
  apple_contacts_list_groups: 'lookup',
  apple_contacts_create: 'change',
  apple_contacts_update: 'change',
  apple_contacts_delete: 'change',
  // iCloud Mail
  apple_mail_list_mailboxes: 'lookup',
  apple_mail_search: 'lookup',
  apple_mail_get_message: 'lookup',
  apple_mail_download_attachment: 'other',
  apple_mail_send: 'send',
  apple_mail_update_flags: 'change',
  apple_mail_move: 'change',
  // Apple Maps
  apple_maps_geocode: 'lookup',
  apple_maps_reverse_geocode: 'lookup',
  apple_maps_search: 'lookup',
  apple_maps_directions: 'lookup',
  apple_maps_etas: 'lookup',
  apple_maps_lookup_place: 'lookup',
  apple_maps_snapshot_url: 'other',
  // WeatherKit
  apple_weather_get: 'lookup',
  apple_weather_get_alert: 'lookup',
  // iTunes Search
  apple_itunes_search: 'lookup',
  apple_itunes_lookup: 'lookup',
  apple_charts_get: 'lookup',
};

describe('_meta.mint on every served tool', () => {
  it('names every served tool except the healthcheck, so a new tool cannot skip the decision', async () => {
    const names = (await served()).map((t) => t.name).filter((n) => n !== 'apple_healthcheck');
    expect(names.sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
  });

  it('leaves apple_healthcheck unhinted (it joins no group)', async () => {
    const hc = (await served()).find((t) => t.name === 'apple_healthcheck');
    expect(hc).toBeDefined();
    expect(hc?._meta?.mint).toBeUndefined();
  });

  it('every other tool declares domain family and its intent', async () => {
    for (const t of await served()) {
      if (t.name === 'apple_healthcheck') continue;
      const mint = t._meta?.mint;
      expect(mint, t.name).toBeDefined();
      expect(mint!.domain, t.name).toBe('family');
      expect(mint!.intent, t.name).toBe(EXPECTED_INTENT[t.name]);
    }
  });

  it('every hint is shaped per the host contract', async () => {
    for (const t of await served()) {
      const mint = t._meta?.mint;
      if (!mint) continue;
      expect(Object.keys(mint).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(mint.domain);
      expect(INTENTS, t.name).toContain(mint.intent);
      const props = t.inputSchema.properties ?? {};
      if ('canonical' in mint) {
        expect(mint.canonical, t.name).toBe(true);
        expect(t.annotations?.readOnlyHint, `${t.name} is canonical, so it must be a read`).toBe(true);
        expect(['whats-new', 'whats-due', 'whats-on'], t.name).toContain(mint.intent);
      }
      if ('subject' in mint) expect(props, t.name).toHaveProperty(mint.subject as string);
      if ('when' in mint) {
        const when = mint.when as Record<string, unknown>;
        expect(Object.keys(when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(when.start as string);
        expect(props, t.name).toHaveProperty(when.end as string);
      }
      if ('aliases' in mint) {
        const aliases = mint.aliases as string[];
        expect(aliases.length, t.name).toBeGreaterThan(0);
        expect(aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
        }
      }
    }
  });

  it('marks exactly one tool canonical: the calendar event list, for whats-on', async () => {
    const canonical = (await served())
      .filter((t) => t._meta?.mint?.canonical === true)
      .map((t) => [t.name, t._meta!.mint!.intent]);
    expect(canonical).toEqual([['apple_calendar_list_events', 'whats-on']]);
  });

  it('the event list names its range arguments, no subject, and offers view: brief', async () => {
    const t = (await served()).find((x) => x.name === 'apple_calendar_list_events')!;
    expect(t._meta?.mint).toEqual({
      domain: 'family',
      intent: 'whats-on',
      canonical: true,
      when: { start: 'fromDate', end: 'toDate' },
      aliases: ['calendar', 'schedule', 'appointments', 'events', 'plans', 'busy'],
    });
    expect(t.inputSchema.properties?.view?.enum).toEqual(['compact', 'full', 'brief']);
  });

  it('search keeps its own views — brief is the canonical read\'s alone', async () => {
    const t = (await served()).find((x) => x.name === 'apple_calendar_search_events')!;
    expect(t.inputSchema.properties?.view?.enum).toEqual(['compact', 'full']);
  });
});
