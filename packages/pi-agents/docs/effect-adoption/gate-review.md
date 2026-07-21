# Effect Adoption Gate Review (Phase 8 entry)

**Date:** 2026-07-21  
**Branch stack:** `feat/effect-phase-0` … `feat/effect-phase-7-chain-fanout` → this Phase 8 work  
**Package:** `@balaenis/pi-agents`

## Entry checklist

1. [x] Phases 0–7 landed on the Effect worktree branch stack (commits through `a79d554` fanout). Not yet force-merged to `origin/main` as a single PR series; treated as sequential phase commits for this monorepo workflow.
2. [x] No open flaky durable/resume failures attributed to Effect work observed during phase validation (session-lease, artifact-store, coordinator, chain, background oracles green).
3. [x] Chosen slices for this PR: **Slice A only** (`runSerial` queue).
4. [x] Explicit non-goals for this PR:
   - No full strict transaction rewrite
   - No interactive-agent migration
   - No `@effect/platform-node`
   - No on-disk layout / `RunStoreErrorCode` vocabulary change
   - No Slice C Schema validation
5. [x] Owner requested Phase 8 implementation and accepts `run-store.test.ts` validation cost for the approved slice(s).

## Slice decisions

| Slice                      | In this PR?  | Rationale                                                                                                                                                                                  |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A** `runSerial`          | **Yes**      | Same continue-after-failure Promise-tail contract as Phase 5 coordinator queue; local swap only; no tx body edits.                                                                         |
| **B** lock wait `Schedule` | **Deferred** | `acquireTxLock` / `withTxLock` are **synchronous** (`Atomics.wait`). Real `Schedule` + `Effect.sleep` would force async conversion of the lock stack — multi-day risk. **Do after the whole Effect program exits** (not mid-stack). Plan: [10-post-program-tx-lock-effect-wait.md](./10-post-program-tx-lock-effect-wait.md). |
| **C** Schema validation    | **No**       | Optional; keep for a later PR with message-pinned fixtures only.                                                                                                                           |

## Validation results (this PR)

| Command | Result |
| ------- | ------ |
| `bun test ./tests/run-store.test.ts` | **119 pass / 0 fail** |
| `mise run typecheck --package packages/pi-agents` | **pass** |
| `bun test ./tests/run-coordinator.test.ts` | **109 pass / 0 fail** |
| `hk fix` / `hk check` on touched paths | **clean** |

## Notes

- Phase 5 did **not** extract `serial-queue.ts`; Phase 8 inlines the same Effect + Promise-tail pattern next to `runSerial` (no new shared module unless duplication hurts later).
