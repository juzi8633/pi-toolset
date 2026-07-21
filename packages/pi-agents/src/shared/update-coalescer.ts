// ABOUTME: Latest-value update coalescer for high-frequency subagent content streaming.
// ABOUTME: Bounds parent onUpdate cadence while preserving immediate flush/cancel for terminal paths.

export type CoalescerTimerHandle = unknown;

export type CoalescerTimers = {
  setTimeout: (handler: () => void, ms: number) => CoalescerTimerHandle;
  clearTimeout: (handle: CoalescerTimerHandle) => void;
};

const defaultTimers: CoalescerTimers = {
  setTimeout(handler, ms) {
    const id = globalThis.setTimeout(handler, ms);
    id.unref?.();
    return id;
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export type LatestValueCoalescer<T> = {
  /** Arm or replace the pending value; emits at most once per interval. */
  schedule: (value: T) => void;
  /** Emit the pending value immediately if any. */
  flush: () => void;
  /** Discard pending work without emitting. */
  cancel: () => void;
  /** True when a value is armed but not yet emitted. */
  hasPending: () => boolean;
};

/**
 * Synchronous latest-value coalescer.
 * First schedule arms one timer; further schedules replace the pending value only.
 */
export function createLatestValueCoalescer<T>(
  emit: (value: T) => void,
  intervalMs: number,
  timers: CoalescerTimers = defaultTimers
): LatestValueCoalescer<T> {
  let pending: T | undefined;
  let hasValue = false;
  let timer: CoalescerTimerHandle | undefined;

  const clearTimer = () => {
    if (timer === undefined) return;
    timers.clearTimeout(timer);
    timer = undefined;
  };

  const fire = () => {
    timer = undefined;
    if (!hasValue) return;
    const value = pending as T;
    pending = undefined;
    hasValue = false;
    emit(value);
  };

  return {
    schedule(value) {
      pending = value;
      hasValue = true;
      if (timer !== undefined) return;
      timer = timers.setTimeout(fire, intervalMs);
    },
    flush() {
      clearTimer();
      if (!hasValue) return;
      const value = pending as T;
      pending = undefined;
      hasValue = false;
      emit(value);
    },
    cancel() {
      clearTimer();
      pending = undefined;
      hasValue = false;
    },
    hasPending() {
      return hasValue;
    },
  };
}
