// ABOUTME: Unit tests for Effect boundary runners and abort helpers.
// ABOUTME: Covers success, typed failure rejection, Exit capture, and AbortSignal policy.

import { describe, expect, it } from 'bun:test';
import { Data, Effect, Exit } from 'effect';
import { AgentAbortError } from '../../src/execution/abort.ts';
import {
  AbortSignalAborted,
  checkAbortSignal,
  createKeyedSerialExecutor,
  failAgentAbortError,
  failIfAborted,
  runEffectExit,
  runEffectPromise,
  runEffectThrowingAsIs,
} from '../../src/shared/effect-runtime.ts';
import { emptyUsage } from '../../src/shared/empty-usage.ts';
import type { SingleResult } from '../../src/shared/types.ts';

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

describe('runEffectThrowingAsIs', () => {
  it('resolves the success value', async () => {
    expect(await runEffectThrowingAsIs(Effect.succeed(7))).toBe(7);
  });

  it('rejects with the same Error instance on typed failure', async () => {
    const err = new Error('as-is error');
    await expect(runEffectThrowingAsIs(Effect.fail(err))).rejects.toBe(err);
  });

  it('rejects with the same plain object on typed failure', async () => {
    const failure = { code: 'run_busy', message: 'x' };
    try {
      await runEffectThrowingAsIs(Effect.fail(failure));
      expect.unreachable('expected rejection');
    } catch (err) {
      expect(err).toBe(failure);
      expect(err instanceof Error).toBe(false);
    }
  });
});

describe('createKeyedSerialExecutor', () => {
  it('runs tasks for the same key in serial order', async () => {
    const serial = createKeyedSerialExecutor();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = serial.enqueue('k', async () => {
      order.push('first-start');
      await firstGate;
      order.push('first-end');
      return 1;
    });

    let secondStarted = false;
    const second = serial.enqueue('k', async () => {
      secondStarted = true;
      order.push('second-start');
      order.push('second-end');
      return 2;
    });

    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    expect(secondStarted).toBe(false);

    releaseFirst();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
  });

  it('continues after a rejected task on the same key', async () => {
    const serial = createKeyedSerialExecutor();
    const firstErr = { code: 'run_busy', message: 'first failed' };

    const first = serial.enqueue('k', async () => {
      throw firstErr;
    });
    const second = serial.enqueue('k', async () => 'ok');

    await expect(first).rejects.toBe(firstErr);
    await expect(second).resolves.toBe('ok');
  });

  it('allows concurrent work on different keys', async () => {
    const serial = createKeyedSerialExecutor();
    let releaseA!: () => void;
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let bStarted = false;

    const a = serial.enqueue('a', async () => {
      await aGate;
      return 'a-done';
    });

    const b = serial.enqueue('b', async () => {
      bStarted = true;
      return 'b-done';
    });

    await Promise.resolve();
    expect(bStarted).toBe(true);
    await expect(b).resolves.toBe('b-done');

    releaseA();
    await expect(a).resolves.toBe('a-done');
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
