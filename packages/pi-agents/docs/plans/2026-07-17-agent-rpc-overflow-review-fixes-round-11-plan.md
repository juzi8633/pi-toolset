# Agent RPC Overflow Review Fixes Round 11 Implementation Plan

**Goal:** Close the Round 10 lock-generation, unsafe cleanup, inode-success, path-resolution, monotonic-wait, and false-positive test findings without revisiting unrelated code.

**Inputs:** Reviewer findings for exact staged delta `bff7ca6a3472b30fbeb30e210d83a35d295ecca6..34f24000c21f9a8a93da5545ff65065aea808d62`.

**Assumptions:**

- Linux `/proc/self/fd` remains the validated target.
- The fixed lock directory must remain present throughout stale ownership transfer so a stale stealer can never capture a replacement generation.
- Unknown candidate/quarantine/tombstone entries are preserved and cause bounded failure rather than recursive deletion.

**Architecture:** Convert stale steal into an in-place fixed-lock state transition guarded by an exclusive intent file inside the lock directory. The old dead owner is replaced atomically within the same directory; the fixed name never disappears during transfer. Release uses an intent then atomically renames the verified fixed lock to a token tombstone after the owner has exited the critical section. All cleanup and authority reads use expected inode/content identities through directory-fd-bound no-follow helpers.

**Tech Stack:** TypeScript, Bun, Node.js filesystem APIs, Linux `/proc/self/fd`, SHA-256, Mise, and HK.

---

## Tasks

### Task 1: Make Stale Ownership Transfer Generation-Safe

**Outcome:** Two stale stealers cannot remove or suspend a replacement owner, and no second owner enters the critical section.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Keep the fixed lock directory present during stale transfer.
- [ ] After proving the owner dead, create an exclusive no-follow `steal.intent` inside that fixed directory containing contender token plus the observed owner token and owner/directory inode identities; fsync it and the lock directory.
- [ ] Re-read owner and directory identities after intent publication. If they differ, remove only the contender's verified intent, fail `run_busy`, and never continue acquisition.
- [ ] Other contenders seeing an intent wait/fail busy; they never rename/delete the fixed lock.
- [ ] Prepare/fsync a new owner temp inside the same lock directory, rename old owner to a tokenized stale entry, rename new owner temp to `owner.json`, fsync the lock directory, then remove the verified intent/stale entry with fsyncs.
- [ ] Return ownership only after new owner durability. The old owner is known dead and the fixed directory generation never disappears.
- [ ] Add two real child-process stealers paused after old-owner inspection. Assert one transfer, one busy/waiter, `maxActive === 1`, replacement token remains installed, and no process deletes another generation.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: stale transfer is exclusive under real concurrency.

### Task 2: Make Release Atomic and Replacement-Safe

**Outcome:** Release cannot delete a replacement lock and public run-directory replacement cannot be reported as success.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Create/fsync an exclusive `release.intent` inside the owned fixed lock; verify lock directory inode, owner inode/token, and intent ownership.
- [ ] After the critical operation completes, atomically rename the whole verified fixed lock directory to a token-specific tombstone through the held run-dir fd, then fsync the run directory. Only then is the fixed name absent for a new owner.
- [ ] Remove tombstone using verified inode/token and no-follow fd traversal; never recursively follow paths.
- [ ] Crash before rename leaves a complete owner+release intent. A live owner remains busy; a proven-dead owner allows the next acquirer to complete release safely before acquiring.
- [ ] Propagate final public run-directory inode mismatch after safe release; `withTxLock` must not swallow it or return write success.
- [ ] Add owner release vs stale transfer, replacement-owner, release-intent crash, tombstone cleanup crash, and public runDir replacement-after-open tests with one exact error code.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: release is token/inode exact and never misreports a replaced public path.

### Task 3: Remove Blind Prefix Cleanup

**Outcome:** Cleanup never traverses symlinks, deletes arbitrary directories, or removes a live contender's candidate.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Delete prefix-based recursive cleanup and all generic `rmSync(..., recursive)` fallbacks for lock candidates/quarantines/tombstones.
- [ ] A process cleans only a path whose token it created or whose owner record, directory inode, uid, mode, and terminal state it has fully verified through an opened no-follow directory fd.
- [ ] Unknown or unsafe prefixed entries cause bounded `corrupt_run`/`run_busy` and remain untouched.
- [ ] Candidate creation failure cleans only the current candidate through its held fd/inode.
- [ ] Add top-level candidate symlink to an external directory, unknown live candidate, wrong-token tombstone, and contender-building candidate tests; assert external/live contents remain unchanged.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: no cleanup follows or recursively deletes unowned paths.

### Task 4: Bind Authority Reads and Cleanup Deletes to Expected Inodes

