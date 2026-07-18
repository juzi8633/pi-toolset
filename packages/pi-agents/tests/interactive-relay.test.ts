// ABOUTME: Tests for the interactive relay coordinator: continuation relay gating and dedup.
// ABOUTME: Uses a fake registry emitter, sendMessage spy, and ctx session-id stub.

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildContinuationMessageContent,
  CONTINUATION_MESSAGE_TYPE,
  createInteractiveRelayCoordinator,
  renderContinuationMessage,
  type InteractiveContinuationDetails,
  type RelayPiApi,
} from '../src/interactive-relay.ts';
import {
  createInteractiveAgentRegistry,
  INTERACTIVE_LINK_TYPE,
  type InteractiveAgentRegistry,
  type InteractiveEndpointSnapshot,
  type InteractiveRegistryEvent,
} from '../src/interactive-agent.ts';
import { createRunCoordinator, agentFingerprint } from '../src/run-coordinator.ts';
import { createRunStore } from '../src/run-store.ts';
import type { AgentConfig } from '../src/agents.ts';
import type { InteractiveAgentLinkV1 } from '../src/run-types.ts';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { PiRpcTransport } from '../src/pi-rpc-transport.ts';
import { INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES } from '../src/constants.ts';

function makeSnapshot(
  overrides: Partial<InteractiveEndpointSnapshot> & {
    key: string;
    hostSessionId: string;
    bindingId: string;
    runId: string;
    unitId: string;
    agent: string;
  }
): InteractiveEndpointSnapshot {
  return {
    status: 'idle',
    messages: [],
    messagesRevision: 0,
    streamRevision: 0,
    streamingMessage: undefined,
    activeTools: [],
    steeringQueue: [],
    followUpQueue: [],
    lastError: undefined,
    errorCode: undefined,
    lastUsedAt: 0,
    createdAt: 0,
    linkCreatedAt: 0,
    usage: {
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
    },
    isCompacting: false,
    isRetrying: false,
    hasTransport: true,
    queueCount: 0,
    worktreePath: undefined,
    title: undefined,
    sessionFile: '/tmp/s.jsonl',
    effectiveCwd: '/tmp',
    ...overrides,
  } as InteractiveEndpointSnapshot;
}

function makeActivation(origin: 'tool_call' | 'view', overrides: Record<string, unknown> = {}) {
  return {
    id: `act_${origin}_${Math.random().toString(36).slice(2, 8)}`,
    endpointKey: 'r:u',
    mode: 'prompt',
    baselineMessageCount: 0,
    sequence: 1,
    origin,
    settled: true,
    createdAt: 0,
    ...overrides,
  };
}

