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

Results from location-returning operations (`findReferences`, `goToDefinition`, `goToImplementation`, `workspaceSymbol`) are filtered to exclude `.gitignore`d files. All `lsp` tool operations target the file's active primary server. Passive diagnostics, in contrast, are collected from every active server covering the file (primary + companions) so lint/type/etc. issues from different servers can coexist. Diagnostics come from two sources: push servers (`textDocument/publishDiagnostics` notifications) and pull servers (`textDocument/diagnostic` requests fired after file sync when the server advertises `diagnosticProvider`).

When no server is configured for a file type, or the server is still starting, the tool returns a clear text message instead of an error.

### StatusLine indicator

The extension renders a passive, non-interactive LSP health indicator in Pi's footer that reflects the live runtime state of LSP servers and whether any diagnostics are currently tracked:

```
⚡LSP             — servers running, no diagnostics
⚡LSP …1          — one starting (dim)
⚡LSP ✕1          — one in error (red)
⚡LSP             — bolt is error-colored while diagnostics are present
(hidden)         — no servers are starting/running/in error
```

The bolt uses the theme's `error` color whenever one or more diagnostics are currently tracked (from the initial LSP publish until the file is edited or the diagnostic state is reset); otherwise it keeps the accent color. The count segments keep their existing semantics: `…n` for starting servers and `✕n` for servers in error.

The indicator is a live snapshot, not a `ready/total` summary: configured-but-stopped servers are not counted, and a `✕` failure clears as soon as a retry succeeds (e.g. crash auto-restart or a re-triggered tool call). The segment is hidden entirely when all tracked counts are zero so the footer stays quiet at session start.

### Slash command

Run `/lsp status` to inspect the current LSP runtime snapshot without starting any stopped servers. The command shows the manager state, server counts by lifecycle state, and per-server details including command, workspace, covered extensions, start time, restart count, and last error when present.

