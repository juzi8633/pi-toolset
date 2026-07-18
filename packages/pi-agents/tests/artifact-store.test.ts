// ABOUTME: Tests for content-addressed run-local artifact write/read and verification.
// ABOUTME: Covers deduplication, corruption, path escape, and media-type selection.

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ArtifactStoreError,
  createArtifactStore,
  makeTempRunDir,
  serializeJsonArtifact,
} from '../src/artifact-store.ts';

describe('artifact-store', () => {
  it('writes text and json artifacts with content-addressed paths and dedupes', async () => {
    const runDir = makeTempRunDir();
    const store = createArtifactStore();
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
    const store = createArtifactStore();
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
    const store = createArtifactStore();
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
    const store = createArtifactStore();
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
});
