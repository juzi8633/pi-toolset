// ABOUTME: Tests for content-addressed run-local artifact write/read and verification.
// ABOUTME: Covers deduplication, corruption, path escape, and media-type selection.

import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ArtifactStoreError,
  createArtifactStore,
  makeTempRunDir,
  serializeJsonArtifact,
  type CreateArtifactStoreOptions,
} from '../../src/run/artifact-store.ts';

/** Explicit host-safe capability for standalone tests (no silent strong-platform default). */
function hostDirectoryFsync(): boolean {
  // Directory fsync is required only when the host supports it; Windows typically does not.
  // Standalone tests pass this explicitly rather than relying on createArtifactStore defaults.
  return process.platform !== 'win32';
}

function createTestArtifactStore(
  overrides: Partial<CreateArtifactStoreOptions> = {}
): ReturnType<typeof createArtifactStore> {
  return createArtifactStore({
    directoryFsync: hostDirectoryFsync(),
    ...overrides,
  });
}

describe('artifact-store', () => {
  it('writes text and json artifacts with content-addressed paths and dedupes', async () => {
    const runDir = makeTempRunDir();
    const store = createTestArtifactStore();
    const runId = 'run-test-1';

    const text = 'hello artifact\n';
    const ref1 = await store.writeTextArtifact(runId, runDir, 'final-output', text);
    expect(ref1.kind).toBe('run-artifact');
    expect(ref1.runId).toBe(runId);
    expect(ref1.payload).toBe('final-output');
    expect(ref1.mediaType).toBe('text/plain; charset=utf-8');
    expect(ref1.bytes).toBe(Buffer.byteLength(text, 'utf8'));
    expect(ref1.relativePath).toBe(
      `artifacts/sha256/${ref1.sha256.slice(0, 2)}/${ref1.sha256}.txt`
    );

    const abs = await store.resolveArtifactPath(runId, runDir, ref1);
    expect(fs.existsSync(abs)).toBe(true);
    expect(await store.readTextArtifact(runId, runDir, ref1)).toBe(text);

    const ref2 = await store.writeTextArtifact(runId, runDir, 'final-output', text);
    expect(ref2.sha256).toBe(ref1.sha256);
    expect(ref2.relativePath).toBe(ref1.relativePath);

    const value = { a: 1, b: ['x'] };
    const jsonRef = await store.writeJsonArtifact(runId, runDir, 'structured-output', value);
    expect(jsonRef.mediaType).toBe('application/json');
    expect(jsonRef.relativePath.endsWith('.json')).toBe(true);
    expect(await store.readJsonArtifact(runId, runDir, jsonRef)).toEqual(value);
    expect(fs.readFileSync(path.join(runDir, jsonRef.relativePath), 'utf8')).toBe(
      serializeJsonArtifact(value)
    );

    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('fails closed on missing, wrong digest, and wrong size', async () => {
    const runDir = makeTempRunDir();
    const store = createTestArtifactStore();
    const runId = 'run-test-2';
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', 'payload');

    await expect(
      store.readTextArtifact(runId, runDir, {
        ...ref,
        sha256: '0'.repeat(64),
        relativePath: `artifacts/sha256/00/${'0'.repeat(64)}.txt`,
      })
    ).rejects.toBeInstanceOf(ArtifactStoreError);

    const abs = path.join(runDir, ref.relativePath);
    fs.writeFileSync(abs, 'tampered');
    await expect(store.readTextArtifact(runId, runDir, ref)).rejects.toMatchObject({
      code: 'artifact_corrupt',
    });

    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('rejects non-finite numbers and undefined object values', async () => {
    const runDir = makeTempRunDir();
    const store = createTestArtifactStore();
    const runId = 'run-json-invalid';
    await expect(
      store.writeJsonArtifact(runId, runDir, 'structured-output', { n: Number.NaN })
    ).rejects.toMatchObject({ code: 'artifact_invalid' });
    await expect(
      store.writeJsonArtifact(runId, runDir, 'structured-output', { n: Number.POSITIVE_INFINITY })
    ).rejects.toMatchObject({ code: 'artifact_invalid' });
    await expect(
      store.writeJsonArtifact(runId, runDir, 'structured-output', { u: undefined as never })
    ).rejects.toMatchObject({ code: 'artifact_invalid' });
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('rejects cross-run refs and path escape attempts', async () => {
    const runDir = makeTempRunDir();
    const store = createTestArtifactStore();
    const runId = 'run-test-3';
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', 'x');

    await expect(store.readTextArtifact('other-run', runDir, ref)).rejects.toMatchObject({
      code: 'artifact_corrupt',
    });

    await expect(
      store.readTextArtifact(runId, runDir, {
        ...ref,
        relativePath: '../outside.txt',
      })
    ).rejects.toMatchObject({ code: 'artifact_corrupt' });

    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('succeeds when directory fsync is disabled and still requires file fsync', async () => {
    const runDir = makeTempRunDir();
    let fileFsyncCalls = 0;
    const store = createArtifactStore({
      directoryFsync: false,
      fileFsync: (fd) => {
        fileFsyncCalls++;
        fs.fsyncSync(fd);
      },
      directorySync: () => {
        throw new Error('directory sync should be skipped');
      },
    });
    const ref = await store.writeTextArtifact('run-dirsync-off', runDir, 'final-output', 'ok');
    expect(ref.bytes).toBe(2);
    expect(fileFsyncCalls).toBeGreaterThan(0);
    expect(await store.readTextArtifact('run-dirsync-off', runDir, ref)).toBe('ok');
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('surfaces directory-sync failure as artifact_write_error when supported', async () => {
    const runDir = makeTempRunDir();
    const store = createArtifactStore({
      directoryFsync: true,
      directorySync: () => {
        throw Object.assign(new Error('injected-dir-sync'), { code: 'EIO' });
      },
    });
    await expect(
      store.writeTextArtifact('run-dirsync-fail', runDir, 'final-output', 'payload')
    ).rejects.toMatchObject({ code: 'artifact_write_error' });
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('mandatory file fsync failure does not publish destination and cleans exact staging entry', async () => {
    const runDir = makeTempRunDir();
    const stagingRoot = path.join(runDir, '.artifact-staging');
    fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const foreign = path.join(stagingRoot, 'foreign-keep.tmp');
    fs.writeFileSync(foreign, 'foreign\n');
    let fileFsyncHits = 0;
    const store = createArtifactStore({
      directoryFsync: false,
      fileFsync: () => {
        fileFsyncHits += 1;
        throw Object.assign(new Error('injected-file-fsync'), { code: 'EIO' });
      },
      directorySync: () => {
        throw new Error('directory sync must not run after file fsync failure');
      },
    });
    await expect(
      store.writeTextArtifact('run-file-fsync-fail', runDir, 'final-output', 'payload-bytes')
    ).rejects.toMatchObject({ code: 'artifact_write_error' });
    expect(fileFsyncHits).toBe(1);
    // No content-addressed destination published.
    const artifactsRoot = path.join(runDir, 'artifacts', 'sha256');
    if (fs.existsSync(artifactsRoot)) {
      const published: string[] = [];
      for (const bucket of fs.readdirSync(artifactsRoot)) {
        const bucketPath = path.join(artifactsRoot, bucket);
        if (!fs.statSync(bucketPath).isDirectory()) continue;
        for (const name of fs.readdirSync(bucketPath)) {
          published.push(path.join(bucket, name));
        }
      }
      expect(published).toEqual([]);
    }
    // Writer exact staging entry cleaned; foreign entry preserved (rmdir refuses non-empty).
    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.readFileSync(foreign, 'utf8')).toBe('foreign\n');
    expect(fs.readdirSync(stagingRoot)).toEqual(['foreign-keep.tmp']);
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('preserves unknown staging entries and only unlinks the writer exact temp', async () => {
    const runDir = makeTempRunDir();
    const stagingRoot = path.join(runDir, '.artifact-staging');
    fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    const foreign = path.join(stagingRoot, 'foreign-keep.tmp');
    fs.writeFileSync(foreign, 'foreign\n');
    const store = createTestArtifactStore();
    await store.writeTextArtifact('run-stage-iso', runDir, 'final-output', 'writer-bytes');
    // Foreign entry must survive exact-pathname cleanup + non-recursive rmdir.
    expect(fs.existsSync(foreign)).toBe(true);
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('concurrent same and different artifact publication via child processes dedupes safely', async () => {
    const runDir = makeTempRunDir();
    const modulePath = path.resolve(import.meta.dir, '../../src/run/artifact-store.ts');
    const goFile = path.join(runDir, 'go');
    const readyA = path.join(runDir, 'ready-a');
    const readyB = path.join(runDir, 'ready-b');
    const readyC = path.join(runDir, 'ready-c');
    const directoryFsync = hostDirectoryFsync();
    const childScript = `
      import { createArtifactStore } from ${JSON.stringify(modulePath)};
      import { writeFileSync, existsSync } from 'node:fs';
      const runDir = process.argv[1];
      const ready = process.argv[2];
      const goFile = process.argv[3];
      const label = process.argv[4];
      const directoryFsync = process.argv[5] === '1';
      try {
        const store = createArtifactStore({ directoryFsync });
        writeFileSync(ready, '1');
        const deadline = Date.now() + 10000;
        while (!existsSync(goFile) && Date.now() < deadline) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        if (!existsSync(goFile)) throw new Error('go barrier timeout');
        const body = label.startsWith('same') ? 'shared-payload' : ('unique-' + label);
        const ref = await store.writeTextArtifact('run-conc', runDir, 'final-output', body);
        writeFileSync(runDir + '/result-' + label + '.json', JSON.stringify(ref));
      } catch (err) {
        writeFileSync(
          runDir + '/error-' + label + '.txt',
          err instanceof Error ? err.stack || err.message : String(err)
        );
        process.exitCode = 1;
      }
    `;
    const spawnChild = (ready: string, label: string) =>
      spawn(
        process.execPath,
        ['-e', childScript, runDir, ready, goFile, label, directoryFsync ? '1' : '0'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
    const procA = spawnChild(readyA, 'same-a');
    const procB = spawnChild(readyB, 'same-b');
    const procC = spawnChild(readyC, 'diff');
    const waitFile = (target: string, ms = 10000) => {
      const deadline = Date.now() + ms;
      while (!fs.existsSync(target) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      return fs.existsSync(target);
    };
    expect(waitFile(readyA)).toBe(true);
    expect(waitFile(readyB)).toBe(true);
    expect(waitFile(readyC)).toBe(true);
    fs.writeFileSync(goFile, '1');
    const waitExit = (p: ReturnType<typeof spawn>) =>
      new Promise<{ code: number | null; stderr: string }>((resolve) => {
        let stderr = '';
        p.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        p.on('exit', (code) => resolve({ code, stderr }));
      });
    const [exitA, exitB, exitC] = await Promise.all([
      waitExit(procA),
      waitExit(procB),
      waitExit(procC),
    ]);
    for (const [label, exit] of [
      ['same-a', exitA],
      ['same-b', exitB],
      ['diff', exitC],
    ] as const) {
      const errPath = path.join(runDir, `error-${label}.txt`);
      if (exit.code !== 0 || fs.existsSync(errPath)) {
        const detail = fs.existsSync(errPath)
          ? fs.readFileSync(errPath, 'utf8')
          : exit.stderr || `exit ${exit.code}`;
        throw new Error(`child ${label} failed: ${detail}`);
      }
      expect(waitFile(path.join(runDir, `result-${label}.json`))).toBe(true);
    }
    const ra = JSON.parse(fs.readFileSync(path.join(runDir, 'result-same-a.json'), 'utf8'));
    const rb = JSON.parse(fs.readFileSync(path.join(runDir, 'result-same-b.json'), 'utf8'));
    const rc = JSON.parse(fs.readFileSync(path.join(runDir, 'result-diff.json'), 'utf8'));
    expect(ra.sha256).toBe(rb.sha256);
    expect(ra.relativePath).toBe(rb.relativePath);
    expect(rc.sha256).not.toBe(ra.sha256);
    const store = createTestArtifactStore();
    expect(await store.readTextArtifact('run-conc', runDir, ra)).toBe('shared-payload');
    expect(await store.readTextArtifact('run-conc', runDir, rc)).toBe('unique-diff');
    fs.rmSync(runDir, { recursive: true, force: true });
  }, 15_000);
});
