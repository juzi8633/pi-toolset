# Agent RPC Overflow Review Fixes Round 12 Implementation Plan

**Goal:** Close the Round 11 incremental lock findings with atomic hard-link intents, a recoverable ownership-transfer state machine, generation-bound cleanup/authority reads, propagated release errors, and deterministic concurrency/path tests.

**Inputs:** Scoped reviewer findings for staged delta `34f24000c21f9a8a93da5545ff65065aea808d62..b89ba1943ed0c66dd7f4bfd2d6555735915eaf7d`.

**Assumptions:** Same-filesystem hard-link creation provides atomic no-replace publication for regular intent files. Read owner tokens are validated as data but never used to derive filesystem paths.

**Architecture:** Publish intent with `link(temp, fixedIntent)` so only one contender wins. Intent records observed owner identity plus contender identity and transfer temp identity. Dead-intent recovery either removes an untouched intent or deterministically completes/rolls back the exact transfer phase. Use constant safe transfer filenames and random locally generated names only. Carry verified inode/digest/phase handles from authority decision through cleanup.

**Tech Stack:** TypeScript, Bun, Node.js filesystem APIs, Linux `/proc/self/fd`, SHA-256, Mise, and HK.

---

## Tasks

### Task 1: Publish Intents with Atomic No-Replace

**Outcome:** Exactly one steal/release intent can exist, and a crashed contender's state is recoverable.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Write/fsync an intent temp, then atomically hard-link it to fixed `steal.intent`/`release.intent`; `EEXIST` means another state transition owns the lock.
- [ ] Verify linked intent and temp share inode/content, unlink the temp, and fsync lock dir.
- [ ] Include fixed schema: phase, observed lock/owner inode, observed owner token, contender PID/start identity/token, and expected new-owner-temp identity.
- [ ] Validate every token with a strict single-component regex and length. Never concatenate a read token into a path.
- [ ] Use constant safe transfer names (`owner.previous`) and locally generated random temp names.
- [ ] Dead-intent recovery: if owner is untouched, remove only the verified dead intent; if transfer began, use intent identities to finish or roll back the exact owner.previous/new-owner-temp/owner state; ambiguous state fails closed preserving evidence.
- [ ] Add crash tests after intent link, old-owner move, new-owner publish, and cleanup; fresh contender must recover without permanent busy or double ownership.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: atomic intent and crash recovery tests pass.

### Task 2: Prevent Path Injection and Generation Confusion

**Outcome:** Untrusted owner data cannot address another file, and tombstone cleanup only removes the exact generation encoded by its safe name.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Reject owner/intent tokens containing `/`, `..`, separators, control characters, excess length, or non-canonical format.
- [ ] Derive no owner/stale/cleanup path from a parsed token except after canonical validation; prefer fixed names and fresh local tokens.
- [ ] Parse tombstone suffix and require exact equality with verified owner token and release-intent token before removal.
- [ ] Add malicious token traversal, intermediate symlink, wrong tombstone suffix, and control-character tests; preserve evidence and fail closed.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: no parsed metadata can escape the lock directory.

### Task 3: Carry Verified Transaction Generations through Cleanup

**Outcome:** Cleanup deletes only the marker/rollback generation that determined transaction authority.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Return a verified entry object from marker/rollback reads: fd-read bytes, parsed phase, digest, dev/ino, uid/mode, and expected pathname.
- [ ] Pass these exact expected entries from authority decision/publication into cleanup.
- [ ] Immediately before unlink, lstat/open no-follow and require identical dev/ino, bytes/digest, phase, uid/mode/type.
- [ ] After unlink, verify absent and fsync directory; replacement or uncertainty preserves evidence and returns one bounded recovery error.
- [ ] Never reopen a replacement and treat it as the transaction generation merely because it is internally valid.
- [ ] Add marker/rollback replacement with valid alternate committed/prepared files and assert no deletion/success.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: generation replacement is detected.

### Task 4: Read Authority from One Verified No-Follow FD

**Outcome:** `run.json` bytes are the bytes verified on the same fd/inode; no path read follows a replacement symlink.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Open `run.json` with `O_NOFOLLOW`, fstat and compare to lstat, validate uid/mode/regular type, read bytes from that fd, fstat again, and return those exact bytes plus identity/digest.
- [ ] Replace every recovery/publication path `readFileSync(target)` with this helper.
- [ ] Ensure the no-transaction fast read also opens the run directory component-by-component and reads through retained dir fd.
- [ ] Add same-digest symlink swap between path validation/read, intermediate-root symlink fast-path, and normal read controls.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: authority reads never follow path replacements.

### Task 5: Propagate Every Release Failure

**Outcome:** A write never returns success if intent publication, tombstone rename, public inode revalidation, or verified release fails.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Remove `return` statements from release catch paths; store exact release error and throw it after safe fd-bound cleanup attempts.
- [ ] `withTxLock` combines operation and release errors deterministically without hiding either; any release failure prevents success.
- [ ] Add release-intent link failure, tombstone rename failure, runDir replacement, fsync failure, and tombstone identity mismatch tests with one exact code each.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: no release failure is swallowed.

### Task 6: Replace Concurrency and RMW Tests with Deterministic Barriers

**Outcome:** Tests prove one owner and exact merged RMW state under real processes.

**Files:**

- Modify: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Use two child processes with filesystem/IPC barriers at owner inspection, intent publication, and owner replacement.
- [ ] Record independent enter/exit event files (append-only or one file per process), assert child exit codes, exactly one successful transfer, one `run_busy`/waiter, and no overlap by interval/barrier evidence.
- [ ] Assert fixed lock exists at every transfer barrier.
- [ ] Use two child writers modifying different fields after a shared start barrier; final record must be exactly `status: running` and `requireArtifactReader: true`.
- [ ] Path/cleanup replacement tests pause at the exact fd-open/pre-unlink hook and require one error code, no success, and untouched replacement evidence.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: tests deterministically fail on dual owner or stale overwrite.

### Task 7: Tighten Remaining Incremental Assertions

**Outcome:** Tests enforce exact full diagnostic and path/cleanup contracts.

**Files:**

- Modify: `packages/pi-agents/tests/tool.test.ts`
- Modify: `packages/pi-agents/tests/run-store.test.ts`
- Modify production only if tests expose a defect.

**Steps:**

- [ ] Require complete final diagnostic `Buffer.byteLength <= 64 * 1024`, exact omission marker, valid multibyte boundary, and deterministic useful fallback for every input shape; never allow `[object Object]`.
- [ ] Remove success-or-error and multi-code assertions from runDir/cleanup tests; each seam has one expected failure code and evidence state.
- [ ] Preserve scoped exact strict-start/Chain assertions already added.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts tests/run-store.test.ts)`
- Expected: no permissive assertions remain in Round 12 coverage.

## Final Validation

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts tests/tool.test.ts)`
- Expected: all Round 12 regressions pass.

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

| Condition                     | Required behavior                                          |
| ----------------------------- | ---------------------------------------------------------- |
| Concurrent intent publication | One hard-link winner; others busy.                         |
| Intent owner crashes          | Exact state-machine recovery or fail closed with evidence. |
| Malicious token               | Reject; no path derivation/deletion.                       |
| Marker/rollback replaced      | Identity mismatch; preserve; no success.                   |
| Authority path swapped        | No-follow fd read rejects it.                              |
| Release operation fails       | Caller receives bounded failure.                           |

## Privacy and Security

- Parsed metadata cannot become an unchecked path.
- Authority and transaction entries are single-fd/inode verified.
- Concurrency diagnostics contain no run content or private paths.

## Open Questions

**Open Questions:** None.
