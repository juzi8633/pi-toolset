// ABOUTME: Execution tests focused on maxTurns enforcement via an injected fake child process.
// ABOUTME: Emits message_end events on a controllable stdout stream and asserts stop reason + kill behavior.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import type { AgentConfig } from '../../src/config/agents.ts';
import { RESULT_UPDATE_INTERVAL_MS } from '../../src/shared/constants.ts';
import type { SpawnFn, SpawnedChild } from '../../src/execution/execution.ts';
import { AgentAbortError, mapWithConcurrencyLimit, runSingleAgent } from '../../src/execution/execution.ts';
import { getResultFinalOutput } from '../../src/output/output.ts';
import type { SingleResult, SubagentDetails } from '../../src/shared/types.ts';

class FakeChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  killed = false;
  killSignals: NodeJS.Signals[] = [];

  emitAssistant(text = 'turn output') {
    const message = {
      role: 'assistant',
      model: 'fake-model',
      content: [{ type: 'text', text }],
      usage: { input: 10, output: 10, totalTokens: 20 },
    };
    this.stdout.push(JSON.stringify({ type: 'message_end', message }) + '\n');
  }

  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.killSignals.push(signal);
    this.killed = true;
    this.stdout.push(null);
    this.stderr.push(null);
    setImmediate(() => this.emit('close', 1));
    return true;
  }
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'maxie',
    description: 'test',
    systemPrompt: '',
    source: 'builtin',
    filePath: '/tmp/maxie.md',
    ...overrides,
  };
}

const makeDetails = (results: SingleResult[]): SubagentDetails => ({
  mode: 'single',
  agentScope: 'user',
  projectAgentsDir: null,
  builtinAgentsDir: '/tmp',
  results,
});

describe('runSingleAgent agent capability propagation', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const piAgentKeys = [
    'PI_AGENT_CHILD',
    'PI_AGENT_DEPTH',
    'PI_AGENT_MAX_DEPTH',
    'PI_AGENT_TOOL_AVAILABLE',
  ] as const;

  beforeEach(() => {
    for (const key of piAgentKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of piAgentKeys) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function captureSpawn(): {
    fake: FakeChild;
    spawnFn: SpawnFn;
    captured: { args: string[]; env: NodeJS.ProcessEnv | undefined };
  } {
    const fake = new FakeChild();
    const captured = {
      args: [] as string[],
      env: undefined as NodeJS.ProcessEnv | undefined,
    };
    const spawnFn: SpawnFn = ((
      _command: string,
      args: string[],
      opts: { env?: NodeJS.ProcessEnv }
    ) => {
      captured.args = args;
      captured.env = opts.env;
      return fake as unknown as SpawnedChild;
    }) as SpawnFn;
    return { fake, spawnFn, captured };
  }

  async function runOnce(agent: AgentConfig, captured: ReturnType<typeof captureSpawn>) {
    const promise = runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'do work',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      { spawnFn: captured.spawnFn }
    );
    setImmediate(() => {
      captured.fake.stdout.push(null);
      captured.fake.stderr.push(null);
      captured.fake.emit('close', 0);
    });
    return promise;
  }

  it('blocks delegation and excludes the agent tool when maxSubagentDepth is 0', async () => {
    const ctx = captureSpawn();
    const agent = makeAgent({ name: 'no-fanout', maxSubagentDepth: 0 });
    await runOnce(agent, ctx);
    expect(ctx.captured.env?.PI_AGENT_DEPTH).toBe('1');
    expect(ctx.captured.env?.PI_AGENT_MAX_DEPTH).toBe('1');
    expect(ctx.captured.env?.PI_AGENT_TOOL_AVAILABLE).toBe('0');
    expect(ctx.captured.args).toContain('--exclude-tools');
    const idx = ctx.captured.args.indexOf('--exclude-tools');
    expect(ctx.captured.args[idx + 1]).toBe('agent');
  });

  it('blocks delegation when tools allowlist omits agent', async () => {
    const ctx = captureSpawn();
    const agent = makeAgent({ name: 'read-only', tools: ['read'] });
    await runOnce(agent, ctx);
    expect(ctx.captured.env?.PI_AGENT_TOOL_AVAILABLE).toBe('0');
    const idx = ctx.captured.args.indexOf('--exclude-tools');
    expect(idx).toBeGreaterThan(-1);
    expect(ctx.captured.args[idx + 1]).toBe('agent');
  });

  it('allows delegation when agent declares tools that include agent', async () => {
    const ctx = captureSpawn();
    const agent = makeAgent({ name: 'fan', tools: ['agent', 'read'] });
    await runOnce(agent, ctx);
    expect(ctx.captured.env?.PI_AGENT_TOOL_AVAILABLE).toBe('1');
    // No forced exclusion appended.
    const idx = ctx.captured.args.indexOf('--exclude-tools');
    expect(idx).toBe(-1);
  });

  it('forwards resolvedSkillPaths to spawn args as --no-skills + --skill', async () => {
    const ctx = captureSpawn();
    const agent = makeAgent({ name: 'skilled' });
    const promise = runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'do work',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      { spawnFn: ctx.spawnFn, resolvedSkillPaths: ['/abs/a/SKILL.md', '/abs/b/SKILL.md'] }
    );
    setImmediate(() => {
      ctx.fake.stdout.push(null);
      ctx.fake.stderr.push(null);
      ctx.fake.emit('close', 0);
    });
    await promise;
    expect(ctx.captured.args).toContain('--no-skills');
    const skillValues = ctx.captured.args.filter(
      (_, i) => i > 0 && ctx.captured.args[i - 1] === '--skill'
    );
    expect(skillValues).toEqual(['/abs/a/SKILL.md', '/abs/b/SKILL.md']);
  });
});

