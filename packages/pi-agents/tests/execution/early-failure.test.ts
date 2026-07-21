// ABOUTME: Tests early-failure stopReason classification and errorStack attachment.
// ABOUTME: Ensures context_error is reserved for real context prep failures.

import { describe, expect, it } from 'bun:test';
import { attachErrorStack, classifyEarlyFailureStopReason } from '../../src/execution/early-failure.ts';
import { emptyUsage } from '../../src/shared/empty-usage.ts';
import type { SingleResult } from '../../src/shared/types.ts';

function failureSlot(stopReason: string, message: string): SingleResult {
  return {
    agent: 'explore',
    agentSource: 'unknown',
    task: 'task',
    exitCode: 1,
    status: 'failed',
    messages: [],
    stderr: message,
    usage: emptyUsage(),
    stopReason,
    errorMessage: message,
  };
}

describe('emptyUsage leaf', () => {
  it('returns zeroed stats without imports from types', () => {
    expect(emptyUsage()).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    });
  });
});

describe('classifyEarlyFailureStopReason', () => {
  it('reserves context_error for context prep messages', () => {
    expect(classifyEarlyFailureStopReason(null, 'Cannot fork parent context: no leaf')).toBe(
      'context_error'
    );
    expect(classifyEarlyFailureStopReason(null, 'Cannot create fresh context: missing file')).toBe(
      'context_error'
    );
    expect(classifyEarlyFailureStopReason(null, 'Cannot resume context: gone')).toBe(
      'context_error'
    );
  });

  it('maps known session codes from messages', () => {
    expect(classifyEarlyFailureStopReason(null, 'session_file_conflict on path')).toBe(
      'session_file_conflict'
    );
    expect(classifyEarlyFailureStopReason(null, 'session_file_unavailable')).toBe(
      'session_file_unavailable'
    );
    expect(classifyEarlyFailureStopReason(null, 'session_prompt_unestablished')).toBe(
      'session_prompt_unestablished'
    );
  });

  it('prefers structured error codes', () => {
    expect(
      classifyEarlyFailureStopReason(
        Object.assign(new Error('x'), { code: 'validation_error' }),
        'Cannot fork parent context: ignored when formal code present'
      )
    ).toBe('validation_error');
  });

  it('defaults generic throws to error instead of context_error', () => {
    expect(
      classifyEarlyFailureStopReason(
        new TypeError("Cannot read properties of undefined (reading 'emptyUsage')"),
        "Cannot read properties of undefined (reading 'emptyUsage')"
      )
    ).toBe('error');
  });
});

describe('attachErrorStack', () => {
  it('copies Error.stack onto the result', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at test';
    const failure = attachErrorStack(failureSlot('error', 'boom'), err);
    expect(failure.errorStack).toBe('Error: boom\n    at test');
    expect(failure.stopReason).toBe('error');
  });

  it('leaves errorStack unset for non-Error throws', () => {
    const failure = attachErrorStack(failureSlot('error', 'string throw'), 'string throw');
    expect(failure.errorStack).toBeUndefined();
  });
});
