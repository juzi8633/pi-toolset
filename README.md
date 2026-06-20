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

### StatusLine indicator

The extension renders a passive, non-interactive LSP health indicator in Pi's footer that reflects the live runtime state of LSP servers:

```
LSP ⚡ 2          — two servers are running
LSP ⚡ 2 …1       — two running, one starting (dim)
LSP ⚡ 2 ✕1       — two running, one in error (red)
(hidden)        — no servers are starting/running/in error
```

The indicator is a live snapshot, not a `ready/total` summary: configured-but-stopped servers are not counted, and an `✗` failure clears as soon as a retry succeeds (e.g. crash auto-restart or a re-triggered tool call). The segment is hidden entirely when all tracked counts are zero so the footer stays quiet at session start.

### Slash command

Run `/lsp status` to inspect the current LSP runtime snapshot without starting any stopped servers. The command shows the manager state, server counts by lifecycle state, and per-server details including command, workspace, covered extensions, start time, restart count, and last error when present.

## Configuration

LSP servers are configured through a dedicated config file (separate from Pi's shared `settings.json`, to avoid key collisions with other extensions). The extension reads two files (project overrides global):

1. `~/.pi/agent/@balaenis/pi-lsp/config.json` (global)
2. `<project>/.pi/@balaenis/pi-lsp/config.json` (per-project; read using the session's working directory)

Both files use JSONC syntax (comments are allowed).

### Schema

```jsonc
{
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
| `startupTimeout`        | no       | `30000`     | Max ms to wait for server initialization before treating startup as retryable failure.                                 |
| `shutdownTimeout`       | no       | `10000`     | Max ms to wait for graceful shutdown before killing the process.                                                       |
| `restartOnCrash`        | no       | `false`     | Auto-restart the server when it crashes unexpectedly. Bounded by `maxRestarts`.                                        |
| `maxRestarts`           | no       | `3`         | Max manual restart, crash-recovery, and retryable startup attempts.                                                    |
| `transport`             | no       | `"stdio"`   | Accepted for compatibility; only `"stdio"` is implemented.                                                             |

¹ Either `extensionToLanguage` or `extensions` must be present; `extensionToLanguage` takes precedence.
² When `extensions` is used without `extensionToLanguage`, the extension guesses `languageId` from a built-in table (covers TS/JS, Python, Rust, Go, Java, C/C++, C#, and ~20 others). Unknown extensions fall back to `"plaintext"`.

### Startup failures and retries

Startup failures are split into permanent failures and retryable failures.

Permanent failures are not retried automatically because they require a configuration or environment fix:

- missing executable or invalid command/workspace path (`ENOENT`, `ENOTDIR`, `EISDIR`, `ENAMETOOLONG`)
- executable permission or format errors (`EACCES`, `EPERM`, `ENOEXEC`)
- clearly invalid CLI arguments, such as unknown options or missing option values
- clearly invalid initialization/configuration text from the server, such as invalid `initializationOptions`, invalid configuration, unsupported transport, or failed config parsing

Retryable failures are tried again on the next LSP use until the startup attempt limit is reached:

- initialization timeout (`startupTimeout`, default `30000` ms)
- early JSON-RPC connection close without a permanent error pattern
- early non-zero process exit without a permanent stderr pattern
- unknown initialization errors

`maxRestarts` also caps retryable startup attempts. With the default `maxRestarts: 3`, Pi will make at most three startup attempts for an unknown/retryable failure, then leave the server blocked with a retry-limit message. Fixing a permanent startup failure currently requires correcting the config or `PATH` and reloading/restarting the Pi session; this version does not watch config changes or expose a reset command.

### Zero-config autodetection

With no `servers` block in `config.json`, the extension scans `PATH` for the following built-in recipes and enables each one whose command is found:

| Recipe     | Command                       | Args      | Extensions                                                                            | Install hint                                                                                                                          |
| ---------- | ----------------------------- | --------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript | `typescript-language-server`  | `--stdio` | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`                          | `npm install -g typescript typescript-language-server`                                                                                |
| Python     | `pyright-langserver`          | `--stdio` | `.py`, `.pyw`                                                                         | `npm install -g pyright`                                                                                                              |
| Rust       | `rust-analyzer`               | none      | `.rs`                                                                                 | `rustup component add rust-analyzer` (or an OS package)                                                                               |
| Go         | `gopls`                       | none      | `.go`                                                                                 | `go install golang.org/x/tools/gopls@latest`                                                                                          |
| Lua        | `lua-language-server`         | none      | `.lua`                                                                                | `pacman -S lua-language-server` / `brew install lua-language-server` (or a release from https://github.com/LuaLS/lua-language-server) |
| C/C++      | `clangd`                      | none      | `.c`, `.h`, `.cc`, `.cpp`, `.cxx`, `.c++`, `.hh`, `.hpp`, `.hxx`, `.h++`, `.m`, `.mm` | `pacman -S clang` / `brew install llvm` / `apt install clangd`                                                                        |
| Bash       | `bash-language-server`        | `start`   | `.sh`, `.bash`, `.zsh`, `.ksh`                                                        | `npm install -g bash-language-server`                                                                                                 |
| JSON       | `vscode-json-language-server` | `--stdio` | `.json`, `.jsonc`                                                                     | `npm install -g vscode-langservers-extracted`                                                                                         |
| YAML       | `yaml-language-server`        | `--stdio` | `.yaml`, `.yml`                                                                       | `npm install -g yaml-language-server`                                                                                                 |
| HTML       | `vscode-html-language-server` | `--stdio` | `.html`, `.htm`                                                                       | `npm install -g vscode-langservers-extracted`                                                                                         |
| CSS        | `vscode-css-language-server`  | `--stdio` | `.css`, `.scss`, `.less`                                                              | `npm install -g vscode-langservers-extracted`                                                                                         |
| Vue        | `vue-language-server`         | `--stdio` | `.vue`                                                                                | `npm install -g @vue/language-server`                                                                                                 |

User entries in `servers` are authoritative: a built-in recipe is skipped when its server name collides with a user entry **or** when any of its extensions are already covered by a user entry. Recipes still supplement uncovered languages. Invalid user entries do not disable autodetection for unrelated languages.

When the agent edits a file or invokes the `lsp` tool for an extension covered by a recipe but the matching binary is missing on `PATH`, the extension surfaces a single non-blocking warning (`ctx.ui.notify(…, "warning")`) with an actionable install hint and includes the same hint in the tool's text output. Notifications are deduplicated per session by extension and reason.

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