describe('runSingleAgent model/thinking overrides', () => {
  function captureSpawn(): {
    fake: FakeChild;
    spawnFn: SpawnFn;
    captured: { args: string[] };
  } {
    const fake = new FakeChild();
    const captured = { args: [] as string[] };
    const spawnFn: SpawnFn = ((_command: string, args: string[]) => {
      captured.args = args;
      return fake as unknown as SpawnedChild;
    }) as SpawnFn;
    return { fake, spawnFn, captured };
  }

  async function runOnce(agent: AgentConfig, options: Parameters<typeof runSingleAgent>[9] = {}) {
    const ctx = captureSpawn();
    const promise = runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'do work',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      { spawnFn: ctx.spawnFn, ...options }
    );
    setImmediate(() => {
      ctx.fake.stdout.push(null);
      ctx.fake.stderr.push(null);
      ctx.fake.emit('close', 0);
    });
    const result = await promise;
    return { result, captured: ctx.captured };
  }

  it('forwards modelOverride/thinkingOverride as --model/--thinking when the agent has none', async () => {
    const { captured, result } = await runOnce(makeAgent(), {
      modelOverride: 'gpt-5',
      thinkingOverride: 'high',
    });
    expect(captured.args).toContain('--model');
    expect(captured.args[captured.args.indexOf('--model') + 1]).toBe('gpt-5');
    expect(captured.args).toContain('--thinking');
    expect(captured.args[captured.args.indexOf('--thinking') + 1]).toBe('high');
    expect(result.model).toBe('gpt-5');
    expect(result.thinking).toBe('high');
  });

  it('override takes precedence over the agent config model/thinking', async () => {
    const { captured, result } = await runOnce(
      makeAgent({ model: 'claude-haiku-4-5', thinking: 'low' }),
      { modelOverride: 'gpt-5', thinkingOverride: 'high' }
    );
    expect(captured.args[captured.args.indexOf('--model') + 1]).toBe('gpt-5');
    expect(captured.args[captured.args.indexOf('--thinking') + 1]).toBe('high');
    expect(result.model).toBe('gpt-5');
    expect(result.thinking).toBe('high');
  });

  it('falls back to the agent config when no override is given', async () => {
    const { captured, result } = await runOnce(
      makeAgent({ model: 'claude-haiku-4-5', thinking: 'medium' })
    );
    expect(captured.args[captured.args.indexOf('--model') + 1]).toBe('claude-haiku-4-5');
    expect(captured.args[captured.args.indexOf('--thinking') + 1]).toBe('medium');
    expect(result.model).toBe('claude-haiku-4-5');
    expect(result.thinking).toBe('medium');
  });

  it('omits --model/--thinking when neither override nor config is set', async () => {
    const { captured, result } = await runOnce(makeAgent());
    expect(captured.args).not.toContain('--model');
    expect(captured.args).not.toContain('--thinking');
    expect(result.model).toBeUndefined();
    expect(result.thinking).toBeUndefined();
  });
});

describe('runSingleAgent runtime override', () => {
  it('forces a grok-acp-configured agent through the pi runtime', async () => {
    const fake = new FakeChild();
    const captured = { command: '', args: [] as string[] };
    const spawnFn: SpawnFn = ((command: string, args: string[]) => {
      captured.command = command;
      captured.args = args;
      return fake as unknown as SpawnedChild;
    }) as SpawnFn;
    const agent = makeAgent({ name: 'g', runtime: 'grok-acp', model: 'grok-4.5' });
    const promise = runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'do work',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      { spawnFn, runtimeOverride: 'pi' }
    );
    setImmediate(() => {
      fake.stdout.push(null);
      fake.stderr.push(null);
      fake.emit('close', 0);
    });
    const result = await promise;
    expect(captured.command).not.toBe('grok');
    expect(captured.args).toContain('--mode');
    expect(captured.args[captured.args.indexOf('--mode') + 1]).toBe('json');
    expect(captured.args).not.toContain('--no-leader');
    expect(captured.args[captured.args.indexOf('--model') + 1]).toBe('grok-4.5');
    expect(result.model).toBe('grok-4.5');
  });
});

