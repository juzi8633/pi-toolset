# Grok ACP Lazy Chunk Implementation Plan

**Goal:** Reduce `@balaenis/pi-agents` extension import time by moving the optional Grok ACP runtime and its bundled ACP SDK/Zod graph behind one coarse, concurrency-safe dynamic import without changing Pi runtime behavior.

**Inputs:** The 2026-07-23 local bundle and Jiti measurements; `packages/pi-agents/src/index.ts`; `src/execution/execution.ts`; `src/interactive/interactive-agent.ts`; the Grok ACP runtime modules; `.mise/tasks/build/_default`; `.github/workflows/pr.yml`; `scripts/postbuild.ts`; `scripts/benchmark-startup.ts`; the prior startup plan at `docs/plans/2026-07-22-startup-import-optimization-plan.md`; Pi extension documentation; Bun code-splitting documentation from `/oven-sh/bun`.

**Assumptions:**

- Most Pi launches do not immediately use `runtime: "grok-acp"`; paying the ACP import cost on the first Grok ACP call is preferable to paying it on every Pi startup.
- `effect` remains in the startup graph because background management, run persistence, and session leases use it outside Grok ACP. Moving Effect into the ACP chunk is out of scope.
- `pi.build.splitting` is repository-owned package build metadata. Pi does not consume it at runtime.
- The implementation is worth shipping only if the same-machine fresh-process warm Jiti median improves by at least 15% and the Windows cold `module import` measurement improves by at least 15% without a material factory regression.
- The measured 2026-07-23 Linux control values are evidence, not permanent timing gates: single bundle `1,853,148` bytes; fresh-process warm-disk Jiti median `96.029ms`; unrefactored splitting median `110.877ms`; unrefactored startup static graph `1,765,306` bytes with only `34,500` bytes (`1.92%`) deferred. The same metafile attributes `606,493` startup-static bytes to the ACP SDK/Zod chunk and `21,120` bytes to the Grok client chunk, grounding the `1_325_000`-byte ceiling after both edges become dynamic.

**Architecture:** Keep `dist/index.js` as the only Pi extension entry. Move the Grok-specific single-agent implementation into a runtime façade that has no value import back to `execution.ts`, and reach that façade through one memoized loader shared by normal execution and the interactive registry. Enable Bun splitting only for opted-in packages; use the build metafile to prove that ACP SDK/Zod inputs are dynamically reachable but absent from the startup static closure.

**Tech Stack:** TypeScript, Bun 1.3.14 bundler and test runner, Jiti 2.7.0, Effect 3.22.0, ACP SDK 1.2.1, Mise, GitHub Actions, Pi extension APIs.

---

## Scope

### Included

- A repeatable fresh-process warm Jiti import benchmark.
- A leaf execution-contract module that removes type dependencies on `execution.ts`.
- A Grok ACP execution module and single lazy runtime façade.
- One concurrency-safe dynamic loader used by all Grok ACP entry paths.
- Opt-in Bun code splitting with hashed chunks under `dist/chunks/`.
- Metafile-based startup-graph, dependency-placement, size, and packaging gates.
- Linux warm and Windows cold performance acceptance checks.
- Runtime, build, profiling, and release documentation updates.

### Out of Scope

- Lazily loading Effect or moving required startup work from module import into the extension factory/session-start path.
- Dynamically importing PI-RPC execution or changing its static cycle protection.
- Lazily loading `execution/tool.ts`, the interactive registry, run store, renderers, or commands.
- Chain workflow splitting. If ACP splitting ships and profiling still justifies more work, chain splitting gets a separate plan.
- Pi host loader/Jiti configuration changes, minification, antivirus exclusions, or runtime feature changes.
- Public exports for internal chunks. `package.json.exports` continues to expose only the extension and artifact-reader entrypoints.

## Acceptance Targets

### Deterministic gates

- `dist/index.js` remains the only path in `pi.extensions` and its default export remains a function.
- The startup static output closure is at most `1_325_000` bytes, a 25% reduction from the measured unrefactored splitting graph.
- No startup-static output contains an input from `@agentclientprotocol/sdk` or its bundled `zod` dependency.
- At least one dynamic edge leaving the startup static closure reaches an output containing `@agentclientprotocol/sdk` input.
- `effect`, `@agentclientprotocol/sdk`, and their subpaths remain bundled rather than external.
- Pi host peers remain external.
- Total emitted JavaScript for the main extension graph remains at most `2_621_440` bytes.
- The packed npm file list contains every chunk referenced by `dist/index.js` and contains no stale unreferenced file under `dist/chunks/`.

