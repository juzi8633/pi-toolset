// ABOUTME: Shared types for the LSP extension.
// ABOUTME: Server lifecycle state, scoped server configuration, and tool result details.

import Type from 'typebox';

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
/**
 * Transport for talking to an LSP server. Only stdio is implemented; socket is
 * accepted for config compatibility and ignored at runtime.
 */
export const LspTransportSchema = Type.Union([Type.Literal('stdio'), Type.Literal('socket')]);
export type LspTransport = Type.Static<typeof LspTransportSchema>;

/**
 * Role of an LSP server in multi-server routing.
 *
 * `primary` servers provide language understanding (navigation, hover, symbols)
 * and at most one is consulted per file for tool requests. `companion` servers
 * augment the primary with additional diagnostics or contextual help (e.g.
 * lint, Tailwind CSS) and do not participate in primary-only operations.
 */
export const LspServerRoleSchema = Type.Union([Type.Literal('primary'), Type.Literal('companion')]);
export type LspServerRole = Type.Static<typeof LspServerRoleSchema>;

/**
 * Whether a server participates automatically in routing or must be enabled
 * per session via `/lsp start`.
 */
export const LspStartupModeSchema = Type.Union([Type.Literal('auto'), Type.Literal('manual')]);
export type LspStartupMode = Type.Static<typeof LspStartupModeSchema>;

export const ScopedLspServerConfigSchema = Type.Object({
  command: Type.String(),
  args: Type.Optional(Type.Array(Type.String())),
  extensionToLanguage: Type.Record(Type.String(), Type.String()),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  initializationOptions: Type.Optional(Type.Unknown()),
  /** Server settings returned from workspace/configuration (optional). */
  settings: Type.Optional(Type.Unknown()),
  workspaceFolder: Type.Optional(Type.String()),
  startupTimeout: Type.Optional(Type.Number()),
  /** Graceful shutdown timeout in ms. Optional; defaults to no timeout. */
  shutdownTimeout: Type.Optional(Type.Number()),
  /** Auto-restart the server when it crashes. Optional; defaults to false. */
  restartOnCrash: Type.Optional(Type.Boolean()),
  maxRestarts: Type.Optional(Type.Number()),
  /** Accepted for compatibility; only 'stdio' is implemented. */
  transport: Type.Optional(LspTransportSchema),
  /** Server role in multi-server routing. Defaults to 'primary'. */
  role: Type.Optional(LspServerRoleSchema),
  /** Whether to participate in automatic routing. Defaults to 'auto'. */
  startupMode: Type.Optional(LspStartupModeSchema),
  /** When false, the server is disabled and excluded from routing entirely. Defaults to true. */
  enabled: Type.Optional(Type.Boolean()),
  /**
   * Optional grouping key for primary replacement scenarios (e.g. two TS-like
   * servers should not both fire). Defaults to the server name for primary
   * servers and is undefined for companions.
   */
  conflictGroup: Type.Optional(Type.String()),
});

export type ScopedLspServerConfig = Type.Static<typeof ScopedLspServerConfigSchema>;

export const InputScopedLspServerConfigSchema = Type.Object({
  ...ScopedLspServerConfigSchema.properties,
  // `command` may be omitted when a user entry only tweaks or disables a
  // built-in recipe by name; runtime validation catches non-recipe entries.
  command: Type.Optional(Type.String()),
  extensionToLanguage: Type.Optional(Type.Record(Type.String(), Type.String())),
  extensions: Type.Optional(Type.Array(Type.String())),
});

export type InputScopedLspServerConfig = Type.Static<typeof InputScopedLspServerConfigSchema>;

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
