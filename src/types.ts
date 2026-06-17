// ABOUTME: Shared types for the LSP extension.
// ABOUTME: Server lifecycle state, scoped server configuration, and tool result details.

/**
 * Lifecycle state of a single LSP server instance.
 */
export type LspServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

/**
 * Resolved configuration for a single LSP server.
 *
 * `extensionToLanguage` maps a file extension (e.g. ".ts") to an LSP languageId
 * (e.g. "typescript"); it is the single source of truth for both extension
 * routing and the `languageId` sent in `textDocument/didOpen`.
 */
export interface ScopedLspServerConfig {
  command: string;
  args?: string[];
  extensionToLanguage: Record<string, string>;
  env?: Record<string, string>;
  initializationOptions?: unknown;
  workspaceFolder?: string;
  startupTimeout?: number;
  maxRestarts?: number;
}

/**
 * Structured details attached to an `lsp` tool result.
 */
export interface LspToolDetails {
  operation: string;
  filePath: string;
  resultCount?: number;
  fileCount?: number;
  truncated?: boolean;
  ready?: boolean;
}
