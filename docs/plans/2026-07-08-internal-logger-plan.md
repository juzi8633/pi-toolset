# Internal Logger Implementation Plan

**Goal:** Extract the duplicated logger implementation from `packages/pi-lsp` and `packages/pi-format` into a private internal workspace package shared by packages in this monorepo, without publishing the logger package.

**Inputs:** User requirement: packages in this monorepo should share the log module, and the shared module does not need to be published separately. Repository evidence: duplicated implementations in `packages/pi-lsp/src/log.ts` and `packages/pi-format/src/log.ts`, root workspace currently only includes `packages/*`, and root `pi.extensions` also points at `packages/*`.

**Assumptions:**

- `@balaenis/pi-lsp` and `@balaenis/pi-format` may still be published independently, so the private logger must be bundled into each package build and must not become a published runtime dependency.
- Existing public/internal package logging behavior should remain unchanged: same env vars, same default log file paths, same log line prefixes, same error handling behavior, and same exported function names from each package's local `src/log.ts`.
- `pi-agents` should not adopt logging in this change because it currently has no logger and the request is to deduplicate existing implementations.

**Architecture:** Add a private workspace package under `internal/pi-log` instead of `packages/pi-log`, so the root `pi.extensions: ["packages/*"]` glob continues to refer only to Pi extension packages. The internal package exports a `createLogger` factory plus `errorMessage`; each extension package keeps a thin local `src/log.ts` adapter that preserves existing imports while delegating implementation to the shared factory. Consumers add `@balaenis/pi-log` as a `devDependency` with `workspace:*` so Bun can bundle it into `dist` during package builds without declaring a private runtime dependency in published packages.

**Tech Stack:** TypeScript, Bun workspaces, Bun build, Bun test, mise task wrappers, Node.js `fs`, `os`, and `path` APIs.

---

## File Map

- Create: `internal/pi-log/package.json` — private workspace package metadata and source export for local resolution.
- Create: `internal/pi-log/tsconfig.json` — strict TypeScript config for the internal package.
- Create: `internal/pi-log/src/index.ts` — shared logger factory, log-level parsing, stream creation, line writing, and `errorMessage` helper.
- Create: `internal/pi-log/tests/logger.test.ts` — focused tests for debug gating, error logging, file override, and `errorMessage`.
- Modify: `package.json` — add `internal/*` to workspaces while leaving `pi.extensions` scoped to `packages/*`.
- Modify: `packages/pi-lsp/package.json` — add `@balaenis/pi-log` as a `devDependency` using `workspace:*`.
- Modify: `packages/pi-format/package.json` — add `@balaenis/pi-log` as a `devDependency` using `workspace:*`.
- Modify: `packages/pi-lsp/src/log.ts` — replace duplicated implementation with an adapter preserving `logForDebugging`, `logError`, `errorMessage`, and `sleep` export compatibility.
- Modify: `packages/pi-format/src/log.ts` — replace duplicated implementation with an adapter preserving `logDebug`, `logError`, and `errorMessage`.
- Modify: `packages/pi-lsp/README.md` — correct logging documentation if it still references the stale `~/.pi/pi-x-ide/debug.log` path instead of the actual default path.
- Modify: `bun.lock` or equivalent lockfile if Bun updates workspace metadata.

## Tasks

### Task 1: Add the private internal logger package

**Outcome:** The monorepo contains a private workspace package that exposes the shared logger implementation and can be resolved by sibling packages during typecheck, test, and build.

**Files:**

- Create: `internal/pi-log/package.json`
- Create: `internal/pi-log/tsconfig.json`
- Create: `internal/pi-log/src/index.ts`
- Modify: `package.json`

**Steps:**

