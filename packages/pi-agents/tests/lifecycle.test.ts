// ABOUTME: Tests spinner ticker cleanup registered against Pi tool and session lifecycle events.
// ABOUTME: Uses a minimal fake ExtensionAPI event registry without starting the extension runtime.

import { describe, expect, it } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerSpinnerLifecycle } from '../src/index.ts';
import {
  activeSpinnerCount,
  type AgentToolRenderContext,
  startSpinner,
  stopAllSpinners,
} from '../src/render.ts';

type Handler = (event?: Record<string, unknown>) => void;

function setupLifecycle() {
  const handlers = new Map<string, Handler>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  registerSpinnerLifecycle(pi);
  return handlers;
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

describe('spinner lifecycle cleanup', () => {
  it('cleans the matching ticker on agent tool execution end', () => {
    const handlers = setupLifecycle();
    start('agent-call');
    start('other-call');

    handlers.get('tool_execution_end')?.({
      toolCallId: 'agent-call',
      toolName: 'agent',
    });
    expect(activeSpinnerCount()).toBe(1);

    handlers.get('tool_execution_end')?.({
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
    'session_start',
    'session_shutdown',
  ]) {
    it(`cleans all tickers on ${event}`, () => {
      const handlers = setupLifecycle();
      start();
      start();
      handlers.get(event)?.({});
      expect(activeSpinnerCount()).toBe(0);
    });
  }
});
