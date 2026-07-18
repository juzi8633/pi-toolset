# Agent RPC Overflow Review Fixes Round 9 Implementation Plan

**Goal:** Make strict run transactions safe across stores/processes, resolve commit uncertainty explicitly, make cleanup crash-safe, prevent transaction-path symlink attacks, and close remaining diagnostic/test gaps.

**Inputs:** Reviewer findings for staged tree `fa7a4207965c6d16dc4e07b35ea4166a26a767e7`; current staged Round 8 implementation.

**Assumptions:**

- Linux/Arch is the production validation target; stale-lock ownership may use PID plus `/proc` process-start identity. Unsupported platforms fail closed rather than stealing a lock they cannot prove stale.
- A live transaction owner is never recovered by another reader/writer.
- If committed-marker publication becomes uncertain and cannot be durably reverted to `prepared`, the API reports `durable_commit_uncertain`; recovery follows the marker/digest actually present.

**Architecture:** Add a run-local exclusive transaction lock shared by all `RunStore` instances/processes. Strict writes and recovery hold it; readers encountering transaction state acquire/wait for the lock before recovery. Use safe no-follow atomic writers for marker/rollback files. Define phase-specific, directory-synced cleanup and an explicit committed-marker uncertainty transition.

**Tech Stack:** TypeScript, Bun, Node.js filesystem APIs, `/proc` process identity on Linux, SHA-256, Mise, and HK.

---

## Tasks

### Task 1: Add Cross-Instance/Process Transaction Ownership

**Outcome:** A reader or writer cannot recover or overwrite a live strict transaction.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Add a fixed private lock directory under each run directory, acquired atomically with `mkdir` and containing a private owner record: version, PID, process-start identity, random token, and timestamp.
- [ ] Flush the owner record and sync the run directory before transaction mutation.
- [ ] Verify ownership token before releasing; remove lock contents/directory and sync the parent directory.
- [ ] Wrap every `run.json` writer (strict and ordinary) and every destructive transaction recovery in the same lock protocol. Keep existing in-instance `runSerial` as an optimization/order layer, not the ownership boundary.
- [ ] `loadRunJson()` may read an atomic `run.json` directly when no transaction artifacts exist. If marker/rollback state exists, it must acquire/wait for the lock before recovery; it must never recover while a verified live owner holds the lock.
- [ ] Use a bounded wait/retry with a specific `run_busy`/durable recovery error. Do not block indefinitely.
- [ ] Steal a lock only when PID plus process-start identity proves the owner is dead/stale. If liveness cannot be proven, fail closed.
- [ ] Add cross-instance and child-process tests that pause a writer after new rename/before committed marker. A second reader/writer must wait/fail busy and must not restore/delete transaction material; after the writer completes, it observes new authority.
- [ ] Add stale-owner recovery and live-owner non-steal tests.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: no active transaction can be destructively recovered by another owner.

### Task 2: Model Committed-Marker Publication Uncertainty

**Outcome:** A committed-marker rename followed by directory-sync failure cannot silently flip between reported rollback and accepted commit.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Make marker publication report whether rename occurred and whether directory sync completed.
- [ ] If committed-marker rename occurred but its directory sync failed, first attempt to durably publish `prepared` again.
- [ ] Only after `prepared` is durably restored may rollback overwrite `run.json` and report the original strict failure.
- [ ] If re-preparing fails, do not attempt rollback or delete artifacts. Return bounded `durable_commit_uncertain`; leave new `run.json`, committed/prepared marker as actually present, and rollback bytes for locked recovery.
- [ ] Recovery validates the marker and digests present: committed accepts verified new authority; prepared restores verified old authority. It never guesses based on the caller's prior return value.
- [ ] Test committed-marker rename + sync failure with successful re-prepare/rollback, and with re-prepare failure. Assert exact returned code, preserved files, and fresh-store authority.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: commit uncertainty is explicit and deterministic.

### Task 3: Make Phase Cleanup Crash-Safe

**Outcome:** Every crash between cleanup unlinks leaves a recoverable state.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Prepared/old-authority cleanup: remove marker first, sync directory, then remove rollback, sync again. An orphan rollback with matching old `run.json` is safe and removable on recovery.
- [ ] Committed/new-authority cleanup: remove rollback first, sync directory, then remove marker, sync again. A committed marker without rollback verifies new `run.json` and is removable on recovery.
- [ ] Do not swallow cleanup errors that would create an unrecognized state. Return committed success only when remaining artifacts still encode an unambiguous committed state recoverable on next load.
- [ ] Add crash seams between each unlink and fsync; use a sentinel that bypasses normal catch/finally cleanup or a child process exit.
- [ ] Reopen with a fresh store and assert prepared windows resolve old, committed windows resolve new, and leftovers are eventually removed.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: no unlink ordering creates `corrupt_run` from a valid interrupted cleanup.

### Task 4: Harden Transaction Files against Symlink/Path Races

