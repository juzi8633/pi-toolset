// ABOUTME: Projects interactive registry activations into SingleResult for TUI Pi units.
// ABOUTME: Consumes activation snapshots only; never mutates endpoint or transport state directly.

import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import type { AgentConfig } from './agents.ts';
import {
  AgentAbortError,
  type OnUpdateCallback,
  type RunSingleAgentOptions,
  ABORT_MESSAGE,
} from './execution.ts';
import {
  InteractiveAgentError,
  type InteractiveAgentRegistry,
  type InteractiveEndpointSnapshot,
  type InteractiveEndpointUpdateKind,
  type InteractiveRegistryEvent,
} from './interactive-agent.ts';
import { appendContinuationTasks, buildSessionContinuationPrompt } from './invocation.ts';
import { applyTerminalStatus, getFinalOutput } from './output.ts';
import { originToUnitStatus } from './run-lifecycle.ts';
import type { RunAbortOrigin } from './run-types.ts';
import { cloneSingleResult, emptyUsage, type SingleResult, type SubagentDetails } from './types.ts';

/** Structured error codes from InteractiveAgentError / GrokAcpClientError / plain {code}. */
function structuredErrorCode(err: unknown): string | undefined {
  if (err instanceof InteractiveAgentError && err.code) return err.code;
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return undefined;
}

const DEFAULT_SETTLE_TIMEOUT_MS = 10_000;

export interface RunSingleAgentPiRpcOptions extends RunSingleAgentOptions {
  interactiveRegistry: InteractiveAgentRegistry;
  endpointKey: string;
  hostMode: 'tui';
  /** Max wait after max_turns abort for protocol settle (default 10s). Injectable for tests. */
  settleTimeoutMs?: number;
  /** Timer surface for settle timeout; injectable for fast tests. */
  timers?: {
    setTimeout: (fn: () => void, ms?: number) => unknown;
    clearTimeout: (id: unknown) => void;
  };
}

function resolveAbortOrigin(
  signal: AbortSignal | undefined,
  options: RunSingleAgentOptions
): RunAbortOrigin {
  const injected = options.getAbortOrigin?.();
  if (injected) return injected;
  return signal && signal.aborted ? 'user' : 'unknown';
}

function finalizeAborted(currentResult: SingleResult, origin: RunAbortOrigin): void {
  const status = originToUnitStatus(origin);
  // Force abort/interrupted terminal over any prior assistant stopReason.
  currentResult.stopReason = status === 'interrupted' ? 'interrupted' : 'aborted';
  currentResult.status = status;
  if (currentResult.exitCode === 0 || currentResult.exitCode === -1) {
    currentResult.exitCode = 1;
  }
  if (!currentResult.errorMessage) {
    currentResult.errorMessage = ABORT_MESSAGE;
  }
}

