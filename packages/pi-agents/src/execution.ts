// ABOUTME: Subprocess execution for the `agent` tool — concurrency limiter and single-agent run loop.
// ABOUTME: Dispatches to pi or grok-acp runtime and accumulates messages and stop reason.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import type { Readable } from 'node:stream';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import type { AgentConfig, Runtime } from './agents.ts';
import { GROK_ACP_RUNTIME } from './constants.ts';
import { GrokAcpClientError, runGrokAcpClient } from './grok-acp-client.ts';
import type { RunAbortOrigin } from './run-types.ts';
import { originToUnitStatus } from './run-lifecycle.ts';
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
  buildPiArgs,
  buildSessionContinuationPrompt,
  getPiInvocation,
  writePromptToTempFile,
} from './invocation.ts';
import { applyTerminalStatus, getFinalOutput } from './output.ts';
import type { UnitExecutionContext } from './run-coordinator.ts';
import { buildChildAgentEnv, isAgentDelegationAllowed } from './security.ts';
import {
  disposalCertaintyFromCaught,
  isDisposeFailedError,
  releaseSessionLeaseWithCertainty,
  type DisposalCertainty,
} from './session-lease.ts';
import { ABORT_MESSAGE, AgentAbortError, isAbortError } from './abort.ts';
import { emptyUsage } from './empty-usage.ts';
import { runSingleAgentInteractive } from './interactive-execution.ts';
import { runSingleAgentPiRpc } from './pi-rpc-execution.ts';
import { cloneSingleResult, type SingleResult, type SubagentDetails } from './types.ts';

export { ABORT_MESSAGE, AgentAbortError, getAbortResult, isAbortError } from './abort.ts';

/** True when Grok ACP SingleResult is a successful matching-prompt completion. */
function isGrokAcpSuccessfulCompletion(result: SingleResult): boolean {
  return (
    result.status === 'completed' &&
    result.stopReason === 'end' &&
    result.exitCode === 0 &&
    !result.errorMessage
  );
}

export interface SpawnedChild extends ChildProcess {
  stdout: Readable;
  stderr: Readable;
}

export type SpawnFn = (command: string, args: string[], options: object) => SpawnedChild;

/** Resume prompt metadata threaded from a durable resume into child invocation. */
export interface ResumePromptContext {
  /** Full durable continuation history (including the current call when already claimed). */
  continuationTasks: string[];
  /**
   * Continuations not yet confirmed delivered for this unit. Existing Pi sessions
   * receive only these (plus the fixed safety prompt). Prefer this over
   * `currentContinuationTask` when delivery tracking is active.
   */
  undeliveredContinuationTasks?: string[];
  /** Current call's continuation; used when undelivered list is not provided. */
  currentContinuationTask?: string;
}

