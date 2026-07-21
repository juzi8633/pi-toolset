// ABOUTME: Tests for compact result snapshots — projection, isolation, caps, and size bounds.
// ABOUTME: Pure unit tests with synthetic oversized tool-result fixtures; no spawned processes.

import { describe, expect, it } from 'bun:test';
import type { Message } from '@earendil-works/pi-ai';
import {
  RESULT_DIAGNOSTIC_MAX_BYTES,
  RESULT_PRESENTATION_ITEM_MAX_BYTES,
  RESULT_PRESENTATION_MAX_BYTES,
} from '../../src/shared/constants.ts';
import {
  copySnapshotShell,
  snapshotResults,
  snapshotSingleResult,
} from '../../src/output/result-snapshot.ts';
import type { DisplayItem, SingleResult } from '../../src/shared/types.ts';
import { emptyUsage } from '../../src/shared/types.ts';

function assistantText(text: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
  } as unknown as Message;
}

function assistantTool(name: string, args: Record<string, unknown> = {}): Message {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', name, arguments: args }],
  } as unknown as Message;
}

function toolResult(body: string): Message {
  return {
    role: 'toolResult',
    toolCallId: 'tc-1',
    toolName: 'bash',
    content: [{ type: 'text', text: body }],
    isError: false,
  } as unknown as Message;
}

function baseResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: 'explore',
    agentSource: 'user',
    task: 'inspect',
    exitCode: 0,
    status: 'completed',
    messages: [],
    stderr: '',
    usage: emptyUsage(),
    ...overrides,
  };
}

describe('snapshotSingleResult projection', () => {
  it('projects assistant text/tool calls, drops tool results, and sets finalOutput', () => {
    const args = { path: 'a.ts' };
    const result = baseResult({
      messages: [
        assistantTool('read', args),
        toolResult('x'.repeat(1024)),
        assistantText('thinking'),
        assistantText('final answer'),
      ],
    });
    const snap = snapshotSingleResult(result);
    expect(snap.messages).toEqual([]);
    expect(snap.finalOutput).toBe('final answer');
    expect(snap.presentation?.transcript).toEqual([
      { type: 'toolCall', name: 'read', args: { path: 'a.ts' } },
      { type: 'text', text: 'thinking' },
    ]);
    // Final text de-duplicated from latestActivity.
    expect(snap.presentation?.latestActivity).toBeUndefined();
    expect(JSON.stringify(snap)).not.toContain('x'.repeat(64));
  });

  it('stores explicit latestActivity for tool calls that differ from finalOutput', () => {
    const result = baseResult({
      messages: [assistantText('final answer'), assistantTool('bash', { command: 'ls' })],
    });
    const snap = snapshotSingleResult(result);
    expect(snap.finalOutput).toBe('final answer');
    expect(snap.presentation?.latestActivity).toEqual({
      type: 'toolCall',
      name: 'bash',
      args: { command: 'ls' },
    });
    expect(snap.presentation?.transcript).toEqual([
      { type: 'toolCall', name: 'bash', args: { command: 'ls' } },
    ]);
  });

  it('preserves structuredOutput, errorCode, and stopReason exactly', () => {
    const structured = { items: [1, 2, { nested: true }] };
    const result = baseResult({
      messages: [assistantText('ok')],
      structuredOutput: structured,
      errorCode: 'transport_error',
      stopReason: 'error',
      exitCode: 1,
      status: 'failed',
    });
    const snap = snapshotSingleResult(result);
    expect(snap.structuredOutput).toEqual(structured);
    expect(snap.errorCode).toBe('transport_error');
    expect(snap.stopReason).toBe('error');
  });
});

