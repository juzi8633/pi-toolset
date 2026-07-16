// ABOUTME: Tests for RPC execution projection from interactive registry activations.
// ABOUTME: Uses fake registries and one real-registry 0.80.6 lifecycle path.

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentConfig } from '../src/agents.ts';
import { AgentAbortError } from '../src/execution.ts';
import {
  createInteractiveAgentRegistry,
  type InteractiveAgentRegistry,
  type InteractiveEndpointSnapshot,
  type InteractiveRegistryEvent,
} from '../src/interactive-agent.ts';
import { runSingleAgentPiRpc } from '../src/pi-rpc-execution.ts';
import { agentFingerprint, createRunCoordinator } from '../src/run-coordinator.ts';
import { createRunStore } from '../src/run-store.ts';
import type { PiRpcTransport } from '../src/pi-rpc-transport.ts';
import type { SingleResult, SubagentDetails } from '../src/types.ts';

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'worker',
    description: 'test',
    systemPrompt: '',
    source: 'builtin',
    filePath: '/tmp/worker.md',
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

function baseSnap(
  overrides: Partial<InteractiveEndpointSnapshot> = {}
): InteractiveEndpointSnapshot {
  return {
    key: 'run1:single',
    hostSessionId: 'h',
    runId: 'run1',
    unitId: 'single',
    bindingId: 'b',
    agent: 'worker',
    sessionFile: '/tmp/s.jsonl',
    effectiveCwd: '/tmp',
    status: 'idle',
    messages: [],
    messagesRevision: 0,
    streamRevision: 0,
    activeTools: [],
    steeringQueue: [],
    followUpQueue: [],
    lastUsedAt: Date.now(),
    createdAt: Date.now(),
    linkCreatedAt: Date.now(),
    hasTransport: true,
    queueCount: 0,
    ...overrides,
  };
}

/** Controllable timer surface for settle-timeout tests (no wall-clock waits). */
function makeFakeTimers() {
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    timers: {
      setTimeout: (fn: () => void, ms?: number): unknown => {
        const id = nextId++;
        pending.set(id, { fn, ms: ms ?? 0 });
        return id;
      },
      clearTimeout: (id: unknown) => {
        pending.delete(id as number);
      },
    },
    async flush(ms: number) {
      const due = [...pending.entries()].filter(([, t]) => t.ms <= ms);
      for (const [id, t] of due) {
        pending.delete(id);
        t.fn();
      }
      await Promise.resolve();
    },
    pendingCount: () => pending.size,
  };
}

describe('runSingleAgentPiRpc resume prompts', () => {
  async function runWithCapturedPrompt(
    task: string,
    options: {
      sessionFile?: string;
      resumeHadStoredSession?: boolean;
      resumePrompt?: {
        continuationTasks: string[];
        undeliveredContinuationTasks?: string[];
        currentContinuationTask?: string;
      };
    }
  ): Promise<{ prompt: string; result: SingleResult }> {
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    const snap = baseSnap({
      status: 'registered',
      sessionFile: options.sessionFile ?? '/tmp/s.jsonl',
      messages: [],
    });
    let capturedPrompt = '';
    const registry = {
      get: () => ({ ...snap, messages: [...snap.messages] }),
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      activate: async (_key: string, prompt: string) => {
        capturedPrompt = prompt;
        snap.status = 'running';
        snap.activation = {
          id: 'act-resume',
          endpointKey: snap.key,
          mode: 'prompt',
          baselineMessageCount: 0,
          sequence: 1,
          origin: 'tool_call',
          settled: false,
          createdAt: Date.now(),
        };
        setTimeout(() => {
          snap.messages = [
            { role: 'user', content: prompt },
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'done' }],
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          ] as never;
          snap.status = 'idle';
          const id = snap.activation!.id;
          snap.activation = undefined;
          for (const l of listeners) {
            l({
              type: 'endpoint_updated',
              key: snap.key,
              snapshot: { ...snap, messages: [...snap.messages] },
              kind: 'full',
            });
            l({
              type: 'activation_settled',
              key: snap.key,
              activationId: id,
              snapshot: { ...snap, messages: [...snap.messages] },
            });
          }
        }, 5);
        return { activationId: 'act-resume', snapshot: { ...snap, messages: [...snap.messages] } };
      },
      abort: async () => snap,
      detach: async () => undefined,
    } as unknown as InteractiveAgentRegistry;

    const result = await runSingleAgentPiRpc(
      '/tmp',
      [makeAgent()],
      'worker',
      task,
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      {
        interactiveRegistry: registry,
        endpointKey: 'run1:single',
        hostMode: 'tui',
        sessionFile: options.sessionFile,
        resumePrompt: options.resumePrompt,
        ...(options.resumeHadStoredSession !== undefined
          ? { resumeHadStoredSession: options.resumeHadStoredSession }
          : {}),
      }
    );
    return { prompt: capturedPrompt, result };
  }

  it('delivers the shared session-continuation prompt with undelivered tasks', async () => {
    const { prompt, result } = await runWithCapturedPrompt('Original task', {
      sessionFile: '/tmp/existing.jsonl',
      resumeHadStoredSession: true,
      resumePrompt: {
        continuationTasks: ['Earlier', 'Also finish validation.'],
        undeliveredContinuationTasks: ['Also finish validation.'],
        currentContinuationTask: 'Also finish validation.',
      },
    });
    expect(prompt).not.toContain('Task: Original task');
    expect(prompt).not.toContain('Earlier');
    expect(prompt).toContain('resuming');
    expect(prompt).toContain(
      'Additional instruction for this resumed run:\nAlso finish validation.'
    );
    expect(result.task).toBe('Original task');
  });

  it('sends original task plus all continuations when resumeHadStoredSession is false', async () => {
    const { prompt } = await runWithCapturedPrompt('Original task', {
      sessionFile: '/tmp/just-created.jsonl',
      resumeHadStoredSession: false,
      resumePrompt: {
        continuationTasks: ['Cont A', 'Cont B'],
      },
    });
    expect(prompt).toContain('Task: Original task');
    expect(prompt).toContain('Additional instruction for this resumed run:\nCont A');
    expect(prompt).toContain('Additional instruction for this resumed run:\nCont B');
  });

  it('sends original task plus all continuations when no session file is present', async () => {
    const { prompt } = await runWithCapturedPrompt('Original task', {
      resumeHadStoredSession: false,
      resumePrompt: {
        continuationTasks: ['Cont A', 'Cont B'],
      },
    });
    expect(prompt).toContain('Task: Original task');
    expect(prompt).toContain('Additional instruction for this resumed run:\nCont A');
    expect(prompt).toContain('Additional instruction for this resumed run:\nCont B');
  });
});

