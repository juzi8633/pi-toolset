# Phase 0: Effect Conventions and Runtime Bridge

**Goal:** Commit the `effect` dependency intentionally, document project conventions, and ship a tiny `effect-runtime` boundary helper used by later phases.

**Inputs:** [00-overview.md](./00-overview.md); current `packages/pi-agents/package.json` (`effect` may already be listed); zero `effect` imports under `src/`.

**Assumptions:**

- Convention text lives under `docs/effect-adoption/` (this file + overview); no separate ADRs required.
- `effect-runtime.ts` is the only new production module in this phase.
- No production call sites migrate yet beyond what the runtime unit tests exercise.

**Architecture:** Introduce a leaf module that standardizes `Effect.runPromise` / `runPromiseExit` usage, maps `AbortSignal` aborts to interruption-friendly failures, and documents tagged-error rules. Later phases import these helpers instead of calling `Effect.runPromise` ad hoc.

**Tech Stack:** `effect@^3.22.0`, TypeScript, `bun:test`, Mise.

---

## File Map

- Modify: `packages/pi-agents/package.json` — ensure `dependencies.effect` is present and intentional (`^3.22.0` or the repo’s chosen range); no other Effect packages
- Create: `packages/pi-agents/src/effect-runtime.ts` — boundary runners and abort helpers
- Create: `packages/pi-agents/tests/effect-runtime.test.ts` — unit coverage for runners
- Modify: `packages/pi-agents/docs/effect-adoption/00-overview.md` — only if phase discovers a convention conflict (prefer not)

## Locked Conventions

### Imports

```ts
import * as Cause from 'effect/Cause';
import * as Data from 'effect/Data';
import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Schedule from 'effect/Schedule';
import * as Scope from 'effect/Scope';
```

- Prefer public subpath namespace imports (e.g. `effect/Effect`) over the root barrel `'effect'`.
- Measured startup cost for the currently used API set: root barrel pulls ~600 translated ESM modules; the matching subpaths pull ~151.
- Keep namespace-style call sites (`Effect.runPromiseExit`, `Either.left`, `Duration.millis`) so import rewrites stay mechanical.

### Boundary rules

1. **Public module APIs** that today return `Promise<T>` or sync `T` keep that shape.
2. Internal helpers may return `Effect.Effect<A, E, R>` with `R = never` unless a phase explicitly introduces services.
3. Crossing back to Promise uses runners from `effect-runtime.ts` (not raw `Effect.runPromise` scattered everywhere).

   | Helper                  | Non-Error typed failure | Use when                                                                |
   | ----------------------- | ----------------------- | ----------------------------------------------------------------------- |
   | `runEffectPromise`      | wrap in `Error`         | domain Effects whose public Promise API should only reject with `Error` |
   | `runEffectThrowingAsIs` | rethrow as-is           | store/coordinator/fanout where plain `{ code, message }` must survive   |
   | `runEffectExit`         | never throws for typed  | callers that branch on Exit                                             |
   - `tryPromiseUnknown(work)` wraps a Promise factory as `Effect.Effect<A, unknown>` without remapping the catch cause.
   - `createKeyedSerialExecutor` is the standard continue-after-failure queue for durable write paths; do not re-inline `prev.then(run, run)` for new durable serial work.

4. Sync pure functions may return `Either` without going through the runtime.

### Error tags

- Domain errors that already have a `code: string` field **keep that code** as the wire value.
- Effect representation: `Data.TaggedError` (or class extending it) with:
  - `_tag`: stable PascalCase name (e.g. `ArtifactStoreFailure`)
  - `code`: existing wire code union member
  - `message`: human-readable string
  - optional `cause`
- Do not create parallel user-visible codes (`ARTIFACT_MISSING` vs `artifact_missing`).
- Prefer failure channel over throw for expected IO/domain errors inside Effect code.
- Use `Effect.die` / throw only for invariant violations.

### Abort / interrupt

- Host `AbortSignal` aborted → treat as cancellation, not generic failure.
- Preserve `AgentAbortError` and `RunAbortOrigin` at execution boundaries.
- Helper API (`effect-runtime.ts`):
  - `AbortSignalAborted` — `Data.TaggedError('AbortSignalAborted')` with optional `reason`
  - `failIfAborted(signal)` — if `signal?.aborted`, fail with `AbortSignalAborted` (no later-abort subscription); canonical name for Effect call sites
  - `checkAbortSignal` — compatibility alias of `failIfAborted` (prefer `failIfAborted` at new call sites)
- Production Promise-pool schedulers may keep point-in-time `signal?.aborted` checks; use `failIfAborted` only inside Effect programs. Do not wrap pure Promise pools solely to call abort helpers.
- Do not map abort to `stopReason: 'error'`. Callers map `AbortSignalAborted` to `AgentAbortError` at execution boundaries.

### Layers / services

- Phase 0–7: **no** `Layer`, **no** `Context.Tag` services required.
- Pass dependencies as ordinary function args / closure options (matches existing `createX(options)` factories).

