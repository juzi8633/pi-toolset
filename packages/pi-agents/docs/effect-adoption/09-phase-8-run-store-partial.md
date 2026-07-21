# Phase 8: RunStore Partial Adoption (Gated)

**Goal:** After Phases 0–7 prove value, optionally apply Effect to **three narrow slices** of `run-store`: (1) serial `runSerial` queue, (2) transaction lock wait `Schedule`, (3) optional Schema-assisted validation for selected durable records — without rewriting the strict transaction state machine.

**Inputs:** [00-overview.md](./00-overview.md); gate review outcome; `packages/pi-agents/src/run-store.ts`; `packages/pi-agents/tests/run-store.test.ts`; Phase 5 `serial-queue` if extracted.

**Assumptions:**

- **Entry gate passed** (see below). If not, this phase is idle.
- Strict run.json transaction phases, crash hooks (`STRICT_TX_BYPASS_CLEANUP`, `strictTransactionHook`), hard-link publication, and claim directory protocol remain authoritative as implemented.
- On-disk layout and `RunStoreErrorCode` vocabulary unchanged.
- `RunStore` public interface stays Promise/sync hybrid as today (`getRun` sync Result; mutating methods async).

**Architecture:** Strangler inside `createRunStore` only:

1. Reuse Phase 5 serial queue for `runSerial`.
2. Replace lock sleep/retry loops with `Schedule` + timeout while preserving `run_busy` / steal / ESRCH semantics.
3. Optionally replace subsets of hand-written `validate*` with `effect/Schema` **only where tests already pin corrupt_run messages/codes** — do not chase perfect schema coverage in one PR.

**Tech Stack:** `effect` (`Schedule`, `Effect`, optional `Schema`), existing run-store test seams (`fileFsync`, `directorySync`, `pidAliveKill`, `txLockWaitMs`, `txLockRetryMs`).

---

## Entry Gate (mandatory)

Write `packages/pi-agents/docs/effect-adoption/gate-review.md` (or PR description section) confirming:

1. [ ] Phases 0–7 merged; `mise run test --package packages/pi-agents` green.
2. [ ] No open flaky durable/resume failures attributed to Effect work.
3. [ ] Chosen slices listed (subset of the three below).
4. [ ] Explicit non-goals: no full tx rewrite; no interactive-agent migration.
5. [ ] Owner accepts multi-day validation cost of `run-store.test.ts` (~5k lines).

If any box fails → **do not start coding**.

## File Map

- Modify: `packages/pi-agents/src/run-store.ts` — only targeted helpers/queues/validation
- Optional reuse: `packages/pi-agents/src/serial-queue.ts` from Phase 5
- Optional create: `packages/pi-agents/src/run-store-schema.ts` — Effect Schema definitions for selected structures
- Test: `packages/pi-agents/tests/run-store.test.ts` — oracle; add regressions per slice
- Create: `packages/pi-agents/docs/effect-adoption/gate-review.md` — gate record

## Non-Goals (hard)

- Rewriting strict transaction phase machine / rollback markers
- Changing claim ticket width, owner.json schema, events.jsonl format
- Replacing all validate* functions in one pass
- Async-ifying currently sync `getRun` / `inspectClaims` unless required (prefer not)
- Introducing `@effect/platform-node`

## Slice A — `runSerial` queue

**Outcome:** Per-runId serial execution matches today’s continue-after-failure behavior.

**Steps:**