describe('snapshotSingleResult isolation and idempotence', () => {
  it('isolates from later mutation of source messages, usage, fanout, files, and structured output', () => {
    const args = { path: 'original.ts' };
    const structured = { value: 'orig' };
    const result = baseResult({
      messages: [
        assistantTool('read', args),
        assistantText('original note'),
        assistantText('done'),
      ],
      usage: { ...emptyUsage(), input: 1, output: 2 },
      fanout: { index: 0, count: 2, itemTask: 'item' },
      worktreeChangedFiles: ['a.ts'],
      structuredOutput: structured,
    });
    const snap = snapshotSingleResult(result);

    args.path = 'mutated.ts';
    result.usage.input = 999;
    result.fanout!.index = 7;
    result.worktreeChangedFiles!.push('b.ts');
    structured.value = 'mutated';
    (result.messages[0].content[0] as unknown as { arguments: { path: string } }).arguments.path =
      'mutated.ts';
    (result.messages[1].content[0] as unknown as { text: string }).text = 'mutated note';

    const tool = snap.presentation!.transcript[0] as Extract<DisplayItem, { type: 'toolCall' }>;
    const note = snap.presentation!.transcript[1] as Extract<DisplayItem, { type: 'text' }>;
    expect(tool.args.path).toBe('original.ts');
    expect(note.text).toBe('original note');
    expect(snap.usage.input).toBe(1);
    expect(snap.fanout?.index).toBe(0);
    expect(snap.worktreeChangedFiles).toEqual(['a.ts']);
    expect(snap.structuredOutput).toEqual({ value: 'orig' });
    expect(Object.isFrozen(snap.presentation)).toBe(true);
    expect(Object.isFrozen(snap.structuredOutput)).toBe(true);
  });

  it('re-bounds and freezes mutable deserialized compact input instead of sharing it', () => {
    const args = { path: 'live.ts' };
    const structured = { value: 'live' };
    const result = baseResult({
      messages: [],
      finalOutput: 'done',
      presentation: {
        transcript: [{ type: 'toolCall', name: 'read', args }],
      },
      structuredOutput: structured,
    });
    const snap = snapshotSingleResult(result);
    args.path = 'mutated.ts';
    structured.value = 'mutated';
    const tool = snap.presentation!.transcript[0] as Extract<DisplayItem, { type: 'toolCall' }>;
    expect(tool.args.path).toBe('live.ts');
    expect(snap.structuredOutput).toEqual({ value: 'live' });
    expect(Object.isFrozen(snap.presentation)).toBe(true);
    expect(Object.isFrozen(snap.structuredOutput)).toBe(true);
    // Second snapshot of the owned result shares frozen payloads.
    const again = snapshotSingleResult(snap);
    expect(again.presentation).toBe(snap.presentation);
    expect(again.structuredOutput).toBe(snap.structuredOutput);
  });

  it('is idempotent for already-compact snapshots via copySnapshotShell', () => {
    const live = baseResult({
      messages: [assistantTool('read', { path: 'a.ts' }), assistantText('done')],
      usage: { ...emptyUsage(), turns: 3 },
    });
    const first = snapshotSingleResult(live);
    const second = snapshotSingleResult(first);
    expect(second.messages).toEqual([]);
    expect(second.presentation).toBe(first.presentation);
    expect(second.structuredOutput).toBe(first.structuredOutput);
    expect(second.usage).not.toBe(first.usage);
    expect(second.usage).toEqual(first.usage);
    expect(second).not.toBe(first);
  });

  it('is idempotent for primitive structuredOutput without WeakSet ownership', () => {
    for (const structured of ['ok', 42, true, null, undefined] as const) {
      const live = baseResult({
        messages: [assistantText(`out-${String(structured)}`)],
        ...(structured === undefined ? {} : { structuredOutput: structured }),
      });
      const first = snapshotSingleResult(live);
      expect(first.structuredOutput).toBe(structured);
      const second = snapshotSingleResult(first);
      // Fast path: new shell, shared owned presentation, same primitive structuredOutput.
      expect(second).not.toBe(first);
      expect(second.presentation).toBe(first.presentation);
      expect(second.structuredOutput).toBe(first.structuredOutput);
      expect(second.finalOutput).toBe(first.finalOutput);
    }
  });

  it('copySnapshotShell shares frozen payloads and clones shell fields', () => {
    const snap = snapshotSingleResult(
      baseResult({
        messages: [assistantText('done')],
        fanout: { index: 1, count: 3 },
        worktreeChangedFiles: ['x.ts'],
        structuredOutput: { ok: true },
      })
    );
    const shell = copySnapshotShell(snap);
    expect(shell.presentation).toBe(snap.presentation);
    expect(shell.structuredOutput).toBe(snap.structuredOutput);
    expect(shell.usage).not.toBe(snap.usage);
    expect(shell.fanout).not.toBe(snap.fanout);
    expect(shell.worktreeChangedFiles).not.toBe(snap.worktreeChangedFiles);
    shell.usage.turns = 99;
    shell.fanout!.index = 8;
    shell.worktreeChangedFiles!.push('y.ts');
    expect(snap.usage.turns).toBe(0);
    expect(snap.fanout?.index).toBe(1);
    expect(snap.worktreeChangedFiles).toEqual(['x.ts']);
  });

  it('copySnapshotShell reprojects externally frozen presentation and unowned structured payloads', () => {
    const hugeText = 'H'.repeat(RESULT_PRESENTATION_ITEM_MAX_BYTES + 2048);
    const externalPresentation = Object.freeze({
      transcript: Object.freeze([
        Object.freeze({ type: 'text' as const, text: hugeText }),
        Object.freeze({
          type: 'toolCall' as const,
          name: 'bash',
          args: Object.freeze({ blob: 'Q'.repeat(RESULT_PRESENTATION_ITEM_MAX_BYTES + 512) }),
        }),
      ]),
    });
    const externalStructured = Object.freeze({ nested: Object.freeze({ value: 'orig' }) });
    const unowned = baseResult({
      messages: [],
      finalOutput: 'done',
      presentation: externalPresentation as never,
      structuredOutput: externalStructured as never,
    });

    const shell = copySnapshotShell(unowned);
    expect(shell.presentation).not.toBe(externalPresentation);
    expect(shell.structuredOutput).not.toBe(externalStructured);
    expect(shell.structuredOutput).toEqual({ nested: { value: 'orig' } });
    const textItem = shell.presentation!.transcript.find((i) => i.type === 'text') as Extract<
      DisplayItem,
      { type: 'text' }
    >;
    expect(textItem.text).toContain('bytes omitted');
    expect(Buffer.byteLength(JSON.stringify(textItem), 'utf8')).toBeLessThanOrEqual(
      RESULT_PRESENTATION_ITEM_MAX_BYTES
    );

    // Deep-frozen external presentation through copySnapshotShell must not share identity.
    const deepFrozen = Object.freeze({
      ...unowned,
      presentation: externalPresentation,
      structuredOutput: externalStructured,
      usage: Object.freeze({ ...unowned.usage }),
    }) as SingleResult;
    const deepShell = copySnapshotShell(deepFrozen);
    expect(deepShell.presentation).not.toBe(externalPresentation);
    expect(deepShell.structuredOutput).not.toBe(externalStructured);
  });

  it('owned snapshot shell re-bounds oversized diagnostics on copy and resnapshot', () => {
    const owned = snapshotSingleResult(
      baseResult({
        messages: [assistantText('ok')],
        stderr: 'small',
        errorMessage: 'small-msg',
        errorStack: 'small-stack',
      })
    );
    const huge = 'D'.repeat(RESULT_DIAGNOSTIC_MAX_BYTES + 4096);
    // Mutate top-level diagnostic strings on the owned shell (shell fields are not frozen).
    owned.stderr = `HEAD-${huge}-TAIL`;
    owned.errorMessage = `MSG-${huge}`;
    owned.errorStack = `STACK-${huge}`;

    const copied = copySnapshotShell(owned);
    expect(copied.presentation).toBe(owned.presentation);
    expect(Buffer.byteLength(copied.stderr, 'utf8')).toBeLessThanOrEqual(
      RESULT_DIAGNOSTIC_MAX_BYTES
    );
    expect(copied.stderr).toContain('TAIL');
    expect(copied.stderr).toContain('bytes omitted');
    expect(Buffer.byteLength(copied.errorMessage!, 'utf8')).toBeLessThanOrEqual(
      RESULT_DIAGNOSTIC_MAX_BYTES
    );
    expect(copied.errorMessage).toContain('MSG-');
    expect(Buffer.byteLength(copied.errorStack!, 'utf8')).toBeLessThanOrEqual(
      RESULT_DIAGNOSTIC_MAX_BYTES
    );

    const resnap = snapshotSingleResult(owned);
    expect(resnap.presentation).toBe(owned.presentation);
    expect(Buffer.byteLength(resnap.stderr, 'utf8')).toBeLessThanOrEqual(
      RESULT_DIAGNOSTIC_MAX_BYTES
    );
    expect(Buffer.byteLength(resnap.errorMessage!, 'utf8')).toBeLessThanOrEqual(
      RESULT_DIAGNOSTIC_MAX_BYTES
    );
    expect(Buffer.byteLength(resnap.errorStack!, 'utf8')).toBeLessThanOrEqual(
      RESULT_DIAGNOSTIC_MAX_BYTES
    );
  });

  it('snapshotResults preserves order', () => {
    const results = [
      baseResult({ task: 'a', messages: [assistantText('A')] }),
      baseResult({ task: 'b', messages: [assistantText('B')] }),
    ];
    const snaps = snapshotResults(results);
    expect(snaps.map((r) => r.finalOutput)).toEqual(['A', 'B']);
  });
});

