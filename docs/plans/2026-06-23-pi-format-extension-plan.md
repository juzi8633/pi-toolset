# Pi Format Extension Implementation Plan

**Goal:** Add a Pi package that provides project file formatting through a `format` tool, `/format` command, and automatic formatting after successful built-in `write`/`edit` tool calls.

**Inputs:** User request from 2026-06-23; opencode format analysis from subagent output; Pi extension documentation at `/home/julian/.local/share/mise/installs/node/26.3.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`; package documentation at `/home/julian/.local/share/mise/installs/node/26.3.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/packages.md`; existing package patterns in `packages/pi-lsp/`.

**Assumptions:**

- This plan creates a new package, `packages/pi-format`, published as `@balaenis/pi-format`.
- This implementation supports explicit formatting via the LLM-callable `format` tool and the user-facing `/format` command.
- This implementation also supports automatic formatting after successful built-in `write`/`edit` calls by using a `tool_result` hook and `withFileMutationQueue`.
- Automatic formatting is enabled by default when the package is enabled, and users can disable it with `formatOnWrite: false`.
- Overriding built-in `write`/`edit` tools is recorded as a future optimization option only; no code for tool overrides is added in this plan.
- Initial built-in formatter recipes cover common local binaries and package-managed tools: Prettier, Biome, Ruff, gofmt, rustfmt, shfmt, and clang-format.
- Formatter failures should be reported as failures for explicit `/format` or `format` tool calls; automatic formatting failures should be best-effort and must not convert a successful `write`/`edit` result into an error.

**Architecture:** Build a standalone Pi extension package with a formatter registry, config loader, shared format service, command runner, explicit `format` tool, `/format` command, and automatic `tool_result` hook. The package detects built-in formatter recipes from project files and PATH, merges global and project config, selects the first enabled formatter matching a file extension, and executes the configured command with `$FILE` substitution. The automatic hook listens for successful built-in `write` and `edit` results, resolves the changed file, and wraps formatting in `withFileMutationQueue` so same-file formatting is serialized with other mutations while avoiding built-in `write`/`edit` overrides.

**Tech Stack:** TypeScript, Bun test runner, TypeBox, Pi extension API, `withFileMutationQueue`, Node.js `fs/path/child_process` APIs, existing `mise` tasks, existing repo lint/format tooling.

---

## Scope

### In Scope

- Create `packages/pi-format` as a Pi package.
- Register a `format` custom tool callable by the LLM.
- Register a `/format` slash command for direct user invocation.
- Support formatting one file or a small explicit list of files.
- Automatically format files after successful built-in `write` and `edit` tool calls.
- Serialize automatic post-edit formatting with `withFileMutationQueue`.
- Support built-in formatter recipes with deterministic detection.
- Support user-defined formatter commands and disabling built-ins.
- Add README documentation, config examples, automatic formatting notes, and validation instructions.
- Add unit tests for config loading, formatter selection, command execution, command/tool behavior, and automatic `tool_result` formatting.

### Out of Scope for This Implementation

- No override of Pi's built-in `write` or `edit` tools.
- No recursive whole-repo formatting command in the first version.
- No LSP `textDocument/formatting` support.
- No remote/sandbox formatting backend.

## Future Optimization Option to Record

This option must be documented in the README or a dedicated design note, but not implemented in this plan.

### Option: Override built-in `write` and `edit`

- Register replacement tools named `write` and `edit`.
- Delegate to `createWriteToolDefinition(ctx.cwd)` and `createEditToolDefinition(ctx.cwd)` or equivalent factory-created implementations.
- Run formatting within the same mutation window only if the override controls the complete file mutation sequence.
- Preserve the exact built-in result shape, render behavior expectations, prompt snippets, and prompt guidelines.
- Caveat: this has higher maintenance risk because Pi core tool schemas, details, and render assumptions can change.

## File Map

