# Agent RPC Overflow Review Fixes Round 7 Implementation Plan

**Goal:** Give strict `run.json` replacement a recoverable post-rename failure contract and close the seven remaining false-positive test gaps.

**Inputs:** The reviewer report limited to the manually completed Round 6 changes; current uncommitted source/tests.

**Assumptions:**

- On post-rename directory-sync failure, strict update must restore the prior `run.json` before returning failure whenever rollback I/O succeeds.
- If rollback itself cannot be completed/synced, return an explicit bounded durable-write failure and never launch or publish live success.
- Tests use one-shot fault injection so rollback durability can be verified independently from the injected publication failure.

**Architecture:** Preserve the previous authoritative file in a same-directory rollback entry before replacing it. If the publication directory sync fails, atomically restore the rollback entry and sync it before propagating failure. Then harden each orchestration/race test so it can fail only at the intended boundary.

**Tech Stack:** TypeScript, Bun, Node.js filesystem APIs, Pi 0.80.9, Mise, and HK.

---

## Tasks

### Task 1: Roll Back Strict Run Replacement after Post-Rename Sync Failure

**Outcome:** A one-shot directory fsync failure after `run.json` replacement returns an error while restoring the previous queued record; no live/event/launch state is published.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Modify: `packages/pi-agents/src/run-coordinator.ts` only if error mapping/order needs adjustment.
- Test: `packages/pi-agents/tests/run-store.test.ts`
- Test: `packages/pi-agents/tests/run-coordinator.test.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] For strict replacement of an existing `run.json`, create a private same-directory rollback entry containing the exact previous authoritative bytes; flush it and sync the directory before publishing the new staging file.
- [ ] Rename the new staging file over `run.json`, then sync the containing directory.
- [ ] If that post-rename sync fails, atomically restore the rollback entry over `run.json`, flush/verify the restored file, sync the directory, remove leftover staging/rollback entries, and rethrow a bounded strict-write error.
- [ ] Do not return success or mirror live state until the new directory sync succeeds.
- [ ] If rollback fails, surface a distinct bounded `durable_write_error`/rollback diagnostic without claiming unchanged state; still prevent event/live/launch publication.
- [ ] Preserve serialization, private modes, same-filesystem atomicity, and existing create/new-file behavior.
- [ ] Add one-shot fault injection at the actual post-rename directory-sync call; assert `run.json` bytes and parsed unit state exactly match the pre-update record after rollback.
- [ ] Assert `startUnit` leaves live queued, writes no `unit_started`, and causes zero child spawn/RPC activation after the real rollback path.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts tests/run-coordinator.test.ts tests/tool.test.ts)`
- Expected: post-rename failure restores prior durable bytes and prevents launch.

### Task 2: Prove Strict-Start Orchestration Reaches the Intended Fault

**Outcome:** Reader-handoff start tests prove the seed ran once, the strict fault fired once, and the descriptor-bearing child never launched.

**Files:**

- Modify: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Count seed child spawn and RPC activation separately from the reader-requiring second child.
- [ ] Count strict update/post-rename-sync fault injections and require exactly one intended hit.
- [ ] Assert seed launch exactly once, second-step spawn zero, second-step RPC activation zero, and exact surfaced error code/message.
- [ ] Inspect durable/live/event state after the failure and confirm the second unit remains queued with no `unit_started`.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts)`
- Expected: unrelated early failure cannot satisfy the test.

### Task 3: Pin Every Post-Claim Failure Boundary

**Outcome:** Each post-claim failure test reaches its named operation and proves record/claim/registration/dispatch invariants.

**Files:**

- Modify: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Make the fanout-ref test succeed on the inspection read and fail on the subsequent `resolveAndVerifyFanoutItems` read; assert both call counts.
- [ ] Snapshot the durable record before claim and compare status, attempts, workflow refs, and continuation fields after each pre-commit failure.
- [ ] Count coordinator registration, workflow dispatch, process spawn, `abandonRun`, and `releaseRun` per case.
- [ ] Inject the running-state failure through `updateRunStrict`, not `updateRun`.
- [ ] Require exactly one abandon, zero release, zero registration/dispatch/spawn where preparation failed, and no `run_resumed` event.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts)`
- Expected: every named boundary is independently exercised.

### Task 4: Test Parent Escape with the Same Inode

**Outcome:** The parent-containment race test fails only because realpath escapes the run root, not because inode or digest changes.

**Files:**

- Modify: `packages/pi-agents/tests/artifact-reader-extension.test.ts`

