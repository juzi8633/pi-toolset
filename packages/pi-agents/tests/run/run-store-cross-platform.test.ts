// ABOUTME: Cross-platform pathname RunStore smoke coverage for transactions, locks, claims.
// ABOUTME: Uses real child processes and filesystem barriers; no proc-fd or no-follow requirements.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  createRunStore,
  getDefaultRunsRoot,
  STRICT_TX_BYPASS_CLEANUP,
  type CreateRunStoreOptions,
} from '../../src/run/run-store.ts';
import { resolveRunsRoot } from '../../src/run/run-store-paths.ts';

function tmpRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'pi-agents-runstore-xp-'));
}

let root: string;
let seq = 0;

function makeDeps(): Pick<CreateRunStoreOptions, 'now' | 'randomUUID' | 'pid' | 'instanceId'> {
  let t = 2_000_000;
  const base = seq++;
  return {
    now: () => t++,
    randomUUID: () => `xp-${base}-${t}`,
    pid: process.pid,
    instanceId: `xp-inst-${base}`,
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
      task: 'cross-platform',
    },
    details: {
      mode: 'single' as const,
      agentScope: 'both' as const,
      projectAgentsDir: null,
      builtinAgentsDir: '/builtin',
      results: [],
    },
    units: {
      single: {
        unitId: 'single',
        agent: 'noop',
        agentFingerprint: 'fp',
        runtime: undefined,
        capability: 'session' as const,
        status: 'queued' as const,
        attempt: 1,
        attempts: [],
        effectiveCwd: process.cwd(),
      },
    },
  };
}

function knownLeftovers(runDir: string): string[] {
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir).filter(
    (n) =>
      n.startsWith('.run.json.tx.') ||
      n.endsWith('.tmp') ||
      n.startsWith('.owner.') ||
      n.includes('.cand.') ||
      n.includes('.tomb.')
  );
}

beforeEach(() => {
  root = tmpRoot();
});
afterEach(() => {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe('cross-platform root resolution', () => {
  it('never places defaults under os.tmpdir()', () => {
    const homeDir = path.posix.join('/', 'home', 'pi-agents-user');
    const resolved = resolveRunsRoot({
      platform: 'linux',
      env: {},
      homeDir,
      cwd: path.posix.join('/', 'work'),
    });
    expect(resolved.startsWith(os.tmpdir())).toBe(false);
    expect(resolved).toBe(
      path.posix.join(homeDir, '.local', 'state', '@balaenis', 'pi-agents', 'runs')
    );
  });

  it('getDefaultRunsRoot is absolute', () => {
    expect(path.isAbsolute(getDefaultRunsRoot())).toBe(true);
  });
});

describe('cross-platform create/load/update', () => {
  it('round-trips a run and leaves no protocol leftovers', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId, record } = await store.createRun(makeCreateInput());
    expect(record.status).toBe('queued');

    const updated = await store.updateRun(runId, (r) => {
      r.status = 'running';
      r.units.single.status = 'running';
    });
    expect(updated.status).toBe('running');

    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.status).toBe('running');
    expect(loaded.loaded.record.units.single.status).toBe('running');
    expect(knownLeftovers(store.getRunDir(runId))).toEqual([]);
  });

  it('rejects traversal run ids before path join', () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const bad = store.getRun(`..${path.sep}escape`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('run_not_found');
  });

  it('lists runs and surfaces resume fields', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const a = await store.createRun(makeCreateInput());
    const b = await store.createRun(makeCreateInput());
    await store.updateRun(a.runId, (r) => {
      r.status = 'interrupted';
    });
    const listed = await store.listRuns();
    expect(listed.length).toBeGreaterThanOrEqual(2);
    const ids = listed.map((entry) =>
      'record' in entry ? entry.record.runId : 'runId' in entry ? entry.runId : ''
    );
    expect(ids).toContain(a.runId);
    expect(ids).toContain(b.runId);
  });
});

