# Apple web services — what this server relies on, and where that knowledge came from

Fleet convention: every upstream fact this code depends on is recorded here with its
provenance, so that when Apple changes something the question "was this ever documented,
or did we infer it?" has an answer. Tags:

- **[DOC]** Apple's published documentation.
- **[BUNDLE]** Read out of Apple's own web client (music.apple.com JavaScript, 2026-09-26).
- **[3P]** A third-party client or report (named).
- **[LIVE]** Observed from this project's sandbox, unauthenticated only, 2026-09-26.
- **[UNVERIFIED]** Believed but not yet observed against a real account — treat as the first
  suspect when something breaks.

Nothing below was exercised against a signed-in Apple account during development: the
build environment had no Apple credentials. The first live run is the real verification.

## Apple Music

**Official API** — `https://api.music.apple.com/v1` [DOC: developer.apple.com/documentation/applemusicapi]

- Developer token: ES256 JWT, header `{alg, kid}`, claims `iss` = Team ID, `iat`, `exp`
  (≤ 15 777 000 s). This server mints 12-hour tokens from the `.p8` and re-mints. [DOC]
- Music User Token (`Music-User-Token` header) can only be obtained interactively with
  MusicKit JS `authorize()` in a browser; it lasts ~6 months and a password change revokes it.
  `npx apple-icloud-mcp music-auth` runs that sign-in on localhost. [DOC; lifetime: Apple
  staff forum post, 2020]
- A user token must be used with a developer token from the SAME key: a different key from
  the same team returned 403. [3P report — UNVERIFIED here]
- `next` pagination hrefs drop `limit`; this server always sends explicit `offset`/`limit`. [LIVE]
- Documented writes are the complete list: create playlist, append tracks, create folder, add
  to library, add favorites, set/delete ratings. [DOC] The official API cannot rename or delete
  playlists, remove or reorder tracks, or remove library items; a playlist `DELETE` returns 401
  there. [Apple staff, forums/107807; forums/813068, Jan 2026; 3P measurement 2026-09-21]
- Apple-curated and collaborative playlists have `canEdit: false`; appending to them fails. [Apple DTS, Oct 2025]
- The health probe calls `GET /v1/test`, Apple's documented connectivity endpoint (200 with a valid developer
  token). It replaced a catalog-song read: the song id first chosen does not exist (404), which made every
  working setup report as failing. [DOC; LIVE with the web-player token, 2026-09-27]

**Web-player API (opt-in, unofficial)** — `https://amp-api.music.apple.com/v1`

- Credentials: the web player's own developer token (embedded in
  `music.apple.com/assets/index~<hash>.js`, `iss: AMPWebPlay`, ~70-day life, rotates) plus the
  signed-in user's `media-user-token` cookie; every request carries
  `Origin: https://music.apple.com`. Without that Origin: 401. [BUNDLE; LIVE for catalog search]
- `x-apple-client-version` must NOT be sent (500). [3P: apple-music-playlists]
- Calls this server uses, all taken from Apple's bundle [BUNDLE; Cider v1 used the same]:
  - rename/description/public: `PATCH /v1/me/library/playlists/{id}` `{attributes:{…}}`
  - replace/reorder tracks: `PUT /v1/me/library/playlists/{id}/tracks` `{data:[…full list…]}`
  - remove tracks: `DELETE /v1/me/library/playlists/{id}/tracks?ids[library-songs]=…&mode=all`
    (no `mode` → 400 "No mode supplied"; removes every occurrence of each id)
  - move to folder: `PUT /v1/me/library/playlists/{id}/parent`
  - delete: `DELETE /v1/me/library/{songs|albums|playlists|music-videos}/{id}`
  - unfavorite: `DELETE /v1/me/favorites?ids[{type}]=…`
- None of these writes was live-tested from here (the sandbox refused authenticated probes).
  Apple has said undocumented methods "may be blocked at any time". [UNVERIFIED]

**Read-after-write lag (both APIs)** — what the playlist/rating/folder write paths are built around:

- Library reads lag library writes: a playlist's tracks, its attributes (name, description, isPublic),
  a folder's children and a rating can read as they were before a write for seconds or longer. Apple
  documents a delay only for new library items appearing; that the delay also covers edits to existing
  playlists, folder membership and ratings, and how long it lasts, is assumed (the 2-minute write-log
  window is a guess). [UNVERIFIED] Every such write therefore verifies by re-reading, reports "not
  visible yet" instead of failing, refuses to rebuild or re-PATCH from a read that does not show this
  process's own recent change, and never skips a write because a read says it is already done.
