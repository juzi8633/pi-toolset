# After Effect Program: Tx Lock Wait Migration (Behavior-Preserving)

**Goal:** Once the **overall Effect adoption program** for `@balaenis/pi-agents` is finished and stable, return to the deferred **transaction-lock wait** work: replace synchronous `Atomics.wait` contention sleeps with Effect-backed async wait — **without changing observable RunStore / durable / resume behavior**.

**Inputs:**

- Program overview: [00-overview.md](./00-overview.md)
- Phase 8 plan + deferred Slice B: [09-phase-8-run-store-partial.md](./09-phase-8-run-store-partial.md)
- Gate record: [gate-review.md](./gate-review.md)
- Implementation: `packages/pi-agents/src/run-store.ts` (`acquireTxLock`, `withTxLock`, `releaseTxLock`, `sleepMs`)
- Oracle: `packages/pi-agents/tests/run-store.test.ts` (and coordinator/resume smoke)

**Assumptions:**

- “整体阶段完成” means at least:
  1. Phases **0–7** landed and green.
  2. Phase **8 Slice A** (`runSerial` Effect queue) landed and green **or** explicitly closed as done for the program.
  3. Slice **C** (Schema) is either done, explicitly cancelled, or left as a separate non-blocking optional track — **this plan does not depend on C**.
  4. A short **program exit note** exists (extend `gate-review.md` or add `program-exit.md`) stating the Effect strangler for planned modules is complete and known leftovers are only this lock-wait item (and any listed non-goals).
- Full package tests were green at program exit (`mise run test --package packages/pi-agents` or the then-current CI equivalent).
- No concurrent large `run-store` tx rewrites while this plan runs.

**Architecture:** This is **not** “more Effect for its own sake.” It is a **behavior-preserving mechanical migration** of one subsystem:

| Layer                       | Sync/async | Role                                                                         |
| --------------------------- | ---------- | ---------------------------------------------------------------------------- |
| `tryAcquireTxLockOnce`      | **Sync**   | One attempt: path checks, rename publish, stale steal, fsync — **no sleep**  |
| Wait between attempts       | **Async**  | Effect `sleep` (optional `Schedule` for delay only) until monotonic deadline |
| Critical section under hold | **Sync**   | `fn(held)` + `releaseTxLock` — **no `await` while holding**                  |

Public wire behavior (`run_busy`, steal/ESRCH, corrupt paths, strict tx codes, on-disk layout) must match pre-change oracles.

**Tech Stack:** existing `effect@^3.22.0`, `effect-runtime` runners, Bun tests, Mise. No `@effect/platform-node`.

**When to start:** **Only after** the Effect program exit criteria above. Do not start mid-phase-stack or in parallel with unfinished Phase 7/8A review.

**Success definition:** Existing tests remain the authority. Green suite + unchanged error codes/messages pinned by tests = done. No user-visible feature change.

**Implementation note (landed):** Public `getRun` / `loadRunJson` must stay **sync**, so they keep `withTxLock` + `Atomics.wait`. Mutating paths use `withTxLockAsync` + Effect sleep. Shared `tryAcquireTxLockOnce` + sync hold via `finishWithTxLock`.

---

## Relationship to the Effect program

```
Phases 0–7  ──►  Phase 8 Slice A (runSerial)  ──►  [PROGRAM EXIT]
                                                      │
                                                      ▼
                         THIS PLAN (deferred hard leftover)
                         Tx lock wait: Atomics.wait → Effect async sleep
                                                      │
                                                      ▼
                         Optional later: Slice C Schema (separate, not required)
```

| Document         | Role                                             |
| ---------------- | ------------------------------------------------ |
| `00`–`09` + gate | Main Effect adoption                             |
| **This doc**     | **Post-program** leftover; behavior freeze first |
| Slice C          | Still optional; not in this plan                 |

---

## Why it waited until program end