function stampUnitContext(result: SingleResult, options: RunSingleAgentOptions): void {
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

function emitRunningSnapshot(
  onUpdate: OnUpdateCallback | undefined,
  currentResult: SingleResult,
  makeDetails: (results: SingleResult[]) => SubagentDetails
): void {
  if (!onUpdate) return;
  const snapshot = cloneSingleResult(currentResult);
  snapshot.status = 'running';
  onUpdate({
    content: [
      {
        type: 'text',
        text: getFinalOutput(snapshot.messages) || '(running...)',
      },
    ],
    details: makeDetails([snapshot]),
  });
}

function emitTerminalSnapshot(
  onUpdate: OnUpdateCallback | undefined,
  currentResult: SingleResult,
  makeDetails: (results: SingleResult[]) => SubagentDetails
): void {
  if (!onUpdate) return;
  const snapshot = cloneSingleResult(currentResult);
  onUpdate({
    content: [
      {
        type: 'text',
        text:
          getFinalOutput(snapshot.messages) ||
          snapshot.errorMessage ||
          snapshot.stderr ||
          (snapshot.status === 'cancelled' ? '(cancelled)' : '(done)'),
      },
    ],
    details: makeDetails([snapshot]),
  });
}

function projectSnapshot(
  currentResult: SingleResult,
  snap: InteractiveEndpointSnapshot,
  baseline: number
): void {
  // Always copy into a caller-owned mutable array — never alias the registry readonly view,
  // even when baseline is 0. Transcript-only paths skip projectSnapshot entirely.
  const post = snap.messages.slice(baseline) as Message[];
  currentResult.messages = post;
  // Count only post-baseline assistant messages for usage/turns.
  // Derive stopReason only from this snapshot's messages — never seed from currentResult
  // so a prior activation's terminal state cannot stick across projections.
  let turns = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let contextTokens = 0;
  let model = currentResult.model;
  let stopReason: string | undefined;
  for (const msg of post) {
    if ((msg as { role?: string }).role !== 'assistant') continue;
    turns += 1;
    const usage = (msg as { usage?: Record<string, number> & { cost?: { total?: number } } }).usage;
    if (usage) {
      input += usage.input || 0;
      output += usage.output || 0;
      cacheRead += (usage as { cacheRead?: number }).cacheRead || 0;
      cacheWrite += (usage as { cacheWrite?: number }).cacheWrite || 0;
      cost += usage.cost?.total || 0;
      contextTokens = (usage as { totalTokens?: number }).totalTokens || contextTokens;
    }
    if ((msg as { model?: string }).model) model = (msg as { model?: string }).model;
    if ((msg as { stopReason?: string }).stopReason) {
      stopReason = (msg as { stopReason?: string }).stopReason;
    }
  }
  currentResult.usage = {
    turns,
    input,
    output,
    cacheRead,
    cacheWrite,
    cost,
    contextTokens,
  };
  if (model) currentResult.model = model;
  // Prefer formal SingleResult stop reason from endpoint usage (Grok ACP mapped
  // end/max_turns/error/aborted) over assistant-message vocabulary (stop/length).
  const formalStop = snap.usage?.stopReason;
  if (formalStop) {
    currentResult.stopReason = formalStop === 'stop' ? 'end' : formalStop;
  } else if (stopReason) {
    currentResult.stopReason = stopReason === 'stop' ? 'end' : stopReason;
  }
  if (snap.lastError) {
    currentResult.stderr = snap.lastError;
  }
}

/** True when an endpoint update belongs to the given activation id. */
function endpointBelongsToActivation(
  snap: InteractiveEndpointSnapshot,
  activationId: string
): boolean {
  return snap.activation?.id === activationId;
}

/**
 * Apply max_turns terminal. Prefer an existing activation/endpoint/ACP message
 * over Pi client text. Only emit `Agent exceeded maxTurns=N` when agent.maxTurns
 * is a finite number — never overwrite ACP `max_turn_requests` with
 * `maxTurns=undefined` (Grok ACP strips maxTurns).
 */
function applyMaxTurnsTerminal(
  currentResult: SingleResult,
  agent: AgentConfig,
  preferredMessage?: string
): void {
  currentResult.stopReason = 'max_turns';
  currentResult.exitCode = 1;
  if (currentResult.errorMessage) return;
  if (preferredMessage) {
    currentResult.errorMessage = preferredMessage;
    return;
  }
  if (typeof agent.maxTurns === 'number' && Number.isFinite(agent.maxTurns)) {
    currentResult.errorMessage = `Agent exceeded maxTurns=${agent.maxTurns}`;
  }
}

/**
 * Project registry terminalOverride / error / cancelled onto SingleResult before
 * applyTerminalStatus. Without this, a transport crash that leaves assistant
 * messages would be mis-classified as completed (exitCode 0, no stopReason).
 */
function projectTerminalFromSettled(
  currentResult: SingleResult,
  snap: InteractiveEndpointSnapshot,
  agent: AgentConfig
): void {
  const override = snap.activation?.terminalOverride;
  const errorCode = snap.errorCode;

  if (
    override === 'max_turns' ||
    errorCode === 'max_turns' ||
    currentResult.stopReason === 'max_turns'
  ) {
    // Prefer endpoint/activation error (e.g. ACP max_turn_requests mapping).
    const preferred =
      currentResult.errorMessage ?? snap.activation?.error ?? snap.lastError ?? undefined;
    applyMaxTurnsTerminal(currentResult, agent, preferred);
    if (errorCode) currentResult.errorCode = errorCode;
    return;
  }

  if (override === 'cancelled' || errorCode === 'cancelled') {
    // Force terminal abort reason — never keep a prior assistant stopReason
    // (stop / toolUse / end) via ??.
    currentResult.stopReason = 'aborted';
    if (currentResult.exitCode === 0 || currentResult.exitCode === -1) {
      currentResult.exitCode = 1;
    }
    currentResult.errorMessage =
      currentResult.errorMessage ?? snap.activation?.error ?? ABORT_MESSAGE;
    if (!currentResult.stderr) currentResult.stderr = currentResult.errorMessage;
    if (errorCode) currentResult.errorCode = errorCode;
    return;
  }

  // Structured failure codes (dispose_failed, acp_*, transport_error, …) and
  // formal non-success stop reasons all project to failed SingleResult.
  const structuredFail =
    errorCode === 'transport_error' ||
    errorCode === 'error' ||
    errorCode === 'dispose_failed' ||
    errorCode === 'acp_load_error' ||
    errorCode === 'acp_session_not_found' ||
    errorCode === 'acp_cwd_mismatch' ||
    errorCode === 'acp_load_unsupported' ||
    errorCode === 'acp_session_history_empty' ||
    errorCode === 'acp_session_unavailable' ||
    currentResult.stopReason === 'error' ||
    currentResult.stopReason === 'max_turns';

  if (override === 'error' || snap.status === 'error' || structuredFail) {
    currentResult.exitCode = 1;
    // Force error terminal — never keep a prior assistant stopReason via ??.
    if (currentResult.stopReason !== 'max_turns') {
      currentResult.stopReason = 'error';
    }
    currentResult.errorMessage =
      currentResult.errorMessage ??
      snap.activation?.error ??
      snap.lastError ??
      'RPC endpoint error';
    currentResult.stderr = currentResult.stderr || currentResult.errorMessage;
    if (errorCode) {
      currentResult.errorCode = errorCode;
    }
  }
}

/**
 * Parent tool onUpdate only when projection inputs change.
 * projectSnapshot ignores streamingMessage, so pure transcript streaming is a no-op.
 */
function parentProjectionChanged(
  prev: { messageCount: number; lastError?: string; stopReason?: string; status?: string },
  currentResult: SingleResult,
  snap: InteractiveEndpointSnapshot
): boolean {
  if (currentResult.messages.length !== prev.messageCount) return true;
  if ((snap.lastError ?? '') !== (prev.lastError ?? '')) return true;
  if ((currentResult.stopReason ?? '') !== (prev.stopReason ?? '')) return true;
  if (snap.status !== prev.status) return true;
  if (snap.activation?.terminalOverride === 'max_turns') return true;
  if (snap.activation?.terminalOverride === 'error') return true;
  if (snap.activation?.terminalOverride === 'cancelled') return true;
  return false;
}

/** Max foreign early-activation cache entries before activate() returns. */
const EARLY_CACHE_MAX = 4;

/** Drop message bodies from pre-bind endpoint cache entries (meta only). */
function slimEarlyEndpointSnapshot(snap: InteractiveEndpointSnapshot): InteractiveEndpointSnapshot {
  return {
    ...snap,
    messages: [],
    streamingMessage: undefined,
    activeTools: [],
    steeringQueue: [],
    followUpQueue: [],
    queueCount: 0,
  };
}

/**
 * Run a single Pi agent through the interactive registry in TUI mode.
 * Waits for the initial activation to settle (including steer/follow-up during
 * the original tool call) before returning the parent SingleResult.
 */
export async function runSingleAgentPiRpc(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  options: RunSingleAgentPiRpcOptions
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(', ') || 'none';
    return {
      agent: agentName,
      agentSource: 'unknown',
      task,
      title: options.title,
      exitCode: 1,
      status: 'failed',
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: emptyUsage(),
      step,
      errorMessage: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      stopReason: 'error',
    };
  }

  const effectiveModel = options.modelOverride ?? agent.model;
  const effectiveThinking = options.thinkingOverride ?? agent.thinking;
  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    title: options.title,
    exitCode: 0,
    status: 'running',
    messages: [],
    stderr: '',
    usage: emptyUsage(),
    model: effectiveModel,
    thinking: effectiveThinking,
    step,
  };
  stampUnitContext(currentResult, options);
  if (options.unitContext) options.sessionFile = options.unitContext.sessionFile;

  const registry = options.interactiveRegistry;
  const endpointKey = options.endpointKey;
  const timers = options.timers ?? {
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  // Prefer explicit resumeHadStoredSession so a just-created session is not
  // treated as a prior stored session for never-started units.
  const resumePrompt = options.resumePrompt;
  const useSessionContinuation = Boolean(
    resumePrompt && (options.resumeHadStoredSession ?? Boolean(options.sessionFile))
  );
  const prompt = useSessionContinuation
    ? buildSessionContinuationPrompt(
        resumePrompt?.undeliveredContinuationTasks ??
          (resumePrompt?.currentContinuationTask ? [resumePrompt.currentContinuationTask] : [])
      )
    : resumePrompt
      ? `Task: ${appendContinuationTasks(task, resumePrompt.continuationTasks)}`
      : `Task: ${task}`;

  let baseline = 0;
  let activationId = '';
  let settled = false;
  let abortRequested = false;
  /** Last settled snapshot for this activation (terminal projection source of truth). */
  let settledSnapshot: InteractiveEndpointSnapshot | undefined;
  /**
   * Events that race ahead of activate() return, keyed by snapshot.activation.id /
   * activation_settled.activationId. Only replayed for the returned activationId.
   * Bounded; non-settled entries are message-free (meta only).
   */
  const earlyByActivation = new Map<
    string,
    { endpoint?: InteractiveEndpointSnapshot; settled?: InteractiveEndpointSnapshot }
  >();

  // Single subscription for the whole activation lifecycle (updates + settle wait).
  let settleResolve: (() => void) | undefined;
  let settleReject: ((err: Error) => void) | undefined;
  let settleTimer: unknown;
  let waitingForSettle = false;
  /** Why the settle timer is armed — only max_turns / abort (never open-ended agent work). */
  let settleTimerReason: 'max_turns' | 'abort' | undefined;

  let lastParentEmit = {
    messageCount: -1,
    lastError: undefined as string | undefined,
    stopReason: undefined as string | undefined,
    status: undefined as string | undefined,
  };

  const clearSettleTimer = () => {
    if (settleTimer) {
      timers.clearTimeout(settleTimer);
      settleTimer = undefined;
    }
    settleTimerReason = undefined;
  };

  /**
   * Bounded wait after max_turns abort or user/signal abort.
   * Detach is activation-scoped so a late timer cannot settle a later activation.
   */
  const armSettleTimeout = (reason: 'max_turns' | 'abort') => {
    if (settleTimer) return;
    settleTimerReason = reason;
    const expectedId = activationId;
    settleTimer = timers.setTimeout(() => {
      clearSettleTimer();
      if (!waitingForSettle || !expectedId) return;
      // Activation-scoped: no-op if a different activation is live (or none).
      void registry
        .detach(endpointKey, { activationId: expectedId })
        .catch(() => undefined)
        .finally(() => {
          if (!waitingForSettle) return;
          if (reason === 'max_turns') {
            settleReject?.(new Error('RPC activation settle timeout after max_turns abort'));
          } else {
            // Abort path: resolve the wait so the outer path throws AgentAbortError.
            settleResolve?.();
            waitingForSettle = false;
            settleResolve = undefined;
            settleReject = undefined;
          }
        });
    }, settleTimeoutMs);
  };

  const finishSettleWait = () => {
    if (!waitingForSettle) return;
    waitingForSettle = false;
    clearSettleTimer();
    const resolve = settleResolve;
    settleResolve = undefined;
    settleReject = undefined;
    resolve?.();
  };

  const applySettledSnapshot = (snap: InteractiveEndpointSnapshot): void => {
    settled = true;
    settledSnapshot = snap;
    projectSnapshot(currentResult, snap, baseline);
    projectTerminalFromSettled(currentResult, snap, agent);
    // Surface real matching prompt completion for Grok ACP delivery gating.
    // Cancel-grace and prompt_failed leave promptCompleted unset/false.
    (currentResult as { acpPromptCompleted?: boolean }).acpPromptCompleted =
      snap.activation?.promptCompleted === true;
    if (waitingForSettle) finishSettleWait();
  };

  const applyMatchingEndpointUpdate = (
    snap: InteractiveEndpointSnapshot,
    kind: InteractiveEndpointUpdateKind
  ): void => {
    projectSnapshot(currentResult, snap, baseline);
    // Mid-flight terminalOverride (max_turns abort, cancel) must surface immediately.
    if (snap.activation?.terminalOverride) {
      projectTerminalFromSettled(currentResult, snap, agent);
    }
    maybeEmitParentRunning(snap, kind);

    if (snap.activation?.terminalOverride === 'max_turns') {
      if (waitingForSettle) armSettleTimeout('max_turns');
    }
  };

  const maybeEmitParentRunning = (
    snap: InteractiveEndpointSnapshot,
    kind: InteractiveEndpointUpdateKind
  ): void => {
    // Pure streaming does not change projectSnapshot inputs — skip full clone/onUpdate.
    if (kind === 'transcript') return;
    if (!parentProjectionChanged(lastParentEmit, currentResult, snap)) return;
    lastParentEmit = {
      messageCount: currentResult.messages.length,
      lastError: snap.lastError,
      stopReason: currentResult.stopReason,
      status: snap.status,
    };
    emitRunningSnapshot(onUpdate, currentResult, makeDetails);
  };

  const cacheEarly = (
    id: string,
    patch: { endpoint?: InteractiveEndpointSnapshot; settled?: InteractiveEndpointSnapshot }
  ): void => {
    // Bound: drop oldest foreign entry when over cap (FIFO by insertion order).
    if (!earlyByActivation.has(id) && earlyByActivation.size >= EARLY_CACHE_MAX) {
      const first = earlyByActivation.keys().next().value;
      if (first !== undefined) earlyByActivation.delete(first);
    }
    const prev = earlyByActivation.get(id) ?? {};
    const next: {
      endpoint?: InteractiveEndpointSnapshot;
      settled?: InteractiveEndpointSnapshot;
    } = { ...prev };
    // Non-settled endpoint: keep latest meta only (no transcript / tool payloads).
    if (patch.endpoint) {
      next.endpoint = slimEarlyEndpointSnapshot(patch.endpoint);
    }
    // Settled: keep latest settled snapshot (messages needed for final projection once).
    if (patch.settled) {
      next.settled = patch.settled;
    }
    earlyByActivation.set(id, next);
  };

  const unsub = registry.subscribe((event: InteractiveRegistryEvent) => {
    if (event.type === 'endpoint_updated' && event.key === endpointKey) {
      // Transcript-only: no projectSnapshot (no slice/scan), no parent onUpdate.
      if (event.kind === 'transcript') return;

      const eventActId = event.snapshot.activation?.id;

      // Until activate() returns, never project into currentResult. Cache by activation id
      // so a fast-matching activation can be replayed; foreign ids stay isolated.
      if (!activationId) {
        if (eventActId) {
          cacheEarly(eventActId, { endpoint: event.snapshot });
        }
        return;
      }

      // Known activation: only project updates that carry our activation id.
      // No-id / other-id events must not pollute currentResult or arm timeout/detach.
      if (!eventActId || eventActId !== activationId) {
        // Error cleanup after our settle: endpoint may drop activation on crash.
        if (
          waitingForSettle &&
          settled &&
          event.snapshot.status === 'error' &&
          !event.snapshot.activation
        ) {
          finishSettleWait();
        }
        return;
      }

      applyMatchingEndpointUpdate(event.snapshot, event.kind);
    }

    if (event.type === 'activation_settled' && event.key === endpointKey) {
      // Never accept an arbitrary settle when activationId is still unknown.
      // Cache early settles by id; match after activate() returns.
      if (!activationId) {
        cacheEarly(event.activationId, { settled: event.snapshot });
        return;
      }
      if (event.activationId !== activationId) return;
      applySettledSnapshot(event.snapshot);
    }
  });

  const onAbort = () => {
    abortRequested = true;
    void registry.abort(endpointKey).catch(() => undefined);
    // Non-max-turn abort must not wait forever for agent_settled.
    if (waitingForSettle && settleTimerReason !== 'max_turns') {
      armSettleTimeout('abort');
    }
  };

  try {
    // Pre-aborted signal must not start the initial prompt or wait forever.
    if (signal?.aborted) {
      const origin = resolveAbortOrigin(signal, options);
      finalizeAborted(currentResult, origin);
      emitTerminalSnapshot(onUpdate, currentResult, makeDetails);
      throw new AgentAbortError(currentResult, origin);
    }
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const snapBefore = registry.get(endpointKey);
    baseline = snapBefore?.messages.length ?? 0;

    let activated: { activationId: string; snapshot: InteractiveEndpointSnapshot };
    try {
      activated = await registry.activate(
        endpointKey,
        prompt,
        'prompt',
        {
          maxTurns: agent.maxTurns,
        },
        'tool_call'
      );
    } catch (err) {
      // Startup-barrier abort / cancellation settles as cancelled rather than hard failure.
      if (
        abortRequested ||
        signal?.aborted ||
        (err instanceof Error && /cancel/i.test(err.message))
      ) {
        const origin = resolveAbortOrigin(signal, options);
        finalizeAborted(currentResult, origin);
        emitTerminalSnapshot(onUpdate, currentResult, makeDetails);
        throw new AgentAbortError(currentResult, origin);
      }
      throw err;
    }
    // RPC activate accepted the resume/fresh prompt for this unit.
    // Await original-prompt establishment first so write failure fail-closes.
    await options.onSessionPromptEstablished?.();
    options.onResumePromptAccepted?.();
    activationId = activated.activationId;
    baseline = activated.snapshot.activation?.baselineMessageCount ?? baseline;
    // Bind to this activation only: drop any sticky terminal state that could not
    // have come from our id (foreign events were never projected, but clear defensively).
    currentResult.stopReason = undefined;
    currentResult.errorMessage = undefined;
    currentResult.exitCode = 0;
    projectSnapshot(currentResult, activated.snapshot, baseline);
    lastParentEmit = {
      messageCount: currentResult.messages.length,
      lastError: activated.snapshot.lastError,
      stopReason: currentResult.stopReason,
      status: activated.snapshot.status,
    };
    emitRunningSnapshot(onUpdate, currentResult, makeDetails);

    // Replay only events that match the returned activationId; drop foreign early entries.
    const early = earlyByActivation.get(activationId);
    earlyByActivation.clear();
    if (early?.endpoint && endpointBelongsToActivation(early.endpoint, activationId)) {
      applyMatchingEndpointUpdate(early.endpoint, 'full');
    }
    if (early?.settled) {
      applySettledSnapshot(early.settled);
    }

    // Wait for this activation to settle (open-ended; agent work can take minutes).
    // After max_turns or user/signal abort, enforce a protocol settle timeout.
    // Unexpected process exit must also settle via activation_settled from the registry.
    if (!settled) {
      await new Promise<void>((resolve, reject) => {
        waitingForSettle = true;
        settleResolve = resolve;
        settleReject = reject;

        // In case settle already raced before we entered the wait.
        const current = registry.get(endpointKey);
        if (!current?.activation || current.activation.id !== activationId) {
          if (
            settled ||
            current?.status === 'idle' ||
            current?.status === 'error' ||
            current?.status === 'detached'
          ) {
            // Only finish if our activation already settled (not some other reason).
            if (settled || early?.settled) {
              finishSettleWait();
              return;
            }
            // No live activation for our id and not settled — still wait for
            // activation_settled event (may be in flight) unless endpoint died.
            if (current?.status === 'error' || current?.status === 'detached') {
              // Endpoint gone without our settle: do not project unless the snapshot
              // still names our activation (foreign detach must not settle us).
              if (endpointBelongsToActivation(current, activationId)) {
                projectSnapshot(currentResult, current, baseline);
                projectTerminalFromSettled(currentResult, current, agent);
                settledSnapshot = current;
              }
              settled = true;
              finishSettleWait();
              return;
            }
          }
        }
        // max_turns may already be set on the activation snapshot from activate path.
        if (
          current?.activation?.id === activationId &&
          current.activation.terminalOverride === 'max_turns'
        ) {
          applyMaxTurnsTerminal(currentResult, agent);
          armSettleTimeout('max_turns');
        }
        // Abort may have fired during activate() before waitingForSettle was true.
        if (abortRequested || signal?.aborted) {
          armSettleTimeout('abort');
        }
      });
    }

    if (abortRequested || signal?.aborted) {
      const origin = resolveAbortOrigin(signal, options);
      // Prefer settled snapshot terminal when present, then abort override.
      if (settledSnapshot) {
        projectTerminalFromSettled(currentResult, settledSnapshot, agent);
      }
      finalizeAborted(currentResult, origin);
      emitTerminalSnapshot(onUpdate, currentResult, makeDetails);
      throw new AgentAbortError(currentResult, origin);
    }

    // Unified terminal projection from the settled snapshot (error/cancelled/max_turns).
    if (settledSnapshot) {
      projectTerminalFromSettled(currentResult, settledSnapshot, agent);
    } else {
      const finalSnap = registry.get(endpointKey);
      if (finalSnap) projectTerminalFromSettled(currentResult, finalSnap, agent);
    }

    if (currentResult.stopReason === 'max_turns') {
      applyTerminalStatus(currentResult);
      return currentResult;
    }

    applyTerminalStatus(currentResult);
    return currentResult;
  } catch (err) {
    if (err instanceof AgentAbortError) throw err;
    // max_turns settle timeout: still surface as max_turns when already projected.
    if (
      err instanceof Error &&
      /settle timeout after max_turns/i.test(err.message) &&
      currentResult.stopReason === 'max_turns'
    ) {
      applyTerminalStatus(currentResult);
      return currentResult;
    }
    currentResult.exitCode = 1;
    currentResult.status = 'failed';
    currentResult.errorMessage = err instanceof Error ? err.message : String(err);
    currentResult.stopReason = 'error';
    currentResult.stderr = currentResult.errorMessage;
    // Preserve structured codes from activation/open/load/dispose/prompt failures.
    const code = structuredErrorCode(err) ?? registry.get(endpointKey)?.errorCode;
    if (code) currentResult.errorCode = code;
    applyTerminalStatus(currentResult);
    return currentResult;
  } finally {
    waitingForSettle = false;
    clearSettleTimer();
    settleResolve = undefined;
    settleReject = undefined;
    earlyByActivation.clear();
    unsub();
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** Type helper for callers that need the tool result shape. */
export type PiRpcAgentToolResult = AgentToolResult<SubagentDetails>;
