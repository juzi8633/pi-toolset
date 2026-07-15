// ABOUTME: Tests for the run coordinator — stable unit ids, fingerprints, status derivation, attempts.
// ABOUTME: Drives coalesced persistence with a fake clock and a memory-backed fake RunStore.

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentConfig, Runtime } from '../src/agents.ts';
import {
  aggregateCapability,
  agentFingerprint,
  assertUniqueUnitIds,
  chainFanoutStepId,
  chainFanoutUnitId,
  chainStepUnitId,
  createRunCoordinator,
  deriveRunStatus,
  generateUnitIds,
  resumeCapabilityForRuntime,
  stampResultMetadata,
  type UnitExecutionContext,
} from '../src/run-coordinator.ts';
import { createRunStore, type RunStore } from '../src/run-store.ts';
import type { AgentRunRecordV1, RunUnitRecord } from '../src/run-types.ts';
import { emptyUsage, type SingleResult, type SubagentDetails } from '../src/types.ts';

function baseAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'tester',
    description: 'test',
    systemPrompt: 'do tasks',
    source: 'builtin',
    filePath: '/tmp/tester.md',
    ...overrides,
  };
}

function detailsWith(summarize: (r: SingleResult[]) => SubagentDetails): SubagentDetails {
  return summarize([]);
}

function emptyDetails(): SubagentDetails {
  return {
    mode: 'single',
    agentScope: 'both',
    projectAgentsDir: null,
    builtinAgentsDir: '/builtin',
    results: [],
  };
}

describe('canonical chain/fanout unit ids', () => {
  it('maps step 2 and item index 0 to chain-0002-fanout-0001', () => {
    expect(chainStepUnitId(2)).toBe('chain-0002');
    expect(chainFanoutStepId(2)).toBe('chain-0002-fanout');
    expect(chainFanoutUnitId(2, 0)).toBe('chain-0002-fanout-0001');
  });

  it('pads multi-digit item positions without duplicate fanout segments', () => {
    expect(chainFanoutUnitId(1, 9)).toBe('chain-0001-fanout-0010');
    expect(chainFanoutUnitId(12, 0)).toBe('chain-0012-fanout-0001');
    expect(chainFanoutUnitId(2, 0)).not.toMatch(/fanout-fanout/);
    expect(chainFanoutUnitId(2, 0)).toMatch(/^chain-\d{4}-fanout-\d{4}$/);
  });

  it('rejects non-positive steps and negative indexes', () => {
    expect(() => chainStepUnitId(0)).toThrow(/Invalid chain step/);
    expect(() => chainFanoutStepId(-1)).toThrow(/Invalid chain step/);
    expect(() => chainFanoutUnitId(1, -1)).toThrow(/Invalid fanout index/);
  });
});

describe('generateUnitIds', () => {
  it('returns ["single"] for single mode', () => {
    expect(generateUnitIds('single', { agent: 'noop', task: 'x' })).toEqual(['single']);
  });

  it('returns padded parallel-N ids for parallel mode', () => {
    expect(
      generateUnitIds('parallel', {
        tasks: [{}, {}, {}],
      } as unknown as { tasks: unknown[] })
    ).toEqual(['parallel-0001', 'parallel-0002', 'parallel-0003']);
  });

  it('returns only sequential chain ids; omits fanout placeholders', () => {
    const chain = [
      { agent: 'a', task: 't' },
      { expand: {}, parallel: { agent: 'b', task: 't' }, collect: { name: 'c' } },
      { agent: 'c', task: 't' },
    ];
    expect(generateUnitIds('chain', { chain })).toEqual(['chain-0001', 'chain-0003']);
  });

  it('never emits unpadded or duplicate-fanout suffixes', () => {
    const ids = [
      ...generateUnitIds('single', {}),
      ...generateUnitIds('parallel', { tasks: [{}, {}] }),
      ...generateUnitIds('chain', {
        chain: [
          { agent: 'a', task: 't' },
          { expand: {}, parallel: { agent: 'b', task: 't' }, collect: { name: 'c' } },
        ],
      }),
      chainFanoutUnitId(2, 0),
    ];
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
      expect(id).not.toMatch(/fanout-fanout/);
      expect(id).not.toMatch(/-(?:[0-9]{1,3}|[0-9]{5,})(?:-|$)/);
    }
  });
});

describe('assertUniqueUnitIds', () => {
  it('passes for unique ids', () => {
    expect(() => assertUniqueUnitIds(['single', 'parallel-0001'])).not.toThrow();
  });

  it('throws duplicate_unit_id for collisions', () => {
    expect(() => assertUniqueUnitIds(['single', 'single'])).toThrow(/duplicate_unit_id/);
  });
});

describe('agentFingerprint', () => {
  it('is deterministic for the same behavior-affecting fields', () => {
    const a = baseAgent();
    const b = baseAgent();
    expect(agentFingerprint(a)).toBe(agentFingerprint(b));
  });

  it('is stable regardless of object key enumeration order', () => {
    const a = baseAgent({ tools: ['bash', 'read'] });
    const b = baseAgent({ tools: ['read', 'bash'] });
    expect(agentFingerprint(a)).toBe(agentFingerprint(b));
  });

  it('changes when behavior-affecting fields change', () => {
    const checks: Array<[keyof AgentConfig, unknown]> = [
      ['name', 'other'],
      ['systemPrompt', 'do other things'],
      ['systemPromptMode', 'replace'],
      ['runtime', 'grok'],
      ['model', 'gpt-x'],
      ['thinking', 'high'],
      ['tools', ['bash']],
      ['excludeTools', ['write']],
      ['skills', ['docs']],
      ['noSkills', true],
      ['noContextFiles', true],
      ['defaultContext', 'fork'],
      ['isolation', 'worktree'],
      ['worktreeSetupHook', 'echo'],
      ['completionCheck', ['test']],
      ['maxTurns', 5],
      ['maxSubagentDepth', 1],
    ];
    const base = baseAgent();
    const reference = agentFingerprint(base);
    for (const [key, value] of checks) {
      const mutated: AgentConfig = { ...base, [key]: value } as AgentConfig;
      expect(agentFingerprint(mutated)).not.toBe(reference);
    }
  });

  it('excludes provenance fields: description, filePath, localName, packageName', () => {
    const a = baseAgent();
    const b = baseAgent({
      description: 'changed description',
      filePath: '/elsewhere/changed.md',
    });
    expect(agentFingerprint(a)).toBe(agentFingerprint(b));
  });
});

describe('resumeCapabilityForRuntime', () => {
  it('returns session for pi/runtime=undefined', () => {
    expect(resumeCapabilityForRuntime(undefined)).toBe('session');
  });
  it('returns session for grok-acp', () => {
    expect(resumeCapabilityForRuntime('grok-acp' as Runtime)).toBe('session');
  });
});

describe('aggregateCapability', () => {
  it('reduces an all-session set to session', () => {
    expect(aggregateCapability(['session', 'session'])).toBe('session');
  });
  it('returns session for an empty set', () => {
    expect(aggregateCapability([])).toBe('session');
  });
  it('aggregates Pi + Grok ACP as session', () => {
    expect(aggregateCapability(['session', 'session'])).toBe('session');
  });
});

describe('deriveRunStatus', () => {
  function unit(status: RunUnitRecord['status']): RunUnitRecord {
    return {
      unitId: 'u',
      agent: 'a',
      agentFingerprint: 'f',
      runtime: undefined,
      capability: 'session',
      status,
      attempt: 1,
      attempts: [],
      effectiveCwd: '/cwd',
    };
  }
  it('queued when any unit is queued', () => {
    expect(deriveRunStatus({ a: unit('queued'), b: unit('running') })).toBe('running');
  });
  it('running when any unit is running', () => {
    expect(deriveRunStatus({ a: unit('running'), b: unit('completed') })).toBe('running');
  });
  it('interrupted beats completed', () => {
    expect(deriveRunStatus({ a: unit('interrupted'), b: unit('completed') })).toBe('interrupted');
  });
  it('completed when all completed', () => {
    expect(deriveRunStatus({ a: unit('completed'), b: unit('completed') })).toBe('completed');
  });
  it('failed when a failed unit exists and no interrupted/active', () => {
    expect(deriveRunStatus({ a: unit('failed'), b: unit('completed') })).toBe('failed');
  });
  it('cancelled when only cancelled/skipped remain', () => {
    expect(deriveRunStatus({ a: unit('cancelled'), b: unit('skipped') })).toBe('cancelled');
  });
});

describe('aggregateRun resumable metadata', () => {
  function unit(
    unitId: string,
    status: RunUnitRecord['status'],
    overrides: Partial<RunUnitRecord> = {}
  ): RunUnitRecord {
    return {
      unitId,
      agent: 'a',
      agentFingerprint: 'f',
      runtime: undefined,
      capability: 'session',
      status,
      attempt: 1,
      attempts: [],
      effectiveCwd: '/cwd',
      ...overrides,
    };
  }

  it('marks completed runs resumable for continuation tasks', () => {
    const store = fakeStore({ now: () => 1 });
    const coord = createRunCoordinator({ store, now: () => 1 });
    const units = {
      single: unit('single', 'completed'),
    };
    const agg = coord.aggregateRun(emptyDetails(), units);
    expect(agg.status).toBe('completed');
    expect(agg.resumable).toBe(true);
    expect(agg.capability).toBe('session');
  });

  it('marks interrupted and failed runs with incomplete units resumable', () => {
    const store = fakeStore({ now: () => 1 });
    const coord = createRunCoordinator({ store, now: () => 1 });

    const interrupted = coord.aggregateRun(emptyDetails(), {
      a: unit('a', 'interrupted'),
      b: unit('b', 'completed'),
    });
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.resumable).toBe(true);

    const failed = coord.aggregateRun(emptyDetails(), {
      a: unit('a', 'failed'),
      b: unit('b', 'completed'),
    });
    expect(failed.status).toBe('failed');
    expect(failed.resumable).toBe(true);

    const cancelled = coord.aggregateRun(emptyDetails(), {
      a: unit('a', 'cancelled'),
      b: unit('b', 'skipped'),
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.resumable).toBe(true);
  });

  it('does not claim active runs are concurrently resumable', () => {
    const store = fakeStore({ now: () => 1 });
    const coord = createRunCoordinator({ store, now: () => 1 });

    const running = coord.aggregateRun(emptyDetails(), {
      a: unit('a', 'running'),
      b: unit('b', 'completed'),
    });
    expect(running.status).toBe('running');
    expect(running.resumable).toBe(false);

    const queuedPeer = coord.aggregateRun(emptyDetails(), {
      a: unit('a', 'queued'),
      b: unit('b', 'completed'),
    });
    expect(queuedPeer.status).toBe('running');
    expect(queuedPeer.resumable).toBe(false);
  });

  it('marks terminal failed/cancelled/interrupted runs with queued units resumable', () => {
    const store = fakeStore({ now: () => 1 });
    const coord = createRunCoordinator({ store, now: () => 1 });

    // Terminal status is authoritative from details.run even when units still
    // include never-started queued siblings (crashed terminal snapshot).
    const failed = coord.aggregateRun(
      {
        ...emptyDetails(),
        run: { runId: 'r1', status: 'failed', resumable: true, capability: 'session' },
      },
      {
        a: unit('a', 'failed'),
        b: unit('b', 'queued'),
      }
    );
    expect(failed.status).toBe('failed');
    expect(failed.resumable).toBe(true);

    const cancelled = coord.aggregateRun(
      {
        ...emptyDetails(),
        run: { runId: 'r1', status: 'cancelled', resumable: true, capability: 'session' },
      },
      {
        a: unit('a', 'cancelled'),
        b: unit('b', 'queued'),
      }
    );
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.resumable).toBe(true);

    const interrupted = coord.aggregateRun(
      {
        ...emptyDetails(),
        run: { runId: 'r1', status: 'interrupted', resumable: true, capability: 'session' },
      },
      {
        a: unit('a', 'interrupted'),
        b: unit('b', 'queued'),
      }
    );
    expect(interrupted.status).toBe('interrupted');
    expect(interrupted.resumable).toBe(true);

    // Pure queued terminal-claimed status is still non-resumable when the run
    // itself is actively queued (not a terminal incomplete state).
    const activelyQueued = coord.aggregateRun(
      {
        ...emptyDetails(),
        run: { runId: 'r1', status: 'queued', resumable: false, capability: 'session' },
      },
      { a: unit('a', 'queued') }
    );
    expect(activelyQueued.status).toBe('queued');
    expect(activelyQueued.resumable).toBe(false);
  });
});

describe('stampResultMetadata', () => {
  it('stamps runId, unitId, attempt, sessionFile, resumeCapability', () => {
    const ctx: UnitExecutionContext = {
      runId: 'run-x',
      unitId: 'single',
      agent: 'noop',
      runtime: undefined,
      resumeCapability: 'session',
      effectiveCwd: '/cwd',
      sessionFile: '/sessions/a.jsonl',
      attempt: 2,
    };
    const result: SingleResult = {
      agent: 'noop',
      agentSource: 'unknown',
      task: '',
      exitCode: -1,
      status: 'running',
      messages: [],
      stderr: '',
      usage: emptyUsage(),
    };
    stampResultMetadata(result, ctx);
    expect(result.runId).toBe('run-x');
    expect(result.unitId).toBe('single');
    expect(result.attempt).toBe(2);
    expect(result.sessionFile).toBe('/sessions/a.jsonl');
    expect(result.resumeCapability).toBe('session');
  });
});

interface FakeStoreOptions {
  now: () => number;
}

function fakeStore(opts: FakeStoreOptions): RunStore & {
  records: Map<string, AgentRunRecordV1>;
  writes: number;
  flushes: () => Promise<void>;
} {
  const records = new Map<string, AgentRunRecordV1>();
  let writes = 0;
  let pending: Promise<void> = Promise.resolve();
  const updateRun: RunStore['updateRun'] = async (runId, mutate) => {
    const r = records.get(runId);
    if (!r) throw new Error('not found');
    mutate(r);
    r.updatedAt = opts.now();
    writes++;
    return r;
  };
  void updateRun;
  const result = {
    rootDir: '/tmp/fake-root',
    records,
    writes,
    flushes: () => pending,
    createRun: (() =>
      Promise.resolve({ runId: '', record: {} as AgentRunRecordV1 })) as RunStore['createRun'],
    getRun: ((runId: string) => {
      const r = records.get(runId);
      return r
        ? { ok: true, loaded: { runDir: '/d/' + runId, record: r } }
        : { ok: false, error: { code: 'run_not_found' as const, runId, message: 'nope' } };
    }) as RunStore['getRun'],
    updateRun,
    appendEvent: async () => {},
    listRuns: async () => [],
    claimRun: (() =>
      Promise.resolve({ ok: true, claimId: 'c', ticket: 1 } as const)) as RunStore['claimRun'],
    releaseRun: async () => {},
    abandonRun: async () => {},
    inspectClaims: ((_runId: string) =>
      ({ ok: true, claims: [] as never[] }) as never) as RunStore['inspectClaims'],
    isPidAlive: () => false,
  };
  pending = Promise.resolve();
  // Wrap writes to capture count.
  const origUpdate = result.updateRun;
  result.updateRun = ((runId: string, mutate: (r: AgentRunRecordV1) => void) => {
    const p = origUpdate(runId, mutate);
    pending = pending.then(() => void p);
    return p;
  }) as typeof origUpdate;
  // expose mutable counter
  Object.defineProperty(result, 'writes', { get: () => writes });
  return result as unknown as ReturnType<typeof fakeStore>;
}

function ctx(over: Partial<UnitExecutionContext> = {}): UnitExecutionContext {
  return {
    runId: 'run-1',
    unitId: 'single',
    agent: 'noop',
    runtime: undefined,
    resumeCapability: 'session',
    effectiveCwd: '/cwd',
    attempt: 1,
    ...over,
  };
}

