// ABOUTME: Tests for the durable run store — paths, modes, atomic writes, events, listing, locks.
// ABOUTME: All tests inject a temporary root so the real home directory is never touched.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createRunStore,
  getDefaultRunsRoot,
  type CreateRunStoreOptions,
} from '../src/run-store.ts';
import { RUN_RECORD_VERSION } from '../src/run-types.ts';
import type { AgentRunRecordV1, RunUnitRecord } from '../src/run-types.ts';

const HOME_BEFORE = process.env.HOME;

function tmpRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'pi-agents-runstore-'));
}

let root: string;
let seq = 0;
function makeDeps(): Pick<CreateRunStoreOptions, 'now' | 'randomUUID' | 'pid' | 'instanceId'> {
  let t = 1_000_000;
  const base = seq++;
  return {
    now: () => t++,
    randomUUID: () => `uuid-${base}-${t}`,
    pid: 4242,
    instanceId: `inst-${base}`,
  };
}

function emptyDetails() {
  return {
    mode: 'single' as const,
    agentScope: 'both' as const,
    projectAgentsDir: null,
    builtinAgentsDir: '/builtin',
    results: [],
  };
}

function singleUnit(): Record<string, RunUnitRecord> {
  return {
    single: {
      unitId: 'single',
      agent: 'noop',
      agentFingerprint: 'fp',
      runtime: undefined,
      capability: 'session',
      status: 'queued',
      attempt: 1,
      attempts: [],
      effectiveCwd: '/tmp',
    },
  };
}

function makeCreateInput() {
  return {
    mode: 'single' as const,
    agentScope: 'both' as const,
    background: false,
    request: {
      mode: 'single' as const,
      agentScope: 'both' as const,
      agent: 'noop',
      task: 'do work',
    },
    details: emptyDetails(),
    units: singleUnit(),
  };
}

beforeEach(() => {
  root = tmpRoot();
  process.env.HOME = root;
});
afterEach(() => {
  if (HOME_BEFORE !== undefined) process.env.HOME = HOME_BEFORE;
  else delete process.env.HOME;
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe('getDefaultRunsRoot', () => {
  it('resolves the exact global segments under ~/.pi/agent/@balaenis/pi-agents/runs', () => {
    const expected = path.join(root, '.pi', 'agent', '@balaenis', 'pi-agents', 'runs');
    expect(getDefaultRunsRoot()).toBe(expected);
  });
});

describe('createRunStore directory and file modes', () => {
  it('creates the root with mode 0700 on POSIX systems', () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    expect(existsSync(store.rootDir)).toBe(true);
    if (process.platform !== 'win32') {
      const mode = statSync(store.rootDir).mode & 0o777;
      expect(mode).toBe(0o700);
    }
  });

  it('writes run.json with mode 0600 on POSIX systems', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const runJson = path.join(store.rootDir, runId, 'run.json');
    if (process.platform !== 'win32') {
      const mode = statSync(runJson).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('creates claims and sessions subdirectories with mode 0700', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    if (process.platform !== 'win32') {
      expect(statSync(path.join(store.rootDir, runId, 'claims')).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(store.rootDir, runId, 'sessions')).mode & 0o777).toBe(0o700);
    }
  });
});

describe('createRun and getRun', () => {
  it('creates a queued v1 record with a run- prefix id and emits run_created', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId, record } = await store.createRun(makeCreateInput());
    expect(runId).toMatch(/^run-/);
    expect(record.version).toBe(RUN_RECORD_VERSION);
    expect(record.status).toBe('queued');
    expect(record.units).toHaveProperty('single');

    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.loaded.record.runId).toBe(runId);
      expect(loaded.loaded.record.version).toBe(1);
    }

    const events = readFileSync(path.join(store.rootDir, runId, 'events.jsonl'), 'utf-8')
      .trim()
      .split('\n');
    expect(events.length).toBe(1);
    expect(JSON.parse(events[0]!).event).toBe('run_created');
  });

  it('returns run_not_found for unknown or invalid ids', () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const missing = store.getRun('run-does-not-exist');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('run_not_found');

    const invalid = store.getRun('../escape');
    expect(invalid.ok).toBe(false);
  });
});

describe('updateRun atomic snapshots', () => {
  it('persists mutated fields and updates updatedAt', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId, record } = await store.createRun(makeCreateInput());
    const before = record.updatedAt;
    const updated = await store.updateRun(runId, (r) => {
      r.status = 'running';
    });
    expect(updated.status).toBe('running');
    expect(updated.updatedAt).toBeGreaterThan(before);
    const reloaded = store.getRun(runId);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.loaded.record.status).toBe('running');
  });

  it('serializes overlapping writes so newer snapshots win', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    // Fire many concurrent updates; final read must be consistent.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.updateRun(runId, (r) => {
          r.lastError = `e${i}`;
        })
      )
    );
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.loaded.record.lastError).toMatch(/^e\d+$/);
      expect(loaded.loaded.record.lastError).toBeDefined();
    }
  });
});

describe('appendEvent', () => {
  it('appends lifecycle events in order', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    await store.appendEvent(runId, {
      version: 1,
      event: 'run_claimed',
      runId,
      timestamp: 5,
      claimId: 'c1',
      ticket: 1,
    });
    await store.appendEvent(runId, {
      version: 1,
      event: 'run_terminal',
      runId,
      timestamp: 6,
      status: 'completed',
    });
    const events = readFileSync(path.join(store.rootDir, runId, 'events.jsonl'), 'utf-8')
      .trim()
      .split('\n');
    expect(events.length).toBe(3);
    expect(JSON.parse(events[1]!).event).toBe('run_claimed');
    expect(JSON.parse(events[2]!).event).toBe('run_terminal');
  });
});

