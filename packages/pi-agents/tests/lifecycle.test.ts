// ABOUTME: Tests spinner ticker cleanup registered against Pi tool and session lifecycle events.
// ABOUTME: Uses a multi-handler fake ExtensionAPI and injectable scheduler (no wall-clock waits).

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerSpinnerLifecycle } from '../src/index.ts';
import {
  activeSpinnerCount,
  type AgentToolRenderContext,
  installSpinnerScheduler,
  isSharedSpinnerTickerActive,
  type SpinnerScheduler,
  startSpinner,
  stopAllSpinners,
} from '../src/render.ts';

type Handler = (event?: Record<string, unknown>) => void;

/** Fake ExtensionAPI that accumulates handlers (matches Pi multi-listener semantics). */
function setupLifecycle() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as ExtensionAPI;
  registerSpinnerLifecycle(pi);
  return {
    handlers,
    emit(event: string, payload: Record<string, unknown> = {}) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
}

function createManualScheduler(): SpinnerScheduler & { tick: () => void } {
  let handler: (() => void) | undefined;
  return {
    setInterval(h) {
      handler = h;
      return 1;
    },
    clearInterval() {
      handler = undefined;
    },
    tick() {
      handler?.();
    },
  };
}

let nextId = 0;

function start(toolCallId = `lifecycle-${nextId++}`): AgentToolRenderContext {
  const context = {
    toolCallId,
    state: {},
    invalidate: () => {},
  } as AgentToolRenderContext;
  startSpinner(context);
  return context;
}

beforeEach(() => {
  stopAllSpinners();
  installSpinnerScheduler(undefined);
});
afterEach(() => {
  stopAllSpinners();
  installSpinnerScheduler(undefined);
});

describe('spinner lifecycle cleanup', () => {
  it('cleans the matching arm on agent tool execution end', () => {
    const manual = createManualScheduler();
    installSpinnerScheduler(manual);
    const { emit } = setupLifecycle();
    start('agent-call');
    start('other-call');
    expect(activeSpinnerCount()).toBe(2);

    emit('tool_execution_end', {
      toolCallId: 'agent-call',
      toolName: 'agent',
    });
    expect(activeSpinnerCount()).toBe(1);

    emit('tool_execution_end', {
      toolCallId: 'other-call',
      toolName: 'read',
    });
    expect(activeSpinnerCount()).toBe(1);
    stopAllSpinners();
  });

  for (const event of [
    'agent_end',
    'session_before_compact',
    'session_before_switch',
    'session_before_tree',
    'session_tree',
    'session_start',
    'session_shutdown',
  ]) {
    it(`cleans all arms on ${event}`, () => {
      const manual = createManualScheduler();
      installSpinnerScheduler(manual);
      const { emit } = setupLifecycle();
      start();
      start();
      expect(isSharedSpinnerTickerActive()).toBe(true);
      emit(event);
      expect(activeSpinnerCount()).toBe(0);
      expect(isSharedSpinnerTickerActive()).toBe(false);
    });
  }

  it('registers additive handlers so other session_shutdown listeners still run', () => {
    const handlers = new Map<string, Handler[]>();
    const pi = {
      on(event: string, handler: Handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    } as unknown as ExtensionAPI;

    let otherShutdown = 0;
    pi.on('session_shutdown', () => {
      otherShutdown++;
    });
    registerSpinnerLifecycle(pi);

    const manual = createManualScheduler();
    installSpinnerScheduler(manual);
    start();
    start();
    expect(activeSpinnerCount()).toBe(2);

    // Pi runs every registered handler for the event.
    for (const handler of handlers.get('session_shutdown') ?? []) handler({});
    expect(otherShutdown).toBe(1);
    expect(activeSpinnerCount()).toBe(0);
    expect(isSharedSpinnerTickerActive()).toBe(false);

    // Spinner registration itself is a single handler per event name.
    expect(handlers.get('session_before_tree')?.length).toBe(1);
    expect(handlers.get('session_tree')?.length).toBe(1);
    expect(handlers.get('session_shutdown')?.length).toBe(2);
  });

  it('tree navigation events match Pi 0.80.1 ExtensionAPI names', () => {
    const { handlers } = setupLifecycle();
    const registered = [...handlers.keys()].sort();
    expect(registered).toContain('session_before_tree');
    expect(registered).toContain('session_tree');
    expect(registered).toEqual(
      [
        'agent_end',
        'session_before_compact',
        'session_before_switch',
        'session_before_tree',
        'session_shutdown',
        'session_start',
        'session_tree',
        'tool_execution_end',
      ].sort()
    );
  });
});
