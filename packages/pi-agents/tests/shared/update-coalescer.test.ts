// ABOUTME: Unit tests for the latest-value update coalescer used by high-frequency streaming.
// ABOUTME: Uses an injectable fake clock so cadence, flush, and cancel behavior are deterministic.

import { describe, expect, it } from 'bun:test';
import { createLatestValueCoalescer, type CoalescerTimers } from '../../src/shared/update-coalescer.ts';

function createFakeTimers(): {
  timers: CoalescerTimers;
  advance: (ms: number) => void;
  pendingCount: () => number;
} {
  let nextId = 1;
  const pending = new Map<number, { fireAt: number; handler: () => void }>();
  let now = 0;
  return {
    timers: {
      setTimeout(handler, ms) {
        const id = nextId++;
        pending.set(id, { fireAt: now + ms, handler });
        return id;
      },
      clearTimeout(handle) {
        pending.delete(handle as number);
      },
    },
    advance(ms) {
      now += ms;
      const due = [...pending.entries()]
        .filter(([, t]) => t.fireAt <= now)
        .sort((a, b) => a[1].fireAt - b[1].fireAt);
      for (const [id, t] of due) {
        if (!pending.has(id)) continue;
        pending.delete(id);
        t.handler();
      }
    },
    pendingCount: () => pending.size,
  };
}

describe('createLatestValueCoalescer', () => {
  it('emits only the latest of 100 rapid schedules on timer expiry', () => {
    const clock = createFakeTimers();
    const emitted: number[] = [];
    const c = createLatestValueCoalescer<number>((v) => emitted.push(v), 150, clock.timers);
    for (let i = 0; i < 100; i++) c.schedule(i);
    expect(emitted).toEqual([]);
    expect(clock.pendingCount()).toBe(1);
    clock.advance(149);
    expect(emitted).toEqual([]);
    clock.advance(1);
    expect(emitted).toEqual([99]);
    expect(clock.pendingCount()).toBe(0);
  });

  it('flush emits the pending value immediately and clears the timer', () => {
    const clock = createFakeTimers();
    const emitted: string[] = [];
    const c = createLatestValueCoalescer<string>((v) => emitted.push(v), 150, clock.timers);
    c.schedule('a');
    c.schedule('b');
    c.flush();
    expect(emitted).toEqual(['b']);
    expect(clock.pendingCount()).toBe(0);
    clock.advance(1000);
    expect(emitted).toEqual(['b']);
  });

  it('cancel discards pending work and prevents late timer emission', () => {
    const clock = createFakeTimers();
    const emitted: string[] = [];
    const c = createLatestValueCoalescer<string>((v) => emitted.push(v), 150, clock.timers);
    c.schedule('stale');
    c.cancel();
    expect(c.hasPending()).toBe(false);
    clock.advance(1000);
    expect(emitted).toEqual([]);
  });

  it('terminal cancel-then-flush ordering cannot be overtaken by a stale timer', () => {
    const clock = createFakeTimers();
    const emitted: string[] = [];
    const c = createLatestValueCoalescer<string>((v) => emitted.push(v), 150, clock.timers);
    c.schedule('running-partial');
    // Shutdown path: discard pending running, emit terminal immediately outside coalescer.
    c.cancel();
    emitted.push('terminal');
    clock.advance(1000);
    expect(emitted).toEqual(['terminal']);
  });

  it('arms only one timer across repeated schedules', () => {
    const clock = createFakeTimers();
    const c = createLatestValueCoalescer<number>(() => {}, 150, clock.timers);
    c.schedule(1);
    c.schedule(2);
    c.schedule(3);
    expect(clock.pendingCount()).toBe(1);
    clock.advance(150);
    expect(clock.pendingCount()).toBe(0);
    c.schedule(4);
    expect(clock.pendingCount()).toBe(1);
  });
});
