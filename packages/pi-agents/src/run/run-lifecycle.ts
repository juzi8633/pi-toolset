// ABOUTME: Per-run abort lifecycle — coordinator-owned AbortController plus a mutable abort origin.
// ABOUTME: Bridges Pi's incoming tool signal as `user`; shutdown overrides to `session_shutdown`.

import type { RunAbortOrigin } from './run-types.ts';

export interface RunLifecycle {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly controller: AbortController;
  origin: RunAbortOrigin;
  claimId?: string;
  ticket?: number;
  setOrigin(origin: RunAbortOrigin): void;
  abort(origin: RunAbortOrigin): void;
}

export function createRunLifecycle(runId: string): RunLifecycle {
  const controller = new AbortController();
  const lifecycle: RunLifecycle = {
    runId,
    controller,
    signal: controller.signal,
    origin: 'unknown',
    setOrigin(origin) {
      // `session_shutdown` outranks `user`/`unknown`/`owner_process_missing`; a
      // non-shutdown origin never downgrades an already-observed shutdown while
      // shutdown is draining.
      if (origin === 'session_shutdown') lifecycle.origin = 'session_shutdown';
      else if (lifecycle.origin === 'unknown') lifecycle.origin = origin;
    },
    abort(origin) {
      lifecycle.setOrigin(origin);
      if (!controller.signal.aborted) controller.abort();
    },
  };
  return lifecycle;
}

/** Forward Pi's incoming tool abort signal to the coordinator-owned controller as `user`. */
export function bridgeIncomingSignal(
  incoming: AbortSignal | undefined,
  lifecycle: RunLifecycle
): void {
  if (!incoming) return;
  if (incoming.aborted) lifecycle.abort('user');
  else incoming.addEventListener('abort', () => lifecycle.abort('user'), { once: true });
}

/** Map a carried abort origin to the durable run-level status. */
export function originToRunStatus(origin: RunAbortOrigin): 'cancelled' | 'interrupted' {
  return origin === 'user' ? 'cancelled' : 'interrupted';
}

/** Map a carried abort origin to the per-unit result status. */
export function originToUnitStatus(origin: RunAbortOrigin): 'cancelled' | 'interrupted' {
  return origin === 'user' ? 'cancelled' : 'interrupted';
}

/** Convert an abort origin into finalize flags for `RunCoordinator.finalizeRun`. */
export function originToFinalizeFlags(origin: RunAbortOrigin): {
  cancelled?: boolean;
  interrupted?: boolean;
} {
  if (origin === 'user') return { cancelled: true };
  return { interrupted: true };
}

/** Human-readable diagnostic for an `unknown` origin; `undefined` for reasoned origins. */
export function describeAbortOrigin(origin: RunAbortOrigin): string | undefined {
  if (origin === 'unknown') return 'abort origin unknown; treated as interrupted';
  return undefined;
}
