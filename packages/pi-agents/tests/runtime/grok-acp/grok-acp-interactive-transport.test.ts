// ABOUTME: Tests for long-lived Grok ACP interactive transport new/load/prompt/cancel/dispose.
// ABOUTME: Uses fake ACP children with NDJSON stdio; covers dispatch vs completion ordering.

import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import type { PromptResponse } from '@agentclientprotocol/sdk';
import { GrokAcpInteractiveTransport } from '../../../src/runtime/grok-acp/grok-acp-interactive-transport.ts';
import type { GrokAcpSpawnedChild } from '../../../src/runtime/grok-acp/grok-acp-client.ts';
import type { AgentConfig } from '../../../src/config/agents.ts';

class FakeAcpChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  stdin: Writable;
  killed = false;
  killSignals: NodeJS.Signals[] = [];
  private buffer = '';
  private closed = false;
  sessionId = 'sess-interactive';
  methodsReceived: string[] = [];
  promptReceived = false;
  cancelReceived = false;
  loadReceived = false;
  private readonly behavior: {
    loadSession?: boolean;
    hangPrompt?: boolean;
    replayBeforeLoadResponse?: boolean;
    stopReason?: PromptResponse['stopReason'];
  };

  constructor(behavior: FakeAcpChild['behavior'] = {}) {
    super();
    this.behavior = behavior;
    this.stdin = new Writable({
      write: (chunk, _enc, cb) => {
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
      jsonrpc?: string;
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
    this.methodsReceived.push(msg.method);

    if (msg.method === 'initialize') {
      this.writeMsg({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: this.behavior.loadSession !== false },
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
    if (msg.method === 'session/load') {
      this.loadReceived = true;
      if (this.behavior.replayBeforeLoadResponse !== false) {
        this.writeMsg({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'prior user' },
            },
          },
        });
        this.writeMsg({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'prior assistant' },
            },
          },
        });
      }
      this.writeMsg({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }
    if (msg.method === 'session/cancel') {
      this.cancelReceived = true;
      return;
    }
    if (msg.method === 'session/prompt') {
      this.promptReceived = true;
      if (this.behavior.hangPrompt) return;
      this.writeMsg({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: this.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'live reply' },
          },
        },
      });
      this.writeMsg({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          stopReason: this.behavior.stopReason ?? 'end_turn',
          _meta: { modelId: 'grok-test', inputTokens: 3, outputTokens: 5 },
        },
      });
    }
  }

  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.killSignals.push(signal);
    this.killed = true;
    this.closed = true;
    this.stdout.push(null);
    this.stderr.push(null);
    setImmediate(() => this.emit('close', 0, signal));
    return true;
  }
}

const agent: AgentConfig = {
  name: 'tester',
  description: 't',
  systemPrompt: 'sys',
  source: 'project',
  model: 'grok-configured',
  runtime: 'grok-acp',
  filePath: '/tmp/g.md',
};

function spawnOf(child: FakeAcpChild) {
  return () => child as unknown as GrokAcpSpawnedChild;
}