**Outcome:** Committed success and cleanup are accepted only for the exact verified marker/rollback/run.json generation.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Replace `pathEntryKind + readFileSync(path)` authority reads with `O_NOFOLLOW` open, `fstat`, lstat/fstat inode comparison, uid/mode/type validation, and fd reads.
- [ ] Return a verified entry handle/identity for marker and rollback; before unlink, lstat again and require the same inode/content digest/phase.
- [ ] Unlink only the expected inode through the bound run-dir fd, then fsync. If identity changes, preserve evidence and return a bounded recovery error.
- [ ] On cleanup fsync uncertainty, revalidate every state that could reappear after crash against the same committed marker/run digest before returning success.
- [ ] Add same-digest run.json symlink swap, marker replacement before unlink, rollback replacement, cleanup fsync uncertainty with old directory entry reappearance, wrong uid/mode, and non-regular tests.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: replacement entries cannot be accepted/deleted as the verified transaction.

### Task 5: Resolve the Entire Run Path without Following Symlinks

**Outcome:** Root or intermediate directory replacement cannot redirect the opened run directory.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Resolve the absolute runs-root/run path component by component starting from `/`, opening each next component through `/proc/self/fd/<parentFd>/<name>` with `O_DIRECTORY|O_NOFOLLOW`.
- [ ] Validate each opened component's lstat/fstat inode and reject symlinks/replacements; retain the final run-directory fd for all operations.
- [ ] Revalidate the public component chain before returning success.
- [ ] Add root symlink, intermediate replacement after parent open, run-directory replacement, and normal-path controls. Every redirection must fail without writing outside the original tree.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: no intermediate path component is followed.

### Task 6: Use a Monotonic Lock Deadline

**Outcome:** Clock changes cannot extend lock wait beyond its hard bound.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Use `performance.now()` or `process.hrtime.bigint()` elapsed time for deadline and remaining timeout.
- [ ] Keep all retry values finite validated integers.
- [ ] Test wall-clock rollback/forward stubs while a live lock is held; elapsed monotonic upper bound remains enforced.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: wait is bounded independently of wall-clock changes.

### Task 7: Replace False-Positive Lock/RMW/Path Tests

**Outcome:** Tests deterministically hit the intended real concurrency and replacement windows.

**Files:**

- Modify: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Replace same-event-loop contender tests with two child processes and barriers around inspect/intent/owner replacement; record shared active/maxActive.
- [ ] Force two-store RMW overlap and require exact merged result: `status === 'running'` and `requireArtifactReader === true`; no either/or assertions.
- [ ] Pause after run-dir fd open, replace the public path, then require one exact failure and no reported success.
- [ ] For cleanup tests, inject at exact verified-unlink/fsync hooks and assert one code, evidence preservation, and fresh-store authority.
- [ ] Execute bypass-cleanup crash seams for prepared cleanup's marker unlink/fsync and rollback unlink/fsync plus every committed cleanup boundary.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: removing race/identity protections fails deterministically.

### Task 8: Tighten Full Diagnostic and Strict-Start Contracts

**Outcome:** Final user-visible diagnostics never exceed 64 KiB, and strict-start errors are exact.

**Files:**

- Modify: `packages/pi-agents/src/tool.ts` only if final formatting needs adjustment.
- Modify: `packages/pi-agents/tests/tool.test.ts`
- Modify: `packages/pi-agents/tests/run-coordinator.test.ts`

**Steps:**

- [ ] Apply the 64 KiB cap to the complete final diagnostic including prefixes/omission marker, not an inner fragment.
- [ ] Parameterize `Error`, code+message, message-only, code-only, string/number/boolean/null, and fallback object; fallback must be deterministic and useful, never accepted as `[object Object]`.
- [ ] Use multibyte boundary cases and require `Buffer.byteLength(output) <= 64 * 1024` exactly.
- [ ] Strict-start fault seams emit fixed coded errors; compare the complete expected code/message and require mandatory live/events/unit observations.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts tests/run-coordinator.test.ts)`
- Expected: diagnostics and strict-start assertions are exact.

## Final Validation

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts tests/tool.test.ts tests/run-coordinator.test.ts)`
- Expected: all Round 11 regressions pass.

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

| Condition                 | Required behavior                                                  |
| ------------------------- | ------------------------------------------------------------------ |
| Two stale stealers        | One in-place transfer; all others busy; fixed lock never absent.   |
| Release crash             | Complete owner/intent or token tombstone, both safely recoverable. |
| Unknown prefixed entry    | Preserve and fail; never recurse/follow.                           |
| Marker/run replacement    | Identity mismatch; preserve evidence; no success.                  |
| Intermediate path symlink | Fail before transaction operation.                                 |
| Wall clock changes        | Monotonic bounded wait unchanged.                                  |

## Privacy and Security

- No blind recursive cleanup remains.
- Every read/delete/publish is directory-fd-bound, no-follow, and inode/uid/mode verified.
- Diagnostics remain bounded and contain no authority content or private paths.

## Open Questions

**Open Questions:** None.
