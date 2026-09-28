# apple-icloud-mcp

[![CI](https://github.com/chrischall/apple-icloud-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/chrischall/apple-icloud-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/apple-icloud-mcp)](https://www.npmjs.com/package/apple-icloud-mcp)
[![license](https://img.shields.io/npm/l/apple-icloud-mcp)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server that connects Claude to **Apple's web
services**: Apple Music (your playlists, library and the catalog), iCloud Calendar, Contacts and Mail,
Apple Maps, WeatherKit, and the iTunes Search API.

It talks to Apple over the network through Apple's own web APIs and standard protocols (CalDAV, CardDAV,
IMAP/SMTP), so — unlike Mac-only Apple integrations such as
[apple-swift-mcp](https://github.com/chrischall/apple-swift-mcp) — it runs anywhere: Linux, Windows, a
container, or hosted on [mcp-host](#running-on-mcp-host) as a claude.ai connector. The two complement each other:
`apple-swift-mcp` drives the Mac's own apps (Calendar, Reminders, Contacts, Mail, Messages, Notes, Photos, Maps,
and Music.app playlists), while `apple-icloud-mcp` reaches Apple's web services from anywhere and adds the Apple
Music catalog, WeatherKit and iTunes.

> [!NOTE]
> **Unofficial.** This project is not affiliated with, endorsed by or sponsored by Apple Inc. Apple, iCloud,
> Apple Music, Apple Maps and WeatherKit are trademarks of Apple Inc., used here only to name the services it
> connects to.

> [!WARNING]
> **AI-developed project.** This codebase was entirely built and is actively maintained by
> [Claude Code](https://www.anthropic.com/claude). No human has audited the implementation. Review all code
> and tool permissions before use.

> [!IMPORTANT]
> **Not yet verified against a live Apple account.** Every request shape comes from Apple's documentation or
> Apple's own web client and is covered by tests against faithful fakes, but the build environment had no
> Apple credentials. The first real run is the real verification — run `apple_healthcheck` first, and see
> [docs/APPLE-API.md](docs/APPLE-API.md) for what each call relies on.

## What you can do

- *"Make a playlist called Road Trip 2026 with twenty upbeat 80s songs"*
- *"Add the top 5 songs from Taylor Swift's latest album to my Workout playlist"*
- *"Remove duplicates from my Chill playlist and sort it by artist"* (web-player mode)
- *"What have I been listening to on heavy rotation?"* / *"Show my Apple Music Replay for this year"*
- *"What's on my calendar next week?"* / *"Find me a free hour on Thursday afternoon"*
- *"Move my dentist appointment to Friday at 3pm"*
- *"What's Jane's phone number?"* / *"Add Bob Lee from Acme with bob@acme.com to my contacts"*
- *"Any unread email from my landlord?"* / *"Reply to the last message from Sam saying I'll be there"*
- *"How long will it take to drive to the airport at 5pm?"* / *"Coffee shops near Union Square"*
- *"Will it rain in Chicago tomorrow?"*
- *"Find the podcast Hard Fork and list its latest episodes"* / *"What are the top albums in the UK right now?"*

## Services and what each needs

Every service is optional: each one switches on when its credentials are present, and
[`apple_healthcheck`](#troubleshooting) tells you which are working.

| Service | What you get | Credential | Cost |
|---|---|---|---|
| **Apple Music** (official API) | Catalog search, charts, your library, playlists (create, add tracks, folders), history, recommendations, Replay, ratings, favorites | Apple Developer key **+** a Music User Token | Apple Developer Program ($99/yr) + Apple Music subscription |
| **Apple Music** (web-player mode, opt-in, unofficial) | Everything above **plus** rename/delete playlists, remove/reorder/sort/dedupe tracks, move to folders, remove from library | The `media-user-token` cookie from music.apple.com | Apple Music subscription only |
| **iCloud Calendar** (CalDAV) | List/search events (recurring ones expanded), create/update/delete with correct time zones and recurrence, free-time finder | Apple ID + **app-specific password** | Free |
| **iCloud Contacts** (CardDAV) | Search, read, create, update (per-email/phone edits), delete, groups | Apple ID + app-specific password | Free |
| **iCloud Mail** (IMAP/SMTP) | List mailboxes, search, read (without marking read), send and reply, flag, move | Apple ID + app-specific password | Free |
| **Apple Maps** (Maps Server API) | Geocode, reverse geocode, place search, directions, ETAs, signed map-image URLs | Apple Developer key | Free up to 25,000 calls/day |
| **WeatherKit** | Current conditions, hourly/daily forecast, next-hour precipitation, severe-weather alerts | Apple Developer key + Services ID | Free up to 500,000 calls/month |
| **iTunes Search + charts** | Search/lookup songs, albums, podcasts (with episodes), apps, books, audiobooks; top charts | None | Free |

## Requirements

- Node.js 22 or later (the hosted runner uses Node 26).
- Whatever the services you want need (table above).

## Acknowledgement of Terms

By using this MCP server, you acknowledge and agree to the following:

**1. It accesses your own Apple accounts only**, with credentials you supply. It cannot reach anyone else's
data, and on a shared deployment each person's Apple ID stays in their own process.

**2. Apple's terms govern your use**, just as they govern your direct use of Apple's services — in
particular the [Apple Media Services Terms](https://www.apple.com/legal/internet-services/itunes/), the
[iCloud Terms and Conditions](https://www.apple.com/legal/internet-services/icloud/) and, for the developer-key
services, the [Apple Developer Program License Agreement](https://developer.apple.com/support/terms/). The
iCloud Terms say you may not *"interfere with or disrupt the Service (including accessing the Service through
any automated means, like scripts or web crawlers)"*. The iCloud paths here use the mechanism Apple provides
for third-party apps — app-specific passwords over CalDAV, CardDAV and IMAP/SMTP — at the pace of a person
using an assistant. **Apple Music web-player mode is different**: it uses Apple's private web-player API with
your browser session, which Apple has said may be blocked at any time. It is off unless you turn it on.
Terms read by the maintainer 2026-09-26.

**3. Personal use only.** This project is not affiliated with, endorsed by, or sponsored by Apple Inc.
"Apple", "Apple Music", "iCloud" and related marks are Apple's. Do not share your credentials, and do not use
this to bulk-extract data.

**4. Writes are real.** Creating a calendar event with attendees makes iCloud email them invitations; sending
mail sends it; deleting a playlist or contact deletes it. Those actions ask for confirmation first (see
[Confirmation](#confirmation-mcp_confirm_mode)), and [`APPLE_WRITE_MODE`](#write-protection-apple_write_mode)
can remove write tools entirely.

**5. You accept full responsibility** for the consequences, technical (rate limits, a locked account after
repeated failed sign-ins) and otherwise.

This is the maintainer's good-faith summary, not legal advice, and it does not modify or supersede Apple's
actual terms.

## Installation

### Claude Code

```bash
claude mcp add apple -- npx -y apple-icloud-mcp
```

then set the variables for the services you want (see [Setting up credentials](#setting-up-credentials)) in
the server's `env`, for example in `.mcp.json`:

```json
{
  "mcpServers": {
    "apple": {
      "command": "npx",
      "args": ["-y", "apple-icloud-mcp"],
      "env": {
        "ICLOUD_USERNAME": "you@icloud.com",
        "ICLOUD_APP_PASSWORD": "abcd-efgh-ijkl-mnop",
        "DISPLAY_TZ": "America/New_York"
      }
    }
  }
}
```

### Claude Desktop

Install the `.mcpb` bundle from the [latest release](https://github.com/chrischall/apple-icloud-mcp/releases) and fill
in the settings it asks for, or add the same `npx` entry to `claude_desktop_config.json`.

### From source

```bash
git clone https://github.com/chrischall/apple-icloud-mcp.git && cd apple-icloud-mcp
npm install && npm run build
cp .env.example .env   # fill in what you need
npm run dev
```

## Setting up credentials

### iCloud Calendar, Contacts and Mail — an app-specific password

1. Sign in at [appleid.apple.com](https://appleid.apple.com) → **Sign-In and Security** → **App-Specific
   Passwords** → generate one (two-factor authentication must be on).
2. Set `ICLOUD_USERNAME` (your Apple ID email) and `ICLOUD_APP_PASSWORD` (the `xxxx-xxxx-xxxx-xxxx`
   password). Your normal Apple ID password does **not** work here.
3. If your Apple ID is not an `@icloud.com` / `@me.com` address, also set `ICLOUD_MAIL_ADDRESS` to your iCloud
   Mail address (Mail only).

Changing your Apple ID password revokes every app-specific password — the usual reason a working setup
suddenly returns "credentials rejected". After a definitive rejection the server stops sending that password —
for 24 hours or until you change it, across restarts too (it records a digest of the rejected pair, never the
password) — because repeated failed sign-ins can lock an Apple ID.

**Reminders are not available**: since iOS 13, iCloud Reminders no longer sync over CalDAV (see
[Not supported](#not-supported-and-why)).

### Apple Developer key — Apple Music (official), Apple Maps, WeatherKit

These three need a paid [Apple Developer Program](https://developer.apple.com/programs/) membership.

1. In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list),
   create the identifiers for the services you want: a **Media ID** (Apple Music), a **Maps ID** (Apple Maps),
   and a **Services ID** for WeatherKit.
2. Under **Keys**, create a key and tick **Media Services (MusicKit)**, **MapKit JS** and/or **WeatherKit**.
   One key can carry all three. Download the `.p8` (you only get one chance).
3. Set `APPLE_TEAM_ID`, `APPLE_KEY_ID` and `APPLE_PRIVATE_KEY` (the `.p8` contents — multi-line PEM, a
   one-line value with `\n` escapes, or base64 all work). For WeatherKit also set
   `APPLE_WEATHERKIT_SERVICE_ID`. Separate keys per service are supported with `APPLE_MUSIC_KEY_ID` /
   `APPLE_MUSIC_PRIVATE_KEY`, `APPLE_MAPS_…` and `APPLE_WEATHERKIT_…`.

The server signs short-lived tokens itself (12 hours for Apple Music, 1 hour for Maps and WeatherKit).

### Apple Music — your library (official API): a Music User Token

Catalog search works with the developer key alone. Your library and playlists also need a **Music User
Token**, which Apple only issues through an interactive MusicKit sign-in in a browser. With the developer key
set, run:

```bash
npx apple-icloud-mcp music-auth
```

It opens a page on `127.0.0.1`, you click **Sign in with Apple Music**, and it prints
`APPLE_MUSIC_USER_TOKEN=…`. Put that value in `APPLE_MUSIC_USER_TOKEN`. It lasts about six months, is tied to
the developer key that minted it, and changing your Apple ID password revokes it.

**Someone without the developer key** (another person on a shared deployment) never needs the `.p8`. The key's
owner runs `npx apple-icloud-mcp music-auth --print-developer-token --days 7` and sends them the short-lived
token it prints; they run `APPLE_MUSIC_DEVELOPER_TOKEN=<that token> npx apple-icloud-mcp music-auth` on their
own machine, sign in, and keep the user token it prints. The developer token expires on its own; the user token
keeps working with the server's key.

### Apple Music — web-player mode (opt-in, unofficial)

Apple's official API cannot rename or delete playlists, remove or reorder tracks, or remove anything from your
library. Apple's own web player can. Web-player mode uses that same private API with your browser session:

1. Sign in at [music.apple.com](https://music.apple.com) in a desktop browser.
2. Open the developer tools → **Application/Storage** → **Cookies** → `https://music.apple.com` and copy the
   value of the **`media-user-token`** cookie.
3. Set it as `APPLE_MUSIC_WEB_USER_TOKEN`.

The web player's own developer token is read from music.apple.com automatically (and cached). This mode also
works with **no** Apple Developer account. It is unsupported by Apple and may stop working without notice; the
tools that need it say so in their descriptions, and their answers report which backend (`official` or `web`)
served them.

> [!TIP]
> **On a Mac, you may not need web-player mode at all.** [apple-swift-mcp](https://github.com/chrischall/apple-swift-mcp)
> makes the same playlist edits — rename, delete, remove, reorder, sort, dedupe, move into folders — in the local
> Music.app library through Music's own scripting, with no tokens or developer account. It works on songs already in
> your library, so a catalog song still needs adding first (`apple_music_add_to_library` here).

## Running on mcp-host

The package ships a [`mint.yaml`](mint.yaml) that mcp-host reads when you register `apple-icloud-mcp`:

- **Owner settings** (the developer key, `APPLE_WRITE_MODE`, `APPLE_SERVICES`, `MCP_CONFIRM_SECRET`, …) go in
  the registration's environment — store the private key and confirm secret as secrets.
- **Everything personal** (Apple ID, app-specific password, Music tokens, iCloud Mail address, time zone,
  default calendar, Apple Music storefront) is declared as `auth.fields`, so mcp-host asks each person when they
  connect and remembers the answers per person; each caller gets their own process and data directory.
- **State**: `dataDir` holds a few small files (see [Security](#security)) that keep a scale-to-zero cold start
  cheap and stop a revoked password or a spent confirmation token from being reused after a restart.
- **Egress**: only the Apple hosts this server calls (`api.music.apple.com`, `amp-api.music.apple.com`,
  `music.apple.com`, `caldav.icloud.com`, `contacts.icloud.com`, `*.icloud.com`, `imap.mail.me.com`,
  `smtp.mail.me.com`, `maps-api.apple.com`, `weatherkit.apple.com`, `itunes.apple.com`,
  `rss.marketingtools.apple.com`). HTTPS goes through the runner's proxy via Node's built-in fetch; IMAP and
  SMTP are tunnelled through the same proxy with HTTP CONNECT.

Give it your time zone (`DISPLAY_TZ`): the runner is on UTC, and times you give without an offset ("3pm") are
read in `DISPLAY_TZ` — so are calendar events stored without a time zone of their own ("floating"), whatever
`timeZone` a call passes. Set **`MCP_CONFIRM_SECRET`** too: without it, a confirmation token issued just before the
child restarts (a redeploy, a machine move) stops working and you have to preview again. Spent tokens are
recorded on disk, so a shared secret does not let one be replayed.

## Tools

<!-- TOOLS:START -->
58 tools. **Mode** is the lowest [`APPLE_WRITE_MODE`](#write-protection-apple_write_mode) that registers the tool; **Confirm** marks tools that ask first ([details](#confirmation-mcp_confirm_mode)); 🌐 marks Apple Music tools that need [web-player mode](#apple-music--web-player-mode-opt-in-unofficial).

### Health

| Tool | What it does | Mode | Confirm |
|---|---|---|---|
| `apple_healthcheck` | Check which Apple services (Apple Music, iCloud Calendar, Contacts, Mail, Apple Maps, WeatherKit, iTunes) are configured and reachable. | read |  |

### Apple Music

| Tool | What it does | Mode | Confirm |
|---|---|---|---|
| `apple_music_search_catalog` | Search Apple Music's catalog by text for songs, albums, artists, playlists, music videos or stations. | read |  |
| `apple_music_get_catalog_items` | Look up Apple Music catalog songs, albums, artists, playlists, music videos or stations by id — or songs/music videos by ISRC, albums by UPC. | read |  |
| `apple_music_get_charts` | Get Apple Music's top charts (most played songs, albums, playlists, music videos) for a storefront, optionally for one genre. | read |  |
| `apple_music_list_playlists` | List the playlists in your Apple Music library (alphabetical), or the contents of one playlist folder (folders and playlists). | read |  |
| `apple_music_get_playlist` | Read one playlist — a library playlist (p.…) or a catalog playlist (pl.…) — with its tracks in order. | read |  |
| `apple_music_list_folders` | List the playlist folders in your Apple Music library: the top level, or the sub-folders of one folder. | read |  |
| `apple_music_search_library` | Search YOUR Apple Music library (not the whole catalog) by text for songs, albums, artists, playlists or music videos. | read |  |
| `apple_music_list_library` | List what is in your Apple Music library: all songs, albums, artists or music videos (alphabetical, paged), or recently-added items. | read |  |
| `apple_music_get_history` | Your recent Apple Music listening: recently-played (albums, playlists, stations), recently-played-tracks (songs), recent-stations, or heavy-rotation. | read |  |
| `apple_music_get_recommendations` | Your personal Apple Music recommendations ("Made for You", "Recently Played" and similar groups), each with its title and the albums, playlists or stations in it (catalog ids). | read |  |
| `apple_music_get_replay` | Apple Music Replay: your top songs, albums and artists for the latest Replay year, or for a given year (with play counts where Apple provides them). | read |  |
| `apple_music_get_ratings` | Whether you have loved or disliked songs, albums, playlists, music videos or stations — catalog or library ids — returning love, dislike or none per id. | read |  |
| `apple_music_create_playlist` | Create a new playlist in your Apple Music library, optionally with tracks (up to 500 catalog or library song ids; added 100 at a time), a description, a folder and public visibility (not in APPLE_WRITE_MODE=additive). | additive |  |
| `apple_music_add_playlist_tracks` | Append songs (up to 500 catalog or library ids) to the end of one of your library playlists. | additive |  |
| `apple_music_create_folder` | Create a playlist folder in your Apple Music library, at the top level or inside another folder. | additive |  |
| `apple_music_add_to_library` | Add catalog songs, albums, playlists or music videos to your Apple Music library by catalog id (up to 100 per type). | additive |  |
| `apple_music_add_favorites` | Mark catalog songs, albums, playlists, artists or music videos as favorites (the star in Apple Music; favorite songs go to your Favorite Songs playlist), by catalog id, up to 100 per type. | additive |  |
| `apple_music_set_rating` | Set your rating on a song, album, playlist, music video or station (catalog or library id): love, dislike, or none to clear it. | all |  |
| `apple_music_update_playlist` 🌐 | Rename one of your Apple Music library playlists, change its description, or make it public/private. | all |  |
| `apple_music_remove_playlist_tracks` 🌐 | Remove tracks from one of your library playlists by library track id and/or 1-based position (from apple_music_get_playlist). | all | yes |
| `apple_music_reorder_playlist` 🌐 | Reorder one of your library playlists: move tracks, sort (name, artist, album, release date, duration, date added), reverse, dedupe (keep the first copy of each song), or replace with a complete new order of its track ids (can drop tracks). | all | yes |
| `apple_music_move_playlist` 🌐 | Move one of your library playlists into a playlist folder, or back to the top level ("root"). | all |  |
| `apple_music_delete_playlist` 🌐 | Delete one of your library playlists (songs stay in your library). | all | yes |
| `apple_music_remove_from_library` 🌐 | Remove songs, albums, music videos or playlists from your Apple Music library by LIBRARY id (i.…, l.…, p.… from apple_music_list_library / apple_music_search_library), up to 50 at a time; the preview names each item. | all | yes |
| `apple_music_remove_favorites` 🌐 | Remove the favorite (star) from catalog songs, albums, playlists, artists or music videos, by catalog id, up to 100 per type. | all |  |

### iCloud Calendar

| Tool | What it does | Mode | Confirm |
|---|---|---|---|
| `apple_calendar_list_calendars` | List your iCloud calendars (event calendars only): id, name, color, whether you can add events to it, whether it is shared (shared: with you by someone else; sharedByYou: by you with others), and which one new events go into by default. | read |  |
| `apple_calendar_list_events` | List iCloud Calendar events (appointments, meetings) in a date window, recurring events expanded into occurrences, sorted by start. | read |  |
| `apple_calendar_search_events` | Search iCloud Calendar events by text (case-insensitive match in title, location or notes) within a date window: fromDate (default today; may be in the past) + toDate or daysAhead (default 30), max 366 days. | read |  |
| `apple_calendar_get_event` | Get one iCloud Calendar event in full (notes untruncated, attendees, alerts, recurrence rule in plain English) by the id list/search returned. | read |  |
| `apple_calendar_create_event` | Create an iCloud Calendar event: title, startDate/endDate (timed default 1 hour; all-day endDate = last day), location, notes, url, alarms, recurrence, attendees. | additive | with attendees |
| `apple_calendar_update_event` | Change an iCloud Calendar event: title, startDate/endDate, isAllDay, location, notes, url ("" clears), alarms, attendees (full new list), calendar (moves it). | all | with attendees |
| `apple_calendar_delete_event` | Delete an iCloud Calendar event. Recurring: span thisEvent (default; the one occurrence an "#occ=" id names), futureEvents (it and all later ones) or allEvents (the whole series). | all | yes |
| `apple_calendar_find_free_time` | Find free time in your iCloud calendars: open slots per day within working hours (workdayStart/workdayEnd, default 09:00–17:00, weekdays only by default) at least minDurationMinutes long (default 30). | read |  |

### iCloud Contacts

| Tool | What it does | Mode | Confirm |
|---|---|---|---|
| `apple_contacts_search` | Search the user's iCloud Contacts (address book) by name, nickname, company, job title, email, or phone number digits — optionally only within one contact group. | read |  |
| `apple_contacts_get` | Get one iCloud contact in full by id (from apple_contacts_search): names, organization, job title, emails, phones, postal addresses and URLs — each with its label and an entryId that apple_contacts_update can target — birthday, note, the… | read |  |
| `apple_contacts_list_groups` | List the contact groups in iCloud Contacts (e.g. Family, Work): each group's id, name and member count. | read |  |
| `apple_contacts_create` | Create a new contact in iCloud Contacts. Needs a givenName, familyName or organization; optional middleName, nickname, department, jobTitle, note, birthday (YYYY-MM-DD, or --MM-DD without a year), and lists of emails, phones, urls and po… | additive |  |
| `apple_contacts_update` | Edit an existing iCloud contact in place. Scalar fields (givenName, familyName, middleName, nickname, organization, department, jobTitle, note, birthday) replace the current value; "" clears it. | all |  |
| `apple_contacts_delete` | Permanently delete one contact from iCloud Contacts (on every device) by id. | all | yes |

### iCloud Mail

| Tool | What it does | Mode | Confirm |
|---|---|---|---|
| `apple_mail_list_mailboxes` | List the iCloud Mail mailboxes (folders): path, name, special use (inbox, sent, drafts, trash, junk, archive) and, by default, message and unread counts. | read |  |
| `apple_mail_search` | Search emails in one iCloud Mail mailbox (default INBOX) by sender, recipient, subject, full text, received date range, unread and flagged state. | read |  |
| `apple_mail_get_message` | Read one iCloud Mail message by uid (from apple_mail_search): headers (from, to, cc, reply-to, date, subject, message-id), the body as plain text (HTML converted to readable text when there is no text part), a truncated flag, and attachm… | read |  |
| `apple_mail_send` | Send a plain-text email from your iCloud Mail address (to/cc/bcc, subject, body; no attachments). | all | yes |
| `apple_mail_update_flags` | Mark iCloud Mail messages read or unread, and flag or unflag them, by uid (1–100 uids from apple_mail_search, one mailbox). | all |  |
| `apple_mail_move` | Move iCloud Mail messages (1–100 uids from apple_mail_search, one mailbox) to another mailbox: a path from apple_mail_list_mailboxes or an alias (inbox, archive, trash, junk, sent, drafts). | all |  |

### Apple Maps

| Tool | What it does | Mode | Confirm |
|---|---|---|---|
| `apple_maps_geocode` | Turn an address or place name into coordinates with Apple Maps (geocoding). | read |  |
| `apple_maps_reverse_geocode` | Find the street address at a latitude/longitude with Apple Maps (reverse geocoding) — e.g. "where is 37.33,-122.01?". | read |  |
| `apple_maps_search` | Search Apple Maps for places: businesses, points of interest, addresses, landmarks (e.g. "coffee", "EV charger", "Golden Gate Bridge"). | read |  |
| `apple_maps_directions` | Driving, walking or cycling directions between two places with Apple Maps (addresses or "lat,lng"). | read |  |
| `apple_maps_etas` | Travel time and distance from one point to up to 10 destinations at once with Apple Maps — driving with live traffic, transit, walking or cycling (e.g. "which of these stores is closest by car?"). | read |  |
| `apple_maps_lookup_place` | Look up Apple Maps places by place id — the id field from apple_maps_search, apple_maps_geocode or apple_maps_reverse_geocode results — 1 to 50 at once. | read |  |
| `apple_maps_snapshot_url` | Make a signed link to a static Apple Maps image (PNG): centred on an address or "lat,lng", and/or with pins (each with an optional label, colour and one-character glyph; the map fits the pins when no center is given). | read |  |

### WeatherKit

| Tool | What it does | Mode | Confirm |
|---|---|---|---|
| `apple_weather_get` | Weather forecast for a place from Apple Weather (WeatherKit): current conditions, hourly (up to 240 h), daily (up to 10 days), next-hour rain, severe-weather alerts (need countryCode). | read |  |
| `apple_weather_get_alert` | Get one severe-weather alert's full official text from Apple Weather (WeatherKit), unmodified, by its id (the alerts[].id from apple_weather_get called with countryCode). | read |  |

### iTunes Search and charts

| Tool | What it does | Mode | Confirm |
|---|---|---|---|
| `apple_itunes_search` | Search Apple's iTunes Store catalog — songs, albums, artists, podcasts and podcast episodes, audiobooks, apps and ebooks — with no Apple account or key. | read |  |
| `apple_itunes_lookup` | Look up iTunes Store items (no Apple account or key) by ids — 1–200 trackId/collectionId/artistId values, e.g. from apple_itunes_search or an Apple Music link — or by one UPC/EAN (album), ISBN (book) or bundleId (app). | read |  |
| `apple_charts_get` | Apple's current top charts (no Apple account or key): most-played songs, albums, music videos and playlists on Apple Music; top podcasts, trending podcast episodes and top subscriber channels; top free/paid apps and books; top audiobooks. | read |  |
<!-- TOOLS:END -->

## Write protection (`APPLE_WRITE_MODE`)

| Value | What is registered |
|---|---|
| `none` | Read tools only. |
| `additive` | Reads, plus writes that only **add** to your own account: create a (private) playlist or folder, append tracks, add to library/favorites, create an event (without attendees, and not in a calendar shared with other people) or a contact. Nothing existing is modified or removed and nothing is sent to anyone. |
| `all` (default) | Everything. |

Gated tools are not registered at all below their mode, so no prompt or injected instruction can call them.
An unrecognised value fails closed to `none`. `APPLE_SERVICES` (comma-separated: `music`, `calendar`,
`contacts`, `mail`, `maps`, `weather`, `itunes`) narrows which services register tools at all.

## Confirmation (`MCP_CONFIRM_MODE`)

Irreversible actions and anything that reaches another person ask for confirmation first: **sending mail**,
**deleting** an event, contact, playlist or library item, **removing or reordering** playlist tracks, and
**creating or changing an event with attendees** (iCloud emails them). A client that can show a prompt
(Claude Code) asks you directly. One that cannot (claude.ai) gets a two-step flow: the first call does nothing
and returns a preview plus a `confirmToken`; only a repeat call with that token acts, and it is refused if the
target changed in between.

| Variable | Meaning |
|---|---|
| `MCP_CONFIRM_MODE` | `ask-user` (default — the model must get your OK before repeating the call), `auto` (the model may confirm after reviewing the preview), `refuse` (never). Unknown values mean `refuse`. |
| `MCP_CONFIRM_TTL_SECONDS` | How long a token is valid (default 600). |
| `MCP_CONFIRM_SECRET` | Token signing key; random per process by default. Set it so a token survives a restart; spent tokens are recorded on disk (`confirm-spent.json`), so none can be replayed (unless `APPLE_STATE_CACHE=false` or the directory is unwritable — a warning says so). |

## Environment variables

<!-- ENV:START -->
All optional; each service activates when its credentials are present. Values that are blank, `undefined`, `null` or an unexpanded `${VAR}` count as unset.

**Apple Developer key**

| Variable | Meaning |
|---|---|
| `APPLE_TEAM_ID` | Your Apple Developer Team ID (10 characters). Needed for Apple Music (official API), Apple Maps and WeatherKit. |
| `APPLE_KEY_ID` | Key ID of a private key created in Certificates, Identifiers & Profiles → Keys with Media Services (MusicKit), MapKit JS and/or WeatherKit enabled. |
| `APPLE_PRIVATE_KEY` 🔒 | Contents of that key's .p8 file (PEM; one-line values with \n escapes and base64 are accepted). |
| `APPLE_PRIVATE_KEY_PATH` | Local installs only: a path to the .p8 file instead of APPLE_PRIVATE_KEY. |
| `APPLE_MUSIC_KEY_ID` | Optional per-service override of APPLE_KEY_ID for Apple Music (pair with APPLE_MUSIC_PRIVATE_KEY). |
| `APPLE_MUSIC_PRIVATE_KEY` 🔒 | Optional per-service override of APPLE_PRIVATE_KEY for Apple Music. |
| `APPLE_MAPS_KEY_ID` | Optional per-service override of APPLE_KEY_ID for Apple Maps. |
| `APPLE_MAPS_PRIVATE_KEY` 🔒 | Optional per-service override of APPLE_PRIVATE_KEY for Apple Maps. |
| `APPLE_WEATHERKIT_KEY_ID` | Optional per-service override of APPLE_KEY_ID for WeatherKit. |
| `APPLE_WEATHERKIT_PRIVATE_KEY` 🔒 | Optional per-service override of APPLE_PRIVATE_KEY for WeatherKit. |
| `APPLE_WEATHERKIT_SERVICE_ID` | WeatherKit only: the Services ID registered for WeatherKit (e.g. com.example.weather). |

**Apple Music**

| Variable | Meaning |
|---|---|
| `APPLE_MUSIC_DEVELOPER_TOKEN` 🔒 | Optional: a pre-minted Apple Music developer token (JWT) instead of signing one from the key above. |
| `APPLE_MUSIC_USER_TOKEN` 🔒 | Music User Token for your library (official API), from a one-time MusicKit sign-in: `npx apple-icloud-mcp music-auth`. Without the Apple Developer key, ask the owner for a developer token (music-auth --print-developer-token) and run it with APPLE_MUSIC_DEVELOPER_TOKEN set. Lasts ~6 months. |
| `APPLE_MUSIC_WEB_USER_TOKEN` 🔒 | Opt-in web-player mode (no developer account needed; unlocks rename/delete/remove/reorder): the media-user-token cookie from a signed-in music.apple.com tab. |
| `APPLE_MUSIC_WEB_DEVELOPER_TOKEN` 🔒 | Optional override for the web-player developer token (normally read automatically from music.apple.com). |
| `APPLE_MUSIC_STOREFRONT` | Two-letter Apple Music storefront (e.g. us, gb). Default: your account's storefront, else us. |

**iCloud**

| Variable | Meaning |
|---|---|
| `ICLOUD_USERNAME` | Your Apple ID email, for iCloud Calendar, Contacts and Mail. |
| `ICLOUD_APP_PASSWORD` 🔒 | An app-specific password from appleid.apple.com → Sign-In and Security → App-Specific Passwords (NOT your Apple ID password). |
| `ICLOUD_MAIL_ADDRESS` | Your @icloud.com address, only if your Apple ID email is not an iCloud address (needed for Mail). |
| `ICLOUD_DEFAULT_CALENDAR` | Calendar new events go to when none is named (default: the first writable event calendar). |

**Behaviour**

| Variable | Meaning |
|---|---|
| `APPLE_WRITE_MODE` | "none" = read-only tools; "additive" = also create/append, never modify, delete or send; "all" = everything (default). Unrecognized values fail closed to "none". |
| `APPLE_SERVICES` | Comma-separated services to enable (music, calendar, contacts, mail, maps, weather, itunes). Default: all. |
| `DISPLAY_TZ` | IANA time zone (e.g. America/New_York) for displayed times and for dates you give without an offset. Calendar events stored without a time zone of their own (floating) are always read in it: a calendar call's `timeZone` changes how your times are read and shown (and, on create/update, the zone an event is stored in) but never how a floating event is read, so occurrence ids never depend on it. Set this on a hosted server, which runs in UTC. |
| `APPLE_UNITS` | "metric" (default) or "imperial" units for weather (Maps distances always show both). |
| `APPLE_STATE_CACHE` | Set to false to write nothing under $MCP_DATA_DIR/.apple-icloud-mcp: no web-player token or iCloud discovery cache, and the rejected-password latch and spent confirmation tokens then last only as long as the process. |
| `APPLE_REQUEST_TIMEOUT_MS` | Per-request timeout in milliseconds (default 30000). |
| `APPLE_DEBUG_LOG` | Set to 1 to log every upstream request line to stderr (credentials redacted). |

**Confirmation**

| Variable | Meaning |
|---|---|
| `MCP_CONFIRM_MODE` | How confirm-gated writes (send mail, deletes, removing tracks, invitations) behave on a client with no prompt, like claude.ai: "ask-user" (default: preview + confirmToken, the model must get your OK), "auto", or "refuse". Unknown values mean refuse. |
| `MCP_CONFIRM_TTL_SECONDS` | Lifetime of a confirmToken in seconds (default 600). |
| `MCP_CONFIRM_SECRET` 🔒 | Signing key for confirmTokens. Random per process by default; set it so a token issued just before a restart or redeploy still works (spent tokens are recorded on disk, so none can be replayed). |

🔒 = a secret: store it as one.
<!-- ENV:END -->

## Not supported (and why)

- **Reminders, Notes, Find My, iCloud Drive, Photos, Hide My Email.** None has a public API or a standard
  protocol that still works: iCloud Reminders left CalDAV with iOS 13. The only route is iCloud.com's private
  API, which needs your **full Apple ID password**, an SRP sign-in and a two-factor code, has broken four times in
  about two years, is blocked by Advanced Data Protection, and is exactly the "automated means" the iCloud
  Terms forbid. On a Mac, [apple-swift-mcp](https://github.com/chrischall/apple-swift-mcp) covers Reminders,
  Notes and Photos natively.
- **Playing music.** Apple's web APIs manage your library; playback happens in an Apple Music app.
- **Creating or deleting calendars** — iCloud's CalDAV server does not reliably support it.
- **Mail attachments** — sending is plain text; reading lists attachments but does not download them.

## Troubleshooting

Run **`apple_healthcheck`** first. For each service it reports whether credentials are configured (and which
variables to set if not), whether Apple accepted them just now, the active write mode and the display time zone.

The same check runs from a terminal, with no MCP client involved — useful before wiring the server into Claude,
or to tell a credential problem from a client problem. It reads the shell environment only, not the `env` block
of `.mcp.json`, Claude Desktop's config or the extension's settings, so export the same values first:

```bash
printf 'App-specific password: '; read -rs ICLOUD_APP_PASSWORD; echo   # not echoed, kept out of shell history
export ICLOUD_APP_PASSWORD ICLOUD_USERNAME=you@icloud.com
npx -y apple-icloud-mcp doctor                  # every enabled service
npx -y apple-icloud-mcp doctor calendar mail    # only these
npx -y apple-icloud-mcp doctor --json           # the apple_healthcheck report as JSON
```

It exits 0 when every configured service works (and every service named on the command line is configured,
enabled and working), 1 otherwise, and 2 for a usage error. It sends each configured service one read-only
request (the iCloud ones one at a time, so a revoked password is sent once), and prints no secrets. From a
source checkout, `node dist/index.js doctor` also reads the repo's `.env`.

| Symptom | Likely cause |
|---|---|
| iCloud "credentials rejected" | The app-specific password was revoked (Apple ID password changed) or the normal password was used. Generate a new app-specific password. |
| Apple Music 401 | Developer key problem: wrong Team/Key ID, or the key lacks MusicKit. In web mode: the `media-user-token` cookie expired — copy a fresh one. |
| Apple Music 403 | The Music User Token expired (≈6 months), was minted with a different key, or the account has no Apple Music subscription. Run `music-auth` again (without the developer key: ask its owner for `music-auth --print-developer-token`). |
| `PLAYLIST_CHANGED` | Apple has not caught up with a recent change this server made to the playlist yet (its reads lag writes by seconds), or the playlist was edited elsewhere. Reorders, track removals, duplicate-checked adds and playlist updates refuse to act on such a read. Re-read with `apple_music_get_playlist` and retry. |
| Times are off by hours | Set `DISPLAY_TZ` to your IANA zone. |
| Mail times out on a hosted deployment | Check `imap.mail.me.com` / `smtp.mail.me.com` are in the egress allowlist. |

`APPLE_DEBUG_LOG=1` logs every upstream request line to stderr, with credentials redacted.

## Security

- Credentials are read from the environment at call time and never written to disk, logged, or put in a URL;
  every error and log line is scrubbed of every credential the process has used.
- Only Apple's hosts are contacted; a redirect or DAV href pointing anywhere else is refused before any
  credential travels.
- Reading mail never marks it read (`apple_mail_update_flags` does that when asked). HTML mail is converted to
  text with hidden content dropped, and mail and calendar text is labelled as content from its sender.
- **Local data:** small files under `$MCP_DATA_DIR/.apple-icloud-mcp/` (or `~/.apple-icloud-mcp/`), all mode 0600 and none holding
  your password or tokens:
  - `music-web-token.json` — Apple Music web player's own public developer token (web mode only);
  - `dav-calendar.json`, `dav-contacts.json` — iCloud discovery URLs, bound to the credential they came from;
  - `mail-login.json` — which IMAP login form iCloud accepted;
  - `icloud-rejected.json` — salted digests of rejected Apple ID/password pairs and when, so a revoked
    password is not re-sent for 24 hours even after a restart;
  - `confirm-spent.json` — digests of used confirmation tokens, so none can be replayed after a restart.

  Delete the directory to remove them, or set `APPLE_STATE_CACHE=false` to never write them (the latch and the
  spent-token record then last only as long as the process, and a warning says so).

## Development

```bash
npm run build        # tsc → dist/, then esbuild bundle → dist/bundle.js
npm test             # typecheck + vitest
npm run test:coverage  # 100% line/branch/function/statement coverage is enforced
```

See [CLAUDE.md](CLAUDE.md) for the architecture and [docs/APPLE-API.md](docs/APPLE-API.md) for the provenance
of every Apple API detail.

## License

MIT