describe('runSingleAgentPiRpc', () => {
  it('excludes baseline history and waits for activation settle', async () => {
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    const history = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: [{ type: 'text', text: 'old reply' }] },
    ];
    let activationId = 'act-1';
    const snap = baseSnap({
      status: 'registered',
      messages: history as never,
    });

    const registry = {
      get: () => ({ ...snap, messages: [...snap.messages] }),
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      activate: async () => {
        snap.status = 'running';
        snap.activation = {
          id: activationId,
          endpointKey: snap.key,
          mode: 'prompt',
          baselineMessageCount: history.length,
          sequence: 1,
          origin: 'tool_call',
          settled: false,
          createdAt: Date.now(),
        };
        // Simulate assistant turn then settle asynchronously.
        setTimeout(() => {
          snap.messages = [
            ...history,
            { role: 'user', content: 'Task: do it' },
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'done' }],
              usage: { input: 5, output: 5, totalTokens: 10 },
            },
          ] as never;
          snap.status = 'idle';
          const settledActivation = snap.activation!;
          settledActivation.settled = true;
          const id = settledActivation.id;
          snap.activation = undefined;
          for (const l of listeners) {
            l({
              type: 'endpoint_updated',
              key: snap.key,
              snapshot: { ...snap, messages: [...snap.messages] },
              kind: 'full',
            });
            l({
              type: 'activation_settled',
              key: snap.key,
              activationId: id,
              snapshot: { ...snap, messages: [...snap.messages] },
            });
          }
        }, 10);
        return { activationId, snapshot: { ...snap, messages: [...snap.messages] } };
      },
      abort: async () => snap,
      detach: async () => undefined,
    } as unknown as InteractiveAgentRegistry;

    const result = await runSingleAgentPiRpc(
      '/tmp',
      [makeAgent()],
      'worker',
      'do it',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      {
        interactiveRegistry: registry,
        endpointKey: 'run1:single',
        hostMode: 'tui',
        sessionFile: '/tmp/s.jsonl',
      }
    );

    // Parent live result retains only post-baseline assistant messages (not user/tool-result).
    expect(result.messages.length).toBe(1);
    expect(result.messages[0]?.role).toBe('assistant');
    expect(result.usage.turns).toBe(1);
    expect(result.status === 'completed' || result.exitCode === 0).toBe(true);
  });

  it('throws AgentAbortError when signal aborts', async () => {
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    const snap = baseSnap({ status: 'running' });
    const ac = new AbortController();

    const registry = {
      get: () => ({ ...snap }),
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      activate: async () => {
        snap.activation = {
          id: 'act-abort',
          endpointKey: snap.key,
          mode: 'prompt',
          baselineMessageCount: 0,
          sequence: 1,
          origin: 'tool_call',
          settled: false,
          createdAt: Date.now(),
        };
        setTimeout(() => ac.abort(), 5);
        setTimeout(() => {
          snap.status = 'idle';
          const id = snap.activation!.id;
          snap.activation = undefined;
          for (const l of listeners) {
            l({
              type: 'activation_settled',
              key: snap.key,
              activationId: id,
              snapshot: { ...snap },
            });
          }
        }, 20);
        return { activationId: 'act-abort', snapshot: { ...snap } };
      },
      abort: async () => {
        snap.activation = snap.activation
          ? { ...snap.activation, terminalOverride: 'cancelled' as const }
          : undefined;
        return { ...snap };
      },
      detach: async () => undefined,
    } as unknown as InteractiveAgentRegistry;

    await expect(
      runSingleAgentPiRpc(
        '/tmp',
        [makeAgent()],
        'worker',
        'do it',
        undefined,
        undefined,
        ac.signal,
        undefined,
        makeDetails,
        {
          interactiveRegistry: registry,
          endpointKey: 'run1:single',
          hostMode: 'tui',
          sessionFile: '/tmp/s.jsonl',
        }
      )
    ).rejects.toBeInstanceOf(AgentAbortError);
  });
});

describe('runSingleAgentPiRpc startup abort', () => {
  it('does not activate when signal is already aborted', async () => {
    let activateCalls = 0;
    const ac = new AbortController();
    ac.abort();
    const registry = {
      get: () => baseSnap(),
      subscribe: () => () => undefined,
      activate: async () => {
        activateCalls += 1;
        throw new Error('should not activate');
      },
      abort: async () => baseSnap(),
      detach: async () => undefined,
    } as unknown as InteractiveAgentRegistry;

    await expect(
      runSingleAgentPiRpc(
        '/tmp',
        [makeAgent()],
        'worker',
        'do it',
        undefined,
        undefined,
        ac.signal,
        undefined,
        makeDetails,
        {
          interactiveRegistry: registry,
          endpointKey: 'run1:single',
          hostMode: 'tui',
          sessionFile: '/tmp/s.jsonl',
        }
      )
    ).rejects.toBeInstanceOf(AgentAbortError);
    expect(activateCalls).toBe(0);
  });

  it('maps startup barrier cancellation to AgentAbortError', async () => {
    const ac = new AbortController();
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    const snap = baseSnap({ status: 'starting' });
    const registry = {
      get: () => ({ ...snap }),
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      activate: async () => {
        // Simulate abort during handshake rejecting activate.
        ac.abort();
        throw new Error('Activation cancelled before send');
      },
      abort: async () => ({ ...snap }),
      detach: async () => undefined,
    } as unknown as InteractiveAgentRegistry;

    await expect(
      runSingleAgentPiRpc(
        '/tmp',
        [makeAgent()],
        'worker',
        'do it',
        undefined,
        undefined,
        ac.signal,
        undefined,
        makeDetails,
        {
          interactiveRegistry: registry,
          endpointKey: 'run1:single',
          hostMode: 'tui',
          sessionFile: '/tmp/s.jsonl',
        }
      )
    ).rejects.toBeInstanceOf(AgentAbortError);
  });
});

