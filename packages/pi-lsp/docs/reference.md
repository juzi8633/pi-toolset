# Reference

Technical lookup for `@balaenis/pi-lsp`.

## `lsp` tool operations

All operations require `filePath`, `line` (1-based), and `character` (1-based).
`documentSymbol` and `workspaceSymbol` accept them for schema compatibility but
do not send a position.

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

Location-returning operations (`findReferences`, `goToDefinition`,
`goToImplementation`, `workspaceSymbol`) are filtered to exclude `.gitignore`d
files. All `lsp` operations target the file's primary server. Passive
diagnostics are collected from every configured server covering the file (primary +
companions).

## Config file locations

- Global: `~/.pi/agent/@balaenis/pi-lsp/config.json`
- Project: `<project>/.pi/@balaenis/pi-lsp/config.json` (project overrides global)

Both use JSONC syntax. A JSON Schema for the whole config is generated at
`schemas/pi-lsp-config.json`; regenerate it with
`bun run --cwd packages/pi-lsp gen:schema` after changing `src/types.ts`.

## Config schema

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

## Config fields

| Field                   | Required | Default                                | Description                                                                                                                       |
| ----------------------- | -------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `command`               | yes²     | -                                      | LSP server binary. Spaces only allowed for absolute paths. May be omitted when overriding/disabling a built-in recipe by name.    |
| `args`                  | no       | `[]`                                   | CLI arguments for the server.                                                                                                     |
| `extensionToLanguage`   | yes¹     | -                                      | Maps file extensions (leading dot) to LSP `languageId` values.                                                                    |
| `extensions`            | no³      | -                                      | Sugar: `[".ts", ".tsx"]` -> `languageId` guessed via a built-in table.                                                            |
| `env`                   | no       | -                                      | Environment variables. `$VAR` and `${VAR}` expanded from `process.env`.                                                           |
| `initializationOptions` | no       | `{}`                                   | Passed to the server during `initialize`.                                                                                         |
| `settings`              | no       | -                                      | Returned to the server from `workspace/configuration`; built-in ESLint uses defaults required by `vscode-eslint-language-server`. |
| `workspaceFolder`       | no       | session cwd                            | Overrides the workspace root sent to the server.                                                                                  |
| `startupTimeout`        | no       | `30000`                                | Max ms to wait for initialization before treating startup as retryable failure.                                                   |
| `shutdownTimeout`       | no       | `10000`                                | Max ms to wait for graceful shutdown before killing the process.                                                                  |
| `restartOnCrash`        | no       | `false`                                | Auto-restart the server when it crashes unexpectedly. Bounded by `maxRestarts`.                                                   |
| `maxRestarts`           | no       | `3`                                    | Max manual restart, crash-recovery, and retryable startup attempts.                                                               |
| `transport`             | no       | `"stdio"`                              | Accepted for compatibility; only `"stdio"` is implemented.                                                                        |
| `role`                  | no       | `"primary"`                            | `"primary"` (one per file, drives navigation) or `"companion"` (adds diagnostics alongside the primary).                          |
| `enabled`               | no       | `true`                                 | When `false`, the server is completely disabled: excluded from routing, diagnostics, and `/lsp status`.                           |
| `conflictGroup`         | no       | primary: server name; companion: unset | Display-only grouping label for primary replacement scenarios, surfaced in `/lsp status`. Not yet enforced at routing time.       |

