# Effect Adoption Program Exit

**Date:** 2026-07-21  
**Package:** `@balaenis/pi-agents`  
**Baseline code SHA:** `bf22a7d` (Phase 8A + post-program lock plan docs)  
**Exit record SHA:** `e14d2db` (this document)  
**Exit branch:** `feat/effect-program-exit`

## Exit checklist

| #   | Criterion                                      | Status                          | Evidence                                                                                                                                    |
| --- | ---------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Phases 0–7 landed                              | **Yes**                         | Commits through fanout (`a79d554`)                                                                                                          |
| 2   | Phase 8 Slice A (`runSerial`) landed           | **Yes**                         | `bf22a7d`                                                                                                                                   |
| 3   | Phase 8 Slice B (lock wait)                    | **Done post-exit**              | [10-post-program-tx-lock-effect-wait.md](./10-post-program-tx-lock-effect-wait.md) — write-path Effect sleep; sync getRun recovery retained |
| 4   | Phase 8 Slice C (Schema)                       | **Out of program**              | Optional; not required for exit                                                                                                             |
| 5   | No open durable flakiness attributed to Effect | **Yes** (as of exit validation) | Full package suite green                                                                                                                    |
| 6   | Leftovers listed                               | **Yes**                         | Lock wait post-program plan only (+ optional Schema)                                                                                        |

## What the program delivered

| Phase | Deliverable                                      |
| ----- | ------------------------------------------------ |
| 0     | `effect-runtime` + conventions                   |
| 1     | `template` / `completion-check` Either           |
| 2     | `session-lease` Deferred                         |
| 3     | `artifact-store` Effect IO boundary              |
| 4     | `worktree` Either                                |
| 5     | coordinator durable write queue Effect tasks     |
| 6     | abort mapping + `waitForIdle` Effect             |
| 7     | chain fanout cancel-safe Effect worker bodies    |
| 8A    | `runSerial` Effect task + continue-after-failure |

## Explicit non-goals (still)

- Full strict-tx rewrite
- interactive-agent / TUI Effect migration
- TypeBox → Effect Schema for tools
- `@effect/platform-node`
- On-disk layout / wire error code vocabulary changes
- Fake Effect wrappers that do not change scheduling (e.g. `Atomics.wait` inside `Effect.sync`)

## Validation at exit

| Command                                                                                                                                                               | Result                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `mise run typecheck --package packages/pi-agents`                                                                                                                     | **pass**                          |
| Effect-touched focused suites (10 files: runtime, template, completion-check, session-lease, artifact-store, worktree, background, chain, run-coordinator, run-store) | **359 pass / 0 fail**             |
| `mise run test --package packages/pi-agents`                                                                                                                          | **1378 pass / 0 fail** (53 files) |

## After exit

1. Do **not** start [10-post-program-tx-lock-effect-wait.md](./10-post-program-tx-lock-effect-wait.md) until this checklist is accepted.
2. Optional Slice C remains a separate product decision.
3. Further Effect use in new modules should follow Phase 0 conventions without reopening durable cores without cause.
