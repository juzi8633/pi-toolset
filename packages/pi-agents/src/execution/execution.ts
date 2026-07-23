// ABOUTME: Subprocess execution for the `agent` tool — concurrency limiter and single-agent run loop.
// ABOUTME: Dispatches to pi or grok-acp runtime and accumulates messages and stop reason.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Message } from '@earendil-works/pi-ai';
import type { AgentConfig, Runtime } from '../config/agents.ts';
import { GROK_ACP_RUNTIME, DEFAULT_KILL_TIMEOUT_MS } from '../shared/constants.ts';
import {
  appendContinuationTasks,
  buildPiArgs,
  getPiInvocation,
  resolveArtifactReaderExtensionPath,
  writePromptToTempFile,
} from './invocation.ts';
import { applyTerminalStatus } from '../output/output.ts';
import { buildChildAgentEnv, isAgentDelegationAllowed } from './security.ts';
import { AgentAbortError } from './abort.ts';
import { emptyUsage } from '../shared/empty-usage.ts';
import { runSingleAgentPiRpc } from '../runtime/pi-rpc/pi-rpc-execution.ts';
import { loadGrokAcpRuntime } from '../runtime/grok-acp/grok-acp-runtime-loader.ts';
import {
  emitRunningSnapshot,
  emitTerminalSnapshot,
  finalizeAborted,
  resolveAbortOrigin,
  stampUnitContext,
} from './execution-result.ts';
import type { OnUpdateCallback, RunSingleAgentOptions, SpawnFn } from './execution-types.ts';
import type { SingleResult, SubagentDetails } from '../shared/types.ts';

export { ABORT_MESSAGE, AgentAbortError, getAbortResult, isAbortError } from './abort.ts';
export type {
  OnUpdateCallback,
  ResumePromptContext,
  RunSingleAgentOptions,
  SpawnedChild,
  SpawnFn,
} from './execution-types.ts';

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
    const runtime = await loadGrokAcpRuntime();
    return runtime.runSingleAgentGrokAcp(
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

    const requireArtifactReader = options.unitContext?.requireArtifactReader === true;
    const childEnv = buildChildAgentEnv(process.env, {
      agent: effectiveAgent,
      ...(requireArtifactReader && options.unitContext?.runId && options.unitContext?.sessionsDir
        ? {
            runId: options.unitContext.runId,
            // sessionsDir is <runDir>/sessions — artifact root is the run dir.
            runArtifactDir: path.dirname(options.unitContext.sessionsDir),
          }
        : {}),
    });
    const disableAgentTool = !isAgentDelegationAllowed(childEnv);
    const args = buildPiArgs(effectiveAgent, invocationTask, {
      tmpPromptPath: tmpPromptPath ?? undefined,
      sessionFile: options.sessionFile,
      disableAgentTool,
      resolvedSkillPaths: options.resolvedSkillPaths,
      ...(requireArtifactReader
        ? {
            requireArtifactReader: true,
            artifactReaderExtensionPath: resolveArtifactReaderExtensionPath(),
          }
        : {}),
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
        }, DEFAULT_KILL_TIMEOUT_MS);
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
          // Parent live result retains only assistant messages. Raw tool-result bodies
          // stay in the child session when a reloadable identity exists; otherwise they
          // are intentionally released after execution.
          if (msg.role !== 'assistant') return;

          currentResult.messages.push(msg);
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
          emitUpdate();

          if (agent.maxTurns && currentResult.usage.turns >= agent.maxTurns && !maxTurnsExceeded) {
            triggerMaxTurns();
          }
        }

        // tool_result_end is intentionally ignored: raw tool-result bodies are not
        // retained in the parent live result (see message_end assistant-only path).
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
          }, DEFAULT_KILL_TIMEOUT_MS);
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
