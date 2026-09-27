import { beforeAll, describe, expect, it } from 'vitest';
import { execSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// End-to-end boot guard: spawn the REAL built artifacts and confirm they answer
// initialize + tools/list — what an MCP host (and fleet CI, with `env -i`)
// does at install time. Catches an eager-import crash in the bundle (which
// ships no node_modules), a config read at import, a wrong `bin`, and anything
// that writes to stdout outside JSON-RPC.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'dist', 'bundle.js');
const BIN = join(ROOT, 'dist', 'index.js');

beforeAll(() => {
  if (!existsSync(BUNDLE) || !existsSync(BIN)) execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
}, 180_000);

function listToolsViaStdio(entry: string, cwd: string, home: string): Promise<{ tools: string[]; stdout: string }> {
  return new Promise((resolve, reject) => {
    // A near-empty environment: no Apple credentials at all.
    const child = spawn(process.execPath, [entry], {
      cwd,
      env: { PATH: process.env.PATH ?? '', HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out; stderr:\n${err}`));
    }, 20_000);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      for (const line of out.split('\n')) {
        let msg: { id?: number; result?: { tools?: { name: string }[] } };
        try {
          msg = JSON.parse(line.trim()) as typeof msg;
        } catch {
          continue;
        }
        if (msg.id === 1 && msg.result) {
          clearTimeout(timer);
          child.kill('SIGKILL');
          resolve({ tools: (msg.result.tools ?? []).map((t) => t.name), stdout: out });
          return;
        }
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (!out.includes('"id":1')) {
        clearTimeout(timer);
        reject(new Error(`server exited (code ${code}) before tools/list; stderr:\n${err}`));
      }
    });
    child.stdin.write(
      '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"boot-test","version":"1"}}}\n',
    );
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  });
}

function assertOnlyJsonOnStdout(stdout: string): void {
  for (const line of stdout.split('\n').filter((l) => l.trim())) {
    expect(() => JSON.parse(line), `non-JSON on stdout: ${line.slice(0, 200)}`).not.toThrow();
  }
}

const MIN_TOOLS = 50;

describe('server boot (built artifacts)', () => {
  it('the .mcpb bundle (dist/bundle.js) boots with no node_modules and no credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aws-mcp-bundle-'));
    try {
      copyFileSync(BUNDLE, join(dir, 'bundle.js'));
      const { tools, stdout } = await listToolsViaStdio(join(dir, 'bundle.js'), dir, dir);
      expect(tools.length).toBeGreaterThanOrEqual(MIN_TOOLS);
      expect(tools).toContain('apple_healthcheck');
      expect(tools).toContain('apple_music_create_playlist');
      assertOnlyJsonOnStdout(stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  it('the npm bin (dist/index.js) boots with no credentials', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aws-mcp-home-'));
    try {
      const { tools, stdout } = await listToolsViaStdio(BIN, ROOT, home);
      expect(tools.length).toBeGreaterThanOrEqual(MIN_TOOLS);
      assertOnlyJsonOnStdout(stdout);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);
});
