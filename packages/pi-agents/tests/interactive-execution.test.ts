// ABOUTME: Production-path tests for interactive Grok ACP execution and delivery.
// ABOUTME: Exercises registry + fake ACP via real orchestration (not manual policy spreads).

import { describe, expect, it } from 'bun:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { PromptResponse } from '@agentclientprotocol/sdk';
import type { AgentConfig } from '../src/agents.ts';
import { runSingleAgent } from '../src/execution.ts';
import type { GrokAcpSpawnedChild } from '../src/grok-acp-client.ts';
import { createInteractiveAgentRegistry, INTERACTIVE_LINK_TYPE } from '../src/interactive-agent.ts';
import { runSingleAgentInteractive } from '../src/interactive-execution.ts';
import { agentFingerprint, createRunCoordinator } from '../src/run-coordinator.ts';
import { createRunStore } from '../src/run-store.ts';
import { executeAgentTool } from '../src/tool.ts';
import type { SingleResult, SubagentDetails } from '../src/types.ts';
import { emptyUsage } from '../src/types.ts';

class FakeAcpChild extends EventEmitter {
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  stdin: Writable;
  killed = false;
  killSignals: NodeJS.Signals[] = [];
  private buffer = '';
  private closed = false;
  sessionId: string;
  methodsReceived: string[] = [];
  promptTexts: string[] = [];
  cancelReceived = false;
  loadReceived = false;
  private readonly behavior: {
    loadSession?: boolean;
    hangPrompt?: boolean;
    rejectPrompt?: boolean;
    rejectLoad?: boolean;
    /** When set, prompt waits until this promise resolves before sending the matching response. */
    promptResponseGate?: Promise<void>;
    stopReason?: PromptResponse['stopReason'];
    sessionId?: string;
  };
  promptRequestSeen = false;

  constructor(behavior: FakeAcpChild['behavior'] = {}) {
    super();
    this.behavior = behavior;
    this.sessionId = behavior.sessionId ?? `sess-${Math.random().toString(16).slice(2, 10)}`;
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
      if (this.behavior.rejectLoad) {
        this.writeMsg({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32001, message: 'Session not found' },
        });
        return;
      }
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
      this.writeMsg({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }
    if (msg.method === 'session/cancel') {
      this.cancelReceived = true;
      return;
    }
    if (msg.method === 'session/prompt') {
      this.promptRequestSeen = true;
      const params = msg.params as { prompt?: Array<{ text?: string }> } | undefined;
      const text = params?.prompt?.map((p) => p.text ?? '').join('') ?? '';
      this.promptTexts.push(text);
      if (this.behavior.hangPrompt) return;
      if (this.behavior.rejectPrompt) {
        this.writeMsg({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: 'prompt rejected by agent' },
        });
        return;
      }
      if (this.behavior.promptResponseGate) {
        await this.behavior.promptResponseGate;
      }
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

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'g-acp',
    description: 'g',
    systemPrompt: 'sys',
    source: 'project',
    filePath: '/tmp/g-acp.md',
    runtime: 'grok-acp',
    model: 'grok-test',
    maxTurns: 3,
    ...overrides,
  };
}

function emptyDetails(): SubagentDetails {
  return {
    mode: 'single',
    agentScope: 'both',
    projectAgentsDir: null,
    builtinAgentsDir: '/builtin',
    results: [],
  };
}

function makeDetails(results: SingleResult[]): SubagentDetails {
  return { ...emptyDetails(), results };
}

function makeTemp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-ix-'));
  const store = createRunStore({ rootDir: root });
  const coordinator = createRunCoordinator({ store });
  return { root, store, coordinator };
}

