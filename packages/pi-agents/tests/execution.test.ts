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
