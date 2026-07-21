// ABOUTME: Tests for output helpers — token formatting, final output extraction, and byte-safe truncation.
// ABOUTME: Pure unit tests; no spawned processes or filesystem state.

import { describe, expect, it } from 'bun:test';
import type { Message } from '@earendil-works/pi-ai';
import { PER_TASK_OUTPUT_CAP } from '../../src/shared/constants.ts';
import {
  formatAggregateUsageStats,
  formatTokens,
  formatUsageStats,
  getFinalOutput,
  getLatestActivity,
  getResultFinalOutput,
  getResultLatestActivity,
  getResultOutput,
  getResultParentOutput,
  getResultTranscriptAndFinal,
  getTranscriptAndFinal,
  resolveExecutionStatus,
  truncateParallelOutput,
} from '../../src/output/output.ts';
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

function assistantMixed(
  parts: Array<{ type: 'text'; text: string } | { type: 'toolCall'; name: string; args?: object }>
): Message {
  return {
    role: 'assistant',
    content: parts.map((p) =>
      p.type === 'text'
        ? { type: 'text', text: p.text }
        : { type: 'toolCall', name: p.name, arguments: p.args ?? {} }
    ),
  } as unknown as Message;
}

describe('formatTokens', () => {
  it('returns plain digits below 1k', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('formats thousands with one decimal under 10k', () => {
    expect(formatTokens(1500)).toBe('1.5k');
  });

  it('formats millions with one decimal', () => {
    expect(formatTokens(1500000)).toBe('1.5M');
  });
});

describe('getFinalOutput', () => {
  it('returns the first text part from the latest assistant message', () => {
    const messages: Message[] = [
      assistantText('first'),
      {
        role: 'user',
        content: [{ type: 'text', text: 'noise' }],
      } as unknown as Message,
      assistantMixed([
        { type: 'text', text: 'older' },
        { type: 'text', text: 'final' },
      ]),
    ];
    expect(getFinalOutput(messages)).toBe('older');
  });

  it('returns empty string when no assistant text exists', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
      } as unknown as Message,
    ];
    expect(getFinalOutput(messages)).toBe('');
    expect(getFinalOutput([])).toBe('');
  });
});

describe('getLatestActivity', () => {
  it('returns undefined for empty messages', () => {
    expect(getLatestActivity([])).toBeUndefined();
  });

  it('returns the last tool call', () => {
    const messages = [
      assistantTool('read', { path: 'a.ts' }),
      assistantTool('bash', { command: 'ls' }),
    ];
    expect(getLatestActivity(messages)).toEqual({
      type: 'toolCall',
      name: 'bash',
      args: { command: 'ls' },
    });
  });

  it('returns the last assistant text', () => {
    const messages = [assistantText('hello'), assistantText('world')];
    expect(getLatestActivity(messages)).toEqual({ type: 'text', text: 'world' });
  });

  it('follows interleaved tool and text order', () => {
    const messages = [
      assistantTool('read', { path: 'a' }),
      assistantText('mid'),
      assistantTool('grep', { pattern: 'x' }),
    ];
    const latest = getLatestActivity(messages);
    expect(latest?.type).toBe('toolCall');
    if (latest?.type === 'toolCall') expect(latest.name).toBe('grep');
  });

  it('selects the last content part within the last assistant message', () => {
    const messages = [
      assistantMixed([
        { type: 'text', text: 'earlier' },
        { type: 'toolCall', name: 'bash', args: { command: 'echo' } },
      ]),
    ];
    const latest = getLatestActivity(messages);
    expect(latest).toEqual({
      type: 'toolCall',
      name: 'bash',
      args: { command: 'echo' },
    });
  });
});