describe('runSingleAgentPiRpc update fan-out', () => {
  it('subscribes once and does not double-forward endpoint updates', async () => {
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    let subscribeCount = 0;
    const snap = baseSnap({ status: 'registered', messages: [] });
    const activationId = 'act-once';

    const registry = {
      get: () => ({ ...snap, messages: [...snap.messages] }),
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        subscribeCount += 1;
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      activate: async () => {
        snap.status = 'running';
        snap.activation = {
          id: activationId,
          endpointKey: snap.key,
          mode: 'prompt',
          baselineMessageCount: 0,
          sequence: 1,
          origin: 'tool_call',
          settled: false,
          createdAt: Date.now(),
        };
        setTimeout(() => {
          // Three progressive finalized appends then settle.
          for (let i = 1; i <= 3; i++) {
            snap.messages = [
              ...snap.messages,
              {
                role: 'assistant',
                content: [{ type: 'text', text: `chunk-${i}` }],
                usage: { input: i, output: i, totalTokens: i * 2 },
              },
            ] as never;
            for (const l of listeners) {
              l({
                type: 'endpoint_updated',
                key: snap.key,
                snapshot: { ...snap, messages: [...snap.messages] },
                kind: 'full',
              });
            }
          }
          snap.status = 'idle';
          const id = snap.activation!.id;
          snap.activation = undefined;
          for (const l of listeners) {
            l({
              type: 'activation_settled',
              key: snap.key,
              activationId: id,
              snapshot: { ...snap, messages: [...snap.messages] },
            });
          }
        }, 5);
        return { activationId, snapshot: { ...snap, messages: [...snap.messages] } };
      },
      abort: async () => snap,
      detach: async () => undefined,
    } as unknown as InteractiveAgentRegistry;

    let onUpdateCount = 0;
    await runSingleAgentPiRpc(
      '/tmp',
      [makeAgent()],
      'worker',
      'do it',
      undefined,
      undefined,
      undefined,
      () => {
        onUpdateCount += 1;
      },
      makeDetails,
      {
        interactiveRegistry: registry,
        endpointKey: 'run1:single',
        hostMode: 'tui',
        sessionFile: '/tmp/s.jsonl',
      }
    );

    // One lifecycle subscription (not the former dual-subscribe pattern).
    expect(subscribeCount).toBe(1);
    // activate emit + 3 full message projections (not 6 from dual subscribe).
    expect(onUpdateCount).toBe(4);
    // Dual-subscribe would have been 1 + 3*2 = 7 for the same sequence.
    expect(onUpdateCount).toBeLessThan(7);
  });

  it('does not emit full parent onUpdate for consecutive transcript-only message_update', async () => {
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    const snap = baseSnap({ status: 'registered', messages: [] });
    const activationId = 'act-stream';

    const registry = {
      get: () => ({ ...snap, messages: [...snap.messages] }),
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      activate: async () => {
        snap.status = 'running';
        snap.activation = {
          id: activationId,
          endpointKey: snap.key,
          mode: 'prompt',
          baselineMessageCount: 0,
          sequence: 1,
          origin: 'tool_call',
          settled: false,
          createdAt: Date.now(),
        };
        setTimeout(() => {
          // Many streaming deltas — must not fan out parent tool updates.
          for (let i = 0; i < 20; i++) {
            snap.streamingMessage = {
              role: 'assistant',
              content: [{ type: 'text', text: 'x'.repeat(i + 1) }],
            } as never;
            for (const l of listeners) {
              l({
                type: 'endpoint_updated',
                key: snap.key,
                snapshot: {
                  ...snap,
                  messages: [...snap.messages],
                  streamingMessage: snap.streamingMessage,
                },
                kind: 'transcript',
              });
            }
          }
          // Finalized turn then settle.
          snap.messages = [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'final' }],
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          ] as never;
          snap.streamingMessage = undefined;
          for (const l of listeners) {
            l({
              type: 'endpoint_updated',
              key: snap.key,
              snapshot: { ...snap, messages: [...snap.messages] },
              kind: 'full',
            });
          }
          snap.status = 'idle';
          const id = snap.activation!.id;
          snap.activation = undefined;
          for (const l of listeners) {
            l({
              type: 'activation_settled',
              key: snap.key,
              activationId: id,
              snapshot: { ...snap, messages: [...snap.messages] },
            });
          }
        }, 5);
        return { activationId, snapshot: { ...snap, messages: [...snap.messages] } };
      },
      abort: async () => snap,
      detach: async () => undefined,
    } as unknown as InteractiveAgentRegistry;

    let onUpdateCount = 0;
    const result = await runSingleAgentPiRpc(
      '/tmp',
      [makeAgent()],
      'worker',
      'stream',
      undefined,
      undefined,
      undefined,
      () => {
        onUpdateCount += 1;
      },
      makeDetails,
      {
        interactiveRegistry: registry,
        endpointKey: 'run1:single',
        hostMode: 'tui',
        sessionFile: '/tmp/s.jsonl',
      }
    );

    // activate (1) + message_end full (1); 20 transcript deltas must not count.
    expect(onUpdateCount).toBe(2);
    expect(result.messages.length).toBe(1);
  });

  it('reuses finalized messages array across message_update and skips parent projection', async () => {
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    const finalized = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        usage: { input: 1, output: 1, totalTokens: 2 },
      },
    ];
    // Stable view identity — transcript publishes must share this array.
    const finalizedView = finalized as never[];
    const snap = baseSnap({
      status: 'running',
      messages: finalizedView as never,
      messagesRevision: 1,
      streamRevision: 0,
    });
    const activationId = 'act-reuse';

    const registry = {
      get: () => ({ ...snap, messages: snap.messages }),
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      activate: async () => {
        snap.activation = {
          id: activationId,
          endpointKey: snap.key,
          mode: 'prompt',
          baselineMessageCount: 0,
          sequence: 1,
          origin: 'tool_call',
          settled: false,
          createdAt: Date.now(),
        };
        setTimeout(() => {
          // Many transcript deltas with the SAME messages array reference.
          for (let i = 0; i < 15; i++) {
            snap.streamRevision = i + 1;
            snap.streamingMessage = {
              role: 'assistant',
              content: [{ type: 'text', text: 't'.repeat(i + 1) }],
            } as never;
            for (const l of listeners) {
              l({
                type: 'endpoint_updated',
                key: snap.key,
                snapshot: {
                  ...snap,
                  messages: snap.messages, // same ref
                  streamingMessage: snap.streamingMessage,
                },
                kind: 'transcript',
              });
            }
          }
          snap.streamingMessage = undefined;
          snap.status = 'idle';
          const id = snap.activation!.id;
          snap.activation = undefined;
          for (const l of listeners) {
            l({
              type: 'endpoint_updated',
              key: snap.key,
              snapshot: { ...snap, messages: snap.messages },
              kind: 'full',
            });
            l({
              type: 'activation_settled',
              key: snap.key,
              activationId: id,
              snapshot: { ...snap, messages: snap.messages },
            });
          }
        }, 5);
        return { activationId, snapshot: { ...snap, messages: snap.messages } };
      },
      abort: async () => snap,
      detach: async () => undefined,
    } as unknown as InteractiveAgentRegistry;

    let onUpdateCount = 0;
    const result = await runSingleAgentPiRpc(
      '/tmp',
      [makeAgent()],
      'worker',
      'reuse',
      undefined,
      undefined,
      undefined,
      () => {
        onUpdateCount += 1;
      },
      makeDetails,
      {
        interactiveRegistry: registry,
        endpointKey: 'run1:single',
        hostMode: 'tui',
        sessionFile: '/tmp/s.jsonl',
      }
    );

    // activate only (transcript deltas must not project / onUpdate).
    // full settle path does not re-emit parent solely for settle; one full may emit if projection changed.
    expect(onUpdateCount).toBeLessThanOrEqual(2);
    // Final SingleResult owns a mutable copy — must not alias registry readonly array.
    expect(result.messages).not.toBe(finalizedView as never);
    expect(result.messages).toEqual(finalizedView as never);
  });
});