describe('snapshotSingleResult size and caps', () => {
  it('drops a 4 MiB toolResult body and keeps presentation under 128 KiB', () => {
    const big = 'Z'.repeat(4 * 1024 * 1024);
    const result = baseResult({
      messages: [
        assistantTool('bash', { command: 'cat big' }),
        toolResult(big),
        assistantText('summary of big file'),
      ],
    });
    const snap = snapshotSingleResult(result);
    const json = JSON.stringify(snap);
    expect(json).not.toContain('Z'.repeat(64));
    expect(snap.finalOutput).toBe('summary of big file');
    expect(snap.presentation?.transcript.some((i) => i.type === 'toolCall')).toBe(true);
    expect(Buffer.byteLength(json, 'utf8')).toBeLessThan(128 * 1024);
  });

  it('bounds oversized text items within the per-item budget', () => {
    const huge = '文'.repeat(RESULT_PRESENTATION_ITEM_MAX_BYTES); // multi-byte chars
    const result = baseResult({
      messages: [assistantText(huge), assistantText('final')],
    });
    const snap = snapshotSingleResult(result);
    const textItem = snap.presentation!.transcript.find((i) => i.type === 'text') as Extract<
      DisplayItem,
      { type: 'text' }
    >;
    expect(textItem).toBeDefined();
    expect(textItem.text).toContain('bytes omitted');
    expect(Buffer.byteLength(JSON.stringify(textItem), 'utf8')).toBeLessThanOrEqual(
      RESULT_PRESENTATION_ITEM_MAX_BYTES
    );
    expect(snap.finalOutput).toBe('final');
  });

  it('replaces oversized tool-call args with an omission marker object', () => {
    const hugeArgs = { blob: 'Q'.repeat(RESULT_PRESENTATION_ITEM_MAX_BYTES) };
    const result = baseResult({
      messages: [assistantTool('write', hugeArgs), assistantText('wrote it')],
    });
    const snap = snapshotSingleResult(result);
    const tool = snap.presentation!.transcript[0] as Extract<DisplayItem, { type: 'toolCall' }>;
    expect(tool.args._omitted).toBe(true);
    expect(typeof tool.args.omittedBytes).toBe('number');
    expect(String(tool.args.message)).toContain('child session');
    expect(Buffer.byteLength(JSON.stringify(tool), 'utf8')).toBeLessThanOrEqual(
      RESULT_PRESENTATION_ITEM_MAX_BYTES
    );
    expect(JSON.stringify(snap)).not.toContain('Q'.repeat(64));
  });

  it('retains newest items when the full presentation exceeds the total budget', () => {
    // Build many medium text items so total presentation exceeds the budget.
    const itemText = 'n'.repeat(8 * 1024);
    const messages: Message[] = [];
    const itemCount = Math.ceil(RESULT_PRESENTATION_MAX_BYTES / (8 * 1024)) + 8;
    for (let i = 0; i < itemCount; i++) {
      messages.push(assistantText(`${i}:${itemText}`));
    }
    messages.push(assistantText('FINAL_OUTPUT'));
    const snap = snapshotSingleResult(baseResult({ messages }));
    expect(snap.finalOutput).toBe('FINAL_OUTPUT');
    expect(
      snap.presentation && 'truncated' in snap.presentation && snap.presentation.truncated
    ).toBe(true);
    if (snap.presentation && 'truncated' in snap.presentation) {
      expect(snap.presentation.omittedItems).toBeGreaterThan(0);
    }
    expect(Buffer.byteLength(JSON.stringify(snap.presentation), 'utf8')).toBeLessThanOrEqual(
      RESULT_PRESENTATION_MAX_BYTES
    );
    // Newest retained transcript items should be near the end of the original sequence.
    const texts = snap
      .presentation!.transcript.filter(
        (i): i is Extract<DisplayItem, { type: 'text' }> => i.type === 'text'
      )
      .map((i) => i.text);
    expect(texts.some((t) => t.startsWith(`${itemCount - 1}:`))).toBe(true);
    expect(texts.some((t) => t.startsWith('0:'))).toBe(false);
  });

  it('accounts for explicit latestActivity in the total presentation budget', () => {
    const itemText = 'm'.repeat(8 * 1024);
    const messages: Message[] = [];
    const itemCount = Math.ceil(RESULT_PRESENTATION_MAX_BYTES / (8 * 1024)) + 4;
    for (let i = 0; i < itemCount; i++) {
      messages.push(assistantText(`${i}:${itemText}`));
    }
    // Trailing tool call becomes explicit latestActivity (differs from finalOutput).
    messages.push(assistantText('FINAL'));
    messages.push(assistantTool('bash', { command: 'echo done' }));
    const snap = snapshotSingleResult(baseResult({ messages }));
    expect(snap.presentation?.latestActivity?.type).toBe('toolCall');
    expect(Buffer.byteLength(JSON.stringify(snap.presentation), 'utf8')).toBeLessThanOrEqual(
      RESULT_PRESENTATION_MAX_BYTES
    );
  });

  it('bounds stderr (tail) and errorMessage/errorStack (prefix)', () => {
    const big = 'E'.repeat(RESULT_DIAGNOSTIC_MAX_BYTES + 4096);
    const result = baseResult({
      messages: [assistantText('failed')],
      exitCode: 1,
      status: 'failed',
      stopReason: 'error',
      stderr: `HEAD-${big}-TAIL`,
      errorMessage: `MSG-${big}`,
      errorStack: `STACK-${big}`,
    });
    const snap = snapshotSingleResult(result);
    expect(Buffer.byteLength(snap.stderr, 'utf8')).toBeLessThanOrEqual(RESULT_DIAGNOSTIC_MAX_BYTES);
    expect(snap.stderr).toContain('TAIL');
    expect(snap.stderr).toContain('bytes omitted');
    expect(snap.errorMessage).toBeDefined();
    expect(Buffer.byteLength(snap.errorMessage!, 'utf8')).toBeLessThanOrEqual(
      RESULT_DIAGNOSTIC_MAX_BYTES
    );
    expect(snap.errorMessage).toContain('MSG-');
    expect(snap.errorMessage).toContain('bytes omitted');
    expect(snap.errorStack).toBeDefined();
    expect(Buffer.byteLength(snap.errorStack!, 'utf8')).toBeLessThanOrEqual(
      RESULT_DIAGNOSTIC_MAX_BYTES
    );
    expect(snap.errorStack).toContain('STACK-');
  });

  it('de-duplicates latest text identical to finalOutput', () => {
    const result = baseResult({
      messages: [assistantTool('read', { path: 'a.ts' }), assistantText('same final')],
      finalOutput: 'same final',
    });
    const snap = snapshotSingleResult(result);
    expect(snap.presentation?.latestActivity).toBeUndefined();
    expect(snap.finalOutput).toBe('same final');
  });

  it('does not store a truncated marker as latestActivity for oversized final text', () => {
    const hugeFinal = 'F'.repeat(RESULT_PRESENTATION_ITEM_MAX_BYTES + 2048);
    const result = baseResult({
      messages: [assistantTool('read', { path: 'a.ts' }), assistantText(hugeFinal)],
      finalOutput: hugeFinal,
    });
    const snap = snapshotSingleResult(result);
    expect(snap.finalOutput).toBe(hugeFinal);
    expect(snap.presentation?.latestActivity).toBeUndefined();
  });

  it('carries prior omittedItems forward when re-snapshotting a truncated presentation with messages', () => {
    const result = baseResult({
      messages: [assistantText('extra retained')],
      finalOutput: 'done',
      presentation: {
        transcript: [{ type: 'text', text: 'kept' }],
        truncated: true,
        omittedItems: 5,
      },
    });
    const snap = snapshotSingleResult(result);
    expect(
      snap.presentation && 'truncated' in snap.presentation && snap.presentation.truncated
    ).toBe(true);
    if (snap.presentation && 'truncated' in snap.presentation) {
      expect(snap.presentation.omittedItems).toBeGreaterThanOrEqual(5);
    }
  });

  it('does not treat externally frozen oversized compact-looking data as owned', () => {
    const hugeText = 'H'.repeat(RESULT_PRESENTATION_ITEM_MAX_BYTES + 4096);
    const hugeDiag = 'D'.repeat(RESULT_DIAGNOSTIC_MAX_BYTES + 2048);
    const structured = Object.freeze({ nested: Object.freeze({ value: 'orig' }) });
    const presentation = Object.freeze({
      transcript: Object.freeze([
        Object.freeze({ type: 'text' as const, text: hugeText }),
        Object.freeze({
          type: 'toolCall' as const,
          name: 'bash',
          args: Object.freeze({ blob: 'Q'.repeat(RESULT_PRESENTATION_ITEM_MAX_BYTES + 1024) }),
        }),
      ]),
    });
    const result = baseResult({
      messages: [],
      finalOutput: 'done',
      presentation: presentation as never,
      structuredOutput: structured as never,
      stderr: hugeDiag,
      errorMessage: hugeDiag,
    });

    const snap = snapshotSingleResult(result);
    // Must reproject: not share the externally frozen presentation/structured payloads.
    expect(snap.presentation).not.toBe(presentation);
    expect(snap.structuredOutput).not.toBe(structured);
    expect(snap.structuredOutput).toEqual({ nested: { value: 'orig' } });

    const textItem = snap.presentation!.transcript.find((i) => i.type === 'text') as Extract<
      DisplayItem,
      { type: 'text' }
    >;
    expect(textItem.text).toContain('bytes omitted');
    expect(Buffer.byteLength(JSON.stringify(textItem), 'utf8')).toBeLessThanOrEqual(
      RESULT_PRESENTATION_ITEM_MAX_BYTES
    );
    const tool = snap.presentation!.transcript.find((i) => i.type === 'toolCall') as Extract<
      DisplayItem,
      { type: 'toolCall' }
    >;
    expect(tool.args._omitted).toBe(true);
    expect(Buffer.byteLength(snap.stderr, 'utf8')).toBeLessThanOrEqual(RESULT_DIAGNOSTIC_MAX_BYTES);
    expect(snap.errorMessage).toBeDefined();
    expect(Buffer.byteLength(snap.errorMessage!, 'utf8')).toBeLessThanOrEqual(
      RESULT_DIAGNOSTIC_MAX_BYTES
    );

    // Externally frozen structured payload is cloned into owned freeze; identity differs.
    expect(Object.isFrozen(snap.structuredOutput)).toBe(true);

    // Owned snapshot remains idempotent and shares frozen owned payloads.
    const again = snapshotSingleResult(snap);
    expect(again.presentation).toBe(snap.presentation);
    expect(again.structuredOutput).toBe(snap.structuredOutput);
    expect(again).not.toBe(snap);
  });

  it('truncates multi-byte emoji text without splitting code points', () => {
    const emoji = '🚀'; // 4 UTF-8 bytes, 2 UTF-16 code units
    // Enough code points that the UTF-8 payload exceeds the per-item budget.
    const huge = emoji.repeat(Math.ceil(RESULT_PRESENTATION_ITEM_MAX_BYTES / 2));
    const result = baseResult({
      messages: [assistantText(huge), assistantText('final')],
    });
    const snap = snapshotSingleResult(result);
    const textItem = snap.presentation!.transcript.find((i) => i.type === 'text') as Extract<
      DisplayItem,
      { type: 'text' }
    >;
    expect(textItem).toBeDefined();
    // No lone surrogates in the retained prefix (before the ASCII marker).
    const markerAt = textItem.text.indexOf('\n\n[Transcript item truncated:');
    const prefix = markerAt >= 0 ? textItem.text.slice(0, markerAt) : textItem.text;
    for (let i = 0; i < prefix.length; i++) {
      const code = prefix.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = prefix.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
        i += 1;
      } else {
        expect(code < 0xdc00 || code > 0xdfff).toBe(true);
      }
    }
  });
});
