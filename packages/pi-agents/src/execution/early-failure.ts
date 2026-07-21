// ABOUTME: Classifies early setup throws into stopReason codes and attaches Error.stack.
// ABOUTME: Leaf helpers so failure paths avoid pulling heavy execution/ACP import graphs.

import type { SingleResult } from '../shared/types.ts';

/** Attach `Error.stack` onto a synthesized failure when available. */
export function attachErrorStack(result: SingleResult, err: unknown): SingleResult {
  if (err instanceof Error && err.stack) {
    result.errorStack = err.stack;
  }
  return result;
}

/**
 * Classify a thrown setup/execution error into a SingleResult stopReason.
 * Reserves `context_error` for real context prep failures; generic throws are `error`.
 */
export function classifyEarlyFailureStopReason(err: unknown, message: string): string {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code?: unknown }).code === 'string'
  ) {
    return (err as { code: string }).code;
  }
  if (message.includes('session_file_conflict')) return 'session_file_conflict';
  if (message.includes('session_file_unavailable')) return 'session_file_unavailable';
  if (message.includes('session_prompt_unestablished')) return 'session_prompt_unestablished';
  if (
    message.startsWith('Cannot fork parent context') ||
    message.startsWith('Cannot create fresh context') ||
    message.startsWith('Cannot resume context')
  ) {
    return 'context_error';
  }
  return 'error';
}