describe('runSingleAgentPiRpc activation settle race', () => {
  it('ignores old activation settle during activate; waits for own settle', async () => {
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    const snap = baseSnap({ status: 'registered', messages: [] });
    let activateStarted!: () => void;
    const activateGate = new Promise<void>((r) => {
      activateStarted = r;
    });
    let resolveActivate!: (v: {
      activationId: string;
      snapshot: InteractiveEndpointSnapshot;
    }) => void;
    const activateResult = new Promise<{
      activationId: string;
      snapshot: InteractiveEndpointSnapshot;
    }>((r) => {
      resolveActivate = r;
    });

    const registry = {
      get: () => ({ ...snap, messages: [...snap.messages] }),
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      activate: async () => {
        activateStarted();
        return activateResult;
      },
      abort: async () => snap,
      detach: async () => undefined,
    } as unknown as InteractiveAgentRegistry;

    const runPromise = runSingleAgentPiRpc(
      '/tmp',
      [makeAgent()],
      'worker',
      'race',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      {
        interactiveRegistry: registry,
        endpointKey: 'run1:single',
        hostMode: 'tui',
        sessionFile: '/tmp/s.jsonl',
      }
    );

    // Wait until activate is in-flight (subscription already live).
    await activateGate;

    // Old activation settles while new activate is still queued/pending.
    for (const l of listeners) {
      l({
        type: 'activation_settled',
        key: snap.key,
        activationId: 'act-old',
        snapshot: baseSnap({
          status: 'idle',
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'old' }],
            },
          ] as never,
          messagesRevision: 1,
        }),
      });
    }

    // New activation returns.
    snap.status = 'running';
    snap.activation = {
      id: 'act-new',
      endpointKey: snap.key,
      mode: 'prompt',
      baselineMessageCount: 0,
      sequence: 2,
      origin: 'tool_call',
      settled: false,
      createdAt: Date.now(),
    };
    resolveActivate({
      activationId: 'act-new',
      snapshot: { ...snap, messages: [...snap.messages] },
    });

    // If the race bug exists, run would complete immediately without waiting.
    let finished = false;
    void runPromise.then(() => {
      finished = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(finished).toBe(false);

    // Own settle must complete the wait.
    snap.messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'new-done' }],
        usage: { input: 1, output: 1, totalTokens: 2 },
      },
    ] as never;
    snap.status = 'idle';
    const id = snap.activation!.id;
    snap.activation = undefined;
    for (const l of listeners) {
      l({
        type: 'activation_settled',
        key: snap.key,
        activationId: id,
        snapshot: { ...snap, messages: [...snap.messages], messagesRevision: 2 },
      });
    }

    const result = await runPromise;
    expect(result.messages.length).toBe(1);
    expect((result.messages[0] as { content?: unknown }).content).toEqual([
      { type: 'text', text: 'new-done' },
    ]);
  });

  it('ignores old max_turns endpoint_updated before activate returns; waits for new id', async () => {
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    const fake = makeFakeTimers();
    const snap = baseSnap({ status: 'registered', messages: [] });
    let activateStarted!: () => void;
    const activateGate = new Promise<void>((r) => {
      activateStarted = r;
    });
    let resolveActivate!: (v: {
      activationId: string;
      snapshot: InteractiveEndpointSnapshot;
    }) => void;
    const activateResult = new Promise<{
      activationId: string;
      snapshot: InteractiveEndpointSnapshot;
    }>((r) => {
      resolveActivate = r;
    });
    let detachCalls = 0;

    const registry = {
      get: () => ({ ...snap, messages: [...snap.messages] }),
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      activate: async () => {
        activateStarted();
        return activateResult;
      },
      abort: async () => snap,
      detach: async () => {
        detachCalls += 1;
      },
    } as unknown as InteractiveAgentRegistry;

    const runPromise = runSingleAgentPiRpc(
      '/tmp',
      [makeAgent({ maxTurns: 1 })],
      'worker',
      'iso',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      {
        interactiveRegistry: registry,
        endpointKey: 'run1:single',
        hostMode: 'tui',
        sessionFile: '/tmp/s.jsonl',
        settleTimeoutMs: 50,
        timers: fake.timers,
      }
    );

    await activateGate;

    // Production order: old max_turns endpoint_updated, then old activation_settled,
    // both before activate() returns the new id.
    const oldAct = {
      id: 'act-old',
      endpointKey: snap.key,
      mode: 'prompt' as const,
      baselineMessageCount: 0,
      sequence: 1,
      origin: 'tool_call' as const,
      settled: false,
      createdAt: Date.now(),
      policy: { maxTurns: 1 },
      terminalOverride: 'max_turns' as const,
    };
    for (const l of listeners) {
      l({
        type: 'endpoint_updated',
        key: snap.key,
        kind: 'full',
        snapshot: baseSnap({
          status: 'running',
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'old-max' }],
              stopReason: 'max_turns',
            },
          ] as never,
          activation: oldAct,
          messagesRevision: 1,
        }),
      });
    }
    for (const l of listeners) {
      l({
        type: 'activation_settled',
        key: snap.key,
        activationId: 'act-old',
        snapshot: baseSnap({
          status: 'idle',
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'old-max' }],
              stopReason: 'max_turns',
            },
          ] as never,
          activation: { ...oldAct, settled: true },
          messagesRevision: 1,
        }),
      });
    }

    // New activation returns (no max_turns).
    snap.status = 'running';
    snap.activation = {
      id: 'act-new',
      endpointKey: snap.key,
      mode: 'prompt',
      baselineMessageCount: 0,
      sequence: 2,
      origin: 'tool_call',
      settled: false,
      createdAt: Date.now(),
    };
    resolveActivate({
      activationId: 'act-new',
      snapshot: { ...snap, messages: [] },
    });

    // Must still be waiting — old settle must not complete the run.
    let finished = false;
    void runPromise.then(() => {
      finished = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(finished).toBe(false);

    // Foreign max_turns must not arm timeout/detach.
    await fake.flush(50);
    expect(detachCalls).toBe(0);
    expect(finished).toBe(false);

    // New activation normal full + settle.
    snap.messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'fresh' }],
        usage: { input: 1, output: 1, totalTokens: 2 },
      },
    ] as never;
    for (const l of listeners) {
      l({
        type: 'endpoint_updated',
        key: snap.key,
        kind: 'full',
        snapshot: {
          ...snap,
          messages: [...snap.messages],
          activation: { ...snap.activation! },
          messagesRevision: 2,
        },
      });
    }
    const id = snap.activation!.id;
    snap.status = 'idle';
    snap.activation = undefined;
    for (const l of listeners) {
      l({
        type: 'activation_settled',
        key: snap.key,
        activationId: id,
        snapshot: { ...snap, messages: [...snap.messages], messagesRevision: 2 },
      });
    }

    const result = await runPromise;
    expect(result.stopReason).not.toBe('max_turns');
    expect(result.errorMessage ?? '').not.toMatch(/timeout|maxTurns/i);
    expect(detachCalls).toBe(0);
    expect(result.messages.length).toBe(1);
    expect((result.messages[0] as { content?: unknown }).content).toEqual([
      { type: 'text', text: 'fresh' },
    ]);
  });
});

