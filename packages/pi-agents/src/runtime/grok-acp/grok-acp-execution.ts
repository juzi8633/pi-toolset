// ABOUTME: Grok ACP single-agent and fresh-TUI execution flows extracted from the static dispatcher.
// ABOUTME: Owns protocol, lease, persistence, terminal mapping, and transport ownership for Grok ACP.

import type { AgentConfig, Runtime } from '../../config/agents.ts';
import { RESULT_UPDATE_INTERVAL_MS } from '../../shared/constants.ts';
import { GrokAcpClientError, runGrokAcpClient } from './grok-acp-client.ts';
import {
  buildGrokAcpArgs,
  buildGrokAcpEnv,
  buildGrokAcpInitializeParams,
  buildGrokAcpSessionNewParams,
} from './grok-acp-invocation.ts';
import {
  createGrokAcpParserState,
  finalizeGrokAcpPrompt,
  handleGrokAcpSessionUpdate,
} from './grok-acp-parser.ts';
import { getGrokInvocation } from './grok-command.ts';
import {
  appendContinuationTasks,
  buildSessionContinuationPrompt,
} from '../../execution/invocation.ts';
import { applyTerminalStatus } from '../../output/output.ts';
import { buildChildAgentEnv } from '../../execution/security.ts';
import {
  disposalCertaintyFromCaught,
  isDisposeFailedError,
  releaseSessionLeaseWithCertainty,
  type DisposalCertainty,
} from '../../run/session-lease.ts';
import { AgentAbortError, isAbortError } from '../../execution/abort.ts';
import { emptyUsage } from '../../shared/empty-usage.ts';
import { runSingleAgentInteractive } from '../../interactive/interactive-execution.ts';
import {
  emitRunningSnapshot,
  emitTerminalSnapshot,
  finalizeAborted,
  resolveAbortOrigin,
  stampUnitContext,
} from '../../execution/execution-result.ts';
import type { OnUpdateCallback, RunSingleAgentOptions } from '../../execution/execution-types.ts';
import type { SingleResult, SubagentDetails } from '../../shared/types.ts';
import { createLatestValueCoalescer } from '../../shared/update-coalescer.ts';

/** True when Grok ACP SingleResult is a successful matching-prompt completion. */
function isGrokAcpSuccessfulCompletion(result: SingleResult): boolean {
  return (
    result.status === 'completed' &&
    result.stopReason === 'end' &&
    result.exitCode === 0 &&
    !result.errorMessage
  );
}

