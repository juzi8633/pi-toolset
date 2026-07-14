// ABOUTME: Tests for interactive agent registry: bindings, trust, messaging, recovery.
// ABOUTME: Uses temporary run stores and fake transports; no real Pi child processes.

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  acquireSessionLease,
  awaitSessionLease,
  canonicalizeSessionLeaseKey,
  createInteractiveAgentRegistry,
  getSessionLeaseGlobalKeyForTest,
  getSessionLeaseStoreSizesForTest,
  InteractiveAgentError,
  INTERACTIVE_LINK_TYPE,
} from '../src/interactive-agent.ts';
import { createRunCoordinator, agentFingerprint } from '../src/run-coordinator.ts';
import { createRunStore } from '../src/run-store.ts';
import type { AgentConfig } from '../src/agents.ts';
import type { InteractiveAgentLinkV1, RunUnitRecord } from '../src/run-types.ts';
import type { PiRpcTransport } from '../src/pi-rpc-transport.ts';

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'explore',
    description: 'test',
    systemPrompt: 'You explore.',
    source: 'user',
    filePath: '/tmp/explore.md',
    ...overrides,
  };
}

function makeTempStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-ia-'));
  const store = createRunStore({ rootDir: root });
  const coordinator = createRunCoordinator({ store });
  return { root, store, coordinator };
}

function emptyDetails() {
  return {
    mode: 'single' as const,
    agentScope: 'both' as const,
    projectAgentsDir: null,
    builtinAgentsDir: '/builtin',
    results: [],
  };
}

async function registerWithFakeTransport(opts: {
  root: string;
  store: ReturnType<typeof createRunStore>;
  coordinator: ReturnType<typeof createRunCoordinator>;
  agent: AgentConfig;
  eventListenerRef: { current?: (e: unknown) => void };
  hostSessionId?: string;
  transportFactory?: () => Promise<PiRpcTransport>;
  registryOptions?: Partial<Parameters<typeof createInteractiveAgentRegistry>[0]>;
}) {
  const { root, store, coordinator, agent, eventListenerRef } = opts;
  const { runId, record } = await store.createRun({
    mode: 'single',
    agentScope: 'both',
    background: false,
    request: {
      mode: 'single',
      agentScope: 'both',
      agent: 'explore',
      task: 'look',
    },
    details: emptyDetails(),
    units: {
      single: {
        unitId: 'single',
        agent: 'explore',
        agentFingerprint: agentFingerprint(agent),
        runtime: undefined,
        capability: 'session',
        status: 'queued',
        attempt: 1,
        attempts: [],
        effectiveCwd: root,
      },
    },
  });
  const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
  await store.updateRun(runId, (r) => {
    r.units.single.sessionFile = sessionFile;
    r.status = 'running';
  });
  const live = store.getRun(runId);
  if (live.ok) coordinator.registerRun(runId, live.loaded.record);

  const fakeTransport = {
    async getState() {
      return {
        sessionId: 's',
        thinkingLevel: 'off',
        isStreaming: false,
        isCompacting: false,
        steeringMode: 'all',
        followUpMode: 'one-at-a-time',
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      };
    },
    async prompt() {},
    async steer() {},
    async followUp() {},
    async abort() {},
    subscribe(fn: (e: unknown) => void) {
      eventListenerRef.current = fn;
      return () => {
        eventListenerRef.current = undefined;
      };
    },
    async dispose() {},
    getStderr() {
      return '';
    },
  } as unknown as PiRpcTransport;

  const registry = createInteractiveAgentRegistry({
    runStore: store,
    runCoordinator: coordinator,
    discoverAgentsFn: () => ({
      agents: [agent],
      projectAgentsDir: null,
      builtinAgentsDir: '/tmp',
    }),
    transportFactory: opts.transportFactory ?? (async () => fakeTransport),
    ...opts.registryOptions,
  });
  registry.setHostLinkAppender(() => undefined);

  const snap = await registry.registerInitial({
    runId,
    unitId: 'single',
    hostSessionId: opts.hostSessionId ?? 'host-stream',
    launchSpec: {
      agent,
      request: record.request,
      sessionFile,
      effectiveCwd: root,
      agentScope: 'both',
      registrationKind: 'initial',
    },
    getBranchEntries: () => [],
  });

  return { registry, key: snap.key, runId, sessionFile, snap };
}