¹ Either `extensionToLanguage` or `extensions` must be present;
`extensionToLanguage` takes precedence.
² `command` is required for custom (non-recipe) entries. It may be omitted when
the entry shares a name with a built-in recipe and only tweaks or disables it.
³ When `extensions` is used without `extensionToLanguage`, the extension guesses
`languageId` from a built-in table (covers TS/JS, Python, Rust, Go, Java, C/C++,
C#, and ~20 others). Unknown extensions fall back to `"plaintext"`.

## Built-in recipes

With no `servers` block, the extension scans `PATH` and adds each **enabled**
recipe whose command is found. Detected recipes join routing immediately.
Recipes with `enabled: false` (currently Tailwind CSS) stay off until a user
config sets `enabled: true`.

| Recipe       | Command                         | Args      | Extensions                                                                                                                                                   | Install hint                                                                                                                          |
| ------------ | ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript   | `typescript-language-server`    | `--stdio` | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`                                                                                                 | `npm install -g typescript typescript-language-server`                                                                                |
| ESLint       | `vscode-eslint-language-server` | `--stdio` | `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`, `.vue`                                                                                         | `npm install -g vscode-langservers-extracted`                                                                                         |
| Tailwind CSS | `tailwindcss-language-server`   | `--stdio` | `.html`, `.htm`, `.css`, `.scss`, `.sass`, `.less`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`, `.vue`, `.svelte`, `.astro`, `.md`, `.mdx` | `npm install -g @tailwindcss/language-server`                                                                                         |
| Python       | `pyright-langserver`            | `--stdio` | `.py`, `.pyw`                                                                                                                                                | `npm install -g pyright`                                                                                                              |
| Rust         | `rust-analyzer`                 | none      | `.rs`                                                                                                                                                        | `rustup component add rust-analyzer` (or an OS package)                                                                               |
| Go           | `gopls`                         | none      | `.go`                                                                                                                                                        | `go install golang.org/x/tools/gopls@latest`                                                                                          |
| Kotlin       | `kotlin-lsp`                    | `--stdio` | `.kt`                                                                                                                                                        | `brew install JetBrains/utils/kotlin-lsp` (or a release from https://github.com/Kotlin/kotlin-lsp, requires Java 17+)                 |
| Lua          | `lua-language-server`           | none      | `.lua`                                                                                                                                                       | `pacman -S lua-language-server` / `brew install lua-language-server` (or a release from https://github.com/LuaLS/lua-language-server) |
| C/C++        | `clangd`                        | none      | `.c`, `.h`, `.cc`, `.cpp`, `.cxx`, `.c++`, `.hh`, `.hpp`, `.hxx`, `.h++`, `.m`, `.mm`                                                                        | `pacman -S clang` / `brew install llvm` / `apt install clangd`                                                                        |
| Bash         | `bash-language-server`          | `start`   | `.sh`, `.bash`, `.zsh`, `.ksh`                                                                                                                               | `npm install -g bash-language-server`                                                                                                 |
| JSON         | `vscode-json-language-server`   | `--stdio` | `.json`, `.jsonc`                                                                                                                                            | `npm install -g vscode-langservers-extracted`                                                                                         |
| YAML         | `yaml-language-server`          | `--stdio` | `.yaml`, `.yml`                                                                                                                                              | `npm install -g yaml-language-server`                                                                                                 |
| HTML         | `vscode-html-language-server`   | `--stdio` | `.html`, `.htm`                                                                                                                                              | `npm install -g vscode-langservers-extracted`                                                                                         |
| CSS          | `vscode-css-language-server`    | `--stdio` | `.css`, `.scss`, `.less`                                                                                                                                     | `npm install -g vscode-langservers-extracted`                                                                                         |
| Vue          | `vue-language-server`           | `--stdio` | `.vue`                                                                                                                                                       | `npm install -g @vue/language-server`                                                                                                 |

User entries are authoritative. A built-in recipe is skipped when its extensions
are already covered by an enabled user `primary` entry. Companion user entries
do **not** suppress a primary recipe, so you can layer ESLint alongside the
built-in TypeScript recipe without losing navigation. When a user entry shares a
recipe name, it is merged on top at the field level. The built-in ESLint recipe
ships default `vscode-eslint-language-server` settings so pull diagnostics work
out of the box. The built-in Tailwind CSS recipe is a companion with
`enabled: false` by default; enable it via `/lsp config` or a user config entry.

## Statusline states

```
⚡LSP             - servers running, no diagnostics
⚡LSP …1          - one starting (dim)
⚡LSP ✕1          - one in error (red)
⚡LSP             - bolt is error-colored while diagnostics are present
(hidden)         - no servers are starting/running/in error
```

`…n` counts starting servers; `✕n` counts servers in error. The bolt uses the
theme's `error` color whenever one or more diagnostics are tracked (from the
initial LSP publish until the file is edited or the diagnostic state is reset);
otherwise it keeps the accent color. The segment is hidden when all tracked
counts are zero.

## Slash commands

| Command                         | Action                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/lsp status`                   | Inspect the current LSP runtime snapshot without starting stopped servers. Manager state, server counts, per-server details.                                                          |
| `/lsp diagnostics`              | Inspect every tracked diagnostic (pending + delivered), grouped by file, tagged with severity, position, message, code, source, and originating server.                               |
| `/lsp start`                    | Interactive panel to start/stop any configured server for the session. Arrow keys move, space toggles, esc closes. TUI only.                                                          |
| `/lsp config <global\|project>` | Interactive panel listing built-in recipes plus that scope's user servers. Space toggles `enabled` and writes it to the scope's `config.json`. TUI only. Reload the session to apply. |

## Environment variables

| Variable           | Default                              | Meaning                                                                                       |
| ------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `PI_LSP_LOG_LEVEL` | `error`                              | Log level. Set to `debug` for verbose output.                                                 |
| `PI_LSP_LOG_FILE`  | `~/.pi/@balaenis/pi-lsp/default.log` | Override the log destination (must be absolute). If unwritable, logging is silently disabled. |

## Limitations

- **`findReferences` cold start** - the extension opens files lazily. References
  in files the server has not indexed (e.g. outside `tsconfig.json`'s include
  set) may be missing on a cold start. No eager workspace priming is performed.
- **Primary server selection on overlap** - if two `primary` servers list the
  same extension, only the first registered server is used. Use a user-defined
  `primary` server to replace a built-in recipe, or set `conflictGroup` to make
  the replacement explicit.
- **Config changes** - fixing a permanent startup failure currently requires
  correcting the config or `PATH` and reloading/restarting the Pi session; this
  version does not watch config changes or expose a reset command.
