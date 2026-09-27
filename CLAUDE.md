# apple-icloud-mcp — Apple services from any OS

Node/TypeScript stdio MCP server that reaches Apple's web services from any OS: Apple Music (official API +
opt-in web-player API), iCloud Calendar (CalDAV), Contacts (CardDAV) and Mail (IMAP/SMTP), Apple Maps Server
API, WeatherKit REST, and iTunes Search/charts. 58 tools, all prefixed `apple_`. Built to be hosted on
mcp-host (Linux, gVisor, egress through an HTTPS proxy, scale-to-zero) as well as run locally. Published as
`apple-icloud-mcp` (unscoped; bin of the same name). Unofficial — not affiliated with Apple, and every description
says so. Before its first release it was `aws-mcp` ("Apple Web Services"), renamed because that reads as Amazon Web
Services: never shorten the name to "AWS", and **never use an `AWS_` env prefix** — that namespace is the Amazon
SDK's (a packaging test enforces it).

## Commands

```bash
npm run build          # tsc → dist/, then esbuild bundle → dist/bundle.js (the .mcpb entry)
npm test               # tsc typecheck + vitest run
npm run test:coverage  # what CI runs: 100% lines/branches/functions/statements on src/** (excl. src/index.ts)
npm run dev            # node --env-file=.env dist/index.js
npm run notices        # regenerate THIRD_PARTY_NOTICES.md (the bundle script does this too)
npx apple-icloud-mcp music-auth   # one-time MusicKit sign-in that prints APPLE_MUSIC_USER_TOKEN
npx apple-icloud-mcp music-auth --print-developer-token --days 7   # hand out a dev token, never the .p8
npx apple-icloud-mcp doctor [service…] [--json]   # apple_healthcheck from a terminal; exit 0 ok / 1 failing / 2 usage
```

## Architecture

```
src/
  index.ts          entry: .env, `music-auth` / `doctor` CLI dispatch, runMcp(REGISTRARS)
  doctor.ts         `doctor` CLI: healthReport() (shared with apple_healthcheck) rendered for a terminal
  registry.ts       REGISTRARS + HEALTH_PROBES — the single list the server AND tests/manifest-roster use
  version.ts        VERSION (x-release-please-version)
  config.ts         APPLE_SERVICES, APPLE_WRITE_MODE (none|additive|all, fail-closed), DISPLAY_TZ, timeouts
  errors.ts         AppleToolError family with stable `code`s; rememberSecret/scrub literal-secret redaction
  http.ts           the ONE HTTPS chokepoint (global fetch, host allowlist, timeouts+cancel, bounded retries,
                    manual redirects, streamed size cap, UnconfirmedWriteError for unknown write outcomes)
  apple-keys.ts     .p8 normalization/validation, ES256 tokens for MusicKit, Maps (/v1/token exchange), WeatherKit
  icloud-auth.ts    ICLOUD_USERNAME/ICLOUD_APP_PASSWORD + the credential-rejection latch (memory + disk, 24 h)
  time.ts           strict date parsing (offset-less = wall clock in DISPLAY_TZ), DST-correct formatting
  state.ts          tiny 0600 JSON caches under $MCP_DATA_DIR/.apple-icloud-mcp, bound to the credential
  health.ts         HealthProbe contract + makeProbe; tools/healthcheck.ts runs them all (apple_healthcheck)
  tools/_shared.ts  defineTool (service switch + write-mode gate + structured scrubbed errors), ANNOTATIONS,
                    pageInfo/pagedResponse (paging facts FIRST), jsonResponse (minified)
  tools/_confirm.ts confirmWrite (mcp-utils elicitation / two-phase confirmToken) with a disk-backed spent-token
                    store (confirm-spent.json) so a token can't be replayed after a restart; stateRevision
  music/            Apple Music: credentials (official|web), client, web-token scraper, 25 tools, auth-cli
  dav/              WebDAV client, multistatus XML (xmldom), iCloud discovery (shared by calendar + contacts)
  calendar/         CalDAV events: ical.js parse/expand/build, ids with #occ=, series edits, free time
  contacts/         CardDAV: raw-line vCard 3.0 editor, entryIds, book cache keyed by getctag
  mail/             imapflow + nodemailer SMTPConnection, CONNECT tunnel, HTML→text, safe move
  maps/ weather/ itunes/
tests/              mirrors src/; tests/_setup.ts blanks APPLE_*/ICLOUD_*/DISPLAY_TZ/MCP_CONFIRM_*,
                    pins MCP_DATA_DIR to a temp dir, stubs fetch to THROW, makes retry sleeps instant
```

