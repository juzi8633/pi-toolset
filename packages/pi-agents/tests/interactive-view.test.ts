// ABOUTME: Tests for interactive navigator helpers: ordering, labels, truncation, tool results.
// ABOUTME: UI components are exercised via pure helpers without a live TUI terminal.

import { describe, expect, it } from 'bun:test';
import { getSelectListTheme, initTheme } from '@earendil-works/pi-coding-agent';
import type {
  InteractiveEndpointSnapshot,
  InteractiveRegistryEvent,
} from '../src/interactive-agent.ts';
import {
  AgentDetailPanel,
  AgentNavigatorPanel,
  createInteractiveViewController,
  __test,
} from '../src/interactive-view.ts';

// SelectList theme is the public getSelectListTheme() singleton; init once for render tests.
initTheme('dark');

function snap(
  overrides: Partial<InteractiveEndpointSnapshot> & { key: string; linkCreatedAt: number }
): InteractiveEndpointSnapshot {
  return {
    hostSessionId: 'h',
    runId: 'run',
    unitId: 'u',
    bindingId: 'b',
    agent: 'explore',
    sessionFile: '/tmp/s',
    effectiveCwd: '/tmp',
    status: 'idle',
    messages: [],
    messagesRevision: 0,
    streamRevision: 0,
    activeTools: [],
    steeringQueue: [],
    followUpQueue: [],
    lastUsedAt: 0,
    createdAt: 0,
    hasTransport: false,
    queueCount: 0,
    ...overrides,
  };
}

function fakeTheme() {
  return {
    fg: (_c: string, t: string) => t,
  };
}

