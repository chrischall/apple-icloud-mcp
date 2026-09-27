import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { versionSyncTest } from '@chrischall/mcp-utils/test';
import { VERSION } from '../src/version.js';

const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

describe('version sync', () => {
  it('every x-release-please-version literal under src/ matches package.json', () => {
    expect(versionSyncTest({ srcDir: root('src'), pkgPath: root('package.json') })).toEqual([]);
  });

  it('the server reports the package version', () => {
    const pkg = JSON.parse(readFileSync(root('package.json'), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