function makeFakeRegistry(visibleKeys: string[] = ['r:u']): {
  emit: (event: InteractiveRegistryEvent) => void;
  visible: Set<string>;
  operable: Set<string>;
  registry: InteractiveAgentRegistry;
  /** Test control: bump the activation generation (simulates a new activation). */
  bumpActivationGeneration: (key: string) => void;
  /** Test control: bump the transport generation (simulates endpoint reopen). */
  bumpTransportGeneration: (key: string) => void;
  /** Test control: remove the endpoint (simulates disappearance). */
  removeEndpoint: (key: string) => void;
  /** Remove then recreate the endpoint with a fresh incarnation (ABA simulation). */
  removeAndRecreate: (key: string) => void;
} {
  const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
  const visible = new Set(visibleKeys);
  /** Track last emitted snapshot per key so get() returns activation info. */
  const snapshots = new Map<string, InteractiveEndpointSnapshot>();
  /** Live endpoint existence + generations for epoch checks. */
  const endpoints = new Map<
    string,
    { transportGeneration: number; activationGeneration: number; endpointIncarnation: number }
  >();
  let nextIncarnation = 1;
  for (const k of visibleKeys)
    endpoints.set(k, {
      transportGeneration: 1,
      activationGeneration: 1,
      endpointIncarnation: nextIncarnation++,
    });
  const reg = {
    emit(event: InteractiveRegistryEvent) {
      if (event.type === 'activation_settled') {
        snapshots.set(event.key, event.snapshot);
      }
      for (const fn of [...listeners]) fn(event);
    },
    get(key: string) {
      const tracked = snapshots.get(key);
      if (tracked) return tracked;
      // Operable snapshot may still be returned for off-branch running units.
      if (!visible.has(key) && !operable.has(key)) return undefined;
      return makeSnapshot({
        key,
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
      });
    },
    getEndpointTransportGeneration(key: string) {
      return endpoints.get(key)?.transportGeneration;
    },
    getEndpointEpoch(key: string) {
      const ep = endpoints.get(key);
      if (!ep) return undefined;
      return {
        endpointIncarnation: ep.endpointIncarnation,
        transportGeneration: ep.transportGeneration,
        activationGeneration: ep.activationGeneration,
      };
    },
    /** True active-branch membership (not merely operable). */
    isOnActiveBranch(key: string) {
      return visible.has(key);
    },
    subscribe(fn: (e: InteractiveRegistryEvent) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  /** Keys still operable (e.g. running) but not on the active branch. */
  const operable = new Set<string>();
  return {
    emit: reg.emit,
    visible,
    operable,
    registry: reg as unknown as InteractiveAgentRegistry,
    bumpActivationGeneration: (key: string) => {
      const ep = endpoints.get(key);
      if (ep) ep.activationGeneration += 1;
    },
    bumpTransportGeneration: (key: string) => {
      const ep = endpoints.get(key);
      if (ep) ep.transportGeneration += 1;
    },
    removeEndpoint: (key: string) => {
      endpoints.delete(key);
      snapshots.delete(key);
    },
    /** Remove then recreate the endpoint with a fresh incarnation. */
    removeAndRecreate: (key: string) => {
      endpoints.delete(key);
      snapshots.delete(key);
      endpoints.set(key, {
        transportGeneration: 1,
        activationGeneration: 1,
        endpointIncarnation: nextIncarnation++,
      });
    },
  };
}

interface SentMessage {
  customType: string;
  content: string;
  display: boolean;
  details: InteractiveContinuationDetails;
  options?: { triggerTurn?: boolean; deliverAs?: string };
}

function makeFakePi() {
  const sent: SentMessage[] = [];
  // Match the Pi Extension API sendMessage signature (loosely typed) so the
  // relay coordinator can call it with a custom message + options.
  const pi = {
    sendMessage(
      message: {
        customType: string;
        content: string | unknown[];
        display: boolean;
        details?: InteractiveContinuationDetails;
      },
      options?: { triggerTurn?: boolean; deliverAs?: string }
    ) {
      sent.push({
        customType: message.customType,
        content: message.content as string,
        display: message.display,
        details: message.details as InteractiveContinuationDetails,
        options,
      });
    },
  };
  return { pi: pi as unknown as RelayPiApi, sent };
}

function makeCtx(sessionId: string): ExtensionContext {
  return {
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
}

function settledEvent(
  key: string,
  activationId: string,
  snap: InteractiveEndpointSnapshot
): InteractiveRegistryEvent {
  return { type: 'activation_settled', key, activationId, snapshot: snap };
}

function snapshotWithActivation(
  base: InteractiveEndpointSnapshot,
  activation: ReturnType<typeof makeActivation> & { id: string },
  messages?: InteractiveEndpointSnapshot['messages']
): InteractiveEndpointSnapshot {
  return {
    ...base,
    activation,
    ...(messages !== undefined ? { messages } : {}),
  } as InteractiveEndpointSnapshot;
}

describe('createInteractiveRelayCoordinator', () => {
  it('relays once when an interrupted tool-call is followed by a view continuation', async () => {
    const registry = makeFakeRegistry();
    const { pi, sent } = makeFakePi();
    const relay = createInteractiveRelayCoordinator({
      registry: registry.registry,
      pi,
      getCtx: () => makeCtx('host-1'),
      now: () => 1000,
    });

    // tool_call activation settles cancelled
    const tcSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'error',
      }),
      makeActivation('tool_call', { id: 'tc-1', terminalOverride: 'cancelled', settled: true })
    );
    registry.emit(settledEvent('r:u', 'tc-1', tcSnap));

    // view activation settles completed with post-baseline output
    const viewSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'idle',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Final answer' }],
          } as never,
        ],
      }),
      makeActivation('view', {
        id: 'v-1',
        baselineMessageCount: 0,
        settled: true,
      })
    );
    registry.emit(settledEvent('r:u', 'v-1', viewSnap));

    await relay.waitForIdle();
    expect(sent.length).toBe(1);
    expect(sent[0]!.customType).toBe(CONTINUATION_MESSAGE_TYPE);
    expect(sent[0]!.details.activationId).toBe('v-1');
    expect(sent[0]!.details.precedingInterrupted).toBe(true);
    expect(sent[0]!.details.output).toBe('Final answer');
    expect(sent[0]!.options?.triggerTurn).toBe(true);
    expect(relay._wasRelayed('v-1')).toBe(true);
    relay.dispose();
  });

  it('does not relay after a normal completed tool-call post-chat', async () => {
    const registry = makeFakeRegistry();
    const { pi, sent } = makeFakePi();
    const relay = createInteractiveRelayCoordinator({
      registry: registry.registry,
      pi,
      getCtx: () => makeCtx('host-1'),
    });

    const tcSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'idle',
      }),
      makeActivation('tool_call', { id: 'tc-ok', settled: true })
    );
    registry.emit(settledEvent('r:u', 'tc-ok', tcSnap));

    const viewSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'idle',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'chat' }] } as never],
      }),
      makeActivation('view', { id: 'v-ok', baselineMessageCount: 0, settled: true })
    );
    registry.emit(settledEvent('r:u', 'v-ok', viewSnap));

    await relay.waitForIdle();
    expect(sent.length).toBe(0);
    expect(relay._wasRelayed('v-ok')).toBe(false);
    relay.dispose();
  });

  it('relays only post-baseline output, not hydrated history', async () => {
    const registry = makeFakeRegistry();
    const { pi, sent } = makeFakePi();
    const relay = createInteractiveRelayCoordinator({
      registry: registry.registry,
      pi,
      getCtx: () => makeCtx('host-1'),
      now: () => 2000,
    });

    const tcSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'error',
      }),
      makeActivation('tool_call', { id: 'tc-2', terminalOverride: 'error', settled: true })
    );
    registry.emit(settledEvent('r:u', 'tc-2', tcSnap));

    // baseline is 2 (two pre-existing messages), final output is the 3rd
    const viewSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'idle',
        messages: [
          { role: 'assistant', content: [{ type: 'text', text: 'old history' }] } as never,
          { role: 'user', content: 'continue' } as never,
          { role: 'assistant', content: [{ type: 'text', text: 'new answer' }] } as never,
        ],
      }),
      makeActivation('view', { id: 'v-2', baselineMessageCount: 2, settled: true })
    );
    registry.emit(settledEvent('r:u', 'v-2', viewSnap));

    await relay.waitForIdle();
    expect(sent.length).toBe(1);
    expect(sent[0]!.details.output).toBe('new answer');
    relay.dispose();
  });

  it('does not relay the same activation twice (exactly-once)', async () => {
    const registry = makeFakeRegistry();
    const { pi, sent } = makeFakePi();
    const relay = createInteractiveRelayCoordinator({
      registry: registry.registry,
      pi,
      getCtx: () => makeCtx('host-1'),
    });

    const tcSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'error',
      }),
      makeActivation('tool_call', { id: 'tc-3', terminalOverride: 'cancelled', settled: true })
    );
    registry.emit(settledEvent('r:u', 'tc-3', tcSnap));

    const viewSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'idle',
      }),
      makeActivation('view', { id: 'v-3', baselineMessageCount: 0, settled: true })
    );
    // Emit the same settle event twice (e.g. duplicate replay).
    registry.emit(settledEvent('r:u', 'v-3', viewSnap));
    registry.emit(settledEvent('r:u', 'v-3', viewSnap));

    await relay.waitForIdle();
    expect(sent.length).toBe(1);
    relay.dispose();
  });

  it('does not relay when host session changed', async () => {
    const registry = makeFakeRegistry();
    const { pi, sent } = makeFakePi();
    let currentSession = 'host-1';
    const relay = createInteractiveRelayCoordinator({
      registry: registry.registry,
      pi,
      getCtx: () => makeCtx(currentSession),
    });

    const tcSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'error',
      }),
      makeActivation('tool_call', { id: 'tc-4', terminalOverride: 'cancelled', settled: true })
    );
    registry.emit(settledEvent('r:u', 'tc-4', tcSnap));

    // Host session switched before the view continuation settled.
    currentSession = 'host-2';
    const viewSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'idle',
      }),
      makeActivation('view', { id: 'v-4', baselineMessageCount: 0, settled: true })
    );
    registry.emit(settledEvent('r:u', 'v-4', viewSnap));

    await relay.waitForIdle();
    expect(sent.length).toBe(0);
    relay.dispose();
  });

  it('does not relay when the endpoint is no longer visible on the active branch', async () => {
    const registry = makeFakeRegistry([]);
    const { pi, sent } = makeFakePi();
    const relay = createInteractiveRelayCoordinator({
      registry: registry.registry,
      pi,
      getCtx: () => makeCtx('host-1'),
    });

    // Record the interrupted tool call while still visible.
    registry.visible.add('r:u');
    const tcSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'error',
      }),
      makeActivation('tool_call', { id: 'tc-5', terminalOverride: 'cancelled', settled: true })
    );
    registry.emit(settledEvent('r:u', 'tc-5', tcSnap));

    // Tree navigated away: still operable (running) but not on the active branch.
    registry.visible.delete('r:u');
    registry.operable.add('r:u');
    expect(registry.registry.get('r:u')).toBeDefined();
    expect(registry.registry.isOnActiveBranch('r:u')).toBe(false);
    const viewSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'idle',
      }),
      makeActivation('view', { id: 'v-5', baselineMessageCount: 0, settled: true })
    );
    registry.emit(settledEvent('r:u', 'v-5', viewSnap));

    await relay.waitForIdle();
    expect(sent.length).toBe(0);
    relay.dispose();
  });

  it('relays failed/cancelled continuations even with no output text', async () => {
    const registry = makeFakeRegistry();
    const { pi, sent } = makeFakePi();
    const relay = createInteractiveRelayCoordinator({
      registry: registry.registry,
      pi,
      getCtx: () => makeCtx('host-1'),
      now: () => 3000,
    });

    const tcSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'error',
      }),
      makeActivation('tool_call', { id: 'tc-6', terminalOverride: 'error', settled: true })
    );
    registry.emit(settledEvent('r:u', 'tc-6', tcSnap));

    const viewSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'error',
      }),
      makeActivation('view', {
        id: 'v-6',
        baselineMessageCount: 0,
        terminalOverride: 'error',
        error: 'transport crashed',
        settled: true,
      })
    );
    registry.emit(settledEvent('r:u', 'v-6', viewSnap));

    await relay.waitForIdle();
    expect(sent.length).toBe(1);
    expect(sent[0]!.details.status).toBe('error');
    expect(sent[0]!.details.output).toBe('');
    expect(sent[0]!.details.error).toBe('transport crashed');
    expect(sent[0]!.content).toContain('no final text');
    relay.dispose();
  });

  it('view send does not block: relay observes settle independently', async () => {
    const registry = makeFakeRegistry();
    const { pi, sent } = makeFakePi();
    const relay = createInteractiveRelayCoordinator({
      registry: registry.registry,
      pi,
      getCtx: () => makeCtx('host-1'),
    });

    const tcSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'error',
      }),
      makeActivation('tool_call', { id: 'tc-7', terminalOverride: 'cancelled', settled: true })
    );
    registry.emit(settledEvent('r:u', 'tc-7', tcSnap));

    // The view activation is settled synchronously right after a send; the relay
    // must process it without the send path awaiting it.
    const viewSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'idle',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] } as never],
      }),
      makeActivation('view', { id: 'v-7', baselineMessageCount: 0, settled: true })
    );
    registry.emit(settledEvent('r:u', 'v-7', viewSnap));

    await relay.waitForIdle();
    expect(sent.length).toBe(1);
    relay.dispose();
  });

  it('a new tool_call activation clears the interrupted gate', async () => {
    const registry = makeFakeRegistry();
    const { pi, sent } = makeFakePi();
    const relay = createInteractiveRelayCoordinator({
      registry: registry.registry,
      pi,
      getCtx: () => makeCtx('host-1'),
    });

    // First an interrupted tool call.
    const tcSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'error',
      }),
      makeActivation('tool_call', { id: 'tc-8', terminalOverride: 'cancelled', settled: true })
    );
    registry.emit(settledEvent('r:u', 'tc-8', tcSnap));

    // A new tool_call starts and completes normally — clears the gate.
    const tcSnap2 = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'idle',
      }),
      makeActivation('tool_call', { id: 'tc-9', settled: true })
    );
    registry.emit(settledEvent('r:u', 'tc-9', tcSnap2));

    // Subsequent view continuation should NOT relay.
    const viewSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'idle',
      }),
      makeActivation('view', { id: 'v-8', baselineMessageCount: 0, settled: true })
    );
    registry.emit(settledEvent('r:u', 'v-8', viewSnap));

    await relay.waitForIdle();
    expect(sent.length).toBe(0);
    relay.dispose();
  });
});