describe('interactive-view helpers', () => {
  it('orders endpoints by link creation time', () => {
    const ordered = __test.endpointOrdering([
      snap({ key: 'a', linkCreatedAt: 30, agent: 'late' }),
      snap({ key: 'b', linkCreatedAt: 10, agent: 'early' }),
      snap({ key: 'c', linkCreatedAt: 20, agent: 'mid' }),
    ]);
    expect(ordered.map((e) => e.key)).toEqual(['b', 'c', 'a']);
  });

  it('truncates tool results to five lines and 4KB', () => {
    const fg = (_c: string, t: string) => t;
    const manyLines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const lines = __test.wrapToolResult(manyLines, 80, fg as never);
    expect(lines.some((l) => l.includes('truncated'))).toBe(true);
    // Total rows including the truncation marker ≤ TOOL_RESULT_MAX_LINES.
    expect(lines.length).toBeLessThanOrEqual(__test.TOOL_RESULT_MAX_LINES);
    expect(lines.filter((l) => l.startsWith('line')).length).toBeLessThanOrEqual(
      __test.TOOL_RESULT_MAX_LINES - 1
    );

    const big = 'x'.repeat(__test.TOOL_RESULT_MAX_BYTES + 100);
    const bigLines = __test.wrapToolResult(big, 80, fg as never);
    expect(bigLines.some((l) => l.includes('truncated'))).toBe(true);
    expect(bigLines.length).toBeLessThanOrEqual(__test.TOOL_RESULT_MAX_LINES);
  });

  it('truncates by UTF-8 bytes without splitting CJK or emoji code points', () => {
    // CJK ideograph is 3 bytes; emoji 😀 is 4 bytes (U+1F600).
    const cjk = '字';
    const emoji = '😀';
    expect(Buffer.byteLength(cjk, 'utf8')).toBe(3);
    expect(Buffer.byteLength(emoji, 'utf8')).toBe(4);

    // Budget of 5 bytes: one CJK (3) + partial next CJK must not split → only one char.
    const twoCjk = cjk.repeat(2);
    const t1 = __test.truncateUtf8Bytes(twoCjk, 5);
    expect(t1.truncated).toBe(true);
    expect(t1.text).toBe(cjk);
    expect(Buffer.byteLength(t1.text, 'utf8')).toBeLessThanOrEqual(5);

    // Budget of 5 bytes with emoji (4): one emoji fits; second does not split.
    const twoEmoji = emoji.repeat(2);
    const t2 = __test.truncateUtf8Bytes(twoEmoji, 5);
    expect(t2.truncated).toBe(true);
    expect(t2.text).toBe(emoji);
    // Full code point kept (UTF-16 may use a surrogate pair; must not be half a pair).
    expect([...t2.text]).toEqual([emoji]);
    expect(t2.text.codePointAt(0)).toBe(0x1f600);

    // Exactly 4 bytes: full emoji kept.
    const t3 = __test.truncateUtf8Bytes(emoji, 4);
    expect(t3.truncated).toBe(false);
    expect(t3.text).toBe(emoji);

    // wrapToolResult uses the same byte cap.
    const fg = (_c: string, t: string) => t;
    const payload = emoji.repeat(2000); // 8000 bytes
    const wrapped = __test.wrapToolResult(payload, 40, fg as never);
    expect(wrapped.some((l) => l.includes('truncated'))).toBe(true);
    const joined = wrapped.filter((l) => !l.includes('truncated')).join('');
    expect(Buffer.byteLength(joined, 'utf8')).toBeLessThanOrEqual(__test.TOOL_RESULT_MAX_BYTES);
  });

  it('wraps long single lines without quadratic blowup and preserves width', () => {
    const long = 'a'.repeat(50_000);
    const t0 = Date.now();
    const lines = __test.wrapPlain(long, 80);
    const elapsed = Date.now() - t0;
    expect(lines.length).toBeGreaterThan(500);
    expect(lines.every((l) => l.length <= 80)).toBe(true);
    // Linear scan should finish well under a second even for 50k chars.
    expect(elapsed).toBeLessThan(500);

    // CJK double-width: width 4 should wrap every 2 chars.
    const cjkLine = '中文测试一行';
    const cjkWrapped = __test.wrapPlain(cjkLine, 4);
    expect(cjkWrapped.length).toBeGreaterThan(1);
    expect(cjkWrapped.join('')).toBe(cjkLine);
  });

  it('formats user messages with You label', () => {
    const fg = (_c: string, t: string) => t;
    const lines = __test.formatMessage(
      { role: 'user', content: 'hello world' } as never,
      40,
      fg as never
    );
    expect(lines[0]).toContain('You');
    expect(lines.join('')).toContain('hello world');
  });

  it('enforces visibleWidth <= width for narrow/full/CJK/emoji and 4KiB tool result panel', async () => {
    const { visibleWidth } = await import('@earendil-works/pi-tui');
    const fg = (c: string, t: string) => (c === 'dim' || c === 'warning' ? t : t);

    const assertWidth = (lines: string[], width: number) => {
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    };

    // Narrow width with CJK + emoji stream cursor and tool status suffix.
    const narrow = 12;
    const cjkStream = __test.formatMessage(
      {
        role: 'assistant',
        content: [{ type: 'text', text: '中文😀测试长内容超出宽度' }],
      } as never,
      narrow,
      fg as never,
      true
    );
    assertWidth(cjkStream, narrow);

    const toolLines = __test.formatTranscriptLines(
      {
        messages: [],
        activeTools: [
          {
            toolCallId: 't1',
            toolName: 'bash',
            args: { command: 'echo ' + 'x'.repeat(80) },
            ended: true,
            isError: true,
          },
        ],
        steeringQueue: ['steer-' + 's'.repeat(40)],
        followUpQueue: ['follow-' + 'f'.repeat(40)],
      },
      narrow,
      fg as never
    );
    assertWidth(toolLines, narrow);
    // Wider width keeps the status suffix after the tool call.
    const wideTool = __test.formatTranscriptLines(
      {
        messages: [],
        activeTools: [
          {
            toolCallId: 't1',
            toolName: 'bash',
            args: { command: 'ls' },
            ended: true,
            isError: true,
          },
        ],
      },
      40,
      fg as never
    );
    assertWidth(wideTool, 40);
    expect(wideTool.some((l) => l.includes('error'))).toBe(true);

    // Full width panel-like render: header-length help text, 4KiB single-line tool result.
    const full = 80;
    const bigResult = '字'.repeat(2000); // multi-byte; > 4KiB when combined
    const bigPayload = 'A'.repeat(4 * 1024 + 256);
    const toolResultLines = __test.wrapToolResult(bigPayload, full, fg as never);
    assertWidth(toolResultLines, full);
    // Marker is included in the 5-line budget (not +1).
    expect(toolResultLines.length).toBeLessThanOrEqual(__test.TOOL_RESULT_MAX_LINES);
    expect(toolResultLines.some((l) => l.includes('truncated'))).toBe(true);
    const contentJoined = toolResultLines.filter((l) => !l.includes('truncated')).join('');
    expect(Buffer.byteLength(contentJoined, 'utf8')).toBeLessThanOrEqual(
      __test.TOOL_RESULT_MAX_BYTES
    );

    const cjkResult = __test.wrapToolResult(bigResult, 20, fg as never);
    assertWidth(cjkResult, 20);
    expect(cjkResult.length).toBeLessThanOrEqual(__test.TOOL_RESULT_MAX_LINES);

    // Entire segmented panel transcript under full width.
    const panel = __test.formatTranscriptLines(
      {
        messages: [
          { role: 'user', content: '请检查 ' + '路径'.repeat(30) } as never,
          {
            role: 'assistant',
            content: [
              { type: 'text', text: '分析中' + '文'.repeat(60) },
              {
                type: 'toolCall',
                name: 'read',
                arguments: { path: '/very/long/path/' + 'seg/'.repeat(20) + 'file.ts' },
              },
            ],
          } as never,
          {
            role: 'toolResult',
            content: [{ type: 'text', text: bigPayload }],
          } as never,
        ],
        streamingMessage: {
          role: 'assistant',
          content: [{ type: 'text', text: 'streaming ' + 'x'.repeat(100) }],
        } as never,
        activeTools: [
          {
            toolCallId: 't2',
            toolName: 'bash',
            args: { command: 'rg -n pattern ' + 'dir/'.repeat(15) },
            ended: true,
            isError: false,
          },
        ],
      },
      full,
      fg as never
    );
    assertWidth(panel, full);

    // Detail panel render: header/help/status/input all width-capped.
    const mockInput = {
      render: (w: number) => ['input-' + 'i'.repeat(Math.max(0, w + 10))],
      invalidate: () => undefined,
      setValue: () => undefined,
      getValue: () => '',
      handleInput: () => undefined,
    };
    const panelUi = new AgentDetailPanel({
      endpointKey: 'run:u',
      registry: {
        get: () =>
          snap({
            key: 'run:u',
            linkCreatedAt: 1,
            title: 'very-long-agent-title-that-exceeds-narrow-width',
            agent: 'explore',
            status: 'running',
            sessionFile: '/tmp/' + 's'.repeat(80),
            queueCount: 2,
            messages: [
              {
                role: 'assistant',
                content: [{ type: 'text', text: 'panel body ' + 'y'.repeat(200) }],
              } as never,
            ],
            messagesRevision: 1,
            streamRevision: 1,
            activeTools: [
              {
                toolCallId: 't3',
                toolName: 'bash',
                args: { command: 'long ' + 'z'.repeat(100) },
                ended: true,
                isError: true,
              },
            ],
            streamingMessage: {
              role: 'assistant',
              content: [{ type: 'text', text: 'cursor ' + 'c'.repeat(100) }],
            } as never,
          }),
        subscribe: () => () => undefined,
        send: async () => undefined,
        abort: async () => undefined,
      } as never,
      tui: { requestRender: () => undefined, terminal: { rows: 24 } } as never,
      theme: fakeTheme() as never,
      onBack: () => undefined,
    });
    // Inject mock input so render does not depend on real Input internals.
    (panelUi as unknown as { input: typeof mockInput }).input = mockInput;
    panelUi['snap'] = (
      panelUi as unknown as { opts: { registry: { get: () => InteractiveEndpointSnapshot } } }
    ).opts.registry.get();

    for (const width of [10, 20, 40, 80]) {
      const rows = panelUi.render(width);
      assertWidth(rows, width);
    }
  });

  it('AgentNavigatorPanel header/help/rows respect visibleWidth <= width on narrow terminals', async () => {
    const { visibleWidth } = await import('@earendil-works/pi-tui');
    const assertWidth = (lines: string[], width: number) => {
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    };

    const longKey = 'run-very-long-id:unit-with-long-name';
    const nav = new AgentNavigatorPanel({
      tui: { requestRender: () => undefined, terminal: { rows: 24, columns: 12 } } as never,
      theme: fakeTheme() as never,
      registry: {
        listVisibleMeta: () => [
          {
            key: longKey,
            hostSessionId: 'h',
            runId: 'run-very-long-id-abcdefgh',
            unitId: 'unit-with-long-name',
            bindingId: 'b',
            agent: 'explore-with-a-very-long-agent-name',
            title: '任务标题超长需要截断显示',
            sessionFile: '/tmp/' + 's'.repeat(40),
            effectiveCwd: '/tmp',
            status: 'running',
            lastUsedAt: 0,
            createdAt: 0,
            linkCreatedAt: 1,
            hasTransport: true,
            queueCount: 3,
            hasActivation: true,
            usage: { model: 'gpt-very-long-model-name-xyz', turns: 1 } as never,
          },
        ],
        subscribe: () => () => undefined,
      } as never,
      endpointLabel: (ep) => ep.title || ep.agent,
      statusText: (ep) => `${ep.status} · queues ${ep.queueCount}`,
      onClose: () => undefined,
    });

    for (const width of [8, 12, 20, 40]) {
      const rows = nav.render(width);
      expect(rows.length).toBeGreaterThan(2);
      assertWidth(rows, width);
      // Top/bottom borders (accent), then header and help inside.
      expect(rows[0]).toBe('─'.repeat(width));
      expect(rows[rows.length - 1]).toBe('─'.repeat(width));
      expect(rows.some((r) => r.includes('Agent'))).toBe(true);
      expect(rows.some((r) => /enter|esc|close|open/i.test(r))).toBe(true);
    }
    nav.dispose();
  });

  it('AgentNavigatorPanel list theme matches public getSelectListTheme (prompt autocomplete)', () => {
    const nav = new AgentNavigatorPanel({
      tui: { requestRender: () => undefined } as never,
      theme: fakeTheme() as never,
      registry: {
        listVisibleMeta: () => [],
        subscribe: () => () => undefined,
      } as never,
      endpointLabel: (ep) => ep.agent,
      statusText: (ep) => ep.status,
      onClose: () => undefined,
    });
    const used = (nav as unknown as { listTheme: ReturnType<typeof getSelectListTheme> }).listTheme;
    const expected = getSelectListTheme();
    expect(used.selectedPrefix('>')).toBe(expected.selectedPrefix('>'));
    expect(used.selectedText('main')).toBe(expected.selectedText('main'));
    expect(used.description('status')).toBe(expected.description('status'));
    expect(used.scrollInfo('1/2')).toBe(expected.scrollInfo('1/2'));
    expect(used.noMatch('none')).toBe(expected.noMatch('none'));
    // Public theme uses muted (not dim/warning) for secondary SelectList text.
    expect(used.description('x')).toBe(expected.description('x'));
    expect(used.noMatch('x')).toBe(expected.noMatch('x'));
    nav.dispose();
  });

  it('AgentNavigatorPanel rows use ● main / ○ agent [- title] statusText via SelectList', () => {
    const endpoints = [
      {
        key: 'run:explore',
        hostSessionId: 'h',
        runId: 'run',
        unitId: 'explore-u',
        bindingId: 'b',
        agent: 'explore',
        title: '调查 agent nav',
        sessionFile: '/tmp/s',
        effectiveCwd: '/tmp',
        status: 'detached' as const,
        lastUsedAt: 0,
        createdAt: 0,
        linkCreatedAt: 1,
        hasTransport: false,
        queueCount: 0,
        hasActivation: false,
      },
      {
        key: 'run:plan',
        hostSessionId: 'h',
        runId: 'run',
        unitId: 'plan-u',
        bindingId: 'b',
        agent: 'plan',
        title: '规划输入框导航',
        sessionFile: '/tmp/s',
        effectiveCwd: '/tmp',
        status: 'detached' as const,
        lastUsedAt: 0,
        createdAt: 0,
        linkCreatedAt: 2,
        hasTransport: false,
        queueCount: 0,
        hasActivation: false,
      },
      {
        key: 'run:general',
        hostSessionId: 'h',
        runId: 'run',
        unitId: 'general-u',
        bindingId: 'b',
        agent: 'general',
        title: '确认 Pi nav 挂载能力',
        sessionFile: '/tmp/s',
        effectiveCwd: '/tmp',
        status: 'running' as const,
        lastUsedAt: 0,
        createdAt: 0,
        linkCreatedAt: 3,
        hasTransport: true,
        queueCount: 0,
        hasActivation: true,
      },
      // No title: agent only (no "agent - agent" duplication).
      {
        key: 'run:worker',
        hostSessionId: 'h',
        runId: 'run',
        unitId: 'worker-u',
        bindingId: 'b',
        agent: 'worker',
        title: '',
        sessionFile: '/tmp/s',
        effectiveCwd: '/tmp',
        status: 'idle' as const,
        lastUsedAt: 0,
        createdAt: 0,
        linkCreatedAt: 4,
        hasTransport: false,
        queueCount: 0,
        hasActivation: false,
      },
      // Title same as agent: avoid repeating the name.
      {
        key: 'run:review',
        hostSessionId: 'h',
        runId: 'run',
        unitId: 'review-u',
        bindingId: 'b',
        agent: 'review',
        title: 'review',
        sessionFile: '/tmp/s',
        effectiveCwd: '/tmp',
        status: 'detached' as const,
        lastUsedAt: 0,
        createdAt: 0,
        linkCreatedAt: 5,
        hasTransport: false,
        queueCount: 2,
        hasActivation: false,
      },
    ];
    const view = createInteractiveViewController({
      registry: {
        listVisibleMeta: () => endpoints,
        subscribe: () => () => undefined,
      } as never,
      isTui: () => false,
      getUi: () => null,
    });

    const nav = new AgentNavigatorPanel({
      tui: { requestRender: () => undefined, terminal: { rows: 24 } } as never,
      theme: fakeTheme() as never,
      registry: {
        listVisibleMeta: () => endpoints,
        subscribe: () => () => undefined,
      } as never,
      endpointLabel: view.endpointLabel,
      statusText: view.statusText,
      onClose: () => undefined,
    });

    const items = (
      nav as unknown as { buildItems: () => Array<{ value: string; label: string }> }
    ).buildItems();
    expect(items[0]).toEqual({ value: 'main', label: '● main' });

    // Names pad to a shared column so status (detached/running/…) lines up.
    const names = [
      'explore - 调查 agent nav',
      'plan - 规划输入框导航',
      'general - 确认 Pi nav 挂载能力',
      'worker',
      'review',
    ];
    const statuses = ['detached', 'detached', 'running', 'idle', 'detached · 2 queued'];
    const nameCol = __test.maxVisibleWidth(names);
    for (let i = 0; i < names.length; i++) {
      expect(items[i + 1]?.label).toBe(
        __test.formatEndpointListLabel(names[i]!, statuses[i]!, nameCol)
      );
    }
    // Explicit fixtures (CJK-aware padding).
    expect(items[1]?.label).toBe('○ explore - 调查 agent nav       detached');
    expect(items[2]?.label).toBe('○ plan - 规划输入框导航          detached');
    expect(items[3]?.label).toBe('○ general - 确认 Pi nav 挂载能力 running');
    // No title / title === agent: no duplicated name, no stray " - ".
    expect(items[4]?.label).toBe('○ worker                         idle');
    expect(items[5]?.label).toBe('○ review                         detached · 2 queued');
    expect(items[4]?.label).not.toContain(' - ');
    expect(items[5]?.label).not.toContain(' - ');

    const rows = nav.render(80);
    // Top/bottom borders use accent (full-width ─).
    expect(rows[0]).toBe('─'.repeat(80));
    expect(rows[rows.length - 1]).toBe('─'.repeat(80));
    expect(rows.some((r) => r.includes('Agent navigator'))).toBe(true);
    // SelectList selected prefix + label → "→ ● main"
    expect(rows.some((r) => r.includes('→ ● main'))).toBe(true);
    expect(rows.some((r) => r.includes(items[1]!.label))).toBe(true);
    expect(rows.some((r) => r.includes(items[2]!.label))).toBe(true);
    expect(rows.some((r) => r.includes(items[3]!.label))).toBe(true);
    expect(rows.some((r) => r.includes(items[4]!.label))).toBe(true);
    expect(rows.some((r) => r.includes(items[5]!.label))).toBe(true);
    nav.dispose();
  });

  it('formatEndpointListLabel pads names so status starts at one column', async () => {
    const { visibleWidth } = await import('@earendil-works/pi-tui');
    const names = [
      'explore - 调查 agent nav',
      'planner - 规划输入框导航',
      'worker - 确认 Pi nav 挂载能力',
    ];
    const nameCol = __test.maxVisibleWidth(names);
    const labels = names.map((n) => __test.formatEndpointListLabel(n, 'detached', nameCol));
    const startCols = labels.map((label) => {
      expect(label.endsWith('detached')).toBe(true);
      return visibleWidth(label.slice(0, label.length - 'detached'.length));
    });
    expect(new Set(startCols).size).toBe(1);
    // At least one row needs padding (names are not equal width).
    expect(labels.some((l) => l.includes('  detached'))).toBe(true);
    expect(labels[0]).toBe(__test.formatEndpointListLabel(names[0]!, 'detached', nameCol));
    expect(labels[2]).toMatch(/^○ worker - 确认 Pi nav 挂载能力 +detached$/);
  });
});

