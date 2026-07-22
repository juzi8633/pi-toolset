# Startup Import Optimization Implementation Plan

**Goal:** Reduce `@balaenis/pi-agents` first-start extension import time by bundling non-host runtime dependencies, narrowing Effect imports, and adding deterministic artifact and startup checks.

**Inputs:** Windows startup timing showing `dist/index.js module import: 11199ms`; repository analysis on 2026-07-22; `packages/pi-agents/package.json`; `.mise/tasks/build/_default`; `.github/workflows/pr.yml`; Pi extension loader `dist/core/extensions/loader.js`; measured Effect and ACP SDK module graphs.

**Assumptions:**

- Pi host packages (`@earendil-works/pi-*` and `typebox`) must remain external to preserve host identity and virtual-module resolution.
- Package-owned runtime dependencies (`effect`, `@agentclientprotocol/sdk`, and bundled transitive `zod`) may be included in `dist/index.js`.
- The reference Windows acceptance target is based on the observed 11,199 ms cold import and the measured 115–139 ms Jiti warm import of a temporary runtime-bundled artifact.
- Actual disk-cold timing remains a manual release check because CI cannot reliably reproduce Windows filesystem cache and antivirus state.

**Architecture:** Keep Pi host peers external, but bundle package-owned runtime dependencies into the existing single-file entrypoint so Jiti reads one artifact instead of traversing hundreds of package files. Replace Effect root-barrel imports with public subpath imports as a defense-in-depth measure and add a postbuild structural gate that prevents runtime dependencies from becoming external again. Use a Jiti benchmark with host peers supplied as virtual modules to approximate Pi binary loading without invoking a model.

**Tech Stack:** TypeScript, Bun 1.3.14, Node.js 26.3.0, Jiti 2.7.0, Effect 3.22.0, ACP SDK 1.2.1, Bun test, Mise, GitHub Actions.

---

## Scope

**In scope:** `pi-agents` Effect import boundaries, package build externalization, Windows CI parity, bundle-size/runtime-import guards, Jiti startup benchmarking, third-party notices, and startup profiling documentation.

**Out of scope:** Pi's global Jiti configuration (`moduleCache`, `tryNative`, or virtual-module behavior), dynamic Grok ACP code splitting, removal of Effect, minification, antivirus exclusions, and runtime feature changes.

## Baseline and Acceptance Targets

Measured baseline on the reference Windows machine:

- Actual Pi cold import: `11199ms`
- Effect root cold import: `6875ms`; 600 translated ESM modules
- ACP SDK cold import: `1096ms`; 88 translated ESM modules
- Current Jiti import with host peers virtualized: approximately `542–597ms` warm
- Temporary runtime-bundled Jiti import with host peers virtualized: approximately `115–139ms` warm
- Temporary runtime-bundled artifact: `2,074,110` bytes

Deterministic ship gates:

- `dist/index.js` contains no external import of `effect`, `effect/*`, or `@agentclientprotocol/sdk`.
- Runtime imports of `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` remain external; all declared peers remain in the build external list.
- `dist/index.js` is at most `2.5 MiB` (`2_621_440` bytes).
- The local Jiti benchmark median is at most `250ms` on the reference Windows machine.
- Tool behavior, Grok ACP behavior, durable runs, and extension factory registration remain unchanged.

Manual performance objectives (recorded on the same machine and extension path before and after the change):

- Capture current-artifact cold and five-run warm baselines before implementation.
- Candidate cold import improves by at least 60% relative to the captured cold baseline; `3500ms` is the stretch target derived from the 11,199 ms report, not a deterministic CI gate.
- Candidate warm median improves by at least 50% relative to the captured warm baseline; `500ms` is the stretch target.
- Factory timing does not regress by more than 25% relative to the captured factory baseline.

## File Map

