// ABOUTME: Shared types for the LSP extension.
// ABOUTME: Server lifecycle state, scoped server configuration, and tool result details.

import Type from 'typebox';

export type LspServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export const LspTransportSchema = Type.Union([Type.Literal('stdio'), Type.Literal('socket')], {
  description:
    'Transport used to talk to the LSP server. Only "stdio" is implemented; "socket" is accepted for config compatibility and ignored at runtime.',
});
export type LspTransport = Type.Static<typeof LspTransportSchema>;

export const LspServerRoleSchema = Type.Union(
  [Type.Literal('primary'), Type.Literal('companion')],
  {
    description:
      'Role of the server in multi-server routing. "primary" servers provide language understanding (navigation, hover, symbols) and at most one is consulted per file for tool requests. "companion" servers augment the primary with extra diagnostics or contextual help (e.g. lint, Tailwind CSS) and do not participate in primary-only operations.',
  }
);
export type LspServerRole = Type.Static<typeof LspServerRoleSchema>;

export const LspStartupModeSchema = Type.Union([Type.Literal('auto'), Type.Literal('manual')], {
  description:
    'Whether the server participates in routing automatically ("auto") or must be enabled per session via `/lsp start` ("manual").',
});
export type LspStartupMode = Type.Static<typeof LspStartupModeSchema>;

export const ScopedLspServerConfigSchema = Type.Object({
  command: Type.String({
    description: 'Executable used to launch the LSP server process.',
  }),
  args: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Arguments passed to the server executable.',
    })
  ),
  extensionToLanguage: Type.Record(Type.String(), Type.String(), {
    description:
      'Map from file extension (e.g. ".ts") to an LSP languageId (e.g. "typescript"). Single source of truth for both extension routing and the `languageId` sent in `textDocument/didOpen`.',
  }),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: 'Environment variables added to the spawned server process.',
    })
  ),
  initializationOptions: Type.Optional(
    Type.Unknown({
      description: 'Value forwarded as `initializationOptions` in the LSP `initialize` request.',
    })
  ),
  settings: Type.Optional(
    Type.Unknown({
      description: 'Server settings returned in response to `workspace/configuration` requests.',
    })
  ),
  workspaceFolder: Type.Optional(
    Type.String({
      description:
        'Override the workspace root reported to the server. Defaults to the current working directory.',
    })
  ),
  startupTimeout: Type.Optional(
    Type.Number({
      description: 'Maximum time in milliseconds to wait for the server to finish initializing.',
    })
  ),
  shutdownTimeout: Type.Optional(
    Type.Number({
      description: 'Graceful shutdown timeout in milliseconds. Defaults to no timeout.',
    })
  ),
  restartOnCrash: Type.Optional(
    Type.Boolean({
      description: 'Auto-restart the server when it crashes. Defaults to false.',
    })
  ),
  maxRestarts: Type.Optional(
    Type.Number({
      description: 'Maximum number of automatic restart attempts when `restartOnCrash` is enabled.',
    })
  ),
  transport: Type.Optional(LspTransportSchema),
  role: Type.Optional(LspServerRoleSchema),
  startupMode: Type.Optional(LspStartupModeSchema),
  enabled: Type.Optional(
    Type.Boolean({
      description:
        'When false, the server is disabled and excluded from routing entirely. Defaults to true.',
    })
  ),
  conflictGroup: Type.Optional(
    Type.String({
      description:
        'Grouping key for primary replacement scenarios (e.g. two TS-like servers should not both fire). Defaults to the server name for primary servers and is undefined for companions.',
    })
  ),
});

export type ScopedLspServerConfig = Type.Static<typeof ScopedLspServerConfigSchema>;

export const InputScopedLspServerConfigSchema = Type.Object({
  ...ScopedLspServerConfigSchema.properties,
  command: Type.Optional(
    Type.String({
      description:
        'Executable used to launch the LSP server process. May be omitted when a user entry only tweaks or disables a built-in recipe by name; runtime validation catches non-recipe entries.',
    })
  ),
  extensionToLanguage: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        'Map from file extension (e.g. ".ts") to an LSP languageId (e.g. "typescript"). Optional on input; merged with a built-in recipe when extending one.',
    })
  ),
  extensions: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Shorthand list of file extensions to attach the server to, using each extension as its own languageId. Merged with `extensionToLanguage` when both are present.',
    })
  ),
});

export type InputScopedLspServerConfig = Type.Static<typeof InputScopedLspServerConfigSchema>;

export interface LspToolDetails {
  operation: string;
  filePath: string;
  resultCount?: number;
  fileCount?: number;
  truncated?: boolean;
  ready?: boolean;
}
