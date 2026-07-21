// ABOUTME: Tests for the child-only pi_agents_read_artifact extension.
// ABOUTME: Covers path derivation, UTF-8 chunking, offsets, and bounded errors without no-follow open flags.

import { describe, expect, it } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createArtifactStore, makeTempRunDir } from '../../src/run/artifact-store.ts';
import { ARTIFACT_READER_CHUNK_MAX_BYTES } from '../../src/shared/constants.ts';

/** Explicit capability for standalone ArtifactStore tests (no silent true default). */
function hostDirectoryFsync(): boolean {
  return process.platform !== 'win32';
}

function createTestArtifactStore() {
  return createArtifactStore({ directoryFsync: hostDirectoryFsync() });
}

type ToolExecute = (
  id: string,
  params: Record<string, unknown>
) => Promise<{
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}>;

async function loadExecute(
  fsOps?: import('../../src/run/artifact-reader-extension.ts').ArtifactReaderFs
): Promise<ToolExecute> {
  let execute: ToolExecute | null = null;
  const pi = {
    registerTool(def: { execute: ToolExecute }) {
      execute = def.execute.bind(def);
    },
  };
  const mod = await import('../../src/run/artifact-reader-extension.ts');
  mod.default(pi as never, fsOps);
  if (!execute) throw new Error('tool not registered');
  return execute;
}