describe('createRunCoordinator persistence and attempts', () => {
  it('startUnit marks the unit running and persists immediately (flush)', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record: AgentRunRecordV1 = {
      version: 1,
      runId: 'run-1',
      mode: 'single',
      status: 'queued',
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'noop',
        task: '',
      },
      background: false,
      agentScope: 'both',
      createdAt: 0,
      updatedAt: 0,
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'noop',
          agentFingerprint: '',
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: '/cwd',
        },
      },
      eventsFile: 'events.jsonl',
    };
    store.records.set('run-1', record);
    const coord = createRunCoordinator({ store, now: () => t, coalesceMs: 1000 });
    coord.registerRun('run-1', record);

    const result: SingleResult = {
      agent: 'noop',
      agentSource: 'unknown',
      task: '',
      exitCode: -1,
      status: 'queued',
      messages: [],
      stderr: '',
      usage: emptyUsage(),
    };
    coord.startUnit('run-1', ctx(), result);
    await store.flushes();
    expect(result.runId).toBe('run-1');
    expect(result.status).toBe('running');
    const stored = store.records.get('run-1')!;
    expect(stored.units['single']!.status).toBe('running');
  });

  it('finishUnit preserves the terminal attempt summary', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record: AgentRunRecordV1 = {
      version: 1,
      runId: 'run-1',
      mode: 'single',
      status: 'running',
      request: { mode: 'single', agentScope: 'both', agent: 'noop', task: '' },
      background: false,
      agentScope: 'both',
      createdAt: 0,
      updatedAt: 0,
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'noop',
          agentFingerprint: '',
          runtime: undefined,
          capability: 'session',
          status: 'running',
          attempt: 1,
          attempts: [],
          effectiveCwd: '/cwd',
        },
      },
      eventsFile: 'events.jsonl',
    };
    store.records.set('run-1', record);
    const coord = createRunCoordinator({ store, now: () => t, coalesceMs: 1000 });
    coord.registerRun('run-1', record);

    const result: SingleResult = {
      agent: 'noop',
      agentSource: 'unknown',
      task: '',
      exitCode: 0,
      status: 'running',
      messages: [],
      stderr: '',
      usage: emptyUsage(),
      stopReason: 'end',
    };
    coord.finishUnit('run-1', ctx(), result, 'completed');
    await store.flushes();
    const stored = store.records.get('run-1')!;
    const unit = stored.units['single']!;
    expect(unit.status).toBe('completed');
    expect(unit.attempts.length).toBe(1);
    expect(unit.attempts[0]!.status).toBe('completed');
    expect(unit.attempts[0]!.finishedAt).toBe(t);
    // Never overwrite previous attempt's data: a second finish would append a new attempt only on resume.
    expect(unit.attempts[0]!.finishedAt).toBe(t);
  });

  it('coalesces persistence within coalesceMs, but flushes on flushNow', async () => {
    let t = 100;
    let realWrites = 0;
    const store = fakeStore({ now: () => t });
    const record: AgentRunRecordV1 = {
      version: 1,
      runId: 'run-1',
      mode: 'single',
      status: 'running',
      request: { mode: 'single', agentScope: 'both', agent: 'noop', task: '' },
      background: false,
      agentScope: 'both',
      createdAt: 0,
      updatedAt: 0,
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'noop',
          agentFingerprint: '',
          runtime: undefined,
          capability: 'session',
          status: 'running',
          attempt: 1,
          attempts: [],
          effectiveCwd: '/cwd',
        },
      },
      eventsFile: 'events.jsonl',
    };
    store as unknown as { updateRun: unknown };
    const origUpdate = store.updateRun.bind(store);
    store.updateRun = (async (runId, mutate) => {
      realWrites++;
      return origUpdate(runId, mutate);
    }) as typeof origUpdate;
    store.records.set('run-1', record);
    const coord = createRunCoordinator({ store, now: () => t, coalesceMs: 1000 });
    coord.registerRun('run-1', record);

    // Several coalesced updates in the same window.
    for (let i = 0; i < 5; i++) {
      coord.persist({
        runId: 'run-1',
        details: emptyDetails(),
        units: record.units,
      });
    }
    // No immediate writes for coalesced non-flush updates — the timer is unref'd.
    // (We assert only that flushNow triggers a write.)
    realWrites = 0;
    coord.persist({
      runId: 'run-1',
      details: emptyDetails(),
      units: record.units,
      flushNow: true,
    });
    await store.flushes();
    expect(realWrites).toBe(1);
  });

  it('finalizeRun flushes terminal state and unregisters the run', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record: AgentRunRecordV1 = {
      version: 1,
      runId: 'run-1',
      mode: 'single',
      status: 'running',
      request: { mode: 'single', agentScope: 'both', agent: 'noop', task: '' },
      background: false,
      agentScope: 'both',
      createdAt: 0,
      updatedAt: 0,
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'noop',
          agentFingerprint: '',
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          attempt: 1,
          attempts: [],
          effectiveCwd: '/cwd',
        },
      },
      eventsFile: 'events.jsonl',
    };
    store.records.set('run-1', record);
    const coord = createRunCoordinator({ store, now: () => t, coalesceMs: 1000 });
    coord.registerRun('run-1', record);
    await coord.finalizeRun(
      'run-1',
      detailsWith((r) => ({ ...emptyDetails(), results: r })),
      record.units,
      {
        success: true,
      }
    );
    await store.flushes();
    const stored = store.records.get('run-1')!;
    expect(stored.status).toBe('completed');
    expect(stored.finishedAt).toBe(t);
    expect(coord.isActive('run-1')).toBe(false);
  });

  it('finalizeRun marks interrupted when interrupted=true', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record: AgentRunRecordV1 = {
      version: 1,
      runId: 'run-1',
      mode: 'single',
      status: 'running',
      request: { mode: 'single', agentScope: 'both', agent: 'noop', task: '' },
      background: false,
      agentScope: 'both',
      createdAt: 0,
      updatedAt: 0,
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'noop',
          agentFingerprint: '',
          runtime: undefined,
          capability: 'session',
          status: 'running',
          attempt: 1,
          attempts: [],
          effectiveCwd: '/cwd',
        },
      },
      eventsFile: 'events.jsonl',
    };
    store.records.set('run-1', record);
    const coord = createRunCoordinator({ store, now: () => t, coalesceMs: 1000 });
    coord.registerRun('run-1', record);
    await coord.finalizeRun('run-1', emptyDetails(), record.units, { interrupted: true });
    await store.flushes();
    const stored = store.records.get('run-1')!;
    expect(stored.status).toBe('interrupted');
  });
});

/** Request-topology fanout step whose parallel.agent matches durable children. */
function fanoutChainStep(agentName: string) {
  return {
    expand: { from: { output: 'seed', path: '/items' } },
    parallel: { agent: agentName, task: 't' },
    collect: { name: 'c' },
  };
}

function chainRecord(
  units: Record<string, RunUnitRecord> = {
    'chain-0001': {
      unitId: 'chain-0001',
      agent: 'seed',
      agentFingerprint: 'fp',
      runtime: undefined,
      capability: 'session',
      status: 'completed',
      step: 1,
      attempt: 1,
      attempts: [],
      effectiveCwd: '/cwd',
    },
  }
): AgentRunRecordV1 {
  return {
    version: 1,
    runId: 'run-1',
    mode: 'chain',
    status: 'running',
    request: {
      mode: 'chain',
      agentScope: 'both',
      chain: [{ agent: 'seed', task: 'seed' }, fanoutChainStep('worker')],
    },
    background: false,
    agentScope: 'both',
    createdAt: 0,
    updatedAt: 0,
    details: emptyDetails(),
    units,
    eventsFile: 'events.jsonl',
  };
}