describe('GrokAcpInteractiveTransport', () => {
  it('session/new then prompt resolves at accept and emits prompt_completed + settled', async () => {
    const child = new FakeAcpChild();
    const transport = new GrokAcpInteractiveTransport({
      agent,
      cwd: process.cwd(),
      spawnFn: spawnOf(child),
      configuredModel: 'grok-configured',
    });

    const events: string[] = [];
    transport.subscribe((e) => events.push(e.type));

    await transport.start();
    expect(child.methodsReceived).toContain('session/new');
    expect(child.promptReceived).toBe(false);

    const promptPromise = transport.prompt('hello');
    // prompt() must resolve at dispatch acceptance, not full completion.
    await promptPromise;
    expect(child.promptReceived).toBe(true);

    // Wait for background completion chain.
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toContain('agent_start');
    expect(events).toContain('prompt_completed');
    expect(events).toContain('agent_settled');
    const completedIdx = events.indexOf('prompt_completed');
    const settledIdx = events.indexOf('agent_settled');
    expect(completedIdx).toBeGreaterThanOrEqual(0);
    expect(settledIdx).toBeGreaterThan(completedIdx);

    await transport.dispose();
    expect(child.killed || child.killSignals.length > 0).toBe(true);
  });

  it('session/load replays history before any prompt and requires user history', async () => {
    const child = new FakeAcpChild({ loadSession: true });
    const transport = new GrokAcpInteractiveTransport({
      agent,
      cwd: process.cwd(),
      spawnFn: spawnOf(child),
      sessionId: 'sess-interactive',
      configuredModel: 'grok-configured',
    });

    const ends: Array<{ role?: string }> = [];
    transport.subscribe((e) => {
      if (e.type === 'message_end') ends.push(e.message as { role?: string });
    });

    await transport.start();
    expect(child.loadReceived).toBe(true);
    expect(child.methodsReceived.indexOf('session/load')).toBeLessThan(
      child.methodsReceived.includes('session/prompt')
        ? child.methodsReceived.indexOf('session/prompt')
        : 999
    );
    expect(ends.some((m) => m.role === 'user')).toBe(true);
    expect(transport.getFinalizedMessages().length).toBeGreaterThan(0);

    await transport.prompt('continue');
    await new Promise((r) => setTimeout(r, 50));
    expect(child.promptReceived).toBe(true);
    await transport.dispose();
  });

  it('abort sends session/cancel and double abort coalesces', async () => {
    const child = new FakeAcpChild({ hangPrompt: true });
    const transport = new GrokAcpInteractiveTransport({
      agent,
      cwd: process.cwd(),
      spawnFn: spawnOf(child),
      configuredModel: 'grok-configured',
      cancelGraceMs: 50,
    });
    await transport.start();
    void transport.prompt('hang').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    await Promise.all([transport.abort(), transport.abort()]);
    expect(child.cancelReceived).toBe(true);
    await transport.dispose();
  });

  it('double dispose is safe', async () => {
    const child = new FakeAcpChild();
    const transport = new GrokAcpInteractiveTransport({
      agent,
      cwd: process.cwd(),
      spawnFn: spawnOf(child),
    });
    await transport.start();
    await transport.dispose();
    await transport.dispose();
  });

  it('dispose_failed is sticky across repeated dispose calls', async () => {
    const child = new FakeAcpChild();
    const transport = new GrokAcpInteractiveTransport({
      agent,
      cwd: process.cwd(),
      spawnFn: spawnOf(child),
    });
    await transport.start();
    // Inject a sticky dispose failure without waiting for HARD_KILL_MS.
    const conn = (transport as unknown as { connection: { dispose: () => Promise<void> } })
      .connection;
    const fail = Object.assign(new Error('SIGKILL failed; child may still hold the session'), {
      code: 'dispose_failed',
      stage: 'shutdown',
      stderr: '',
      name: 'GrokAcpClientError',
    });
    conn.dispose = async () => {
      throw fail;
    };
    await expect(transport.dispose()).rejects.toMatchObject({ code: 'dispose_failed' });
    // Sticky: every later dispose rethrows the same structured failure.
    await expect(transport.dispose()).rejects.toMatchObject({ code: 'dispose_failed' });
    await expect(transport.dispose()).rejects.toMatchObject({ code: 'dispose_failed' });
  });

  it('cancel grace settles without prompt_completed', async () => {
    const child = new FakeAcpChild({ hangPrompt: true });
    const transport = new GrokAcpInteractiveTransport({
      agent,
      cwd: process.cwd(),
      spawnFn: spawnOf(child),
      configuredModel: 'grok-configured',
      cancelGraceMs: 40,
    });
    const events: string[] = [];
    transport.subscribe((e) => events.push(e.type));
    await transport.start();
    void transport.prompt('hang').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    await transport.abort();
    await new Promise((r) => setTimeout(r, 80));
    expect(events).toContain('agent_settled');
    expect(events).not.toContain('prompt_completed');
    await transport.dispose();
  });
});
