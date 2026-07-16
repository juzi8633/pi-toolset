// ABOUTME: Shared abort error type and helpers for subagent cancellation paths.
// ABOUTME: Leaf module so pi-rpc-execution does not value-import execution (breaks jiti cycles).

import type { RunAbortOrigin } from './run-types.ts';
import { snapshotSingleResult } from './result-snapshot.ts';
import type { SingleResult } from './types.ts';

export const ABORT_MESSAGE = 'Subagent was aborted';

/** Abort error that carries a compact terminal SingleResult snapshot and the abort origin. */
export class AgentAbortError extends Error {
  readonly result: SingleResult;
  readonly origin: RunAbortOrigin;

  constructor(result: SingleResult, origin: RunAbortOrigin = 'unknown') {
    super(ABORT_MESSAGE);
    this.name = 'AgentAbortError';
    // Provisional compact snapshot; runStepWithContext may re-stamp and replace this.
    this.result = snapshotSingleResult(result);
    this.origin = origin;
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof AgentAbortError || (err instanceof Error && err.message === ABORT_MESSAGE);
}

export function getAbortResult(err: unknown): SingleResult | undefined {
  if (err instanceof AgentAbortError) return err.result;
  if (err && typeof err === 'object' && 'result' in err) {
    const result = (err as { result?: SingleResult }).result;
    if (result && typeof result === 'object' && 'agent' in result) return result;
  }
  return undefined;
}