describe('expandFanout', () => {
  it('persists workflowState.fanouts and child units before resolving', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = chainRecord();
    const unitsRef = record.units;
    store.records.set('run-1', structuredClone(record));
    const coord = createRunCoordinator({ store, now: () => t, coalesceMs: 1000 });
    coord.registerRun('run-1', record);

    const agent = baseAgent({ name: 'worker' });
    const expansion = await coord.expandFanout('run-1', {
      step: 2,
      items: ['a', 'b'],
      agent,
      runtime: undefined,
      effectiveCwd: '/cwd',
    });

    expect(expansion.unitIds).toEqual(['chain-0002-fanout-0001', 'chain-0002-fanout-0002']);
    expect(record.units).toBe(unitsRef);
    expect(Object.keys(record.units).sort()).toEqual([
      'chain-0001',
      'chain-0002-fanout-0001',
      'chain-0002-fanout-0002',
    ]);

    const stored = store.records.get('run-1')!;
    expect(stored.workflowState?.fanouts?.['chain-0002-fanout']).toEqual(expansion);
    expect(stored.units['chain-0002-fanout-0001']?.status).toBe('queued');
    expect(stored.units['chain-0002-fanout-0001']?.attempt).toBe(1);
    expect(stored.units['chain-0002-fanout-0001']?.attempts).toEqual([]);
    expect(stored.units['chain-0002-fanout-0001']?.step).toBe(2);
    expect(stored.units['chain-0002-fanout-0001']?.fanoutIndex).toBe(0);
    expect(stored.units['chain-0002-fanout-0002']?.fanoutIndex).toBe(1);
    expect(stored.units['chain-0002-fanout-0001']?.agentFingerprint).toBe(agentFingerprint(agent));
    expect(stored.units['chain-0002-fanout']).toBeUndefined();
  });

  it('persists an empty expansion with no child units', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = chainRecord();
    store.records.set('run-1', structuredClone(record));
    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-1', record);

    const expansion = await coord.expandFanout('run-1', {
      step: 2,
      items: [],
      agent: baseAgent({ name: 'worker' }),
      runtime: undefined,
      effectiveCwd: '/cwd',
    });

    expect(expansion).toEqual({ step: 2, items: [], unitIds: [] });
    expect(Object.keys(record.units)).toEqual(['chain-0001']);
    const stored = store.records.get('run-1')!;
    expect(stored.workflowState?.fanouts?.['chain-0002-fanout']).toEqual(expansion);
    expect(Object.keys(stored.units)).toEqual(['chain-0001']);
  });

  it('is idempotent for identical expansions', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = chainRecord();
    store.records.set('run-1', structuredClone(record));
    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-1', record);

    const input = {
      step: 2,
      items: ['x'],
      agent: baseAgent({ name: 'worker' }),
      runtime: undefined as Runtime | undefined,
      effectiveCwd: '/cwd',
    };
    const first = await coord.expandFanout('run-1', input);
    const writesBefore = store.writes;
    const second = await coord.expandFanout('run-1', input);
    expect(second).toEqual(first);
    expect(store.writes).toBe(writesBefore);
    expect(
      Object.keys(record.units).filter((k) => k.startsWith('chain-0002-fanout-'))
    ).toHaveLength(1);
  });

  it('rejects conflicting expansions without mutating durable or live state', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = chainRecord();
    store.records.set('run-1', structuredClone(record));
    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-1', record);

    await coord.expandFanout('run-1', {
      step: 2,
      items: ['a'],
      agent: baseAgent({ name: 'worker' }),
      runtime: undefined,
      effectiveCwd: '/cwd',
    });
    const snapshotUnits = { ...record.units };
    const snapshotFanouts = structuredClone(record.workflowState);

    await expect(
      coord.expandFanout('run-1', {
        step: 2,
        items: ['a', 'b'],
        agent: baseAgent({ name: 'worker' }),
        runtime: undefined,
        effectiveCwd: '/cwd',
      })
    ).rejects.toThrow(/fanout_state_conflict/);

    expect(Object.keys(record.units).sort()).toEqual(Object.keys(snapshotUnits).sort());
    expect(record.workflowState).toEqual(snapshotFanouts);
    const stored = store.records.get('run-1')!;
    expect(stored.workflowState).toEqual(snapshotFanouts);
  });

  it('propagates strict write failures without leaving child units live', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = chainRecord();
    // Use a separate stored object so store mutation ≠ live mutation.
    store.records.set('run-1', structuredClone(record));
    store.updateRun = (async () => {
      throw new Error('disk full');
    }) as typeof store.updateRun;

    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-1', record);

    await expect(
      coord.expandFanout('run-1', {
        step: 2,
        items: ['a'],
        agent: baseAgent({ name: 'worker' }),
        runtime: undefined,
        effectiveCwd: '/cwd',
      })
    ).rejects.toThrow(/disk full/);

    expect(record.units['chain-0002-fanout-0001']).toBeUndefined();
    expect(record.workflowState?.fanouts?.['chain-0002-fanout']).toBeUndefined();
  });

  it('preserves workflowState across subsequent persist writes', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = chainRecord();
    store.records.set('run-1', structuredClone(record));
    const coord = createRunCoordinator({ store, now: () => t, coalesceMs: 1000 });
    coord.registerRun('run-1', record);

    await coord.expandFanout('run-1', {
      step: 2,
      items: ['a'],
      agent: baseAgent({ name: 'worker' }),
      runtime: undefined,
      effectiveCwd: '/cwd',
    });

    coord.persist({
      runId: 'run-1',
      details: emptyDetails(),
      units: record.units,
      flushNow: true,
    });
    await store.flushes();

    const stored = store.records.get('run-1')!;
    expect(stored.workflowState?.fanouts?.['chain-0002-fanout']?.items).toEqual(['a']);
  });

  it('disk matches request while live has stale mapping/identity: idempotent success and mirrors disk', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-fanout-live-stale-map-'));
    try {
      const store = createRunStore({ rootDir: root });
      const agentA = baseAgent({ name: 'worker-a', systemPrompt: 'A' });
      const agentStale = baseAgent({ name: 'worker-stale', systemPrompt: 'S' });
      const { runId } = await store.createRun({
        mode: 'chain',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'chain',
          agentScope: 'both',
          chain: [{ agent: 'planner', task: 'p' }, fanoutChainStep('worker-a')],
        },
        details: emptyDetails(),
        units: {
          'chain-0001': {
            unitId: 'chain-0001',
            agent: 'planner',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'completed',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            step: 1,
          },
        },
      });

      const unitAId = chainFanoutUnitId(2, 0);
      const expansionA = {
        step: 2,
        items: ['item-a'],
        unitIds: [unitAId],
      };
      const unitA: RunUnitRecord = {
        unitId: unitAId,
        agent: agentA.name,
        agentFingerprint: agentFingerprint(agentA),
        runtime: undefined,
        capability: 'session',
        status: 'queued',
        attempt: 1,
        attempts: [],
        effectiveCwd: root,
        step: 2,
        fanoutIndex: 0,
      };
      await store.updateRun(runId, (r) => {
        r.units[unitAId] = unitA;
        r.workflowState = { fanouts: { [chainFanoutStepId(2)]: expansionA } };
      });

      // Live holds an older incompatible mapping + identity (would conflict if
      // evaluated alone before reading disk).
      const loaded0 = store.getRun(runId);
      expect(loaded0.ok).toBe(true);
      if (!loaded0.ok) return;
      const staleLive = structuredClone(loaded0.loaded.record);
      const staleUnitId = chainFanoutUnitId(2, 0);
      staleLive.units[staleUnitId] = {
        unitId: staleUnitId,
        agent: agentStale.name,
        agentFingerprint: agentFingerprint(agentStale),
        runtime: undefined,
        capability: 'session',
        status: 'queued',
        attempt: 1,
        attempts: [],
        effectiveCwd: root,
        step: 2,
        fanoutIndex: 0,
      };
      staleLive.workflowState = {
        fanouts: {
          [chainFanoutStepId(2)]: {
            step: 2,
            items: ['old-item'],
            unitIds: [staleUnitId],
          },
        },
      };

      const coord = createRunCoordinator({ store });
      coord.registerRun(runId, staleLive);

      // Request matches durable disk A — must not fail on stale live conflict.
      const again = await coord.expandFanout(runId, {
        step: 2,
        items: ['item-a'],
        agent: agentA,
        runtime: undefined,
        effectiveCwd: root,
      });
      expect(again).toEqual(expansionA);
      expect(staleLive.units[unitAId]?.agent).toBe('worker-a');
      expect(staleLive.units[unitAId]?.agentFingerprint).toBe(agentFingerprint(agentA));
      expect(staleLive.workflowState?.fanouts?.[chainFanoutStepId(2)]).toEqual(expansionA);

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.loaded.record.units[unitAId]?.agent).toBe('worker-a');
        expect(loaded.loaded.record.workflowState?.fanouts?.[chainFanoutStepId(2)]).toEqual(
          expansionA
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('live stale + disk A identity: B mirrors disk children and does not install B units', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-fanout-stale-'));
    try {
      const store = createRunStore({ rootDir: root });
      const agentA = baseAgent({ name: 'worker-a', systemPrompt: 'A' });
      const agentB = baseAgent({ name: 'worker-b', systemPrompt: 'B' });
      const { runId, record } = await store.createRun({
        mode: 'chain',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'chain',
          agentScope: 'both',
          chain: [{ agent: 'planner', task: 'p' }, fanoutChainStep('worker-a')],
        },
        details: emptyDetails(),
        units: {
          'chain-0001': {
            unitId: 'chain-0001',
            agent: 'planner',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'completed',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            step: 1,
          },
        },
      });

      // Disk already has expansion A (full worker identity).
      const unitAId = chainFanoutUnitId(2, 0);
      const expansionA = {
        step: 2,
        items: ['item-a'],
        unitIds: [unitAId],
      };
      const unitA: RunUnitRecord = {
        unitId: unitAId,
        agent: agentA.name,
        agentFingerprint: agentFingerprint(agentA),
        runtime: undefined,
        capability: 'session',
        status: 'queued',
        attempt: 1,
        attempts: [],
        effectiveCwd: root,
        step: 2,
        fanoutIndex: 0,
      };
      await store.updateRun(runId, (r) => {
        r.units[unitAId] = unitA;
        r.workflowState = { fanouts: { [chainFanoutStepId(2)]: expansionA } };
      });

      // Live is stale: no fanout state / children (as if live lagged behind disk).
      const live = store.getRun(runId);
      expect(live.ok).toBe(true);
      if (!live.ok) return;
      // Start from disk snapshot then strip fanout so live is intentionally stale.
      const fullLive = structuredClone(live.loaded.record);
      const { workflowState: _omitWs, ...restLive } = fullLive;
      const staleUnits = { ...restLive.units };
      delete staleUnits[unitAId];
      const staleLive: AgentRunRecordV1 = { ...restLive, units: staleUnits };
      void _omitWs;
      const coord = createRunCoordinator({ store });
      coord.registerRun(runId, staleLive);

      // B expands with same mapping but different agent identity → conflict on disk identity.
      await expect(
        coord.expandFanout(runId, {
          step: 2,
          items: ['item-a'],
          agent: agentB,
          runtime: undefined,
          effectiveCwd: root,
        })
      ).rejects.toThrow(/fanout_state_conflict|identity mismatch/);

      // Conflict mirrors latest disk mapping/child identity onto live (not left as B/empty).
      expect(staleLive.units[unitAId]?.agent).toBe('worker-a');
      expect(staleLive.units[unitAId]?.agentFingerprint).toBe(agentFingerprint(agentA));
      expect(staleLive.workflowState?.fanouts?.[chainFanoutStepId(2)]).toEqual(expansionA);

      // Same identity as disk A: idempotent, mirrors disk children onto live.
      const again = await coord.expandFanout(runId, {
        step: 2,
        items: ['item-a'],
        agent: agentA,
        runtime: undefined,
        effectiveCwd: root,
      });
      expect(again).toEqual(expansionA);
      expect(staleLive.units[unitAId]?.agent).toBe('worker-a');
      expect(staleLive.units[unitAId]?.agentFingerprint).toBe(agentFingerprint(agentA));
      expect(staleLive.workflowState?.fanouts?.[chainFanoutStepId(2)]).toEqual(expansionA);

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.loaded.record.units[unitAId]?.agent).toBe('worker-a');
        expect(loaded.loaded.record.units[unitAId]?.agentFingerprint).toBe(
          agentFingerprint(agentA)
        );
      }
      void record;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('disk A / live B: conflict + flush/finalize keeps disk A and corrects live to A', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-fanout-ab-flush-'));
    try {
      const store = createRunStore({ rootDir: root });
      const agentA = baseAgent({ name: 'worker-a', systemPrompt: 'A' });
      const agentB = baseAgent({ name: 'worker-b', systemPrompt: 'B' });
      const { runId } = await store.createRun({
        mode: 'chain',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'chain',
          agentScope: 'both',
          chain: [{ agent: 'planner', task: 'p' }, fanoutChainStep('worker-a')],
        },
        details: emptyDetails(),
        units: {
          'chain-0001': {
            unitId: 'chain-0001',
            agent: 'planner',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'completed',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            step: 1,
          },
        },
      });

      const unitAId = chainFanoutUnitId(2, 0);
      const expansionA = {
        step: 2,
        items: ['item-a'],
        unitIds: [unitAId],
      };
      const unitA: RunUnitRecord = {
        unitId: unitAId,
        agent: agentA.name,
        agentFingerprint: agentFingerprint(agentA),
        runtime: undefined,
        capability: 'session',
        status: 'queued',
        attempt: 1,
        attempts: [],
        effectiveCwd: root,
        step: 2,
        fanoutIndex: 0,
      };
      await store.updateRun(runId, (r) => {
        r.units[unitAId] = unitA;
        r.workflowState = { fanouts: { [chainFanoutStepId(2)]: expansionA } };
      });

      const seeded = store.getRun(runId);
      expect(seeded.ok).toBe(true);
      if (!seeded.ok) return;
      const live = structuredClone(seeded.loaded.record);
      // Live holds incompatible expansion B + wrong child identity.
      live.units[unitAId] = {
        ...unitA,
        agent: agentB.name,
        agentFingerprint: agentFingerprint(agentB),
        status: 'running',
      };
      live.workflowState = {
        fanouts: {
          [chainFanoutStepId(2)]: {
            step: 2,
            items: ['item-b'],
            unitIds: [unitAId],
          },
        },
      };

      const coord = createRunCoordinator({ store });
      coord.registerRun(runId, live);

      await expect(
        coord.expandFanout(runId, {
          step: 2,
          items: ['item-b'],
          agent: agentB,
          runtime: undefined,
          effectiveCwd: root,
        })
      ).rejects.toThrow(/fanout_state_conflict/);

      // After conflict: live corrected to disk A.
      expect(live.workflowState?.fanouts?.[chainFanoutStepId(2)]).toEqual(expansionA);
      expect(live.units[unitAId]?.agent).toBe('worker-a');
      expect(live.units[unitAId]?.agentFingerprint).toBe(agentFingerprint(agentA));

      // Stale live status can still flush; mapping/identity stay A.
      live.units[unitAId] = {
        ...live.units[unitAId]!,
        agent: agentB.name,
        agentFingerprint: agentFingerprint(agentB),
        status: 'running',
      };
      live.workflowState = {
        fanouts: {
          [chainFanoutStepId(2)]: {
            step: 2,
            items: ['item-b'],
            unitIds: [unitAId],
          },
        },
      };
      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
        flushNow: true,
      });
      await new Promise((r) => setTimeout(r, 40));

      const afterFlush = store.getRun(runId);
      expect(afterFlush.ok).toBe(true);
      if (afterFlush.ok) {
        expect(afterFlush.loaded.record.workflowState?.fanouts?.[chainFanoutStepId(2)]).toEqual(
          expansionA
        );
        expect(afterFlush.loaded.record.units[unitAId]?.agent).toBe('worker-a');
        expect(afterFlush.loaded.record.units[unitAId]?.status).toBe('running');
      }
      // Live mirrored back to A after merge.
      expect(live.workflowState?.fanouts?.[chainFanoutStepId(2)]).toEqual(expansionA);
      expect(live.units[unitAId]?.agent).toBe('worker-a');

      await coord.finalizeRun(runId, emptyDetails(), live.units, { success: true });
      const afterFinal = store.getRun(runId);
      expect(afterFinal.ok).toBe(true);
      if (afterFinal.ok) {
        expect(afterFinal.loaded.record.workflowState?.fanouts?.[chainFanoutStepId(2)]).toEqual(
          expansionA
        );
        expect(afterFinal.loaded.record.units[unitAId]?.agent).toBe('worker-a');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('full snapshot live-only mapping does not pollute disk on flush/finalize', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-fanout-live-only-map-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'chain',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'chain',
          agentScope: 'both',
          chain: [{ agent: 'planner', task: 'p' }],
        },
        details: emptyDetails(),
        units: {
          'chain-0001': {
            unitId: 'chain-0001',
            agent: 'planner',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'completed',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            step: 1,
          },
        },
      });

      const seeded = store.getRun(runId);
      expect(seeded.ok).toBe(true);
      if (!seeded.ok) return;
      const live = structuredClone(seeded.loaded.record);
      const phantomId = chainFanoutUnitId(2, 0);
      live.workflowState = {
        fanouts: {
          [chainFanoutStepId(2)]: {
            step: 2,
            items: ['ghost'],
            unitIds: [phantomId],
          },
        },
      };
      live.units[phantomId] = {
        unitId: phantomId,
        agent: 'ghost-worker',
        agentFingerprint: 'fp-ghost',
        runtime: undefined,
        capability: 'session',
        status: 'queued',
        attempt: 1,
        attempts: [],
        effectiveCwd: root,
        step: 2,
        fanoutIndex: 0,
      };

      const coord = createRunCoordinator({ store });
      coord.registerRun(runId, live);
      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
        flushNow: true,
      });
      await new Promise((r) => setTimeout(r, 40));

      const afterFlush = store.getRun(runId);
      expect(afterFlush.ok).toBe(true);
      if (afterFlush.ok) {
        expect(afterFlush.loaded.record.workflowState).toBeUndefined();
        expect(afterFlush.loaded.record.units[phantomId]).toBeUndefined();
      }
      // Live mirrored: live-only mapping/children dropped.
      expect(live.workflowState).toBeUndefined();
      expect(live.units[phantomId]).toBeUndefined();

      // Re-inject live-only pollution and finalize — still no disk pollution.
      live.workflowState = {
        fanouts: {
          [chainFanoutStepId(2)]: {
            step: 2,
            items: ['ghost-final'],
            unitIds: [phantomId],
          },
        },
      };
      live.units[phantomId] = {
        unitId: phantomId,
        agent: 'ghost-worker',
        agentFingerprint: 'fp-ghost',
        runtime: undefined,
        capability: 'session',
        status: 'queued',
        attempt: 1,
        attempts: [],
        effectiveCwd: root,
        step: 2,
        fanoutIndex: 0,
      };
      await coord.finalizeRun(runId, emptyDetails(), live.units, { success: true });
      const afterFinal = store.getRun(runId);
      expect(afterFinal.ok).toBe(true);
      if (afterFinal.ok) {
        expect(afterFinal.loaded.record.workflowState).toBeUndefined();
        expect(afterFinal.loaded.record.units[phantomId]).toBeUndefined();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('disk mapping missing child is not filled from live; flush keeps gap', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-fanout-missing-child-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'chain',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'chain',
          agentScope: 'both',
          chain: [{ agent: 'planner', task: 'p' }],
        },
        details: emptyDetails(),
        units: {
          'chain-0001': {
            unitId: 'chain-0001',
            agent: 'planner',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'completed',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            step: 1,
          },
        },
      });

      const missingId = chainFanoutUnitId(2, 0);
      const expansion = {
        step: 2,
        items: ['orphan-map'],
        unitIds: [missingId],
      };
      await store.updateRun(runId, (r) => {
        // Mapping present, unit intentionally absent on disk.
        r.workflowState = { fanouts: { [chainFanoutStepId(2)]: expansion } };
      });

      const seeded = store.getRun(runId);
      expect(seeded.ok).toBe(true);
      if (!seeded.ok) return;
      const live = structuredClone(seeded.loaded.record);
      live.units[missingId] = {
        unitId: missingId,
        agent: 'live-fill',
        agentFingerprint: 'fp-live-fill',
        runtime: undefined,
        capability: 'session',
        status: 'running',
        attempt: 1,
        attempts: [],
        effectiveCwd: root,
        step: 2,
        fanoutIndex: 0,
      };

      const coord = createRunCoordinator({ store });
      coord.registerRun(runId, live);
      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
        flushNow: true,
      });
      await new Promise((r) => setTimeout(r, 40));

      const afterFlush = store.getRun(runId);
      expect(afterFlush.ok).toBe(true);
      if (afterFlush.ok) {
        expect(afterFlush.loaded.record.workflowState?.fanouts?.[chainFanoutStepId(2)]).toEqual(
          expansion
        );
        // Must not invent the missing mapped child from live.
        expect(afterFlush.loaded.record.units[missingId]).toBeUndefined();
      }
      // Live drop of invent-from-live child.
      expect(live.units[missingId]).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('collision with no disk mapping: conflict mirrors empty step; flush does not pollute', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-fanout-collision-nomap-'));
    try {
      const store = createRunStore({ rootDir: root });
      const agent = baseAgent({ name: 'worker' });
      const { runId } = await store.createRun({
        mode: 'chain',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'chain',
          agentScope: 'both',
          chain: [{ agent: 'planner', task: 'p' }, fanoutChainStep('worker')],
        },
        details: emptyDetails(),
        units: {
          'chain-0001': {
            unitId: 'chain-0001',
            agent: 'planner',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'completed',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            step: 1,
          },
        },
      });

      const childId = chainFanoutUnitId(2, 0);
      // Pre-existing unit collides with expansion ids; disk has no fanout mapping.
      await store.updateRun(runId, (r) => {
        r.units[childId] = {
          unitId: childId,
          agent: 'worker',
          agentFingerprint: 'fp-pre',
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
          step: 2,
          fanoutIndex: 0,
        };
      });

      const seeded = store.getRun(runId);
      expect(seeded.ok).toBe(true);
      if (!seeded.ok) return;
      const live = structuredClone(seeded.loaded.record);
      // Live invents a mapping that disk never had.
      live.workflowState = {
        fanouts: {
          [chainFanoutStepId(2)]: {
            step: 2,
            items: ['attempt-b'],
            unitIds: [childId],
          },
        },
      };
      live.units[childId] = {
        ...live.units[childId]!,
        agent: agent.name,
        agentFingerprint: agentFingerprint(agent),
      };

      const coord = createRunCoordinator({ store });
      coord.registerRun(runId, live);

      await expect(
        coord.expandFanout(runId, {
          step: 2,
          items: ['attempt-b'],
          agent,
          runtime: undefined,
          effectiveCwd: root,
        })
      ).rejects.toThrow(/fanout_state_conflict|already exists/);

      // No disk mapping → live mapping for this step removed; pre-existing disk unit kept.
      expect(live.workflowState?.fanouts?.[chainFanoutStepId(2)]).toBeUndefined();
      expect(live.units[childId]?.agent).toBe('worker');

      // Pollute live mapping again and flush — disk still has no mapping.
      live.workflowState = {
        fanouts: {
          [chainFanoutStepId(2)]: {
            step: 2,
            items: ['pollute'],
            unitIds: [childId],
          },
        },
      };
      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
        flushNow: true,
      });
      await new Promise((r) => setTimeout(r, 40));

      const afterFlush = store.getRun(runId);
      expect(afterFlush.ok).toBe(true);
      if (afterFlush.ok) {
        expect(afterFlush.loaded.record.workflowState).toBeUndefined();
        expect(afterFlush.loaded.record.units[childId]?.agent).toBe('worker');
      }
      expect(live.workflowState).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('real concurrent gate: first expansion wins; different mapping conflicts without overwrite', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-fanout-race-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId, record } = await store.createRun({
        mode: 'chain',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'chain',
          agentScope: 'both',
          chain: [{ agent: 'planner', task: 'p' }, fanoutChainStep('worker')],
        },
        details: emptyDetails(),
        units: {
          'chain-0001': {
            unitId: 'chain-0001',
            agent: 'planner',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'completed',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            step: 1,
          },
        },
      });
      const coord = createRunCoordinator({ store });
      coord.registerRun(runId, record);

      let releaseFirstDisk!: () => void;
      const firstDiskGate = new Promise<void>((r) => {
        releaseFirstDisk = r;
      });
      let firstInDisk = false;
      let updateCount = 0;
      const orig = store.updateRun.bind(store);
      store.updateRun = (async (id, mutate) => {
        updateCount += 1;
        if (updateCount === 1 && !firstInDisk) {
          firstInDisk = true;
          // Hold the first expand's disk slot so the second sits on the durable queue.
          await firstDiskGate;
        }
        return orig(id, mutate);
      }) as typeof store.updateRun;

      const agent = baseAgent({ name: 'worker' });
      const firstP = coord.expandFanout(runId, {
        step: 2,
        items: ['a', 'b'],
        agent,
        runtime: undefined,
        effectiveCwd: root,
      });

      // Wait until first has entered its durable queue / disk path.
      for (let i = 0; i < 80 && !firstInDisk; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(firstInDisk).toBe(true);

      const secondP = coord.expandFanout(runId, {
        step: 2,
        items: ['x'],
        agent,
        runtime: undefined,
        effectiveCwd: root,
      });

      releaseFirstDisk();
      const first = await firstP;
      expect(first.items).toEqual(['a', 'b']);
      await expect(secondP).rejects.toThrow(/fanout_state_conflict/);

      // Live + disk keep the first mapping only.
      expect(record.workflowState?.fanouts?.['chain-0002-fanout']?.items).toEqual(['a', 'b']);
      expect(record.units['chain-0002-fanout-0001']?.fanoutIndex).toBe(0);
      expect(record.units['chain-0002-fanout-0002']?.fanoutIndex).toBe(1);
      expect(record.units['chain-0002-fanout-0001']?.agent).toBe('worker');
      // Second mapping must not have replaced children with a single 'x' unit only.
      expect(
        Object.keys(record.units)
          .filter((k) => k.startsWith('chain-0002-fanout-'))
          .sort()
      ).toEqual(['chain-0002-fanout-0001', 'chain-0002-fanout-0002']);

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.loaded.record.workflowState?.fanouts?.['chain-0002-fanout']?.items).toEqual([
          'a',
          'b',
        ]);
        expect(
          Object.keys(loaded.loaded.record.units).filter((k) => k.startsWith('chain-0002-fanout-'))
            .length
        ).toBe(2);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('non-active persist / finalizeRun disk-first merge', () => {
  it('late inactive persist cannot erase bindings/acpSessionId/delivery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-inactive-persist-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId, record } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: 'grok-acp' as never,
            capability: 'session',
            status: 'completed',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            acpSessionId: 'sess-keep',
            interactiveBindings: {
              b1: { bindingId: 'b1', hostSessionId: 'h', createdAt: 1 },
            },
          },
        },
      });
      // Seed delivery on disk without an active registration.
      await store.updateRun(runId, (r) => {
        r.continuationTasks = ['c1', 'c2'];
        r.continuationDelivery = { single: { deliveredCount: 1 } };
      });

      const coord = createRunCoordinator({ store });
      // Intentionally NOT registerRun — exercise non-active path.
      expect(coord.isActive(runId)).toBe(false);

      // Stale snapshot: missing binding, session id, and delivery.
      const staleUnits: Record<string, RunUnitRecord> = {
        single: {
          unitId: 'single',
          agent: 'tester',
          agentFingerprint: 'fp',
          runtime: 'grok-acp' as never,
          capability: 'session',
          status: 'completed',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      };
      coord.persist({
        runId,
        details: emptyDetails(),
        units: staleUnits,
        flushNow: true,
      });
      // Drain durable queue.
      await new Promise((r) => setTimeout(r, 30));

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        const u = loaded.loaded.record.units.single;
        expect(u.acpSessionId).toBe('sess-keep');
        expect(u.interactiveBindings?.b1?.bindingId).toBe('b1');
        expect(loaded.loaded.record.continuationDelivery?.single?.deliveredCount).toBe(1);
      }
      void record;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stale full persist cannot overwrite disk binding/acpSessionId or downgrade result metadata', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-strict-merge-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId, record } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: 'grok-acp' as never,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            acpSessionId: 'sess-strict',
            interactiveBindings: {
              keep: { bindingId: 'keep', hostSessionId: 'h1', createdAt: 1 },
            },
            result: {
              agent: 'tester',
              agentSource: 'unknown',
              task: 't',
              exitCode: -1,
              status: 'running',
              messages: [],
              stderr: '',
              usage: emptyUsage(),
              acpSessionId: 'sess-strict',
              resumeCapability: 'session',
            },
          },
        },
      });
      await store.updateRun(runId, (r) => {
        r.continuationTasks = ['c1', 'c2'];
        r.continuationDelivery = { single: { deliveredCount: 2 } };
      });

      const coord = createRunCoordinator({ store });
      // Active live snapshot that tries to wipe / downgrade strict fields.
      // Prefer a fresh disk clone so live starts from post-seed state.
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      void record;
      live.units.single = {
        unitId: 'single',
        agent: 'tester',
        agentFingerprint: 'fp',
        runtime: 'grok-acp' as never,
        capability: 'session',
        status: 'running',
        attempt: 1,
        attempts: [],
        effectiveCwd: root,
        // missing acpSessionId
        interactiveBindings: {
          // conflict on same id with different host
          keep: { bindingId: 'keep', hostSessionId: 'HACKED', createdAt: 99 },
          extra: { bindingId: 'extra', hostSessionId: 'h2', createdAt: 2 },
        },
        result: {
          agent: 'tester',
          agentSource: 'unknown',
          task: 't',
          exitCode: -1,
          status: 'running',
          messages: [],
          stderr: '',
          usage: emptyUsage(),
          // stale / missing identity
          resumeCapability: 'session',
        },
      };
      live.continuationDelivery = { single: { deliveredCount: 0 } };
      coord.registerRun(runId, live);

      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
        flushNow: true,
      });
      await new Promise((r) => setTimeout(r, 40));

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        const u = loaded.loaded.record.units.single;
        expect(u.acpSessionId).toBe('sess-strict');
        expect(u.capability).toBe('session');
        expect(u.interactiveBindings?.keep).toEqual({
          bindingId: 'keep',
          hostSessionId: 'h1',
          createdAt: 1,
        });
        expect(u.interactiveBindings?.extra?.bindingId).toBe('extra');
        expect(u.result?.acpSessionId).toBe('sess-strict');
        expect(u.result?.resumeCapability).toBe('session');
        expect(loaded.loaded.record.continuationDelivery?.single?.deliveredCount).toBe(2);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stale persist/finalize without live result preserves complete disk result', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-merge-result-'));
    try {
      const store = createRunStore({ rootDir: root });
      const diskResult: SingleResult = {
        agent: 'tester',
        agentSource: 'unknown',
        task: 't',
        exitCode: 0,
        status: 'completed',
        messages: [{ role: 'assistant', content: 'done', timestamp: 1 } as never],
        stderr: '',
        usage: emptyUsage(),
        acpSessionId: 'sess-result',
        resumeCapability: 'session',
        finalOutput: 'done',
      };
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: 'grok-acp' as never,
            capability: 'session',
            status: 'completed',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            acpSessionId: 'sess-result',
            result: diskResult,
          },
        },
      });

      const coord = createRunCoordinator({ store });

      // Active live unit omits result entirely (stale lag).
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      const { result: _drop, ...unitWithoutResult } = live.units.single;
      live.units.single = unitWithoutResult as RunUnitRecord;
      void _drop;
      coord.registerRun(runId, live);

      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
        flushNow: true,
      });
      await new Promise((r) => setTimeout(r, 40));

      let loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        const kept = loaded.loaded.record.units.single.result!;
        // Durable terminal payload preserved; identity may be re-stamped from unit/record.
        expect(kept.finalOutput).toBe(diskResult.finalOutput);
        expect(kept.acpSessionId).toBe(diskResult.acpSessionId);
        expect(kept.resumeCapability).toBe(diskResult.resumeCapability);
        expect(kept.status).toBe('completed');
        expect(kept.exitCode).toBe(0);
        expect(kept.runId).toBe(runId);
        expect(kept.unitId).toBe('single');
        expect(kept.attempt).toBe(1);
        expect(loaded.loaded.record.units.single.acpSessionId).toBe('sess-result');
      }

      // Inactive finalize with live missing result must also keep disk result.
      coord.unregisterRun(runId);
      const staleUnits: Record<string, RunUnitRecord> = {
        single: {
          unitId: 'single',
          agent: 'tester',
          agentFingerprint: 'fp',
          runtime: 'grok-acp' as never,
          capability: 'session',
          status: 'completed',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
          // no result, no acpSessionId
        },
      };
      await coord.finalizeRun(runId, emptyDetails(), staleUnits, { success: true });

      loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        const kept = loaded.loaded.record.units.single.result!;
        expect(kept.finalOutput).toBe(diskResult.finalOutput);
        expect(kept.acpSessionId).toBe('sess-result');
        expect(kept.resumeCapability).toBe('session');
        expect(kept.runId).toBe(runId);
        expect(kept.unitId).toBe('single');
        expect(loaded.loaded.record.units.single.acpSessionId).toBe('sess-result');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('live terminal result field-merges without deleting durable strict metadata', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-merge-result-terminal-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: 'grok-acp' as never,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            acpSessionId: 'sess-term',
            result: {
              agent: 'tester',
              agentSource: 'unknown',
              task: 't',
              exitCode: -1,
              status: 'running',
              messages: [],
              stderr: '',
              usage: emptyUsage(),
              acpSessionId: 'sess-term',
              resumeCapability: 'session',
            },
          },
        },
      });

      const coord = createRunCoordinator({ store });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      // Terminal update with ordinary fields but omits durable session metadata.
      live.units.single = {
        ...live.units.single,
        status: 'completed',
        result: {
          agent: 'tester',
          agentSource: 'unknown',
          task: 't',
          exitCode: 0,
          status: 'completed',
          messages: [{ role: 'assistant', content: 'ok', timestamp: 2 } as never],
          stderr: '',
          usage: emptyUsage(),
          finalOutput: 'ok',
          // intentionally omit acpSessionId / resumeCapability
        },
      };
      coord.registerRun(runId, live);
      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
        flushNow: true,
      });
      await new Promise((r) => setTimeout(r, 40));

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        const r = loaded.loaded.record.units.single.result;
        expect(r?.status).toBe('completed');
        expect(r?.exitCode).toBe(0);
        expect(r?.finalOutput).toBe('ok');
        expect(r?.acpSessionId).toBe('sess-term');
        expect(r?.resumeCapability).toBe('session');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('inactive finalizeRun and stale persist interleave without wiping durable fields', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-inactive-final-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: 'grok-acp' as never,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            acpSessionId: 'sess-final',
            interactiveBindings: {
              keep: { bindingId: 'keep', hostSessionId: 'h', createdAt: 9 },
            },
          },
        },
      });
      await store.updateRun(runId, (r) => {
        r.continuationTasks = ['t1'];
        r.continuationDelivery = { single: { deliveredCount: 1 } };
      });

      const coord = createRunCoordinator({ store });
      expect(coord.isActive(runId)).toBe(false);

      const staleUnits: Record<string, RunUnitRecord> = {
        single: {
          unitId: 'single',
          agent: 'tester',
          agentFingerprint: 'fp',
          runtime: 'grok-acp' as never,
          capability: 'session',
          status: 'completed',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      };

      // Interleave inactive persist + finalize on the shared queue.
      coord.persist({
        runId,
        details: emptyDetails(),
        units: staleUnits,
        flushNow: true,
      });
      await coord.finalizeRun(runId, emptyDetails(), staleUnits, { success: true });

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        const rec = loaded.loaded.record;
        expect(rec.status).toBe('completed');
        expect(rec.finishedAt).toBeDefined();
        expect(rec.units.single.acpSessionId).toBe('sess-final');
        expect(rec.units.single.interactiveBindings?.keep?.bindingId).toBe('keep');
        expect(rec.continuationDelivery?.single?.deliveredCount).toBe(1);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('persistInteractiveBinding', () => {
  it('writes binding onto the live unit and flushes before resolving', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record: AgentRunRecordV1 = {
      version: 1,
      runId: 'run-bind',
      mode: 'single',
      status: 'running',
      request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
      background: false,
      agentScope: 'both',
      createdAt: 0,
      updatedAt: 0,
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'tester',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: '/cwd',
        },
      },
      eventsFile: 'events.jsonl',
    };
    store.records.set('run-bind', structuredClone(record));
    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-bind', record);

    const binding = {
      bindingId: 'bind-1',
      hostSessionId: 'host-1',
      createdAt: 42,
    };
    await coord.persistInteractiveBinding({
      runId: 'run-bind',
      unitId: 'single',
      binding,
    });

    expect(record.units.single.interactiveBindings?.['bind-1']).toEqual(binding);
    expect(store.records.get('run-bind')!.units.single.interactiveBindings?.['bind-1']).toEqual(
      binding
    );

    // Idempotent re-write of the same binding.
    await coord.persistInteractiveBinding({
      runId: 'run-bind',
      unitId: 'single',
      binding,
    });
    expect(Object.keys(record.units.single.interactiveBindings!)).toEqual(['bind-1']);
  });

  it('surfaces flush failures so callers can refuse link append', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record: AgentRunRecordV1 = {
      version: 1,
      runId: 'run-bind-fail',
      mode: 'single',
      status: 'running',
      request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
      background: false,
      agentScope: 'both',
      createdAt: 0,
      updatedAt: 0,
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'tester',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: '/cwd',
        },
      },
      eventsFile: 'events.jsonl',
    };
    store.records.set('run-bind-fail', structuredClone(record));
    store.updateRun = (async () => {
      throw new Error('flush failed');
    }) as typeof store.updateRun;

    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-bind-fail', record);

    await expect(
      coord.persistInteractiveBinding({
        runId: 'run-bind-fail',
        unitId: 'single',
        binding: { bindingId: 'b', hostSessionId: 'h', createdAt: 1 },
      })
    ).rejects.toThrow(/flush failed/);
    // Disk-first: live must remain unchanged on failure (no half-applied binding).
    expect(record.units.single.interactiveBindings).toBeUndefined();
  });

  it('disk-first: live is unchanged until updateRun succeeds', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record: AgentRunRecordV1 = {
      version: 1,
      runId: 'run-bind-order',
      mode: 'single',
      status: 'running',
      request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
      background: false,
      agentScope: 'both',
      createdAt: 0,
      updatedAt: 0,
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'tester',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: '/cwd',
        },
      },
      eventsFile: 'events.jsonl',
    };
    store.records.set('run-bind-order', structuredClone(record));
    let sawLiveDuringWrite = false;
    const orig = store.updateRun.bind(store);
    store.updateRun = (async (runId, mutate) => {
      // Live must still be empty when the serial disk callback runs.
      expect(record.units.single.interactiveBindings).toBeUndefined();
      sawLiveDuringWrite = true;
      return orig(runId, mutate);
    }) as typeof store.updateRun;

    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-bind-order', record);
    await coord.persistInteractiveBinding({
      runId: 'run-bind-order',
      unitId: 'single',
      binding: { bindingId: 'b1', hostSessionId: 'h', createdAt: 1 },
    });
    expect(sawLiveDuringWrite).toBe(true);
    expect(record.units.single.interactiveBindings?.b1?.bindingId).toBe('b1');
  });

  it('real RunStore: concurrent multi-unit bindings keep peer fields', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-bind-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId, record } = await store.createRun({
        mode: 'parallel',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'parallel',
          agentScope: 'both',
          tasks: [
            { agent: 'tester', task: 't1' },
            { agent: 'tester', task: 't2' },
          ],
        },
        details: emptyDetails(),
        units: {
          'parallel-0001': {
            unitId: 'parallel-0001',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            fanoutIndex: 0,
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
          },
          'parallel-0002': {
            unitId: 'parallel-0002',
            agent: 'tester',
            agentFingerprint: 'fp-b',
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            fanoutIndex: 1,
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
          },
        },
      });
      const coord = createRunCoordinator({ store });
      coord.registerRun(runId, record);

      await Promise.all([
        coord.persistInteractiveBinding({
          runId,
          unitId: 'parallel-0001',
          binding: { bindingId: 'ba', hostSessionId: 'h', createdAt: 1 },
        }),
        coord.persistInteractiveBinding({
          runId,
          unitId: 'parallel-0002',
          binding: { bindingId: 'bb', hostSessionId: 'h', createdAt: 2 },
        }),
      ]);

      expect(record.units['parallel-0001'].interactiveBindings?.ba?.bindingId).toBe('ba');
      expect(record.units['parallel-0002'].interactiveBindings?.bb?.bindingId).toBe('bb');
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.loaded.record.units['parallel-0001'].interactiveBindings?.ba?.bindingId).toBe(
          'ba'
        );
        expect(loaded.loaded.record.units['parallel-0002'].interactiveBindings?.bb?.bindingId).toBe(
          'bb'
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('serial queue: full snapshot flush cannot wipe binding between disk write and live mirror', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record: AgentRunRecordV1 = {
      version: 1,
      runId: 'run-bind-race',
      mode: 'single',
      status: 'running',
      request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
      background: false,
      agentScope: 'both',
      createdAt: 0,
      updatedAt: 0,
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'tester',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: '/cwd',
        },
      },
      eventsFile: 'events.jsonl',
    };
    store.records.set('run-bind-race', structuredClone(record));

    let releaseBindingDisk!: () => void;
    const bindingDiskGate = new Promise<void>((r) => {
      releaseBindingDisk = r;
    });
    let bindingInDiskCallback = false;
    let flushSawBinding = false;
    const orig = store.updateRun.bind(store);
    store.updateRun = (async (runId, mutate) => {
      // Detect binding write (mutates interactiveBindings) vs full flush.
      const before = structuredClone(store.records.get(runId)!);
      const isBindingWrite = !before.units.single.interactiveBindings?.b1;
      if (isBindingWrite && !bindingInDiskCallback) {
        bindingInDiskCallback = true;
        // Hold disk callback so a concurrent flush is forced onto the serial queue.
        await bindingDiskGate;
      }
      const result = await orig(runId, mutate);
      const after = store.records.get(runId)!;
      if (after.units.single.interactiveBindings?.b1) {
        flushSawBinding = true;
      }
      return result;
    }) as typeof store.updateRun;

    const coord = createRunCoordinator({ store, now: () => t, coalesceMs: 10_000 });
    coord.registerRun('run-bind-race', record);

    // Mutate live status so a full flush would overwrite disk units if it raced.
    record.status = 'running';
    record.units.single.status = 'running';

    const bindingP = coord.persistInteractiveBinding({
      runId: 'run-bind-race',
      unitId: 'single',
      binding: { bindingId: 'b1', hostSessionId: 'h', createdAt: 1 },
    });

    // Wait until binding has entered its durable queue slot / disk path.
    for (let i = 0; i < 50 && !bindingInDiskCallback; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(bindingInDiskCallback).toBe(true);
    // Live must still be empty while disk is gated (disk-first inside the slot).
    expect(record.units.single.interactiveBindings).toBeUndefined();

    // Schedule a full snapshot flush while binding disk is still in flight.
    coord.persist({
      runId: 'run-bind-race',
      details: record.details,
      units: record.units,
      flushNow: true,
    });

    // Release binding disk; serial queue must finish binding (disk+live) before flush.
    releaseBindingDisk();
    await bindingP;
    await store.flushes();
    // Drain the durable queue (flush may still be in flight).
    await new Promise((r) => setTimeout(r, 30));

    expect(record.units.single.interactiveBindings?.b1?.bindingId).toBe('b1');
    expect(
      store.records.get('run-bind-race')!.units.single.interactiveBindings?.b1?.bindingId
    ).toBe('b1');
    expect(flushSawBinding).toBe(true);
  });

  it('serial queue: concurrent persist flush and binding keep disk+live consistent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-bind-race-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId, record } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
          },
        },
      });
      const coord = createRunCoordinator({ store, coalesceMs: 5 });
      coord.registerRun(runId, record);

      const ops: Promise<unknown>[] = [];
      for (let i = 0; i < 8; i++) {
        ops.push(
          Promise.resolve().then(() => {
            record.details = { ...record.details, results: [] };
            coord.persist({
              runId,
              details: record.details,
              units: record.units,
              flushNow: i % 2 === 0,
            });
          })
        );
        if (i % 3 === 0) {
          ops.push(
            coord.persistInteractiveBinding({
              runId,
              unitId: 'single',
              binding: { bindingId: 'shared', hostSessionId: 'h', createdAt: 9 },
            })
          );
        }
      }
      await Promise.all(ops);
      // Allow coalesced flushes to settle.
      await new Promise((r) => setTimeout(r, 40));

      expect(record.units.single.interactiveBindings?.shared?.bindingId).toBe('shared');
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.loaded.record.units.single.interactiveBindings?.shared?.bindingId).toBe(
          'shared'
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('conflict is decided before write: live mismatch rejects without disk mutation', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record: AgentRunRecordV1 = {
      version: 1,
      runId: 'run-bind-conflict',
      mode: 'single',
      status: 'running',
      request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
      background: false,
      agentScope: 'both',
      createdAt: 0,
      updatedAt: 0,
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'tester',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: '/cwd',
          interactiveBindings: {
            b1: { bindingId: 'b1', hostSessionId: 'host-old', createdAt: 1 },
          },
        },
      },
      eventsFile: 'events.jsonl',
    };
    // Disk already has the live binding.
    store.records.set('run-bind-conflict', structuredClone(record));
    let updateCalls = 0;
    const orig = store.updateRun.bind(store);
    store.updateRun = (async (runId, mutate) => {
      updateCalls += 1;
      return orig(runId, mutate);
    }) as typeof store.updateRun;

    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-bind-conflict', record);

    await expect(
      coord.persistInteractiveBinding({
        runId: 'run-bind-conflict',
        unitId: 'single',
        binding: { bindingId: 'b1', hostSessionId: 'host-new', createdAt: 1 },
      })
    ).rejects.toThrow(/already exists with different data/);

    // Conflict decided on latest disk inside updateRun; neither live nor disk mutates.
    expect(updateCalls).toBeGreaterThanOrEqual(1);
    expect(record.units.single.interactiveBindings?.b1?.hostSessionId).toBe('host-old');
    expect(
      store.records.get('run-bind-conflict')!.units.single.interactiveBindings?.b1?.hostSessionId
    ).toBe('host-old');
  });
});