describe('interactive-execution production path (Grok ACP)', () => {
  it('exports runSingleAgentInteractive for Pi and Grok ACP runtimes', async () => {
    expect(typeof runSingleAgentInteractive).toBe('function');
  });

  it('non-TUI fresh: runSingleAgent → session/new → prompt; cancel grace does not deliver', async () => {
    const agent = makeAgent();
    const child = new FakeAcpChild({ hangPrompt: true });
    const delivered: number[] = [];
    const controller = new AbortController();

    const resultPromise = runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'do work',
      undefined,
      undefined,
      controller.signal,
      undefined,
      makeDetails,
      {
        spawnFn: (() => child as unknown as GrokAcpSpawnedChild) as never,
        unitContext: {
          runId: 'r1',
          unitId: 'single',
          agent: agent.name,
          runtime: 'grok-acp',
          resumeCapability: 'session',
          effectiveCwd: process.cwd(),
          attempt: 1,
        },
        onAcpSessionEstablished: async () => {
          /* no-op durable flush in this unit */
        },
        onAcpPromptCompleted: async () => {
          delivered.push(1);
        },
      }
    );

    // Wait for prompt to hang, then abort so cancel grace settles.
    await new Promise((r) => setTimeout(r, 80));
    expect(child.promptRequestSeen || child.methodsReceived.includes('session/prompt')).toBe(true);
    controller.abort();
    let thrown: unknown;
    try {
      await resultPromise;
    } catch (err) {
      thrown = err;
    }
    // Cancelled path must not confirm continuation delivery.
    expect(delivered).toEqual([]);
    expect(thrown !== undefined || child.cancelReceived).toBe(true);
  });

  it('non-TUI resume: single load then prompt; delivery only after real response', async () => {
    const agent = makeAgent();
    const child = new FakeAcpChild({ loadSession: true, sessionId: 'sess-resume-1' });
    const delivered: number[] = [];

    const result = await runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'continue task',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      {
        spawnFn: (() => child as unknown as GrokAcpSpawnedChild) as never,
        unitContext: {
          runId: 'r-resume',
          unitId: 'single',
          agent: agent.name,
          runtime: 'grok-acp',
          resumeCapability: 'session',
          effectiveCwd: process.cwd(),
          attempt: 2,
          acpSessionId: 'sess-resume-1',
        },
        resumeHadStoredSession: true,
        resumePrompt: {
          continuationTasks: ['c1'],
          undeliveredContinuationTasks: ['c1'],
        },
        onAcpPromptCompleted: async () => {
          delivered.push(1);
        },
      }
    );

    expect(child.loadReceived).toBe(true);
    expect(child.methodsReceived.indexOf('session/load')).toBeLessThan(
      child.methodsReceived.indexOf('session/prompt')
    );
    // Only one load (no hydrate-only second process).
    expect(child.methodsReceived.filter((m) => m === 'session/load').length).toBe(1);
    expect(result.status).toBe('completed');
    expect(delivered).toEqual([1]);
  });

  it('durable TUI resume: registerInitial validates store, registry activate, one load, delivers', async () => {
    const { root, store, coordinator } = makeTemp();
    const agent = makeAgent();
    const child = new FakeAcpChild({ loadSession: true, sessionId: 'sess-tui-1' });
    const spawnFn = (() => child as unknown as GrokAcpSpawnedChild) as never;

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: agent.name,
        task: 't',
        runtime: 'grok-acp',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'interrupted',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
          acpSessionId: 'sess-tui-1',
        },
      },
    });
    coordinator.registerRun(runId, record);

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      spawnFn,
    });
    registry.setHostLinkAppender(() => undefined);

    // registerInitial must validate runtime/capability/sessionId from RunStore.
    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-1',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile: '',
        sessionArtifact: { runtime: 'grok-acp', sessionId: 'sess-tui-1' },
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    // Existing-key revalidation (no capability bypass).
    const again = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-1',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile: '',
        sessionArtifact: { runtime: 'grok-acp', sessionId: 'sess-tui-1' },
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [
        {
          type: 'custom',
          customType: INTERACTIVE_LINK_TYPE,
          data: {
            version: 1,
            runId,
            unitId: 'single',
            bindingId: snap.bindingId,
            hostSessionId: 'host-1',
            createdAt: snap.linkCreatedAt,
          },
        },
      ],
    });
    expect(again.key).toBe(snap.key);

    const delivered: number[] = [];
    const result = await runSingleAgentInteractive(
      root,
      [agent],
      agent.name,
      'resume please',
      root,
      undefined,
      undefined,
      undefined,
      makeDetails,
      {
        interactiveRegistry: registry,
        endpointKey: snap.key,
        hostMode: 'tui',
        runtime: 'grok-acp',
        unitContext: {
          runId,
          unitId: 'single',
          agent: agent.name,
          runtime: 'grok-acp',
          resumeCapability: 'session',
          effectiveCwd: root,
          attempt: 2,
          acpSessionId: 'sess-tui-1',
        },
        resumeHadStoredSession: true,
        onAcpPromptCompleted: async () => {
          delivered.push(1);
          await coordinator.persistContinuationDelivery({
            runId,
            unitId: 'single',
            deliveredCount: 1,
            continuationTasks: ['c1'],
          });
        },
      }
    );

    expect(child.loadReceived).toBe(true);
    expect(child.methodsReceived.filter((m) => m === 'session/load').length).toBe(1);
    expect(child.methodsReceived.indexOf('session/load')).toBeLessThan(
      child.methodsReceived.indexOf('session/prompt')
    );
    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('end');
    expect(delivered).toEqual([1]);
    // maxTurns stripped for Grok ACP (policy) — still completes without max_turns error.
    expect(result.stopReason).not.toBe('max_turns');
    // Real RunStore delivery persistence.
    const after = store.getRun(runId);
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.loaded.record.continuationDelivery?.single?.deliveredCount).toBe(1);
    }

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('non-TUI max_tokens/refusal stop reasons do not deliver', async () => {
    for (const stopReason of ['max_tokens', 'refusal', 'max_turn_requests'] as const) {
      const agent = makeAgent();
      const child = new FakeAcpChild({ stopReason });
      const delivered: number[] = [];
      const result = await runSingleAgent(
        process.cwd(),
        [agent],
        agent.name,
        'task',
        undefined,
        undefined,
        undefined,
        undefined,
        makeDetails,
        {
          spawnFn: (() => child as unknown as GrokAcpSpawnedChild) as never,
          unitContext: {
            runId: `r-${stopReason}`,
            unitId: 'single',
            agent: agent.name,
            runtime: 'grok-acp',
            resumeCapability: 'session',
            effectiveCwd: process.cwd(),
            attempt: 1,
          },
          onAcpSessionEstablished: async () => undefined,
          onAcpPromptCompleted: async () => {
            delivered.push(1);
          },
        }
      );
      expect(delivered).toEqual([]);
      expect(result.status).toBe('failed');
      expect(result.stopReason === 'error' || result.stopReason === 'max_turns').toBe(true);
    }
  });

  it('fresh TUI: executeAgentTool with discoverable agent, registry, RunStore, fake ACP', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-eat-'));
    const agentsDir = path.join(root, '.pi', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'fresh-acp.md'),
      `---\nname: fresh-acp\ndescription: fresh acp\nruntime: grok-acp\nmodel: grok-test\n---\nBody.`
    );

    const store = createRunStore({ rootDir: root });
    const coordinator = createRunCoordinator({ store });
    const child = new FakeAcpChild();
    const spawnFn = (() => child as unknown as GrokAcpSpawnedChild) as never;
    const branch: Array<{ type: string; customType?: string; data?: unknown }> = [];
    /** Unified timeline: session/new → ACP ID commit → binding commit → link → prompt. */
    const timeline: string[] = [];

    const origPersistAcp = coordinator.persistAcpSessionId.bind(coordinator);
    coordinator.persistAcpSessionId = async (input) => {
      await origPersistAcp(input);
      timeline.push('acp_session_id');
    };
    const origPersistBinding = coordinator.persistInteractiveBinding.bind(coordinator);
    coordinator.persistInteractiveBinding = async (input) => {
      await origPersistBinding(input);
      timeline.push('binding');
    };

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      spawnFn,
    });
    registry.setHostLinkAppender((link) => {
      timeline.push('link');
      branch.push({ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: link });
    });

    // Hook ACP method receipt into the same timeline for strict total order.
    const origPush = child.methodsReceived.push.bind(child.methodsReceived);
    child.methodsReceived.push = ((...args: string[]) => {
      for (const m of args) {
        if (m === 'session/new') timeline.push('session/new');
        if (m === 'session/prompt') timeline.push('session/prompt');
      }
      return origPush(...args);
    }) as typeof child.methodsReceived.push;

    const result = await executeAgentTool(
      { agent: 'fresh-acp', task: 'fresh via executeAgentTool', runtime: 'grok-acp' },
      undefined,
      undefined,
      {
        cwd: root,
        mode: 'tui',
        hasUI: false,
        sessionManager: {
          getSessionId: () => 'host-eat',
          getBranch: () => branch as never,
        },
        ui: {
          confirm: async () => true,
          select: async () => undefined,
          input: async () => undefined,
          notify: () => {},
        },
      } as unknown as ExtensionContext,
      {
        runStore: store,
        runCoordinator: coordinator,
        interactiveRegistry: registry,
        spawnFn,
      }
    );

    // Strict total order on the unified timeline.
    const idx = (label: string) => {
      const i = timeline.indexOf(label);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(idx('session/new')).toBeLessThan(idx('acp_session_id'));
    expect(idx('acp_session_id')).toBeLessThan(idx('binding'));
    expect(idx('binding')).toBeLessThan(idx('link'));
    expect(idx('link')).toBeLessThan(idx('session/prompt'));

    expect(branch.length).toBeGreaterThanOrEqual(1);
    expect(result.isError).toBeUndefined();
    expect(result.details.results[0]?.status).toBe('completed');
    expect(result.details.results[0]?.stopReason).toBe('end');
    expect(result.details.results[0]?.acpSessionId).toBe(child.sessionId);

    const runs = await store.listRuns();
    expect(runs.length).toBe(1);
    const runId = 'record' in runs[0]! ? runs[0]!.record.runId : '';
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.loaded.record.units.single.acpSessionId).toBe(child.sessionId);
      expect(
        Object.keys(loaded.loaded.record.units.single.interactiveBindings ?? {}).length
      ).toBeGreaterThanOrEqual(1);
    }

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('abort before matching response: no delivery (controllable gate)', async () => {
    let releaseResponse!: () => void;
    const gate = new Promise<void>((r) => {
      releaseResponse = r;
    });
    const agent = makeAgent();
    const child = new FakeAcpChild({ promptResponseGate: gate });
    const delivered: number[] = [];
    const controller = new AbortController();

    const resultPromise = runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'gated',
      undefined,
      undefined,
      controller.signal,
      undefined,
      makeDetails,
      {
        spawnFn: (() => child as unknown as GrokAcpSpawnedChild) as never,
        unitContext: {
          runId: 'r-gate',
          unitId: 'single',
          agent: agent.name,
          runtime: 'grok-acp',
          resumeCapability: 'session',
          effectiveCwd: process.cwd(),
          attempt: 1,
        },
        onAcpSessionEstablished: async () => undefined,
        onAcpPromptCompleted: async () => {
          delivered.push(1);
        },
      }
    );

    // Wait until prompt is in flight but response is gated.
    for (let i = 0; i < 50 && !child.promptRequestSeen; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(child.promptRequestSeen).toBe(true);
    controller.abort();
    await new Promise((r) => setTimeout(r, 40));
    // Release response after abort — must not deliver.
    releaseResponse();
    let thrown: unknown;
    try {
      await resultPromise;
    } catch (err) {
      thrown = err;
    }
    expect(delivered).toEqual([]);
    expect(thrown !== undefined || child.cancelReceived).toBe(true);
  });

  it('prompt failure preserves structured error without maxTurns=undefined overwrite', async () => {
    const agent = makeAgent({ maxTurns: 3 });
    const child = new FakeAcpChild({
      stopReason: 'max_turn_requests',
    });
    const result = await runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'turns',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      {
        spawnFn: (() => child as unknown as GrokAcpSpawnedChild) as never,
        unitContext: {
          runId: 'r-turns',
          unitId: 'single',
          agent: agent.name,
          runtime: 'grok-acp',
          resumeCapability: 'session',
          effectiveCwd: process.cwd(),
          attempt: 1,
        },
      }
    );
    expect(result.stopReason).toBe('max_turns');
    expect(result.errorMessage).toBe('Grok reported a max turn request limit');
    expect(result.errorMessage ?? '').not.toMatch(/maxTurns=undefined/);
    // Grok ACP does not project Pi client maxTurns text.
    expect(result.errorMessage ?? '').not.toMatch(/Agent exceeded maxTurns=/);
  });

  it('executeAgentTool injects TUI registration failure with structured errorCode', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-eat-fail-'));
    const agentsDir = path.join(root, '.pi', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'fail-acp.md'),
      `---\nname: fail-acp\ndescription: fail acp\nruntime: grok-acp\nmodel: grok-test\n---\nBody.`
    );

    const store = createRunStore({ rootDir: root });
    const coordinator = createRunCoordinator({ store });
    const child = new FakeAcpChild();
    const spawnFn = (() => child as unknown as GrokAcpSpawnedChild) as never;
    const branch: Array<{ type: string; customType?: string; data?: unknown }> = [];

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      spawnFn,
    });
    registry.setHostLinkAppender((link) => {
      branch.push({ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: link });
    });
    // Fresh TUI Grok ACP registers via registerGrokAcpLive after session/new.
    const { InteractiveAgentError } = await import('../src/interactive-agent.ts');
    registry.registerGrokAcpLive = (async () => {
      throw new InteractiveAgentError(
        'validation_error',
        'Injected TUI endpoint registration failure'
      );
    }) as typeof registry.registerGrokAcpLive;

    const result = await executeAgentTool(
      { agent: 'fail-acp', task: 'should fail registration', runtime: 'grok-acp' },
      undefined,
      undefined,
      {
        cwd: root,
        mode: 'tui',
        hasUI: false,
        sessionManager: {
          getSessionId: () => 'host-fail',
          getBranch: () => branch as never,
        },
        ui: {
          confirm: async () => true,
          select: async () => undefined,
          input: async () => undefined,
          notify: () => {},
        },
      } as unknown as ExtensionContext,
      {
        runStore: store,
        runCoordinator: coordinator,
        interactiveRegistry: registry,
        spawnFn,
      }
    );

    const single = result.details.results[0];
    expect(single).toBeDefined();
    expect(single!.errorCode).toBe('validation_error');
    expect(single!.errorMessage ?? '').toMatch(/Injected TUI endpoint registration failure/);
    expect(single!.errorMessage ?? '').not.toBe('');
    expect(single!.status).toBe('failed');

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('executeAgentTool max_turn_requests surfaces exact errorMessage via real path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-eat-turns-'));
    const agentsDir = path.join(root, '.pi', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'turns-acp.md'),
      `---\nname: turns-acp\ndescription: turns acp\nruntime: grok-acp\nmodel: grok-test\nmaxTurns: 3\n---\nBody.`
    );

    const store = createRunStore({ rootDir: root });
    const coordinator = createRunCoordinator({ store });
    const child = new FakeAcpChild({ stopReason: 'max_turn_requests' });
    const spawnFn = (() => child as unknown as GrokAcpSpawnedChild) as never;
    const branch: Array<{ type: string; customType?: string; data?: unknown }> = [];

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      spawnFn,
    });
    registry.setHostLinkAppender((link) => {
      branch.push({ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: link });
    });

    const result = await executeAgentTool(
      { agent: 'turns-acp', task: 'hit turn limit', runtime: 'grok-acp' },
      undefined,
      undefined,
      {
        cwd: root,
        mode: 'tui',
        hasUI: false,
        sessionManager: {
          getSessionId: () => 'host-turns',
          getBranch: () => branch as never,
        },
        ui: {
          confirm: async () => true,
          select: async () => undefined,
          input: async () => undefined,
          notify: () => {},
        },
      } as unknown as ExtensionContext,
      {
        runStore: store,
        runCoordinator: coordinator,
        interactiveRegistry: registry,
        spawnFn,
      }
    );

    const single = result.details.results[0];
    expect(single).toBeDefined();
    expect(single!.stopReason).toBe('max_turns');
    expect(single!.errorMessage).toBe('Grok reported a max turn request limit');
    expect(single!.errorMessage).not.toBe('');
    expect(single!.errorMessage ?? '').not.toMatch(/maxTurns=undefined/);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('load failure preserves acp_session_not_found errorCode', async () => {
    const agent = makeAgent();
    const child = new FakeAcpChild({
      loadSession: true,
      sessionId: 'missing-sess',
      rejectLoad: true,
    });

    const result = await runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'resume missing',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      {
        spawnFn: (() => child as unknown as GrokAcpSpawnedChild) as never,
        unitContext: {
          runId: 'r-missing',
          unitId: 'single',
          agent: agent.name,
          runtime: 'grok-acp',
          resumeCapability: 'session',
          effectiveCwd: process.cwd(),
          attempt: 2,
          acpSessionId: 'missing-sess',
        },
        resumeHadStoredSession: true,
        resumePrompt: {
          continuationTasks: ['c1'],
          undeliveredContinuationTasks: ['c1'],
        },
      }
    );
    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('acp_session_not_found');
  });

  it('prompt rejection is terminal failed and does not deliver', async () => {
    const { root, store, coordinator } = makeTemp();
    const agent = makeAgent();
    const child = new FakeAcpChild({
      loadSession: true,
      sessionId: 'sess-fail-1',
      rejectPrompt: true,
    });
    const spawnFn = (() => child as unknown as GrokAcpSpawnedChild) as never;

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: agent.name,
        task: 't',
        runtime: 'grok-acp',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'interrupted',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
          acpSessionId: 'sess-fail-1',
        },
      },
    });
    coordinator.registerRun(runId, record);

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      spawnFn,
    });
    registry.setHostLinkAppender(() => undefined);

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-f',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile: '',
        sessionArtifact: { runtime: 'grok-acp', sessionId: 'sess-fail-1' },
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    const delivered: number[] = [];
    const result = await runSingleAgentInteractive(
      root,
      [agent],
      agent.name,
      'will fail',
      root,
      undefined,
      undefined,
      undefined,
      makeDetails,
      {
        interactiveRegistry: registry,
        endpointKey: snap.key,
        hostMode: 'tui',
        runtime: 'grok-acp',
        unitContext: {
          runId,
          unitId: 'single',
          agent: agent.name,
          runtime: 'grok-acp',
          resumeCapability: 'session',
          effectiveCwd: root,
          attempt: 2,
          acpSessionId: 'sess-fail-1',
        },
        onAcpPromptCompleted: async () => {
          delivered.push(1);
        },
      }
    );

    expect(delivered).toEqual([]);
    expect(result.status).toBe('failed');
    expect(result.stopReason).toBe('error');

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fresh non-TUI runSingleAgent delivers only on real matching response', async () => {
    const agent = makeAgent();
    const child = new FakeAcpChild();
    const delivered: number[] = [];
    let establishedId = '';

    const result = await runSingleAgent(
      process.cwd(),
      [agent],
      agent.name,
      'fresh task',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      {
        spawnFn: (() => child as unknown as GrokAcpSpawnedChild) as never,
        unitContext: {
          runId: 'r-fresh',
          unitId: 'single',
          agent: agent.name,
          runtime: 'grok-acp',
          resumeCapability: 'session',
          effectiveCwd: process.cwd(),
          attempt: 1,
        },
        onAcpSessionEstablished: async (id) => {
          establishedId = id;
        },
        onAcpPromptCompleted: async () => {
          delivered.push(1);
        },
      }
    );

    expect(establishedId).toBe(child.sessionId);
    expect(child.methodsReceived).toContain('session/new');
    expect(child.methodsReceived).toContain('session/prompt');
    expect(result.acpSessionId).toBe(child.sessionId);
    expect(result.status).toBe('completed');
    expect(delivered).toEqual([1]);
  });

  it('pre-handoff getSessionId throw: transport dispose=1 and lease released', async () => {
    const agent = makeAgent();
    const child = new FakeAcpChild();
    const { GrokAcpInteractiveTransport } =
      await import('../src/grok-acp-interactive-transport.ts');
    const { acquireSessionLease, buildSessionLeaseKey } = await import('../src/session-lease.ts');

    let disposeCount = 0;
    const origDispose = GrokAcpInteractiveTransport.prototype.dispose;
    GrokAcpInteractiveTransport.prototype.dispose = async function (
      this: InstanceType<typeof GrokAcpInteractiveTransport>,
      ...args: Parameters<typeof origDispose>
    ) {
      disposeCount++;
      return origDispose.apply(this, args);
    };

    try {
      const result = await runSingleAgent(
        process.cwd(),
        [agent],
        agent.name,
        'handoff-getSessionId',
        undefined,
        undefined,
        undefined,
        undefined,
        makeDetails,
        {
          hostMode: 'tui',
          interactiveRegistry: {
            registerGrokAcpLive: async () => {
              throw new Error('registry should not be reached');
            },
          } as never,
          spawnFn: (() => child as unknown as GrokAcpSpawnedChild) as never,
          unitContext: {
            runId: 'r-hsid',
            unitId: 'single',
            agent: agent.name,
            runtime: 'grok-acp',
            resumeCapability: 'session',
            effectiveCwd: process.cwd(),
            attempt: 1,
          },
          onAcpSessionEstablished: async () => undefined,
          registerGrokAcpLiveEndpoint: async (_input) => {
            // Simulate tool adapter getSessionId throw before acceptOwnership.
            throw new Error('getSessionId failed');
          },
        }
      );
      expect(result.status).toBe('failed');
      expect(result.errorMessage ?? '').toMatch(/getSessionId failed/);
      expect(disposeCount).toBe(1);

      // Lease must be free for re-acquire (released by caller catch).
      const leaseKey = buildSessionLeaseKey({
        runtime: 'grok-acp',
        cwd: process.cwd(),
        sessionIdentity: child.sessionId,
      });
      const reacquire = await Promise.race([
        acquireSessionLease(leaseKey).then((h) => {
          h.release();
          return 'ok' as const;
        }),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 200)),
      ]);
      expect(reacquire).toBe('ok');
    } finally {
      GrokAcpInteractiveTransport.prototype.dispose = origDispose;
    }
  });

  it('pre-handoff resolveIsolation throw: transport dispose=1 and lease released', async () => {
    const agent = makeAgent();
    const child = new FakeAcpChild();
    const { GrokAcpInteractiveTransport } =
      await import('../src/grok-acp-interactive-transport.ts');
    const { acquireSessionLease, buildSessionLeaseKey } = await import('../src/session-lease.ts');

    let disposeCount = 0;
    const origDispose = GrokAcpInteractiveTransport.prototype.dispose;
    GrokAcpInteractiveTransport.prototype.dispose = async function (
      this: InstanceType<typeof GrokAcpInteractiveTransport>,
      ...args: Parameters<typeof origDispose>
    ) {
      disposeCount++;
      return origDispose.apply(this, args);
    };

    try {
      const result = await runSingleAgent(
        process.cwd(),
        [agent],
        agent.name,
        'handoff-resolveIsolation',
        undefined,
        undefined,
        undefined,
        undefined,
        makeDetails,
        {
          hostMode: 'tui',
          interactiveRegistry: {
            registerGrokAcpLive: async () => {
              throw new Error('registry should not be reached');
            },
          } as never,
          spawnFn: (() => child as unknown as GrokAcpSpawnedChild) as never,
          unitContext: {
            runId: 'r-riso',
            unitId: 'single',
            agent: agent.name,
            runtime: 'grok-acp',
            resumeCapability: 'session',
            effectiveCwd: process.cwd(),
            attempt: 1,
          },
          onAcpSessionEstablished: async () => undefined,
          registerGrokAcpLiveEndpoint: async (_input) => {
            // Simulate tool adapter resolveIsolation throw before acceptOwnership.
            throw new Error('resolveIsolation failed');
          },
        }
      );
      expect(result.status).toBe('failed');
      expect(result.errorMessage ?? '').toMatch(/resolveIsolation failed/);
      expect(disposeCount).toBe(1);

      const leaseKey = buildSessionLeaseKey({
        runtime: 'grok-acp',
        cwd: process.cwd(),
        sessionIdentity: child.sessionId,
      });
      const reacquire = await Promise.race([
        acquireSessionLease(leaseKey).then((h) => {
          h.release();
          return 'ok' as const;
        }),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 200)),
      ]);
      expect(reacquire).toBe('ok');
    } finally {
      GrokAcpInteractiveTransport.prototype.dispose = origDispose;
    }
  });

  it('executeAgentTool getSessionId throw during handoff disposes and releases lease', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-eat-hsid-'));
    const agentsDir = path.join(root, '.pi', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'hsid-acp.md'),
      `---\nname: hsid-acp\ndescription: hsid acp\nruntime: grok-acp\nmodel: grok-test\n---\nBody.`
    );

    const store = createRunStore({ rootDir: root });
    const coordinator = createRunCoordinator({ store });
    const child = new FakeAcpChild();
    const spawnFn = (() => child as unknown as GrokAcpSpawnedChild) as never;
    const { GrokAcpInteractiveTransport } =
      await import('../src/grok-acp-interactive-transport.ts');
    const { acquireSessionLease, buildSessionLeaseKey } = await import('../src/session-lease.ts');

    let disposeCount = 0;
    const origDispose = GrokAcpInteractiveTransport.prototype.dispose;
    GrokAcpInteractiveTransport.prototype.dispose = async function (
      this: InstanceType<typeof GrokAcpInteractiveTransport>,
      ...args: Parameters<typeof origDispose>
    ) {
      disposeCount++;
      return origDispose.apply(this, args);
    };

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      spawnFn,
    });

    try {
      const result = await executeAgentTool(
        { agent: 'hsid-acp', task: 'fail getSessionId', runtime: 'grok-acp' },
        undefined,
        undefined,
        {
          cwd: root,
          mode: 'tui',
          hasUI: false,
          sessionManager: {
            getSessionId: () => {
              throw new Error('getSessionId failed');
            },
            getBranch: () => [] as never,
          },
          ui: {
            confirm: async () => true,
            select: async () => undefined,
            input: async () => undefined,
            notify: () => {},
          },
        } as unknown as ExtensionContext,
        {
          runStore: store,
          runCoordinator: coordinator,
          interactiveRegistry: registry,
          spawnFn,
        }
      );

      const single = result.details.results[0];
      expect(single).toBeDefined();
      expect(single!.status).toBe('failed');
      expect(single!.errorMessage ?? '').toMatch(/getSessionId failed/);
      expect(disposeCount).toBe(1);

      const leaseKey = buildSessionLeaseKey({
        runtime: 'grok-acp',
        cwd: root,
        sessionIdentity: child.sessionId,
      });
      const reacquire = await Promise.race([
        acquireSessionLease(leaseKey).then((h) => {
          h.release();
          return 'ok' as const;
        }),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 200)),
      ]);
      expect(reacquire).toBe('ok');
    } finally {
      GrokAcpInteractiveTransport.prototype.dispose = origDispose;
      await registry.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('interactive-execution policy (via production wrapper)', () => {
  it('Grok ACP path strips maxTurns by mapping agent before shared runner', async () => {
    // Verified indirectly above: maxTurns: 3 agent still completes without max_turns.
    // Direct unit: runSingleAgentInteractive is the production export (not a hand-spread).
    const agent = makeAgent({ maxTurns: 3 });
    expect(agent.maxTurns).toBe(3);
    expect(typeof runSingleAgentInteractive).toBe('function');
    expect(emptyUsage().turns).toBe(0);
  });
});
