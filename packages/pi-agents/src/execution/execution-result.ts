// ABOUTME: Shared result stamping, update emission, and abort finalization for Pi and Grok execution.
// ABOUTME: Keeps snapshot/abort semantics out of the main execution dispatcher module.

import type { RunAbortOrigin } from '../run/run-types.ts';
import { originToUnitStatus } from '../run/run-lifecycle.ts';
import { getResultFinalOutput } from '../output/output.ts';
import { snapshotProvisionalResult } from '../output/result-snapshot.ts';
import type { SingleResult, SubagentDetails } from '../shared/types.ts';
import { ABORT_MESSAGE } from './abort.ts';
import type { OnUpdateCallback, RunSingleAgentOptions } from './execution-types.ts';

export function stampUnitContext(result: SingleResult, options: RunSingleAgentOptions): void {
  const ctx = options.unitContext;
  if (!ctx) return;
  result.runId = ctx.runId;
  result.unitId = ctx.unitId;
  result.attempt = ctx.attempt;
  result.sessionFile = ctx.sessionFile;
  if (ctx.acpSessionId !== undefined) {
    result.acpSessionId = ctx.acpSessionId;
  }
  result.resumeCapability = ctx.resumeCapability;
}

export function emitRunningSnapshot(
  onUpdate: OnUpdateCallback | undefined,
  currentResult: SingleResult,
  makeDetails: (results: SingleResult[]) => SubagentDetails
): void {
  if (!onUpdate) return;
  // Provisional UI update — no authoritative inline/ref values while running.
  const snapshot = snapshotProvisionalResult(currentResult);
  snapshot.status = 'running';
  onUpdate({
    content: [
      {
        type: 'text',
        text: getResultFinalOutput(snapshot) || '(running...)',
      },
    ],
    details: makeDetails([snapshot]),
  });
}

export function emitTerminalSnapshot(
  onUpdate: OnUpdateCallback | undefined,
  currentResult: SingleResult,
  makeDetails: (results: SingleResult[]) => SubagentDetails
): void {
  if (!onUpdate) return;
  // Low-level terminal callback remains provisional; durable authority is finishUnit.
  const snapshot = snapshotProvisionalResult(currentResult);
  onUpdate({
    content: [
      {
        type: 'text',
        text:
          getResultFinalOutput(snapshot) ||
          snapshot.errorMessage ||
          snapshot.stderr ||
          (snapshot.status === 'cancelled' ? '(cancelled)' : '(done)'),
      },
    ],
    details: makeDetails([snapshot]),
  });
}

export function resolveAbortOrigin(
  signal: AbortSignal | undefined,
  options: RunSingleAgentOptions
): RunAbortOrigin {
  const injected = options.getAbortOrigin?.();
  if (injected) return injected;
  // When Pi's incoming tool signal aborts with no coordinator-owned origin,
  // treat it as user-initiated; otherwise unknown (interrupted with diagnostic).
  return signal && signal.aborted ? 'user' : 'unknown';
}

export function finalizeAborted(currentResult: SingleResult, origin: RunAbortOrigin): void {
  const status = originToUnitStatus(origin);
  currentResult.stopReason =
    currentResult.stopReason ?? (status === 'interrupted' ? 'interrupted' : 'aborted');
  currentResult.status = status;
  if (currentResult.exitCode === 0 || currentResult.exitCode === -1) {
    currentResult.exitCode = 1;
  }
  if (!currentResult.errorMessage) {
    currentResult.errorMessage = ABORT_MESSAGE;
  }
}
