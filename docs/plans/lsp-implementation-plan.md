# Pi LSP Extension — Implementation Plan

> Spec: [../specs/lsp-extension-spec.md](../specs/lsp-extension-spec.md)
> Feasibility: [../analysis/lsp-pi-port-feasibility.md](../analysis/lsp-pi-port-feasibility.md)
> Architecture: [../analysis/lsp-module-architecture.md](../analysis/lsp-module-architecture.md)
> Claude Code source: `/home/julian/workspace/source/claude-code-2.1.88/package-src/src`

This plan turns the spec into an actionable, SDK-verified build. It ports Claude Code's (CC) LSP
client into a standalone Pi extension (`pi-lsp`) so Pi's agent gains semantic code intelligence
(`goToDefinition` / `findReferences` / `hover`) and, in later phases, passive diagnostics.

About 70% of CC's LSP module is host-independent pure logic (JSON-RPC transport, the per-server
state machine, diagnostic dedup, formatting) and is ported nearly verbatim. The remaining 30% —
lifecycle timing, config source, and the tool harness — is rewritten against Pi's extension API.

---

## 1. Module map

Source lives in `src/`; Pi loads the built `dist/index.js` (or `src/index.ts` directly via jiti for
local iteration). Every `.ts` file starts with two `// ABOUTME:` lines.

| File                | Responsibility                                                                     | Phase                           | Porting source                                                        |
| ------------------- | ---------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| `index.ts`          | Entry `default (pi) => void`; session lifecycle wiring                             | 1 (extended 2)                  | new                                                                   |
| `log.ts`            | `logForDebugging` / `logError` / `errorMessage` / `sleep` (stderr, `PI_LSP_DEBUG`) | 1                               | replaces CC `utils/debug`, `utils/log`, `utils/errors`, `utils/sleep` |
| `types.ts`          | `LspServerState`, `ScopedLspServerConfig`, `LspToolDetails`                        | 1                               | CC `services/lsp/types`                                               |
| `client.ts`         | `createLSPClient` — spawn + JSON-RPC transport                                     | 1                               | CC `LSPClient.ts`                                                     |
| `instance.ts`       | `createLSPServerInstance` — state machine / retry / crash ceiling                  | 1                               | CC `LSPServerInstance.ts`                                             |
| `manager.ts`        | `createLSPServerManager` + global singleton + `isLspConnected`                     | 1 (extended 3)                  | CC `LSPServerManager.ts` + `manager.ts`                               |
| `config.ts`         | LSP server config source                                                           | 1 hardcoded → 3 `settings.json` | CC `services/lsp/config.ts` + `schemas.ts`                            |
| `formatters.ts`     | LSP responses → readable text                                                      | 1 (3 ops) → 3 (all)             | CC `tools/LSPTool/formatters.ts`                                      |
| `tools.ts`          | `registerTool` + input schema + execute flow                                       | 1 (3 ops) → 3 (9 ops)           | CC `tools/LSPTool/LSPTool.ts` + `schemas.ts` + `prompt.ts`            |
| `diagnostics.ts`    | Dedup + throttle + edit-aware cleanup                                              | 2                               | CC `LSPDiagnosticRegistry.ts`                                         |
| `symbol-context.ts` | Cursor symbol extraction (first 64KB)                                              | 3 (optional)                    | CC `tools/LSPTool/symbolContext.ts`                                   |

---

## 2. Corrections to the spec (verified against the installed SDK + CC runtime)

The spec was written before reading the installed SDK type declarations and CC's runtime config
schema. These corrections override the spec where they conflict.

1. **Tool return shape.** `AgentToolResult<T>` (`pi-agent-core/dist/types.d.ts:305`) is
   `{ content: (TextContent | ImageContent)[]; details: T; terminate?: boolean }`. `details` is
   **required**; there is **no `isError`** field. Every return supplies a `details` object, and
   errors are conveyed as plain text content (exactly as CC does in its `result` string).
2. **No `isEnabled` on `ToolDefinition`.** Unlike CC's `buildTool`, Pi's `ToolDefinition` has no
   `isEnabled`. The "LSP connected?" gate moves **inside `execute`**:
   `await waitForInitialization()` → `isLspConnected()` → return a clear text message if not ready.