describe('runSingleAgent maxTurns', () => {
  it('terminates the child and reports max_turns once the budget is exceeded', async () => {
    const fake = new FakeChild();
    const promise = runSingleAgent(
      process.cwd(),
      [makeAgent({ maxTurns: 1 })],
      'maxie',
      'do work',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      { spawnFn: (() => fake as unknown as SpawnedChild) as SpawnFn }
    );

    setImmediate(() => {
      fake.emitAssistant('first turn');
      setImmediate(() => fake.emitAssistant('second turn'));
    });

    const result = await promise;
    expect(result.stopReason).toBe('max_turns');
    expect(result.errorMessage).toContain('maxTurns=1');
    expect(result.exitCode).toBe(1);
    expect(fake.killSignals).toContain('SIGTERM');
  });

  it('does not interfere when usage.turns stays below maxTurns', async () => {
    const fake = new FakeChild();
    const promise = runSingleAgent(
      process.cwd(),
      [makeAgent({ maxTurns: 3 })],
      'maxie',
      'do work',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      { spawnFn: (() => fake as unknown as SpawnedChild) as SpawnFn }
    );

    setImmediate(() => {
      fake.emitAssistant('only turn');
      setImmediate(() => {
        fake.stdout.push(null);
        fake.stderr.push(null);
        fake.emit('close', 0);
      });
    });

    const result = await promise;
    expect(result.stopReason).not.toBe('max_turns');
    expect(result.exitCode).toBe(0);
    expect(fake.killSignals).toEqual([]);
  });

  it('flushes a buffered unterminated assistant event on close', async () => {
    const fake = new FakeChild();
    const promise = runSingleAgent(
      process.cwd(),
      [makeAgent({ maxTurns: 3 })],
      'maxie',
      'do work',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      { spawnFn: (() => fake as unknown as SpawnedChild) as SpawnFn }
    );

    setImmediate(() => {
      const message = {
        role: 'assistant',
        model: 'fake-model',
        content: [{ type: 'text', text: 'final partial line' }],
        usage: { input: 1, output: 1, totalTokens: 2 },
      };
      fake.stdout.push(JSON.stringify({ type: 'message_end', message }));
      setImmediate(() => {
        fake.stdout.push(null);
        fake.stderr.push(null);
        fake.emit('close', 0);
      });
    });

    const result = await promise;
    expect(result.usage.turns).toBe(1);
    expect(result.messages).toHaveLength(1);
    expect(result.exitCode).toBe(0);
  });
});

describe('runSingleAgent cwd validation', () => {
  it('returns an actionable cwd_error without spawning when cwd does not exist', async () => {
    let spawned = false;
    const missingCwd = `/definitely/missing/pi-agent-cwd-${process.pid}`;
    const result = await runSingleAgent(
      process.cwd(),
      [makeAgent()],
      'maxie',
      'go',
      missingCwd,
      undefined,
      undefined,
      undefined,
      makeDetails,
      {
        spawnFn: (() => {
          spawned = true;
          return new FakeChild() as unknown as SpawnedChild;
        }) as SpawnFn,
      }
    );

    expect(spawned).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.status).toBe('failed');
    expect(result.stopReason).toBe('cwd_error');
    expect(result.errorMessage).toBe(
      `Cannot start agent: working directory does not exist: ${missingCwd}`
    );
    expect(result.stderr).toBe(
      `Cannot start agent: working directory does not exist: ${missingCwd}`
    );
  });
});