1. **Risk concentration:** Lock wait sits on every durable write; flaking it mid-adoption confuses “Effect migration broke durable” vs “lock rewrite broke durable.”
2. **Sync → async API surface:** `withTxLock` / `acquireTxLock` are sync today; migration needs a quiet tree (call sites already async via `runSerial`).
3. **Oracle stability:** Program exit gives a known-green `run-store` + coordinator baseline to diff against.
4. **Scope honesty:** Main program already delivered conventions, leaves, lease, artifacts, worktree, coordinator queue, background abort, fanout, and `runSerial`. Lock wait was correctly deferred, not forgotten.

---

## File Map

- Modify: `packages/pi-agents/src/run-store.ts` — try-once extract; async acquire; async `withTxLock`; await call sites
- Test: `packages/pi-agents/tests/run-store.test.ts` — existing lock oracles are primary; add only gaps
- Modify: `packages/pi-agents/docs/effect-adoption/gate-review.md` or create `program-exit.md` — mark leftover started/done
- Modify: `packages/pi-agents/docs/effect-adoption/09-phase-8-run-store-partial.md` — check off Slice B when complete
- Do **not** modify strict-tx phase machine, claim protocol, or artifact path scheme

---

## Behavioral freeze (acceptance contract)

Treat the following as **regression blockers** (must match pre-change):

1. Live owner + exceeded `txLockWaitMs` → `run_busy` (existing message patterns).
2. Dead owner (ESRCH / start-identity rules) → steal/recover per current tests — not permanent busy.
3. Monotonic deadline: wall-clock rollback does not extend wait.
4. Foreign candidates / wrong-token tombstones preserved (no blind cleanup).
5. Strict tx error codes (`durable_write_error`, `durable_commit_uncertain`, `corrupt_run`, …) unchanged.
6. `runSerial` continue-after-failure still holds (Slice A invariant).
7. Coordinator / resume paths that write through the store still pass.
8. **Hold invariant:** no `await` between successful acquire and finished release.

Primary oracle: **full** `bun test ./tests/run-store.test.ts`.  
Secondary: `bun test ./tests/run-coordinator.test.ts` (and `resume.test.ts` if lock timing is implicated).

---

## Out of Scope

- Re-opening Phases 0–7 design
- Full Effect rewrite of strict transaction body
- Slice C Schema
- Making `getRun` / sync inspect APIs async
- “Improving” lock fairness, adding timeouts beyond current knobs, or changing steal policy
- Fake Effect wrapping of `Atomics.wait` (no behavior/async benefit)

---

## Tasks

### Task 0: Program-exit gate (do not code lock changes until green)

**Outcome:** Written confirmation that the Effect program is closed enough to touch the lock.

**Files:**

- Create or modify: `packages/pi-agents/docs/effect-adoption/program-exit.md` (or a section in `gate-review.md`)

**Steps:**

- [ ] Checklist:

  | #   | Criterion                                                             | Evidence                |
  | --- | --------------------------------------------------------------------- | ----------------------- |
  | 1   | Phases 0–7 + 8A on branch/main as intended                            | git log / PR links      |
  | 2   | `mise run test --package packages/pi-agents` green (or documented CI) | command output          |
  | 3   | No open durable flakiness attributed to Effect                        | note / issue list empty |
  | 4   | Leftovers listed: this lock-wait plan only (plus optional C)          | this doc linked         |
  | 5   | Owner approves starting post-program lock work                        | explicit                |

- [ ] Record baseline: `run-store.test.ts` pass count and git SHA.

**Validation:**

- Run: `mise run test --package packages/pi-agents`
- Expected: Pass on baseline SHA.
- If any box fails → **stop**; do not start Task 1.

---

### Task 1: Baseline branch + characterization (no production logic change)

**Outcome:** Isolated branch; known-green baseline; optional note of lock-related test names.

**Files:** none required (process)

**Steps:**

- [ ] Branch: `feat/effect-post-program-tx-lock-wait` from program-exit SHA (worktree under `./.worktrees` if multi-file).
- [ ] List lock-related tests (for focused iteration):

  ```bash
  cd packages/pi-agents && rg -n "run_busy|txLockWaitMs|stale|steal|lock timeout|round-1[0-3]" tests/run-store.test.ts
  ```

