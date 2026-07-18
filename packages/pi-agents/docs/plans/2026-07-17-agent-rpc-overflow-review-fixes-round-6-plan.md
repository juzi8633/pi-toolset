# Agent RPC Overflow Review Fixes Round 6 Implementation Plan

**Goal:** Replace the remaining weak Round 5 regressions with awaited, fault-injected, real-race, and full production-path tests.

**Inputs:** The reviewer report limited to Round 5 changes; current uncommitted implementation and tests.

**Assumptions:** Production fixes are retained unless stronger tests expose a defect. No unrelated refactoring is included.

**Architecture:** Strengthen tests at the exact boundaries named by the reviewer: strict unit start, every post-claim failure point, actual filesystem swaps after open, real Chain/Parallel execution, and the full restore/activate launch matrix.

**Tech Stack:** TypeScript, Bun, Node.js filesystem APIs, Pi 0.80.9, Mise, and HK.

---

## Tasks

### Task 1: Await and Fault-Test Strict Unit Start

**Outcome:** Tests fail if strict start persistence leaks live/event/launch state.

**Files:**

- Modify: `packages/pi-agents/tests/run-coordinator.test.ts`
- Modify: `packages/pi-agents/tests/tool.test.ts`
- Modify production only if tests expose a defect.

**Steps:**

- [ ] Await every asynchronous `startUnit()` call in affected tests.
- [ ] Inject `updateRunStrict` write rejection and directory-sync rejection separately.
- [ ] Assert the durable unit remains queued/unchanged, live unit remains unchanged, no `unit_started` event exists, and the error propagates.
- [ ] Through real `executeAgentTool` orchestration with a reader-requiring handoff, assert spawn and RPC activation counts are zero on each strict failure.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-coordinator.test.ts tests/tool.test.ts)`
- Expected: strict write/sync failures have zero start/launch side effects.

### Task 2: Exhaustively Test Post-Claim Abandon Paths

**Outcome:** Every throw after claim acquisition produces exactly one abandon, zero release, and the expected zero-side-effect state.

**Files:**

- Modify: `packages/pi-agents/tests/tool.test.ts`
- Modify production only if tests expose a defect.

**Steps:**

- [ ] Rename misleading release-oriented test descriptions to abandon semantics.
- [ ] Add post-claim injections for fresh `getRun`, post-claim inspect/ref read, fanout ref resolution, `getRunDir`, restored-state builder, strict running update, and coordinator registration.
- [ ] Spy/capture `abandonRun` and `releaseRun`; require exactly one abandon and zero release for every case.
- [ ] Inspect event JSONL and run record: no inappropriate `run_resumed`, status/attempt changes, registration, dispatch, or spawn before the relevant commit boundary.
- [ ] Assert coordinator inactive after cleanup.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts)`
- Expected: all claimed failure paths are explicitly covered.

### Task 3: Perform Real Post-Open Filesystem Swaps

**Outcome:** Race tests use real inode and directory replacement while the opened fd still contains valid expected bytes.

**Files:**

- Modify: `packages/pi-agents/tests/artifact-reader-extension.test.ts`

**Steps:**

- [ ] For inode swap, have injected `openSync` open the original artifact, verify via positional `readSync` that fd bytes and SHA-256 are valid, then atomically replace the digest path with a same-content/same-size different-inode file before post-open checks.
- [ ] Assert exact `artifact_unavailable`; digest mismatch must not be the reason.
- [ ] For parent swap, after opening/verifying the original fd, rename the real prefix directory and replace its original pathname with a symlink or redirected directory outside the run root containing an identical artifact.
- [ ] Assert exact `artifact_unavailable` and confirm the original fd content/digest remained valid.
- [ ] Preserve normal success and missing-identity controls.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/artifact-reader-extension.test.ts)`
- Expected: tests depend on identity/containment checks, not fake return values or digest mismatch.

### Task 4: Run Real Chain and Parallel Artifact Workflows

**Outcome:** Parent-output tests traverse real workflow orchestration and assert actual refs/descriptors.

**Files:**

- Modify: `packages/pi-agents/tests/memory-regression.test.ts`
- Modify: `packages/pi-agents/tests/tool.test.ts` if its production harness is more suitable.

**Steps:**

- [ ] Remove the Chain test's `runWorkflow` shortcut.
- [ ] Execute a real two-step Chain through `executeAgentTool` with controlled child execution: the first step emits oversized output, the second receives the real referenced handoff, and the terminal step emits oversized output.
- [ ] Capture the second child task and assert it contains the first artifact descriptor/reader instruction, not raw sentinel.
- [ ] Assert final Chain tool content contains bounded artifact metadata, no `(no output)`, no sentinel, and durable details use refs.
- [ ] Execute real Parallel children with oversized outputs and assert aggregate content includes bounded artifact metadata for each successful ref-only result and excludes sentinels.
- [ ] Keep the structured spill clone-boundary test on the real coordinator path.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts tests/memory-regression.test.ts)`
- Expected: removing Chain/Parallel ref-aware assembly would fail.

### Task 5: Cover the Full Restore-and-Activate Matrix

**Outcome:** Both restore paths prove true, false, and absent reader requirements through real activation and exact launch arguments/environment.

**Files:**

- Modify: `packages/pi-agents/tests/interactive-agent.test.ts`

**Steps:**

- [ ] For metadata-only creation and existing-endpoint refresh, create valid owning run-local sessions and cover `requireArtifactReader` true, false, and absent.
- [ ] After restore, assert the endpoint is not `unavailable` before activating.
- [ ] Activate each case and capture the production transport invocation.
- [ ] True: assert shipped `--extension`, `--tools` containing `pi_agents_read_artifact`, exact `PI_AGENTS_RUN_ID`, and exact `PI_AGENTS_RUN_ARTIFACT_DIR === store.getRunDir(runId)`.
- [ ] False/absent: assert no reader extension, no forced reader tool, and no artifact run env.
- [ ] Ensure existing-refresh cases truly pre-register the endpoint and metadata-only cases do not.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/interactive-agent.test.ts)`
- Expected: all six restore/requirement combinations traverse restore and activate correctly.

## Final Validation

- Run: `(cd packages/pi-agents && bun test tests/run-coordinator.test.ts tests/tool.test.ts tests/artifact-reader-extension.test.ts tests/memory-regression.test.ts tests/interactive-agent.test.ts)`
- Expected: all Round 6 regressions pass.

- Run: `mise run test --package packages/pi-agents`
- Expected: full package suite passes.

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: no errors.

- Run: `mise run build --package packages/pi-agents`
- Expected: both entries build.

- Run: `(cd packages/pi-agents && out="$(bun pm pack --dry-run 2>&1)" && printf '%s\n' "$out" | rg -q 'dist/index\.js' && printf '%s\n' "$out" | rg -q 'dist/artifact-reader-extension\.js')`
- Expected: both entries package.

- Run: `hk check`
- Expected: lint and formatting pass.

- Run: `git diff --check`
- Expected: no whitespace errors.

## Failure Behavior

| Failure                           | Required behavior                                     |
| --------------------------------- | ----------------------------------------------------- |
| Strict start write/sync fails     | No event, live mutation, spawn, or RPC activation.    |
| Any post-claim operation throws   | Exactly one abandon, zero release.                    |
| Artifact path changes after open  | `artifact_unavailable` despite valid fd bytes/digest. |
| Real Chain/Parallel result spills | Final content is bounded metadata; no raw authority.  |
| Restore endpoint is unavailable   | Test fails before launch assertions.                  |

## Open Questions

**Open Questions:** None.