A module exports `register<X>Tools(server, deps?)` from `src/<x>/tools.ts` and `<x>Health` from
`src/<x>/health.ts`; `registry.ts` wraps each registrar so it receives the server ONLY (runMcp passes its own
`deps` as the 2nd argument). Add a tool → register it through `defineTool` → add it to `manifest.json`
(`tests/manifest-roster.test.ts` fails otherwise) and to the README table.

## Rules every tool follows (tested — don't weaken)

- **Config is read at CALL time, never at import or registration.** CI boots the bundle with `env -i` and
  fails if only the healthcheck is listed; `tests/server-boot.test.ts` spawns the real bundle with no env.
  Missing config → `ConfigError(service, msg, missingVarNames, hint)` from the handler.
- **Global `fetch` only** (through `httpRequest`) — on mcp-host `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1` is the
  only way out, and a library with its own HTTP stack silently bypasses it. Raw TCP (IMAP/SMTP) is tunnelled
  through the proxy explicitly (mail/smtp.ts, imapflow `proxy`).
- **Host allowlist** (`ALLOWED_HOSTS` + `.icloud.com` suffix in http.ts) must match `mint.yaml` `egress.allow`
  (a test checks). Redirects are followed by hand; credential headers never cross a service family
  (`credentialFamily`: iCloud / Apple Music / the host), but survive iCloud's partition-host hops.
- **Input schemas are `z.strictObject`** — an unknown argument is an error, never silently dropped.
- **An error never renders as an empty result.** Throw; `defineTool` turns it into
  `{error:{code,message,hint,…}}` with `isError`, scrubbed of every credential (`rememberSecret` every value
  you read — `redactSecrets` doesn't know Apple's token shapes or app-specific passwords).
- **Paging facts before data** (`pagedResponse`); no silent caps — anything cut says so in a note.
- **Every instant carries an explicit offset plus a `…Display` sibling** (`putInstant`); dates stay `YYYY-MM-DD`.
  Parse user dates only with `parseDateInput` (strict, whole string; offset-less = wall clock in the zone).
- **Writes re-read to verify** and report `verified`/`warnings`; an unknown outcome is `UnconfirmedWriteError`
  ("may have landed — check before retrying"). Only 429 is ever retried on a non-idempotent request.
- **Structural write gate:** `APPLE_WRITE_MODE` below a tool's access → the tool is NOT REGISTERED.
  `additive` = only adds to your own account; nothing modified, removed, or sent to another person
  (calendar create refuses attendees, and music create refuses `isPublic: true`, in additive mode for that reason).
- **Confirm gate** (`confirmWrite`) on sends, deletes, playlist track removal/rewrites, and events with
  attendees (calendar create/update say so conditionally — never end a conditionally gated tool's description
  with the unconditional `CONFIRM_NOTE`); called on EVERY invocation after reads, right before the write, with a human-readable preview and
  a revision (ETag or `stateRevision`) so a stale token fails as DRAFT_CHANGED. A prompt's acceptance is bound to the
  same target+revision+payload+preview (an explicit `binding` — mcp-utils' default binds the args only, so an accepted
  "remove position 1" once removed whichever song sat there on the retry). Never a boolean `confirm` (CI lint).
- **Annotate every tool** from `ANNOTATIONS` (an unannotated tool is published as destructive).
- stdout is JSON-RPC: `console.error` only. imapflow's default logger writes to stdout — always `logger: false`.

## Service notes (the things that bit, or would have)