- Create: `packages/pi-format/package.json` — package metadata, Pi manifest, dependencies, scripts, and exports.
- Create: `packages/pi-format/tsconfig.json` — TypeScript configuration matching the existing package style.
- Create: `packages/pi-format/README.md` — user documentation, configuration reference, examples, automatic formatting behavior, and future override notes.
- Create: `packages/pi-format/src/index.ts` — extension entry point that registers the `format` tool, `/format` command, and automatic format hook.
- Create: `packages/pi-format/src/types.ts` — shared formatter, config, result, automatic-format, and command-runner types.
- Create: `packages/pi-format/src/config.ts` — global/project config loading, JSONC parsing, normalization, and merge rules.
- Create: `packages/pi-format/src/recipes.ts` — built-in formatter recipe definitions and detection logic.
- Create: `packages/pi-format/src/registry.ts` — formatter selection, command resolution, and extension matching.
- Create: `packages/pi-format/src/runner.ts` — formatter command execution, `$FILE` substitution, cwd/env handling, timeout handling, and result shaping.
- Create: `packages/pi-format/src/service.ts` — shared explicit and automatic file-formatting workflow used by the tool, command, and hook.
- Create: `packages/pi-format/src/tools.ts` — `format` tool schema, implementation, and compact TUI renderers.
- Create: `packages/pi-format/src/command.ts` — `/format` command parsing and UI notifications.
- Create: `packages/pi-format/src/hooks.ts` — `tool_result` listener that formats successful `write`/`edit` targets with `withFileMutationQueue`.
- Create: `packages/pi-format/src/log.ts` — minimal debug/error helpers consistent with `pi-lsp` style.
- Create: `packages/pi-format/tests/config.test.ts` — config normalization and merge coverage.
- Create: `packages/pi-format/tests/recipes.test.ts` — recipe detection coverage with mocked executables/project files.
- Create: `packages/pi-format/tests/registry.test.ts` — extension matching and formatter precedence coverage.
- Create: `packages/pi-format/tests/runner.test.ts` — command substitution, env merge, cwd, timeout, and failure coverage.
- Create: `packages/pi-format/tests/service.test.ts` — shared explicit and automatic formatting workflow coverage.
- Create: `packages/pi-format/tests/tools.test.ts` — explicit `format` tool behavior.
- Create: `packages/pi-format/tests/command.test.ts` — `/format` argument handling and status messaging.
- Create: `packages/pi-format/tests/hooks.test.ts` — automatic `tool_result + withFileMutationQueue` behavior.
- Modify: `README.md` if the root README exists or is created later — list the new package and basic install/use instructions. If no root README exists, keep package documentation in `packages/pi-format/README.md` only.
- Modify: release configuration only if the repo's existing release tooling requires package names to be enumerated explicitly.

## Configuration Shape

Use dedicated config files matching `pi-lsp` conventions:

- Global: `~/.pi/agent/@balaenis/pi-format/config.json`
- Project: `<cwd>/.pi/@balaenis/pi-format/config.json`

Project config overrides global config by formatter name.

Example:

```jsonc
{
  "enabled": true,
  "formatOnWrite": true,
  "formatters": {
    "prettier": {
      "disabled": false,
      "command": ["bunx", "prettier", "--write", "$FILE"],
      "extensions": [".js", ".jsx", ".ts", ".tsx", ".json", ".md"],
    },
    "biome": {
      "disabled": true,
    },
    "custom-md": {
      "command": ["markdownfmt", "$FILE"],
      "extensions": [".md"],
      "environment": {
        "MARKDOWN_WIDTH": "100",
      },
    },
  },
}
```

Normalized config rules:

- Missing config means explicit formatting and automatic post-`write`/`edit` formatting are enabled with built-in recipes.
- `enabled: false` disables the tool, command, and automatic hook at runtime but still registers the tool and command so the user gets a clear disabled message.
- `formatOnWrite: false` disables automatic formatting after successful `write`/`edit` while keeping `/format` and the `format` tool enabled.
- `formatters.<name>.disabled: true` disables that formatter.
- `formatters.<name>.command` overrides a built-in or defines a custom formatter.
- `formatters.<name>.extensions` overrides a built-in extension list or is required for a custom formatter.
- Commands must be arrays of strings.
- A command that formats a file must include `$FILE`; config validation rejects commands without `$FILE`.
- Extensions normalize to lowercase and must start with `.`.
- `environment` values support `$VAR` and `${VAR}` substitution from `process.env`.

