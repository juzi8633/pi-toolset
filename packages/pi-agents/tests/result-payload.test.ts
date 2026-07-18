// ABOUTME: Tests for result payload measurement, spill thresholds, and externalization.
// ABOUTME: Covers inline retention, artifact refs, and store-unavailable failures.

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import {
  externalizeTerminalResult,
  ResultPayloadError,
  shouldSpillPayload,
  textPayloadBytes,
} from '../src/result-payload.ts';
import { RESULT_INLINE_PAYLOAD_MAX_BYTES } from '../src/constants.ts';
import { createRunStore } from '../src/run-store.ts';
import type { SingleResult } from '../src/types.ts';

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

function baseResult(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: 'explore',
    agentSource: 'user',
    task: 't',
    exitCode: 0,
    status: 'completed',
    messages: [],
    stderr: '',
    usage: emptyUsage(),
    ...overrides,
  };
}

describe('result-payload', () => {
  it('keeps small text inline and spills above 256 KiB', async () => {
    expect(shouldSpillPayload(RESULT_INLINE_PAYLOAD_MAX_BYTES)).toBe(false);
    expect(shouldSpillPayload(RESULT_INLINE_PAYLOAD_MAX_BYTES + 1)).toBe(true);

    const root = fs.mkdtempSync('/tmp/pi-agents-result-payload-');
    const store = createRunStore({ rootDir: root });
    const { runId } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: { mode: 'single', agentScope: 'both', agent: 'explore', task: 't' },
      details: {
        mode: 'single',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/b',
        results: [],
      },
      units: {
        single: {
          unitId: 'single',
          agent: 'explore',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: root,
        },
      },
    });

    const small = baseResult({ finalOutput: 'ok' });
    const smallSnap = await externalizeTerminalResult(small, store, runId);
    expect(smallSnap.finalOutput).toBe('ok');
    expect(smallSnap.finalOutputRef).toBeUndefined();

    const largeText = 'L'.repeat(RESULT_INLINE_PAYLOAD_MAX_BYTES + 64);
    expect(textPayloadBytes(largeText)).toBeGreaterThan(RESULT_INLINE_PAYLOAD_MAX_BYTES);
    const large = baseResult({ finalOutput: largeText, structuredOutput: { big: largeText } });
    const largeSnap = await externalizeTerminalResult(large, store, runId);
    expect(largeSnap.finalOutput).toBeUndefined();
    expect(largeSnap.finalOutputRef?.payload).toBe('final-output');
    expect(largeSnap.structuredOutput).toBeUndefined();
    expect(largeSnap.structuredOutputRef?.payload).toBe('structured-output');

    const readBack = await store.readTextArtifact(runId, largeSnap.finalOutputRef!);
    expect(readBack).toBe(largeText);

    await expect(externalizeTerminalResult(large, undefined, undefined)).rejects.toBeInstanceOf(
      ResultPayloadError
    );

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('provisional snapshots contain no authoritative inline or ref fields', async () => {
    const { snapshotProvisionalResult } = await import('../src/result-snapshot.ts');
    const provisional = snapshotProvisionalResult(
      baseResult({
        finalOutput: 'secret',
        structuredOutput: { x: 1 },
        finalOutputRef: {
          kind: 'run-artifact',
          version: 1,
          runId: 'run-x',
          payload: 'final-output',
          relativePath: 'artifacts/sha256/ab/ab' + '0'.repeat(62) + '.txt',
          sha256: 'ab' + '0'.repeat(62),
          bytes: 6,
          mediaType: 'text/plain; charset=utf-8',
        },
      })
    );
    expect(provisional.finalOutput).toBeUndefined();
    expect(provisional.finalOutputRef).toBeUndefined();
    expect(provisional.structuredOutput).toBeUndefined();
    expect(provisional.structuredOutputRef).toBeUndefined();
    expect(provisional.messages).toEqual([]);
  });
});
