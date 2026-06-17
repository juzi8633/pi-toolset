// ABOUTME: LSP server configuration source.
// ABOUTME: Phase 1 returns a hardcoded typescript-language-server config; Phase 3 will read settings.json.

import type { ScopedLspServerConfig } from './types.ts';

/**
 * Get all configured LSP servers.
 *
 * Phase 1 hardcodes a single typescript-language-server entry. The return shape
 * mirrors the eventual settings.json-backed loader so callers do not change when
 * the config source is swapped in Phase 3.
 */
export function getAllLspServers(): {
  servers: Record<string, ScopedLspServerConfig>;
} {
  return {
    servers: {
      typescript: {
        command: 'typescript-language-server',
        args: ['--stdio'],
        extensionToLanguage: {
          '.ts': 'typescript',
          '.tsx': 'typescriptreact',
          '.js': 'javascript',
          '.jsx': 'javascriptreact',
          '.mjs': 'javascript',
          '.cjs': 'javascript',
          '.mts': 'typescript',
          '.cts': 'typescript',
        },
        startupTimeout: 10000,
        maxRestarts: 3,
      },
    },
  };
}
