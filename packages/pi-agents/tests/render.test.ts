// ABOUTME: Tests agent tool TUI rendering, including static running-status glyphs.
// ABOUTME: Uses fake renderer contexts without agent subprocesses.

import { describe, expect, it } from 'bun:test';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import {
  type AgentRenderState,
  type AgentToolRenderContext,
  renderResult,
  RUNNING_STATUS_GLYPH,
} from '../src/render.ts';
import type { SingleResult, SubagentDetails } from '../src/types.ts';

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
};

function fakeTheme(): Theme {
  return {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
  } as Theme;
}

let nextToolCallId = 0;

function makeContext(
  state: AgentRenderState = {},
  invalidate: () => void = () => {}
): {
  context: AgentToolRenderContext;
  state: AgentRenderState;
} {
  const context = {
    toolCallId: `tool-${nextToolCallId++}`,
    state,
    invalidate,
  } as AgentToolRenderContext;
  return { context, state };
}

function singleResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: 'explore',
    agentSource: 'user',
    task: 'find things',
    exitCode: 0,
    messages: [],
    stderr: '',
    usage: { ...emptyUsage },
    ...overrides,
  };
}

function singleDetails(result: SingleResult): SubagentDetails {
  return {
    mode: 'single',
    agentScope: 'user',
    projectAgentsDir: null,
    builtinAgentsDir: '/builtin',
    results: [result],
  };
}

function parallelDetails(results: SingleResult[]): SubagentDetails {
  return {
    mode: 'parallel',
    agentScope: 'user',
    projectAgentsDir: null,
    builtinAgentsDir: '/builtin',
    results,
  };
}

function backgroundDetails(): SubagentDetails {
  return {
    mode: 'background',
    agentScope: 'user',
    projectAgentsDir: null,
    builtinAgentsDir: '/builtin',
    results: [],
    background: [
      {
        jobId: 'agent-bg-1',
        mode: 'single',
        status: 'running',
        agentScope: 'user',
        description: 'explore find things',
        startedAt: 0,
        taskPreview: 'find things',
      },
    ],
  };
}

function renderText(component: Component): string {
  return component.render(120).join('\n');
}

describe('RUNNING_STATUS_GLYPH', () => {
  it('is the static hourglass-with-bars glyph', () => {
    expect(RUNNING_STATUS_GLYPH).toBe('⧗');
  });
});

describe('renderResult status icons', () => {
  const theme = fakeTheme();

  it('uses a static running glyph for single partial results and success on completion', () => {
    const { context } = makeContext();
    const partial = {
      content: [{ type: 'text', text: 'running' }],
      details: singleDetails(singleResult()),
    };

    const first = renderText(
      renderResult(partial, { expanded: false, isPartial: true }, theme, context)
    );
    expect(first.startsWith(RUNNING_STATUS_GLYPH)).toBe(true);
    expect(first).toContain('explore');

    const second = renderText(
      renderResult(partial, { expanded: false, isPartial: true }, theme, context)
    );
    expect(second.startsWith(RUNNING_STATUS_GLYPH)).toBe(true);
    expect(second).toBe(first);

    const done = renderText(
      renderResult(partial, { expanded: false, isPartial: false }, theme, context)
    );
    expect(done.startsWith('✓')).toBe(true);
  });

  it('uses a static running glyph for parallel tasks and success when all finish', () => {
    const { context } = makeContext();
    const running = {
      content: [{ type: 'text', text: 'parallel' }],
      details: parallelDetails([
        singleResult({ agent: 'a', exitCode: -1 }),
        singleResult({ agent: 'b', exitCode: -1 }),
      ]),
    };

    const text = renderText(
      renderResult(running, { expanded: false, isPartial: true }, theme, context)
    );
    expect(text.startsWith(RUNNING_STATUS_GLYPH)).toBe(true);
    expect(text).toContain('0/2 done, 2 running');
    expect(text).toContain('(running...)');
    expect(text.split(RUNNING_STATUS_GLYPH).length - 1).toBeGreaterThanOrEqual(3);

    const again = renderText(
      renderResult(running, { expanded: false, isPartial: true }, theme, context)
    );
    expect(again.startsWith(RUNNING_STATUS_GLYPH)).toBe(true);
    expect(again).toBe(text);

    const finished = {
      content: [{ type: 'text', text: 'done' }],
      details: parallelDetails([
        singleResult({ agent: 'a', exitCode: 0 }),
        singleResult({ agent: 'b', exitCode: 0 }),
      ]),
    };
    const done = renderText(
      renderResult(finished, { expanded: false, isPartial: false }, theme, context)
    );
    expect(done.startsWith('✓')).toBe(true);
    expect(done).toContain('2/2 tasks');
  });

  it('uses the error icon on failed finalization', () => {
    const { context } = makeContext();
    const failed = {
      content: [{ type: 'text', text: 'failed' }],
      details: singleDetails(
        singleResult({ exitCode: 1, stopReason: 'aborted', errorMessage: 'aborted' })
      ),
    };
    const text = renderText(
      renderResult(failed, { expanded: false, isPartial: false }, theme, context)
    );
    expect(text.startsWith('✗')).toBe(true);
  });

  it('renders empty/unknown results without a status glyph', () => {
    const { context } = makeContext();
    const text = renderText(
      renderResult(
        { content: [{ type: 'text', text: 'none' }], details: undefined },
        { expanded: false, isPartial: false },
        theme,
        context
      )
    );
    expect(text.trim()).toBe('none');
    expect(text).not.toContain(RUNNING_STATUS_GLYPH);
    expect(text).not.toContain('⧗');
    expect(text).not.toContain('✓');
    expect(text).not.toContain('✗');
  });

  it('uses the static running glyph for background launches', () => {
    const { context } = makeContext();

    const text = renderText(
      renderResult(
        {
          content: [{ type: 'text', text: 'launched' }],
          details: backgroundDetails(),
        },
        { expanded: false, isPartial: false },
        theme,
        context
      )
    );

    expect(text).toContain('⧗');
    expect(text).toContain('background');
    expect(text).toContain('agent-bg-1');
    expect(text).toContain('You will be notified when it completes.');
  });

  it('does not invalidate the TUI between host updates', async () => {
    let invalidations = 0;
    const { context } = makeContext({}, () => invalidations++);
    const partial = {
      content: [{ type: 'text', text: 'running' }],
      details: singleDetails(singleResult()),
    };

    renderResult(partial, { expanded: false, isPartial: true }, theme, context);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(invalidations).toBe(0);
  });
});