- Modify: `.mise/tasks/build/_default` — externalize only peer dependencies and explicit `pi.external` entries
- Modify: `.github/workflows/pr.yml` — run the same postbuild artifact guard on Windows
- Modify: `packages/pi-agents/package.json` — bundle runtime dependencies and add Jiti as a dev dependency
- Modify: `bun.lock` — lock the explicit Jiti development dependency metadata
- Create: `packages/pi-agents/scripts/benchmark-startup.ts` — measure Jiti import with Pi host peers virtualized
- Create: `packages/pi-agents/scripts/postbuild.ts` — enforce runtime bundling, host-peer externalization, and bundle-size constraints
- Modify: `packages/pi-agents/src/shared/effect-runtime.ts` — import Effect APIs from public subpaths
- Modify: `packages/pi-agents/src/execution/background.ts` — use `effect/Effect`
- Modify: `packages/pi-agents/src/execution/completion-check.ts` — use `effect/Either`
- Modify: `packages/pi-agents/src/execution/worktree.ts` — use `effect/Either`
- Modify: `packages/pi-agents/src/output/template.ts` — use `effect/Either`
- Modify: `packages/pi-agents/src/run/artifact-store.ts` — use `effect/Effect`
- Modify: `packages/pi-agents/src/run/run-store.ts` — use `effect/Duration` and `effect/Effect`
- Modify: `packages/pi-agents/src/run/session-lease.ts` — use `effect/Deferred` and `effect/Effect`
- Modify: `packages/pi-agents/docs/effect-adoption/01-phase-0-conventions.md` — replace the obsolete root-barrel import convention with measured subpath guidance
- Modify: `packages/pi-agents/THIRD_PARTY_NOTICES.md` — add notices for code newly included in the distributed bundle
- Modify: `packages/pi-agents/docs/profiling.md` — distinguish startup import profiling from agent-execution profiling
- Modify: `packages/pi-agents/README.md` — document startup artifact and benchmark commands

## Tasks

### Task 1: Add a repeatable Jiti startup benchmark

**Outcome:** Developers can measure extension-module import without launching a model, with Pi host modules excluded from the timed region.

**Files:**

- Create: `packages/pi-agents/scripts/benchmark-startup.ts`
- Modify: `packages/pi-agents/package.json`
- Modify: `bun.lock`

**Steps:**

- [ ] Before changing source or build policy, use `PI_TIMING=1` to record one current-artifact cold import after reboot, five current-artifact warm imports, and the corresponding factory timings on the reference Windows machine. Store the values in the implementation PR description and use them as the relative manual acceptance baseline.
- [ ] Add `jiti: "2.7.0"` to `packages/pi-agents` `devDependencies`; do not add it to runtime `dependencies`, `files`, or a new `package.json` `scripts` property.
- [ ] Start `benchmark-startup.ts` with the required two-line `ABOUTME:` header.
- [ ] Import these host modules before starting the timer and provide them through Jiti `virtualModules`:
  - `@earendil-works/pi-coding-agent`
  - `@earendil-works/pi-agent-core`
  - `@earendil-works/pi-tui`
  - `@earendil-works/pi-ai/compat` under the virtual name `@earendil-works/pi-ai`
  - `typebox`
- [ ] Construct Jiti with `moduleCache: false` and `tryNative: false` to match Pi's Bun-binary extension path.
- [ ] Import `../dist/index.js` with `{ default: true }`; assert the returned default export is a function, but do not call the factory.
- [ ] Use named constants `DEFAULT_WARMUP_RUNS = 1`, `DEFAULT_SAMPLE_RUNS = 5`, and `DEFAULT_MAX_MEDIAN_MS = 250`; avoid anonymous timing literals.
- [ ] Support `--warmups <n>`, `--samples <n>`, and `--max-median-ms <n>`; reject non-positive or non-finite values with a non-zero exit.
- [ ] Create a fresh Jiti instance for each sample, collect elapsed milliseconds, and print min/median/max plus all samples as JSON.
- [ ] Exit non-zero when the median exceeds `--max-median-ms`; state clearly in output that this is a warm Jiti benchmark, not a disk-cold measurement.
- [ ] Run the benchmark once against the current externalized artifact and record the result in the PR description; do not encode the old result as a test expectation.

**Validation:**

- Run: `mise run build --package packages/pi-agents`
- Expected: Existing build succeeds before optimization.
- Run: `cd packages/pi-agents && bun run scripts/benchmark-startup.ts --samples 3 --max-median-ms 1000`
- Expected: Three samples are printed, the default export is validated, and the command succeeds on the current artifact.
- Run: `cd packages/pi-agents && bun run scripts/benchmark-startup.ts --samples 0`
- Expected: Command exits non-zero with an invalid-sample-count message.

### Task 2: Replace Effect root-barrel imports

**Outcome:** Source imports only the public Effect subpaths it uses, reducing the external module graph if build policy regresses and making dependency boundaries explicit.

**Files:**