describe('runSingleAgentGrokAcp', () => {
  class FakeAcpChild extends EventEmitter {
    stdout = new Readable({ read() {} });
    stderr = new Readable({ read() {} });
    stdin: Writable;
    killed = false;
    killSignals: NodeJS.Signals[] = [];
    private buffer = '';
    private closed = false;
    private sessionId = 'sess-exec';
    cancelReceived = false;
    private readonly behavior: {
      multiCycle?: boolean;
      hang?: boolean;
      highFrequency?: boolean;
      protocolVersion?: number;
      stopReason?: string;
      stderrText?: string;
      failSpawn?: boolean;
    };

    constructor(behavior: FakeAcpChild['behavior'] = {}) {
      super();
      this.behavior = behavior;
      this.stdin = new Writable({
        write: (chunk: Buffer | string, _enc: unknown, cb: (err?: Error | null) => void) => {
          if (this.behavior.failSpawn) {
            cb();
            return;
          }
          this.buffer += chunk.toString();
          const lines = this.buffer.split('\n');
          this.buffer = lines.pop() || '';
          for (const line of lines) void this.handleLine(line);
          cb();
        },
      });
    }

    private writeMsg(msg: unknown) {
      if (this.closed) return;
      this.stdout.push(JSON.stringify(msg) + '\n');
    }

    private async handleLine(line: string) {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: {
        id?: number | string;
        method?: string;
        params?: Record<string, unknown>;
      };
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (!msg.method) return;

      if (msg.method === 'initialize') {
        this.writeMsg({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: this.behavior.protocolVersion ?? 1,
            agentCapabilities: {},
            authMethods: [{ id: 'cached_token', name: 'Cached' }],
          },
        });
        return;
      }
      if (msg.method === 'authenticate') {
        this.writeMsg({ jsonrpc: '2.0', id: msg.id, result: {} });
        return;
      }
      if (msg.method === 'session/new') {
        this.writeMsg({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: this.sessionId },
        });
        return;
      }
      if (msg.method === 'session/cancel') {
        this.cancelReceived = true;
        return;
      }
      if (msg.method === 'session/prompt') {
        if (this.behavior.stderrText) this.stderr.push(this.behavior.stderrText);

        this.writeMsg({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'preamble ' },
            },
          },
        });

        this.writeMsg({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 't1',
              title: 'read',
              status: 'completed',
              rawInput: { path: 'a.ts' },
              _meta: { 'x.ai/tool': { name: 'read_file' } },
            },
          },
        });

        if (this.behavior.multiCycle) {
          this.writeMsg({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: this.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'mid ' },
              },
            },
          });
          this.writeMsg({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: this.sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 't2',
                title: 'grep',
                status: 'completed',
                rawInput: { pattern: 'x' },
              },
            },
          });
        }

        if (this.behavior.highFrequency) {
          for (let i = 0; i < 1000; i++) {
            this.writeMsg({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: this.sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: `tok${i} ` },
                },
              },
            });
            if (i % 50 === 0) {
              this.writeMsg({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: this.sessionId,
                  update: {
                    sessionUpdate: 'usage_update',
                    used: i,
                    size: 200000,
                    cost: { amount: 0.01, currency: 'USD' },
                  },
                },
              });
            }
          }
        }

        this.writeMsg({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '## Completed\n\nDone.\n' },
            },
          },
        });

        this.writeMsg({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'usage_update',
              used: 42,
              size: 200000,
              cost: { amount: 0.01, currency: 'USD' },
            },
          },
        });

        if (this.behavior.hang) return;

        this.writeMsg({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            stopReason: this.behavior.stopReason ?? 'end_turn',
            _meta: {
              inputTokens: 11,
              outputTokens: 7,
              cachedReadTokens: 3,
              totalTokens: 21,
              modelId: 'fake-acp-model',
            },
          },
        });
      }
    }

    kill(signal: NodeJS.Signals = 'SIGTERM') {
      this.killSignals.push(signal);
      this.killed = true;
      this.close(1);
      return true;
    }

    close(code = 0) {
      if (this.closed) return;
      this.closed = true;
      this.stdout.push(null);
      this.stderr.push(null);
      setImmediate(() => this.emit('close', code));
    }
  }

  function captureAcpSpawn(behavior: ConstructorParameters<typeof FakeAcpChild>[0] = {}) {
    const fake = new FakeAcpChild(behavior);
    const captured = {
      command: '',
      args: [] as string[],
      env: undefined as NodeJS.ProcessEnv | undefined,
    };
    const spawnFn: SpawnFn = ((
      command: string,
      args: string[],
      opts: { env?: NodeJS.ProcessEnv }
    ) => {
      captured.command = command;
      captured.args = args;
      captured.env = opts.env;
      if (behavior.failSpawn) {
        throw Object.assign(new Error('spawn grok ENOENT'), { code: 'ENOENT' });
      }
      return fake as unknown as SpawnedChild;
    }) as SpawnFn;
    return { fake, spawnFn, captured };
  }

  it('routes grok-acp through ACP args/env and returns structured messages/tools/usage', async () => {
    const ctx = captureAcpSpawn();
    const agent = makeAgent({
      name: 'g',
      runtime: 'grok-acp',
      model: 'grok-4.5',
      maxTurns: 1,
      systemPrompt: 'Be careful',
      tools: ['read'],
    });
    const updates: string[] = [];
    const usageSnapshots: Array<{
      input: number;
      output: number;
      cost: number;
      contextTokens: number;
    }> = [];
    const promise = runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'review this',
      undefined,
      undefined,
      undefined,
      (partial) => {
        const text = partial.content.find((c) => c.type === 'text');
        if (text && text.type === 'text') updates.push(text.text);
        const usage = partial.details?.results[0]?.usage;
        if (usage) {
          usageSnapshots.push({
            input: usage.input,
            output: usage.output,
            cost: usage.cost,
            contextTokens: usage.contextTokens,
          });
        }
      },
      makeDetails,
      { spawnFn: ctx.spawnFn }
    );
    const result = await promise;

    expect(ctx.captured.command).toBe('grok');
    expect(ctx.captured.args[0]).toBe('agent');
    expect(ctx.captured.args).toContain('stdio');
    expect(ctx.captured.args).toContain('--always-approve');
    expect(ctx.captured.args).toContain('--no-leader');
    expect(ctx.captured.args).not.toContain('--max-turns');
    expect(ctx.captured.args).not.toContain('-p');
    expect(ctx.captured.env?.GROK_MEMORY).toBe('0');
    expect(ctx.captured.env?.GROK_SUBAGENTS).toBe('0');
    expect(ctx.captured.env?.GROK_DISABLE_AUTOUPDATER).toBe('1');

    expect(result.exitCode).toBe(0);
    expect(result.stopReason).toBe('end');
    expect(result.model).toBe('fake-acp-model');
    expect(result.usage.input).toBe(11);
    expect(result.usage.output).toBe(7);
    expect(result.usage.cacheRead).toBe(3);
    expect(result.usage.contextTokens).toBe(21);
    expect(result.usage.cost).toBe(0.01);
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    const content = result.messages[0].content as Array<{
      type: string;
      name?: string;
      arguments?: unknown;
    }>;
    const toolPart = content.find((p) => p.type === 'toolCall');
    expect(toolPart).toMatchObject({
      type: 'toolCall',
      name: 'read_file',
      arguments: { path: 'a.ts' },
    });
    expect(result.errorMessage).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('maxTurns=1');
    // Provisional parent updates may only show running/done placeholders; authority is result.
    expect(updates.length).toBeGreaterThan(0);
    expect(result.finalOutput || result.messages.length > 0).toBeTruthy();

    // Content/usage chunks are coalesced: intermediate mid-turn snapshots may be dropped,
    // but the final delivered usage (and authoritative result) remain complete.
    expect(usageSnapshots.length).toBeGreaterThan(0);
    expect(usageSnapshots.length).toBeLessThan(50);
    const finalSnap = usageSnapshots[usageSnapshots.length - 1];
    expect(finalSnap).toMatchObject({
      input: 11,
      output: 7,
      cost: 0.01,
      contextTokens: 21,
    });
  });

  it('ignores maxTurns=1 across multiple ACP tool/message cycles', async () => {
    const ctx = captureAcpSpawn({ multiCycle: true });
    const agent = makeAgent({ name: 'g', runtime: 'grok-acp', maxTurns: 1 });
    const result = await runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'multi',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      { spawnFn: ctx.spawnFn }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stopReason).toBe('end');
    expect(result.errorMessage).toBeUndefined();
    expect(ctx.captured.args).not.toContain('--max-turns');
    const toolCalls = result.messages.flatMap((m) =>
      m.role === 'assistant' ? m.content.filter((p) => p.type === 'toolCall') : []
    );
    expect(toolCalls.length).toBe(2);
  });

  it('forces a pi agent through runtimeOverride grok-acp', async () => {
    const ctx = captureAcpSpawn();
    const agent = makeAgent({ name: 'p', runtime: 'pi' });
    const result = await runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'go',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      { spawnFn: ctx.spawnFn, runtimeOverride: 'grok-acp' }
    );
    expect(ctx.captured.command).toBe('grok');
    expect(ctx.captured.args[0]).toBe('agent');
    expect(result.stopReason).toBe('end');
  });

  it(
    'throws when aborted during ACP prompt',
    async () => {
      const ctx = captureAcpSpawn({ hang: true });
      const agent = makeAgent({ name: 'g', runtime: 'grok-acp' });
      const controller = new AbortController();
      const promise = runSingleAgent(
        process.cwd(),
        [agent],
        agent.name,
        'hang',
        undefined,
        undefined,
        controller.signal,
        undefined,
        makeDetails,
        { spawnFn: ctx.spawnFn }
      );
      await new Promise((r) => setTimeout(r, 80));
      controller.abort();
      await expect(promise).rejects.toThrow('Subagent was aborted');
      expect(ctx.fake.cancelReceived).toBe(true);
    },
    { timeout: 15_000 }
  );

  it('surfaces protocol version errors directly', async () => {
    const ctx = captureAcpSpawn({ protocolVersion: 99 });
    const agent = makeAgent({ name: 'g', runtime: 'grok-acp' });
    const result = await runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'go',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      { spawnFn: ctx.spawnFn }
    );
    expect(result.exitCode).toBe(1);
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toMatch(/protocol version/i);
    expect(ctx.captured.args).not.toContain('--output-format');
  });

  it('surfaces spawn errors for grok-acp', async () => {
    const ctx = captureAcpSpawn({ failSpawn: true });
    const agent = makeAgent({ name: 'g', runtime: 'grok-acp' });
    const result = await runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'go',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      { spawnFn: ctx.spawnFn }
    );
    expect(result.exitCode).toBe(1);
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toMatch(/ENOENT|failed/i);
  });

  it('1000 high-frequency content/tool/usage updates coalesce and terminal is not overtaken', async () => {
    const ctx = captureAcpSpawn({ highFrequency: true });
    const agent = makeAgent({ name: 'g', runtime: 'grok-acp' });
    const statuses: string[] = [];
    let updateCount = 0;
    const result = await runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'stream',
      undefined,
      undefined,
      undefined,
      (partial) => {
        updateCount += 1;
        const st = partial.details?.results[0]?.status;
        if (st) statuses.push(st);
      },
      makeDetails,
      { spawnFn: ctx.spawnFn }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stopReason).toBe('end');
    expect(result.status === 'completed' || result.stopReason === 'end').toBe(true);
    // Coalescing: parent update count must be far below raw 1000+ notifications.
    expect(updateCount).toBeLessThan(1000);
    expect(updateCount).toBeGreaterThan(0);
    // After the promise settles, no further parent updates may arrive (terminal is final).
    const countAtSettle = updateCount;
    await new Promise((r) => setTimeout(r, 200));
    expect(updateCount).toBe(countAtSettle);
    // Pending running updates must not appear after settlement.
    expect(statuses.every((s) => s === 'running' || s === 'completed' || s === 'failed')).toBe(
      true
    );
  }, 20_000);

  it('successful Grok terminal discards pending running flush and emits authoritative terminal', async () => {
    const ctx = captureAcpSpawn();
    const agent = makeAgent({ name: 'g', runtime: 'grok-acp', model: 'grok-4.5' });
    const statuses: Array<string | undefined> = [];
    const texts: string[] = [];
    let updateCount = 0;
    const result = await runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'review this',
      undefined,
      undefined,
      undefined,
      (partial) => {
        updateCount += 1;
        statuses.push(partial.details?.results[0]?.status);
        const text = partial.content.find((c) => c.type === 'text');
        if (text && text.type === 'text') texts.push(text.text);
      },
      makeDetails,
      { spawnFn: ctx.spawnFn }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stopReason).toBe('end');
    expect(result.status).toBe('completed');
    // Authoritative terminal is delivered via onUpdate (not a stale running flush)
    // and also via the returned result.
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses[statuses.length - 1]).toBe('completed');
    // No trailing running update after the terminal snapshot.
    const lastRunning = statuses.lastIndexOf('running');
    const lastCompleted = statuses.lastIndexOf('completed');
    if (lastRunning >= 0) {
      expect(lastCompleted).toBeGreaterThan(lastRunning);
    }
    // Final result remains complete.
    expect(result.usage.input).toBe(11);
    expect(result.usage.output).toBe(7);
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    const countAtSettle = updateCount;
    await new Promise((r) => setTimeout(r, RESULT_UPDATE_INTERVAL_MS + 100));
    expect(updateCount).toBe(countAtSettle);
  }, 15_000);
});

