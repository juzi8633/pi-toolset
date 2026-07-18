# Agent RPC Overflow Review Fixes Round 4 Implementation Plan

**Goal:** Make pre-launch reader persistence truly strict, move all throwable resume preparation before side effects, and replace nominal tests with boundary-level regressions for relay ABA, reader identity, restore wiring, spill ordering, and parent delivery.

**Inputs:** The reviewer report limited to the Round 3 changes; current uncommitted source/tests; prior implementation and fix plans.

**Assumptions:**

- Production `RunStore` always provides strict APIs; missing strict methods fail closed.
- Test seams are dependency parameters scoped to a constructed test instance, never mutable production globals.
- Existing runtime and durable Version 1 contracts remain unchanged.

**Architecture:** First enforce the strict pre-launch barrier and make resume preparation a prepare-then-commit flow. Then strengthen tests so they traverse the real relay, extension registration, restored launch, coordinator, workflow, and parent-output boundaries rather than calling leaf helpers directly.

**Tech Stack:** TypeScript, Bun, Node.js filesystem APIs, Pi 0.80.9, Mise, and HK.

---

## Requirement Coverage

| Finding                                                               | Task   |
| --------------------------------------------------------------------- | ------ |
| `startUnit()` uses non-strict update before spawn                     | Task 1 |
| Throwable resume context construction remains after side effects      | Task 2 |
| Builder failure test does not prove zero side effects/abandon         | Task 2 |
| Relay fake does not model endpoint incarnation or remove/recreate ABA | Task 3 |
| Reader identity seam/tests do not cover unavailable/mismatched inode  | Task 4 |
| Spill-before-clone and parent-mode tests call helpers only            | Task 5 |
| Restore launch paths lack reader argv/env/tool assertions             | Task 6 |

## Tasks

### Task 1: Make Reader Requirement a Strict Pre-Launch Write

**Outcome:** A referenced child handoff cannot spawn unless `requireArtifactReader: true` is durably synced.

**Files:**

- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Test: `packages/pi-agents/tests/run-coordinator.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Change the awaited `RunCoordinator.startUnit()` mutation that persists `requireArtifactReader` to `updateRunStrict()`; do not use `updateRun()` fallback.
- [ ] Keep unit status/attempt/session/worktree and reader requirement in one serialized strict mutation where practical.
- [ ] Mirror live state only after strict persistence succeeds; a rejected write must not leave live `requireArtifactReader` or started status visible.
- [ ] Confirm `runStepWithContext` awaits `beginUnit/startUnit` before spawn/RPC activation.
- [ ] Update test stores to expose explicit strict methods without weakening production code.
- [ ] Add a real orchestration regression that injects strict write/sync failure, asserts spawn/RPC activation count is zero, live state is unchanged/unregistered as appropriate, and the error is surfaced.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-coordinator.test.ts tests/tool.test.ts)`
- Expected: strict failure prevents every launch side effect.

### Task 2: Prepare the Entire Resume Runtime before Commit

**Outcome:** Every throwable post-claim runtime construction succeeds before `run_resumed`, running-state persistence, or coordinator registration.

**Files:**

- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Refactor post-claim resume into a prepare phase and a commit phase within one cleanup `try/catch`.
- [ ] In prepare, using the exact verified fresh record and local unit clones, construct resolved fanouts, restored Chain state, lifecycle, sessions directory, unit IDs, project cwd, resume prompts, and every runtime context/value that can throw.
- [ ] Do not append events, update the run, mutate live authority, or register the coordinator during prepare.
- [ ] Only after prepare completes may commit append `run_resumed`, persist running state/attempts/continuations, mirror local state, and register.
- [ ] Keep the whole prepare and commit sequence in the same failure boundary; any error unregisters idempotently and abandons exactly once.
- [ ] Strengthen the injected builder/getRunDir failure test to assert: no `run_resumed` event, run status/attempts unchanged, coordinator inactive, no dispatch/spawn, no release, and exactly one terminal abandoned claim.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts)`
- Expected: forced failures before commit leave no durable/live side effect and abandon once.

### Task 3: Test Relay Incarnation through Real ABA

**Outcome:** Tests fail if endpoint incarnation is absent, reused, or omitted from the post-I/O comparison.

**Files:**

- Modify: `packages/pi-agents/tests/interactive-relay.test.ts`
- Optionally modify: `packages/pi-agents/src/interactive-agent.ts` only if the test exposes a production defect.

**Steps:**

- [ ] Give fake endpoints an explicit unique `endpointIncarnation` and return all three epoch fields from `getEndpointEpoch()`.
- [ ] Add fake registry remove/recreate support that resets transport/activation counters but allocates a new incarnation.
- [ ] Block artifact spill, remove the original endpoint, recreate the same key, reach the same numeric transport/activation values, activate and settle, then release I/O.
- [ ] Assert the old continuation is suppressed solely because incarnation differs.
- [ ] Add an unchanged-incarnation control that sends exactly once.
- [ ] If production incarnation allocation can approach `Number.MAX_SAFE_INTEGER`, centralize allocation and fail closed before unsafe reuse.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/interactive-relay.test.ts tests/interactive-agent.test.ts)`
- Expected: a remove/recreate ABA cannot pass the epoch check.

### Task 4: Inject Reader Filesystem Dependencies per Instance

**Outcome:** Tests deterministically prove fail-closed identity and pathname-swap behavior without mutable production globals.

**Files:**

