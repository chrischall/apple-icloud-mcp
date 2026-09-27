import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8'));
const text = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');

describe('packaging', () => {
  it('keeps the server.json description within the MCP Registry limit (100 chars → 422 otherwise)', () => {
    expect(read('server.json').description.length).toBeLessThanOrEqual(100);
  });

  it('publishes the scoped npm identity while the registry name follows the repo', () => {
    const server = read('server.json');
    const pkg = read('package.json');
    expect(pkg.name).toBe('@chrischall/aws-mcp');
    expect(pkg.mcpName).toBe('io.github.chrischall/aws-mcp');
    expect(server.name).toBe(pkg.mcpName);
    expect(pkg.publishConfig?.access).toBe('public');
    for (const p of server.packages) expect(p.identifier).toBe(pkg.name);
  });

  it('keeps the bin unscoped', () => {
    expect(Object.keys(read('package.json').bin)).toEqual(['aws-mcp']);
  });

  it('ships mint.yaml (mcp-host reads it from the published package)', () => {
    expect(read('package.json').files).toContain('mint.yaml');
  });

  it('keeps every version-bearing file on one version', () => {
    const v = read('package.json').version;
    const server = read('server.json');
    const market = read('.claude-plugin/marketplace.json');
    expect(read('manifest.json').version).toBe(v);
    expect(server.version).toBe(v);
    for (const p of server.packages) expect(p.version).toBe(v);
    expect(read('.claude-plugin/plugin.json').version).toBe(v);
    expect(market.metadata.version).toBe(v);
    for (const p of market.plugins) expect(p.version).toBe(v);
    expect(read('.release-please-manifest.json')['.']).toBe(v);
  });

  it('never uses the AWS_ environment prefix (that namespace belongs to the Amazon SDK)', () => {
    for (const f of ['server.json', 'manifest.json', 'mint.yaml', '.env.example', '.mcp.json']) {
      expect(text(f)).not.toMatch(/\bAWS_[A-Z]/);
    }
  });

  it('lists only lowercase hosts in the mint.yaml egress allowlist, with the wildcard quoted', () => {
    const yaml = text('mint.yaml');
    const allow = yaml.slice(yaml.indexOf('egress:'));
    expect(allow).toContain('"*.icloud.com"');
    expect(allow).toBe(allow.toLowerCase());
  });
});