describe('runSingleAgent execution status', () => {
  it('emits running status on partials and completed on success', async () => {
    const fake = new FakeChild();
    const statuses: Array<string | undefined> = [];
    const promise = runSingleAgent(
      process.cwd(),
      [makeAgent()],
      'maxie',
      'do work',
      undefined,
      undefined,
      undefined,
      (partial) => {
        statuses.push(partial.details?.results[0]?.status);
      },
      makeDetails,
      { spawnFn: (() => fake as unknown as SpawnedChild) as SpawnFn }
    );

    setImmediate(() => {
      fake.emitAssistant('turn');
      setImmediate(() => {
        fake.stdout.push(null);
        fake.stderr.push(null);
        fake.emit('close', 0);
      });
    });

    const result = await promise;
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((s) => s === 'running')).toBe(true);
    expect(result.status).toBe('completed');
  });

  it('finalizes as failed for unknown agents', async () => {
    const result = await runSingleAgent(
      process.cwd(),
      [],
      'missing',
      'task',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails
    );
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
  });

  it('finalizes as failed when maxTurns is exceeded', async () => {
    const fake = new FakeChild();
    const promise = runSingleAgent(
      process.cwd(),
      [makeAgent({ maxTurns: 1 })],
      'maxie',
      'do work',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      { spawnFn: (() => fake as unknown as SpawnedChild) as SpawnFn }
    );

    setImmediate(() => {
      fake.emitAssistant('first turn');
      setImmediate(() => fake.emitAssistant('second turn'));
    });

    const result = await promise;
    expect(result.stopReason).toBe('max_turns');
    expect(result.status).toBe('failed');
  });

  it('emits a terminal cancelled snapshot before abort throw', async () => {
    const fake = new FakeChild();
    const controller = new AbortController();
    const updates: Array<string | undefined> = [];
    const promise = runSingleAgent(
      process.cwd(),
      [makeAgent()],
      'maxie',
      'do work',
      undefined,
      undefined,
      controller.signal,
      (partial) => {
        updates.push(partial.details?.results[0]?.status);
      },
      makeDetails,
      { spawnFn: (() => fake as unknown as SpawnedChild) as SpawnFn }
    );

    setImmediate(() => {
      fake.emitAssistant('partial text');
      setImmediate(() => controller.abort());
    });

    await expect(promise).rejects.toBeInstanceOf(AgentAbortError);
    expect(updates).toContain('cancelled');
    expect(updates[updates.length - 1]).toBe('cancelled');
  });
});

