# Effect Adoption Overview

**Goal:** Adopt Effect as an internal standard library for error channels, serial queues, resource scopes, retry/schedule, and bounded concurrency — without rewriting durable core or TUI surfaces.

**Inputs:** Package analysis of `packages/pi-agents` (2026-07-21): `effect@^3.22.0` is declared in `package.json` but unused; ad-hoc Result unions, Promise tail queues, AbortSignal, and dispose/lease cleanup already encode Effect-like semantics; ~38k LOC source / ~60k LOC tests.

**Assumptions:**

- Public APIs that Pi hosts and existing tests call remain Promise- or sync-shaped; Effect stays behind module boundaries until adjacent callers are ready.
- Only the `effect` package is used through Phase 7. No `@effect/platform-node`, `@effect/schema` package split, or Layer-heavy DI until Phase 8 re-evaluates.
- Tool parameter schemas stay on TypeBox (`schema.ts`); Effect Schema is optional and only for durable JSON validation in Phase 8.
- Work proceeds on dedicated `feat/effect-*` branches (or worktrees under `./.worktrees`); no big-bang PR.
- `effect` dependency may already be present uncommitted; Phase 0 commits/normalizes it.

**Architecture:** Strangler-fig adoption from pure leaves upward. Phase 0 freezes conventions (error tags, boundary runners, import style). Phases 1–4 convert leaf modules with stable external APIs. Phases 5–7 replace hand-rolled concurrency/lifecycle primitives while keeping Promise façades. Phase 8 is **gated**: only if Phases 0–7 reduce boilerplate and do not increase durable flakiness. TUI, TypeBox tool schemas, and full `run-store` / `interactive-agent` rewrites stay out of scope.

**Tech Stack:** TypeScript, Bun, `effect@^3.22.0`, existing `bun:test` suites, Mise (`mise run typecheck|test|build --package packages/pi-agents`), `hk check` / `hk fix`.

---

## Principles

1. **Boundary Promise, kernel Effect** — exports used by Pi, `tool.ts`, and tests keep current signatures; internal implementations may return `Effect`.
2. **No behavior change without a test** — each phase must keep existing tests green before adding Effect-specific coverage.
3. **One module family per PR** — do not mix leaf conversion with durable transaction edits.
4. **Tagged failures, not string matching** — prefer `Data.TaggedError` / domain error codes over `message.includes(...)`.
5. **Interrupt ≠ failure** — user/session abort maps to interruption or existing `AgentAbortError`; do not fold aborts into generic `error` stopReason.
6. **Stop rule** — if a phase raises durable/resume flakiness or forces large test rewrites, freeze deeper phases and document the blocker.

## Phase Map

| Phase | Doc                                                                        | Scope                                                         | Depends on         | Exit gate                                                             |
| ----- | -------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------- |
| 0     | [01-phase-0-conventions.md](./01-phase-0-conventions.md)                   | Dep + conventions + `effect-runtime` bridge                   | —                  | Typecheck; conventions doc merged; runtime helpers tested             |
| 1     | [02-phase-1-pure-leaves.md](./02-phase-1-pure-leaves.md)                   | `template.ts`, `completion-check.ts`                          | 0                  | Existing leaf tests green; Either/Effect style established            |
| 2     | [03-phase-2-session-lease.md](./03-phase-2-session-lease.md)               | `session-lease.ts` acquire/release internals                  | 0                  | `session-lease.test.ts` green; sticky fail + serial acquire preserved |
| 3     | [04-phase-3-artifact-store.md](./04-phase-3-artifact-store.md)             | `artifact-store.ts` IO + errors                               | 0                  | `artifact-store.test.ts` green; error codes unchanged                 |
| 4     | [05-phase-4-worktree.md](./05-phase-4-worktree.md)                         | `worktree.ts` Result paths                                    | 0–1                | `worktree.test.ts` green; create/open/remove semantics unchanged      |
| 5     | [06-phase-5-coordinator-queue.md](./06-phase-5-coordinator-queue.md)       | `run-coordinator` durable write queue                         | 0, 2–3 recommended | `run-coordinator.test.ts` green; persist coalesce semantics unchanged |
| 6     | [07-phase-6-background-and-abort.md](./07-phase-6-background-and-abort.md) | `background.ts` job limit; abort mapping notes                | 0, 5 optional      | `background.test.ts` green; cancelAll/notify semantics unchanged      |
| 7     | [08-phase-7-chain-fanout.md](./08-phase-7-chain-fanout.md)                 | Fanout concurrency scheduler only                             | 0–1, 5 optional    | `chain.test.ts` green; restore/skip/abort fanout unchanged            |
| 8     | [09-phase-8-run-store-partial.md](./09-phase-8-run-store-partial.md)       | Gated: Schema validation, lock Schedule, internal `runSerial` | 0–7 + gate review  | Optional; only after written gate review passes                       |

## Recommended Sequence (calendar sketch)

Not a commitment — order is fixed; duration is guidance.

```
Phase 0  conventions + bridge          ~0.5–1 day
Phase 1  pure leaves                   ~0.5 day
Phase 2  session-lease                 ~1 day
Phase 3  artifact-store                ~1–2 days
Phase 4  worktree                      ~0.5–1 day
Phase 5  coordinator queue             ~1–2 days
Phase 6  background + abort mapping    ~1 day
Phase 7  chain fanout scheduler        ~1–2 days
--- gate review ---
Phase 8  run-store partial (optional)  ~3–5 days if approved
```

## Out of Scope (all phases)

