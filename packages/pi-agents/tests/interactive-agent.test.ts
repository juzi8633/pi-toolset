// ABOUTME: Tests for interactive agent registry: bindings, trust, messaging, recovery.
// ABOUTME: Uses temporary run stores and fake transports; no real Pi child processes.

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES,
  INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES,
} from '../src/constants.ts';
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
    // List/widget interrupted glyph depends on durable stopReason after activation clears.
    const after = registry.get(snap.key);
    expect(after?.activation).toBeUndefined();
    expect(after?.usage?.stopReason).toBe('aborted');

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('existing Pi endpoint requires exact six-field link; empty/forged refuse and clear branch trust', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const links: InteractiveAgentLinkV1[] = [];
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
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 's.jsonl');
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );
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
    });
    registry.setHostLinkAppender((link) => {
      links.push(link);
    });

    const first = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-a',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () =>
        links.map((data) => ({ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data })),
    });
    expect(links).toHaveLength(1);
    expect(registry.isOnActiveBranch(first.key)).toBe(true);

    // Same host, empty branch: fail closed (never trust local desiredLink).
    await expect(
      registry.registerInitial({
        runId,
        unitId: 'single',
        hostSessionId: 'host-a',
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
    ).rejects.toThrow(/exact six-field|exact branch link/i);
    expect(registry.isOnActiveBranch(first.key)).toBe(false);

    // Re-grant with exact branch link present.
    const again = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-a',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile,
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () =>
        links.map((data) => ({ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data })),
    });
    expect(again.bindingId).toBe(first.bindingId);
    expect(registry.isOnActiveBranch(first.key)).toBe(true);

    // Second host without exact link: refuse (trust for original host remains).
    await expect(
      registry.registerInitial({
        runId,
        unitId: 'single',
        hostSessionId: 'host-b',
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
    ).rejects.toThrow(/hostSessionId|exact branch link/i);
    expect(registry.isOnActiveBranch(first.key)).toBe(true);

    // Forged-only branch: refuse and clear trust (no append-and-trust).
    await expect(
      registry.registerInitial({
        runId,
        unitId: 'single',
        hostSessionId: 'host-a',
        launchSpec: {
          agent,
          request: record.request,
          sessionFile,
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
              bindingId: 'forged-binding',
              hostSessionId: 'host-a',
              createdAt: first.linkCreatedAt,
            },
          },
        ],
      })
    ).rejects.toThrow(/exact six-field|exact branch link/i);
    expect(registry.isOnActiveBranch(first.key)).toBe(false);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('existing Grok ACP endpoint requires exact six-field link; empty/forged refuse trust', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ name: 'gagent', runtime: 'grok-acp' as never, model: 'grok' });
    const links: InteractiveAgentLinkV1[] = [];
    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'gagent',
        task: 't',
        runtime: 'grok-acp',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'gagent',
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'running',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
          acpSessionId: 'sess-exact-1',
        },
      },
    });
    const live0 = store.getRun(runId);
    if (live0.ok) coordinator.registerRun(runId, live0.loaded.record);

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
    });
    registry.setHostLinkAppender((link) => {
      links.push(link);
    });

    const first = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-g',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile: '',
        sessionArtifact: { runtime: 'grok-acp', sessionId: 'sess-exact-1' },
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () =>
        links.map((data) => ({ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data })),
    });
    expect(registry.isOnActiveBranch(first.key)).toBe(true);

    await expect(
      registry.registerInitial({
        runId,
        unitId: 'single',
        hostSessionId: 'host-g',
        launchSpec: {
          agent,
          request: record.request,
          sessionFile: '',
          sessionArtifact: { runtime: 'grok-acp', sessionId: 'sess-exact-1' },
          effectiveCwd: root,
          agentScope: 'both',
          registrationKind: 'initial',
        },
        getBranchEntries: () => [],
      })
    ).rejects.toThrow(/exact six-field|exact branch link/i);
    expect(registry.isOnActiveBranch(first.key)).toBe(false);

    // Exact link re-grants.
    const again = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-g',
      launchSpec: {
        agent,
        request: record.request,
        sessionFile: '',
        sessionArtifact: { runtime: 'grok-acp', sessionId: 'sess-exact-1' },
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () =>
        links.map((data) => ({ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data })),
    });
    expect(again.bindingId).toBe(first.bindingId);
    expect(registry.isOnActiveBranch(first.key)).toBe(true);

    await expect(
      registry.registerInitial({
        runId,
        unitId: 'single',
        hostSessionId: 'host-g',
        launchSpec: {
          agent,
          request: record.request,
          sessionFile: '',
          sessionArtifact: { runtime: 'grok-acp', sessionId: 'sess-exact-1' },
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
              bindingId: 'forged-g',
              hostSessionId: 'host-g',
              createdAt: first.linkCreatedAt,
            },
          },
        ],
      })
    ).rejects.toThrow(/exact six-field|exact branch link/i);
    expect(registry.isOnActiveBranch(first.key)).toBe(false);

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

  it('pre-frozen raw messages are reprojected; oversized non-authoritative payloads are bounded', async () => {
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

    await registry.activate(key, 'Task: bound', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));

    const hugeThinking = 'T'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 4096);
    const hugeArgsBlob = 'A'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 2048);
    const hugeImage = 'B'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 1024);
    const hugeToolBody = 'R'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 8192);
    const hugeCustom = 'C'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 512);
    const completeAssistantText = 'COMPLETE_FINAL_OUTPUT_PRESERVED';

    // Externally frozen raw native messages must not establish projection ownership.
    const frozenAssistant = Object.freeze({
      role: 'assistant',
      content: Object.freeze([
        Object.freeze({ type: 'thinking', thinking: hugeThinking }),
        Object.freeze({
          type: 'toolCall',
          id: 'tc-1',
          name: 'bash',
          arguments: Object.freeze({ blob: hugeArgsBlob }),
        }),
        Object.freeze({ type: 'image', data: hugeImage, mimeType: 'image/png' }),
        Object.freeze({
          type: 'unknownCustom',
          payload: Object.freeze({ data: hugeCustom }),
          note: hugeCustom,
        }),
        Object.freeze({ type: 'text', text: completeAssistantText }),
      ]),
      usage: Object.freeze({
        input: 11,
        output: 7,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 18,
        cost: Object.freeze({ total: 0.01 }),
      }),
      model: 'test-model',
      stopReason: 'stop',
    });

    const frozenToolResult = Object.freeze({
      role: 'toolResult',
      toolCallId: 'tc-1',
      toolName: 'bash',
      content: Object.freeze([
        Object.freeze({ type: 'text', text: hugeToolBody }),
        Object.freeze({ type: 'image', data: hugeImage, mimeType: 'image/png' }),
      ]),
      details: Object.freeze({ dump: hugeToolBody }),
      isError: false,
    });

    eventListenerRef.current?.({ type: 'message_end', message: frozenAssistant });
    eventListenerRef.current?.({ type: 'message_end', message: frozenToolResult });
    await new Promise((r) => setImmediate(r));

    const snap = registry.get(key)!;
    expect(snap.messages.length).toBe(2);
    // Must not share the externally frozen raw object.
    expect(snap.messages[0]).not.toBe(frozenAssistant);
    expect(snap.messages[1]).not.toBe(frozenToolResult);

    const assistant = snap.messages[0] as unknown as {
      content: Array<Record<string, unknown>>;
      usage?: { input?: number; output?: number };
      model?: string;
      stopReason?: string;
    };
    const thinking = assistant.content.find((p) => p.type === 'thinking') as {
      thinking: string;
    };
    expect(thinking.thinking).toContain('bytes omitted');
    expect(Buffer.byteLength(thinking.thinking, 'utf8')).toBeLessThanOrEqual(
      INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
    );

    const toolCall = assistant.content.find((p) => p.type === 'toolCall') as {
      arguments: Record<string, unknown>;
    };
    expect(toolCall.arguments._omitted).toBe(true);
    expect(JSON.stringify(toolCall.arguments)).not.toContain(hugeArgsBlob);

    const image = assistant.content.find((p) => p.type === 'image') as { data: string };
    expect(image.data).toContain('bytes omitted');
    expect(Buffer.byteLength(image.data, 'utf8')).toBeLessThanOrEqual(
      INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
    );

    const unknown = assistant.content.find((p) => p.type === 'unknownCustom') as {
      note: string;
      payload: Record<string, unknown>;
    };
    expect(unknown.note).toContain('bytes omitted');
    expect(unknown.payload._omitted).toBe(true);

    const text = assistant.content.find((p) => p.type === 'text') as { text: string };
    expect(text.text).toBe(completeAssistantText);
    expect(assistant.usage?.input).toBe(11);
    expect(assistant.usage?.output).toBe(7);
    expect(assistant.model).toBe('test-model');
    expect(assistant.stopReason).toBe('stop');

    const toolResult = snap.messages[1] as unknown as {
      content: Array<Record<string, unknown>>;
      details: Record<string, unknown>;
    };
    const toolText = toolResult.content.find((p) => p.type === 'text') as { text: string };
    expect(toolText.text).toContain('bytes omitted');
    expect(Buffer.byteLength(toolText.text, 'utf8')).toBeLessThanOrEqual(
      INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
    );
    expect(toolResult.details._omitted).toBe(true);
    // Full raw payloads must not be retained; only bounded prefixes/markers remain.
    expect(JSON.stringify(snap.messages)).not.toContain(hugeThinking);
    expect(JSON.stringify(snap.messages)).not.toContain(hugeToolBody);
    expect(JSON.stringify(snap.messages)).not.toContain(hugeImage);
    expect(JSON.stringify(snap.messages)).not.toContain(hugeArgsBlob);
    expect(JSON.stringify(snap.messages)).not.toContain(hugeCustom);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('enforces complete multi-field non-authoritative item budget including top-level extras', async () => {
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

    await registry.activate(key, 'Task: multi-field', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));

    // Each field is under the per-field cap, but the complete item exceeds it.
    const nearLimit = Math.floor(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES * 0.6);
    const fieldA = 'A'.repeat(nearLimit);
    const fieldB = 'B'.repeat(nearLimit);
    const longName = 'N'.repeat(nearLimit);
    const topLevelExtra = 'X'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 2048);
    const completeText = 'AUTHORITATIVE_FINAL_TEXT';

    eventListenerRef.current?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'image',
            data: fieldA,
            base64: fieldB,
            mimeType: 'image/png',
            extraMeta: fieldA,
          },
          {
            type: 'toolCall',
            id: 'tc-multi',
            name: longName,
            arguments: { blob: fieldA },
            extraPayload: fieldB,
          },
          {
            type: 'customPart',
            alpha: fieldA,
            beta: fieldB,
          },
          { type: 'text', text: completeText },
        ],
        usage: { input: 9, output: 3, totalTokens: 12, cost: { total: 0 } },
        model: 'multi-model',
        stopReason: 'stop',
        // Unknown assistant top-level field — non-authoritative.
        customBlob: topLevelExtra,
        customObject: { dump: topLevelExtra },
      },
    });
    await new Promise((r) => setImmediate(r));

    const snap = registry.get(key)!;
    expect(snap.messages).toHaveLength(1);
    const assistant = snap.messages[0] as unknown as {
      content: Array<Record<string, unknown>>;
      usage?: { input?: number; output?: number };
      model?: string;
      stopReason?: string;
      customBlob?: string;
      customObject?: Record<string, unknown>;
    };

    // Authoritative fields preserved completely.
    const text = assistant.content.find((p) => p.type === 'text') as { text: string };
    expect(text.text).toBe(completeText);
    expect(assistant.usage?.input).toBe(9);
    expect(assistant.usage?.output).toBe(3);
    expect(assistant.model).toBe('multi-model');
    expect(assistant.stopReason).toBe('stop');

    // Every non-authoritative content item's complete serialized form fits the budget.
    for (const part of assistant.content) {
      if (part.type === 'text') continue;
      expect(Buffer.byteLength(JSON.stringify(part), 'utf8')).toBeLessThanOrEqual(
        INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
      );
    }

    // Multi-field items must not retain the combined near-limit raw payload volume.
    const image = assistant.content.find((p) => p.type === 'image' || p._omitted) as Record<
      string,
      unknown
    >;
    expect(image).toBeDefined();
    const imageJson = JSON.stringify(image);
    expect(Buffer.byteLength(imageJson, 'utf8')).toBeLessThanOrEqual(
      INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
    );
    // Cannot keep both full near-limit fields (would exceed the complete-item budget).
    expect(imageJson.includes(fieldA) && imageJson.includes(fieldB)).toBe(false);

    const toolCall = assistant.content.find(
      (p) => p.type === 'toolCall' || (p._omitted && p.id === 'tc-multi')
    ) as Record<string, unknown>;
    expect(toolCall).toBeDefined();
    const toolJson = JSON.stringify(toolCall);
    expect(Buffer.byteLength(toolJson, 'utf8')).toBeLessThanOrEqual(
      INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
    );
    // Long tool name + full near-limit args/extra cannot all survive.
    expect(
      toolJson.includes(longName) && toolJson.includes(fieldA) && toolJson.includes(fieldB)
    ).toBe(false);

    const custom = assistant.content.find(
      (p) => p.type === 'customPart' || (p._omitted && !p.id && p.type !== 'image')
    ) as Record<string, unknown>;
    expect(custom).toBeDefined();
    const customJson = JSON.stringify(custom);
    expect(Buffer.byteLength(customJson, 'utf8')).toBeLessThanOrEqual(
      INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
    );
    expect(customJson.includes(fieldA) && customJson.includes(fieldB)).toBe(false);

    // Top-level unknown fields are projected/bounded.
    if (typeof assistant.customBlob === 'string') {
      expect(Buffer.byteLength(assistant.customBlob, 'utf8')).toBeLessThanOrEqual(
        INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
      );
      expect(assistant.customBlob).not.toBe(topLevelExtra);
    } else {
      expect(assistant.customBlob).toBeUndefined();
    }
    if (assistant.customObject) {
      expect(Buffer.byteLength(JSON.stringify(assistant.customObject), 'utf8')).toBeLessThanOrEqual(
        INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
      );
    }
    expect(JSON.stringify(assistant)).not.toContain(topLevelExtra);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('bounds huge finalized-message identity fields on user/toolResult/custom without mutating source', async () => {
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

    await registry.activate(key, 'Task: identity-bound', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));

    const hugeId = 'I'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 4096);
    const hugeName = 'N'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 2048);
    const hugeTs = 'T'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 1024);
    const hugeCustomType = 'C'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 512);
    const hugeBody = 'B'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 256);

    const userSource = {
      role: 'user' as const,
      content: hugeBody,
      timestamp: hugeTs,
      customType: hugeCustomType,
    };
    const toolSource = {
      role: 'toolResult' as const,
      toolCallId: hugeId,
      toolName: hugeName,
      content: [{ type: 'text', text: 'tool-ok' }],
      isError: false,
      timestamp: hugeTs,
    };
    const customSource = {
      role: 'custom' as const,
      customType: hugeCustomType,
      content: [{ type: 'text', text: 'custom-ok' }],
      timestamp: hugeTs,
      toolCallId: hugeId,
      toolName: hugeName,
    };

    eventListenerRef.current?.({ type: 'message_end', message: userSource });
    eventListenerRef.current?.({ type: 'message_end', message: toolSource });
    eventListenerRef.current?.({ type: 'message_end', message: customSource });
    await new Promise((r) => setImmediate(r));

    const snap = registry.get(key)!;
    expect(snap.messages).toHaveLength(3);

    const assertBoundedIdentity = (msg: Record<string, unknown>, label: string) => {
      for (const key of ['toolCallId', 'toolName', 'timestamp', 'customType'] as const) {
        const val = msg[key];
        if (typeof val === 'string') {
          expect(Buffer.byteLength(val, 'utf8')).toBeLessThanOrEqual(
            INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
          );
          expect(val).not.toBe(hugeId);
          expect(val).not.toBe(hugeName);
          expect(val).not.toBe(hugeTs);
          expect(val).not.toBe(hugeCustomType);
        } else if (val !== undefined && val !== null && typeof val === 'object') {
          expect(Buffer.byteLength(JSON.stringify(val), 'utf8')).toBeLessThanOrEqual(
            INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
          );
        }
      }
      // Complete retained message stays within a few complete-item budgets (content + identity).
      expect(Buffer.byteLength(JSON.stringify(msg), 'utf8')).toBeLessThanOrEqual(
        INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES * 6
      );
      expect(JSON.stringify(msg)).not.toContain(hugeId);
      expect(JSON.stringify(msg)).not.toContain(hugeName);
      expect(JSON.stringify(msg)).not.toContain(hugeTs);
      expect(JSON.stringify(msg)).not.toContain(hugeCustomType);
      void label;
    };

    const userMsg = snap.messages[0] as unknown as Record<string, unknown>;
    const toolMsg = snap.messages[1] as unknown as Record<string, unknown>;
    const customMsg = snap.messages[2] as unknown as Record<string, unknown>;
    assertBoundedIdentity(userMsg, 'user');
    assertBoundedIdentity(toolMsg, 'toolResult');
    assertBoundedIdentity(customMsg, 'custom');

    // Source transport objects remain unbounded/unmutated.
    expect(userSource.timestamp).toBe(hugeTs);
    expect(userSource.customType).toBe(hugeCustomType);
    expect(userSource.content).toBe(hugeBody);
    expect(toolSource.toolCallId).toBe(hugeId);
    expect(toolSource.toolName).toBe(hugeName);
    expect(toolSource.timestamp).toBe(hugeTs);
    expect(customSource.customType).toBe(hugeCustomType);
    expect(customSource.toolCallId).toBe(hugeId);
    expect(customSource.toolName).toBe(hugeName);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('bounds oversized streaming messages and active tool args/results', async () => {
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

    await registry.activate(key, 'Task: stream-bound', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));

    const hugeThinking = 'S'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 2048);
    const hugeArgs = { blob: 'X'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 1024) };
    const hugeResult = { dump: 'Y'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 1024) };

    eventListenerRef.current?.({
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: hugeThinking },
          { type: 'text', text: 'partial-final' },
        ],
      },
    });
    eventListenerRef.current?.({
      type: 'tool_execution_start',
      toolCallId: 'tc-stream',
      toolName: 'bash',
      args: hugeArgs,
    });
    eventListenerRef.current?.({
      type: 'tool_execution_update',
      toolCallId: 'tc-stream',
      partialResult: hugeResult,
    });
    await new Promise((r) => setImmediate(r));

    const mid = registry.get(key)!;
    const streaming = mid.streamingMessage as unknown as {
      content: Array<Record<string, unknown>>;
    };
    expect(streaming).toBeDefined();
    const thinking = streaming.content.find((p) => p.type === 'thinking') as { thinking: string };
    expect(thinking.thinking).toContain('bytes omitted');
    expect(Buffer.byteLength(thinking.thinking, 'utf8')).toBeLessThanOrEqual(
      INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
    );
    const text = streaming.content.find((p) => p.type === 'text') as { text: string };
    expect(text.text).toBe('partial-final');

    expect(mid.activeTools).toHaveLength(1);
    expect(mid.activeTools[0]!.args._omitted).toBe(true);
    expect(JSON.stringify(mid.activeTools[0]!.args)).not.toContain(hugeArgs.blob);
    expect((mid.activeTools[0]!.partialResult as { _omitted?: boolean })._omitted).toBe(true);
    expect(JSON.stringify(mid.activeTools[0]!.partialResult)).not.toContain(
      hugeResult.dump as string
    );
    // Source objects remain raw (registry does not mutate caller payloads).
    expect(hugeArgs.blob.startsWith('X')).toBe(true);
    expect(hugeArgs.blob.length).toBeGreaterThan(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES);

    eventListenerRef.current?.({
      type: 'tool_execution_end',
      toolCallId: 'tc-stream',
      isError: false,
      result: { dump: 'Z'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 512) },
    });
    await new Promise((r) => setImmediate(r));
    const ended = registry.get(key)!;
    expect(ended.activeTools[0]!.ended).toBe(true);
    expect((ended.activeTools[0]!.partialResult as { _omitted?: boolean })._omitted).toBe(true);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('caps complete active-tool entry when args+partialResult each under budget but combined exceed', async () => {
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

    await registry.activate(key, 'Task: combined-entry', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));

    // Each payload ~40 KiB (under 64 KiB) but combined with id/name/object overhead > 64 KiB.
    const half = Math.floor(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES * 0.62);
    const sourceArgs = { blob: 'A'.repeat(half), nested: { keep: true } };
    const sourcePartial = { dump: 'B'.repeat(half), nested: { keep: true } };
    expect(Buffer.byteLength(JSON.stringify(sourceArgs), 'utf8')).toBeLessThan(
      INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
    );
    expect(Buffer.byteLength(JSON.stringify(sourcePartial), 'utf8')).toBeLessThan(
      INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
    );
    // Combined raw would exceed the complete-entry cap.
    const rawCombined = {
      toolCallId: 'tc-combined',
      toolName: 'bash',
      args: sourceArgs,
      partialResult: sourcePartial,
    };
    expect(Buffer.byteLength(JSON.stringify(rawCombined), 'utf8')).toBeGreaterThan(
      INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
    );

    eventListenerRef.current?.({
      type: 'tool_execution_start',
      toolCallId: 'tc-combined',
      toolName: 'bash',
      args: sourceArgs,
    });
    eventListenerRef.current?.({
      type: 'tool_execution_update',
      toolCallId: 'tc-combined',
      partialResult: sourcePartial,
    });
    await new Promise((r) => setImmediate(r));

    const mid = registry.get(key)!;
    expect(mid.activeTools).toHaveLength(1);
    const entry = mid.activeTools[0]!;
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
    expect(entryBytes).toBeLessThanOrEqual(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES);
    // Lower-priority fields must have been shrunk/omitted so the complete entry fits.
    const entryJson = JSON.stringify(entry);
    expect(entryJson.includes(sourceArgs.blob) && entryJson.includes(sourcePartial.dump)).toBe(
      false
    );
    // Source objects remain mutable and unfrozen (no transport mutation).
    expect(Object.isFrozen(sourceArgs)).toBe(false);
    expect(Object.isFrozen(sourcePartial)).toBe(false);
    expect(Object.isFrozen(sourceArgs.nested)).toBe(false);
    sourceArgs.nested.keep = false;
    sourcePartial.nested.keep = false;
    sourceArgs.blob = 'mutated';
    // Published entry is isolated from source mutation.
    const after = registry.get(key)!;
    expect(JSON.stringify(after.activeTools[0])).not.toContain('mutated');
    expect(Object.isFrozen(after.activeTools[0])).toBe(true);

    // start/update/end lookup still works with the same id.
    eventListenerRef.current?.({
      type: 'tool_execution_end',
      toolCallId: 'tc-combined',
      isError: false,
      result: { ok: true },
    });
    await new Promise((r) => setImmediate(r));
    const ended = registry.get(key)!;
    expect(ended.activeTools).toHaveLength(1);
    expect(ended.activeTools[0]!.ended).toBe(true);
    expect(ended.activeTools[0]!.toolCallId).toBe('tc-combined');
    expect(Buffer.byteLength(JSON.stringify(ended.activeTools[0]), 'utf8')).toBeLessThanOrEqual(
      INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
    );

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('clones under-budget array tool args before freeze (no transport mutation)', async () => {
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

    await registry.activate(key, 'Task: array-args', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));

    const nested = { flag: true };
    const sourceArray = ['item-a', nested, 'item-b'];
    eventListenerRef.current?.({
      type: 'tool_execution_start',
      toolCallId: 'tc-arr',
      toolName: 'list',
      args: sourceArray,
    });
    await new Promise((r) => setImmediate(r));

    const mid = registry.get(key)!;
    expect(mid.activeTools).toHaveLength(1);
    const published = mid.activeTools[0]!.args as { value?: unknown[] };
    expect(Array.isArray(published.value)).toBe(true);
    // Must be a clone, not the transport-owned array.
    expect(published.value).not.toBe(sourceArray);
    expect(published.value![1]).not.toBe(nested);
    expect(Object.isFrozen(mid.activeTools[0])).toBe(true);
    // Freezing published state must not freeze the source array or its nested objects.
    expect(Object.isFrozen(sourceArray)).toBe(false);
    expect(Object.isFrozen(nested)).toBe(false);
    // Source mutation must not affect the retained projection.
    sourceArray.push('item-c');
    nested.flag = false;
    (sourceArray[1] as { flag: boolean }).flag = false;
    const again = registry.get(key)!;
    const againVal = (again.activeTools[0]!.args as { value: unknown[] }).value;
    expect(againVal).toHaveLength(3);
    expect((againVal[1] as { flag: boolean }).flag).toBe(true);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('bounds text-part siblings, top-level extras, tool id/name/queues; isolates snapshot mutables', async () => {
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

    await registry.activate(key, 'Task: r3-bound', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));

    const hugeText = 'T'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 8192);
    const hugeSibling = 'S'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 4096);
    const hugeTop = 'X'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 2048);
    const hugeId = 'I'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 512);
    const hugeName = 'N'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 256);
    const hugeQueue = 'Q'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 128);
    const mutableArgs = {
      blob: 'A'.repeat(1024),
      nested: { v: 1 },
    };
    const mutableResult = { dump: 'R'.repeat(1024), nested: { v: 2 } };

    eventListenerRef.current?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: hugeText,
            note: hugeSibling,
            meta: { blob: hugeSibling },
          },
        ],
        usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0 } },
        model: 'r3-model',
        stopReason: 'stop',
        errorMessage: hugeTop,
        responseId: hugeTop,
        api: hugeTop,
        provider: hugeTop,
        timestamp: hugeTop,
        customExtra: { dump: hugeTop },
      },
    });
    eventListenerRef.current?.({
      type: 'tool_execution_start',
      toolCallId: hugeId,
      toolName: hugeName,
      args: mutableArgs,
    });
    eventListenerRef.current?.({
      type: 'tool_execution_update',
      toolCallId: hugeId,
      partialResult: mutableResult,
    });
    eventListenerRef.current?.({
      type: 'queue_update',
      steering: [hugeQueue],
      followUp: [hugeQueue, { nested: hugeQueue }],
    });
    await new Promise((r) => setImmediate(r));

    const snap = registry.get(key)!;
    const assistant = snap.messages[0] as unknown as {
      content: Array<Record<string, unknown>>;
      usage?: { input?: number; output?: number };
      model?: string;
      stopReason?: string;
      errorMessage?: string;
      responseId?: string;
      api?: string;
      provider?: string;
      timestamp?: string;
      customExtra?: unknown;
    };
    const textPart = assistant.content[0]!;
    // Authoritative text preserved exactly even when itself exceeds 64 KiB.
    expect(textPart.text).toBe(hugeText);
    expect(assistant.usage?.input).toBe(1);
    expect(assistant.model).toBe('r3-model');
    expect(assistant.stopReason).toBe('stop');
    // Non-authoritative text siblings bounded.
    if (typeof textPart.note === 'string') {
      expect(Buffer.byteLength(textPart.note, 'utf8')).toBeLessThanOrEqual(
        INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
      );
      expect(textPart.note).not.toBe(hugeSibling);
    }
    if (textPart.meta) {
      expect(Buffer.byteLength(JSON.stringify(textPart.meta), 'utf8')).toBeLessThanOrEqual(
        INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
      );
    }
    // Top-level extras bounded or omitted as complete items.
    for (const field of ['errorMessage', 'responseId', 'api', 'provider', 'timestamp'] as const) {
      const val = assistant[field];
      if (typeof val === 'string') {
        expect(Buffer.byteLength(val, 'utf8')).toBeLessThanOrEqual(
          INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
        );
        expect(val).not.toBe(hugeTop);
      }
    }
    if (assistant.customExtra !== undefined) {
      expect(Buffer.byteLength(JSON.stringify(assistant.customExtra), 'utf8')).toBeLessThanOrEqual(
        INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
      );
    }
    expect(JSON.stringify(assistant)).not.toContain(hugeSibling);
    expect(JSON.stringify(assistant)).not.toContain(hugeTop);

    expect(snap.activeTools).toHaveLength(1);
    const tool = snap.activeTools[0]!;
    expect(Buffer.byteLength(tool.toolCallId, 'utf8')).toBeLessThanOrEqual(
      INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
    );
    expect(Buffer.byteLength(tool.toolName, 'utf8')).toBeLessThanOrEqual(
      INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
    );
    expect(tool.toolCallId).not.toBe(hugeId);
    expect(tool.toolName).not.toBe(hugeName);
    expect(Buffer.byteLength(JSON.stringify(tool), 'utf8')).toBeLessThanOrEqual(
      INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
    );

    for (const q of [...snap.steeringQueue, ...snap.followUpQueue]) {
      expect(Buffer.byteLength(q, 'utf8')).toBeLessThanOrEqual(
        INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
      );
      expect(q).not.toBe(hugeQueue);
    }

    // Snapshot isolation: published nested objects are frozen clones, not transport-owned refs.
    const publishedArgs = tool.args as { blob?: string; nested?: { v?: number } };
    const publishedResult = tool.partialResult as { dump?: string; nested?: { v?: number } };
    expect(publishedArgs).not.toBe(mutableArgs);
    expect(Object.isFrozen(tool)).toBe(true);
    expect(Object.isFrozen(publishedArgs)).toBe(true);
    expect(() => {
      (publishedArgs as { blob?: string }).blob = 'MUTATED';
    }).toThrow();
    if (publishedResult && typeof publishedResult === 'object') {
      expect(Object.isFrozen(publishedResult)).toBe(true);
    }
    // Mutating the original transport-owned payloads must not expand retained endpoint state.
    mutableArgs.blob = 'Z'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 2048);
    mutableArgs.nested.v = 42;
    mutableResult.dump = 'Z'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 2048);
    mutableResult.nested.v = 42;

    const again = registry.get(key)!;
    expect(JSON.stringify(again.activeTools)).not.toContain('Z'.repeat(64));
    const againArgs = again.activeTools[0]!.args as { nested?: { v?: number }; blob?: string };
    expect(againArgs.nested?.v).toBe(1);
    expect(againArgs.blob).toBe('A'.repeat(1024));

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('bounds text-part identity siblings under complete-item budget without truncating text', async () => {
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

    await registry.activate(key, 'Task: text-siblings', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));

    const hugeText = 'T'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 16384);
    const hugeId = 'I'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 4096);
    const hugeName = 'N'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 2048);
    const hugeToolCallId = 'C'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 1024);
    const hugeToolName = 'M'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 512);
    const hugeMime = 'X'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 256);
    const hugeExtra = 'E'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 128);

    const sourcePart = {
      type: 'text' as const,
      text: hugeText,
      id: hugeId,
      name: hugeName,
      toolCallId: hugeToolCallId,
      toolName: hugeToolName,
      mimeType: hugeMime,
      mystery: hugeExtra,
    };
    eventListenerRef.current?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [sourcePart],
        usage: { input: 2, output: 3, totalTokens: 5, cost: { total: 0 } },
        model: 'sibling-model',
        stopReason: 'stop',
      },
    });
    await new Promise((r) => setImmediate(r));

    const snap = registry.get(key)!;
    const assistant = snap.messages[0] as unknown as {
      content: Array<Record<string, unknown>>;
      model?: string;
      stopReason?: string;
      usage?: { input?: number };
    };
    const part = assistant.content[0]!;
    expect(part.text).toBe(hugeText);
    expect(assistant.model).toBe('sibling-model');
    expect(assistant.stopReason).toBe('stop');
    expect(assistant.usage?.input).toBe(2);

    for (const key of ['id', 'name', 'toolCallId', 'toolName', 'mimeType', 'mystery'] as const) {
      const val = part[key];
      if (typeof val === 'string') {
        expect(Buffer.byteLength(val, 'utf8')).toBeLessThanOrEqual(
          INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
        );
        expect(val).not.toBe(hugeId);
        expect(val).not.toBe(hugeName);
        expect(val).not.toBe(hugeToolCallId);
        expect(val).not.toBe(hugeToolName);
        expect(val).not.toBe(hugeMime);
        expect(val).not.toBe(hugeExtra);
      }
    }
    // Non-text envelope (type + siblings) must fit a complete-item budget.
    const shell: Record<string, unknown> = { type: part.type };
    for (const [k, v] of Object.entries(part)) {
      if (k === 'type' || k === 'text') continue;
      shell[k] = v;
    }
    expect(Buffer.byteLength(JSON.stringify(shell), 'utf8')).toBeLessThanOrEqual(
      INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
    );
    expect(JSON.stringify(part)).not.toContain(hugeId);
    expect(JSON.stringify(part)).not.toContain(hugeMime);

    // Source transport object remains unbounded/unmutated.
    expect(sourcePart.text).toBe(hugeText);
    expect(sourcePart.id).toBe(hugeId);
    expect(sourcePart.mimeType).toBe(hugeMime);
    expect(sourcePart.mystery).toBe(hugeExtra);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('projects bashExecution and unknown roles with bounded payloads; preserves assistant final text', async () => {
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

    await registry.activate(key, 'Task: unknown-roles', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));

    const hugeOutput = 'O'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 8192);
    const hugeUnknown = 'U'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 4096);
    const finalText = 'authoritative final assistant text — keep exact';

    const bashSource = {
      role: 'bashExecution' as const,
      command: 'ls -la',
      output: hugeOutput,
      exitCode: 0,
    };
    const unknownSource = {
      role: 'futureRole' as const,
      payload: hugeUnknown,
      nested: { blob: hugeUnknown },
      content: hugeUnknown,
    };

    eventListenerRef.current?.({ type: 'message_end', message: bashSource });
    eventListenerRef.current?.({ type: 'message_end', message: unknownSource });
    eventListenerRef.current?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: finalText }],
        usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
        model: 'final-model',
        stopReason: 'stop',
      },
    });
    await new Promise((r) => setImmediate(r));

    const snap = registry.get(key)!;
    expect(snap.messages).toHaveLength(3);

    const bash = snap.messages[0] as unknown as Record<string, unknown>;
    expect(bash.role).toBe('bashExecution');
    if (typeof bash.output === 'string') {
      expect(Buffer.byteLength(bash.output, 'utf8')).toBeLessThanOrEqual(
        INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
      );
      expect(bash.output).not.toBe(hugeOutput);
    }
    expect(JSON.stringify(bash)).not.toContain(hugeOutput);

    const unknown = snap.messages[1] as unknown as Record<string, unknown>;
    expect(unknown.role).toBe('futureRole');
    if (typeof unknown.content === 'string') {
      expect(Buffer.byteLength(unknown.content, 'utf8')).toBeLessThanOrEqual(
        INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
      );
    }
    if (typeof unknown.payload === 'string') {
      expect(Buffer.byteLength(unknown.payload, 'utf8')).toBeLessThanOrEqual(
        INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
      );
    }
    if (unknown.nested !== undefined) {
      expect(Buffer.byteLength(JSON.stringify(unknown.nested), 'utf8')).toBeLessThanOrEqual(
        INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
      );
    }
    expect(JSON.stringify(unknown)).not.toContain(hugeUnknown);

    const assistant = snap.messages[2] as unknown as {
      content: Array<{ type?: string; text?: string }>;
      model?: string;
      stopReason?: string;
    };
    expect(assistant.content[0]?.text).toBe(finalText);
    expect(assistant.model).toBe('final-model');
    expect(assistant.stopReason).toBe('stop');

    // Source transport objects remain unbounded/unmutated.
    expect(bashSource.output).toBe(hugeOutput);
    expect(unknownSource.payload).toBe(hugeUnknown);
    expect(unknownSource.content).toBe(hugeUnknown);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('bounds huge activeTools Map keys across start/update/end and keeps retained size finite', async () => {
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

    await registry.activate(key, 'Task: huge-tool-id', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));

    const hugeId = 'H'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 8192);
    const hugeId2 = 'G'.repeat(INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES + 4096);

    eventListenerRef.current?.({
      type: 'tool_execution_start',
      toolCallId: hugeId,
      toolName: 'search',
      args: { q: 'one' },
    });
    eventListenerRef.current?.({
      type: 'tool_execution_start',
      toolCallId: hugeId2,
      toolName: 'read',
      args: { path: '/tmp/a' },
    });
    await new Promise((r) => setImmediate(r));

    const internal = registry._endpoints.get(key) as
      { activeTools: Map<string, { toolCallId: string; ended?: boolean }> } | undefined;
    expect(internal).toBeDefined();
    expect(internal!.activeTools.size).toBe(2);
    for (const mapKey of internal!.activeTools.keys()) {
      expect(Buffer.byteLength(mapKey, 'utf8')).toBeLessThanOrEqual(256);
      expect(mapKey).not.toBe(hugeId);
      expect(mapKey).not.toBe(hugeId2);
    }
    // Map retained key storage must not keep the raw huge IDs.
    const keyJoin = [...internal!.activeTools.keys()].join('');
    expect(keyJoin.includes('H'.repeat(64))).toBe(false);
    expect(keyJoin.includes('G'.repeat(64))).toBe(false);

    const snapStart = registry.get(key)!;
    expect(snapStart.activeTools).toHaveLength(2);
    for (const tool of snapStart.activeTools) {
      expect(Buffer.byteLength(tool.toolCallId, 'utf8')).toBeLessThanOrEqual(
        INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES
      );
      expect(tool.toolCallId).not.toBe(hugeId);
      expect(tool.toolCallId).not.toBe(hugeId2);
    }
    expect(Buffer.byteLength(JSON.stringify(snapStart.activeTools), 'utf8')).toBeLessThan(
      INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES * 2
    );

    // Update/end still resolve via the deterministic bounded key.
    eventListenerRef.current?.({
      type: 'tool_execution_update',
      toolCallId: hugeId,
      partialResult: { progress: 50 },
    });
    eventListenerRef.current?.({
      type: 'tool_execution_end',
      toolCallId: hugeId,
      result: { ok: true },
      isError: false,
    });
    eventListenerRef.current?.({
      type: 'tool_execution_end',
      toolCallId: hugeId2,
      result: { ok: false },
      isError: true,
    });
    await new Promise((r) => setImmediate(r));

    const snapEnd = registry.get(key)!;
    expect(snapEnd.activeTools).toHaveLength(2);
    expect(snapEnd.activeTools.every((t) => t.ended === true)).toBe(true);
    const ended = snapEnd.activeTools.find((t) => t.isError === false);
    const failed = snapEnd.activeTools.find((t) => t.isError === true);
    expect(ended?.partialResult).toEqual({ ok: true });
    expect(failed?.partialResult).toEqual({ ok: false });
    expect(internal!.activeTools.size).toBe(2);
    for (const mapKey of internal!.activeTools.keys()) {
      expect(Buffer.byteLength(mapKey, 'utf8')).toBeLessThanOrEqual(256);
    }

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('public snapshot and list item isolate sessionArtifact, activation.policy, and usage', async () => {
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

    const act = await registry.activate(
      key,
      'Task: isolate-meta',
      'prompt',
      { maxTurns: 3 },
      'tool_call'
    );
    await new Promise((r) => setImmediate(r));

    // Seed usage so the public projection includes nested metadata.
    eventListenerRef.current?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'meta' }],
        usage: { input: 2, output: 3, totalTokens: 5, cost: { total: 0.1 } },
        model: 'meta-model',
        stopReason: 'stop',
      },
    });
    await new Promise((r) => setImmediate(r));

    const snap = registry.get(key)!;
    const list = registry.listVisibleMeta().find((row) => row.key === key)!;
    expect(snap.activation?.id).toBe(act.activationId);
    expect(snap.activation?.policy?.maxTurns).toBe(3);
    expect(snap.sessionArtifact).toBeDefined();
    expect(list.sessionArtifact).toBeDefined();
    expect(snap.usage).toBeDefined();
    expect(list.usage).toBeDefined();

    const internal = registry._endpoints.get(key) as
      | {
          sessionArtifact?: { runtime?: string; sessionFile?: string; sessionId?: string };
          activation?: { policy?: { maxTurns?: number } };
          usage?: { turns?: number; model?: string; input?: number };
        }
      | undefined;
    expect(internal).toBeDefined();

    // Consumer mutation of public nested metadata must not alter endpoint identity.
    const publicArt = snap.sessionArtifact as { runtime?: string; sessionFile?: string };
    const listArt = list.sessionArtifact as { runtime?: string; sessionFile?: string };
    expect(publicArt).not.toBe(internal!.sessionArtifact);
    expect(listArt).not.toBe(internal!.sessionArtifact);
    expect(Object.isFrozen(publicArt)).toBe(true);
    expect(Object.isFrozen(listArt)).toBe(true);
    expect(() => {
      publicArt.sessionFile = '/mutated/session.json';
    }).toThrow();
    expect(() => {
      listArt.runtime = 'mutated' as never;
    }).toThrow();

    const publicPolicy = snap.activation!.policy as { maxTurns?: number };
    expect(publicPolicy).not.toBe(internal!.activation?.policy);
    expect(Object.isFrozen(publicPolicy)).toBe(true);
    expect(() => {
      publicPolicy.maxTurns = 99;
    }).toThrow();
    expect(internal!.activation?.policy?.maxTurns).toBe(3);

    const publicUsage = snap.usage as { model?: string; turns?: number; input?: number };
    const listUsage = list.usage as { model?: string; turns?: number; input?: number };
    expect(publicUsage).not.toBe(internal!.usage);
    expect(listUsage).not.toBe(internal!.usage);
    expect(Object.isFrozen(publicUsage)).toBe(true);
    expect(() => {
      publicUsage.model = 'mutated-model';
      publicUsage.turns = 999;
    }).toThrow();

    const later = registry.get(key)!;
    expect(later.sessionArtifact).toEqual(snap.sessionArtifact);
    expect(later.activation?.policy?.maxTurns).toBe(3);
    expect(later.usage?.model).not.toBe('mutated-model');
    if (internal!.sessionArtifact && 'sessionFile' in internal!.sessionArtifact) {
      expect(internal!.sessionArtifact.sessionFile).not.toBe('/mutated/session.json');
    }

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('detach during running activation settles terminal status, defers eviction, no duplicate settle', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const eventListenerRef: { current?: (e: unknown) => void } = {};
    const { registry, key, sessionFile } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef,
    });
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );

    const settledEvents: Array<{
      status: string;
      messageCount: number;
      activationId: string;
    }> = [];
    const order: string[] = [];
    registry.subscribe((e) => {
      if (e.type === 'activation_settled') {
        order.push('activation_settled');
        settledEvents.push({
          status: e.snapshot.status,
          messageCount: e.snapshot.messages.length,
          activationId: e.activationId,
        });
        // Pre-eviction transcript must still be visible on the settled snapshot.
        expect(e.snapshot.messages.length).toBeGreaterThan(0);
        expect(e.snapshot.status).not.toBe('running');
        expect(e.snapshot.status).not.toBe('starting');
      } else if (e.type === 'endpoint_updated' && e.key === key) {
        order.push(`endpoint_updated:${e.snapshot.status}:${e.snapshot.messages.length}`);
      }
    });

    const act = await registry.activate(
      key,
      'Task: detach-running',
      'prompt',
      undefined,
      'tool_call'
    );
    await new Promise((r) => setImmediate(r));
    eventListenerRef.current?.({ type: 'agent_start' });
    const chunk = 'D'.repeat(40 * 1024);
    for (let i = 0; i < 20; i++) {
      eventListenerRef.current?.({
        type: 'message_end',
        message: {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: i % 2 === 0 ? `u-${i}:${chunk}` : [{ type: 'text', text: `a-${i}:${chunk}` }],
        },
      });
    }
    await new Promise((r) => setImmediate(r));
    expect(registry.get(key)?.status).toBe('running');
    const preCount = registry.get(key)!.messages.length;
    expect(preCount).toBeGreaterThan(2);

    await registry.detach(key);
    expect(settledEvents).toHaveLength(1);
    expect(settledEvents[0]!.activationId).toBe(act.activationId);
    expect(settledEvents[0]!.status).toBe('detached');
    expect(settledEvents[0]!.messageCount).toBe(preCount);
    // Settled before any post-settle empty transcript publication.
    const settledIdx = order.indexOf('activation_settled');
    expect(settledIdx).toBeGreaterThanOrEqual(0);
    const laterEmpty = order
      .slice(settledIdx + 1)
      .some((s) => s.startsWith('endpoint_updated:detached:0'));
    // Eviction is deferred; after microtasks the transcript may clear.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 30));
    // No duplicate settle.
    expect(settledEvents).toHaveLength(1);
    const after = registry.get(key)!;
    expect(after.activation).toBeUndefined();
    expect(after.status).toBe('detached');
    // Oversized idle/detached transcript is eventually released.
    expect(after.messages.length).toBe(0);
    expect(laterEmpty || after.messages.length === 0).toBe(true);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('transport invalidation during running activation settles non-running status without duplicate settle', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const eventListenerRef: { current?: (e: unknown) => void } = {};
    const { registry, key, runId, sessionFile } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef,
    });
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );

    const settled: Array<{ status: string; messageCount: number; activationId: string }> = [];
    let internalAtSettled: { status: string; messageCount: number } | undefined;
    registry.subscribe((e) => {
      if (e.type === 'activation_settled' && e.key === key) {
        settled.push({
          status: e.snapshot.status,
          messageCount: e.snapshot.messages.length,
          activationId: e.activationId,
        });
        expect(e.snapshot.status).not.toBe('running');
        expect(e.snapshot.status).not.toBe('starting');
        expect(e.snapshot.messages.length).toBeGreaterThan(0);
        // Internal endpoint must retain the complete transcript through the settled turn.
        const internalNow = registry._endpoints.get(key) as
          { status: string; messages: readonly unknown[] } | undefined;
        internalAtSettled = {
          status: internalNow?.status ?? 'missing',
          messageCount: internalNow?.messages.length ?? 0,
        };
      }
    });

    const act = await registry.activate(key, 'Task: invalidate', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    eventListenerRef.current?.({ type: 'agent_start' });
    eventListenerRef.current?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'keep-me-' + 'K'.repeat(1024) }],
      },
    });
    await new Promise((r) => setImmediate(r));
    expect(registry.get(key)?.status).toBe('running');
    const preCount = registry.get(key)!.messages.length;

    // Forged host session → applyUnavailable → invalidateLiveTransport while running.
    const ep = registry.get(key)!;
    const forged: InteractiveAgentLinkV1 = {
      version: 1,
      runId,
      unitId: 'single',
      bindingId: ep.bindingId,
      hostSessionId: 'forged-invalid-host',
      createdAt: Date.now(),
    };
    registry.restoreActiveBranch({
      sessionManager: {
        getSessionId: () => 'forged-invalid-host',
        getBranch: () => [{ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: forged }],
      },
      cwd: root,
    } as never);

    expect(settled).toHaveLength(1);
    expect(settled[0]!.activationId).toBe(act.activationId);
    expect(settled[0]!.status).not.toBe('running');
    expect(settled[0]!.messageCount).toBe(preCount);
    expect(internalAtSettled?.messageCount).toBe(preCount);
    // Immediately after the synchronous settled call stack, internal transcript is still complete.
    const internalSync = registry._endpoints.get(key) as
      { status: string; activation?: unknown; messages: readonly unknown[] } | undefined;
    expect(internalSync?.activation).toBeUndefined();
    expect(internalSync?.status).toBe('unavailable');
    expect(internalSync?.messages.length).toBe(preCount);

    // Deferred transition clears the transcript after the settled turn.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(settled).toHaveLength(1);
    const internalDeferred = registry._endpoints.get(key) as
      { status: string; messages: readonly unknown[] } | undefined;
    expect(internalDeferred?.status).toBe('unavailable');
    expect(internalDeferred?.messages.length).toBe(0);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('successful settle publishes full snapshot before deferred reloadable eviction', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent();
    const eventListenerRef: { current?: (e: unknown) => void } = {};
    const { registry, key, sessionFile } = await registerWithFakeTransport({
      root,
      store,
      coordinator,
      agent,
      eventListenerRef,
    });
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"test-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );

    const settledSnapshots: Array<{ messages: readonly unknown[]; activationId: string }> = [];
    let settled = false;
    registry.subscribe((e) => {
      if (e.type === 'activation_settled') {
        settled = true;
        settledSnapshots.push({
          messages: e.snapshot.messages,
          activationId: e.activationId,
        });
      }
    });

    const act = await registry.activate(key, 'Task: evict', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));

    const chunk = 'M'.repeat(32 * 1024);
    let appended = 0;
    while (true) {
      eventListenerRef.current?.({
        type: 'message_end',
        message: {
          role: appended % 2 === 0 ? 'user' : 'assistant',
          content:
            appended % 2 === 0
              ? `user-${appended}:${chunk}`
              : [{ type: 'text', text: `assistant-${appended}:${chunk}` }],
        },
      });
      appended += 1;
      const mid = registry.get(key)!;
      const bytes = Buffer.byteLength(JSON.stringify(mid.messages), 'utf8');
      if (bytes > INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES && appended >= 4) break;
      if (appended > 40) break;
    }
    eventListenerRef.current?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'SETTLE_FINAL_OUTPUT' }],
        usage: { input: 3, output: 5, totalTokens: 8, cost: { total: 0 } },
        model: 'test-model',
        stopReason: 'stop',
      },
    });
    await new Promise((r) => setImmediate(r));

    const beforeSettle = registry.get(key)!;
    expect(beforeSettle.messages.length).toBeGreaterThan(2);
    const preBytes = Buffer.byteLength(JSON.stringify(beforeSettle.messages), 'utf8');
    expect(preBytes).toBeGreaterThan(INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES);
    const elementBytes = beforeSettle.messages.map((m) =>
      Buffer.byteLength(JSON.stringify(m), 'utf8')
    );
    const exact =
      2 + elementBytes.reduce((a, b) => a + b, 0) + Math.max(0, elementBytes.length - 1);
    expect(exact).toBe(preBytes);

    eventListenerRef.current?.({ type: 'agent_start' });
    eventListenerRef.current?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListenerRef.current?.({ type: 'agent_settled' });
    // Drain transition queue so agent_settled reduces synchronously for subscribers.
    await new Promise((r) => setImmediate(r));

    // Settled consumer observed the complete pre-eviction snapshot before deferred retention.
    expect(settled).toBe(true);
    expect(settledSnapshots).toHaveLength(1);
    expect(settledSnapshots[0]!.activationId).toBe(act.activationId);
    expect(settledSnapshots[0]!.messages.length).toBe(beforeSettle.messages.length);
    const last = settledSnapshots[0]!.messages[settledSnapshots[0]!.messages.length - 1] as {
      content: Array<{ text: string }>;
    };
    expect(last.content[0]!.text).toBe('SETTLE_FINAL_OUTPUT');

    // Deferred retention: reloadable oversized idle becomes empty/unhydrated.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));

    const after = registry.get(key)!;
    expect(after.messages).toEqual([]);
    expect(['detached', 'idle', 'error']).toContain(after.status);
    expect(after.sessionFile).toBe(sessionFile);
    const epMap = (
      registry as unknown as {
        _endpoints: Map<string, { transcriptHydrated: boolean }>;
      }
    )._endpoints;
    expect(epMap.get(key)?.transcriptHydrated).toBe(false);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('hydrated oversized transcript schedules eviction after prompt/spawn failure', async () => {
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
    const sessionFile = path.join(sessionsDir, 'oversized-fail.jsonl');
    const header = {
      type: 'session',
      version: 3,
      id: 'sess-oversized-fail',
      timestamp: new Date().toISOString(),
      cwd: root,
    };
    const chunk = 'M'.repeat(40 * 1024);
    const lines = [JSON.stringify(header)];
    for (let i = 0; i < 20; i++) {
      lines.push(
        JSON.stringify({
          type: 'message',
          id: `m${i}`,
          parentId: i === 0 ? null : `m${i - 1}`,
          timestamp: new Date().toISOString(),
          message: {
            role: i % 2 === 0 ? 'user' : 'assistant',
            content:
              i % 2 === 0
                ? `user-${i}:${chunk}`
                : [{ type: 'text', text: `assistant-${i}:${chunk}` }],
            timestamp: Date.now(),
          },
        })
      );
    }
    fs.writeFileSync(sessionFile, `${lines.join('\n')}\n`);
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
        throw new Error('spawn boom after hydrate');
      },
    });
    registry.setHostLinkAppender(() => undefined);

    const settled: Array<{ activationId: string; messageCount: number }> = [];
    registry.subscribe((e) => {
      if (e.type === 'activation_settled') {
        settled.push({
          activationId: e.activationId,
          messageCount: e.snapshot.messages.length,
        });
      }
    });

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-oversized-fail',
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

    expect(snap.messages.length).toBeGreaterThan(2);
    const preBytes = Buffer.byteLength(JSON.stringify(snap.messages), 'utf8');
    expect(preBytes).toBeGreaterThan(INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES);

    let err: unknown;
    try {
      await registry.activate(snap.key, 'Task: fail', 'prompt', undefined, 'tool_call');
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(String(err)).toMatch(/spawn boom/);

    // Settled consumers observe the complete pre-eviction snapshot first.
    expect(settled.length).toBeGreaterThanOrEqual(1);
    expect(settled[0]!.messageCount).toBe(snap.messages.length);

    // Deferred reloadable eviction after final error status.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 30));

    const after = registry.get(snap.key)!;
    expect(after.messages).toEqual([]);
    expect(['error', 'detached', 'idle']).toContain(after.status);
    const epMap = (
      registry as unknown as {
        _endpoints: Map<string, { transcriptHydrated: boolean }>;
      }
    )._endpoints;
    expect(epMap.get(snap.key)?.transcriptHydrated).toBe(false);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('hydrated oversized transcript schedules eviction after starting cancellation', async () => {
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
    const sessionFile = path.join(sessionsDir, 'oversized-cancel.jsonl');
    const header = {
      type: 'session',
      version: 3,
      id: 'sess-oversized-cancel',
      timestamp: new Date().toISOString(),
      cwd: root,
    };
    const chunk = 'C'.repeat(40 * 1024);
    const lines = [JSON.stringify(header)];
    for (let i = 0; i < 20; i++) {
      lines.push(
        JSON.stringify({
          type: 'message',
          id: `c${i}`,
          parentId: i === 0 ? null : `c${i - 1}`,
          timestamp: new Date().toISOString(),
          message: {
            role: i % 2 === 0 ? 'user' : 'assistant',
            content:
              i % 2 === 0
                ? `user-${i}:${chunk}`
                : [{ type: 'text', text: `assistant-${i}:${chunk}` }],
            timestamp: Date.now(),
          },
        })
      );
    }
    fs.writeFileSync(sessionFile, `${lines.join('\n')}\n`);
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);

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
        }) as unknown as PiRpcTransport,
    });
    registry.setHostLinkAppender(() => undefined);

    const settled: Array<{ messageCount: number }> = [];
    registry.subscribe((e) => {
      if (e.type === 'activation_settled') {
        settled.push({ messageCount: e.snapshot.messages.length });
      }
    });

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-oversized-cancel',
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

    expect(snap.messages.length).toBeGreaterThan(2);
    const preBytes = Buffer.byteLength(JSON.stringify(snap.messages), 'utf8');
    expect(preBytes).toBeGreaterThan(INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES);

    const actPromise = registry.activate(snap.key, 'Task: cancel', 'prompt', undefined, 'view');
    // Wait until starting with an open activation, then cancel before handshake completes.
    for (let i = 0; i < 50; i++) {
      const mid = registry.get(snap.key);
      if (mid?.status === 'starting' && mid.activation) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const starting = registry.get(snap.key)!;
    expect(starting.status).toBe('starting');
    expect(starting.activation).toBeTruthy();

    await registry.abort(snap.key);
    resolveState();
    await Promise.allSettled([actPromise]);

    expect(settled.length).toBeGreaterThanOrEqual(1);
    expect(settled[0]!.messageCount).toBe(snap.messages.length);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 30));

    const after = registry.get(snap.key)!;
    expect(after.messages).toEqual([]);
    expect(['detached', 'idle', 'error', 'cancelled']).toContain(after.status);
    const epMap = (
      registry as unknown as {
        _endpoints: Map<string, { transcriptHydrated: boolean }>;
      }
    )._endpoints;
    expect(epMap.get(snap.key)?.transcriptHydrated).toBe(false);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('non-reloadable oversized settle compacts, publishes, and preserves latest assistant', async () => {
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

    const postSettleFull: Array<{ messageCount: number; texts: string[] }> = [];
    let settled = false;
    registry.subscribe((e) => {
      if (e.type === 'activation_settled') settled = true;
      if (e.type === 'endpoint_updated' && settled && e.kind === 'full') {
        postSettleFull.push({
          messageCount: e.snapshot.messages.length,
          texts: e.snapshot.messages.map((m) => {
            const msg = m as { role?: string; content?: unknown };
            if (typeof msg.content === 'string') return msg.content;
            if (Array.isArray(msg.content)) {
              const t = msg.content.find(
                (p) => p && typeof p === 'object' && (p as { type?: string }).type === 'text'
              ) as { text?: string } | undefined;
              return t?.text ?? '';
            }
            return '';
          }),
        });
      }
    });

    await registry.activate(key, 'Task: compact', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));

    // Strip reloadable identity after spawn so settle uses in-place compaction.
    const epMap = (
      registry as unknown as {
        _endpoints: Map<
          string,
          {
            sessionFile: string;
            sessionArtifact?: unknown;
            transcriptHydrated: boolean;
          }
        >;
      }
    )._endpoints;
    const ep = epMap.get(key)!;
    ep.sessionFile = '';
    ep.sessionArtifact = undefined;

    const chunk = 'N'.repeat(40 * 1024);
    for (let i = 0; i < 20; i++) {
      eventListenerRef.current?.({
        type: 'message_end',
        message: {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: i % 2 === 0 ? `u-${i}:${chunk}` : [{ type: 'text', text: `a-${i}:${chunk}` }],
        },
      });
    }
    eventListenerRef.current?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'LATEST_ASSISTANT_KEPT' }],
      },
    });
    await new Promise((r) => setImmediate(r));

    const before = registry.get(key)!;
    const beforeCount = before.messages.length;
    expect(Buffer.byteLength(JSON.stringify(before.messages), 'utf8')).toBeGreaterThan(
      INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES
    );

    eventListenerRef.current?.({ type: 'agent_start' });
    eventListenerRef.current?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));

    const after = registry.get(key)!;
    expect(after.messages.length).toBe(beforeCount);
    const last = after.messages[after.messages.length - 1] as unknown as {
      role: string;
      content: Array<{ text: string }>;
    };
    expect(last.role).toBe('assistant');
    expect(last.content[0]!.text).toBe('LATEST_ASSISTANT_KEPT');
    const earlier = after.messages[0] as unknown as { content: Array<{ text: string }> | string };
    const earlierText =
      typeof earlier.content === 'string' ? earlier.content : (earlier.content[0]?.text ?? '');
    expect(earlierText).toContain('Earlier history omitted');
    expect(ep.transcriptHydrated).toBe(true);

    expect(
      postSettleFull.some((u) => u.texts.some((t) => t.includes('Earlier history omitted')))
    ).toBe(true);
    expect(postSettleFull.some((u) => u.texts.includes('LATEST_ASSISTANT_KEPT'))).toBe(true);

    const afterBytes = Buffer.byteLength(JSON.stringify(after.messages), 'utf8');
    const latestBytes = Buffer.byteLength(JSON.stringify(last), 'utf8');
    const markerOverhead = afterBytes - latestBytes;
    expect(afterBytes).toBeLessThanOrEqual(
      Math.max(INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES, latestBytes + markerOverhead)
    );

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
    expect(registry.get(snap.key)?.status).toBe('idle');
    // After activation clears, list glyphs still classify interrupted via stopReason.
    expect(registry.get(snap.key)?.usage?.stopReason).toBe('aborted');

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('clears prior aborted stopReason on new activation so success settle is not stale interrupted', async () => {
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

    // Turn 1: run then abort → durable stopReason aborted (interrupted glyph).
    const act1 = await registry.activate(key, 'Task: abort-me', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    eventListenerRef.current?.({ type: 'agent_start' });
    await registry.abort(key);
    expect(registry.get(key)?.activation?.terminalOverride).toBe('cancelled');
    eventListenerRef.current?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListenerRef.current?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    expect(settled).toContain(act1.activationId);
    expect(registry.get(key)?.activation).toBeUndefined();
    expect(registry.get(key)?.status).toBe('idle');
    expect(registry.get(key)?.usage?.stopReason).toBe('aborted');

    // Turn 2: new activation must drop prior aborted immediately (no stale ⊘).
    const act2 = await registry.activate(key, 'Task: retry-ok', 'prompt', undefined, 'view');
    expect(act2.activationId).not.toBe(act1.activationId);
    expect(registry.get(key)?.usage?.stopReason).toBeUndefined();

    // Success settle without a new stopReason must not revive interrupted classification.
    await new Promise((r) => setImmediate(r));
    eventListenerRef.current?.({ type: 'agent_start' });
    eventListenerRef.current?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListenerRef.current?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    expect(settled).toContain(act2.activationId);
    expect(registry.get(key)?.activation).toBeUndefined();
    expect(registry.get(key)?.status).toBe('idle');
    expect(registry.get(key)?.usage?.stopReason).toBeUndefined();
    expect(registry.get(key)?.usage?.stopReason).not.toBe('aborted');

    // Turn 3: abort again still leaves interrupted signal for glyphs.
    const act3 = await registry.activate(key, 'Task: abort-again', 'prompt', undefined, 'view');
    await new Promise((r) => setImmediate(r));
    eventListenerRef.current?.({ type: 'agent_start' });
    await registry.abort(key);
    eventListenerRef.current?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListenerRef.current?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    expect(settled).toContain(act3.activationId);
    expect(registry.get(key)?.status).toBe('idle');
    expect(registry.get(key)?.usage?.stopReason).toBe('aborted');

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

    // Forge restore with host-session mismatch → applyUnavailable settles then defers clear.
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

    // Synchronous turn still retains transcript for settled consumers.
    const mid = registry.get(key)!;
    expect(mid.status).toBe('unavailable');
    expect(mid.messages.length).toBeGreaterThan(0);

    // Deferred transition clears transcript and bumps revision.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
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
    expect(registry.get(snap.key)?.usage?.stopReason).toBe('aborted');

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

    // Shutdown must surface sticky dispose_failed (not swallow).
    await expect(registry.shutdown()).rejects.toThrow(/SIGKILL|dispose/i);
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

    await expect(registry.shutdown()).rejects.toThrow(/SIGKILL|dispose/i);
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

    // Factory returns before deadline but getState hangs — shutdown must still
    // dispose, surface dispose_failed on budget, and sticky-fail the lease.
    const hangAct = reg1.activate(snap1.key, 'Task: hang', 'prompt').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(hangGetState).toBe(true);

    await expect(reg1.shutdown()).rejects.toMatchObject({ code: 'dispose_failed' });
    await hangAct;
    expect(order).toContain('old-dispose-start');

    // New registry must not spawn: deadline sticky-failed the same-session lease
    // even though background dispose is still gated.
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

    await expect(
      reg2
        .registerInitial({
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
        })
        .then((snap) => reg2.activate(snap.key, 'Task: after', 'prompt'))
    ).rejects.toMatchObject({ code: 'dispose_failed' });
    expect(factoryNew).toBe(0);

    releaseOldDispose();
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toContain('old-dispose-done');

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
    await expect(regFail.shutdown()).rejects.toThrow(/SIGKILL|dispose/i);
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
    // Hung dispose past budget: shutdown surfaces dispose_failed and fail-closes leases.
    await expect(registry.shutdown()).rejects.toThrow(/dispose|deadline/i);
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
  it('T1 factory hang across shutdown deadline: sticky-fails lease; late dispose success cannot clear', async () => {
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

    // Shutdown deadline exceeded while factory hung: surface dispose_failed, lease sticky.
    const shutdown1 = reg1.shutdown();
    await expect(shutdown1).rejects.toMatchObject({ code: 'dispose_failed' });
    // Cached promise: repeat shutdown rethrows the same dispose_failed.
    await expect(reg1.shutdown()).rejects.toMatchObject({ code: 'dispose_failed' });
    await expect(reg1.shutdown()).rejects.toBe(await shutdown1.catch((e) => e));
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

    // Sticky deadline settle: new registry must fail closed even before late dispose.
    await expect(
      reg2
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
        .then((snap) => reg2.activate(snap.key, 'Task: after', 'prompt'))
    ).rejects.toMatchObject({ code: 'dispose_failed' });
    expect(factoryNew).toBe(0);

    // T1 factory finally returns; late dispose success must not clear sticky failure.
    releaseT1Factory(makeIdleTransport('t1-late', { disposeGate: true }));
    await hangAct;
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toContain('t1-late-dispose-start');
    releaseT1Dispose();
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toContain('t1-late-dispose-done');

    // After late clean dispose, a third registry still fails closed (factory never called).
    let factoryThird = 0;
    const reg3 = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      transportFactory: async () => {
        factoryThird += 1;
        return makeIdleTransport('third');
      },
    });
    reg3.setHostLinkAppender(() => undefined);
    await expect(
      reg3
        .registerInitial({
          runId,
          unitId: 'single',
          hostSessionId: 'host-lease-hang-3',
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
        .then((snap) => reg3.activate(snap.key, 'Task: third', 'prompt'))
    ).rejects.toMatchObject({ code: 'dispose_failed' });
    expect(factoryThird).toBe(0);
    expect(factoryNew).toBe(0);

    await reg2.shutdown();
    await reg3.shutdown();
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
    // Dispose gated past budget: shutdown fails closed and surfaces dispose_failed.
    await expect(reg1.shutdown()).rejects.toMatchObject({ code: 'dispose_failed' });
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

    // After shutdown deadline the shared lease is sticky fail-closed: alias and
    // realpath keys collide, so the new registry must not spawn.
    await expect(
      reg2
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
        .then((snap) => reg2.activate(snap.key, 'Task: new', 'prompt'))
    ).rejects.toMatchObject({ code: 'dispose_failed' });
    expect(factoryNew).toBe(0);

    // Background cleanup may still finish after the deadline.
    releaseT1Dispose();
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toContain('old-dispose-done');

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

describe('Grok ACP session resume + Agent View restoration', () => {
  it('restores Grok ACP endpoint with sessionArtifact and session capability', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ name: 'gagent', runtime: 'grok-acp' as never, model: 'grok' });
    const { runId } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'gagent',
        task: 't',
        runtime: 'grok-acp',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'gagent',
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'interrupted',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
          acpSessionId: 'sess-restore-1',
        },
      },
    });
    const binding = { bindingId: 'bind-1', hostSessionId: 'host-g', createdAt: 100 };
    await store.updateRun(runId, (r) => {
      r.units.single.interactiveBindings = { [binding.bindingId]: binding };
      r.status = 'interrupted';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({ agents: [agent], projectAgentsDir: null, builtinAgentsDir: '/b' }),
    });

    const link: InteractiveAgentLinkV1 = {
      version: 1,
      runId,
      unitId: 'single',
      bindingId: binding.bindingId,
      hostSessionId: binding.hostSessionId,
      createdAt: binding.createdAt,
    };
    const fakeSm = {
      getSessionId: () => 'host-g',
      getBranch: () => [{ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: link }],
    };
    const restored = registry.restoreActiveBranch({
      sessionManager: fakeSm as never,
      cwd: root,
    });
    expect(restored.length).toBe(1);
    expect(restored[0]!.status).toBe('detached');
    expect(restored[0]!.sessionArtifact).toEqual({
      runtime: 'grok-acp',
      sessionId: 'sess-restore-1',
    });
    expect(restored[0]!.sessionFile).toBe('');
    expect(restored[0]!.messages.length).toBe(0);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects forged link without matching binding and rejects running Grok input', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ name: 'gagent', runtime: 'grok-acp' as never, model: 'grok' });
    const { runId } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'gagent',
        task: 't',
        runtime: 'grok-acp',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'gagent',
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'running',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
          acpSessionId: 'sess-forge',
        },
      },
    });
    const binding = { bindingId: 'real-bind', hostSessionId: 'host-g', createdAt: 50 };
    await store.updateRun(runId, (r) => {
      r.units.single.interactiveBindings = { [binding.bindingId]: binding };
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({ agents: [agent], projectAgentsDir: null, builtinAgentsDir: '/b' }),
    });
    registry.setHostLinkAppender(() => undefined);

    const forged: InteractiveAgentLinkV1 = {
      version: 1,
      runId,
      unitId: 'single',
      bindingId: 'forged-bind',
      hostSessionId: 'host-g',
      createdAt: 50,
    };
    const forgedSnap = registry.restoreActiveBranch({
      sessionManager: {
        getSessionId: () => 'host-g',
        getBranch: () => [{ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: forged }],
      } as never,
      cwd: root,
    });
    expect(forgedSnap[0]!.status).toBe('unavailable');
    expect(forgedSnap[0]!.lastError).toMatch(/binding/);

    // Trusted register then reject running input before activation mutation.
    // Unavailable forged endpoint is replaced by a RunStore-validated registration.
    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-g',
      launchSpec: {
        agent,
        request: {
          mode: 'single',
          agentScope: 'both',
          agent: 'gagent',
          task: 't',
          runtime: 'grok-acp',
        },
        sessionFile: '',
        sessionArtifact: { runtime: 'grok-acp', sessionId: 'sess-forge' },
        effectiveCwd: root,
        agentScope: 'both',
        registrationKind: 'initial',
      },
      getBranchEntries: () => [],
    });

    // Inject a fake Grok transport that is already "running".
    const ep = registry.getMutable(snap.key)!;
    const events: unknown[] = [];
    let promptCalls = 0;
    ep.client = {
      runtime: 'grok-acp',
      runningInput: 'unsupported',
      async getState() {
        return { running: true, idle: false, disposed: false };
      },
      async prompt() {
        promptCalls += 1;
      },
      async abort() {},
      async dispose() {},
      subscribe() {
        return () => undefined;
      },
      getStderr() {
        return '';
      },
    } as never;
    ep.status = 'running';
    ep.activation = {
      id: 'act_running',
      endpointKey: snap.key,
      mode: 'prompt',
      baselineMessageCount: 0,
      sequence: 1,
      origin: 'view',
      settled: false,
      createdAt: 1,
      observedAgentStart: true,
    };

    await expect(registry.activate(snap.key, 'while running', 'prompt')).rejects.toMatchObject({
      code: 'running_input_unsupported',
    });
    expect(promptCalls).toBe(0);
    // Activation from the rejected call must not replace the in-flight one.
    expect(registry.get(snap.key)?.activation?.id).toBe('act_running');
    void events;

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('hydrate-only pending owner is tracked: shutdown deadline sticky-fails lease; late clean dispose cannot clear', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ name: 'gagent', runtime: 'grok-acp' as never, model: 'grok' });
    const sessionId = 'sess-hydrate-pending';
    const { runId } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'gagent',
        task: 't',
        runtime: 'grok-acp',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'gagent',
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'interrupted',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
          acpSessionId: sessionId,
        },
      },
    });
    const binding = { bindingId: 'bind-h', hostSessionId: 'host-h', createdAt: 10 };
    await store.updateRun(runId, (r) => {
      r.units.single.interactiveBindings = { [binding.bindingId]: binding };
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);

    let releaseFactory!: (t: {
      getFinalizedMessages: () => unknown[];
      dispose: () => Promise<void>;
      getState: () => Promise<unknown>;
      prompt: () => Promise<void>;
      abort: () => Promise<void>;
      subscribe: () => () => void;
      getStderr: () => string;
    }) => void;
    const factoryGate = new Promise<typeof releaseFactory extends (t: infer T) => void ? T : never>(
      (r) => {
        releaseFactory = r as typeof releaseFactory;
      }
    );
    let disposeCalls = 0;
    let releaseDispose!: () => void;
    const disposeGate = new Promise<void>((r) => {
      releaseDispose = r;
    });

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/b',
      }),
      shutdownDisposeBudgetMs: 40,
      grokAcpTransportFactory: async () => {
        // Hang past shutdown deadline while lease is already held + pending-tracked.
        return factoryGate as never;
      },
    });
    registry.setHostLinkAppender(() => undefined);

    const link: InteractiveAgentLinkV1 = {
      version: 1,
      runId,
      unitId: 'single',
      bindingId: binding.bindingId,
      hostSessionId: binding.hostSessionId,
      createdAt: binding.createdAt,
    };
    registry.restoreActiveBranch({
      sessionManager: {
        getSessionId: () => 'host-h',
        getBranch: () => [{ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: link }],
      } as never,
      cwd: root,
    });

    const key = `${runId}:single`;
    const hydrateP = registry.ensureTranscript(key).catch(() => undefined);
    // Wait until hydrate has acquired the lease (pending owner registered).
    for (let i = 0; i < 50; i++) {
      if (registry._pendingOwnerCount() > 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(registry._pendingOwnerCount()).toBeGreaterThan(0);

    await expect(registry.shutdown()).rejects.toMatchObject({ code: 'dispose_failed' });

    // Late factory return + clean dispose must not clear sticky failure.
    releaseFactory({
      getFinalizedMessages: () => [],
      async dispose() {
        disposeCalls += 1;
        await disposeGate;
      },
      async getState() {
        return { running: false, idle: true, disposed: false };
      },
      async prompt() {},
      async abort() {},
      subscribe() {
        return () => undefined;
      },
      getStderr() {
        return '';
      },
    });
    releaseDispose();
    await hydrateP;
    await new Promise((r) => setTimeout(r, 20));

    // Sticky: a new registry cannot acquire the same Grok session lease.
    const { buildSessionLeaseKey } = await import('../src/session-lease.ts');
    const leaseKey = buildSessionLeaseKey({
      runtime: 'grok-acp',
      cwd: root,
      sessionIdentity: sessionId,
    });
    await expect(acquireSessionLease(leaseKey)).rejects.toThrow(/dispose|deadline/i);

    fs.rmSync(root, { recursive: true, force: true });
    void disposeCalls;
  });

  it('registerGrokAcpLive: binding-gate shutdown race fails closed without attaching transport', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ name: 'gagent', runtime: 'grok-acp' as never, model: 'grok' });
    const sessionId = 'sess-live-race';
    const { runId } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'gagent',
        task: 't',
        runtime: 'grok-acp',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'gagent',
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'running',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
          acpSessionId: sessionId,
        },
      },
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);

    let releaseBinding!: () => void;
    const bindingGate = new Promise<void>((r) => {
      releaseBinding = r;
    });
    let bindingEntered = false;
    const origPersist = coordinator.persistInteractiveBinding.bind(coordinator);
    coordinator.persistInteractiveBinding = (async (input) => {
      bindingEntered = true;
      await bindingGate;
      return origPersist(input);
    }) as typeof coordinator.persistInteractiveBinding;

    let disposeCalls = 0;
    const lease = await acquireSessionLease(
      (await import('../src/session-lease.ts')).buildSessionLeaseKey({
        runtime: 'grok-acp',
        cwd: root,
        sessionIdentity: sessionId,
      })
    );

    const transport = {
      runtime: 'grok-acp' as const,
      runningInput: 'unsupported' as const,
      async getState() {
        return { running: false, idle: true, disposed: false };
      },
      async prompt() {},
      async abort() {},
      async dispose() {
        disposeCalls += 1;
      },
      subscribe() {
        return () => undefined;
      },
      getStderr() {
        return '';
      },
    };

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/b',
      }),
      shutdownDisposeBudgetMs: 5_000,
    });
    registry.setHostLinkAppender(() => undefined);

    const regP = registry
      .registerGrokAcpLive({
        runId,
        unitId: 'single',
        hostSessionId: 'host-live',
        transport: transport as never,
        leaseRelease: lease.release,
        launchSpec: {
          agent,
          request: {
            mode: 'single',
            agentScope: 'both',
            agent: 'gagent',
            task: 't',
            runtime: 'grok-acp',
          },
          sessionFile: '',
          sessionArtifact: { runtime: 'grok-acp', sessionId },
          effectiveCwd: root,
          agentScope: 'both',
          registrationKind: 'initial',
        },
        getBranchEntries: () => [],
      })
      .then(
        () => 'ok' as const,
        (e: unknown) => e
      );

    for (let i = 0; i < 80 && !bindingEntered; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(bindingEntered).toBe(true);
    expect(registry._pendingOwnerCount()).toBeGreaterThan(0);

    // Shutdown while binding is gated: must not attach transport after release.
    const shutdownP = registry.shutdown();
    releaseBinding();
    const regResult = await regP;
    expect(regResult).toMatchObject({ code: 'shutdown' });
    await shutdownP;

    // Endpoint must not hold the live transport (no late attach / no zombie grant).
    const ep = registry.getMutable(`${runId}:single`);
    expect(ep).toBeUndefined();
    // Per-transport dispose promise: exactly one dispose() across fail-closed + shutdown.
    expect(disposeCalls).toBe(1);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('concurrent registerGrokAcpLive: single winner, loser disposes once, no client overwrite', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ name: 'gagent', runtime: 'grok-acp' as never, model: 'grok' });
    const sessionId = 'sess-concurrent-live';
    const { runId } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'gagent',
        task: 't',
        runtime: 'grok-acp',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'gagent',
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'running',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
          acpSessionId: sessionId,
        },
      },
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);

    let releaseBinding!: () => void;
    const bindingGate = new Promise<void>((r) => {
      releaseBinding = r;
    });
    let bindingEntered = 0;
    const origPersist = coordinator.persistInteractiveBinding.bind(coordinator);
    coordinator.persistInteractiveBinding = (async (input) => {
      bindingEntered += 1;
      // Gate only the first binder so the second waits on registration serial.
      if (bindingEntered === 1) await bindingGate;
      return origPersist(input);
    }) as typeof coordinator.persistInteractiveBinding;

    const { buildSessionLeaseKey } = await import('../src/session-lease.ts');
    const leaseKey = buildSessionLeaseKey({
      runtime: 'grok-acp',
      cwd: root,
      sessionIdentity: sessionId,
    });

    function makeTransport(label: string) {
      let disposeCalls = 0;
      let leaseReleased = false;
      return {
        label,
        disposeCalls: () => disposeCalls,
        leaseReleased: () => leaseReleased,
        transport: {
          runtime: 'grok-acp' as const,
          runningInput: 'unsupported' as const,
          async getState() {
            return { running: false, idle: true, disposed: false };
          },
          async prompt() {},
          async abort() {},
          async dispose() {
            disposeCalls += 1;
          },
          subscribe() {
            return () => undefined;
          },
          getStderr() {
            return '';
          },
        },
        leaseRelease: (_err?: Error) => {
          leaseReleased = true;
        },
      };
    }

    // Two distinct leases/transports for the same session key — only one may win.
    const a = makeTransport('A');
    const b = makeTransport('B');
    // Real leases would conflict on the same session identity; use synthetic releases
    // so the registry ownership path is under test (dispose + release counts).
    void leaseKey;

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/b',
      }),
      shutdownDisposeBudgetMs: 5_000,
    });
    registry.setHostLinkAppender(() => undefined);

    const launchSpec = {
      agent,
      request: {
        mode: 'single' as const,
        agentScope: 'both' as const,
        agent: 'gagent',
        task: 't',
        runtime: 'grok-acp' as const,
      },
      sessionFile: '',
      sessionArtifact: { runtime: 'grok-acp' as const, sessionId },
      effectiveCwd: root,
      agentScope: 'both' as const,
      registrationKind: 'initial' as const,
    };

    const p1 = registry
      .registerGrokAcpLive({
        runId,
        unitId: 'single',
        hostSessionId: 'host-a',
        transport: a.transport as never,
        leaseRelease: a.leaseRelease,
        launchSpec,
        getBranchEntries: () => [],
      })
      .then(
        (s) => ({ ok: true as const, snap: s, who: 'A' }),
        (e: unknown) => ({ ok: false as const, err: e, who: 'A' })
      );

    for (let i = 0; i < 80 && bindingEntered < 1; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(bindingEntered).toBe(1);

    const p2 = registry
      .registerGrokAcpLive({
        runId,
        unitId: 'single',
        hostSessionId: 'host-b',
        transport: b.transport as never,
        leaseRelease: b.leaseRelease,
        launchSpec,
        getBranchEntries: () => [],
      })
      .then(
        (s) => ({ ok: true as const, snap: s, who: 'B' }),
        (e: unknown) => ({ ok: false as const, err: e, who: 'B' })
      );

    // Let B reserve a newer generation while A is mid-binding, then release A.
    await new Promise((r) => setTimeout(r, 20));
    releaseBinding();
    const [r1, r2] = await Promise.all([p1, p2]);

    const wins = [r1, r2].filter((r) => r.ok);
    const losses = [r1, r2].filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect((losses[0] as { err: { code?: string } }).err).toMatchObject({
      code: 'session_busy',
    });

    const ep = registry.getMutable(`${runId}:single`);
    expect(ep).toBeDefined();
    expect(ep!.client).toBeDefined();
    // Winner's transport is attached; loser never overwrites.
    const winnerWho = (wins[0] as { who: string }).who;
    if (winnerWho === 'A') {
      expect(ep!.client).toBe(a.transport);
      expect(b.disposeCalls()).toBe(1);
      expect(b.leaseReleased()).toBe(true);
      expect(a.disposeCalls()).toBe(0);
    } else {
      expect(ep!.client).toBe(b.transport);
      expect(a.disposeCalls()).toBe(1);
      expect(a.leaseReleased()).toBe(true);
      expect(b.disposeCalls()).toBe(0);
    }

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('concurrent registerGrokAcpLive after live owner: second refuses without attach', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ name: 'gagent', runtime: 'grok-acp' as never, model: 'grok' });
    const sessionId = 'sess-live-owner';
    const { runId } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'gagent',
        task: 't',
        runtime: 'grok-acp',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'gagent',
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'running',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
          acpSessionId: sessionId,
        },
      },
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);

    let disposeB = 0;
    let leaseBReleased = false;
    const transportA = {
      runtime: 'grok-acp' as const,
      runningInput: 'unsupported' as const,
      async getState() {
        return { running: false, idle: true, disposed: false };
      },
      async prompt() {},
      async abort() {},
      async dispose() {},
      subscribe() {
        return () => undefined;
      },
      getStderr() {
        return '';
      },
    };
    const transportB = {
      runtime: 'grok-acp' as const,
      runningInput: 'unsupported' as const,
      async getState() {
        return { running: false, idle: true, disposed: false };
      },
      async prompt() {},
      async abort() {},
      async dispose() {
        disposeB += 1;
      },
      subscribe() {
        return () => undefined;
      },
      getStderr() {
        return '';
      },
    };

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/b',
      }),
    });
    registry.setHostLinkAppender(() => undefined);

    const launchSpec = {
      agent,
      request: {
        mode: 'single' as const,
        agentScope: 'both' as const,
        agent: 'gagent',
        task: 't',
        runtime: 'grok-acp' as const,
      },
      sessionFile: '',
      sessionArtifact: { runtime: 'grok-acp' as const, sessionId },
      effectiveCwd: root,
      agentScope: 'both' as const,
      registrationKind: 'initial' as const,
    };

    const first = await registry.registerGrokAcpLive({
      runId,
      unitId: 'single',
      hostSessionId: 'host-1',
      transport: transportA as never,
      leaseRelease: () => undefined,
      launchSpec,
      getBranchEntries: () => [],
    });
    expect(first.key).toBe(`${runId}:single`);
    expect(registry.getMutable(first.key)?.client).toBe(transportA);

    await expect(
      registry.registerGrokAcpLive({
        runId,
        unitId: 'single',
        hostSessionId: 'host-2',
        transport: transportB as never,
        leaseRelease: () => {
          leaseBReleased = true;
        },
        launchSpec,
        getBranchEntries: () => [],
      })
    ).rejects.toMatchObject({ code: 'session_busy' });

    // Live owner unchanged; loser disposed exactly once and lease released.
    expect(registry.getMutable(first.key)?.client).toBe(transportA);
    expect(disposeB).toBe(1);
    expect(leaseBReleased).toBe(true);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('same-tick concurrent registerGrokAcpLive: acquire-stage loser disposes once and releases lease', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ name: 'gagent', runtime: 'grok-acp' as never, model: 'grok' });
    const sessionId = 'sess-same-tick-acquire';
    const { runId } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'gagent',
        task: 't',
        runtime: 'grok-acp',
      },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'gagent',
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'running',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
          acpSessionId: sessionId,
        },
      },
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);

    function makeTransport(label: string) {
      let disposeCalls = 0;
      let leaseReleased = false;
      return {
        label,
        disposeCalls: () => disposeCalls,
        leaseReleased: () => leaseReleased,
        transport: {
          runtime: 'grok-acp' as const,
          runningInput: 'unsupported' as const,
          async getState() {
            return { running: false, idle: true, disposed: false };
          },
          async prompt() {},
          async abort() {},
          async dispose() {
            disposeCalls += 1;
          },
          subscribe() {
            return () => undefined;
          },
          getStderr() {
            return '';
          },
        },
        leaseRelease: (_err?: Error) => {
          leaseReleased = true;
        },
      };
    }

    const a = makeTransport('A');
    const b = makeTransport('B');

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/b',
      }),
      shutdownDisposeBudgetMs: 5_000,
    });
    registry.setHostLinkAppender(() => undefined);

    const launchSpec = {
      agent,
      request: {
        mode: 'single' as const,
        agentScope: 'both' as const,
        agent: 'gagent',
        task: 't',
        runtime: 'grok-acp' as const,
      },
      sessionFile: '',
      sessionArtifact: { runtime: 'grok-acp' as const, sessionId },
      effectiveCwd: root,
      agentScope: 'both' as const,
      registrationKind: 'initial' as const,
    };

    // Fire both on the same tick so the later reservation supersedes the earlier
    // generation at acquireRegistration (before binding / attach).
    const p1 = registry
      .registerGrokAcpLive({
        runId,
        unitId: 'single',
        hostSessionId: 'host-a',
        transport: a.transport as never,
        leaseRelease: a.leaseRelease,
        launchSpec,
        getBranchEntries: () => [],
      })
      .then(
        (s) => ({ ok: true as const, snap: s, who: 'A' as const }),
        (e: unknown) => ({ ok: false as const, err: e, who: 'A' as const })
      );
    const p2 = registry
      .registerGrokAcpLive({
        runId,
        unitId: 'single',
        hostSessionId: 'host-b',
        transport: b.transport as never,
        leaseRelease: b.leaseRelease,
        launchSpec,
        getBranchEntries: () => [],
      })
      .then(
        (s) => ({ ok: true as const, snap: s, who: 'B' as const }),
        (e: unknown) => ({ ok: false as const, err: e, who: 'B' as const })
      );

    // Pending owners must be visible to shutdown while either registration is in flight.
    expect(registry._pendingOwnerCount()).toBeGreaterThan(0);

    const [r1, r2] = await Promise.all([p1, p2]);
    const wins = [r1, r2].filter((r) => r.ok);
    const losses = [r1, r2].filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    // Loser fails at acquire (superseded) or live-owner gate — both session_busy.
    expect((losses[0] as { err: { code?: string } }).err).toMatchObject({
      code: 'session_busy',
    });

    const loser = (losses[0] as { who: 'A' | 'B' }).who === 'A' ? a : b;
    const winner = (wins[0] as { who: 'A' | 'B' }).who === 'A' ? a : b;
    expect(loser.disposeCalls()).toBe(1);
    expect(loser.leaseReleased()).toBe(true);
    // Winner keeps the attached transport (dispose only on later shutdown).
    expect(winner.disposeCalls()).toBe(0);

    const ep = registry.getMutable(`${runId}:single`);
    expect(ep?.client).toBe(winner.transport);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('shutdown with fixed clock + pending no transport still hits real deadline (no hang)', async () => {
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
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'fixed-clock.jsonl');
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"s","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );

    let releaseFactory!: (t: PiRpcTransport) => void;
    const factoryGate = new Promise<PiRpcTransport>((r) => {
      releaseFactory = r;
    });
    let factoryEntered = false;

    // Fixed clock must not freeze the shutdown deadline (real Date.now used).
    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      clock: () => 1_000_000,
      shutdownDisposeBudgetMs: 80,
      transportFactory: async () => {
        factoryEntered = true;
        // Pending owner holds lease with no transport until factory returns.
        return factoryGate;
      },
    });
    registry.setHostLinkAppender(() => undefined);

    const snap = await registry.registerInitial({
      runId,
      unitId: 'single',
      hostSessionId: 'host-fixed-clock',
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

    const actP = registry.activate(snap.key, 'Task: hang', 'prompt').catch(() => undefined);
    for (let i = 0; i < 80 && !factoryEntered; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(factoryEntered).toBe(true);
    expect(registry._pendingOwnerCount()).toBeGreaterThan(0);

    const t0 = Date.now();
    await expect(registry.shutdown()).rejects.toMatchObject({ code: 'dispose_failed' });
    const elapsed = Date.now() - t0;
    // Real short deadline fires despite fixed clock; must not hang.
    expect(elapsed).toBeLessThan(2_000);
    expect(elapsed).toBeGreaterThanOrEqual(50);

    // Late factory resolve must not hang the test; sticky settle already ran.
    releaseFactory({
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
      async dispose() {},
      getStderr() {
        return '';
      },
    } as unknown as PiRpcTransport);
    await actP;
    await new Promise((r) => setTimeout(r, 20));

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('shutdown clears deadline timer when dispose completes first (no residual active timer)', async () => {
    const { root, store, coordinator } = makeTempStore();
    const agent = makeAgent({ systemPrompt: '' });
    const activeTimers = new Set<unknown>();
    let timerSeq = 0;
    const timers = {
      setTimeout: (fn: () => void, ms?: number) => {
        const id = { id: ++timerSeq, ms };
        activeTimers.add(id);
        const handle = setTimeout(() => {
          activeTimers.delete(id);
          fn();
        }, ms);
        (id as { handle?: ReturnType<typeof setTimeout> }).handle = handle;
        return id;
      },
      clearTimeout: (id: unknown) => {
        activeTimers.delete(id);
        const handle = (id as { handle?: ReturnType<typeof setTimeout> })?.handle;
        if (handle) clearTimeout(handle);
      },
    };

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
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'timer.jsonl');
    await store.updateRun(runId, (r) => {
      r.units.single.sessionFile = sessionFile;
      r.status = 'running';
    });
    const live = store.getRun(runId);
    if (live.ok) coordinator.registerRun(runId, live.loaded.record);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(
      sessionFile,
      '{"type":"session","version":3,"id":"s","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n'
    );

    const registry = createInteractiveAgentRegistry({
      runStore: store,
      runCoordinator: coordinator,
      discoverAgentsFn: () => ({
        agents: [agent],
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
      }),
      shutdownDisposeBudgetMs: 5_500,
      timers,
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
          async abort() {},
          subscribe() {
            return () => undefined;
          },
          async dispose() {
            // Completes immediately — well under the 5.5s budget.
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
      hostSessionId: 'host-timer',
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
    await registry.activate(snap.key, 'Task: quick', 'prompt');

    const t0 = Date.now();
    await registry.shutdown();
    const elapsed = Date.now() - t0;
    // Fast dispose path: well under the absolute budget.
    expect(elapsed).toBeLessThan(500);
    // No residual deadline timer left active after clean shutdown.
    expect(activeTimers.size).toBe(0);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