- A catalog song appended to a library playlist reads back as a library track whose
  `attributes.playParams.catalogId` is the catalog id that was sent (that is how the duplicate check,
  the write log and add verification recognise it). If Apple lists it under a different catalog id
  (another storefront's equivalent), the add reports "not showing yet" and rewrites are refused until
  the 2-minute window lapses — safe, but noisy. [UNVERIFIED]
- `PUT /v1/me/ratings/{type}/{id}` sets a value and `DELETE` removes it (404 when there is none), so
  repeating either is harmless. [DOC for the endpoints; idempotence UNVERIFIED] Setting a playlist's
  `parent` to the folder it is already in is assumed to be a no-op. [UNVERIFIED]
- `isPublic: true` shows a playlist on the user's Apple Music profile (the web player adds `with=shared`
  when creating or updating a public one) — i.e. to other people, which is why additive mode refuses
  it. [BUNDLE]

## iCloud Calendar and Contacts (CalDAV / CardDAV)

- Hosts `caldav.icloud.com` / `contacts.icloud.com`; Basic auth with the Apple ID and an
  **app-specific password**; wrong credentials → 401 or 403. [LIVE unauthenticated; support.apple.com/102654]
- Discovery: `PROPFIND /` Depth 0 → `current-user-principal`; `PROPFIND` principal Depth 0 →
  `calendar-home-set` / `addressbook-home-set`, an ABSOLUTE URL on the account's partition host
  (`pNN-caldav.icloud.com`) — the move happens through the href, not an HTTP redirect. Depth 1
  on the first PROPFIND returns 400. [3P: Aurinko samples 2024; Apple Community 2019]
- `calendar-query` with a time range returns master events with their RRULE; server-side
  `expand` turns all-day events into UTC date-times, so recurrences are expanded client-side
  with ical.js. REPORT responses include the collection's own href. Searching by UID → 412.
  [3P: icloud-mcp Sept 2026, python-caldav]
- A PUT with ATTENDEE properties makes iCloud email invitations (`calendar-auto-schedule`) —
  which is why those writes are confirm-gated. [DOC: DAV header LIVE; behaviour 3P]
- MKCALENDAR is not offered (not in `Allow`); VJOURNAL and free-busy REPORT are unsupported.
- Calendars the account shares out are detected from `CS:shared-owner` in the resourcetype; calendars shared
  WITH the account from missing write privileges. [UNVERIFIED on iCloud — used to keep additive mode out of
  shared calendars]
- **Reminders are not reachable over CalDAV** for any account migrated to the iOS 13+ Reminders
  (BusyCal, 2Do, DAVx5, python-caldav all agree). Only the private CloudKit web API reaches
  them, which needs the full Apple ID password and 2FA — deliberately not implemented.
- Contacts: unfiltered `addressbook-query` REPORT returns every card; cards are vCard 3.0 with
  Apple's `itemN.X-ABLabel` grouping; groups are separate cards
  (`X-ADDRESSBOOKSERVER-KIND:group`). Updates edit raw lines because a generic serializer
  rewrote Apple's grouped/typed lines. [3P: msgvault, measurements in research]
- Contacts: cards can carry the contact photo inline (`PHOTO;ENCODING=b`), so the one unfiltered
  `addressbook-query` answer for a large, photo-heavy book can pass the server's 32 MB read cap. The
  fallback then lists ETags only (same query, `getetag` alone) and fetches cards with
  `addressbook-multiget` (hrefs as absolute paths) in batches of 100, halving on a too-large batch.
  How large iCloud's answer gets in practice, and whether it honours the ETag-only query and multiget
  batches of 100, are [UNVERIFIED] live. Timing out on a huge answer (rather than passing the cap) is
  not handled by the fallback. [UNVERIFIED]
- Contacts: some exporters write a birthday with no year as `BDAY:0000-MM-DD`; it is read like Apple's
  `1604` / `X-APPLE-OMIT-YEAR`. Whether iCloud ever serves that form is [UNVERIFIED].

## iCloud Mail (IMAP / SMTP)

