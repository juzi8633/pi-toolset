# pi-lsp

Language Server Protocol support for Pi's coding agent. Provides code intelligence operations (go-to-definition, find-references, hover, document/workspace symbols, call hierarchy, go-to-implementation) via the `lsp` tool.

## Usage

Once the extension is installed, the agent gains access to the `lsp` tool. All nine operations require `filePath`, `line` (1-based), and `character` (1-based) — `documentSymbol` and `workspaceSymbol` accept them for schema compatibility but do not send a position to the LSP request.

| Operation              | Description                                          |
| ---------------------- | ---------------------------------------------------- |
| `goToDefinition`       | Find where a symbol is defined                       |
| `findReferences`       | Find all references to a symbol                      |
| `hover`                | Get type signature and documentation for a symbol    |
| `documentSymbol`       | List all symbols in a document                       |
| `workspaceSymbol`      | Search the server's workspace for symbols            |
| `goToImplementation`   | Find implementations of an interface/abstract method |
| `prepareCallHierarchy` | Get the call hierarchy item at a position            |
| `incomingCalls`        | Find functions that call the target (two-step)       |
| `outgoingCalls`        | Find functions called by the target (two-step)       |

Results from location-returning operations (`findReferences`, `goToDefinition`, `goToImplementation`, `workspaceSymbol`) are filtered to exclude `.gitignore`d files.

When no server is configured for a file type, or the server is still starting, the tool returns a clear text message instead of an error.

## Configuration

LSP servers are configured through Pi's `settings.json`. The extension reads two files (project overrides global):

1. `~/.pi/agent/settings.json` (global)
2. `<project>/.pi/settings.json` (per-project; read using the session's working directory)

Both files use JSONC syntax (comments are allowed).

### Schema

```jsonc
{
  "lsp": {
    "servers": {
      "<server-name>": {
        "command": "typescript-language-server",
        "args": ["--stdio"],
        "extensionToLanguage": {
          ".ts": "typescript",
          ".tsx": "typescriptreact",
          ".js": "javascript",
        },
        // optional fields below
        "extensions": [".ts", ".tsx"],
        "env": { "PATH": "/custom/bin:${PATH}" },
        "initializationOptions": {},
        "settings": {},
        "workspaceFolder": "/path/to/root",
        "startupTimeout": 10000,
        "shutdownTimeout": 5000,
        "restartOnCrash": false,
        "maxRestarts": 3,
        "transport": "stdio",
      },
    },
  },
}
```

### Fields

| Field                   | Required | Default     | Description                                                                                                            |
| ----------------------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `command`               | yes      | —           | LSP server binary. Spaces only allowed for absolute paths.                                                             |
| `args`                  | no       | `[]`        | CLI arguments for the server.                                                                                          |
| `extensionToLanguage`   | yes¹     | —           | Maps file extensions (leading dot) to LSP `languageId` values.                                                         |
| `extensions`            | no²      | —           | Sugar: `[".ts", ".tsx"]` → languageId is guessed via a built-in table.                                                 |
| `env`                   | no       | —           | Environment variables. `$VAR` and `${VAR}` are expanded from `process.env`.                                            |
| `initializationOptions` | no       | `{}`        | Passed to the server during `initialize`.                                                                              |
| `settings`              | no       | —           | Accepted for schema compatibility; **not delivered to the server** yet. See [optimization note](#future-optimization). |
| `workspaceFolder`       | no       | session cwd | Overrides the workspace root sent to the server.                                                                       |
| `startupTimeout`        | no       | no timeout  | Max ms to wait for server startup.                                                                                     |
| `shutdownTimeout`       | no       | no timeout  | Max ms to wait for graceful shutdown before killing the process.                                                       |
| `restartOnCrash`        | no       | `false`     | Auto-restart the server when it crashes unexpectedly. Bounded by `maxRestarts`.                                        |
| `maxRestarts`           | no       | `3`         | Max restart attempts (both manual and crash-recovery).                                                                 |
| `transport`             | no       | `"stdio"`   | Accepted for compatibility; only `"stdio"` is implemented.                                                             |

¹ Either `extensionToLanguage` or `extensions` must be present; `extensionToLanguage` takes precedence.
² When `extensions` is used without `extensionToLanguage`, the extension guesses `languageId` from a built-in table (covers TS/JS, Python, Rust, Go, Java, C/C++, C#, and ~20 others). Unknown extensions fall back to `"plaintext"`.

### Default server

When no `lsp.servers` are configured (or all entries are invalid), the extension falls back to a hardcoded `typescript-language-server` entry that covers `.ts` / `.tsx` / `.js` / `.jsx` / `.mjs` / `.cjs` / `.mts` / `.cts`.

## Limitations

- **`findReferences` cold start**: The extension opens files lazily. References in files the server has not indexed (e.g. outside `tsconfig.json`'s include set) may be missing on a cold start. Matching Claude Code's default, no eager workspace priming is performed.
- **Single server per extension**: If multiple servers list the same extension, only the first registered server is used.

### Future optimization

`settings` in the server config is accepted for schema compatibility but is not delivered to the LSP server. Claude Code has the same gap (schema describes `workspace/didChangeConfiguration` but the implementation answers `workspace/configuration` with `null` and never pushes settings). A future version may send `workspace/didChangeConfiguration` after initialization.

## Installation

The extension is published as `pi-lsp`. When installed as a Pi package, it registers the `lsp` tool and wires session lifecycle hooks automatically.

## Development

- `mise run build` — Build the module
- `mise run dev` — Watch mode
- `mise run test` — Run tests
- `mise run lint` — Lint code
- `mise run lint:fix` — Fix linting issues
- `mise run format` — Format code with Prettier
- `mise run format:check` — Check formatting with Prettier
- `mise run typecheck` - Run TypeScript type check

## Validation

- **Static**: `mise run typecheck` (typecheck) + `hk check` (eslint + prettier)
- **Functional**: requires a real LSP server binary (`typescript-language-server`, `pyright`, etc.) in a real project — no mocks.
  - Phase 2 diagnostics fixture: `fixtures/phase2-diagnostics/README.md`
  - Phase 3 multi-server/operations: configure two servers (e.g. TypeScript + Python), verify routing, call hierarchy two-step, and gitignore filtering in a repository with `.gitignore`d files.

## Release

See [RELEASE.md](RELEASE.md).

## License

See [LICENSE](LICENSE).