describe('getTranscriptAndFinal', () => {
  it('returns empty transcript and final for empty messages', () => {
    expect(getTranscriptAndFinal([])).toEqual({ transcript: [], finalOutput: '' });
  });

  it('excludes the final assistant text from the transcript', () => {
    const messages = [
      assistantTool('read', { path: 'a.ts' }),
      assistantText('thinking aloud'),
      assistantMixed([
        { type: 'toolCall', name: 'bash', args: { command: 'ls' } },
        { type: 'text', text: 'done' },
      ]),
    ];
    const { transcript, finalOutput } = getTranscriptAndFinal(messages);
    expect(finalOutput).toBe('done');
    expect(transcript).toEqual([
      { type: 'toolCall', name: 'read', args: { path: 'a.ts' } },
      { type: 'text', text: 'thinking aloud' },
      { type: 'toolCall', name: 'bash', args: { command: 'ls' } },
    ]);
    // Final text appears exactly once overall (as finalOutput, not in transcript)
    const textParts = transcript.filter((i) => i.type === 'text');
    expect(textParts.some((t) => t.type === 'text' && t.text === 'done')).toBe(false);
  });

  it('preserves earlier assistant text blocks', () => {
    const messages = [
      assistantText('turn 1 notes'),
      assistantText('turn 2 notes'),
      assistantText('final answer'),
    ];
    const { transcript, finalOutput } = getTranscriptAndFinal(messages);
    expect(finalOutput).toBe('final answer');
    expect(transcript).toEqual([
      { type: 'text', text: 'turn 1 notes' },
      { type: 'text', text: 'turn 2 notes' },
    ]);
  });

  it('keeps all items when there is no final text', () => {
    const messages = [assistantTool('read', { path: 'x' })];
    const { transcript, finalOutput } = getTranscriptAndFinal(messages);
    expect(finalOutput).toBe('');
    expect(transcript).toHaveLength(1);
  });

  it('does not duplicate final text when a trailing assistant message is tool-only', () => {
    const messages = [assistantText('final answer'), assistantTool('read', { path: 'late.ts' })];
    const { transcript, finalOutput } = getTranscriptAndFinal(messages);
    expect(finalOutput).toBe('final answer');
    expect(transcript).toEqual([{ type: 'toolCall', name: 'read', args: { path: 'late.ts' } }]);
    expect(transcript.some((i) => i.type === 'text' && i.text === 'final answer')).toBe(false);
  });
});

describe('resolveExecutionStatus', () => {
  it('prefers explicit status', () => {
    const r = { status: 'running', exitCode: 0 } as SingleResult;
    expect(resolveExecutionStatus(r)).toBe('running');
  });

  it('falls back from exitCode for older sessions', () => {
    expect(resolveExecutionStatus({ exitCode: -1 } as SingleResult)).toBe('running');
    expect(resolveExecutionStatus({ exitCode: 0 } as SingleResult)).toBe('completed');
    expect(resolveExecutionStatus({ exitCode: 1 } as SingleResult)).toBe('failed');
    expect(resolveExecutionStatus({ exitCode: 1, stopReason: 'aborted' } as SingleResult)).toBe(
      'cancelled'
    );
  });
});

describe('formatUsageStats', () => {
  const emptyUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };

  it('appends model when provided', () => {
    expect(formatUsageStats(emptyUsage, 'glm-5.2')).toBe('glm-5.2');
  });

  it('appends thinking level next to model when provided', () => {
    expect(formatUsageStats(emptyUsage, 'glm-5.2', 'xhigh')).toBe('glm-5.2 • xhigh');
  });

  it('omits thinking when model is missing', () => {
    expect(formatUsageStats(emptyUsage, undefined, 'xhigh')).toBe('');
  });

  it('shows only mid-turn fields (ctx) without zero token breakdown', () => {
    expect(
      formatUsageStats({
        ...emptyUsage,
        cost: 0.0123,
        contextTokens: 111,
      })
    ).toBe('ctx:111');
  });

  it('omits cost from display even when present', () => {
    expect(
      formatUsageStats({
        ...emptyUsage,
        cost: 0.0123,
      })
    ).toBe('');
  });

  it('shows context alone when that is the only known field', () => {
    expect(formatUsageStats({ ...emptyUsage, contextTokens: 50 })).toBe('ctx:50');
  });

  it('shows the full breakdown when all fields are present', () => {
    expect(
      formatUsageStats(
        {
          input: 10,
          output: 4,
          cacheRead: 2,
          cacheWrite: 1,
          cost: 0.0123,
          contextTokens: 17,
          turns: 1,
        },
        'fake-model',
        'high'
      )
    ).toBe('1 turn ↑10 ↓4 R2 W1 ctx:17 fake-model • high');
  });
});

describe('formatAggregateUsageStats', () => {
  it('formats max context and omits model/thinking', () => {
    expect(
      formatAggregateUsageStats({
        input: 20,
        output: 3,
        cacheRead: 40,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 12000,
        turns: 9,
      })
    ).toBe('9 turns ↑20 ↓3 R40 ctx:max 12k');
  });
});