**Steps:**

- [ ] After opening and positionally verifying the original fd, move the original prefix directory outside the run root and replace the original prefix pathname with a symlink to that moved directory.
- [ ] Keep the artifact itself unchanged so fd/path `dev` and `ino`, size, bytes, and digest remain equal.
- [ ] Assert exact `artifact_unavailable` due to resolved containment.
- [ ] Record/assert the inode equality and valid fd digest inside the test so deleting containment checks would make the test fail.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/artifact-reader-extension.test.ts)`
- Expected: same-inode parent escape is rejected.

### Task 5: Assert Real Chain Terminal Spill and Handoff

**Outcome:** The real two-step Chain test proves both the intermediate descriptor and terminal ref-aware parent output.

**Files:**

- Modify: `packages/pi-agents/tests/tool.test.ts`
- Modify: `packages/pi-agents/tests/memory-regression.test.ts` only if shared fixtures belong there.

**Steps:**

- [ ] Assert exactly two real child invocations and inspect the second captured task directly.
- [ ] Make step 1 emit oversized output and assert step 2 receives a bounded artifact descriptor/reader instruction without raw sentinel.
- [ ] Make step 2 also emit oversized terminal output.
- [ ] Assert final tool content contains the terminal artifact descriptor, excludes `(no output)` and both sentinels, and final durable result uses `finalOutputRef` only.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts tests/memory-regression.test.ts)`
- Expected: both handoff and final Chain assembly are ref-backed.

### Task 6: Require One Descriptor per Parallel Success

**Outcome:** Parallel tests fail if ref-only successes become `(no output)` or omit metadata.

**Files:**

- Modify: `packages/pi-agents/tests/tool.test.ts`
- Modify: `packages/pi-agents/tests/memory-regression.test.ts` if duplicated coverage is retained.

**Steps:**

- [ ] Count successful oversized children.
- [ ] Parse/count bounded run-artifact descriptors in actual Parallel tool content and require one per successful child.
- [ ] Assert no `(no output)`, no sentinel, and each durable result contains `finalOutputRef` without inline output.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts tests/memory-regression.test.ts)`
- Expected: every success is represented by artifact metadata.

### Task 7: Make Existing-Refresh Restore Assertions Adversarial

**Outcome:** Restore tests prove durable reader state overrides stale endpoint state and launch assembly is exact.

**Files:**

- Modify: `packages/pi-agents/tests/interactive-agent.test.ts`

**Steps:**

- [ ] Pre-register existing endpoints with the opposite reader requirement from the durable unit for true and false/absent cases.
- [ ] Require the restored snapshot to be available and the refresh to install the durable requirement, including clearing stale true when durable state is false/absent if that is the defined contract.
- [ ] Activate and require exactly one transport creation.
- [ ] Compare the full shipped artifact-reader extension path, scan every `--extension` and `--tools` value, and assert exactly one forced reader tool when true.
- [ ] Assert exact run ID and `store.getRunDir(runId)` environment when true; assert no reader env/tool/extension anywhere when false/absent.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/interactive-agent.test.ts)`
- Expected: stale existing state cannot mask restore defects.

## Final Validation

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts tests/run-coordinator.test.ts tests/tool.test.ts tests/artifact-reader-extension.test.ts tests/memory-regression.test.ts tests/interactive-agent.test.ts)`
- Expected: all Round 7 regressions pass.

- Run: `mise run test --package packages/pi-agents`
- Expected: complete package suite passes.

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: no errors.

- Run: `mise run build --package packages/pi-agents`
- Expected: both entries build.

- Run: `(cd packages/pi-agents && out="$(bun pm pack --dry-run 2>&1)" && printf '%s\n' "$out" | rg -q 'dist/index\.js' && printf '%s\n' "$out" | rg -q 'dist/artifact-reader-extension\.js')`
- Expected: both entries package.

- Run: `hk check`
- Expected: lint/formatting pass.

- Run: `git diff --check`
- Expected: no whitespace errors.

## Failure Behavior

| Failure | Required behavior |
| --- | --- |
| Post-rename directory sync fails once | Restore prior `run.json`, return failure, no live/event/launch success. |
| Rollback fails | Bounded durable rollback error; no launch or live success claim. |
| Post-claim operation fails | Exactly one abandon, zero release. |
| Same-inode path resolves outside root | `artifact_unavailable`. |
| Chain/Parallel output spills | Actual content contains required descriptors, never `(no output)`. |

## Open Questions

**Open Questions:** None.
