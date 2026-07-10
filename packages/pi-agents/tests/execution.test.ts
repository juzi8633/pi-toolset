// ABOUTME: Execution tests focused on maxTurns enforcement via an injected fake child process.
// ABOUTME: Emits message_end events on a controllable stdout stream and asserts stop reason + kill behavior.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { AgentConfig } from '../src/agents.ts';
import type { SpawnFn, SpawnedChild } from '../src/execution.ts';
import { runSingleAgent } from '../src/execution.ts';
import type { SingleResult, SubagentDetails } from '../src/types.ts';

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
  function captureSpawn(): {
    fake: FakeChild;
    spawnFn: SpawnFn;
    captured: { command: string; args: string[] };
  } {
    const fake = new FakeChild();
    const captured = { command: '', args: [] as string[] };
    const spawnFn: SpawnFn = ((command: string, args: string[]) => {
      captured.command = command;
      captured.args = args;
      return fake as unknown as SpawnedChild;
    }) as SpawnFn;
    return { fake, spawnFn, captured };
  }

  it('forces a pi-configured agent through the grok runtime', async () => {
    const ctx = captureSpawn();
    const agent = makeAgent({ name: 'p' });
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
      { spawnFn: ctx.spawnFn, runtimeOverride: 'grok' }
    );
    setImmediate(() => {
      ctx.fake.stdout.push(
        JSON.stringify({ type: 'text', data: 'ok' }) +
          '\n' +
          JSON.stringify({ type: 'end', stopReason: 'EndTurn' }) +
          '\n'
      );
      ctx.fake.stdout.push(null);
      ctx.fake.stderr.push(null);
      ctx.fake.emit('close', 0);
    });
    const result = await promise;
    expect(ctx.captured.command).toBe('grok');
    expect(ctx.captured.args).toContain('--no-subagents');
    expect(ctx.captured.args).not.toContain('--mode');
    expect(result.model).toBeUndefined();
  });

  it('forces a grok-configured agent through the pi runtime', async () => {
    const ctx = captureSpawn();
    const agent = makeAgent({ name: 'g', runtime: 'grok', model: 'grok-4.5' });
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
      { spawnFn: ctx.spawnFn, runtimeOverride: 'pi' }
    );
    setImmediate(() => {
      ctx.fake.stdout.push(null);
      ctx.fake.stderr.push(null);
      ctx.fake.emit('close', 0);
    });
    const result = await promise;
    expect(ctx.captured.command).not.toBe('grok');
    expect(ctx.captured.args).toContain('--mode');
    expect(ctx.captured.args[ctx.captured.args.indexOf('--mode') + 1]).toBe('json');
    expect(ctx.captured.args).not.toContain('--no-subagents');
    // model from the agent config still flows through the pi builder
    expect(ctx.captured.args[ctx.captured.args.indexOf('--model') + 1]).toBe('grok-4.5');
    expect(result.model).toBe('grok-4.5');
  });

  it('falls back to the agent config runtime when no override is given', async () => {
    const ctx = captureSpawn();
    const agent = makeAgent({ name: 'g', runtime: 'grok' });
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
      { spawnFn: ctx.spawnFn }
    );
    setImmediate(() => {
      ctx.fake.stdout.push(JSON.stringify({ type: 'end', stopReason: 'EndTurn' }) + '\n');
      ctx.fake.stdout.push(null);
      ctx.fake.stderr.push(null);
      ctx.fake.emit('close', 0);
    });
    await promise;
    expect(ctx.captured.command).toBe('grok');
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

describe('runSingleAgentGrok', () => {
  function captureGrokSpawn(): {
    fake: FakeChild;
    spawnFn: SpawnFn;
    captured: { command: string; args: string[] };
  } {
    const fake = new FakeChild();
    const captured = { command: '', args: [] as string[] };
    const spawnFn: SpawnFn = ((command: string, args: string[]) => {
      captured.command = command;
      captured.args = args;
      return fake as unknown as SpawnedChild;
    }) as SpawnFn;
    return { fake, spawnFn, captured };
  }

  it('spawns grok with streaming-json flags and always --no-subagents', async () => {
    const ctx = captureGrokSpawn();
    const agent = makeAgent({ name: 'g', runtime: 'grok', model: 'grok-4.5', maxTurns: 3 });
    const promise = runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'review this',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      { spawnFn: ctx.spawnFn }
    );
    setImmediate(() => {
      ctx.fake.stdout.push(
        JSON.stringify({ type: 'text', data: 'ok' }) +
          '\n' +
          JSON.stringify({ type: 'end', stopReason: 'EndTurn' }) +
          '\n'
      );
      ctx.fake.stdout.push(null);
      ctx.fake.stderr.push(null);
      ctx.fake.emit('close', 0);
    });
    const result = await promise;
    expect(ctx.captured.command).toBe('grok');
    expect(ctx.captured.args).toContain('--output-format');
    expect(ctx.captured.args[ctx.captured.args.indexOf('--output-format') + 1]).toBe(
      'streaming-json'
    );
    expect(ctx.captured.args).toContain('--no-subagents');
    expect(ctx.captured.args).toContain('--no-memory');
    expect(ctx.captured.args).toContain('--always-approve');
    expect(result.exitCode).toBe(0);
    expect(result.stopReason).toBe('end');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content[0]).toEqual({ type: 'text', text: 'ok' });
  });

  it('maps Cancelled to max_turns and sets a stable errorMessage', async () => {
    const ctx = captureGrokSpawn();
    const agent = makeAgent({ name: 'g', runtime: 'grok', maxTurns: 2 });
    const promise = runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'long task',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      { spawnFn: ctx.spawnFn }
    );
    setImmediate(() => {
      ctx.fake.stderr.push('Error: max turns reached\n');
      ctx.fake.stdout.push(JSON.stringify({ type: 'end', stopReason: 'Cancelled' }) + '\n');
      ctx.fake.stdout.push(null);
      ctx.fake.stderr.push(null);
      ctx.fake.emit('close', 1);
    });
    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.stopReason).toBe('max_turns');
    expect(result.errorMessage).toContain('maxTurns=2');
    expect(result.stderr).toContain('max turns reached');
  });

  it('surfaces spawn errors on stderr and stopReason', async () => {
    const fake = new FakeChild();
    const spawnFn: SpawnFn = (() => fake as unknown as SpawnedChild) as SpawnFn;
    const agent = makeAgent({ name: 'g', runtime: 'grok' });
    const promise = runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'go',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      { spawnFn }
    );
    setImmediate(() => {
      fake.emit('error', Object.assign(new Error('spawn grok ENOENT'), { code: 'ENOENT' }));
    });
    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('ENOENT');
    expect(result.stderr).toContain('ENOENT');
  });

  it('supports progressive text updates via onUpdate', async () => {
    const ctx = captureGrokSpawn();
    const agent = makeAgent({ name: 'g', runtime: 'grok' });
    const updates: string[] = [];
    const promise = runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'go',
      undefined,
      undefined,
      undefined,
      (partial) => {
        const text = partial.content.find((c) => c.type === 'text');
        if (text && text.type === 'text') updates.push(text.text);
      },
      makeDetails,
      { spawnFn: ctx.spawnFn }
    );
    setImmediate(() => {
      ctx.fake.stdout.push(JSON.stringify({ type: 'text', data: 'Hel' }) + '\n');
      setImmediate(() => {
        ctx.fake.stdout.push(JSON.stringify({ type: 'text', data: 'lo' }) + '\n');
        setImmediate(() => {
          ctx.fake.stdout.push(JSON.stringify({ type: 'end', stopReason: 'EndTurn' }) + '\n');
          ctx.fake.stdout.push(null);
          ctx.fake.stderr.push(null);
          ctx.fake.emit('close', 0);
        });
      });
    });
    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(updates.some((u) => u.includes('Hel'))).toBe(true);
    expect(result.messages[0].content[0]).toEqual({ type: 'text', text: 'Hello' });
  });

  it('throws when aborted', () => {
    const ctx = captureGrokSpawn();
    const agent = makeAgent({ name: 'g', runtime: 'grok' });
    const controller = new AbortController();
    const promise = runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'go',
      undefined,
      undefined,
      controller.signal,
      undefined,
      makeDetails,
      { spawnFn: ctx.spawnFn }
    );
    setImmediate(() => {
      controller.abort();
      setImmediate(() => {
        ctx.fake.stdout.push(null);
        ctx.fake.stderr.push(null);
        ctx.fake.emit('close', 1);
      });
    });
    expect(promise).rejects.toThrow('Subagent was aborted');
    expect(ctx.fake.killSignals).toContain('SIGTERM');
  });

  it('modelOverride/thinkingOverride win over the grok agent config and map to --model/--effort', async () => {
    const ctx = captureGrokSpawn();
    const agent = makeAgent({
      name: 'g',
      runtime: 'grok',
      model: 'grok-4.5',
      thinking: 'low',
    });
    const promise = runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'go',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      { spawnFn: ctx.spawnFn, modelOverride: 'grok-4', thinkingOverride: 'high' }
    );
    setImmediate(() => {
      ctx.fake.stdout.push(
        JSON.stringify({ type: 'text', data: 'ok' }) +
          '\n' +
          JSON.stringify({ type: 'end', stopReason: 'EndTurn' }) +
          '\n'
      );
      ctx.fake.stdout.push(null);
      ctx.fake.stderr.push(null);
      ctx.fake.emit('close', 0);
    });
    const result = await promise;
    expect(ctx.captured.args[ctx.captured.args.indexOf('--model') + 1]).toBe('grok-4');
    expect(ctx.captured.args[ctx.captured.args.indexOf('--effort') + 1]).toBe('high');
    expect(result.model).toBe('grok-4');
    expect(result.thinking).toBe('high');
  });
});
