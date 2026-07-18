# Agent RPC Overflow Review Fixes Round 10 Implementation Plan

**Goal:** Make run transaction locking atomically publishable/stealable/releasable, hold it across full read-modify-write, bind all transaction paths to an opened run-directory inode, and make cleanup/config/tests fail closed and exact.

**Inputs:** Reviewer findings for staged tree `bff7ca6a3472b30fbeb30e210d83a35d295ecca6`; current staged Round 9 implementation.

**Assumptions:**

- Linux `/proc/self/fd` is available on the validated Arch target. If a platform cannot provide equivalent directory-fd-relative safety, strict transactions fail closed.
- Atomic rename of a fully initialized unique lock directory to the fixed lock name is the ownership publication primitive.
- Atomic rename of the fixed lock directory to a unique quarantine/tombstone is the stale-steal/release primitive.

**Architecture:** Open the owning run directory with `O_DIRECTORY|O_NOFOLLOW`, verify its identity, and address all transaction entries through `/proc/self/fd/<dirFd>/...`. Build lock candidates completely off to the side, then atomically rename to the fixed lock name. Stale steal and release first atomically rename the fixed lock away, then verify/remove the captured inode. Move load, recovery, mutate, validation, and publication under this lock for every run-record writer.

**Tech Stack:** TypeScript, Bun, Node.js filesystem APIs, Linux `/proc/self/fd`, SHA-256, Mise, and HK.

---

## Tasks

### Task 1: Atomically Publish and Remove Complete Locks

**Outcome:** The fixed lock name is always absent or a fully initialized owner directory; stale steal/release cannot delete a replacement owner.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Create a unique candidate lock directory with mode `0700`, write/fsync a validated `owner.json` mode `0600`, fsync the candidate directory, then atomically rename the complete candidate to the fixed lock name.
- [ ] If fixed lock exists, remove the losing candidate and inspect the fixed owner.
- [ ] Eliminate `mkdir fixed -> write owner`; no crash may leave an ownerless fixed lock.
- [ ] Stale steal: lstat fixed lock and owner, prove stale, atomically rename fixed lock to a unique quarantine path, then verify quarantine directory inode and owner token/inode match the inspected stale owner before removal.
- [ ] Release: verify current fixed directory inode and owner token, atomically rename it to a token-specific tombstone, sync the run directory, then remove tombstone contents. Never unlink owner then rmdir fixed in place.
- [ ] Crash before/after candidate publication or tombstone removal leaves either a complete fixed owner or only an ignorable unique candidate/tombstone; next acquisition cleans safe leftovers.
- [ ] Add two-contender stale-steal races, owner-release vs steal, candidate crash, release crash, and replacement-owner tests. Assert at most one owner enters the critical section.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: lock ownership remains exclusive through all races/crashes.

### Task 2: Hold the Lock across Full Read-Modify-Write

**Outcome:** Two stores/processes cannot overwrite each other's changes from stale snapshots.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Refactor ordinary `updateRun()` and `updateRunStrict()` so lock acquisition occurs before transaction recovery and `run.json` load.
- [ ] While holding the lock: recover, read current record, clone/mutate, validate, serialize, write/publish, and complete required cleanup.
- [ ] Ordinary writers must recover any interrupted strict transaction under the lock before reading/writing; they cannot overwrite prepared/committed state.
- [ ] Preserve in-instance `runSerial`, but correctness must hold across independent `RunStore` instances and child processes.
- [ ] Audit every run-record writer/helper so none performs load outside lock followed by write inside lock.
- [ ] Add two-store overlapping field updates and child-process write races; assert both non-conflicting changes survive or conflicts are explicit, never silent stale overwrite.
- [ ] Pause a strict writer in prepared/rename state and start an ordinary writer; assert it waits/fails busy and later reads the recovered/committed authority before mutation.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: no stale-snapshot lost update across stores/processes.

### Task 3: Bind Transaction Paths to an Open Directory Inode

**Outcome:** Replacing the run directory or intermediate path cannot redirect lock/marker/rollback/temp/owner operations.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Open the run directory with `O_RDONLY|O_DIRECTORY|O_NOFOLLOW`, record `fstat` identity, ownership, and private mode.
- [ ] Build child operation paths only beneath `/proc/self/fd/<dirFd>/`; fail closed if proc-fd resolution is unavailable or does not resolve to the expected opened inode.
- [ ] Before returning, revalidate that the public run-directory path still names the same inode; a replacement causes a bounded security/durable error.
- [ ] For each temp: open `O_CREAT|O_EXCL|O_NOFOLLOW`, `fchmod(0600)`, write/fsync, capture fd identity, close, lstat temp and compare identity, rename through dir-fd paths, then lstat destination and compare the same inode before directory fsync.
- [ ] Perform lock candidate/quarantine/tombstone operations through the same opened directory fd.
- [ ] Validate expected uid (when available), exact private mode policy (`0700` dirs, `0600` files), regular-file/directory type, and no symlink for owner, marker, rollback, fixed lock, and transaction temps.
- [ ] Use identity-checked no-follow deletion; never path-delete an entry that changed after validation.
- [ ] Add run-directory replacement, temp replacement after close, intermediate symlink, wrong uid/mode, dangling link, and owner replacement races.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: all operations remain bound to the opened owning directory.