- Modify: `packages/pi-agents/src/artifact-reader-extension.ts`
- Modify: `packages/pi-agents/tests/artifact-reader-extension.test.ts`

**Steps:**

- [ ] Replace the unused/global `_testFsOps` concept with a narrow immutable dependency object passed to an internal reader or optional registration parameter; production registration defaults to real `node:fs` operations.
- [ ] Route `realpath`, `lstat`, `open`, `fstat`, fd read, and close through that instance dependency.
- [ ] Keep child input/env/path contracts unchanged and expose no runtime configuration or mock mode.
- [ ] Add deterministic tests for missing `dev`/`ino`, equal-size different inode, pathname swap after open, parent swap, and normal same-inode reading.
- [ ] Assert every identity/path failure returns exact `artifact_unavailable` with no native error/path text.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/artifact-reader-extension.test.ts)`
- Expected: each identity/race branch is covered through the registered tool path.

### Task 5: Exercise Spill and Parent Delivery through Orchestration

**Outcome:** Tests traverse `runStepWithContext -> finishUnit -> externalizeTerminalResult -> snapshotSingleResult` and actual Single/Parallel/Chain parent output assembly.

**Files:**

- Modify: `packages/pi-agents/tests/tool.test.ts`
- Modify: `packages/pi-agents/tests/memory-regression.test.ts`
- Modify: `packages/pi-agents/tests/output.test.ts` only for direct helper unit controls.

**Steps:**

- [ ] Add a durable `executeAgentTool` path using a real temporary `RunStore` and `RunCoordinator` plus controlled child execution that returns oversized structured authority.
- [ ] Instrument or observe the snapshot boundary so the test fails if the oversized private structure reaches `snapshotSingleResult` before externalization. Prefer a scoped clone observer/test dependency restored in `finally`, not a production mock path.
- [ ] Assert artifact publication occurs first, committed result contains `structuredOutputRef`, durable details contain no sentinel, and serialized terminal shells stay bounded.
- [ ] Add separate Single, Parallel, and Chain `executeAgentTool` scenarios whose committed results contain `finalOutputRef`; assert actual final tool `content` contains bounded run-artifact metadata, never `(no output)`, and never artifact bytes/sentinel.
- [ ] Keep direct `getResultParentOutput` unit tests as supplemental controls, not the sole coverage.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts tests/output.test.ts tests/memory-regression.test.ts)`
- Expected: clone-order or parent-mode wiring regressions fail these tests.

### Task 6: Exercise Both Restored TUI Reader Launch Paths

**Outcome:** Tests prove both existing-endpoint refresh and metadata-only endpoint creation restore the reader extension, tool allowlist, and private artifact environment.

**Files:**

- Modify: `packages/pi-agents/tests/interactive-agent.test.ts`
- Optionally modify: `packages/pi-agents/src/interactive-agent.ts` only if tests expose a defect.

**Steps:**

- [ ] Build durable units with `requireArtifactReader: true` and valid owning run artifact paths.
- [ ] Cover restore of an existing endpoint and creation of a metadata-only endpoint.
- [ ] Trigger the production launch path and capture argv/env/tool filtering.
- [ ] Assert `--extension` points to the shipped artifact reader, `pi_agents_read_artifact` is force-included without broadening other tools, and `PI_AGENTS_RUN_ID`/artifact-root env values match the owning run.
- [ ] Add false/absent controls that preserve launch parity and inject none of these values.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/interactive-agent.test.ts)`
- Expected: both restore paths retain exactly the dedicated reader capability.

## Final Validation

- Run: `(cd packages/pi-agents && bun test tests/run-coordinator.test.ts tests/tool.test.ts tests/interactive-agent.test.ts tests/interactive-relay.test.ts tests/artifact-reader-extension.test.ts tests/output.test.ts tests/memory-regression.test.ts)`
- Expected: all Round 4 regressions pass.

- Run: `mise run test --package packages/pi-agents`
- Expected: complete package suite passes.

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: no errors.

- Run: `mise run build --package packages/pi-agents`
- Expected: both package entries build.

- Run: `(cd packages/pi-agents && out="$(bun pm pack --dry-run 2>&1)" && printf '%s\n' "$out" | rg -q 'dist/index\.js' && printf '%s\n' "$out" | rg -q 'dist/artifact-reader-extension\.js')`
- Expected: both entries are packaged.

- Run: `hk check`
- Expected: ESLint and Prettier pass.

- Run: `git diff --check`
- Expected: no whitespace errors.

## Failure Behavior

| Failure                                                   | Required behavior                                               |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| Strict reader-requirement write/sync fails                | No child spawn or RPC activation.                               |
| Any resume prepare step fails post-claim                  | No resume event/status/attempt/register/dispatch; abandon once. |
| Endpoint is removed/recreated during spill                | Suppress old continuation.                                      |
| File identity is absent/mismatched                        | Exact `artifact_unavailable`.                                   |
| Oversized private authority reaches snapshot before spill | Regression test fails.                                          |
| Restored reader requirement is absent/false               | No reader extension/tool/env injection.                         |

## Privacy and Security

- Reader capability is durably published before a descriptor-bearing child starts.
- Resume failures cannot leave an active owner after partial preparation.
- Incarnation tests lock stale sensitive continuation suppression.
- Filesystem seams are construction-scoped and production defaults remain real integrations.
- Parent and durable shells never contain oversized artifact bytes.

## Open Questions

**Open Questions:** None.