export interface RunSingleAgentOptions {
  spawnFn?: SpawnFn;
  sessionFile?: string;
  resolvedSkillPaths?: string[];
  modelOverride?: string;
  thinkingOverride?: string;
  runtimeOverride?: Runtime;
  /** Short collapsed-summary label stamped onto every emitted result snapshot. */
  title?: string;
  /** Durable run/unit/attempt identity stamped onto every emitted snapshot. */
  unitContext?: UnitExecutionContext;
  /** Supplies the carried abort origin so terminal snapshots classify as cancelled/interrupted. */
  getAbortOrigin?: () => RunAbortOrigin;
  /** Host extension mode; TUI Pi units with a registry endpoint use RPC execution. */
  hostMode?: 'tui' | 'rpc' | 'json' | 'print';
  /** Interactive registry handle for TUI Pi RPC execution. */
  interactiveRegistry?: import('./interactive-agent.ts').InteractiveAgentRegistry;
  /** Endpoint key (`runId:unitId`) registered before spawn. */
  endpointKey?: string;
  /**
   * When set, this invocation is part of a durable resume. Existing Pi sessions
   * receive a session-continuation prompt; never-started units receive the
   * original task plus accumulated continuation tasks.
   */
  resumePrompt?: ResumePromptContext;
  /**
   * Explicit prompt-kind flag for resume. When true, send session-continuation
   * (unit already owned a stored session before this invocation). When false,
   * send original task + continuations even if a session file was just created.
   * Required for correct never-started unit resume after prepareAgentContext.
   */
  resumeHadStoredSession?: boolean;
  /** Called once the child has accepted the resume or original prompt (spawn or RPC activate). */
  onResumePromptAccepted?: () => void;
  /**
   * Awaited once Pi has accepted the unit's original (or fresh) prompt so durable
   * sessionPromptEstablished can be written. Write failure must fail-close the turn.
   * Not used for Grok ACP (session history after load is the authority).
   */
  onSessionPromptEstablished?: () => void | Promise<void>;
  /**
   * Awaited after session/new returns a non-empty ACP session ID and before the
   * first prompt. Used for durable disk-first session-ID persistence.
   */
  onAcpSessionEstablished?: (sessionId: string) => void | Promise<void>;
  /**
   * Grok ACP only: awaited after the matching prompt response (not dispatch accept).
   * Used for strict continuation-delivery persistence.
   */
  onAcpPromptCompleted?: () => void | Promise<void>;
  /**
   * Fresh TUI Grok ACP: after durable session ID + lease, register the live
   * transport on the interactive registry (binding/link) and return endpoint key.
   *
   * Ownership: caller keeps transport/lease until `acceptOwnership` runs
   * (synchronously after registry `beginPendingOwner`). Adapter may throw during
   * precompute before that call; caller catch still disposes.
   */
  registerGrokAcpLiveEndpoint?: (input: {
    sessionId: string;
    transport: import('./interactive-transport.ts').InteractiveAgentTransport;
    leaseRelease: (err?: Error) => void;
    /** Sync handoff: registry owns cleanup after this returns. */
    acceptOwnership: () => void;
  }) => Promise<string>;
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

export interface MapConcurrencyOptions<TIn, TOut> {
  signal?: AbortSignal;
  /** Fill slots that never started after scheduling stopped (abort / worker error). */
  onUnstarted?: (item: TIn, index: number) => TOut;
}

/**
 * Bounded concurrency map that never Promise.all fail-fasts.
 * On abort or worker error: stops claiming new items, waits for in-flight workers,
 * fills unstarted slots via onUnstarted, then rethrows the first error if any.
 */
export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
  options: MapConcurrencyOptions<TIn, TOut> = {}
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  const started = new Array<boolean>(items.length).fill(false);
  let nextIndex = 0;
  let stopScheduling = false;
  let firstError: unknown;

  const claim = (): number | null => {
    if (stopScheduling || options.signal?.aborted) {
      stopScheduling = true;
      return null;
    }
    const current = nextIndex++;
    if (current >= items.length) return null;
    started[current] = true;
    return current;
  };

  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const current = claim();
      if (current === null) return;
      try {
        results[current] = await fn(items[current], current);
      } catch (err) {
        if (firstError === undefined) firstError = err;
        stopScheduling = true;
      }
    }
  });

  await Promise.all(workers);

  if (options.onUnstarted) {
    for (let i = 0; i < items.length; i++) {
      if (!started[i] || results[i] === undefined) {
        if (results[i] === undefined) {
          results[i] = options.onUnstarted(items[i], i);
        }
      }
    }
  }

  if (firstError !== undefined) throw firstError;
  return results;
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

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

function resolveAbortOrigin(
  signal: AbortSignal | undefined,
  options: RunSingleAgentOptions
): RunAbortOrigin {
  const injected = options.getAbortOrigin?.();
  if (injected) return injected;
  // When Pi's incoming tool signal aborts with no coordinator-owned origin,
  // treat it as user-initiated; otherwise unknown (interrupted with diagnostic).
  return signal && signal.aborted ? 'user' : 'unknown';
}

