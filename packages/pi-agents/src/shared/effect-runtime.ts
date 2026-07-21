// ABOUTME: Leaf Effect runtime bridge — Promise boundary runners and abort helpers.
// ABOUTME: Later phases import these instead of calling Effect.runPromise ad hoc.

import { Cause, Data, Effect, Exit, Option } from 'effect';
import type { AgentAbortError } from '../execution/abort.ts';

/**
 * Abort → Effect mapping (Phase 0 + 6):
 *
 * | Source                | Effect                                      | Downstream (existing)                |
 * | --------------------- | ------------------------------------------- | ------------------------------------ |
 * | `signal.aborted` user | fail `AbortSignalAborted` via `failIfAborted` | `AgentAbortError` / cancelled result |
 * | `AgentAbortError`     | fail same instance (`failAgentAbortError`)  | preserve `result` + `origin`         |
 * | defect                | die                                         | unexpected                           |
 *
 * Canonical Effect call-site helper for signals: `failIfAborted`.
 * `checkAbortSignal` is the same function (Phase 0 name kept for compatibility).
 *
 * Do not map aborts to generic domain `stopReason: 'error'`. Keep dual
 * representation: Effect tags at Effect boundaries; `AgentAbortError` at
 * execution/tool Promise boundaries.
 */

/**
 * Typed abort failure for host AbortSignal cancellation.
 * Callers map this to AgentAbortError / interrupt paths; do not treat as domain error or defect.
 */
export class AbortSignalAborted extends Data.TaggedError('AbortSignalAborted')<{
  readonly reason?: unknown;
}> {}

/**
 * Fail immediately when `signal` is already aborted.
 * Does not subscribe for later aborts — compose with interruptible fibers if needed.
 * Canonical name for Effect call sites (Phase 6+).
 */
export function failIfAborted(
  signal: AbortSignal | undefined
): Effect.Effect<void, AbortSignalAborted> {
  if (signal?.aborted) {
    return Effect.fail(new AbortSignalAborted({ reason: signal.reason }));
  }
  return Effect.void;
}

/** Phase 0 name; identical to `failIfAborted`. Prefer `failIfAborted` at new call sites. */
export const checkAbortSignal = failIfAborted;

/**
 * Put an existing AgentAbortError on the failure channel without wrapping.
 * Preserves `result` and `origin` for Promise-boundary rethrow.
 */
export function failAgentAbortError(err: AgentAbortError): Effect.Effect<never, AgentAbortError> {
  return Effect.fail(err);
}

/**
 * Promise-boundary runner choice:
 *
 * | Helper                  | Non-Error typed failure | Use when                                                                |
 * | ----------------------- | ----------------------- | ----------------------------------------------------------------------- |
 * | `runEffectPromise`      | wrap in `Error`         | domain Effects whose public Promise API should only reject with `Error` |
 * | `runEffectThrowingAsIs` | rethrow as-is           | store/coordinator/fanout where plain `{ code, message }` must survive   |
 * | `runEffectExit`         | never throws for typed  | callers that branch on Exit                                             |
 *
 * `createKeyedSerialExecutor` is the standard continue-after-failure queue
 * for durable write paths; do not re-inline `prev.then(run, run)` for new work.
 */

/**
 * Run an Effect as Exit. Typed failures never throw; only runtime defects in the runner itself can.
 */
export function runEffectExit<A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect);
}

/**
 * Wrap a Promise factory as `Effect.Effect<A, unknown>` without remapping the catch cause.
 */
export function tryPromiseUnknown<A>(work: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: work, catch: (cause) => cause });
}

/**
 * Run an Effect as a Promise.
 *
 * Rejection wrap rule:
 * - Typed failure that is an `Error` (incl. Data.TaggedError subclasses) → reject with that instance.
 * - Other typed failures → reject with `Error` whose message is the string failure or Cause.pretty.
 * - Defects / interruptions → reject with the defect Error when present, else Cause.pretty Error.
 */
export async function runEffectPromise<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw causeToRejection(exit.cause);
}

/**
 * Run an Effect as a Promise, rethrowing typed failures and defects as-is.
 * Plain object failures (e.g. `{ code, message }`) are not wrapped in `Error`.
 */
export async function runEffectThrowingAsIs<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await runEffectExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
  if (failure !== undefined) {
    throw failure;
  }
  for (const defect of Cause.defects(exit.cause)) {
    throw defect;
  }
  throw new Error(Cause.pretty(exit.cause));
}

export interface KeyedSerialExecutor {
  enqueue<T>(key: string, task: () => Promise<T>): Promise<T>;
}

/**
 * Per-key serial Promise queue with continue-after-failure semantics.
 * - Task body via `runEffectThrowingAsIs(tryPromiseUnknown(task))`
 * - Chain: `prev.then(run, run)` so one reject does not wedge the key
 * - Map stores swallowed promises (no unhandled rejection)
 * - No automatic key deletion (late non-active writes stay serial)
 */
export function createKeyedSerialExecutor(): KeyedSerialExecutor {
  const tails = new Map<string, Promise<unknown>>();

  return {
    enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve();
      const runTask = (): Promise<T> => runEffectThrowingAsIs(tryPromiseUnknown(task));
      const next = prev.then(runTask, runTask);
      tails.set(
        key,
        next.then(
          () => undefined,
          () => undefined
        )
      );
      return next;
    },
  };
}

function causeToRejection<E>(cause: Cause.Cause<E>): Error {
  const failure = Option.getOrUndefined(Cause.failureOption(cause));
  if (failure !== undefined) {
    if (failure instanceof Error) {
      return failure;
    }
    if (typeof failure === 'string') {
      return new Error(failure, { cause: failure });
    }
    return new Error(Cause.pretty(cause), { cause: failure as unknown as Error });
  }

  for (const defect of Cause.defects(cause)) {
    if (defect instanceof Error) {
      return defect;
    }
  }

  return new Error(Cause.pretty(cause));
}