describe('runSingleAgentPiRpc max_turns settle timeout', () => {
  it('force-settles activation on timeout and subsequent activate is not polluted', async () => {
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    const fake = makeFakeTimers();
    const snap = baseSnap({ status: 'registered', messages: [] });
    let activateSeq = 0;
    let detachCalls = 0;
    let activationCleared = false;

    const registry = {
      get: () => ({ ...snap, messages: [...snap.messages] }),
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      activate: async () => {
        activateSeq += 1;
        const activationId = activateSeq === 1 ? 'act-max' : 'act-next';
        snap.status = 'running';
        snap.activation = {
          id: activationId,
          endpointKey: snap.key,
          mode: 'prompt',
          baselineMessageCount: snap.messages.length,
          sequence: activateSeq,
          origin: 'tool_call',
          settled: false,
          createdAt: Date.now(),
          policy: activateSeq === 1 ? { maxTurns: 1 } : undefined,
          terminalOverride: activateSeq === 1 ? 'max_turns' : undefined,
        };
        // First activation never settles via agent_settled — timeout must clean up.
        // Second activation settles successfully after a short delay.
        if (activateSeq === 2) {
          setTimeout(() => {
            snap.messages = [
              ...snap.messages,
              {
                role: 'assistant',
                content: [{ type: 'text', text: 'second-ok' }],
                usage: { input: 1, output: 1, totalTokens: 2 },
              },
            ] as never;
            snap.status = 'idle';
            const id = snap.activation!.id;
            const settledAct = { ...snap.activation!, settled: true };
            for (const l of listeners) {
              l({
                type: 'endpoint_updated',
                key: snap.key,
                kind: 'full',
                snapshot: {
                  ...snap,
                  messages: [...snap.messages],
                  activation: settledAct,
                  messagesRevision: snap.messages.length,
                },
              });
              l({
                type: 'activation_settled',
                key: snap.key,
                activationId: id,
                snapshot: {
                  ...snap,
                  messages: [...snap.messages],
                  activation: settledAct,
                  messagesRevision: snap.messages.length,
                },
              });
            }
            snap.activation = undefined;
          }, 5);
        }
        return { activationId, snapshot: { ...snap, messages: [...snap.messages] } };
      },
      abort: async () => snap,
      detach: async () => {
        detachCalls += 1;
        // Mimic registry detach: settle open activation then clear.
        if (snap.activation && !snap.activation.settled) {
          const id = snap.activation.id;
          snap.activation = {
            ...snap.activation,
            settled: true,
            terminalOverride: snap.activation.terminalOverride ?? 'error',
            error: 'max_turns settle timeout',
          };
          for (const l of listeners) {
            l({
              type: 'activation_settled',
              key: snap.key,
              activationId: id,
              snapshot: {
                ...snap,
                messages: [...snap.messages],
                activation: { ...snap.activation },
              },
            });
          }
          snap.activation = undefined;
          activationCleared = true;
        }
        snap.status = 'detached';
        for (const l of listeners) {
          l({
            type: 'endpoint_updated',
            key: snap.key,
            snapshot: { ...snap, messages: [...snap.messages] },
            kind: 'full',
          });
        }
      },
    } as unknown as InteractiveAgentRegistry;

    const firstPromise = runSingleAgentPiRpc(
      '/tmp',
      [makeAgent({ maxTurns: 1 })],
      'worker',
      'max',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      {
        interactiveRegistry: registry,
        endpointKey: 'run1:single',
        hostMode: 'tui',
        sessionFile: '/tmp/s.jsonl',
        settleTimeoutMs: 50,
        timers: fake.timers,
      }
    );

    // Let activate return and arm timeout.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Fire the settle timeout without waiting wall-clock 10s.
    await fake.flush(50);

    const first = await firstPromise;
    expect(detachCalls).toBe(1);
    expect(activationCleared).toBe(true);
    // Protocol timeout must clear the activation — no zombie left for later send/activate.
    expect(snap.activation).toBeUndefined();
    expect(snap.status).toBe('detached');
    expect(first.stopReason === 'max_turns' || first.errorMessage?.includes('timeout')).toBe(true);

    // Subsequent activate on the same endpoint must not inherit the old timeout/max_turns.
    const second = await runSingleAgentPiRpc(
      '/tmp',
      [makeAgent()],
      'worker',
      'after-timeout',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      {
        interactiveRegistry: registry,
        endpointKey: 'run1:single',
        hostMode: 'tui',
        sessionFile: '/tmp/s.jsonl',
        settleTimeoutMs: 50,
        timers: fake.timers,
      }
    );
    expect(second.stopReason).not.toBe('max_turns');
    expect(second.errorMessage ?? '').not.toMatch(/timeout/i);
    expect((second.messages[0] as { content?: unknown } | undefined)?.content).toEqual([
      { type: 'text', text: 'second-ok' },
    ]);
    // Old timeout must not fire a second detach against the new activation.
    expect(detachCalls).toBe(1);
  });
});