describe('runSingleAgent resume prompt selection', () => {
  function captureSpawn(): {
    fake: FakeChild;
    spawnFn: SpawnFn;
    captured: { args: string[] };
  } {
    const fake = new FakeChild();
    const captured = { args: [] as string[] };
    const spawnFn: SpawnFn = ((_command: string, args: string[]) => {
      captured.args = args;
      return fake as unknown as SpawnedChild;
    }) as SpawnFn;
    return { fake, spawnFn, captured };
  }

  async function runAndClose(
    task: string,
    options: Parameters<typeof runSingleAgent>[9],
    captured: ReturnType<typeof captureSpawn>
  ) {
    const promise = runSingleAgent(
      process.cwd(),
      [makeAgent()],
      'maxie',
      task,
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      { spawnFn: captured.spawnFn, ...options }
    );
    setImmediate(() => {
      captured.fake.emitAssistant('ok');
      setImmediate(() => {
        captured.fake.stdout.push(null);
        captured.fake.stderr.push(null);
        captured.fake.emit('close', 0);
      });
    });
    return promise;
  }

  it('sends session-continuation prompt with only undelivered tasks for an existing Pi session', async () => {
    const ctx = captureSpawn();
    const result = await runAndClose(
      'Original resolved task',
      {
        sessionFile: '/tmp/existing-session.jsonl',
        resumeHadStoredSession: true,
        resumePrompt: {
          continuationTasks: ['Earlier instruction', 'Current instruction'],
          undeliveredContinuationTasks: ['Current instruction'],
          currentContinuationTask: 'Current instruction',
        },
      },
      ctx
    );
    const last = ctx.captured.args[ctx.captured.args.length - 1]!;
    expect(ctx.captured.args).toContain('--session');
    expect(last).not.toContain('Task: Original resolved task');
    expect(last).not.toContain('Earlier instruction');
    expect(last).toContain('resuming');
    expect(last).toContain('Additional instruction for this resumed run:\nCurrent instruction');
    // Result metadata keeps the original task.
    expect(result.task).toBe('Original resolved task');
  });

  it('redelivers all undelivered continuations to an existing session after a crash window', async () => {
    const ctx = captureSpawn();
    await runAndClose(
      'Original resolved task',
      {
        sessionFile: '/tmp/existing-session.jsonl',
        resumeHadStoredSession: true,
        resumePrompt: {
          continuationTasks: ['First cont', 'Second cont'],
          undeliveredContinuationTasks: ['First cont', 'Second cont'],
        },
      },
      ctx
    );
    const last = ctx.captured.args[ctx.captured.args.length - 1]!;
    expect(last).toContain('First cont');
    expect(last).toContain('Second cont');
    expect(last).not.toContain('Task: Original resolved task');
  });

  it('sends original task plus continuations when resumeHadStoredSession is false even if sessionFile is set', async () => {
    // Never-started unit: prepareAgentContext creates a new session file, but
    // the unit never owned a prior session — must not use session-continuation only.
    const ctx = captureSpawn();
    await runAndClose(
      'Original resolved task',
      {
        sessionFile: '/tmp/just-created-session.jsonl',
        resumeHadStoredSession: false,
        resumePrompt: {
          continuationTasks: ['Cont A', 'Cont B'],
        },
      },
      ctx
    );
    const last = ctx.captured.args[ctx.captured.args.length - 1]!;
    expect(last).toContain('Task: Original resolved task');
    expect(last).toContain('Additional instruction for this resumed run:\nCont A');
    expect(last).toContain('Additional instruction for this resumed run:\nCont B');
  });

  it('appends all durable continuations for a never-started Pi unit without a session', async () => {
    const ctx = captureSpawn();
    await runAndClose(
      'Original resolved task',
      {
        resumeHadStoredSession: false,
        resumePrompt: {
          continuationTasks: ['First cont', 'Second cont'],
        },
      },
      ctx
    );
    const last = ctx.captured.args[ctx.captured.args.length - 1]!;
    expect(ctx.captured.args).toContain('--no-session');
    expect(last).toContain('Task: Original resolved task');
    expect(last).toContain('Additional instruction for this resumed run:\nFirst cont');
    expect(last).toContain('Additional instruction for this resumed run:\nSecond cont');
  });

  it('keeps earlier persisted continuations available on a second resume of a never-started unit', async () => {
    const ctx = captureSpawn();
    await runAndClose(
      'Original',
      {
        resumePrompt: {
          continuationTasks: ['From first interruption', 'From second interruption'],
          currentContinuationTask: 'From second interruption',
        },
      },
      ctx
    );
    const last = ctx.captured.args[ctx.captured.args.length - 1]!;
    expect(last).toContain('From first interruption');
    expect(last).toContain('From second interruption');
  });
});