describe('listRuns', () => {
  it('lists runs sorted by updatedAt descending', async () => {
    const storeA = createRunStore({ rootDir: root, ...makeDeps() });
    const a = await storeA.createRun(makeCreateInput());

    const storeB = createRunStore({ rootDir: root, ...makeDeps() });
    const b = await storeB.createRun(makeCreateInput());
    await storeB.updateRun(b.runId, (r) => {
      r.status = 'running';
    });

    const list = await storeA.listRuns();
    expect(list.length).toBe(2);
    if ('record' in list[0]!) {
      expect(list[0].record.runId).toBe(b.runId);
      if ('record' in list[1]!) expect(list[1].record.runId).toBe(a.runId);
    }
  });

  it('returns corrupt_run diagnostics for malformed JSON without hiding valid runs', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    await store.createRun(makeCreateInput());
    // Corrupt another directory by writing invalid JSON.
    const corruptDir = path.join(root, 'run-corrupt');
    const sub = path.join(corruptDir);
    await Bun.write(path.join(sub, 'run.json') as unknown as string, '{ not json').catch(() => {});
    const fs = await import('node:fs');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'run.json'), '{ not json');
    const list = await store.listRuns();
    const corrupt = list.find((r) => !('record' in r));
    expect(corrupt).toBeDefined();
    if (corrupt && !('record' in corrupt)) expect(corrupt.code).toBe('corrupt_run');
    const valid = list.filter((r) => 'record' in r);
    expect(valid.length).toBe(1);
  });

  it('returns corrupt_run for unsupported versions', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const file = path.join(root, runId, 'run.json');
    const record: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));
    writeFileSync(file, JSON.stringify({ ...record, version: 999 }));
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe('corrupt_run');
  });

  it('accepts valid presentation and rejects malformed truncation state', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const file = path.join(root, runId, 'run.json');
    const record: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));
    const unitId = Object.keys(record.units)[0]!;
    const validResult = {
      agent: 'noop',
      agentSource: 'unknown',
      task: 't',
      exitCode: 0,
      status: 'completed',
      messages: [],
      stderr: '',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      finalOutput: 'done',
      presentation: {
        transcript: [{ type: 'toolCall', name: 'read', args: { path: 'a.ts' } }],
        truncated: true,
        omittedItems: 2,
      },
    };
    record.units[unitId] = { ...record.units[unitId]!, result: validResult as never };
    record.details = {
      ...record.details,
      results: [validResult as never],
    };
    writeFileSync(file, JSON.stringify(record));
    const ok = store.getRun(runId);
    expect(ok.ok).toBe(true);

    const bad = structuredClone(record);
    (
      bad.units[unitId]!.result as unknown as { presentation: Record<string, unknown> }
    ).presentation = {
      transcript: [],
      truncated: true,
      // omittedItems missing
    };
    writeFileSync(file, JSON.stringify(bad));
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe('corrupt_run');
      expect(loaded.error.message).toContain('omittedItems');
    }
  });

  it('still accepts legacy results with messages and no presentation', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const file = path.join(root, runId, 'run.json');
    const record: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));
    const unitId = Object.keys(record.units)[0]!;
    const legacy = {
      agent: 'noop',
      agentSource: 'unknown',
      task: 't',
      exitCode: 0,
      status: 'completed',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'legacy final' }],
        },
      ],
      stderr: '',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 1,
      },
    };
    record.units[unitId] = { ...record.units[unitId]!, result: legacy as never };
    record.details = { ...record.details, results: [legacy as never] };
    writeFileSync(file, JSON.stringify(record));
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
  });

  it('returns corrupt_run for primitive, array, null messages, and non-array messages results', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const file = path.join(root, runId, 'run.json');
    const base: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));
    const unitId = Object.keys(base.units)[0]!;

    const cases: Array<{ label: string; unitResult: unknown; detailsResult?: unknown }> = [
      { label: 'unit result primitive', unitResult: 'nope' },
      { label: 'unit result array', unitResult: [] },
      { label: 'unit result messages null', unitResult: { messages: null, status: 'completed' } },
      {
        label: 'unit result messages object',
        unitResult: { messages: { role: 'assistant' }, status: 'completed' },
      },
      {
        label: 'details.results primitive shell',
        unitResult: undefined,
        detailsResult: 42,
      },
      {
        label: 'details.results messages null',
        unitResult: undefined,
        detailsResult: { agent: 'noop', messages: null },
      },
    ];

    for (const c of cases) {
      const record = structuredClone(base);
      if (c.unitResult !== undefined) {
        record.units[unitId] = { ...record.units[unitId]!, result: c.unitResult as never };
      }
      if (c.detailsResult !== undefined) {
        record.details = { ...record.details, results: [c.detailsResult as never] };
      } else if (c.unitResult !== undefined) {
        // Keep details empty so only unit path is exercised when unit is set.
        record.details = { ...record.details, results: [] };
      }
      writeFileSync(file, JSON.stringify(record));
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) {
        expect(loaded.error.code).toBe('corrupt_run');
        if (c.detailsResult !== undefined) {
          expect(loaded.error.message).toContain('details.results[0]');
        } else {
          expect(loaded.error.message).toContain(`unit ${unitId} result`);
        }
      }
    }
  });

  it('returns corrupt_run for wrong details/results container shapes with precise paths', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const file = path.join(root, runId, 'run.json');
    const base: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));

    const cases: Array<{ label: string; mutate: (r: AgentRunRecordV1) => void; message: string }> =
      [
        {
          label: 'details primitive',
          mutate: (r) => {
            (r as { details: unknown }).details = 'nope';
          },
          message: 'invalid details',
        },
        {
          label: 'details null',
          mutate: (r) => {
            (r as { details: unknown }).details = null;
          },
          message: 'invalid details',
        },
        {
          label: 'details array',
          mutate: (r) => {
            (r as { details: unknown }).details = [];
          },
          message: 'invalid details',
        },
        {
          label: 'details.results primitive',
          mutate: (r) => {
            (r.details as { results: unknown }).results = 'nope';
          },
          message: 'details.results must be an array',
        },
        {
          label: 'details.results object',
          mutate: (r) => {
            (r.details as { results: unknown }).results = { agent: 'noop' };
          },
          message: 'details.results must be an array',
        },
        {
          label: 'details.results null',
          mutate: (r) => {
            (r.details as { results: unknown }).results = null;
          },
          message: 'details.results must be an array',
        },
        {
          label: 'details.results absent',
          mutate: (r) => {
            delete (r.details as { results?: unknown }).results;
          },
          message: 'details.results must be an array',
        },
      ];

    for (const c of cases) {
      const record = structuredClone(base);
      c.mutate(record);
      writeFileSync(file, JSON.stringify(record));
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) {
        expect(loaded.error.code).toBe('corrupt_run');
        expect(loaded.error.message).toBe(c.message);
      }
    }

    // Valid legacy record with empty results array still loads.
    writeFileSync(file, JSON.stringify(base));
    const ok = store.getRun(runId);
    expect(ok.ok).toBe(true);
  });

  it('returns corrupt_run for invalid unit status/attempt/attempts/cwd/fingerprint without throwing', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const file = path.join(root, runId, 'run.json');
    const base: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));
    const unitId = Object.keys(base.units)[0]!;

    const cases: Array<{ label: string; mutate: (r: AgentRunRecordV1) => void; message: string }> =
      [
        {
          label: 'bad status',
          mutate: (r) => {
            (r.units[unitId] as { status: unknown }).status = 'not-a-status';
          },
          message: `unit ${unitId} has unsupported status`,
        },
        {
          label: 'negative attempt',
          mutate: (r) => {
            (r.units[unitId] as { attempt: unknown }).attempt = -1;
          },
          message: `unit ${unitId} attempt must be a non-negative integer`,
        },
        {
          label: 'non-integer attempt',
          mutate: (r) => {
            (r.units[unitId] as { attempt: unknown }).attempt = 1.5;
          },
          message: `unit ${unitId} attempt must be a non-negative integer`,
        },
        {
          label: 'attempts null',
          mutate: (r) => {
            (r.units[unitId] as { attempts: unknown }).attempts = null;
          },
          message: `unit ${unitId} attempts must be an array`,
        },
        {
          label: 'malformed attempt record',
          mutate: (r) => {
            (r.units[unitId] as { attempts: unknown }).attempts = [
              { attempt: 1, status: 'running' },
            ];
          },
          message: `unit ${unitId} attempts[0].startedAt must be a number`,
        },
        {
          label: 'bad attempt status',
          mutate: (r) => {
            (r.units[unitId] as { attempts: unknown }).attempts = [
              { attempt: 1, status: 'weird', startedAt: 1 },
            ];
          },
          message: `unit ${unitId} attempts[0] has unsupported status`,
        },
        {
          label: 'bad effectiveCwd type',
          mutate: (r) => {
            (r.units[unitId] as { effectiveCwd: unknown }).effectiveCwd = 42;
          },
          message: `unit ${unitId} effectiveCwd must be a non-empty string`,
        },
        {
          label: 'empty effectiveCwd',
          mutate: (r) => {
            (r.units[unitId] as { effectiveCwd: unknown }).effectiveCwd = '';
          },
          message: `unit ${unitId} effectiveCwd must be a non-empty string`,
        },
        {
          label: 'missing effectiveCwd',
          mutate: (r) => {
            delete (r.units[unitId] as { effectiveCwd?: unknown }).effectiveCwd;
          },
          message: `unit ${unitId} effectiveCwd must be a non-empty string`,
        },
        {
          label: 'bad sessionPromptEstablished type',
          mutate: (r) => {
            (r.units[unitId] as { sessionPromptEstablished: unknown }).sessionPromptEstablished =
              'false';
          },
          message: `unit ${unitId} sessionPromptEstablished must be a boolean when present`,
        },
        {
          label: 'bad agentFingerprint type',
          mutate: (r) => {
            (r.units[unitId] as { agentFingerprint: unknown }).agentFingerprint = {
              hash: 'x',
            };
          },
          message: `unit ${unitId} agentFingerprint must be a string when present`,
        },
      ];

    for (const c of cases) {
      const record = structuredClone(base);
      c.mutate(record);
      writeFileSync(file, JSON.stringify(record));
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) {
        expect(loaded.error.code).toBe('corrupt_run');
        expect(loaded.error.message).toContain(c.message);
      }
    }

    // Valid legacy V1 unit core fields (including attempt history) still load.
    const legacy = structuredClone(base);
    legacy.units[unitId] = {
      ...legacy.units[unitId]!,
      status: 'interrupted',
      attempt: 2,
      attempts: [
        {
          attempt: 1,
          status: 'failed',
          startedAt: 1_000,
          finishedAt: 1_100,
          stopReason: 'error',
          errorMessage: 'boom',
        },
      ],
      effectiveCwd: '/legacy/cwd',
      agentFingerprint: 'legacy-fp',
      sessionPromptEstablished: false,
    };
    writeFileSync(file, JSON.stringify(legacy));
    const okLegacy = store.getRun(runId);
    expect(okLegacy.ok).toBe(true);
    if (okLegacy.ok) {
      const unit = okLegacy.loaded.record.units[unitId]!;
      expect(unit.status).toBe('interrupted');
      expect(unit.attempt).toBe(2);
      expect(unit.attempts).toHaveLength(1);
      expect(unit.effectiveCwd).toBe('/legacy/cwd');
      expect(unit.agentFingerprint).toBe('legacy-fp');
      expect(unit.sessionPromptEstablished).toBe(false);
    }

    // Absent sessionPromptEstablished remains valid (legacy established-by-sessionFile).
    const absentFlag = structuredClone(base);
    delete absentFlag.units[unitId]!.sessionPromptEstablished;
    writeFileSync(file, JSON.stringify(absentFlag));
    expect(store.getRun(runId).ok).toBe(true);
  });

  it('returns corrupt_run for malformed details.chain/outputs and accepts valid legacy chain', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const file = path.join(root, runId, 'run.json');
    const base: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));

    const cases: Array<{ label: string; mutate: (r: AgentRunRecordV1) => void; message: string }> =
      [
        {
          label: 'outputs null',
          mutate: (r) => {
            (r.details as { outputs: unknown }).outputs = null;
          },
          message: 'details.outputs must be a non-null object',
        },
        {
          label: 'outputs array',
          mutate: (r) => {
            (r.details as { outputs: unknown }).outputs = [];
          },
          message: 'details.outputs must be a non-null object',
        },
        {
          label: 'outputs entry null',
          mutate: (r) => {
            (r.details as { outputs: unknown }).outputs = { prev: null };
          },
          message: 'details.outputs[prev] must be a non-null object',
        },
        {
          label: 'outputs entry primitive',
          mutate: (r) => {
            (r.details as { outputs: unknown }).outputs = { prev: 'text only' };
          },
          message: 'details.outputs[prev] must be a non-null object',
        },
        {
          label: 'outputs entry missing text',
          mutate: (r) => {
            (r.details as { outputs: unknown }).outputs = {
              prev: { agent: 'noop', step: 1 },
            };
          },
          message: 'details.outputs[prev].text must be a string',
        },
        {
          label: 'outputs entry bad step',
          mutate: (r) => {
            (r.details as { outputs: unknown }).outputs = {
              prev: { text: 'ok', agent: 'noop', step: 0 },
            };
          },
          message: 'details.outputs[prev].step must be a positive integer',
        },
        {
          label: 'chain null',
          mutate: (r) => {
            (r.details as { chain: unknown }).chain = null;
          },
          message: 'details.chain must be a non-null object',
        },
        {
          label: 'chain steps not array',
          mutate: (r) => {
            (r.details as { chain: unknown }).chain = { totalSteps: 1, steps: { step: 1 } };
          },
          message: 'details.chain.steps must be an array',
        },
        {
          label: 'chain step missing kind',
          mutate: (r) => {
            (r.details as { chain: unknown }).chain = {
              totalSteps: 1,
              steps: [{ step: 1, agent: 'noop', task: 't', status: 'queued' }],
            };
          },
          message: 'details.chain.steps[0].kind must be sequential or fanout',
        },
        {
          label: 'fanout step missing counts',
          mutate: (r) => {
            (r.details as { chain: unknown }).chain = {
              totalSteps: 1,
              steps: [
                {
                  kind: 'fanout',
                  step: 1,
                  agent: 'noop',
                  taskTemplate: '{item}',
                  status: 'running',
                  collectName: 'items',
                },
              ],
            };
          },
          message: 'details.chain.steps[0].executedCount must be a non-negative integer',
        },
      ];

    for (const c of cases) {
      const record = structuredClone(base);
      c.mutate(record);
      writeFileSync(file, JSON.stringify(record));
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) {
        expect(loaded.error.code).toBe('corrupt_run');
        expect(loaded.error.message).toContain(c.message);
      }
    }

    // Valid legacy chain presentation + outputs still load.
    const legacyChain = structuredClone(base);
    legacyChain.details = {
      ...legacyChain.details,
      mode: 'chain',
      results: [],
      outputs: {
        step1: {
          text: 'hello',
          structured: { ok: true },
          agent: 'noop',
          step: 1,
        },
      },
      chain: {
        totalSteps: 2,
        steps: [
          {
            kind: 'sequential',
            step: 1,
            agent: 'noop',
            task: 'first',
            status: 'completed',
          },
          {
            kind: 'fanout',
            step: 2,
            agent: 'noop',
            taskTemplate: 'item {item}',
            status: 'queued',
            collectName: 'items',
            executedCount: 0,
            completedCount: 0,
            failedCount: 0,
            runningCount: 0,
            queuedCount: 0,
            skippedCount: 0,
          },
        ],
      },
    };
    writeFileSync(file, JSON.stringify(legacyChain));
    const okChain = store.getRun(runId);
    expect(okChain.ok).toBe(true);
    if (okChain.ok) {
      expect(okChain.loaded.record.details.chain?.totalSteps).toBe(2);
      expect(okChain.loaded.record.details.outputs?.step1?.text).toBe('hello');
    }

    // Absent chain/outputs remain valid (presentation optional).
    const noChain = structuredClone(base);
    delete (noChain.details as { chain?: unknown }).chain;
    delete (noChain.details as { outputs?: unknown }).outputs;
    writeFileSync(file, JSON.stringify(noChain));
    expect(store.getRun(runId).ok).toBe(true);
  });

  it('loads Version 1 records when continuationTasks is absent', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.continuationTasks).toBeUndefined();
  });

  it('round-trips a string array for continuationTasks', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    await store.updateRun(runId, (r) => {
      r.continuationTasks = ['First follow-up', 'Second follow-up'];
    });
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.continuationTasks).toEqual(['First follow-up', 'Second follow-up']);
  });

  it('returns corrupt_run when continuationTasks is not an array', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const file = path.join(root, runId, 'run.json');
    const record: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));
    writeFileSync(file, JSON.stringify({ ...record, continuationTasks: 'not-an-array' }));
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe('corrupt_run');
      expect(loaded.error.message).toContain('continuationTasks');
    }
  });

  it('returns corrupt_run when continuationTasks contains a non-string entry', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const file = path.join(root, runId, 'run.json');
    const record: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));
    writeFileSync(file, JSON.stringify({ ...record, continuationTasks: ['ok', 42] }));
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe('corrupt_run');
      expect(loaded.error.message).toContain('continuationTasks[1]');
    }
  });

  it('round-trips continuationDelivery and rejects malformed entries', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    await store.updateRun(runId, (r) => {
      r.continuationTasks = ['a', 'b'];
      r.continuationDelivery = { single: { deliveredCount: 1 } };
    });
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.continuationDelivery).toEqual({
      single: { deliveredCount: 1 },
    });

    const file = path.join(root, runId, 'run.json');
    const record: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        continuationDelivery: { single: { deliveredCount: -1 } },
      })
    );
    const bad = store.getRun(runId);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe('corrupt_run');
      expect(bad.error.message).toContain('continuationDelivery');
    }

    // Orphan delivery key (no matching unit) is corrupt.
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        continuationDelivery: { 'missing-unit': { deliveredCount: 0 } },
      })
    );
    const orphan = store.getRun(runId);
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) {
      expect(orphan.error.code).toBe('corrupt_run');
      expect(orphan.error.message).toContain('no matching unit');
    }
  });

  it('returns corrupt_run for untrimmed or blank acpSessionId', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const file = path.join(root, runId, 'run.json');
    const record: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));
    const unitId = Object.keys(record.units)[0]!;

    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        units: {
          ...record.units,
          [unitId]: { ...record.units[unitId], acpSessionId: '  padded  ' },
        },
      })
    );
    const padded = store.getRun(runId);
    expect(padded.ok).toBe(false);
    if (!padded.ok) {
      expect(padded.error.code).toBe('corrupt_run');
      expect(padded.error.message).toContain('acpSessionId');
    }

    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        units: {
          ...record.units,
          [unitId]: { ...record.units[unitId], acpSessionId: '   ' },
        },
      })
    );
    const blank = store.getRun(runId);
    expect(blank.ok).toBe(false);
    if (!blank.ok) {
      expect(blank.error.code).toBe('corrupt_run');
      expect(blank.error.message).toContain('acpSessionId');
    }

    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        units: {
          ...record.units,
          [unitId]: { ...record.units[unitId], acpSessionId: 'sess-ok' },
        },
      })
    );
    const ok = store.getRun(runId);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.loaded.record.units[unitId]!.acpSessionId).toBe('sess-ok');
  });

  it('returns corrupt_run for removed plain grok and unknown request/unit runtimes', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const file = path.join(root, runId, 'run.json');
    const record: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));
    const unitId = Object.keys(record.units)[0]!;

    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        request: { ...record.request, runtime: 'grok' },
      })
    );
    const removedRequest = store.getRun(runId);
    expect(removedRequest.ok).toBe(false);
    if (!removedRequest.ok) {
      expect(removedRequest.error.code).toBe('corrupt_run');
      expect(removedRequest.error.message).toContain('request.runtime');
      expect(removedRequest.error.message).toContain('grok');
    }

    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        units: {
          ...record.units,
          [unitId]: { ...record.units[unitId], runtime: 'grok' },
        },
      })
    );
    const removedUnit = store.getRun(runId);
    expect(removedUnit.ok).toBe(false);
    if (!removedUnit.ok) {
      expect(removedUnit.error.code).toBe('corrupt_run');
      expect(removedUnit.error.message).toContain(`unit ${unitId}`);
      expect(removedUnit.error.message).toContain('unsupported runtime');
      expect(removedUnit.error.message).toContain('grok');
    }

    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        request: { ...record.request, runtime: 'unknown-runtime' },
      })
    );
    const unknownRequest = store.getRun(runId);
    expect(unknownRequest.ok).toBe(false);
    if (!unknownRequest.ok) {
      expect(unknownRequest.error.code).toBe('corrupt_run');
      expect(unknownRequest.error.message).toContain('request.runtime');
      expect(unknownRequest.error.message).toContain('unknown-runtime');
    }

    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        units: {
          ...record.units,
          [unitId]: { ...record.units[unitId], runtime: 'claude' },
        },
      })
    );
    const unknownUnit = store.getRun(runId);
    expect(unknownUnit.ok).toBe(false);
    if (!unknownUnit.ok) {
      expect(unknownUnit.error.code).toBe('corrupt_run');
      expect(unknownUnit.error.message).toContain(`unit ${unitId}`);
      expect(unknownUnit.error.message).toContain('claude');
    }

    // Absent and allowed matching runtimes remain valid.
    writeFileSync(file, JSON.stringify(record));
    expect(store.getRun(runId).ok).toBe(true);

    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        request: { ...record.request, runtime: 'pi' },
        units: {
          ...record.units,
          [unitId]: { ...record.units[unitId], runtime: 'pi' },
        },
      })
    );
    expect(store.getRun(runId).ok).toBe(true);

    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        // Absent request.runtime allows per-agent unit runtimes.
        units: {
          ...record.units,
          [unitId]: { ...record.units[unitId], runtime: 'grok-acp' },
        },
      })
    );
    expect(store.getRun(runId).ok).toBe(true);
  });

  it('returns corrupt_run for missing, replay, or unknown unit capabilities', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const file = path.join(root, runId, 'run.json');
    const record: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));
    const unitId = Object.keys(record.units)[0]!;
    const baseUnit = record.units[unitId]!;

    const { capability: _drop, ...withoutCapability } = baseUnit;
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        units: { ...record.units, [unitId]: withoutCapability },
      })
    );
    const missing = store.getRun(runId);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe('corrupt_run');
      expect(missing.error.message).toContain(`unit ${unitId}`);
      expect(missing.error.message).toContain('missing capability');
    }

    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        units: {
          ...record.units,
          [unitId]: { ...baseUnit, capability: 'replay' },
        },
      })
    );
    const replay = store.getRun(runId);
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.error.code).toBe('corrupt_run');
      expect(replay.error.message).toContain(`unit ${unitId}`);
      expect(replay.error.message).toContain('unsupported capability');
      expect(replay.error.message).toContain('replay');
    }

    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        units: {
          ...record.units,
          [unitId]: { ...baseUnit, capability: 'mixed' },
        },
      })
    );
    const unknown = store.getRun(runId);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe('corrupt_run');
      expect(unknown.error.message).toContain('mixed');
    }

    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        units: {
          ...record.units,
          [unitId]: {
            ...baseUnit,
            capability: 'session',
            result: {
              agent: 'noop',
              agentSource: 'unknown',
              task: 't',
              exitCode: 0,
              status: 'completed',
              messages: [],
              stderr: '',
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                contextTokens: 0,
                turns: 0,
              },
              resumeCapability: 'replay',
            },
          },
        },
      })
    );
    const resultCap = store.getRun(runId);
    expect(resultCap.ok).toBe(false);
    if (!resultCap.ok) {
      expect(resultCap.error.code).toBe('corrupt_run');
      expect(resultCap.error.message).toContain('result.resumeCapability');
      expect(resultCap.error.message).toContain('replay');
    }

    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        details: {
          ...record.details,
          run: {
            runId,
            status: 'completed',
            resumable: true,
            capability: 'replay',
          },
        },
      })
    );
    const runMeta = store.getRun(runId);
    expect(runMeta.ok).toBe(false);
    if (!runMeta.ok) {
      expect(runMeta.error.code).toBe('corrupt_run');
      expect(runMeta.error.message).toContain('details.run.capability');
    }

    // Session-only metadata remains valid.
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        details: {
          ...record.details,
          run: {
            runId,
            status: 'interrupted',
            resumable: true,
            capability: 'session',
          },
        },
        units: {
          ...record.units,
          [unitId]: {
            ...baseUnit,
            capability: 'session',
            result: {
              agent: 'noop',
              agentSource: 'unknown',
              task: 't',
              exitCode: 0,
              status: 'completed',
              messages: [],
              stderr: '',
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                contextTokens: 0,
                turns: 0,
              },
              resumeCapability: 'session',
            },
          },
        },
      })
    );
    expect(store.getRun(runId).ok).toBe(true);
  });

  it('returns corrupt_run when presentation results advertise unsupported resumeCapability', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const file = path.join(root, runId, 'run.json');
    const record: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));
    const unitId = Object.keys(record.units)[0]!;
    // Canonical session units stay valid; only presentation metadata is poisoned.
    const sessionUnits = {
      ...record.units,
      [unitId]: {
        ...record.units[unitId],
        capability: 'session' as const,
      },
    };
    const basePresentationResult = {
      agent: 'noop',
      agentSource: 'unknown',
      task: 't',
      exitCode: 0,
      status: 'completed' as const,
      messages: [],
      stderr: '',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
    };

    for (const bad of ['replay', 'mixed', 'unknown', 42] as const) {
      writeFileSync(
        file,
        JSON.stringify({
          ...record,
          units: sessionUnits,
          details: {
            ...record.details,
            results: [{ ...basePresentationResult, resumeCapability: bad }],
          },
        })
      );
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) {
        expect(loaded.error.code).toBe('corrupt_run');
        expect(loaded.error.message).toContain('details.results[0].resumeCapability');
        expect(loaded.error.message).toContain(String(bad));
      }
    }

    // Absent presentation resumeCapability remains allowed.
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        units: sessionUnits,
        details: {
          ...record.details,
          results: [basePresentationResult],
        },
      })
    );
    expect(store.getRun(runId).ok).toBe(true);

    // Explicit session presentation capability remains valid.
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        units: sessionUnits,
        details: {
          ...record.details,
          results: [{ ...basePresentationResult, resumeCapability: 'session' }],
        },
      })
    );
    expect(store.getRun(runId).ok).toBe(true);
  });

  it('returns corrupt_run when explicit request.runtime conflicts with unit effective runtime', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const file = path.join(root, runId, 'run.json');
    const record: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));
    const unitId = Object.keys(record.units)[0]!;

    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        request: { ...record.request, runtime: 'pi' },
        units: {
          ...record.units,
          [unitId]: { ...record.units[unitId], runtime: 'grok-acp' },
        },
      })
    );
    const conflict = store.getRun(runId);
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.error.code).toBe('corrupt_run');
      expect(conflict.error.message).toContain(`unit ${unitId}`);
      expect(conflict.error.message).toContain('conflicts with request.runtime');
      expect(conflict.error.message).toContain('grok-acp');
      expect(conflict.error.message).toContain('pi');
    }

    // Explicit request.runtime=grok-acp vs absent unit (effective pi) conflicts.
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        request: { ...record.request, runtime: 'grok-acp' },
        units: {
          ...record.units,
          [unitId]: { ...record.units[unitId], runtime: undefined },
        },
      })
    );
    const absentUnit = store.getRun(runId);
    expect(absentUnit.ok).toBe(false);
    if (!absentUnit.ok) {
      expect(absentUnit.error.code).toBe('corrupt_run');
      expect(absentUnit.error.message).toContain('conflicts with request.runtime');
    }

    // Matching explicit runtimes are accepted.
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        request: { ...record.request, runtime: 'grok-acp' },
        units: {
          ...record.units,
          [unitId]: { ...record.units[unitId], runtime: 'grok-acp' },
        },
      })
    );
    expect(store.getRun(runId).ok).toBe(true);

    // Explicit pi + absent unit (effective pi) is accepted.
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        request: { ...record.request, runtime: 'pi' },
        units: {
          ...record.units,
          [unitId]: { ...record.units[unitId], runtime: undefined },
        },
      })
    );
    expect(store.getRun(runId).ok).toBe(true);
  });

  it('returns corrupt_run for request mode/topology mismatches without throwing', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const file = path.join(root, runId, 'run.json');
    const record: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));

    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        mode: 'parallel',
        request: { mode: 'single', agentScope: 'user', agent: 'a', task: 't' },
      })
    );
    const mismatch = store.getRun(runId);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.error.code).toBe('corrupt_run');
      expect(mismatch.error.message).toContain('request.mode');
    }

    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        mode: 'chain',
        request: { mode: 'chain', agentScope: 'user', chain: 'not-array' },
      })
    );
    const badChain = store.getRun(runId);
    expect(badChain.ok).toBe(false);
    if (!badChain.ok) {
      expect(badChain.error.code).toBe('corrupt_run');
      expect(badChain.error.message).toContain('chain');
    }
  });

  it('returns corrupt_run when unit.agent does not match request topology', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const file = path.join(root, runId, 'run.json');
    const record: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));

    // Single mode: unit agent must match request.agent.
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        units: {
          single: { ...record.units.single, agent: 'other-agent' },
        },
      })
    );
    const singleMismatch = store.getRun(runId);
    expect(singleMismatch.ok).toBe(false);
    if (!singleMismatch.ok) {
      expect(singleMismatch.error.code).toBe('corrupt_run');
      expect(singleMismatch.error.message).toContain('does not match request topology agent');
      expect(singleMismatch.error.message).toContain('other-agent');
      expect(singleMismatch.error.message).toContain('noop');
    }

    // Parallel mode: each task unit agent must match request.tasks[i].agent.
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        mode: 'parallel',
        request: {
          mode: 'parallel',
          agentScope: 'both',
          tasks: [
            { agent: 'alpha', task: 't1' },
            { agent: 'beta', task: 't2' },
          ],
        },
        units: {
          'parallel-0001': {
            unitId: 'parallel-0001',
            agent: 'alpha',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            fanoutIndex: 0,
            attempt: 1,
            attempts: [],
            effectiveCwd: '/tmp',
          },
          'parallel-0002': {
            unitId: 'parallel-0002',
            agent: 'wrong',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            fanoutIndex: 1,
            attempt: 1,
            attempts: [],
            effectiveCwd: '/tmp',
          },
        },
      })
    );
    const parallelMismatch = store.getRun(runId);
    expect(parallelMismatch.ok).toBe(false);
    if (!parallelMismatch.ok) {
      expect(parallelMismatch.error.code).toBe('corrupt_run');
      expect(parallelMismatch.error.message).toContain('parallel-0002');
      expect(parallelMismatch.error.message).toContain('wrong');
      expect(parallelMismatch.error.message).toContain('beta');
    }

    // Sequential chain: unit agent must match request.chain[step].agent.
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        mode: 'chain',
        request: {
          mode: 'chain',
          agentScope: 'both',
          chain: [{ agent: 'seed', task: 'seed' }],
        },
        units: {
          'chain-0001': {
            unitId: 'chain-0001',
            agent: 'not-seed',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            step: 1,
            attempt: 1,
            attempts: [],
            effectiveCwd: '/tmp',
          },
        },
      })
    );
    const chainMismatch = store.getRun(runId);
    expect(chainMismatch.ok).toBe(false);
    if (!chainMismatch.ok) {
      expect(chainMismatch.error.code).toBe('corrupt_run');
      expect(chainMismatch.error.message).toContain('chain-0001');
      expect(chainMismatch.error.message).toContain('not-seed');
      expect(chainMismatch.error.message).toContain('seed');
    }

    // Fanout child: unit agent must match request.chain[step].parallel.agent.
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        mode: 'chain',
        request: {
          mode: 'chain',
          agentScope: 'both',
          chain: [
            { agent: 'seed', task: 'seed' },
            {
              expand: { from: { output: 'seed', path: '/items' } },
              parallel: { agent: 'worker', task: 'Process {item}' },
              collect: { name: 'out' },
            },
          ],
        },
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
            effectiveCwd: '/tmp',
          },
          'chain-0002-fanout-0001': {
            unitId: 'chain-0002-fanout-0001',
            agent: 'not-worker',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            step: 2,
            fanoutIndex: 0,
            attempt: 1,
            attempts: [],
            effectiveCwd: '/tmp',
          },
        },
      })
    );
    const fanoutMismatch = store.getRun(runId);
    expect(fanoutMismatch.ok).toBe(false);
    if (!fanoutMismatch.ok) {
      expect(fanoutMismatch.error.code).toBe('corrupt_run');
      expect(fanoutMismatch.error.message).toContain('chain-0002-fanout-0001');
      expect(fanoutMismatch.error.message).toContain('not-worker');
      expect(fanoutMismatch.error.message).toContain('worker');
    }

    // Matching topology agents remain valid (including default Pi runtime absent).
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        mode: 'chain',
        request: {
          mode: 'chain',
          agentScope: 'both',
          chain: [
            { agent: 'seed', task: 'seed' },
            {
              expand: { from: { output: 'seed', path: '/items' } },
              parallel: { agent: 'worker', task: 'Process {item}' },
              collect: { name: 'out' },
            },
          ],
        },
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
            effectiveCwd: '/tmp',
          },
          'chain-0002-fanout-0001': {
            unitId: 'chain-0002-fanout-0001',
            agent: 'worker',
            agentFingerprint: 'fp',
            runtime: 'grok-acp',
            capability: 'session',
            status: 'queued',
            step: 2,
            fanoutIndex: 0,
            attempt: 1,
            attempts: [],
            effectiveCwd: '/tmp',
            acpSessionId: 'sess-1',
          },
        },
      })
    );
    expect(store.getRun(runId).ok).toBe(true);
  });

  it('returns corrupt_run for swapped parallel positions, noncanonical ids, and coverage gaps', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const file = path.join(root, runId, 'run.json');
    const record: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));

    // Swapped fanoutIndex relative to parallel unit ids.
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        mode: 'parallel',
        request: {
          mode: 'parallel',
          agentScope: 'both',
          tasks: [
            { agent: 'alpha', task: 't1' },
            { agent: 'beta', task: 't2' },
          ],
        },
        units: {
          'parallel-0001': {
            unitId: 'parallel-0001',
            agent: 'alpha',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            fanoutIndex: 1,
            attempt: 1,
            attempts: [],
            effectiveCwd: '/tmp',
          },
          'parallel-0002': {
            unitId: 'parallel-0002',
            agent: 'beta',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            fanoutIndex: 0,
            attempt: 1,
            attempts: [],
            effectiveCwd: '/tmp',
          },
        },
      })
    );
    const swappedParallel = store.getRun(runId);
    expect(swappedParallel.ok).toBe(false);
    if (!swappedParallel.ok) {
      expect(swappedParallel.error.code).toBe('corrupt_run');
      expect(swappedParallel.error.message).toMatch(/fanoutIndex|canonical/);
    }

    // Swapped chain step fields.
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        mode: 'chain',
        request: {
          mode: 'chain',
          agentScope: 'both',
          chain: [
            { agent: 'seed', task: 'seed' },
            { agent: 'finish', task: 'finish' },
          ],
        },
        units: {
          'chain-0001': {
            unitId: 'chain-0001',
            agent: 'seed',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'completed',
            step: 2,
            attempt: 1,
            attempts: [],
            effectiveCwd: '/tmp',
          },
          'chain-0002': {
            unitId: 'chain-0002',
            agent: 'finish',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'interrupted',
            step: 1,
            attempt: 1,
            attempts: [],
            effectiveCwd: '/tmp',
          },
        },
      })
    );
    const swappedChain = store.getRun(runId);
    expect(swappedChain.ok).toBe(false);
    if (!swappedChain.ok) {
      expect(swappedChain.error.code).toBe('corrupt_run');
      expect(swappedChain.error.message).toMatch(/step|canonical|topology/);
    }

    // Noncanonical unit id for single mode.
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        units: {
          'not-single': {
            unitId: 'not-single',
            agent: 'noop',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            attempt: 1,
            attempts: [],
            effectiveCwd: '/tmp',
          },
        },
      })
    );
    const noncanonical = store.getRun(runId);
    expect(noncanonical.ok).toBe(false);
    if (!noncanonical.ok) {
      expect(noncanonical.error.code).toBe('corrupt_run');
      expect(noncanonical.error.message).toMatch(/canonical|coverage|topology/);
    }

    // Missing static parallel unit.
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        mode: 'parallel',
        request: {
          mode: 'parallel',
          agentScope: 'both',
          tasks: [
            { agent: 'alpha', task: 't1' },
            { agent: 'beta', task: 't2' },
          ],
        },
        units: {
          'parallel-0001': {
            unitId: 'parallel-0001',
            agent: 'alpha',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            fanoutIndex: 0,
            attempt: 1,
            attempts: [],
            effectiveCwd: '/tmp',
          },
        },
      })
    );
    const missing = store.getRun(runId);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe('corrupt_run');
      expect(missing.error.message).toContain('static unit coverage');
      expect(missing.error.message).toMatch(/parallel-0002|expected 2/);
    }

    // Extra static unit in single mode.
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        units: {
          single: record.units.single,
          extra: {
            unitId: 'extra',
            agent: 'noop',
            agentFingerprint: 'fp',
            runtime: undefined,
            capability: 'session',
            status: 'queued',
            attempt: 1,
            attempts: [],
            effectiveCwd: '/tmp',
          },
        },
      })
    );
    const extra = store.getRun(runId);
    expect(extra.ok).toBe(false);
    if (!extra.ok) {
      expect(extra.error.code).toBe('corrupt_run');
      // Extra unit fails identity/coverage; either message fail-closes the record.
      expect(extra.error.message).toMatch(/static unit coverage|canonical single-mode id/);
    }

    // unitId field disagrees with record key.
    writeFileSync(
      file,
      JSON.stringify({
        ...record,
        units: {
          single: { ...record.units.single, unitId: 'other' },
        },
      })
    );
    const mismatchedKey = store.getRun(runId);
    expect(mismatchedKey.ok).toBe(false);
    if (!mismatchedKey.ok) {
      expect(mismatchedKey.error.code).toBe('corrupt_run');
      expect(mismatchedKey.error.message).toContain('does not match record key');
    }
  });
});

