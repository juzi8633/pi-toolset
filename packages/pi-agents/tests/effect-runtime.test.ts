// ABOUTME: Unit tests for Effect boundary runners and abort helpers.
// ABOUTME: Covers success, typed failure rejection, Exit capture, and AbortSignal policy.

import { describe, expect, it } from 'bun:test';
import { Data, Effect, Exit } from 'effect';
import { AgentAbortError } from '../src/abort.ts';
import {
  AbortSignalAborted,
  checkAbortSignal,
  failAgentAbortError,
  failIfAborted,
  runEffectExit,
  runEffectPromise,
} from '../src/effect-runtime.ts';
import { emptyUsage } from '../src/empty-usage.ts';
import type { SingleResult } from '../src/types.ts';

class SampleTaggedFailure extends Data.TaggedError('SampleTaggedFailure')<{
  readonly message: string;
}> {}

describe('runEffectPromise', () => {
  it('resolves the success value', async () => {
    expect(await runEffectPromise(Effect.succeed(42))).toBe(42);
  });

  it('rejects with the original Error on typed failure', async () => {
    const err = new Error('x');
    await expect(runEffectPromise(Effect.fail(err))).rejects.toBe(err);
  });

  it('rejects with TaggedError instances that extend Error', async () => {
    const err = new SampleTaggedFailure({ message: 'tagged boom' });
    await expect(runEffectPromise(Effect.fail(err))).rejects.toBe(err);
  });

  it('wraps non-Error typed failures in Error', async () => {
    try {
      await runEffectPromise(Effect.fail('string-fail'));
      expect.unreachable('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe('string-fail');
    }
  });
});

describe('runEffectExit', () => {
  it('returns success Exit without throwing', async () => {
    const exit = await runEffectExit(Effect.succeed('ok'));
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toBe('ok');
    }
  });

  it('returns failure Exit without throwing', async () => {
    const err = new Error('typed');
    const exit = await runEffectExit(Effect.fail(err));
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe('failIfAborted', () => {
  it('succeeds when signal is undefined', async () => {
    expect(await runEffectPromise(failIfAborted(undefined))).toBeUndefined();
  });

  it('succeeds when signal is not aborted', async () => {
    const controller = new AbortController();
    expect(await runEffectPromise(failIfAborted(controller.signal))).toBeUndefined();
  });

  it('fails with AbortSignalAborted when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort('user-cancel');
    try {
      await runEffectPromise(failIfAborted(controller.signal));
      expect.unreachable('expected AbortSignalAborted');
    } catch (err) {
      expect(err).toBeInstanceOf(AbortSignalAborted);
      expect((err as AbortSignalAborted)._tag).toBe('AbortSignalAborted');
      expect((err as AbortSignalAborted).reason).toBe('user-cancel');
    }
  });

  it('checkAbortSignal is the Phase 0 alias of failIfAborted', () => {
    expect(checkAbortSignal).toBe(failIfAborted);
  });
});

describe('failAgentAbortError', () => {
  it('rejects with the same AgentAbortError instance', async () => {
    const result: SingleResult = {
      agent: 'noop',
      agentSource: 'builtin',
      task: 't',
      status: 'cancelled',
      stopReason: 'aborted',
      exitCode: 1,
      messages: [],
      stderr: '',
      usage: emptyUsage(),
    };
    const abortErr = new AgentAbortError(result, 'user');
    try {
      await runEffectPromise(failAgentAbortError(abortErr));
      expect.unreachable('expected AgentAbortError');
    } catch (err) {
      expect(err).toBe(abortErr);
      expect(err).toBeInstanceOf(AgentAbortError);
      expect((err as AgentAbortError).origin).toBe('user');
      expect((err as AgentAbortError).result.agent).toBe('noop');
    }
  });
});
