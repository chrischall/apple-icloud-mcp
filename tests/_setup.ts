// Suite-wide hermeticity guards. Every test starts from the same blank
// environment and a network that refuses to be used.
//
//  - Apple/iCloud/config variables from the developer's shell are removed, so
//    a real APPLE_PRIVATE_KEY or ICLOUD_APP_PASSWORD can never change an
//    outcome (or be sent anywhere).
//  - MCP_DATA_DIR is pinned to a temp dir, so the on-disk caches (src/state.ts)
//    can never touch the real home directory.
//  - `fetch` is stubbed to THROW: a test that forgets to mock the network
//    fails loudly instead of calling Apple. A test mocks it with
//    `vi.stubGlobal('fetch', vi.fn(...))`.
//  - Retry sleeps are instant.
import { afterAll, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetSecrets } from '../src/errors.js';
import { resetConfigWarnings } from '../src/config.js';
import { setSleepForTests } from '../src/http.js';
import { resetICloudLatch } from '../src/icloud-auth.js';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'apple-icloud-mcp-test-'));
const homeStateExisted = existsSync(join(homedir(), '.apple-icloud-mcp'));

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (/^(APPLE_|ICLOUD_|MCP_CONFIRM_|MCP_HOST_CONFIRM_)/.test(key) || key === 'DISPLAY_TZ') delete process.env[key];
  }
  process.env.MCP_DATA_DIR = DATA_DIR;
  forgetSecrets();
  resetICloudLatch();
  resetConfigWarnings();
  setSleepForTests(() => Promise.resolve());
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      throw new Error(`Unexpected network call in a test: ${String(input)}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  const leaked = join(homedir(), '.apple-icloud-mcp');
  if (!homeStateExisted && existsSync(leaked)) {
    rmSync(leaked, { recursive: true, force: true });
    throw new Error(`A test wrote to ${leaked}; tests must only use the temp MCP_DATA_DIR.`);
  }
});