describe('createInteractiveRelayCoordinator monotonic epoch after artifact I/O', () => {
  /**
   * Fake runStore whose writeTextArtifact blocks on a gate the test releases,
   * simulating a slow artifact spill so the epoch can change mid-I/O.
   */
  function makeGatedRunStore() {
    let gateResolve: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      gateResolve = resolve;
    });
    const store = {
      async writeTextArtifact(
        _runId: string,
        _payload: string,
        _text: string
      ): Promise<import('../src/run-types.ts').RunArtifactRefV1> {
        await gate;
        return {
          kind: 'run-artifact',
          version: 1,
          runId: 'r',
          payload: 'interactive-continuation',
          relativePath: 'artifacts/sha256/aa/aaaaaaaa.json',
          sha256: 'a'.repeat(64),
          bytes: 1024,
          mediaType: 'text/plain; charset=utf-8',
        };
      },
    };
    return {
      store: store as unknown as import('../src/run-store.ts').RunStore,
      release: () => gateResolve?.(),
    };
  }

  function armInterruptedToolCall(registry: ReturnType<typeof makeFakeRegistry>) {
    const tcSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'error',
      }),
      makeActivation('tool_call', { id: 'tc-epoch', terminalOverride: 'cancelled', settled: true })
    );
    registry.emit(settledEvent('r:u', 'tc-epoch', tcSnap));
  }

  function emitOversizedView(registry: ReturnType<typeof makeFakeRegistry>, id = 'v-epoch') {
    // Oversized output forces a real spill await in buildContinuationMessageContent.
    const big = 'z'.repeat(300 * 1024);
    const viewSnap = snapshotWithActivation(
      makeSnapshot({
        key: 'r:u',
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'idle',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: big }],
          } as never,
        ],
      }),
      makeActivation('view', { id, baselineMessageCount: 0, settled: true })
    );
    registry.emit(settledEvent('r:u', id, viewSnap));
  }

  it('suppresses when a newer activation starts and remains active during spill I/O', async () => {
    const registry = makeFakeRegistry();
    const { pi, sent } = makeFakePi();
    const { store, release } = makeGatedRunStore();
    const suppressed: string[] = [];
    const relay = createInteractiveRelayCoordinator({
      registry: registry.registry,
      pi,
      getCtx: () => makeCtx('host-1'),
      runStore: store,
      onSuppressed: (reason) => suppressed.push(reason),
    });
    armInterruptedToolCall(registry);
    emitOversizedView(registry);
    // While spill I/O is blocked, a newer activation starts (generation bumps).
    registry.bumpActivationGeneration('r:u');
    release();
    await relay.waitForIdle();
    expect(sent.length).toBe(0);
    expect(suppressed).toContain('epoch_changed_after_io');
    relay.dispose();
  });

  it('suppresses when a newer activation starts then settles/clears during spill I/O', async () => {
    const registry = makeFakeRegistry();
    const { pi, sent } = makeFakePi();
    const { store, release } = makeGatedRunStore();
    const suppressed: string[] = [];
    const relay = createInteractiveRelayCoordinator({
      registry: registry.registry,
      pi,
      getCtx: () => makeCtx('host-1'),
      runStore: store,
      onSuppressed: (reason) => suppressed.push(reason),
    });
    armInterruptedToolCall(registry);
    emitOversizedView(registry);
    // Newer activation starts then settles; activationGeneration stays bumped.
    registry.bumpActivationGeneration('r:u');
    release();
    await relay.waitForIdle();
    expect(sent.length).toBe(0);
    expect(suppressed).toContain('epoch_changed_after_io');
    relay.dispose();
  });

  it('suppresses when the endpoint reopens (transport generation changes) during spill I/O', async () => {
    const registry = makeFakeRegistry();
    const { pi, sent } = makeFakePi();
    const { store, release } = makeGatedRunStore();
    const suppressed: string[] = [];
    const relay = createInteractiveRelayCoordinator({
      registry: registry.registry,
      pi,
      getCtx: () => makeCtx('host-1'),
      runStore: store,
      onSuppressed: (reason) => suppressed.push(reason),
    });
    armInterruptedToolCall(registry);
    emitOversizedView(registry);
    registry.bumpTransportGeneration('r:u');
    release();
    await relay.waitForIdle();
    expect(sent.length).toBe(0);
    expect(suppressed).toContain('epoch_changed_after_io');
    relay.dispose();
  });

  it('suppresses when the endpoint disappears during spill I/O', async () => {
    const registry = makeFakeRegistry();
    const { pi, sent } = makeFakePi();
    const { store, release } = makeGatedRunStore();
    const suppressed: string[] = [];
    const relay = createInteractiveRelayCoordinator({
      registry: registry.registry,
      pi,
      getCtx: () => makeCtx('host-1'),
      runStore: store,
      onSuppressed: (reason) => suppressed.push(reason),
    });
    armInterruptedToolCall(registry);
    emitOversizedView(registry);
    registry.removeEndpoint('r:u');
    release();
    await relay.waitForIdle();
    expect(sent.length).toBe(0);
    expect(suppressed).toContain('epoch_changed_after_io');
    relay.dispose();
  });

  it('sends once when the epoch is unchanged across spill I/O', async () => {
    const registry = makeFakeRegistry();
    const { pi, sent } = makeFakePi();
    const { store, release } = makeGatedRunStore();
    const relay = createInteractiveRelayCoordinator({
      registry: registry.registry,
      pi,
      getCtx: () => makeCtx('host-1'),
      runStore: store,
    });
    armInterruptedToolCall(registry);
    emitOversizedView(registry);
    release();
    await relay.waitForIdle();
    expect(sent.length).toBe(1);
    expect(sent[0]!.details.activationId).toBe('v-epoch');
    relay.dispose();
  });

  it('suppresses when endpoint is removed and recreated during spill I/O (ABA incarnation)', async () => {
    const registry = makeFakeRegistry();
    const { pi, sent } = makeFakePi();
    const { store, release } = makeGatedRunStore();
    const suppressed: string[] = [];
    const relay = createInteractiveRelayCoordinator({
      registry: registry.registry,
      pi,
      getCtx: () => makeCtx('host-1'),
      runStore: store,
      onSuppressed: (reason) => suppressed.push(reason),
    });
    armInterruptedToolCall(registry);
    emitOversizedView(registry);
    // Remove and recreate: transport/activation values cycle back to 1 but
    // incarnation is fresh. Old continuation must be suppressed.
    registry.removeAndRecreate('r:u');
    release();
    await relay.waitForIdle();
    expect(sent.length).toBe(0);
    expect(suppressed).toContain('epoch_changed_after_io');
    relay.dispose();
  });

  it('suppresses when transport/activation reach same values but incarnation differs (ABA control)', async () => {
    // Simulate the ABA window where transport + activation both reach the same
    // numeric values as the captured relay epoch after a remove/recreate.
    const registry = makeFakeRegistry();
    const { pi, sent } = makeFakePi();
    const { store, release } = makeGatedRunStore();
    const suppressed: string[] = [];
    const relay = createInteractiveRelayCoordinator({
      registry: registry.registry,
      pi,
      getCtx: () => makeCtx('host-1'),
      runStore: store,
      onSuppressed: (reason) => suppressed.push(reason),
    });
    armInterruptedToolCall(registry);
    emitOversizedView(registry);
    // Remove endpoint so transportGeneration + activationGeneration reset to 1.
    registry.removeAndRecreate('r:u');
    // Bump activation to match the original epoch's value (1).
    // Now incarnation alone differs — must suppress.
    release();
    await relay.waitForIdle();
    expect(sent.length).toBe(0);
    expect(suppressed).toContain('epoch_changed_after_io');
    relay.dispose();
  });
});

