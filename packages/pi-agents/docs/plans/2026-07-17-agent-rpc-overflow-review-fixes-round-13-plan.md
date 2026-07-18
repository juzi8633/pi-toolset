# Agent RPC Overflow Review Fixes Round 13 Implementation Plan

**Goal:** Make every intent-transfer crash state recoverable, prevent cleanup generation replacement from being accepted, uniformly bound all resume errors, and replace remaining non-deterministic/omitted tests.

**Inputs:** Scoped reviewer findings for staged delta `b89ba1943ed0c66dd7f4bfd2d6555735915eaf7d..5ad961b86a1ccad3e1582c88eb5572acc6326e3f`.

**Assumptions:** Ownership transfer does not enter the protected RMW critical section until intent/previous/temp cleanup completes. Therefore a crash while intent exists may safely restore the previous owner generation.

**Architecture:** Create and verify the new owner temp before atomically publishing immutable intent. Intent contains exact old owner, lock-dir, contender, and new-temp identities. Do not mutate intent phase in place. Recovery derives the transfer point from exact owner/previous/temp inode combinations and always restores the prior owner while intent exists. Generation mismatch becomes a terminal non-revalidatable error. A single final formatter bounds every resume error after prefixes.

**Tech Stack:** TypeScript, Bun, Node.js filesystem APIs, SHA-256, Mise, and HK.

---

## Tasks

### Task 1: Make Intent Immutable and Self-Describing

**Outcome:** Intent publication captures every generation needed to recover any later crash.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Create/fsync the contender's new owner temp before intent publication and capture its safe filename, dev/ino, bytes/digest, PID/start identity, and token.
- [ ] Publish one immutable hard-link intent containing exact lock-dir identity, old owner identity/content, contender identity, and new owner temp identity/content.
- [ ] Remove all in-place `ftruncate`/phase updates. Intent bytes never change after publication.
- [ ] Transfer operations remain: old owner -> constant `owner.previous`, new temp -> `owner.json`, with fsyncs; intent and previous are removed only before returning acquired ownership.
- [ ] Crash before intent leaves only an orphan new-owner temp tied to a dead contender; validated cleanup may remove it. Crash after intent is handled by Task 2.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: immutable intent schema and publication tests pass.

### Task 2: Recover Every Exact Intent Transfer State

**Outcome:** No crash while intent exists can cause permanent `run_busy` or dual ownership.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] If contender is live, return/wait busy without mutation.
- [ ] If contender is dead, validate lock dir and every present owner/previous/temp entry against immutable intent identities.
- [ ] Recover exact states idempotently:
  - old owner present + previous absent + new temp present: remove verified temp and intent; old owner remains.
  - owner absent + previous old + new temp present: rename previous back to owner, fsync, remove temp and intent.
  - owner is new + previous old + temp absent: remove new owner, rename previous back to owner, fsync, remove intent.
  - owner old + previous absent + temp absent: remove intent.
- [ ] Any other/mismatched combination fails closed preserving evidence.
- [ ] After restoring old owner and removing intent, the next contender may start a fresh transfer; it must not inherit the dead contender's new owner.
- [ ] Add bypass-cleanup/child-exit tests after intent link, after temp creation (before intent), after old owner move, after new owner publish, and during cleanup. Fresh acquisition must recover then succeed exactly once.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: every transfer crash state recovers deterministically.

### Task 3: Make Generation Mismatch Non-Revalidatable

**Outcome:** Replacing marker/rollback after authority decision always fails; valid replacement content cannot be washed into success.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Introduce a distinct internal generation-mismatch error/code emitted when expected dev/ino/content/phase differs before cleanup unlink.
- [ ] Cleanup catch paths must propagate this error directly and preserve replacement evidence; they must not call generic committed-state revalidation.
- [ ] `revalidateCommittedState` accepts original expected verified marker/rollback generations and rejects any present entry with different dev/ino, even if bytes/digest/phase are valid.
- [ ] Apply the same rule in strict publication and recovery cleanup paths.
- [ ] Add valid same-content/different-inode marker and rollback replacements at every pre-unlink seam; require one exact failure code and replacement preservation.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: generation replacement can never return success.

