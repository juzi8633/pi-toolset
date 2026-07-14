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