### Performance ship gates

- Same machine, same artifact path: fresh-process warm Jiti median improves by at least 15% from the freshly captured control.
- Reference Windows machine: cold `pi-agents ... module import` improves by at least 15% from the freshly captured control.
- Windows factory timing regresses by no more than 10%.
- First Grok ACP use remains functionally correct; any deferred import latency is reported separately rather than hidden inside the startup number.
- Both relative timing gates are mandatory: Windows cold improvement does not override a failed fresh-process warm gate, and Linux warm improvement does not override a failed Windows cold gate. If either timing gate fails, do not ship splitting; revert the build opt-in and retain only source-boundary refactors that are behavior-neutral and independently maintainable.

## File Map

- Create: `packages/pi-agents/src/execution/execution-types.ts` — shared execution types with no value imports from execution implementations.
- Create: `packages/pi-agents/src/execution/execution-result.ts` — shared result stamping, update emission, and abort finalization helpers used by Pi and Grok execution.
- Create: `packages/pi-agents/src/runtime/grok-acp/grok-acp-execution.ts` — extracted Grok ACP single-agent and fresh-TUI execution flows.
- Create: `packages/pi-agents/src/runtime/grok-acp/grok-acp-runtime.ts` — the sole lazy façade exported to runtime callers.
- Create: `packages/pi-agents/src/runtime/grok-acp/grok-acp-runtime-loader.ts` — memoized dynamic importer with retry-after-load-failure behavior.
- Create: `packages/pi-agents/scripts/jiti-host-modules.ts` — shared Jiti host virtual-module construction for startup and built-runtime workers.
- Create: `packages/pi-agents/scripts/benchmark-startup-worker.ts` — one fresh-process Jiti import sample with host peers loaded outside the timer.
- Create: `packages/pi-agents/scripts/smoke-built-lazy-runtime.ts` — Jiti smoke for the emitted entry followed by its hashed Grok ACP runtime chunk.
- Create: `packages/pi-agents/scripts/bundle-graph.ts` — Bun metafile parsing and static/dynamic output-closure analysis.
- Create: `packages/pi-agents/tests/runtime/grok-acp/grok-acp-runtime-loader.test.ts` — loader concurrency, cache, retry, and façade-shape coverage.
- Create: `packages/pi-agents/tests/scripts/bundle-graph.test.ts` — cross-platform synthetic metafile graph coverage.
- Modify: `packages/pi-agents/src/execution/execution.ts` — retain Pi dispatch and dynamically load only the Grok ACP branch.
- Modify: `packages/pi-agents/src/execution/chain.ts` — import abort values from the existing leaf module and callback types from `execution-types.ts`; do not make chain dynamic in this plan.
- Modify: `packages/pi-agents/src/execution/tool.ts` — consume moved execution types without changing orchestration.
- Modify: `packages/pi-agents/src/interactive/interactive-agent.ts` — obtain the Grok ACP transport factory through the shared runtime loader.
- Modify: `packages/pi-agents/src/interactive/interactive-execution.ts` — consume execution contracts without a type import from `execution.ts`.
- Modify: `packages/pi-agents/src/runtime/pi-rpc/pi-rpc-execution.ts` — consume execution contracts while preserving static PI-RPC value imports.
- Modify: `packages/pi-agents/src/runtime/pi-rpc/pi-rpc-transport.ts` — consume moved spawn types.
- Modify: `packages/pi-agents/scripts/benchmark-startup.ts` — orchestrate fresh worker processes and report stable comparative samples.
- Modify: `packages/pi-agents/scripts/postbuild.ts` — validate the full emitted graph using the transient Bun metafile.
- Modify: `packages/pi-agents/package.json` — opt this package into splitting through `pi.build.splitting` without exposing chunks publicly.
- Modify: `.mise/tasks/build/_default` — support opt-in splitting, chunk cleanup, transient metafiles, and postbuild metadata handoff.
- Modify: `.github/workflows/pr.yml` — mirror the splitting/metafile build on Windows.
- Modify: `packages/pi-agents/tests/execution/execution.test.ts` — preserve existing Grok behavior tests and add concurrent lazy-load regression coverage.
- Modify: `packages/pi-agents/tests/interactive/interactive-agent.test.ts` — verify interactive Grok transport creation still uses one runtime load.
- Modify: `packages/pi-agents/README.md` — document split artifacts and current validation commands.
- Modify: `packages/pi-agents/docs/profiling.md` — document fresh-process benchmarking, graph metrics, deferred-cost measurement, and release protocol.
- Modify: `packages/pi-agents/docs/explanation.md` — explain the lazy ACP boundary and retained PI-RPC static-cycle protection.
- Modify: `packages/pi-agents/CHANGELOG.md` — record the startup optimization and unchanged public API.