- [ ] Save baseline command results in the PR description or program-exit note.

**Validation:**

- Run: `cd packages/pi-agents && bun test ./tests/run-store.test.ts`
- Expected: Pass (same count as program exit).

---

### Task 2: Mechanical extract — `tryAcquireTxLockOnce` (behavior unchanged)

**Outcome:** One loop iteration is a sync function; acquire still uses `sleepMs` so semantics are identical.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`

**Steps:**

- [ ] Define local outcome union:

  ```ts
  type TxLockAttempt =
    | { kind: 'acquired'; held: HeldTxLock }
    | { kind: 'retry' }
    | { kind: 'fail'; error: RunStoreError };
  ```

- [ ] Move current `for (;;)` body **except** deadline + `sleepMs` into `tryAcquireTxLockOnce(...)`.
- [ ] Keep `acquireTxLock` **sync** for this task only:

  ```ts
  for (;;) {
    const attempt = tryAcquireTxLockOnce(...);
    if (attempt.kind === 'acquired') return attempt.held;
    if (attempt.kind === 'fail') throw attempt.error;
    if (monotonicNowMs() >= deadline) throw run_busy;
    sleepMs(Math.min(txLockRetryMs, Math.max(1, deadline - monotonicNowMs())));
  }
  ```

- [ ] No steal/rename/fsync reordering.

**Validation:**

- Run: `cd packages/pi-agents && bun test ./tests/run-store.test.ts`
- Expected: Full pass (pure refactor).
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.

---

### Task 3: Async wait — Effect sleep replaces `Atomics.wait` on the wait path

**Outcome:** Contention wait is async; **hold path still sync after acquire returns.**

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`

**Steps:**

- [ ] `async function acquireTxLock(runId: string): Promise<HeldTxLock>`
- [ ] Replace `sleepMs(...)` with Effect-backed delay, e.g.:

  ```ts
  const now = monotonicNowMs();
  if (now >= deadline) throw run_busy;
  const delayMs = Math.min(txLockRetryMs, Math.max(1, deadline - now));
  await runEffectPromise(Effect.sleep(`${delayMs} millis`));
  ```

  - Prefer a tiny `sleepLockRetry(delayMs)` helper for readability.
  - Sleep Effect must not fail under normal use; if using other Effects that can fail, use `runEffectExit` + rethrow-as-is (never wrap plain `{code,message}` via `runEffectPromise` failure path).

- [ ] Optional: express the **delay only** with `Schedule` if equivalent; do **not** wrap try/steal in `Effect.retry` until outcomes are proven exhaustive under full suite.
- [ ] Remove or stop using `sleepMs` for lock wait; delete if unused.

**Validation:**

- Run: lock/busy/stale-focused tests, then full `run-store.test.ts`
- Expected: Pass; bounded wait test still holds.
- Run 2–3 full-file repeats if any lock flake history appears.

---

### Task 4: `withTxLock` async + call-site `await` (still no await under hold)

**Outcome:** Typecheck-clean async wrapper; critical section remains `(held) => T` sync.

**Files:**

- Modify: `packages/pi-agents/src/run-store.ts`

**Steps:**

- [ ] `async function withTxLock<T>(runId: string, fn: (held: HeldTxLock) => T): Promise<T>`
- [ ] Body: `await acquireTxLock` → sync `fn(held)` → sync `releaseTxLock` (same error combination rules as today).
- [ ] `await withTxLock` at every call site (`rg -n "withTxLock\\(|acquireTxLock\\(" src/run-store.ts`).
- [ ] Make intermediate helpers (`writeRunContents`, etc.) `async` only as needed; public Promise APIs already async.
- [ ] **Hard rule:** `fn` must not be `async` and must not return a Promise that is awaited while the lock is held.

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.
- Run: `cd packages/pi-agents && bun test ./tests/run-store.test.ts`
- Expected: Pass.

---

### Task 5: Behavior regression pack + cross-suite smoke

**Outcome:** Explicit proof that original functionality is intact.

**Files:**

- Test: `packages/pi-agents/tests/run-store.test.ts` (add only if a gap is real)
- Docs: program-exit / gate-review / Phase 8 Slice B checkboxes

