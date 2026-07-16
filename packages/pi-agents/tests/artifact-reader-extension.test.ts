// ABOUTME: Tests for the child-only pi_agents_read_artifact extension.
// ABOUTME: Covers path derivation, UTF-8 chunking, offsets, and bounded errors.

import { describe, expect, it } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { createArtifactStore, makeTempRunDir } from '../src/artifact-store.ts';
import { ARTIFACT_READER_CHUNK_MAX_BYTES } from '../src/constants.ts';

type ToolExecute = (
  id: string,
  params: Record<string, unknown>
) => Promise<{
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}>;

async function loadExecute(): Promise<ToolExecute> {
  let execute: ToolExecute | null = null;
  const pi = {
    registerTool(def: { execute: ToolExecute }) {
      execute = def.execute.bind(def);
    },
  };
  const mod = await import('../src/artifact-reader-extension.ts');
  mod.default(pi as never);
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
});