describe('runSingleAgent durable metadata stamping', () => {
  it('stamps runId/unitId/attempt/session/resumeCapability on partials and the final result', async () => {
    const fake = new FakeChild();
    const snapshots: SingleResult[] = [];
    const unitContext = {
      runId: 'run-stamp',
      unitId: 'single',
      agent: 'maxie',
      runtime: undefined,
      resumeCapability: 'session' as const,
      effectiveCwd: '/cwd',
      sessionFile: '/sessions/run-stamp/s.jsonl',
      attempt: 1,
    };
    const promise = runSingleAgent(
      process.cwd(),
      [makeAgent()],
      'maxie',
      'do work',
      undefined,
      undefined,
      undefined,
      (partial) => {
        if (partial.details?.results[0]) snapshots.push(partial.details.results[0]);
      },
      makeDetails,
      {
        spawnFn: (() => fake as unknown as SpawnedChild) as SpawnFn,
        unitContext,
        sessionFile: unitContext.sessionFile,
      }
    );
    setImmediate(() => {
      fake.emitAssistant('turn');
      setImmediate(() => {
        fake.stdout.push(null);
        fake.stderr.push(null);
        fake.emit('close', 0);
      });
    });
    const result = await promise;
    expect(result.runId).toBe('run-stamp');
    expect(result.unitId).toBe('single');
    expect(result.attempt).toBe(1);
    expect(result.sessionFile).toBe('/sessions/run-stamp/s.jsonl');
    expect(result.resumeCapability).toBe('session');
    for (const snap of snapshots) {
      expect(snap.runId).toBe('run-stamp');
      expect(snap.unitId).toBe('single');
    }
  });

  it('an aborted pi run carries a deep-cloned terminal snapshot with durable identity', async () => {
    const fake = new FakeChild();
    const controller = new AbortController();
    const unitContext = {
      runId: 'run-abort',
      unitId: 'single',
      agent: 'maxie',
      runtime: undefined,
      resumeCapability: 'session' as const,
      effectiveCwd: '/cwd',
      attempt: 1,
    };
    const promise = runSingleAgent(
      process.cwd(),
      [makeAgent()],
      'maxie',
      'do work',
      undefined,
      undefined,
      controller.signal,
      undefined,
      makeDetails,
      {
        spawnFn: (() => fake as unknown as SpawnedChild) as SpawnFn,
        unitContext,
      }
    );
    setImmediate(() => {
      fake.emitAssistant('partial');
      setImmediate(() => {
        controller.abort();
      });
    });
    await expect(promise).rejects.toBeInstanceOf(AgentAbortError);
    const err = (await promise.catch((e: unknown) => e)) as AgentAbortError;
    expect(err.result.runId).toBe('run-abort');
    expect(err.result.unitId).toBe('single');
    expect(err.result.status).toBe('cancelled');
  });
});