describe('cross-platform crash recovery', () => {
  it('prepared crash restores old authority', async () => {
    const deps = makeDeps();
    const store = createRunStore({
      rootDir: root,
      ...deps,
      strictTransactionHook: (phase) => {
        if (phase === 'after_prepared_marker') {
          const err = new Error('crash-prepared') as Error & Record<symbol, unknown>;
          err[STRICT_TX_BYPASS_CLEANUP] = true;
          throw err;
        }
      },
    });
    const { runId } = await store.createRun(makeCreateInput());
    const before = readFileSync(path.join(store.getRunDir(runId), 'run.json'));

    await expect(
      store.updateRunStrict(runId, (r) => {
        r.status = 'running';
      })
    ).rejects.toBeDefined();

    const recovered = createRunStore({ rootDir: root, ...makeDeps() }).getRun(runId);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.loaded.record.status).toBe('queued');
    expect(readFileSync(path.join(store.getRunDir(runId), 'run.json')).equals(before)).toBe(true);
    expect(knownLeftovers(store.getRunDir(runId))).toEqual([]);
  });

  it('committed crash keeps new authority and cleans leftovers', async () => {
    const deps = makeDeps();
    const store = createRunStore({
      rootDir: root,
      ...deps,
      strictTransactionHook: (phase) => {
        if (phase === 'after_committed_marker') {
          const err = new Error('crash-committed') as Error & Record<symbol, unknown>;
          err[STRICT_TX_BYPASS_CLEANUP] = true;
          throw err;
        }
      },
    });
    const { runId } = await store.createRun(makeCreateInput());
    await expect(
      store.updateRunStrict(runId, (r) => {
        r.status = 'running';
      })
    ).rejects.toBeDefined();

    const recovered = createRunStore({ rootDir: root, ...makeDeps() }).getRun(runId);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.loaded.record.status).toBe('running');
    expect(knownLeftovers(store.getRunDir(runId))).toEqual([]);
  });
});

describe('cross-platform locking and liveness', () => {
  it('live owner is not stolen within the wait window', async () => {
    const modulePath = path.resolve(import.meta.dir, '../../src/run/run-store.ts');
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const holdFile = path.join(root, 'hold-go');
    const enteredFile = path.join(root, 'holder-entered');

    const holderScript = `
      import { createRunStore } from ${JSON.stringify(modulePath)};
      import { writeFileSync, existsSync } from 'node:fs';
      const root = process.argv[1];
      const runId = process.argv[2];
      const enteredFile = process.argv[3];
      const holdFile = process.argv[4];
      const store = createRunStore({ rootDir: root, txLockWaitMs: 5000, txLockRetryMs: 20 });
      await store.updateRun(runId, (r) => {
        writeFileSync(enteredFile, '1');
        const deadline = Date.now() + 8000;
        while (!existsSync(holdFile) && Date.now() < deadline) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        r.status = 'running';
      });
    `;
    const holder = spawn(
      process.execPath,
      ['-e', holderScript, root, runId, enteredFile, holdFile],
      {
        stdio: 'ignore',
      }
    );

    const waitFile = (p: string, ms = 8000) => {
      const deadline = Date.now() + ms;
      while (!existsSync(p) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return existsSync(p);
    };
    expect(waitFile(enteredFile)).toBe(true);

    const contender = createRunStore({
      rootDir: root,
      ...makeDeps(),
      txLockWaitMs: 80,
      txLockRetryMs: 10,
    });
    await expect(
      contender.updateRun(runId, (r) => {
        r.status = 'failed';
      })
    ).rejects.toMatchObject({ code: 'run_busy' });

    writeFileSync(holdFile, '1');
    await new Promise<void>((resolve) => holder.on('exit', () => resolve()));
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.loaded.record.status).toBe('running');
  }, 15_000);

  it('exited child owner is recoverable by a successor', async () => {
    const modulePath = path.resolve(import.meta.dir, '../../src/run/run-store.ts');
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    const crashMarker = path.join(root, 'child-crashed');

    const childScript = `
      import { createRunStore, STRICT_TX_BYPASS_CLEANUP } from ${JSON.stringify(modulePath)};
      import { writeFileSync } from 'node:fs';
      const root = process.argv[1];
      const runId = process.argv[2];
      const crashMarker = process.argv[3];
      const store = createRunStore({
        rootDir: root,
        strictTransactionHook: (phase) => {
          if (phase === 'after_prepared_marker') {
            writeFileSync(crashMarker, '1');
            const err = new Error('child-crash');
            err[STRICT_TX_BYPASS_CLEANUP] = true;
            throw err;
          }
        },
      });
      try {
        await store.updateRunStrict(runId, (r) => {
          r.status = 'running';
        });
      } catch {
        // Natural termination: set exitCode and return so the process ends without forced exit.
        process.exitCode = 2;
      }
    `;
    const child = spawn(process.execPath, ['-e', childScript, root, runId, crashMarker], {
      stdio: 'ignore',
    });
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    expect(existsSync(crashMarker)).toBe(true);

    const successor = createRunStore({ rootDir: root, ...makeDeps() });
    const recovered = successor.getRun(runId);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    // Prepared crash restores old authority.
    expect(recovered.loaded.record.status).toBe('queued');

    const updated = await successor.updateRun(runId, (r) => {
      r.status = 'completed';
    });
    expect(updated.status).toBe('completed');
    expect(knownLeftovers(successor.getRunDir(runId))).toEqual([]);
  }, 15_000);

  it('does not steal based on lock age while owner is live', async () => {
    const store = createRunStore({
      rootDir: root,
      ...makeDeps(),
      txLockWaitMs: 50,
      txLockRetryMs: 10,
    });
    const { runId } = await store.createRun(makeCreateInput());
    const runDir = store.getRunDir(runId);
    const lockDir = path.join(runDir, '.run.json.tx.lock');
    mkdirSync(lockDir, { mode: 0o700 });
    // Publish a lock owned by this live process with an ancient timestamp.
    writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        processStart:
          process.platform === 'linux'
            ? readFileSync(`/proc/${process.pid}/stat`, 'utf8')
                .slice(readFileSync(`/proc/${process.pid}/stat`, 'utf8').lastIndexOf(')') + 2)
                .split(' ')[19]
            : `unsupported-${process.platform}-${process.pid}`,
        token: 'live-old-token',
        timestamp: Date.now() - 86_400_000,
      }) + '\n',
      { mode: 0o600 }
    );

    await expect(
      store.updateRun(runId, (r) => {
        r.status = 'running';
      })
    ).rejects.toMatchObject({ code: 'run_busy' });
  });
});