## Built-in Formatter Recipes

Initial recipes:

- `prettier` — `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.css`, `.scss`, `.json`, `.jsonc`, `.yaml`, `.yml`, `.md`, `.html`; detect by `package.json` dependency/devDependency/peerDependency or local binary; command `prettier --write $FILE`.
- `biome` — `.js`, `.jsx`, `.ts`, `.tsx`, `.json`, `.jsonc`, `.css`; detect `biome.json` or `biome.jsonc` and local binary; command `biome format --write $FILE`.
- `ruff` — `.py`, `.pyi`; detect `ruff` on PATH or project config files `pyproject.toml`, `ruff.toml`, `.ruff.toml`; command `ruff format $FILE`.
- `gofmt` — `.go`; detect `gofmt` on PATH; command `gofmt -w $FILE`.
- `rustfmt` — `.rs`; detect `rustfmt` on PATH; command `rustfmt $FILE`.
- `shfmt` — `.sh`, `.bash`, `.zsh`; detect `shfmt` on PATH; command `shfmt -w $FILE`.
- `clang-format` — `.c`, `.cc`, `.cpp`, `.cxx`, `.h`, `.hh`, `.hpp`, `.hxx`; detect `.clang-format` and `clang-format` on PATH; command `clang-format -i $FILE`.

Detection rules should be conservative: if a formatter is not clearly available, return disabled rather than running `npx` or installing tools implicitly.

## Tasks

### Task 1: Create the package skeleton

**Outcome:** `packages/pi-format` exists as a buildable Pi package with the same package conventions as `packages/pi-lsp`.

**Files:**

- Create: `packages/pi-format/package.json`
- Create: `packages/pi-format/tsconfig.json`
- Create: `packages/pi-format/src/index.ts`
- Create: `packages/pi-format/src/types.ts`
- Create: `packages/pi-format/src/log.ts`
- Create: `packages/pi-format/README.md`

**Steps:**