describe('buildContinuationMessageContent', () => {
  it('marks the message as an interactive continuation with agent/run/unit identity', async () => {
    const snap = makeSnapshot({
      key: 'r:u',
      hostSessionId: 'host-1',
      bindingId: 'b-1',
      runId: 'run-xyz',
      unitId: 'unit-1',
      agent: 'explore',
      status: 'idle',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'result text' }] } as never],
    });
    const activation = makeActivation('view', { id: 'v-x', baselineMessageCount: 0 });
    const snapWithAct = { ...snap, activation } as InteractiveEndpointSnapshot;
    const { content, details } = await buildContinuationMessageContent(
      snapWithAct,
      0,
      'completed',
      true,
      () => 5000
    );
    expect(content).toContain('<pi-agents-continuation');
    expect(content).toContain('agent="explore"');
    expect(content).toContain('runId="run-xyz"');
    expect(content).toContain('unitId="unit-1"');
    expect(content).toContain('precedingInterrupted="true"');
    expect(content).toContain('<output>\nresult text\n</output>');
    expect(details.agent).toBe('explore');
    expect(details.runId).toBe('run-xyz');
    expect(details.unitId).toBe('unit-1');
    expect(details.output).toBe('result text');
    expect(details.precedingInterrupted).toBe(true);
    expect(details.activationId).toBe('v-x');
  });
});

describe('renderContinuationMessage', () => {
  function fakeTheme(): Theme {
    return {
      bold: (t: string) => t,
      fg: (_c: string, t: string) => t,
    } as unknown as Theme;
  }

  it('renders a collapsed row with status and output preview', () => {
    const details: InteractiveContinuationDetails = {
      runId: 'run-1',
      unitId: 'u',
      agent: 'explore',
      endpointKey: 'r:u',
      activationId: 'v-1',
      status: 'completed',
      output: 'First line\nsecond line',
      precedingInterrupted: true,
      relayedAt: 100,
    };
    const comp = renderContinuationMessage(
      { details, content: '' },
      { expanded: false },
      fakeTheme()
    );
    const lines = comp.render!(80);
    expect(lines.join('\n')).toContain('interactive continuation');
    expect(lines.join('\n')).toContain('explore');
    expect(lines.join('\n')).toContain('First line');
  });

  it('renders without crashing when details are missing', () => {
    const comp = renderContinuationMessage({}, { expanded: false }, fakeTheme());
    const lines = comp.render!(80);
    expect(lines.join('\n')).toContain('no details');
  });
});