function finalizeAborted(currentResult: SingleResult, origin: RunAbortOrigin): void {
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

function getWorkingDirectoryError(cwd: string): string | undefined {
  try {
    if (!fs.statSync(cwd).isDirectory()) {
      return `Cannot start agent: working directory is not a directory: ${cwd}`;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return `Cannot start agent: working directory does not exist: ${cwd}`;
    }
    const message = err instanceof Error ? err.message : String(err);
    return `Cannot start agent: cannot access working directory ${cwd}: ${message}`;
  }
  return undefined;
}

export async function runSingleAgent(
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
  const effectiveRuntime: Runtime | undefined = options.runtimeOverride ?? agent.runtime;
  const effectiveAgent: AgentConfig = {
    ...agent,
    model: effectiveModel,
    thinking: effectiveThinking,
    runtime: effectiveRuntime,
  };

  const workCwd = cwd ?? defaultCwd;
  const cwdError = getWorkingDirectoryError(workCwd);
  if (cwdError) {
    return {
      agent: agentName,
      agentSource: agent.source,
      task,
      title: options.title,
      exitCode: 1,
      status: 'failed',
      messages: [],
      stderr: cwdError,
      usage: emptyUsage(),
      model: effectiveModel,
      thinking: effectiveThinking,
      step,
      errorMessage: cwdError,
      stopReason: 'cwd_error',
    };
  }

  if (effectiveRuntime === GROK_ACP_RUNTIME) {
    return runSingleAgentGrokAcp(
      defaultCwd,
      agents,
      agentName,
      task,
      cwd,
      step,
      signal,
      onUpdate,
      makeDetails,
      options
    );
  }

  // TUI Pi units with a registered interactive endpoint run through RPC so they
  // remain steerable; JSON/print/RPC host modes keep the one-shot JSON path.
  // Static import (not dynamic): jiti loads extensions with moduleCache:false and
  // CJS interop; dynamic import under parallel runs re-entered a circular graph
  // and produced `undefined.emptyUsage` at pi-rpc-execution setup.
  if (
    options.hostMode === 'tui' &&
    options.interactiveRegistry &&
    options.endpointKey &&
    (options.sessionFile || options.unitContext?.sessionFile)
  ) {
    return runSingleAgentPiRpc(
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
      }
    );
  }

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

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

  const emitUpdate = () => emitRunningSnapshot(onUpdate, currentResult, makeDetails);

  // Resolve the prompt text for this invocation. Result metadata keeps the
  // original resolved task; only the argv / child prompt is rewritten.
  // Prefer the explicit resumeHadStoredSession flag so a session file created
  // for a never-started unit is not mistaken for a prior stored session.
  const resumePrompt = options.resumePrompt;
  const useSessionContinuation = Boolean(
    resumePrompt && (options.resumeHadStoredSession ?? Boolean(options.sessionFile))
  );
  const invocationTask =
    resumePrompt && !useSessionContinuation
      ? appendContinuationTasks(task, resumePrompt.continuationTasks)
      : task;

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
    }

    const childEnv = buildChildAgentEnv(process.env, { agent: effectiveAgent });
    const disableAgentTool = !isAgentDelegationAllowed(childEnv);
    const args = buildPiArgs(effectiveAgent, invocationTask, {
      tmpPromptPath: tmpPromptPath ?? undefined,
      sessionFile: options.sessionFile,
      disableAgentTool,
      resolvedSkillPaths: options.resolvedSkillPaths,
      ...(useSessionContinuation
        ? {
            prompt: {
              kind: 'session_continuation' as const,
              ...(resumePrompt?.undeliveredContinuationTasks !== undefined
                ? {
                    undeliveredContinuationTasks: resumePrompt.undeliveredContinuationTasks,
                  }
                : {}),
              ...(resumePrompt?.currentContinuationTask !== undefined
                ? { currentContinuationTask: resumePrompt.currentContinuationTask }
                : {}),
            },
          }
        : { prompt: { kind: 'task' as const } }),
    });
    let wasAborted = false;
    let maxTurnsExceeded = false;

    const invocation = getPiInvocation(args);
    const spawnFn = options.spawnFn ?? (spawn as unknown as SpawnFn);
    const proc = spawnFn(invocation.command, invocation.args, {
      cwd: cwd ?? defaultCwd,
      env: childEnv,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wire I/O before durable establishment so early stdout is not lost.
    const exitCodePromise = new Promise<number>((resolve) => {
      let buffer = '';
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let hasClosed = false;
      let settled = false;

      const flushBuffer = () => {
        if (buffer.trim()) {
          const remaining = buffer;
          buffer = '';
          processLine(remaining);
        }
      };

      const settle = (code: number) => {
        if (settled) return;
        settled = true;
        flushBuffer();
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        resolve(code);
      };

      const triggerMaxTurns = () => {
        if (maxTurnsExceeded || !agent.maxTurns) return;
        maxTurnsExceeded = true;
        currentResult.stopReason = 'max_turns';
        currentResult.errorMessage = `Agent exceeded maxTurns=${agent.maxTurns}`;
        proc.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (!hasClosed) proc.kill('SIGKILL');
        }, 5000);
      };

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (!event || typeof event !== 'object') return;
        const evt = event as { type?: string; message?: Message };

        if (evt.type === 'message_end' && evt.message) {
          const msg = evt.message;
          currentResult.messages.push(msg);

          if (msg.role === 'assistant') {
            currentResult.usage.turns++;
            const usage = msg.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && msg.model) currentResult.model = msg.model;
            if (!maxTurnsExceeded) {
              if (msg.stopReason) currentResult.stopReason = msg.stopReason;
              if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
            }
          }
          emitUpdate();

          if (
            msg.role === 'assistant' &&
            agent.maxTurns &&
            currentResult.usage.turns >= agent.maxTurns &&
            !maxTurnsExceeded
          ) {
            triggerMaxTurns();
          }
        }

        if (evt.type === 'tool_result_end' && evt.message) {
          currentResult.messages.push(evt.message);
          emitUpdate();
        }
      };

      proc.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) processLine(line);
      });

      proc.stderr.on('data', (data) => {
        currentResult.stderr += data.toString();
      });

      proc.on('close', (code) => {
        hasClosed = true;
        settle(maxTurnsExceeded ? (code ?? 1) : (code ?? 0));
      });

      proc.on('error', (err: Error) => {
        hasClosed = true;
        const message = err?.message || String(err);
        currentResult.stderr = currentResult.stderr
          ? `${currentResult.stderr}\n${message}`
          : message;
        currentResult.errorMessage = message;
        currentResult.stopReason = 'error';
        settle(1);
      });

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill('SIGTERM');
          setTimeout(() => {
            if (!proc.killed) proc.kill('SIGKILL');
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener('abort', killProc, { once: true });
      }
    });

    // Durable original-prompt establishment after spawn accepts argv. Write
    // failure fail-closes this turn (kill child, rethrow).
    try {
      await options.onSessionPromptEstablished?.();
    } catch (err) {
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      void exitCodePromise;
      throw err;
    }
    // Continuation delivery may remain fire-and-forget (separate deferred follow-up).
    options.onResumePromptAccepted?.();

    const exitCode = await exitCodePromise;

    if (maxTurnsExceeded && exitCode === 0) {
      currentResult.exitCode = 1;
    } else {
      currentResult.exitCode = exitCode;
    }
    if (wasAborted) {
      const origin = resolveAbortOrigin(signal, options);
      finalizeAborted(currentResult, origin);
      emitTerminalSnapshot(onUpdate, currentResult, makeDetails);
      throw new AgentAbortError(currentResult, origin);
    }
    applyTerminalStatus(currentResult);
    return currentResult;
  } finally {
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
  }
}

async function runSingleAgentGrokAcp(
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

  const emitUpdate = () => emitRunningSnapshot(onUpdate, currentResult, makeDetails);

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
    const { acquireSessionLease, buildSessionLeaseKey } = await import('./session-lease.ts');

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
          emitTerminalSnapshot(onUpdate, currentResult, makeDetails);
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
        emitTerminalSnapshot(onUpdate, currentResult, makeDetails);
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
        emitTerminalSnapshot(onUpdate, currentResult, makeDetails);
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
    emitTerminalSnapshot(onUpdate, currentResult, makeDetails);
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
  const { acquireSessionLease, buildSessionLeaseKey } = await import('./session-lease.ts');

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