3. **Config field is `extensionToLanguage`, not `extensions`.** Spec §4.7 shows
   `extensions: [".ts", ...]` (array), but `textDocument/didOpen` requires a `languageId` per file.
   CC's real schema is `extensionToLanguage: Record<ext, languageId>`, and extension routing keys
   are derived from `Object.keys(extensionToLanguage)`. We adopt `extensionToLanguage` as canonical.
   Phase 3's `settings.json` reader may still accept an `extensions` array as sugar by mapping it
   through a `guessLanguageId(ext)` table, but the internal config type stays `extensionToLanguage`.
4. **Build must externalize the SDK + use `--target node`.** `.mise/tasks/build` had no
   `--external`, so the runtime imports of `Type` / `StringEnum` / `truncateTail` would bundle a
   second copy of the SDK into `dist/index.js` — contradicting spec §2/§5 (host/extension
   SDK-instance mismatch). The build and dev tasks now pass `--external @earendil-works/pi-ai
--external @earendil-works/pi-coding-agent --external typebox --external vscode-jsonrpc` plus
   `--target node` (see correction 9).
5. **No `console` allowed (`no-console: error`).** CC's logging helpers don't exist here, so a tiny
   `log.ts` writes to `process.stderr`, gated by `PI_LSP_DEBUG`, off by default.
6. **ESM/bun, not CJS.** CC lazy-loads jsonrpc via `require("vscode-jsonrpc/node.js")`. This repo is
   `"type": "module"`, so we use `await import("vscode-jsonrpc/node.js")` inside `client.start()`.
   The lazy-load goal is preserved (`start()` is already async); `import type` keeps the annotations.
7. **`Type` and `StringEnum` both come from `@earendil-works/pi-ai`** (`StringEnum` via the
   `export * from "./utils/typebox-helpers"` re-export). `Static` is a type-only import from the
   same package.
8. **ESLint config gap.** The template's `...tseslint.configs.recommended.rules` spread is a no-op
   (that export is an array, so `.rules` is `undefined`), leaving base `no-unused-vars`/`no-undef`
   active — which false-positive on TS type-signature params and runtime globals like `setTimeout`.
   The config now explicitly enables `@typescript-eslint/no-unused-vars` (with `^_` ignore) and
   disables base `no-unused-vars` and `no-undef` (tsc already covers undefined identifiers).
9. **Phase 2: `--target bun` emits Bun-specific CJS shim.** Bun's bundler, when inlining CJS
   packages (`vscode-jsonrpc`), generated `var __require = import.meta.require` — a Bun API that
   does not exist in the Node.js runtime that pi uses. Calling `__require("util")` at runtime threw
   `TypeError: __require is not a function`. Fix: change `--target bun` → `--target node` (now
   emits `createRequire(import.meta.url)`), and externalise `vscode-jsonrpc` so its CJS internals
   load directly from `node_modules` instead of being inlined. The lazy-load `await
import("vscode-jsonrpc/node.js")` in `client.start()` resolves at runtime via Node.js ESM
   interop.

---

## 3. Lifecycle & singleton design

- **No factory side effects.** The `default (pi)` body only calls `registerLspTool(pi)` (pure
  metadata) and two `pi.on(...)` registrations. No process, timer, or watcher is created here.
- **`session_start`** → `initializeManager(ctx.cwd)`: synchronous, non-blocking, idempotent. It
  constructs the manager, parses config, and creates `LSPServerInstance` objects (no process
  spawn), then kicks the async `manager.initialize(cwd)` promise. `ctx.cwd` is threaded into each
  server's `workspaceFolder` → `InitializeParams.workspaceFolders` / `rootUri` / `rootPath`.
- **First tool call** lazily starts the relevant server (`ensureServerStarted` → `instance.start()`
  → `client.start()` spawns the process). `startupTimeout` failures hit the tool's clean error path.
- **`session_shutdown`** → `shutdownManager()`: idempotent (fires on quit/reload/new/resume/fork).
  Stops every running/error server (`client.stop()` = shutdown request → exit notify → dispose →
  kill), swallows errors, clears state, and bumps the generation counter to invalidate any in-flight
  init.
- **Tool gate.** `execute` returns a clear text message (not a throw) when LSP is not ready.

---

## 4. Phase 1 — MVP (this deliverable)