describe('interactive-view openView lifecycle', () => {
  it('openView calls ui.custom with { overlay: false } and restores viewOpen after close', async () => {
    const customOpts: unknown[] = [];
    let resolveCustom: ((value: null) => void) | undefined;
    let factoryInvoked = false;

    const ui = {
      custom: async (
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (result: null) => void
        ) => unknown,
        opts?: { overlay?: boolean }
      ) => {
        customOpts.push(opts);
        factoryInvoked = true;
        // Simulate long-lived custom surface; resolve when host would call done.
        return new Promise<null>((resolve) => {
          resolveCustom = resolve;
          // Invoke factory the way Pi does (component may dispose on close).
          const component = factory({ requestRender: () => undefined }, fakeTheme(), {}, (result) =>
            resolve(result)
          );
          void component;
        });
      },
      notify: () => undefined,
    };

    const view = createInteractiveViewController({
      registry: {
        listVisibleMeta: () => [],
        subscribe: () => () => undefined,
      } as never,
      isTui: () => true,
      getUi: () => ui,
    });

    expect(view.isViewOpen()).toBe(false);
    const openPromise = view.openView();
    // Allow openView to set viewOpen and enter ui.custom.
    await Promise.resolve();
    expect(factoryInvoked).toBe(true);
    expect(customOpts).toEqual([{ overlay: false }]);
    expect(view.isViewOpen()).toBe(true);

    resolveCustom?.(null);
    await openPromise;
    expect(view.isViewOpen()).toBe(false);
  });

  it('openView is re-entrant: second call while open is a no-op', async () => {
    let customCalls = 0;
    let resolveFirst: ((value: null) => void) | undefined;

    const ui = {
      custom: async () => {
        customCalls += 1;
        return new Promise<null>((resolve) => {
          resolveFirst = resolve;
        });
      },
    };

    const view = createInteractiveViewController({
      registry: {
        listVisibleMeta: () => [],
        subscribe: () => () => undefined,
      } as never,
      isTui: () => true,
      getUi: () => ui,
    });

    const first = view.openView();
    await Promise.resolve();
    expect(view.isViewOpen()).toBe(true);
    expect(customCalls).toBe(1);

    // Concurrent open while first is still open must not call ui.custom again.
    await view.openView();
    expect(customCalls).toBe(1);
    expect(view.isViewOpen()).toBe(true);

    resolveFirst?.(null);
    await first;
    expect(view.isViewOpen()).toBe(false);

    // After close, a new open is allowed.
    const second = view.openView();
    await Promise.resolve();
    expect(customCalls).toBe(2);
    resolveFirst?.(null);
    await second;
    expect(view.isViewOpen()).toBe(false);
  });

  it('openView is a no-op outside TUI and notifies when available', async () => {
    let customCalls = 0;
    let notified: Array<{ message: string; type: string }> = [];
    const ui = {
      custom: async () => {
        customCalls += 1;
        return null;
      },
      notify: (message: string, type: string) => {
        notified.push({ message, type });
      },
    };

    const view = createInteractiveViewController({
      registry: { listVisibleMeta: () => [], subscribe: () => () => undefined } as never,
      isTui: () => false,
      getUi: () => ui,
    });

    await view.openView();
    expect(customCalls).toBe(0);
    expect(view.isViewOpen()).toBe(false);
    expect(notified.length).toBe(1);
    expect(notified[0]?.type).toBe('warning');
    expect(notified[0]?.message.toLowerCase()).toMatch(/tui/);
  });

  it('hides below-editor widget while navigator is open and restores after close if active', async () => {
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    let rows = [
      {
        key: 'run:u',
        hostSessionId: 'h',
        runId: 'run',
        unitId: 'u',
        bindingId: 'b',
        agent: 'explore',
        title: 'explore',
        sessionFile: '/tmp/s',
        effectiveCwd: '/tmp',
        status: 'running' as const,
        lastUsedAt: 0,
        createdAt: 0,
        linkCreatedAt: 0,
        hasTransport: true,
        queueCount: 0,
        hasActivation: true,
      },
    ];
    let lastWidget: string[] | undefined;
    let resolveCustom: ((value: null) => void) | undefined;

    const registry = {
      listVisibleMeta: () => rows,
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    const ui = {
      setWidget: (_key: string, lines: string[] | undefined) => {
        lastWidget = lines;
      },
      custom: async () =>
        new Promise<null>((resolve) => {
          resolveCustom = resolve;
        }),
    };

    const view = createInteractiveViewController({
      registry: registry as never,
      isTui: () => true,
      getUi: () => ui,
    });
    view.installWidget();
    expect(lastWidget).toBeDefined();
    expect(lastWidget!.some((l) => l.includes('/agent view'))).toBe(true);

    const openPromise = view.openView();
    await Promise.resolve();
    expect(view.isViewOpen()).toBe(true);
    // Entire widget including the open hint is hidden while nav is open.
    expect(lastWidget).toBeUndefined();

    // Registry updates during open must not re-show the widget.
    for (const l of listeners) {
      l({ type: 'endpoints_changed', keys: rows.map((r) => r.key) });
    }
    expect(lastWidget).toBeUndefined();

    resolveCustom?.(null);
    await openPromise;
    expect(view.isViewOpen()).toBe(false);
    // Active agent still present → restore chrome including open hint.
    expect(lastWidget).toBeDefined();
    expect(lastWidget!.some((l) => l.includes('● main'))).toBe(true);
    expect(lastWidget!.some((l) => l.includes('/agent view'))).toBe(true);

    view.clearWidget();
  });

  it('does not restore below-editor widget after close when no endpoint is active', async () => {
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    let rows: Array<{
      key: string;
      hostSessionId: string;
      runId: string;
      unitId: string;
      bindingId: string;
      agent: string;
      title: string;
      sessionFile: string;
      effectiveCwd: string;
      status: InteractiveEndpointSnapshot['status'];
      lastUsedAt: number;
      createdAt: number;
      linkCreatedAt: number;
      hasTransport: boolean;
      queueCount: number;
      hasActivation: boolean;
    }> = [
      {
        key: 'run:u',
        hostSessionId: 'h',
        runId: 'run',
        unitId: 'u',
        bindingId: 'b',
        agent: 'explore',
        title: 'explore',
        sessionFile: '/tmp/s',
        effectiveCwd: '/tmp',
        status: 'running',
        lastUsedAt: 0,
        createdAt: 0,
        linkCreatedAt: 0,
        hasTransport: true,
        queueCount: 0,
        hasActivation: true,
      },
    ];
    let lastWidget: string[] | undefined;
    let resolveCustom: ((value: null) => void) | undefined;

    const registry = {
      listVisibleMeta: () => rows,
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    const ui = {
      setWidget: (_key: string, lines: string[] | undefined) => {
        lastWidget = lines;
      },
      custom: async () =>
        new Promise<null>((resolve) => {
          resolveCustom = resolve;
        }),
    };

    const view = createInteractiveViewController({
      registry: registry as never,
      isTui: () => true,
      getUi: () => ui,
    });
    view.installWidget();
    expect(lastWidget).toBeDefined();

    const openPromise = view.openView();
    await Promise.resolve();
    expect(lastWidget).toBeUndefined();

    // Agent finishes while navigator is still open.
    rows = [{ ...rows[0]!, status: 'idle', hasActivation: true }];
    for (const l of listeners) {
      l({
        type: 'endpoint_updated',
        key: 'run:u',
        kind: 'meta',
        snapshot: snap({ key: 'run:u', linkCreatedAt: 1, status: 'idle' }),
      });
    }
    expect(lastWidget).toBeUndefined();

    resolveCustom?.(null);
    await openPromise;
    // No starting/running endpoints → stay hidden.
    expect(lastWidget).toBeUndefined();

    view.clearWidget();
  });

  it('keeps widget hidden for the whole custom session (list and detail share one open)', async () => {
    let lastWidget: string[] | undefined;
    let resolveCustom: ((value: null) => void) | undefined;
    let panel: AgentNavigatorPanel | undefined;

    const rows = [
      {
        key: 'run:u',
        hostSessionId: 'h',
        runId: 'run',
        unitId: 'u',
        bindingId: 'b',
        agent: 'explore',
        title: 'explore',
        sessionFile: '/tmp/s',
        effectiveCwd: '/tmp',
        status: 'running' as const,
        lastUsedAt: 0,
        createdAt: 0,
        linkCreatedAt: 0,
        hasTransport: true,
        queueCount: 0,
        hasActivation: true,
      },
    ];

    const ui = {
      setWidget: (_key: string, lines: string[] | undefined) => {
        lastWidget = lines;
      },
      custom: async (
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (result: null) => void
        ) => unknown
      ) =>
        new Promise<null>((resolve) => {
          resolveCustom = resolve;
          panel = factory({ requestRender: () => undefined }, fakeTheme(), {}, (result) =>
            resolve(result)
          ) as AgentNavigatorPanel;
        }),
    };

    const view = createInteractiveViewController({
      registry: {
        listVisibleMeta: () => rows,
        get: () =>
          snap({
            key: 'run:u',
            linkCreatedAt: 1,
            status: 'running',
            agent: 'explore',
            title: 'explore',
          }),
        subscribe: () => () => undefined,
        send: async () => undefined,
        abort: async () => undefined,
      } as never,
      isTui: () => true,
      getUi: () => ui,
    });
    view.installWidget();
    expect(lastWidget).toBeDefined();

    const openPromise = view.openView();
    await Promise.resolve();
    expect(view.isViewOpen()).toBe(true);
    expect(lastWidget).toBeUndefined();
    expect(panel).toBeDefined();

    // Switch list → detail inside the same custom session; widget must stay hidden.
    const items = (
      panel as unknown as { buildItems: () => Array<{ value: string; label: string }> }
    ).buildItems();
    const child = items.find((i) => i.value !== 'main');
    expect(child).toBeDefined();
    (
      panel as unknown as { handleListSelect: (item: { value: string; label: string }) => void }
    ).handleListSelect(child!);
    expect(view.isViewOpen()).toBe(true);
    expect(lastWidget).toBeUndefined();
    expect((panel as unknown as { mode: string }).mode).toBe('detail');

    resolveCustom?.(null);
    await openPromise;
    expect(view.isViewOpen()).toBe(false);
    expect(lastWidget).toBeDefined();

    panel?.dispose();
    view.clearWidget();
  });
});