**Steps:**

- [ ] Confirm existing coverage still hits:
  - live second store → `run_busy`
  - bounded `txLockWaitMs`
  - monotonic deadline
  - stale steal / release intent / hard-link rounds
  - directory-sync / fsync failure paths through locked writes
- [ ] Add only if missing: after B gets `run_busy`, A can still complete a later write (no wedge).
- [ ] Smoke:

  ```bash
  cd packages/pi-agents && bun test ./tests/run-coordinator.test.ts
  # if durable resume uses store locks under contention:
  bun test ./tests/resume.test.ts
  ```

- [ ] Update docs: Slice B done; leftover cleared on program-exit note.

**Validation:**

- Run: `cd packages/pi-agents && bun test ./tests/run-store.test.ts ./tests/run-coordinator.test.ts`
- Expected: Pass.
- Run: `mise run test --package packages/pi-agents`
- Expected: Pass (merge gate).
- Run: `hk check` on touched paths
- Expected: Clean.

---

## Final Validation (merge criteria)

All must pass on the PR branch:

| Check                                             | Expected                                                                  | Status                    |
| ------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------- |
| `bun test ./tests/run-store.test.ts`              | Full pass                                                                 | **119 pass**              |
| `bun test ./tests/run-coordinator.test.ts`        | Full pass                                                                 | **109 pass**              |
| `mise run typecheck --package packages/pi-agents` | Pass                                                                      | **pass**                  |
| `mise run test --package packages/pi-agents`      | Pass                                                                      | optional pre-merge        |
| Diff review                                       | No strict-tx state machine rewrite; no layout change; no await under hold | dual-path hold stays sync |

**Ship rule:** If any pre-existing oracle fails and the fix would change steal/`run_busy` semantics, **revert** the wait migration rather than “fix” durable behavior in the same PR.

---

## Failure Behavior

| Condition                               | Expected (unchanged)                               |
| --------------------------------------- | -------------------------------------------------- |
| Live owner, wait exceeded               | `run_busy`                                         |
| Unsafe lock path                        | `corrupt_run` / fail closed, no retry              |
| Steal success                           | Single owner; tests for maxActive / transfer       |
| Release failure after successful mutate | Combined error rules as today                      |
| Effect sleep defect                     | Must not become silent success or wrong `run_busy` |

---

## Privacy and Security

- Runs-root containment, fsync requirements, and foreign-entry preservation unchanged.
- No new logging of payloads or lock tokens.

---

## Rollout Notes

- Single-purpose PR after program exit (or two PRs: Task 2 extract-only, then Tasks 3–5).
- No on-disk version bump; no README unless user-facing behavior changes (it must not).
- Communicate in PR body: “Post–Effect-program leftover; behavior oracle = existing run-store suite.”

---

## Risks and Mitigations

| Risk                                   | Mitigation                                                             |
| -------------------------------------- | ---------------------------------------------------------------------- |
| Durable flake blamed on Effect program | Start only after program exit; isolate branch; full suite baseline SHA |
| Await under hold                       | Type `fn` as sync `T`; review checklist; ban async critical sections   |
| Deadline drift after async sleep       | Always recompute with `monotonicNowMs()`; existing bounded-wait tests  |
| Error wrapping breaks `toMatchObject`  | Same Phase 5/8A rule: rethrow failures as-is for store errors          |
| Reviewer fatigue on 6k-line file       | Task 2 mechanical first; small async surface in Tasks 3–4              |

---

## Open Questions

- Exact program-exit artifact name (`program-exit.md` vs gate-review section) — either is fine if checklist is complete.
- Whether `Duration.millis` vs `` `${n} millis` `` string form for Effect 3.22 — verify against installed `effect` at implement time.
- Slice C remains a separate product decision; not required for “Effect program complete.”

---

## One-line summary

**After the Effect adoption program is done and green, migrate only the lock contention sleep from `Atomics.wait` to Effect async wait, with sync try-once + sync hold, and prove no behavior change via the full run-store (and smoke) oracles.**
