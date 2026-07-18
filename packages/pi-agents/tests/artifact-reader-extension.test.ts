// ABOUTME: Tests for the child-only pi_agents_read_artifact extension.
// ABOUTME: Covers path derivation, UTF-8 chunking, offsets, and bounded errors.

import { describe, expect, it } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createArtifactStore, makeTempRunDir } from '../src/artifact-store.ts';
import { ARTIFACT_READER_CHUNK_MAX_BYTES } from '../src/constants.ts';

type ToolExecute = (
  id: string,
  params: Record<string, unknown>
) => Promise<{
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}>;

async function loadExecute(
  fsOps?: import('../src/artifact-reader-extension.ts').ArtifactReaderFs
): Promise<ToolExecute> {
  let execute: ToolExecute | null = null;
  const pi = {
    registerTool(def: { execute: ToolExecute }) {
      execute = def.execute.bind(def);
    },
  };
  const mod = await import('../src/artifact-reader-extension.ts');
  mod.default(pi as never, fsOps);
  if (!execute) throw new Error('tool not registered');
  return execute;
}

describe('artifact-reader-extension', () => {
  it('reads text chunks with UTF-8 boundaries and EOF', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-1';
    const store = createArtifactStore();
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
    const store = createArtifactStore();
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
    const store = createArtifactStore();
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
    const store = createArtifactStore();
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

  it('rejects symlink artifacts with artifact_unavailable', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-7';
    const store = createArtifactStore();
    const text = 'real content';
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', text);
    // Replace the artifact file with a symlink pointing elsewhere.
    const prefix = ref.sha256.slice(0, 2);
    const artifactDir = `${runDir}/artifacts/sha256/${prefix}`;
    const files = fs.readdirSync(artifactDir);
    const artifactFile = files.find((f) => f.startsWith(ref.sha256));
    if (artifactFile) {
      const fullPath = `${artifactDir}/${artifactFile}`;
      fs.unlinkSync(fullPath);
      fs.symlinkSync('/etc/passwd', fullPath);
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

  it('rejects a parent-directory symlink with artifact_unavailable (intermediate containment)', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-parent-sym';
    const store = createArtifactStore();
    const text = 'parent-sym content';
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', text);
    // Replace the sha256 prefix directory with a symlink to /tmp.
    const prefix = ref.sha256.slice(0, 2);
    const shaDir = `${runDir}/artifacts/sha256/${prefix}`;
    const target = fs.mkdtempSync(`${runDir}/target-`);
    fs.rmSync(shaDir, { recursive: true, force: true });
    fs.symlinkSync(target, shaDir);
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

  it('rejects a path swap where the opened file is replaced mid-read path with artifact_unavailable', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-swap';
    const store = createArtifactStore();
    const text = 'swap-content';
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', text);
    // Replace the artifact file with a different file having the same name but
    // different content (digest mismatch). open+read succeed but digest check fails.
    const prefix = ref.sha256.slice(0, 2);
    const artifactDir = `${runDir}/artifacts/sha256/${prefix}`;
    const files = fs.readdirSync(artifactDir);
    const artifactFile = files.find((f) => f.startsWith(ref.sha256));
    if (artifactFile) {
      const fullPath = `${artifactDir}/${artifactFile}`;
      fs.unlinkSync(fullPath);
      fs.writeFileSync(fullPath, 'swapped-different-content');
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
    const store = createArtifactStore();
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

  it('rejects when fstat returns missing dev (inode identity unavailable)', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-no-dev';
    const store = createArtifactStore();
    const text = 'no-dev-content';
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', text);
    process.env.PI_AGENTS_RUN_ID = runId;
    process.env.PI_AGENTS_RUN_ARTIFACT_DIR = runDir;

    // Inject fs where fstatSync returns stats with missing dev.
    const execute = await loadExecute({
      fstatSync: (_fd: number) =>
        ({ isFile: () => true, dev: undefined, ino: 1, size: text.length }) as unknown as fs.Stats,
      lstatSync: (p: string) => fs.lstatSync(p),
      openSync: (p: string, flags: number) => fs.openSync(p, flags),
      readFileSync: (fd: number) => fs.readFileSync(fd),
      closeSync: (fd: number) => fs.closeSync(fd),
      realpathSync: (p: string) => fs.realpathSync(p),
    });

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

  it('rejects when fstat returns missing ino (inode identity unavailable)', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-no-ino';
    const store = createArtifactStore();
    const text = 'no-ino-content';
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', text);
    process.env.PI_AGENTS_RUN_ID = runId;
    process.env.PI_AGENTS_RUN_ARTIFACT_DIR = runDir;

    const execute = await loadExecute({
      fstatSync: (_fd: number) =>
        ({ isFile: () => true, dev: 1, ino: undefined, size: text.length }) as unknown as fs.Stats,
      lstatSync: (p: string) => fs.lstatSync(p),
      openSync: (p: string, flags: number) => fs.openSync(p, flags),
      readFileSync: (fd: number) => fs.readFileSync(fd),
      closeSync: (fd: number) => fs.closeSync(fd),
      realpathSync: (p: string) => fs.realpathSync(p),
    });

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

  it('rejects when fstat and lstat have same size but different inode (path swap)', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-diff-ino';
    const store = createArtifactStore();
    const text = 'same-size-different-inode';
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', text);
    const prefix = ref.sha256.slice(0, 2);
    const artifactDir = `${runDir}/artifacts/sha256/${prefix}`;
    const files = fs.readdirSync(artifactDir);
    const artifactFile = files.find((f) => f.startsWith(ref.sha256));

    process.env.PI_AGENTS_RUN_ID = runId;
    process.env.PI_AGENTS_RUN_ARTIFACT_DIR = runDir;

    // Replace the artifact file with a different file of identical size.
    // fstat returns the new inode, lstat returns original — mismatch.
    if (artifactFile) {
      const fullPath = `${artifactDir}/${artifactFile}`;
      // Write replacement with same byte count.
      fs.unlinkSync(fullPath);
      fs.writeFileSync(fullPath, '!'.repeat(text.length));
    }

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

  it('rejects when opened realpath differs from expected digest-derived location (parent swap)', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-parent-swap';
    const store = createArtifactStore();
    const text = 'parent-swap-content';
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', text);
    process.env.PI_AGENTS_RUN_ID = runId;
    process.env.PI_AGENTS_RUN_ARTIFACT_DIR = runDir;

    // Inject realpathSync that returns a different path after open.
    let callCount = 0;
    const execute = await loadExecute({
      fstatSync: (fd: number) => fs.fstatSync(fd),
      lstatSync: (p: string) => fs.lstatSync(p),
      openSync: (p: string, flags: number) => fs.openSync(p, flags),
      readFileSync: (fd: number) => fs.readFileSync(fd),
      closeSync: (fd: number) => fs.closeSync(fd),
      realpathSync: (p: string) => {
        callCount++;
        if (callCount === 2) {
          // Second call (post-open) returns a path outside the artifact tree.
          return '/tmp/evil/outside';
        }
        return fs.realpathSync(p);
      },
    });

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

  it('reads successfully when same inode identity is confirmed (normal path)', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-same-ino';
    const store = createArtifactStore();
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

  it('identity race: real inode swap after open; fd bytes+digest valid, exact artifact_unavailable', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-race-ino';
    const store = createArtifactStore();
    const text = 'race-ino-content';
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', text);
    process.env.PI_AGENTS_RUN_ID = runId;
    process.env.PI_AGENTS_RUN_ARTIFACT_DIR = runDir;

    const absolute = path.join(
      runDir,
      'artifacts',
      'sha256',
      ref.sha256.slice(0, 2),
      `${ref.sha256}.txt`
    );
    const expectedBuf = Buffer.from(text, 'utf8');
    const expectedDigest = crypto.createHash('sha256').update(expectedBuf).digest('hex');
    expect(expectedDigest).toBe(ref.sha256);

    let openedFd: number | undefined;
    let originalIno: number | undefined;
    let swappedIno: number | undefined;
    let fdDigestAfterSwap: string | undefined;

    const execute = await loadExecute({
      fstatSync: (fd: number) => fs.fstatSync(fd),
      lstatSync: (p: string) => fs.lstatSync(p),
      openSync: (p: string, flags: number) => {
        const fd = fs.openSync(p, flags);
        openedFd = fd;
        const pre = fs.fstatSync(fd);
        originalIno = pre.ino as number;

        // Prove fd already holds the expected bytes + digest before the race.
        const probe = Buffer.alloc(expectedBuf.length);
        const n = fs.readSync(fd, probe, 0, expectedBuf.length, 0);
        expect(n).toBe(expectedBuf.length);
        expect(probe.equals(expectedBuf)).toBe(true);
        fdDigestAfterSwap = crypto.createHash('sha256').update(probe).digest('hex');
        expect(fdDigestAfterSwap).toBe(ref.sha256);

        // Atomic same-content, same-size, different-inode replacement at the path.
        const alt = `${p}.alt-${process.pid}`;
        fs.writeFileSync(alt, text, { mode: 0o600 });
        const altIno = fs.lstatSync(alt).ino as number;
        expect(altIno).not.toBe(originalIno);
        fs.renameSync(alt, p);
        swappedIno = fs.lstatSync(p).ino as number;
        expect(swappedIno).not.toBe(originalIno);
        expect(swappedIno).toBe(altIno);

        // Original fd still has valid bytes/digest (old inode).
        const still = Buffer.alloc(expectedBuf.length);
        fs.readSync(fd, still, 0, expectedBuf.length, 0);
        expect(still.equals(expectedBuf)).toBe(true);
        expect(crypto.createHash('sha256').update(still).digest('hex')).toBe(ref.sha256);
        return fd;
      },
      readFileSync: (fd: number) => fs.readFileSync(fd),
      closeSync: (fd: number) => fs.closeSync(fd),
      realpathSync: (p: string) => fs.realpathSync(p),
    });

    try {
      await execute('t', {
        runId,
        sha256: ref.sha256,
        mediaType: 'text',
        offsetBytes: 0,
      });
      throw new Error('expected artifact_unavailable');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      // Exact collapse — not a digest-mismatch leak or path leak.
      expect(msg).toBe('artifact_unavailable');
      expect(msg).not.toMatch(/digest|sha256|mismatch|ENOENT/i);
      expect(msg).not.toContain(runDir);
      expect(msg).not.toContain(absolute);
    }

    expect(openedFd).toBeDefined();
    expect(originalIno).toBeDefined();
    expect(swappedIno).toBeDefined();
    expect(fdDigestAfterSwap).toBe(ref.sha256);

    delete process.env.PI_AGENTS_RUN_ID;
    delete process.env.PI_AGENTS_RUN_ARTIFACT_DIR;
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('identity race: real parent-directory swap after open; fd valid, exact artifact_unavailable', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-race-parent';
    const store = createArtifactStore();
    const text = 'race-parent-content';
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', text);
    process.env.PI_AGENTS_RUN_ID = runId;
    process.env.PI_AGENTS_RUN_ARTIFACT_DIR = runDir;

    const prefixDir = path.join(runDir, 'artifacts', 'sha256', ref.sha256.slice(0, 2));
    const absolute = path.join(prefixDir, `${ref.sha256}.txt`);
    const expectedBuf = Buffer.from(text, 'utf8');
    // Outside the run root entirely so realpath escapes containment.
    const outsideRoot = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'pi-agents-outside-'));
    const movedPrefix = path.join(outsideRoot, `prefix-${ref.sha256.slice(0, 2)}`);

    let fdDigestAfterSwap: string | undefined;
    let preSwapIno: number | undefined;
    let preSwapDev: number | undefined;
    let postSwapFdIno: number | undefined;
    let postSwapPathIno: number | undefined;
    let postSwapFdDev: number | undefined;
    let postSwapPathDev: number | undefined;

    const execute = await loadExecute({
      fstatSync: (fd: number) => fs.fstatSync(fd),
      lstatSync: (p: string) => fs.lstatSync(p),
      openSync: (p: string, flags: number) => {
        const fd = fs.openSync(p, flags);

        // Prove original fd content/digest before the parent swap.
        const probe = Buffer.alloc(expectedBuf.length);
        fs.readSync(fd, probe, 0, expectedBuf.length, 0);
        expect(probe.equals(expectedBuf)).toBe(true);
        fdDigestAfterSwap = crypto.createHash('sha256').update(probe).digest('hex');
        expect(fdDigestAfterSwap).toBe(ref.sha256);
        const pre = fs.fstatSync(fd);
        preSwapIno = pre.ino;
        preSwapDev = pre.dev;

        // Move the original prefix directory outside the run root (same inode for
        // the artifact file) and replace the original pathname with a symlink to
        // that moved directory. Digest/size/bytes/dev/ino stay equal; only realpath
        // containment escapes the run root.
        fs.renameSync(prefixDir, movedPrefix);
        fs.symlinkSync(movedPrefix, prefixDir);

        // Original fd still valid after parent redirect; path and fd share identity.
        const still = Buffer.alloc(expectedBuf.length);
        fs.readSync(fd, still, 0, expectedBuf.length, 0);
        expect(still.equals(expectedBuf)).toBe(true);
        expect(crypto.createHash('sha256').update(still).digest('hex')).toBe(ref.sha256);
        const fdStat = fs.fstatSync(fd);
        const pathStat = fs.lstatSync(absolute);
        postSwapFdIno = fdStat.ino;
        postSwapPathIno = pathStat.ino;
        postSwapFdDev = fdStat.dev;
        postSwapPathDev = pathStat.dev;
        expect(postSwapFdIno).toBe(preSwapIno);
        expect(postSwapPathIno).toBe(preSwapIno);
        expect(postSwapFdDev).toBe(preSwapDev);
        expect(postSwapPathDev).toBe(preSwapDev);
        expect(fdStat.size).toBe(expectedBuf.length);
        expect(pathStat.size).toBe(expectedBuf.length);
        return fd;
      },
      readFileSync: (fd: number) => fs.readFileSync(fd),
      closeSync: (fd: number) => fs.closeSync(fd),
      realpathSync: (p: string) => fs.realpathSync(p),
    });

    try {
      await execute('t', {
        runId,
        sha256: ref.sha256,
        mediaType: 'text',
        offsetBytes: 0,
      });
      throw new Error('expected artifact_unavailable');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toBe('artifact_unavailable');
      expect(msg).not.toContain(runDir);
      expect(msg).not.toContain(outsideRoot);
      expect(msg).not.toContain(absolute);
    }

    // Same-inode equality was recorded: rejection is containment/realpath, not identity.
    expect(fdDigestAfterSwap).toBe(ref.sha256);
    expect(postSwapFdIno).toBe(preSwapIno);
    expect(postSwapPathIno).toBe(preSwapIno);
    expect(postSwapFdDev).toBe(preSwapDev);
    expect(postSwapPathDev).toBe(preSwapDev);

    delete process.env.PI_AGENTS_RUN_ID;
    delete process.env.PI_AGENTS_RUN_ARTIFACT_DIR;
    fs.rmSync(runDir, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });

  it('identity race: race error message is exactly artifact_unavailable with no path leak', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-reader-race-leak';
    const store = createArtifactStore();
    const text = 'race-leak-content';
    const ref = await store.writeTextArtifact(runId, runDir, 'final-output', text);
    process.env.PI_AGENTS_RUN_ID = runId;
    process.env.PI_AGENTS_RUN_ARTIFACT_DIR = runDir;

    const absolute = path.join(
      runDir,
      'artifacts',
      'sha256',
      ref.sha256.slice(0, 2),
      `${ref.sha256}.txt`
    );

    const execute = await loadExecute({
      fstatSync: (fd: number) => fs.fstatSync(fd),
      lstatSync: (p: string) => fs.lstatSync(p),
      openSync: (p: string, flags: number) => {
        const fd = fs.openSync(p, flags);
        // Real inode swap (same content) after open.
        const alt = `${p}.alt-leak`;
        fs.writeFileSync(alt, text, { mode: 0o600 });
        fs.renameSync(alt, p);
        return fd;
      },
      readFileSync: (fd: number) => fs.readFileSync(fd),
      closeSync: (fd: number) => fs.closeSync(fd),
      realpathSync: (p: string) => fs.realpathSync(p),
    });

    try {
      await execute('t', {
        runId,
        sha256: ref.sha256,
        mediaType: 'text',
        offsetBytes: 0,
      });
      throw new Error('expected artifact_unavailable');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toBe('artifact_unavailable');
      expect(msg).not.toContain(runDir);
      expect(msg).not.toContain(absolute);
      expect(msg).not.toContain('ENOENT');
      expect(msg).not.toContain('/');
    }

    delete process.env.PI_AGENTS_RUN_ID;
    delete process.env.PI_AGENTS_RUN_ARTIFACT_DIR;
    fs.rmSync(runDir, { recursive: true, force: true });
  });

  it('isolated registration: two concurrent registrations with different fs deps stay independent', async () => {
    const runDir = makeTempRunDir();
    const runId = 'run-isolated-1';
    const store = createArtifactStore();
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
    const modA = await import('../src/artifact-reader-extension.ts');
    modA.default(piA as never, {
      fstatSync: (_fd: number) => ({ isFile: () => true, dev: 1, ino: 1, size: 0 }) as fs.Stats,
      lstatSync: (_p: string) => ({ isFile: () => true, dev: 1, ino: 1 }) as fs.Stats,
      openSync: () => {
        throw new Error('injected-failure');
      },
      readFileSync: (_fd: number) => Buffer.from(''),
      closeSync: () => {},
      realpathSync: (p: string) => fs.realpathSync(p),
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
});