describe('InteractiveAgentRegistry bindings and registration', () => {
  it('persists binding before link append and rejects blank/slash messages', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'look',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });

    const sessionsDir = path.join(store.getRunDir(runId), 'sessions');
    const sessionFile = path.join(sessionsDir, 'planned.jsonl');
    record.units.single.sessionFile = sessionFile;
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    {
      const loadedRun = store.getRun(runId);
      coordinator.registerRun(runId, loadedRun.ok ? loadedRun.loaded.record : record);
    }

    const links: InteractiveAgentLinkV1[] = [];
    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        throw new Error('should not spawn during register');
      },
    });
    registry.setHostLinkAppender((link) => links.push(link));

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-1',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () =>
        links.map((data) => ({
          type: 'custom',
          customType: INTERACTIVE_LINK_TYPE,
          data,
        })),
    });

    expect(snap.status).toBe('registered');
    expect(links).toHaveLength(1);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const bindings = loaded.loaded.record.units.single.interactiveBindings;
      expect(bindings?.[links[0]!.bindingId]).toBeDefined();
    }

    await expect(registry.send(snap.key, '   ')).rejects.toBeInstanceOf(InteractiveAgentError);
    await expect(registry.send(snap.key, '/help')).rejects.toMatchObject({ code: 'slash_message' });

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('marks restore links unavailable when host session mismatches', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const bindingId = 'bind-abc';
    const createdAt = 1000;

    const { runId } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'look',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
          interactiveBindings: {
            [bindingId]: {
              bindingId,
              hostSessionId: 'original-host',
              createdAt,
            },
          },
        } satisfies RunUnitRecord,
      },
    });

    const sessionsDir = path.join(store.getRunDir(runId), 'sessions');
    const sessionFile = path.join(sessionsDir, 's.jsonl');
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'completed';
    });

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
    });

    const restored = registry.restoreActiveBranch({
      cwd: root,
      sessionManager: {
        getSessionId: () => 'other-host',
        getBranch: () => [
          {
            type: 'custom',
            customType: INTERACTIVE_LINK_TYPE,
            data: {
              version: 1,
              runId,
              unitId: 'single',
              bindingId,
              hostSessionId: 'original-host',
              createdAt,
            },
          },
        ],
      } as never,
    });

    expect(restored).toHaveLength(1);
    expect(restored[0]!.status).toBe('unavailable');
    expect(restored[0]!.lastError).toContain('host_session');

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('InteractiveAgentRegistry messaging serialization', () => {
  it('shares startup barrier and routes concurrent sends as steer after prompt', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'look',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });

    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);

    const calls: string[] = [];
    let eventListener: ((e: unknown) => void) | undefined;
    let resolveState: (() => void) | undefined;
    const stateGate = new Promise<void>((r) => {
      resolveState = r;
    });

    const fakeTransport = {
      async getState() {
        await stateGate;
        return {
          sessionId: 's',
          thinkingLevel: 'off',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'one-at-a-time',
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        };
      },
      async prompt(msg: string) {
        calls.push(`prompt:${msg}`);
      },
      async steer(msg: string) {
        calls.push(`steer:${msg}`);
      },
      async followUp(msg: string) {
        calls.push(`follow_up:${msg}`);
      },
      async abort() {
        calls.push('abort');
      },
      subscribe(fn: (e: unknown) => void) {
        eventListener = fn;
        return () => {
          eventListener = undefined;
        };
      },
      async dispose() {
        calls.push('dispose');
      },
      getStderr() {
        return '';
      },
    } as unknown as PiRpcTransport;

    const links: InteractiveAgentLinkV1[] = [];
    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => fakeTransport,
    });
    registry.setHostLinkAppender((link) => links.push(link));

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-3',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    const p1 = registry.activate(snap.key, 'Task: first', 'prompt');
    const p2 = registry.send(snap.key, 'steer me', 'prompt');

    resolveState?.();
    await Promise.all([p1, p2]);

    const promptIdx = calls.findIndex((c) => c.startsWith('prompt:'));
    const steerIdx = calls.findIndex((c) => c.startsWith('steer:'));
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(steerIdx).toBeGreaterThan(promptIdx);

    eventListener?.({ type: 'agent_start' });
    eventListener?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        usage: { input: 1, output: 2, totalTokens: 3 },
      },
    });
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));

    const after = registry.get(snap.key);
    expect(after?.status).toBe('idle');
    expect(after?.messages.length).toBeGreaterThan(0);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('sets max_turns from post-baseline assistant count, not lifetime usage', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ maxTurns: 1 } as Partial<AgentConfig>);

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'look',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });

    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);

    let eventListener: ((e: unknown) => void) | undefined;
    const fakeTransport = {
      async getState() {
        return {
          sessionId: 's',
          thinkingLevel: 'off',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'one-at-a-time',
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        };
      },
      async prompt() {},
      async steer() {},
      async followUp() {},
      async abort() {},
      subscribe(fn: (e: unknown) => void) {
        eventListener = fn;
        return () => {
          eventListener = undefined;
        };
      },
      async dispose() {},
      getStderr() {
        return '';
      },
    } as unknown as PiRpcTransport;

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => fakeTransport,
    });
    registry.setHostLinkAppender(() => undefined);

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-max',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    // First activation: one assistant message settles within maxTurns=1.
    await registry.activate(snap.key, 'Task: first', 'prompt', { maxTurns: 1 });
    eventListener?.({ type: 'agent_start' });
    eventListener?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'turn1' }],
        usage: { input: 1, output: 1, totalTokens: 2 },
      },
    });
    await new Promise((r) => setImmediate(r));
    const mid = registry.get(snap.key);
    expect(mid?.activation?.terminalOverride).toBe('max_turns');
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));

    // Second activation should allow another full turn despite lifetime usage.turns > 0.
    await registry.activate(snap.key, 'continue', 'prompt', { maxTurns: 1 });
    eventListener?.({ type: 'agent_start' });
    eventListener?.({
      type: 'message_end',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'continue' }],
      },
    });
    eventListener?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'turn2' }],
        usage: { input: 1, output: 1, totalTokens: 2 },
      },
    });
    await new Promise((r) => setImmediate(r));
    const late = registry.get(snap.key);
    expect(late?.activation?.terminalOverride).toBe('max_turns');
    expect(late?.messages.filter((m) => (m as { role?: string }).role === 'assistant').length).toBe(
      2
    );

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('InteractiveAgentRegistry activation origin', () => {
  async function setup(
    root: string,
    store: ReturnType<typeof createRunStore>,
    coordinator: ReturnType<typeof createRunCoordinator>,
    agent: AgentConfig
  ) {
    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: { mode: 'single', agentScope: 'both', agent: 'explore', task: 'look' },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);
    return { runId, record, sessionFile };
  }

  function makeFakeTransport() {
    let eventListener: ((e: unknown) => void) | undefined;
    return {
      async getState() {
        return {
          sessionId: 's',
          thinkingLevel: 'off',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'one-at-a-time',
          messageCount: 0,
          pendingMessageCount: 0,
        };
      },
      async prompt() {},
      async steer() {},
      async followUp() {},
      async abort() {},
      subscribe(fn: (e: unknown) => void) {
        eventListener = fn;
        return () => {
          eventListener = undefined;
        };
      },
      async dispose() {},
      getStderr() {
        return '';
      },
      emit(event: unknown) {
        eventListener?.(event);
      },
    } as unknown as PiRpcTransport;
  }

  it('records origin view for send() and tool_call for activate(...,tool_call)', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const { runId, record, sessionFile } = await setup(root, store, coordinator, agent);
    const transport = makeFakeTransport();
    const settledOrigins: Array<{ id: string; origin: string }> = [];

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => transport,
    });
    registry.setHostLinkAppender(() => undefined);
    registry.subscribe((e) => {
      if (e.type === 'activation_settled') {
        settledOrigins.push({
          id: e.activationId,
          origin: e.snapshot.activation?.origin ?? 'none',
        });
      }
    });

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-origin',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    // Original tool-call activation.
    const tc = await registry.activate(snap.key, 'Task: go', 'prompt', undefined, 'tool_call');
    expect(tc.snapshot.activation?.origin).toBe('tool_call');
    (transport as unknown as { emit: (e: unknown) => void }).emit({ type: 'agent_start' });
    (transport as unknown as { emit: (e: unknown) => void }).emit({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    });
    (transport as unknown as { emit: (e: unknown) => void }).emit({
      type: 'agent_end',
      messages: [],
      willRetry: false,
    });
    (transport as unknown as { emit: (e: unknown) => void }).emit({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));

    // View continuation via send() defaults to origin view.
    const view = await registry.send(snap.key, 'continue', 'prompt');
    expect(view.activation?.origin).toBe('view');
    (transport as unknown as { emit: (e: unknown) => void }).emit({ type: 'agent_start' });
    (transport as unknown as { emit: (e: unknown) => void }).emit({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'more' }] },
    });
    (transport as unknown as { emit: (e: unknown) => void }).emit({
      type: 'agent_end',
      messages: [],
      willRetry: false,
    });
    (transport as unknown as { emit: (e: unknown) => void }).emit({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));

    const origins = settledOrigins.map((o) => o.origin);
    expect(origins).toContain('tool_call');
    expect(origins).toContain('view');

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('InteractiveAgentRegistry reviewer fixes', () => {
  async function setupRun(
    root: string,
    store: ReturnType<typeof createRunStore>,
    coordinator: ReturnType<typeof createRunCoordinator>,
    agent: AgentConfig
  ) {
    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'look',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);
    return { runId, record, sessionFile };
  }

  function makeFakeTransport(
    hooks: {
      onPrompt?: () => void | Promise<void>;
      onDispose?: () => void | Promise<void>;
      disposeDelayMs?: number;
    } = {}
  ) {
    let eventListener: ((e: unknown) => void) | undefined;
    let disposed = false;
    const transport = {
      async getState() {
        return {
          sessionId: 's',
          thinkingLevel: 'off',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'one-at-a-time',
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        };
      },
      async prompt(msg: string) {
        await hooks.onPrompt?.();
        void msg;
      },
      async steer() {},
      async followUp() {},
      async abort() {},
      subscribe(fn: (e: unknown) => void) {
        eventListener = fn;
        return () => {
          eventListener = undefined;
        };
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        if (hooks.disposeDelayMs) {
          await new Promise((r) => setTimeout(r, hooks.disposeDelayMs));
        }
        await hooks.onDispose?.();
        eventListener?.({
          type: 'pi_rpc_transport_exit',
          intentional: true,
          error: { message: 'disposed', code: 'disposed' },
        });
      },
      getStderr() {
        return '';
      },
      emit(event: unknown) {
        eventListener?.(event);
      },
      get disposed() {
        return disposed;
      },
    };
    return transport as unknown as FakeTransport;
  }

  type FakeTransport = {
    getState: () => Promise<unknown>;
    prompt: (msg: string) => Promise<void>;
    steer: () => Promise<void>;
    followUp: () => Promise<void>;
    abort: () => Promise<void>;
    subscribe: (fn: (e: unknown) => void) => () => void;
    dispose: () => Promise<void>;
    getStderr: () => string;
    emit: (e: unknown) => void;
  };

  it('settles activation when child crashes after prompt acceptance', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const { runId, record, sessionFile } = await setupRun(root, store, coordinator, agent);

    const transport = makeFakeTransport();
    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => transport as unknown as PiRpcTransport,
    });
    registry.setHostLinkAppender(() => undefined);

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-crash',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    const settled: string[] = [];
    registry.subscribe((e) => {
      if (e.type === 'activation_settled') settled.push(e.activationId);
    });

    const activated = await registry.activate(snap.key, 'Task: work', 'prompt');
    transport.emit({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));

    // Mid-run process crash after prompt was accepted.
    transport.emit({
      type: 'pi_rpc_transport_exit',
      intentional: false,
      error: { message: 'Agent process exited (code=1 signal=null)', code: 'process_exit' },
    });
    await new Promise((r) => setImmediate(r));

    expect(settled).toContain(activated.activationId);
    const after = registry.get(snap.key);
    expect(after?.status).toBe('error');
    expect(after?.activation).toBeUndefined();
    expect(after?.lastError).toContain('exited');

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('revalidates fingerprint and worktree before detached/error reopen', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const { runId, record, sessionFile } = await setupRun(root, store, coordinator, agent);
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );

    let spawnCount = 0;
    const transport = makeFakeTransport();
    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        spawnCount += 1;
        return transport as unknown as PiRpcTransport;
      },
    });
    registry.setHostLinkAppender(() => undefined);

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-fp',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    await registry.activate(snap.key, 'Task: first', 'prompt');
    transport.emit({ type: 'agent_start' });
    transport.emit({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    });
    transport.emit({ type: 'agent_end', messages: [], willRetry: false });
    transport.emit({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    await registry.detach(snap.key);
    expect(registry.get(snap.key)?.status).toBe('detached');

    // Tamper durable fingerprint so reopen must refuse.
    await store.updateRun(runId, (r) => {
      r.units.single.agentFingerprint = 'tampered-fingerprint';
    });

    const settledOnReopen: string[] = [];
    registry.subscribe((e) => {
      if (e.type === 'activation_settled') settledOnReopen.push(e.activationId);
    });

    await expect(registry.activate(snap.key, 'reopen me', 'prompt')).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(spawnCount).toBe(1); // no second spawn after fingerprint mismatch
    expect(registry.get(snap.key)?.status).toBe('unavailable');
    // Revalidation failure must not leave a zombie activation or fire settle.
    expect(registry.get(snap.key)?.activation).toBeUndefined();
    expect(settledOnReopen).toEqual([]);

    // Repair trust and activate again successfully.
    await store.updateRun(runId, (r) => {
      r.units.single.agentFingerprint = agentFingerprint(agent);
    });
    // Still unavailable until restore/re-register path clears it — set detached for reopen.
    const ep = registry.getMutable(snap.key)!;
    ep.status = 'detached';
    ep.lastError = undefined;
    ep.errorCode = undefined;
    const recovered = await registry.activate(snap.key, 'reopen after fix', 'prompt');
    expect(recovered.activationId).toBeTruthy();
    expect(spawnCount).toBe(2);
    expect(registry.get(snap.key)?.activation?.id).toBe(recovered.activationId);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects symlink session escape on reopen revalidation', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const { runId, record, sessionFile } = await setupRun(root, store, coordinator, agent);
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );

    const outside = path.join(root, 'outside.jsonl');
    fs.writeFileSync(
      outside,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );
    const sessionsDir = path.dirname(sessionFile);
    const linkPath = path.join(sessionsDir, 'escape-link.jsonl');
    try {
      fs.symlinkSync(outside, linkPath);
    } catch {
      // Some environments disallow symlinks; skip soft.
      fs.rmSync(root, { recursive: true, force: true });
      return;
    }

    const transport = makeFakeTransport();
    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => transport as unknown as PiRpcTransport,
    });
    registry.setHostLinkAppender(() => undefined);

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-sym',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });
    await registry.activate(snap.key, 'Task: first', 'prompt');
    transport.emit({ type: 'agent_end', messages: [], willRetry: false });
    transport.emit({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    await registry.detach(snap.key);

    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = linkPath;
    });

    await expect(registry.activate(snap.key, 'again', 'prompt')).rejects.toMatchObject({
      code: 'unavailable',
    });

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('awaits prior dispose fully before recovery spawn (single writer)', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const { runId, record, sessionFile } = await setupRun(root, store, coordinator, agent);
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );

    const order: string[] = [];
    let factoryCalls = 0;

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        factoryCalls += 1;
        if (factoryCalls === 1) {
          return makeFakeTransport({
            disposeDelayMs: 40,
            onDispose: () => {
              order.push('dispose-done');
            },
          }) as unknown as PiRpcTransport;
        }
        order.push('spawn-2');
        return makeFakeTransport() as unknown as PiRpcTransport;
      },
    });
    registry.setHostLinkAppender(() => undefined);

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-disp',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    await registry.activate(snap.key, 'Task: first', 'prompt');
    // Force error status while keeping client so recovery must dispose first.
    const ep = registry.getMutable(snap.key)!;
    ep.status = 'error';
    ep.lastError = 'boom';

    await registry.activate(snap.key, 'recover', 'prompt');
    expect(order.indexOf('dispose-done')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('spawn-2')).toBeGreaterThan(order.indexOf('dispose-done'));
    expect(factoryCalls).toBe(2);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('true overlap: T2 activate starts but factory waits until T1 dispose completes', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ systemPrompt: '' });
    const { runId, record, sessionFile } = await setupRun(root, store, coordinator, agent);
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );

    const order: string[] = [];
    let factoryCalls = 0;
    let releaseT1Dispose!: () => void;
    const t1DisposeGate = new Promise<void>((r) => {
      releaseT1Dispose = r;
    });

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        factoryCalls += 1;
        const n = factoryCalls;
        order.push(`factory-${n}`);
        if (n === 1) {
          return makeFakeTransport({
            onDispose: async () => {
              order.push('t1-dispose-start');
              await t1DisposeGate;
              order.push('t1-dispose-done');
            },
          }) as unknown as PiRpcTransport;
        }
        return makeFakeTransport() as unknown as PiRpcTransport;
      },
    });
    registry.setHostLinkAppender(() => undefined);

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-overlap',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    // Start A, then abort during life so T1 must dispose before T2 can open sessionFile.
    await registry.activate(snap.key, 'Task: A', 'prompt', undefined, 'tool_call');
    expect(factoryCalls).toBe(1);

    // Detach invalidates T1 and starts tracked dispose (gated).
    const detachP = registry.detach(snap.key);
    await new Promise((r) => setImmediate(r));
    expect(order).toContain('t1-dispose-start');
    expect(factoryCalls).toBe(1);

    // T2 activate begins while T1 dispose is still gated — factory must not run yet.
    const actBPromise = registry.activate(snap.key, 'Task: B', 'prompt', undefined, 'view');
    await new Promise((r) => setTimeout(r, 30));
    expect(factoryCalls).toBe(1);
    expect(order.filter((x) => x.startsWith('factory-'))).toEqual(['factory-1']);

    releaseT1Dispose();
    await detachP;
    const actB = await actBPromise;
    expect(factoryCalls).toBe(2);
    expect(order.indexOf('factory-2')).toBeGreaterThan(order.indexOf('t1-dispose-done'));
    expect(actB.activationId).toBeTruthy();
    expect(registry.get(snap.key)?.activation?.id).toBe(actB.activationId);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('cancels activation during startup barrier before prompt is sent', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const { runId, record, sessionFile } = await setupRun(root, store, coordinator, agent);

    let resolveState: (() => void) | undefined;
    const stateGate = new Promise<void>((r) => {
      resolveState = r;
    });
    let promptCalls = 0;
    let eventListener: ((e: unknown) => void) | undefined;
    const transport = {
      async getState() {
        await stateGate;
        return {
          sessionId: 's',
          thinkingLevel: 'off',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'one-at-a-time',
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        };
      },
      async prompt() {
        promptCalls += 1;
      },
      async steer() {},
      async followUp() {},
      async abort() {},
      subscribe(fn: (e: unknown) => void) {
        eventListener = fn;
        return () => {
          eventListener = undefined;
        };
      },
      async dispose() {
        eventListener?.({
          type: 'pi_rpc_transport_exit',
          intentional: true,
          error: { message: 'disposed', code: 'disposed' },
        });
      },
      getStderr() {
        return '';
      },
    } as unknown as PiRpcTransport;

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => transport as unknown as PiRpcTransport,
    });
    registry.setHostLinkAppender(() => undefined);

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-abort',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    const settled: string[] = [];
    registry.subscribe((e) => {
      if (e.type === 'activation_settled') settled.push(e.activationId);
    });

    const activateP = registry.activate(snap.key, 'Task: slow start', 'prompt');
    // Abort while handshake is still gated.
    await new Promise((r) => setImmediate(r));
    await registry.abort(snap.key);
    resolveState?.();

    await expect(activateP).rejects.toMatchObject({ code: 'rejected' });
    expect(promptCalls).toBe(0);
    expect(settled.length).toBeGreaterThanOrEqual(1);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('revalidates existing endpoint key on restore and hides off-branch endpoints', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const bindingId = 'bind-valid';
    const createdAt = 42;
    const { runId } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'look',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
          interactiveBindings: {
            [bindingId]: {
              bindingId,
              hostSessionId: 'host-tree',
              createdAt,
            },
          },
        } satisfies RunUnitRecord,
      },
    });
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 's.jsonl');
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'completed';
    });

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
    });

    const validLink = {
      version: 1 as const,
      runId,
      unitId: 'single',
      bindingId,
      hostSessionId: 'host-tree',
      createdAt,
    };

    const changes: string[][] = [];
    registry.subscribe((e) => {
      if (e.type === 'endpoints_changed') changes.push(e.keys);
    });

    // First restore succeeds.
    let restored = registry.restoreActiveBranch({
      cwd: root,
      sessionManager: {
        getSessionId: () => 'host-tree',
        getBranch: () => [{ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: validLink }],
      } as never,
    });
    expect(restored[0]!.status).toBe('detached');
    expect(registry.listVisible()).toHaveLength(1);

    // Same key with forged binding must revalidate to unavailable.
    restored = registry.restoreActiveBranch({
      cwd: root,
      sessionManager: {
        getSessionId: () => 'host-tree',
        getBranch: () => [
          {
            type: 'custom',
            customType: INTERACTIVE_LINK_TYPE,
            data: { ...validLink, bindingId: 'forged-binding' },
          },
        ],
      } as never,
    });
    expect(restored[0]!.status).toBe('unavailable');
    expect(restored[0]!.lastError).toMatch(/binding/);

    // Branch without the link: endpoint must disappear and publish refresh.
    registry.restoreActiveBranch({
      cwd: root,
      sessionManager: {
        getSessionId: () => 'host-tree',
        getBranch: () => [],
      } as never,
    });
    expect(registry.listVisible()).toHaveLength(0);
    expect(registry.get(`${runId}:single`)).toBeUndefined();
    expect(changes.some((keys) => keys.length === 0)).toBe(true);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rolls back session ownership claim when binding persistence fails', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const { runId, record, sessionFile } = await setupRun(root, store, coordinator, agent);

    const original = coordinator.persistInteractiveBinding.bind(coordinator);
    let failOnce = true;
    coordinator.persistInteractiveBinding = async (input) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('disk full');
      }
      return original(input);
    };

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        throw new Error('no spawn');
      },
    });
    registry.setHostLinkAppender(() => undefined);

    await expect(
      registry.registerInitial({
        runId,
        unitId: 'single',
        hostSessionId: 'host-roll',
        launchSpec: {
          agent,
          request: record.request,
          sessionFile,
          effectiveCwd: root,
          agentScope: 'both',
          registrationKind: 'initial',
        },
        getBranchEntries: () => [],
      })
    ).rejects.toThrow(/disk full/);

    // Claim must be released so a subsequent register can succeed.
    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-roll',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });
    expect(snap.status).toBe('registered');

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('InteractiveAgentRegistry streaming snapshot cost', () => {
  it('marks message_update as transcript and structure-shares finalized messages', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const eventListenerRef: { current?: (e: unknown) => void } = {};
    const { registry, key } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef,
    });

    const events: Array<{ type: string; kind?: string; messages?: unknown }> = [];
    registry.subscribe((e) => {
      if (e.type === 'endpoint_updated') {
        events.push({ type: e.type, kind: e.kind, messages: e.snapshot.messages });
      }
    });

    await registry.activate(key, 'Task: stream', 'prompt', undefined, 'tool_call');
    // Drain transition queue for spawn subscribe.
    await new Promise((r) => setImmediate(r));

    // Finalized history first.
    eventListenerRef.current?.({
      type: 'message_end',
      message: {
        role: 'user',
        content: 'Task: stream',
      },
    });
    await new Promise((r) => setImmediate(r));

    const afterEnd = registry.get(key);
    expect(afterEnd?.messages.length).toBe(1);
    const finalizedRef = afterEnd!.messages[0];
    const finalizedArray = afterEnd!.messages;
    const messagesRevisionAfterEnd = afterEnd!.messagesRevision;

    events.length = 0;
    // Streaming deltas must not deep-clone history into new message objects.
    for (let i = 0; i < 5; i++) {
      eventListenerRef.current?.({
        type: 'message_update',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'tok'.repeat(i + 1) }],
        },
      });
      await new Promise((r) => setImmediate(r));
    }

    expect(events.length).toBe(5);
    expect(events.every((e) => e.kind === 'transcript')).toBe(true);
    // All transcript snapshots reuse the same finalized messages array reference.
    for (const e of events) {
      expect(e.messages).toBe(finalizedArray);
    }

    const streamed = registry.get(key);
    expect(streamed?.messages.length).toBe(1);
    // Structure sharing: same finalized message object identity across stream snapshots.
    expect(streamed?.messages[0]).toBe(finalizedRef);
    expect(streamed?.messages).toBe(finalizedArray);
    // message_update must not bump messagesRevision (only streamRevision).
    expect(streamed?.messagesRevision).toBe(messagesRevisionAfterEnd);
    expect(streamed!.streamRevision).toBeGreaterThan(0);

    // listVisibleMeta never carries message history.
    const meta = registry.listVisibleMeta();
    expect(meta).toHaveLength(1);
    expect('messages' in meta[0]!).toBe(false);
    expect('streamingMessage' in meta[0]!).toBe(false);

    // Consecutive listVisible snapshots share finalized message object refs (no deep clone).
    const a = registry.listVisible()[0]!;
    const b = registry.listVisible()[0]!;
    expect(a.messages).toBe(b.messages);
    expect(a.messages[0]).toBe(b.messages[0]);
    expect(a.messages[0]).toBe(finalizedRef);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('detach force-settles open activation so subsequent activate gets a new id', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const eventListenerRef: { current?: (e: unknown) => void } = {};
    const { registry, key, runId } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef,
    });
    // Reopen revalidation requires a readable session file.
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );

    const settled: string[] = [];
    registry.subscribe((e) => {
      if (e.type === 'activation_settled') settled.push(e.activationId);
    });

    const first = await registry.activate(key, 'Task: hang', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    expect(registry.get(key)?.activation?.id).toBe(first.activationId);

    await registry.detach(key);
    expect(settled).toContain(first.activationId);
    expect(registry.get(key)?.activation).toBeUndefined();
    expect(registry.get(key)?.status).toBe('detached');

    const second = await registry.activate(key, 'Task: reopen', 'prompt', undefined, 'view');
    expect(second.activationId).not.toBe(first.activationId);
    expect(registry.get(key)?.activation?.id).toBe(second.activationId);

    // Old force-settle must not reappear for the new activation.
    expect(settled.filter((id) => id === first.activationId)).toHaveLength(1);
    expect(settled).not.toContain(second.activationId);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('detach({remove:true}) force-settles open activation then drops the endpoint', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const eventListenerRef: { current?: (e: unknown) => void } = {};
    const { registry, key } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef,
    });

    const settled: string[] = [];
    registry.subscribe((e) => {
      if (e.type === 'activation_settled') settled.push(e.activationId);
    });

    const first = await registry.activate(key, 'Task: remove', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    expect(registry.get(key)?.activation?.id).toBe(first.activationId);

    await registry.detach(key, { remove: true });
    expect(settled).toContain(first.activationId);
    expect(registry.get(key)).toBeUndefined();
    expect(registry.listVisible()).toHaveLength(0);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('finalized messages are frozen; consumers cannot mutate registry snapshots', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const eventListenerRef: { current?: (e: unknown) => void } = {};
    const { registry, key } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef,
    });

    await registry.activate(key, 'Task: freeze', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));

    eventListenerRef.current?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'sealed' }],
        usage: { input: 1, output: 1, totalTokens: 2 },
      },
    });
    await new Promise((r) => setImmediate(r));

    const snap = registry.get(key)!;
    expect(Object.isFrozen(snap.messages)).toBe(true);
    expect(Object.isFrozen(snap.messages[0])).toBe(true);

    // Array push must not mutate the shared view.
    expect(() => {
      (snap.messages as unknown as unknown[]).push({
        role: 'user',
        content: 'hack',
      });
    }).toThrow();

    // Nested content mutation must not stick on subsequent get/snapshot.
    const content = (snap.messages[0] as { content: Array<{ type: string; text: string }> })
      .content;
    expect(Object.isFrozen(content)).toBe(true);
    expect(() => {
      content[0]!.text = 'mutated';
    }).toThrow();

    const again = registry.get(key)!;
    expect(again.messages.length).toBe(1);
    expect((again.messages[0] as { content: Array<{ text: string }> }).content[0]!.text).toBe(
      'sealed'
    );
    // Still the same frozen array/object identity (structure sharing).
    expect(again.messages).toBe(snap.messages);
    expect(again.messages[0]).toBe(snap.messages[0]);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('message_update same-length text replacement bumps streamRevision only', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const eventListenerRef: { current?: (e: unknown) => void } = {};
    const { registry, key } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef,
    });

    await registry.activate(key, 'Task: rev', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));

    eventListenerRef.current?.({
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'aaaa' }],
      },
    });
    await new Promise((r) => setImmediate(r));
    const mid = registry.get(key)!;
    const messagesRevision = mid.messagesRevision;
    const streamRevision = mid.streamRevision;

    // Same-length replacement (producer must bump streamRevision so detail cache invalidates).
    eventListenerRef.current?.({
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'bbbb' }],
      },
    });
    await new Promise((r) => setImmediate(r));
    const after = registry.get(key)!;
    expect(after.messagesRevision).toBe(messagesRevision);
    expect(after.streamRevision).toBeGreaterThan(streamRevision);
    expect((after.streamingMessage as { content: Array<{ text: string }> }).content[0]!.text).toBe(
      'bbbb'
    );

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('timeout detach then reopen: old settle does not close new activation', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ maxTurns: 1 });
    const eventListenerRef: { current?: (e: unknown) => void } = {};
    const { registry, key, runId } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef,
    });
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );

    const settled: string[] = [];
    registry.subscribe((e) => {
      if (e.type === 'activation_settled') settled.push(e.activationId);
    });

    const first = await registry.activate(key, 'Task: max', 'prompt', { maxTurns: 1 }, 'tool_call');
    await new Promise((r) => setImmediate(r));

    // Drive max_turns terminalOverride via a completed assistant turn.
    eventListenerRef.current?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'turn-1' }],
        usage: { input: 1, output: 1, totalTokens: 2 },
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(registry.get(key)?.activation?.terminalOverride).toBe('max_turns');

    // Protocol settle timeout path: detach force-settles the open activation.
    await registry.detach(key);
    expect(settled).toContain(first.activationId);
    expect(registry.get(key)?.activation).toBeUndefined();
    expect(registry.get(key)?.status).toBe('detached');

    // New activation after reopen must be a different id and stay open until its own settle.
    const second = await registry.activate(key, 'Task: next', 'prompt', undefined, 'view');
    expect(second.activationId).not.toBe(first.activationId);
    expect(registry.get(key)?.activation?.id).toBe(second.activationId);
    expect(registry.get(key)?.activation?.settled).toBe(false);
    // Old timeout/detach must not have settled the new activation.
    expect(settled).not.toContain(second.activationId);

    eventListenerRef.current?.({ type: 'agent_start' });
    eventListenerRef.current?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListenerRef.current?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    expect(settled).toContain(second.activationId);
    expect(registry.get(key)?.activation).toBeUndefined();

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('publishes message_end as full and settles only on agent_settled', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const eventListenerRef: { current?: (e: unknown) => void } = {};
    const { registry, key } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef,
    });

    const updated: string[] = [];
    registry.subscribe((e) => {
      if (e.type === 'endpoint_updated') updated.push(e.kind);
      if (e.type === 'activation_settled') updated.push('settled');
    });

    await registry.activate(key, 'Task: settle', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    updated.length = 0;

    eventListenerRef.current?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));
    eventListenerRef.current?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input: 1, output: 1, totalTokens: 2 },
      },
    });
    await new Promise((r) => setImmediate(r));
    eventListenerRef.current?.({ type: 'agent_end', messages: [], willRetry: false });
    await new Promise((r) => setImmediate(r));

    expect(updated).toContain('meta'); // agent_start (and agent_end meta)
    expect(updated).toContain('full'); // message_end
    expect(updated.filter((k) => k === 'settled')).toHaveLength(0);
    expect(registry.get(key)?.activation?.settled).toBe(false);
    expect(registry.get(key)?.status).toBe('running');
    // message_end full only so far (agent_end is meta, not settle full).
    expect(updated.filter((k) => k === 'full')).toHaveLength(1);

    eventListenerRef.current?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));

    const fullCount = updated.filter((k) => k === 'full').length;
    const settledCount = updated.filter((k) => k === 'settled').length;
    expect(settledCount).toBe(1);
    // message_end full + agent_settled full = 2 (no third duplicate from fallthrough)
    expect(fullCount).toBe(2);
    expect(registry.get(key)?.activation).toBeUndefined();
    expect(registry.get(key)?.status).toBe('idle');

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('T1 late handshake after T2 reopen cannot install client or settle B', async () => {
    const { root, store, coordinator } = makeTempStore();
    // Empty systemPrompt avoids temp-file work in spawn so the factory gate is the barrier.
    const agent = makeAgent({ systemPrompt: '' });
    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'look',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );

    type Gate = {
      resolveState?: () => void;
      disposed: boolean;
      emit: (e: unknown) => void;
      installedAt?: number;
    };
    const transports: Gate[] = [];
    let factoryCalls = 0;

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        factoryCalls += 1;
        const label = factoryCalls === 1 ? 'T1' : 'T2';
        let eventListener: ((e: unknown) => void) | undefined;
        let resolveState!: () => void;
        const stateGate = new Promise<void>((r) => {
          resolveState = r;
        });
        const gate: Gate = {
          disposed: false,
          emit(e: unknown) {
            eventListener?.(e);
          },
          resolveState,
        };
        transports.push(gate);
        return {
          async getState() {
            await stateGate;
            gate.installedAt = Date.now();
            return {
              sessionId: label,
              thinkingLevel: 'off',
              isStreaming: false,
              isCompacting: false,
              steeringMode: 'all',
              followUpMode: 'one-at-a-time',
              autoCompactionEnabled: true,
              messageCount: 0,
              pendingMessageCount: 0,
            };
          },
          async prompt() {},
          async steer() {},
          async followUp() {},
          async abort() {},
          subscribe(fn: (e: unknown) => void) {
            eventListener = fn;
            return () => {
              eventListener = undefined;
            };
          },
          async dispose() {
            gate.disposed = true;
          },
          getStderr() {
            return '';
          },
        } as unknown as PiRpcTransport;
      },
    });
    registry.setHostLinkAppender(() => undefined);

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-gen',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    const waitForFactory = async (n: number) => {
      const deadline = Date.now() + 2000;
      while (factoryCalls < n && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(factoryCalls).toBeGreaterThanOrEqual(n);
    };

    // Start activation A — T1 handshake gated (still pending).
    const actA = registry.activate(snap.key, 'Task: A', 'prompt', undefined, 'tool_call');
    const actASettled = actA.then(
      (v) => ({ ok: true as const, v }),
      (e) => ({ ok: false as const, e })
    );
    await waitForFactory(1);

    // Abort while T1 handshake is still incomplete — generation bumps; A settles.
    // Spawn waiter is rejected so T1 disposes without needing getState to resolve.
    await registry.abort(snap.key);
    const aResult = await actASettled;
    expect(aResult.ok).toBe(false);
    expect((aResult as { ok: false; e: { code?: string } }).e).toMatchObject({ code: 'rejected' });
    expect(transports[0]!.installedAt).toBeUndefined();
    // T1 must be disposed before T2 can open the same sessionFile.
    expect(transports[0]!.disposed).toBe(true);

    // Start activation B — factory must not run until T1 dispose barrier clears.
    const actBPromise = registry.activate(snap.key, 'Task: B', 'prompt', undefined, 'view');
    await waitForFactory(2);
    expect(transports[1]).toBeDefined();
    expect(transports[0]!.disposed).toBe(true);

    // Complete T2 handshake.
    transports[1]!.resolveState?.();
    const actB = await actBPromise;
    await new Promise((r) => setImmediate(r));

    const mid = registry.get(snap.key);
    expect(mid?.activation?.id).toBe(actB.activationId);
    expect(mid?.hasTransport).toBe(true);
    expect(transports[1]!.disposed).toBe(false);

    // Late T1 getState resolve (if still pending) must not install over T2.
    transports[0]!.resolveState?.();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(transports[0]!.disposed).toBe(true);
    expect(transports[1]!.disposed).toBe(false);

    const afterT1 = registry.get(snap.key);
    expect(afterT1?.activation?.id).toBe(actB.activationId);
    expect(afterT1?.hasTransport).toBe(true);

    // Late T1 events must not reduce into B.
    transports[0]!.emit({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'from-T1-stale' }] },
    });
    await new Promise((r) => setImmediate(r));
    const afterStale = registry.get(snap.key);
    expect(
      afterStale?.messages.some(
        (m) => typeof m === 'object' && JSON.stringify(m).includes('from-T1-stale')
      )
    ).toBe(false);
    expect(afterStale?.activation?.id).toBe(actB.activationId);

    // T2 still owns the endpoint; real Pi agent_settled settles B after agent_start.
    transports[1]!.emit({ type: 'agent_start' });
    transports[1]!.emit({ type: 'agent_end', messages: [], willRetry: false });
    transports[1]!.emit({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    expect(registry.get(snap.key)?.activation).toBeUndefined();
    expect(registry.get(snap.key)?.status).toBe('idle');

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('activation-scoped detach no-ops when timer carries A after B is live', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const eventListenerRef: { current?: (e: unknown) => void } = {};
    const { registry, key, runId } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef,
    });
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );

    const settled: string[] = [];
    registry.subscribe((e) => {
      if (e.type === 'activation_settled') settled.push(e.activationId);
    });

    const first = await registry.activate(key, 'Task: A', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    const actA = first.activationId;

    // Settle A normally via agent_start → agent_settled (Pi 0.80.6).
    eventListenerRef.current?.({ type: 'agent_start' });
    eventListenerRef.current?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListenerRef.current?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    expect(settled).toContain(actA);

    const second = await registry.activate(key, 'Task: B', 'prompt', undefined, 'view');
    await new Promise((r) => setImmediate(r));
    expect(registry.get(key)?.activation?.id).toBe(second.activationId);

    // Late timer for A must not detach B.
    await registry.detach(key, { activationId: actA });
    expect(registry.get(key)?.activation?.id).toBe(second.activationId);
    expect(settled).not.toContain(second.activationId);

    // Correct id still works.
    await registry.detach(key, { activationId: second.activationId });
    expect(settled).toContain(second.activationId);
    expect(registry.get(key)?.activation).toBeUndefined();

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('force detach/error clears activeTools, streamingMessage, queues and bumps streamRevision', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const eventListenerRef: { current?: (e: unknown) => void } = {};
    const { registry, key } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef,
    });

    await registry.activate(key, 'Task: tools', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));

    eventListenerRef.current?.({ type: 'agent_start' });
    eventListenerRef.current?.({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial…' }] },
    });
    eventListenerRef.current?.({
      type: 'tool_execution_start',
      toolCallId: 'tc1',
      toolName: 'bash',
      args: { command: 'sleep 99' },
    });
    eventListenerRef.current?.({
      type: 'tool_execution_update',
      toolCallId: 'tc1',
      partialResult: 'running…',
    });
    eventListenerRef.current?.({
      type: 'queue_update',
      steering: ['steer-1'],
      followUp: ['fu-1'],
    });
    await new Promise((r) => setImmediate(r));

    const mid = registry.get(key)!;
    expect(mid.streamingMessage).toBeDefined();
    expect(mid.activeTools.length).toBe(1);
    expect(mid.queueCount).toBe(2);
    const streamRev = mid.streamRevision;

    await registry.detach(key);
    const after = registry.get(key)!;
    expect(after.streamingMessage).toBeUndefined();
    expect(after.activeTools).toEqual([]);
    expect(after.steeringQueue).toEqual([]);
    expect(after.followUpQueue).toEqual([]);
    expect(after.queueCount).toBe(0);
    expect(after.streamRevision).toBeGreaterThan(streamRev);
    expect(after.activation).toBeUndefined();

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('idle steer demotes to prompt', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const modeBox: { last: string | undefined } = { last: undefined };
    const eventListenerRef: { current?: (e: unknown) => void } = {};
    const transport = {
      async getState() {
        return {
          sessionId: 's',
          thinkingLevel: 'off',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'one-at-a-time',
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        };
      },
      async prompt() {
        modeBox.last = 'prompt';
      },
      async steer() {
        modeBox.last = 'steer';
      },
      async followUp() {
        modeBox.last = 'follow_up';
      },
      async abort() {},
      subscribe(fn: (e: unknown) => void) {
        eventListenerRef.current = fn;
        return () => {
          eventListenerRef.current = undefined;
        };
      },
      async dispose() {},
      getStderr() {
        return '';
      },
    } as unknown as PiRpcTransport;

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'look',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);

    const reg = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => transport,
    });
    reg.setHostLinkAppender(() => undefined);
    const snap = await reg.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-steer',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    // First turn then settle to idle (Pi 0.80.6: agent_start before agent_settled).
    await reg.activate(snap.key, 'Task: first', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    eventListenerRef.current?.({ type: 'agent_start' });
    eventListenerRef.current?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListenerRef.current?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    expect(reg.get(snap.key)?.status).toBe('idle');

    modeBox.last = 'unset';
    // Stale steer while idle must demote to prompt.
    await reg.activate(snap.key, 'again', 'steer', undefined, 'view');
    await new Promise((r) => setImmediate(r));
    expect(modeBox.last === 'prompt').toBe(true);

    await reg.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('coalesces burst message_update under a gated transition and flushes before settle', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const eventListenerRef: { current?: (e: unknown) => void } = {};
    const { registry, key } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef,
    });

    await registry.activate(key, 'Task: coalesce', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));

    // Truly block the transition queue while the burst arrives.
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    const order: string[] = [];
    void registry._enqueueTransition(key, async () => {
      order.push('block-start');
      await gate;
      order.push('block-end');
    });

    const transcriptKinds: string[] = [];
    registry.subscribe((e) => {
      if (e.type === 'endpoint_updated' && e.kind === 'transcript') {
        const text =
          (e.snapshot.streamingMessage as { content?: { text?: string }[] } | undefined)
            ?.content?.[0]?.text ?? '';
        transcriptKinds.push(text);
        order.push(`transcript:${text}`);
      }
      if (e.type === 'endpoint_updated' && e.kind === 'full') {
        order.push(`full:${e.snapshot.status}`);
      }
      if (e.type === 'activation_settled') {
        order.push(`settled:${e.activationId}`);
      }
    });

    // Start event while queue is blocked.
    eventListenerRef.current?.({ type: 'agent_start' });
    // Fire a burst without awaiting — coalesce should keep only the latest.
    for (let i = 0; i < 40; i++) {
      eventListenerRef.current?.({
        type: 'message_update',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `tok-${i}` }],
        },
      });
    }
    eventListenerRef.current?.({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'bash',
      args: {},
    });
    eventListenerRef.current?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListenerRef.current?.({ type: 'agent_settled' });

    // While blocked, no coalesced/transcript work should have published yet.
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['block-start']);
    expect(transcriptKinds.length).toBe(0);

    releaseGate();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));

    // Order: block ends, then stream flush (latest only), tool, then agent_settled.
    expect(order[0]).toBe('block-start');
    expect(order).toContain('block-end');
    const afterBlock = order.slice(order.indexOf('block-end'));
    // Coalesce: fewer than 40 transcript publishes; last token is tok-39.
    expect(transcriptKinds.length).toBeLessThan(40);
    expect(transcriptKinds.length).toBeGreaterThan(0);
    expect(transcriptKinds[transcriptKinds.length - 1]).toBe('tok-39');
    // agent_settled settles after the flush path.
    expect(afterBlock.some((x) => x.startsWith('settled:'))).toBe(true);
    expect(registry.get(key)?.activation).toBeUndefined();
    expect(registry.get(key)?.status).toBe('idle');

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('coalesce boundary seal: U1 → boundary → U2 reduce order under blocked queue', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const eventListenerRef: { current?: (e: unknown) => void } = {};
    const { registry, key } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef,
    });

    await registry.activate(key, 'Task: boundary', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));

    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    void registry._enqueueTransition(key, async () => {
      await gate;
    });

    const reduceOrder: string[] = [];
    registry.subscribe((e) => {
      if (e.type === 'endpoint_updated' && e.kind === 'transcript') {
        const text =
          (e.snapshot.streamingMessage as { content?: { text?: string }[] } | undefined)
            ?.content?.[0]?.text ?? '';
        if (text) reduceOrder.push(`U:${text}`);
      }
      if (e.type === 'endpoint_updated' && e.kind === 'full' && e.snapshot.status === 'idle') {
        reduceOrder.push('boundary');
      }
      if (e.type === 'activation_settled') {
        reduceOrder.push(`settled:${e.activationId}`);
      }
    });

    // agent_start so agent_settled is activation-eligible (not a late A ghost).
    eventListenerRef.current?.({ type: 'agent_start' });
    // U1 while blocked.
    eventListenerRef.current?.({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'U1' }] },
    });
    // Boundary enqueued (seals U1).
    eventListenerRef.current?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListenerRef.current?.({ type: 'agent_settled' });
    // U2 after boundary is enqueued — must form a new cell after the boundary.
    eventListenerRef.current?.({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'U2' }] },
    });

    await new Promise((r) => setImmediate(r));
    expect(reduceOrder).toEqual([]);

    releaseGate();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));

    const u1 = reduceOrder.indexOf('U:U1');
    const boundary = reduceOrder.findIndex((x) => x.startsWith('settled:') || x === 'boundary');
    const u2 = reduceOrder.indexOf('U:U2');
    expect(u1).toBeGreaterThanOrEqual(0);
    expect(boundary).toBeGreaterThan(u1);
    // U2 may only appear after settle if a post-idle stream is accepted; when it
    // does, it must not precede the boundary.
    if (u2 >= 0) {
      expect(u2).toBeGreaterThan(boundary);
    }

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('settle-boundary: idle get_state drains pending agent_settled before new activation', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const modes: string[] = [];
    let eventListener: ((e: unknown) => void) | undefined;
    let getStateCalls = 0;
    let isStreaming = true;

    const transport = {
      async getState() {
        getStateCalls += 1;
        return {
          sessionId: 's',
          thinkingLevel: 'off',
          isStreaming,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'one-at-a-time',
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        };
      },
      async prompt() {
        modes.push('prompt');
      },
      async steer() {
        modes.push('steer');
      },
      async followUp() {
        modes.push('follow_up');
      },
      async abort() {},
      subscribe(fn: (e: unknown) => void) {
        eventListener = fn;
        return () => {
          eventListener = undefined;
        };
      },
      async dispose() {},
      getStderr() {
        return '';
      },
    } as unknown as PiRpcTransport;

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => transport,
    });
    registry.setHostLinkAppender(() => undefined);

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: { mode: 'single', agentScope: 'both', agent: 'explore', task: 'look' },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );
    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-settle-sync',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    const settled: string[] = [];
    registry.subscribe((e) => {
      if (e.type === 'activation_settled') settled.push(e.activationId);
    });

    const actA = await registry.activate(snap.key, 'Task: A', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    eventListener?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));
    expect(registry.get(snap.key)?.activation?.id).toBe(actA.activationId);

    // Block the transition queue so agent_settled is enqueued but not reduced.
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGate = r;
    });
    void registry._enqueueTransition(snap.key, async () => {
      await gate;
    });

    // Child is idle and agent_settled is in the pipe (queued behind the gate).
    isStreaming = false;
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });

    // User send while settle is pending — must not steer without a settled A.
    const actBPromise = registry.activate(snap.key, 'Task: B', 'steer', undefined, 'view');

    // get_state preflight observes idle; force-settle / drain is queued behind gate.
    await new Promise((r) => setTimeout(r, 20));
    expect(getStateCalls).toBeGreaterThanOrEqual(1);
    expect(settled).not.toContain(actA.activationId);

    releaseGate();
    const actB = await actBPromise;
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));

    // A settles first; B is a distinct activation started via prompt (not idle steer).
    expect(settled[0]).toBe(actA.activationId);
    expect(actB.activationId).not.toBe(actA.activationId);
    expect(registry.get(snap.key)?.activation?.id).toBe(actB.activationId);
    expect(modes).toContain('prompt');
    // Must not have used steer for the post-idle send.
    expect(modes.filter((m) => m === 'steer')).toHaveLength(0);

    // Subsequent abort + agent_settled (Pi 0.80.6) clears the live activation.
    await registry.abort(snap.key);
    expect(registry.get(snap.key)?.activation?.terminalOverride).toBe('cancelled');
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    expect(registry.get(snap.key)?.activation).toBeUndefined();

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('shutdown disposes multiple stubborn transports concurrently under one budget', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ systemPrompt: '' });
    const disposeStarts: number[] = [];
    const disposeDone: number[] = [];
    let factoryN = 0;

    const makeStubborn = () => {
      let eventListener: ((e: unknown) => void) | undefined;
      return {
        async getState() {
          return {
            sessionId: 's',
            thinkingLevel: 'off',
            isStreaming: false,
            isCompacting: false,
            steeringMode: 'all',
            followUpMode: 'one-at-a-time',
            autoCompactionEnabled: true,
            messageCount: 0,
            pendingMessageCount: 0,
          };
        },
        async prompt() {},
        async steer() {},
        async followUp() {},
        async abort() {},
        subscribe(fn: (e: unknown) => void) {
          eventListener = fn;
          return () => {
            eventListener = undefined;
          };
        },
        async dispose() {
          disposeStarts.push(Date.now());
          // Stubborn: longer than a serial 3× budget would allow if sequential.
          await new Promise((r) => setTimeout(r, 80));
          disposeDone.push(Date.now());
          void eventListener;
        },
        getStderr() {
          return '';
        },
      } as unknown as PiRpcTransport;
    };

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        factoryN += 1;
        return makeStubborn();
      },
    });
    registry.setHostLinkAppender(() => undefined);

    const keys: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { runId, record } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'explore', task: `t${i}` },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'explore',
            agentFingerprint: agentFingerprint(agent),
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
          },
        },
      });
      const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
      await store.updateRun(runId, (r) => {
        r.units.single.sessionFile = sessionFile;
        r.status = 'running';
      });
      const live = store.getRun(runId);
      if (live.ok) coordinator.registerRun(runId, live.loaded.record);
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(
        sessionFile,
        '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
      );
      const snap = await registry.registerInitial({
        runId,
        unitId: 'single',
        hostSessionId: `host-shut-${i}`,
        launchSpec: {
          agent,
          request: record.request,
          sessionFile,
          effectiveCwd: root,
          agentScope: 'both',
          registrationKind: 'initial',
        },
        getBranchEntries: () => [],
      });
      keys.push(snap.key);
      await registry.activate(snap.key, `Task: ${i}`, 'prompt');
    }
    expect(factoryN).toBe(3);
    expect(keys).toHaveLength(3);

    const t0 = Date.now();
    await registry.shutdown();
    const elapsed = Date.now() - t0;

    // All three dispose started nearly together (parallel), not staggered by 80ms each.
    expect(disposeStarts).toHaveLength(3);
    const startSpread = Math.max(...disposeStarts) - Math.min(...disposeStarts);
    expect(startSpread).toBeLessThan(50);
    // Total wall time well under serial 3×80ms ≈ 240ms (allow overhead).
    expect(elapsed).toBeLessThan(200);
    expect(disposeDone).toHaveLength(3);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('applyUnavailable bumps messagesRevision when clearing transcript', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const eventListenerRef: { current?: (e: unknown) => void } = {};
    const { registry, key, runId } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef,
      hostSessionId: 'host-rev',
    });

    await registry.activate(key, 'Task: hist', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    eventListenerRef.current?.({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'history' }] },
    });
    await new Promise((r) => setImmediate(r));
    const before = registry.get(key)!;
    expect(before.messages.length).toBeGreaterThan(0);
    const rev = before.messagesRevision;

    // Forge restore with host-session mismatch → applyUnavailable clears messages.
    const forged: InteractiveAgentLinkV1 = {
      version: 1,
      runId,
      unitId: 'single',
      bindingId: before.bindingId,
      hostSessionId: 'forged-other-host',
      createdAt: before.linkCreatedAt,
    };
    registry.restoreActiveBranch({
      sessionManager: {
        getSessionId: () => 'host-rev',
        getBranch: () => [{ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: forged }],
      },
      cwd: root,
    } as never);

    const after = registry.get(key)!;
    expect(after.status).toBe('unavailable');
    expect(after.messages).toHaveLength(0);
    expect(after.messagesRevision).toBeGreaterThan(rev);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('isOnActiveBranch is false for operable off-branch running endpoints', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const eventListenerRef: { current?: (e: unknown) => void } = {};
    const { registry, key } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef,
    });

    expect(registry.isOnActiveBranch(key)).toBe(true);
    await registry.activate(key, 'Task: run', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    eventListenerRef.current?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));
    expect(registry.get(key)?.status).toBe('running');

    // Navigate tree away: clear branch membership but leave running endpoint operable.
    registry.restoreActiveBranch({
      sessionManager: {
        getSessionId: () => 'host-stream',
        getBranch: () => [],
      },
      cwd: root,
    } as never);

    // After restore with empty branch, branchKeys is rebuilt from the branch only.
    // Running endpoint may still be listVisible (operable) but not on active branch.
    expect(registry.isOnActiveBranch(key)).toBe(false);
    // Still operable for status/abort.
    expect(registry.get(key)?.status).toBe('running');
    expect(registry.listVisible().some((e) => e.key === key)).toBe(true);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('restore is metadata-only: no session hydrate until ensureTranscript/activate', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const bindingId = 'bind-lazy';
    const createdAt = 99;

    // Two endpoints on the branch.
    const runA = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'a',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
          interactiveBindings: {
            [bindingId]: { bindingId, hostSessionId: 'host-lazy', createdAt },
          },
        } satisfies RunUnitRecord,
      },
    });
    const runB = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'b',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
          interactiveBindings: {
            [bindingId]: { bindingId, hostSessionId: 'host-lazy', createdAt },
          },
        } satisfies RunUnitRecord,
      },
    });

    const sessionA = path.join(store.getRunDir(runA.runId), 'sessions', 'a.jsonl');
    const sessionB = path.join(store.getRunDir(runB.runId), 'sessions', 'b.jsonl');
    // Write minimal session files; hydrate count is observed via SessionManager.open spy.
    fs.mkdirSync(path.dirname(sessionA), { recursive: true });
    fs.mkdirSync(path.dirname(sessionB), { recursive: true });
    fs.writeFileSync(
      sessionA,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );
    fs.writeFileSync(
      sessionB,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );
    await store.updateRun(runA.runId, (r) => {
      r.units.single.sessionFile = sessionA;
      r.status = 'completed';
    });
    await store.updateRun(runB.runId, (r) => {
      r.units.single.sessionFile = sessionB;
      r.status = 'completed';
    });

    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const originalOpen = SessionManager.open.bind(SessionManager);
    let openCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (SessionManager as any).open = (...args: unknown[]) => {
      openCount += 1;
      return originalOpen(...(args as Parameters<typeof SessionManager.open>));
    };

    try {
      const registry = createInteractiveAgentRegistry({
        runStore: store,
        runCoordinator: coordinator,
        discoverAgentsFn: () => ({
          agents: [agent],
          projectAgentsDir: null,
          builtinAgentsDir: '/tmp',
        }),
      });

      const links = [
        {
          version: 1 as const,
          runId: runA.runId,
          unitId: 'single',
          bindingId,
          hostSessionId: 'host-lazy',
          createdAt,
        },
        {
          version: 1 as const,
          runId: runB.runId,
          unitId: 'single',
          bindingId,
          hostSessionId: 'host-lazy',
          createdAt,
        },
      ];

      const restored = registry.restoreActiveBranch({
        cwd: root,
        sessionManager: {
          getSessionId: () => 'host-lazy',
          getBranch: () =>
            links.map((data) => ({
              type: 'custom',
              customType: INTERACTIVE_LINK_TYPE,
              data,
            })),
        } as never,
      });

      expect(restored.length).toBe(2);
      expect(openCount).toBe(0);
      // listVisible is metadata-friendly: may expose empty messages until hydrate.
      const listed = registry.listVisible();
      expect(listed).toHaveLength(2);
      expect(listed.every((e) => e.messages.length === 0)).toBe(true);
      expect(openCount).toBe(0);
      expect(registry.listVisibleMeta()).toHaveLength(2);
      expect(openCount).toBe(0);

      // get is pure in-memory — never opens SessionManager.
      const keyA = `${runA.runId}:single`;
      const memA = registry.get(keyA);
      expect(memA).toBeDefined();
      expect(memA?.messages.length).toBe(0);
      expect(openCount).toBe(0);

      // ensureTranscript hydrates only that session (after writer barrier).
      const gotA = await registry.ensureTranscript(keyA);
      expect(gotA).toBeDefined();
      expect(openCount).toBe(1);

      // Second ensure is a no-op for open count once hydrated.
      await registry.ensureTranscript(keyA);
      expect(openCount).toBe(1);
      // get still does not open.
      registry.get(keyA);
      expect(openCount).toBe(1);

      // B still not hydrated until ensureTranscript.
      const keyB = `${runB.runId}:single`;
      const listedB = registry.listVisible().find((e) => e.key === keyB);
      expect(listedB?.messages.length).toBe(0);
      expect(openCount).toBe(1);
      registry.get(keyB);
      expect(openCount).toBe(1);
      await registry.ensureTranscript(keyB);
      expect(openCount).toBe(2);

      await registry.shutdown();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (SessionManager as any).open = originalOpen;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('InteractiveAgentRegistry adversarial review fixes', () => {
  it('Pi 0.80.6: only agent_settled settles; agent_end keeps activation running', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const eventListenerRef: { current?: (e: unknown) => void } = {};
    const { registry, key } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef,
    });

    const settled: string[] = [];
    registry.subscribe((e) => {
      if (e.type === 'activation_settled') settled.push(e.activationId);
    });

    const act = await registry.activate(key, 'Task: done', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));

    eventListenerRef.current?.({ type: 'agent_start' });
    eventListenerRef.current?.({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
    });
    eventListenerRef.current?.({
      type: 'queue_update',
      steering: ['steer-pending'],
      followUp: ['fu-pending'],
    });
    eventListenerRef.current?.({
      type: 'tool_execution_start',
      toolCallId: 't1',
      toolName: 'bash',
      args: { cmd: 'ls' },
    });
    eventListenerRef.current?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'final answer' }],
        usage: { input: 2, output: 3, totalTokens: 5 },
      },
    });
    // Low-level run end (willRetry false) must NOT settle.
    eventListenerRef.current?.({ type: 'agent_end', messages: [], willRetry: false });
    await new Promise((r) => setImmediate(r));

    const mid = registry.get(key)!;
    expect(settled).not.toContain(act.activationId);
    expect(mid.status).toBe('running');
    expect(mid.activation?.id).toBe(act.activationId);
    expect(mid.activation?.settled).toBe(false);
    // Queues/tools/streaming remain for possible follow-up/retry; agent_end does not clear them.
    expect(mid.steeringQueue).toEqual(['steer-pending']);
    expect(mid.followUpQueue).toEqual(['fu-pending']);
    expect(mid.activeTools.length).toBeGreaterThan(0);
    expect(mid.messages.some((m) => JSON.stringify(m).includes('final answer'))).toBe(true);

    // willRetry true also must not settle.
    eventListenerRef.current?.({ type: 'agent_end', messages: [], willRetry: true });
    await new Promise((r) => setImmediate(r));
    expect(settled).toHaveLength(0);
    expect(registry.get(key)?.activation?.id).toBe(act.activationId);

    // Follow-up / second low-level run while still open.
    eventListenerRef.current?.({
      type: 'queue_update',
      steering: [],
      followUp: ['after-done'],
    });
    eventListenerRef.current?.({ type: 'agent_start' });
    eventListenerRef.current?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'follow-up reply' }],
        usage: { input: 1, output: 1, totalTokens: 2 },
      },
    });
    eventListenerRef.current?.({ type: 'agent_end', messages: [], willRetry: false });
    await new Promise((r) => setImmediate(r));
    expect(settled).toHaveLength(0);
    expect(registry.get(key)?.status).toBe('running');
    expect(registry.get(key)?.activation?.id).toBe(act.activationId);

    // Fully settled: clear transients, idle, LRU can continue.
    eventListenerRef.current?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));

    const after = registry.get(key)!;
    expect(settled).toContain(act.activationId);
    expect(after.status).toBe('idle');
    expect(after.activation).toBeUndefined();
    expect(after.streamingMessage).toBeUndefined();
    expect(after.activeTools).toHaveLength(0);
    expect(after.steeringQueue).toEqual([]);
    expect(after.followUpQueue).toEqual([]);
    expect(after.messages.some((m) => JSON.stringify(m).includes('follow-up reply'))).toBe(true);

    // Relay/LRU can continue: new activation after normal settle.
    const next = await registry.activate(key, 'Task: again', 'prompt', undefined, 'view');
    expect(next.activationId).not.toBe(act.activationId);
    expect(registry.get(key)?.activation?.id).toBe(next.activationId);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('applyUnavailable atomically invalidates live/starting endpoint on forged /tree link', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ systemPrompt: '' });
    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'look',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );

    let disposed = false;
    let eventListener: ((e: unknown) => void) | undefined;
    let resolveState!: () => void;
    const stateGate = new Promise<void>((r) => {
      resolveState = r;
    });
    let lateInstalled = false;

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () =>
        ({
          async getState() {
            await stateGate;
            lateInstalled = true;
            return {
              sessionId: 't1',
              thinkingLevel: 'off',
              isStreaming: false,
              isCompacting: false,
              steeringMode: 'all',
              followUpMode: 'one-at-a-time',
              autoCompactionEnabled: true,
              messageCount: 0,
              pendingMessageCount: 0,
            };
          },
          async prompt() {},
          async steer() {},
          async followUp() {},
          async abort() {},
          subscribe(fn: (e: unknown) => void) {
            eventListener = fn;
            return () => {
              eventListener = undefined;
            };
          },
          async dispose() {
            disposed = true;
          },
          getStderr() {
            return '';
          },
        }) as unknown as PiRpcTransport,
    });
    registry.setHostLinkAppender(() => undefined);

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-live',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    // Start handshake (starting) then forge an invalid host-session link on /tree.
    const actPromise = registry.activate(snap.key, 'Task: live', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setTimeout(r, 10));

    const genBefore = (registry._endpoints.get(snap.key) as { transportGeneration: number })
      .transportGeneration;

    // Forged link: wrong host session → applyUnavailable while starting.
    const forged: InteractiveAgentLinkV1 = {
      version: 1,
      runId,
      unitId: 'single',
      bindingId: snap.bindingId,
      hostSessionId: 'forged-other-host',
      createdAt: Date.now(),
    };
    registry.restoreActiveBranch({
      sessionManager: {
        getSessionId: () => 'forged-other-host',
        getBranch: () => [{ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: forged }],
      },
      cwd: root,
    } as never);

    const after = registry.get(snap.key);
    // Wrong host: endpoint may be invisible on the forged branch identity, or unavailable.
    const ep = registry._endpoints.get(snap.key) as
      | {
          status: string;
          transportGeneration: number;
          client?: unknown;
          transportReady?: unknown;
          activation?: unknown;
        }
      | undefined;
    expect(ep?.status).toBe('unavailable');
    expect(ep?.transportGeneration).toBeGreaterThan(genBefore);
    expect(ep?.client).toBeUndefined();
    expect(ep?.transportReady).toBeUndefined();
    expect(ep?.activation).toBeUndefined();

    // Late T1 resolve must not install.
    resolveState();
    await expect(actPromise).rejects.toBeTruthy();
    await new Promise((r) => setImmediate(r));
    // Either never completed install, or disposed after supersede.
    expect(disposed || !lateInstalled || !ep?.client).toBe(true);
    expect(registry._endpoints.get(snap.key)?.client).toBeUndefined();

    // Late event from the discarded listener must not settle anything new.
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    await new Promise((r) => setImmediate(r));
    expect(registry._endpoints.get(snap.key)?.status).toBe('unavailable');

    void after;
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reopen success clears lastError: transport failure → trusted reopen → agent_settled completed', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ systemPrompt: '' });
    let factoryCalls = 0;
    let eventListener: ((e: unknown) => void) | undefined;
    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'look',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        factoryCalls += 1;
        if (factoryCalls === 1) {
          throw new Error('spawn boom');
        }
        return {
          async getState() {
            return {
              sessionId: 't2',
              thinkingLevel: 'off',
              isStreaming: false,
              isCompacting: false,
              steeringMode: 'all',
              followUpMode: 'one-at-a-time',
              autoCompactionEnabled: true,
              messageCount: 0,
              pendingMessageCount: 0,
            };
          },
          async prompt() {},
          async steer() {},
          async followUp() {},
          async abort() {},
          subscribe(fn: (e: unknown) => void) {
            eventListener = fn;
            return () => {
              eventListener = undefined;
            };
          },
          async dispose() {},
          getStderr() {
            return '';
          },
        } as unknown as PiRpcTransport;
      },
    });
    registry.setHostLinkAppender(() => undefined);

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-reopen',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    let firstErr: unknown;
    try {
      await registry.activate(snap.key, 'Task: fail', 'prompt');
    } catch (err) {
      firstErr = err;
    }
    expect(firstErr).toBeTruthy();
    expect(String(firstErr)).toMatch(/spawn boom/);
    const failed = registry.get(snap.key)!;
    expect(failed.status).toBe('error');
    expect(failed.lastError).toMatch(/spawn boom/);
    expect(failed.errorCode).toBe('transport_error');

    // Trusted reopen T2.
    const act2 = await registry.activate(snap.key, 'Task: recover', 'prompt', undefined, 'view');
    await new Promise((r) => setImmediate(r));
    const mid = registry.get(snap.key)!;
    // Handshake success / running path clears prior error.
    expect(mid.lastError).toBeUndefined();
    expect(mid.errorCode).toBeUndefined();
    expect(mid.hasTransport).toBe(true);

    eventListener?.({ type: 'agent_start' });
    eventListener?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'recovered' }],
      },
    });
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));

    const done = registry.get(snap.key)!;
    expect(done.status).toBe('idle');
    expect(done.activation).toBeUndefined();
    expect(done.lastError).toBeUndefined();
    expect(done.messages.some((m) => JSON.stringify(m).includes('recovered'))).toBe(true);
    expect(act2.activationId).toBeTruthy();

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('abort does not block transition queue on hanging abort RPC; settles near injected timeout', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    let abortStarted = 0;
    let abortResolved = false;
    const eventListenerRef: { current?: (e: unknown) => void } = {};

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'look',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      abortSettleTimeoutMs: 50,
      transportFactory: async () =>
        ({
          async getState() {
            return {
              sessionId: 's',
              thinkingLevel: 'off',
              isStreaming: false,
              isCompacting: false,
              steeringMode: 'all',
              followUpMode: 'one-at-a-time',
              autoCompactionEnabled: true,
              messageCount: 0,
              pendingMessageCount: 0,
            };
          },
          async prompt() {},
          async steer() {},
          async followUp() {},
          async abort() {
            abortStarted += 1;
            // Hang forever (simulates transport RPC timeout path without a 30s timer
            // that would keep the test process alive). unref not needed: no timer.
            await new Promise(() => {
              /* never settles */
            });
            abortResolved = true;
          },
          subscribe(fn: (e: unknown) => void) {
            eventListenerRef.current = fn;
            return () => {
              eventListenerRef.current = undefined;
            };
          },
          async dispose() {},
          getStderr() {
            return '';
          },
        }) as unknown as PiRpcTransport,
    });
    registry.setHostLinkAppender(() => undefined);

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-abort',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    const act = await registry.activate(snap.key, 'Task: hang', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    eventListenerRef.current?.({ type: 'agent_start' });

    const t0 = Date.now();
    // abort() itself must return quickly (does not await hanging RPC).
    await registry.abort(snap.key);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(abortStarted).toBe(1);
    expect(registry.get(snap.key)?.activation?.terminalOverride).toBe('cancelled');

    // Transition queue remains usable: agent_settled (after agent_end) can still settle.
    // agent_end alone must not settle; agent_settled completes the abort path.
    eventListenerRef.current?.({ type: 'agent_end', messages: [], willRetry: false });
    await new Promise((r) => setImmediate(r));
    expect(registry.get(snap.key)?.activation?.id).toBe(act.activationId);
    eventListenerRef.current?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    // Protocol settle must not wait ~30s on the hanging abort RPC.
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(abortResolved).toBe(false);
    expect(registry.get(snap.key)?.activation).toBeUndefined();
    expect(registry.get(snap.key)?.status).toBe('idle');

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('registerInitial with non-empty session history hydrates (not permanent empty)', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'look',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sessionsDir = path.join(store.getRunDir(runId), 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    // Real on-disk Pi session JSONL (SessionManager.create may stay in-memory
    // until first process write; write a valid persisted file for hydrate).
    const sessionFile = path.join(sessionsDir, 'resume.jsonl');
    const header = {
      type: 'session',
      version: 3,
      id: 'sess-resume',
      timestamp: new Date().toISOString(),
      cwd: root,
    };
    const msgEntry = {
      type: 'message',
      id: 'm1',
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'prior history from fork/resume' }],
        timestamp: Date.now(),
      },
    };
    fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(msgEntry)}\n`);
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        throw new Error('no spawn');
      },
    });
    registry.setHostLinkAppender(() => undefined);

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-hist',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    expect(snap.messages.length).toBeGreaterThan(0);
    expect(JSON.stringify(snap.messages)).toContain('prior history from fork/resume');

    // Frozen: consumer cannot mutate registry history.
    expect(() => {
      (snap.messages as unknown as unknown[]).push({ role: 'user', content: 'hack' });
    }).toThrow();

    // Baseline for activation includes hydrated history length.
    const baseline = snap.messages.length;
    expect(baseline).toBeGreaterThan(0);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('outbound poison: concurrent steer after prompt reject writes only once; new activation retries', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ systemPrompt: '' });
    const writes: string[] = [];
    let promptRejects = true;
    let eventListener: ((e: unknown) => void) | undefined;

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'look',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );

    let resolveState!: () => void;
    const stateGate = new Promise<void>((r) => {
      resolveState = r;
    });

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () =>
        ({
          async getState() {
            await stateGate;
            return {
              sessionId: 's',
              thinkingLevel: 'off',
              isStreaming: false,
              isCompacting: false,
              steeringMode: 'all',
              followUpMode: 'one-at-a-time',
              autoCompactionEnabled: true,
              messageCount: 0,
              pendingMessageCount: 0,
            };
          },
          async prompt(msg: string) {
            writes.push(`prompt:${msg}`);
            if (promptRejects) throw new Error('prompt failed');
          },
          async steer(msg: string) {
            writes.push(`steer:${msg}`);
          },
          async followUp(msg: string) {
            writes.push(`follow_up:${msg}`);
          },
          async abort() {},
          subscribe(fn: (e: unknown) => void) {
            eventListener = fn;
            return () => {
              eventListener = undefined;
            };
          },
          async dispose() {},
          getStderr() {
            return '';
          },
        }) as unknown as PiRpcTransport,
    });
    registry.setHostLinkAppender(() => undefined);

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-poison',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    // Concurrent prompt + steer sharing the startup barrier / same activation window.
    const p1 = registry.activate(snap.key, 'first', 'prompt', undefined, 'tool_call');
    const p2 = registry.send(snap.key, 'steer-me', 'prompt');
    resolveState();
    const results = await Promise.allSettled([p1, p2]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);

    // Only the first write (prompt) should have hit the transport; steer must be poisoned.
    expect(writes.filter((w) => w.startsWith('prompt:'))).toHaveLength(1);
    expect(writes.filter((w) => w.startsWith('steer:'))).toHaveLength(0);

    // New activation after settle may write again.
    promptRejects = false;
    // Ensure prior activation is cleared.
    await new Promise((r) => setImmediate(r));
    const retry = await registry.activate(snap.key, 'retry-ok', 'prompt', undefined, 'view');
    expect(writes).toContain('prompt:retry-ok');
    expect(retry.activationId).toBeTruthy();
    void eventListener;

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('production path: registry + fake transport + agent_settled, non-empty session, serial abort/detach', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ systemPrompt: '' });
    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'look',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sessionsDir = path.join(store.getRunDir(runId), 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, 'prod.jsonl');
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: 'session',
        version: 3,
        id: 'sess-prod',
        timestamp: new Date().toISOString(),
        cwd: root,
      })}\n${JSON.stringify({
        type: 'message',
        id: 'm1',
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'seeded history' }],
          timestamp: Date.now(),
        },
      })}\n`
    );
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);

    let eventListener: ((e: unknown) => void) | undefined;
    const calls: string[] = [];
    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      abortSettleTimeoutMs: 80,
      transportFactory: async () =>
        ({
          async getState() {
            calls.push('getState');
            return {
              sessionId: 'prod',
              thinkingLevel: 'off',
              isStreaming: false,
              isCompacting: false,
              steeringMode: 'all',
              followUpMode: 'one-at-a-time',
              autoCompactionEnabled: true,
              messageCount: 1,
              pendingMessageCount: 0,
            };
          },
          async prompt(msg: string) {
            calls.push(`prompt:${msg}`);
          },
          async steer() {
            calls.push('steer');
          },
          async followUp() {
            calls.push('follow_up');
          },
          async abort() {
            calls.push('abort');
          },
          subscribe(fn: (e: unknown) => void) {
            eventListener = fn;
            return () => {
              eventListener = undefined;
            };
          },
          async dispose() {
            calls.push('dispose');
          },
          getStderr() {
            return '';
          },
        }) as unknown as PiRpcTransport,
    });
    registry.setHostLinkAppender(() => undefined);

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-prod',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });
    expect(snap.messages.length).toBeGreaterThan(0);

    const act = await registry.activate(snap.key, 'prod-task', 'prompt', undefined, 'tool_call');
    expect(act.snapshot.messages.length).toBeGreaterThan(0);
    eventListener?.({ type: 'agent_start' });
    eventListener?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'prod done' }],
      },
    });
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    expect(registry.get(snap.key)?.status).toBe('idle');

    // Serial abort then detach path.
    const act2 = await registry.activate(snap.key, 'again', 'prompt', undefined, 'view');
    eventListener?.({ type: 'agent_start' });
    await registry.abort(snap.key);
    expect(calls).toContain('abort');
    await registry.detach(snap.key, { activationId: act2.activationId });
    expect(registry.get(snap.key)?.activation).toBeUndefined();

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('InteractiveAgentRegistry planned missing, hydrate, dispose barrier', () => {
  it('planned missing session: first transport fail then reopen retry succeeds (0.80.6 format)', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ systemPrompt: '' });
    let attempts = 0;
    let eventListener: ((e: unknown) => void) | undefined;

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'look',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    // Planned path only — do not create the file (Pi 0.80.6 SessionManager.create style).
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned-retry.jsonl');
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);
    // Ensure sessions dir exists for containment checks but leave file missing.
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    expect(fs.existsSync(sessionFile)).toBe(false);

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('handshake failed before first persist');
        }
        return {
          async getState() {
            return {
              sessionId: 's',
              thinkingLevel: 'off',
              isStreaming: false,
              isCompacting: false,
              steeringMode: 'all',
              followUpMode: 'one-at-a-time',
              autoCompactionEnabled: true,
              messageCount: 0,
              pendingMessageCount: 0,
            };
          },
          async prompt() {},
          async steer() {},
          async followUp() {},
          async abort() {},
          subscribe(fn: (e: unknown) => void) {
            eventListener = fn;
            return () => {
              eventListener = undefined;
            };
          },
          async dispose() {},
          getStderr() {
            return '';
          },
        } as unknown as PiRpcTransport;
      },
    });
    registry.setHostLinkAppender(() => undefined);

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-planned',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });
    expect(snap.status).toBe('registered');
    expect(fs.existsSync(sessionFile)).toBe(false);

    // First spawn/handshake fails while file still missing.
    await expect(registry.activate(snap.key, 'Task: first', 'prompt')).rejects.toThrow(
      /handshake|fail/i
    );
    expect(registry.get(snap.key)?.status).toBe('error');
    expect(attempts).toBe(1);
    expect(fs.existsSync(sessionFile)).toBe(false);

    // Reopen revalidation still allows planned missing; retry succeeds.
    const act = await registry.activate(snap.key, 'Task: retry', 'prompt');
    expect(act.activationId).toBeTruthy();
    expect(attempts).toBe(2);
    eventListener?.({ type: 'agent_start' });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));

    // Once the file appears, planned-missing grace ends (restore path still strict).
    const header = {
      type: 'session',
      version: 3,
      id: 'sess-planned',
      timestamp: new Date().toISOString(),
      cwd: root,
    };
    fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
    await registry.ensureTranscript(snap.key);
    const ep = (
      registry as unknown as {
        _endpoints: Map<string, { allowPlannedMissingSession?: boolean }>;
      }
    )._endpoints.get(snap.key);
    expect(ep?.allowPlannedMissingSession).toBe(false);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('restored missing session still fails closed (no planned-missing grace)', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const bindingId = 'bind-restore-miss';
    const createdAt = 42;
    const { runId } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'a',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
          interactiveBindings: {
            [bindingId]: { bindingId, hostSessionId: 'host-rm', createdAt },
          },
        } satisfies RunUnitRecord,
      },
    });
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'gone.jsonl');
    // Store path but never create the file.
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'completed';
    });
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
    });
    const restored = registry.restoreActiveBranch({
      cwd: root,
      sessionManager: {
        getSessionId: () => 'host-rm',
        getBranch: () => [
          {
            type: 'custom',
            customType: INTERACTIVE_LINK_TYPE,
            data: {
              version: 1,
              runId,
              unitId: 'single',
              bindingId,
              hostSessionId: 'host-rm',
              createdAt,
            },
          },
        ],
      } as never,
    });
    expect(restored.some((e) => e.status === 'unavailable')).toBe(true);
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('hydrate distinguishes corrupt session from legal empty; retries after fix', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'look',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sessionsDir = path.join(store.getRunDir(runId), 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, 'hydrate.jsonl');
    // Corrupt file present at register time.
    fs.writeFileSync(sessionFile, 'not-valid-jsonl{{{\n');
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        throw new Error('no spawn');
      },
    });
    registry.setHostLinkAppender(() => undefined);

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-hydrate',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });
    // Corrupt at register: not marked permanently empty.
    const epMap = (
      registry as unknown as {
        _endpoints: Map<string, { transcriptHydrated: boolean; activation?: unknown }>;
      }
    )._endpoints;
    expect(epMap.get(snap.key)?.transcriptHydrated).toBe(false);

    // get is pure memory — does not attempt hydrate or change the flag.
    registry.get(snap.key);
    expect(epMap.get(snap.key)?.transcriptHydrated).toBe(false);

    // Soft ensureTranscript leaves unhydrated for retry after parse failure.
    await registry.ensureTranscript(snap.key);
    expect(epMap.get(snap.key)?.transcriptHydrated).toBe(false);

    // Activate with required history fails cleanly — no zombie activation.
    await expect(registry.activate(snap.key, 'Task: need hist', 'prompt')).rejects.toMatchObject({
      code: 'hydrate_error',
    });
    expect(registry.get(snap.key)?.activation).toBeUndefined();
    expect(epMap.get(snap.key)?.activation).toBeUndefined();

    // Fix file to legal empty session (0.80.6 header only).
    const header = {
      type: 'session',
      version: 3,
      id: 'sess-empty',
      timestamp: new Date().toISOString(),
      cwd: root,
    };
    fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
    // get still does not open disk.
    expect(registry.get(snap.key)?.messages).toEqual([]);
    expect(epMap.get(snap.key)?.transcriptHydrated).toBe(false);
    const afterFix = await registry.ensureTranscript(snap.key);
    expect(afterFix?.messages).toEqual([]);
    expect(epMap.get(snap.key)?.transcriptHydrated).toBe(true);

    // Legal empty with a message then works for activate baseline.
    const msgEntry = {
      type: 'message',
      id: 'm1',
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'recovered history' }],
        timestamp: Date.now(),
      },
    };
    // Reset hydrated so ensureTranscript reloads after we rewrite the file with history.
    const ep = epMap.get(snap.key)!;
    (ep as { transcriptHydrated: boolean }).transcriptHydrated = false;
    fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(msgEntry)}\n`);
    const withHist = await registry.ensureTranscript(snap.key);
    expect(JSON.stringify(withHist?.messages)).toContain('recovered history');

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('dispose barrier fail-closed: kill-failed dispose blocks same-session T2 spawn', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ systemPrompt: '' });
    let factoryN = 0;

    const { registry, key } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef: {},
      transportFactory: async () => {
        factoryN += 1;
        return {
          async getState() {
            return {
              sessionId: 's',
              thinkingLevel: 'off',
              isStreaming: false,
              isCompacting: false,
              steeringMode: 'all',
              followUpMode: 'one-at-a-time',
              autoCompactionEnabled: true,
              messageCount: 0,
              pendingMessageCount: 0,
            };
          },
          async prompt() {},
          async steer() {},
          async followUp() {},
          async abort() {},
          subscribe() {
            return () => undefined;
          },
          async dispose() {
            throw Object.assign(
              new Error('SIGKILL failed; child may still hold the session writer'),
              {
                code: 'dispose_failed',
              }
            );
          },
          getStderr() {
            return '';
          },
        } as unknown as PiRpcTransport;
      },
    });

    await registry.activate(key, 'Task: go', 'prompt');
    expect(factoryN).toBe(1);

    // Detach triggers dispose which rejects; barrier must fail closed.
    await registry.detach(key);
    await new Promise((r) => setImmediate(r));

    await expect(registry.activate(key, 'Task: T2', 'prompt')).rejects.toThrow(
      /SIGKILL|dispose|fail/i
    );
    // T2 factory must not have run.
    expect(factoryN).toBe(1);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('protocol/stdio exit: dispose barrier before clear client; T2 factory waits for T1 close', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ systemPrompt: '' });
    const order: string[] = [];
    let factoryN = 0;
    let releaseT1Close!: () => void;
    const t1CloseGate = new Promise<void>((r) => {
      releaseT1Close = r;
    });
    let t1Listener: ((e: unknown) => void) | undefined;

    const { registry, key } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef: {},
      hostSessionId: 'host-proto-exit',
      transportFactory: async () => {
        factoryN += 1;
        const n = factoryN;
        order.push(`factory-${n}`);
        if (n === 1) {
          return {
            async getState() {
              return {
                sessionId: 't1',
                thinkingLevel: 'off',
                isStreaming: false,
                isCompacting: false,
                steeringMode: 'all',
                followUpMode: 'one-at-a-time',
                autoCompactionEnabled: true,
                messageCount: 0,
                pendingMessageCount: 0,
              };
            },
            async prompt() {},
            async steer() {},
            async followUp() {},
            async abort() {},
            subscribe(fn: (e: unknown) => void) {
              t1Listener = fn;
              return () => {
                t1Listener = undefined;
              };
            },
            async dispose() {
              order.push('t1-dispose-start');
              await t1CloseGate;
              order.push('t1-dispose-done');
            },
            getStderr() {
              return '';
            },
          } as unknown as PiRpcTransport;
        }
        order.push('factory-2-ran-after-t1-close');
        return {
          async getState() {
            return {
              sessionId: 't2',
              thinkingLevel: 'off',
              isStreaming: false,
              isCompacting: false,
              steeringMode: 'all',
              followUpMode: 'one-at-a-time',
              autoCompactionEnabled: true,
              messageCount: 0,
              pendingMessageCount: 0,
            };
          },
          async prompt() {},
          async steer() {},
          async followUp() {},
          async abort() {},
          subscribe() {
            return () => undefined;
          },
          async dispose() {},
          getStderr() {
            return '';
          },
        } as unknown as PiRpcTransport;
      },
    });

    await registry.activate(key, 'Task: A', 'prompt');
    expect(factoryN).toBe(1);

    // Simulate unintentional protocol failure (malformed/overflow/stdin) via exit event.
    t1Listener?.({
      type: 'pi_rpc_transport_exit',
      intentional: false,
      code: null,
      signal: null,
      error: { message: 'RPC stdout record exceeded 2 MiB', code: 'stdout_overflow' },
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toContain('t1-dispose-start');
    expect(registry.get(key)?.status).toBe('error');

    // Immediate reopen while T1 dispose still gated — factory must not run.
    const actBPromise = registry.activate(key, 'Task: B', 'prompt');
    await new Promise((r) => setTimeout(r, 40));
    expect(factoryN).toBe(1);
    expect(order.filter((x) => x.startsWith('factory-'))).toEqual(['factory-1']);

    releaseT1Close();
    const actB = await actBPromise;
    expect(factoryN).toBe(2);
    expect(order.indexOf('factory-2')).toBeGreaterThan(order.indexOf('t1-dispose-done'));
    expect(actB.activationId).toBeTruthy();

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('protocol exit dispose reject fail-closed: T2 does not spawn', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ systemPrompt: '' });
    let factoryN = 0;
    let t1Listener: ((e: unknown) => void) | undefined;

    const { registry, key } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef: {},
      hostSessionId: 'host-proto-fail',
      transportFactory: async () => {
        factoryN += 1;
        return {
          async getState() {
            return {
              sessionId: 't1',
              thinkingLevel: 'off',
              isStreaming: false,
              isCompacting: false,
              steeringMode: 'all',
              followUpMode: 'one-at-a-time',
              autoCompactionEnabled: true,
              messageCount: 0,
              pendingMessageCount: 0,
            };
          },
          async prompt() {},
          async steer() {},
          async followUp() {},
          async abort() {},
          subscribe(fn: (e: unknown) => void) {
            t1Listener = fn;
            return () => {
              t1Listener = undefined;
            };
          },
          async dispose() {
            throw Object.assign(
              new Error('SIGKILL failed; child may still hold the session writer'),
              {
                code: 'dispose_failed',
              }
            );
          },
          getStderr() {
            return '';
          },
        } as unknown as PiRpcTransport;
      },
    });

    await registry.activate(key, 'Task: A', 'prompt');
    expect(factoryN).toBe(1);

    t1Listener?.({
      type: 'pi_rpc_transport_exit',
      intentional: false,
      code: null,
      signal: null,
      error: { message: 'Malformed RPC JSON', code: 'malformed_json' },
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));

    await expect(registry.activate(key, 'Task: B', 'prompt')).rejects.toThrow(
      /SIGKILL|dispose|fail/i
    );
    expect(factoryN).toBe(1);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('cross-registry session barrier: new registry waits for old dispose; fail-closed on dispose error', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ systemPrompt: '' });
    const order: string[] = [];
    let releaseOldDispose!: () => void;
    const oldDisposeGate = new Promise<void>((r) => {
      releaseOldDispose = r;
    });
    let hangGetState = false;
    let factoryNew = 0;

    // Shared session file across two registries (same run unit).
    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: { mode: 'single', agentScope: 'both', agent: 'explore', task: 'look' },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );

    const makeTransport = (label: string, opts: { hangState?: boolean; disposeGate?: boolean }) =>
      ({
        async getState() {
          if (opts.hangState) {
            hangGetState = true;
            await new Promise(() => undefined); // never resolves
          }
          return {
            sessionId: label,
            thinkingLevel: 'off',
            isStreaming: false,
            isCompacting: false,
            steeringMode: 'all',
            followUpMode: 'one-at-a-time',
            autoCompactionEnabled: true,
            messageCount: 0,
            pendingMessageCount: 0,
          };
        },
        async prompt() {},
        async steer() {},
        async followUp() {},
        async abort() {},
        subscribe() {
          return () => undefined;
        },
        async dispose() {
          order.push(`${label}-dispose-start`);
          if (opts.disposeGate) {
            await oldDisposeGate;
          }
          order.push(`${label}-dispose-done`);
        },
        getStderr() {
          return '';
        },
      }) as unknown as PiRpcTransport;

    const reg1 = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      shutdownDisposeBudgetMs: 80,
      transportFactory: async () => makeTransport('old', { hangState: true, disposeGate: true }),
    });
    reg1.setHostLinkAppender(() => undefined);

    const snap1 = await reg1.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-cross-1',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    // Factory returns before deadline but getState hangs — shutdown must still dispose.
    const hangAct = reg1.activate(snap1.key, 'Task: hang', 'prompt').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(hangGetState).toBe(true);

    await reg1.shutdown();
    await hangAct;
    expect(order).toContain('old-dispose-start');
    // Shutdown returned while dispose still gated (budget elapsed).

    // New registry attempts same session — factory must wait for old dispose.
    const reg2 = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        factoryNew += 1;
        order.push('new-factory');
        return makeTransport('new', {});
      },
    });
    reg2.setHostLinkAppender(() => undefined);

    // registerInitial hydrates only after the writer lease releases — start it while
    // dispose is still gated so we observe the barrier (do not await yet).
    const snap2Promise = reg2.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-cross-2',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });
    const act2Promise = snap2Promise.then((snap) =>
      reg2.activate(snap.key, 'Task: after', 'prompt')
    );
    await new Promise((r) => setTimeout(r, 40));
    // Hydrate + factory must both wait for the old dispose lease.
    expect(factoryNew).toBe(0);

    releaseOldDispose();
    await act2Promise;
    expect(factoryNew).toBe(1);
    expect(order.indexOf('new-factory')).toBeGreaterThan(order.indexOf('old-dispose-done'));

    await reg2.shutdown();

    // Fail-closed path: dispose rejects sticky so a third registry cannot spawn.
    let factoryFail = 0;
    const regFail = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () =>
        ({
          async getState() {
            return {
              sessionId: 'fail',
              thinkingLevel: 'off',
              isStreaming: false,
              isCompacting: false,
              steeringMode: 'all',
              followUpMode: 'one-at-a-time',
              autoCompactionEnabled: true,
              messageCount: 0,
              pendingMessageCount: 0,
            };
          },
          async prompt() {},
          async steer() {},
          async followUp() {},
          async abort() {},
          subscribe() {
            return () => undefined;
          },
          async dispose() {
            throw Object.assign(new Error('SIGKILL failed'), { code: 'dispose_failed' });
          },
          getStderr() {
            return '';
          },
        }) as unknown as PiRpcTransport,
    });
    regFail.setHostLinkAppender(() => undefined);
    // Use a different unit to avoid binding conflicts — same sessionFile path is what matters.
    const sessionFile2 = path.join(store.getRunDir(runId), 'sessions', 'planned-fail.jsonl');
    fs.writeFileSync(
      sessionFile2,
      '{"type":"session","version":3,"id":"test-session-2","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );
    const { runId: runId2, record: record2 } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: { mode: 'single', agentScope: 'both', agent: 'explore', task: 'look2' },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    await store.updateRun(runId2, (r) => {
      r.units.single.sessionFile = sessionFile2;
      r.status = 'running';
    });
    const live2 = store.getRun(runId2);
    if (live2.ok) coordinator.registerRun(runId2, live2.loaded.record);

    const snapFail = await regFail.registerInitial({
      runId: runId2,
      unitId: 'single',
      hostSessionId: 'host-fail',
      launchSpec: {
        agent,
        request: record2.request,
        sessionFile: sessionFile2,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });
    await regFail.activate(snapFail.key, 'Task: x', 'prompt');
    await regFail.detach(snapFail.key);
    await new Promise((r) => setImmediate(r));

    const regAfterFail = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        factoryFail += 1;
        return {
          async getState() {
            return {
              sessionId: 'after',
              thinkingLevel: 'off',
              isStreaming: false,
              isCompacting: false,
              steeringMode: 'all',
              followUpMode: 'one-at-a-time',
              autoCompactionEnabled: true,
              messageCount: 0,
              pendingMessageCount: 0,
            };
          },
          async prompt() {},
          async steer() {},
          async followUp() {},
          async abort() {},
          subscribe() {
            return () => undefined;
          },
          async dispose() {},
          getStderr() {
            return '';
          },
        } as unknown as PiRpcTransport;
      },
    });
    regAfterFail.setHostLinkAppender(() => undefined);
    // Same sessionFile as failed dispose — sticky barrier rejects.
    // Detach left endpoint on regFail; regAfterFail is a new registry with empty endpoints.
    // Re-register same run would conflict with regFail if still alive — shutdown regFail first
    // but session barrier remains sticky.
    await regFail.shutdown();
    // Sticky dispose failure fail-closes hydrate and spawn (registerInitial waits on lease).
    await expect(
      regAfterFail.registerInitial({
        runId: runId2,
        unitId: 'single',
        hostSessionId: 'host-after-fail',
        launchSpec: {
          agent,
          request: record2.request,
          sessionFile: sessionFile2,
          effectiveCwd: root,
          agentScope: 'both',
          registrationKind: 'initial',
        },
        getBranchEntries: () => [],
      })
    ).rejects.toThrow(/SIGKILL|dispose|fail/i);
    expect(factoryFail).toBe(0);

    await regAfterFail.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('idle preflight waits for real agent_settled; late A settle does not close B', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const modes: string[] = [];
    let eventListener: ((e: unknown) => void) | undefined;
    let isStreaming = true;
    let getStateCalls = 0;

    const transport = {
      async getState() {
        getStateCalls += 1;
        return {
          sessionId: 's',
          thinkingLevel: 'off',
          isStreaming,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'one-at-a-time',
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        };
      },
      async prompt() {
        modes.push('prompt');
      },
      async steer() {
        modes.push('steer');
      },
      async followUp() {
        modes.push('follow_up');
      },
      async abort() {},
      subscribe(fn: (e: unknown) => void) {
        eventListener = fn;
        return () => {
          eventListener = undefined;
        };
      },
      async dispose() {},
      getStderr() {
        return '';
      },
    } as unknown as PiRpcTransport;

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => transport,
      idleSettleWaitMs: 2000,
    });
    registry.setHostLinkAppender(() => undefined);

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: { mode: 'single', agentScope: 'both', agent: 'explore', task: 'look' },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );
    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-idle-real',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    const settled: string[] = [];
    registry.subscribe((e) => {
      if (e.type === 'activation_settled') settled.push(e.activationId);
    });

    const actA = await registry.activate(snap.key, 'Task: A', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    eventListener?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));

    // Response path finishes (idle) before agent_settled arrives.
    isStreaming = false;
    eventListener?.({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'A done' }] },
    });
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    // Deliberately withhold agent_settled so send must wait (not force-settle).

    const actBPromise = registry.activate(snap.key, 'Task: B', 'steer', undefined, 'view');
    await new Promise((r) => setTimeout(r, 30));
    expect(getStateCalls).toBeGreaterThanOrEqual(1);
    // B still pending; A not settled; no prompt for B yet.
    expect(settled).not.toContain(actA.activationId);
    expect(modes.filter((m) => m === 'prompt')).toHaveLength(1); // only A

    // Inject real agent_settled — A settles then B prompts.
    eventListener?.({ type: 'agent_settled' });
    const actB = await actBPromise;
    await new Promise((r) => setImmediate(r));

    expect(settled[0]).toBe(actA.activationId);
    expect(actB.activationId).not.toBe(actA.activationId);
    expect(modes.filter((m) => m === 'prompt').length).toBeGreaterThanOrEqual(2);
    expect(modes.filter((m) => m === 'steer')).toHaveLength(0);

    // Late/duplicate A settle must not close B.
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    expect(registry.get(snap.key)?.activation?.id).toBe(actB.activationId);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('shutdown live+handshake transports share one absolute budget and start dispose concurrently', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ systemPrompt: '' });
    const disposeStarts: number[] = [];
    const budgetMs = 120;

    const makeStubborn = (delayMs: number) =>
      ({
        async getState() {
          return {
            sessionId: 's',
            thinkingLevel: 'off',
            isStreaming: false,
            isCompacting: false,
            steeringMode: 'all',
            followUpMode: 'one-at-a-time',
            autoCompactionEnabled: true,
            messageCount: 0,
            pendingMessageCount: 0,
          };
        },
        async prompt() {},
        async steer() {},
        async followUp() {},
        async abort() {},
        subscribe() {
          return () => undefined;
        },
        async dispose() {
          disposeStarts.push(Date.now());
          await new Promise((r) => setTimeout(r, delayMs));
        },
        getStderr() {
          return '';
        },
      }) as unknown as PiRpcTransport;

    let factoryN = 0;
    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      shutdownDisposeBudgetMs: budgetMs,
      transportFactory: async () => {
        factoryN += 1;
        // Second endpoint hangs in handshake so shutdown sees live + ready.
        if (factoryN === 2) {
          await new Promise((r) => setTimeout(r, 10_000));
        }
        return makeStubborn(80);
      },
    });
    registry.setHostLinkAppender(() => undefined);

    const keys: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { runId, record } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'explore', task: `t${i}` },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'explore',
            agentFingerprint: agentFingerprint(agent),
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
          },
        },
      });
      const sessionFile = path.join(store.getRunDir(runId), 'sessions', `planned-${i}.jsonl`);
      await store.updateRun(runId, (r) => {
        r.units.single.sessionFile = sessionFile;
        r.status = 'running';
      });
      const live = store.getRun(runId);
      if (live.ok) coordinator.registerRun(runId, live.loaded.record);
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(
        sessionFile,
        '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
      );
      const snap = await registry.registerInitial({
        runId,
        unitId: 'single',
        hostSessionId: `host-shut-mix-${i}`,
        launchSpec: {
          agent,
          request: record.request,
          sessionFile,
          effectiveCwd: root,
          agentScope: 'both',
          registrationKind: 'initial',
        },
        getBranchEntries: () => [],
      });
      keys.push(snap.key);
    }

    // Live transport on key0; handshake in-flight on key1.
    await registry.activate(keys[0]!, 'Task: live', 'prompt');
    const handshakeP = registry
      .activate(keys[1]!, 'Task: handshake', 'prompt')
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));

    const t0 = Date.now();
    await registry.shutdown();
    const elapsed = Date.now() - t0;
    await handshakeP;

    // Shared absolute budget: well under two serial races (2×5500) and under ~2×budget.
    expect(elapsed).toBeLessThan(budgetMs + 150);
    // At least the live client dispose started; handshake may or may not have spawned.
    expect(disposeStarts.length).toBeGreaterThanOrEqual(1);
    if (disposeStarts.length >= 2) {
      const spread = Math.max(...disposeStarts) - Math.min(...disposeStarts);
      expect(spread).toBeLessThan(50);
    }

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('InteractiveAgentRegistry session lease pre-acquire, canonical key, hydrate barrier', () => {
  it('T1 factory hang across shutdown deadline: new registry waits; T2 factory only after T1 close', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ systemPrompt: '' });
    const order: string[] = [];
    let factoryN = 0;
    let releaseT1Factory!: (transport: PiRpcTransport) => void;
    const t1FactoryGate = new Promise<PiRpcTransport>((r) => {
      releaseT1Factory = r;
    });
    let releaseT1Dispose!: () => void;
    const t1DisposeGate = new Promise<void>((r) => {
      releaseT1Dispose = r;
    });

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: { mode: 'single', agentScope: 'both', agent: 'explore', task: 'look' },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'planned.jsonl');
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );

    const makeIdleTransport = (label: string, opts: { disposeGate?: boolean } = {}) =>
      ({
        async getState() {
          return {
            sessionId: label,
            thinkingLevel: 'off',
            isStreaming: false,
            isCompacting: false,
            steeringMode: 'all',
            followUpMode: 'one-at-a-time',
            autoCompactionEnabled: true,
            messageCount: 0,
            pendingMessageCount: 0,
          };
        },
        async prompt() {},
        async steer() {},
        async followUp() {},
        async abort() {},
        subscribe() {
          return () => undefined;
        },
        async dispose() {
          order.push(`${label}-dispose-start`);
          if (opts.disposeGate) await t1DisposeGate;
          order.push(`${label}-dispose-done`);
        },
        getStderr() {
          return '';
        },
      }) as unknown as PiRpcTransport;

    const reg1 = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      shutdownDisposeBudgetMs: 60,
      transportFactory: async () => {
        factoryN += 1;
        order.push(`factory-${factoryN}`);
        if (factoryN === 1) {
          // Hang past shutdown deadline — lease must already be held.
          return t1FactoryGate;
        }
        return makeIdleTransport(`t${factoryN}`);
      },
    });
    reg1.setHostLinkAppender(() => undefined);

    const snap1 = await reg1.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-lease-hang',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    const hangAct = reg1.activate(snap1.key, 'Task: hang', 'prompt').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(factoryN).toBe(1);
    expect(order).toContain('factory-1');

    await reg1.shutdown();
    // Shutdown returned while factory still hung; lease must remain held.
    expect(factoryN).toBe(1);

    let factoryNew = 0;
    const reg2 = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        factoryNew += 1;
        order.push('factory-new');
        return makeIdleTransport('new');
      },
    });
    reg2.setHostLinkAppender(() => undefined);

    // registerInitial + activate both wait on the pre-acquired T1 lease (do not await yet).
    const act2Promise = reg2
      .registerInitial({
        runId,
        unitId: 'single',
        hostSessionId: 'host-lease-hang-2',
        launchSpec: {
          agent,
          request: record.request,
          sessionFile,
          effectiveCwd: root,
          agentScope: 'both',
          registrationKind: 'initial',
        },
        getBranchEntries: () => [],
      })
      .then((snap) => reg2.activate(snap.key, 'Task: after', 'prompt'));
    await new Promise((r) => setTimeout(r, 40));
    // New registry must not call factory while T1 factory is still hung (lease held).
    expect(factoryNew).toBe(0);

    // T1 factory finally returns; generation is stale → dispose then release lease.
    releaseT1Factory(makeIdleTransport('t1-late', { disposeGate: true }));
    await hangAct;
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toContain('t1-late-dispose-start');
    // Still blocked on T1 dispose.
    expect(factoryNew).toBe(0);

    releaseT1Dispose();
    await act2Promise;
    expect(factoryNew).toBe(1);
    expect(order.indexOf('factory-new')).toBeGreaterThan(order.indexOf('t1-late-dispose-done'));

    await reg2.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('symlink alias and realpath hit the same session lease (T2 waits for T1 dispose)', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ systemPrompt: '' });
    const order: string[] = [];
    let releaseT1Dispose!: () => void;
    const t1DisposeGate = new Promise<void>((r) => {
      releaseT1Dispose = r;
    });
    let factoryNew = 0;

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: { mode: 'single', agentScope: 'both', agent: 'explore', task: 'look' },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sessionsDir = path.join(store.getRunDir(runId), 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const realSessionFile = path.join(sessionsDir, 'planned.jsonl');
    fs.writeFileSync(
      realSessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );

    // Alias via symlink directory: .../alias-sessions -> sessions
    const aliasDir = path.join(store.getRunDir(runId), 'alias-sessions');
    try {
      fs.symlinkSync(sessionsDir, aliasDir, 'dir');
    } catch {
      // Environments without symlink support skip this coverage.
      fs.rmSync(root, { recursive: true, force: true });
      return;
    }
    const aliasSessionFile = path.join(aliasDir, 'planned.jsonl');
    expect(canonicalizeSessionLeaseKey(aliasSessionFile)).toBe(
      canonicalizeSessionLeaseKey(realSessionFile)
    );

    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = realSessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);

    const makeTransport = (label: string, disposeGate: boolean) =>
      ({
        async getState() {
          return {
            sessionId: label,
            thinkingLevel: 'off',
            isStreaming: false,
            isCompacting: false,
            steeringMode: 'all',
            followUpMode: 'one-at-a-time',
            autoCompactionEnabled: true,
            messageCount: 0,
            pendingMessageCount: 0,
          };
        },
        async prompt() {},
        async steer() {},
        async followUp() {},
        async abort() {},
        subscribe() {
          return () => undefined;
        },
        async dispose() {
          order.push(`${label}-dispose-start`);
          if (disposeGate) await t1DisposeGate;
          order.push(`${label}-dispose-done`);
        },
        getStderr() {
          return '';
        },
      }) as unknown as PiRpcTransport;

    // Old registry registers/activates via symlink alias path.
    const reg1 = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      // Short budget so shutdown returns while dispose is still gated.
      shutdownDisposeBudgetMs: 80,
      transportFactory: async () => makeTransport('old', true),
    });
    reg1.setHostLinkAppender(() => undefined);

    const snap1 = await reg1.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-symlink-1',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile: aliasSessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });
    await reg1.activate(snap1.key, 'Task: old', 'prompt');
    await reg1.shutdown();
    expect(order).toContain('old-dispose-start');

    // New registry uses realpath for the same session file.
    const reg2 = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        factoryNew += 1;
        order.push('new-factory');
        return makeTransport('new', false);
      },
    });
    reg2.setHostLinkAppender(() => undefined);

    // Alias lease from reg1 must block realpath register/activate until dispose completes.
    const act2Promise = reg2
      .registerInitial({
        runId,
        unitId: 'single',
        hostSessionId: 'host-symlink-2',
        launchSpec: {
          agent,
          request: record.request,
          sessionFile: realSessionFile,
          effectiveCwd: root,
          agentScope: 'both',
          registrationKind: 'initial',
        },
        getBranchEntries: () => [],
      })
      .then((snap) => reg2.activate(snap.key, 'Task: new', 'prompt'));
    await new Promise((r) => setTimeout(r, 40));
    expect(factoryNew).toBe(0);

    releaseT1Dispose();
    await act2Promise;
    expect(factoryNew).toBe(1);
    expect(order.indexOf('new-factory')).toBeGreaterThan(order.indexOf('old-dispose-done'));

    await reg2.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('hydrate waits for writer lease; reads final content only after release', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ systemPrompt: '' });

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: { mode: 'single', agentScope: 'both', agent: 'explore', task: 'look' },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sessionsDir = path.join(store.getRunDir(runId), 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, 'hydrate-barrier.jsonl');
    const header = {
      type: 'session',
      version: 3,
      id: 'sess-barrier',
      timestamp: new Date().toISOString(),
      cwd: root,
    };
    // Initial partial content written by "old writer".
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify({
        type: 'message',
        id: 'm-partial',
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'partial-before-release' }],
          timestamp: Date.now(),
        },
      })}\n`
    );
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);

    // Hold a process-scoped lease as if an old writer is still disposing.
    const lease = await acquireSessionLease(sessionFile);
    let hydrateSaw: string | undefined;
    let registerDone = false;

    const reg = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        throw new Error('no spawn');
      },
    });
    reg.setHostLinkAppender(() => undefined);

    const registerPromise = reg
      .registerInitial({
        runId,
        unitId: 'single',
        hostSessionId: 'host-hydrate-barrier',
        launchSpec: {
          agent,
          request: record.request,
          sessionFile,
          effectiveCwd: root,
          agentScope: 'both',
          registrationKind: 'initial',
        },
        getBranchEntries: () => [],
      })
      .then((snap) => {
        registerDone = true;
        hydrateSaw = JSON.stringify(snap.messages);
        return snap;
      });

    // While blocked on the lease, registerInitial must not complete hydrate.
    await new Promise((r) => setTimeout(r, 40));
    expect(registerDone).toBe(false);

    // Old writer mutates session to final content during the barrier wait.
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify({
        type: 'message',
        id: 'm-final',
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'final-after-release' }],
          timestamp: Date.now(),
        },
      })}\n`
    );

    lease.release();
    const snap = await registerPromise;
    expect(registerDone).toBe(true);
    expect(hydrateSaw).toContain('final-after-release');
    expect(hydrateSaw).not.toContain('partial-before-release');
    expect(JSON.stringify(snap.messages)).toContain('final-after-release');

    await reg.shutdown();
    // Ensure no sticky lease remains for other tests.
    await awaitSessionLease(sessionFile).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('get stays memory-only while ensureTranscript waits on writer lease then shows final history', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ systemPrompt: '' });

    const { runId } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: { mode: 'single', agentScope: 'both', agent: 'explore', task: 'look' },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sessionsDir = path.join(store.getRunDir(runId), 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = path.join(sessionsDir, 'detail-barrier.jsonl');
    const header = {
      type: 'session',
      version: 3,
      id: 'sess-detail-barrier',
      timestamp: new Date().toISOString(),
      cwd: root,
    };
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify({
        type: 'message',
        id: 'm-partial',
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'partial-live-dispose' }],
          timestamp: Date.now(),
        },
      })}\n`
    );
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);

    // Simulate live endpoint applyUnavailable → dispose holding the writer lease.
    const lease = await acquireSessionLease(sessionFile);

    const reg = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        throw new Error('no spawn');
      },
    });
    reg.setHostLinkAppender(() => undefined);

    // Metadata restore without hydrate (like session_tree after unavailable settle).
    await store.updateRun(runId, (r) => {
      const unit = r.units.single;
      if (!unit.interactiveBindings) unit.interactiveBindings = {};
      unit.interactiveBindings['bind-detail'] = {
        bindingId: 'bind-detail',
        hostSessionId: 'host-detail-barrier',
        createdAt: 1,
      };
    });
    const restored = reg.restoreActiveBranch({
      cwd: root,
      sessionManager: {
        getSessionId: () => 'host-detail-barrier',
        getBranch: () => [
          {
            type: 'custom',
            customType: INTERACTIVE_LINK_TYPE,
            data: {
              version: 1,
              runId,
              unitId: 'single',
              bindingId: 'bind-detail',
              hostSessionId: 'host-detail-barrier',
              createdAt: 1,
            },
          },
        ],
      } as never,
    });
    expect(restored).toHaveLength(1);
    const key = restored[0]!.key;

    // Immediate open detail/get: pure memory, empty, no disk read of partial.
    const mem = reg.get(key);
    expect(mem?.messages.length).toBe(0);
    expect(
      (
        reg as unknown as {
          _endpoints: Map<string, { transcriptHydrated: boolean }>;
        }
      )._endpoints.get(key)?.transcriptHydrated
    ).toBe(false);

    let ensureDone = false;
    let ensureSaw: string | undefined;
    const ensurePromise = reg.ensureTranscript(key).then((snap) => {
      ensureDone = true;
      ensureSaw = JSON.stringify(snap?.messages ?? []);
      return snap;
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(ensureDone).toBe(false);

    // Writer finishes dispose: final history lands on disk, then release.
    fs.writeFileSync(
      sessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify({
        type: 'message',
        id: 'm-final',
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'final-after-dispose' }],
          timestamp: Date.now(),
        },
      })}\n`
    );
    lease.release();
    const hydrated = await ensurePromise;
    expect(ensureDone).toBe(true);
    expect(ensureSaw).toContain('final-after-dispose');
    expect(ensureSaw).not.toContain('partial-live-dispose');
    expect(JSON.stringify(hydrated?.messages)).toContain('final-after-dispose');
    // get now reflects hydrated in-memory state.
    expect(JSON.stringify(reg.get(key)?.messages)).toContain('final-after-dispose');

    await reg.shutdown();
    await awaitSessionLease(sessionFile).catch(() => undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('session lease store is shared across fresh module instances (globalThis Symbol.for)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lease-reload-'));
    const sessionFile = path.join(root, 'shared-lease.jsonl');
    fs.writeFileSync(sessionFile, '{"type":"session","version":3,"id":"x"}\n');

    // Cache-busting imports simulate Jiti moduleCache:false (new module instances).
    const base = new URL('../src/interactive-agent.ts', import.meta.url).href;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const modA = await import(`${base}?lease-reload=${stamp}-a`);
    const modB = await import(`${base}?lease-reload=${stamp}-b`);

    expect(modA.getSessionLeaseGlobalKeyForTest()).toBe(getSessionLeaseGlobalKeyForTest());
    expect(modB.getSessionLeaseGlobalKeyForTest()).toBe(getSessionLeaseGlobalKeyForTest());
    expect(modA.getSessionLeaseGlobalKeyForTest()).toBe(modB.getSessionLeaseGlobalKeyForTest());

    const lease = await modA.acquireSessionLease(sessionFile);
    let secondAcquired = false;
    const second = modB.acquireSessionLease(sessionFile).then((h: { release: () => void }) => {
      secondAcquired = true;
      return h;
    });
    await new Promise((r) => setTimeout(r, 30));
    // Old lease not released: new module instance factory/acquire must not start.
    expect(secondAcquired).toBe(false);

    lease.release();
    const h2 = await second;
    expect(secondAcquired).toBe(true);
    h2.release();

    // Both modules see the same empty store after release.
    expect(modA.getSessionLeaseStoreSizesForTest().leases).toBe(
      modB.getSessionLeaseStoreSizesForTest().leases
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('acquire tails drop after success; store size falls after many acquire/release cycles', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lease-tails-'));
    const sizesBefore = getSessionLeaseStoreSizesForTest();

    const paths: string[] = [];
    for (let i = 0; i < 40; i++) {
      const p = path.join(root, `s-${i}.jsonl`);
      fs.writeFileSync(p, '{"type":"session","version":3,"id":"x"}\n');
      paths.push(p);
      const lease = await acquireSessionLease(p);
      lease.release();
    }

    const sizesAfter = getSessionLeaseStoreSizesForTest();
    // No residual acquire tails for completed cycles.
    expect(sizesAfter.acquireTails).toBe(sizesBefore.acquireTails);
    // Successful releases leave no leases either.
    expect(sizesAfter.leases).toBe(sizesBefore.leases);

    // Sticky fail retains lease but not a dangling acquire tail.
    const stickyPath = path.join(root, 'sticky.jsonl');
    fs.writeFileSync(stickyPath, '{"type":"session","version":3,"id":"s"}\n');
    const sticky = await acquireSessionLease(stickyPath);
    sticky.release(new Error('dispose failed'));
    const afterSticky = getSessionLeaseStoreSizesForTest();
    expect(afterSticky.leases).toBe(sizesBefore.leases + 1);
    expect(afterSticky.acquireTails).toBe(sizesBefore.acquireTails);

    // Clean sticky for other tests: wait rejects, key stays — do not leave pollution
    // that blocks the same path. Use a unique path only in this temp dir (rm at end).
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('dangling symlink alias canonical key matches target once created; lease hits across registries', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ systemPrompt: '' });
    let factoryNew = 0;

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: { mode: 'single', agentScope: 'both', agent: 'explore', task: 'look' },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });
    const sessionsDir = path.join(store.getRunDir(runId), 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const realSessionFile = path.join(sessionsDir, 'planned-later.jsonl');
    const aliasSessionFile = path.join(sessionsDir, 'alias-planned.jsonl');

    // Dangling file symlink: alias → target that does not exist yet.
    try {
      fs.symlinkSync(realSessionFile, aliasSessionFile);
    } catch {
      fs.rmSync(root, { recursive: true, force: true });
      return;
    }

    // Keys must agree before the target exists (nearest parent + remaining).
    const keyWhileDangling = canonicalizeSessionLeaseKey(aliasSessionFile);
    expect(keyWhileDangling).toBe(canonicalizeSessionLeaseKey(realSessionFile));
    expect(fs.existsSync(aliasSessionFile)).toBe(false);
    expect(fs.existsSync(realSessionFile)).toBe(false);

    // Hold lease via dangling alias path (simulates old writer still disposing).
    const lease = await acquireSessionLease(aliasSessionFile);
    expect(lease.key).toBe(keyWhileDangling);

    // Target appears later; keys stay stable and match realpath.
    fs.writeFileSync(
      realSessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );
    expect(canonicalizeSessionLeaseKey(aliasSessionFile)).toBe(
      canonicalizeSessionLeaseKey(realSessionFile)
    );
    expect(canonicalizeSessionLeaseKey(aliasSessionFile)).toBe(fs.realpathSync(realSessionFile));
    expect(canonicalizeSessionLeaseKey(aliasSessionFile)).toBe(keyWhileDangling);

    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = realSessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);

    const reg = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        factoryNew += 1;
        return {
          async getState() {
            return {
              sessionId: 'new',
              thinkingLevel: 'off',
              isStreaming: false,
              isCompacting: false,
              steeringMode: 'all',
              followUpMode: 'one-at-a-time',
              autoCompactionEnabled: true,
              messageCount: 0,
              pendingMessageCount: 0,
            };
          },
          async prompt() {},
          async steer() {},
          async followUp() {},
          async abort() {},
          subscribe() {
            return () => undefined;
          },
          async dispose() {},
          getStderr() {
            return '';
          },
        } as unknown as PiRpcTransport;
      },
    });
    reg.setHostLinkAppender(() => undefined);

    // New registry uses realpath of the now-existing target — blocked by dangling-alias lease.
    const actPromise = reg
      .registerInitial({
        runId,
        unitId: 'single',
        hostSessionId: 'host-dangling-2',
        launchSpec: {
          agent,
          request: record.request,
          sessionFile: realSessionFile,
          effectiveCwd: root,
          agentScope: 'both',
          registrationKind: 'initial',
        },
        getBranchEntries: () => [],
      })
      .then((snap) => reg.activate(snap.key, 'Task: new', 'prompt'));
    await new Promise((r) => setTimeout(r, 40));
    expect(factoryNew).toBe(0);

    lease.release();
    await actPromise;
    expect(factoryNew).toBe(1);

    await reg.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
