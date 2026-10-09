import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/server';
import { HEALTH_PROBES, REGISTRARS } from '../src/registry.js';
import { SERVICES } from '../src/config.js';

/**
 * `manifest.json`'s tool roster must equal the REGISTERED roster, both ways.
 *
 * It is the file an mcpb host reads to decide what to show: a tool missing
 * from it is callable and invisible, a tool listed but not registered is
 * advertised and then fails. Nothing else reads it, so drift is silent in
 * both directions. The roster is read by REGISTERING (not by grepping
 * source), in the mode that registers everything.
 */
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../manifest.json', import.meta.url)), 'utf8')) as {
  tools: { name: string; description?: string }[];
};

interface Captured {
  name: string;
  description: string;
  annotations: Record<string, unknown>;
}

function registered(env: Record<string, string> = {}): Captured[] {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const out: Captured[] = [];
    const server = {
      registerTool: (name: string, cfg: { description: string; annotations: Record<string, unknown> }) =>
        void out.push({ name, description: cfg.description, annotations: cfg.annotations }),
    } as unknown as McpServer;
    for (const r of REGISTRARS) r(server);
    return out;
  } finally {
    process.env = saved;
  }
}

describe('manifest.json tool roster', () => {
  it('lists exactly the registered tools', () => {
    const names = registered().map((t) => t.name).sort();
    expect(manifest.tools.map((t) => t.name).sort()).toEqual(names);
  });

  it('gives every entry a non-blank description', () => {
    expect(manifest.tools.filter((t) => !t.description?.trim()).map((t) => t.name)).toEqual([]);
  });

  it('registers every tool with an EMPTY environment (CI boots the bundle with env -i)', () => {
    expect(registered().length).toBeGreaterThan(50);
  });

  it('names every tool apple_<service>_… or apple_healthcheck, with no duplicates', () => {
    const names = registered().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^apple_(healthcheck|(music|calendar|contacts|mail|maps|weather|itunes|charts)_[a-z_]+)$/);
  });

  it('annotates every tool explicitly (an unannotated tool is published as destructive)', () => {
    for (const t of registered()) {
      expect(typeof t.annotations.readOnlyHint, t.name).toBe('boolean');
      if (t.annotations.readOnlyHint === false) expect(typeof t.annotations.destructiveHint, t.name).toBe('boolean');
    }
  });

  it('never lets a read claim to destroy, and declares openWorldHint on every tool', () => {
    for (const t of registered()) {
      if (t.annotations.readOnlyHint === true) expect(t.annotations.destructiveHint, t.name).not.toBe(true);
      expect(typeof t.annotations.openWorldHint, t.name).toBe('boolean');
    }
  });

  it('marks apple_calendar_create_event destructive when it can email invitations, additive when it cannot', () => {
    // APPLE_WRITE_MODE=all accepts attendees, and iCloud emails each one an
    // invitation: that reaches another person, and apple_calendar_delete_event
    // cannot un-send it. APPLE_WRITE_MODE=additive refuses attendees (and
    // shared calendars), so there the create is a plain, deletable addition.
    const find = (env: Record<string, string>) => registered(env).find((t) => t.name === 'apple_calendar_create_event');
    expect(find({})?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
    expect(find({ APPLE_WRITE_MODE: 'additive' })?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('registers only read tools in APPLE_WRITE_MODE=none', () => {
    const tools = registered({ APPLE_WRITE_MODE: 'none' });
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.filter((t) => t.annotations.readOnlyHint !== true).map((t) => t.name)).toEqual([]);
  });

  it('never registers a send or remove tool in APPLE_WRITE_MODE=additive', () => {
    const tools = registered({ APPLE_WRITE_MODE: 'additive' });
    expect(tools.filter((t) => t.annotations.destructiveHint === true).map((t) => t.name)).toEqual([]);
  });

  it('APPLE_SERVICES narrows registration to the named services (plus the healthcheck)', () => {
    const names = registered({ APPLE_SERVICES: 'weather' }).map((t) => t.name);
    expect(names.every((n) => n === 'apple_healthcheck' || n.startsWith('apple_weather_'))).toBe(true);
    expect(names).toContain('apple_weather_get');
  });

  it('wires a health probe for every service', () => {
    expect(HEALTH_PROBES.map((p) => p.service).sort()).toEqual([...SERVICES].sort());
  });
});