Run `/lsp diagnostics` to inspect every diagnostic currently tracked by the extension. The command shows pending diagnostics (waiting to be delivered to the LLM) and delivered diagnostics (already injected and tracked for cross-turn deduplication), grouped by file and tagged with severity, line/column, message, code, source, and originating server (the server name is shown when the diagnostic's `source` does not already identify it).

Run `/lsp start` to manually start or stop any configured server (including the built-in autodetected ones), and to enable manual (opt-in) servers for the current session. It opens an interactive panel listing each server with its live lifecycle state:

```
LSP servers — space to start/stop, esc to close
→ typescript   running
  eslint       running
  tailwindcss  stopped
```

Move with the arrow keys, press space to toggle the highlighted server (start when stopped/errored, stop when running), and press esc to close. The state column updates live as servers transition through `starting`/`stopping` into `running`, `stopped`, or `error`. Manual (`startupMode: "manual"`) servers are only enrolled into routing for the current session after you start them here — use `/lsp status` to see each server's `startup` mode and `manual active` flag. Requires TUI mode.

## Configuration

LSP servers are configured through a dedicated config file (separate from Pi's shared `settings.json`, to avoid key collisions with other extensions). A JSON Schema for the per-server shape is generated at `schemas/input-scoped-lsp-server-config.json`; regenerate it with `bun run --cwd packages/pi-lsp gen:schema` after changing `src/types.ts`.

The extension reads two files (project overrides global):

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
      "enabled": true,
    },
  },
}
```

### Fields

| Field                   | Required | Default                                | Description                                                                                                                       |
| ----------------------- | -------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `command`               | yes²     | —                                      | LSP server binary. Spaces only allowed for absolute paths. May be omitted when overriding or disabling a built-in recipe by name. |
| `args`                  | no       | `[]`                                   | CLI arguments for the server.                                                                                                     |
| `extensionToLanguage`   | yes¹     | —                                      | Maps file extensions (leading dot) to LSP `languageId` values.                                                                    |
| `extensions`            | no³      | —                                      | Sugar: `[".ts", ".tsx"]` → languageId is guessed via a built-in table.                                                            |
| `env`                   | no       | —                                      | Environment variables. `$VAR` and `${VAR}` are expanded from `process.env`.                                                       |
| `initializationOptions` | no       | `{}`                                   | Passed to the server during `initialize`.                                                                                         |
| `settings`              | no       | —                                      | Returned to the server from `workspace/configuration`; built-in ESLint uses defaults required by `vscode-eslint-language-server`. |
| `workspaceFolder`       | no       | session cwd                            | Overrides the workspace root sent to the server.                                                                                  |
| `startupTimeout`        | no       | `30000`                                | Max ms to wait for server initialization before treating startup as retryable failure.                                            |
| `shutdownTimeout`       | no       | `10000`                                | Max ms to wait for graceful shutdown before killing the process.                                                                  |
| `restartOnCrash`        | no       | `false`                                | Auto-restart the server when it crashes unexpectedly. Bounded by `maxRestarts`.                                                   |
| `maxRestarts`           | no       | `3`                                    | Max manual restart, crash-recovery, and retryable startup attempts.                                                               |
| `transport`             | no       | `"stdio"`                              | Accepted for compatibility; only `"stdio"` is implemented.                                                                        |
| `role`                  | no       | `"primary"`                            | `"primary"` (one per file, drives navigation) or `"companion"` (adds diagnostics alongside the primary).                          |
| `startupMode`           | no       | `"auto"`                               | `"auto"` (joins routing automatically) or `"manual"` (only after `/lsp start`).                                                   |
| `enabled`               | no       | `true`                                 | When `false`, the server is completely disabled: it is excluded from routing, diagnostics, and `/lsp status`.                     |
| `conflictGroup`         | no       | primary: server name; companion: unset | Display-only grouping label for primary replacement scenarios, surfaced in `/lsp status`. Not yet enforced at routing time.       |

¹ Either `extensionToLanguage` or `extensions` must be present; `extensionToLanguage` takes precedence.
² `command` is required for custom (non-recipe) server entries. It may be omitted when the entry shares a name with a built-in recipe and only tweaks or disables that recipe.
³ When `extensions` is used without `extensionToLanguage`, the extension guesses `languageId` from a built-in table (covers TS/JS, Python, Rust, Go, Java, C/C++, C#, and ~20 others). Unknown extensions fall back to `"plaintext"`.

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

| Recipe     | Command                         | Args      | Extensions                                                                            | Install hint                                                                                                                          |
| ---------- | ------------------------------- | --------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript | `typescript-language-server`    | `--stdio` | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`                          | `npm install -g typescript typescript-language-server`                                                                                |
| ESLint     | `vscode-eslint-language-server` | `--stdio` | `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`, `.vue`                  | `npm install -g vscode-langservers-extracted`                                                                                         |
| Python     | `pyright-langserver`            | `--stdio` | `.py`, `.pyw`                                                                         | `npm install -g pyright`                                                                                                              |
| Rust       | `rust-analyzer`                 | none      | `.rs`                                                                                 | `rustup component add rust-analyzer` (or an OS package)                                                                               |
| Go         | `gopls`                         | none      | `.go`                                                                                 | `go install golang.org/x/tools/gopls@latest`                                                                                          |
| Kotlin     | `kotlin-lsp`                    | `--stdio` | `.kt`                                                                                 | `brew install JetBrains/utils/kotlin-lsp` (or a release from https://github.com/Kotlin/kotlin-lsp, requires Java 17+)                 |
| Lua        | `lua-language-server`           | none      | `.lua`                                                                                | `pacman -S lua-language-server` / `brew install lua-language-server` (or a release from https://github.com/LuaLS/lua-language-server) |
| C/C++      | `clangd`                        | none      | `.c`, `.h`, `.cc`, `.cpp`, `.cxx`, `.c++`, `.hh`, `.hpp`, `.hxx`, `.h++`, `.m`, `.mm` | `pacman -S clang` / `brew install llvm` / `apt install clangd`                                                                        |
| Bash       | `bash-language-server`          | `start`   | `.sh`, `.bash`, `.zsh`, `.ksh`                                                        | `npm install -g bash-language-server`                                                                                                 |
| JSON       | `vscode-json-language-server`   | `--stdio` | `.json`, `.jsonc`                                                                     | `npm install -g vscode-langservers-extracted`                                                                                         |
| YAML       | `yaml-language-server`          | `--stdio` | `.yaml`, `.yml`                                                                       | `npm install -g yaml-language-server`                                                                                                 |
| HTML       | `vscode-html-language-server`   | `--stdio` | `.html`, `.htm`                                                                       | `npm install -g vscode-langservers-extracted`                                                                                         |
| CSS        | `vscode-css-language-server`    | `--stdio` | `.css`, `.scss`, `.less`                                                              | `npm install -g vscode-langservers-extracted`                                                                                         |
| Vue        | `vue-language-server`           | `--stdio` | `.vue`                                                                                | `npm install -g @vue/language-server`                                                                                                 |

User entries in `servers` are authoritative. A built-in recipe is skipped when its extensions are already covered by a user `primary` + `startupMode: "auto"` entry. Companion (`role: "companion"`) and manual (`startupMode: "manual"`) user entries do **not** suppress an auto-primary recipe, so you can layer e.g. ESLint alongside the built-in TypeScript recipe without losing navigation. Recipes still supplement uncovered languages. Invalid user entries do not disable autodetection for unrelated languages.

When a user entry uses the **same name** as a built-in recipe, it is merged on top of the recipe at the field level. This means you can override just `command` (or `args`, `env`, `settings`, etc.) while keeping the recipe's `extensionToLanguage`, `role`, `startupMode`, and other defaults. The merge precedence is **project config > global config > recipe defaults**.

When the agent edits a file or invokes the `lsp` tool for an extension covered by a recipe but the matching binary is missing on `PATH`, the extension surfaces a single non-blocking warning (`ctx.ui.notify(…, "warning")`) with an actionable install hint and includes the same hint in the tool's text output. Notifications are deduplicated per session by extension and reason.

## Multi-server routing

Each file may be served by one primary server plus zero or more companion servers.

- **Primary server (`role: "primary"`, the default).** The single server consulted for the `lsp` tool's navigation operations (definitions, references, hover, symbols, call hierarchy). When two primary servers cover the same extension, the first one registered wins; configure `conflictGroup` only when you want to make a replacement explicit.
- **Companion server (`role: "companion"`).** Receives `textDocument/didOpen`, `didChange`, `didSave`, and `didClose` notifications for files it covers, and publishes diagnostics. Companions do **not** participate in navigation requests, so adding ESLint or Tailwind never overrides TypeScript's go-to-definition.
- **Startup mode (`startupMode: "auto" | "manual"`, default `"auto"`).** Auto servers join routing on session start. Manual servers stay dormant until you enable them with `/lsp start` for the current session. Manual mode is the recommended default for broad companions such as Tailwind CSS so a global install doesn't activate in unrelated projects.

Passive diagnostics from every active server (primary + active companions) are collected and tagged by source server, so TypeScript, ESLint, and Tailwind diagnostics can coexist for the same file without overwriting each other. Stopping an `auto` server doesn't permanently disable it; it may restart on the next matching file event. Use `startupMode: "manual"` for true opt-in behavior.

### Example: override only the TypeScript command

```jsonc
{
  "servers": {
    "typescript": {
      "command": "/home/user/.local/bin/typescript-language-server",
    },
  },
}
```

Because this entry shares the recipe name `typescript`, it inherits the recipe's `extensionToLanguage`, `args`, `role`, `startupMode`, and other defaults. Only `command` is replaced.

### Example: disable a built-in recipe

```jsonc
{
  "servers": {
    "typescript": {
      "enabled": false,
    },
  },
}
```

Because this entry shares the recipe name `typescript`, it inherits the recipe defaults and then disables the server entirely. The built-in TypeScript recipe will not be loaded, and no TypeScript language server will participate in routing or diagnostics.

### Example: primary replacement with a different server name (vtsls)

```jsonc
{
  "servers": {
    "vtsls": {
      "command": "vtsls",
      "args": ["--stdio"],
      "extensionToLanguage": {
        ".ts": "typescript",
        ".tsx": "typescriptreact",
        ".js": "javascript",
        ".jsx": "javascriptreact",
      },
      "role": "primary",
      "startupMode": "auto",
      "conflictGroup": "typescript",
    },
  },
}
```

With this entry, the built-in `typescript` recipe is skipped because the user-configured server is an auto primary covering the same extensions. A different server name does **not** inherit recipe defaults, so all required fields must be supplied.

### Example: ESLint companion alongside the TypeScript primary

```jsonc
{
  "servers": {
    "eslint": {
      "command": "vscode-eslint-language-server",
      "args": ["--stdio"],
      "extensionToLanguage": {
        ".js": "javascript",
        ".jsx": "javascriptreact",
        ".ts": "typescript",
        ".tsx": "typescriptreact",
      },
      "role": "companion",
      "startupMode": "auto",
      // Optional when using the recipe name `eslint`: the built-in ESLint
      // recipe already ships defaults (validate: 'on', useFlatConfig: true,
      // workingDirectory: { mode: 'location' }) required for pull diagnostics.
      // Include a settings block only if you want to override those defaults.
      "settings": {
        "validate": "on",
        "useFlatConfig": true,
        "workingDirectory": { "mode": "location" },
      },
    },
  },
}
```

ESLint diagnostics surface alongside TypeScript diagnostics; navigation operations still target the built-in TypeScript primary. The built-in ESLint recipe also ships default `vscode-eslint-language-server` settings (e.g. `validate: 'on'`, `useFlatConfig: true`, `workingDirectory: { mode: 'location' }`) so pull diagnostics work out of the box. Because this example uses the recipe name `eslint`, the user entry would inherit those recipe defaults; if you choose a different server name, supply your own `settings` block as shown above.

### Example: Tailwind CSS manual companion

```jsonc
{
  "servers": {
    "tailwindcss": {
      "command": "tailwindcss-language-server",
      "args": ["--stdio"],
      "extensionToLanguage": {
        ".js": "javascript",
        ".jsx": "javascriptreact",
        ".ts": "typescript",
        ".tsx": "typescriptreact",
      },
      "role": "companion",
      "startupMode": "manual",
    },
  },
}
```

The Tailwind server is configured and visible in `/lsp status` but inactive until you enable it for the session via `/lsp start`.

## Logging

Logging defaults to **error level** — only errors are written. Set `PI_LSP_LOG_LEVEL=debug` to enable debug output. Logs are streamed to `~/.pi/pi-x-ide/debug.log` (never to stdout/stderr) and the directory is created on first write. Override the destination with `PI_LSP_LOG_FILE=/absolute/path/to/file`. If the file cannot be written, logging is silently disabled for the rest of the session.

## Limitations

- **`findReferences` cold start**: The extension opens files lazily. References in files the server has not indexed (e.g. outside `tsconfig.json`'s include set) may be missing on a cold start. Matching Claude Code's default, no eager workspace priming is performed.
- **Primary server selection on overlap**: If two `primary` servers list the same extension, only the first registered server is used. Use a user-defined `primary` server to replace a built-in recipe, or set `conflictGroup` to make the replacement explicit.

## Installation

The extension is published as `pi-lsp`. When installed as a Pi package, it registers the `lsp` tool and wires session lifecycle hooks automatically.

## Development

- `mise run build --package packages/pi-lsp` — Build the package
- `mise run dev --package packages/pi-lsp` — Build with sourcemaps (watch mode)
- `mise run test --package packages/pi-lsp` — Run tests
- `mise run lint` — Lint code (repo-wide)
- `mise run lint:fix` — Fix linting issues (repo-wide)
- `mise run format` — Format code with Prettier (repo-wide)
- `mise run format:check` — Check formatting with Prettier (repo-wide)
- `mise run typecheck --package packages/pi-lsp` — Run TypeScript type check

## Validation

- **Static**: `mise run typecheck --package packages/pi-lsp` (typecheck) + `hk check` (eslint + prettier)
- **Functional**: requires a real LSP server binary (`typescript-language-server`, `pyright`, etc.) in a real project — no mocks.
  - Phase 2 diagnostics fixture: `fixtures/phase2-diagnostics/README.md`
  - Phase 3 multi-server/operations: configure two servers (e.g. TypeScript + Python), verify routing, call hierarchy two-step, and gitignore filtering in a repository with `.gitignore`d files.

## Release

See [RELEASE.md](../../RELEASE.md).

## License

See [LICENSE](../../LICENSE).
