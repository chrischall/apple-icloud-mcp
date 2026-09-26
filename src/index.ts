#!/usr/bin/env node
import { runMcp } from '@chrischall/mcp-utils';
import { registerHealthcheckTool } from './tools/healthcheck.js';
import { VERSION } from './version.js';

// PROVISIONAL: the service registrars are wired in by the integration step.
await runMcp({
  name: 'aws-mcp',
  version: VERSION,
  tools: [(server) => registerHealthcheckTool(server, [])],
  banner: '[aws-mcp] This project was developed and is maintained by AI (Claude Code). Use at your own discretion.',
});