describe('truncateParallelOutput', () => {
  it('preserves strings under the cap', () => {
    const small = 'hello world';
    expect(truncateParallelOutput(small)).toBe(small);
  });

  it('truncates oversize strings and keeps the pre-notice body within the cap', () => {
    const big = 'a'.repeat(PER_TASK_OUTPUT_CAP + 1024);
    const result = truncateParallelOutput(big);
    const noticeIdx = result.indexOf('\n\n[Output truncated:');
    expect(noticeIdx).toBeGreaterThan(-1);
    const preNotice = result.slice(0, noticeIdx);
    expect(Buffer.byteLength(preNotice, 'utf8')).toBeLessThanOrEqual(PER_TASK_OUTPUT_CAP);
    expect(result).toContain('[Output truncated:');
  });
});

describe('cloneSingleResult deep snapshot', () => {
  it('isolates message content and tool arguments from later mutation', async () => {
    const { cloneSingleResult } = await import('../../src/shared/types.ts');
    const args = { path: 'original.ts' };
    const result: SingleResult = {
      agent: 'explore',
      agentSource: 'user',
      task: 't',
      exitCode: -1,
      status: 'running',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'read', arguments: args }],
        } as unknown as SingleResult['messages'][number],
      ],
      stderr: '',
      usage: { ...emptyUsage(), input: 1 },
    };
    const snap = cloneSingleResult(result);
    // Mutate live result the way a streaming parser would.
    args.path = 'mutated.ts';
    result.usage.input = 999;
    const livePart = result.messages[0].content[0] as unknown as {
      arguments: { path: string };
    };
    livePart.arguments.path = 'mutated.ts';
    const snapPart = snap.messages[0].content[0] as unknown as {
      arguments: { path: string };
    };
    expect(snapPart.arguments.path).toBe('original.ts');
    expect(snap.usage.input).toBe(1);
  });

  it('deep-clones presentation transcript and latest activity', async () => {
    const { cloneResults, cloneSingleResult } = await import('../../src/shared/types.ts');
    const args = { path: 'original.ts' };
    const result: SingleResult = {
      agent: 'explore',
      agentSource: 'user',
      task: 't',
      exitCode: 0,
      status: 'completed',
      messages: [],
      presentation: {
        transcript: [
          { type: 'text', text: 'note' },
          { type: 'toolCall', name: 'read', args },
        ],
        latestActivity: { type: 'toolCall', name: 'read', args },
      },
      finalOutput: 'done',
      stderr: '',
      usage: emptyUsage(),
    };
    const [snap] = cloneResults([result]);
    const solo = cloneSingleResult(result);

    // Mutate source presentation arrays, text, and tool args.
    result.presentation!.transcript.push({ type: 'text', text: 'extra' });
    (result.presentation!.transcript[0] as Extract<DisplayItem, { type: 'text' }>).text = 'mutated';
    args.path = 'mutated.ts';
    (result.presentation!.latestActivity as Extract<DisplayItem, { type: 'toolCall' }>).args.path =
      'mutated.ts';

    expect(result.presentation!.transcript).toHaveLength(3);
    expect(snap.presentation!.transcript).toHaveLength(2);
    expect((snap.presentation!.transcript[0] as Extract<DisplayItem, { type: 'text' }>).text).toBe(
      'note'
    );
    expect(
      (snap.presentation!.transcript[1] as Extract<DisplayItem, { type: 'toolCall' }>).args.path
    ).toBe('original.ts');
    expect(
      (snap.presentation!.latestActivity as Extract<DisplayItem, { type: 'toolCall' }>).args.path
    ).toBe('original.ts');

    // Mutate clones and confirm source is unchanged.
    snap.presentation!.transcript.pop();
    (solo.presentation!.transcript[0] as Extract<DisplayItem, { type: 'text' }>).text = 'clone';
    expect(snap.presentation!.transcript).toHaveLength(1);
    expect(result.presentation!.transcript).toHaveLength(3);
    expect(
      (result.presentation!.transcript[0] as Extract<DisplayItem, { type: 'text' }>).text
    ).toBe('mutated');
    expect((solo.presentation!.transcript[0] as Extract<DisplayItem, { type: 'text' }>).text).toBe(
      'clone'
    );
  });
});

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

