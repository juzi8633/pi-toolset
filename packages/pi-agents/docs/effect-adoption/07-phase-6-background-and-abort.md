# Phase 6: Background Manager and Abort Mapping

**Goal:** Bound background job concurrency/lifecycle with Effect-friendly structure where it helps, and document/implement a consistent abort→Effect mapping that does not break `AgentAbortError` or notification semantics.

**Inputs:** [00-overview.md](./00-overview.md), [01-phase-0-conventions.md](./01-phase-0-conventions.md); `packages/pi-agents/src/background.ts`; `packages/pi-agents/src/abort.ts`; `packages/pi-agents/src/effect-runtime.ts`; tests `background.test.ts`; abort usage in `tool.ts` / `execution.ts` / `chain.ts`.

**Assumptions:**

- Phase 0 complete; Phase 5 optional.
- `BackgroundManager` public API unchanged: `launch`, `cancelAll`, `activeCount`, `waitForIdle`.
- `DEFAULT_MAX_BACKGROUND_JOBS = 4` remains the default cap.
- `AgentAbortError`, `ABORT_MESSAGE`, `isAbortError`, `getAbortResult` remain the execution-wire abort types.
- Full tool/execution abort rewrite is **out of scope**; this phase focuses on background + shared mapping helpers.

**Architecture:** Keep background jobs as AbortController-backed tasks. Use Effect only for internal orchestration that is clearly better (e.g. `waitForIdle` composition, structured finalization). Add a small mapping helper in `effect-runtime.ts` or `abort.ts` that converts aborted signals / `AgentAbortError` into typed Effect failures without changing how `tool.ts` synthesizes `SingleResult` today.

**Tech Stack:** `effect`, existing background tests, AbortController.

---

## File Map

- Modify: `packages/pi-agents/src/background.ts` — optional Effect internals for job tracking / waitForIdle
- Modify: `packages/pi-agents/src/abort.ts` and/or `packages/pi-agents/src/effect-runtime.ts` — mapping helpers
- Test: `packages/pi-agents/tests/background.test.ts`
- Test: `packages/pi-agents/tests/effect-runtime.test.ts` — extend for abort mapping
- Do not rewrite: `packages/pi-agents/src/tool.ts` abort classification (unless a one-line helper swap is trivial and tests prove equivalence)

## Behavioral Invariants

1. `launch` rejects/returns error result when max jobs exceeded (same shape as today).
2. Background completion still notifies via `pi.sendMessage` with `BACKGROUND_MESSAGE_TYPE`.
3. `cancelAll` aborts controllers and emits cancellation notifications without double-emit (settled latch).
4. Durable background finalize flags (`cancelled` / `interrupted` / …) still invoked when durable context attached.
5. `waitForIdle` resolves when all jobs settle.
6. `isAbortError` remains true for `AgentAbortError` and message-equal fallback.

## Tasks

### Task 1: Abort mapping helper

**Outcome:** A single helper documents how Effect code should treat aborts.

**Files:**

- Modify: `packages/pi-agents/src/effect-runtime.ts` and/or `packages/pi-agents/src/abort.ts`
- Test: `packages/pi-agents/tests/effect-runtime.test.ts` (and abort coverage if added)

**Steps:**

- [x] Export a helper:
  - Canonical: `failIfAborted(signal: AbortSignal | undefined): Effect.Effect<void, AbortSignalAborted>`
  - Compat alias: `checkAbortSignal` (Phase 0 name; same function)
- [x] Define `AbortSignalAborted` as `Data.TaggedError` with optional `reason` (Phase 0).
- [ ] Document mapping table in code comment:

  | Source                   | Effect                                     | Downstream (existing)                |
  | ------------------------ | ------------------------------------------ | ------------------------------------ |
  | `signal.aborted` user    | fail `AbortSignalAborted`                  | `AgentAbortError` / cancelled result |
  | `AgentAbortError` thrown | catch → fail tagged or rethrow at boundary | preserve `result` + `origin`         |
  | defect                   | die                                        | unexpected                           |

- [ ] Do not change `AgentAbortError` constructor semantics.
- [ ] Unit test: aborted signal fails helper; non-aborted succeeds.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/effect-runtime.test.ts`
- Expected: Pass.

### Task 2: Background manager internal cleanup

**Outcome:** Background manager keeps behavior; uses clearer structured concurrency only where low risk.

**Files:**

- Modify: `packages/pi-agents/src/background.ts`
- Test: `packages/pi-agents/tests/background.test.ts`

**Steps:**

- [ ] Keep `jobs: Map<string, BackgroundJob>` model unless tests allow a cleaner structure.
- [ ] Acceptable Effect uses:
  - `waitForIdle` via `Effect.all` / `Promise` of job promises (either fine)
  - ensuring finalize/notify happens once (do not break settled latch)
- [ ] Avoid rewriting `launch` control flow entirely in one step; prefer surgical replacement of wait/join logic.
- [ ] Cap enforcement remains synchronous at launch time.
- [ ] No new public types.

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/background.test.ts`
- Expected: Pass (max jobs, cancelAll, notification, durable finalize if covered).

### Task 3: Smoke abort paths without tool rewrite

**Outcome:** Existing abort classification still works.

**Validation:**

- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.
- Run: `cd packages/pi-agents && bun test tests/background.test.ts tests/effect-runtime.test.ts`
- Expected: Pass.
- Optional: focused execution abort tests if present — Expected: Pass.

## Final Validation

- Run: `cd packages/pi-agents && bun test tests/background.test.ts tests/effect-runtime.test.ts`
- Expected: Pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.

## Failure Behavior

- Over-capacity launch → same error/result as today (do not throw a new Effect defect).
- Double notification on cancel+complete → forbidden; settled latch must hold.

## Privacy and Security

- Background notifications may include task summaries; no new log sinks.

## Rollout Notes

- Internal; README unchanged unless notification text accidentally changes (it must not).

## Risks and Mitigations

- Abort mis-map to `stopReason: 'error'` — do not plumb helper into `tool.ts` until mapping tests exist; keep phase scoped.
- Background race on cancel — rely on existing tests; add regression if a bug is found rather than weakening tests.

## Open Questions

- Whether later phases should replace `AgentAbortError` with Effect interrupt only — **default no**; keep dual representation at execution boundary indefinitely if needed.
