import type { McpServer } from '@modelcontextprotocol/server';
import { clientGetter, type MusicDeps } from './common.js';
import { registerCatalogTools } from './tools-catalog.js';
import { registerExtendedTools } from './tools-extended.js';
import { registerLibraryReadTools } from './tools-library.js';
import { registerLibraryWriteTools } from './tools-write.js';

export type { MusicDeps } from './common.js';

/**
 * Register every Apple Music tool. Registration does no I/O and reads no
 * credentials: each handler resolves its backend (official / web) from the
 * environment when it is called, so the full tool list is served even with
 * an empty environment. Which tools exist is decided by `defineTool`
 * (APPLE_SERVICES and APPLE_WRITE_MODE).
 */
export function registerMusicTools(server: McpServer, deps?: MusicDeps): void {
  const client = clientGetter(deps);
  registerCatalogTools(server, client);
  registerLibraryReadTools(server, client);
  registerLibraryWriteTools(server, client);
  registerExtendedTools(server, client);
}