### Task 4: Revalidate Committed Cleanup before Returning Success

**Outcome:** Cleanup errors are tolerated only when remaining files still encode a safe committed state.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] On committed cleanup failure, re-read marker/rollback/run.json through identity-checked no-follow helpers while still holding lock.
- [ ] Return committed success only if marker phase/digests and remaining artifacts unambiguously recover to the verified new `run.json`.
- [ ] Unsafe replacement, malformed entry, digest mismatch, or non-recoverable shape returns `durable_write_error`/`corrupt_run` and preserves evidence.
- [ ] Apply the same rule to recovery cleanup; do not unconditionally swallow errors.
- [ ] Add cleanup-time marker/rollback replacement with symlink/wrong inode/wrong mode, benign unlink/fsync interruption, and digest mismatch tests.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: success is reported only for provably recoverable committed state.

### Task 5: Validate Lock Wait Configuration

**Outcome:** Lock waiting is always finite and positive.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] At store construction, reject or normalize `NaN`, `Infinity`, negative, zero/invalid retry, and retry greater than wait.
- [ ] Use finite integer millisecond bounds and a hard maximum suitable for the existing synchronous API.
- [ ] Ensure `Atomics.wait` always receives a finite bounded timeout and the acquisition loop always reaches a deadline.
- [ ] Add table-driven invalid/edge tests and a live-lock timeout elapsed-time upper bound.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: no configuration can wait forever.

### Task 6: Make Crash/Race Tests Execute Real States

**Outcome:** Tests pause/exit real writers and fresh stores perform actual recovery.

**Files:**

- Modify: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Use the bypass-cleanup sentinel or child-process exit so prepared/committed/cleanup artifacts remain on disk after the writer terminates; do not throw through normal rollback catch/finally.
- [ ] Cover every prepared cleanup unlink/fsync and committed cleanup unlink/fsync boundary, plus committed-marker uncertainty.
- [ ] For lock races, pause a real writer holding a published lock and run a second store/process; assert no destructive recovery or second writer entry.
- [ ] Reopen via a fresh store and assert exact old/new authority, leftover removal, and unique error codes.
- [ ] Tighten existing broad code assertions to one expected code per scenario.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: tests fail if real recovery/locking is removed.

### Task 7: Complete Diagnostic and Orchestration Exactness

**Outcome:** Error bounds and strict-start/Chain assertions cover every branch exactly.

**Files:**

- Modify: `packages/pi-agents/tests/tool.test.ts`
- Modify: `packages/pi-agents/tests/run-coordinator.test.ts`
- Modify: `packages/pi-agents/tests/memory-regression.test.ts` if duplicate coverage remains.
- Modify production only if tests expose a defect.

**Steps:**

- [ ] Parameterize bounded-store-error tests for `Error`, code+message object, message-only, code-only, primitive, and fallback object.
- [ ] Use repeated multibyte content crossing the exact byte boundary; require output at/below the fixed budget, valid UTF-8, stable omission marker, and useful code/prefix.
- [ ] Strict-start seams throw deterministic coded errors; assert exact code/message, exact target unit queued/attempt/reader fields, mandatory live/events observations, and independent spawn/RPC counters.
- [ ] Chain assertions compare invocation 2 and terminal content to exact step 1/step 2 digests, not generic descriptor presence.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts tests/run-coordinator.test.ts tests/memory-regression.test.ts)`
- Expected: all diagnostic/orchestration branches are exact.

## Final Validation

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts tests/tool.test.ts tests/run-coordinator.test.ts tests/memory-regression.test.ts)`
- Expected: all Round 10 regressions pass.

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

- Run: `git diff --check && git diff --cached --check`
- Expected: no whitespace errors.

## Failure Behavior

| Condition                     | Required behavior                                                     |
| ----------------------------- | --------------------------------------------------------------------- |
| Lock candidate creation crash | Fixed lock absent; candidate safely collectible.                      |
| Release crash                 | Fixed lock absent; token tombstone safely collectible.                |
| Two stale stealers            | Only one atomically captures stale lock; replacement owner untouched. |
| Concurrent store updates      | Full RMW serialized; no silent lost update.                           |
| Run directory/temp replaced   | Fail closed; no redirected publish/delete.                            |
| Committed cleanup error       | Success only if remaining committed state revalidates.                |
| Invalid wait configuration    | Store construction fails or finite defaults apply.                    |

## Privacy and Security

- All transaction operations are directory-fd-bound and no-follow.
- Owner metadata remains private and contains no run authority.
- Unsafe entries are preserved for diagnosis and never followed/deleted blindly.

## Open Questions

**Open Questions:** None.