- `imap.mail.me.com:993` (TLS), user = address local part (full address as fallback);
  `smtp.mail.me.com:587` STARTTLS, user = full address; app-specific password. [DOC: support.apple.com/102525]
- No MOVE / SPECIAL-USE; folders are "Sent Messages", "Deleted Messages", "Junk", "Archive".
  SMTP does not file a copy in Sent, so the server APPENDs one. [3P: Mozilla bug 1611624, imapflow]
- iCloud advertises UIDPLUS, which the COPY-then-`UID EXPUNGE` move depends on (without MOVE or
  UIDPLUS `apple_mail_move` refuses rather than expunge other deleted mail). [UNVERIFIED]
- imapflow 2.0.7's COPY, MOVE, STORE and EXPUNGE catch EVERY error — a tagged NO and a
  connection that died with the command already sent (socket timeout, reset, cancel) alike — log
  it and return `false`; they never throw for it. Only the logged error (`responseStatus`
  NO/BAD vs. `code: NoConnection`, …) and `client.usable` tell "refused" from "unknown", so the
  tools read both (`swallowedWriteFailure`). [3P: imapflow 2.0.7 `commands/copy.js`, `store.js`,
  `expunge.js`, `move.js`; reproduced in tests/mail/real-imapflow.test.ts]
- Limits: 1,000 messages/day, 500 recipients per message, 20 MB per message. [DOC]
- On a hosted runner raw TCP only leaves through an HTTP CONNECT tunnel, so both clients are
  handed `HTTPS_PROXY` explicitly. [mcp-host docs/SECURITY.md]

## Apple Maps Server API

- `https://maps-api.apple.com/v1`; an ES256 JWT with `scope: "server_api"` is exchanged at
  `GET /v1/token` for a 30-minute access token; the JWT itself cannot call data endpoints.
  25 000 calls/day per team. [DOC; forum answer]
- Snapshot URLs (`snapshot.apple-mapkit.com/api/v1/snapshot`) are signed over the exact path
  and query with the Maps key, `signature` last. The server returns the URL; it never fetches it. [DOC]

## WeatherKit REST

- `https://weatherkit.apple.com/api/v1`; JWT header carries the non-standard
  `id: "<TeamID>.<ServiceID>"`, payload `sub` = Services ID. Missing `id` → `NOT_ENABLED`.
  500 000 calls/month free. [DOC] Unauthenticated → `401 {"reason":"MISSING JWT"}`. [LIVE]
- Attribution (Apple Weather mark + legal link) is mandatory and included in every response;
  alerts must keep their `detailsUrl` and issuing `source`. [DOC]
- `weatherAlerts` is believed to be OMITTED (not sent as `{alerts: []}`) when no alert is active at a covered
  location; `GET /api/v1/availability/{lat}/{lon}?country=` lists `weatherAlerts` where alerts are covered.
  [UNVERIFIED] Until a live run settles it, a missing set is never reported as an empty alerts list: the tool
  asks availability and says "probably none — NOT confirmation" (covered), "no alert service here" (not
  covered) or UNKNOWN (check failed). If a live run shows the omission means "none", tag this [LIVE] and the
  empty list may be restored; if Apple sends `{alerts: []}` instead, a missing set means "not delivered" and
  should always read UNKNOWN.

## iTunes Search / Lookup and charts (no auth)

- `https://itunes.apple.com/search|lookup` — ~20 calls/min, JSON served as `text/javascript`,
  `cache-control: max-age=86400`. trackId/collectionId/artistId equal Apple Music catalog ids.
  Podcast episodes: `lookup?id=<podcast>&entity=podcastEpisode`, ≤ 200. [DOC: performance-partners.apple.com/search-api; LIVE]
- Charts: `https://rss.marketingtools.apple.com/api/v2/{sf}/{media}/{feed}/{limit}/{type}.json`,
  limit ≤ 100. [LIVE]

## Deliberately not implemented

The private iCloud web APIs (Find My, Reminders, Notes, iCloud Drive, Photos, Hide My Email)
need the full Apple ID password, an SRP-6a sign-in and a 2FA code, change every few months
(four breaking changes in ~24 months per pyicloud/icloudpd), are blocked by Advanced Data
Protection, and the iCloud Terms forbid automated access. See the README's "Not supported" section.