export async function runSingleAgentGrokAcp(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  options: RunSingleAgentOptions = {}
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName)!;

  const effectiveModel = options.modelOverride ?? agent.model;
  const effectiveThinking = options.thinkingOverride ?? agent.thinking;
  const effectiveRuntime: Runtime | undefined = options.runtimeOverride ?? agent.runtime;
  const effectiveAgent: AgentConfig = {
    ...agent,
    model: effectiveModel,
    thinking: effectiveThinking,
    runtime: effectiveRuntime,
  };

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

  // Initial running update is immediate; subsequent chunk updates are coalesced.
  // Terminal paths cancel pending content and emit one authoritative snapshot.
  let sentInitialRunning = false;
  const contentCoalescer = createLatestValueCoalescer<void>(() => {
    emitRunningSnapshot(onUpdate, currentResult, makeDetails);
  }, RESULT_UPDATE_INTERVAL_MS);
  const emitUpdate = () => {
    if (!sentInitialRunning) {
      sentInitialRunning = true;
      emitRunningSnapshot(onUpdate, currentResult, makeDetails);
      return;
    }
    contentCoalescer.schedule(undefined);
  };
  const emitTerminal = () => {
    contentCoalescer.cancel();
    emitTerminalSnapshot(onUpdate, currentResult, makeDetails);
  };

  // Prefer explicit resumeHadStoredSession so a session ID created during this
  // invocation is not mistaken for a prior stored ACP session.
  const resumePrompt = options.resumePrompt;
  const acpSessionId = options.unitContext?.acpSessionId?.trim();
  const useSessionLoad = Boolean(
    resumePrompt && (options.resumeHadStoredSession ?? Boolean(acpSessionId)) && acpSessionId
  );

  // Never-started resume: original task + all continuations.
  // Existing session: fixed continuation prompt + undelivered only.
  // Fresh (non-resume): original task.
  const invocationTask = useSessionLoad
    ? buildSessionContinuationPrompt(
        resumePrompt?.undeliveredContinuationTasks ??
          (resumePrompt?.currentContinuationTask ? [resumePrompt.currentContinuationTask] : [])
      )
    : resumePrompt
      ? appendContinuationTasks(task, resumePrompt.continuationTasks)
      : task;

  const parserState = createGrokAcpParserState(effectiveModel);
  const workCwd = cwd ?? defaultCwd;
  const childEnv = buildGrokAcpEnv(buildChildAgentEnv(process.env, { agent: effectiveAgent }));
  const args = buildGrokAcpArgs(effectiveAgent);
  const invocation = getGrokInvocation(args);

  const deliveryAfterPrompt = async (): Promise<void> => {
    if (options.onAcpPromptCompleted) {
      await options.onAcpPromptCompleted();
    }
  };

  // TUI with a registered interactive endpoint: registry is the sole reducer.
  if (options.hostMode === 'tui' && options.interactiveRegistry && options.endpointKey) {
    return runSingleAgentInteractive(
      defaultCwd,
      agents,
      agentName,
      task,
      cwd,
      step,
      signal,
      onUpdate,
      makeDetails,
      {
        ...options,
        interactiveRegistry: options.interactiveRegistry,
        endpointKey: options.endpointKey,
        hostMode: 'tui',
        runtime: 'grok-acp',
        onAcpPromptCompleted: options.onAcpPromptCompleted,
      }
    );
  }

  // Fresh TUI without endpoint yet: create transport → ID flush → register live → prompt.
  // Registry/transport is the only reducer; no one-shot facade dual-owner.
  if (
    options.hostMode === 'tui' &&
    options.interactiveRegistry &&
    options.unitContext &&
    !options.endpointKey &&
    !useSessionLoad
  ) {
    return runFreshTuiGrokAcp(
      defaultCwd,
      agents,
      agentName,
      task,
      cwd,
      step,
      signal,
      onUpdate,
      makeDetails,
      options,
      {
        effectiveAgent,
        effectiveModel: effectiveModel ?? '',
        workCwd,
        invocationTask,
        currentResult,
      }
    );
  }

  try {
    const { openGrokAcpConnection } = await import('./grok-acp-client.ts');
    const { buildGrokAcpSessionLoadParams } = await import('./grok-acp-invocation.ts');
    const { createGrokAcpTranscriptProjector } = await import('./grok-acp-transcript.ts');
    const { acquireSessionLease, buildSessionLeaseKey } =
      await import('../../run/session-lease.ts');

    if (useSessionLoad && acpSessionId) {
      // Durable non-TUI resume: lease before spawn → load → barrier → continuation.
      const leaseKey = buildSessionLeaseKey({
        runtime: 'grok-acp',
        cwd: workCwd,
        sessionIdentity: acpSessionId,
      });
      const lease = await acquireSessionLease(leaseKey);
      const loadProjector = createGrokAcpTranscriptProjector({ configuredModel: effectiveModel });
      let connection: Awaited<ReturnType<typeof openGrokAcpConnection>> | undefined;
      try {
        connection = await openGrokAcpConnection({
          command: invocation.command,
          args: invocation.args,
          cwd: workCwd,
          env: childEnv,
          spawnFn: options.spawnFn as never,
          signal,
          initializeParams: buildGrokAcpInitializeParams(),
          onSessionUpdate: (notification, phase) => {
            if (phase === 'load') {
              loadProjector.handleSessionUpdate(notification, phase);
              return;
            }
            if (phase === 'prompt') {
              handleGrokAcpSessionUpdate(notification, currentResult, parserState, emitUpdate);
            }
          },
        });
        await connection.loadSession(buildGrokAcpSessionLoadParams(acpSessionId, workCwd));
        loadProjector.finalizeLoadBarrier();
        if (!loadProjector.hasUserHistory) {
          throw new GrokAcpClientError(
            'load',
            'Loaded ACP session has no replayed user history (acp_session_history_empty)',
            connection.stderr,
            'acp_session_history_empty'
          );
        }
        currentResult.acpSessionId = acpSessionId;
        const dispatch = connection.prompt(invocationTask);
        await dispatch.accepted;
        const completion = await dispatch.completed;
        currentResult.stderr = connection.stderr;
        const wasAborted = connection.wasAborted || completion.source === 'cancel_grace';
        // Structured terminal mapping before any delivery decision.
        finalizeGrokAcpPrompt(
          currentResult,
          completion.response.stopReason,
          completion.response._meta as Record<string, unknown> | null | undefined,
          parserState,
          { wasAborted },
          emitUpdate
        );
        if (wasAborted) {
          const exitCode = await connection.dispose();
          lease.release();
          if (currentResult.exitCode === 0 && exitCode !== 0) {
            currentResult.exitCode = exitCode;
          }
          const origin = resolveAbortOrigin(signal, options);
          finalizeAborted(currentResult, origin);
          emitTerminal();
          throw new AgentAbortError(currentResult, origin);
        }
        if (currentResult.stopReason === 'end') {
          currentResult.exitCode = 0;
        }
        applyTerminalStatus(currentResult);
        // Delivery only for matching response + final successful completed.
        if (completion.source === 'response' && isGrokAcpSuccessfulCompletion(currentResult)) {
          await deliveryAfterPrompt();
        }
        const exitCode = await connection.dispose();
        lease.release();
        if (currentResult.stopReason === 'end') {
          currentResult.exitCode = 0;
        } else if (currentResult.exitCode === 0 && exitCode !== 0) {
          currentResult.exitCode = exitCode;
        }
        // Discard pending running content; emit one authoritative terminal snapshot.
        // Terminal state is also returned via the result for durable/parent finalization.
        emitTerminal();
        return currentResult;
      } catch (err) {
        let certainty: DisposalCertainty;
        if (connection) {
          try {
            await connection.dispose();
            certainty = { kind: 'confirmed' };
          } catch (disposeErr) {
            const de = disposeErr instanceof Error ? disposeErr : new Error(String(disposeErr));
            releaseSessionLeaseWithCertainty(lease.release, { kind: 'failed', error: de });
            if (isDisposeFailedError(disposeErr)) throw disposeErr;
            throw err;
          }
        } else {
          // open may have spawned then failed cleanup (dispose_failed) without
          // returning a handle — never assume !connection ⇒ never spawned.
          certainty = disposalCertaintyFromCaught(err);
        }
        releaseSessionLeaseWithCertainty(lease.release, certainty);
        throw err;
      }
    }

    // Fresh / never-started non-TUI: session/new with lease after ID, before persist/prompt.
    let heldLease: { release: (err?: Error) => void } | undefined;
    try {
      const acpResult = await runGrokAcpClient({
        command: invocation.command,
        args: invocation.args,
        cwd: workCwd,
        env: childEnv,
        spawnFn: options.spawnFn as never,
        signal,
        initializeParams: buildGrokAcpInitializeParams(),
        sessionNewParams: buildGrokAcpSessionNewParams(workCwd, effectiveAgent),
        task: invocationTask,
        onSessionEstablished: async (sessionId) => {
          // Acquire process-global lease after ID, before durable flush / prompt.
          // On persist failure keep the lease held: the process is still alive and
          // the facade will dispose; outer catch settles the lease with certainty.
          const leaseKey = buildSessionLeaseKey({
            runtime: 'grok-acp',
            cwd: workCwd,
            sessionIdentity: sessionId,
          });
          heldLease = await acquireSessionLease(leaseKey);
          const persist = options.onAcpSessionEstablished;
          if (persist) await persist(sessionId);
          // Only after disk-first persist succeeds, stamp live result/context.
          currentResult.acpSessionId = sessionId;
          if (options.unitContext) {
            options.unitContext.acpSessionId = sessionId;
          }
        },
        onSessionUpdate: (notification) => {
          handleGrokAcpSessionUpdate(notification, currentResult, parserState, emitUpdate);
        },
      });

      currentResult.stderr = acpResult.stderr;
      if (acpResult.sessionId) {
        currentResult.acpSessionId = acpResult.sessionId;
        if (options.unitContext) options.unitContext.acpSessionId = acpResult.sessionId;
      }
      finalizeGrokAcpPrompt(
        currentResult,
        acpResult.promptResponse.stopReason,
        acpResult.promptResponse._meta as Record<string, unknown> | null | undefined,
        parserState,
        { wasAborted: acpResult.wasAborted },
        emitUpdate
      );

      // Successful ACP prompt completion is treated as process success even when
      // the long-lived agent exits non-zero during shutdown cleanup.
      if (currentResult.stopReason === 'end') {
        currentResult.exitCode = 0;
      } else if (currentResult.exitCode === 0 && acpResult.exitCode !== 0) {
        currentResult.exitCode = acpResult.exitCode;
      }

      if (acpResult.wasAborted) {
        if (heldLease) {
          heldLease.release();
          heldLease = undefined;
        }
        const origin = resolveAbortOrigin(signal, options);
        finalizeAborted(currentResult, origin);
        emitTerminal();
        throw new AgentAbortError(currentResult, origin);
      }
      applyTerminalStatus(currentResult);
      // Delivery only after terminal mapping: matching response + final success.
      if (
        acpResult.promptCompletionSource === 'response' &&
        isGrokAcpSuccessfulCompletion(currentResult)
      ) {
        await deliveryAfterPrompt();
      }

      if (heldLease) {
        heldLease.release();
        heldLease = undefined;
      }
      // Discard pending running content; emit one authoritative terminal snapshot.
      // Terminal state is also returned via the result for durable/parent finalization.
      emitTerminal();
      return currentResult;
    } catch (err) {
      if (heldLease) {
        // Facade already disposed (or failed dispose). Settle lease with certainty.
        releaseSessionLeaseWithCertainty(heldLease.release, disposalCertaintyFromCaught(err));
        heldLease = undefined;
      }
      throw err;
    }
  } catch (err) {
    if (isAbortError(err)) {
      if (!(err instanceof AgentAbortError)) {
        const origin = resolveAbortOrigin(signal, options);
        finalizeAborted(currentResult, origin);
        emitTerminal();
        throw new AgentAbortError(currentResult, origin);
      }
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    currentResult.stopReason = 'error';
    currentResult.exitCode = 1;
    currentResult.errorMessage = message;
    if (err instanceof GrokAcpClientError) {
      currentResult.stderr = err.stderr || currentResult.stderr;
      // Structured code for callers/UI (session not found, cwd mismatch, dispose, …).
      if (err.code) {
        currentResult.errorCode = err.code;
      }
      if (err.code === 'dispose_failed') {
        currentResult.errorMessage = message;
      } else if (!currentResult.errorMessage.startsWith('Grok ACP')) {
        currentResult.errorMessage = `Grok ACP ${err.stage} failed: ${message}`;
      }
    } else if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      typeof (err as { code?: unknown }).code === 'string'
    ) {
      currentResult.errorCode = (err as { code: string }).code;
      if (!currentResult.stderr) currentResult.stderr = message;
    } else if (!currentResult.stderr) {
      currentResult.stderr = message;
    }
    applyTerminalStatus(currentResult);
    emitTerminal();
    return currentResult;
  }
}

