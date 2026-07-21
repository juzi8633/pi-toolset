// ABOUTME: Exact byte measurement, terminal spill decisions, and trusted artifact resolvers.
// ABOUTME: Produces inline values or verified run-local refs without cloning oversized payloads first.

import {
  measureJsonArtifactBytes,
  measureTextArtifactBytes,
  serializeJsonArtifact,
} from '../run/artifact-store.ts';
import { RESULT_INLINE_PAYLOAD_MAX_BYTES } from '../shared/constants.ts';
import type { RunArtifactPayload, RunArtifactRefV1 } from '../run/run-types.ts';
import type { RunStore } from '../run/run-store.ts';
import type { ChainOutputEntry, SingleResult } from '../shared/types.ts';

export function textPayloadBytes(text: string): number {
  return measureTextArtifactBytes(text);
}

export function jsonPayloadBytes(value: unknown): number {
  return measureJsonArtifactBytes(value);
}

export function shouldSpillPayload(bytes: number): boolean {
  return bytes > RESULT_INLINE_PAYLOAD_MAX_BYTES;
}

export class ResultPayloadError extends Error {
  readonly code:
    | 'artifact_write_error'
    | 'artifact_store_unavailable'
    | 'artifact_missing'
    | 'artifact_corrupt'
    | 'artifact_too_large';

  constructor(code: ResultPayloadError['code'], message: string) {
    super(message);
    this.name = 'ResultPayloadError';
    this.code = code;
  }
}

/** Bounded parent/child descriptor for handoff/UI (never contains artifact content). */
export function formatParentArtifactDescriptor(
  ref: RunArtifactRefV1,
  absolutePath?: string
): string {
  const pathPart = absolutePath ? ` path=${absolutePath}` : '';
  return `[run-artifact payload=${ref.payload} bytes=${ref.bytes} sha256=${ref.sha256.slice(0, 16)}…${pathPart}]`;
}

export function formatChildArtifactDescriptor(ref: RunArtifactRefV1): string {
  const media = ref.mediaType === 'application/json' ? 'json' : 'text';
  return [
    `[run-artifact runId=${ref.runId} payload=${ref.payload} bytes=${ref.bytes}`,
    `sha256=${ref.sha256} mediaType=${media}]`,
    `Use pi_agents_read_artifact with runId, sha256, mediaType=${media}, offsetBytes=0.`,
  ].join(' ');
}

export async function externalizeTextPayload(
  store: RunStore | undefined,
  runId: string | undefined,
  payload: RunArtifactPayload,
  text: string
): Promise<{ text?: string; textRef?: RunArtifactRefV1 }> {
  const bytes = textPayloadBytes(text);
  if (!shouldSpillPayload(bytes)) return { text };
  if (!store || !runId) {
    throw new ResultPayloadError(
      'artifact_store_unavailable',
      'Oversized text payload requires a durable run store'
    );
  }
  try {
    const textRef = await store.writeTextArtifact(runId, payload, text);
    return { textRef };
  } catch (err) {
    throw new ResultPayloadError(
      'artifact_write_error',
      err instanceof Error ? err.message : 'artifact write failed'
    );
  }
}

export async function externalizeJsonPayload(
  store: RunStore | undefined,
  runId: string | undefined,
  payload: RunArtifactPayload,
  value: unknown
): Promise<{ value?: unknown; valueRef?: RunArtifactRefV1 }> {
  const bytes = jsonPayloadBytes(value);
  if (!shouldSpillPayload(bytes)) return { value };
  if (!store || !runId) {
    throw new ResultPayloadError(
      'artifact_store_unavailable',
      'Oversized structured payload requires a durable run store'
    );
  }
  try {
    const valueRef = await store.writeJsonArtifact(runId, payload, value);
    return { valueRef };
  } catch (err) {
    throw new ResultPayloadError(
      'artifact_write_error',
      err instanceof Error ? err.message : 'artifact write failed'
    );
  }
}

/**
 * Externalize oversized terminal SingleResult authority into run artifacts.
 * Measures private authority first; leaves small values inline.
 */
export async function externalizeTerminalResult(
  result: SingleResult,
  store: RunStore | undefined,
  runId: string | undefined
): Promise<SingleResult> {
  const next: SingleResult = { ...result };

  if (typeof next.finalOutput === 'string') {
    const out = await externalizeTextPayload(store, runId, 'final-output', next.finalOutput);
    if (out.textRef) {
      delete next.finalOutput;
      next.finalOutputRef = out.textRef;
    }
  }

  if (hasOwn(next as unknown as Record<string, unknown>, 'structuredOutput')) {
    const out = await externalizeJsonPayload(
      store,
      runId,
      'structured-output',
      next.structuredOutput
    );
    if (out.valueRef) {
      delete next.structuredOutput;
      next.structuredOutputRef = out.valueRef;
    }
  }

  return next;
}

export async function resolveTextRef(
  store: RunStore,
  runId: string,
  ref: RunArtifactRefV1
): Promise<string> {
  return store.readTextArtifact(runId, ref);
}

export async function resolveJsonRef(
  store: RunStore,
  runId: string,
  ref: RunArtifactRefV1
): Promise<unknown> {
  return store.readJsonArtifact(runId, ref);
}

export async function resolveChainText(
  store: RunStore | undefined,
  runId: string | undefined,
  entry: ChainOutputEntry
): Promise<string> {
  if (typeof entry.text === 'string') return entry.text;
  if (entry.textRef) {
    if (!store || !runId) {
      throw new ResultPayloadError(
        'artifact_store_unavailable',
        'Chain text ref requires a durable run store'
      );
    }
    return resolveTextRef(store, runId, entry.textRef);
  }
  return '';
}

export async function resolveChainStructured(
  store: RunStore | undefined,
  runId: string | undefined,
  entry: ChainOutputEntry
): Promise<unknown> {
  if (hasOwn(entry as unknown as Record<string, unknown>, 'structured')) {
    return entry.structured;
  }
  if (entry.structuredRef) {
    if (!store || !runId) {
      throw new ResultPayloadError(
        'artifact_store_unavailable',
        'Chain structured ref requires a durable run store'
      );
    }
    return resolveJsonRef(store, runId, entry.structuredRef);
  }
  return undefined;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export { serializeJsonArtifact, measureTextArtifactBytes, measureJsonArtifactBytes };