describe('ticket claim locks', () => {
  it('claims a run and exposes the lowest eligible ticket as owner', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const claim = await store.claimRun(runId);
    expect(claim.ok).toBe(true);
    if (claim.ok) {
      expect(claim.ticket).toBe(1);
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.loaded.record.owner?.ticket).toBe(1);
        expect(loaded.loaded.record.owner?.claimId).toBe(claim.claimId);
      }
    }
  });

  it('a second live claimant withdraws with run_active and releases its own ticket', async () => {
    const deps = makeDeps();
    const storeA = createRunStore({ rootDir: root, ...deps });
    const { runId } = await storeA.createRun(makeCreateInput());
    const claimA = await storeA.claimRun(runId);
    expect(claimA.ok).toBe(true);

    // Same PID so the lower claim looks live to the second claimant.
    const storeB = createRunStore({ rootDir: root, ...deps });
    const claimB = await storeB.claimRun(runId);
    expect(claimB.ok).toBe(false);
    if (!claimB.ok) expect(claimB.error.code).toBe('run_active');

    // storeB released its higher ticket; its terminal.json should exist.
    const claims = storeA.inspectClaims(runId);
    expect(claims.ok).toBe(true);
    if (claims.ok) {
      // Two tickets published: A's winning ticket 1 and B's released ticket 2.
      expect(claims.claims.length).toBe(2);
      const ticketOne = claims.claims.find((c) => c.ticket === 1);
      const ticketTwo = claims.claims.find((c) => c.ticket === 2);
      expect(ticketOne?.terminal).toBeUndefined();
      expect(ticketTwo?.terminal?.state).toBe('released');
    }
  });

  it('monotonically increases tickets across terminal claims', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const c1 = await store.claimRun(runId);
    expect(c1.ok).toBe(true);
    if (c1.ok) await store.releaseRun(runId, c1.claimId);

    const c2 = await store.claimRun(runId);
    expect(c2.ok).toBe(true);
    if (c2.ok) {
      expect(c2.ticket).toBeGreaterThan(1);
      await store.releaseRun(runId, c2.claimId);
    }

    const claims = store.inspectClaims(runId);
    expect(claims.ok).toBe(true);
    if (claims.ok) {
      expect(claims.claims.length).toBe(2);
      expect(claims.claims[0]!.ticket).toBe(1);
      expect(claims.claims[1]!.ticket).toBe(2);
    }
  });

  it('release cannot alter a later claim', async () => {
    // Two distinct Pi processes share the same run root.
    const storeA = createRunStore({ rootDir: root, ...makeDeps(), pid: 1111, instanceId: 'ia' });
    const { runId } = await storeA.createRun(makeCreateInput());
    const claimA = await storeA.claimRun(runId);
    expect(claimA.ok).toBe(true);
    if (!claimA.ok) return;
    const winningTicket = claimA.ticket;

    // storeB releases using claimA's claimId. It must not terminate storeA's
    // claim because storeA's owner payload does not belong to storeB.
    const storeB = createRunStore({ rootDir: root, ...makeDeps(), pid: 2222, instanceId: 'ib' });
    await storeB.releaseRun(runId, claimA.claimId);

    const claims = storeA.inspectClaims(runId);
    expect(claims.ok).toBe(true);
    if (claims.ok) {
      const winning = claims.claims.find((c) => c.ticket === winningTicket);
      // The original winning claim is untouched (whatever its current owner is).
      if (winning?.owner?.claimId === claimA.claimId) {
        expect(winning.terminal).toBeUndefined();
      }
    }
  });

  it('foreign claim release refuses to terminate another owner (no matching claimId)', async () => {
    const deps = makeDeps();
    const storeA = createRunStore({ rootDir: root, ...deps });
    const { runId } = await storeA.createRun(makeCreateInput());
    const claimA = await storeA.claimRun(runId);
    expect(claimA.ok).toBe(true);

    // storeB with a different instance/pid releases a nonexistent claim — no-op.
    const storeB = createRunStore({
      rootDir: root,
      ...deps,
      pid: 9999,
      instanceId: 'foreign',
    });
    await storeB.releaseRun(runId, 'nonexistent-claim');
    const claims = storeA.inspectClaims(runId);
    expect(claims.ok).toBe(true);
    if (claims.ok) {
      expect(claims.claims[0]!.terminal).toBeUndefined();
    }
  });

  it('abandons a dead lower claim so a successor can claim', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    // Simulate a dead owner by claiming with a phantom PID then marking dead via a store
    // that treats that pid as dead.
    const deadDeps = { ...makeDeps(), pid: 7777, instanceId: 'dead-inst' };
    const deadStore = createRunStore({ rootDir: root, ...deadDeps });
    const deadClaim = await deadStore.claimRun(runId);
    expect(deadClaim.ok).toBe(true);

    // A new store with a different pid claims; the dead owner (pid 7777) is not alive.
    const liveDeps = makeDeps();
    const liveStore = createRunStore({ rootDir: root, ...liveDeps });
    // Ensure the live store's pid differs from the dead pid.
    const liveClaim = await liveStore.claimRun(runId);
    expect(liveClaim.ok).toBe(true);
    if (liveClaim.ok) {
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.loaded.record.owner?.claimId).toBe(liveClaim.claimId);
      }
    }
  });

  it('malformed published claim returns claim_corrupt and blocks resume', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    // Hand-publish a malformed claim directory at ticket 1.
    const claimsDir = path.join(root, runId, 'claims');
    const ticketOne = path.join(claimsDir, '0000000000000001');
    const fs = await import('node:fs');
    fs.mkdirSync(ticketOne, { recursive: true });
    fs.writeFileSync(path.join(ticketOne, 'owner.json'), '{ "garbled": true');
    const claim = await store.claimRun(runId);
    expect(claim.ok).toBe(false);
    if (!claim.ok) expect(claim.error.code).toBe('claim_corrupt');
  });

  it('same-ticket contention publishes exactly one owner directory', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const claims = await Promise.all([
      store.claimRun(runId),
      store.claimRun(runId),
      store.claimRun(runId),
    ]);
    const winners = claims.filter((c) => c.ok);
    const losers = claims.filter((c) => !c.ok);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(2);
    for (const loser of losers) {
      if (!loser.ok) expect(loser.error.code).toBe('run_active');
    }
    const published = store.inspectClaims(runId);
    expect(published.ok).toBe(true);
    if (published.ok) {
      // Three tickets published (1 winner + 2 released withdrawals).
      expect(published.claims.length).toBe(3);
      const distinctTickets = new Set(published.claims.map((c) => c.ticket));
      expect(distinctTickets.size).toBe(3);
    }
  });

  it('abandoned staging directories are cleaned up after withdraw', async () => {
    const deps = makeDeps();
    const storeA = createRunStore({ rootDir: root, ...deps });
    const { runId } = await storeA.createRun(makeCreateInput());
    const claimA = await storeA.claimRun(runId);
    expect(claimA.ok).toBe(true);

    const storeB = createRunStore({ rootDir: root, ...deps });
    await storeB.claimRun(runId);

    const claimsDir = path.join(root, runId, 'claims');
    const entries = await import('node:fs').then((f) =>
      f.readdirSync(claimsDir, { withFileTypes: true })
    );
    const staging = entries.filter((e) => e.name.startsWith('.staging-'));
    expect(staging.length).toBe(0);
  });
});
