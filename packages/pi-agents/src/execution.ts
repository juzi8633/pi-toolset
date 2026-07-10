// ABOUTME: Subprocess execution for the `agent` tool — concurrency limiter and single-agent run loop.
// ABOUTME: Dispatches to pi or grok runtime, consumes JSON/NDJSON streams, accumulates messages and stop reason.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import type { Readable } from 'node:stream';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import type { AgentConfig, Runtime } from './agents.ts';
import { GROK_RUNTIME } from './constants.ts';
import { buildGrokArgs, getGrokInvocation } from './grok-invocation.ts';
import { parseGrokEvent } from './grok-parser.ts';
import { buildPiArgs, getPiInvocation, writePromptToTempFile } from './invocation.ts';
import { getFinalOutput } from './output.ts';
import { buildChildAgentEnv, isAgentDelegationAllowed } from './security.ts';
import type { SingleResult, SubagentDetails } from './types.ts';

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
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

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
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      step,
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
    exitCode: 0,
    messages: [],
    stderr: '',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model: effectiveModel,
    thinking: effectiveThinking,
    step,
  };

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: 'text', text: getFinalOutput(currentResult.messages) || '(running...)' }],
        details: makeDetails([currentResult]),
      });
    }
  };

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
    if (wasAborted) throw new Error('Subagent was aborted');
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
    exitCode: 0,
    messages: [],
    stderr: '',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model: effectiveModel,
    thinking: effectiveThinking,
    step,
  };

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: 'text', text: getFinalOutput(currentResult.messages) || '(running...)' }],
        details: makeDetails([currentResult]),
      });
    }
  };

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

    const flushBuffer = () => {
      if (buffer.trim()) {
        const remaining = buffer;
        buffer = '';
        parseGrokEvent(remaining, currentResult, emitUpdate);
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
      for (const line of lines) parseGrokEvent(line, currentResult, emitUpdate);
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
  if (wasAborted) throw new Error('Subagent was aborted');
  return currentResult;
}
