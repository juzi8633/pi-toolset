// ABOUTME: Subprocess execution for the `agent` tool — concurrency limiter and single-agent run loop.
// ABOUTME: Dispatches to pi, grok, or grok-acp runtime and accumulates messages and stop reason.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import type { Readable } from 'node:stream';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import type { AgentConfig, Runtime } from './agents.ts';
import { GROK_ACP_RUNTIME, GROK_RUNTIME } from './constants.ts';
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
import { buildGrokArgs, getGrokInvocation } from './grok-invocation.ts';
import { createGrokParserState, parseGrokEvent } from './grok-parser.ts';
import { buildPiArgs, getPiInvocation, writePromptToTempFile } from './invocation.ts';
import { applyTerminalStatus, getFinalOutput } from './output.ts';
import { buildChildAgentEnv, isAgentDelegationAllowed } from './security.ts';
import { cloneSingleResult, emptyUsage, type SingleResult, type SubagentDetails } from './types.ts';

export interface SpawnedChild extends ChildProcess {
  stdout: Readable;
  stderr: Readable;
}

export type SpawnFn = (command: string, args: string[], options: object) => SpawnedChild;

export interface RunSingleAgentOptions {
  spawnFn?: SpawnFn;
  sessionFile?: string;
  resolvedSkillPaths?: string[];
  modelOverride?: string;
  thinkingOverride?: string;
  runtimeOverride?: Runtime;
  /** Short collapsed-summary label stamped onto every emitted result snapshot. */
  title?: string;
}

export const ABORT_MESSAGE = 'Subagent was aborted';

/** Abort error that carries a deep-cloned terminal SingleResult snapshot. */
export class AgentAbortError extends Error {
  readonly result: SingleResult;

  constructor(result: SingleResult) {
    super(ABORT_MESSAGE);
    this.name = 'AgentAbortError';
    this.result = cloneSingleResult(result);
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

function finalizeCancelled(currentResult: SingleResult): void {
  currentResult.stopReason = currentResult.stopReason ?? 'aborted';
  currentResult.status = 'cancelled';
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

  if (effectiveRuntime === GROK_RUNTIME) {
    return runSingleAgentGrok(
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

  const emitUpdate = () => emitRunningSnapshot(onUpdate, currentResult, makeDetails);

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
    }

    const childEnv = buildChildAgentEnv(process.env, { agent: effectiveAgent });
    const disableAgentTool = !isAgentDelegationAllowed(childEnv);
    const args = buildPiArgs(effectiveAgent, task, {
      tmpPromptPath: tmpPromptPath ?? undefined,
      sessionFile: options.sessionFile,
      disableAgentTool,
      resolvedSkillPaths: options.resolvedSkillPaths,
    });
    let wasAborted = false;
    let maxTurnsExceeded = false;

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const spawnFn = options.spawnFn ?? (spawn as unknown as SpawnFn);
      const proc = spawnFn(invocation.command, invocation.args, {
        cwd: cwd ?? defaultCwd,
        env: childEnv,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
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

    if (maxTurnsExceeded && exitCode === 0) {
      currentResult.exitCode = 1;
    } else {
      currentResult.exitCode = exitCode;
    }
    if (wasAborted) {
      finalizeCancelled(currentResult);
      emitTerminalSnapshot(onUpdate, currentResult, makeDetails);
      throw new AgentAbortError(currentResult);
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

async function runSingleAgentGrok(
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

  const emitUpdate = () => emitRunningSnapshot(onUpdate, currentResult, makeDetails);

  const childEnv = buildChildAgentEnv(process.env, { agent: effectiveAgent });
  const args = buildGrokArgs(effectiveAgent, task, {
    resolvedSkillPaths: options.resolvedSkillPaths,
  });

  let wasAborted = false;

  const exitCode = await new Promise<number>((resolve) => {
    const invocation = getGrokInvocation(args);
    const spawnFn = options.spawnFn ?? (spawn as unknown as SpawnFn);
    const proc = spawnFn(invocation.command, invocation.args, {
      cwd: cwd ?? defaultCwd,
      env: childEnv,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffer = '';
    let hasClosed = false;
    let settled = false;
    const parserState = createGrokParserState();

    const flushBuffer = () => {
      if (buffer.trim()) {
        const remaining = buffer;
        buffer = '';
        parseGrokEvent(remaining, currentResult, emitUpdate, parserState);
      }
    };

    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      flushBuffer();
      resolve(code);
    };

    proc.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) parseGrokEvent(line, currentResult, emitUpdate, parserState);
    });

    proc.stderr.on('data', (data) => {
      currentResult.stderr += data.toString();
    });

    proc.on('close', (code) => {
      hasClosed = true;
      settle(code ?? 0);
    });

    proc.on('error', (err: Error) => {
      hasClosed = true;
      const message = err?.message || String(err);
      currentResult.stderr = currentResult.stderr ? `${currentResult.stderr}\n${message}` : message;
      currentResult.errorMessage = message;
      currentResult.stopReason = 'error';
      settle(1);
    });

    if (signal) {
      const killProc = () => {
        wasAborted = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!hasClosed) proc.kill('SIGKILL');
        }, 5000);
      };
      if (signal.aborted) killProc();
      else signal.addEventListener('abort', killProc, { once: true });
    }
  });

  currentResult.exitCode = exitCode;
  if (currentResult.stopReason === 'max_turns' && !currentResult.errorMessage) {
    currentResult.errorMessage = agent.maxTurns
      ? `Agent exceeded maxTurns=${agent.maxTurns}`
      : 'Agent exceeded max turns';
  }
  if (wasAborted) {
    finalizeCancelled(currentResult);
    emitTerminalSnapshot(onUpdate, currentResult, makeDetails);
    throw new AgentAbortError(currentResult);
  }
  applyTerminalStatus(currentResult);
  return currentResult;
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

  const emitUpdate = () => emitRunningSnapshot(onUpdate, currentResult, makeDetails);

  const parserState = createGrokAcpParserState(effectiveModel);
  const workCwd = cwd ?? defaultCwd;
  const childEnv = buildGrokAcpEnv(buildChildAgentEnv(process.env, { agent: effectiveAgent }));
  const args = buildGrokAcpArgs(effectiveAgent);
  const invocation = getGrokInvocation(args);

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
      task,
      onSessionUpdate: (notification) => {
        handleGrokAcpSessionUpdate(notification, currentResult, parserState, emitUpdate);
      },
    });

    currentResult.stderr = acpResult.stderr;
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
      finalizeCancelled(currentResult);
      emitTerminalSnapshot(onUpdate, currentResult, makeDetails);
      throw new AgentAbortError(currentResult);
    }
    applyTerminalStatus(currentResult);
    return currentResult;
  } catch (err) {
    if (isAbortError(err)) {
      if (!(err instanceof AgentAbortError)) {
        finalizeCancelled(currentResult);
        emitTerminalSnapshot(onUpdate, currentResult, makeDetails);
        throw new AgentAbortError(currentResult);
      }
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    currentResult.stopReason = 'error';
    currentResult.exitCode = 1;
    currentResult.errorMessage = message;
    if (err instanceof GrokAcpClientError) {
      currentResult.stderr = err.stderr || currentResult.stderr;
      if (!currentResult.errorMessage.startsWith('Grok ACP')) {
        currentResult.errorMessage = `Grok ACP ${err.stage} failed: ${message}`;
      }
    } else if (!currentResult.stderr) {
      currentResult.stderr = message;
    }
    applyTerminalStatus(currentResult);
    emitTerminalSnapshot(onUpdate, currentResult, makeDetails);
    return currentResult;
  }
}