**Deliver:** `client` + `instance` + minimal `manager` + hardcoded `config` + `formatters` (3 ops)

- `tools` (3 ops) + `index` lifecycle + `log` + `types`, plus the build `--external` fix.

### Tasks

- [x] `log.ts` — stderr logger gated by `PI_LSP_DEBUG`; `errorMessage`, `sleep`.
- [x] `types.ts` — `LspServerState`, `ScopedLspServerConfig` (subset), `LspToolDetails`.
- [x] `client.ts` — faithful port of CC `LSPClient.ts` (dynamic jsonrpc import, `process.env`).
- [x] `instance.ts` — faithful port; drop CC's `restartOnCrash`/`shutdownTimeout` throw-guards
      (those fields are not on the Phase 1 config type; re-add in Phase 3).
- [x] `config.ts` — hardcoded `typescript-language-server` via `extensionToLanguage`.
- [x] `manager.ts` — trimmed `LSPServerManager` + singleton (`getManager`, `isLspConnected`,
      `waitForInitialization`, `initializeManager(cwd)`, `shutdownManager`, generation counter).
- [x] `formatters.ts` — `formatUri`, `groupByFile`, `formatLocation`, `extractMarkupText` +
      `formatGoToDefinitionResult` / `formatFindReferencesResult` / `formatHoverResult`.
- [x] `tools.ts` — single `lsp` tool, `StringEnum` 3-op enum, execute flow.
- [x] `index.ts` — factory + `session_start` / `session_shutdown` wiring.
- [x] `.mise/tasks/build` + `dev` — add the three `--external` flags.
- [x] `eslint.config.js` — TS-aware unused-vars, disable base `no-unused-vars` / `no-undef`.

### Key skeletons

`client.ts` (port — closure factory; only the three adaptations differ from CC):

```ts
export function createLSPClient(serverName, onCrash?) {
  let childProcess, connection, capabilities, isInitialized = false;
  let startFailed = false, startError, isStopping = false;
  const pendingHandlers = [], pendingRequestHandlers = [];
  return {
    async start(command, args, options) {
      const { createMessageConnection, StreamMessageReader, StreamMessageWriter, Trace } =
        await import("vscode-jsonrpc/node.js");                  // lazy, ESM
      childProcess = spawn(command, args, {
        stdio: ["pipe","pipe","pipe"], env: { ...process.env, ...options?.env },
        cwd: options?.cwd, windowsHide: true });
      await /* once('spawn') vs once('error') race with mutual cleanup */;
      // stderr→log; on('error')/on('exit')(non-zero & !isStopping → onCrash); stdin.on('error')
      connection = createMessageConnection(reader, writer);
      connection.onError(...); connection.onClose(...);          // BEFORE listen()
      connection.listen();
      connection.trace(Trace.Verbose, { log }).catch(...);
      // replay pendingHandlers + pendingRequestHandlers, then clear
    },
    async initialize(params) { /* sendRequest('initialize') → capabilities; notify('initialized') */ },
    sendRequest, sendNotification, onNotification, onRequest,
    async stop() { /* isStopping=true; shutdown→exit; finally dispose+removeAllListeners+kill; rethrow */ },
  };
}
```

`instance.ts` (port): state machine `stopped→starting→running→stopping(+error)`; the full new+legacy
`InitializeParams` matrix (`processId`, `initializationOptions`, `workspaceFolders`, `rootPath`,
`rootUri`, capabilities incl. `general.positionEncodings:["utf-16"]`); `withTimeout(initPromise,
startupTimeout)`; transient retry on `-32801` with `sleep(500 * 2**attempt)`, `MAX_RETRIES=3`;
crash ceiling `maxRestarts ?? 3`; `isHealthy() = state==="running" && client.isInitialized`.

`manager.ts` (port + singleton):

```ts
const servers = new Map(), extensionMap = new Map(), openedFiles = new Map();
async function initialize(cwd) {                                // CHANGE: takes cwd
  for (const [name, raw] of Object.entries((await getAllLspServers()).servers)) {
    const config = { ...raw, workspaceFolder: raw.workspaceFolder ?? cwd };
    for (const ext of Object.keys(config.extensionToLanguage)) extensionMap...push(name);
    const inst = createLSPServerInstance(name, config); servers.set(name, inst);
    inst.onRequest("workspace/configuration", p => p.items.map(() => null));
  }
}
// openFile→didOpen (languageId from extensionToLanguage[ext]||"plaintext"),
// changeFile→didChange (falls back to openFile), saveFile→didSave, closeFile→didClose
// singleton: getManager(), isLspConnected(), waitForInitialization(),
//            initializeManager(cwd), shutdownManager(); generation counter guards stale init
```

