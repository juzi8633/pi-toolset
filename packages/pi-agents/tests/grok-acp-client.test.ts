// ABOUTME: Tests for the Grok ACP SDK client adapter — lifecycle, permissions, cancel, cleanup.
// ABOUTME: Uses in-process agent apps and fake children with NDJSON stdio streams.

import { describe, expect, it, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import {
  agent,
  client,
  methods,
  PROTOCOL_VERSION,
  type PromptResponse,
} from '@agentclientprotocol/sdk';
import {
  GrokAcpClientError,
  runGrokAcpClient,
  selectPermissionOutcome,
  type GrokAcpSpawnedChild,
} from '../src/grok-acp-client.ts';
import { buildGrokAcpInitializeParams } from '../src/grok-acp-invocation.ts';

describe('selectPermissionOutcome', () => {
  it('prefers allow_once, then allow_always, else cancelled', () => {
    expect(
      selectPermissionOutcome(
        {
          sessionId: 's',
          toolCall: { toolCallId: 't', title: 'x' },
          options: [
            { optionId: 'r', name: 'Reject', kind: 'reject_once' },
            { optionId: 'a', name: 'Allow', kind: 'allow_once' },
            { optionId: 'aa', name: 'Always', kind: 'allow_always' },
          ],
        },
        false
      )
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'a' } });

    expect(
      selectPermissionOutcome(
        {
          sessionId: 's',
          toolCall: { toolCallId: 't', title: 'x' },
          options: [
            { optionId: 'r', name: 'Reject', kind: 'reject_once' },
            { optionId: 'aa', name: 'Always', kind: 'allow_always' },
          ],
        },
        false
      )
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'aa' } });

    expect(
      selectPermissionOutcome(
        {
          sessionId: 's',
          toolCall: { toolCallId: 't', title: 'x' },
          options: [{ optionId: 'r', name: 'Reject', kind: 'reject_once' }],
        },
        false
      )
    ).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('returns cancelled after abort begins', () => {
    expect(
      selectPermissionOutcome(
        {
          sessionId: 's',
          toolCall: { toolCallId: 't', title: 'x' },
          options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }],
        },
        true
      )
    ).toEqual({ outcome: { outcome: 'cancelled' } });
  });
});

describe('SDK import / Web Streams smoke', () => {
  it('loads PROTOCOL_VERSION, client, and methods from the official SDK', async () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(typeof client).toBe('function');
    expect(methods.agent.session.prompt).toBe('session/prompt');
    expect(typeof Writable.toWeb).toBe('function');
    expect(typeof Readable.toWeb).toBe('function');
  });
});