- [ ] Update root `package.json` workspaces from `["packages/*"]` to `["packages/*", "internal/*"]`; do not add `internal/*` to `pi.extensions`.
- [ ] Create `internal/pi-log/package.json` with `name: "@balaenis/pi-log"`, `private: true`, `type: "module"`, and `exports: { ".": "./src/index.ts" }`.
- [ ] Create `internal/pi-log/tsconfig.json` following the package TypeScript style: `target`/`module` `ESNext`, `moduleResolution: "bundler"`, `strict: true`, `noEmit: true`, `skipLibCheck: true`, `types: ["bun-types"]`, and include `src` and `tests`.
- [ ] Create `internal/pi-log/src/index.ts` with the required two-line `ABOUTME` header.
- [ ] Implement `type LogLevel = "debug" | "error"` and `const LEVEL_ORDER` with debug below error.
- [ ] Export `interface LoggerOptions` with `name`, `envPrefix`, `defaultLogFile`, and optional `env?: Record<string, string | undefined>`.
- [ ] Export `interface Logger` with `debug(message: string): void` and `error(error: unknown): void`.
- [ ] Export `createLogger(options: LoggerOptions): Logger`.
- [ ] In `createLogger`, read `${envPrefix}_LOG_LEVEL` and `${envPrefix}_LOG_FILE` from `options.env ?? process.env` at factory creation time.
- [ ] Preserve current behavior: only exact normalized `debug` enables debug logs; all other values use `error` level; blank log file override falls back to `defaultLogFile`.
- [ ] Preserve current stream behavior: lazily `mkdirSync(path.dirname(logFile), { recursive: true })`, create `WriteStream` with append mode, disable logging for the instance on create/write stream errors, and never write to stdout/stderr.
- [ ] Format each line as `${new Date().toISOString()} [${name}][${level}] ${message}\n`.
- [ ] Export `errorMessage(error: unknown): string` with the same behavior as current implementations.

**Validation:**

- Run: `mise run typecheck --package internal/pi-log`
- Expected: TypeScript completes with no errors for the internal package.

### Task 2: Add focused logger tests

**Outcome:** The shared logger behavior is covered where the implementation now lives.

**Files:**

- Create: `internal/pi-log/tests/logger.test.ts`

**Steps:**

- [ ] Create `internal/pi-log/tests/logger.test.ts` with the required two-line `ABOUTME` header.
- [ ] Add a test that `errorMessage(new Error("boom"))` returns `"boom"` and `errorMessage("plain")` returns `"plain"`.
- [ ] Add a test that a logger with `envPrefix: "TEST_LOGGER"`, `TEST_LOGGER_LOG_LEVEL: "debug"`, and `TEST_LOGGER_LOG_FILE` set to a temporary file writes a debug line containing `[test-logger][debug] hello`.
- [ ] Add a test that the default error level suppresses debug output but still writes errors containing `[test-logger][error] boom`.
- [ ] Ensure tests use temporary directories/files and wait briefly or close the stream if the implementation exposes a test-safe flush/close mechanism. Prefer not exposing production-only test APIs unless necessary; if a `close()` method is added to `Logger`, document it in the interface and use it from adapters harmlessly.

**Validation:**

- Run: `mise run test --package internal/pi-log`
- Expected: Bun test reports all internal logger tests passing.

### Task 3: Migrate pi-format to the shared logger

**Outcome:** `pi-format` uses the shared logger while preserving current local exports and behavior.

**Files:**

- Modify: `packages/pi-format/package.json`
- Modify: `packages/pi-format/src/log.ts`

**Steps:**

- [ ] Add `"@balaenis/pi-log": "workspace:*"` to `packages/pi-format/package.json` under `devDependencies`, not `dependencies`, so published runtime metadata does not require the private package.
- [ ] Replace `packages/pi-format/src/log.ts` duplicated implementation with a thin adapter that keeps the required two-line `ABOUTME` header.
- [ ] Import `createLogger` and `errorMessage` from `@balaenis/pi-log`.
- [ ] Keep `DEFAULT_LOG_FILE` as `path.join(homedir(), ".pi", "@balaenis", "pi-format", "default.log")`.
- [ ] Create a logger with `name: "pi-format"`, `envPrefix: "PI_FORMAT"`, and the current default log file.
- [ ] Export `logDebug` as `logger.debug`, `logError` as `logger.error`, and re-export `errorMessage`.
- [ ] Do not change any pi-format call sites unless typecheck requires it.

**Validation:**

- Run: `mise run typecheck --package packages/pi-format`
- Expected: TypeScript completes with no errors.
- Run: `mise run test --package packages/pi-format`
- Expected: Existing pi-format tests pass.

### Task 4: Migrate pi-lsp to the shared logger

**Outcome:** `pi-lsp` uses the shared logger while preserving current local exports and behavior.

**Files:**

- Modify: `packages/pi-lsp/package.json`
- Modify: `packages/pi-lsp/src/log.ts`
- Modify: `packages/pi-lsp/README.md`

**Steps:**