describe('interactive-view finalized tool calls', () => {
  it('keeps assistant toolCall parts and ended tool activities in transcript', () => {
    const fg = (_c: string, t: string) => t;
    const lines = __test.formatTranscriptLines(
      {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Reading file' },
              { type: 'toolCall', name: 'read', arguments: { path: 'src/a.ts' } },
            ],
          } as never,
          {
            role: 'toolResult',
            content: [{ type: 'text', text: 'file contents here' }],
          } as never,
        ],
        activeTools: [
          {
            toolCallId: 't1',
            toolName: 'bash',
            args: { command: 'ls' },
            ended: true,
            isError: false,
          },
        ],
      },
      80,
      fg as never
    );

    const joined = lines.join('\n');
    expect(joined).toContain('Reading file');
    // formatToolCall renders read path
    expect(joined.toLowerCase()).toMatch(/read|a\.ts/);
    expect(joined).toContain('file contents here');
    expect(joined).toContain('done');
    expect(joined).toMatch(/\$ |ls/);
  });
});

describe('interactive-view widget metadata refresh', () => {
  function metaRow(
    overrides: Partial<{
      key: string;
      unitId: string;
      agent: string;
      title: string;
      status: InteractiveEndpointSnapshot['status'];
      hasActivation: boolean;
      linkCreatedAt: number;
    }> = {}
  ) {
    return {
      key: 'run:u',
      hostSessionId: 'h',
      runId: 'run',
      unitId: 'u',
      bindingId: 'b',
      agent: 'explore',
      title: 'explore',
      sessionFile: '/tmp/s',
      effectiveCwd: '/tmp',
      status: 'running' as const,
      lastUsedAt: 0,
      createdAt: 0,
      linkCreatedAt: 0,
      hasTransport: true,
      queueCount: 0,
      hasActivation: true,
      ...overrides,
    };
  }

  it('does not rebuild widget chrome on transcript-only endpoint updates', () => {
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    let listVisibleCalls = 0;
    let listVisibleMetaCalls = 0;
    let setWidgetCalls = 0;

    const registry = {
      listVisible: () => {
        listVisibleCalls += 1;
        throw new Error('widget must not call listVisible (full history snapshots)');
      },
      listVisibleMeta: () => {
        listVisibleMetaCalls += 1;
        return [metaRow({ status: 'running' })];
      },
      get: () => undefined,
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };

    const ui = {
      setWidget: () => {
        setWidgetCalls += 1;
      },
    };

    const view = createInteractiveViewController({
      registry: registry as never,
      isTui: () => true,
      getUi: () => ui,
    });
    view.installWidget();
    const afterInstall = setWidgetCalls;
    expect(afterInstall).toBeGreaterThan(0);
    expect(listVisibleMetaCalls).toBeGreaterThan(0);
    expect(listVisibleCalls).toBe(0);

    const metaCallsBefore = listVisibleMetaCalls;
    const widgetCallsBefore = setWidgetCalls;

    // Transcript-only stream events must not refresh chrome or touch history APIs.
    for (let i = 0; i < 10; i++) {
      for (const l of listeners) {
        l({
          type: 'endpoint_updated',
          key: 'run:u',
          kind: 'transcript',
          snapshot: snap({ key: 'run:u', linkCreatedAt: 1, status: 'running' }),
        });
      }
    }
    expect(listVisibleMetaCalls).toBe(metaCallsBefore);
    expect(setWidgetCalls).toBe(widgetCallsBefore);
    expect(listVisibleCalls).toBe(0);

    // Meta update should refresh once.
    for (const l of listeners) {
      l({
        type: 'endpoint_updated',
        key: 'run:u',
        kind: 'meta',
        snapshot: snap({ key: 'run:u', linkCreatedAt: 1, status: 'running' }),
      });
    }
    expect(listVisibleMetaCalls).toBe(metaCallsBefore + 1);
    expect(setWidgetCalls).toBe(widgetCallsBefore + 1);

    view.clearWidget();
  });

  it('clears below-editor widget when all visible endpoints are idle', () => {
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    let rows = [metaRow({ status: 'idle', hasActivation: true })];
    let lastWidget: string[] | undefined = ['sentinel'];

    const registry = {
      listVisibleMeta: () => rows,
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    const ui = {
      setWidget: (_key: string, lines: string[] | undefined) => {
        lastWidget = lines;
      },
    };

    const view = createInteractiveViewController({
      registry: registry as never,
      isTui: () => true,
      getUi: () => ui,
    });
    view.installWidget();
    // Idle-only (even with hasActivation) must not show chrome.
    expect(lastWidget).toBeUndefined();

    for (const status of ['registered', 'detached', 'error', 'unavailable'] as const) {
      rows = [metaRow({ status, hasActivation: status === 'error' })];
      for (const l of listeners) {
        l({ type: 'endpoints_changed', keys: rows.map((r) => r.key) });
      }
      expect(lastWidget).toBeUndefined();
    }

    view.clearWidget();
  });

  it('shows below-editor widget for starting or running endpoints', () => {
    for (const status of ['starting', 'running'] as const) {
      let lastWidget: string[] | undefined;
      const view = createInteractiveViewController({
        registry: {
          listVisibleMeta: () => [metaRow({ status, title: `agent-${status}` })],
          subscribe: () => () => undefined,
        } as never,
        isTui: () => true,
        getUi: () => ({
          setWidget: (_key: string, lines: string[] | undefined) => {
            lastWidget = lines;
          },
        }),
      });
      view.installWidget();
      expect(lastWidget).toBeDefined();
      expect(lastWidget!.some((l) => l.includes(`agent-${status}`))).toBe(true);
      expect(lastWidget!.some((l) => l.includes(status))).toBe(true);
      view.clearWidget();
    }
  });

  it('clears below-editor widget after running becomes idle', () => {
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    let rows = [metaRow({ status: 'running' })];
    let lastWidget: string[] | undefined;

    const registry = {
      listVisibleMeta: () => rows,
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
    const ui = {
      setWidget: (_key: string, lines: string[] | undefined) => {
        lastWidget = lines;
      },
    };

    const view = createInteractiveViewController({
      registry: registry as never,
      isTui: () => true,
      getUi: () => ui,
    });
    view.installWidget();
    expect(lastWidget).toBeDefined();
    expect(lastWidget!.some((l) => l.includes('running'))).toBe(true);

    rows = [metaRow({ status: 'idle', hasActivation: true })];
    for (const l of listeners) {
      l({
        type: 'endpoint_updated',
        key: 'run:u',
        kind: 'meta',
        snapshot: snap({ key: 'run:u', linkCreatedAt: 1, status: 'idle' }),
      });
    }
    expect(lastWidget).toBeUndefined();

    // activation_settled also refreshes chrome; still idle → stays cleared.
    for (const l of listeners) {
      l({
        type: 'activation_settled',
        key: 'run:u',
        activationId: 'act-1',
        snapshot: snap({ key: 'run:u', linkCreatedAt: 1, status: 'idle' }),
      });
    }
    expect(lastWidget).toBeUndefined();

    view.clearWidget();
  });

  it('when one endpoint is active, widget lists all visible endpoints including idle', () => {
    let lastWidget: string[] | undefined;
    const view = createInteractiveViewController({
      registry: {
        listVisibleMeta: () => [
          metaRow({
            key: 'run:active',
            unitId: 'active',
            title: 'worker-active',
            status: 'running',
            linkCreatedAt: 1,
          }),
          metaRow({
            key: 'run:idle',
            unitId: 'idle',
            title: 'worker-idle',
            status: 'idle',
            hasActivation: false,
            linkCreatedAt: 2,
          }),
        ],
        subscribe: () => () => undefined,
      } as never,
      isTui: () => true,
      getUi: () => ({
        setWidget: (_key: string, lines: string[] | undefined) => {
          lastWidget = lines;
        },
      }),
    });
    view.installWidget();
    expect(lastWidget).toBeDefined();
    const joined = lastWidget!.join('\n');
    expect(joined).toContain('worker-active');
    expect(joined).toContain('worker-idle');
    expect(joined).toContain('running');
    expect(joined).toContain('idle');
    view.clearWidget();
  });

  it('invalidates transcript cache via explicit stream/messages revisions', () => {
    const base = {
      messagesRevision: 1,
      streamRevision: 1,
      queueCount: 0,
      activeTools: [] as InteractiveEndpointSnapshot['activeTools'],
    };
    const k1 = __test.buildTranscriptCacheKey(base, 80);
    const k2 = __test.buildTranscriptCacheKey({ ...base, streamRevision: 2 }, 80);
    const k3 = __test.buildTranscriptCacheKey({ ...base, messagesRevision: 2 }, 80);
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
    // Same-length content replacement is producer-side: only a revision bump invalidates.
    expect(k1).toBe(__test.buildTranscriptCacheKey(base, 80));
  });

  it('AgentDetailPanel cache is driven by revision, not unconditional invalidation', () => {
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    let current = snap({
      key: 'run:u',
      linkCreatedAt: 1,
      status: 'running',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'aaaa' }] } as never],
      messagesRevision: 1,
      streamRevision: 0,
      streamingMessage: {
        role: 'assistant',
        content: [{ type: 'text', text: 'xxxx' }],
      } as never,
    });

    const registry = {
      get: () => current,
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      send: async () => current,
      abort: async () => current,
    };

    const tui = {
      requestRender: () => undefined,
      terminal: { rows: 24 },
    };

    const panel = new AgentDetailPanel({
      tui: tui as never,
      theme: fakeTheme() as never,
      registry: registry as never,
      endpointKey: 'run:u',
      onBack: () => undefined,
    });

    const first = panel.render(80).join('\n');
    expect(first).toContain('xxxx');

    // Same width, same-length stream text replacement WITHOUT streamRevision bump:
    // revision-based key must keep the cache (proves listener does not blank cachedKey).
    current = snap({
      key: 'run:u',
      linkCreatedAt: 1,
      status: 'running',
      messages: current.messages,
      messagesRevision: 1,
      streamRevision: 0,
      streamingMessage: {
        role: 'assistant',
        content: [{ type: 'text', text: 'yyyy' }],
      } as never,
    });
    for (const l of listeners) {
      l({
        type: 'endpoint_updated',
        key: 'run:u',
        kind: 'transcript',
        snapshot: current,
      });
    }
    const stale = panel.render(80).join('\n');
    expect(stale).toContain('xxxx');
    expect(stale).not.toContain('yyyy');

    // Same length, different content, bumped streamRevision — must recompute and update.
    current = snap({
      key: 'run:u',
      linkCreatedAt: 1,
      status: 'running',
      messages: current.messages,
      messagesRevision: 1,
      streamRevision: 1,
      streamingMessage: {
        role: 'assistant',
        content: [{ type: 'text', text: 'yyyy' }],
      } as never,
    });
    for (const l of listeners) {
      l({
        type: 'endpoint_updated',
        key: 'run:u',
        kind: 'transcript',
        snapshot: current,
      });
    }
    const second = panel.render(80).join('\n');
    expect(second).toContain('yyyy');
    expect(second).not.toContain('xxxx');

    // Finalized same-length content replacement requires messagesRevision bump.
    current = snap({
      key: 'run:u',
      linkCreatedAt: 1,
      status: 'running',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'bbbb' }] } as never],
      messagesRevision: 2,
      streamRevision: 1,
    });
    for (const l of listeners) {
      l({
        type: 'endpoint_updated',
        key: 'run:u',
        kind: 'full',
        snapshot: current,
      });
    }
    const third = panel.render(80).join('\n');
    expect(third).toContain('bbbb');
    expect(third).not.toContain('aaaa');

    panel.dispose();
  });

  it('long history + burst deltas do not re-format finalized history', () => {
    // Drive real AgentDetailPanel: append-aware finalized cache + format call counts.
    const history = Array.from({ length: 200 }, (_, i) =>
      Object.freeze({
        role: 'assistant' as const,
        content: Object.freeze([{ type: 'text', text: `hist-${i}-${'x'.repeat(40)}` }]),
      })
    );
    // Shared frozen array (append-only identity for later message_end).
    let messages: readonly unknown[] = Object.freeze([...history]);

    let current = snap({
      key: 'run:u',
      linkCreatedAt: 1,
      status: 'running',
      messages: messages as never,
      messagesRevision: 5,
      streamRevision: 1,
      streamingMessage: {
        role: 'assistant',
        content: [{ type: 'text', text: 'stream-0' }],
      } as never,
    });
    const listeners = new Set<(e: InteractiveRegistryEvent) => void>();
    const registry = {
      get: () => current,
      ensureTranscript: async () => current,
      subscribe: (fn: (e: InteractiveRegistryEvent) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      send: async () => current,
      abort: async () => current,
    };
    const tui = { requestRender: () => undefined, terminal: { rows: 24 } };
    const panel = new AgentDetailPanel({
      tui: tui as never,
      theme: fakeTheme() as never,
      registry: registry as never,
      endpointKey: 'run:u',
      onBack: () => undefined,
    });

    panel.render(80);
    expect(panel.finalizedFormatCalls).toBe(200);
    const afterFirst = panel.finalizedFormatCalls;

    // Burst stream deltas: messagesRevision unchanged → zero additional finalized formats.
    for (let i = 1; i <= 50; i++) {
      current = snap({
        key: 'run:u',
        linkCreatedAt: 1,
        status: 'running',
        messages: messages as never,
        messagesRevision: 5,
        streamRevision: i + 1,
        streamingMessage: {
          role: 'assistant',
          content: [{ type: 'text', text: `stream-${i}-tail` }],
        } as never,
      });
      for (const l of listeners) {
        l({
          type: 'endpoint_updated',
          key: 'run:u',
          kind: 'transcript',
          snapshot: current,
        });
      }
      panel.render(80);
    }
    expect(panel.finalizedFormatCalls).toBe(afterFirst);
    expect(panel.render(80).join('\n')).toContain('stream-50-tail');

    // message_end append: only the new message is formatted (not full history again).
    const newMsg = Object.freeze({
      role: 'assistant' as const,
      content: Object.freeze([{ type: 'text', text: 'hist-new-appended' }]),
    });
    messages = Object.freeze([...messages, newMsg]);
    current = snap({
      key: 'run:u',
      linkCreatedAt: 1,
      status: 'running',
      messages: messages as never,
      messagesRevision: 6,
      streamRevision: 52,
      streamingMessage: undefined,
    });
    for (const l of listeners) {
      l({
        type: 'endpoint_updated',
        key: 'run:u',
        kind: 'full',
        snapshot: current,
      });
    }
    panel.render(80);
    expect(panel.finalizedFormatCalls).toBe(afterFirst + 1);
    expect(panel.render(80).join('\n')).toContain('hist-new-appended');

    // Width change forces full rebuild.
    panel.render(60);
    expect(panel.finalizedFormatCalls).toBe(afterFirst + 1 + 201);

    panel.dispose();
  });

  it('same tool count with different partialResult invalidates dynamic cache key', () => {
    const toolsA = [
      {
        toolCallId: 't1',
        toolName: 'bash',
        args: {},
        partialResult: 'aaa',
      },
    ];
    const toolsB = [
      {
        toolCallId: 't1',
        toolName: 'bash',
        args: {},
        partialResult: 'bbb',
      },
    ];
    const k1 = __test.buildDynamicCacheKey(
      {
        streamRevision: 1,
        queueCount: 0,
        activeTools: toolsA,
        steeringQueue: [],
        followUpQueue: [],
      },
      80
    );
    const k2 = __test.buildDynamicCacheKey(
      {
        streamRevision: 1,
        queueCount: 0,
        activeTools: toolsB,
        steeringQueue: [],
        followUpQueue: [],
      },
      80
    );
    expect(k1).not.toBe(k2);

    const q1 = __test.buildDynamicCacheKey(
      {
        streamRevision: 2,
        queueCount: 1,
        activeTools: [],
        steeringQueue: ['old'],
        followUpQueue: [],
      },
      80
    );
    const q2 = __test.buildDynamicCacheKey(
      {
        streamRevision: 2,
        queueCount: 1,
        activeTools: [],
        steeringQueue: ['new'],
        followUpQueue: [],
      },
      80
    );
    expect(q1).not.toBe(q2);
  });
});

