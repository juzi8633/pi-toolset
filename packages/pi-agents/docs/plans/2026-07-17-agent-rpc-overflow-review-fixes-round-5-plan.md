# Agent RPC Overflow Review Fixes Round 5 Implementation Plan

**Goal:** Resolve the seven Round 4 review warnings by making start-state publication and post-claim cleanup correct, making reader dependencies truly instance-scoped, and replacing false-positive tests with production-boundary regressions.

**Inputs:** The reviewer report limited to Round 4 changes; current uncommitted source/tests; prior plans.

**Assumptions:**

- Strict unit-state persistence is authoritative before `unit_started` observation and child launch.
- Filesystem dependency injection is construction-scoped and unavailable to child input/environment.
- Tests may use real temporary run/session files and controlled production dependencies.

**Architecture:** Stage unit start state locally, persist strictly, then publish event/live state. Put every operation after claim acquisition inside one abandon boundary. Capture filesystem dependencies in each registered tool closure, and test races by swapping paths between `open` and post-open checks. Use real `executeAgentTool`, registry restore, activation, and transport capture for orchestration coverage.

**Tech Stack:** TypeScript, Bun, Node.js filesystem APIs, Pi 0.80.9, Mise, and HK.

---

## Tasks

### Task 1: Publish Unit Start Disk-First without Live/Event Leakage

**Outcome:** A strict start write failure leaves no live started state, no `unit_started` event, and no child launch.

**Files:**

- Modify: `packages/pi-agents/src/run-coordinator.ts`
- Test: `packages/pi-agents/tests/run-coordinator.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Build the next unit/attempt/worktree/reader-requirement state in local clones; do not mutate the active live unit first.
- [ ] Persist the staged state with `updateRunStrict()` through the coordinator's durable queue.
- [ ] Only after strict run persistence succeeds, append `unit_started` in the existing required order and then mirror the committed unit into live state.
- [ ] If strict update fails, emit no event, expose no started/live reader flag, and propagate the error before spawn/RPC activation.
- [ ] Add coordinator fault tests for strict write and sync rejection, checking disk record, live record, event log, and error.
- [ ] Add a real `executeAgentTool` handoff with `requireArtifactReader: true`; inject strict start failure and assert spawn/transport count zero.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-coordinator.test.ts tests/tool.test.ts)`
- Expected: strict failure has zero live/event/launch side effects.

### Task 2: Enclose Every Post-Claim Operation in One Abandon Boundary

**Outcome:** Any throw after a claim succeeds unregisters and abandons exactly once.

**Files:**

- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Begin the unified `try/catch` immediately after `claimRun()` succeeds.
- [ ] Move post-claim `getRun`, `inspectResumeRecord`, ref/fanout resolution, PREPARE, COMMIT, and returned runtime construction inside it.
- [ ] On any thrown error or validation failure, unregister idempotently and call `safeAbandon()` exactly once; never release.
- [ ] Keep expected validation failures bounded while preserving the same cleanup path.
- [ ] Strengthen tests to inspect event JSONL, run status/attempts, coordinator activity, dispatch/spawn counters, and claim terminal records.
- [ ] Add throws from post-claim `getRun`, `inspectResumeRecord` dependency/ref read, `getRunDir`, builder seam, strict update, and registration; each must show no inappropriate side effect and exactly one abandoned/no released claim.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts)`
- Expected: no post-claim exception can leak an owner claim.

### Task 3: Capture Filesystem Dependencies per Registered Reader

**Outcome:** Each registered artifact-reader tool permanently uses its own immutable filesystem dependency.

**Files:**

- Modify: `packages/pi-agents/src/artifact-reader-extension.ts`
- Test: `packages/pi-agents/tests/artifact-reader-extension.test.ts`

**Steps:**

- [ ] Remove module-level mutable `_fs`.
- [ ] In `registerArtifactReaderExtension(pi, fsOps = realFs)`, capture the selected dependency in a local constant used by that registration's execute closure.
- [ ] Pass the captured dependency explicitly to read, containment, identity, and intermediate-component helpers.
- [ ] Ensure a later registration cannot alter an earlier tool closure; a default registration always uses `realFs`.
- [ ] Add two concurrently registered tools with different dependencies and assert each remains isolated after the second registration.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/artifact-reader-extension.test.ts)`
- Expected: no global dependency contamination.

### Task 4: Test Identity Races between Open and Post-Open Checks

**Outcome:** Tests fail if inode/path identity or containment checks are removed.

**Files:**

- Modify: `packages/pi-agents/tests/artifact-reader-extension.test.ts`

**Steps:**

