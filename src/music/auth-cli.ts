import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { signEs256Jwt, type EnvSource } from '@chrischall/mcp-utils';
import { mintMusicDeveloperToken, type DeveloperKey } from '../apple-keys.js';
import { errorMessage, rememberSecret } from '../errors.js';
import { VERSION } from '../version.js';
import { ENV, resolveOfficialDev, type OfficialDevResolution } from './credentials.js';

/**
 * `apple-cloud-mcp music-auth` — get an official Music User Token.
 *
 * Apple mints a Music User Token only through an interactive Apple ID sign-in
 * in MusicKit (there is no OAuth grant to script). So this starts a tiny page
 * on 127.0.0.1, loads MusicKit JS there with a developer token from the SAME
 * key the server uses (a user token is bound to the developer credential it
 * was minted with), and has the browser post the token back once. It prints
 * `APPLE_MUSIC_USER_TOKEN=<token>` on stdout (this is a CLI, not the MCP
 * server, so stdout is free) and exits.
 *
 * The listener is locked down: loopback only, a random 32-byte path nonce,
 * the Host header must be the loopback address (DNS-rebinding guard), the
 * token POST must come from the page's own origin as JSON under 16 KiB, and
 * everything else is refused. It gives up after 5 minutes.
 *
 * Someone WITHOUT the key (another person on a shared deployment) must still
 * sign in against the server's key — a user token only works with the key
 * that minted it. `--print-developer-token` lets the key's owner hand them a
 * short-lived developer token from it instead of the `.p8` (which also signs
 * Maps and WeatherKit tokens and cannot be revoked per person); they run
 * music-auth with APPLE_MUSIC_DEVELOPER_TOKEN set to it. A developer token is
 * no secret from the person signing in anyway: the sign-in page hands it to
 * MusicKit JS in their browser.
 */

export const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_BODY_BYTES = 16 * 1024;
const MUSICKIT_URL = 'https://js-cdn.music.apple.com/musickit/v3/musickit.js';
const TOKEN_RE = /^[\x21-\x7e]{20,8192}$/;

export interface MusicAuthIo {
  /** Where the token line goes (default process.stdout). */
  stdout?: (text: string) => void;
  /** Instructions and errors (default process.stderr). */
  stderr?: (text: string) => void;
  /** Open a URL in a browser; best effort, must not throw (default: open / xdg-open / start). */
  open?: (url: string) => void;
  timeoutMs?: number;
  env?: EnvSource;
  now?: () => number;
  /** Told the page URL once the listener is up (tests). */
  onListening?: (url: string) => void;
}

/** Default and maximum lifetime of a token printed by --print-developer-token (Apple's own cap is ~182 days). */
export const SHARED_TOKEN_DEFAULT_DAYS = 7;
export const SHARED_TOKEN_MAX_DAYS = 180;

const HOW_TO_GET_ONE =
  'No Apple Developer key? Ask whoever runs the server for a developer token (they run ' +
  '`npx apple-cloud-mcp music-auth --print-developer-token`), then run ' +
  '`APPLE_MUSIC_DEVELOPER_TOKEN=<that token> npx apple-cloud-mcp music-auth`.';

const USAGE =
  'Usage: apple-cloud-mcp music-auth [--no-open]\n' +
  '       apple-cloud-mcp music-auth --print-developer-token [--days N]\n\n' +
  'Signs in to Apple Music in your browser and prints APPLE_MUSIC_USER_TOKEN=… for the official API.\n' +
  'Needs the Apple Developer key the server uses (APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY), or\n' +
  'APPLE_MUSIC_DEVELOPER_TOKEN set to a developer token minted from that key — the key never has to be shared.\n' +
  '  --no-open                 print the URL instead of opening a browser\n' +
  '  --print-developer-token   for the key\'s owner: print APPLE_MUSIC_DEVELOPER_TOKEN=… minted from the key and exit;\n' +
  '                            hand that line to someone who then runs music-auth with it (never the .p8)\n' +
  `  --days N                  how long that token lasts: 1-${SHARED_TOKEN_MAX_DAYS} days (default ${SHARED_TOKEN_DEFAULT_DAYS}). It cannot be\n` +
  '                            revoked short of revoking the key, so keep it short\n';

/** A developer token from the key, valid for `days` (the server's own tokens last 12 hours). */
export function mintSharedDeveloperToken(key: DeveloperKey, days: number, now: number): { token: string; expiresAt: number } {
  const iat = Math.floor(now / 1000);
  const exp = iat + days * 24 * 60 * 60;
  return { token: signEs256Jwt(key.privateKeyPem, { iss: key.teamId, iat, exp }, { header: { kid: key.keyId } }), expiresAt: exp * 1000 };
}

/** Best-effort browser launch; never throws. */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const [cmd, args] =
    platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // No launcher on this machine — the URL is on stderr.
  }
}