`tools.ts` (Pi harness):

```ts
const PARAMETERS = Type.Object({
  operation: StringEnum(['goToDefinition', 'findReferences', 'hover']),
  filePath: Type.String(),
  line: Type.Number(),
  character: Type.Number(),
});
pi.registerTool<typeof PARAMETERS, LspToolDetails>({
  name: 'lsp',
  label: 'LSP',
  description: DESCRIPTION,
  parameters: PARAMETERS,
  async execute(_id, params, _signal, _onUpdate, ctx) {
    return runLsp(params, ctx.cwd);
  },
});
// runLsp: waitForInitialization → isLspConnected gate → resolve path (UNC skip) →
//   stat validate (ENOENT / not-a-file / >10MB) → ensure open (read file) →
//   1-based→0-based → manager.sendRequest → formatResult → truncateTail →
//   { content:[{type:"text",text}], details:{operation,filePath,resultCount,fileCount,truncated} }
// all wrapped in try/catch → textResult("Error performing <op>: <msg>")
```

`index.ts`:

```ts
export default function (pi: ExtensionAPI): void {
  registerLspTool(pi); // pure metadata, safe in factory
  pi.on('session_start', (_e, ctx) => initializeManager(ctx.cwd));
  pi.on('session_shutdown', async () => {
    await shutdownManager();
  });
}
```

### Phase 1 acceptance (spec §6)

- [x] `goToDefinition` returns correct `file:line:col` (1-based) in a TS project.
- [x] `findReferences` returns multi-file references grouped by file.
- [x] `hover` returns a type signature.
- [x] A missing server binary surfaces a clear error, no crash.
- [x] `session_shutdown` kills the process (`ps` shows no residue); `/reload` leaves exactly one.
- [x] `bunx tsc --noEmit` + `hk check` pass.

---

## 5. Phase 2 — Passive diagnostics

**Deliver:** `diagnostics.ts` + `context` hook injection + `tool_result`-triggered `didChange` /
cache clear.

### Tasks

- [x] `diagnostics.ts` — port `LSPDiagnosticRegistry`: same-batch dedup key
      `{message, severity, range, source, code}`; cross-turn dedup `LRUCache<fileUri, Set<key>>`
      (max 500); throttle `MAX_DIAGNOSTICS_PER_FILE=10`, `MAX_TOTAL_DIAGNOSTICS=30`, severity sort;
      `register(uri, diagnostics)`, `drain()`, `clearForFile(uri)`.
- [x] Register a `publishDiagnostics` notification handler per server (in `manager.initialize`)
      that calls `diagnostics.register(uri, list)`.
- [x] `pi.on("context", …)` — drain new diagnostics, strip previous injected blocks from
      `event.messages`, append the fresh block; return `{ messages }`.
- [x] `pi.on("tool_result", …)` — when `toolName` is `edit`/`write`, extract the file path from
      `event.input.path`, send `didChange` + `didSave`, and `diagnostics.clearForFile(uri)`.
- [x] Decide `LRUCache` source (small internal impl vs dependency) — keep it dependency-light.
      → Implemented a minimal `LruMap` in `diagnostics.ts` (no new runtime dep).

### Acceptance (spec §6)

- [x] Editing in a type error makes the diagnostic appear next turn. _(wiring:
      `tool_result` → `syncFileChange` (didChange+didSave) → server re-publishes →
      `context` hook drains and injects; verified via registry unit smoke test)_
- [x] After a fix, the diagnostic does not reappear (dedup works). _(cross-turn LRU
      dedup + empty-publish clears pending; verified)_
- [x] Heavy diagnostics throttle to ≤30, errors first. _(per-file 10 / total 30 caps
      with severity sort; verified)_
- [x] Old injected blocks are stripped before each LLM call (no accumulation).
      _(`stripDiagnosticBlocks` filters `customType === "lsp-diagnostics"`)_
