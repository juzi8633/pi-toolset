# Agent RPC Overflow Review Fixes Round 8 Implementation Plan

**Goal:** Complete the strict run-file transaction lifecycle, preserve recoverability when rollback fails or the process crashes, retain useful durable errors, and make strict-start/Chain tests identity-exact.

**Inputs:** The reviewer report for staged tree `24d79292efb645e775bfe93ac7d6319799521fca`; current staged Round 7 changes.

**Assumptions:**

- A strict update is not committed until a durable transaction marker records the committed digest.
- A prepared but uncommitted transaction recovers to the previous authoritative bytes.
- A committed transaction recovers to the new authoritative bytes and only needs cleanup.
- Cleanup failure after a durable committed marker does not turn a committed authority update into a reported rollback; recovery completes cleanup later.

**Architecture:** Replace the anonymous rollback file with a deterministic run-local transaction protocol: rollback copy plus durable marker carrying old/new digests and phase. Every run load recovers an interrupted transaction before parsing `run.json`. Prepared transactions restore old authority; committed transactions keep new authority and clean leftovers. Rollback failure preserves recovery files instead of deleting them.

**Tech Stack:** TypeScript, Bun, Node.js filesystem APIs, SHA-256, Mise, and HK.

---

## Tasks

### Task 1: Add a Recoverable Strict Run-File Transaction Protocol

**Outcome:** Every crash window has deterministic old/new authority, and rollback failure preserves recovery material.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Use deterministic private transaction paths inside the run directory for the rollback bytes and transaction marker; do not expose them through public refs.
- [ ] The marker contains a fixed version, phase (`prepared` or `committed`), old SHA-256/byte count, and new SHA-256/byte count. Validate it strictly before recovery.
- [ ] Before replacing an existing `run.json`, recover any prior transaction, write/fsync the exact old rollback bytes, write/fsync a `prepared` marker, and sync the directory.
- [ ] Rename the new staging file over `run.json` and sync the directory.
- [ ] Durably replace the marker with `committed` and sync the directory before treating the update as committed.
- [ ] Remove rollback and marker after commit and sync the directory. If cleanup fails after committed marker durability, leave recoverable leftovers and return committed success; the next load finishes cleanup.
- [ ] On any failure before committed marker durability, restore rollback bytes over `run.json`, fsync the restored file and directory, then remove marker/rollback and sync cleanup before propagating failure.
- [ ] If rollback I/O fails, preserve rollback and marker, return a bounded `durable_write_error` indicating recovery is pending/failed, and never call generic leftover cleanup.
- [ ] Run recovery before every `run.json` load/update: `prepared` restores and returns old authority; `committed` verifies the new digest and cleans leftovers; malformed/unsafe transaction state fails closed as `corrupt_run`/durable recovery error.
- [ ] Handle orphan rollback created before marker durability: verify `run.json` still matches rollback old digest/bytes, remove the redundant rollback, and sync cleanup; otherwise fail closed.
- [ ] Keep file/directory modes private and all paths contained in the owning run directory.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: all transaction and recovery tests pass.

### Task 2: Cover Every Strict Transaction Crash Window

**Outcome:** Tests lock old/new authority and cleanup semantics at each protocol phase.

**Files:**

- Modify: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [ ] Add one-shot faults after rollback publication, after prepared marker durability, after new rename, after new directory sync but before committed marker, after committed marker durability, and during cleanup.
- [ ] Reopen through a fresh `RunStore`/`getRun()` after each simulated crash.
- [ ] For every pre-commit window, assert old exact bytes/state are restored and leftovers are durably removed.
- [ ] For committed-marker and cleanup windows, assert new exact bytes/state remain authoritative and leftovers are removed on recovery.
- [ ] Add rollback rename/write/fsync failure cases; assert rollback/marker remain present, the error is bounded, no generic cleanup deletes them, and a later successful recovery restores old authority.
- [ ] Add malformed marker, digest mismatch, traversal/symlink, and wrong-mode/non-regular recovery entries; fail closed without deleting forensic/recovery material.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts)`
- Expected: no crash window is ambiguous.

### Task 3: Preserve Structured Resume Write Errors

**Outcome:** Resume reports useful `code`/`message` for object-shaped store errors instead of `[object Object]`.

**Files:**

- Modify: `packages/pi-agents/src/tool.ts`
- Test: `packages/pi-agents/tests/tool.test.ts`

**Steps:**

- [ ] Add/reuse a bounded error formatter that extracts own string `code` and `message` from `Error` and plain-object store failures, with `String()` only as the final fallback.
- [ ] Use it in the post-claim resume cleanup result.
- [ ] Inject a plain object `{ code: 'durable_write_error', message: 'post-rename sync failed' }` through the real strict running update.
- [ ] Assert the user-visible result contains the code/message, not `[object Object]`, and claim cleanup remains exactly one abandon/zero release.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts)`
- Expected: structured durable errors remain diagnostic and bounded.