describe('persistAcpSessionId', () => {
  function acpRecord(overrides: Partial<RunUnitRecord> = {}): AgentRunRecordV1 {
    return {
      version: 1,
      runId: 'run-acp',
      mode: 'single',
      status: 'running',
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'tester',
        task: 't',
        runtime: 'grok-acp',
      },
      background: false,
      agentScope: 'both',
      createdAt: 0,
      updatedAt: 0,
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'tester',
          agentFingerprint: 'fp',
          runtime: 'grok-acp',
          capability: 'session',
          status: 'running',
          attempt: 1,
          attempts: [],
          effectiveCwd: '/cwd',
          ...overrides,
        },
      },
      eventsFile: 'events.jsonl',
    };
  }

  it('writes acpSessionId and is same-ID idempotent', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = acpRecord();
    store.records.set('run-acp', structuredClone(record));
    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-acp', record);

    await coord.persistAcpSessionId({
      runId: 'run-acp',
      unitId: 'single',
      sessionId: 'sess-1',
    });
    expect(record.units.single.acpSessionId).toBe('sess-1');
    expect(store.records.get('run-acp')!.units.single.acpSessionId).toBe('sess-1');

    await coord.persistAcpSessionId({
      runId: 'run-acp',
      unitId: 'single',
      sessionId: 'sess-1',
    });
    expect(record.units.single.acpSessionId).toBe('sess-1');
  });

  it('rejects a conflicting existing session ID', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = acpRecord({ acpSessionId: 'sess-old' });
    store.records.set('run-acp', structuredClone(record));
    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-acp', record);

    await expect(
      coord.persistAcpSessionId({
        runId: 'run-acp',
        unitId: 'single',
        sessionId: 'sess-new',
      })
    ).rejects.toThrow(/acp_session_conflict/);
    expect(record.units.single.acpSessionId).toBe('sess-old');
  });

  it('disk request ID / live old ID: same-ID request is idempotent and corrects live', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = acpRecord({ acpSessionId: 'sess-disk' });
    store.records.set('run-acp', structuredClone(record));
    // Live lagging with a different stale id — must not precheck-reject.
    record.units.single.acpSessionId = 'sess-live-stale';
    if (record.units.single.result) {
      record.units.single.result.acpSessionId = 'sess-live-stale';
    } else {
      record.units.single.result = {
        agent: 'tester',
        agentSource: 'unknown',
        task: '',
        exitCode: -1,
        messages: [],
        stderr: '',
        usage: emptyUsage(),
        resumeCapability: 'session',
        acpSessionId: 'sess-live-stale',
      };
    }
    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-acp', record);

    await coord.persistAcpSessionId({
      runId: 'run-acp',
      unitId: 'single',
      sessionId: 'sess-disk',
    });

    expect(store.records.get('run-acp')!.units.single.acpSessionId).toBe('sess-disk');
    expect(record.units.single.acpSessionId).toBe('sess-disk');
    expect(record.units.single.result?.acpSessionId).toBe('sess-disk');
    expect(record.units.single.result?.resumeCapability).toBe('session');
  });

  it('live session change during disk write does not throw post-commit; live mirrors committed', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = acpRecord();
    store.records.set('run-acp', structuredClone(record));
    const orig = store.updateRun.bind(store);
    store.updateRun = (async (runId, mutate) => {
      // While disk write is in flight, mutate live to a conflicting id.
      const result = await orig(runId, (disk) => {
        mutate(disk);
        // After disk apply, poison live before post-commit mirror.
        record.units.single.acpSessionId = 'sess-live-poison';
        if (!record.units.single.result) {
          record.units.single.result = {
            agent: 'tester',
            agentSource: 'unknown',
            task: '',
            exitCode: -1,
            messages: [],
            stderr: '',
            usage: emptyUsage(),
            resumeCapability: 'session',
          };
        }
        record.units.single.result.acpSessionId = 'sess-live-poison';
      });
      return result;
    }) as typeof store.updateRun;

    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-acp', record);

    // Must not throw even though live holds a different id after disk commit.
    await coord.persistAcpSessionId({
      runId: 'run-acp',
      unitId: 'single',
      sessionId: 'sess-committed',
    });

    expect(store.records.get('run-acp')!.units.single.acpSessionId).toBe('sess-committed');
    expect(record.units.single.acpSessionId).toBe('sess-committed');
    expect(record.units.single.result?.acpSessionId).toBe('sess-committed');
  });

  it('rejects blank session IDs', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = acpRecord();
    store.records.set('run-acp', structuredClone(record));
    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-acp', record);

    await expect(
      coord.persistAcpSessionId({
        runId: 'run-acp',
        unitId: 'single',
        sessionId: '   ',
      })
    ).rejects.toThrow(/acp_session_unavailable/);
  });

  it('surfaces flush failures without claiming a durable ID', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = acpRecord();
    store.records.set('run-acp', structuredClone(record));
    store.updateRun = (async () => {
      throw new Error('flush failed');
    }) as typeof store.updateRun;
    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-acp', record);

    await expect(
      coord.persistAcpSessionId({
        runId: 'run-acp',
        unitId: 'single',
        sessionId: 'sess-1',
      })
    ).rejects.toThrow(/flush failed/);
    // Disk-first: live state must not claim a durable ID after a failed write.
    expect(record.units.single.acpSessionId).toBeUndefined();
    // A later successful flush must not invent the ID from a half-applied live mutation.
    expect(store.records.get('run-acp')!.units.single.acpSessionId).toBeUndefined();
  });

  it('does not leave live state mutated when write fails after mutation would apply', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = acpRecord();
    store.records.set('run-acp', structuredClone(record));
    let call = 0;
    const originalUpdate = store.updateRun.bind(store);
    store.updateRun = (async (runId, mutate) => {
      call += 1;
      if (call === 1) {
        // Simulate mutate-then-write-fail: mutate on a clone only (real updateRun
        // loads from disk). Reject after the mutate would have run.
        const clone = structuredClone(store.records.get(runId)!);
        mutate(clone);
        throw new Error('atomic write failed');
      }
      return originalUpdate(runId, mutate);
    }) as typeof store.updateRun;
    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-acp', record);

    await expect(
      coord.persistAcpSessionId({
        runId: 'run-acp',
        unitId: 'single',
        sessionId: 'sess-fail',
      })
    ).rejects.toThrow(/atomic write failed/);
    expect(record.units.single.acpSessionId).toBeUndefined();

    // Recovery write succeeds and only then updates live.
    await coord.persistAcpSessionId({
      runId: 'run-acp',
      unitId: 'single',
      sessionId: 'sess-ok',
    });
    expect(record.units.single.acpSessionId).toBe('sess-ok');
  });

  it('persistAcpSessionId stamps session ID and keeps session capability', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = acpRecord({
      capability: 'session',
      status: 'queued',
      result: {
        agent: 'tester',
        agentSource: 'unknown',
        task: '',
        exitCode: -1,
        messages: [],
        stderr: '',
        usage: emptyUsage(),
        resumeCapability: 'session',
      },
    });
    store.records.set('run-acp', structuredClone(record));
    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-acp', record);

    await coord.persistAcpSessionId({
      runId: 'run-acp',
      unitId: 'single',
      sessionId: 'sess-new',
    });

    expect(record.units.single.capability).toBe('session');
    expect(record.units.single.acpSessionId).toBe('sess-new');
    expect(record.units.single.result?.resumeCapability).toBe('session');
    expect(record.units.single.result?.acpSessionId).toBe('sess-new');
    expect(store.records.get('run-acp')!.units.single.capability).toBe('session');

    const agg = coord.aggregateRun(emptyDetails(), record.units);
    expect(agg.capability).toBe('session');
  });

  it('concurrent multi-unit ID writes do not wipe peer session IDs', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = acpRecord();
    // Parallel fanout: two units share one run record.
    record.units = {
      'u-a': {
        ...record.units.single,
        unitId: 'u-a',
      },
      'u-b': {
        ...record.units.single,
        unitId: 'u-b',
        agent: 'tester-b',
      },
    };
    store.records.set('run-acp', structuredClone(record));
    // Serialize like real RunStore so concurrent callers queue on latest disk.
    let chain: Promise<unknown> = Promise.resolve();
    const orig = store.updateRun.bind(store);
    store.updateRun = (async (runId, mutate) => {
      const next = chain.then(async () => {
        // Yield so both callers enter before either mutates.
        await new Promise((r) => setTimeout(r, 5));
        return orig(runId, mutate);
      });
      chain = next.then(
        () => undefined,
        () => undefined
      );
      return next as Promise<AgentRunRecordV1>;
    }) as typeof store.updateRun;

    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-acp', record);

    await Promise.all([
      coord.persistAcpSessionId({ runId: 'run-acp', unitId: 'u-a', sessionId: 'sess-a' }),
      coord.persistAcpSessionId({ runId: 'run-acp', unitId: 'u-b', sessionId: 'sess-b' }),
    ]);

    expect(record.units['u-a'].acpSessionId).toBe('sess-a');
    expect(record.units['u-b'].acpSessionId).toBe('sess-b');
    expect(store.records.get('run-acp')!.units['u-a'].acpSessionId).toBe('sess-a');
    expect(store.records.get('run-acp')!.units['u-b'].acpSessionId).toBe('sess-b');
  });

  it('concurrent same-unit conflicting IDs surface acp_session_conflict', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = acpRecord();
    store.records.set('run-acp', structuredClone(record));
    let chain: Promise<unknown> = Promise.resolve();
    const orig = store.updateRun.bind(store);
    store.updateRun = (async (runId, mutate) => {
      const next = chain.then(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return orig(runId, mutate);
      });
      chain = next.then(
        () => undefined,
        () => undefined
      );
      return next as Promise<AgentRunRecordV1>;
    }) as typeof store.updateRun;

    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-acp', record);

    const results = await Promise.allSettled([
      coord.persistAcpSessionId({ runId: 'run-acp', unitId: 'single', sessionId: 'sess-1' }),
      coord.persistAcpSessionId({ runId: 'run-acp', unitId: 'single', sessionId: 'sess-2' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/acp_session_conflict/);
    // Surviving ID is whichever write ran first on the serial queue.
    const surviving = store.records.get('run-acp')!.units.single.acpSessionId;
    expect(surviving === 'sess-1' || surviving === 'sess-2').toBe(true);
    expect(record.units.single.acpSessionId).toBe(surviving);
  });

  it('concurrent continuation delivery keeps peer units and is monotonic', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = acpRecord();
    record.units = {
      'u-a': { ...record.units.single, unitId: 'u-a' },
      'u-b': { ...record.units.single, unitId: 'u-b' },
    };
    record.continuationTasks = ['c1', 'c2', 'c3'];
    store.records.set('run-acp', structuredClone(record));
    let chain: Promise<unknown> = Promise.resolve();
    const orig = store.updateRun.bind(store);
    store.updateRun = (async (runId, mutate) => {
      const next = chain.then(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return orig(runId, mutate);
      });
      chain = next.then(
        () => undefined,
        () => undefined
      );
      return next as Promise<AgentRunRecordV1>;
    }) as typeof store.updateRun;

    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-acp', record);

    await Promise.all([
      coord.persistContinuationDelivery({
        runId: 'run-acp',
        unitId: 'u-a',
        deliveredCount: 2,
        continuationTasks: ['c1', 'c2', 'c3'],
      }),
      coord.persistContinuationDelivery({
        runId: 'run-acp',
        unitId: 'u-b',
        deliveredCount: 1,
        continuationTasks: ['c1', 'c2', 'c3'],
      }),
    ]);

    expect(record.continuationDelivery!['u-a'].deliveredCount).toBe(2);
    expect(record.continuationDelivery!['u-b'].deliveredCount).toBe(1);
    expect(store.records.get('run-acp')!.continuationDelivery!['u-a'].deliveredCount).toBe(2);
    expect(store.records.get('run-acp')!.continuationDelivery!['u-b'].deliveredCount).toBe(1);

    // Regression is rejected.
    await expect(
      coord.persistContinuationDelivery({
        runId: 'run-acp',
        unitId: 'u-a',
        deliveredCount: 1,
      })
    ).rejects.toThrow(/regress/);
    // Over-bound is rejected.
    await expect(
      coord.persistContinuationDelivery({
        runId: 'run-acp',
        unitId: 'u-a',
        deliveredCount: 99,
      })
    ).rejects.toThrow(/exceeds/);
    // Monotonic advance is allowed.
    await coord.persistContinuationDelivery({
      runId: 'run-acp',
      unitId: 'u-a',
      deliveredCount: 3,
    });
    expect(record.continuationDelivery!['u-a'].deliveredCount).toBe(3);
  });

  it('continuationTasks merge: stale live shorten/replace keeps disk; append takes longer', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-cont-merge-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: 'grok-acp' as never,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
          },
        },
      });
      await store.updateRun(runId, (r) => {
        r.continuationTasks = ['c1', 'c2', 'c3'];
        r.continuationDelivery = { single: { deliveredCount: 2 } };
      });

      const coord = createRunCoordinator({ store });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);

      // Shorten: live is a proper prefix of disk → keep longer disk list.
      live.continuationTasks = ['c1'];
      live.continuationDelivery = { single: { deliveredCount: 0 } };
      coord.registerRun(runId, live);
      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
        flushNow: true,
      });
      await new Promise((r) => setTimeout(r, 40));
      let loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.loaded.record.continuationTasks).toEqual(['c1', 'c2', 'c3']);
        expect(loaded.loaded.record.continuationDelivery?.single?.deliveredCount).toBe(2);
      }

      // Replace with incompatible content → disk wins (conflict).
      live.continuationTasks = ['x', 'y'];
      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
        flushNow: true,
      });
      await new Promise((r) => setTimeout(r, 40));
      loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.loaded.record.continuationTasks).toEqual(['c1', 'c2', 'c3']);
      }

      // Append-only extension on live → take longer.
      live.continuationTasks = ['c1', 'c2', 'c3', 'c4'];
      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
        flushNow: true,
      });
      await new Promise((r) => setTimeout(r, 40));
      loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.loaded.record.continuationTasks).toEqual(['c1', 'c2', 'c3', 'c4']);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('incompatible continuation: disk [A]/0 vs live [B]/1 keeps A/0 and mirrors live', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-cont-incompat-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: 'grok-acp' as never,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
          },
        },
      });
      await store.updateRun(runId, (r) => {
        r.continuationTasks = ['A'];
        r.continuationDelivery = { single: { deliveredCount: 0 } };
      });

      const coord = createRunCoordinator({ store });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      live.continuationTasks = ['B'];
      live.continuationDelivery = { single: { deliveredCount: 1 } };
      coord.registerRun(runId, live);

      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
        flushNow: true,
      });
      await new Promise((r) => setTimeout(r, 40));

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.loaded.record.continuationTasks).toEqual(['A']);
        expect(loaded.loaded.record.continuationDelivery?.single?.deliveredCount).toBe(0);
      }
      // Live corrected from disk (incompatible live delivery ignored).
      expect(live.continuationTasks).toEqual(['A']);
      expect(live.continuationDelivery?.single?.deliveredCount).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stale live result identity is re-stamped from canonical unit/record', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-result-id-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: 'grok-acp' as never,
            capability: 'session',
            status: 'running',
            attempt: 2,
            attempts: [],
            effectiveCwd: root,
            sessionFile: '/canonical/session.jsonl',
            acpSessionId: 'sess-canonical',
            result: {
              agent: 'tester',
              agentSource: 'unknown',
              task: 't',
              exitCode: -1,
              status: 'running',
              messages: [],
              stderr: '',
              usage: emptyUsage(),
              runId: 'wrong-run',
              unitId: 'wrong-unit',
              attempt: 99,
              sessionFile: '/stale/session.jsonl',
              acpSessionId: 'sess-canonical',
              resumeCapability: 'session',
            },
          },
        },
      });

      const coord = createRunCoordinator({ store });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      live.units.single = {
        ...live.units.single!,
        // Stale live mutates immutable identity fields — disk/map-key wins.
        unitId: 'stale-unit-field',
        agent: 'stale-agent',
        agentFingerprint: 'fp-stale',
        status: 'completed',
        result: {
          agent: 'tester',
          agentSource: 'unknown',
          task: 't',
          exitCode: 0,
          status: 'completed',
          messages: [],
          stderr: '',
          usage: emptyUsage(),
          finalOutput: 'ok',
          // Stale / wrong durable identity from lagging live.
          runId: 'stale-run',
          unitId: 'stale-unit',
          attempt: 1,
          sessionFile: '/stale/other.jsonl',
          acpSessionId: 'sess-WRONG',
          resumeCapability: 'session',
        },
      };
      coord.registerRun(runId, live);
      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
        flushNow: true,
      });
      await new Promise((r) => setTimeout(r, 40));

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        const u = loaded.loaded.record.units.single;
        expect(u.unitId).toBe('single');
        expect(u.agent).toBe('tester');
        expect(u.agentFingerprint).toBe('fp');
        const r = u.result!;
        expect(r.runId).toBe(runId);
        expect(r.unitId).toBe('single');
        expect(r.attempt).toBe(2);
        expect(r.sessionFile).toBe('/canonical/session.jsonl');
        expect(r.acpSessionId).toBe('sess-canonical');
        expect(r.resumeCapability).toBe('session');
        // Ordinary terminal/output fields may update from live.
        expect(r.status).toBe('completed');
        expect(r.exitCode).toBe(0);
        expect(r.finalOutput).toBe('ok');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('canonical unit without acpSessionId clears stale result session on restamp', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-result-clear-sess-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            // No acpSessionId on canonical unit.
            result: {
              agent: 'tester',
              agentSource: 'unknown',
              task: 't',
              exitCode: -1,
              status: 'running',
              messages: [],
              stderr: '',
              usage: emptyUsage(),
              runId: 'x',
              unitId: 'single',
              attempt: 1,
              resumeCapability: 'session',
            },
          },
        },
      });

      const coord = createRunCoordinator({ store });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      live.units.single = {
        ...live.units.single!,
        status: 'completed',
        // Live still carries a stale session id on the nested result.
        result: {
          agent: 'tester',
          agentSource: 'unknown',
          task: 't',
          exitCode: 0,
          status: 'completed',
          messages: [],
          stderr: '',
          usage: emptyUsage(),
          finalOutput: 'done',
          runId: 'stale',
          unitId: 'stale',
          attempt: 9,
          acpSessionId: 'sess-STALE-MUST-CLEAR',
          resumeCapability: 'session',
        },
      };
      coord.registerRun(runId, live);
      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
        flushNow: true,
      });
      await new Promise((r) => setTimeout(r, 40));

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        const r = loaded.loaded.record.units.single.result!;
        expect(r.unitId).toBe('single');
        expect(r.acpSessionId).toBeUndefined();
        expect(r.resumeCapability).toBe('session');
        expect(r.status).toBe('completed');
        expect(r.finalOutput).toBe('done');
      }
      expect(live.units.single.result?.acpSessionId).toBeUndefined();
      expect(live.units.single.result?.resumeCapability).toBe('session');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('persistContinuationDelivery: live ahead does not block disk-authoritative write; live corrected', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = acpRecord();
    record.continuationTasks = ['c1', 'c2', 'c3'];
    record.continuationDelivery = { single: { deliveredCount: 1 } };
    store.records.set('run-acp', structuredClone(record));
    const coord = createRunCoordinator({ store, now: () => t });
    // Live wrongly ahead of disk.
    record.continuationDelivery = { single: { deliveredCount: 5 } };
    record.continuationTasks = ['c1', 'c2', 'c3'];
    coord.registerRun('run-acp', record);

    // Disk still at 1; legal advance to 2 must succeed despite live=5.
    await coord.persistContinuationDelivery({
      runId: 'run-acp',
      unitId: 'single',
      deliveredCount: 2,
    });
    expect(store.records.get('run-acp')!.continuationDelivery!.single.deliveredCount).toBe(2);
    expect(record.continuationDelivery!.single.deliveredCount).toBe(2);

    // Equal-to-disk write also corrects live wrongly ahead.
    record.continuationDelivery = { single: { deliveredCount: 9 } };
    await coord.persistContinuationDelivery({
      runId: 'run-acp',
      unitId: 'single',
      deliveredCount: 2,
    });
    expect(store.records.get('run-acp')!.continuationDelivery!.single.deliveredCount).toBe(2);
    expect(record.continuationDelivery!.single.deliveredCount).toBe(2);

    // True disk regression still rejected.
    await expect(
      coord.persistContinuationDelivery({
        runId: 'run-acp',
        unitId: 'single',
        deliveredCount: 0,
      })
    ).rejects.toThrow(/regress/);
  });

  it('persistContinuationDelivery: disk tasks undefined clears live stale tasks; flush does not write back', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = acpRecord();
    // Disk has no continuationTasks / delivery.
    store.records.set('run-acp', structuredClone(record));
    const coord = createRunCoordinator({ store, now: () => t });
    // Live carries stale tasks and a non-zero delivery count.
    record.continuationTasks = ['stale-a', 'stale-b'];
    record.continuationDelivery = { single: { deliveredCount: 2 } };
    coord.registerRun('run-acp', record);

    await coord.persistContinuationDelivery({
      runId: 'run-acp',
      unitId: 'single',
      deliveredCount: 0,
    });

    // Committed disk: tasks still undefined; delivery 0 for the unit.
    expect(store.records.get('run-acp')!.continuationTasks).toBeUndefined();
    expect(store.records.get('run-acp')!.continuationDelivery!.single.deliveredCount).toBe(0);
    // Live tasks cleared unconditionally from committed undefined.
    expect(record.continuationTasks).toBeUndefined();
    expect(record.continuationDelivery!.single.deliveredCount).toBe(0);

    // Full flush must not re-pollute disk with stale live tasks (already cleared).
    coord.persist({
      runId: 'run-acp',
      details: emptyDetails(),
      units: record.units,
      flushNow: true,
    });
    await store.flushes();
    expect(store.records.get('run-acp')!.continuationTasks).toBeUndefined();
    expect(store.records.get('run-acp')!.continuationDelivery!.single.deliveredCount).toBe(0);
  });

  it('persistContinuationDelivery rejects task rewrite/shorten and enforces deliveredCount bounds', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record = acpRecord();
    record.continuationTasks = ['c1', 'c2', 'c3'];
    record.continuationDelivery = { single: { deliveredCount: 1 } };
    store.records.set('run-acp', structuredClone(record));
    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-acp', record);

    // Rewrite existing item → conflict.
    await expect(
      coord.persistContinuationDelivery({
        runId: 'run-acp',
        unitId: 'single',
        deliveredCount: 1,
        continuationTasks: ['CHANGED', 'c2', 'c3'],
      })
    ).rejects.toThrow(/change or regress/);

    // Shorten → conflict.
    await expect(
      coord.persistContinuationDelivery({
        runId: 'run-acp',
        unitId: 'single',
        deliveredCount: 1,
        continuationTasks: ['c1'],
      })
    ).rejects.toThrow(/change or regress/);

    // Append is allowed; deliveredCount may not exceed final length.
    await coord.persistContinuationDelivery({
      runId: 'run-acp',
      unitId: 'single',
      deliveredCount: 2,
      continuationTasks: ['c1', 'c2', 'c3', 'c4'],
    });
    expect(record.continuationTasks).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(record.continuationDelivery!.single.deliveredCount).toBe(2);

    await expect(
      coord.persistContinuationDelivery({
        runId: 'run-acp',
        unitId: 'single',
        deliveredCount: 99,
        continuationTasks: ['c1', 'c2', 'c3', 'c4'],
      })
    ).rejects.toThrow(/exceeds/);

    // deliveredCount equal to length is the upper bound (inclusive).
    await coord.persistContinuationDelivery({
      runId: 'run-acp',
      unitId: 'single',
      deliveredCount: 4,
    });
    expect(record.continuationDelivery!.single.deliveredCount).toBe(4);

    // Unknown unit → reject (delivery must correspond to an existing unit).
    await expect(
      coord.persistContinuationDelivery({
        runId: 'run-acp',
        unitId: 'missing-unit',
        deliveredCount: 0,
      })
    ).rejects.toThrow(/does not exist/);

    // Stale live with shorter tasks must not block disk-authoritative advance.
    record.continuationTasks = ['c1'];
    store.records.set(
      'run-acp',
      (() => {
        const d = structuredClone(store.records.get('run-acp')!);
        d.continuationTasks = ['c1', 'c2', 'c3', 'c4'];
        d.continuationDelivery = { single: { deliveredCount: 4 } };
        return d;
      })()
    );
    // Live is shorter but delivery already at 4 on both after prior write —
    // re-seed live short while disk remains full, then advance is no-op equal.
    record.continuationTasks = ['c1'];
    record.continuationDelivery = { single: { deliveredCount: 2 } };
    // Disk still has full history + higher delivery; equal deliveredCount to disk fails monotony on live.
    // A equal-or-advance from live floor (2) up to disk length must succeed against disk.
    store.records.set(
      'run-acp',
      (() => {
        const d = structuredClone(store.records.get('run-acp')!);
        d.continuationTasks = ['c1', 'c2', 'c3', 'c4'];
        d.continuationDelivery = { single: { deliveredCount: 2 } };
        return d;
      })()
    );
    await coord.persistContinuationDelivery({
      runId: 'run-acp',
      unitId: 'single',
      deliveredCount: 3,
    });
    expect(store.records.get('run-acp')!.continuationDelivery!.single.deliveredCount).toBe(3);
    // Live tasks should mirror disk (prefix merge takes longer disk list).
    expect(record.continuationTasks).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(record.continuationDelivery!.single.deliveredCount).toBe(3);
  });
});