- [ ] Add `"@balaenis/pi-log": "workspace:*"` to `packages/pi-lsp/package.json` under `devDependencies`, not `dependencies`, so published runtime metadata does not require the private package.
- [ ] Replace `packages/pi-lsp/src/log.ts` duplicated logger implementation with a thin adapter that keeps the required two-line `ABOUTME` header.
- [ ] Import `createLogger` and `errorMessage` from `@balaenis/pi-log`.
- [ ] Keep `DEFAULT_LOG_FILE` as `path.join(homedir(), ".pi", "@balaenis", "pi-lsp", "default.log")`.
- [ ] Create a logger with `name: "pi-lsp"`, `envPrefix: "PI_LSP"`, and the current default log file.
- [ ] Export `logForDebugging` as `logger.debug`, `logError` as `logger.error`, and re-export `errorMessage`.
- [ ] Preserve the existing `sleep(ms: number): Promise<void>` export for compatibility, but leave a note in the final response that it is unrelated to logging and can be moved in a future cleanup.
- [ ] Update `packages/pi-lsp/README.md` logging text if it still says logs stream to `~/.pi/pi-x-ide/debug.log`; the correct default path is `~/.pi/@balaenis/pi-lsp/default.log`, with `PI_LSP_LOG_FILE` still overriding it.
- [ ] Do not change pi-lsp call sites unless typecheck requires it.

**Validation:**

- Run: `mise run typecheck --package packages/pi-lsp`
- Expected: TypeScript completes with no errors.
- Run: `mise run test --package packages/pi-lsp`
- Expected: Existing pi-lsp tests pass.

### Task 5: Refresh workspace metadata and run final checks

**Outcome:** Workspace dependency metadata is current, build bundles the private logger, and repository checks pass.

**Files:**

- Modify: `bun.lock` or equivalent lockfile if changed by Bun.

**Steps:**

- [ ] Run `bun install` from the repository root to refresh workspace metadata after adding `internal/*` and the two workspace devDependencies.
- [ ] Run package builds for `packages/pi-format` and `packages/pi-lsp` to confirm Bun resolves and bundles `@balaenis/pi-log` without externalizing it.
- [ ] Inspect the build output or build command output enough to confirm there is no runtime external requirement for `@balaenis/pi-log`.
- [ ] Run repo formatting/lint checks with `hk check`.

**Validation:**

- Run: `mise run build --package packages/pi-format`
- Expected: Build succeeds and `dist/index.js` is produced.
- Run: `mise run build --package packages/pi-lsp`
- Expected: Build succeeds, schema generation still succeeds, and `dist/index.js` is produced.
- Run: `hk check`
- Expected: ESLint and Prettier checks pass.

## Final Validation

- Run: `mise run typecheck --package internal/pi-log`
- Expected: No TypeScript errors.
- Run: `mise run test --package internal/pi-log`
- Expected: All internal logger tests pass.
- Run: `mise run typecheck --package packages/pi-format`
- Expected: No TypeScript errors.
- Run: `mise run test --package packages/pi-format`
- Expected: Existing pi-format tests pass.
- Run: `mise run build --package packages/pi-format`
- Expected: Build succeeds.
- Run: `mise run typecheck --package packages/pi-lsp`
- Expected: No TypeScript errors.
- Run: `mise run test --package packages/pi-lsp`
- Expected: Existing pi-lsp tests pass.
- Run: `mise run build --package packages/pi-lsp`
- Expected: Build and postbuild schema generation succeed.
- Run: `hk check`
- Expected: Repository lint and formatting checks pass.

## Rollout Notes

- There is no user-facing logging behavior change intended. Existing env vars remain `PI_FORMAT_LOG_LEVEL`, `PI_FORMAT_LOG_FILE`, `PI_LSP_LOG_LEVEL`, and `PI_LSP_LOG_FILE`.
- The private package is intentionally placed under `internal/*` so root `pi.extensions: ["packages/*"]` does not scan it as a Pi extension.
- The private logger is a build-time workspace dependency for extension packages and should be bundled into each extension's `dist/index.js`.

## Risks and Mitigations

- Risk: A private workspace package accidentally becomes a published runtime dependency. — Mitigation: put `@balaenis/pi-log` in consuming packages' `devDependencies`, keep it private, and verify package builds bundle it instead of externalizing it.
- Risk: Async file writes make logger tests flaky. — Mitigation: either expose a small `close(): Promise<void>`/`flush(): Promise<void>` method on `Logger` or structure tests to wait for file content with a short retry loop; prefer the smallest production-safe API.
- Risk: Changing `log.ts` exports breaks existing imports. — Mitigation: keep package-local adapter exports exactly named as today: `logDebug` for pi-format, `logForDebugging` for pi-lsp, `logError`, and `errorMessage`.
- Risk: Stale logging documentation remains inconsistent with actual defaults. — Mitigation: update `packages/pi-lsp/README.md` if it still references `~/.pi/pi-x-ide/debug.log`.