**Apple Music** — two credential profiles (music/credentials.ts). *Official*: `api.music.apple.com`, developer
token self-minted (12 h) from the `.p8` or `APPLE_MUSIC_DEVELOPER_TOKEN`, `Music-User-Token` from
`music-auth`. *Web* (opt-in via `APPLE_MUSIC_WEB_USER_TOKEN` = the `media-user-token` cookie):
`amp-api.music.apple.com`, the web player's own developer token scraped from
`music.apple.com/assets/index~*.js` (tokens start `eyJ0eXAi`; pick `iss: AMPWebPlay` / latest `exp`; cached to
disk, re-read at most hourly near expiry and at most every 10 min after a 401), `Origin:
https://music.apple.com`, never `x-apple-client-version`. Routing: catalog → official dev token else web;
library → official (dev + user token) else web; rename/delete/remove/reorder/move/unfavorite → web only
(Apple's official API cannot do them). A 401 on official with web mode on replays on web and says so.
Responses report `backend`. Track removal is `DELETE …/tracks?ids[library-songs]=…&mode=all` (removes EVERY
occurrence; `mode` mandatory; videos use the same key); reorders `PUT` the full list built from a fresh full
read; `PATCH` sends name+description+isPublic together like the web player. Apple-curated/collaborative
playlists are `canEdit:false`. `next` hrefs drop `limit` — always send explicit `offset`/`limit`.
Apple's reads lag its writes: `write-log.ts` keeps EVERY write of the last 2 min per playlist (keeping only the
latest let a second quick write hide the first): a rewrite (remove/reorder) records the order it replaced, an
add/create the copies of each track a read must show (never the add's own, possibly stale, read). A rewrite that
lands supersedes the entries its read showed (`mark()` → `recordRewrite`); an unconfirmed one is kept alongside.
`playlistStateRefusal` refuses a rewrite whose read doesn't show one of them, or whose `expectedRevision` doesn't
match (`PLAYLIST_CHANGED`); every rewrite returns the new `revision`. add_playlist_tracks refuses the same way when
its duplicate check would run on such a read (`skipDuplicates:false` appends with a warning) and verifies by
PRESENCE, not count. `update_playlist` PATCHes the full attribute set, so `PlaylistAttributeLog` refuses one whose
read doesn't show a name/description/visibility this process set in the last 2 min. A write whose read may lag is
never skipped as "already so": `set_rating` always sends (PUT/DELETE are idempotent) and `move_playlist` always PUTs
the parent. The health
probe uses `GET /v1/test` (a catalog id can be withdrawn) and checks each backend independently.

**iCloud DAV** (dav/) — discovery: `PROPFIND /` Depth **0** → principal → home-set, an ABSOLUTE URL on the
partition host (moved by href, not redirect). Credentials go only to `https://*.icloud.com`. 401 latches the
credential (`icloud-auth.ts`) on EVERY request — the cached-home `probe` too, so a cold start with a disk
discovery record doesn't re-send a revoked pair to rediscover (the probe answers only 403/404/410); a bare 403 latches only on the two discovery hosts (on partition hosts it's
usually a read-only calendar). REPORT responses include the collection's own href — skip it (`sameResource`).
A 207 on DELETE/MOVE is a partial failure, not success. The dsid in paths is scrubbed from errors. The latch is
persisted (`icloud-rejected.json`, salted digests + time) so a hosted cold start doesn't re-send a revoked
password; the healthcheck runs the iCloud probes one at a time until one answers, so a revoked pair is sent once.

**Calendar** — event id `<calendarId>/<file>.ics`, occurrence `…#occ=<UTC Z | YYYY-MM-DD>` (parsed from the
end). A bare id on a recurring series is refused for single-occurrence edits; never fall back to the first
occurrence. Recurrences are expanded client-side with ical.js (iCloud's server `expand` breaks all-day
events). ical.js has NO loop limits: VTIMEZONE rules that aren't plain yearly are swapped for the standard
zone (an invitation-controlled TZ once hung the server), and rules it would spin on are refused before it
sees them — keep those guards. API all-day end dates are INCLUSIVE; iCalendar DTEND is exclusive. Query
windows are widened a day each side (iCloud evaluates all-day events in its own zone) then filtered exactly.
`futureEvents` splits the series (UNTIL on the old, new UID for the new, COUNT adjusted; restore on failure);
`allEvents` time changes shift DTSTART, EXDATE/RDATE/UNTIL, overrides AND plain BYDAY weekdays by wall
clock. PUT with If-Match; 412 → "changed since read". **Every write goes through `serializeForWrite`**, which
re-parses the ICS and refuses it if any line break slipped into a value or the ATTENDEE/ORGANIZER/UID set differs
from what was built — a CR/LF in a `url` once injected an ATTENDEE past the confirm gate. Schemas refuse control
characters (C0, C1, U+2028/9) in single-line fields. `list_events`/`search_events` default to a compact
`view`. Additive mode refuses calendars shared with others (`CS:shared-owner` / sharee privileges, unverified live).