describe('runSingleAgentPiRpc terminal projection (release blockers)', () => {
  it('transport-error-with-finalized-message projects failed, not completed', async () => {
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial work' }],
        usage: { input: 2, output: 2, totalTokens: 4 },
      },
    ];
    const snap = baseSnap({
      status: 'running',
      messages: messages as never,
      messagesRevision: 1,
    });

    const registry = {
      get: () => ({ ...snap, messages: [...snap.messages] }),
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      activate: async () => {
        snap.activation = {
          id: 'act-err',
          endpointKey: snap.key,
          mode: 'prompt',
          baselineMessageCount: 0,
          sequence: 1,
          origin: 'tool_call',
          settled: false,
          createdAt: Date.now(),
        };
        setTimeout(() => {
          // Registry settle with terminalOverride=error after messages exist.
          snap.status = 'error';
          snap.lastError = 'child process crashed';
          snap.errorCode = 'transport_error';
          snap.activation = {
            ...snap.activation!,
            settled: true,
            terminalOverride: 'error',
            error: 'child process crashed',
          };
          const id = snap.activation.id;
          for (const l of listeners) {
            l({
              type: 'endpoint_updated',
              key: snap.key,
              kind: 'full',
              snapshot: {
                ...snap,
                messages: [...snap.messages],
                activation: { ...snap.activation! },
              },
            });
            l({
              type: 'activation_settled',
              key: snap.key,
              activationId: id,
              snapshot: {
                ...snap,
                messages: [...snap.messages],
                activation: { ...snap.activation! },
              },
            });
          }
          snap.activation = undefined;
        }, 5);
        return { activationId: 'act-err', snapshot: { ...snap, messages: [...snap.messages] } };
      },
      abort: async () => snap,
      detach: async () => undefined,
    } as unknown as InteractiveAgentRegistry;

    const result = await runSingleAgentPiRpc(
      '/tmp',
      [makeAgent()],
      'worker',
      'crash-after-output',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      {
        interactiveRegistry: registry,
        endpointKey: 'run1:single',
        hostMode: 'tui',
        sessionFile: '/tmp/s.jsonl',
      }
    );

    expect(result.messages.length).toBe(1);
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toMatch(/crashed|transport|error/i);
    expect(result.status).not.toBe('completed');
  });

  it('overwrites prior assistant stopReason on transport crash (not ?? keep stop/toolUse)', async () => {
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'used a tool' }],
        stopReason: 'toolUse',
        usage: { input: 1, output: 1, totalTokens: 2 },
      },
    ];
    const snap = baseSnap({
      status: 'running',
      messages: messages as never,
      messagesRevision: 1,
    });

    const registry = {
      get: () => ({ ...snap, messages: [...snap.messages] }),
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      activate: async () => {
        snap.activation = {
          id: 'act-stop-overwrite',
          endpointKey: snap.key,
          mode: 'prompt',
          baselineMessageCount: 0,
          sequence: 1,
          origin: 'tool_call',
          settled: false,
          createdAt: Date.now(),
        };
        setTimeout(() => {
          snap.status = 'error';
          snap.lastError = 'process crashed mid-turn';
          snap.errorCode = 'transport_error';
          snap.activation = {
            ...snap.activation!,
            settled: true,
            terminalOverride: 'error',
            error: 'process crashed mid-turn',
          };
          const id = snap.activation.id;
          for (const l of listeners) {
            l({
              type: 'endpoint_updated',
              key: snap.key,
              kind: 'full',
              snapshot: {
                ...snap,
                messages: [...snap.messages],
                activation: { ...snap.activation! },
              },
            });
            l({
              type: 'activation_settled',
              key: snap.key,
              activationId: id,
              snapshot: {
                ...snap,
                messages: [...snap.messages],
                activation: { ...snap.activation! },
              },
            });
          }
          snap.activation = undefined;
        }, 5);
        return {
          activationId: 'act-stop-overwrite',
          snapshot: { ...snap, messages: [...snap.messages] },
        };
      },
      abort: async () => snap,
      detach: async () => undefined,
    } as unknown as InteractiveAgentRegistry;

    const result = await runSingleAgentPiRpc(
      '/tmp',
      [makeAgent()],
      'worker',
      'crash-after-toolUse',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      {
        interactiveRegistry: registry,
        endpointKey: 'run1:single',
        hostMode: 'tui',
        sessionFile: '/tmp/s.jsonl',
      }
    );

    expect(result.stopReason).toBe('error');
    expect(result.stopReason).not.toBe('toolUse');
    expect(result.stopReason).not.toBe('stop');
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
  });

  it('overwrites prior assistant stopReason on user abort (aborted, not stop)', async () => {
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    const fake = makeFakeTimers();
    const messages = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'still going' }],
        stopReason: 'stop',
        usage: { input: 1, output: 1, totalTokens: 2 },
      },
    ];
    const snap = baseSnap({
      status: 'running',
      messages: messages as never,
      messagesRevision: 1,
    });
    const ac = new AbortController();

    const registry = {
      get: () => ({ ...snap, messages: [...snap.messages] }),
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      activate: async () => {
        snap.activation = {
          id: 'act-abort-stop',
          endpointKey: snap.key,
          mode: 'prompt',
          baselineMessageCount: 0,
          sequence: 1,
          origin: 'tool_call',
          settled: false,
          createdAt: Date.now(),
        };
        // Project the assistant message first so stopReason would stick without overwrite.
        for (const l of listeners) {
          l({
            type: 'endpoint_updated',
            key: snap.key,
            kind: 'full',
            snapshot: {
              ...snap,
              messages: [...snap.messages],
              activation: { ...snap.activation! },
            },
          });
        }
        queueMicrotask(() => ac.abort());
        return {
          activationId: 'act-abort-stop',
          snapshot: { ...snap, messages: [...snap.messages], activation: { ...snap.activation! } },
        };
      },
      abort: async () => {
        if (snap.activation) snap.activation.terminalOverride = 'cancelled';
        return { ...snap, messages: [...snap.messages] };
      },
      detach: async (_key: string, opts?: { activationId?: string }) => {
        if (opts?.activationId && snap.activation?.id !== opts.activationId) return;
        if (snap.activation && !snap.activation.settled) {
          const id = snap.activation.id;
          snap.activation = {
            ...snap.activation,
            settled: true,
            terminalOverride: 'cancelled',
            error: 'Endpoint detached',
          };
          for (const l of listeners) {
            l({
              type: 'activation_settled',
              key: snap.key,
              activationId: id,
              snapshot: {
                ...snap,
                messages: [...snap.messages],
                activation: { ...snap.activation },
              },
            });
          }
          snap.activation = undefined;
        }
        snap.status = 'detached';
      },
    } as unknown as InteractiveAgentRegistry;

    const runPromise = runSingleAgentPiRpc(
      '/tmp',
      [makeAgent()],
      'worker',
      'abort-after-stop',
      undefined,
      undefined,
      ac.signal,
      undefined,
      makeDetails,
      {
        interactiveRegistry: registry,
        endpointKey: 'run1:single',
        hostMode: 'tui',
        sessionFile: '/tmp/s.jsonl',
        settleTimeoutMs: 20,
        timers: fake.timers,
      }
    );
    // Drive settle timeout so detach runs if abort did not settle.
    await new Promise((r) => setImmediate(r));
    await fake.flush(30);

    let caught: unknown;
    try {
      await runPromise;
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AgentAbortError);
    const result = (caught as AgentAbortError).result;
    expect(result.stopReason).toBe('aborted');
    expect(result.stopReason).not.toBe('stop');
    expect(result.status === 'cancelled' || result.status === 'interrupted').toBe(true);
  });

  it('user abort arms bounded settle timeout and throws AgentAbortError/cancelled', async () => {
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    const fake = makeFakeTimers();
    const snap = baseSnap({ status: 'running', messages: [] });
    let abortCalls = 0;
    let detachOpts: { activationId?: string } | undefined;

    const ac = new AbortController();
    const registry = {
      get: () => ({ ...snap, messages: [...snap.messages] }),
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      activate: async () => {
        snap.activation = {
          id: 'act-abort',
          endpointKey: snap.key,
          mode: 'prompt',
          baselineMessageCount: 0,
          sequence: 1,
          origin: 'tool_call',
          settled: false,
          createdAt: Date.now(),
        };
        return { activationId: 'act-abort', snapshot: { ...snap, messages: [] } };
      },
      abort: async () => {
        abortCalls += 1;
        if (snap.activation) snap.activation.terminalOverride = 'cancelled';
        return { ...snap, messages: [] };
      },
      detach: async (_key: string, opts?: { activationId?: string }) => {
        detachOpts = opts;
        if (opts?.activationId && snap.activation?.id !== opts.activationId) return;
        if (snap.activation && !snap.activation.settled) {
          const id = snap.activation.id;
          snap.activation = {
            ...snap.activation,
            settled: true,
            terminalOverride: 'cancelled',
            error: 'Endpoint detached',
          };
          for (const l of listeners) {
            l({
              type: 'activation_settled',
              key: snap.key,
              activationId: id,
              snapshot: {
                ...snap,
                messages: [],
                activation: { ...snap.activation },
              },
            });
          }
          snap.activation = undefined;
        }
        snap.status = 'detached';
      },
    } as unknown as InteractiveAgentRegistry;

    const runPromise = runSingleAgentPiRpc(
      '/tmp',
      [makeAgent()],
      'worker',
      'abort-me',
      undefined,
      undefined,
      ac.signal,
      undefined,
      makeDetails,
      {
        interactiveRegistry: registry,
        endpointKey: 'run1:single',
        hostMode: 'tui',
        sessionFile: '/tmp/s.jsonl',
        settleTimeoutMs: 40,
        timers: fake.timers,
      }
    );

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    ac.abort();
    await new Promise((r) => setImmediate(r));
    expect(abortCalls).toBe(1);

    // Without agent_settled, timeout must detach activation-scoped and finish.
    await fake.flush(40);

    await expect(runPromise).rejects.toBeInstanceOf(AgentAbortError);
    try {
      await runPromise;
    } catch (err) {
      expect(err).toBeInstanceOf(AgentAbortError);
      const abortErr = err as AgentAbortError;
      expect(
        abortErr.result.status === 'cancelled' || abortErr.result.status === 'interrupted'
      ).toBe(true);
    }
    expect(detachOpts?.activationId).toBe('act-abort');
  });

  it('abort settle timeout is activation-scoped and does not detach a later activation', async () => {
    const fake = makeFakeTimers();
    const snap = baseSnap({ status: 'running', messages: [] });
    const detachCalls: Array<string | undefined> = [];
    let activateSeq = 0;

    const registry = {
      get: () => ({ ...snap, messages: [...snap.messages] }),
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        void fn;
        return () => undefined;
      },
      activate: async () => {
        activateSeq += 1;
        const id = activateSeq === 1 ? 'act-A' : 'act-B';
        snap.activation = {
          id,
          endpointKey: snap.key,
          mode: 'prompt',
          baselineMessageCount: 0,
          sequence: activateSeq,
          origin: 'tool_call',
          settled: false,
          createdAt: Date.now(),
        };
        return { activationId: id, snapshot: { ...snap, messages: [] } };
      },
      abort: async () => {
        if (snap.activation) snap.activation.terminalOverride = 'cancelled';
        return snap;
      },
      detach: async (_key: string, opts?: { activationId?: string }) => {
        detachCalls.push(opts?.activationId);
        // Activation-scoped no-op when B is live and timer carries A.
        if (opts?.activationId && snap.activation?.id !== opts.activationId) return;
        snap.activation = undefined;
        snap.status = 'detached';
      },
    } as unknown as InteractiveAgentRegistry;

    const ac = new AbortController();
    const first = runSingleAgentPiRpc(
      '/tmp',
      [makeAgent()],
      'worker',
      'A',
      undefined,
      undefined,
      ac.signal,
      undefined,
      makeDetails,
      {
        interactiveRegistry: registry,
        endpointKey: 'run1:single',
        hostMode: 'tui',
        sessionFile: '/tmp/s.jsonl',
        settleTimeoutMs: 30,
        timers: fake.timers,
      }
    );

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    ac.abort();
    await new Promise((r) => setImmediate(r));

    // Before timeout: simulate A settled externally and B starting.
    snap.activation = {
      id: 'act-B',
      endpointKey: snap.key,
      mode: 'prompt',
      baselineMessageCount: 0,
      sequence: 2,
      origin: 'tool_call',
      settled: false,
      createdAt: Date.now(),
    };
    snap.status = 'running';

    await fake.flush(30);
    await expect(first).rejects.toBeInstanceOf(AgentAbortError);

    // Timer detached with A id; scoped detach must not clear B.
    expect(detachCalls).toContain('act-A');
    expect(snap.activation?.id).toBe('act-B');
  });
});