### Task 4: Make Strict-Start Assertions Unit- and Signal-Exact

**Outcome:** Tests independently prove seed spawn, descriptor-child spawn, real RPC activation, event identity, live state, disk state, and exact error.

**Files:**

- Modify: `packages/pi-agents/tests/tool.test.ts`
- Modify: `packages/pi-agents/tests/run-coordinator.test.ts` if shared helpers belong there.

**Steps:**

- [ ] Count seed process spawn exactly once and reader-child process spawn exactly zero.
- [ ] Count RPC activation independently by observing prompt/activate transport behavior, not by incrementing inside the spawn branch.
- [ ] Require the intended strict fault hook to fire exactly once.
- [ ] Parse lifecycle events by exact second-unit ID and assert no `unit_started` for that unit, regardless of reader fields.
- [ ] Inspect coordinator live state and durable record directly; require the exact second unit remains `queued` with unchanged attempt and no reader flag.
- [ ] Assert the exact bounded error code/message returned to the caller.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts tests/run-coordinator.test.ts)`
- Expected: unrelated early failures cannot satisfy strict-start coverage.

### Task 5: Correlate Real Chain Invocations and Terminal Ref

**Outcome:** The Chain test proves the second child receives step 1's descriptor and final content corresponds to step 2's artifact ref.

**Files:**

- Modify: `packages/pi-agents/tests/tool.test.ts`
- Modify: `packages/pi-agents/tests/memory-regression.test.ts` if duplicate coverage remains.

**Steps:**

- [ ] Capture child tasks by spawn index/unit ID instead of collecting all matching parameters together.
- [ ] Assert exactly two child invocations.
- [ ] Extract step 1's committed `finalOutputRef` digest and require the second child's actual task to contain that digest/reader instruction and no step 1 sentinel.
- [ ] Make step 2 spill and extract its committed `finalOutputRef`.
- [ ] Require final tool content to contain metadata/digest prefix for step 2's ref specifically, not merely any artifact descriptor.
- [ ] Assert final content excludes step 1 digest as terminal authority where the descriptor format distinguishes it, excludes both sentinels and `(no output)`, and durable details contain exact refs.

**Validation:**

- Run: `(cd packages/pi-agents && bun test tests/tool.test.ts tests/memory-regression.test.ts)`
- Expected: handoff and terminal descriptors are correlated to the correct steps.

## Final Validation

- Run: `(cd packages/pi-agents && bun test tests/run-store.test.ts tests/run-coordinator.test.ts tests/tool.test.ts tests/memory-regression.test.ts)`
- Expected: all Round 8 regressions pass.

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

| Failure/crash point                   | Recovered authority                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| Before committed marker durability    | Previous `run.json`; strict update reports failure.                            |
| After committed marker durability     | New `run.json`; cleanup completes on next load.                                |
| Rollback fails                        | Recovery files preserved; bounded durable error; no live/event/launch success. |
| Transaction metadata malformed/unsafe | Fail closed without deleting evidence.                                         |
| Plain-object store error              | Bounded code/message, never `[object Object]`.                                 |

## Privacy and Security

- Transaction files are private, run-contained, regular files with validated fixed names and digests.
- Recovery never follows symlinks or accepts caller-supplied paths.
- Error messages omit private paths and run authority content.

## Open Questions

**Open Questions:** None.