### Task 4: Uniformly Bound Every Resume Error after Prefixes

**Outcome:** Preflight, claim, post-claim, and fallback errors all produce final valid UTF-8 output at or below 64 KiB.

**Files:**

- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Centralize creation of every `{ error }` return from `maybeResumeDurableRun`, including missing persistence, preflight, claim, post-claim validation, setup, and plain-object exceptions.
- [ ] Apply code/message extraction first, add the final public prefix (`resume_error:` or `resume_setup_failed:`), then truncate the complete final text to `64 * 1024` UTF-8 bytes with one stable omission marker.
- [ ] Ensure callers do not add an unbounded second prefix after formatting.
- [ ] Test multi-megabyte preflight blocking reason, claim error message, post-claim Error/plain object, primitive, and fallback object with multibyte boundary; every complete final tool string is <=64 KiB and useful.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts)`
- Expected: every resume error branch is uniformly bounded.

### Task 5: Make Contender Tests Winner-Independent and Deterministic

**Outcome:** Tests prove atomic intent behavior regardless of which process wins.

**Files:**

- Modify: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Add a ready file/IPC handshake for each child before releasing a shared start barrier.
- [ ] Register both exit promises before release.
- [ ] Let either child become winner; determine winner from an atomic winner/event file and provide its non-empty release path dynamically.
- [ ] Require exactly one success, exactly one `run_busy`/waiter outcome, one intent inode, no overlap, fixed lock continuously present, and both exit codes expected.
- [ ] Kill the intent winner at each transfer seam and require a third process to recover and acquire successfully; never accept permanent busy.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: contender tests are race-order independent.

### Task 6: Add Exact Release Fault Coverage

**Outcome:** Every release failure named by Round 12 plan is tested with one error and no success.

**Files:**

- Modify: `packages/pi-agents/tests/run-store.test.ts`
- Modify production only if tests expose a defect.

**Steps:**

- [ ] Inject release-intent hard-link failure, tombstone rename failure, public runDir replacement, directory fsync failure, and tombstone identity mismatch at exact seams.
- [ ] For each: require operation rejection with one exact code, no success return, fixed/tombstone evidence preserved as specified, and later recovery/acquisition behavior explicit.
- [ ] Remove success-or-error and multi-code allowances from the affected tests.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: release failures cannot be swallowed.

## Final Validation

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts tests/tool.test.ts)`
- Expected: all Round 13 regressions pass.

- Run: `mise run test --package packages/pi-agents`
- Expected: complete package suite passes.

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: no errors.

- Run: `mise run build --package packages/pi-agents`
- Expected: both package entries build.

- Run: `(cd packages/pi-agents && out="$(bun pm pack --dry-run 2>&1)" && printf '%s\n' "$out" | rg -q 'dist/index\.js' && printf '%s\n' "$out" | rg -q 'dist/artifact-reader-extension\.js')`
- Expected: both entries package.

- Run: `hk check`
- Expected: lint/formatting pass.

- Run: `git diff --check && git diff --cached --check`
- Expected: no whitespace errors.

## Failure Behavior

| Condition                                 | Required behavior                                                    |
| ----------------------------------------- | -------------------------------------------------------------------- |
| Dead contender before intent              | Verified orphan temp removed; old owner unchanged.                   |
| Dead contender after intent/transfer step | Previous owner restored from exact immutable identities.             |
| Cleanup generation replaced               | Exact mismatch error; preserve replacement; no revalidation success. |
| Oversized resume error                    | Complete prefixed output <=64 KiB valid UTF-8.                       |
| Either contender wins                     | Same one-winner/one-waiter result.                                   |
| Release seam fails                        | Exact rejection; no success.                                         |

## Open Questions

**Open Questions:** None.