**Contacts** — vCard 3.0 edited as RAW LINES (a generic serializer rewrote Apple's `itemN.` groups); untouched
lines round-trip byte-for-byte. `entryId` = hash of property+group+raw value, `~n` suffix for duplicates,
resolved against the card as it was BEFORE the request's first change. FN is rewritten only when the composed
name changes. Groups are separate cards (`X-ADDRESSBOOKSERVER-KIND:group`) excluded from results. The whole
book is read with one unfiltered REPORT and cached per process by getctag; a 507 on the collection's own
response means truncated — say so. Inline `PHOTO`s can push that answer past `MAX_RESPONSE_BYTES`
(`ResponseTooLargeError`): then the book is read as an ETag-only listing + `addressbook-multiget` batches of
100, halving a batch that is still too large; a card too large ON ITS OWN is counted (`tooLarge`) and warned
about, never a failed book, and `get` reads a card the book left out directly rather than calling it
NOT_FOUND. ORG's department reads as every unit after the organization, so setting it replaces them all (the
value as shown is left untouched). A `BDAY` with year `0000` is a birthday without a year, like `1604`.

**Mail** — IMAP login tries the address local part then the full address (Apple domains only; a custom domain
uses the full address) and remembers which worked (`mail-login.json`) so cold starts don't spend failed
sign-ins. Reads use `BODY.PEEK` and `get_message` has no markRead (use `update_flags`). Replies take
`inReplyTo`; a Reply-To the recipients don't include is warned about, never silently followed. iCloud has no MOVE: move = COPY, verify, then remove
exactly those UIDs (imapflow's fallback deletes originals even when the copy failed). Send drives nodemailer's
`SMTPConnection` step by step so "nothing was sent" and "may have been sent" are distinguishable, then APPENDs
to "Sent Messages" (iCloud SMTP doesn't). The CONNECT tunnel pauses the socket until nodemailer listens (the
greeting can arrive with the proxy's 200) and has its own deadline. WITHIN's `OLDER 0`/`YOUNGER 0` are
invalid — future dates are handled locally. imapflow's COPY/MOVE/STORE/EXPUNGE swallow a connection lost
mid-command into the same `false` as a server NO: every such write goes through `unswallowed` (tools.ts), and only
a tagged NO/BAD (or a `false` with no error on a live connection) may say "Nothing was moved/changed" — anything
else is UNCONFIRMED_WRITE. HTML→text drops hidden content (prompt-injection hygiene) and reads markup as a
browser does where that decides what is hidden: comments end at the first `-->`/`--!>` (`<!-->` is empty), `/>`
counts only on void/SVG/MathML elements, `<p>`/`<li>` close implicitly (at a start tag that closes them, or at the end tag
of an element they sit in). It must stay linear — links don't nest
and a link's text is compared with its target only when short (a nested-`<a>` bomb once took minutes).

**Maps** — ES256 JWT (`scope: server_api`) exchanged at `GET /v1/token` for a 30-min access token; a 401 on a
data call re-exchanges once (only if the cached token is still the refused one). Snapshot URLs are SIGNED,
never fetched; the query must be encoded exactly as a browser will send it (`!'()*` too) or the signature
won't match. A missing result list only means "empty" when the body has no other list.

**Weather** — JWT header needs `id: <team>.<serviceId>` and `sub` = Services ID. Days roll over in `timeZone`
(default: display zone) — a response warns when that zone is far from the location's solar time. Hourly
ranges > 192 h may 400 → retried once at 192 with a note. Attribution + alert `source`/`detailsUrl` are
mandatory and always included; alert text is never modified. A `weatherAlerts` set Apple didn't send is never
turned into an empty alerts list (whether Apple omits it when none is active is [UNVERIFIED]); only a list
Apple sent reads as "none", and not when its metadata says `temporarilyUnavailable`.

**iTunes** — no auth, ~20 calls/min: one sliding-window limiter (fails fast with RATE_LIMITED past a 30 s
wait) + 1 h response cache. No real paging upstream: tools fetch `offset+limit` (≤ 200) and slice; charts
always fetch the full top 100 once and slice. JSON arrives as `text/javascript`.

## Hosting (mcp-host)

`mint.yaml` (shipped in the package; mcp-host reads it from jsDelivr) proposes: owner `env` for the developer
key, `DISPLAY_TZ`, write mode, `MCP_CONFIRM_SECRET`; `auth.fields` (persist: user) for each person's Apple ID,
app-specific password and Music tokens — declaring auth gives each caller their own child and `$HOME`;
`state.dataDir` for the small caches; `egress.allow` = exactly the hosts in http.ts plus the two mail hosts.
Quote `"*.icloud.com"` in YAML (a bare `*` is an alias). Keep the allowlist and `ALLOWED_HOSTS` in step.

## Testing

`vitest.config.ts` enforces 100% coverage on `src/**` (excluding `src/index.ts`). `/* v8 ignore */` only for
provably unreachable code, with the reason. Tests never touch the network or `$HOME`: fetch throws unless a test
stubs it; DAV/Music/Mail tests run the REAL client code against in-memory fakes (fake CalDAV/CardDAV servers,
a fake Apple Music library, an in-memory IMAP server, loopback SMTP/proxy). Tests must not depend on the
machine's zone — set `DISPLAY_TZ` and fake timers. `tests/server-boot.test.ts` builds (if needed) and spawns
`dist/bundle.js` with an empty env and checks stdout is pure JSON-RPC.

Nothing here has been exercised against a live Apple account; `docs/APPLE-API.md` tags every upstream fact
([DOC]/[BUNDLE]/[3P]/[LIVE]/[UNVERIFIED]). When a live run contradicts it, fix the code AND that file.

## Publishing constraints

- `server.json` `description` ≤ 100 chars (MCP Registry 422 otherwise) — `tests/packaging.test.ts` checks.
- Unscoped npm name `apple-icloud-mcp` (like the rest of the fleet), same-named bin, `mcpName`/`server.json` name
  `io.github.chrischall/apple-icloud-mcp`.
- `mint.yaml` and `THIRD_PARTY_NOTICES.md` must stay in package.json `files`.
- A green tag is not a green publish: after a release, `npm view apple-icloud-mcp version`.

## Versioning

release-please (`release-type: node`, `initial-version: 0.1.0`) owns every version: `package.json`,
`src/version.ts` (`// x-release-please-version`), `manifest.json`, `server.json` (both fields),
`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (both fields). Never bump by hand or tag;
`tests/version-sync.test.ts` and `tests/packaging.test.ts` catch drift. Conventional-commit PR titles:
`fix:` → patch, `feat:` → minor, `feat!:` → major.

## Pull requests & release notes

Fleet policy — Conventional-Commit PR titles, labels, the auto-review / auto-merge ladder, PR timing, release
PRs — lives in `~/.claude/CLAUDE.md`. Shared technical conventions live in
[`chrischall/workflows`](https://github.com/chrischall/workflows): `docs/fleet-conventions.md`, plus `README.md`
for the CI pipeline contract. The `.github/` stubs are rendered from that repo's `fleet.json`; don't hand-edit them.

## Gotchas

- ESM + NodeNext: relative imports end in `.js`.
- `ical.js` is MPL-2.0 (bundled unmodified; `THIRD_PARTY_NOTICES.md` + the bundle footer carry the notice).
- mcp-utils `createApiClient` is NOT used: CalDAV needs raw XML bodies and WebDAV methods it can't send.
- AI-maintained: README warns so; `src/index.ts` prints the same notice to stderr on startup.