describe('mapWithConcurrencyLimit cancel-safe scheduling', () => {
  it('stops scheduling, waits for started workers, and fills unstarted slots', async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const finished: number[] = [];
    const resolvers: Array<() => void> = [];
    const gates = [0, 1, 2, 3].map(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        })
    );

    let resolveTwoStarted!: () => void;
    const twoStarted = new Promise<void>((resolve) => {
      resolveTwoStarted = resolve;
    });

    const run = mapWithConcurrencyLimit(
      [0, 1, 2, 3],
      2,
      async (item) => {
        started.push(item);
        if (started.length === 2) resolveTwoStarted();
        await gates[item];
        finished.push(item);
        return item * 10;
      },
      {
        signal: controller.signal,
        onUnstarted: (item) => -(item + 1),
      }
    );

    await twoStarted;
    controller.abort();
    // Let the scheduler observe abort before releasing in-flight work.
    await new Promise((r) => setTimeout(r, 10));
    resolvers[0]();
    resolvers[1]();
    // Unstarted gates should never be awaited.
    resolvers[2]();
    resolvers[3]();

    const results = await run;
    expect(started.sort()).toEqual([0, 1]);
    expect(finished.sort()).toEqual([0, 1]);
    expect(results[0]).toBe(0);
    expect(results[1]).toBe(10);
    expect(results[2]).toBe(-3);
    expect(results[3]).toBe(-4);
  });

  it('does not fail-fast: waits for in-flight work after a worker error', async () => {
    const finished: number[] = [];
    const resolvers: Array<() => void> = [];
    const gates = [0, 1].map(
      () =>
        new Promise<void>((resolve) => {
          resolvers.push(resolve);
        })
    );

    const run = mapWithConcurrencyLimit([0, 1], 2, async (item) => {
      await gates[item];
      finished.push(item);
      if (item === 0) throw new Error('boom');
      return item;
    });

    // Complete the non-erroring worker first, then the erroring one.
    resolvers[1]();
    await new Promise((r) => setTimeout(r, 10));
    expect(finished).toEqual([1]);
    resolvers[0]();
    await expect(run).rejects.toThrow('boom');
    expect(finished.sort()).toEqual([0, 1]);
  });
});

describe('runSingleAgent compact parent projection', () => {
  it('ignores tool_result_end and non-assistant message_end events', async () => {
    const fake = new FakeChild();
    const updates: SubagentDetails[] = [];
    const promise = runSingleAgent(
      process.cwd(),
      [makeAgent()],
      'maxie',
      'do work',
      undefined,
      undefined,
      undefined,
      (partial) => {
        if (partial.details) updates.push(partial.details);
      },
      makeDetails,
      {
        spawnFn: (() => fake as unknown as SpawnedChild) as SpawnFn,
      }
    );

    setImmediate(() => {
      fake.emitAssistant('thinking');
      fake.stdout.push(
        JSON.stringify({
          type: 'message_end',
          message: {
            role: 'toolResult',
            toolCallId: 't1',
            toolName: 'bash',
            content: [{ type: 'text', text: 'RAW_TOOL_BODY_' + 'x'.repeat(100) }],
            isError: false,
          },
        }) + '\n'
      );
      fake.stdout.push(
        JSON.stringify({
          type: 'tool_result_end',
          message: {
            role: 'toolResult',
            toolCallId: 't2',
            toolName: 'bash',
            content: [{ type: 'text', text: 'RAW_TOOL_BODY_END_' + 'y'.repeat(100) }],
            isError: false,
          },
        }) + '\n'
      );
      fake.emitAssistant('final answer');
      fake.stdout.push(null);
      fake.stderr.push(null);
      fake.emit('close', 0);
    });

    const result = await promise;
    // Live private result retains assistant messages only.
    expect(result.messages.every((m) => m.role === 'assistant')).toBe(true);
    expect(result.messages).toHaveLength(2);
    expect(result.usage.turns).toBe(2);
    expect(JSON.stringify(result.messages)).not.toContain('RAW_TOOL_BODY_');

    // Parent onUpdate details are compact snapshots without raw tool bodies.
    expect(updates.length).toBeGreaterThan(0);
    for (const details of updates) {
      const json = JSON.stringify(details);
      expect(json).not.toContain('RAW_TOOL_BODY_');
      for (const r of details.results) {
        expect(r.messages).toEqual([]);
        expect(r.presentation).toBeDefined();
      }
    }
    // Low-level onUpdate is provisional (no authoritative finalOutput).
    for (const details of updates) {
      for (const r of details.results) {
        expect(r.finalOutput).toBeUndefined();
        expect(r.finalOutputRef).toBeUndefined();
      }
    }
    // Authoritative returned result still exposes final text via messages.
    expect(getResultFinalOutput(result)).toBe('final answer');
    expect(
      result.messages.some(
        (m) =>
          m.role === 'assistant' &&
          Array.isArray(m.content) &&
          m.content.some((c) => c.type === 'text' && c.text === 'thinking')
      )
    ).toBe(true);
  });

  it('still updates usage and stopReason from assistant message_end events', async () => {
    const fake = new FakeChild();
    const promise = runSingleAgent(
      process.cwd(),
      [makeAgent()],
      'maxie',
      'do work',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      {
        spawnFn: (() => fake as unknown as SpawnedChild) as SpawnFn,
      }
    );

    setImmediate(() => {
      const message = {
        role: 'assistant',
        model: 'fake-model',
        content: [{ type: 'text', text: 'done' }],
        usage: { input: 11, output: 7, totalTokens: 18, cacheRead: 3, cacheWrite: 1 },
        stopReason: 'end',
      };
      fake.stdout.push(JSON.stringify({ type: 'message_end', message }) + '\n');
      fake.stdout.push(null);
      fake.stderr.push(null);
      fake.emit('close', 0);
    });

    const result = await promise;
    expect(result.usage.turns).toBe(1);
    expect(result.usage.input).toBe(11);
    expect(result.usage.output).toBe(7);
    expect(result.usage.cacheRead).toBe(3);
    expect(result.usage.cacheWrite).toBe(1);
    expect(result.usage.contextTokens).toBe(18);
    expect(result.model).toBe('fake-model');
    expect(result.stopReason === 'end' || result.status === 'completed').toBe(true);
  });
});