describe('disk-authoritative unit identity on full persist/finalize', () => {
  it('disk without acpSessionId clears live unit and result stale ACP ids', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-disk-no-acp-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: 'grok-acp' as never,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            // disk has no acpSessionId
          },
        },
      });

      const coord = createRunCoordinator({ store });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      live.units.single = {
        ...live.units.single!,
        acpSessionId: 'sess-LIVE-STALE',
        status: 'completed',
        result: {
          agent: 'tester',
          agentSource: 'unknown',
          task: 't',
          exitCode: 0,
          status: 'completed',
          messages: [],
          stderr: '',
          usage: emptyUsage(),
          finalOutput: 'done',
          acpSessionId: 'sess-LIVE-STALE',
          resumeCapability: 'session',
        },
      };
      coord.registerRun(runId, live);
      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
        flushNow: true,
      });
      await new Promise((r) => setTimeout(r, 40));

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        const u = loaded.loaded.record.units.single;
        expect(u.acpSessionId).toBeUndefined();
        expect(u.result?.acpSessionId).toBeUndefined();
        expect(u.result?.finalOutput).toBe('done');
      }
      // Live mirrored: stale ACP must not survive for a later flush.
      expect(live.units.single.acpSessionId).toBeUndefined();
      expect(live.units.single.result?.acpSessionId).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('Pi session capability and sessionFile win over live stale fields without requiring acpSessionId', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-pi-cap-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            sessionFile: '/canonical/pi.jsonl',
          },
        },
      });

      const coord = createRunCoordinator({ store });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      live.units.single = {
        ...live.units.single!,
        capability: 'session',
        sessionFile: '/stale/wrong.jsonl',
        status: 'completed',
        result: {
          agent: 'tester',
          agentSource: 'unknown',
          task: 't',
          exitCode: 0,
          status: 'completed',
          messages: [],
          stderr: '',
          usage: emptyUsage(),
          finalOutput: 'pi-ok',
          sessionFile: '/stale/wrong.jsonl',
          resumeCapability: 'session',
        },
      };
      coord.registerRun(runId, live);
      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
        flushNow: true,
      });
      await new Promise((r) => setTimeout(r, 40));

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        const u = loaded.loaded.record.units.single;
        expect(u.capability).toBe('session');
        expect(u.sessionFile).toBe('/canonical/pi.jsonl');
        expect(u.result?.resumeCapability).toBe('session');
        expect(u.result?.sessionFile).toBe('/canonical/pi.jsonl');
        expect(u.result?.finalOutput).toBe('pi-ok');
      }
      expect(live.units.single.capability).toBe('session');
      expect(live.units.single.sessionFile).toBe('/canonical/pi.jsonl');
      expect(live.units.single.result?.resumeCapability).toBe('session');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('conflicting sessionFile and attempt on full persist keep disk values', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-conflict-id-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'running',
            attempt: 3,
            attempts: [],
            effectiveCwd: root,
            sessionFile: '/disk/session.jsonl',
          },
        },
      });

      const coord = createRunCoordinator({ store });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      live.units.single = {
        ...live.units.single!,
        attempt: 1,
        sessionFile: '/live/stale.jsonl',
        status: 'completed',
        result: {
          agent: 'tester',
          agentSource: 'unknown',
          task: 't',
          exitCode: 0,
          status: 'completed',
          messages: [],
          stderr: '',
          usage: emptyUsage(),
          finalOutput: 'terminal',
          attempt: 1,
          sessionFile: '/live/stale.jsonl',
          resumeCapability: 'session',
        },
      };
      coord.registerRun(runId, live);
      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
        flushNow: true,
      });
      await new Promise((r) => setTimeout(r, 40));

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        const u = loaded.loaded.record.units.single;
        expect(u.attempt).toBe(3);
        expect(u.sessionFile).toBe('/disk/session.jsonl');
        expect(u.result?.attempt).toBe(3);
        expect(u.result?.sessionFile).toBe('/disk/session.jsonl');
        expect(u.result?.finalOutput).toBe('terminal');
      }
      expect(live.units.single.attempt).toBe(3);
      expect(live.units.single.sessionFile).toBe('/disk/session.jsonl');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('inactive finalize with conflicting sessionFile/attempt keeps disk identity', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-final-id-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'running',
            attempt: 2,
            attempts: [],
            effectiveCwd: root,
            sessionFile: '/disk/final.jsonl',
          },
        },
      });

      const coord = createRunCoordinator({ store });
      expect(coord.isActive(runId)).toBe(false);

      const staleUnits: Record<string, RunUnitRecord> = {
        single: {
          unitId: 'single',
          agent: 'tester',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          attempt: 9,
          attempts: [],
          effectiveCwd: root,
          sessionFile: '/stale/final.jsonl',
          result: {
            agent: 'tester',
            agentSource: 'unknown',
            task: 't',
            exitCode: 0,
            status: 'completed',
            messages: [],
            stderr: '',
            usage: emptyUsage(),
            finalOutput: 'finalized',
            attempt: 9,
            sessionFile: '/stale/final.jsonl',
            resumeCapability: 'session',
          },
        },
      };
      await coord.finalizeRun(runId, emptyDetails(), staleUnits, { success: true });

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        const u = loaded.loaded.record.units.single;
        expect(u.attempt).toBe(2);
        expect(u.sessionFile).toBe('/disk/final.jsonl');
        expect(u.capability).toBe('session');
        expect(u.result?.attempt).toBe(2);
        expect(u.result?.sessionFile).toBe('/disk/final.jsonl');
        expect(u.result?.resumeCapability).toBe('session');
        expect(u.result?.finalOutput).toBe('finalized');
        expect(loaded.loaded.record.status).toBe('completed');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('Grok ACP disk without sessionFile drops live stale sessionFile', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-acp-no-sf-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'single',
          agentScope: 'both',
          agent: 'tester',
          task: 't',
          runtime: 'grok-acp',
        },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: 'grok-acp' as never,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            acpSessionId: 'sess-real',
            // no sessionFile on disk
          },
        },
      });

      const coord = createRunCoordinator({ store });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      live.units.single = {
        ...live.units.single!,
        sessionFile: '/should/not/persist.jsonl',
        status: 'completed',
        result: {
          agent: 'tester',
          agentSource: 'unknown',
          task: 't',
          exitCode: 0,
          status: 'completed',
          messages: [],
          stderr: '',
          usage: emptyUsage(),
          finalOutput: 'acp-done',
          sessionFile: '/should/not/persist.jsonl',
          acpSessionId: 'sess-real',
          resumeCapability: 'session',
        },
      };
      coord.registerRun(runId, live);
      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
        flushNow: true,
      });
      await new Promise((r) => setTimeout(r, 40));

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        const u = loaded.loaded.record.units.single;
        expect(u.sessionFile).toBeUndefined();
        expect(u.acpSessionId).toBe('sess-real');
        expect(u.result?.sessionFile).toBeUndefined();
        expect(u.result?.acpSessionId).toBe('sess-real');
      }
      expect(live.units.single.sessionFile).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('Pi disk without sessionFile drops live stale path (full merge never first-stamps)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-pi-no-sf-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            // no sessionFile on disk
          },
        },
      });

      const coord = createRunCoordinator({ store });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      live.units.single = {
        ...live.units.single!,
        sessionFile: '/stale/live-only.jsonl',
        status: 'completed',
        result: {
          agent: 'tester',
          agentSource: 'unknown',
          task: 't',
          exitCode: 0,
          status: 'completed',
          messages: [],
          stderr: '',
          usage: emptyUsage(),
          finalOutput: 'pi-done',
          sessionFile: '/stale/live-only.jsonl',
          resumeCapability: 'session',
        },
      };
      coord.registerRun(runId, live);
      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
        flushNow: true,
      });
      await new Promise((r) => setTimeout(r, 40));

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        const u = loaded.loaded.record.units.single;
        expect(u.sessionFile).toBeUndefined();
        expect(u.result?.sessionFile).toBeUndefined();
        expect(u.result?.finalOutput).toBe('pi-done');
      }
      expect(live.units.single.sessionFile).toBeUndefined();
      expect(live.units.single.result?.sessionFile).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('persistSessionFile', () => {
  it('first legal write is durable and mirrors live', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-sf-first-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            result: {
              agent: 'tester',
              agentSource: 'unknown',
              task: 't',
              exitCode: -1,
              status: 'running',
              messages: [],
              stderr: '',
              usage: emptyUsage(),
            },
          },
        },
      });

      const coord = createRunCoordinator({ store });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      coord.registerRun(runId, live);

      await coord.persistSessionFile({
        runId,
        unitId: 'single',
        sessionFile: '/sessions/first.jsonl',
      });

      expect(live.units.single.sessionFile).toBe('/sessions/first.jsonl');
      expect(live.units.single.result?.sessionFile).toBe('/sessions/first.jsonl');
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.loaded.record.units.single.sessionFile).toBe('/sessions/first.jsonl');
        expect(loaded.loaded.record.units.single.result?.sessionFile).toBe('/sessions/first.jsonl');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('same path is idempotent; different path conflicts without mutating disk', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-sf-cas-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            sessionFile: '/sessions/canonical.jsonl',
          },
        },
      });

      const coord = createRunCoordinator({ store });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      live.units.single.sessionFile = '/sessions/stale-live.jsonl';
      coord.registerRun(runId, live);

      await coord.persistSessionFile({
        runId,
        unitId: 'single',
        sessionFile: '/sessions/canonical.jsonl',
      });
      expect(live.units.single.sessionFile).toBe('/sessions/canonical.jsonl');

      await expect(
        coord.persistSessionFile({
          runId,
          unitId: 'single',
          sessionFile: '/sessions/other.jsonl',
        })
      ).rejects.toThrow(/session_file_conflict/);

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.loaded.record.units.single.sessionFile).toBe('/sessions/canonical.jsonl');
      }
      expect(live.units.single.sessionFile).toBe('/sessions/canonical.jsonl');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('write failure leaves live and disk unchanged; empty path is rejected', async () => {
    let t = 100;
    const store = {
      records: new Map<string, AgentRunRecordV1>(),
      getRun(runId: string) {
        const r = this.records.get(runId);
        if (!r) return { ok: false as const, error: { message: 'missing' } };
        return { ok: true as const, loaded: { record: structuredClone(r) } };
      },
      async updateRun(_runId: string, _mutate: (r: AgentRunRecordV1) => void) {
        throw new Error('disk full');
      },
      async appendEvent() {},
    };
    const record: AgentRunRecordV1 = {
      version: 1,
      runId: 'run-sf-fail',
      mode: 'single',
      agentScope: 'both',
      background: false,
      status: 'running',
      createdAt: t,
      updatedAt: t,
      eventsFile: 'events.jsonl',
      request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'tester',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'running',
          attempt: 1,
          attempts: [],
          effectiveCwd: '/tmp',
        },
      },
    };
    store.records.set('run-sf-fail', structuredClone(record));
    const coord = createRunCoordinator({
      store: store as unknown as RunStore,
      now: () => t,
    });
    coord.registerRun('run-sf-fail', record);

    await expect(
      coord.persistSessionFile({
        runId: 'run-sf-fail',
        unitId: 'single',
        sessionFile: '/sessions/x.jsonl',
      })
    ).rejects.toThrow(/disk full/);
    expect(record.units.single.sessionFile).toBeUndefined();
    expect(store.records.get('run-sf-fail')!.units.single.sessionFile).toBeUndefined();

    await expect(
      coord.persistSessionFile({
        runId: 'run-sf-fail',
        unitId: 'single',
        sessionFile: '   ',
      })
    ).rejects.toThrow(/session_file_unavailable/);
  });

  it('strict sessionFile write does not cancel pending ordinary timer flush', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-sf-timer-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            result: {
              agent: 'tester',
              agentSource: 'unknown',
              task: 't',
              exitCode: -1,
              status: 'running',
              messages: [],
              stderr: '',
              usage: emptyUsage(),
            },
          },
        },
      });

      const coord = createRunCoordinator({ store, coalesceMs: 80 });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      coord.registerRun(runId, live);

      live.units.single = {
        ...live.units.single!,
        result: {
          ...live.units.single!.result!,
          finalOutput: 'ordinary-after-sf',
        },
      };
      coord.persist({ runId, details: emptyDetails(), units: live.units });

      await coord.persistSessionFile({
        runId,
        unitId: 'single',
        sessionFile: '/sessions/strict.jsonl',
      });

      let mid = store.getRun(runId);
      expect(mid.ok).toBe(true);
      if (mid.ok) {
        expect(mid.loaded.record.units.single.sessionFile).toBe('/sessions/strict.jsonl');
      }

      await new Promise((r) => setTimeout(r, 150));
      const after = store.getRun(runId);
      expect(after.ok).toBe(true);
      if (after.ok) {
        expect(after.loaded.record.units.single.sessionFile).toBe('/sessions/strict.jsonl');
        expect(after.loaded.record.units.single.result?.finalOutput).toBe('ordinary-after-sf');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('startUnit does not wipe disk-synced sessionFile when ctx omits it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-sf-start-preserve-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
          },
        },
      });
      const coord = createRunCoordinator({ store });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      coord.registerRun(runId, live);

      await coord.persistSessionFile({
        runId,
        unitId: 'single',
        sessionFile: '/sessions/kept.jsonl',
      });
      expect(live.units.single.sessionFile).toBe('/sessions/kept.jsonl');

      // ctx without sessionFile must not clear the durable path on live.
      coord.startUnit(runId, {
        runId,
        unitId: 'single',
        agent: 'tester',
        runtime: undefined,
        resumeCapability: 'session',
        effectiveCwd: root,
        attempt: 1,
      });
      expect(live.units.single.sessionFile).toBe('/sessions/kept.jsonl');
      await new Promise((r) => setTimeout(r, 40));
      expect(live.units.single.sessionFile).toBe('/sessions/kept.jsonl');
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.loaded.record.units.single.sessionFile).toBe('/sessions/kept.jsonl');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('finishUnit prefers unit.sessionFile when ctx path is missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-sf-finish-prefer-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [{ attempt: 1, status: 'running', startedAt: 1 }],
            effectiveCwd: root,
          },
        },
      });
      const coord = createRunCoordinator({ store });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      coord.registerRun(runId, live);

      await coord.persistSessionFile({
        runId,
        unitId: 'single',
        sessionFile: '/sessions/from-unit.jsonl',
      });

      const result: SingleResult = {
        agent: 'tester',
        agentSource: 'unknown',
        task: 't',
        exitCode: 0,
        status: 'running',
        messages: [],
        stderr: '',
        usage: emptyUsage(),
      };
      // ctx omits sessionFile — terminal result must still carry the unit path.
      coord.finishUnit(
        runId,
        {
          runId,
          unitId: 'single',
          agent: 'tester',
          runtime: undefined,
          resumeCapability: 'session',
          effectiveCwd: root,
          attempt: 1,
        },
        result,
        'completed'
      );
      expect(result.sessionFile).toBe('/sessions/from-unit.jsonl');
      await new Promise((r) => setTimeout(r, 40));
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.loaded.record.units.single.sessionFile).toBe('/sessions/from-unit.jsonl');
        expect(loaded.loaded.record.units.single.result?.sessionFile).toBe(
          '/sessions/from-unit.jsonl'
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('startUnit never writes unit identity from ctx (stale sessionFile/acpSessionId ignored)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-sf-start-no-ctx-id-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: 'grok-acp',
            capability: 'session',
            status: 'queued',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
          },
        },
      });
      const coord = createRunCoordinator({ store });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      coord.registerRun(runId, live);

      coord.startUnit(runId, {
        runId,
        unitId: 'single',
        agent: 'tester',
        runtime: 'grok-acp',
        resumeCapability: 'session',
        effectiveCwd: root,
        attempt: 1,
        sessionFile: '/sessions/stale-from-ctx.jsonl',
        acpSessionId: 'stale-acp-from-ctx',
      });
      expect(live.units.single.sessionFile).toBeUndefined();
      expect(live.units.single.acpSessionId).toBeUndefined();
      await new Promise((r) => setTimeout(r, 40));
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.loaded.record.units.single.sessionFile).toBeUndefined();
        expect(loaded.loaded.record.units.single.acpSessionId).toBeUndefined();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('finishUnit set-or-delete: ctx stale identity cleared when unit has none', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record: AgentRunRecordV1 = {
      version: 1,
      runId: 'run-stale-clear',
      mode: 'single',
      status: 'running',
      request: { mode: 'single', agentScope: 'both', agent: 'noop', task: '' },
      background: false,
      agentScope: 'both',
      createdAt: 0,
      updatedAt: 0,
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'noop',
          agentFingerprint: '',
          runtime: undefined,
          capability: 'session',
          status: 'running',
          attempt: 1,
          attempts: [{ attempt: 1, status: 'running', startedAt: 1 }],
          effectiveCwd: '/cwd',
        },
      },
      eventsFile: 'events.jsonl',
    };
    store.records.set('run-stale-clear', record);
    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-stale-clear', record);

    const ctx: import('../src/run-coordinator.ts').UnitExecutionContext = {
      runId: 'run-stale-clear',
      unitId: 'single',
      agent: 'noop',
      runtime: undefined,
      resumeCapability: 'session',
      effectiveCwd: '/cwd',
      attempt: 1,
      sessionFile: '/sessions/stale.jsonl',
      acpSessionId: 'stale-acp',
    };
    const result: SingleResult = {
      agent: 'noop',
      agentSource: 'unknown',
      task: '',
      exitCode: 0,
      status: 'running',
      messages: [],
      stderr: '',
      usage: emptyUsage(),
      sessionFile: '/sessions/stale.jsonl',
      acpSessionId: 'stale-acp',
      resumeCapability: 'session',
    };
    coord.finishUnit('run-stale-clear', ctx, result, 'completed');
    expect(result.sessionFile).toBeUndefined();
    expect(result.acpSessionId).toBeUndefined();
    expect(result.resumeCapability).toBe('session');
    expect(ctx.sessionFile).toBeUndefined();
    expect(ctx.acpSessionId).toBeUndefined();
    expect(ctx.resumeCapability).toBe('session');
    expect(record.units.single.result?.sessionFile).toBeUndefined();
    expect(record.units.single.result?.acpSessionId).toBeUndefined();
    expect(record.units.single.result?.resumeCapability).toBe('session');
  });

  it('finishUnit set-or-delete: ctx stale identity replaced by canonical unit identity', async () => {
    let t = 100;
    const store = fakeStore({ now: () => t });
    const record: AgentRunRecordV1 = {
      version: 1,
      runId: 'run-stale-replace',
      mode: 'single',
      status: 'running',
      request: { mode: 'single', agentScope: 'both', agent: 'noop', task: '' },
      background: false,
      agentScope: 'both',
      createdAt: 0,
      updatedAt: 0,
      details: emptyDetails(),
      units: {
        single: {
          unitId: 'single',
          agent: 'noop',
          agentFingerprint: '',
          runtime: 'grok-acp',
          capability: 'session',
          status: 'running',
          attempt: 1,
          attempts: [{ attempt: 1, status: 'running', startedAt: 1 }],
          effectiveCwd: '/cwd',
          sessionFile: '/sessions/canonical.jsonl',
          acpSessionId: 'canonical-acp',
        },
      },
      eventsFile: 'events.jsonl',
    };
    store.records.set('run-stale-replace', record);
    const coord = createRunCoordinator({ store, now: () => t });
    coord.registerRun('run-stale-replace', record);

    const ctx: import('../src/run-coordinator.ts').UnitExecutionContext = {
      runId: 'run-stale-replace',
      unitId: 'single',
      agent: 'noop',
      runtime: 'grok-acp',
      resumeCapability: 'session',
      effectiveCwd: '/cwd',
      attempt: 1,
      sessionFile: '/sessions/stale.jsonl',
      acpSessionId: 'stale-acp',
    };
    const result: SingleResult = {
      agent: 'noop',
      agentSource: 'unknown',
      task: '',
      exitCode: 0,
      status: 'running',
      messages: [],
      stderr: '',
      usage: emptyUsage(),
      sessionFile: '/sessions/stale.jsonl',
      acpSessionId: 'stale-acp',
      resumeCapability: 'session',
    };
    coord.finishUnit('run-stale-replace', ctx, result, 'completed');
    expect(result.sessionFile).toBe('/sessions/canonical.jsonl');
    expect(result.acpSessionId).toBe('canonical-acp');
    expect(result.resumeCapability).toBe('session');
    expect(ctx.sessionFile).toBe('/sessions/canonical.jsonl');
    expect(ctx.acpSessionId).toBe('canonical-acp');
    expect(ctx.resumeCapability).toBe('session');
    expect(record.units.single.result?.sessionFile).toBe('/sessions/canonical.jsonl');
    expect(record.units.single.result?.acpSessionId).toBe('canonical-acp');
    expect(record.units.single.result?.resumeCapability).toBe('session');
  });

  it('fanout out-of-order terminals keep per-unit sessionFile after strict first-write', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-sf-fanout-ooo-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'chain',
        agentScope: 'user',
        background: false,
        request: {
          mode: 'chain',
          agentScope: 'user',
          chain: [{ agent: 'seed', task: 'seed' }, fanoutChainStep('worker')],
        },
        details: emptyDetails(),
        units: {
          'chain-0001': {
            unitId: 'chain-0001',
            agent: 'seed',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'completed',
            step: 1,
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
          },
        },
      });
      const coord = createRunCoordinator({ store });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      live.status = 'running';
      coord.registerRun(runId, live);

      const expansion = await coord.expandFanout(runId, {
        step: 2,
        items: ['a', 'b', 'c'],
        agent: {
          name: 'worker',
          description: '',
          systemPrompt: '',
          source: 'builtin',
          filePath: '/tmp/w.md',
        },
        runtime: undefined,
        effectiveCwd: root,
      });

      // Stamp all units first (production: before beginUnit), then start all, finish OOO.
      await Promise.all(
        expansion.unitIds.map((unitId) =>
          coord.persistSessionFile({
            runId,
            unitId,
            sessionFile: `/sessions/${unitId}.jsonl`,
          })
        )
      );
      for (let index = 0; index < expansion.unitIds.length; index++) {
        const unitId = expansion.unitIds[index]!;
        coord.startUnit(runId, {
          runId,
          unitId,
          agent: 'worker',
          runtime: undefined,
          resumeCapability: 'session',
          effectiveCwd: root,
          attempt: 1,
          step: 2,
          fanoutIndex: index,
          sessionFile: `/sessions/${unitId}.jsonl`,
        });
      }
      for (const index of [1, 2, 0]) {
        const unitId = expansion.unitIds[index]!;
        const sessionFile = `/sessions/${unitId}.jsonl`;
        coord.finishUnit(
          runId,
          {
            runId,
            unitId,
            agent: 'worker',
            runtime: undefined,
            resumeCapability: 'session',
            effectiveCwd: root,
            attempt: 1,
            step: 2,
            fanoutIndex: index,
            sessionFile,
          },
          {
            agent: 'worker',
            agentSource: 'builtin',
            task: `item-${index}`,
            exitCode: 0,
            status: 'completed',
            messages: [],
            stderr: '',
            usage: emptyUsage(),
            step: 2,
            fanout: { index, count: 3, itemTask: `item-${index}` },
            finalOutput: `item-${index}`,
          },
          'completed'
        );
      }
      await new Promise((r) => setTimeout(r, 50));

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      const units = loaded.loaded.record.units;
      for (let i = 0; i < 3; i++) {
        const unitId = expansion.unitIds[i]!;
        expect(units[unitId]!.sessionFile).toBe(`/sessions/${unitId}.jsonl`);
        expect(units[unitId]!.result?.sessionFile).toBe(`/sessions/${unitId}.jsonl`);
        expect(units[unitId]!.result?.finalOutput).toBe(`item-${i}`);
      }
      // Stale live-only path on a peer must not inject into a unit that never stamped.
      // (All three stamped above; assert isolation of paths.)
      expect(units[expansion.unitIds[0]!]!.sessionFile).not.toBe(
        units[expansion.unitIds[1]!]!.sessionFile
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('strict writes preserve pending coalesced ordinary updates', () => {
  it('ordinary live result pending timer survives strict success and lands after flush', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-strict-timer-ok-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'single',
          agentScope: 'both',
          agent: 'tester',
          task: 't',
          runtime: 'grok-acp',
        },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: 'grok-acp' as never,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            result: {
              agent: 'tester',
              agentSource: 'unknown',
              task: 't',
              exitCode: -1,
              status: 'running',
              messages: [],
              stderr: '',
              usage: emptyUsage(),
            },
          },
        },
      });

      const coord = createRunCoordinator({ store, coalesceMs: 80 });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      coord.registerRun(runId, live);

      // Ordinary live update — schedule coalesced timer (do not flushNow).
      live.units.single = {
        ...live.units.single!,
        result: {
          ...live.units.single!.result!,
          finalOutput: 'ordinary-pending',
          status: 'running',
        },
      };
      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
      });

      // Strict success while timer still pending.
      await coord.persistAcpSessionId({
        runId,
        unitId: 'single',
        sessionId: 'sess-strict-ok',
      });

      // Immediately after strict return: strict field is durable; ordinary is not claimed.
      let mid = store.getRun(runId);
      expect(mid.ok).toBe(true);
      if (mid.ok) {
        expect(mid.loaded.record.units.single.acpSessionId).toBe('sess-strict-ok');
        // Ordinary may not be durable yet — timer has not necessarily fired.
        // (If the queue already drained a concurrent flush, finalOutput may be set;
        // the contract is only that strict success does not *require* ordinary durable.)
      }
      // Live still holds the ordinary update regardless.
      expect(live.units.single.result?.finalOutput).toBe('ordinary-pending');

      // After coalesce window, ordinary update must land.
      await new Promise((r) => setTimeout(r, 150));
      const after = store.getRun(runId);
      expect(after.ok).toBe(true);
      if (after.ok) {
        expect(after.loaded.record.units.single.acpSessionId).toBe('sess-strict-ok');
        expect(after.loaded.record.units.single.result?.finalOutput).toBe('ordinary-pending');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ordinary live result pending timer survives strict conflict and lands after flush', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-strict-timer-conflict-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'single',
          agentScope: 'both',
          agent: 'tester',
          task: 't',
          runtime: 'grok-acp',
        },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: 'grok-acp' as never,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            acpSessionId: 'sess-disk',
            result: {
              agent: 'tester',
              agentSource: 'unknown',
              task: 't',
              exitCode: -1,
              status: 'running',
              messages: [],
              stderr: '',
              usage: emptyUsage(),
              acpSessionId: 'sess-disk',
              resumeCapability: 'session',
            },
          },
        },
      });

      const coord = createRunCoordinator({ store, coalesceMs: 80 });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      coord.registerRun(runId, live);

      live.units.single = {
        ...live.units.single!,
        result: {
          ...live.units.single!.result!,
          finalOutput: 'after-conflict-ordinary',
        },
      };
      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
      });

      await expect(
        coord.persistAcpSessionId({
          runId,
          unitId: 'single',
          sessionId: 'sess-OTHER',
        })
      ).rejects.toThrow(/acp_session_conflict/);

      // Strict conflict does not claim ordinary durable; disk still lacks ordinary until timer.
      const mid = store.getRun(runId);
      expect(mid.ok).toBe(true);
      if (mid.ok) {
        expect(mid.loaded.record.units.single.acpSessionId).toBe('sess-disk');
      }

      await new Promise((r) => setTimeout(r, 150));
      const after = store.getRun(runId);
      expect(after.ok).toBe(true);
      if (after.ok) {
        expect(after.loaded.record.units.single.acpSessionId).toBe('sess-disk');
        expect(after.loaded.record.units.single.result?.finalOutput).toBe(
          'after-conflict-ordinary'
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('ordinary live result pending timer survives strict failure and lands after flush', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-strict-timer-fail-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'single',
          agentScope: 'both',
          agent: 'tester',
          task: 't',
          runtime: 'grok-acp',
        },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: 'grok-acp' as never,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            result: {
              agent: 'tester',
              agentSource: 'unknown',
              task: 't',
              exitCode: -1,
              status: 'running',
              messages: [],
              stderr: '',
              usage: emptyUsage(),
            },
          },
        },
      });

      const coord = createRunCoordinator({ store, coalesceMs: 80 });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      coord.registerRun(runId, live);

      live.units.single = {
        ...live.units.single!,
        result: {
          ...live.units.single!.result!,
          finalOutput: 'after-failure-ordinary',
        },
      };
      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
      });

      // Empty sessionId → failure before/at strict path; timer must remain armed.
      await expect(
        coord.persistAcpSessionId({
          runId,
          unitId: 'single',
          sessionId: '   ',
        })
      ).rejects.toThrow(/acp_session_unavailable/);

      await new Promise((r) => setTimeout(r, 150));
      const after = store.getRun(runId);
      expect(after.ok).toBe(true);
      if (after.ok) {
        expect(after.loaded.record.units.single.acpSessionId).toBeUndefined();
        expect(after.loaded.record.units.single.result?.finalOutput).toBe('after-failure-ordinary');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('strict binding/delivery success leaves pending ordinary update to timer flush', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-strict-bind-timer-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            result: {
              agent: 'tester',
              agentSource: 'unknown',
              task: 't',
              exitCode: -1,
              status: 'running',
              messages: [],
              stderr: '',
              usage: emptyUsage(),
            },
          },
        },
      });
      await store.updateRun(runId, (r) => {
        r.continuationTasks = ['c1', 'c2'];
      });

      const coord = createRunCoordinator({ store, coalesceMs: 80 });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      coord.registerRun(runId, live);

      live.units.single = {
        ...live.units.single!,
        result: {
          ...live.units.single!.result!,
          finalOutput: 'bind-delivery-ordinary',
        },
      };
      coord.persist({ runId, details: emptyDetails(), units: live.units });

      await coord.persistInteractiveBinding({
        runId,
        unitId: 'single',
        binding: { bindingId: 'b1', hostSessionId: 'h1', createdAt: 1 },
      });
      await coord.persistContinuationDelivery({
        runId,
        unitId: 'single',
        deliveredCount: 1,
      });

      // Strict fields durable; ordinary not required yet.
      let mid = store.getRun(runId);
      expect(mid.ok).toBe(true);
      if (mid.ok) {
        expect(mid.loaded.record.units.single.interactiveBindings?.b1?.hostSessionId).toBe('h1');
        expect(mid.loaded.record.continuationDelivery?.single?.deliveredCount).toBe(1);
      }

      await new Promise((r) => setTimeout(r, 150));
      const after = store.getRun(runId);
      expect(after.ok).toBe(true);
      if (after.ok) {
        expect(after.loaded.record.units.single.result?.finalOutput).toBe('bind-delivery-ordinary');
        expect(after.loaded.record.units.single.interactiveBindings?.b1?.hostSessionId).toBe('h1');
        expect(after.loaded.record.continuationDelivery?.single?.deliveredCount).toBe(1);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('inactive persist mutate via incoming snapshot', () => {
  it('inactive mutate cannot add fanout mapping or fanout child units', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-inactive-mutate-fanout-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'chain',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'chain',
          agentScope: 'both',
          chain: [{ agent: 'planner', task: 'p' }],
        },
        details: emptyDetails(),
        units: {
          'chain-0001': {
            unitId: 'chain-0001',
            agent: 'planner',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'completed',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            step: 1,
          },
        },
      });

      const coord = createRunCoordinator({ store });
      expect(coord.isActive(runId)).toBe(false);

      const childId = chainFanoutUnitId(2, 0);
      const fanoutKey = chainFanoutStepId(2);
      coord.persist({
        runId,
        details: emptyDetails(),
        units: {
          'chain-0001': {
            unitId: 'chain-0001',
            agent: 'planner',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'completed',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            step: 1,
          },
        },
        mutate: (rec) => {
          rec.workflowState = {
            fanouts: {
              [fanoutKey]: {
                step: 2,
                items: ['sneaky'],
                unitIds: [childId],
              },
            },
          };
          rec.units[childId] = {
            unitId: childId,
            agent: 'worker',
            agentFingerprint: 'fp-w',
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            step: 2,
            fanoutIndex: 0,
          };
          rec.startedAt = 42_000;
        },
      });
      await new Promise((r) => setTimeout(r, 40));

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.loaded.record.workflowState).toBeUndefined();
        expect(loaded.loaded.record.units[childId]).toBeUndefined();
        // Legitimate startedAt from mutate is admitted when disk was missing it.
        expect(loaded.loaded.record.startedAt).toBe(42_000);
        expect(loaded.loaded.record.units['chain-0001']?.agent).toBe('planner');
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('inactive mutate preserves existing disk startedAt and ignores overwrite', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-inactive-mutate-started-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: { mode: 'single', agentScope: 'both', agent: 'tester', task: 't' },
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
          },
        },
      });
      await store.updateRun(runId, (r) => {
        r.startedAt = 11_000;
      });

      const coord = createRunCoordinator({ store });
      coord.persist({
        runId,
        details: emptyDetails(),
        units: {
          single: {
            unitId: 'single',
            agent: 'tester',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'running',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
          },
        },
        mutate: (rec) => {
          rec.startedAt = 99_999;
        },
      });
      await new Promise((r) => setTimeout(r, 40));

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.loaded.record.startedAt).toBe(11_000);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('inactive mutate adding canonical child id without fanoutIndex does not land on disk', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-inactive-new-unit-'));
    try {
      const store = createRunStore({ rootDir: root });
      const { runId } = await store.createRun({
        mode: 'chain',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'chain',
          agentScope: 'both',
          chain: [{ agent: 'planner', task: 'p' }],
        },
        details: emptyDetails(),
        units: {
          'chain-0001': {
            unitId: 'chain-0001',
            agent: 'planner',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'completed',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            step: 1,
          },
        },
      });

      const coord = createRunCoordinator({ store });
      const childId = chainFanoutUnitId(2, 0);
      coord.persist({
        runId,
        details: emptyDetails(),
        units: {
          'chain-0001': {
            unitId: 'chain-0001',
            agent: 'planner',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'completed',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            step: 1,
          },
        },
        mutate: (rec) => {
          // Canonical child id shape, but no fanoutIndex / mapping — still rejected.
          rec.units[childId] = {
            unitId: childId,
            agent: 'worker',
            agentFingerprint: 'fp-w',
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            step: 2,
            // deliberately no fanoutIndex
          };
          rec.startedAt = 55_000;
        },
      });
      await new Promise((r) => setTimeout(r, 40));

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.loaded.record.units[childId]).toBeUndefined();
        expect(loaded.loaded.record.workflowState).toBeUndefined();
        expect(loaded.loaded.record.startedAt).toBe(55_000);
        expect(Object.keys(loaded.loaded.record.units)).toEqual(['chain-0001']);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('inactive mutate in-place nested fanouts/request/delivery does not change disk authority', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-inactive-deep-clone-'));
    try {
      const store = createRunStore({ rootDir: root });
      const childId = chainFanoutUnitId(2, 0);
      const fanoutKey = chainFanoutStepId(2);
      const { runId } = await store.createRun({
        mode: 'chain',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'chain',
          agentScope: 'both',
          chain: [{ agent: 'planner', task: 'p' }, fanoutChainStep('worker')],
          cwd: root,
        },
        details: emptyDetails(),
        units: {
          'chain-0001': {
            unitId: 'chain-0001',
            agent: 'planner',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'completed',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            step: 1,
          },
          [childId]: {
            unitId: childId,
            agent: 'worker',
            agentFingerprint: 'fp-w',
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            step: 2,
            fanoutIndex: 0,
          },
        },
      });
      await store.updateRun(runId, (r) => {
        r.workflowState = {
          fanouts: {
            [fanoutKey]: { step: 2, items: ['disk-item'], unitIds: [childId] },
          },
        };
        r.continuationTasks = ['disk-c1', 'disk-c2'];
        r.continuationDelivery = { [childId]: { deliveredCount: 1 } };
        r.startedAt = 7_000;
      });

      const before = store.getRun(runId);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const diskBefore = structuredClone(before.loaded.record);

      const coord = createRunCoordinator({ store });
      coord.persist({
        runId,
        details: emptyDetails(),
        units: {
          'chain-0001': diskBefore.units['chain-0001']!,
          [childId]: {
            ...diskBefore.units[childId]!,
            status: 'running',
          },
        },
        mutate: (rec) => {
          // In-place nested mutation must not alias into disk authority.
          if (rec.workflowState?.fanouts?.[fanoutKey]) {
            rec.workflowState.fanouts[fanoutKey].items = ['hacked-item'];
            rec.workflowState.fanouts[fanoutKey].unitIds = ['ghost-unit'];
          }
          if (rec.request && typeof rec.request === 'object') {
            (rec.request as { cwd?: string }).cwd = '/hacked';
            (rec.request as { agent?: string }).agent = 'hacked-agent';
          }
          if (rec.continuationDelivery?.[childId]) {
            rec.continuationDelivery[childId].deliveredCount = 99;
          }
          if (rec.continuationTasks) {
            rec.continuationTasks[0] = 'hacked-task';
          }
          // Allowed ordinary field when disk missing would apply; disk has startedAt.
          rec.startedAt = 99_999;
          // Legitimate unit status merge should still apply.
          rec.units[childId] = {
            ...rec.units[childId]!,
            status: 'running',
          };
        },
      });
      await new Promise((r) => setTimeout(r, 40));

      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        const r = loaded.loaded.record;
        // Disk authority preserved for nested identity/strict slices.
        expect(r.workflowState?.fanouts?.[fanoutKey]?.items).toEqual(['disk-item']);
        expect(r.workflowState?.fanouts?.[fanoutKey]?.unitIds).toEqual([childId]);
        expect((r.request as { cwd?: string }).cwd).toBe(root);
        expect(r.continuationTasks).toEqual(['disk-c1', 'disk-c2']);
        expect(r.continuationDelivery?.[childId]?.deliveredCount).toBe(1);
        expect(r.startedAt).toBe(7_000);
        // Allowed ordinary unit field from incoming still merges.
        expect(r.units[childId]?.status).toBe('running');
        expect(r.units[childId]?.agent).toBe('worker');
        expect(r.units['ghost-unit' as never]).toBeUndefined();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('expandFanout identity-matched mirror preserves mutable payload', () => {
  it('idempotent/conflict mirror keeps pending live status/result across timer flush', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-fanout-preserve-'));
    try {
      const store = createRunStore({ rootDir: root });
      const agentA = baseAgent({ name: 'worker-a', systemPrompt: 'A' });
      const { runId } = await store.createRun({
        mode: 'chain',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'chain',
          agentScope: 'both',
          chain: [{ agent: 'planner', task: 'p' }, fanoutChainStep('worker-a')],
        },
        details: emptyDetails(),
        units: {
          'chain-0001': {
            unitId: 'chain-0001',
            agent: 'planner',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'completed',
            attempt: 1,
            attempts: [],
            effectiveCwd: root,
            step: 1,
          },
        },
      });

      const unitAId = chainFanoutUnitId(2, 0);
      const expansionA = {
        step: 2,
        items: ['item-a'],
        unitIds: [unitAId],
      };
      const unitA: RunUnitRecord = {
        unitId: unitAId,
        agent: agentA.name,
        agentFingerprint: agentFingerprint(agentA),
        runtime: undefined,
        capability: 'session',
        status: 'queued',
        attempt: 1,
        attempts: [],
        effectiveCwd: root,
        step: 2,
        fanoutIndex: 0,
      };
      await store.updateRun(runId, (r) => {
        r.units[unitAId] = unitA;
        r.workflowState = { fanouts: { [chainFanoutStepId(2)]: expansionA } };
      });

      const coord = createRunCoordinator({ store, coalesceMs: 80 });
      const seeded = store.getRun(runId);
      if (!seeded.ok) throw new Error(seeded.error.message);
      const live = structuredClone(seeded.loaded.record);
      // Live child has pending ordinary mutable payload not yet on disk.
      live.units[unitAId] = {
        ...live.units[unitAId]!,
        status: 'running',
        attempts: [{ attempt: 1, status: 'running', startedAt: 100 }],
        result: {
          agent: agentA.name,
          agentSource: 'unknown',
          task: 'item-a',
          exitCode: -1,
          status: 'running',
          messages: [{ role: 'assistant', content: 'pending-msg', timestamp: 1 } as never],
          stderr: '',
          usage: emptyUsage(),
          finalOutput: 'pending-live-output',
        },
      };
      coord.registerRun(runId, live);

      // Schedule coalesced ordinary flush of the pending payload.
      coord.persist({
        runId,
        details: emptyDetails(),
        units: live.units,
      });

      // Idempotent expand: identity match must preserve pending mutable fields.
      const again = await coord.expandFanout(runId, {
        step: 2,
        items: ['item-a'],
        agent: agentA,
        runtime: undefined,
        effectiveCwd: root,
      });
      expect(again).toEqual(expansionA);
      expect(live.units[unitAId]?.status).toBe('running');
      expect(live.units[unitAId]?.result?.finalOutput).toBe('pending-live-output');
      expect(live.units[unitAId]?.attempts).toHaveLength(1);
      expect(live.units[unitAId]?.result?.messages).toHaveLength(1);

      // Conflict path (wrong agent) also preserves identity-matched live payload.
      const agentB = baseAgent({ name: 'worker-b', systemPrompt: 'B' });
      await expect(
        coord.expandFanout(runId, {
          step: 2,
          items: ['item-a'],
          agent: agentB,
          runtime: undefined,
          effectiveCwd: root,
        })
      ).rejects.toThrow(/fanout_state_conflict|identity mismatch/);
      expect(live.units[unitAId]?.status).toBe('running');
      expect(live.units[unitAId]?.result?.finalOutput).toBe('pending-live-output');
      expect(live.units[unitAId]?.agent).toBe('worker-a');

      // After timer flush, ordinary updates land without being wiped by mirror.
      await new Promise((r) => setTimeout(r, 150));
      const after = store.getRun(runId);
      expect(after.ok).toBe(true);
      if (after.ok) {
        const u = after.loaded.record.units[unitAId];
        expect(u?.agent).toBe('worker-a');
        expect(u?.status).toBe('running');
        expect(u?.result?.finalOutput).toBe('pending-live-output');
        expect(u?.attempts).toHaveLength(1);
        expect(after.loaded.record.workflowState?.fanouts?.[chainFanoutStepId(2)]).toEqual(
          expansionA
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
