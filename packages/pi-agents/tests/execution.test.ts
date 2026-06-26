// ABOUTME: Execution tests focused on maxTurns enforcement via an injected fake child process.
// ABOUTME: Emits message_end events on a controllable stdout stream and asserts stop reason + kill behavior.

import { describe, expect, it } from 'bun:test';
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
