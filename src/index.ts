#!/usr/bin/env node
import { loadDotenvSafely, runMcp } from '@chrischall/mcp-utils';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.js';

// A local checkout's .env (real env vars win). Silently skipped when dotenv is
// absent, e.g. inside the .mcpb bundle, which ships no node_modules.
try {
  await loadDotenvSafely({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') });
} catch {
  // no .env — nothing to load
}

// `npx apple-cloud-mcp music-auth` — the one-time browser sign-in that
// mints an Apple Music user token. A CLI, not the MCP server: it prints the
// token on stdout and exits.
if (process.argv[2] === 'music-auth') {
  const { runMusicAuthCli } = await import('./music/auth-cli.js');
  process.exit(await runMusicAuthCli(process.argv.slice(3)));
}

const { REGISTRARS } = await import('./registry.js');

await runMcp({
  name: 'apple-cloud-mcp',
  version: VERSION,
  tools: [...REGISTRARS],
  banner: '[apple-cloud-mcp] This project was developed and is maintained by AI (Claude Code). Use at your own discretion.',
});