describe('relay binding-scoped gate', () => {
  it('B1 gate is not consumed by B2 activation with a different bindingId', async () => {
    const key = 'run-bind:u';
    const suppressed: string[] = [];
    const registry = makeFakeRegistry([key]);
    const { pi, sent } = makeFakePi();
    const relay = createInteractiveRelayCoordinator({
      registry: registry.registry,
      pi,
      getCtx: () => makeCtx('host-1'),
      onSuppressed: (reason) => suppressed.push(reason),
    });

    const baseB1 = makeSnapshot({
      key,
      bindingId: 'b-1',
      hostSessionId: 'host-1',
      runId: 'run-bind',
      unitId: 'u',
      agent: 'explore',
      status: 'error',
    });
    const tcB1 = makeActivation('tool_call', {
      id: 'tc-b1',
      endpointKey: key,
      terminalOverride: 'cancelled',
    });
    registry.emit(settledEvent(key, tcB1.id, snapshotWithActivation(baseB1, tcB1)));
    expect(relay._hasRecordedTerminal(key)).toBe(true);

    // B2 view settle under a new binding must not relay.
    const baseB2 = makeSnapshot({
      key,
      bindingId: 'b-2',
      hostSessionId: 'host-1',
      runId: 'run-bind',
      unitId: 'u',
      agent: 'explore',
      status: 'idle',
    });
    const vB2 = makeActivation('view', { id: 'v-b2', endpointKey: key, baselineMessageCount: 0 });
    registry.emit(
      settledEvent(
        key,
        vB2.id,
        snapshotWithActivation(baseB2, vB2, [
          { role: 'assistant', content: [{ type: 'text', text: 'cross-binding' }] } as never,
        ])
      )
    );
    await relay.waitForIdle();
    expect(sent).toHaveLength(0);
    expect(relay._wasRelayed('v-b2')).toBe(false);
    expect(suppressed).toContain('binding_mismatch');
    expect(relay._hasRecordedTerminal(key)).toBe(false);

    // B2 new host tool terminal re-arms; same-binding view relays.
    const tcB2 = makeActivation('tool_call', {
      id: 'tc-b2',
      endpointKey: key,
      terminalOverride: 'error',
      error: 'boom',
      baselineMessageCount: 1,
    });
    registry.emit(
      settledEvent(key, tcB2.id, snapshotWithActivation({ ...baseB2, status: 'error' }, tcB2))
    );
    expect(relay._hasRecordedTerminal(key)).toBe(true);

    const vOk = makeActivation('view', {
      id: 'v-b2-ok',
      endpointKey: key,
      baselineMessageCount: 1,
    });
    registry.emit(
      settledEvent(
        key,
        vOk.id,
        snapshotWithActivation(baseB2, vOk, [
          { role: 'assistant', content: [{ type: 'text', text: 'same-binding cont' }] } as never,
        ])
      )
    );
    await relay.waitForIdle();
    expect(sent).toHaveLength(1);
    expect(relay._wasRelayed('v-b2-ok')).toBe(true);
    expect(relay._hasRecordedTerminal(key)).toBe(false);

    relay.dispose();
  });

  it('clears retained maps on endpoints_changed and shutdown', () => {
    const key = 'run-prune:u';
    const registry = makeFakeRegistry([key]);
    const { pi } = makeFakePi();
    const relay = createInteractiveRelayCoordinator({
      registry: registry.registry,
      pi,
      getCtx: () => makeCtx('host-1'),
    });

    const base = makeSnapshot({
      key,
      bindingId: 'b-1',
      hostSessionId: 'host-1',
      runId: 'run-prune',
      unitId: 'u',
      agent: 'explore',
      status: 'error',
    });
    const tc = makeActivation('tool_call', {
      id: 'tc-p',
      endpointKey: key,
      terminalOverride: 'cancelled',
    });
    registry.emit(settledEvent(key, tc.id, snapshotWithActivation(base, tc)));
    expect(relay._hasRecordedTerminal(key)).toBe(true);
    expect(relay._gateSize()).toBe(1);

    registry.emit({ type: 'endpoints_changed', keys: [] });
    expect(relay._hasRecordedTerminal(key)).toBe(false);
    expect(relay._gateSize()).toBe(0);

    registry.emit(settledEvent(key, tc.id, snapshotWithActivation(base, tc)));
    expect(relay._gateSize()).toBe(1);
    registry.emit({ type: 'shutdown' });
    expect(relay._gateSize()).toBe(0);
    expect(relay._relayedSize()).toBe(0);

    relay.dispose();
  });
});

describe('relay continuation gate consumption (V1/V2)', () => {
  it('consumes lastToolCallTerminal after successful V1 relay so V2 does not re-trigger host', async () => {
    const registry = makeFakeRegistry();
    const { pi, sent } = makeFakePi();
    const relay = createInteractiveRelayCoordinator({
      registry: registry.registry,
      pi,
      getCtx: () => makeCtx('host-1'),
      now: () => 1000,
    });

    const key = 'r:u';
    const tcSnap = snapshotWithActivation(
      makeSnapshot({
        key,
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'error',
      }),
      makeActivation('tool_call', {
        id: 'tc-gate',
        terminalOverride: 'cancelled',
        settled: true,
      })
    );
    registry.emit(settledEvent(key, 'tc-gate', tcSnap));
    expect(relay._hasRecordedTerminal(key)).toBe(true);

    const v1 = snapshotWithActivation(
      makeSnapshot({
        key,
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'idle',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'V1' }] } as never],
      }),
      makeActivation('view', { id: 'v1', baselineMessageCount: 0, settled: true })
    );
    registry.emit(settledEvent(key, 'v1', v1));
    await relay.waitForIdle();
    expect(sent.length).toBe(1);
    expect(sent[0]!.details.activationId).toBe('v1');
    expect(relay._hasRecordedTerminal(key)).toBe(false);

    // Different view activation must not re-fire without a new tool_call terminal.
    const v2 = snapshotWithActivation(
      makeSnapshot({
        key,
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'idle',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'V2' }] } as never],
      }),
      makeActivation('view', { id: 'v2', baselineMessageCount: 0, settled: true })
    );
    registry.emit(settledEvent(key, 'v2', v2));
    await relay.waitForIdle();
    expect(sent.length).toBe(1);
    expect(relay._wasRelayed('v2')).toBe(false);

    // New interrupted tool_call re-arms the gate for a later view.
    registry.emit(
      settledEvent(
        key,
        'tc-gate-2',
        snapshotWithActivation(
          makeSnapshot({
            key,
            hostSessionId: 'host-1',
            bindingId: 'b-1',
            runId: 'r',
            unitId: 'u',
            agent: 'explore',
            status: 'error',
          }),
          makeActivation('tool_call', {
            id: 'tc-gate-2',
            terminalOverride: 'error',
            settled: true,
          })
        )
      )
    );
    expect(relay._hasRecordedTerminal(key)).toBe(true);
    const v3 = snapshotWithActivation(
      makeSnapshot({
        key,
        hostSessionId: 'host-1',
        bindingId: 'b-1',
        runId: 'r',
        unitId: 'u',
        agent: 'explore',
        status: 'idle',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'V3' }] } as never],
      }),
      makeActivation('view', { id: 'v3', baselineMessageCount: 0, settled: true })
    );
    registry.emit(settledEvent(key, 'v3', v3));
    await relay.waitForIdle();
    expect(sent.length).toBe(2);
    expect(sent[1]!.details.activationId).toBe('v3');

    relay.dispose();
  });
});