- [x] `bunx tsc --noEmit` + `hk check` pass.

### Resolved decisions (spec §8)

- Use the `context` hook for passive diagnostic injection. It runs before every LLM call, supports
  same-loop diagnostics after `edit`/`write`, and does not persist injected blocks to the session
  transcript.
- Extract edited paths from `tool_result.input.path`, not `details`. SDK evidence: `EditToolInput`
  and `WriteToolInput` both carry `path`; `EditToolDetails` has only diff/patch metadata, and
  `WriteToolResultEvent.details` is `undefined`.

---

## 6. Phase 3 — Multi-server + config + remaining operations

**Deliver:** `config.ts` reading `settings.json`; `manager` multi-language routing; the other 6
operations; gitignore filtering; optional `symbol-context.ts`; optional reference-completeness
priming for cold-start workspaces.

### Tasks

- [x] `config.ts` — read `~/.pi/agent/settings.json` then `<cwd>/.pi/settings.json` (project
      overrides global), parse the `lsp.servers` segment, validate (command without spaces unless
      absolute path; non-empty `extensionToLanguage`), apply `$VAR` / `${VAR}` env substitution.
      Make `getAllLspServers()` async (signature already compatible).
- [x] Re-add the `restartOnCrash` / `shutdownTimeout` handling (or accept-and-ignore) in
      `instance.ts` once the full config type returns.
- [x] `tools.ts` — extend the `StringEnum` to all 9 operations; keep `workspaceSymbol` aligned
      with Claude Code (`filePath` selects the server; query is always empty) and require
      positive integer `line`/`character`; map the remaining methods; implement the callHierarchy
      two-step (`prepareCallHierarchy` → `incomingCalls`/`outgoingCalls`).
- [x] `formatters.ts` — add `symbolKindToString` (26 kinds), `plural`, document-symbol,
      workspace-symbol, and call-hierarchy formatters.
- [x] `filterGitIgnoredLocations` — `git check-ignore` in batches of 50, 5s timeout, for
      location-returning operations.
- [ ] `symbol-context.ts` (optional) — first-64KB symbol extraction for richer tool rendering.
      → Deferred: only useful when overriding `renderCall`/`renderResult`, which this extension
      does not do. Revisit if custom tool rendering is added.
- [x] `findReferences` workspace completeness (optional) — do **not** eagerly `didOpen` whole
      repos by default; documented the cold-start limitation below. Workspace priming is left as
      opt-in future work.

### Acceptance (spec §6)

Real-Pi verification uses the `fixtures/phase3-smoke` fixture (`bun run pi` loads the built
extension into a real `pi -p` session with local `typescript-language-server` + `pyright`).

- [x] `.ts` and `.py` route to different servers in one session. _(config: temp `.pi/settings.json`
      `direct-route ts_server typescript py_server python`. **Real Pi**: stderr shows
      `loaded 2 LSP server(s): typescript, python`; `.ts` hover answered by the typescript server,
      `.py` hover on `src/caller.py` line 5 (the `def target` line) returns
      `(function) def target() -> Literal[1]` from the pyright server)_
- [x] Adding/removing a server in `settings.json` takes effect after `/reload`. _(verified with
      `initializeManager` → `shutdownManager` → `initializeManager`: `first-session py_server,ts_server`,
      `second-session py_only`; config is read fresh on each `session_start`. **Interactive `/reload`
      still needs a human** — run `bun run pi` in `fixtures/phase3-smoke`, edit `.pi/settings.json`,
      `/reload`, re-test per the fixture README §A2.)_
- [x] callHierarchy two-step returns incoming/outgoing calls. _(**Real Pi**: model drove the `lsp`
      tool; stderr shows `prepareCallHierarchy` → `callHierarchy/outgoingCalls` then
      `callHierarchy/incomingCalls`; result `incoming=caller`, `outgoing=callee`)_
- [x] `.gitignore`d files are excluded from results. _(unit: `filterGitIgnoredLocations` returned
      only `kept.ts`. **Real Pi + control**: with `.gitignore` present, `findReferences` on `secret`
      (after `didOpen` of `src/ignored.ts`) returns only `src/main.ts`; with `.gitignore` removed
      (control) it returns `src/main.ts` + `src/ignored.ts` — proving the filter removes the ignored
      file in the live pipeline)_