describe('artifact-reader-extension', () => {
  it('reads text chunks with UTF-8 boundaries and EOF', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-1';
    const store = createTestArtifactStore();
    const text = `${'A'.repeat(100)}😀${'B'.repeat(100)}`;
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', text);
    process.env.PI_AGENTS_RUN_ID = runId;
    process.env.PI_AGENTS_RUN_ARTIFACT_DIR = runDir;

    const execute = await loadExecute();
    const first = await execute('t1', {
      runId,
      sha256: ref.sha256,
      mediaType: 'text',
      offsetBytes: 0,
      maxBytes: 80,
    });
    expect(first.details.eof).toBe(false);
    expect(Number(first.details.bytesReturned)).toBeGreaterThan(0);
    expect(Number(first.details.bytesReturned)).toBeLessThanOrEqual(80);
    expect(first.content[0]!.text.length).toBeGreaterThan(0);

    const next = Number(first.details.nextOffsetBytes);
    const rest = await execute('t2', {
      runId,
      sha256: ref.sha256,
      mediaType: 'text',
      offsetBytes: next,
      maxBytes: ARTIFACT_READER_CHUNK_MAX_BYTES,
    });
    expect(rest.details.eof).toBe(true);
    expect(first.content[0]!.text + rest.content[0]!.text).toBe(text);

    const eof = await execute('t3', {
      runId,
      sha256: ref.sha256,
      mediaType: 'text',
      offsetBytes: Buffer.byteLength(text, 'utf8'),
    });
    expect(eof.details.eof).toBe(true);
    expect(eof.content[0]!.text).toBe('');

    delete process.env.PI_AGENTS_RUN_ID;
    delete process.env.PI_AGENTS_RUN_ARTIFACT_DIR;
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('rejects wrong run, bad digest, and mid-code-point offsets', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-2';
    const store = createTestArtifactStore();
    const text = '😀hello';
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', text);
    process.env.PI_AGENTS_RUN_ID = runId;
    process.env.PI_AGENTS_RUN_ARTIFACT_DIR = runDir;
    const execute = await loadExecute();

    await expect(
      execute('t', {
        runId: 'other',
        sha256: ref.sha256,
        mediaType: 'text',
        offsetBytes: 0,
      })
    ).rejects.toThrow('artifact_unavailable');

    await expect(
      execute('t', {
        runId,
        sha256: crypto.createHash('sha256').update('nope').digest('hex'),
        mediaType: 'text',
        offsetBytes: 0,
      })
    ).rejects.toThrow('artifact_unavailable');

    await expect(
      execute('t', {
        runId,
        sha256: ref.sha256,
        mediaType: 'text',
        offsetBytes: 1,
      })
    ).rejects.toThrow('invalid_artifact_offset');

    delete process.env.PI_AGENTS_RUN_ID;
    delete process.env.PI_AGENTS_RUN_ARTIFACT_DIR;
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('rejects out-of-range offset', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-3';
    const store = createTestArtifactStore();
    const text = 'hello';
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', text);
    process.env.PI_AGENTS_RUN_ID = runId;
    process.env.PI_AGENTS_RUN_ARTIFACT_DIR = runDir;
    const execute = await loadExecute();

    await expect(
      execute('t', {
        runId,
        sha256: ref.sha256,
        mediaType: 'text',
        offsetBytes: 100,
      })
    ).rejects.toThrow('invalid_artifact_offset');

    delete process.env.PI_AGENTS_RUN_ID;
    delete process.env.PI_AGENTS_RUN_ARTIFACT_DIR;
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('collapses missing-file errors to artifact_unavailable', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-4';
    const fakeSha = crypto.createHash('sha256').update('nonexistent').digest('hex');
    process.env.PI_AGENTS_RUN_ID = runId;
    process.env.PI_AGENTS_RUN_ARTIFACT_DIR = runDir;
    const execute = await loadExecute();

    await expect(
      execute('t', {
        runId,
        sha256: fakeSha,
        mediaType: 'text',
        offsetBytes: 0,
      })
    ).rejects.toThrow('artifact_unavailable');

    delete process.env.PI_AGENTS_RUN_ID;
    delete process.env.PI_AGENTS_RUN_ARTIFACT_DIR;
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('rejects invalid sha256 hex format', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-5';
    process.env.PI_AGENTS_RUN_ID = runId;
    process.env.PI_AGENTS_RUN_ARTIFACT_DIR = runDir;
    const execute = await loadExecute();

    await expect(
      execute('t', {
        runId,
        sha256: 'not-a-hex-digest',
        mediaType: 'text',
        offsetBytes: 0,
      })
    ).rejects.toThrow('artifact_unavailable');

    delete process.env.PI_AGENTS_RUN_ID;
    delete process.env.PI_AGENTS_RUN_ARTIFACT_DIR;
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('collapses tampered-file errors to artifact_unavailable', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-6';
    const store = createTestArtifactStore();
    const original = 'original content';
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', original);
    // Tamper with the file after the ref was computed.
    const artifactPath = fs
      .readdirSync(`${runDir}/artifacts/sha256/${ref.sha256.slice(0, 2)}`)
      .find((f) => f.startsWith(ref.sha256));
    if (artifactPath) {
      fs.writeFileSync(
        `${runDir}/artifacts/sha256/${ref.sha256.slice(0, 2)}/${artifactPath}`,
        'tampered'
      );
    }
    process.env.PI_AGENTS_RUN_ID = runId;
    process.env.PI_AGENTS_RUN_ARTIFACT_DIR = runDir;
    const execute = await loadExecute();

    await expect(
      execute('t', {
        runId,
        sha256: ref.sha256,
        mediaType: 'text',
        offsetBytes: 0,
      })
    ).rejects.toThrow('artifact_unavailable');

    delete process.env.PI_AGENTS_RUN_ID;
    delete process.env.PI_AGENTS_RUN_ARTIFACT_DIR;
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('rejects empty sha256', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-8';
    process.env.PI_AGENTS_RUN_ID = runId;
    process.env.PI_AGENTS_RUN_ARTIFACT_DIR = runDir;
    const execute = await loadExecute();

    await expect(
      execute('t', {
        runId,
        sha256: '',
        mediaType: 'text',
        offsetBytes: 0,
      })
    ).rejects.toThrow('artifact_unavailable');

    delete process.env.PI_AGENTS_RUN_ID;
    delete process.env.PI_AGENTS_RUN_ARTIFACT_DIR;
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('root-error leakage: no child-visible error contains a path or native filesystem message', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-leak';
    // Point the artifact dir at a non-existent root so realpathSync fails.
    process.env.PI_AGENTS_RUN_ID = runId;
    process.env.PI_AGENTS_RUN_ARTIFACT_DIR = `${runDir}/does-not-exist`;
    const execute = await loadExecute();
    const fakeSha = crypto.createHash('sha256').update('leak').digest('hex');
    try {
      await execute('t', {
        runId,
        sha256: fakeSha,
        mediaType: 'text',
        offsetBytes: 0,
      });
      throw new Error('expected artifact_unavailable');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toBe('artifact_unavailable');
      // No path or native fs details leak.
      expect(msg).not.toContain(runDir);
      expect(msg).not.toContain('ENOENT');
      expect(msg).not.toContain('does-not-exist');
    }

    delete process.env.PI_AGENTS_RUN_ID;
    delete process.env.PI_AGENTS_RUN_ARTIFACT_DIR;
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('same-fd identity: a verified artifact reads back exact content through one fd', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-fd-id';
    const store = createTestArtifactStore();
    const text = 'fd-identity-content';
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', text);
    process.env.PI_AGENTS_RUN_ID = runId;
    process.env.PI_AGENTS_RUN_ARTIFACT_DIR = runDir;
    const execute = await loadExecute();

    const out = await execute('t', {
      runId,
      sha256: ref.sha256,
      mediaType: 'text',
      offsetBytes: 0,
      maxBytes: ARTIFACT_READER_CHUNK_MAX_BYTES,
    });
    expect(out.content[0]!.text).toBe(text);
    expect(out.details.eof).toBe(true);

    delete process.env.PI_AGENTS_RUN_ID;
    delete process.env.PI_AGENTS_RUN_ARTIFACT_DIR;
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('reads successfully for a normal cross-platform spilled artifact without no-follow open flags', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-same-ino';
    const store = createTestArtifactStore();
    const text = 'same-inode-content';
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', text);
    process.env.PI_AGENTS_RUN_ID = runId;
    process.env.PI_AGENTS_RUN_ARTIFACT_DIR = runDir;
    const execute = await loadExecute();

    const out = await execute('t', {
      runId,
      sha256: ref.sha256,
      mediaType: 'text',
      offsetBytes: 0,
      maxBytes: ARTIFACT_READER_CHUNK_MAX_BYTES,
    });
    expect(out.content[0]!.text).toBe(text);
    expect(out.details.eof).toBe(true);

    delete process.env.PI_AGENTS_RUN_ID;
    delete process.env.PI_AGENTS_RUN_ARTIFACT_DIR;
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('isolated registration: two concurrent registrations with different fs deps stay independent', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-isolated-1';
    const store = createTestArtifactStore();
    const text = 'isolated-content';
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', text);
    process.env.PI_AGENTS_RUN_ID = runId;
    process.env.PI_AGENTS_RUN_ARTIFACT_DIR = runDir;

    // First registration: inject an fs that always fails openSync.
    let executeA: ToolExecute | null = null;
    const piA = {
      registerTool(def: { execute: ToolExecute }) {
        executeA = def.execute.bind(def);
      },
    };
    const modA = await import('../../src/run/artifact-reader-extension.ts');
    modA.default(piA as never, {
      fstatSync: (_fd: number) => ({ isFile: () => true, dev: 1, ino: 1, size: 0 }) as fs.Stats,
      openSync: () => {
        throw new Error('injected-failure');
      },
      readFileSync: (_fd: number) => Buffer.from(''),
      closeSync: () => {},
    });

    // Second registration: use default (real) fs.
    const executeB = await loadExecute();

    // Registration A fails with injected error, collapsed to artifact_unavailable.
    await expect(
      executeA!('t', {
        runId,
        sha256: ref.sha256,
        mediaType: 'text',
        offsetBytes: 0,
      })
    ).rejects.toThrow('artifact_unavailable');

    // Registration B (default fs, second registration) still works.
    const out = await executeB('t', {
      runId,
      sha256: ref.sha256,
      mediaType: 'text',
      offsetBytes: 0,
      maxBytes: ARTIFACT_READER_CHUNK_MAX_BYTES,
    });
    expect(out.content[0]!.text).toBe(text);

    delete process.env.PI_AGENTS_RUN_ID;
    delete process.env.PI_AGENTS_RUN_ARTIFACT_DIR;
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('rejects uppercase sha256 digests without normalizing', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-upper-digest';
    const store = createTestArtifactStore();
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', 'upper-case-check');
    process.env.PI_AGENTS_RUN_ID = runId;
    process.env.PI_AGENTS_RUN_ARTIFACT_DIR = runDir;
    const execute = await loadExecute();
    const upper = ref.sha256.toUpperCase();
    expect(upper).not.toBe(ref.sha256);
    await expect(
      execute('t', {
        runId,
        sha256: upper,
        mediaType: 'text',
        offsetBytes: 0,
      })
    ).rejects.toThrow('artifact_unavailable');
    // Lowercase still works.
    const out = await execute('t', {
      runId,
      sha256: ref.sha256,
      mediaType: 'text',
      offsetBytes: 0,
    });
    expect(out.content[0]!.text).toBe('upper-case-check');
    delete process.env.PI_AGENTS_RUN_ID;
    delete process.env.PI_AGENTS_RUN_ARTIFACT_DIR;
    fs.rmSync(runDir, { recursive: true, force: true });
  });
});