/**
 * Fresh TUI Grok ACP: provisional transport → session/new → lease → ID flush →
 * binding/link registration with the same live transport → first prompt via registry.
 */
async function runFreshTuiGrokAcp(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  options: RunSingleAgentOptions,
  ctx: {
    effectiveAgent: AgentConfig;
    effectiveModel: string;
    workCwd: string;
    invocationTask: string;
    currentResult: SingleResult;
  }
): Promise<SingleResult> {
  const registry = options.interactiveRegistry!;
  const unitCtx = options.unitContext!;
  const { GrokAcpInteractiveTransport } = await import('./grok-acp-interactive-transport.ts');
  const { acquireSessionLease, buildSessionLeaseKey } = await import('../../run/session-lease.ts');

  let leaseRelease: ((err?: Error) => void) | undefined;
  let transport: InstanceType<typeof GrokAcpInteractiveTransport> | undefined;

  try {
    transport = new GrokAcpInteractiveTransport({
      agent: ctx.effectiveAgent,
      cwd: ctx.workCwd,
      spawnFn: options.spawnFn as never,
      signal,
      configuredModel: ctx.effectiveModel,
      onSessionEstablished: async (sessionId) => {
        // Keep lease held through persist failures; process is live until dispose.
        const leaseKey = buildSessionLeaseKey({
          runtime: 'grok-acp',
          cwd: ctx.workCwd,
          sessionIdentity: sessionId,
        });
        const lease = await acquireSessionLease(leaseKey);
        leaseRelease = lease.release;
        if (options.onAcpSessionEstablished) {
          await options.onAcpSessionEstablished(sessionId);
        }
        ctx.currentResult.acpSessionId = sessionId;
        unitCtx.acpSessionId = sessionId;
      },
    });
    await transport.start();
    const sessionId = transport.getSessionId();
    if (!sessionId) {
      throw new GrokAcpClientError('session', 'session/new returned an empty sessionId', '');
    }
    if (!leaseRelease) {
      const lease = await acquireSessionLease(
        buildSessionLeaseKey({
          runtime: 'grok-acp',
          cwd: ctx.workCwd,
          sessionIdentity: sessionId,
        })
      );
      leaseRelease = lease.release;
    }

    const registerLive = options.registerGrokAcpLiveEndpoint;
    if (!registerLive) {
      throw new Error(
        'Fresh TUI Grok ACP requires registerGrokAcpLiveEndpoint after session ID persistence'
      );
    }

    // Keep local ownership until acceptOwnership (sync, after beginPendingOwner).
    // Adapter precompute may throw before that; this catch still disposes once.
    // After acceptOwnership, registry alone disposes — local handles are cleared.
    const endpointKey = await registerLive({
      sessionId,
      transport: transport!,
      leaseRelease: leaseRelease!,
      acceptOwnership: () => {
        transport = undefined;
        leaseRelease = undefined;
      },
    });

    return runSingleAgentInteractive(
      defaultCwd,
      agents,
      agentName,
      task,
      cwd,
      step,
      signal,
      onUpdate,
      makeDetails,
      {
        ...options,
        interactiveRegistry: registry,
        endpointKey,
        hostMode: 'tui',
        runtime: 'grok-acp',
        onAcpPromptCompleted: options.onAcpPromptCompleted,
        unitContext: unitCtx,
      }
    );
  } catch (err) {
    let certainty: DisposalCertainty;
    if (transport) {
      try {
        await transport.dispose();
        certainty = { kind: 'confirmed' };
      } catch (disposeErr) {
        certainty = {
          kind: 'failed',
          error: disposeErr instanceof Error ? disposeErr : new Error(String(disposeErr)),
        };
      }
    } else {
      // start()/factory may have spawned then failed without assigning transport.
      certainty = disposalCertaintyFromCaught(err);
    }
    releaseSessionLeaseWithCertainty(leaseRelease, certainty);
    // Prefer sticky dispose_failed over the original business error.
    if (certainty.kind === 'failed') {
      ctx.currentResult.stopReason = 'error';
      ctx.currentResult.exitCode = 1;
      ctx.currentResult.errorMessage = certainty.error.message;
      ctx.currentResult.errorCode = 'dispose_failed';
      applyTerminalStatus(ctx.currentResult);
      emitTerminalSnapshot(onUpdate, ctx.currentResult, makeDetails);
      return ctx.currentResult;
    }
    if (isAbortError(err)) {
      const origin = resolveAbortOrigin(signal, options);
      finalizeAborted(ctx.currentResult, origin);
      emitTerminalSnapshot(onUpdate, ctx.currentResult, makeDetails);
      throw new AgentAbortError(ctx.currentResult, origin);
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.currentResult.stopReason = 'error';
    ctx.currentResult.exitCode = 1;
    ctx.currentResult.errorMessage = message;
    // Fresh TUI catch: preserve GrokAcpClientError and any structured {code}.
    if (err instanceof GrokAcpClientError && err.code) {
      ctx.currentResult.errorCode = err.code;
    } else if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      typeof (err as { code?: unknown }).code === 'string'
    ) {
      ctx.currentResult.errorCode = (err as { code: string }).code;
    }
    applyTerminalStatus(ctx.currentResult);
    emitTerminalSnapshot(onUpdate, ctx.currentResult, makeDetails);
    return ctx.currentResult;
  }
}