function legacyAndCompactPair() {
  const messages: Message[] = [
    assistantTool('read', { path: 'a.ts' }),
    assistantText('thinking aloud'),
    assistantMixed([
      { type: 'toolCall', name: 'bash', args: { command: 'ls' } },
      { type: 'text', text: 'done' },
    ]),
  ];
  const transcript: DisplayItem[] = [
    { type: 'toolCall', name: 'read', args: { path: 'a.ts' } },
    { type: 'text', text: 'thinking aloud' },
    { type: 'toolCall', name: 'bash', args: { command: 'ls' } },
  ];
  const legacy = baseResult({
    messages,
    finalOutput: 'done',
  });
  const compact = baseResult({
    messages: [],
    finalOutput: 'done',
    presentation: {
      transcript,
      // latest activity is the final text, intentionally de-duplicated
    },
  });
  return { legacy, compact, transcript };
}

describe('result-aware presentation helpers', () => {
  it('matches final output between legacy and compact results', () => {
    const { legacy, compact } = legacyAndCompactPair();
    expect(getResultFinalOutput(legacy)).toBe('done');
    expect(getResultFinalOutput(compact)).toBe('done');
    expect(getResultOutput(legacy)).toBe('done');
    expect(getResultOutput(compact)).toBe('done');
  });

  it('matches latest activity and synthesizes de-duplicated final text', () => {
    const { legacy, compact } = legacyAndCompactPair();
    expect(getResultLatestActivity(legacy)).toEqual({ type: 'text', text: 'done' });
    expect(getResultLatestActivity(compact)).toEqual({ type: 'text', text: 'done' });
  });

  it('synthesizes empty finalOutput as latest activity instead of older transcript', () => {
    const result = baseResult({
      messages: [],
      finalOutput: '',
      presentation: {
        transcript: [{ type: 'text', text: 'older retained note' }],
      },
    });
    expect(getResultLatestActivity(result)).toEqual({ type: 'text', text: '' });
  });

  it('prefers explicit compact latestActivity over finalOutput synthesis', () => {
    const result = baseResult({
      messages: [],
      finalOutput: 'done',
      presentation: {
        transcript: [{ type: 'toolCall', name: 'read', args: { path: 'a.ts' } }],
        latestActivity: { type: 'toolCall', name: 'bash', args: { command: 'ls' } },
      },
    });
    expect(getResultLatestActivity(result)).toEqual({
      type: 'toolCall',
      name: 'bash',
      args: { command: 'ls' },
    });
  });

  it('falls back to the last transcript item when compact data is incomplete', () => {
    const result = baseResult({
      messages: [],
      presentation: {
        transcript: [
          { type: 'text', text: 'earlier' },
          { type: 'toolCall', name: 'grep', args: { pattern: 'x' } },
        ],
      },
    });
    expect(getResultLatestActivity(result)).toEqual({
      type: 'toolCall',
      name: 'grep',
      args: { pattern: 'x' },
    });
  });

  it('matches transcript and final between legacy and compact results', () => {
    const { legacy, compact, transcript } = legacyAndCompactPair();
    expect(getResultTranscriptAndFinal(legacy)).toEqual({
      transcript,
      finalOutput: 'done',
    });
    expect(getResultTranscriptAndFinal(compact)).toEqual({
      transcript,
      finalOutput: 'done',
    });
  });

  it('ignores conflicting legacy messages when presentation is present', () => {
    const result = baseResult({
      messages: [assistantText('stale message body'), assistantTool('read', { path: 'stale.ts' })],
      finalOutput: 'compact final',
      presentation: {
        transcript: [{ type: 'toolCall', name: 'bash', args: { command: 'pwd' } }],
        latestActivity: { type: 'toolCall', name: 'bash', args: { command: 'pwd' } },
      },
    });
    expect(getResultFinalOutput(result)).toBe('compact final');
    expect(getResultLatestActivity(result)).toEqual({
      type: 'toolCall',
      name: 'bash',
      args: { command: 'pwd' },
    });
    expect(getResultTranscriptAndFinal(result)).toEqual({
      transcript: [{ type: 'toolCall', name: 'bash', args: { command: 'pwd' } }],
      finalOutput: 'compact final',
    });
  });

  it('prefers explicit finalOutput over legacy messages when presentation is absent', () => {
    const result = baseResult({
      messages: [assistantText('from messages')],
      finalOutput: 'from finalOutput field',
    });
    expect(getResultFinalOutput(result)).toBe('from finalOutput field');
    // Expanded transcript still derives both sides from messages for legacy parity.
    expect(getResultTranscriptAndFinal(result)).toEqual({
      transcript: [],
      finalOutput: 'from messages',
    });
  });

  it('uses finalOutput for success and failure formatting when messages are empty', () => {
    const success = baseResult({
      messages: [],
      finalOutput: 'compact success',
      presentation: { transcript: [] },
    });
    expect(getResultOutput(success)).toBe('compact success');

    const failed = baseResult({
      messages: [],
      exitCode: 1,
      status: 'failed',
      stopReason: 'error',
      finalOutput: 'agent said this',
      presentation: { transcript: [] },
    });
    expect(getResultOutput(failed)).toBe('agent said this');

    const failedWithError = baseResult({
      messages: [],
      exitCode: 1,
      status: 'failed',
      stopReason: 'error',
      errorMessage: 'boom',
      stderr: 'noise',
      finalOutput: 'ignored when errorMessage set',
      presentation: { transcript: [] },
    });
    expect(getResultOutput(failedWithError)).toBe('boom');

    const failedWithStderr = baseResult({
      messages: [],
      exitCode: 1,
      status: 'failed',
      stopReason: 'error',
      stderr: 'stderr noise',
      finalOutput: 'fallback body',
      presentation: { transcript: [] },
    });
    expect(getResultOutput(failedWithStderr)).toBe('stderr noise');

    const completionFailed = baseResult({
      messages: [],
      exitCode: 1,
      status: 'failed',
      stopReason: 'completion_check',
      errorMessage: 'missing acceptance',
      finalOutput: 'unchecked body',
      presentation: { transcript: [] },
    });
    expect(getResultOutput(completionFailed)).toBe(
      'missing acceptance\n\nUnchecked agent output:\nunchecked body'
    );
  });

  it('falls back to message helpers when presentation is absent', () => {
    const result = baseResult({
      messages: [assistantText('from messages')],
    });
    expect(getResultFinalOutput(result)).toBe('from messages');
    expect(getResultLatestActivity(result)).toEqual({ type: 'text', text: 'from messages' });
    expect(getResultTranscriptAndFinal(result)).toEqual({
      transcript: [],
      finalOutput: 'from messages',
    });
  });
});