function json(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c');
}

export function signInPage(developerToken: string, tokenPath: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>apple-cloud-mcp · Apple Music sign-in</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5}button{font-size:1rem;padding:.6rem 1.2rem}#status{margin-top:1rem;color:#555}</style>
<script src="${MUSICKIT_URL}" async></script>
</head><body>
<h1>Sign in to Apple Music</h1>
<p>This page gets a Music User Token for apple-cloud-mcp. Click the button, sign in with your Apple ID and allow access. The token goes only to the apple-cloud-mcp command running on this computer.</p>
<button id="go" disabled>Sign in with Apple Music</button>
<p id="status">Loading MusicKit…</p>
<script>
(function () {
  var DEV = ${json(developerToken)};
  var TOKEN_URL = ${json(tokenPath)};
  var go = document.getElementById('go');
  var status = document.getElementById('status');
  function say(t) { status.textContent = t; }
  function start() {
    Promise.resolve(MusicKit.configure({ developerToken: DEV, app: { name: 'apple-cloud-mcp', build: ${json(VERSION)} } })).then(
      function () { go.disabled = false; say('Ready.'); },
      function (e) { say('MusicKit could not start: ' + e); }
    );
  }
  if (window.MusicKit) start(); else document.addEventListener('musickitloaded', start);
  go.addEventListener('click', function () {
    go.disabled = true;
    say('Waiting for Apple sign-in…');
    MusicKit.getInstance().authorize().then(function (token) {
      return fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token }) });
    }).then(function (r) {
      return r.text().then(function (t) { if (!r.ok) throw new Error(t); document.body.innerHTML = t; });
    }).catch(function (e) { go.disabled = false; say('Sign-in failed: ' + ((e && e.message) || e)); });
  });
})();
</script>
</body></html>
`;
}

const DONE_PAGE =
  '<h1>Done — you can close this tab.</h1><p>Your Music User Token was handed to the apple-cloud-mcp command. Set it as APPLE_MUSIC_USER_TOKEN.</p>';

function reply(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...extra,
  });
  res.end(body);
}

function readBody(req: IncomingMessage, cap: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) over = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? undefined : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

/** `--print-developer-token`: mint a shareable developer token from the key and print it. */
function printDeveloperToken(
  official: OfficialDevResolution,
  daysArg: string | undefined,
  now: number,
  out: (t: string) => void,
  err: (t: string) => void,
): number {
  const days = daysArg === undefined ? SHARED_TOKEN_DEFAULT_DAYS : /^\d{1,3}$/.test(daysArg) ? Number(daysArg) : NaN;
  if (!(days >= 1 && days <= SHARED_TOKEN_MAX_DAYS)) {
    err(`--days must be a whole number from 1 to ${SHARED_TOKEN_MAX_DAYS}, not "${daysArg}".\n`);
    return 2;
  }
  if (official.status !== 'ok') {
    const e = official.error;
    err(`${[`Cannot mint a developer token: ${errorMessage(e)}`, e.hint].filter(Boolean).join('\n')}\n`);
    return 1;
  }
  if (official.dev.kind === 'env-token') {
    err(
      `${ENV.developerToken} is set, so this server signs with that token, not with a key — a token minted from some key ` +
        `could belong to a different key than the one it uses. Share that token itself (it expires ` +
        `${new Date(official.dev.expiresAt).toISOString()}), or unset ${ENV.developerToken} to mint one from ` +
        'APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY.\n',
    );
    return 1;
  }
  const { token, expiresAt } = mintSharedDeveloperToken(official.dev.key, days, now);
  rememberSecret(token);
  out(`${ENV.developerToken}=${token}\n`);
  err(
    `Apple Music developer token from key ${official.dev.key.keyId} (team ${official.dev.key.teamId}), valid until ` +
      `${new Date(expiresAt).toISOString()} (${days} day${days === 1 ? '' : 's'}). Hand the line on stdout to the person ` +
      'instead of the .p8: they run `APPLE_MUSIC_DEVELOPER_TOKEN=<token> npx apple-cloud-mcp music-auth` and get ' +
      'their own APPLE_MUSIC_USER_TOKEN for this server.\n',
  );
  return 0;
}

/**
 * Run the sign-in helper. `argv` is the arguments after `music-auth`.
 * Resolves to the process exit code (0 = token printed).
 */
export async function runMusicAuthCli(argv: string[], io: MusicAuthIo = {}): Promise<number> {
  const out = io.stdout ?? ((t: string) => void process.stdout.write(t));
  const err = io.stderr ?? ((t: string) => void process.stderr.write(t));
  const env = io.env ?? process.env;
  const now = io.now ?? Date.now;
  let noOpen = false;
  let printDev = false;
  let days: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--no-open') noOpen = true;
    else if (arg === '--print-developer-token') printDev = true;
    else if (arg === '--days' || arg.startsWith('--days=')) {
      days = arg === '--days' ? argv[++i] : arg.slice('--days='.length);
      if (days === undefined) {
        err(`--days needs a number of days.\n\n${USAGE}`);
        return 2;
      }
    } else if (arg === '--help' || arg === '-h') {
      err(USAGE);
      return 0;
    } else {
      err(`Unknown argument: ${arg}\n\n${USAGE}`);
      return 2;
    }
  }
  if (printDev && noOpen) {
    err(`--no-open does not apply to --print-developer-token.\n\n${USAGE}`);
    return 2;
  }
  if (!printDev && days !== undefined) {
    err(`--days applies only to --print-developer-token.\n\n${USAGE}`);
    return 2;
  }

  const official = resolveOfficialDev(env, now());
  if (printDev) return printDeveloperToken(official, days, now(), out, err);
  if (official.status !== 'ok') {
    const e = official.error;
    err(`${[`Cannot start Apple Music sign-in: ${errorMessage(e)}`, e.hint, official.status === 'absent' ? HOW_TO_GET_ONE : undefined].filter(Boolean).join('\n')}\n`);
    return 1;
  }
  const developerToken = official.dev.kind === 'env-token' ? official.dev.token : mintMusicDeveloperToken(official.dev.key, now()).token;
  rememberSecret(developerToken);

  const nonce = randomBytes(32).toString('base64url');
  let port = 0;
  /** One token per run: a second POST (a double click, a replay) must not print a second line. */
  let received = false;
  let finish!: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });

  const server = createServer((req, res) => {
    // The only thing that can reject is reading the body of a request the
    // browser abandoned; there is nobody left to answer.
    void handle(req, res).catch(() => res.destroy());
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = `http://127.0.0.1:${port}`;
    if (req.headers.host !== `127.0.0.1:${port}`) {
      reply(res, 421, 'text/plain; charset=utf-8', 'Wrong host.');
      return;
    }
    const path = new URL(String(req.url), origin).pathname;
    if (path === `/${nonce}/` || path === `/${nonce}`) {
      if (req.method !== 'GET') {
        reply(res, 405, 'text/plain; charset=utf-8', 'Method not allowed.', { Allow: 'GET' });
        return;
      }
      reply(res, 200, 'text/html; charset=utf-8', signInPage(developerToken, `/${nonce}/token`));
      return;
    }
    if (path !== `/${nonce}/token`) {
      reply(res, 404, 'text/plain; charset=utf-8', 'Not found.');
      return;
    }
    if (req.method !== 'POST') {
      reply(res, 405, 'text/plain; charset=utf-8', 'Method not allowed.', { Allow: 'POST' });
      return;
    }
    if (req.headers.origin !== origin) {
      reply(res, 403, 'text/plain; charset=utf-8', 'Cross-origin request refused.');
      return;
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      reply(res, 415, 'text/plain; charset=utf-8', 'Expected application/json.');
      return;
    }
    const body = await readBody(req, MAX_BODY_BYTES);
    if (body === undefined) {
      reply(res, 413, 'text/plain; charset=utf-8', 'Body too large.');
      return;
    }
    let token: unknown;
    try {
      token = (JSON.parse(body) as { token?: unknown }).token;
    } catch {
      token = undefined;
    }
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
      reply(res, 400, 'text/plain; charset=utf-8', 'No usable token in the request.');
      return;
    }
    if (received) {
      reply(res, 409, 'text/plain; charset=utf-8', 'A token was already received; this command is finishing.');
      return;
    }
    received = true;
    out(`APPLE_MUSIC_USER_TOKEN=${token}\n`);
    err('Got it. The token is on stdout; it lasts about 6 months (an Apple ID password change revokes it).\n');
    // Shut down only once the "close this tab" page has been flushed to the browser.
    res.once('finish', () => finish(0));
    reply(res, 200, 'text/html; charset=utf-8', DONE_PAGE);
  }

  try {
    port = await listen(server);
  } catch (e) {
    err(`Cannot start the local sign-in page: ${errorMessage(e)}\n`);
    return 1;
  }
  const url = `http://127.0.0.1:${port}/${nonce}/`;
  err(
    `Open this page in a browser on this computer to sign in to Apple Music (it stops in ${Math.round((io.timeoutMs ?? AUTH_TIMEOUT_MS) / 60000)} min):\n  ${url}\n`,
  );
  io.onListening?.(url);
  if (!noOpen) (io.open ?? openInBrowser)(url);

  const timer = setTimeout(() => {
    err('Timed out waiting for the Apple Music sign-in. Run the command again when ready.\n');
    finish(1);
  }, io.timeoutMs ?? AUTH_TIMEOUT_MS);
  const code = await done;
  clearTimeout(timer);
  server.close();
  server.closeAllConnections();
  return code;
}
