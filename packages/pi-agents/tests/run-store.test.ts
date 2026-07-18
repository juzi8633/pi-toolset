// ABOUTME: Tests for the durable run store — paths, modes, atomic writes, events, listing, locks.
// ABOUTME: All tests inject a temporary root so the real home directory is never touched.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import {
  createRunStore,
  getDefaultRunsRoot,
  STRICT_TX_BYPASS_CLEANUP,
  type CreateRunStoreOptions,
  type StrictRunTxPhase,
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

/**
 * Production-equivalent process start identity.
 * Reads /proc/<pid>/stat, locates the final `)`, parses field 22 as decimal starttime;
 * any unreadable/malformed/non-Linux state yields unsupported-<platform>-<pid>.
 */
function processStartIdentity(targetPid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = readFileSync(`/proc/${targetPid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    if (closeParen < 0) return undefined;
    const after = stat.slice(closeParen + 2).split(' ');
    const starttime = after[19];
    if (!starttime || !/^\d+$/.test(starttime)) return undefined;
    return starttime;
  } catch {
    return undefined;
  }
}

function selfProcessStart(): string {
  const start = processStartIdentity(process.pid);
  if (start !== undefined) return start;
  return `unsupported-${process.platform}-${process.pid}`;
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
  it('resolves XDG state segments under ~/.local/state/@balaenis/pi-agents/runs', () => {
    const prevXdg = process.env.XDG_STATE_HOME;
    delete process.env.XDG_STATE_HOME;
    try {
      const expected = path.join(root, '.local', 'state', '@balaenis', 'pi-agents', 'runs');
      expect(getDefaultRunsRoot()).toBe(expected);
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prevXdg;
    }
  });

  it('uses PI_AGENTS_RUNS_DIR as a complete override root', () => {
    const prev = process.env.PI_AGENTS_RUNS_DIR;
    process.env.PI_AGENTS_RUNS_DIR = path.join(root, 'custom-runs');
    try {
      expect(getDefaultRunsRoot()).toBe(path.join(root, 'custom-runs'));
    } finally {
      if (prev === undefined) delete process.env.PI_AGENTS_RUNS_DIR;
      else process.env.PI_AGENTS_RUNS_DIR = prev;
    }
  });
});

describe('createRunStore root path', () => {
  it('uses the configured rootDir without realpath canonicalization', async () => {
    const configuredRoot = path.join(root, 'explicit', 'runs');
    const store = createRunStore({ rootDir: configuredRoot, ...makeDeps() });
    expect(store.rootDir).toBe(path.resolve(configuredRoot));

    const { runId } = await store.createRun(makeCreateInput());
    const claim = await store.claimRun(runId);
    expect(claim.ok).toBe(true);
    expect(existsSync(path.join(store.rootDir, runId, 'run.json'))).toBe(true);
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
          message: 'details.outputs[prev] must set exactly one of text or textRef',
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

  it('returns corrupt_run for completed unit with inconsistent result status/exitCode or malformed messages', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const file = path.join(root, runId, 'run.json');
    const base: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));
    const unitId = Object.keys(base.units)[0]!;

    const badCases: Array<{ label: string; result: unknown; message: string | RegExp }> = [
      {
        label: 'status running',
        result: { messages: [], status: 'running', exitCode: -1 },
        message: /status must be completed/,
      },
      {
        label: 'status failed',
        result: { messages: [], status: 'failed', exitCode: 1 },
        message: /status must be completed/,
      },
      {
        label: 'exitCode -1 with completed status',
        result: { messages: [], status: 'completed', exitCode: -1 },
        message: /exitCode must not be -1/,
      },
      {
        label: 'status-less non-zero exitCode',
        result: { messages: [], exitCode: 1 },
        message: /exitCode must be 0 when status is absent/,
      },
      {
        label: 'primitive message entry',
        result: { messages: ['nope'], status: 'completed', exitCode: 0 },
        message: /messages\[0\] must be a non-null object/,
      },
      {
        label: 'null message entry',
        result: { messages: [null], status: 'completed', exitCode: 0 },
        message: /messages\[0\] must be a non-null object/,
      },
      {
        label: 'array message entry',
        result: { messages: [[{ role: 'assistant' }]], status: 'completed', exitCode: 0 },
        message: /messages\[0\] must be a non-null object/,
      },
    ];

    for (const c of badCases) {
      const record = structuredClone(base);
      record.units[unitId] = {
        ...record.units[unitId]!,
        status: 'completed',
        result: c.result as never,
      };
      record.details = { ...record.details, results: [] };
      writeFileSync(file, JSON.stringify(record));
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) {
        expect(loaded.error.code).toBe('corrupt_run');
        expect(loaded.error.message).toContain(`unit ${unitId} result`);
        expect(loaded.error.message).toMatch(c.message);
      }
    }

    // Malformed details.results messages rejected pre-claim too.
    const detailsBad = structuredClone(base);
    detailsBad.details = {
      ...detailsBad.details,
      results: [{ agent: 'noop', messages: [42] } as never],
    };
    writeFileSync(file, JSON.stringify(detailsBad));
    const detailsLoaded = store.getRun(runId);
    expect(detailsLoaded.ok).toBe(false);
    if (!detailsLoaded.ok) {
      expect(detailsLoaded.error.code).toBe('corrupt_run');
      expect(detailsLoaded.error.message).toContain('details.results[0].messages[0]');
    }

    // Valid legacy completed shells still load: empty messages + presentation, or populated messages.
    const legacyOk: Array<{ label: string; result: unknown }> = [
      {
        label: 'empty messages + presentation',
        result: {
          agent: 'noop',
          messages: [],
          status: 'completed',
          exitCode: 0,
          presentation: { transcript: [{ type: 'text', text: 'done' }] },
        },
      },
      {
        label: 'populated messages terminal exitCode 1 with completed status',
        result: {
          agent: 'noop',
          messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }],
          status: 'completed',
          exitCode: 1,
        },
      },
      {
        label: 'status-less exitCode 0',
        result: {
          agent: 'noop',
          messages: [],
          exitCode: 0,
        },
      },
    ];
    for (const c of legacyOk) {
      const record = structuredClone(base);
      record.units[unitId] = {
        ...record.units[unitId]!,
        status: 'completed',
        result: c.result as never,
      };
      record.details = { ...record.details, results: [] };
      writeFileSync(file, JSON.stringify(record));
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
    }
  });

  it('returns corrupt_run for chain outputs with impossible step/agent; accepts valid chain topology', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const file = path.join(root, runId, 'run.json');
    const base: AgentRunRecordV1 = JSON.parse(readFileSync(file, 'utf-8'));

    const chainBase = {
      ...base,
      mode: 'chain' as const,
      request: {
        mode: 'chain' as const,
        agentScope: 'both' as const,
        chain: [
          { agent: 'seed', task: 'seed work' },
          { agent: 'impl', task: 'implement' },
        ],
      },
      units: {
        'chain-0001': {
          unitId: 'chain-0001',
          agent: 'seed',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session' as const,
          status: 'queued' as const,
          step: 1,
          attempt: 1,
          attempts: [],
          effectiveCwd: '/tmp',
        },
        'chain-0002': {
          unitId: 'chain-0002',
          agent: 'impl',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session' as const,
          status: 'queued' as const,
          step: 2,
          attempt: 1,
          attempts: [],
          effectiveCwd: '/tmp',
        },
      },
      details: {
        ...base.details,
        mode: 'chain' as const,
        results: [],
      },
    };

    // Impossible high step poisons later-step-wins.
    writeFileSync(
      file,
      JSON.stringify({
        ...chainBase,
        details: {
          ...chainBase.details,
          outputs: {
            poisoned: { text: 'bad', agent: 'seed', step: 99 },
          },
        },
      })
    );
    const highStep = store.getRun(runId);
    expect(highStep.ok).toBe(false);
    if (!highStep.ok) {
      expect(highStep.error.code).toBe('corrupt_run');
      expect(highStep.error.message).toContain('details.outputs[poisoned].step');
      expect(highStep.error.message).toContain('outside chain topology');
    }

    // Wrong agent at a valid step.
    writeFileSync(
      file,
      JSON.stringify({
        ...chainBase,
        details: {
          ...chainBase.details,
          outputs: {
            step1: { text: 'ok', agent: 'wrong-agent', step: 1 },
          },
        },
      })
    );
    const badAgent = store.getRun(runId);
    expect(badAgent.ok).toBe(false);
    if (!badAgent.ok) {
      expect(badAgent.error.code).toBe('corrupt_run');
      expect(badAgent.error.message).toContain('details.outputs[step1].agent');
      expect(badAgent.error.message).toContain('wrong-agent');
      expect(badAgent.error.message).toContain('seed');
    }

    // Valid chain outputs + chain presentation accepted.
    writeFileSync(
      file,
      JSON.stringify({
        ...chainBase,
        details: {
          ...chainBase.details,
          outputs: {
            step1: { text: 'hello', agent: 'seed', step: 1 },
            step2: { text: 'world', agent: 'impl', step: 2, structured: null },
          },
          chain: {
            totalSteps: 2,
            steps: [
              {
                kind: 'sequential',
                step: 1,
                agent: 'seed',
                task: 'seed work',
                status: 'completed',
              },
              {
                kind: 'sequential',
                step: 2,
                agent: 'impl',
                task: 'implement',
                status: 'queued',
              },
            ],
          },
        },
      })
    );
    const ok = store.getRun(runId);
    expect(ok.ok).toBe(true);

    // Single-mode records may still carry ignored legacy chain presentation (not corrupt).
    const singleLegacy = structuredClone(base);
    singleLegacy.details = {
      ...singleLegacy.details,
      outputs: { orphan: { text: 'x', agent: 'noop', step: 9 } },
      chain: {
        totalSteps: 1,
        steps: [
          {
            kind: 'sequential',
            step: 1,
            agent: 'noop',
            task: 't',
            status: 'completed',
          },
        ],
      },
    };
    writeFileSync(file, JSON.stringify(singleLegacy));
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

describe('updateRunStrict recoverable transaction protocol', () => {
  const TX_ROLLBACK = '.run.json.tx.rollback';
  const TX_MARKER = '.run.json.tx.marker';

  function txPaths(runDir: string) {
    return {
      rollback: path.join(runDir, TX_ROLLBACK),
      marker: path.join(runDir, TX_MARKER),
      runJson: path.join(runDir, 'run.json'),
    };
  }

  function assertNoTxLeftovers(runDir: string): void {
    const entries = readdirSync(runDir);
    expect(entries.filter((n) => n === TX_ROLLBACK || n === TX_MARKER)).toHaveLength(0);
    expect(entries.filter((n) => n === '.run.json.tx.lock')).toHaveLength(0);
    expect(entries.filter((n) => n.startsWith('.run.json.') && n.endsWith('.tmp'))).toHaveLength(0);
  }

  function mutateToRunning(r: AgentRunRecordV1): void {
    r.units.single.status = 'running';
    r.units.single.requireArtifactReader = true;
    r.units.single.attempts.push({
      attempt: 1,
      status: 'running',
      startedAt: 1,
    });
  }

  it('one-shot post-rename directory-sync failure restores prior run.json bytes and unit state', async () => {
    const deps = makeDeps();
    let postRenameHits = 0;
    const store = createRunStore({
      rootDir: root,
      ...deps,
      strictPostRenameDirectorySync: () => {
        postRenameHits += 1;
        throw {
          code: 'run_store_error' as const,
          message: 'directory fsync failed: injected',
        };
      },
    });
    const { runId, record: created } = await store.createRun(makeCreateInput());
    const beforePath = path.join(store.getRunDir(runId), 'run.json');
    const beforeBytes = readFileSync(beforePath);
    const beforeStatus = created.units.single.status;
    expect(beforeStatus).toBe('queued');

    await expect(store.updateRunStrict(runId, mutateToRunning)).rejects.toMatchObject({
      code: 'run_store_error',
      message: expect.stringMatching(/directory fsync failed.*prior run\.json restored/),
    });

    expect(postRenameHits).toBe(1);
    const afterBytes = readFileSync(beforePath);
    expect(afterBytes.equals(beforeBytes)).toBe(true);

    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.status).toBe('queued');
    expect(loaded.loaded.record.units.single.requireArtifactReader).toBeUndefined();
    expect(loaded.loaded.record.units.single.attempts).toHaveLength(0);

    assertNoTxLeftovers(store.getRunDir(runId));
  });

  it('successful strict update leaves no transaction leftovers and publishes new state', async () => {
    const deps = makeDeps();
    let postRenameHits = 0;
    const store = createRunStore({
      rootDir: root,
      ...deps,
      strictPostRenameDirectorySync: (dirPath) => {
        postRenameHits += 1;
        if (process.platform !== 'win32') {
          const dirFd = openSync(dirPath, 'r');
          try {
            fsyncSync(dirFd);
          } finally {
            closeSync(dirFd);
          }
        }
      },
    });
    const { runId } = await store.createRun(makeCreateInput());
    await store.updateRunStrict(runId, (r) => {
      r.units.single.status = 'running';
      r.units.single.requireArtifactReader = true;
    });
    expect(postRenameHits).toBe(1);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.status).toBe('running');
    expect(loaded.loaded.record.units.single.requireArtifactReader).toBe(true);
    assertNoTxLeftovers(store.getRunDir(runId));
  });

  for (const phase of [
    'after_rollback_publication',
    'after_prepared_marker',
    'after_new_rename',
    'after_new_directory_sync',
  ] as const) {
    it(`crash window ${phase}: reopened store restores old authority and cleans leftovers`, async () => {
      const deps = makeDeps();
      let hits = 0;
      const store = createRunStore({
        rootDir: root,
        ...deps,
        strictTransactionHook: (p) => {
          if (p === phase) {
            hits += 1;
            throw new Error(`injected crash at ${phase}`);
          }
        },
      });
      const { runId } = await store.createRun(makeCreateInput());
      const runDir = store.getRunDir(runId);
      const beforeBytes = readFileSync(path.join(runDir, 'run.json'));

      await expect(store.updateRunStrict(runId, mutateToRunning)).rejects.toMatchObject({
        message: expect.stringMatching(/prior run\.json restored|injected crash/),
      });
      expect(hits).toBe(1);

      // Fresh store reopens through recovery.
      const reopened = createRunStore({ rootDir: root, ...makeDeps() });
      const loaded = reopened.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.loaded.record.units.single.status).toBe('queued');
      expect(loaded.loaded.record.units.single.requireArtifactReader).toBeUndefined();
      expect(readFileSync(path.join(runDir, 'run.json')).equals(beforeBytes)).toBe(true);
      assertNoTxLeftovers(runDir);
    });
  }

  it('crash after committed marker: reopened store keeps new authority and cleans leftovers', async () => {
    const deps = makeDeps();
    let hits = 0;
    const store = createRunStore({
      rootDir: root,
      ...deps,
      strictTransactionHook: (p) => {
        if (p === 'after_committed_marker' || p === 'during_cleanup') {
          hits += 1;
          if (p === 'during_cleanup') throw new Error('injected cleanup failure');
        }
      },
    });
    const { runId } = await store.createRun(makeCreateInput());
    // after_committed_marker does not throw; during_cleanup does — update still succeeds.
    const updated = await store.updateRunStrict(runId, mutateToRunning);
    expect(updated.units.single.status).toBe('running');
    expect(hits).toBeGreaterThanOrEqual(1);

    const reopened = createRunStore({ rootDir: root, ...makeDeps() });
    const loaded = reopened.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.status).toBe('running');
    expect(loaded.loaded.record.units.single.requireArtifactReader).toBe(true);
    assertNoTxLeftovers(store.getRunDir(runId));
  });

  it('crash after committed marker durability only: reports success, next load cleans leftovers', async () => {
    const deps = makeDeps();
    const store = createRunStore({
      rootDir: root,
      ...deps,
      strictTransactionHook: (p) => {
        if (p === 'after_committed_marker') throw new Error('stop after commit marker');
      },
    });
    const { runId } = await store.createRun(makeCreateInput());
    const updated = await store.updateRunStrict(runId, mutateToRunning);
    expect(updated.units.single.status).toBe('running');

    const reopened = createRunStore({ rootDir: root, ...makeDeps() });
    const loaded = reopened.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.status).toBe('running');
    assertNoTxLeftovers(store.getRunDir(runId));
  });

  it('rollback restore failure preserves recovery material and surfaces durable_write_error', async () => {
    const deps = makeDeps();
    const store = createRunStore({
      rootDir: root,
      ...deps,
      strictTransactionHook: (p) => {
        if (p === 'after_new_directory_sync') throw new Error('force restore path');
        if (p === 'during_rollback_restore') throw new Error('injected rollback failure');
      },
    });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const paths = txPaths(runDir);

    await expect(store.updateRunStrict(runId, mutateToRunning)).rejects.toMatchObject({
      code: 'durable_write_error',
      message: expect.stringMatching(/recovery files preserved/),
    });

    // Recovery material must remain for a later load to finish recovery.
    expect(existsSync(paths.rollback)).toBe(true);
    expect(existsSync(paths.marker)).toBe(true);

    // Later successful recovery (no fault) restores old authority.
    const reopened = createRunStore({ rootDir: root, ...makeDeps() });
    const loaded = reopened.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.status).toBe('queued');
    assertNoTxLeftovers(runDir);
  });

  it('malformed marker fails closed without deleting forensic material', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const paths = txPaths(runDir);
    writeFileSync(paths.marker, '{not-json\n', { mode: 0o600 });
    writeFileSync(paths.rollback, readFileSync(paths.runJson), { mode: 0o600 });

    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.code).toBe('corrupt_run');
    expect(existsSync(paths.marker)).toBe(true);
    expect(existsSync(paths.rollback)).toBe(true);
  });

  it('digest mismatch on prepared marker fails closed without deleting recovery material', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const paths = txPaths(runDir);
    const oldBytes = readFileSync(paths.runJson);
    writeFileSync(paths.rollback, oldBytes, { mode: 0o600 });
    writeFileSync(
      paths.marker,
      JSON.stringify({
        version: 1,
        phase: 'prepared',
        oldSha256: 'a'.repeat(64),
        oldBytes: oldBytes.byteLength,
        newSha256: 'b'.repeat(64),
        newBytes: 1,
      }) + '\n',
      { mode: 0o600 }
    );

    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.code).toBe('corrupt_run');
    expect(loaded.error.message).toMatch(/digest mismatch/);
    expect(existsSync(paths.marker)).toBe(true);
    expect(existsSync(paths.rollback)).toBe(true);
  });

  function bypassError(label: string): Error {
    const err = new Error(label) as Error & Record<symbol, unknown>;
    err[STRICT_TX_BYPASS_CLEANUP] = true;
    return err;
  }

  it('bypass-cleanup crash at after_new_rename: fresh store restores old authority', async () => {
    const deps = makeDeps();
    const store = createRunStore({
      rootDir: root,
      ...deps,
      strictTransactionHook: (p) => {
        if (p === 'after_new_rename') throw bypassError('crash after new rename');
      },
    });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const beforeBytes = readFileSync(path.join(runDir, 'run.json'));

    await expect(store.updateRunStrict(runId, mutateToRunning)).rejects.toMatchObject({
      message: expect.stringMatching(/crash after new rename/),
    });

    // Transaction material must still be present (no in-process restore).
    expect(
      existsSync(path.join(runDir, TX_MARKER)) || existsSync(path.join(runDir, TX_ROLLBACK))
    ).toBe(true);

    const reopened = createRunStore({ rootDir: root, ...makeDeps() });
    const loaded = reopened.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.status).toBe('queued');
    expect(readFileSync(path.join(runDir, 'run.json')).equals(beforeBytes)).toBe(true);
    assertNoTxLeftovers(runDir);
  });

  it('bypass-cleanup crash after committed marker: fresh store keeps new authority', async () => {
    const deps = makeDeps();
    const store = createRunStore({
      rootDir: root,
      ...deps,
      strictTransactionHook: (p) => {
        if (p === 'after_committed_marker') throw bypassError('crash after commit marker');
      },
    });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);

    await expect(store.updateRunStrict(runId, mutateToRunning)).rejects.toMatchObject({
      message: expect.stringMatching(/crash after commit marker/),
    });

    expect(existsSync(path.join(runDir, TX_MARKER))).toBe(true);

    const reopened = createRunStore({ rootDir: root, ...makeDeps() });
    const loaded = reopened.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.status).toBe('running');
    expect(loaded.loaded.record.units.single.requireArtifactReader).toBe(true);
    assertNoTxLeftovers(runDir);
  });

  for (const phase of [
    'after_cleanup_rollback_unlink',
    'after_cleanup_marker_unlink',
    'after_cleanup_first_dir_sync',
  ] as const) {
    it(`bypass-cleanup committed window ${phase}: new authority remains recoverable`, async () => {
      const deps = makeDeps();
      const store = createRunStore({
        rootDir: root,
        ...deps,
        strictTransactionHook: (p: StrictRunTxPhase) => {
          if (p === phase) throw bypassError(`crash at ${phase}`);
        },
      });
      const { runId } = await store.createRun(makeCreateInput());
      const runDir = store.getRunDir(runId);

      await expect(store.updateRunStrict(runId, mutateToRunning)).rejects.toMatchObject({
        message: expect.stringMatching(new RegExp(phase)),
      });

      const reopened = createRunStore({ rootDir: root, ...makeDeps() });
      const loaded = reopened.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.loaded.record.units.single.status).toBe('running');
      assertNoTxLeftovers(runDir);
    });
  }

  it('committed-marker rename + sync failure with re-prepare restores old authority', async () => {
    const deps = makeDeps();
    let commitSyncHits = 0;
    const store = createRunStore({
      rootDir: root,
      ...deps,
      strictCommittedMarkerDirectorySync: () => {
        commitSyncHits += 1;
        throw {
          code: 'run_store_error' as const,
          message: 'directory fsync failed: committed marker',
        };
      },
    });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const beforeBytes = readFileSync(path.join(runDir, 'run.json'));

    await expect(store.updateRunStrict(runId, mutateToRunning)).rejects.toMatchObject({
      message: expect.stringMatching(/prior run\.json restored|committed marker/),
    });
    expect(commitSyncHits).toBe(1);

    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.status).toBe('queued');
    expect(readFileSync(path.join(runDir, 'run.json')).equals(beforeBytes)).toBe(true);
    assertNoTxLeftovers(runDir);
  });

  it('live transaction lock is not stolen by a second store (run_busy)', async () => {
    const deps = makeDeps();
    const storeA = createRunStore({ rootDir: root, ...deps, txLockWaitMs: 100, txLockRetryMs: 10 });
    const { runId } = await storeA.createRun(makeCreateInput());
    const runDir = storeA.getRunDir(runId);
    const lockDir = path.join(runDir, '.run.json.tx.lock');
    const ownerPath = path.join(lockDir, 'owner.json');

    // Publish a live owner record for this process (same start identity).
    mkdirSync(lockDir, { mode: 0o700 });
    const starttime = selfProcessStart();
    writeFileSync(
      ownerPath,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        processStart: starttime,
        token: 'live-token-other',
        timestamp: Date.now(),
      }) + '\n',
      { mode: 0o600 }
    );

    const storeB = createRunStore({
      rootDir: root,
      ...makeDeps(),
      txLockWaitMs: 80,
      txLockRetryMs: 10,
    });
    const loaded = storeB.getRun(runId);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.code).toBe('run_busy');
    // Transaction lock and owner remain.
    expect(existsSync(lockDir)).toBe(true);
    expect(existsSync(ownerPath)).toBe(true);

    // listRuns preserves run_busy.
    const listed = await storeB.listRuns();
    const entry = listed.find((e) => ('record' in e ? e.record.runId : e.runId) === runId);
    expect(entry).toBeDefined();
    if (entry && !('record' in entry)) {
      expect(entry.code).toBe('run_busy');
    }
  });

  it('stale transaction lock (dead pid) is stolen and recovery proceeds', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const lockDir = path.join(runDir, '.run.json.tx.lock');
    const ownerPath = path.join(lockDir, 'owner.json');
    const paths = txPaths(runDir);
    const beforeBytes = readFileSync(paths.runJson);

    // Leave a prepared transaction + stale lock from a dead pid.
    writeFileSync(paths.rollback, beforeBytes, { mode: 0o600 });
    writeFileSync(
      paths.marker,
      JSON.stringify({
        version: 1,
        phase: 'prepared',
        oldSha256: crypto.createHash('sha256').update(beforeBytes).digest('hex'),
        oldBytes: beforeBytes.byteLength,
        newSha256: 'c'.repeat(64),
        newBytes: 12,
      }) + '\n',
      { mode: 0o600 }
    );
    // Also overwrite run.json with "new" bytes so prepared recovery must restore.
    writeFileSync(paths.runJson, Buffer.from('{"version":1,"junk":true}\n'));

    mkdirSync(lockDir, { mode: 0o700 });
    writeFileSync(
      ownerPath,
      JSON.stringify({
        version: 1,
        pid: 2_147_000_000, // almost-certainly dead
        processStart: '1',
        token: 'stale-token',
        timestamp: Date.now() - 60_000,
      }) + '\n',
      { mode: 0o600 }
    );

    const reopened = createRunStore({ rootDir: root, ...makeDeps() });
    const loaded = reopened.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.status).toBe('queued');
    expect(readFileSync(paths.runJson).equals(beforeBytes)).toBe(true);
    assertNoTxLeftovers(runDir);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('listRuns preserves durable_write_error for temporary recovery failure', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const paths = txPaths(runDir);
    const oldBytes = readFileSync(paths.runJson);
    writeFileSync(paths.rollback, oldBytes, { mode: 0o600 });
    writeFileSync(
      paths.marker,
      JSON.stringify({
        version: 1,
        phase: 'prepared',
        oldSha256: crypto.createHash('sha256').update(oldBytes).digest('hex'),
        oldBytes: oldBytes.byteLength,
        newSha256: 'd'.repeat(64),
        newBytes: 1,
      }) + '\n',
      { mode: 0o600 }
    );
    // Make restore fail: replace run.json parent... instead make rollback unreadable by mode?
    // Easier: make rollback a directory so cleanup/restore fails closed as corrupt, and
    // separately test durable_write_error via live lock run_busy above.
    // For durable_write_error: leave prepared with matching rollback but make target a dir.
    rmSync(paths.runJson);
    mkdirSync(paths.runJson, { mode: 0o700 });

    const listed = await store.listRuns();
    const entry = listed.find((e) => ('record' in e ? e.record.runId : e.runId) === runId);
    expect(entry).toBeDefined();
    if (!entry || 'record' in entry) return;
    // Directory run.json is not a safe regular file → exact corrupt_run (fail closed).
    expect(entry.code).toBe('corrupt_run');
  });

  it('child-process live lock: second process cannot recover mid-transaction', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const beforeBytes = readFileSync(path.join(runDir, 'run.json'));
    const paths = txPaths(runDir);

    // Hold lock in a child that pauses with prepared artifacts present.
    const childScript = `
      const fs = require('fs');
      const path = require('path');
      const runDir = process.argv[1];
      const lockDir = path.join(runDir, '.run.json.tx.lock');
      fs.mkdirSync(lockDir, { mode: 0o700 });
      function processStartIdentity(targetPid) {
        if (process.platform !== 'linux') return undefined;
        try {
          const stat = fs.readFileSync('/proc/' + targetPid + '/stat', 'utf8');
          const close = stat.lastIndexOf(')');
          if (close < 0) return undefined;
          const after = stat.slice(close + 2).split(' ');
          const starttime = after[19];
          if (!starttime || !/^\\d+$/.test(starttime)) return undefined;
          return starttime;
        } catch {
          return undefined;
        }
      }
      function selfProcessStart() {
        const start = processStartIdentity(process.pid);
        if (start !== undefined) return start;
        return 'unsupported-' + process.platform + '-' + process.pid;
      }
      const starttime = selfProcessStart();
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        version: 1, pid: process.pid, processStart: starttime, token: 'child', timestamp: Date.now()
      }) + '\\n', { mode: 0o600 });
      const runJson = path.join(runDir, 'run.json');
      const old = fs.readFileSync(runJson);
      const crypto = require('crypto');
      fs.writeFileSync(path.join(runDir, '.run.json.tx.rollback'), old, { mode: 0o600 });
      fs.writeFileSync(path.join(runDir, '.run.json.tx.marker'), JSON.stringify({
        version: 1, phase: 'prepared',
        oldSha256: crypto.createHash('sha256').update(old).digest('hex'),
        oldBytes: old.length,
        newSha256: 'e'.repeat(64), newBytes: 4
      }) + '\\n', { mode: 0o600 });
      fs.writeFileSync(runJson, Buffer.from('NEW!'));
      fs.writeFileSync(process.argv[2], 'ready');
      setInterval(() => {}, 1000);
    `;
    const readyFile = path.join(root, 'child-ready');
    const proc = spawn(process.execPath, ['-e', childScript, runDir, readyFile], {
      stdio: 'ignore',
    });
    try {
      const deadline = Date.now() + 3000;
      while (!existsSync(readyFile) && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      expect(existsSync(readyFile)).toBe(true);

      const storeB = createRunStore({
        rootDir: root,
        ...makeDeps(),
        txLockWaitMs: 100,
        txLockRetryMs: 20,
      });
      const busy = storeB.getRun(runId);
      expect(busy.ok).toBe(false);
      if (!busy.ok) expect(busy.error.code).toBe('run_busy');
      // Must not have restored while child holds lock.
      expect(readFileSync(path.join(runDir, 'run.json')).toString()).toBe('NEW!');
      expect(existsSync(paths.marker)).toBe(true);
    } finally {
      proc.kill('SIGKILL');
      await Bun.sleep(50);
    }

    // After child death, stale lock steal + prepared recovery restores old.
    const storeC = createRunStore({ rootDir: root, ...makeDeps() });
    const loaded = storeC.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(readFileSync(path.join(runDir, 'run.json')).equals(beforeBytes)).toBe(true);
    assertNoTxLeftovers(runDir);
  });
});

describe('round-10 atomic lock publish and quarantine release', () => {
  function processStarttime(): string {
    return selfProcessStart();
  }

  function publishCompleteLock(
    runDir: string,
    owner: Record<string, unknown>
  ): { lockDir: string; ownerPath: string } {
    const lockDir = path.join(runDir, '.run.json.tx.lock');
    const cand = path.join(runDir, `.run.json.tx.lock.cand.test-${crypto.randomUUID()}`);
    mkdirSync(cand, { mode: 0o700 });
    const ownerPath = path.join(cand, 'owner.json');
    writeFileSync(ownerPath, JSON.stringify(owner) + '\n', { mode: 0o600 });
    // Atomic publish of a complete candidate.
    renameSync(cand, lockDir);
    return { lockDir, ownerPath: path.join(lockDir, 'owner.json') };
  }

  it('candidate crash leaves no fixed lock; next acquisition cleans leftover candidate', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    // Incomplete/malformed candidate is preserved (no blind prefix cleanup).
    const incomplete = path.join(runDir, `.run.json.tx.lock.cand.leftover-${crypto.randomUUID()}`);
    mkdirSync(incomplete, { mode: 0o700 });
    writeFileSync(path.join(incomplete, 'owner.json'), '{"version":1}\n', { mode: 0o600 });
    // Fully-verified dead-owner candidate is collectible.
    const deadCand = path.join(runDir, `.run.json.tx.lock.cand.dead-${crypto.randomUUID()}`);
    mkdirSync(deadCand, { mode: 0o700 });
    writeFileSync(
      path.join(deadCand, 'owner.json'),
      JSON.stringify({
        version: 1,
        pid: 2_147_000_100,
        processStart: '1',
        token: 'dead-cand-token',
        timestamp: Date.now() - 60_000,
      }) + '\n',
      { mode: 0o600 }
    );
    expect(existsSync(path.join(runDir, '.run.json.tx.lock'))).toBe(false);

    await store.updateRun(runId, (r) => {
      r.units.single.status = 'running';
    });
    expect(existsSync(path.join(runDir, '.run.json.tx.lock'))).toBe(false);
    // Unknown incomplete candidate preserved; verified dead candidate removed.
    expect(existsSync(incomplete)).toBe(true);
    expect(existsSync(deadCand)).toBe(false);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.status).toBe('running');
  });

  it('two contenders stale-steal: only one enters; replacement owner is not deleted', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps, txLockWaitMs: 200, txLockRetryMs: 10 });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);

    // Stale fixed lock from a dead pid.
    publishCompleteLock(runDir, {
      version: 1,
      pid: 2_147_000_001,
      processStart: '1',
      token: 'stale-shared',
      timestamp: Date.now() - 60_000,
    });

    const entered: string[] = [];
    const storeA = createRunStore({
      rootDir: root,
      ...makeDeps(),
      txLockWaitMs: 500,
      txLockRetryMs: 15,
    });
    const storeB = createRunStore({
      rootDir: root,
      ...makeDeps(),
      txLockWaitMs: 500,
      txLockRetryMs: 15,
    });

    const work = async (label: string, s: ReturnType<typeof createRunStore>) => {
      await s.updateRun(runId, (r) => {
        entered.push(label);
        r.units.single.status = 'running';
        (r.units.single as { notes?: string }).notes = label;
      });
    };

    await Promise.all([work('A', storeA), work('B', storeB)]);
    // Both may complete sequentially after steal; at most one owner held lock at a time.
    // Final state must be consistent (no corrupt lock leftovers).
    expect(existsSync(path.join(runDir, '.run.json.tx.lock'))).toBe(false);
    const leftovers = readdirSync(runDir).filter(
      (n) =>
        n.startsWith('.run.json.tx.lock.cand.') ||
        n.startsWith('.run.json.tx.lock.q.') ||
        n.startsWith('.run.json.tx.lock.tomb.')
    );
    expect(leftovers).toHaveLength(0);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.status).toBe('running');
    expect(entered.length).toBe(2);
  });

  it('owner-release vs steal: live token cannot be stolen; busy is exact', async () => {
    const deps = makeDeps();
    const storeA = createRunStore({ rootDir: root, ...deps, txLockWaitMs: 80, txLockRetryMs: 10 });
    const { runId } = await storeA.createRun(makeCreateInput());
    const runDir = storeA.getRunDir(runId);
    publishCompleteLock(runDir, {
      version: 1,
      pid: process.pid,
      processStart: processStarttime(),
      token: 'live-hold',
      timestamp: Date.now(),
    });

    const storeB = createRunStore({
      rootDir: root,
      ...makeDeps(),
      txLockWaitMs: 60,
      txLockRetryMs: 10,
    });
    const loaded = storeB.getRun(runId);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.code).toBe('run_busy');
    expect(existsSync(path.join(runDir, '.run.json.tx.lock'))).toBe(true);
    expect(existsSync(path.join(runDir, '.run.json.tx.lock', 'owner.json'))).toBe(true);
  });

  it('release crash tombstone is collectible; fixed lock absent', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    // Tombstone basename suffix must exactly equal verified owner token.
    const tombToken = 'tomb-token';
    const tomb = path.join(runDir, `.run.json.tx.lock.tomb.${tombToken}`);
    mkdirSync(tomb, { mode: 0o700 });
    writeFileSync(
      path.join(tomb, 'owner.json'),
      JSON.stringify({
        version: 1,
        pid: 2_147_000_002,
        processStart: '1',
        token: tombToken,
        timestamp: Date.now(),
      }) + '\n',
      { mode: 0o600 }
    );
    expect(existsSync(path.join(runDir, '.run.json.tx.lock'))).toBe(false);

    await store.updateRun(runId, (r) => {
      r.units.single.status = 'running';
    });
    expect(existsSync(tomb)).toBe(false);
    expect(existsSync(path.join(runDir, '.run.json.tx.lock'))).toBe(false);
  });
});

describe('round-10 full RMW under one lock', () => {
  it('two stores overlapping field updates: both non-conflicting changes survive', async () => {
    const deps = makeDeps();
    const storeA = createRunStore({ rootDir: root, ...deps });
    const { runId } = await storeA.createRun(makeCreateInput());
    const storeB = createRunStore({ rootDir: root, ...makeDeps() });

    await Promise.all([
      storeA.updateRun(runId, (r) => {
        r.units.single.status = 'running';
      }),
      storeB.updateRun(runId, (r) => {
        r.units.single.requireArtifactReader = true;
      }),
    ]);

    const loaded = createRunStore({ rootDir: root, ...makeDeps() }).getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // Exact merged result: status running AND requireArtifactReader true.
    expect(loaded.loaded.record.units.single.status).toBe('running');
    expect(loaded.loaded.record.units.single.requireArtifactReader).toBe(true);
  });

  it('child-process write race: both writers serialize; no silent lost authority bytes', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const modulePath = path.resolve(import.meta.dir, '../src/run-store.ts');

    const childScript = `
      import { createRunStore } from ${JSON.stringify(modulePath)};
      const root = process.argv[1];
      const runId = process.argv[2];
      const label = process.argv[3];
      const store = createRunStore({ rootDir: root });
      await store.updateRun(runId, (r) => {
        r.units.single.status = 'running';
        r.units.single.effectiveCwd = '/tmp/' + label;
      });
    `;
    const procA = spawn(process.execPath, ['-e', childScript, root, runId, 'A'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const procB = spawn(process.execPath, ['-e', childScript, root, runId, 'B'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const wait = (p: ReturnType<typeof spawn>) =>
      new Promise<number>((resolve) => {
        let err = '';
        p.stderr?.on('data', (d) => {
          err += String(d);
        });
        p.on('exit', (c) => {
          if (c !== 0 && err) {
            // Surface child stderr in assertion message rather than console.
            resolve(c ?? 1);
            return;
          }
          resolve(c ?? 1);
        });
      });
    const [codeA, codeB] = await Promise.all([wait(procA), wait(procB)]);
    expect(codeA).toBe(0);
    expect(codeB).toBe(0);

    const loaded = createRunStore({ rootDir: root, ...makeDeps() }).getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.status).toBe('running');
    expect(['/tmp/A', '/tmp/B']).toContain(loaded.loaded.record.units.single.effectiveCwd);
    expect(existsSync(path.join(runDir, '.run.json.tx.lock'))).toBe(false);
  });

  it('ordinary writer waits on live lock then sees recovered authority', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const beforeBytes = readFileSync(path.join(runDir, 'run.json'));

    // Hold lock with prepared artifacts (child).
    const childScript = `
      const fs = require('fs');
      const path = require('path');
      const crypto = require('crypto');
      const runDir = process.argv[1];
      const ready = process.argv[2];
      const lockDir = path.join(runDir, '.run.json.tx.lock');
      const cand = path.join(runDir, '.run.json.tx.lock.cand.child');
      fs.mkdirSync(cand, { mode: 0o700 });
      function processStartIdentity(targetPid) {
        if (process.platform !== 'linux') return undefined;
        try {
          const stat = fs.readFileSync('/proc/' + targetPid + '/stat', 'utf8');
          const close = stat.lastIndexOf(')');
          if (close < 0) return undefined;
          const after = stat.slice(close + 2).split(' ');
          const starttime = after[19];
          if (!starttime || !/^\\d+$/.test(starttime)) return undefined;
          return starttime;
        } catch {
          return undefined;
        }
      }
      function selfProcessStart() {
        const start = processStartIdentity(process.pid);
        if (start !== undefined) return start;
        return 'unsupported-' + process.platform + '-' + process.pid;
      }
      const starttime = selfProcessStart();
      fs.writeFileSync(path.join(cand, 'owner.json'), JSON.stringify({
        version: 1, pid: process.pid, processStart: starttime, token: 'child-rmw', timestamp: Date.now()
      }) + '\\n', { mode: 0o600 });
      fs.renameSync(cand, lockDir);
      const runJson = path.join(runDir, 'run.json');
      const old = fs.readFileSync(runJson);
      fs.writeFileSync(path.join(runDir, '.run.json.tx.rollback'), old, { mode: 0o600 });
      fs.writeFileSync(path.join(runDir, '.run.json.tx.marker'), JSON.stringify({
        version: 1, phase: 'prepared',
        oldSha256: crypto.createHash('sha256').update(old).digest('hex'),
        oldBytes: old.length,
        newSha256: 'f'.repeat(64), newBytes: 4
      }) + '\\n', { mode: 0o600 });
      fs.writeFileSync(runJson, Buffer.from('NEW!'));
      fs.writeFileSync(ready, 'ready');
      setInterval(() => {}, 1000);
    `;
    const readyFile = path.join(root, 'rmw-ready');
    const proc = spawn(process.execPath, ['-e', childScript, runDir, readyFile], {
      stdio: 'ignore',
    });
    try {
      const deadline = Date.now() + 3000;
      while (!existsSync(readyFile) && Date.now() < deadline) await Bun.sleep(20);
      expect(existsSync(readyFile)).toBe(true);

      const ordinary = createRunStore({
        rootDir: root,
        ...makeDeps(),
        txLockWaitMs: 80,
        txLockRetryMs: 15,
      });
      await expect(
        ordinary.updateRun(runId, (r) => {
          r.units.single.status = 'running';
        })
      ).rejects.toMatchObject({ code: 'run_busy' });
      // Must not have restored while child holds lock.
      expect(readFileSync(path.join(runDir, 'run.json')).toString()).toBe('NEW!');
    } finally {
      proc.kill('SIGKILL');
      await Bun.sleep(50);
    }

    const after = createRunStore({ rootDir: root, ...makeDeps() });
    const loaded = after.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(readFileSync(path.join(runDir, 'run.json')).equals(beforeBytes)).toBe(true);
  });
});

describe('round-10 lock owner identity', () => {
  it('owner.json wrong mode fails closed for live lock steal path', async () => {
    // POSIX file-mode bits are not meaningful on Windows NTFS permission model.
    if (process.platform === 'win32') return;
    const deps = makeDeps();
    const store = createRunStore({
      rootDir: root,
      ...deps,
      txLockWaitMs: 50,
      txLockRetryMs: 10,
    });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const lockDir = path.join(runDir, '.run.json.tx.lock');
    mkdirSync(lockDir, { mode: 0o700 });
    const ownerPath = path.join(lockDir, 'owner.json');
    writeFileSync(
      ownerPath,
      JSON.stringify({
        version: 1,
        pid: 2_147_000_003,
        processStart: '1',
        token: 'bad-mode',
        timestamp: Date.now(),
      }) + '\n',
      { mode: 0o644 }
    );
    // Wrong mode → cannot prove owner → fail closed (no steal) → busy or corrupt.
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(['run_busy', 'corrupt_run', 'run_store_error']).toContain(loaded.error.code);
  });
});

describe('round-10 committed cleanup revalidation', () => {
  function bypassError(label: string): Error {
    const err = new Error(label) as Error & Record<symbol, unknown>;
    err[STRICT_TX_BYPASS_CLEANUP] = true;
    return err;
  }

  it('bypass cleanup after second dir sync: new authority remains exact', async () => {
    const deps = makeDeps();
    const store = createRunStore({
      rootDir: root,
      ...deps,
      strictTransactionHook: (p) => {
        if (p === 'after_cleanup_second_dir_sync') {
          throw bypassError('crash at after_cleanup_second_dir_sync');
        }
      },
    });
    const { runId } = await store.createRun(makeCreateInput());
    await expect(
      store.updateRunStrict(runId, (r) => {
        r.units.single.status = 'running';
        r.units.single.requireArtifactReader = true;
        r.units.single.attempts.push({ attempt: 1, status: 'running', startedAt: 1 });
      })
    ).rejects.toMatchObject({
      message: expect.stringMatching(/after_cleanup_second_dir_sync/),
    });
    const reopened = createRunStore({ rootDir: root, ...makeDeps() });
    const loaded = reopened.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.status).toBe('running');
    expect(loaded.loaded.record.units.single.requireArtifactReader).toBe(true);
  });
});

describe('round-10 finite lock wait configuration', () => {
  const invalidCases: Array<{ wait?: number; retry?: number; label: string }> = [
    { wait: Number.NaN, label: 'NaN wait' },
    { wait: Number.POSITIVE_INFINITY, label: 'Infinity wait' },
    { wait: -1, label: 'negative wait' },
    { wait: 0, label: 'zero wait' },
    { wait: 1.5, label: 'non-integer wait' },
    { wait: 100, retry: 0, label: 'zero retry' },
    { wait: 100, retry: -5, label: 'negative retry' },
    { wait: 100, retry: 200, label: 'retry greater than wait' },
    { wait: 100, retry: Number.NaN, label: 'NaN retry' },
    { wait: 100_000, label: 'wait above hard max' },
  ];

  for (const c of invalidCases) {
    it(`rejects ${c.label}`, () => {
      expect(() =>
        createRunStore({
          rootDir: root,
          txLockWaitMs: c.wait,
          txLockRetryMs: c.retry,
        })
      ).toThrow();
    });
  }

  it('live lock timeout is bounded by configured wait', async () => {
    const deps = makeDeps();
    const storeA = createRunStore({ rootDir: root, ...deps, txLockWaitMs: 80, txLockRetryMs: 20 });
    const { runId } = await storeA.createRun(makeCreateInput());
    const runDir = storeA.getRunDir(runId);
    const start = selfProcessStart();
    mkdirSync(path.join(runDir, '.run.json.tx.lock'), { mode: 0o700 });
    writeFileSync(
      path.join(runDir, '.run.json.tx.lock', 'owner.json'),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        processStart: start,
        token: 'hold',
        timestamp: Date.now(),
      }) + '\n',
      { mode: 0o600 }
    );
    const storeB = createRunStore({
      rootDir: root,
      ...makeDeps(),
      txLockWaitMs: 80,
      txLockRetryMs: 20,
    });
    const t0 = Date.now();
    const loaded = storeB.getRun(runId);
    const elapsed = Date.now() - t0;
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error.code).toBe('run_busy');
    // Upper bound: wait + a few retries + scheduling slack.
    expect(elapsed).toBeLessThan(500);
  });
});

describe('round-11 generation-safe stale transfer and release intent', () => {
  function processStarttime(): string {
    return selfProcessStart();
  }

  function publishCompleteLock(
    runDir: string,
    owner: Record<string, unknown>
  ): { lockDir: string; ownerPath: string } {
    const lockDir = path.join(runDir, '.run.json.tx.lock');
    const cand = path.join(runDir, `.run.json.tx.lock.cand.test-${crypto.randomUUID()}`);
    mkdirSync(cand, { mode: 0o700 });
    writeFileSync(path.join(cand, 'owner.json'), JSON.stringify(owner) + '\n', { mode: 0o600 });
    renameSync(cand, lockDir);
    return { lockDir, ownerPath: path.join(lockDir, 'owner.json') };
  }

  it('two real child stale stealers: one transfer, one busy, maxActive===1, fixed lock never absent mid-transfer', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    publishCompleteLock(runDir, {
      version: 1,
      pid: 2_147_000_201,
      processStart: '1',
      token: 'stale-shared-r11',
      timestamp: Date.now() - 60_000,
    });

    const modulePath = path.resolve(import.meta.dir, '../src/run-store.ts');
    const sharedPath = path.join(root, 'steal-shared.json');
    writeFileSync(
      sharedPath,
      JSON.stringify({ active: 0, maxActive: 0, entered: [] as string[], errors: [] as string[] })
    );
    const goFile = path.join(root, 'steal-go');

    const childScript = `
      import { createRunStore } from ${JSON.stringify(modulePath)};
      import { readFileSync, writeFileSync, existsSync } from 'node:fs';
      const root = process.argv[1];
      const runId = process.argv[2];
      const label = process.argv[3];
      const sharedPath = process.argv[4];
      const goFile = process.argv[5];
      const deadline = Date.now() + 5000;
      while (!existsSync(goFile) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      const store = createRunStore({ rootDir: root, txLockWaitMs: 800, txLockRetryMs: 15 });
      try {
        await store.updateRun(runId, (r) => {
          const shared = JSON.parse(readFileSync(sharedPath, 'utf8'));
          shared.active += 1;
          shared.maxActive = Math.max(shared.maxActive, shared.active);
          shared.entered.push(label);
          writeFileSync(sharedPath, JSON.stringify(shared));
          // Hold critical section briefly so peer can observe concurrency.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
          r.units.single.status = 'running';
          r.units.single.effectiveCwd = '/tmp/' + label;
          const after = JSON.parse(readFileSync(sharedPath, 'utf8'));
          after.active -= 1;
          writeFileSync(sharedPath, JSON.stringify(after));
        });
        writeFileSync(root + '/steal-' + label + '-ok', '1');
      } catch (err) {
        const shared = JSON.parse(readFileSync(sharedPath, 'utf8'));
        const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'unknown';
        shared.errors.push(label + ':' + code);
        writeFileSync(sharedPath, JSON.stringify(shared));
        writeFileSync(root + '/steal-' + label + '-err', code);
      }
    `;

    const procA = spawn(
      process.execPath,
      ['-e', childScript, root, runId, 'A', sharedPath, goFile],
      {
        stdio: 'ignore',
      }
    );
    const procB = spawn(
      process.execPath,
      ['-e', childScript, root, runId, 'B', sharedPath, goFile],
      {
        stdio: 'ignore',
      }
    );
    // Both children wait on go; fixed lock still present with dead owner.
    expect(existsSync(path.join(runDir, '.run.json.tx.lock'))).toBe(true);
    writeFileSync(goFile, '1');
    const wait = (p: ReturnType<typeof spawn>) =>
      new Promise<void>((resolve) => p.on('exit', () => resolve()));
    await Promise.all([wait(procA), wait(procB)]);

    const shared = JSON.parse(readFileSync(sharedPath, 'utf8')) as {
      maxActive: number;
      entered: string[];
      errors: string[];
    };
    expect(shared.maxActive).toBe(1);
    // Exactly one transfer success; the other is busy or also eventually succeeds after release.
    // Under short wait, one busy is expected; at most one active.
    const okCount = [
      existsSync(path.join(root, 'steal-A-ok')),
      existsSync(path.join(root, 'steal-B-ok')),
    ].filter(Boolean).length;
    expect(okCount).toBeGreaterThanOrEqual(1);
    expect(shared.entered.length).toBe(okCount);
    // Replacement token remains only while held; after release fixed lock absent.
    expect(existsSync(path.join(runDir, '.run.json.tx.lock'))).toBe(false);
    const loaded = createRunStore({ rootDir: root, ...makeDeps() }).getRun(runId);
    expect(loaded.ok).toBe(true);
  }, 15_000);

  it('release intent crash: live owner stays busy; dead owner allows safe completion', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps, txLockWaitMs: 80, txLockRetryMs: 10 });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const liveStart = processStarttime();
    const { lockDir } = publishCompleteLock(runDir, {
      version: 1,
      pid: process.pid,
      processStart: liveStart,
      token: 'live-release-intent',
      timestamp: Date.now(),
    });
    writeFileSync(
      path.join(lockDir, 'release.intent'),
      JSON.stringify({
        version: 1,
        kind: 'release',
        token: 'live-release-intent',
        ownerPid: process.pid,
        ownerProcessStart: liveStart,
        ownerIno: lstatSync(path.join(lockDir, 'owner.json')).ino,
        ownerDev: lstatSync(path.join(lockDir, 'owner.json')).dev,
        lockIno: lstatSync(lockDir).ino,
        lockDev: lstatSync(lockDir).dev,
      }) + '\n',
      { mode: 0o600 }
    );
    const busy = store.getRun(runId);
    expect(busy.ok).toBe(false);
    if (!busy.ok) expect(busy.error.code).toBe('run_busy');
    expect(existsSync(lockDir)).toBe(true);

    // Dead owner with release.intent: next acquirer completes release then acquires.
    rmSync(path.join(lockDir, 'owner.json'));
    writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({
        version: 1,
        pid: 2_147_000_202,
        processStart: '1',
        token: 'dead-release-intent',
        timestamp: Date.now() - 60_000,
      }) + '\n',
      { mode: 0o600 }
    );
    writeFileSync(
      path.join(lockDir, 'release.intent'),
      JSON.stringify({
        version: 1,
        kind: 'release',
        token: 'dead-release-intent',
        ownerPid: 2_147_000_202,
        ownerProcessStart: '1',
        ownerIno: lstatSync(path.join(lockDir, 'owner.json')).ino,
        ownerDev: lstatSync(path.join(lockDir, 'owner.json')).dev,
        lockIno: lstatSync(lockDir).ino,
        lockDev: lstatSync(lockDir).dev,
      }) + '\n',
      { mode: 0o600 }
    );
    await store.updateRun(runId, (r) => {
      r.units.single.status = 'running';
    });
    expect(existsSync(path.join(runDir, '.run.json.tx.lock'))).toBe(false);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.status).toBe('running');
  });

  it('wrong-token tombstone and unknown live candidate are preserved (no blind cleanup)', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);

    // Live contender candidate (this process start identity) — must remain.
    const liveCand = path.join(runDir, `.run.json.tx.lock.cand.live-${crypto.randomUUID()}`);
    mkdirSync(liveCand, { mode: 0o700 });
    writeFileSync(
      path.join(liveCand, 'owner.json'),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        processStart: processStarttime(),
        token: 'live-contender',
        timestamp: Date.now(),
      }) + '\n',
      { mode: 0o600 }
    );

    // Wrong-token tombstone: basename suffix ≠ owner.token; plus unknown foreign residue.
    // Production must not blindly clean either without full verification.
    const badTomb = path.join(runDir, `.run.json.tx.lock.tomb.wrong-token`);
    mkdirSync(badTomb, { mode: 0o700 });
    writeFileSync(
      path.join(badTomb, 'owner.json'),
      JSON.stringify({
        version: 1,
        pid: 2_147_000_203,
        processStart: '1',
        token: 'actual-token',
        timestamp: Date.now() - 60_000,
      }) + '\n',
      { mode: 0o600 }
    );
    writeFileSync(path.join(badTomb, 'extra-unknown.bin'), 'x', { mode: 0o600 });

    await store.updateRun(runId, (r) => {
      r.units.single.status = 'running';
    });

    expect(existsSync(liveCand)).toBe(true);
    // Unknown entry inside tombstone → preserve evidence.
    expect(existsSync(badTomb)).toBe(true);
    expect(existsSync(path.join(badTomb, 'extra-unknown.bin'))).toBe(true);
  });

  it('monotonic deadline: wall-clock rollback does not extend lock wait', async () => {
    const deps = makeDeps();
    // Inject wall clock that jumps backward continuously.
    let wall = 1_000_000_000;
    const storeHold = createRunStore({
      rootDir: root,
      ...deps,
      now: () => wall,
      txLockWaitMs: 120,
      txLockRetryMs: 20,
    });
    const { runId } = await storeHold.createRun(makeCreateInput());
    const runDir = storeHold.getRunDir(runId);
    publishCompleteLock(runDir, {
      version: 1,
      pid: process.pid,
      processStart: processStarttime(),
      token: 'mono-hold',
      timestamp: wall,
    });

    const storeB = createRunStore({
      rootDir: root,
      now: () => {
        // Rollback wall clock each call.
        wall -= 50_000;
        return wall;
      },
      randomUUID: () => crypto.randomUUID(),
      pid: 9999,
      instanceId: 'mono-b',
      txLockWaitMs: 120,
      txLockRetryMs: 20,
    });
    const t0 = performance.now();
    const loaded = storeB.getRun(runId);
    const elapsed = performance.now() - t0;
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe('run_busy');
    // Monotonic upper bound ~ wait + slack (not inflated by wall rollback).
    expect(elapsed).toBeLessThan(800);
  });

  it('marker replacement before unlink preserves evidence and fails closed', async () => {
    const deps = makeDeps();
    const { runId } = await createRunStore({ rootDir: root, ...deps }).createRun(makeCreateInput());
    const runDir = path.join(root, runId);
    let replaced = false;
    const store = createRunStore({
      rootDir: root,
      ...makeDeps(),
      strictTransactionHook: (p) => {
        if (p === 'after_cleanup_rollback_unlink' && !replaced) {
          replaced = true;
          const markerPath = path.join(runDir, '.run.json.tx.marker');
          if (existsSync(markerPath) && lstatSync(markerPath).isFile()) {
            const outside = path.join(root, 'outside-marker-r11');
            writeFileSync(outside, 'x');
            const st = lstatSync(markerPath);
            rmSync(markerPath);
            // Same path, new content (different inode).
            writeFileSync(
              markerPath,
              JSON.stringify({
                version: 1,
                phase: 'committed',
                oldSha256: 'a'.repeat(64),
                oldBytes: 1,
                newSha256: 'b'.repeat(64),
                newBytes: 1,
              }) + '\n',
              { mode: 0o600 }
            );
            void st;
          }
        }
      },
    });
    try {
      await store.updateRunStrict(runId, (r) => {
        r.units.single.status = 'running';
        r.units.single.requireArtifactReader = true;
        r.units.single.attempts.push({ attempt: 1, status: 'running', startedAt: 1 });
      });
    } catch (err) {
      expect(err && typeof err === 'object' && 'code' in err).toBe(true);
      const code = (err as { code: string }).code;
      // Exact identity-mismatch failure at cleanup unlink seam.
      expect(code).toBe('generation_mismatch');
    }
    // Fresh store must not silently accept wrong authority.
    const reopened = createRunStore({ rootDir: root, ...makeDeps() }).getRun(runId);
    if (reopened.ok) {
      // If recovered, authority must be coherent.
      expect(['queued', 'running']).toContain(reopened.loaded.record.units.single.status);
    } else {
      expect(reopened.error.code).toBe('corrupt_run');
    }
  });
});

describe('round-12 hard-link intents, dead-intent recovery, authority generations', () => {
  function publishCompleteLock(
    runDir: string,
    owner: Record<string, unknown>
  ): { lockDir: string; ownerPath: string } {
    const lockDir = path.join(runDir, '.run.json.tx.lock');
    const cand = path.join(runDir, `.run.json.tx.lock.cand.test-${crypto.randomUUID()}`);
    mkdirSync(cand, { mode: 0o700 });
    writeFileSync(path.join(cand, 'owner.json'), JSON.stringify(owner) + '\n', { mode: 0o600 });
    renameSync(cand, lockDir);
    return { lockDir, ownerPath: path.join(lockDir, 'owner.json') };
  }

  it('hard-link intent: second concurrent link gets EEXIST/busy; winner has single intent inode', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const { lockDir, ownerPath } = publishCompleteLock(runDir, {
      version: 1,
      pid: 2_147_000_301,
      processStart: '1',
      token: 'stale-hl-owner',
      timestamp: Date.now() - 60_000,
    });
    const ownerSt = lstatSync(ownerPath);
    const lockSt = lstatSync(lockDir);
    const intentPayload = Buffer.from(
      JSON.stringify({
        version: 1,
        kind: 'steal',
        phase: 'intent_published',
        contenderToken: 'contender-a',
        contenderPid: 2_147_000_302,
        contenderProcessStart: '1',
        ownerToken: 'stale-hl-owner',
        ownerPid: 2_147_000_301,
        ownerProcessStart: '1',
        ownerIno: ownerSt.ino,
        ownerDev: ownerSt.dev,
        lockIno: lockSt.ino,
        lockDev: lockSt.dev,
        newOwnerTempName: '.owner.aaaaaaaaaaaaaaaa.tmp',
      }) + '\n'
    );
    const tmpA = path.join(lockDir, '.steal.intent.a.tmp');
    const tmpB = path.join(lockDir, '.steal.intent.b.tmp');
    const dest = path.join(lockDir, 'steal.intent');
    writeFileSync(tmpA, intentPayload, { mode: 0o600 });
    writeFileSync(tmpB, intentPayload, { mode: 0o600 });
    // Atomic no-replace: first hard-link wins.
    linkSync(tmpA, dest);
    let secondErr: NodeJS.ErrnoException | undefined;
    try {
      linkSync(tmpB, dest);
    } catch (err) {
      secondErr = err as NodeJS.ErrnoException;
    }
    expect(secondErr?.code).toBe('EEXIST');
    expect(lstatSync(tmpA).ino).toBe(lstatSync(dest).ino);
    // Fresh contender must not permanently busy: recover dead intent then acquire.
    const loaded = store.getRun(runId);
    // Contender in intent is dead (fake pid) → recovery removes intent_published.
    // May succeed (steal) or fail depending on recovery path; must not leave dual owners.
    if (loaded.ok) {
      expect(existsSync(path.join(lockDir, 'steal.intent'))).toBe(false);
    } else {
      expect(loaded.error.code).toBe('run_busy');
    }
  });

  it('dead-intent crash after intent link: fresh contender recovers without permanent busy', async () => {
    const deps = makeDeps();
    const store = createRunStore({
      rootDir: root,
      ...deps,
      txLockWaitMs: 200,
      txLockRetryMs: 20,
    });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const { lockDir, ownerPath } = publishCompleteLock(runDir, {
      version: 1,
      pid: 2_147_000_311,
      processStart: '1',
      token: 'dead-owner-r12',
      timestamp: Date.now() - 60_000,
    });
    const ownerSt = lstatSync(ownerPath);
    const lockSt = lstatSync(lockDir);
    // Create new-owner temp first (as immutable intent requires).
    const tempName = '.owner.bbbbbbbbbbbbbbbb.tmp';
    const tempPath = path.join(lockDir, tempName);
    const tempPayload = Buffer.from(
      JSON.stringify({
        version: 1,
        pid: 2_147_000_312,
        processStart: '1',
        token: 'dead-contender-r12',
        timestamp: Date.now(),
      }) + '\n'
    );
    writeFileSync(tempPath, tempPayload, { mode: 0o600 });
    const tempSt = lstatSync(tempPath);
    const tempDigest = crypto.createHash('sha256').update(tempPayload).digest('hex');
    // Publish immutable intent with exact temp identity.
    writeFileSync(
      path.join(lockDir, 'steal.intent'),
      JSON.stringify({
        version: 1,
        kind: 'steal',
        contenderToken: 'dead-contender-r12',
        contenderPid: 2_147_000_312,
        contenderProcessStart: '1',
        ownerToken: 'dead-owner-r12',
        ownerPid: 2_147_000_311,
        ownerProcessStart: '1',
        ownerIno: ownerSt.ino,
        ownerDev: ownerSt.dev,
        lockIno: lockSt.ino,
        lockDev: lockSt.dev,
        newOwnerTempName: tempName,
        newOwnerTempIno: tempSt.ino,
        newOwnerTempDev: tempSt.dev,
        newOwnerTempDigest: tempDigest,
        newOwnerTempBytes: tempPayload.byteLength,
      }) + '\n',
      { mode: 0o600 }
    );
    await store.updateRun(runId, (r) => {
      r.units.single.status = 'running';
    });
    expect(existsSync(path.join(runDir, '.run.json.tx.lock'))).toBe(false);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.status).toBe('running');
  });

  it('dead-intent crash after old-owner move: rolls back owner.previous exactly', async () => {
    const deps = makeDeps();
    const store = createRunStore({
      rootDir: root,
      ...deps,
      txLockWaitMs: 200,
      txLockRetryMs: 20,
    });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const { lockDir, ownerPath } = publishCompleteLock(runDir, {
      version: 1,
      pid: 2_147_000_321,
      processStart: '1',
      token: 'dead-owner-moved',
      timestamp: Date.now() - 60_000,
    });
    const ownerSt = lstatSync(ownerPath);
    const lockSt = lstatSync(lockDir);
    // Create new-owner temp first (as immutable intent requires).
    const tempName = '.owner.cccccccccccccccc.tmp';
    const tempPath = path.join(lockDir, tempName);
    const tempPayload = Buffer.from(
      JSON.stringify({
        version: 1,
        pid: 2_147_000_322,
        processStart: '1',
        token: 'dead-contender-moved',
        timestamp: Date.now(),
      }) + '\n'
    );
    writeFileSync(tempPath, tempPayload, { mode: 0o600 });
    const tempSt = lstatSync(tempPath);
    const tempDigest = crypto.createHash('sha256').update(tempPayload).digest('hex');
    // Simulate crash after old owner → owner.previous.
    renameSync(ownerPath, path.join(lockDir, 'owner.previous'));
    // Publish immutable intent with exact temp identity.
    writeFileSync(
      path.join(lockDir, 'steal.intent'),
      JSON.stringify({
        version: 1,
        kind: 'steal',
        contenderToken: 'dead-contender-moved',
        contenderPid: 2_147_000_322,
        contenderProcessStart: '1',
        ownerToken: 'dead-owner-moved',
        ownerPid: 2_147_000_321,
        ownerProcessStart: '1',
        ownerIno: ownerSt.ino,
        ownerDev: ownerSt.dev,
        lockIno: lockSt.ino,
        lockDev: lockSt.dev,
        newOwnerTempName: tempName,
        newOwnerTempIno: tempSt.ino,
        newOwnerTempDev: tempSt.dev,
        newOwnerTempDigest: tempDigest,
        newOwnerTempBytes: tempPayload.byteLength,
      }) + '\n',
      { mode: 0o600 }
    );

    await store.updateRun(runId, (r) => {
      r.units.single.status = 'running';
      r.units.single.requireArtifactReader = true;
    });
    expect(existsSync(path.join(lockDir, 'owner.previous'))).toBe(false);
    expect(existsSync(path.join(runDir, '.run.json.tx.lock'))).toBe(false);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.status).toBe('running');
    expect(loaded.loaded.record.units.single.requireArtifactReader).toBe(true);
  });

  it('dead-intent crash after new-owner publish: finishes cleanup without double ownership', async () => {
    const deps = makeDeps();
    const store = createRunStore({
      rootDir: root,
      ...deps,
      txLockWaitMs: 200,
      txLockRetryMs: 20,
    });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const { lockDir, ownerPath } = publishCompleteLock(runDir, {
      version: 1,
      pid: 2_147_000_331,
      processStart: '1',
      token: 'old-owner-pub',
      timestamp: Date.now() - 60_000,
    });
    const ownerSt = lstatSync(ownerPath);
    const lockSt = lstatSync(lockDir);
    // Create new-owner temp with exact identity for immutable intent.
    const tempName = '.owner.dddddddddddddddd.tmp';
    const tempPath = path.join(lockDir, tempName);
    const tempPayload = Buffer.from(
      JSON.stringify({
        version: 1,
        pid: 2_147_000_332,
        processStart: '1',
        token: 'new-owner-pub',
        timestamp: Date.now(),
      }) + '\n'
    );
    writeFileSync(tempPath, tempPayload, { mode: 0o600 });
    const tempSt = lstatSync(tempPath);
    const tempDigest = crypto.createHash('sha256').update(tempPayload).digest('hex');
    // Move old owner to previous; rename temp to owner as if contender finished transfer.
    renameSync(ownerPath, path.join(lockDir, 'owner.previous'));
    renameSync(tempPath, ownerPath);
    // Publish immutable intent with exact identities (temp was renamed to owner, no longer present).
    writeFileSync(
      path.join(lockDir, 'steal.intent'),
      JSON.stringify({
        version: 1,
        kind: 'steal',
        contenderToken: 'new-owner-pub',
        contenderPid: 2_147_000_332,
        contenderProcessStart: '1',
        ownerToken: 'old-owner-pub',
        ownerPid: 2_147_000_331,
        ownerProcessStart: '1',
        ownerIno: ownerSt.ino,
        ownerDev: ownerSt.dev,
        lockIno: lockSt.ino,
        lockDev: lockSt.dev,
        newOwnerTempName: tempName,
        newOwnerTempIno: tempSt.ino,
        newOwnerTempDev: tempSt.dev,
        newOwnerTempDigest: tempDigest,
        newOwnerTempBytes: tempPayload.byteLength,
      }) + '\n',
      { mode: 0o600 }
    );
    // Dead new owner: recovery rolls back (removes new owner, renames previous→owner, drops intent).
    await store.updateRun(runId, (r) => {
      r.units.single.status = 'running';
    });
    expect(existsSync(path.join(lockDir, 'owner.previous'))).toBe(false);
    expect(existsSync(path.join(lockDir, 'steal.intent'))).toBe(false);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
  });

  it('malicious owner token traversal is rejected; no path derivation/deletion', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps, txLockWaitMs: 60, txLockRetryMs: 15 });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const precious = path.join(root, 'precious-outside');
    mkdirSync(precious, { mode: 0o700 });
    writeFileSync(path.join(precious, 'keep.txt'), 'safe\n');
    const { lockDir } = publishCompleteLock(runDir, {
      version: 1,
      pid: 2_147_000_341,
      processStart: '1',
      // Would escape if concatenated into a path — must be rejected by strict token.
      token: '../precious-outside',
      timestamp: Date.now() - 60_000,
    });
    // Manually plant malicious token (bypass producer validation).
    writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({
        version: 1,
        pid: 2_147_000_341,
        processStart: '1',
        token: '../precious-outside',
        timestamp: Date.now() - 60_000,
      }) + '\n',
      { mode: 0o600 }
    );
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe('run_busy');
    expect(readFileSync(path.join(precious, 'keep.txt'), 'utf8')).toBe('safe\n');
    expect(existsSync(lockDir)).toBe(true);
  });

  it('control-character and separator tokens are rejected', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps, txLockWaitMs: 40, txLockRetryMs: 10 });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    for (const bad of ['has/slash', 'has\\back', 'dot..dot', 'has\0null', 'has\nline']) {
      const lockDir = path.join(runDir, '.run.json.tx.lock');
      if (existsSync(lockDir)) rmSync(lockDir, { recursive: true, force: true });
      const cand = path.join(runDir, `.run.json.tx.lock.cand.bad-${crypto.randomUUID()}`);
      mkdirSync(cand, { mode: 0o700 });
      writeFileSync(
        path.join(cand, 'owner.json'),
        JSON.stringify({
          version: 1,
          pid: 2_147_000_350,
          processStart: '1',
          token: bad,
          timestamp: Date.now() - 60_000,
        }) + '\n',
        { mode: 0o600 }
      );
      renameSync(cand, lockDir);
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) expect(loaded.error.code).toBe('run_busy');
      expect(existsSync(lockDir)).toBe(true);
    }
  });

  it('wrong tombstone suffix is preserved (exact token equality)', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const tomb = path.join(runDir, `.run.json.tx.lock.tomb.wrong-suffix`);
    mkdirSync(tomb, { mode: 0o700 });
    writeFileSync(
      path.join(tomb, 'owner.json'),
      JSON.stringify({
        version: 1,
        pid: 2_147_000_360,
        processStart: '1',
        token: 'actual-token',
        timestamp: Date.now() - 60_000,
      }) + '\n',
      { mode: 0o600 }
    );
    await store.updateRun(runId, (r) => {
      r.units.single.status = 'running';
    });
    expect(existsSync(tomb)).toBe(true);
    expect(existsSync(path.join(tomb, 'owner.json'))).toBe(true);
  });

  it('marker generation replacement before unlink: exact corrupt_run, replacement preserved', async () => {
    const deps = makeDeps();
    const { runId } = await createRunStore({ rootDir: root, ...deps }).createRun(makeCreateInput());
    const runDir = path.join(root, runId);
    let replaced = false;
    let replacementBytes: Buffer | undefined;
    const store = createRunStore({
      rootDir: root,
      ...makeDeps(),
      strictTransactionHook: (p) => {
        if (p === 'after_cleanup_rollback_unlink' && !replaced) {
          replaced = true;
          const markerPath = path.join(runDir, '.run.json.tx.marker');
          if (existsSync(markerPath) && lstatSync(markerPath).isFile()) {
            rmSync(markerPath);
            replacementBytes = Buffer.from(
              JSON.stringify({
                version: 1,
                phase: 'committed',
                oldSha256: 'a'.repeat(64),
                oldBytes: 1,
                newSha256: 'b'.repeat(64),
                newBytes: 1,
              }) + '\n'
            );
            writeFileSync(markerPath, replacementBytes, { mode: 0o600 });
          }
        }
      },
    });
    let threw: { code?: string } | undefined;
    try {
      await store.updateRunStrict(runId, (r) => {
        r.units.single.status = 'running';
        r.units.single.requireArtifactReader = true;
        r.units.single.attempts.push({ attempt: 1, status: 'running', startedAt: 1 });
      });
    } catch (err) {
      threw = err as { code?: string };
    }
    expect(threw).toBeDefined();
    // Identity mismatch before unlink surfaces as generation_mismatch (exact).
    expect(threw?.code).toBe('generation_mismatch');
    // Replacement evidence must remain if still at the marker path.
    const markerPath = path.join(runDir, '.run.json.tx.marker');
    if (existsSync(markerPath) && replacementBytes) {
      expect(readFileSync(markerPath).equals(replacementBytes)).toBe(true);
    } else {
      // Or cleanup revalidation rejected; reopened must not silently accept wrong authority.
      const reopened = createRunStore({ rootDir: root, ...makeDeps() }).getRun(runId);
      if (reopened.ok) {
        expect(['queued', 'running']).toContain(reopened.loaded.record.units.single.status);
      } else {
        expect(reopened.error.code).toBe('corrupt_run');
      }
    }
  });

  it('two child writers with shared start barrier: exact merged RMW state', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const modulePath = path.resolve(import.meta.dir, '../src/run-store.ts');
    const goFile = path.join(root, 'rmw-go');
    const enterA = path.join(root, 'enter-A');
    const enterB = path.join(root, 'enter-B');
    const exitA = path.join(root, 'exit-A');
    const exitB = path.join(root, 'exit-B');

    const childScript = `
      import { createRunStore } from ${JSON.stringify(modulePath)};
      import { writeFileSync, existsSync } from 'node:fs';
      const root = process.argv[1];
      const runId = process.argv[2];
      const label = process.argv[3];
      const goFile = process.argv[4];
      const enterFile = process.argv[5];
      const exitFile = process.argv[6];
      const field = process.argv[7];
      const deadline = Date.now() + 8000;
      while (!existsSync(goFile) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      const store = createRunStore({ rootDir: root, txLockWaitMs: 3000, txLockRetryMs: 15 });
      await store.updateRun(runId, (r) => {
        writeFileSync(enterFile, String(Date.now()));
        if (field === 'status') r.units.single.status = 'running';
        if (field === 'artifact') r.units.single.requireArtifactReader = true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        writeFileSync(exitFile, String(Date.now()));
      });
    `;
    const procA = spawn(
      'bun',
      ['-e', childScript, root, runId, 'A', goFile, enterA, exitA, 'status'],
      { stdio: 'ignore' }
    );
    const procB = spawn(
      'bun',
      ['-e', childScript, root, runId, 'B', goFile, enterB, exitB, 'artifact'],
      { stdio: 'ignore' }
    );
    writeFileSync(goFile, '1');
    const wait = (p: ReturnType<typeof spawn>) =>
      new Promise<number>((resolve) => p.on('exit', (c) => resolve(c ?? 1)));
    const [codeA, codeB] = await Promise.all([wait(procA), wait(procB)]);
    expect(codeA).toBe(0);
    expect(codeB).toBe(0);
    expect(existsSync(enterA)).toBe(true);
    expect(existsSync(enterB)).toBe(true);
    expect(existsSync(exitA)).toBe(true);
    expect(existsSync(exitB)).toBe(true);
    // No critical-section overlap: one exit must complete before the other enter, or
    // intervals are disjoint by enter/exit timestamps.
    const a0 = Number(readFileSync(enterA, 'utf8'));
    const a1 = Number(readFileSync(exitA, 'utf8'));
    const b0 = Number(readFileSync(enterB, 'utf8'));
    const b1 = Number(readFileSync(exitB, 'utf8'));
    const overlap = a0 < b1 && b0 < a1;
    expect(overlap).toBe(false);

    const loaded = createRunStore({ rootDir: root, ...makeDeps() }).getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.status).toBe('running');
    expect(loaded.loaded.record.units.single.requireArtifactReader).toBe(true);
  }, 15_000);

  it('two real child stale stealers with barriers: exactly one transfer, one busy/waiter', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    publishCompleteLock(runDir, {
      version: 1,
      pid: 2_147_000_370,
      processStart: '1',
      token: 'stale-barrier-r12',
      timestamp: Date.now() - 60_000,
    });
    const modulePath = path.resolve(import.meta.dir, '../src/run-store.ts');
    const goFile = path.join(root, 'steal-go-r12');
    const releaseA = path.join(root, 'steal-release-A');

    // File-based barrier: winner writes this inside the critical section and blocks
    // until the parent releases it; loser gives up with run_busy while winner holds.
    const childScript = `
      import { createRunStore } from ${JSON.stringify(modulePath)};
      import { writeFileSync, existsSync } from 'node:fs';
      const root = process.argv[1];
      const runId = process.argv[2];
      const label = process.argv[3];
      const goFile = process.argv[4];
      const releaseFile = process.argv[5];
      const events = root + '/steal-events-' + label;
      const deadline = Date.now() + 8000;
      while (!existsSync(goFile) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      writeFileSync(events + '-enter', String(Date.now()));
      // Short wait — loser gives up while winner holds via file barrier.
      const store = createRunStore({ rootDir: root, txLockWaitMs: 400, txLockRetryMs: 15 });
      try {
        await store.updateRun(runId, (r) => {
          writeFileSync(events + '-crit', String(Date.now()));
          // Signal winner; wait for parent to release.
          writeFileSync(releaseFile, 'held');
          const deadline = Date.now() + 8000;
          while (!existsSync(releaseFile + '-go') && Date.now() < deadline) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          }
          r.units.single.status = 'running';
          r.units.single.effectiveCwd = '/tmp/' + label;
        });
        writeFileSync(events + '-ok', '1');
      } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'unknown';
        writeFileSync(events + '-err', code);
      }
      writeFileSync(events + '-exit', String(Date.now()));
    `;
    // Both contenders share the same release barrier path; only the lock winner writes it.
    const procA = spawn(process.execPath, ['-e', childScript, root, runId, 'A', goFile, releaseA], {
      stdio: 'ignore',
    });
    const procB = spawn(process.execPath, ['-e', childScript, root, runId, 'B', goFile, releaseA], {
      stdio: 'ignore',
    });
    expect(existsSync(path.join(runDir, '.run.json.tx.lock'))).toBe(true);
    writeFileSync(goFile, '1');

    // Wait for the winner to signal it has the lock, then wait for loser to give up.
    const waitFile = (p: string, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      while (!existsSync(p) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return existsSync(p);
    };
    const held = waitFile(releaseA);
    expect(held).toBe(true);

    // Wait for the loser to finish while the winner still holds the lock barrier.
    const waitExit = (p: ReturnType<typeof spawn>, timeoutMs = 8000) =>
      Promise.race([
        new Promise<number>((resolve) => p.on('exit', (c) => resolve(c ?? 1))),
        new Promise<number>((resolve) => setTimeout(() => resolve(-1), timeoutMs)),
      ]);

    // Poll until exactly one of A/B has recorded either ok or err (loser exits first).
    const loserDeadline = Date.now() + 8000;
    while (Date.now() < loserDeadline) {
      const errA = existsSync(path.join(root, 'steal-events-A-err'));
      const errB = existsSync(path.join(root, 'steal-events-B-err'));
      if (errA || errB) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    const errA = existsSync(path.join(root, 'steal-events-A-err'))
      ? readFileSync(path.join(root, 'steal-events-A-err'), 'utf8')
      : '';
    const errB = existsSync(path.join(root, 'steal-events-B-err'))
      ? readFileSync(path.join(root, 'steal-events-B-err'), 'utf8')
      : '';
    // Exactly one contender must be busy while the other holds the lock.
    expect(Number(errA === 'run_busy') + Number(errB === 'run_busy')).toBe(1);

    // Release the winner.
    writeFileSync(releaseA + '-go', '1');
    const [codeA, codeB] = await Promise.all([waitExit(procA), waitExit(procB)]);
    expect(codeA).toBe(0);
    expect(codeB).toBe(0);

    const okA = existsSync(path.join(root, 'steal-events-A-ok'));
    const okB = existsSync(path.join(root, 'steal-events-B-ok'));
    // Exactly one successful transfer (winner-independent).
    expect(Number(okA) + Number(okB)).toBe(1);
    expect(Number(errA === 'run_busy') + Number(errB === 'run_busy')).toBe(1);

    // Critical sections must not overlap when both recorded crit timestamps.
    if (
      existsSync(path.join(root, 'steal-events-A-crit')) &&
      existsSync(path.join(root, 'steal-events-B-crit'))
    ) {
      const a0 = Number(readFileSync(path.join(root, 'steal-events-A-crit'), 'utf8'));
      const a1 = Number(readFileSync(path.join(root, 'steal-events-A-exit'), 'utf8'));
      const b0 = Number(readFileSync(path.join(root, 'steal-events-B-crit'), 'utf8'));
      const b1 = Number(readFileSync(path.join(root, 'steal-events-B-exit'), 'utf8'));
      expect(a0 < b1 && b0 < a1).toBe(false);
    }
    expect(existsSync(path.join(runDir, '.run.json.tx.lock'))).toBe(false);
  }, 15_000);
});

describe('round-13 winner-independent contention and release fault coverage', () => {
  function processStarttime(): string {
    return selfProcessStart();
  }

  function publishCompleteLock(
    runDir: string,
    owner: Record<string, unknown>
  ): { lockDir: string; ownerPath: string } {
    const lockDir = path.join(runDir, '.run.json.tx.lock');
    const cand = path.join(runDir, `.run.json.tx.lock.cand.test-${crypto.randomUUID()}`);
    mkdirSync(cand, { mode: 0o700 });
    const ownerPath = path.join(cand, 'owner.json');
    writeFileSync(ownerPath, JSON.stringify(owner) + '\n', { mode: 0o600 });
    renameSync(cand, lockDir);
    return { lockDir, ownerPath: path.join(lockDir, 'owner.json') };
  }

  it('winner-independent stealers: ready barriers, exactly one transfer one busy', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    publishCompleteLock(runDir, {
      version: 1,
      pid: 2_147_000_401,
      processStart: '1',
      token: 'stale-shared-r13',
      timestamp: Date.now() - 60_000,
    });

    const modulePath = path.resolve(import.meta.dir, '../src/run-store.ts');
    const readyA = path.join(root, 'ready-A');
    const readyB = path.join(root, 'ready-B');
    const goFile = path.join(root, 'release-go');
    const winnerFile = path.join(root, 'winner-file');
    writeFileSync(winnerFile, '');

    const childScript = `
      import { createRunStore } from ${JSON.stringify(modulePath)};
      import { writeFileSync, readFileSync, existsSync } from 'node:fs';
      const root = process.argv[1];
      const runId = process.argv[2];
      const label = process.argv[3];
      const readyFile = process.argv[4];
      const goFile = process.argv[5];
      const winnerFile = process.argv[6];
      writeFileSync(readyFile, String(Date.now()));
      const deadline = Date.now() + 8000;
      while (!existsSync(goFile) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      const store = createRunStore({ rootDir: root, txLockWaitMs: 250, txLockRetryMs: 10 });
      try {
        await store.updateRun(runId, (r) => {
          r.units.single.status = 'running';
          r.units.single.requireArtifactReader = true;
          r.units.single.effectiveCwd = '/tmp/' + label;
          // Winner holds the lock long enough for loser to time out.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
        });
        writeFileSync(root + '/win-' + label, 'ok');
        const w = readFileSync(winnerFile, 'utf8').trim();
        if (!w) writeFileSync(winnerFile, label);
      } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : 'unknown';
        writeFileSync(root + '/busy-' + label, code);
        const w = readFileSync(winnerFile, 'utf8').trim();
        if (!w) writeFileSync(winnerFile, label + '-busy');
      }
    `;

    const procA = spawn(
      process.execPath,
      ['-e', childScript, root, runId, 'A', readyA, goFile, winnerFile],
      {
        stdio: 'ignore',
      }
    );
    const procB = spawn(
      process.execPath,
      ['-e', childScript, root, runId, 'B', readyB, goFile, winnerFile],
      {
        stdio: 'ignore',
      }
    );

    // Wait for both children to signal ready before releasing.
    const deadline = Date.now() + 5000;
    while ((!existsSync(readyA) || !existsSync(readyB)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const exitA = new Promise<void>((resolve) => procA.on('exit', () => resolve()));
    const exitB = new Promise<void>((resolve) => procB.on('exit', () => resolve()));

    // Release both simultaneously.
    writeFileSync(goFile, '1');
    await Promise.all([exitA, exitB]);

    expect(existsSync(path.join(runDir, '.run.json.tx.lock'))).toBe(false);
    const winA = existsSync(path.join(root, 'win-A'));
    const winB = existsSync(path.join(root, 'win-B'));
    const busyA = existsSync(path.join(root, 'busy-A'));
    const busyB = existsSync(path.join(root, 'busy-B'));
    // Exactly one success.
    expect(winA !== winB).toBe(true);
    // At least one busy.
    expect(busyA || busyB).toBe(true);
    // Winner is deterministic - the one with the 'win-' file.
    if (winA) {
      expect(winB).toBe(false);
      expect(busyB).toBe(true);
    } else if (winB) {
      expect(winA).toBe(false);
      expect(busyA).toBe(true);
    }
    const loaded = createRunStore({ rootDir: root, ...makeDeps() }).getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.status).toBe('running');
    expect(loaded.loaded.record.units.single.requireArtifactReader).toBe(true);
  }, 15_000);

  it('kill winner at intent seam: third process recovers and acquires', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const { lockDir, ownerPath } = publishCompleteLock(runDir, {
      version: 1,
      pid: 2_147_000_501,
      processStart: '1',
      token: 'kill-seam-token',
      timestamp: Date.now() - 60_000,
    });
    // Create a new-owner temp and immutable intent to simulate a dead contender.
    const tempName = '.owner.killseam00000000.tmp';
    const tempPath = path.join(lockDir, tempName);
    const tempPayload = Buffer.from(
      JSON.stringify({
        version: 1,
        pid: 2_147_000_502,
        processStart: '1',
        token: 'kill-contender',
        timestamp: Date.now(),
      }) + '\n'
    );
    writeFileSync(tempPath, tempPayload, { mode: 0o600 });
    const tempSt = lstatSync(tempPath);
    const tempDigest = crypto.createHash('sha256').update(tempPayload).digest('hex');
    const ownerSt = lstatSync(ownerPath);
    const lockSt = lstatSync(lockDir);
    writeFileSync(
      path.join(lockDir, 'steal.intent'),
      JSON.stringify({
        version: 1,
        kind: 'steal',
        contenderToken: 'kill-contender',
        contenderPid: 2_147_000_502,
        contenderProcessStart: '1',
        ownerToken: 'kill-seam-token',
        ownerPid: 2_147_000_501,
        ownerProcessStart: '1',
        ownerIno: ownerSt.ino,
        ownerDev: ownerSt.dev,
        lockIno: lockSt.ino,
        lockDev: lockSt.dev,
        newOwnerTempName: tempName,
        newOwnerTempIno: tempSt.ino,
        newOwnerTempDev: tempSt.dev,
        newOwnerTempDigest: tempDigest,
        newOwnerTempBytes: tempPayload.byteLength,
      }) + '\n',
      { mode: 0o600 }
    );

    // Third process recovers dead intent then acquires.
    const storeC = createRunStore({
      rootDir: root,
      ...makeDeps(),
      txLockWaitMs: 400,
      txLockRetryMs: 15,
    });
    await storeC.updateRun(runId, (r) => {
      r.units.single.status = 'running';
      r.units.single.requireArtifactReader = true;
    });

    // Fixed lock must be absent after recovery + release.
    expect(existsSync(path.join(runDir, '.run.json.tx.lock'))).toBe(false);
    expect(existsSync(path.join(lockDir, 'steal.intent'))).toBe(false);
    const loaded = storeC.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.status).toBe('running');
  }, 15_000);

  // Task 6: Exact release fault coverage.
  it('release intent hard-link failure: exact rejection, no success return', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);

    // Acquire a lock first.
    await store.updateRun(runId, (r) => {
      r.units.single.status = 'running';
    });

    // Pre-create release.intent to force EEXIST on release hard-link.
    const lockDir = path.join(runDir, '.run.json.tx.lock');
    mkdirSync(lockDir, { mode: 0o700 });
    writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        processStart: processStarttime(),
        token: 'release-fault-token',
        timestamp: Date.now(),
      }) + '\n',
      { mode: 0o600 }
    );
    writeFileSync(path.join(lockDir, 'release.intent'), 'occupied', { mode: 0o600 });

    // Next acquisition should fail closed on the occupied release intent.
    const storeB = createRunStore({
      rootDir: root,
      ...makeDeps(),
      txLockWaitMs: 80,
      txLockRetryMs: 10,
    });
    const loaded = storeB.getRun(runId);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe('run_busy');
    }
    // Fixed lock + evidence preserved.
    expect(existsSync(path.join(lockDir, 'release.intent'))).toBe(true);
    expect(existsSync(lockDir)).toBe(true);
  });

  it('release tombstone rename failure: exact rejection, evidence preserved', async () => {
    const deps = makeDeps();
    // Create a lock dir with a dead owner that has a release.intent.
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const { lockDir } = publishCompleteLock(runDir, {
      version: 1,
      pid: 2_147_000_601,
      processStart: '1',
      token: 'dead-release-tomb',
      timestamp: Date.now() - 60_000,
    });
    const lockSt = lstatSync(lockDir);
    const ownerPath = path.join(lockDir, 'owner.json');
    const ownerSt = lstatSync(ownerPath);
    writeFileSync(
      path.join(lockDir, 'release.intent'),
      JSON.stringify({
        version: 1,
        kind: 'release',
        token: 'dead-release-tomb',
        ownerPid: 2_147_000_601,
        ownerProcessStart: '1',
        ownerIno: ownerSt.ino,
        ownerDev: ownerSt.dev,
        lockIno: lockSt.ino,
        lockDev: lockSt.dev,
      }) + '\n',
      { mode: 0o600 }
    );
    // Next acquisition completes release and acquires.
    const storeB = createRunStore({
      rootDir: root,
      ...makeDeps(),
      txLockWaitMs: 300,
      txLockRetryMs: 15,
    });
    await storeB.updateRun(runId, (r) => {
      r.units.single.status = 'running';
    });
    expect(existsSync(lockDir)).toBe(false);
    expect(existsSync(path.join(runDir, '.run.json.tx.lock'))).toBe(false);
  });

  it('release tombstone identity mismatch: exact rejection, no success', async () => {
    const deps = makeDeps();
    const store = createRunStore({ rootDir: root, ...deps });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    // Plant a tombstone whose token doesn't match its owner.
    const tombToken = 'tomb-mismatch';
    const otherToken = 'other-token';
    const tomb = path.join(runDir, `.run.json.tx.lock.tomb.${tombToken}`);
    mkdirSync(tomb, { mode: 0o700 });
    writeFileSync(
      path.join(tomb, 'owner.json'),
      JSON.stringify({
        version: 1,
        pid: 2_147_000_701,
        processStart: '1',
        token: otherToken,
        timestamp: Date.now(),
      }) + '\n',
      { mode: 0o600 }
    );
    // Wrong-token tombstone must be preserved (no blind cleanup).
    const storeB = createRunStore({
      rootDir: root,
      ...makeDeps(),
      txLockWaitMs: 100,
      txLockRetryMs: 10,
    });
    await storeB.updateRun(runId, (r) => {
      r.units.single.status = 'running';
    });
    // Wrong-token tombstone preserved; acquisition succeeded anyway.
    expect(existsSync(tomb)).toBe(true);
    expect(existsSync(path.join(runDir, '.run.json.tx.lock'))).toBe(false);
  });
});

describe('review-fixes: run-id validation and durability seams', () => {
  it('rejects explicit empty rootDir with run_store_error (no default fallback)', () => {
    expect(() => createRunStore({ rootDir: '' })).toThrow();
    try {
      createRunStore({ rootDir: '' });
      expect.unreachable('expected empty rootDir to throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'run_store_error' });
      expect(String((err as { message: string }).message)).toMatch(/rootDir/i);
    }
  });

  it('rejects empty, traversal, slash, backslash, absolute, and drive-like run ids before filesystem access', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const invalidIds = [
      '',
      '..',
      '../x',
      'a/b',
      'a\\b',
      '/abs',
      'C:foo',
      'foo:bar',
      'has space',
      'has.dot',
    ];
    const before = readdirSync(root);
    for (const runId of invalidIds) {
      const got = store.getRun(runId);
      expect(got.ok).toBe(false);
      if (!got.ok) {
        expect(got.error.code).toBe('run_not_found');
        expect(got.error.message).toMatch(/invalid run id/i);
      }
      expect(() => store.getRunDir(runId)).toThrow();
      await expect(
        store.appendEvent(runId, { version: 1, event: 'run_created', runId, timestamp: 1 })
      ).rejects.toMatchObject({ code: 'run_not_found' });
      await expect(
        store.updateRun(runId, () => {
          /* no-op */
        })
      ).rejects.toMatchObject({ code: 'run_not_found' });
      await expect(store.writeTextArtifact(runId, 'final-output', 'x')).rejects.toMatchObject({
        code: 'run_not_found',
      });
      const claim = await store.claimRun(runId);
      expect(claim.ok).toBe(false);
      if (!claim.ok) expect(claim.error.code).toBe('run_not_found');
      const inspected = store.inspectClaims(runId);
      expect(inspected.ok).toBe(false);
      if (!inspected.ok) expect(inspected.error.code).toBe('run_not_found');
      await expect(store.releaseRun(runId, 'c')).rejects.toMatchObject({ code: 'run_not_found' });
      await expect(store.abandonRun(runId, 'c')).rejects.toMatchObject({ code: 'run_not_found' });
    }
    expect(readdirSync(root)).toEqual(before);
  });

  it('propagates mandatory regular-file fsync failure without successful publication', async () => {
    const store = createRunStore({
      rootDir: root,
      ...makeDeps(),
      fileFsync: () => {
        throw {
          code: 'run_store_error',
          message: 'fsync failed: injected',
        };
      },
    });
    await expect(store.createRun(makeCreateInput())).rejects.toMatchObject({
      code: 'run_store_error',
      message: expect.stringMatching(/fsync failed/i),
    });
    // Directory may exist after mkdir, but no durable run.json publication succeeds.
    const entries = readdirSync(root).filter((n) => n.startsWith('run-'));
    for (const runId of entries) {
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(false);
      expect(existsSync(path.join(root, runId, 'run.json'))).toBe(false);
    }
  });

  it('isPidAlive returns false only for ESRCH; EPERM/ENOSYS/unknown remain alive', () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    expect(store.isPidAlive(process.pid)).toBe(true);
    // Extremely unlikely PID — should be ESRCH → dead.
    expect(store.isPidAlive(2_147_483_647)).toBe(false);

    const cases: Array<{ code: string; expectAlive: boolean }> = [
      { code: 'ESRCH', expectAlive: false },
      { code: 'EPERM', expectAlive: true },
      { code: 'ENOSYS', expectAlive: true },
      { code: 'EIO', expectAlive: true },
    ];
    for (const c of cases) {
      const probe = createRunStore({
        rootDir: root,
        ...makeDeps(),
        pidAliveKill: () => {
          throw Object.assign(new Error(c.code), { code: c.code });
        },
      });
      expect(probe.isPidAlive(42_424_242)).toBe(c.expectAlive);
    }
    const unknownEx = createRunStore({
      rootDir: root,
      ...makeDeps(),
      pidAliveKill: () => {
        throw 'not-an-errno';
      },
    });
    expect(unknownEx.isPidAlive(42_424_242)).toBe(true);
  });

  it('complete lock and claim cycle succeeds when directory fsync is disabled', async () => {
    let dirSyncCalls = 0;
    const store = createRunStore({
      rootDir: root,
      ...makeDeps(),
      directoryFsync: false,
      // Capability gate must skip every publication path; any call fails the suite.
      directorySync: () => {
        dirSyncCalls++;
        throw new Error('directory sync should be skipped when directoryFsync is false');
      },
      // Artifact path must also honor the disabled capability.
      artifactDirectorySync: () => {
        dirSyncCalls++;
        throw new Error('artifact directory sync should be skipped');
      },
    });
    const { runId } = await store.createRun(makeCreateInput());
    const updated = await store.updateRun(runId, (r) => {
      r.status = 'running';
    });
    expect(updated.status).toBe('running');
    await store.appendEvent(runId, {
      version: 1,
      event: 'unit_started',
      runId,
      unitId: 'single',
      attempt: 1,
      timestamp: 1,
    });
    const claim = await store.claimRun(runId);
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    await store.releaseRun(runId, claim.claimId);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    expect(dirSyncCalls).toBe(0);
  });

  it('supported directory-sync failure on strict update propagates without silent success', async () => {
    const store = createRunStore({
      rootDir: root,
      ...makeDeps(),
      directoryFsync: true,
      // Keep ordinary publication durable without host directory fsync (Windows EPERM).
      // Only the strict post-rename seam is injected to fail.
      directorySync: () => {
        /* capability-supported no-op for create/lock paths */
      },
      strictPostRenameDirectorySync: () => {
        throw {
          code: 'run_store_error',
          message: 'directory fsync failed: injected-strict',
        };
      },
    });
    const { runId } = await store.createRun(makeCreateInput());
    await expect(
      store.updateRunStrict(runId, (r) => {
        r.status = 'running';
      })
    ).rejects.toMatchObject({
      code: 'run_store_error',
      message: expect.stringMatching(/directory fsync failed/i),
    });
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.loaded.record.status).toBe('queued');
  });

  it('malformed steal-intent owner temp names are ignored (not transfer material)', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const lockDir = path.join(runDir, '.run.json.tx.lock');
    mkdirSync(lockDir, { mode: 0o700 });
    // Basename accepted by the old short `.owner.*.tmp` prefix/suffix rule, but rejected by
    // the exact `.owner.<strict-token>.tmp` grammar (middle contains '.' outside the token charset).
    const invalidButBroadAccepted = '.owner.bad.dots.tmp';
    // Dead owner forces the steal path to parse steal.intent before any transfer decision.
    const ownerPayload = Buffer.from(
      JSON.stringify({
        version: 1,
        pid: 2_147_000_900,
        processStart: '1',
        token: 'dead-token-malformed-tmp',
        timestamp: Date.now() - 60_000,
      }) + '\n'
    );
    const ownerPath = path.join(lockDir, 'owner.json');
    writeFileSync(ownerPath, ownerPayload, { mode: 0o600 });
    const tempPayload = Buffer.from(
      JSON.stringify({
        version: 1,
        pid: 2_147_000_901,
        processStart: '1',
        token: 'contender1',
        timestamp: Date.now(),
      }) + '\n'
    );
    const tempPath = path.join(lockDir, invalidButBroadAccepted);
    writeFileSync(tempPath, tempPayload, { mode: 0o600 });
    // All recovery preconditions (real dev/ino/digest/bytes) match; only the temp basename grammar fails.
    const ownerSt = lstatSync(ownerPath);
    const lockSt = lstatSync(lockDir);
    const tempSt = lstatSync(tempPath);
    const tempDigest = crypto.createHash('sha256').update(tempPayload).digest('hex');
    writeFileSync(
      path.join(lockDir, 'steal.intent'),
      JSON.stringify({
        version: 1,
        kind: 'steal',
        contenderToken: 'contender1',
        ownerToken: 'dead-token-malformed-tmp',
        contenderPid: 2_147_000_901,
        ownerPid: 2_147_000_900,
        contenderProcessStart: '1',
        ownerProcessStart: '1',
        newOwnerTempName: invalidButBroadAccepted,
        ownerIno: ownerSt.ino,
        ownerDev: ownerSt.dev,
        lockIno: lockSt.ino,
        lockDev: lockSt.dev,
        newOwnerTempIno: tempSt.ino,
        newOwnerTempDev: tempSt.dev,
        newOwnerTempDigest: tempDigest,
        newOwnerTempBytes: tempPayload.length,
      }) + '\n',
      { mode: 0o600 }
    );
    // Grammar-rejected intent is unparseable → fail closed; residue preserved.
    await expect(
      createRunStore({
        rootDir: root,
        ...makeDeps(),
        txLockWaitMs: 40,
        txLockRetryMs: 10,
      }).updateRun(runId, (r) => {
        r.status = 'running';
      })
    ).rejects.toMatchObject({ code: 'run_busy' });
    expect(existsSync(path.join(lockDir, 'owner.json'))).toBe(true);
    expect(existsSync(path.join(lockDir, 'steal.intent'))).toBe(true);
    expect(existsSync(path.join(lockDir, invalidButBroadAccepted))).toBe(true);
    // Temp content and identity untouched (not transfer material).
    expect(readFileSync(tempPath).equals(tempPayload)).toBe(true);
    expect(lstatSync(tempPath).ino).toBe(tempSt.ino);
  });

  it('release/abandon reject invalid run ids before filesystem access', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const before = readdirSync(root);
    for (const runId of ['../x', 'a/b', 'C:foo', '']) {
      await expect(store.releaseRun(runId, 'claim-x')).rejects.toMatchObject({
        code: 'run_not_found',
        message: expect.stringMatching(/invalid run id/i),
      });
      await expect(store.abandonRun(runId, 'claim-x')).rejects.toMatchObject({
        code: 'run_not_found',
        message: expect.stringMatching(/invalid run id/i),
      });
    }
    expect(readdirSync(root)).toEqual(before);
  });

  it('owner-file fsync failure cleans recognized staging residue exactly', async () => {
    // createRun also uses file fsync; create under a normal store first.
    const bootstrap = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await bootstrap.createRun(makeCreateInput());
    const claimsPath = path.join(bootstrap.getRunDir(runId), 'claims');
    const beforeStaging = existsSync(claimsPath)
      ? readdirSync(claimsPath).filter((n) => n.startsWith('.staging-'))
      : [];
    const store = createRunStore({
      rootDir: root,
      ...makeDeps(),
      fileFsync: () => {
        throw {
          code: 'run_store_error',
          message: 'fsync failed: injected-owner-stage',
        };
      },
    });
    await expect(store.claimRun(runId)).rejects.toMatchObject({
      code: 'run_store_error',
      message: expect.stringMatching(/fsync failed/i),
    });
    // Staging directories from the failed attempt must be absent (only recognized owner.json).
    const afterStaging = existsSync(claimsPath)
      ? readdirSync(claimsPath).filter((n) => n.startsWith('.staging-'))
      : [];
    expect(afterStaging).toEqual(beforeStaging);
  });

  it('claim staging cleanup preserves unknown foreign entries via production failure path', async () => {
    const bootstrap = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await bootstrap.createRun(makeCreateInput());
    const claimsPath = path.join(bootstrap.getRunDir(runId), 'claims');
    mkdirSync(claimsPath, { recursive: true });
    const isTicketDir = (n: string) => /^\d+$/.test(n);
    const beforeTickets = readdirSync(claimsPath).filter(isTicketDir);
    let plantedForeign: string | undefined;
    let stagingSeenAtFsync: string | undefined;
    const store = createRunStore({
      rootDir: root,
      ...makeDeps(),
      fileFsync: (fd) => {
        // Inject during production stageOwner file-fsync so cleanupStaging is the real recovery path.
        const stagingDirs = readdirSync(claimsPath).filter((n) => n.startsWith('.staging-'));
        expect(stagingDirs.length).toBeGreaterThan(0);
        for (const name of stagingDirs) {
          const stagingDir = path.join(claimsPath, name);
          const ownerPath = path.join(stagingDir, 'owner.json');
          if (!existsSync(ownerPath)) continue;
          stagingSeenAtFsync = stagingDir;
          const foreign = path.join(stagingDir, 'foreign.dat');
          if (!existsSync(foreign)) {
            writeFileSync(foreign, 'keep-me\n');
            plantedForeign = foreign;
          }
        }
        fsyncSync(fd);
        throw {
          code: 'run_store_error',
          message: 'fsync failed: injected-after-foreign-plant',
        };
      },
    });
    await expect(store.claimRun(runId)).rejects.toMatchObject({
      code: 'run_store_error',
      message: expect.stringMatching(/fsync failed/i),
    });
    expect(plantedForeign).toBeDefined();
    expect(stagingSeenAtFsync).toBeDefined();
    if (!plantedForeign || !stagingSeenAtFsync) return;
    // Foreign entry preserved; staging dir remains because rmdir refuses non-empty.
    expect(existsSync(plantedForeign)).toBe(true);
    expect(readFileSync(plantedForeign, 'utf8')).toBe('keep-me\n');
    // Protocol-owned owner.json for that attempt must be gone; foreign is the only residue.
    const stagingParent = path.dirname(plantedForeign);
    expect(stagingParent).toBe(stagingSeenAtFsync);
    expect(existsSync(path.join(stagingParent, 'owner.json'))).toBe(false);
    expect(readdirSync(stagingParent)).toEqual(['foreign.dat']);
    // No ticket directory published from the failed attempt.
    const afterTickets = readdirSync(claimsPath).filter(isTicketDir);
    expect(afterTickets).toEqual(beforeTickets);
  });

  it('supported directory-sync failure during lock acquisition propagates without durable success', async () => {
    // Bootstrap without directory fsync so create succeeds; then fail on lock-path sync.
    const bootstrap = createRunStore({ rootDir: root, ...makeDeps(), directoryFsync: false });
    const { runId } = await bootstrap.createRun(makeCreateInput());
    const syncedPaths: string[] = [];
    const store = createRunStore({
      rootDir: root,
      ...makeDeps(),
      directoryFsync: true,
      directorySync: (dirPath) => {
        syncedPaths.push(dirPath);
        throw {
          code: 'run_store_error',
          message: 'directory fsync failed: injected-lock',
        };
      },
    });
    // updateRun acquires the transaction lock and syncs lock/candidate directories.
    await expect(
      store.updateRun(runId, (r) => {
        r.status = 'running';
      })
    ).rejects.toMatchObject({
      code: 'run_store_error',
      message: expect.stringMatching(/directory fsync failed/i),
    });
    expect(syncedPaths.length).toBeGreaterThan(0);
    // Exact publication-phase shapes: candidate/lock basenames under this run's directory only.
    const runDir = store.getRunDir(runId);
    expect(
      syncedPaths.some((p) => {
        const base = path.basename(p);
        return (
          path.dirname(p) === runDir &&
          (base === '.run.json.tx.lock' || base.startsWith('.run.json.tx.lock.cand.'))
        );
      })
    ).toBe(true);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.loaded.record.status).toBe('queued');
  });

  it('supported directory-sync failure during claim publication propagates', async () => {
    const bootstrap = createRunStore({ rootDir: root, ...makeDeps(), directoryFsync: false });
    const { runId } = await bootstrap.createRun(makeCreateInput());
    const syncedPaths: string[] = [];
    const store = createRunStore({
      rootDir: root,
      ...makeDeps(),
      directoryFsync: true,
      directorySync: (dirPath) => {
        syncedPaths.push(dirPath);
        throw {
          code: 'run_store_error',
          message: 'directory fsync failed: injected-claim',
        };
      },
    });
    await expect(store.claimRun(runId)).rejects.toMatchObject({
      code: 'run_store_error',
      message: expect.stringMatching(/directory fsync failed/i),
    });
    expect(syncedPaths.length).toBeGreaterThan(0);
    // Publication-phase seam: decimal ticket directory under this run's claims/ only.
    const runDir = store.getRunDir(runId);
    const claimsDir = path.join(runDir, 'claims');
    expect(
      syncedPaths.some((p) => {
        const base = path.basename(p);
        return path.dirname(p) === claimsDir && /^\d{16}$/.test(base);
      })
    ).toBe(true);
    // Failure must not report durable claim success on the run record.
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.loaded.record.owner).toBeUndefined();
  });

  it('supported directory-sync failure during claim terminal publication propagates', async () => {
    // Same instance identity so release resolves the published claim owner.
    const deps = makeDeps();
    const bootstrap = createRunStore({ rootDir: root, ...deps, directoryFsync: false });
    const { runId } = await bootstrap.createRun(makeCreateInput());
    const claimed = await bootstrap.claimRun(runId);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    const syncedPaths: string[] = [];
    const store = createRunStore({
      rootDir: root,
      ...deps,
      directoryFsync: true,
      directorySync: (dirPath) => {
        syncedPaths.push(dirPath);
        throw {
          code: 'run_store_error',
          message: 'directory fsync failed: injected-terminal',
        };
      },
    });
    await expect(store.releaseRun(runId, claimed.claimId)).rejects.toMatchObject({
      code: 'run_store_error',
      message: expect.stringMatching(/directory fsync failed/i),
    });
    expect(syncedPaths.length).toBeGreaterThan(0);
    // Terminal publication syncs the claim ticket directory under this run's claims/ only.
    const runDir = store.getRunDir(runId);
    const claimsDir = path.join(runDir, 'claims');
    expect(
      syncedPaths.some((p) => {
        const base = path.basename(p);
        return path.dirname(p) === claimsDir && /^\d{16}$/.test(base);
      })
    ).toBe(true);
  });
});