- [ ] Add `packages/pi-format/package.json` with name `@balaenis/pi-format`, `type: "module"`, `keywords` including `pi-package`, and a `pi.extensions` entry pointing to `./dist/index.js`.
- [ ] Add peer dependencies for `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and `typebox` using `"*"` ranges.
- [ ] Add dev dependencies aligned with the repo's current Pi package versions where needed for local type checking.
- [ ] Add `packages/pi-format/tsconfig.json` using `moduleResolution: "bundler"`, `strict: true`, `noEmit: true`, `allowImportingTsExtensions: true`, and `types: ["bun-types"]`.
- [ ] Add `src/index.ts`, `src/types.ts`, and `src/log.ts` with one-line `ABOUTME:` comments at the top of each code file.
- [ ] In `src/index.ts`, export the default extension function and leave only registration calls plus concrete wiring for the tool, command, and hook registration functions.
- [ ] Add an initial `packages/pi-format/README.md` with package purpose, local development usage, and a statement that v1 supports explicit formatting plus automatic formatting after successful `write`/`edit`.

**Validation:**

- Run: `mise run typecheck --package packages/pi-format`
- Expected: TypeScript completes without errors once the package is included in the repo's package-task discovery.

### Task 2: Define config and runtime types

**Outcome:** The package has precise TypeScript types for raw config, normalized config, formatter recipes, formatter commands, and format results.

**Files:**

- Modify: `packages/pi-format/src/types.ts`
- Test: `packages/pi-format/tests/config.test.ts`

**Steps:**

- [ ] Define `InputFormatConfig` with optional `enabled?: boolean`, optional `formatOnWrite?: boolean`, and optional `formatters?: Record<string, InputFormatterConfig>`.
- [ ] Define `InputFormatterConfig` with optional `disabled?: boolean`, `command?: string[]`, `extensions?: string[]`, `environment?: Record<string, string>`, and `timeoutMs?: number`.
- [ ] Define `FormatterConfig` as the normalized shape with `name`, `disabled`, `command`, `extensions`, `environment`, `timeoutMs`, and `source: 'builtin' | 'user'`.
- [ ] Define `FormatterRecipe` with `name`, `extensions`, optional `environment`, and `resolve(ctx): Promise<ResolvedFormatterCommand | false>`.
- [ ] Define `ResolvedFormatterCommand` with `command: string[]` and optional `environment`.
- [ ] Define `FormatMode` as `'explicit' | 'automatic'` so result handling can distinguish direct requests from post-edit hooks.
- [ ] Define `FormatResult` with `filePath`, `formatterName`, `command`, `exitCode`, `stdout`, `stderr`, `formatted: boolean`, and `mode: FormatMode`.
- [ ] Add `tests/config.test.ts` cases that type-level runtime validation rejects empty formatter names, empty command arrays, commands without `$FILE`, invalid `formatOnWrite`, and extensions without leading dots.

**Validation:**

- Run: `mise run test --package packages/pi-format`
- Expected: config type/normalization tests pass.

### Task 3: Implement config loading and normalization

**Outcome:** The extension can load global and project config files, merge them deterministically, and produce normalized formatter overrides.

**Files:**

- Create: `packages/pi-format/src/config.ts`
- Modify: `packages/pi-format/src/types.ts`
- Test: `packages/pi-format/tests/config.test.ts`

**Steps:**

- [ ] Implement `readJsoncFile(filePath)` that strips line and block comments without breaking string literals.
- [ ] Implement `substituteEnv(value)` supporting `$VAR` and `${VAR}`, using empty string for undefined variables.
- [ ] Implement `normalizeExtension(ext)` that lowercases and requires a leading `.`.
- [ ] Implement `normalizeFormatterConfig(name, raw)` that validates command arrays, `$FILE`, extensions, environment, and timeout.
- [ ] Implement `getFormatConfig(cwd)` that reads global config from `path.join(getAgentDir(), '@balaenis', 'pi-format', 'config.json')` and project config from `path.join(cwd, CONFIG_DIR_NAME, '@balaenis', 'pi-format', 'config.json')`.
- [ ] Merge formatter records with project entries overriding global entries by formatter name.
- [ ] Default missing `enabled` to `true`.
- [ ] Default missing `formatOnWrite` to `true`.
- [ ] Log invalid formatter entries and skip them rather than failing the entire config load.
- [ ] Add tests for missing config, global-only config, project override, invalid formatter skipped, JSONC comments, env substitution, extension normalization, and `formatOnWrite` overrides.

**Validation:**

- Run: `mise run test --package packages/pi-format`
- Expected: config tests pass and invalid entries do not prevent valid entries from loading.

### Task 4: Implement built-in formatter recipes

**Outcome:** Built-in recipes conservatively detect available formatters and return executable command arrays without installing anything implicitly.

**Files:**

- Create: `packages/pi-format/src/recipes.ts`
- Modify: `packages/pi-format/src/types.ts`
- Test: `packages/pi-format/tests/recipes.test.ts`

**Steps:**

- [ ] Implement a `which(binary, cwd)` helper using `pi.exec` where extension context is available or a testable process lookup helper where direct process spawning is simpler.
- [ ] Implement `findUp(cwd, stopAt, names)` that walks from `cwd` up to filesystem root or a defined stop path and returns matching config files.
- [ ] Implement package dependency detection by reading nearest `package.json` and checking `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`.
- [ ] Add `prettier` recipe with package dependency/local binary detection and extensions listed in the Built-in Formatter Recipes section.
- [ ] Add `biome` recipe with `biome.json`/`biome.jsonc` and binary detection.
- [ ] Add `ruff` recipe with config-file or binary detection.
- [ ] Add `gofmt`, `rustfmt`, `shfmt`, and `clang-format` recipes with PATH/config detection as listed above.
- [ ] Export `BUILTIN_FORMATTER_RECIPES` in deterministic precedence order: biome before prettier for projects with Biome config, then prettier, then language-specific formatters.
- [ ] Add tests using temporary directories and mocked command lookup to verify each recipe returns false when unavailable and returns the expected command when available.

**Validation:**

- Run: `mise run test --package packages/pi-format`
- Expected: recipe tests pass without requiring actual formatter binaries to be installed globally.

### Task 5: Implement formatter registry and selection

**Outcome:** The package can combine built-in recipes and user config, then choose the correct formatter for a given file extension.

**Files:**

- Create: `packages/pi-format/src/registry.ts`
- Modify: `packages/pi-format/src/types.ts`
- Test: `packages/pi-format/tests/registry.test.ts`

**Steps:**

- [ ] Implement `createFormatterRegistry(cwd, config, recipes)` that applies user overrides to built-ins and adds custom user formatters.
- [ ] Preserve deterministic formatter precedence: user custom formatters in config order first, then user-overridden built-ins at their built-in precedence position, then remaining built-ins.
- [ ] Implement `getFormatterForFile(filePath)` using `path.extname(filePath).toLowerCase()` and normalized extension lists.
- [ ] Skip disabled formatters.
- [ ] Cache recipe resolution results per formatter name for the current registry instance.
- [ ] Return a structured no-match result when no enabled formatter supports the extension.
- [ ] Add tests for custom formatter match, disabled built-in, command override, extension override, no-match extension, and cache reuse.

**Validation:**

- Run: `mise run test --package packages/pi-format`
- Expected: registry tests pass and formatter precedence is deterministic.

### Task 6: Implement the formatter runner

**Outcome:** The package can execute a selected formatter command safely and return structured output for the tool and command layers.

**Files:**

- Create: `packages/pi-format/src/runner.ts`
- Modify: `packages/pi-format/src/types.ts`
- Test: `packages/pi-format/tests/runner.test.ts`

**Steps:**

- [ ] Implement `replaceFileToken(args, filePath)` that replaces every exact `$FILE` argument or `$FILE` substring with the absolute file path.
- [ ] Implement `runFormatter(formatter, filePath, ctx)` using `pi.exec` from the extension closure or an injected command runner for tests.
- [ ] Use `ctx.cwd` as the working directory.
- [ ] Merge formatter `environment` over `process.env` for execution.
- [ ] Respect `timeoutMs`, defaulting to 30 seconds.
- [ ] Treat non-zero exit codes as formatter failures with captured stderr/stdout in the returned error message.
- [ ] Truncate stdout/stderr using Pi truncation utilities before returning content to the LLM.
- [ ] Add tests for `$FILE` substitution, env merge, cwd, timeout option, non-zero exit code, missing executable error, and successful format result.

**Validation:**

- Run: `mise run test --package packages/pi-format`
- Expected: runner tests pass and command output is bounded.

### Task 7: Implement the shared format service

**Outcome:** Tool, command, and automatic hook code share one formatting workflow with explicit and automatic result modes.

**Files:**

- Create: `packages/pi-format/src/service.ts`
- Modify: `packages/pi-format/src/types.ts`
- Test: `packages/pi-format/tests/service.test.ts`

**Steps:**

- [ ] Implement `formatPaths(paths, options, ctx)` where `options.mode` is `'explicit'` or `'automatic'`.
- [ ] Resolve every path against `ctx.cwd` before formatter selection.
- [ ] Check every resolved path exists and is a file before formatting.
- [ ] Load config and registry per invocation so `/reload` or config edits are picked up without restarting the process.
- [ ] Respect `enabled: false` by returning a disabled result without running commands.
- [ ] Respect `formatOnWrite: false` only when `options.mode === 'automatic'`.
- [ ] If `options.formatter` is provided, use only that named formatter and return a clear error if it does not exist or does not support the file extension.
- [ ] Format files sequentially in the order provided to keep output deterministic.
- [ ] In explicit mode, preserve formatter failures in the returned summary so the tool or command can surface them as failures.
- [ ] In automatic mode, return best-effort results that distinguish formatted, skipped, and failed files without throwing for formatter failures.
- [ ] Add service tests for enabled config, disabled config, `formatOnWrite: false`, forced formatter, unsupported extension, missing file, successful format, and formatter failure in both explicit and automatic modes.

**Validation:**

- Run: `mise run test --package packages/pi-format`
- Expected: service tests pass and explicit versus automatic failure handling is distinct.

### Task 8: Register the explicit `format` tool

**Outcome:** The LLM can call a `format` tool to format one or more explicitly named files.

**Files:**

- Create: `packages/pi-format/src/tools.ts`
- Modify: `packages/pi-format/src/index.ts`
- Test: `packages/pi-format/tests/tools.test.ts`

**Steps:**

- [ ] Define a TypeBox schema with `paths: string[]` and optional `formatter?: string`.
- [ ] Keep the first version limited to explicit paths; reject empty `paths`.
- [ ] Call `formatPaths(paths, { mode: 'explicit', formatter }, ctx)`.
- [ ] Return a concise text summary listing formatted files, skipped files, formatter names, and failures.
- [ ] Mark the tool result as failed by throwing only when explicit formatting has invalid input or one or more formatter commands fail.
- [ ] Add `renderCall` showing `format <paths>` and `renderResult` showing counts and expandable details.
- [ ] Add tests for successful single file, multiple files, unsupported extension, disabled config, forced formatter, missing file, and command failure.

**Validation:**

- Run: `mise run test --package packages/pi-format`
- Expected: tool tests pass and the tool does not format unspecified files.

### Task 9: Register the `/format` command

**Outcome:** Users can run `/format path/to/file.ts` or `/format --formatter prettier path/to/file.ts` from Pi without asking the LLM to call the tool.

**Files:**

- Create: `packages/pi-format/src/command.ts`
- Modify: `packages/pi-format/src/index.ts`
- Test: `packages/pi-format/tests/command.test.ts`

**Steps:**

- [ ] Implement simple command argument parsing for `/format <path...>` and `/format --formatter <name> <path...>`.
- [ ] Require at least one path and notify usage text when no path is provided.
- [ ] In command mode, wait for idle with `ctx.waitForIdle()` before formatting so it does not race with active agent tool calls.
- [ ] Call `formatPaths(paths, { mode: 'explicit', formatter }, ctx)`.
- [ ] Call `ctx.ui.notify()` with success, warning, or error summaries depending on result counts.
- [ ] Add command tests for no args, one file, multiple files, forced formatter, unsupported extension, disabled config, and formatter failure.

**Validation:**

- Run: `mise run test --package packages/pi-format`
- Expected: command tests pass and command messages are clear in success and failure cases.

### Task 10: Register automatic post-`write`/`edit` formatting

**Outcome:** Successful built-in `write` and `edit` tool calls automatically format their target file when config allows it, without overriding the built-in tools.

**Files:**

- Create: `packages/pi-format/src/hooks.ts`
- Modify: `packages/pi-format/src/index.ts`
- Test: `packages/pi-format/tests/hooks.test.ts`

**Steps:**

- [ ] Register a `tool_result` handler in `registerFormatHooks(pi)`.
- [ ] Use `isWriteToolResult(event)` and `isEditToolResult(event)` to narrow events to built-in `write` and `edit` results.
- [ ] Return immediately when `event.isError` is true.
- [ ] Read `event.input.path` and return immediately when the path is missing or not a string.
- [ ] Resolve the target path against `ctx.cwd`.
- [ ] Call `withFileMutationQueue(absolutePath, async () => formatPaths([absolutePath], { mode: 'automatic' }, ctx))`.
- [ ] Do not modify the successful `write`/`edit` tool result content on automatic format success, so the LLM context does not get noisy formatting status messages.
- [ ] Do not set `isError: true` or throw for automatic formatter failures; log the failure and use `ctx.ui.notify()` with a warning when `ctx.hasUI` is true.
- [ ] Skip automatic formatting when the shared service reports `enabled: false`, `formatOnWrite: false`, unsupported extension, missing formatter, or missing file.
- [ ] Add hook tests for successful write result, successful edit result, failed edit result skipped, missing path skipped, `formatOnWrite: false` skipped, formatter failure non-fatal, and queue wrapper usage.
- [ ] Add a regression test that automatic formatting uses the same formatter selection and command execution path as explicit formatting.

**Validation:**

- Run: `mise run test --package packages/pi-format`
- Expected: hook tests pass; automatic formatting never converts a successful `write`/`edit` result into an error.

### Task 11: Wire the extension entry point

**Outcome:** Loading the package registers the tool, command, and automatic hook without starting background processes or watchers.

**Files:**

- Modify: `packages/pi-format/src/index.ts`
- Test: `packages/pi-format/tests/tools.test.ts`
- Test: `packages/pi-format/tests/command.test.ts`
- Test: `packages/pi-format/tests/hooks.test.ts`

**Steps:**

- [ ] Import and call `registerFormatTool(pi)` from `src/tools.ts`.
- [ ] Import and call `registerFormatCommand(pi)` from `src/command.ts`.
- [ ] Import and call `registerFormatHooks(pi)` from `src/hooks.ts`.
- [ ] Do not start timers, watchers, or child processes in the extension factory.
- [ ] Add an optional `session_start` notification only if it is quiet by default; otherwise omit startup UI noise.
- [ ] Confirm the extension works with Pi package loading through the `pi.extensions` manifest.

**Validation:**

- Run: `mise run typecheck --package packages/pi-format`
- Expected: TypeScript completes without errors.

### Task 12: Document usage, config, automatic formatting, and future override option

**Outcome:** Users know how to install, configure, use explicit formatting, understand automatic post-write/edit behavior, and see built-in tool overrides as a future optimization only.

**Files:**

- Modify: `packages/pi-format/README.md`
- Modify: root `README.md` only if it exists or is created for monorepo package listing.

**Steps:**

- [ ] Document installation with `pi install npm:@balaenis/pi-format` once published and local development usage with `pi -e ./packages/pi-format/dist/index.js` after build.
- [ ] Document `/format <path>` and `/format --formatter <name> <path>`.
- [ ] Document the `format` tool behavior for LLM-driven explicit formatting.
- [ ] Document automatic formatting after successful built-in `write` and `edit` results.
- [ ] Document that automatic formatting uses `tool_result + withFileMutationQueue` and does not override built-in tools.
- [ ] Document the caveat that built-in `edit` displayed diffs do not include formatter-produced changes because formatting happens after the edit result is computed.
- [ ] Document global and project config paths.
- [ ] Document config fields: `enabled`, `formatOnWrite`, `formatters`, `disabled`, `command`, `extensions`, `environment`, and `timeoutMs`.
- [ ] Document that commands must include `$FILE`.
- [ ] Document built-in formatter recipes and their conservative detection rules.
- [ ] Add a section named `Future optimization: write/edit overrides` describing built-in tool overrides as an advanced option not implemented in this release.
- [ ] Add test instructions: `mise run test --package packages/pi-format`, `mise run typecheck --package packages/pi-format`, `mise run build --package packages/pi-format`, and `hk check`.

**Validation:**

- Run: `hk check`
- Expected: markdown and code formatting/lint checks pass.

## Final Validation

- Run: `mise run test --package packages/pi-format`
- Expected: all `pi-format` tests pass.
- Run: `mise run typecheck --package packages/pi-format`
- Expected: TypeScript completes without errors.
- Run: `mise run build --package packages/pi-format`
- Expected: package builds and emits `dist/index.js` referenced by the Pi manifest.
- Run: `hk check`
- Expected: repo-wide eslint and prettier checks pass.

## Rollout Notes

- The first release supports both explicit formatting and automatic formatting after successful built-in `write`/`edit` tool results.
- Automatic formatting is enabled by default when the package is enabled; users can disable it with `formatOnWrite: false`.
- The package should still be safe to install globally because it starts no background watchers and runs formatting only after Pi file-mutation tools or explicit user/tool requests.
- Project-local config should be honored only after Pi trusts the project, following normal Pi project-resource trust behavior.
- Automatic formatting may mutate whitespace after a built-in `edit` result is displayed; the README must document that the displayed edit diff does not include formatter-produced changes.

## Risks and Mitigations

- Risk: Formatter detection accidentally runs the wrong tool. — Mitigation: use conservative detection and never invoke `npx`/`bunx` implicitly unless the user configured that exact command.
- Risk: Formatting output can flood the LLM context. — Mitigation: truncate stdout/stderr and return summaries for explicit calls; automatic formatting should not append success messages to tool results.
- Risk: User config can define unsafe commands. — Mitigation: document that Pi extensions run with user permissions; validate shape but do not pretend command execution is sandboxed.
- Risk: Different projects expect different formatter precedence. — Mitigation: allow disabling built-ins, overriding commands, forcing a formatter in the tool/command, and disabling automatic formatting with `formatOnWrite: false`.
- Risk: A formatter mutates files beyond the target file. — Mitigation: require `$FILE` and document that formatters should be configured for single-file operation.
- Risk: Automatic formatting races with concurrent edits. — Mitigation: wrap automatic formatting in `withFileMutationQueue(absolutePath, ...)` so formatting participates in Pi's same-file mutation serialization.
- Risk: Automatic formatting changes are not reflected in the built-in `edit` diff. — Mitigation: document the caveat and keep automatic success messages out of LLM context to avoid claiming a diff that Pi did not render.
- Risk: Automatic formatter failures make successful edits look failed. — Mitigation: automatic mode logs or notifies failures without throwing or setting `isError: true` on the original tool result.
- Risk: Overriding `write`/`edit` creates maintenance burden. — Mitigation: record it only as an advanced future optimization; this implementation uses event-based automation instead.

## Deferred Items (post-review)

The following items came out of the 2026-06-23 review of the initial implementation. They are deferred and may be picked up later when justified.

- **`environment` config field (Pi exec env support).** Removed from v1 because Pi's `ExecOptions` only exposes `signal` / `timeout` / `cwd` (`@earendil-works/pi-coding-agent/dist/core/exec.d.ts`), so any `env` passed through would be silently dropped. Revisit when Pi core exposes `env` on `pi.exec`; re-add `formatters.<name>.environment` with `$VAR` / `${VAR}` substitution from `process.env` (the `substituteEnv` helper in `src/utils.ts` is kept for this purpose).
- **Tool renderer generics.** `tools.ts` still uses `result.details as FormatToolDetails | undefined` because `registerTool` does not currently expose a `details` generic. When `pi-coding-agent` adds a generic to `registerTool` (or a typed renderer payload), thread it through and drop the cast. The matching pattern in `pi-lsp` should be updated at the same time.
- **Optional advanced detection rules.** `prettier` and `ruff` recipes intentionally require the binary on PATH and ignore `package.json` / `ruff.toml` heuristics, because `pi.exec` does not augment PATH with `node_modules/.bin` and conservative detection wins. If Pi later adds `node_modules/.bin` resolution, we can re-introduce the dependency-based fallback that wraps the command with `bunx prettier` / `uv run ruff` rather than the bare binary name.
- **Write/edit tool overrides.** Still out of scope for v1. Reconsider only if the event-based hook proves insufficient for use cases like "format the edit diff before it is shown" — implementing that requires either an override or a new Pi core hook.