- Full rewrite of `run-store.ts` strict transaction state machine
- Full rewrite of `interactive-agent.ts`, `interactive-view.ts`, `render.ts`, `agent-config-ui.ts`
- Replacing TypeBox in `schema.ts` / Pi `registerTool` parameters
- Replacing custom structured-output subset validator with Effect Schema (unless Phase 8 explicitly expands)
- Introducing mock-only Effect modes or fake durable paths
- Changing durable on-disk layout, claim protocol, artifact path scheme, or run status vocabulary
- Changing public tool result shapes (`SingleResult`, `SubagentDetails`, `RunStoreError` codes)

## Cross-Cutting File Map (new shared assets)

| Path                                                                | Owner phase | Responsibility                                                      |
| ------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| `packages/pi-agents/docs/effect-adoption/00-overview.md`            | 0           | This roadmap                                                        |
| `packages/pi-agents/docs/effect-adoption/01-phase-0-conventions.md` | 0           | Conventions plan                                                    |
| `packages/pi-agents/src/effect-runtime.ts`                          | 0           | Boundary runners, abort/interrupt helpers                           |
| `packages/pi-agents/tests/effect-runtime.test.ts`                   | 0           | Runner unit tests                                                   |
| `packages/pi-agents/package.json`                                   | 0           | Ensure `effect` dependency is intentional and version-pinned policy |

Per-phase file maps live in each phase plan.

## Global Validation Commands

Use from monorepo root unless a phase plan scopes narrower.

```sh
# Focused (prefer during a phase)
cd packages/pi-agents && bun test tests/<suite>.test.ts

# Package typecheck / tests
mise run typecheck --package packages/pi-agents
mise run test --package packages/pi-agents

# Lint/format after substantive edits
hk fix
hk check
```

**Global success criteria after Phase 7:**

- At least four production modules use Effect internally (`effect-runtime`, `session-lease`, `artifact-store`, plus one of coordinator/chain/background).
- Hand-rolled Promise tail queues remain only where not yet migrated (document leftovers).
- No public API signature breaks; existing suites for touched modules pass.
- README notes Effect as an internal dependency only if user-facing behavior changed (normally no README change).

**Phase 8 entry gate (must write a short review note in the Phase 8 PR or a sibling `gate-review.md`):**

1. Phases 0–7 merged and green on CI / local full package tests.
2. No open durable flakiness attributed to Effect adoption.
3. Clear target slices listed (validation and/or lock wait and/or `runSerial` only).
4. Explicit non-goals restated (no strict-tx rewrite).

## Error Model (summary)

Full detail in Phase 0. Short form:

| Kind          | Use for                                                            | Surface                                                                           |
| ------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| **Failure**   | Expected domain errors (`run_busy`, `artifact_missing`, …)         | Typed tag / existing `code` field                                                 |
| **Interrupt** | User abort, session shutdown, owner missing when modeled as cancel | `AgentAbortError` / lifecycle origin; Effect interruption at boundaries           |
| **Defect**    | Invariant violations / programmer errors                           | throw / `Effect.die`; should not become soft `stopReason: 'error'` without review |

Existing string codes (`RunStoreErrorCode`, `ArtifactStoreError['code']`, interactive/ACP codes) stay the **wire vocabulary**. Effect tags wrap them; they do not invent parallel user-visible codes.

## Dependency Policy

- Runtime dependency: `effect` only (already `^3.22.0`).
- Prefer named imports from `effect` (`Effect`, `Exit`, `Cause`, `Data`, `Schedule`, `Scope`, `Deferred`, `Fiber`, …) for tree-shaking clarity.
- Do not add Effect ecosystem packages before Phase 8 gate review.
- Do not replace Node `fs` sync seams used by crash-injection tests unless the phase plan says so.

## Risks and Mitigations

| Risk                                       | Mitigation                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| Dual-stack readability cost                | Thin Promise façades; Effect only inside module bodies; conventions doc |
| Accidental behavior drift on durable paths | Phase order; existing tests as oracle; Phase 8 gated                    |
| Abort misclassified as failure             | Phase 0 mapping + Phase 6 explicit abort work                           |
| Large PR / review fatigue                  | One phase doc = one PR series                                           |
| Test rewrite explosion                     | Keep external APIs stable; avoid rewriting 5k+ test files               |

## Open Questions

- Whether Phase 8 should adopt `effect/Schema` for `run.json` validation only, or leave hand-written validators indefinitely — decide at gate review.
- Whether a future phase may introduce `@effect/platform-node` FileSystem — default **no** until sync test seams are redesigned.

## After the program (deferred leftovers)

When Phases 0–8A (and any accepted optional slices) are done and the package suite is green, remaining Effect-adjacent work is **not** part of the main strangler timeline:

| Leftover | Doc | Rule |
| -------- | --- | ---- |
| Tx lock wait (`Atomics.wait` → Effect async sleep) | [10-post-program-tx-lock-effect-wait.md](./10-post-program-tx-lock-effect-wait.md) | Start only after program exit; existing tests are the behavior freeze |
| Slice C Schema (optional) | [09-phase-8-run-store-partial.md](./09-phase-8-run-store-partial.md) | Separate decision; not required for program complete |

## How to Execute a Phase

1. Read this overview + the phase plan end-to-end.
2. Create branch `feat/effect-phase-N-short-name` (worktree under `./.worktrees` for multi-file work).
3. Implement tasks in order; run each task’s validation before the next.
4. Run the phase Final Validation.
5. Do not start the next phase until the current exit gate is met.
6. Commit only when asked (or via commit sub-agent when requested).