- [x] Optional: cold-start `findReferences` behavior for unopened files is documented; workspace
      priming is not enabled. _(**Real Pi**: `src/ignored.ts` is absent from `findReferences` until it
      is `didOpen`'d by a prior operation — the documented cold-start limitation, observed live; see
      limitation note below and README Limitations)_
- [x] `bunx tsc --noEmit` + `hk check` pass. _(also ran full `mise run lint`,
      `mise run format_check`, and `mise run build`; `mise run test` is not applicable yet because no
      test files exist)_

#### Concurrency fix from real-Pi smoke (fixed)

When two `lsp` calls race the first server startup, the second call's `didOpen` used to fire
while the server was still `starting` and log `Cannot send notification to LSP server
'typescript': server is starting`. Root cause: `ensureServerStarted` returned immediately when
`state === 'starting'` instead of awaiting the in-flight `start()`. Fixed by sharing an in-flight
`startingPromise` in `createLSPServerInstance` (concurrent `start()` callers await the same
startup) and making `ensureServerStarted` await `start()` whenever `state !== 'running'`. **Real
Pi re-run**: the A3 two-call case now logs `server is starting` 0 times (was 3) and both calls
succeed first try.

### `findReferences` cold-start limitation

The extension opens files in the LSP server lazily (only when a tool operation targets them).
`findReferences` therefore returns references only for files the server has already indexed:

- Files the agent has opened via an LSP operation in this session.
- Files the server itself indexes from disk (e.g. typescript-language-server loads the project's
  `tsconfig.json` and indexes referenced files on startup).

References in files the server has not opened or indexed (e.g. unopened files outside the
`tsconfig` include set) may be missing on a cold start.

The extension does **not** eagerly `didOpen` the whole repository by default — that would be
expensive and can overwhelm servers. If workspace-wide reference completeness is needed, a future
opt-in, bounded workspace-priming feature could `didOpen` a gitignore-respecting, size-capped
allowlist of files before reference queries. That remains future work; the current behavior matches
Claude Code's default (no eager workspace priming).

### Future optimization: server `settings` delivery

`ScopedLspServerConfig.settings` is accepted for schema compatibility, but it is not delivered to
the language server in Phase 3. This matches Claude Code's current behavior: its schema describes
`settings` as data for `workspace/didChangeConfiguration`, but the implementation declares
`workspace.configuration: false`, answers `workspace/configuration` with `null`, and never sends
`workspace/didChangeConfiguration`.

Future work can make this field effective by sending `workspace/didChangeConfiguration` after
initialization and/or by answering `workspace/configuration` requests from `config.settings`.

---

## 7. Validation

Per phase: `bunx tsc --noEmit` (strict typecheck) and `hk check` (eslint + prettier). Functional
verification uses a **real** LSP server in a real TS/Python project — no mocks (per the repo
constraint). Bundle check: `@earendil-works/*` remain bare `from "..."` imports in `dist/index.js`
(externalized, host-provided). `vscode-jsonrpc` is **also externalized** as a dynamic
`import("vscode-jsonrpc/node.js")` and resolved from the package's `dependencies` at runtime —
this changed in Phase 2 (`--target node` + `--external vscode-jsonrpc`) because bundling its CJS
internals under `--target node` broke the Node runtime. It is safe to externalize: vscode-jsonrpc
holds no shared identity with the host, unlike the Pi SDK.

---

## 8. Risks

- **Build externalize (handled).** The one mandatory non-source change; without it the host loads a
  second SDK instance.
- **No `isError` channel.** Failures show as text; Pi won't visually flag the tool row as errored.
- **`isLspConnected()` pending window.** `initialize()` only constructs instances (no spawn), so it
  can report connected while a server's `state` is still `stopped`; the real `start()` (and its
  `startupTimeout`) runs on first tool use and failures hit the clean error path.
- **WSL path/URI.** `pathToFileURL(path.resolve(cwd, filePath)).href` yields POSIX `file:///…`;
  the Windows drive-letter branch in `formatUri` stays inert but is kept for portability.
- **Concurrent multi-server startup (Phase 3).** May need a cap on simultaneously starting servers
  (spec §8 open question).