describe('getResultParentOutput', () => {
  const ref = (sha256: string, bytes = 100): import('../../src/run/run-types.ts').RunArtifactRefV1 => ({
    kind: 'run-artifact',
    version: 1,
    runId: 'r',
    payload: 'final-output',
    relativePath: `artifacts/sha256/${sha256.slice(0, 2)}/${sha256}.txt`,
    sha256,
    bytes,
    mediaType: 'text/plain; charset=utf-8',
  });

  it('returns inline finalOutput text', () => {
    const r = baseResult({ finalOutput: 'hello' });
    expect(getResultParentOutput(r)).toBe('hello');
  });

  it('returns finalOutputRef as a bounded artifact descriptor', () => {
    const r = baseResult({
      finalOutput: undefined,
      finalOutputRef: ref('a'.repeat(64), 9999),
    });
    const out = getResultParentOutput(r);
    expect(out).toContain('run-artifact');
    expect(out).toContain('bytes=9999');
    expect(out).not.toBe('(no output)');
  });

  it('truncates oversized descriptors to the 2 KiB cap', () => {
    const hugePath = 'artifacts/sha256/aa/' + 'x'.repeat(3000) + '.txt';
    const oversizedRef: import('../../src/run/run-types.ts').RunArtifactRefV1 = {
      kind: 'run-artifact',
      version: 1,
      runId: 'r',
      payload: 'final-output',
      relativePath: hugePath,
      sha256: 'a'.repeat(64),
      bytes: 99,
      mediaType: 'text/plain; charset=utf-8',
    };
    const r = baseResult({
      finalOutput: undefined,
      finalOutputRef: oversizedRef,
    });
    const out = getResultParentOutput(r);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(2048);
    expect(out).toContain('payload=final-output');
  });

  it('returns (no output) when no output authority exists', () => {
    const r = baseResult({
      finalOutput: undefined,
      finalOutputRef: undefined,
      messages: [],
      status: 'completed',
    });
    expect(getResultParentOutput(r)).toBe('(no output)');
  });

  it('returns ref-only output without inline content', () => {
    const r = baseResult({
      finalOutput: undefined,
      finalOutputRef: ref('b'.repeat(64), 500),
    });
    const out = getResultParentOutput(r);
    expect(out).not.toContain('secret-content');
    expect(out).toContain('run-artifact');
  });
});