- [x] Replace `runSerial` body with Effect.tryPromise + runEffectExit task runner; keep `queues` Promise tail (Phase 5-equivalent; no extracted serial-queue module).
- [x] Keep `assertValidRunId` before enqueue.
- [x] Add/confirm test: task B runs after task A throws for same runId (`continues the per-run serial queue after a rejected task`).

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store.test.ts`
- Expected: Pass (or focused serial/lock tests during iteration, full file before merge).

## Slice B — Lock wait with `Schedule`

**Outcome:** `txLockWaitMs` / `txLockRetryMs` behavior preserved with Schedule-based retry.

**Status:** Deferred until the **overall Effect adoption program** is complete (not mid-phase). **Post-program plan (behavior-preserving):** [10-post-program-tx-lock-effect-wait.md](./10-post-program-tx-lock-effect-wait.md).

**Steps:** (execute via `10-post-gate-lock-schedule.md`, not this PR)

- [ ] Locate lock acquire retry/sleep loop.
- [ ] Split try-once (sync) vs wait loop (async Effect sleep / Schedule).
- [ ] Preserve:
  - live owner → wait/retry
  - dead owner detection via `isPidAlive` / `pidAliveKill` seam (ESRCH only = dead)
  - `run_busy` when wait exceeded
  - no lock-age steal on non-Linux beyond current rules
  - **no `await` while holding the lock**
- [ ] Keep injectable timing options and tests that use short waits.

**Validation:**

- Run focused lock/claim tests inside `run-store.test.ts` then full suite.
- Expected: Pass; no new flakes under default timings.

## Slice C — Optional Schema validation (narrow)

**Outcome:** One or two high-churn validators move to `effect/Schema` without message regressions.

**Steps:**

- [ ] Pick a closed structure with strong tests, e.g. `RunArtifactRefV1` shape or claim owner.json fields — **not** the entire `AgentRunRecordV1` in the first PR.
- [ ] Implement Schema; adapt failures to `corrupt_run` / existing codes with messages that satisfy tests (update tests only when messages were underspecified and behavior is identical).
- [ ] Keep fail-closed load behavior.

**Validation:**

- Run corrupt/invalid fixture tests in `run-store.test.ts`.
- Expected: Pass.

## Tasks (execution order when gate open)

### Task 1: Gate review document

**Outcome:** `gate-review.md` committed or attached; slices selected.

**Files:**

- Create: `packages/pi-agents/docs/effect-adoption/gate-review.md`

**Steps:**

- [x] Fill checklist from Entry Gate.
- [x] State which of A/B/C are in scope for the first Phase 8 PR (**A only**; B deferred — sync lock; C separate).

**Validation:**

- Review sign-off (human).

### Task 2: Implement approved slices

**Outcome:** Code + tests for each approved slice.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`
- Optional: `packages/pi-agents/src/run-store-schema.ts`, `packages/pi-agents/src/serial-queue.ts`
- Test: `packages/pi-agents/tests/run-store.test.ts`

**Steps:**

- [x] One slice per commit/PR when possible (A this PR; B/C deferred).
- [x] After Slice A: full `run-store.test.ts` green (119 pass including continue-after-failure).
- [x] No drive-by refactors in strict tx paths (diff is imports + `runSerial` only).

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-store.test.ts`
- Expected: Pass. **Done: 119 pass.**
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass. **Done.**

### Task 3: Cross-suite durable smoke

**Outcome:** Coordinator/resume still green with store queue/lock changes.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/run-coordinator.test.ts tests/resume.test.ts`
- Expected: Pass.
- Run: `mise run test --package packages/pi-agents`
- Expected: Pass.

## Final Validation

- Run: `mise run test --package packages/pi-agents`
- Expected: Pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.
- Run: `hk check`
- Expected: Clean.

## Failure Behavior

- Lock timeout → `run_busy` (not hang forever).
- Corrupt record → `corrupt_run` (fail closed).
- Strict tx IO failure codes (`durable_write_error`, `durable_commit_uncertain`) unchanged.

## Privacy and Security

- Runs root trust model unchanged; no weakening of path containment or fsync requirements.

## Rollout Notes

- No migration tool; no layout version bump if schemas only validate existing v1.
- Document in gate-review if any error message strings changed intentionally.

## Risks and Mitigations

| Risk                                    | Mitigation                                                        |
| --------------------------------------- | ----------------------------------------------------------------- |
| Hidden tx interaction with queue change | Slice A only swaps serial plumbing; no tx body edits              |
| Schedule off-by-one busy timeouts       | Use existing short-wait tests; add explicit boundary test         |
| Schema message churn breaks tests       | Prefer structural code equality; update messages only with review |
| Reviewer fatigue on 6k LOC file         | Slice PRs; forbid unrelated diffs                                 |

## Open Questions

- Full `AgentRunRecordV1` Schema coverage timeline — not decided here; only narrow C slice.
- Whether Phase 8 is the last Effect phase — default yes until a new overview revision.