- [ ] Create two same-content, same-size, same-digest regular files with different inodes.
- [ ] Through the instance fs dependency, let `openSync` return an fd for the original file, then atomically replace the digest path before post-open `lstat`/realpath.
- [ ] Assert the opened fd still reads valid expected bytes/digest but identity mismatch alone produces exact `artifact_unavailable`.
- [ ] Add a parent-directory swap after open that redirects the pathname outside the run root while the fd remains on the original inode; assert containment/identity rejection.
- [ ] Add missing `dev` and missing `ino` controls and a normal same-inode success.
- [ ] Assert errors equal `artifact_unavailable` exactly and contain no path/native text.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/artifact-reader-extension.test.ts)`
- Expected: removing identity/containment checks would fail the race tests.

### Task 5: Exercise Real Workflow Spill and Parent Assembly

**Outcome:** Single, Parallel, and Chain tests traverse the actual orchestration path, and the clone-order test observes oversized structured authority before/after spill.

**Files:**

- Modify: `packages/pi-agents/tests/tool.test.ts`
- Modify: `packages/pi-agents/tests/memory-regression.test.ts`
- Keep: `packages/pi-agents/tests/output.test.ts` direct helper controls.

**Steps:**

- [ ] Use `executeAgentTool` with a real temporary `RunStore` and `RunCoordinator` plus controlled child execution for Single, Parallel, and Chain.
- [ ] Produce ref-only terminal results through actual externalization, not by constructing refs in the assertion helper.
- [ ] Assert actual final tool content for all three modes contains bounded artifact metadata, excludes `(no output)` and payload sentinel, and details/run records retain refs only.
- [ ] For structured clone ordering, send oversized structured authority through the durable workflow and install a test-scoped `structuredClone` observer restored in `finally`.
- [ ] Make the observer fail if the raw oversized sentinel-bearing structured object reaches a snapshot clone before artifact publication; allow the compact ref shell afterward.
- [ ] Assert artifact exists/verifies, committed result has `structuredOutputRef`, and serialized parent/run shells remain bounded and sentinel-free.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts tests/memory-regression.test.ts tests/output.test.ts)`
- Expected: tests fail on early clone or any parent mode missing ref-aware output.

### Task 6: Exercise Both Real Restore-and-Launch Reader Paths

**Outcome:** Tests restore valid endpoints and activate real production launch assembly for existing refresh and metadata-only creation.

**Files:**

- Modify: `packages/pi-agents/tests/interactive-agent.test.ts`

**Steps:**

- [ ] Create a temporary owning run directory and valid session file under `<run>/sessions/` with metadata accepted by restore validation.
- [ ] Existing-refresh case: register a valid endpoint first, restore the branch metadata onto it, assert it remains available, then activate it.
- [ ] Metadata-only case: restore without a prior endpoint, assert a valid restorable endpoint is created, then activate it.
- [ ] Capture the production `transportFactory` invocation and assert `--extension`, forced `pi_agents_read_artifact`, `PI_AGENTS_RUN_ID`, and `PI_AGENTS_RUN_ARTIFACT_DIR` are correct.
- [ ] Add false/absent requirement controls for each path and assert no reader extension/tool/env injection.
- [ ] Assert tests fail on `unavailable` snapshots rather than accepting endpoint count alone.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/interactive-agent.test.ts)`
- Expected: both actual restore-and-launch paths preserve exactly the dedicated reader capability.

## Final Validation

- Run: `(cd packages/pi-agents && bun test tests/run-coordinator.test.ts tests/tool.test.ts tests/artifact-reader-extension.test.ts tests/memory-regression.test.ts tests/output.test.ts tests/interactive-agent.test.ts tests/interactive-relay.test.ts)`
- Expected: all Round 5 regressions pass.

- Run: `mise run test --package packages/pi-agents`
- Expected: full package suite passes.

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: no errors.

- Run: `mise run build --package packages/pi-agents`
- Expected: both entries build.

- Run: `(cd packages/pi-agents && out="$(bun pm pack --dry-run 2>&1)" && printf '%s\n' "$out" | rg -q 'dist/index\.js' && printf '%s\n' "$out" | rg -q 'dist/artifact-reader-extension\.js')`
- Expected: both entries are packaged.

- Run: `hk check`
- Expected: lint and formatting pass.

- Run: `git diff --check`
- Expected: no whitespace errors.

## Failure Behavior

| Failure                                               | Required behavior                                    |
| ----------------------------------------------------- | ---------------------------------------------------- |
| Strict start write fails                              | No event, live started state, or launch.             |
| Any operation throws after claim                      | Unregister and abandon exactly once; never release.  |
| Reader registration uses injected fs                  | Only that registration sees it.                      |
| Path changes after open                               | `artifact_unavailable` even when bytes/digest match. |
| Raw oversized structure reaches snapshot before spill | Regression test fails.                               |
| Restore is invalid/unavailable                        | Test fails before launch assertions.                 |

## Privacy and Security

- Reader dependencies are not mutable globally or controlled by child input.
- Path race tests preserve valid bytes to prove identity checks, not digest mismatch, enforce security.
- Parent content and durable records remain sentinel-free.
- Resume cleanup prevents stale claims from blocking future work.

## Open Questions

**Open Questions:** None.