### Testing

- Prefer existing Promise/sync tests as regression oracles.
- Add Effect-specific tests only for new helpers or new failure paths.
- Do not rewrite large suites to `Effect.gen` style.

## Tasks

### Task 1: Normalize dependency

**Outcome:** `effect` is a declared runtime dependency of `@balaenis/pi-agents` with a clear version range; install resolves.

**Files:**

- Modify: `packages/pi-agents/package.json`

**Steps:**

- [x] Confirm `dependencies.effect` is `"^3.22.0"` (or update to that range if missing).
- [x] Do not add `@effect/*` packages.
- [x] Run `bun install` at monorepo root if the lockfile needs refresh.
- [x] Verify resolve: `node -e "import('effect').then(m => console.log(!!m.Effect))"` from package context, or import in a scratch test.

**Validation:**

- Run: `cd /home/julian/workspace/my/pi-toolset && bun install`
- Expected: Install succeeds; `packages/pi-agents/node_modules/effect/package.json` exists with version 3.x.
- Run: `cd packages/pi-agents && bun -e "import { Effect } from 'effect'; console.log(typeof Effect.runPromise)"`
- Expected: Prints `function`.

### Task 2: Implement `effect-runtime` bridge

**Outcome:** A leaf module exports runners used by later phases; no production callers required yet.

**Files:**

- Create: `packages/pi-agents/src/effect-runtime.ts`
- Create: `packages/pi-agents/tests/effect-runtime.test.ts`

**Steps:**

- [x] Add 2-line ABOUTME header.
- [x] Export at least:
  - `runEffectPromise<A, E>(effect: Effect.Effect<A, E>): Promise<A>` — runs with default runtime; rejects with the failure value if it is an `Error`, otherwise wraps non-Error failures in `Error` **only when necessary**. Prefer: if failure is `Error`, reject with it; if tagged error with `message`, reject with that instance when it extends `Error`.
  - `runEffectExit<A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>>` — never throws for typed failures.
  - `checkAbortSignal(signal: AbortSignal | undefined): Effect.Effect<void, AbortSignalAborted>` — chosen abort policy (point-in-time check).
  - `AbortSignalAborted` — `Data.TaggedError('AbortSignalAborted')` with optional `reason`.
- [x] Document chosen abort policy in a short comment on the helper:
  - when `signal?.aborted`, fail with `AbortSignalAborted` carrying optional `reason`, so callers can map to `AgentAbortError` without treating it as defect.
- [x] Keep the module free of pi-agents domain imports (no `run-types`, no `SingleResult`) so it stays a true leaf.
- [x] Unit tests:
  - success path resolves value
  - failure path: `Effect.fail(new Error('x'))` rejects with that error via `runEffectPromise`
  - `runEffectExit` returns `Exit.isFailure` without throwing
  - aborted signal helper fails/interrupts as designed

**Validation:**

- Run: `cd packages/pi-agents && bun test tests/effect-runtime.test.ts`
- Expected: All tests pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: No TypeScript errors.

### Task 3: Freeze conventions in docs (this plan is the source)

**Outcome:** Engineers can implement Phase 1+ without inventing import/error/boundary rules.

**Files:**

- Modify: this file only if Task 2 chose a different abort policy than written — update Locked Conventions to match code.

**Steps:**

- [x] Re-read Locked Conventions against the implemented helpers.
- [x] Align wording so Phase 1 authors copy the real API names (`runEffectPromise`, `runEffectExit`, `checkAbortSignal`, `AbortSignalAborted`).

**Validation:**

- Run: `git diff --check -- packages/pi-agents/docs/effect-adoption packages/pi-agents/src/effect-runtime.ts packages/pi-agents/tests/effect-runtime.test.ts packages/pi-agents/package.json`
- Expected: No whitespace errors.

## Final Validation

- Run: `cd packages/pi-agents && bun test tests/effect-runtime.test.ts`
- Expected: Pass.
- Run: `mise run typecheck --package packages/pi-agents`
- Expected: Pass.
- Run: `hk check` (or at least format/lint on touched files)
- Expected: Clean for touched paths.

## Failure Behavior

- Missing `effect` install → Task 1 fails closed; do not stub a local Effect polyfill.
- Typed failure that is not an `Error` → `runEffectPromise` must still reject (wrap or use Cause pretty-print); document the wrap rule in code comments and tests.

## Privacy and Security

- No change to run storage, logging, or trust boundaries.

## Rollout Notes

- Safe to merge alone; no runtime behavior change in production paths until Phase 1+.

## Risks and Mitigations

- Over-building a mini framework — keep `effect-runtime.ts` under ~150 lines; no DI container.
- Premature Layer adoption — explicitly forbidden until Phase 8 review.

## Open Questions

None for Phase 0. Abort policy decided: point-in-time `checkAbortSignal` → `AbortSignalAborted` (no live signal subscription in Phase 0).
