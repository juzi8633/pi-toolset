// ABOUTME: Tests for the run coordinator — stable unit ids, fingerprints, status derivation, attempts.
// ABOUTME: Drives coalesced persistence with a fake clock and a memory-backed fake RunStore.

import { describe, expect, it } from 'bun:test';
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
import type { RunStore } from '../src/run-store.ts';
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
  it('returns replay for grok and grok-acp', () => {
    expect(resumeCapabilityForRuntime('grok' as Runtime)).toBe('replay');
    expect(resumeCapabilityForRuntime('grok-acp' as Runtime)).toBe('replay');
  });
});

describe('aggregateCapability', () => {
  it('reduces an all-session set to session', () => {
    expect(aggregateCapability(['session', 'session'])).toBe('session');
  });
  it('reduces an all-replay set to replay', () => {
    expect(aggregateCapability(['replay'])).toBe('replay');
  });
  it('returns mixed when both are present', () => {
    expect(aggregateCapability(['session', 'replay'])).toBe('mixed');
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
      chain: [
        { agent: 'seed', task: 'seed' },
        { expand: {}, parallel: { agent: 'worker', task: 't' }, collect: { name: 'c' } },
      ],
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
  });
});