- Modify: `packages/pi-agents/src/shared/effect-runtime.ts`
- Modify: `packages/pi-agents/src/execution/background.ts`
- Modify: `packages/pi-agents/src/execution/completion-check.ts`
- Modify: `packages/pi-agents/src/execution/worktree.ts`
- Modify: `packages/pi-agents/src/output/template.ts`
- Modify: `packages/pi-agents/src/run/artifact-store.ts`
- Modify: `packages/pi-agents/src/run/run-store.ts`
- Modify: `packages/pi-agents/src/run/session-lease.ts`
- Modify: `packages/pi-agents/docs/effect-adoption/01-phase-0-conventions.md`

**Steps:**

- [ ] Replace every value import from `effect` with namespace imports from the matching public subpath:
  - `Cause` → `effect/Cause`
  - `Data` → `effect/Data`
  - `Deferred` → `effect/Deferred`
  - `Duration` → `effect/Duration`
  - `Effect` → `effect/Effect`
  - `Either` → `effect/Either`
  - `Exit` → `effect/Exit`
  - `Option` → `effect/Option`
- [ ] Preserve existing local identifiers and namespace-style calls, e.g. `Effect.runPromiseExit`, `Either.left`, and `Duration.millis`; do not rewrite Effect logic.
- [ ] Keep type signatures and public Promise rejection behavior unchanged.
- [ ] Verify `rg "from 'effect'" packages/pi-agents/src` returns no matches.
- [ ] Update the Imports section of `docs/effect-adoption/01-phase-0-conventions.md`: replace the named root-barrel example and prohibition on `effect/Effect` with the subpath namespace pattern from this task, and cite the measured reduction from 600 translated modules to 151 for the currently used API set.
- [ ] Do not introduce dynamic imports in this task.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/execution/background.test.ts tests/execution/completion-check.test.ts tests/execution/worktree.test.ts tests/output/template.test.ts tests/run/artifact-store.test.ts tests/run/run-store.test.ts tests/run/session-lease.test.ts`
- Expected: All focused tests pass, 0 fail.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: No TypeScript errors.
- Run: `rg "from 'effect'" packages/pi-agents/src`
- Expected: No output and exit status 1 because no root-barrel imports remain.

### Task 3: Bundle package-owned runtime dependencies

**Outcome:** `dist/index.js` contains Effect, ACP SDK, and required Zod code while Pi host peers remain external; build behavior is consistent on Mise and Windows CI.

**Files:**

- Modify: `.mise/tasks/build/_default`
- Modify: `packages/pi-agents/package.json`
- Modify: `.github/workflows/pr.yml`
- Create: `packages/pi-agents/scripts/postbuild.ts`
- Modify: `packages/pi-agents/THIRD_PARTY_NOTICES.md`

**Steps:**

- [ ] In `.mise/tasks/build/_default`, build the external list from `peerDependencies` plus explicit `pi.external` only; stop automatically adding every regular `dependency`.
- [ ] Update the build-task comment to state the policy: host peers are always external; package runtime dependencies bundle unless explicitly listed in `pi.external`.
- [ ] Confirm the policy does not alter the other packages:
  - `pi-lsp` keeps `vscode-jsonrpc` external through its existing `pi.external` entry.
  - `pi-format` has no runtime dependencies to bundle.
- [ ] Remove `effect` and `@agentclientprotocol/sdk` from `packages/pi-agents` `pi.external`; remove the property entirely if it becomes empty. Do not add a `package.json` `scripts` property; repository tasks own build hooks.
- [ ] Start `scripts/postbuild.ts` with the required two-line `ABOUTME:` header.
- [ ] Have the checker read `dist/index.js` and fail when:
  - The file is missing.
  - Its byte size exceeds named constant `MAX_MAIN_BUNDLE_BYTES = 2_621_440`.
  - A static or dynamic import resolves `effect`, any `effect/*` subpath, or `@agentclientprotocol/sdk`.
  - Any of the required runtime host imports is absent: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, or `@earendil-works/pi-tui`.
- [ ] After structural scanning, dynamically import the built file from its absolute file URL and fail unless its default export is a function; do not invoke the extension factory.
- [ ] Keep `@earendil-works/pi-agent-core` and `typebox` in the build external list even though current imports are type-only or indirect and therefore need not appear in generated runtime imports.
- [ ] Use a multiline-safe import-specifier scan; do not reject harmless string literals in comments or application text.
- [ ] Print bundle byte size plus external package specifiers on success for CI diagnostics.
- [ ] In `.mise/tasks/build/_default`, run `bun run ./scripts/postbuild.ts` when that conventional file exists, after all package entrypoints are built and before returning success. Keep the existing `package.json` `postbuild` compatibility path for `pi-lsp`.
- [ ] In `.github/workflows/pr.yml`, fix the artifact-reader entry path by preferring `./src/run/artifact-reader-extension.ts` with the same legacy fallback as Mise, then run `bun run ./scripts/postbuild.ts` after both Windows entrypoints build.
- [ ] Generate a temporary Bun metafile from the candidate runtime-bundled build before editing notices:

  ```sh
  cd packages/pi-agents
  bun build ./src/index.ts \
    --outfile ./dist/index-license-audit.tmp.js \
    --metafile=./dist/index-license-audit.tmp.meta.json \
    --target node \
    --external @earendil-works/pi-agent-core \
    --external @earendil-works/pi-ai \
    --external @earendil-works/pi-coding-agent \
    --external @earendil-works/pi-tui \
    --external typebox
  ```

  Derive the exact bundled third-party package set from `inputs` in the metafile, then delete both temporary audit files. The current expected set is `effect@3.22.0`, `@agentclientprotocol/sdk@1.2.1`, and `zod@4.4.3`; if the metafile lists additional packages, include them too.

- [ ] Update `THIRD_PARTY_NOTICES.md` with attribution and the full required license text or canonical license-file inclusion for every package in that metafile-derived set.
- [ ] Do not bundle any `@earendil-works/pi-*` package or `typebox`.

**Validation:**

- Run: `mise run build --package packages/pi-agents`
- Expected: Build and postbuild check pass; output reports a main bundle no larger than 2.5 MiB and no external Effect/ACP SDK imports.
- Run: `rg 'from "(effect|@agentclientprotocol/sdk)|import\("(effect|@agentclientprotocol/sdk)' packages/pi-agents/dist/index.js`
- Expected: No output.
- Run: `rg '^import .*@earendil-works/pi-' packages/pi-agents/dist/index.js`
- Expected: At least one host-peer import remains, proving peers were not inlined.
- Run: `mise run build --package packages/pi-lsp`
- Expected: Build passes and `dist/index.js` still contains an external `vscode-jsonrpc` import.
- Run: `cd packages/pi-agents && bun run ./scripts/postbuild.ts`
- Expected: Structural gate passes and reports required host imports as external.
- Run: `cd packages/pi-agents && bun run scripts/benchmark-startup.ts --max-median-ms 250`
- Expected: Median is at most 250 ms on the reference Windows machine. This validation depends on the benchmark created in Task 1.

### Task 4: Validate runtime compatibility and document the startup workflow

**Outcome:** Source and bundled artifacts preserve Pi and Grok ACP behavior, and maintainers have separate procedures for deterministic warm benchmarking and real cold-start acceptance.

**Files:**

- Modify: `packages/pi-agents/docs/profiling.md`
- Modify: `packages/pi-agents/README.md`

**Steps:**

- [ ] Add a `Startup import profiling` section near the top of `docs/profiling.md` and explicitly state that `PI_AGENTS_CPU_PROFILE=1` starts during agent execution and does not measure extension import.
- [ ] Document `PI_TIMING=1` as the Pi startup timer and explain that the `module import` line includes recursive dependency loading inside `jiti.import()` while `factory` is reported separately.
- [ ] Document the deterministic command `bun run scripts/benchmark-startup.ts --max-median-ms 250` and its limitation: host peers are virtualized and filesystem cold-cache/antivirus effects are not represented.
- [ ] Document the Windows cold/warm protocol:
  1. Build the candidate.
  2. Ensure only one `pi-agents` extension instance is enabled.
  3. Set `$env:PI_TIMING = '1'`.
  4. Reboot before the cold sample.
  5. Start Pi, wait for the prompt, exit normally, and record the `pi-agents ... module import` line.
  6. Repeat five launches without reboot and record the median warm import.
- [ ] Record the deterministic gates from this plan: benchmark median `<= 250ms` and bundle `<= 2.5 MiB`. Record manual objectives separately: cold improves at least 60%, warm median improves at least 50%, factory regresses no more than 25%; cold `3500ms` and warm `500ms` remain stretch targets until candidate measurements exist.
- [ ] Add `bun run ./scripts/postbuild.ts` and `bun run scripts/benchmark-startup.ts --max-median-ms 250` to the README `Local development` section.
- [ ] Run all Grok ACP focused suites because ACP SDK is now bundled, including client, invocation, parser, transcript, and interactive transport tests.
- [ ] Run a local `pi -e ./packages/pi-agents/dist/index.js` smoke test with other copies of the extension disabled; verify the `agent` tool registers and `/agent runs` resolves without calling a child agent.
- [ ] Perform the cold/warm protocol on the reference Windows machine before release. If the cold target is missed, stop rollout and collect a new startup profile; do not immediately change Pi's global loader in this implementation.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/runtime/grok-acp/grok-acp-client.test.ts tests/runtime/grok-acp/grok-acp-interactive-transport.test.ts tests/runtime/grok-acp/grok-acp-invocation.test.ts tests/runtime/grok-acp/grok-acp-parser.test.ts tests/runtime/grok-acp/grok-acp-transcript.test.ts`
- Expected: All ACP tests pass, 0 fail.
- Run: `mise run test --package packages/pi-agents`
- Expected: Full package suite passes, 0 fail.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.
- Run: `hk check`
- Expected: ESLint and Prettier checks pass repo-wide.
- Manual: Complete the documented Windows cold/warm protocol.
- Expected: Cold import improves at least 60% from the Task 1 baseline, warm median improves at least 50%, and factory timing regresses no more than 25%. Record whether the 3500 ms cold and 500 ms warm stretch targets were met.

## Final Validation

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.
- Run: `mise run test --package packages/pi-agents`
- Expected: Pass, 0 fail.
- Run: `mise run build --package packages/pi-agents`
- Expected: Build plus postbuild structural gate pass.
- Run: `cd packages/pi-agents && bun run scripts/benchmark-startup.ts --max-median-ms 250`
- Expected: Median at most 250 ms on the reference Windows machine.
- Run: `mise run build --package packages/pi-lsp && mise run build --package packages/pi-format`
- Expected: Both packages still build; `pi-lsp` keeps `vscode-jsonrpc` external.
- Run: `hk check`
- Expected: Pass.
- Manual: Run the actual Pi Windows cold/warm acceptance protocol.
- Expected: Cold improves at least 60%, warm median improves at least 50%, factory regresses no more than 25%, and no duplicate extension registration. Report the 3500 ms cold and 500 ms warm stretch-target results separately.

## Failure Behavior

- A missing or oversized bundle, reintroduced Effect/ACP external import, or missing default factory causes postbuild to fail before publication.
- Invalid benchmark arguments or a median above the requested threshold cause the benchmark command to exit non-zero with measured values.
- If bundling changes ACP SDK runtime behavior, focused ACP tests or the extension smoke test block rollout; do not fall back silently to a different protocol path.
- If the actual cold target is missed while structural and warm checks pass, retain the bundled artifact for diagnosis but stop release and profile the remaining Jiti/Windows I/O path.

## Privacy and Security

- No prompts, sessions, credentials, or run records are added to benchmark output.
- Startup timing output contains local extension paths; treat captured logs as local diagnostic data.
- Do not recommend or automate Windows Defender exclusions as part of this optimization.
- Bundling changes distribution contents, so third-party license notices are a release requirement.

## Rollout Notes

- Implement on `fix/pi-agents-startup-import` in a dedicated worktree because the change spans build infrastructure, package metadata, source imports, CI, and documentation.
- Publish or install a candidate package only after postbuild, full tests, and the Windows cold/warm gate pass.
- Compare the candidate against the Task 1 cold/warm/factory baselines on the same machine and storage path; keep the original 11,199 ms report as historical context.
- Roll back by restoring the two runtime packages to `pi.external` and the previous build externalization policy if an unresolvable bundled-runtime compatibility issue appears.

## Risks and Mitigations

- **Bundle growth increases package size.** — Enforce the 2.5 MiB cap; measured candidate is approximately 2.1 MB.
- **A host peer is accidentally bundled, breaking identity checks.** — Keep all peers external by construction and verify host import specifiers remain in the output.
- **Build behavior changes for other monorepo packages.** — `pi-lsp` retains its explicit `pi.external`; build all three packages in final validation.
- **Jiti benchmark becomes a flaky CI timing gate.** — Keep wall-clock threshold local/manual; CI gates deterministic artifact structure and size only.
- **Root-barrel import rewrite changes namespace typing.** — Use namespace subpath imports and run focused plus full TypeScript/tests.
- **Bundled ACP SDK or Zod behaves differently from external ESM.** — Run all ACP suites and a real extension-load smoke test.
- **License obligations are missed after bundling.** — Generate the candidate metafile, derive the exact bundled package set, and update notices for every listed third-party package before release.

## Open Questions

None. The plan deliberately defers Pi loader changes and ACP code splitting until the package-local bundling result is measured.