describe('cross-platform claims and events', () => {
  it('claims, releases, and appends events without leftovers', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const { runId } = await store.createRun(makeCreateInput());
    await store.appendEvent(runId, {
      version: 1,
      event: 'unit_started',
      runId,
      unitId: 'single',
      attempt: 1,
      timestamp: Date.now(),
    });
    const claim = await store.claimRun(runId);
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    await store.releaseRun(runId, claim.claimId);
    const inspect = store.inspectClaims(runId);
    expect(inspect.ok).toBe(true);
    expect(knownLeftovers(store.getRunDir(runId))).toEqual([]);
  });

  it('lock update and claim cycle succeed with directory fsync disabled', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps(), directoryFsync: false });
    const { runId } = await store.createRun(makeCreateInput());
    await store.updateRun(runId, (r) => {
      r.status = 'running';
    });
    const claim = await store.claimRun(runId);
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    await store.releaseRun(runId, claim.claimId);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.loaded.record.status).toBe('running');
    expect(knownLeftovers(store.getRunDir(runId))).toEqual([]);
  });

  it('rejects invalid run ids on public APIs without creating entries', async () => {
    const store = createRunStore({ rootDir: root, ...makeDeps() });
    const before = readdirSync(root);
    for (const runId of ['../escape', 'a/b', 'C:drive']) {
      expect(store.getRun(runId).ok).toBe(false);
      await expect(
        store.appendEvent(runId, { version: 1, event: 'run_created', runId, timestamp: 1 })
      ).rejects.toMatchObject({ code: 'run_not_found' });
      const claim = await store.claimRun(runId);
      expect(claim.ok).toBe(false);
    }
    expect(readdirSync(root)).toEqual(before);
  });
});

describe('post-publish path fsync durability', () => {
  it('createRun completes when directory fsync is unavailable', async () => {
    // Regression: fsyncPathStrict must open write-capable handles. On Windows,
    // O_RDONLY + fsync returns EPERM (FlushFileBuffers), which used to fail every createRun.
    const store = createRunStore({
      rootDir: root,
      directoryFsync: false,
      ...makeDeps(),
    });
    const { runId, record } = await store.createRun(makeCreateInput());
    expect(runId.startsWith('run-')).toBe(true);
    expect(record.status).toBe('queued');
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.runId).toBe(runId);
    expect(knownLeftovers(store.getRunDir(runId))).toEqual([]);
  });

  it('host fsync requires a write-capable handle when O_RDONLY is rejected', () => {
    // Documents the platform constraint that fsyncPathStrict must honor.
    const probe = path.join(root, 'fsync-open-mode-probe.txt');
    writeFileSync(probe, 'pi-agents-fsync-open-mode-probe\n');
    const rdonly = openSync(probe, fsConstants.O_RDONLY);
    let rdonlyFailed = false;
    try {
      fsyncSync(rdonly);
    } catch (err) {
      rdonlyFailed = true;
      if (process.platform === 'win32') {
        expect((err as NodeJS.ErrnoException).code).toBe('EPERM');
      }
    } finally {
      closeSync(rdonly);
    }
    const rdwr = openSync(probe, fsConstants.O_RDWR);
    try {
      fsyncSync(rdwr);
    } finally {
      closeSync(rdwr);
    }
    if (process.platform === 'win32') {
      expect(rdonlyFailed).toBe(true);
    }
  });
});