**Outcome:** Marker, rollback, owner, and staging files cannot follow or overwrite through attacker-controlled links.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Replace `existsSync` security decisions with `lstat` and explicit absent/regular-file/private-mode validation.
- [ ] Read transaction files using `O_NOFOLLOW`, `fstat`, and same-inode verification.
- [ ] Create transaction bytes through random same-directory temp files opened with `O_CREAT|O_EXCL|O_NOFOLLOW`, mode `0600`, write/fsync, then atomic rename over a validated fixed destination. Never open fixed transaction paths with `'w'`.
- [ ] Validate run-directory containment and reject marker/rollback/lock symlinks, dangling symlinks, directories, non-regular files, wrong ownership/mode, and replacement races.
- [ ] On unsafe entries, fail closed without following or deleting evidence.
- [ ] Add dangling rollback, dangling marker/lock, post-lstat replacement, wrong-mode, directory, and out-of-run target tests.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: no transaction operation follows a symlink or writes outside the run.

### Task 5: Bound Resume Store Diagnostics

**Outcome:** Object-shaped store errors preserve useful code/message within a fixed UTF-8 budget.

**Files:**

- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Apply an existing diagnostic budget or a named fixed constant to the final formatted code/message in `formatBoundedStoreError()`.
- [ ] Truncate on UTF-8 code-point boundaries and add a stable omission marker.
- [ ] Bound every branch, including primitive/fallback values.
- [ ] Test multi-megabyte code/message/fallback objects; assert byte limit, useful prefix/code, no broken UTF-8, and no `[object Object]` when message exists.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts)`
- Expected: resume diagnostics remain bounded.

### Task 6: Use Real Crash-State Tests and Preserve Recovery Error Codes

**Outcome:** Tests execute actual recovery, and list APIs distinguish temporary recovery errors from permanent corruption.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Modify: `packages/pi-agents/src/run-types.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Replace exception hooks that trigger in-process rollback with a test-only crash sentinel that intentionally bypasses transaction cleanup, or run the writer in an exiting child process.
- [ ] Assert fresh-store recovery performs the work for every prepared/committed/cleanup window.
- [ ] Preserve `durable_write_error`, `durable_commit_uncertain`, `run_busy`, and recovery-pending codes through `listRuns()` instead of rewriting all to `corrupt_run`.
- [ ] Keep malformed data/schema/digest/security violations as `corrupt_run` where appropriate.
- [ ] Add list tests for temporary lock/recovery failure and permanent malformed transaction state.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: fresh recovery and list error taxonomy are explicit.

### Task 7: Make Strict-Start and Chain Assertions Exact

**Outcome:** Remaining orchestration tests cannot pass on missing live/events or the wrong Chain descriptor.

**Files:**

- Modify: `packages/pi-agents/tests/tool.test.ts`
- Modify: `packages/pi-agents/tests/run-coordinator.test.ts`
- Modify: `packages/pi-agents/tests/memory-regression.test.ts` if duplicate coverage remains.

**Steps:**

- [ ] Strict-start: require a known registered live record, exact second unit `queued`, exact unchanged attempt, absent reader flag, existing events file with no second-unit `unit_started`, exact independent seed spawn/reader spawn/RPC activation counts, and exact bounded error code/message.
- [ ] Remove all conditional assertions that skip when live/event data is missing.
- [ ] Chain: capture tasks by spawn index, require exactly two invocations, directly inspect invocation 2, and compare its digest to step 1's exact ref.
- [ ] Compare final content's digest prefix to step 2's exact ref and ensure step 1's descriptor is not accepted as terminal authority.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts tests/run-coordinator.test.ts tests/memory-regression.test.ts)`
- Expected: strict-start and Chain identity regressions are exact.

## Final Validation

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts tests/tool.test.ts tests/run-coordinator.test.ts tests/memory-regression.test.ts)`
- Expected: all Round 9 regressions pass.

- Run: `mise run test --package packages/pi-agents`
- Expected: complete package suite passes.

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: no errors.

- Run: `mise run build --package packages/pi-agents`
- Expected: both package entries build.

- Run: `(cd packages/pi-agents && out="$(bun pm pack --dry-run 2>&1)" && printf '%s\n' "$out" | rg -q 'dist/index\.js' && printf '%s\n' "$out" | rg -q 'dist/artifact-reader-extension\.js')`
- Expected: both entries package.

- Run: `hk check`
- Expected: lint and formatting pass.

- Run: `git diff --check && git diff --cached --check`
- Expected: no whitespace errors.

## Failure Behavior

| Condition                                 | Required behavior                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Live transaction lock exists              | Wait/fail busy; never recover it.                                                  |
| Proven stale transaction lock             | Acquire ownership, recover by marker phase.                                        |
| Committed marker rename sync is uncertain | Re-prepare then rollback, or report `durable_commit_uncertain` and preserve files. |
| Prepared cleanup crashes                  | Old authority remains recoverable.                                                 |
| Committed cleanup crashes                 | New authority remains recoverable.                                                 |
| Transaction path is symlink/unsafe        | Fail closed without following/deleting it.                                         |
| Recovery is temporarily unavailable       | Preserve recovery-specific code in list output.                                    |

## Privacy and Security

- Lock and transaction files are private, run-contained, no-follow, and identity-verified.
- Lock owner records expose only local process metadata inside private run storage.
- Diagnostics are bounded and contain no authority payload or private paths.

## Open Questions

**Open Questions:** None.