describe('relay + real registry branchKeys path', () => {
  it('suppresses settle injection when tree navigates away (isOnActiveBranch false)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-relay-branch-'));
    const store = createRunStore({ rootDir: root });
    const coordinator = createRunCoordinator({ store });
    const agent: AgentConfig = {
      name: 'explore',
      description: 'test',
      systemPrompt: 'You explore.',
      source: 'user',
      filePath: '/tmp/explore.md',
    };

    let eventListener: ((e: unknown) => void) | undefined;
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
      transportFactory: async () => transport,
    });
    registry.setHostLinkAppender(() => undefined);

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: { mode: 'single', agentScope: 'both', agent: 'explore', task: 'look' },
      details: {
        mode: 'single',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        results: [],
      },
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
      hostSessionId: 'host-relay-branch',
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

    const { pi, sent } = makeFakePi();
    const suppressed: string[] = [];
    const relay = createInteractiveRelayCoordinator({
      registry,
      pi,
      getCtx: () => makeCtx('host-relay-branch'),
      onSuppressed: (reason) => suppressed.push(reason),
    });

    expect(registry.isOnActiveBranch(snap.key)).toBe(true);

    // Interrupted tool_call while on branch — records gate.
    await registry.activate(snap.key, 'Task: tc', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    eventListener?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));
    await registry.abort(snap.key);
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    expect(relay._hasRecordedTerminal(snap.key)).toBe(true);

    // Start view continuation while still on branch, keep it running.
    await registry.activate(snap.key, 'continue', 'prompt', undefined, 'view');
    await new Promise((r) => setImmediate(r));
    eventListener?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));
    expect(registry.get(snap.key)?.status).toBe('running');
    expect(registry.get(snap.key)?.activation?.origin).toBe('view');

    // Tree navigates away while still running: branchKeys cleared, endpoint stays operable.
    registry.restoreActiveBranch({
      sessionManager: {
        getSessionId: () => 'host-relay-branch',
        getBranch: () => [],
      },
      cwd: root,
    } as never);
    expect(registry.isOnActiveBranch(snap.key)).toBe(false);
    expect(registry.get(snap.key)?.status).toBe('running');
    expect(registry.listVisible().some((e) => e.key === snap.key)).toBe(true);

    // View settles off-branch — must not inject into the new tree.
    eventListener?.({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'off-branch' }] },
    });
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));

    await relay.waitForIdle();
    expect(sent.length).toBe(0);
    expect(suppressed).toContain('branch_not_visible');
    // Off-branch suppress consumes the tool-call gate — return must re-arm.
    expect(relay._hasRecordedTerminal(snap.key)).toBe(false);

    // Restore original branch; next view activation must not inherit the gate.
    const link: InteractiveAgentLinkV1 = {
      version: 1,
      runId,
      unitId: 'single',
      bindingId: snap.bindingId,
      hostSessionId: 'host-relay-branch',
      createdAt: snap.linkCreatedAt,
    };
    // Persist binding so resolveTrusted succeeds on restore.
    const loaded = store.getRun(runId);
    if (loaded.ok) {
      await store.updateRun(runId, (r) => {
        const unit = r.units.single;
        if (!unit.interactiveBindings) unit.interactiveBindings = {};
        unit.interactiveBindings[snap.bindingId] = {
          bindingId: snap.bindingId,
          hostSessionId: 'host-relay-branch',
          createdAt: snap.linkCreatedAt,
        };
      });
    }
    registry.restoreActiveBranch({
      sessionManager: {
        getSessionId: () => 'host-relay-branch',
        getBranch: () => [{ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: link }],
      },
      cwd: root,
    } as never);
    expect(registry.isOnActiveBranch(snap.key)).toBe(true);

    await registry.activate(snap.key, 'continue-2', 'prompt', undefined, 'view');
    await new Promise((r) => setImmediate(r));
    eventListener?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));
    eventListener?.({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'on-branch-again' }] },
    });
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    await relay.waitForIdle();
    expect(sent.length).toBe(0);

    // New tool_call terminal re-arms the gate.
    await registry.activate(snap.key, 'Task: rearm', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    eventListener?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));
    await registry.abort(snap.key);
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    expect(relay._hasRecordedTerminal(snap.key)).toBe(true);

    relay.dispose();
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('forged tree revokes trusted membership before settle; no relay until legal binding restored', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-relay-forge-'));
    const store = createRunStore({ rootDir: root });
    const coordinator = createRunCoordinator({ store });
    const agent: AgentConfig = {
      name: 'explore',
      description: 'test',
      systemPrompt: 'You explore.',
      source: 'user',
      filePath: '/tmp/explore.md',
    };

    let eventListener: ((e: unknown) => void) | undefined;
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
      transportFactory: async () => transport,
    });
    registry.setHostLinkAppender(() => undefined);

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: { mode: 'single', agentScope: 'both', agent: 'explore', task: 'look' },
      details: {
        mode: 'single',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        results: [],
      },
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
      hostSessionId: 'host-forge',
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
    expect(registry.isOnActiveBranch(snap.key)).toBe(true);

    const { pi, sent } = makeFakePi();
    const suppressed: string[] = [];
    const relay = createInteractiveRelayCoordinator({
      registry,
      pi,
      getCtx: () => makeCtx('host-forge'),
      onSuppressed: (reason) => suppressed.push(reason),
    });

    // Interrupted tool_call (B1 gate) while running with trusted B1.
    await registry.activate(snap.key, 'Task: tc', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    eventListener?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));
    await registry.abort(snap.key);
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    expect(relay._hasRecordedTerminal(snap.key)).toBe(true);

    // Start view continuation on trusted B1.
    await registry.activate(snap.key, 'continue', 'prompt', undefined, 'view');
    await new Promise((r) => setImmediate(r));
    eventListener?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));

    // Tree to same key forged B2 (wrong host) — must revoke trust before settle.
    const forged = {
      version: 1 as const,
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
    expect(registry.isOnActiveBranch(snap.key)).toBe(false);
    // applyUnavailable settles the open activation while untrusted — no relay.
    await new Promise((r) => setImmediate(r));
    await relay.waitForIdle();
    expect(sent.length).toBe(0);

    // Late settle from transport must not relay either.
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    await relay.waitForIdle();
    expect(sent.length).toBe(0);

    // Restore legal B1 binding on original host — trust returns.
    const legal = {
      version: 1 as const,
      runId,
      unitId: 'single',
      bindingId: snap.bindingId,
      hostSessionId: 'host-forge',
      createdAt: snap.linkCreatedAt,
    };
    await store.updateRun(runId, (r) => {
      const unit = r.units.single;
      if (!unit.interactiveBindings) unit.interactiveBindings = {};
      unit.interactiveBindings[snap.bindingId] = {
        bindingId: snap.bindingId,
        hostSessionId: 'host-forge',
        createdAt: snap.linkCreatedAt,
      };
    });
    registry.restoreActiveBranch({
      sessionManager: {
        getSessionId: () => 'host-forge',
        getBranch: () => [{ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: legal }],
      },
      cwd: root,
    } as never);
    // Forged settle may have consumed gate; re-arm with new interrupted tool_call.
    expect(registry.isOnActiveBranch(snap.key)).toBe(true);

    await registry.activate(snap.key, 'Task: rearm', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    eventListener?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));
    await registry.abort(snap.key);
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    expect(relay._hasRecordedTerminal(snap.key)).toBe(true);

    await registry.activate(snap.key, 'continue-legal', 'prompt', undefined, 'view');
    await new Promise((r) => setImmediate(r));
    eventListener?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));
    eventListener?.({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'legal-continue' }] },
    });
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));

    await relay.waitForIdle();
    expect(sent.length).toBe(1);
    expect(sent[0]!.details.output).toContain('legal-continue');

    relay.dispose();
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('live getBranch switch without restoreActiveBranch fail-closes relay; re-gate works after legal branch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-relay-live-branch-'));
    const store = createRunStore({ rootDir: root });
    const coordinator = createRunCoordinator({ store });
    const agent: AgentConfig = {
      name: 'explore',
      description: 'test',
      systemPrompt: 'You explore.',
      source: 'user',
      filePath: '/tmp/explore.md',
    };

    let eventListener: ((e: unknown) => void) | undefined;
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
      transportFactory: async () => transport,
    });
    registry.setHostLinkAppender(() => undefined);

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: { mode: 'single', agentScope: 'both', agent: 'explore', task: 'look' },
      details: {
        mode: 'single',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        results: [],
      },
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
      hostSessionId: 'host-live-branch',
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

    const legalLink: InteractiveAgentLinkV1 = {
      version: 1,
      runId,
      unitId: 'single',
      bindingId: snap.bindingId,
      hostSessionId: 'host-live-branch',
      createdAt: snap.linkCreatedAt,
    };
    const forgedLink: InteractiveAgentLinkV1 = {
      version: 1,
      runId,
      unitId: 'single',
      bindingId: snap.bindingId,
      hostSessionId: 'forged-other-host',
      createdAt: snap.linkCreatedAt,
    };

    // Mutable live branch used by getCtx — intentionally NOT mirrored via restoreActiveBranch.
    let branchEntries: Array<{ type: string; customType?: string; data?: unknown }> = [
      { type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: legalLink },
    ];
    // Seed registry trust so isOnActiveBranch stays true while live branch diverges.
    registry.restoreActiveBranch({
      sessionManager: {
        getSessionId: () => 'host-live-branch',
        getBranch: () => branchEntries,
      },
      cwd: root,
    } as never);
    expect(registry.isOnActiveBranch(snap.key)).toBe(true);

    const { pi, sent } = makeFakePi();
    const suppressed: string[] = [];
    const relay = createInteractiveRelayCoordinator({
      registry,
      pi,
      getCtx: () =>
        ({
          sessionManager: {
            getSessionId: () => 'host-live-branch',
            getBranch: () => branchEntries,
          },
        }) as unknown as ExtensionContext,
      onSuppressed: (reason) => suppressed.push(reason),
    });

    // Arm gate with interrupted tool_call.
    await registry.activate(snap.key, 'Task: tc', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    eventListener?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));
    await registry.abort(snap.key);
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    expect(relay._hasRecordedTerminal(snap.key)).toBe(true);

    // View continuation while registry still trusts the endpoint.
    await registry.activate(snap.key, 'continue', 'prompt', undefined, 'view');
    await new Promise((r) => setImmediate(r));
    eventListener?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));

    // Real branch switches to empty (no restoreActiveBranch) — cached trust remains.
    branchEntries = [];
    expect(registry.isOnActiveBranch(snap.key)).toBe(true);

    eventListener?.({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'should-not-relay' }] },
    });
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    await relay.waitForIdle();
    expect(sent.length).toBe(0);
    expect(suppressed).toContain('branch_link_mismatch');

    // Forged link on live branch also fail-closes (still no restoreActiveBranch).
    suppressed.length = 0;
    branchEntries = [{ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: forgedLink }];
    // Re-arm gate.
    await registry.activate(snap.key, 'Task: rearm-forged', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    eventListener?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));
    await registry.abort(snap.key);
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));

    await registry.activate(snap.key, 'continue-forged', 'prompt', undefined, 'view');
    await new Promise((r) => setImmediate(r));
    eventListener?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));
    eventListener?.({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'forged-out' }] },
    });
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    await relay.waitForIdle();
    expect(sent.length).toBe(0);
    expect(suppressed).toContain('branch_link_mismatch');

    // Legal branch + restore trust + re-gate → relay succeeds.
    branchEntries = [{ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: legalLink }];
    await store.updateRun(runId, (r) => {
      const unit = r.units.single;
      if (!unit.interactiveBindings) unit.interactiveBindings = {};
      unit.interactiveBindings[snap.bindingId] = {
        bindingId: snap.bindingId,
        hostSessionId: 'host-live-branch',
        createdAt: snap.linkCreatedAt,
      };
    });
    registry.restoreActiveBranch({
      sessionManager: {
        getSessionId: () => 'host-live-branch',
        getBranch: () => branchEntries,
      },
      cwd: root,
    } as never);
    expect(registry.isOnActiveBranch(snap.key)).toBe(true);

    await registry.activate(snap.key, 'Task: rearm-legal', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    eventListener?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));
    await registry.abort(snap.key);
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));

    await registry.activate(snap.key, 'continue-legal', 'prompt', undefined, 'view');
    await new Promise((r) => setImmediate(r));
    eventListener?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));
    eventListener?.({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'live-branch-ok' }] },
    });
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));

    await relay.waitForIdle();
    expect(sent.length).toBe(1);
    expect(sent[0]!.details.output).toContain('live-branch-ok');

    relay.dispose();
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('live branch link requires version/createdAt/host context exact match; forged fields do not relay', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-relay-link-full-'));
    const store = createRunStore({ rootDir: root });
    const coordinator = createRunCoordinator({ store });
    const agent: AgentConfig = {
      name: 'explore',
      description: 'test',
      systemPrompt: '',
      source: 'user',
      filePath: '/tmp/explore.md',
    };
    let eventListener: ((e: unknown) => void) | undefined;
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
        }) as unknown as PiRpcTransport,
    });
    registry.setHostLinkAppender(() => undefined);

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: { mode: 'single', agentScope: 'both', agent: 'explore', task: 'look' },
      details: {
        mode: 'single',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        results: [],
      },
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
      hostSessionId: 'host-link-full',
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

    const legalLink: InteractiveAgentLinkV1 = {
      version: 1,
      runId,
      unitId: 'single',
      bindingId: snap.bindingId,
      hostSessionId: 'host-link-full',
      createdAt: snap.linkCreatedAt,
    };
    const wrongVersion = { ...legalLink, version: 2 };
    const wrongCreatedAt = { ...legalLink, createdAt: snap.linkCreatedAt + 999 };
    const copiedToOtherHost = {
      ...legalLink,
      hostSessionId: 'other-host-session',
    };

    let branchEntries: Array<{ type: string; customType?: string; data?: unknown }> = [
      { type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: legalLink },
    ];
    let hostSessionId = 'host-link-full';

    await store.updateRun(runId, (r) => {
      const unit = r.units.single;
      if (!unit.interactiveBindings) unit.interactiveBindings = {};
      unit.interactiveBindings[snap.bindingId] = {
        bindingId: snap.bindingId,
        hostSessionId: 'host-link-full',
        createdAt: snap.linkCreatedAt,
      };
    });
    registry.restoreActiveBranch({
      sessionManager: {
        getSessionId: () => hostSessionId,
        getBranch: () => branchEntries,
      },
      cwd: root,
    } as never);

    const { pi, sent } = makeFakePi();
    const suppressed: string[] = [];
    const relay = createInteractiveRelayCoordinator({
      registry,
      pi,
      getCtx: () =>
        ({
          sessionManager: {
            getSessionId: () => hostSessionId,
            getBranch: () => branchEntries,
          },
        }) as unknown as ExtensionContext,
      onSuppressed: (reason) => suppressed.push(reason),
    });

    async function armAndSettleView(label: string): Promise<void> {
      await registry.activate(snap.key, `Task: ${label}`, 'prompt', undefined, 'tool_call');
      await new Promise((r) => setImmediate(r));
      eventListener?.({ type: 'agent_start' });
      await new Promise((r) => setImmediate(r));
      await registry.abort(snap.key);
      eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
      eventListener?.({ type: 'agent_settled' });
      await new Promise((r) => setImmediate(r));

      await registry.activate(snap.key, `continue-${label}`, 'prompt', undefined, 'view');
      await new Promise((r) => setImmediate(r));
      eventListener?.({ type: 'agent_start' });
      await new Promise((r) => setImmediate(r));
      eventListener?.({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: label }] },
      });
      eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
      eventListener?.({ type: 'agent_settled' });
      await new Promise((r) => setImmediate(r));
    }

    // Wrong version on live branch — no relay.
    branchEntries = [{ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: wrongVersion }];
    suppressed.length = 0;
    sent.length = 0;
    await armAndSettleView('bad-version');
    await relay.waitForIdle();
    expect(sent.length).toBe(0);
    expect(suppressed).toContain('branch_link_mismatch');

    // Wrong createdAt — no relay.
    branchEntries = [{ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: wrongCreatedAt }];
    suppressed.length = 0;
    sent.length = 0;
    await armAndSettleView('bad-createdAt');
    await relay.waitForIdle();
    expect(sent.length).toBe(0);
    expect(suppressed).toContain('branch_link_mismatch');

    // Copied link into a different host context — no relay.
    branchEntries = [
      { type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: copiedToOtherHost },
    ];
    hostSessionId = 'other-host-session';
    // Re-seed registry trust under the foreign host so isOnActiveBranch alone is not enough.
    registry.restoreActiveBranch({
      sessionManager: {
        getSessionId: () => hostSessionId,
        getBranch: () => branchEntries,
      },
      cwd: root,
    } as never);
    suppressed.length = 0;
    sent.length = 0;
    // Gate arming under foreign host will fail host_session_mismatch on snap.hostSessionId.
    // Force path: keep snap host as original by restoring legal trust first, then switch ctx only.
    hostSessionId = 'host-link-full';
    branchEntries = [{ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: legalLink }];
    registry.restoreActiveBranch({
      sessionManager: {
        getSessionId: () => hostSessionId,
        getBranch: () => branchEntries,
      },
      cwd: root,
    } as never);
    await registry.activate(snap.key, 'Task: rearm-host', 'prompt', undefined, 'tool_call');
    await new Promise((r) => setImmediate(r));
    eventListener?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));
    await registry.abort(snap.key);
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));

    // Switch live ctx host while branch still has the original link (copied into foreign view).
    hostSessionId = 'other-host-session';
    branchEntries = [{ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: legalLink }];
    await registry.activate(snap.key, 'continue-foreign-host', 'prompt', undefined, 'view');
    await new Promise((r) => setImmediate(r));
    eventListener?.({ type: 'agent_start' });
    await new Promise((r) => setImmediate(r));
    eventListener?.({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'foreign-host' }] },
    });
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));
    await relay.waitForIdle();
    expect(sent.length).toBe(0);
    expect(
      suppressed.includes('host_session_mismatch') || suppressed.includes('branch_link_mismatch')
    ).toBe(true);

    // Legal exact link + matching host context → relay succeeds.
    hostSessionId = 'host-link-full';
    branchEntries = [{ type: 'custom', customType: INTERACTIVE_LINK_TYPE, data: legalLink }];
    registry.restoreActiveBranch({
      sessionManager: {
        getSessionId: () => hostSessionId,
        getBranch: () => branchEntries,
      },
      cwd: root,
    } as never);
    suppressed.length = 0;
    sent.length = 0;
    await armAndSettleView('exact-ok');
    await relay.waitForIdle();
    expect(sent.length).toBe(1);
    expect(sent[0]!.details.output).toContain('exact-ok');

    relay.dispose();
    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('relay settled ordering before deferred retention', () => {
  it('settled snapshot precedes deferred idle eviction for oversized reloadable endpoint', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-relay-evict-'));
    const store = createRunStore({ rootDir: root });
    const coordinator = createRunCoordinator({ store });
    const agent: AgentConfig = {
      name: 'explore',
      description: 'test',
      systemPrompt: 'You explore.',
      source: 'user',
      filePath: '/tmp/explore.md',
    };
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
      details: {
        mode: 'single',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        results: [],
      },
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
      hostSessionId: 'host-relay-evict',
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

    const observed: Array<{ phase: string; count: number; final?: string }> = [];
    registry.subscribe((e) => {
      if (e.type === 'activation_settled') {
        const msgs = e.snapshot.messages;
        const last = msgs[msgs.length - 1] as { content?: Array<{ text?: string }> } | undefined;
        observed.push({
          phase: 'settled',
          count: msgs.length,
          final: last?.content?.[0]?.text,
        });
      }
      if (e.type === 'endpoint_updated' && e.snapshot.status === 'detached') {
        observed.push({ phase: 'detached', count: e.snapshot.messages.length });
      }
    });

    await registry.activate(snap.key, 'Task: relay-evict', 'prompt', undefined, 'view');
    await new Promise((r) => setImmediate(r));
    const chunk = 'R'.repeat(40 * 1024);
    for (let i = 0; i < 20; i++) {
      eventListener?.({
        type: 'message_end',
        message: {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: i % 2 === 0 ? `u-${i}:${chunk}` : [{ type: 'text', text: `a-${i}:${chunk}` }],
        },
      });
    }
    eventListener?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'RELAY_SETTLED_FINAL' }],
      },
    });
    eventListener?.({ type: 'agent_start' });
    eventListener?.({ type: 'agent_settled' });
    await new Promise((r) => setImmediate(r));

    expect(observed.some((o) => o.phase === 'settled')).toBe(true);
    const settledObs = observed.find((o) => o.phase === 'settled')!;
    expect(settledObs.count).toBeGreaterThan(2);
    expect(settledObs.final).toBe('RELAY_SETTLED_FINAL');
    expect(
      Buffer.byteLength(JSON.stringify(registry.get(snap.key)?.messages ?? []), 'utf8')
    ).toBeLessThanOrEqual(
      // Immediately after settle, may still hold pre-eviction or already empty after microtask.
      INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES * 4
    );

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 30));
    const after = registry.get(snap.key)!;
    expect(after.messages).toEqual([]);
    // Ordering: settled observation happened before empty/detached state.
    const settledIdx = observed.findIndex((o) => o.phase === 'settled');
    const emptyIdx = observed.findIndex((o) => o.phase === 'detached' || o.count === 0);
    expect(settledIdx).toBeGreaterThanOrEqual(0);
    if (emptyIdx >= 0) expect(settledIdx).toBeLessThan(emptyIdx);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