## Tasks

### Task 1: Replace the Too-Hot Startup Benchmark

**Outcome:** Startup comparisons use a fresh Bun/Jiti process per sample while keeping host-peer setup and process startup outside the measured import interval.

**Files:**

- Create: `packages/pi-agents/scripts/jiti-host-modules.ts`
- Create: `packages/pi-agents/scripts/benchmark-startup-worker.ts`
- Modify: `packages/pi-agents/scripts/benchmark-startup.ts`
- Modify: `packages/pi-agents/docs/profiling.md`

**Steps:**

- [ ] Start `jiti-host-modules.ts` and `benchmark-startup-worker.ts` with the required two-line `ABOUTME:` header.
- [ ] Move host virtual-module construction into `jiti-host-modules.ts`: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai/compat` under `@earendil-works/pi-ai`, and `typebox`. Export one `createHostVirtualModules()` function returning a fresh object.
- [ ] Have the worker accept exactly `--entry <absolute-or-relative-path>`, resolve it to an absolute file URL, construct Jiti with `moduleCache: false`, `tryNative: false`, and `createHostVirtualModules()`, then start the timer immediately before `jiti.import()`.
- [ ] Validate that the imported default export is a function and print one JSON object containing `elapsedMs` and the resolved entry path. Do not call the extension factory.
- [ ] Keep argument parsing, median calculation, and reporting in `benchmark-startup.ts`, but replace in-process samples with sequential child invocations of `process.execPath` running the worker.
- [ ] Treat `--warmups` as discarded worker processes and `--samples` as measured worker processes. Child-process startup is excluded because the worker starts its timer after its own imports.
- [ ] Add named constant `DEFAULT_WORKER_TIMEOUT_MS = 30_000` and CLI flag `--worker-timeout-ms <n>`. Fail when a worker exits non-zero, emits invalid JSON, imports a non-function default, or exceeds that timeout; include worker stderr in the failure.
- [ ] Rename the report kind to `fresh-process-warm-jiti-benchmark` and state that disk cache is warm and filesystem/antivirus cold-cache effects are not represented.
- [ ] Preserve `--warmups`, `--samples`, and `--max-median-ms`; keep `DEFAULT_MAX_MEDIAN_MS = 250` as a loose local guard rather than the incremental ship target.
- [ ] Before source-boundary changes, build the current single bundle and record at least 15 samples on Linux plus the Windows cold/five-run-warm protocol values in the implementation PR.

**Validation:**

- Run: `mise run build --package packages/pi-agents`
- Expected: Existing single-bundle build succeeds and postbuild passes.
- Run: `cd packages/pi-agents && bun run scripts/benchmark-startup.ts --warmups 2 --samples 15 --max-median-ms 250`
- Expected: Seventeen separate workers run, 15 samples are reported, and the median is based only on measured workers.
- Run: `cd packages/pi-agents && bun run scripts/benchmark-startup.ts --samples 0`
- Expected: The command exits non-zero with an invalid positive-number diagnostic.
- Run: `cd packages/pi-agents && bun run scripts/benchmark-startup.ts --samples 1 --worker-timeout-ms 0`
- Expected: The command exits non-zero with an invalid positive-number diagnostic.
- Run: `cd packages/pi-agents && bun run scripts/benchmark-startup-worker.ts --entry dist/index.js`
- Expected: One JSON sample is printed and the imported default export is validated without invoking the factory.

### Task 2: Create an Acyclic Grok ACP Runtime Boundary

**Outcome:** `execution.ts` has no static value path to Grok ACP modules or the ACP SDK, while Pi and Grok behavior remain covered by the existing execution suites.

**Files:**

- Create: `packages/pi-agents/src/execution/execution-types.ts`
- Create: `packages/pi-agents/src/execution/execution-result.ts`
- Create: `packages/pi-agents/src/runtime/grok-acp/grok-acp-execution.ts`
- Create: `packages/pi-agents/src/runtime/grok-acp/grok-acp-runtime.ts`
- Create: `packages/pi-agents/src/runtime/grok-acp/grok-acp-runtime-loader.ts`
- Create: `packages/pi-agents/tests/runtime/grok-acp/grok-acp-runtime-loader.test.ts`
- Modify: `packages/pi-agents/src/execution/execution.ts`
- Modify: `packages/pi-agents/src/execution/chain.ts`
- Modify: `packages/pi-agents/src/execution/tool.ts`
- Modify: `packages/pi-agents/src/interactive/interactive-agent.ts`
- Modify: `packages/pi-agents/src/interactive/interactive-execution.ts`
- Modify: `packages/pi-agents/src/runtime/pi-rpc/pi-rpc-execution.ts`
- Modify: `packages/pi-agents/src/runtime/pi-rpc/pi-rpc-transport.ts`
- Modify: `packages/pi-agents/tests/execution/execution.test.ts`
- Modify: `packages/pi-agents/tests/interactive/interactive-agent.test.ts`

**Steps:**

- [ ] Start every new TypeScript file with two `ABOUTME:` lines.
- [ ] Move `SpawnedChild`, `SpawnFn`, `ResumePromptContext`, `RunSingleAgentOptions`, and `OnUpdateCallback` from `execution.ts` to `execution-types.ts`. Keep imports in this module type-only except for standard TypeScript declarations.
- [ ] Update `tool.ts`, `interactive-agent.ts`, `interactive-execution.ts`, `pi-rpc-execution.ts`, and `pi-rpc-transport.ts` to import those types from `execution-types.ts`.
- [ ] Change `chain.ts` and `tool.ts` to import `ABORT_MESSAGE`, `AgentAbortError`, `getAbortResult`, and `isAbortError` directly from `execution/abort.ts` as applicable, and callback/spawn/resume types from `execution-types.ts`. This removes avoidable value/type edges to `execution.ts` but does not make chain lazy.
- [ ] Move `stampUnitContext`, `emitRunningSnapshot`, `emitTerminalSnapshot`, `resolveAbortOrigin`, and `finalizeAborted` into `execution-result.ts`. Preserve their current signatures and result/abort semantics.
- [ ] Move `runSingleAgentGrokAcp`, `runFreshTuiGrokAcp`, and the Grok-only successful-completion predicate from `execution.ts` into `runtime/grok-acp/grok-acp-execution.ts` without rewriting the protocol, lease, persistence, terminal mapping, coalescing, or transport ownership logic.
- [ ] Delete the direct `grok-acp-client.ts`, `grok-acp-invocation.ts`, `grok-acp-parser.ts`, `grok-command.ts`, `session-lease.ts`, `interactive-execution.ts`, and Grok-only update-coalescer imports that become unused in `execution.ts`; retaining any direct ACP implementation import defeats the boundary.
- [ ] Ensure `grok-acp-execution.ts` imports shared types/helpers from `execution-types.ts`, `execution-result.ts`, and `abort.ts`; it must not value-import `execution.ts`, `tool.ts`, or `index.ts`.
- [ ] Create `grok-acp-runtime.ts` as the only dynamic façade. Export `runSingleAgentGrokAcp` and `createGrokAcpInteractiveTransport`; do not add unrelated exports or public package exports.
- [ ] Implement `createGrokAcpRuntimeLoader(importer)` in `grok-acp-runtime-loader.ts`. Cache one in-flight/resolved promise so parallel Grok calls share one import, reset the cache after rejection so a later call can retry, and export the production `loadGrokAcpRuntime` bound to `import('./grok-acp-runtime.ts')`.
- [ ] In `runSingleAgent`, keep validation and effective-runtime selection in the static module. Only after `effectiveRuntime === GROK_ACP_RUNTIME`, await `loadGrokAcpRuntime()` and call its `runSingleAgentGrokAcp` export.
- [ ] In `interactive-agent.ts`, replace the direct dynamic import of `grok-acp-interactive-transport.ts` with `loadGrokAcpRuntime()` and its `createGrokAcpInteractiveTransport` export. Preserve the injected `grokAcpTransportFactory` test seam.
- [ ] Preserve the static `runSingleAgentPiRpc` import and its existing Jiti cycle comment. Do not route Pi through the lazy façade.
- [ ] On a missing/corrupt lazy chunk, throw a clear `Grok ACP runtime failed to load: <cause>` error from the Grok call path. Pi runtime calls and extension startup must remain usable.
- [ ] Add loader tests for: concurrent calls invoke the importer once; resolved calls reuse the module; a rejected import is shared by concurrent callers; the next call retries; and the production façade exposes both required functions.
- [ ] Add an execution regression test that starts at least two fake Grok ACP runs concurrently and verifies both complete without partially initialized exports.
- [ ] Retain all existing Grok ACP success, resume, abort, high-frequency update, terminal, transport, and error-mapping assertions.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/runtime/grok-acp/grok-acp-runtime-loader.test.ts tests/execution/execution.test.ts tests/interactive/interactive-agent.test.ts tests/interactive/interactive-execution.test.ts`
- Expected: Loader and orchestration tests pass, including concurrent first use.
- Run: `cd packages/pi-agents && bun test tests/runtime/grok-acp/grok-acp-client.test.ts tests/runtime/grok-acp/grok-acp-interactive-transport.test.ts tests/runtime/grok-acp/grok-acp-invocation.test.ts tests/runtime/grok-acp/grok-acp-parser.test.ts tests/runtime/grok-acp/grok-acp-transcript.test.ts tests/runtime/pi-rpc/pi-rpc-execution.test.ts tests/runtime/pi-rpc/pi-rpc-integration.test.ts`
- Expected: Grok ACP and PI-RPC focused suites pass with no behavior changes.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: No type errors after moving execution contracts.
- Run: `rg "from ['\"].*execution\.ts['\"]" packages/pi-agents/src/runtime/grok-acp packages/pi-agents/src/interactive/interactive-execution.ts packages/pi-agents/src/runtime/pi-rpc`
- Expected: No value import from `execution.ts`; any remaining matches must be removed or proven type-only and moved to `execution-types.ts`.
- Run: `rg "grok-acp-(client|invocation|parser|command|interactive-transport)|runSingleAgentInteractive" packages/pi-agents/src/execution/execution.ts`
- Expected: No output; `execution.ts` reaches Grok only through `grok-acp-runtime-loader.ts`.
- Run: `mise run build --package packages/pi-agents`
- Expected: The source-boundary refactor still builds successfully before splitting is enabled.