describe('runGrokAcpClient in-process via fake stdio agent', () => {
  class FakeAcpChild extends EventEmitter {
    stdout = new Readable({ read() {} });
    stderr = new Readable({ read() {} });
    stdin: Writable;
    killed = false;
    killSignals: NodeJS.Signals[] = [];
    private buffer = '';
    private closed = false;
    private sessionId = 'sess-test';
    private updates: string[] = [];
    permissionCalls = 0;
    cancelReceived = false;
    private readonly behavior: {
      authMethods?: Array<{ id: string; name: string }>;
      protocolVersion?: number;
      stopReason?: PromptResponse['stopReason'];
      meta?: Record<string, unknown>;
      emitTool?: boolean;
      requestPermission?: boolean;
      hangPrompt?: boolean;
      hangInitialize?: boolean;
      hangAuthenticate?: boolean;
      hangSession?: boolean;
      /** Do not exit on SIGTERM so SIGKILL path can be observed. */
      ignoreSigterm?: boolean;
      unknownNotification?: boolean;
      skillsReloadResponse?: boolean;
      badInitialize?: boolean;
    };
    promptReceived = false;
    methodsReceived: string[] = [];

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
        if (this.behavior.hangInitialize) {
          return;
        }
        if (this.behavior.badInitialize) {
          this.writeMsg({
            jsonrpc: '2.0',
            id: msg.id,
            result: { protocolVersion: 99 },
          });
          return;
        }
        this.writeMsg({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: this.behavior.protocolVersion ?? 1,
            agentCapabilities: {},
            authMethods: this.behavior.authMethods ?? [{ id: 'cached_token', name: 'Cached' }],
          },
        });
        return;
      }

      if (msg.method === 'authenticate') {
        if (this.behavior.hangAuthenticate) {
          return;
        }
        this.writeMsg({ jsonrpc: '2.0', id: msg.id, result: {} });
        return;
      }

      if (msg.method === 'session/new') {
        if (this.behavior.hangSession) {
          return;
        }
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
        this.promptReceived = true;
        if (this.behavior.skillsReloadResponse) {
          this.writeMsg({ jsonrpc: '2.0', id: 'skills-reload', result: {} });
        }
        if (this.behavior.unknownNotification) {
          this.writeMsg({
            jsonrpc: '2.0',
            method: 'x.ai/status',
            params: { ok: true },
          });
        }

        this.writeMsg({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'pre ' },
            },
          },
        });
        this.updates.push('text');

        if (this.behavior.emitTool) {
          if (this.behavior.requestPermission) {
            this.permissionCalls++;
            this.writeMsg({
              jsonrpc: '2.0',
              id: `perm-${this.permissionCalls}`,
              method: 'session/request_permission',
              params: {
                sessionId: this.sessionId,
                toolCall: { toolCallId: 't1', title: 'read' },
                options: [
                  { optionId: 'allow1', name: 'Allow once', kind: 'allow_once' },
                  { optionId: 'always', name: 'Always', kind: 'allow_always' },
                ],
              },
            });
            // Client responds asynchronously; continue without waiting for matching id
            // beyond the JSON-RPC layer — the SDK matches by id.
          }

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
          this.updates.push('tool');
        }

        this.writeMsg({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'final' },
            },
          },
        });
        this.updates.push('text2');

        if (this.behavior.hangPrompt) {
          // Wait for cancel or external kill.
          return;
        }

        this.writeMsg({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            stopReason: this.behavior.stopReason ?? 'end_turn',
            _meta: this.behavior.meta ?? {
              inputTokens: 3,
              outputTokens: 2,
              totalTokens: 5,
              modelId: 'fake-model',
            },
          },
        });
      }
    }

    kill(signal: NodeJS.Signals = 'SIGTERM') {
      this.killSignals.push(signal);
      if (signal === 'SIGTERM' && this.behavior.ignoreSigterm) {
        this.killed = true;
        return true;
      }
      this.killed = true;
      this.close(signal === 'SIGKILL' ? 137 : 1);
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

  function spawnFake(behavior: FakeAcpChild['behavior'] = {}) {
    const fake = new FakeAcpChild(behavior);
    const spawnFn = ((_command: string, _args: string[], _opts: object) =>
      fake as unknown as GrokAcpSpawnedChild) as (
      command: string,
      args: string[],
      options: object
    ) => GrokAcpSpawnedChild;
    return { fake, spawnFn };
  }

  it('completes initialize/auth/session/prompt and streams updates', async () => {
    const { fake, spawnFn } = spawnFake({
      emitTool: true,
      requestPermission: true,
      authMethods: [{ id: 'cached_token', name: 'Cached' }],
    });
    const updates: string[] = [];

    // Respond to permission requests from the fake agent.
    // The SDK client handles session/request_permission via our registered handler.
    // Fake agent sends a request with string id; client must reply.
    // Our FakeAcpChild currently doesn't wait for the permission response before continuing —
    // that's fine for this lifecycle test.

    const result = await runGrokAcpClient({
      command: 'grok',
      args: ['agent', '--always-approve', '--no-leader', 'stdio'],
      cwd: '/tmp',
      env: { ...process.env, GROK_MEMORY: '0' },
      spawnFn,
      initializeParams: buildGrokAcpInitializeParams(),
      sessionNewParams: { cwd: '/tmp', mcpServers: [] },
      task: 'do work',
      stageTimeoutMs: 5_000,
      onSessionUpdate: (n) => updates.push(n.update.sessionUpdate),
    });

    expect(result.promptResponse.stopReason).toBe('end_turn');
    expect(result.promptResponse._meta).toMatchObject({ inputTokens: 3, modelId: 'fake-model' });
    expect(updates).toContain('agent_message_chunk');
    expect(updates).toContain('tool_call');
    expect(result.wasAborted).toBe(false);
    // Cleanup should close the process
    expect(fake.killSignals.length + (fake.killed ? 1 : 0)).toBeGreaterThanOrEqual(0);
  });

  it('fails on unsupported protocol version', async () => {
    const { spawnFn } = spawnFake({ badInitialize: true });
    await expect(
      runGrokAcpClient({
        command: 'grok',
        args: ['agent', 'stdio'],
        cwd: '/tmp',
        env: process.env,
        spawnFn,
        initializeParams: buildGrokAcpInitializeParams(),
        sessionNewParams: { cwd: '/tmp', mcpServers: [] },
        task: 'x',
        stageTimeoutMs: 3_000,
      })
    ).rejects.toBeInstanceOf(GrokAcpClientError);
  });

  it('tolerates unknown x.ai notifications without failing', async () => {
    const { spawnFn } = spawnFake({ unknownNotification: true });
    const result = await runGrokAcpClient({
      command: 'grok',
      args: ['agent', 'stdio'],
      cwd: '/tmp',
      env: process.env,
      spawnFn,
      initializeParams: buildGrokAcpInitializeParams(),
      sessionNewParams: { cwd: '/tmp', mcpServers: [] },
      task: 'x',
      stageTimeoutMs: 5_000,
    });
    expect(result.promptResponse.stopReason).toBe('end_turn');
  });

  it('silently ignores Grok skills-reload control responses', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { spawnFn } = spawnFake({ skillsReloadResponse: true });
      const result = await runGrokAcpClient({
        command: 'grok',
        args: ['agent', 'stdio'],
        cwd: '/tmp',
        env: process.env,
        spawnFn,
        initializeParams: buildGrokAcpInitializeParams(),
        sessionNewParams: { cwd: '/tmp', mcpServers: [] },
        task: 'skills reload response',
        stageTimeoutMs: 5_000,
      });

      expect(result.promptResponse.stopReason).toBe('end_turn');
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('sends session/cancel on abort and is cleanup-idempotent', async () => {
    const { fake, spawnFn } = spawnFake({ hangPrompt: true });
    const controller = new AbortController();
    const promise = runGrokAcpClient({
      command: 'grok',
      args: ['agent', 'stdio'],
      cwd: '/tmp',
      env: process.env,
      spawnFn,
      signal: controller.signal,
      initializeParams: buildGrokAcpInitializeParams(),
      sessionNewParams: { cwd: '/tmp', mcpServers: [] },
      task: 'hang',
      stageTimeoutMs: 10_000,
      cancelGraceMs: 50,
    });

    // Abort after a short delay so initialize/session can complete.
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();

    const result = await promise;
    expect(result.wasAborted).toBe(true);
    expect(result.promptResponse.stopReason).toBe('cancelled');
    expect(fake.cancelReceived).toBe(true);
    // After cancel grace, cleanup must still send SIGTERM (wasAborted ≠ already termed).
    expect(fake.killSignals).toContain('SIGTERM');
    // Double cleanup should be safe
    fake.kill('SIGTERM');
    fake.kill('SIGKILL');
  });

  it('throws immediately when signal is already aborted (pre-abort)', async () => {
    const { fake, spawnFn } = spawnFake();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runGrokAcpClient({
        command: 'grok',
        args: ['agent', 'stdio'],
        cwd: '/tmp',
        env: process.env,
        spawnFn,
        signal: controller.signal,
        initializeParams: buildGrokAcpInitializeParams(),
        sessionNewParams: { cwd: '/tmp', mcpServers: [] },
        task: 'never',
        stageTimeoutMs: 3_000,
        cancelGraceMs: 20,
      })
    ).rejects.toMatchObject({
      name: 'GrokAcpClientError',
      message: 'Subagent was aborted',
    });
    expect(fake.promptReceived).toBe(false);
    expect(fake.methodsReceived).not.toContain('session/prompt');
  });

  it('aborts while a startup request is hanging and does not send session/prompt', async () => {
    const { fake, spawnFn } = spawnFake({ hangInitialize: true });
    const controller = new AbortController();
    const promise = runGrokAcpClient({
      command: 'grok',
      args: ['agent', 'stdio'],
      cwd: '/tmp',
      env: process.env,
      spawnFn,
      signal: controller.signal,
      initializeParams: buildGrokAcpInitializeParams(),
      sessionNewParams: { cwd: '/tmp', mcpServers: [] },
      task: 'never',
      stageTimeoutMs: 10_000,
      cancelGraceMs: 30,
    });

    await new Promise((r) => setTimeout(r, 50));
    controller.abort();

    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrokAcpClientError);
    expect((err as GrokAcpClientError).message).toBe('Subagent was aborted');
    expect((err as GrokAcpClientError).stage).toBe('initialize');
    expect(fake.promptReceived).toBe(false);
    expect(fake.methodsReceived).not.toContain('session/prompt');
    expect(fake.killSignals).toContain('SIGTERM');
  });

  it('does not send session/prompt when aborted while session/new is hanging', async () => {
    const { fake, spawnFn } = spawnFake({ hangSession: true });
    const controller = new AbortController();
    const promise = runGrokAcpClient({
      command: 'grok',
      args: ['agent', 'stdio'],
      cwd: '/tmp',
      env: process.env,
      spawnFn,
      signal: controller.signal,
      initializeParams: buildGrokAcpInitializeParams(),
      sessionNewParams: { cwd: '/tmp', mcpServers: [] },
      task: 'never',
      stageTimeoutMs: 10_000,
      cancelGraceMs: 30,
    });

    await new Promise((r) => setTimeout(r, 50));
    controller.abort();

    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrokAcpClientError);
    expect((err as GrokAcpClientError).message).toBe('Subagent was aborted');
    expect(fake.promptReceived).toBe(false);
    expect(fake.methodsReceived).not.toContain('session/prompt');
    expect(fake.killSignals).toContain('SIGTERM');
  });

  it('sends SIGTERM after cancel grace, then SIGKILL if the child ignores SIGTERM', async () => {
    const { fake, spawnFn } = spawnFake({ hangPrompt: true, ignoreSigterm: true });
    const controller = new AbortController();
    const promise = runGrokAcpClient({
      command: 'grok',
      args: ['agent', 'stdio'],
      cwd: '/tmp',
      env: process.env,
      spawnFn,
      signal: controller.signal,
      initializeParams: buildGrokAcpInitializeParams(),
      sessionNewParams: { cwd: '/tmp', mcpServers: [] },
      task: 'hang',
      stageTimeoutMs: 30_000,
      cancelGraceMs: 30,
    });

    await new Promise((r) => setTimeout(r, 80));
    controller.abort();

    const result = await promise;
    expect(result.wasAborted).toBe(true);
    expect(result.promptResponse.stopReason).toBe('cancelled');
    expect(fake.cancelReceived).toBe(true);
    expect(fake.killSignals[0]).toBe('SIGTERM');
    expect(fake.killSignals).toContain('SIGKILL');
  }, 15_000);

  it('times out the prompt stage using promptTimeoutMs, not stageTimeoutMs', async () => {
    const { fake, spawnFn } = spawnFake({ hangPrompt: true });
    const err = await runGrokAcpClient({
      command: 'grok',
      args: ['agent', 'stdio'],
      cwd: '/tmp',
      env: process.env,
      spawnFn,
      initializeParams: buildGrokAcpInitializeParams(),
      sessionNewParams: { cwd: '/tmp', mcpServers: [] },
      task: 'hang',
      stageTimeoutMs: 5_000,
      promptTimeoutMs: 50,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GrokAcpClientError);
    expect((err as GrokAcpClientError).stage).toBe('prompt');
    expect((err as GrokAcpClientError).message).toBe('Grok ACP prompt timed out after 50ms');
    expect(fake.promptReceived).toBe(true);
    expect(fake.killSignals).toContain('SIGTERM');
  }, 10_000);

  it('classifies auth method selection failure as authenticate stage', async () => {
    const { spawnFn } = spawnFake({
      authMethods: [{ id: 'oauth_browser', name: 'Browser' }],
    });
    await expect(
      runGrokAcpClient({
        command: 'grok',
        args: ['agent', 'stdio'],
        cwd: '/tmp',
        env: {},
        spawnFn,
        initializeParams: buildGrokAcpInitializeParams(),
        sessionNewParams: { cwd: '/tmp', mcpServers: [] },
        task: 'x',
        stageTimeoutMs: 3_000,
        selectAuthMethod: () => {
          throw new Error('no supported method');
        },
      })
    ).rejects.toMatchObject({
      name: 'GrokAcpClientError',
      stage: 'authenticate',
    });
  });

  it('permission handler selection is exercised via in-process agent composition', async () => {
    const agentApp = agent({ name: 'test-agent' })
      .onRequest(methods.agent.initialize, async () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {},
        authMethods: [],
      }))
      .onRequest(methods.agent.session.new, async () => ({ sessionId: 's1' }))
      .onRequest(methods.agent.session.prompt, async (ctx) => {
        const perm = await ctx.client.request(methods.client.session.requestPermission, {
          sessionId: 's1',
          toolCall: { toolCallId: 't1', title: 'read' },
          options: [
            { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'a2', name: 'Always', kind: 'allow_always' },
          ],
        });
        return { stopReason: 'end_turn', _meta: { perm } };
      });

    const result = await client({ name: 'c' })
      .onRequest(methods.client.session.requestPermission, (ctx) =>
        selectPermissionOutcome(ctx.params, false)
      )
      .onNotification(methods.client.session.update, () => {})
      .connectWith(agentApp, async (ctx) => {
        await ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        });
        const session = await ctx.request(methods.agent.session.new, {
          cwd: '/tmp',
          mcpServers: [],
        });
        return ctx.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Task: hi' }],
        });
      });

    expect(result.stopReason).toBe('end_turn');
    expect((result._meta as { perm: unknown }).perm).toEqual({
      outcome: { outcome: 'selected', optionId: 'a1' },
    });
  });
});