describe('interactive-view detail preview (last 15 + Ctrl+O)', () => {
  const CTRL_O = '\x0f'; // ctrl+o
  const previewN = __test.DETAIL_PREVIEW_LINES;

  /** Unique per-line token so substring checks cannot collide (e.g. marker-2 vs marker-25). */
  function lineToken(i: number): string {
    return `L${String(i).padStart(3, '0')}-END`;
  }

  function longHistorySnap(lineCount: number) {
    const messages = Array.from({ length: lineCount }, (_, i) =>
      Object.freeze({
        role: 'assistant' as const,
        content: Object.freeze([{ type: 'text', text: lineToken(i) }]),
      })
    );
    return snap({
      key: 'run:u',
      linkCreatedAt: 1,
      status: 'idle',
      agent: 'explore',
      title: 'preview-agent',
      sessionFile: '/tmp/s',
      messages: messages as never,
      messagesRevision: 1,
      streamRevision: 0,
    });
  }

  function makePanel(lineCount: number, terminalRows = 40) {
    const current = longHistorySnap(lineCount);
    let inputHandled: string[] = [];
    const panel = new AgentDetailPanel({
      tui: { requestRender: () => undefined, terminal: { rows: terminalRows } } as never,
      theme: fakeTheme() as never,
      registry: {
        get: () => current,
        subscribe: () => () => undefined,
        send: async () => undefined,
        abort: async () => undefined,
      } as never,
      endpointKey: 'run:u',
      onBack: () => undefined,
    });
    // Spy Input so we can assert Ctrl+O never reaches it.
    const realInput = (panel as unknown as { input: { handleInput: (d: string) => void } }).input;
    const orig = realInput.handleInput.bind(realInput);
    realInput.handleInput = (d: string) => {
      inputHandled.push(d);
      orig(d);
    };
    return { panel, inputHandled: () => inputHandled };
  }

  it(`defaults to last ${__test.DETAIL_PREVIEW_LINES} lines regardless of terminal rows`, () => {
    // Large terminal must not expand the collapsed preview beyond DETAIL_PREVIEW_LINES.
    const { panel } = makePanel(40, 80);
    const rows = panel.render(80);
    const joined = rows.join('\n');

    // Last N markers visible; earlier history hidden.
    for (let i = 40 - previewN; i < 40; i++) {
      expect(joined).toContain(lineToken(i));
    }
    for (let i = 0; i < 40 - previewN; i++) {
      expect(joined).not.toContain(lineToken(i));
    }

    // Help clearly offers expand-all via Ctrl+O.
    expect(joined).toMatch(/Ctrl\+O expand all/i);
    expect(joined).not.toMatch(/Ctrl\+O collapse/i);

    // Collapsed content region is fixed at DETAIL_PREVIEW_LINES even on a tall terminal.
    const markerRows = rows.filter((r) => /L\d{3}-END/.test(r));
    expect(markerRows.length).toBe(previewN);

    panel.dispose();
  });

  it('Ctrl+O expands to full content and help switches to collapse', () => {
    const { panel, inputHandled } = makePanel(40, 40);
    panel.handleInput(CTRL_O);
    expect(inputHandled()).toEqual([]);

    const rows = panel.render(80);
    const joined = rows.join('\n');
    for (let i = 0; i < 40; i++) {
      expect(joined).toContain(lineToken(i));
    }
    expect(joined).toMatch(/Ctrl\+O collapse/i);
    expect(joined).not.toMatch(/Ctrl\+O expand all/i);
    expect(rows.filter((r) => /L\d{3}-END/.test(r)).length).toBe(40);

    panel.dispose();
  });

  it('Ctrl+O again restores last-N preview at the tail', () => {
    const { panel, inputHandled } = makePanel(40, 40);
    panel.handleInput(CTRL_O); // expand
    panel.handleInput(CTRL_O); // collapse
    expect(inputHandled()).toEqual([]);

    const joined = panel.render(80).join('\n');
    for (let i = 40 - previewN; i < 40; i++) {
      expect(joined).toContain(lineToken(i));
    }
    for (let i = 0; i < 40 - previewN; i++) {
      expect(joined).not.toContain(lineToken(i));
    }
    expect(joined).toMatch(/Ctrl\+O expand all/i);

    // Page up while collapsed, then expand+collapse must snap back to the tail.
    panel.handleInput('\x1b[5~'); // pageUp
    panel.handleInput(CTRL_O); // expand
    panel.handleInput(CTRL_O); // collapse → last N at tail
    const after = panel.render(80).join('\n');
    expect(after).toContain(lineToken(39));
    expect(after).not.toContain(lineToken(0));
    expect(after).toMatch(/Ctrl\+O expand all/i);
    expect(inputHandled()).toEqual([]);

    panel.dispose();
  });

  it('Ctrl+O is captured by the detail panel and never reaches Input', () => {
    const { panel, inputHandled } = makePanel(5, 24);
    // Type a letter first so Input is live; then Ctrl+O must still be intercepted.
    panel.handleInput('a');
    expect(inputHandled()).toEqual(['a']);
    panel.handleInput(CTRL_O);
    expect(inputHandled()).toEqual(['a']);
    expect((panel as unknown as { contentExpanded: boolean }).contentExpanded).toBe(true);
    panel.handleInput(CTRL_O);
    expect(inputHandled()).toEqual(['a']);
    expect((panel as unknown as { contentExpanded: boolean }).contentExpanded).toBe(false);
    panel.dispose();
  });
});