### Task 3: Enable Opt-In Splitting and Enforce the Output Graph

**Outcome:** `pi-agents` emits hashed internal chunks, and postbuild proves the ACP SDK is outside the startup static graph while package-owned dependencies remain bundled.

**Files:**

- Create: `packages/pi-agents/scripts/bundle-graph.ts`
- Create: `packages/pi-agents/tests/scripts/bundle-graph.test.ts`
- Modify: `packages/pi-agents/package.json`
- Modify: `.mise/tasks/build/_default`
- Modify: `.github/workflows/pr.yml`
- Modify: `packages/pi-agents/scripts/postbuild.ts`

**Steps:**

- [ ] Add `pi.build.splitting: true` to `packages/pi-agents/package.json`. Keep `pi.extensions`, `exports`, dependencies, peers, and published `files` unchanged.
- [ ] In `.mise/tasks/build/_default`, read `.pi.build.splitting // false`. Packages without the flag retain the existing single-bundle command and output shape.
- [ ] For opted-in packages, remove only `dist/chunks/` before the main build, then add `--splitting` and `--chunk-naming "chunks/[name]-[hash].[ext]"`. Do not remove unrelated dist entrypoints.
- [ ] Create a temporary main-build metafile with `mktemp`, include it in the existing cleanup trap, and pass it to Bun with `--metafile=<path>`.
- [ ] Keep external arguments separate from main-build arguments so the optional artifact-reader entry builds without splitting and cannot overwrite the main graph metadata.
- [ ] Invoke package postbuild with `PI_BUILD_METAFILE=<temp-path>` in the environment. Apply the same handoff to either the package `postbuild` script or conventional `scripts/postbuild.ts` path.
- [ ] Mirror the opted-in splitting in the Windows PowerShell build in `.github/workflows/pr.yml` with this exact lifecycle: `$chunksDir = Join-Path (Get-Location) 'dist/chunks'`; remove it with `Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`; allocate `$metafile = [System.IO.Path]::GetTempFileName()`; run `bun build ./src/index.ts --outdir dist --target node --splitting --chunk-naming 'chunks/[name]-[hash].[ext]' "--metafile=$metafile" @externalArgs`; set `$env:PI_BUILD_METAFILE = $metafile` before postbuild; and remove both the environment variable and temp file in `finally`.
- [ ] Implement `bundle-graph.ts` as a pure helper that normalizes Windows/POSIX paths, identifies the `src/index.ts` output, resolves output imports relative to each importing output, and computes static closure from `import-statement` plus dynamic reachability from `dynamic-import`. Ignore `require-call`, `require-resolve`, `at`, `url-token`, and `internal` kinds rather than treating them as startup ESM edges.
- [ ] Add synthetic metafile tests for nested chunk directories, shared static chunks, dynamic descendants, external imports, missing outputs, path separator differences, and cycles.
- [ ] Update `postbuild.ts` to require `PI_BUILD_METAFILE` when `pi.build.splitting` is true and fail with an actionable message when metadata is missing or malformed.
- [ ] Before enforcing the byte gate, run one split build after Task 2 and record the candidate static closure. Confirm that the measured `606,493`-byte ACP SDK/Zod contribution and `21,120`-byte Grok client contribution left the static closure. Then enforce named constants `MAX_STARTUP_STATIC_GRAPH_BYTES = 1_325_000` and `MAX_TOTAL_MAIN_GRAPH_BYTES = 2_621_440`; if the ACP placement checks pass but the candidate exceeds the startup ceiling, stop and profile rather than silently loosening it.
- [ ] Use metafile `inputs` to classify ACP SDK paths in both standard `node_modules/@agentclientprotocol/sdk/` form and Bun cache `node_modules/.bun/@agentclientprotocol+sdk@.../node_modules/@agentclientprotocol/sdk/` form. Apply equivalent optional classification to `zod`.
- [ ] Fail if any ACP SDK or Zod input contributes bytes to the startup static closure. Fail if no dynamically reachable output contains ACP SDK input.
- [ ] Scan every emitted main-graph JavaScript file for external import specifiers. Reject external `effect`, `effect/*`, `@agentclientprotocol/sdk`, and ACP subpaths; continue requiring Pi host peer imports in the startup graph.
- [ ] Verify every local output import resolves to an emitted file, every referenced file exists in `dist`, the startup static byte limit passes, and total main-graph JavaScript passes the total limit.
- [ ] Dynamically import the built `dist/index.js` and retain the default-function assertion. Do not invoke the extension factory or lazy runtime.
- [ ] Print a JSON report containing startup-static files/bytes, dynamically reachable files/bytes, total graph bytes, ACP-containing outputs, external packages, and all emitted chunk paths.
- [ ] Do not rely on generated source comments or stable hash values for dependency placement; the metafile is the authority.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/scripts/bundle-graph.test.ts`
- Expected: Synthetic graph and path-normalization tests pass.
- Run: `mise run build --package packages/pi-agents`
- Expected: Build emits `dist/index.js`, `dist/chunks/*.js`, and `dist/artifact-reader-extension.js`; postbuild reports an ACP-free startup static closure no larger than `1_325_000` bytes.
- Run: `mise run build --package packages/pi-format && mise run build --package packages/pi-lsp`
- Expected: Non-opted-in packages retain single-entry output; `pi-lsp` still externalizes `vscode-jsonrpc`.
- Run: `cd packages/pi-agents && test -n "$(find dist/chunks -maxdepth 1 -type f -name '*.js' -print -quit)"`
- Expected: At least one internal chunk exists.
- Run: `cd packages/pi-agents && bun pm pack --dry-run`
- Expected: The dry-run file list includes all referenced `dist/chunks/*.js`, `dist/index.js`, and `dist/artifact-reader-extension.js`.
- Run: `git status --short`
- Expected: No transient metafile or generated chunk is tracked unless the repository already tracks dist artifacts.

### Task 4: Validate Runtime and Packaging Compatibility

**Outcome:** Pi, Grok ACP, interactive, durable, and packaged installation paths work with hashed relative chunks.

**Files:**

- Create: `packages/pi-agents/scripts/smoke-built-lazy-runtime.ts`
- Modify: `packages/pi-agents/tests/execution/execution.test.ts`
- Modify: `packages/pi-agents/tests/interactive/interactive-agent.test.ts`
- Modify: `packages/pi-agents/scripts/postbuild.ts`

**Steps:**

- [ ] Run the full package suite after splitting, not only source-level tests; tests that import source modules do not validate emitted relative chunk paths.
- [ ] Start `smoke-built-lazy-runtime.ts` with two `ABOUTME:` lines. Import `createHostVirtualModules()` from `jiti-host-modules.ts`, create Jiti with `moduleCache: false` and `tryNative: false`, import emitted `dist/index.js`, then import the metafile-identified output whose `entryPoint` is `src/runtime/grok-acp/grok-acp-runtime.ts`; assert the main default is a function and the runtime chunk exports both `runSingleAgentGrokAcp` and `createGrokAcpInteractiveTransport`.
- [ ] Have postbuild launch that smoke in a fresh Bun process after graph validation. This is the automated Jiti + emitted-relative-chunk regression gate; a native `import(dist/index.js)` alone is insufficient.
- [ ] Add a negative postbuild fixture or synthetic graph case for a missing referenced chunk and verify the gate fails before publication.
- [ ] Build twice and verify `dist/chunks/` contains only files referenced by the second build. Hashed chunks from the first build must not survive cleanup.
- [ ] Run Pi with only `./packages/pi-agents/dist/index.js` enabled; verify the `agent` tool and `/agent runs` register without loading Grok ACP.
- [ ] Execute one fake/test Grok ACP path and one real Grok ACP smoke call when the `grok` binary is available. Confirm the first call loads the chunk, later calls reuse it, and session/lease cleanup still completes.
- [ ] Execute a TUI Pi subagent smoke path to confirm the retained static PI-RPC graph does not regress to the prior `undefined.emptyUsage` cycle.
- [ ] Verify package dry-run output after a clean build and, before release, install the produced tarball into a clean temporary Pi package environment and import its `dist/index.js`.

**Validation:**

- Run: `mise run test --package packages/pi-agents`
- Expected: Full suite passes with zero failures.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: No TypeScript errors.
- Run: `mise run build --package packages/pi-agents && mise run build --package packages/pi-agents`
- Expected: Both builds pass; each build runs the fresh-process Jiti lazy-runtime smoke, and the second postbuild report contains no missing or stale chunks.
- Run: `cd packages/pi-agents && bun pm pack --dry-run`
- Expected: All runtime-referenced chunks are included.
- Run: `pi -e ./packages/pi-agents/dist/index.js`
- Expected: The extension loads, the `agent` tool registers, and `/agent runs` resolves without calling a child agent.
- Manual: Run one Pi TUI subagent and one Grok ACP subagent, with parallel first-use coverage for Grok ACP when practical.
- Expected: No partial exports, missing chunks, lease leaks, duplicate transports, or changed terminal/error mapping.

### Task 5: Measure, Document, and Apply the Ship Gate

**Outcome:** The optimization ships only with demonstrated startup benefit and documented deferred-cost trade-offs.

**Files:**

- Modify: `packages/pi-agents/README.md`
- Modify: `packages/pi-agents/docs/profiling.md`
- Modify: `packages/pi-agents/docs/explanation.md`
- Modify: `packages/pi-agents/CHANGELOG.md`

**Steps:**

- [ ] Update README Local Development to state that build emits internal hashed chunks under `dist/chunks/`, that chunks are not public exports, and that `mise run build --package packages/pi-agents` is the supported structural-gate command because it supplies transient metafile metadata.
- [ ] Remove or qualify the standalone `bun run scripts/postbuild.ts` instruction; direct postbuild requires `PI_BUILD_METAFILE` from the corresponding build.
- [ ] Document the fresh-process warm Jiti command and distinguish it from same-process hot module-cache timing, real disk-cold startup, factory timing, and first Grok lazy-load latency.
- [ ] Document postbuild report fields and the `1_325_000` startup-static graph / `2_621_440` total-graph limits.
- [ ] Extend the Windows protocol to record control and candidate `module import` plus factory timings using the same machine, extension path, and enabled-extension set.
- [ ] In `docs/explanation.md`, describe the static Pi graph, memoized ACP loader, no-reverse-import rule, load-failure behavior, and why PI-RPC remains static.
- [ ] Add a changelog entry describing the internal startup optimization, first-use ACP load, unchanged tool schema/public exports, and package requirement to retain `dist/chunks/`.
- [ ] Capture at least 15 fresh-process warm samples for control and candidate on Linux. Report min/median/max and the relative median change.
- [ ] Complete the documented Windows cold/five-run-warm protocol for control and candidate. Report cold import, warm median, and factory median.
- [ ] Record first Grok ACP call timing separately. Do not claim that deferred work disappeared; state where it moved.
- [ ] Apply the ship gate: require deterministic gates, at least 15% fresh-process warm improvement, at least 15% Windows cold import improvement, and no more than 10% factory regression.
- [ ] If the gate fails, remove `pi.build.splitting`, restore the single-file build, retain only justified acyclic source refactors, and attach the metafile/timing evidence to a follow-up analysis.
- [ ] Do not begin chain splitting in this implementation. If startup remains material, first confirm that chain-only inputs account for at least 10% of the remaining startup static graph, then write a separate plan.

**Validation:**

- Run: `cd packages/pi-agents && bun run scripts/benchmark-startup.ts --warmups 2 --samples 15 --max-median-ms 250`
- Expected: Candidate report passes the loose guard and demonstrates at least 15% median improvement against the freshly captured same-machine control.
- Run: `hk check`
- Expected: ESLint and Prettier checks pass repository-wide.
- Manual: Complete the Windows `PI_TIMING=1` cold/five-run-warm protocol for control and candidate.
- Expected: Cold module import improves by at least 15%; factory median regresses by no more than 10%.
- Manual: Review README, profiling, explanation, and changelog against the final artifact report.
- Expected: Commands, limits, output locations, deferred-cost caveats, and rollback behavior match the implemented build.

## Final Validation

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.
- Run: `mise run test --package packages/pi-agents`
- Expected: Full package suite passes with zero failures.
- Run: `mise run build --package packages/pi-agents`
- Expected: Split build and postbuild graph gates pass.
- Run: `mise run build --package packages/pi-format && mise run build --package packages/pi-lsp`
- Expected: Shared build-task changes do not alter non-opted-in package topology or externalization.
- Run: `cd packages/pi-agents && bun pm pack --dry-run`
- Expected: All referenced runtime chunks and both public entrypoints are included.
- Run: `cd packages/pi-agents && bun run scripts/benchmark-startup.ts --warmups 2 --samples 15 --max-median-ms 250`
- Expected: Candidate meets the relative warm ship gate.
- Run: `hk check`
- Expected: Repository lint and formatting pass.
- Manual: Pi entry smoke, TUI PI-RPC smoke, Grok ACP first/repeated call smoke, and Windows cold/warm protocol.
- Expected: Runtime behavior is unchanged and all performance ship gates pass.

## Failure Behavior

- Missing or corrupt lazy chunk — only Grok ACP invocation fails with `Grok ACP runtime failed to load: <cause>`; extension startup and Pi runtime remain usable.
- Concurrent first Grok calls — all callers await one in-flight import and receive the same initialized module.
- Lazy import rejection — concurrent callers receive the same failure; the cached promise resets so a later call can retry.
- ACP protocol, spawn, lease, persistence, abort, or dispose failure after load — preserve existing structured result/error mapping and fail-closed lease semantics.
- Missing emitted or packed chunk — postbuild/package validation fails before release.
- Stale hashed chunk — build removes `dist/chunks/` before emission, so stale files cannot enter the package.
- Performance target miss — splitting is not shipped; do not compensate by moving required startup work into the factory or changing Pi's global loader.

## Privacy and Security

- The runtime change does not alter prompts, transcripts, run records, logs, subprocess environment, or network behavior.
- Bun metafiles contain local source/module paths and dependency names. Keep them transient, pass them only to postbuild, and delete them through the build trap; do not publish or commit them.
- Lazy loading must not bypass existing agent delegation checks, run-store permissions, session leases, or Grok ACP child-environment filtering.
- A missing chunk is treated as an integrity/build failure, not as a reason to download code or fall back to an external package at runtime.

## Rollout Notes

- Publish all of `dist/`, including `dist/chunks/`; consumers continue importing only `dist/index.js`.
- No migration, configuration change, tool-schema change, or public export change is required.
- Roll out first on the reference Windows environment where the original cold-import problem was observed.
- Keep the single-bundle path recoverable by removing `pi.build.splitting`; the runtime façade can remain bundled into one file.

## Risks and Mitigations

- Jiti CJS interop exposes partial exports under parallel dynamic imports — use one memoized loader, remove reverse value imports, and retain concurrent first-use tests.
- More filesystem reads erase parse savings — use one coarse façade, enforce a static-graph byte reduction, and require measured warm/cold improvement before shipping.
- Timing work merely moves from import to factory/session start — do not lazy-load startup-required modules; measure module import and factory separately.
- First Grok call becomes slower — document and measure the deferred cost; ship only when startup frequency and runtime usage justify the trade-off.
- Hashed chunks are omitted or become stale — clean only `dist/chunks/`, validate every local edge, and inspect `bun pm pack --dry-run`.
- Generic build-task changes affect other packages — make splitting opt-in and build `pi-format`/`pi-lsp` in final validation.
- Bun output topology changes in a future version — derive closures from the metafile rather than filenames or generated comments, and pin validation to the repository Bun version.

## Open Questions

**None for implementation.** Chain splitting is intentionally deferred until post-ACP measurements show that its remaining static contribution justifies a separate plan.
