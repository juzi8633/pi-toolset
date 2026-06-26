// ABOUTME: Tests for output helpers — token formatting, final output extraction, and byte-safe truncation.
// ABOUTME: Pure unit tests; no spawned processes or filesystem state.

import { describe, expect, it } from 'bun:test';
import type { Message } from '@earendil-works/pi-ai';
import { PER_TASK_OUTPUT_CAP } from '../src/constants.ts';
import { formatTokens, getFinalOutput, truncateParallelOutput } from '../src/output.ts';

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
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'first' }],
      } as unknown as Message,
      {
        role: 'user',
        content: [{ type: 'text', text: 'noise' }],
      } as unknown as Message,
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'older' },
          { type: 'text', text: 'final' },
        ],
      } as unknown as Message,
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
    // Pre-notice body must fit the cap; the appended notice intentionally pushes the total over.
    expect(Buffer.byteLength(preNotice, 'utf8')).toBeLessThanOrEqual(PER_TASK_OUTPUT_CAP);
    expect(result).toContain('[Output truncated:');
  });
});