describe('runSingleAgentPiRpc real registry Pi 0.80.6 lifecycle', () => {
  it('does not resolve on agent_end; resolves only after agent_settled', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-rpc-life-'));
    const store = createRunStore({ rootDir: root });
    const coordinator = createRunCoordinator({ store });
    const agent = makeAgent({ name: 'worker', systemPrompt: '' });
    let eventListener: ((e: unknown) => void) | undefined;

    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'worker',
        task: 'lifecycle',
      },
      details: {
        mode: 'single',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
        results: [],
      },
      units: {
        single: {
          unitId: 'single',
          agent: 'worker',
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
    const sessionFile = path.join(store.getRunDir(runId), 'sessions', 'life.jsonl');
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

    let resolvePromptAccepted!: () => void;
    const promptAccepted = new Promise<void>((r) => {
      resolvePromptAccepted = r;
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
            return {
              sessionId: 'life',
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
            resolvePromptAccepted();
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
      hostSessionId: 'host-life',
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

    let resolved = false;
    const runPromise = runSingleAgentPiRpc(
      root,
      [agent],
      'worker',
      'lifecycle',
      undefined,
      undefined,
      undefined,
      undefined,
      makeDetails,
      {
        interactiveRegistry: registry,
        endpointKey: snap.key,
        hostMode: 'tui',
        sessionFile,
      }
    ).then((r) => {
      resolved = true;
      return r;
    });

    // Wait until activate() has accepted the initial prompt (activation is live).
    await promptAccepted;
    await new Promise((r) => setImmediate(r));
    expect(eventListener).toBeTruthy();
    expect(registry.get(snap.key)?.activation).toBeTruthy();

    eventListener?.({ type: 'agent_start' });
    eventListener?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'first run' }],
        usage: { input: 2, output: 2, totalTokens: 4 },
      },
    });
    // willRetry false alone must not resolve runSingleAgentPiRpc.
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    expect(registry.get(snap.key)?.status).toBe('running');
    expect(registry.get(snap.key)?.activation).toBeTruthy();

    // willRetry true alone must not resolve either.
    eventListener?.({ type: 'agent_end', messages: [], willRetry: true });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // Follow-up low-level run still under the same activation.
    eventListener?.({ type: 'agent_start' });
    eventListener?.({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'after follow-up' }],
        usage: { input: 1, output: 1, totalTokens: 2 },
      },
    });
    eventListener?.({ type: 'agent_end', messages: [], willRetry: false });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
    expect(registry.get(snap.key)?.activation).toBeTruthy();

    // Fully settled — only now may the parent tool return.
    eventListener?.({ type: 'agent_settled' });
    const result = await runPromise;
    expect(resolved).toBe(true);
    expect(registry.get(snap.key)?.status).toBe('idle');
    expect(registry.get(snap.key)?.activation).toBeUndefined();
    expect(result.messages.some((m) => JSON.stringify(m).includes('after follow-up'))).toBe(true);
    expect(result.status === 'completed' || result.exitCode === 0).toBe(true);

    await registry.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
