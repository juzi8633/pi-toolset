// ABOUTME: Durable run store — versioned snapshots, event log, and append-only ticket claims.
// ABOUTME: Pathname-based cross-platform transactions under a resolved per-user runs root.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Duration, Effect } from 'effect';
import {
  getDefaultRunsRoot as resolveDefaultRunsRoot,
  initializeRunsRoot,
  isNoReplaceContentionError,
  resolveRunsRoot,
  type RunStoreCapabilities,
} from './run-store-paths.ts';
import { DEFAULT_RUNTIME, GROK_ACP_RUNTIME } from '../shared/constants.ts';
import { createKeyedSerialExecutor, runEffectPromise } from '../shared/effect-runtime.ts';
import { chainFanoutUnitId, chainStepUnitId, generateUnitIds, pad } from './run-coordinator.ts';
import { createArtifactStore, isRunArtifactRef, type ArtifactStore } from './artifact-store.ts';
import type {
  AgentRunRecordV1,
  ClaimOwner,
  ClaimResult,
  ClaimTerminal,
  CorruptRunEntry,
  ListRunsResult,
  LoadedRun,
  RunArtifactPayload,
  RunArtifactRefV1,
  RunLifecycleEvent,
  RunStoreError,
} from './run-types.ts';
import { RUN_RECORD_VERSION } from './run-types.ts';

/** Fixed-width decimal ticket width; preserves lexical ordering of claim directories. */
const TICKET_WIDTH = 16;

const RUN_STATUS_VALUES = new Set([
  'queued',
  'running',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
]);

/** Durable unit/attempt statuses accepted for resume (includes skipped). */
const UNIT_STATUS_VALUES = new Set([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'skipped',
  'interrupted',
]);

/** Durable runtimes accepted on current records; absent means the Pi default. */
const ALLOWED_DURABLE_RUNTIMES = new Set<string>([DEFAULT_RUNTIME, GROK_ACP_RUNTIME]);

/** Durable resume capabilities accepted on current records (session-only). */
const ALLOWED_DURABLE_CAPABILITIES = new Set<string>(['session']);

function isAllowedDurableRuntime(runtime: unknown): boolean {
  return typeof runtime === 'string' && ALLOWED_DURABLE_RUNTIMES.has(runtime);
}

function isAllowedDurableCapability(capability: unknown): boolean {
  return typeof capability === 'string' && ALLOWED_DURABLE_CAPABILITIES.has(capability);
}

/**
 * Minimum durable SingleResult shell: non-null non-array object with `messages` array.
 * Accepts legacy populated messages and compact empty messages; optional presentation
 * is validated separately when present.
 *
 * When `unitStatus` is `completed`, rejects contradictory result shells that would
 * redispatch a completed unit (status running/failed/…, exitCode -1, or status-less
 * non-zero exitCode). Message entries must be non-null objects so post-claim snapshot
 * normalization cannot throw on primitives.
 */
function validateResultShell(
  result: unknown,
  pathLabel: string,
  options?: { unitStatus?: string; runId?: string }
): string | undefined {
  if (result === undefined) return undefined;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return `${pathLabel} must be a non-null object`;
  }
  const r = result as Record<string, unknown>;
  const messages = r.messages;
  if (!Array.isArray(messages)) {
    return `${pathLabel}.messages must be an array`;
  }
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
      return `${pathLabel}.messages[${i}] must be a non-null object`;
    }
  }
  if (r.status !== undefined) {
    if (typeof r.status !== 'string' || !UNIT_STATUS_VALUES.has(r.status)) {
      return `${pathLabel}.status has unsupported value ${String(r.status)}`;
    }
  }
  if (r.exitCode !== undefined) {
    if (typeof r.exitCode !== 'number' || !Number.isInteger(r.exitCode)) {
      return `${pathLabel}.exitCode must be an integer when present`;
    }
  }
  // Completed unit must carry a terminal completed result shell so Parallel/resume
  // skip-by-status cannot redispatch via lagging result.status / exitCode -1.
  if (options?.unitStatus === 'completed') {
    if (r.status !== undefined && r.status !== 'completed') {
      return `${pathLabel}.status must be completed when unit is completed (got ${String(r.status)})`;
    }
    if (r.exitCode === -1) {
      return `${pathLabel}.exitCode must not be -1 when unit is completed`;
    }
    // Absent status falls back to exitCode: only 0 resolves to completed.
    if (r.status === undefined) {
      if (typeof r.exitCode !== 'number') {
        return `${pathLabel} must have status completed or exitCode 0 when unit is completed`;
      }
      if (r.exitCode !== 0) {
        return `${pathLabel}.exitCode must be 0 when status is absent and unit is completed`;
      }
    }
  }
  const finalUnion = validateInlineOrRef(
    r,
    'finalOutput',
    'finalOutputRef',
    pathLabel,
    options?.runId,
    'final-output',
    'text/plain; charset=utf-8',
    { allowNeither: true }
  );
  if (finalUnion) return finalUnion;
  const structuredUnion = validateInlineOrRef(
    r,
    'structuredOutput',
    'structuredOutputRef',
    pathLabel,
    options?.runId,
    'structured-output',
    'application/json',
    { allowNeither: true }
  );
  if (structuredUnion) return structuredUnion;
  return undefined;
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function validateArtifactRefField(
  ref: unknown,
  pathLabel: string,
  runId: string | undefined,
  expectedPayload: RunArtifactPayload,
  expectedMedia: RunArtifactRefV1['mediaType']
): string | undefined {
  if (!isRunArtifactRef(ref)) {
    return `${pathLabel} must be a Version 1 run-artifact ref`;
  }
  if (runId !== undefined && ref.runId !== runId) {
    return `${pathLabel}.runId does not match owning run`;
  }
  if (ref.payload !== expectedPayload) {
    return `${pathLabel}.payload must be ${expectedPayload}`;
  }
  if (ref.mediaType !== expectedMedia) {
    return `${pathLabel}.mediaType must be ${expectedMedia}`;
  }
  if (!/^[a-f0-9]{64}$/.test(ref.sha256)) {
    return `${pathLabel}.sha256 must be 64 lowercase hex chars`;
  }
  const expectedPath = `artifacts/sha256/${ref.sha256.slice(0, 2)}/${ref.sha256}.${expectedMedia === 'application/json' ? 'json' : 'txt'}`;
  if (ref.relativePath !== expectedPath) {
    return `${pathLabel}.relativePath does not match digest`;
  }
  if (!Number.isInteger(ref.bytes) || ref.bytes < 0) {
    return `${pathLabel}.bytes must be a non-negative integer`;
  }
  return undefined;
}

function validateInlineOrRef(
  obj: Record<string, unknown>,
  inlineKey: string,
  refKey: string,
  pathLabel: string,
  runId: string | undefined,
  expectedPayload: RunArtifactPayload,
  expectedMedia: RunArtifactRefV1['mediaType'],
  options?: { allowNeither?: boolean; requireOne?: boolean }
): string | undefined {
  const hasInline = hasOwn(obj, inlineKey);
  const hasRef = hasOwn(obj, refKey);
  if (hasInline && hasRef) {
    return `${pathLabel} must not set both ${inlineKey} and ${refKey}`;
  }
  if (!hasInline && !hasRef) {
    if (options?.requireOne) {
      return `${pathLabel} must set exactly one of ${inlineKey} or ${refKey}`;
    }
    return undefined;
  }
  if (hasRef) {
    return validateArtifactRefField(
      obj[refKey],
      `${pathLabel}.${refKey}`,
      runId,
      expectedPayload,
      expectedMedia
    );
  }
  return undefined;
}

/** Validate optional compact ResultPresentation on a durable SingleResult. */
function validatePresentation(presentation: unknown, pathLabel: string): string | undefined {
  if (presentation === undefined) return undefined;
  if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)) {
    return `${pathLabel}.presentation must be an object`;
  }
  const p = presentation as Record<string, unknown>;
  if (!Array.isArray(p.transcript)) {
    return `${pathLabel}.presentation.transcript must be an array`;
  }
  for (let i = 0; i < p.transcript.length; i++) {
    const itemError = validateDisplayItem(
      p.transcript[i],
      `${pathLabel}.presentation.transcript[${i}]`
    );
    if (itemError) return itemError;
  }
  if (p.latestActivity !== undefined) {
    const latestError = validateDisplayItem(
      p.latestActivity,
      `${pathLabel}.presentation.latestActivity`
    );
    if (latestError) return latestError;
  }
  if (p.truncated === true) {
    if (
      typeof p.omittedItems !== 'number' ||
      !Number.isInteger(p.omittedItems) ||
      p.omittedItems <= 0
    ) {
      return `${pathLabel}.presentation.omittedItems must be a positive integer when truncated`;
    }
  } else if (p.truncated === false) {
    return `${pathLabel}.presentation.truncated must be true or absent`;
  } else if (p.truncated !== undefined) {
    return `${pathLabel}.presentation.truncated must be true or absent`;
  } else if (p.omittedItems !== undefined) {
    return `${pathLabel}.presentation.omittedItems requires truncated: true`;
  }
  return undefined;
}

function validateDisplayItem(item: unknown, pathLabel: string): string | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return `${pathLabel} must be a display item object`;
  }
  const d = item as Record<string, unknown>;
  if (d.type === 'text') {
    if (typeof d.text !== 'string') return `${pathLabel}.text must be a string`;
    return undefined;
  }
  if (d.type === 'toolCall') {
    if (typeof d.name !== 'string') return `${pathLabel}.name must be a string`;
    if (d.args === null || typeof d.args !== 'object' || Array.isArray(d.args)) {
      return `${pathLabel}.args must be a non-null object`;
    }
    return undefined;
  }
  return `${pathLabel}.type must be text or toolCall`;
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && Number.isFinite(value)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && Number.isFinite(value)
  );
}

/** Validate one durable ChainOutputEntry used by resume/restore. */
function validateChainOutputEntry(
  entry: unknown,
  pathLabel: string,
  runId?: string
): string | undefined {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return `${pathLabel} must be a non-null object`;
  }
  const e = entry as Record<string, unknown>;
  const textUnion = validateInlineOrRef(
    e,
    'text',
    'textRef',
    pathLabel,
    runId,
    'chain-output-text',
    'text/plain; charset=utf-8',
    { requireOne: true }
  );
  if (textUnion) return textUnion;
  if (hasOwn(e, 'text') && typeof e.text !== 'string') {
    return `${pathLabel}.text must be a string`;
  }
  const structuredUnion = validateInlineOrRef(
    e,
    'structured',
    'structuredRef',
    pathLabel,
    runId,
    'chain-output-structured',
    'application/json',
    { allowNeither: true }
  );
  if (structuredUnion) return structuredUnion;
  if (typeof e.agent !== 'string') {
    return `${pathLabel}.agent must be a string`;
  }
  if (!isPositiveInteger(e.step)) {
    return `${pathLabel}.step must be a positive integer`;
  }
  return undefined;
}

function validateWorkflowFanoutState(
  fanout: unknown,
  pathLabel: string,
  runId: string
): string | undefined {
  if (fanout === null || typeof fanout !== 'object' || Array.isArray(fanout)) {
    return `${pathLabel} must be a non-null object`;
  }
  const f = fanout as Record<string, unknown>;
  if (!isPositiveInteger(f.step)) {
    return `${pathLabel}.step must be a positive integer`;
  }
  if (!Array.isArray(f.unitIds)) {
    return `${pathLabel}.unitIds must be an array`;
  }
  for (let i = 0; i < f.unitIds.length; i++) {
    if (typeof f.unitIds[i] !== 'string') {
      return `${pathLabel}.unitIds[${i}] must be a string`;
    }
  }
  const hasItems = hasOwn(f, 'items');
  const hasItemsRef = hasOwn(f, 'itemsRef');
  if (hasItems === hasItemsRef) {
    return `${pathLabel} must set exactly one of items or itemsRef`;
  }
  if (hasItems) {
    if (!Array.isArray(f.items)) return `${pathLabel}.items must be an array`;
    if (f.items.length !== f.unitIds.length) {
      return `${pathLabel}.items length must match unitIds`;
    }
  } else {
    const refError = validateArtifactRefField(
      f.itemsRef,
      `${pathLabel}.itemsRef`,
      runId,
      'fanout-items',
      'application/json'
    );
    if (refError) return refError;
  }
  return undefined;
}

/** Validate one durable presentation ChainLogicalStep enough for resume/restore. */
function validateChainLogicalStep(step: unknown, pathLabel: string): string | undefined {
  if (step === null || typeof step !== 'object' || Array.isArray(step)) {
    return `${pathLabel} must be a non-null object`;
  }
  const s = step as Record<string, unknown>;
  if (s.kind !== 'sequential' && s.kind !== 'fanout') {
    return `${pathLabel}.kind must be sequential or fanout`;
  }
  if (!isPositiveInteger(s.step)) {
    return `${pathLabel}.step must be a positive integer`;
  }
  if (typeof s.agent !== 'string') {
    return `${pathLabel}.agent must be a string`;
  }
  if (typeof s.status !== 'string' || !UNIT_STATUS_VALUES.has(s.status)) {
    return `${pathLabel}.status has unsupported value ${String(s.status)}`;
  }
  if (s.title !== undefined && typeof s.title !== 'string') {
    return `${pathLabel}.title must be a string when present`;
  }
  if (s.kind === 'sequential') {
    if (typeof s.task !== 'string') {
      return `${pathLabel}.task must be a string`;
    }
    return undefined;
  }
  if (typeof s.taskTemplate !== 'string') {
    return `${pathLabel}.taskTemplate must be a string`;
  }
  if (typeof s.collectName !== 'string') {
    return `${pathLabel}.collectName must be a string`;
  }
  if (s.sourceOutput !== undefined && typeof s.sourceOutput !== 'string') {
    return `${pathLabel}.sourceOutput must be a string when present`;
  }
  if (s.sourcePath !== undefined && typeof s.sourcePath !== 'string') {
    return `${pathLabel}.sourcePath must be a string when present`;
  }
  if (s.concurrency !== undefined && !isNonNegativeInteger(s.concurrency)) {
    return `${pathLabel}.concurrency must be a non-negative integer when present`;
  }
  for (const countField of [
    'executedCount',
    'completedCount',
    'failedCount',
    'runningCount',
    'queuedCount',
    'skippedCount',
  ] as const) {
    if (!isNonNegativeInteger(s[countField])) {
      return `${pathLabel}.${countField} must be a non-negative integer`;
    }
  }
  if (s.latestIndex !== undefined && !isNonNegativeInteger(s.latestIndex)) {
    return `${pathLabel}.latestIndex must be a non-negative integer when present`;
  }
  return undefined;
}

/** Resolve agent name for request.chain[step-1] (sequential agent or fanout parallel.agent). */
function chainRequestStepAgent(chain: unknown[], step: number): string | undefined {
  if (step < 1 || step > chain.length) return undefined;
  const entry = chain[step - 1];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const e = entry as Record<string, unknown>;
  const isFanout = 'expand' in e && !('agent' in e);
  if (isFanout) {
    const parallel = e.parallel;
    if (!parallel || typeof parallel !== 'object' || Array.isArray(parallel)) return undefined;
    const agent = (parallel as { agent?: unknown }).agent;
    return typeof agent === 'string' ? agent : undefined;
  }
  return typeof e.agent === 'string' ? e.agent : undefined;
}

/**
 * Minimum mode-aware SubagentDetails shape consumed by getRun / preflight / chain restore.
 * Requires results; validates optional chain/outputs enough that resume cannot throw.
 *
 * Compatibility: `details.chain` / `details.outputs` may appear on single/parallel records
 * as ignored presentation (legacy fixtures). Topology provenance is enforced only when
 * `mode === 'chain'` so impossible step/agent entries cannot poison later-step-wins restore.
 */
function validateSubagentDetails(
  details: unknown,
  options?: { mode?: string; request?: Record<string, unknown>; runId?: string }
): string | undefined {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) {
    return 'invalid details';
  }
  const d = details as Record<string, unknown>;

  if (!Array.isArray(d.results)) {
    return 'details.results must be an array';
  }
  for (let i = 0; i < d.results.length; i++) {
    const result = d.results[i];
    const pathLabel = `details.results[${i}]`;
    const shellError = validateResultShell(result, pathLabel, { runId: options?.runId });
    if (shellError) return shellError;
    if (!result || typeof result !== 'object') continue;
    const resumeCapability = (result as { resumeCapability?: unknown }).resumeCapability;
    if (resumeCapability !== undefined && !isAllowedDurableCapability(resumeCapability)) {
      return `${pathLabel}.resumeCapability has unsupported value ${String(resumeCapability)}`;
    }
    const presentationError = validatePresentation(
      (result as { presentation?: unknown }).presentation,
      pathLabel
    );
    if (presentationError) return presentationError;
  }

  if (d.outputs !== undefined) {
    if (d.outputs === null || typeof d.outputs !== 'object' || Array.isArray(d.outputs)) {
      return 'details.outputs must be a non-null object';
    }
    for (const [name, entry] of Object.entries(d.outputs as Record<string, unknown>)) {
      const entryError = validateChainOutputEntry(
        entry,
        `details.outputs[${name}]`,
        options?.runId
      );
      if (entryError) return entryError;
    }
  }

  if (d.chain !== undefined) {
    if (d.chain === null || typeof d.chain !== 'object' || Array.isArray(d.chain)) {
      return 'details.chain must be a non-null object';
    }
    const chain = d.chain as Record<string, unknown>;
    if (!isNonNegativeInteger(chain.totalSteps)) {
      return 'details.chain.totalSteps must be a non-negative integer';
    }
    if (!Array.isArray(chain.steps)) {
      return 'details.chain.steps must be an array';
    }
    for (let i = 0; i < chain.steps.length; i++) {
      const stepError = validateChainLogicalStep(chain.steps[i], `details.chain.steps[${i}]`);
      if (stepError) return stepError;
    }
  }

  // Chain-mode topology provenance: reject impossible output/step agents that can
  // win later-step-wins and poison named templates. Non-chain modes may still carry
  // ignored legacy chain/outputs presentation (accepted without topology checks).
  if (options?.mode === 'chain' && options.request) {
    const requestChain = options.request.chain;
    const topology = Array.isArray(requestChain) ? requestChain : [];
    const totalSteps = topology.length;

    if (d.outputs !== undefined && totalSteps > 0) {
      for (const [name, entry] of Object.entries(d.outputs as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const e = entry as { step?: unknown; agent?: unknown };
        if (typeof e.step === 'number' && isPositiveInteger(e.step) && e.step > totalSteps) {
          return `details.outputs[${name}].step ${e.step} is outside chain topology (1..${totalSteps})`;
        }
        if (
          typeof e.step === 'number' &&
          isPositiveInteger(e.step) &&
          typeof e.agent === 'string'
        ) {
          const expected = chainRequestStepAgent(topology, e.step);
          if (expected !== undefined && e.agent !== expected) {
            return `details.outputs[${name}].agent "${e.agent}" does not match topology agent "${expected}" at step ${e.step}`;
          }
        }
      }
    }

    if (d.chain !== undefined && totalSteps > 0) {
      const chain = d.chain as { steps?: unknown };
      if (Array.isArray(chain.steps)) {
        for (let i = 0; i < chain.steps.length; i++) {
          const step = chain.steps[i];
          if (!step || typeof step !== 'object' || Array.isArray(step)) continue;
          const s = step as { step?: unknown; agent?: unknown };
          if (typeof s.step === 'number' && isPositiveInteger(s.step) && s.step > totalSteps) {
            return `details.chain.steps[${i}].step ${s.step} is outside chain topology (1..${totalSteps})`;
          }
          if (
            typeof s.step === 'number' &&
            isPositiveInteger(s.step) &&
            typeof s.agent === 'string'
          ) {
            const expected = chainRequestStepAgent(topology, s.step);
            if (expected !== undefined && s.agent !== expected) {
              return `details.chain.steps[${i}].agent "${s.agent}" does not match topology agent "${expected}" at step ${s.step}`;
            }
          }
        }
      }
    }
  }

  const runMeta = d.run;
  if (runMeta !== undefined) {
    if (runMeta === null || typeof runMeta !== 'object' || Array.isArray(runMeta)) {
      return 'details.run must be a non-null object when present';
    }
    const cap = (runMeta as { capability?: unknown }).capability;
    if (cap !== undefined && !isAllowedDurableCapability(cap)) {
      return `details.run.capability has unsupported value ${String(cap)}`;
    }
  }

  return undefined;
}

/** Effective unit runtime: explicit value or the Pi default when absent. */
function effectiveUnitRuntime(runtime: unknown): string {
  return typeof runtime === 'string' ? runtime : DEFAULT_RUNTIME;
}

export function getDefaultRunsRoot(): string {
  return resolveDefaultRunsRoot();
}

function isNonEmptyRoot(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

const POSIX = process.platform !== 'win32';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function applyMode(targetPath: string, mode: number): void {
  if (!POSIX) return;
  try {
    fs.chmodSync(targetPath, mode);
  } catch {
    // best-effort
  }
}

function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  applyMode(dir, DIR_MODE);
}

function fsyncFdStrict(fd: number): void {
  try {
    fs.fsyncSync(fd);
  } catch (err) {
    throw {
      code: 'run_store_error',
      message: `fsync failed: ${err instanceof Error ? err.message : String(err)}`,
    } satisfies RunStoreError;
  }
}

function fsyncDirStrict(dirPath: string): void {
  // Capability gate is applied by callers (fsyncRunDir / defaultDirSync).
  // When directory fsync is supported, failure propagates as run_store_error.
  let dirFd: number | undefined;
  try {
    dirFd = fs.openSync(dirPath, 'r');
    fsyncFdStrict(dirFd);
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err) throw err;
    throw {
      code: 'run_store_error',
      message: `directory fsync failed: ${err instanceof Error ? err.message : String(err)}`,
    } satisfies RunStoreError;
  } finally {
    if (dirFd !== undefined) {
      try {
        fs.closeSync(dirFd);
      } catch {
        /* ignore */
      }
    }
  }
}

function isUnitIdValid(id: string): boolean {
  return /^[a-z0-9-]+$/.test(id);
}

function isRunIdValid(id: string): boolean {
  if (!id || id.includes(path.sep) || id.includes('/') || id.includes('\\')) return false;
  // Reject drive-like prefixes (e.g. C:foo) and absolute forms without separators.
  if (id.includes(':')) return false;
  return /^[a-zA-Z0-9-]+$/.test(id);
}

/** Throw run_store_error / run_not_found-shaped rejection before any path join. */
function assertValidRunId(id: string, shape: 'throw' | 'not_found' = 'not_found'): void {
  if (isRunIdValid(id)) return;
  if (shape === 'throw') {
    throw {
      code: 'run_store_error',
      runId: id,
      message: 'invalid run id',
    } satisfies RunStoreError;
  }
  throw {
    code: 'run_not_found',
    runId: id,
    message: 'invalid run id',
  } satisfies RunStoreError;
}

/** Durable crash windows for strict run.json transactions (test injection). */
export type StrictRunTxPhase =
  | 'after_rollback_publication'
  | 'after_prepared_marker'
  | 'after_new_rename'
  | 'after_new_directory_sync'
  | 'after_committed_marker'
  | 'during_cleanup'
  | 'during_rollback_restore'
  | 'after_cleanup_marker_unlink'
  | 'after_cleanup_rollback_unlink'
  | 'after_cleanup_first_dir_sync'
  | 'after_cleanup_second_dir_sync';

/**
 * Test-only crash: throw from a strict transaction hook with this flag to leave
 * on-disk state exactly as-is (no catch/finally restore or cleanup).
 */
export const STRICT_TX_BYPASS_CLEANUP = Symbol.for('pi-agents.strictTxBypassCleanup');

export interface CreateRunStoreOptions {
  rootDir?: string;
  now?: () => number;
  randomUUID?: () => string;
  pid?: number;
  instanceId?: string;
  /**
   * Test seam: post-rename directory sync for strict run.json publication only.
   * Defaults to the real strict directory fsync. Rollback prep/restore always
   * uses the real fsync so one-shot publication faults can be verified.
   */
  strictPostRenameDirectorySync?: (dirPath: string) => void;
  /**
   * Test seam: called after each durable phase of a strict run.json transaction.
   * Throwing before committed-marker durability restores prior authority unless
   * the error carries STRICT_TX_BYPASS_CLEANUP (process-crash simulation).
   * Throwing during cleanup without bypass leaves recoverable leftovers and
   * still reports success; with bypass, cleanup stops immediately.
   */
  strictTransactionHook?: (phase: StrictRunTxPhase) => void;
  /**
   * Test seam: committed-marker directory sync only (after marker rename).
   * Defaults to the real strict directory fsync.
   */
  strictCommittedMarkerDirectorySync?: (dirPath: string) => void;
  /** Test seam: regular-file fsync used for durable publications (mandatory). */
  fileFsync?: (fd: number) => void;
  /**
   * Test seam: directory sync used when directoryFsync capability is true.
   * Defaults to real directory open/fsync. Not called when capability is false.
   * Shared by lock, candidate, intent, tombstone, claim, terminal, and cleanup paths.
   */
  directorySync?: (dirPath: string) => void;
  /** Test seam: artifact regular-file fsync (defaults to real fsync). */
  artifactFileFsync?: (fd: number) => void;
  /** Test seam: artifact directory sync (defaults to capability-aware fsync). */
  artifactDirectorySync?: (dirPath: string) => void;
  /**
   * Test seam: force directory-fsync capability after probe (does not re-probe).
   * When false, directory open/sync is skipped; file fsync and hard-link remain required.
   */
  directoryFsync?: boolean;
  /**
   * Test seam: process.kill used by isPidAlive (signal 0). Production uses process.kill.
   * Only ESRCH must be treated as dead; EPERM/ENOSYS/unknown remain busy.
   */
  pidAliveKill?: (pid: number, signal: 0) => void;
  /** Max wait for a live transaction lock before run_busy (default 2000ms). */
  txLockWaitMs?: number;
  /** Retry interval while waiting for a transaction lock (default 25ms). */
  txLockRetryMs?: number;
}

export interface CreateRunInput {
  mode: 'single' | 'parallel' | 'chain';
  agentScope: import('../config/agents.ts').AgentScope;
  background: boolean;
  request: import('./run-types.ts').StoredRunRequest;
  details: import('../shared/types.ts').SubagentDetails;
  units: Record<string, import('./run-types.ts').RunUnitRecord>;
}

export interface UpdateRunInput {
  record: AgentRunRecordV1;
}

export interface ClaimInfo {
  claimId: string;
  ticket: number;
}

export interface RunStore {
  readonly rootDir: string;
  /** Resolve the on-disk directory for a run id (exists once createRun succeeds). */
  getRunDir(runId: string): string;
  createRun(input: CreateRunInput): Promise<{ runId: string; record: AgentRunRecordV1 }>;
  getRun(runId: string): { ok: true; loaded: LoadedRun } | { ok: false; error: RunStoreError };
  updateRun(runId: string, mutate: (record: AgentRunRecordV1) => void): Promise<AgentRunRecordV1>;
  appendEvent(runId: string, event: RunLifecycleEvent): Promise<void>;
  /** Strict update that propagates supported file/directory sync failures. */
  updateRunStrict(
    runId: string,
    mutate: (record: AgentRunRecordV1) => void
  ): Promise<AgentRunRecordV1>;
  /** Strict event append that propagates supported file/directory sync failures. */
  appendEventStrict(runId: string, event: RunLifecycleEvent): Promise<void>;
  writeTextArtifact(
    runId: string,
    payload: RunArtifactPayload,
    text: string
  ): Promise<RunArtifactRefV1>;
  writeJsonArtifact(
    runId: string,
    payload: RunArtifactPayload,
    value: unknown
  ): Promise<RunArtifactRefV1>;
  readTextArtifact(runId: string, ref: RunArtifactRefV1): Promise<string>;
  readJsonArtifact(runId: string, ref: RunArtifactRefV1): Promise<unknown>;
  resolveArtifactPath(runId: string, ref: RunArtifactRefV1): Promise<string>;
  listRuns(): Promise<ListRunsResult>;
  claimRun(runId: string): Promise<ClaimResult>;
  releaseRun(runId: string, claimId: string): Promise<void>;
  abandonRun(runId: string, claimId: string): Promise<void>;
  /** Inspect published claims for a run without participating. */
  inspectClaims(runId: string):
    | {
        ok: true;
        claims: Array<{
          ticket: number;
          owner?: ClaimOwner;
          terminal?: ClaimTerminal;
          ownerError?: string;
          terminalError?: string;
        }>;
      }
    | { ok: false; error: RunStoreError };
  /** Test/inspection helper: is the given PID alive (false only on ESRCH). */
  isPidAlive(pid: number): boolean;
}

/** Hard upper bound for synchronous lock waits (milliseconds). */
const TX_LOCK_WAIT_MS_MAX = 60_000;
const TX_LOCK_WAIT_MS_DEFAULT = 2_000;
const TX_LOCK_RETRY_MS_DEFAULT = 25;

function normalizeTxLockTiming(
  waitMs: number | undefined,
  retryMs: number | undefined
): { txLockWaitMs: number; txLockRetryMs: number } {
  const waitRaw = waitMs === undefined ? TX_LOCK_WAIT_MS_DEFAULT : waitMs;
  const retryRaw = retryMs === undefined ? TX_LOCK_RETRY_MS_DEFAULT : retryMs;
  if (
    typeof waitRaw !== 'number' ||
    !Number.isFinite(waitRaw) ||
    !Number.isInteger(waitRaw) ||
    waitRaw <= 0 ||
    waitRaw > TX_LOCK_WAIT_MS_MAX
  ) {
    throw {
      code: 'run_store_error',
      message: `txLockWaitMs must be a finite integer in 1..${TX_LOCK_WAIT_MS_MAX}`,
    } satisfies RunStoreError;
  }
  if (
    typeof retryRaw !== 'number' ||
    !Number.isFinite(retryRaw) ||
    !Number.isInteger(retryRaw) ||
    retryRaw <= 0 ||
    retryRaw > waitRaw
  ) {
    throw {
      code: 'run_store_error',
      message: 'txLockRetryMs must be a positive finite integer <= txLockWaitMs',
    } satisfies RunStoreError;
  }
  return { txLockWaitMs: waitRaw, txLockRetryMs: retryRaw };
}

export function createRunStore(options: CreateRunStoreOptions = {}): RunStore {
  // Resolve runs root (programmatic > env > platform default), create it, and probe
  // mandatory regular-file fsync + hard-link no-replace capabilities before any run-*.
  // Explicit empty rootDir is invalid; omitted rootDir falls through to env/platform default.
  if (options.rootDir !== undefined && !isNonEmptyRoot(options.rootDir)) {
    throw {
      code: 'run_store_error',
      message: 'rootDir must be a non-empty path when provided',
    } satisfies RunStoreError;
  }
  const configuredRoot = isNonEmptyRoot(options.rootDir)
    ? resolveRunsRoot({ rootDir: options.rootDir })
    : resolveRunsRoot();
  let capabilities: RunStoreCapabilities;
  try {
    capabilities = initializeRunsRoot(configuredRoot);
  } catch (err) {
    if (isRunStoreError(err)) throw err;
    throw {
      code: 'run_store_error',
      message: `cannot initialize runs root: ${err instanceof Error ? err.message : String(err)}`,
    } satisfies RunStoreError;
  }
  if (options.directoryFsync !== undefined) {
    capabilities = { ...capabilities, directoryFsync: options.directoryFsync };
  }
  const rootDir = path.resolve(configuredRoot);
  const pidAliveKill =
    options.pidAliveKill ?? ((probePid: number, signal: 0) => process.kill(probePid, signal));
  applyMode(rootDir, DIR_MODE);
  const now = options.now ?? (() => Date.now());
  const randomUUID = options.randomUUID ?? crypto.randomUUID;
  const pid = options.pid ?? process.pid;
  const instanceId = options.instanceId ?? `${process.ppid ?? 0}-${Date.now()}-${randomUUID()}`;
  // Single injectable directory-sync implementation; capability gate applied at call sites.
  const directorySyncImpl = options.directorySync ?? fsyncDirStrict;
  const defaultDirSync = (dirPath: string): void => {
    if (!capabilities.directoryFsync) return;
    directorySyncImpl(dirPath);
  };
  // Strict-transaction seams retain independent fault-phase injection; default to shared gate.
  const strictPostRenameDirectorySync = options.strictPostRenameDirectorySync ?? defaultDirSync;
  const strictCommittedMarkerDirectorySync =
    options.strictCommittedMarkerDirectorySync ?? defaultDirSync;
  const strictTransactionHook = options.strictTransactionHook;
  const { txLockWaitMs, txLockRetryMs } = normalizeTxLockTiming(
    options.txLockWaitMs,
    options.txLockRetryMs
  );
  // File fsync test seam: production uses real fsyncFdStrict.
  const fileFsyncImpl = options.fileFsync ?? fsyncFdStrict;
  const artifacts: ArtifactStore = createArtifactStore({
    directoryFsync: capabilities.directoryFsync,
    fileFsync: options.artifactFileFsync,
    directorySync: options.artifactDirectorySync,
  });

  /** Deterministic private transaction filenames (never public refs). */
  const TX_ROLLBACK_NAME = '.run.json.tx.rollback';
  const TX_MARKER_NAME = '.run.json.tx.marker';
  const TX_LOCK_DIR_NAME = '.run.json.tx.lock';
  const TX_LOCK_OWNER_NAME = 'owner.json';
  const TX_MARKER_VERSION = 1 as const;
  const TX_LOCK_VERSION = 1 as const;

  type TxPhase = 'prepared' | 'committed';
  interface TxMarker {
    version: typeof TX_MARKER_VERSION;
    phase: TxPhase;
    oldSha256: string;
    oldBytes: number;
    newSha256: string;
    newBytes: number;
  }

  interface TxLockOwner {
    version: typeof TX_LOCK_VERSION;
    pid: number;
    processStart: string;
    token: string;
    timestamp: number;
  }

  interface FileIdentity {
    dev: number;
    ino: number;
  }

  /** Pathname handle for a run directory under the trusted runs root. */
  interface RunDirHandle {
    publicDir: string;
  }

  interface HeldTxLock {
    runId: string;
    dir: string;
    lockDir: string;
    token: string;
    session: RunDirHandle;
    lockIdentity: FileIdentity;
  }

  function isBypassCleanupError(err: unknown): boolean {
    return (
      !!err &&
      typeof err === 'object' &&
      (err as { [STRICT_TX_BYPASS_CLEANUP]?: unknown })[STRICT_TX_BYPASS_CLEANUP] === true
    );
  }

  function fireStrictTxHook(phase: StrictRunTxPhase): void {
    if (strictTransactionHook) strictTransactionHook(phase);
  }

  function sha256Hex(buf: Buffer): string {
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  function isRunStoreError(err: unknown): err is RunStoreError {
    if (!err || typeof err !== 'object' || !('code' in err) || !('message' in err)) return false;
    const code = (err as { code: unknown }).code;
    return (
      code === 'run_not_found' ||
      code === 'corrupt_run' ||
      code === 'run_store_error' ||
      code === 'run_busy' ||
      code === 'durable_write_error' ||
      code === 'durable_commit_uncertain' ||
      code === 'generation_mismatch' ||
      code === 'claim_corrupt' ||
      code === 'run_active'
    );
  }

  function noFollowFlag(): number {
    // Cross-platform pathname mode: no-follow flags are not required.
    return 0;
  }

  function processStartIdentity(targetPid: number): string | undefined {
    if (process.platform !== 'linux') return undefined;
    try {
      const stat = fs.readFileSync(`/proc/${targetPid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      if (closeParen < 0) return undefined;
      const after = stat.slice(closeParen + 2).split(' ');
      // Field 22 (1-based) is starttime; after comm fields start at index 0 = state (field 3).
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
    // Fail closed on unsupported platforms: identity cannot prove staleness.
    return `unsupported-${process.platform}-${process.pid}`;
  }

  const selfStartIdentity = selfProcessStart();

  function txPaths(dir: string): { rollback: string; marker: string; lockDir: string } {
    return {
      rollback: path.join(dir, TX_ROLLBACK_NAME),
      marker: path.join(dir, TX_MARKER_NAME),
      lockDir: path.join(dir, TX_LOCK_DIR_NAME),
    };
  }

  function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
    return a.dev === b.dev && a.ino === b.ino;
  }

  function identityOf(st: fs.Stats): FileIdentity {
    return { dev: st.dev, ino: st.ino };
  }

  function assertSafeEntryName(name: string): string {
    // Basenames may start with '.' (protocol temps like ..run.json.tx.marker.*.tmp).
    // Reject only path separators and NUL — never treat leading dots as traversal.
    if (!name || name.includes('/') || name.includes('\\') || name.includes('\0')) {
      throw {
        code: 'run_store_error',
        message: 'invalid transaction entry name',
      } satisfies RunStoreError;
    }
    return name;
  }

  function childInDir(dir: string, name: string): string {
    return path.join(dir, assertSafeEntryName(name));
  }

  function closeFdQuiet(fd: number | undefined): void {
    if (fd === undefined) return;
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }

  /**
   * Open a pathname session for a run directory under the trusted runs root.
   * Symlink/junction tampering inside the runs tree is unsupported.
   */
  function openRunDirHandle(publicDir: string, runId?: string): RunDirHandle {
    try {
      const st = fs.lstatSync(publicDir);
      if (!st.isDirectory()) {
        throw {
          code: 'corrupt_run',
          runId,
          message: 'run path is not a directory',
        } satisfies RunStoreError;
      }
      return { publicDir };
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT') {
        throw {
          code: 'run_not_found',
          runId,
          message: 'run directory path component missing',
        } satisfies RunStoreError;
      }
      if (
        isRunStoreError(err) &&
        typeof (err as { code: unknown }).code === 'string' &&
        [
          'run_not_found',
          'corrupt_run',
          'run_store_error',
          'run_busy',
          'durable_write_error',
          'generation_mismatch',
        ].includes(String((err as { code: unknown }).code))
      ) {
        throw err;
      }
      throw {
        code: 'run_store_error',
        runId,
        message: `open run directory failed: ${messageOf(err)}`,
      } satisfies RunStoreError;
    }
  }

  function revalidatePublicRunDir(
    _publicDir: string,
    _expected: FileIdentity | undefined,
    _runId?: string
  ): void {
    // Pathname mode: cooperative generation checks remain on lock/intent identities.
    // Hostile same-user pathname replacement is outside the trusted-runs threat model.
    void _publicDir;
    void _expected;
    void _runId;
  }

  function closeRunDirHandle(_session: RunDirHandle): void {
    void _session;
  }

  function fsyncRunDir(dirPath: string): void {
    if (!capabilities.directoryFsync) return;
    directorySyncImpl(dirPath);
  }

  function pathEntryKind(
    filePath: string
  ): 'absent' | 'regular' | 'symlink' | 'directory' | 'other' {
    try {
      const st = fs.lstatSync(filePath);
      if (st.isSymbolicLink()) return 'symlink';
      if (st.isFile()) return 'regular';
      if (st.isDirectory()) return 'directory';
      return 'other';
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return 'absent';
      return 'other';
    }
  }

  function validatePrivateEntryStats(
    st: fs.Stats,
    kind: 'file' | 'directory'
  ): { ok: true } | { ok: false; reason: string } {
    if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
    if (kind === 'file') {
      if (!st.isFile()) return { ok: false, reason: 'not a regular file' };
      if (POSIX && (st.mode & 0o777) !== FILE_MODE) {
        return { ok: false, reason: 'wrong mode' };
      }
    } else {
      if (!st.isDirectory()) return { ok: false, reason: 'not a directory' };
      if (POSIX && (st.mode & 0o777) !== DIR_MODE) {
        return { ok: false, reason: 'wrong mode' };
      }
    }
    return { ok: true };
  }

  /** Validate a private regular file under runDir (lstat only; never follows). */
  function validatePrivateRegularTxFile(
    filePath: string,
    runDir: string,
    expectedBase: string
  ): { ok: true } | { ok: false; reason: string } {
    if (path.basename(filePath) !== expectedBase) {
      return { ok: false, reason: 'unexpected basename' };
    }
    if (path.dirname(filePath) !== runDir) {
      return { ok: false, reason: 'path escapes run directory' };
    }
    try {
      const st = fs.lstatSync(filePath);
      return validatePrivateEntryStats(st, 'file');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ok: false, reason: 'absent' };
      return { ok: false, reason: messageOf(err) };
    }
  }

  interface VerifiedPrivateFile {
    path: string;
    expectedBase: string;
    identity: FileIdentity;
    digest: string;
    bytes: number;
    data: Buffer;
    uid: number;
    mode: number;
    phase?: TxPhase;
  }

  /**
   * Open a private transaction file with pathname, verify lstat/fstat inode,
   * uid/mode/type, and return identity + content digest + exact fd-read bytes.
   */
  function openVerifiedPrivateFile(
    filePath: string,
    runDir: string,
    expectedBase: string,
    opts?: { skipPathBound?: boolean; parseMarkerPhase?: boolean }
  ): VerifiedPrivateFile {
    if (path.basename(filePath) !== expectedBase) {
      throw {
        code: 'corrupt_run',
        message: 'private transaction file unsafe: unexpected basename',
      } satisfies RunStoreError;
    }
    if (!opts?.skipPathBound) {
      const validated = validatePrivateRegularTxFile(filePath, runDir, expectedBase);
      if (!validated.ok) {
        throw {
          code: 'corrupt_run',
          message: `private transaction file unsafe: ${validated.reason}`,
        } satisfies RunStoreError;
      }
    }
    let fd: number | undefined;
    try {
      const before = fs.lstatSync(filePath);
      const beforeV = validatePrivateEntryStats(before, 'file');
      if (!beforeV.ok) {
        throw {
          code: 'corrupt_run',
          message: `private transaction file unsafe: ${beforeV.reason}`,
        } satisfies RunStoreError;
      }
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
      const after = fs.fstatSync(fd);
      if (!sameIdentity(identityOf(before), identityOf(after)) || !after.isFile()) {
        throw {
          code: 'corrupt_run',
          message: 'private transaction file replaced during open',
        } satisfies RunStoreError;
      }
      const modeCheck = validatePrivateEntryStats(after, 'file');
      if (!modeCheck.ok) {
        throw {
          code: 'corrupt_run',
          message: `private transaction file unsafe: ${modeCheck.reason}`,
        } satisfies RunStoreError;
      }
      const data = fs.readFileSync(fd);
      // Post-read fstat on the same fd must still match.
      const postFd = fs.fstatSync(fd);
      if (!sameIdentity(identityOf(after), identityOf(postFd)) || !postFd.isFile()) {
        throw {
          code: 'corrupt_run',
          message: 'private transaction file replaced after read',
        } satisfies RunStoreError;
      }
      let phase: TxPhase | undefined;
      if (opts?.parseMarkerPhase) {
        try {
          const parsed = parseTxMarker(JSON.parse(data.toString('utf8')));
          if (parsed) phase = parsed.phase;
        } catch {
          /* leave phase undefined */
        }
      }
      return {
        path: filePath,
        expectedBase,
        identity: identityOf(after),
        digest: sha256Hex(data),
        bytes: data.byteLength,
        data,
        uid: after.uid,
        mode: after.mode,
        phase,
      };
    } catch (err) {
      if (isRunStoreError(err)) throw err;
      throw {
        code: 'corrupt_run',
        message: `private transaction file unsafe: ${messageOf(err)}`,
      } satisfies RunStoreError;
    } finally {
      closeFdQuiet(fd);
    }
  }

  /**
   * Unlink only the exact verified inode/digest/uid/mode generation; preserve evidence
   * on replacement. Never treats a newly valid file at the same path as authority.
   */
  function unlinkVerifiedPrivateFile(verified: VerifiedPrivateFile): void {
    try {
      const st = fs.lstatSync(verified.path);
      if (!st.isFile() || st.isSymbolicLink()) {
        throw {
          code: 'corrupt_run',
          message: 'refusing to unlink non-file after validation',
        } satisfies RunStoreError;
      }
      if (!sameIdentity(verified.identity, identityOf(st))) {
        throw {
          code: 'generation_mismatch',
          message: 'entry identity changed before unlink',
        } satisfies RunStoreError;
      }
      if (st.uid !== verified.uid || (st.mode & 0o777) !== (verified.mode & 0o777)) {
        throw {
          code: 'corrupt_run',
          message: 'entry uid/mode changed before unlink',
        } satisfies RunStoreError;
      }
      // Re-open no-follow to confirm digest still matches before unlink.
      let fd: number | undefined;
      try {
        fd = fs.openSync(verified.path, fs.constants.O_RDONLY | noFollowFlag());
        const after = fs.fstatSync(fd);
        if (!sameIdentity(verified.identity, identityOf(after))) {
          throw {
            code: 'corrupt_run',
            message: 'entry identity changed before unlink open',
          } satisfies RunStoreError;
        }
        const data = fs.readFileSync(fd);
        if (sha256Hex(data) !== verified.digest || data.byteLength !== verified.bytes) {
          throw {
            code: 'corrupt_run',
            message: 'entry content digest changed before unlink',
          } satisfies RunStoreError;
        }
        if (verified.phase !== undefined) {
          try {
            const parsed = parseTxMarker(JSON.parse(data.toString('utf8')));
            if (!parsed || parsed.phase !== verified.phase) {
              throw {
                code: 'corrupt_run',
                message: 'entry phase changed before unlink',
              } satisfies RunStoreError;
            }
          } catch (phaseErr) {
            if (
              phaseErr &&
              typeof phaseErr === 'object' &&
              'code' in phaseErr &&
              'message' in phaseErr
            ) {
              throw phaseErr;
            }
            throw {
              code: 'corrupt_run',
              message: 'entry phase unreadable before unlink',
            } satisfies RunStoreError;
          }
        }
      } finally {
        closeFdQuiet(fd);
      }
      fs.unlinkSync(verified.path);
      // Confirm absence; replacement at path means identity race — preserve evidence.
      if (pathEntryKind(verified.path) !== 'absent') {
        const post = fs.lstatSync(verified.path);
        if (sameIdentity(verified.identity, identityOf(post))) {
          throw {
            code: 'corrupt_run',
            message: 'entry still present after unlink',
          } satisfies RunStoreError;
        }
        throw {
          code: 'corrupt_run',
          message: 'entry replaced after unlink; evidence preserved',
        } satisfies RunStoreError;
      }
    } catch (err) {
      if (isRunStoreError(err)) throw err;
      throw {
        code: 'corrupt_run',
        message: `verified unlink failed: ${messageOf(err)}`,
      } satisfies RunStoreError;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function unlinkIfIdentity(
    filePath: string,
    expected: FileIdentity,
    kind: 'file' | 'directory'
  ): void {
    const st = fs.lstatSync(filePath);
    if (kind === 'file') {
      if (!st.isFile() || st.isSymbolicLink()) {
        throw {
          code: 'corrupt_run',
          message: 'refusing to unlink non-file after validation',
        } satisfies RunStoreError;
      }
    } else if (!st.isDirectory() || st.isSymbolicLink()) {
      throw {
        code: 'corrupt_run',
        message: 'refusing to rmdir non-directory after validation',
      } satisfies RunStoreError;
    }
    if (!sameIdentity(expected, identityOf(st))) {
      throw {
        code: 'corrupt_run',
        message: 'entry identity changed before unlink',
      } satisfies RunStoreError;
    }
    if (kind === 'file') fs.unlinkSync(filePath);
    else fs.rmdirSync(filePath);
  }

  function readPrivateFileBytes(
    filePath: string,
    runDir: string,
    expectedBase: string,
    opts?: { skipPathBound?: boolean }
  ): Buffer {
    // Single no-follow open: return the exact fd-read bytes (no second path open).
    return openVerifiedPrivateFile(filePath, runDir, expectedBase, opts).data;
  }

  /**
   * Authority run.json read: pathname + lstat/fstat match + uid/mode/type +
   * same-fd bytes + post-read fstat. Never follows a replacement symlink.
   */
  function readAuthorityRunJson(
    filePath: string,
    runDir: string,
    opts?: { skipPathBound?: boolean }
  ): VerifiedPrivateFile {
    const kind = pathEntryKind(filePath);
    if (kind === 'symlink') {
      throw {
        code: 'corrupt_run',
        message: 'run.json is a symlink',
      } satisfies RunStoreError;
    }
    if (kind !== 'regular') {
      throw {
        code: 'corrupt_run',
        message: kind === 'absent' ? 'run.json not found' : 'run.json is not a regular file',
      } satisfies RunStoreError;
    }
    return openVerifiedPrivateFile(filePath, runDir, 'run.json', opts);
  }

  /** Read run.json authority without following symlinks; validate regular private file. */
  function readRunJsonNoFollow(
    filePath: string,
    runDir: string,
    opts?: { skipPathBound?: boolean }
  ): Buffer {
    return readAuthorityRunJson(filePath, runDir, opts).data;
  }

  /**
   * Fast-path authority read via ordinary pathnames under the trusted runs root.
   */
  function readRunJsonViaDirComponents(runId: string, publicDir: string): Buffer {
    const session = openRunDirHandle(publicDir, runId);
    try {
      const lockedFile = childInDir(session.publicDir, 'run.json');
      return readAuthorityRunJson(lockedFile, publicDir).data;
    } finally {
      closeRunDirHandle(session);
    }
  }

  /**
   * Write private transaction bytes via O_CREAT|O_EXCL|pathname temp + atomic rename.
   * Paths may be public or dir-fd-relative; identity is checked through open fd.
   */
  function writePrivateBytesAtomic(
    destPath: string,
    runDir: string,
    expectedBase: string,
    data: Buffer,
    dirSync: (dirPath: string) => void = fsyncRunDir,
    session?: RunDirHandle
  ): void {
    if (path.basename(destPath) !== expectedBase) {
      throw {
        code: 'run_store_error',
        message: 'transaction write destination basename mismatch',
      } satisfies RunStoreError;
    }
    if (!session) {
      if (path.dirname(destPath) !== runDir) {
        throw {
          code: 'run_store_error',
          message: 'transaction write destination escapes run directory',
        } satisfies RunStoreError;
      }
    }

    const existing = pathEntryKind(destPath);
    if (existing === 'symlink' || existing === 'directory' || existing === 'other') {
      throw {
        code: 'corrupt_run',
        message: `transaction destination is unsafe (${existing})`,
      } satisfies RunStoreError;
    }
    if (existing === 'regular') {
      try {
        const st = fs.lstatSync(destPath);
        const v = validatePrivateEntryStats(st, 'file');
        if (!v.ok) {
          throw {
            code: 'corrupt_run',
            message: `transaction destination is unsafe: ${v.reason}`,
          } satisfies RunStoreError;
        }
      } catch (err) {
        if (isRunStoreError(err)) throw err;
        throw {
          code: 'corrupt_run',
          message: `transaction destination is unsafe: ${messageOf(err)}`,
        } satisfies RunStoreError;
      }
    }

    const tmpName = `.${expectedBase}.${instanceId}.${randomUUID()}.tmp`;
    const tmp = session ? childInDir(session.publicDir, tmpName) : path.join(runDir, tmpName);
    let fd: number | undefined;
    let writtenIdentity: FileIdentity | undefined;
    try {
      fd = fs.openSync(
        tmp,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollowFlag(),
        FILE_MODE
      );
      try {
        fs.fchmodSync(fd, FILE_MODE);
      } catch {
        applyMode(tmp, FILE_MODE);
      }
      fs.writeFileSync(fd, data);
      fileFsyncImpl(fd);
      writtenIdentity = identityOf(fs.fstatSync(fd));
      fs.closeSync(fd);
      fd = undefined;

      // Identity revalidation before rename (temp replacement race).
      const tmpStat = fs.lstatSync(tmp);
      if (
        !writtenIdentity ||
        !sameIdentity(writtenIdentity, identityOf(tmpStat)) ||
        !tmpStat.isFile()
      ) {
        throw {
          code: 'corrupt_run',
          message: 'transaction temp replaced after close',
        } satisfies RunStoreError;
      }
      const modeCheck = validatePrivateEntryStats(tmpStat, 'file');
      if (!modeCheck.ok) {
        throw {
          code: 'corrupt_run',
          message: `transaction temp unsafe: ${modeCheck.reason}`,
        } satisfies RunStoreError;
      }

      fs.renameSync(tmp, destPath);

      const destStat = fs.lstatSync(destPath);
      if (!sameIdentity(writtenIdentity, identityOf(destStat)) || !destStat.isFile()) {
        throw {
          code: 'corrupt_run',
          message: 'transaction destination identity mismatch after rename',
        } satisfies RunStoreError;
      }
      const destMode = validatePrivateEntryStats(destStat, 'file');
      if (!destMode.ok) {
        throw {
          code: 'corrupt_run',
          message: `transaction destination unsafe after rename: ${destMode.reason}`,
        } satisfies RunStoreError;
      }

      if (session) {
        fsyncRunDir(session.publicDir);
        revalidatePublicRunDir(session.publicDir, undefined);
      } else {
        dirSync(runDir);
      }
    } finally {
      closeFdQuiet(fd);
      try {
        if (pathEntryKind(tmp) !== 'absent') fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  type MarkerPublishResult =
    | { renameOccurred: true; dirSyncCompleted: true }
    | { renameOccurred: true; dirSyncCompleted: false; syncError: unknown }
    | { renameOccurred: false; dirSyncCompleted: false; error: unknown };

  function writeMarkerStrict(
    dir: string,
    marker: TxMarker,
    dirSync: (dirPath: string) => void = fsyncRunDir,
    session?: RunDirHandle
  ): MarkerPublishResult {
    const markerPath = session
      ? childInDir(session.publicDir, TX_MARKER_NAME)
      : path.join(dir, TX_MARKER_NAME);
    const payload = Buffer.from(`${JSON.stringify(marker)}\n`);
    const tmpName = `.${TX_MARKER_NAME}.${instanceId}.${randomUUID()}.tmp`;
    const tmp = session ? childInDir(session.publicDir, tmpName) : path.join(dir, tmpName);
    let fd: number | undefined;
    let writtenIdentity: FileIdentity | undefined;
    try {
      const existing = pathEntryKind(markerPath);
      if (existing === 'symlink' || existing === 'directory' || existing === 'other') {
        return {
          renameOccurred: false,
          dirSyncCompleted: false,
          error: {
            code: 'corrupt_run',
            message: `transaction marker destination is unsafe (${existing})`,
          } satisfies RunStoreError,
        };
      }
      fd = fs.openSync(
        tmp,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollowFlag(),
        FILE_MODE
      );
      try {
        fs.fchmodSync(fd, FILE_MODE);
      } catch {
        applyMode(tmp, FILE_MODE);
      }
      fs.writeFileSync(fd, payload);
      fileFsyncImpl(fd);
      writtenIdentity = identityOf(fs.fstatSync(fd));
      fs.closeSync(fd);
      fd = undefined;
      const tmpStat = fs.lstatSync(tmp);
      if (
        !writtenIdentity ||
        !sameIdentity(writtenIdentity, identityOf(tmpStat)) ||
        !tmpStat.isFile()
      ) {
        return {
          renameOccurred: false,
          dirSyncCompleted: false,
          error: {
            code: 'corrupt_run',
            message: 'transaction marker temp replaced after close',
          } satisfies RunStoreError,
        };
      }
      fs.renameSync(tmp, markerPath);
      const destStat = fs.lstatSync(markerPath);
      if (!sameIdentity(writtenIdentity, identityOf(destStat))) {
        return {
          renameOccurred: true,
          dirSyncCompleted: false,
          syncError: {
            code: 'corrupt_run',
            message: 'transaction marker identity mismatch after rename',
          } satisfies RunStoreError,
        };
      }
      try {
        if (session) {
          fsyncRunDir(session.publicDir);
          revalidatePublicRunDir(session.publicDir, undefined);
        }
        // Always invoke the provided directory sync seam (may be the real fsync
        // or a test injection for committed-marker publication uncertainty).
        dirSync(dir);
        return { renameOccurred: true, dirSyncCompleted: true };
      } catch (syncErr) {
        return { renameOccurred: true, dirSyncCompleted: false, syncError: syncErr };
      }
    } catch (err) {
      return { renameOccurred: false, dirSyncCompleted: false, error: err };
    } finally {
      closeFdQuiet(fd);
      try {
        if (pathEntryKind(tmp) !== 'absent') fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  function parseTxMarker(raw: unknown): TxMarker | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const o = raw as Record<string, unknown>;
    if (o.version !== TX_MARKER_VERSION) return undefined;
    if (o.phase !== 'prepared' && o.phase !== 'committed') return undefined;
    if (typeof o.oldSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(o.oldSha256)) return undefined;
    if (typeof o.newSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(o.newSha256)) return undefined;
    if (typeof o.oldBytes !== 'number' || !Number.isInteger(o.oldBytes) || o.oldBytes < 0) {
      return undefined;
    }
    if (typeof o.newBytes !== 'number' || !Number.isInteger(o.newBytes) || o.newBytes < 0) {
      return undefined;
    }
    // Reject unexpected own keys so forensic markers cannot smuggle state.
    const allowed = new Set(['version', 'phase', 'oldSha256', 'oldBytes', 'newSha256', 'newBytes']);
    for (const key of Object.keys(o)) {
      if (!allowed.has(key)) return undefined;
    }
    return {
      version: TX_MARKER_VERSION,
      phase: o.phase,
      oldSha256: o.oldSha256,
      oldBytes: o.oldBytes,
      newSha256: o.newSha256,
      newBytes: o.newBytes,
    };
  }

  function parseTxLockOwner(raw: unknown): TxLockOwner | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const o = raw as Record<string, unknown>;
    if (o.version !== TX_LOCK_VERSION) return undefined;
    if (typeof o.pid !== 'number' || !Number.isInteger(o.pid) || o.pid <= 0) return undefined;
    if (typeof o.processStart !== 'string' || o.processStart.length === 0) return undefined;
    if (typeof o.token !== 'string' || !isStrictLockToken(o.token)) return undefined;
    if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) return undefined;
    const allowed = new Set(['version', 'pid', 'processStart', 'token', 'timestamp']);
    for (const key of Object.keys(o)) {
      if (!allowed.has(key)) return undefined;
    }
    return {
      version: TX_LOCK_VERSION,
      pid: o.pid,
      processStart: o.processStart,
      token: o.token,
      timestamp: o.timestamp,
    };
  }

  /**
   * Phase-specific cleanup using optional authority-decision verified entries.
   * When expected entries are provided, only that exact inode/digest generation is removed.
   * Re-reading a replacement path as a new authority generation is never allowed.
   */
  function cleanupTxPhase(
    dir: string,
    phase: TxPhase,
    session?: RunDirHandle,
    expected?: {
      marker?: VerifiedPrivateFile;
      rollback?: VerifiedPrivateFile;
    }
  ): { ok: true } | { ok: false; error: unknown } {
    const marker = session
      ? childInDir(session.publicDir, TX_MARKER_NAME)
      : path.join(dir, TX_MARKER_NAME);
    const rollback = session
      ? childInDir(session.publicDir, TX_ROLLBACK_NAME)
      : path.join(dir, TX_ROLLBACK_NAME);
    const syncDir = (): void => {
      if (session) fsyncRunDir(session.publicDir);
      else fsyncRunDir(dir);
    };
    const unlinkEntry = (
      filePath: string,
      base: string,
      expectedEntry?: VerifiedPrivateFile
    ): void => {
      if (pathEntryKind(filePath) === 'absent') {
        if (expectedEntry) {
          throw {
            code: 'corrupt_run',
            message: 'expected transaction entry absent before cleanup',
          } satisfies RunStoreError;
        }
        return;
      }
      if (expectedEntry) {
        // Re-verify the exact decision generation; never open a replacement as authority.
        if (expectedEntry.path !== filePath || expectedEntry.expectedBase !== base) {
          throw {
            code: 'corrupt_run',
            message: 'cleanup expected entry path mismatch',
          } satisfies RunStoreError;
        }
        unlinkVerifiedPrivateFile(expectedEntry);
        return;
      }
      const verified = openVerifiedPrivateFile(filePath, dir, base, {
        skipPathBound: !!session,
        parseMarkerPhase: base === TX_MARKER_NAME,
      });
      unlinkVerifiedPrivateFile(verified);
    };
    try {
      if (phase === 'prepared') {
        // Marker first, then rollback: orphan rollback with matching old run.json is safe.
        if (pathEntryKind(marker) !== 'absent' || expected?.marker) {
          unlinkEntry(marker, TX_MARKER_NAME, expected?.marker);
          fireStrictTxHook('after_cleanup_marker_unlink');
          syncDir();
          fireStrictTxHook('after_cleanup_first_dir_sync');
        }
        if (pathEntryKind(rollback) !== 'absent' || expected?.rollback) {
          unlinkEntry(rollback, TX_ROLLBACK_NAME, expected?.rollback);
          fireStrictTxHook('after_cleanup_rollback_unlink');
          syncDir();
          fireStrictTxHook('after_cleanup_second_dir_sync');
        }
      } else {
        // Rollback first, then marker: committed marker without rollback verifies new run.json.
        if (pathEntryKind(rollback) !== 'absent' || expected?.rollback) {
          unlinkEntry(rollback, TX_ROLLBACK_NAME, expected?.rollback);
          fireStrictTxHook('after_cleanup_rollback_unlink');
          syncDir();
          fireStrictTxHook('after_cleanup_first_dir_sync');
        }
        if (pathEntryKind(marker) !== 'absent' || expected?.marker) {
          unlinkEntry(marker, TX_MARKER_NAME, expected?.marker);
          fireStrictTxHook('after_cleanup_marker_unlink');
          syncDir();
          fireStrictTxHook('after_cleanup_second_dir_sync');
        }
      }
      return { ok: true };
    } catch (err) {
      if (isBypassCleanupError(err)) throw err;
      return { ok: false, error: err };
    }
  }

  /**
   * After committed cleanup fails, re-read marker/rollback/run.json and accept
   * success only when remaining artifacts unambiguously recover to the new run.json.
   * Every authority read is pathname + inode/digest verified.
   * When expected marker/rollback identities are provided, any present entry with
   * different dev/ino is rejected as generation_mismatch (replacement never washes).
   */
  function revalidateCommittedState(
    dir: string,
    expectedNew: { sha256: string; bytes: number },
    session?: RunDirHandle,
    expected?: {
      markerIdentity?: FileIdentity;
      rollbackIdentity?: FileIdentity;
    }
  ): { ok: true } | { ok: false; error: RunStoreError } {
    const marker = session
      ? childInDir(session.publicDir, TX_MARKER_NAME)
      : path.join(dir, TX_MARKER_NAME);
    const rollback = session
      ? childInDir(session.publicDir, TX_ROLLBACK_NAME)
      : path.join(dir, TX_ROLLBACK_NAME);
    const target = session ? childInDir(session.publicDir, 'run.json') : path.join(dir, 'run.json');

    const checkGeneration = (
      filePath: string,
      expectedIdentity: FileIdentity | undefined,
      label: string
    ): string | undefined => {
      if (!expectedIdentity) return undefined;
      try {
        const st = fs.lstatSync(filePath);
        if (!sameIdentity(expectedIdentity, identityOf(st))) {
          return `committed cleanup: ${label} replaced (generation mismatch)`;
        }
      } catch {
        // Missing when expected: also mismatch.
        return `committed cleanup: ${label} missing (generation mismatch)`;
      }
      return undefined;
    };

    try {
      // Reject replaced marker/rollback before re-reading content.
      const markerKind = pathEntryKind(marker);
      const rollbackKind = pathEntryKind(rollback);
      if (expected?.markerIdentity && markerKind === 'regular') {
        const genErr = checkGeneration(marker, expected.markerIdentity, 'marker');
        if (genErr) return { ok: false, error: { code: 'generation_mismatch', message: genErr } };
      }
      if (expected?.rollbackIdentity && rollbackKind === 'regular') {
        const genErr = checkGeneration(rollback, expected.rollbackIdentity, 'rollback');
        if (genErr) return { ok: false, error: { code: 'generation_mismatch', message: genErr } };
      }

      if (
        markerKind === 'symlink' ||
        markerKind === 'directory' ||
        markerKind === 'other' ||
        rollbackKind === 'symlink' ||
        rollbackKind === 'directory' ||
        rollbackKind === 'other'
      ) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            message: 'committed cleanup left unsafe transaction entries',
          },
        };
      }
      if (pathEntryKind(target) !== 'regular') {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            message: 'committed cleanup: run.json missing or unsafe',
          },
        };
      }
      // Authority run.json via single no-follow fd + digest (exact fd-read bytes).
      const runVerified = readAuthorityRunJson(target, dir, {
        skipPathBound: !!session,
      });
      if (runVerified.bytes !== expectedNew.bytes || runVerified.digest !== expectedNew.sha256) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            message: 'committed cleanup: run.json no longer matches committed digest',
          },
        };
      }
      // No leftovers: clean committed success.
      if (markerKind === 'absent' && rollbackKind === 'absent') return { ok: true };

      if (markerKind === 'regular') {
        // Re-verify identity again before opening (TOCTOU defense).
        if (expected?.markerIdentity) {
          const genErr2 = checkGeneration(marker, expected.markerIdentity, 'marker');
          if (genErr2)
            return { ok: false, error: { code: 'generation_mismatch', message: genErr2 } };
        }
        const markerVerified = openVerifiedPrivateFile(marker, dir, TX_MARKER_NAME, {
          skipPathBound: !!session,
          parseMarkerPhase: true,
        });
        let parsed: unknown;
        try {
          // Use bytes already verified on the same fd open — no second path read.
          parsed = JSON.parse(markerVerified.data.toString('utf8'));
        } catch {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              message: 'committed cleanup: marker unreadable',
            },
          };
        }
        const m = parseTxMarker(parsed);
        if (!m || m.phase !== 'committed') {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              message: 'committed cleanup: marker is not a committed phase',
            },
          };
        }
        if (m.newBytes !== expectedNew.bytes || m.newSha256 !== expectedNew.sha256) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              message: 'committed cleanup: marker digest mismatch',
            },
          };
        }
        if (markerVerified.phase !== undefined && markerVerified.phase !== 'committed') {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              message: 'committed cleanup: marker phase identity mismatch',
            },
          };
        }
        if (rollbackKind === 'regular') {
          if (expected?.rollbackIdentity) {
            const genErr3 = checkGeneration(rollback, expected.rollbackIdentity, 'rollback');
            if (genErr3) {
              return { ok: false, error: { code: 'generation_mismatch', message: genErr3 } };
            }
          }
          openVerifiedPrivateFile(rollback, dir, TX_ROLLBACK_NAME, {
            skipPathBound: !!session,
          });
        }
        return { ok: true };
      }

      if (rollbackKind === 'regular') {
        if (expected?.rollbackIdentity) {
          const genErr4 = checkGeneration(rollback, expected.rollbackIdentity, 'rollback');
          if (genErr4) {
            return { ok: false, error: { code: 'generation_mismatch', message: genErr4 } };
          }
        }
        openVerifiedPrivateFile(rollback, dir, TX_ROLLBACK_NAME, {
          skipPathBound: !!session,
        });
        return { ok: true };
      }
      return {
        ok: false,
        error: {
          code: 'corrupt_run',
          message: 'committed cleanup: non-recoverable leftover shape',
        },
      };
    } catch (err) {
      if (isRunStoreError(err)) {
        return { ok: false, error: err as RunStoreError };
      }
      return {
        ok: false,
        error: {
          code: 'durable_write_error',
          message: `committed cleanup revalidation failed: ${messageOf(err)}`,
        },
      };
    }
  }

  function removeTxFiles(dir: string, phase: TxPhase = 'prepared', session?: RunDirHandle): void {
    const result = cleanupTxPhase(dir, phase, session);
    if (!result.ok) {
      // Best-effort only for non-strict leftover sweeps; leave evidence on failure.
    }
  }

  function fsyncPathStrict(filePath: string): void {
    let fd: number | undefined;
    try {
      // Open write-capable: Windows FlushFileBuffers rejects O_RDONLY with EPERM.
      // O_RDWR is a no-op for content and works for owner-private 0600 files on POSIX.
      fd = fs.openSync(filePath, fs.constants.O_RDWR | noFollowFlag());
      fileFsyncImpl(fd);
    } finally {
      closeFdQuiet(fd);
    }
  }

  function sleepMs(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const bounded = Math.min(Math.floor(ms), TX_LOCK_WAIT_MS_MAX);
    if (bounded <= 0) return;
    const buf = new SharedArrayBuffer(4);
    const arr = new Int32Array(buf);
    Atomics.wait(arr, 0, 0, bounded);
  }

  /** Monotonic milliseconds for lock deadlines (immune to wall-clock jumps). */
  function monotonicNowMs(): number {
    return Number(process.hrtime.bigint() / 1_000_000n);
  }

  function isProcessAliveWithStart(ownerPid: number, processStart: string): boolean | 'unknown' {
    if (ownerPid === process.pid && processStart === selfStartIdentity) return true;
    try {
      process.kill(ownerPid, 0);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false;
      if (code === 'EPERM') {
        // Exists but inaccessible — cannot steal.
        return true;
      }
      return 'unknown';
    }
    if (process.platform !== 'linux') {
      // Cannot prove start identity on non-Linux; fail closed (treat as live).
      return true;
    }
    const currentStart = processStartIdentity(ownerPid);
    if (currentStart === undefined) {
      // /proc unreadable while kill(0) succeeded — fail closed.
      return 'unknown';
    }
    if (currentStart !== processStart) return false;
    return true;
  }

  const TX_STEAL_INTENT_NAME = 'steal.intent';
  const TX_RELEASE_INTENT_NAME = 'release.intent';
  /** Fixed safe name for the previous owner during transfer (never from a read token). */
  const TX_OWNER_PREVIOUS_NAME = 'owner.previous';
  const TX_OWNER_TMP_PREFIX = '.owner.';
  /**
   * Strict single-component token: alphanumeric + dash/underscore only, bounded length.
   * Never path separators, `..`, leading dots, or control characters.
   */
  const LOCK_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
  const LOCK_TOKEN_MAX_LEN = 63;
  interface StealIntent {
    version: typeof TX_LOCK_VERSION;
    kind: 'steal';
    contenderToken: string;
    contenderPid: number;
    contenderProcessStart: string;
    ownerToken: string;
    ownerPid: number;
    ownerProcessStart: string;
    ownerIno: number;
    ownerDev: number;
    lockIno: number;
    lockDev: number;
    /** Locally generated temp basename for new owner (never derived from read tokens). */
    newOwnerTempName: string;
    /** Identity of the pre-published new-owner temp file. */
    newOwnerTempIno: number;
    newOwnerTempDev: number;
    /** Content digest and byte length of the pre-published new-owner temp. */
    newOwnerTempDigest: string;
    newOwnerTempBytes: number;
  }

  interface ReleaseIntent {
    version: typeof TX_LOCK_VERSION;
    kind: 'release';
    token: string;
    ownerPid: number;
    ownerProcessStart: string;
    ownerIno: number;
    ownerDev: number;
    lockIno: number;
    lockDev: number;
  }

  function isStrictLockToken(token: string): boolean {
    if (typeof token !== 'string') return false;
    if (token.length === 0 || token.length > LOCK_TOKEN_MAX_LEN) return false;
    if (!LOCK_TOKEN_RE.test(token)) return false;
    if (
      token.includes('..') ||
      token.includes('/') ||
      token.includes('\\') ||
      token.includes('\0')
    ) {
      return false;
    }
    /* eslint-disable-next-line no-control-regex */
    if (/[\x00-\x1f\x7f]/.test(token)) return false;
    return true;
  }
  /** Exact steal-intent owner temp grammar: `.owner.<strict-token>.tmp`. */
  function isValidOwnerTempName(name: string): boolean {
    if (typeof name !== 'string') return false;
    if (!name.startsWith(TX_OWNER_TMP_PREFIX) || !name.endsWith('.tmp')) return false;
    const middle = name.slice(TX_OWNER_TMP_PREFIX.length, name.length - '.tmp'.length);
    return isStrictLockToken(middle);
  }

  function assertStrictLockToken(token: string, label: string): void {
    if (!isStrictLockToken(token)) {
      throw {
        code: 'corrupt_run',
        message: `lock ${label} token is not a strict single-component token`,
      } satisfies RunStoreError;
    }
  }

  /**
   * Tombstone basename uses only a locally validated token. Never concatenates an
   * unvalidated parsed token into a path; requires exact equality with held token.
   */
  function tombstoneNameForToken(token: string): string {
    assertStrictLockToken(token, 'tombstone');
    return `${TX_LOCK_DIR_NAME}.tomb.${token}`;
  }

  function parseStealIntent(raw: unknown): StealIntent | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const o = raw as Record<string, unknown>;
    if (o.version !== TX_LOCK_VERSION || o.kind !== 'steal') return undefined;
    if (typeof o.contenderToken !== 'string' || !isStrictLockToken(o.contenderToken)) {
      return undefined;
    }
    if (typeof o.ownerToken !== 'string' || !isStrictLockToken(o.ownerToken)) return undefined;
    if (
      typeof o.contenderPid !== 'number' ||
      !Number.isInteger(o.contenderPid) ||
      o.contenderPid <= 0
    ) {
      return undefined;
    }
    if (typeof o.ownerPid !== 'number' || !Number.isInteger(o.ownerPid) || o.ownerPid <= 0) {
      return undefined;
    }
    if (typeof o.contenderProcessStart !== 'string' || !o.contenderProcessStart) return undefined;
    if (typeof o.ownerProcessStart !== 'string' || !o.ownerProcessStart) return undefined;
    if (typeof o.newOwnerTempName !== 'string' || !isValidOwnerTempName(o.newOwnerTempName)) {
      return undefined;
    }
    for (const k of [
      'ownerIno',
      'ownerDev',
      'lockIno',
      'lockDev',
      'newOwnerTempIno',
      'newOwnerTempDev',
    ] as const) {
      if (typeof o[k] !== 'number' || !Number.isInteger(o[k])) return undefined;
    }
    if (typeof o.newOwnerTempDigest !== 'string' || !/^[a-f0-9]{64}$/.test(o.newOwnerTempDigest)) {
      return undefined;
    }
    if (
      typeof o.newOwnerTempBytes !== 'number' ||
      !Number.isInteger(o.newOwnerTempBytes) ||
      o.newOwnerTempBytes < 0
    ) {
      return undefined;
    }
    const allowed = new Set([
      'version',
      'kind',
      'contenderToken',
      'contenderPid',
      'contenderProcessStart',
      'ownerToken',
      'ownerPid',
      'ownerProcessStart',
      'ownerIno',
      'ownerDev',
      'lockIno',
      'lockDev',
      'newOwnerTempName',
      'newOwnerTempIno',
      'newOwnerTempDev',
      'newOwnerTempDigest',
      'newOwnerTempBytes',
    ]);
    for (const key of Object.keys(o)) {
      if (!allowed.has(key)) return undefined;
    }
    return {
      version: TX_LOCK_VERSION,
      kind: 'steal',
      contenderToken: o.contenderToken,
      contenderPid: o.contenderPid,
      contenderProcessStart: o.contenderProcessStart,
      ownerToken: o.ownerToken,
      ownerPid: o.ownerPid,
      ownerProcessStart: o.ownerProcessStart,
      ownerIno: o.ownerIno as number,
      ownerDev: o.ownerDev as number,
      lockIno: o.lockIno as number,
      lockDev: o.lockDev as number,
      newOwnerTempName: o.newOwnerTempName,
      newOwnerTempIno: o.newOwnerTempIno as number,
      newOwnerTempDev: o.newOwnerTempDev as number,
      newOwnerTempDigest: o.newOwnerTempDigest,
      newOwnerTempBytes: o.newOwnerTempBytes as number,
    };
  }

  function parseReleaseIntent(raw: unknown): ReleaseIntent | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const o = raw as Record<string, unknown>;
    if (o.version !== TX_LOCK_VERSION || o.kind !== 'release') return undefined;
    if (typeof o.token !== 'string' || !isStrictLockToken(o.token)) return undefined;
    if (typeof o.ownerPid !== 'number' || !Number.isInteger(o.ownerPid) || o.ownerPid <= 0) {
      return undefined;
    }
    if (typeof o.ownerProcessStart !== 'string' || !o.ownerProcessStart) return undefined;
    for (const k of ['ownerIno', 'ownerDev', 'lockIno', 'lockDev'] as const) {
      if (typeof o[k] !== 'number' || !Number.isInteger(o[k])) return undefined;
    }
    const allowed = new Set([
      'version',
      'kind',
      'token',
      'ownerPid',
      'ownerProcessStart',
      'ownerIno',
      'ownerDev',
      'lockIno',
      'lockDev',
    ]);
    for (const key of Object.keys(o)) {
      if (!allowed.has(key)) return undefined;
    }
    return {
      version: TX_LOCK_VERSION,
      kind: 'release',
      token: o.token,
      ownerPid: o.ownerPid,
      ownerProcessStart: o.ownerProcessStart,
      ownerIno: o.ownerIno as number,
      ownerDev: o.ownerDev as number,
      lockIno: o.lockIno as number,
      lockDev: o.lockDev as number,
    };
  }

  function readLockOwnerVia(lockDirPath: string):
    | {
        owner: TxLockOwner;
        ownerIdentity: FileIdentity;
        lockIdentity: FileIdentity;
      }
    | undefined {
    try {
      const lockSt = fs.lstatSync(lockDirPath);
      if (!lockSt.isDirectory() || lockSt.isSymbolicLink()) return undefined;
      const lockIdentity = identityOf(lockSt);
      const lockMode = validatePrivateEntryStats(lockSt, 'directory');
      if (!lockMode.ok) return undefined;
      // Re-lstat to detect replacement without directory-fd open.
      const lockSt2 = fs.lstatSync(lockDirPath);
      if (!sameIdentity(lockIdentity, identityOf(lockSt2)) || !lockSt2.isDirectory()) {
        return undefined;
      }
      const ownerPath = path.join(lockDirPath, TX_LOCK_OWNER_NAME);
      const kind = pathEntryKind(ownerPath);
      if (kind !== 'regular') {
        return undefined;
      }
      const before = fs.lstatSync(ownerPath);
      const v = validatePrivateEntryStats(before, 'file');
      if (!v.ok) {
        return undefined;
      }
      let fd: number | undefined;
      try {
        fd = fs.openSync(ownerPath, fs.constants.O_RDONLY | noFollowFlag());
        const after = fs.fstatSync(fd);
        if (after.ino !== before.ino || after.dev !== before.dev || !after.isFile()) {
          return undefined;
        }
        const bytes = fs.readFileSync(fd);
        const owner = parseTxLockOwner(JSON.parse(bytes.toString('utf8')));
        if (!owner) {
          return undefined;
        }
        return {
          owner,
          ownerIdentity: identityOf(after),
          lockIdentity,
        };
      } finally {
        closeFdQuiet(fd);
      }
    } catch {
      return undefined;
    }
  }

  function readIntentInLockDir(
    lockDirPath: string,
    name: typeof TX_STEAL_INTENT_NAME | typeof TX_RELEASE_INTENT_NAME
  ): { raw: Buffer; identity: FileIdentity } | undefined {
    try {
      const intentPath = path.join(lockDirPath, name);
      if (pathEntryKind(intentPath) !== 'regular') return undefined;
      const before = fs.lstatSync(intentPath);
      const v = validatePrivateEntryStats(before, 'file');
      if (!v.ok) return undefined;
      let fd: number | undefined;
      try {
        fd = fs.openSync(intentPath, fs.constants.O_RDONLY | noFollowFlag());
        const after = fs.fstatSync(fd);
        if (!sameIdentity(identityOf(before), identityOf(after))) return undefined;
        return { raw: fs.readFileSync(fd), identity: identityOf(after) };
      } finally {
        closeFdQuiet(fd);
      }
    } catch {
      return undefined;
    }
  }

  /**
   * Remove a private regular file under a lock directory only when inode matches.
   * Never follows symlinks; never recursive.
   */
  function unlinkNamedInDir(lockDirPath: string, name: string, expected?: FileIdentity): boolean {
    try {
      const child = path.join(lockDirPath, name);
      if (pathEntryKind(child) === 'absent') return true;
      if (pathEntryKind(child) !== 'regular') return false;
      const st = fs.lstatSync(child);
      const v = validatePrivateEntryStats(st, 'file');
      if (!v.ok) return false;
      if (expected && !sameIdentity(expected, identityOf(st))) return false;
      fs.unlinkSync(child);
      fsyncRunDir(lockDirPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clean only a candidate/tombstone directory whose owner token and identities
   * are fully verified through a no-follow directory fd. Never recursive follow.
   */
  function removeVerifiedLockSideDir(
    sidePath: string,
    expected?: { token?: string; lockIdentity?: FileIdentity }
  ): { ok: true } | { ok: false; reason: string } {
    const lockDirPath = sidePath;
    try {
      const lockSt = fs.lstatSync(sidePath);
      if (!lockSt.isDirectory() || lockSt.isSymbolicLink()) {
        return { ok: false, reason: 'not a private directory' };
      }
      const lockMode = validatePrivateEntryStats(lockSt, 'directory');
      if (!lockMode.ok) return { ok: false, reason: lockMode.reason };
      if (expected?.lockIdentity && !sameIdentity(expected.lockIdentity, identityOf(lockSt))) {
        return { ok: false, reason: 'lock identity mismatch' };
      }
      // Pathname re-lstat for cooperative replacement detection (no directory-fd).
      const lockSt2 = fs.lstatSync(sidePath);
      if (!sameIdentity(identityOf(lockSt), identityOf(lockSt2)) || !lockSt2.isDirectory()) {
        return { ok: false, reason: 'lock dir replaced during open' };
      }
      const names = fs.readdirSync(lockDirPath);
      // Only allow known private basenames inside a side directory.
      const allowed = new Set([
        TX_LOCK_OWNER_NAME,
        TX_STEAL_INTENT_NAME,
        TX_RELEASE_INTENT_NAME,
        TX_OWNER_PREVIOUS_NAME,
      ]);
      for (const name of names) {
        if (name.startsWith(TX_OWNER_TMP_PREFIX)) {
          // Locally generated owner temp files created by this protocol
          continue;
        }
        if (
          name.startsWith(`.${TX_STEAL_INTENT_NAME}.`) ||
          name.startsWith(`.${TX_RELEASE_INTENT_NAME}.`)
        ) {
          // Locally generated intent temp files (orphaned only — winner is removed)
          try {
            const child = path.join(lockDirPath, name);
            if (pathEntryKind(child) === 'regular') {
              fs.unlinkSync(child);
            }
          } catch {
            /* leave evidence if unlink fails */
          }
          continue;
        }
        if (!allowed.has(name)) {
          // Unknown entry — refuse recursive cleanup; leave evidence.
          return { ok: false, reason: `unknown entry ${name}` };
        }
      }
      // Verify owner if present and token expected.
      const ownerPath = path.join(lockDirPath, TX_LOCK_OWNER_NAME);
      if (pathEntryKind(ownerPath) === 'regular') {
        const before = fs.lstatSync(ownerPath);
        const v = validatePrivateEntryStats(before, 'file');
        if (!v.ok) return { ok: false, reason: `owner unsafe: ${v.reason}` };
        let fd: number | undefined;
        try {
          fd = fs.openSync(ownerPath, fs.constants.O_RDONLY | noFollowFlag());
          const after = fs.fstatSync(fd);
          if (!sameIdentity(identityOf(before), identityOf(after))) {
            return { ok: false, reason: 'owner replaced' };
          }
          const owner = parseTxLockOwner(JSON.parse(fs.readFileSync(fd).toString('utf8')));
          if (!owner) return { ok: false, reason: 'owner unreadable' };
          if (expected?.token !== undefined && owner.token !== expected.token) {
            return { ok: false, reason: 'owner token mismatch' };
          }
        } finally {
          closeFdQuiet(fd);
        }
        // Unlink verified owner.
        const st2 = fs.lstatSync(ownerPath);
        if (!sameIdentity(identityOf(before), identityOf(st2))) {
          return { ok: false, reason: 'owner changed before unlink' };
        }
        fs.unlinkSync(ownerPath);
      }
      // Unlink only regular private files we recognize; never recurse into subdirs.
      for (const name of fs.readdirSync(lockDirPath)) {
        const child = path.join(lockDirPath, name);
        const kind = pathEntryKind(child);
        if (kind === 'regular') {
          const st = fs.lstatSync(child);
          const v = validatePrivateEntryStats(st, 'file');
          if (!v.ok) return { ok: false, reason: `entry ${name} unsafe` };
          fs.unlinkSync(child);
        } else if (kind !== 'absent') {
          return { ok: false, reason: `non-file entry ${name}` };
        }
      }
      fsyncRunDir(sidePath);
      // Final rmdir of empty side directory by identity.
      const finalSt = fs.lstatSync(sidePath);
      if (!sameIdentity(identityOf(lockSt), identityOf(finalSt))) {
        return { ok: false, reason: 'side dir replaced before rmdir' };
      }
      fs.rmdirSync(sidePath);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: messageOf(err) };
    }
  }

  function removeOwnCandidate(
    candidatePath: string,
    lockIdentity: FileIdentity,
    ownerToken: string
  ): void {
    const result = removeVerifiedLockSideDir(candidatePath, {
      token: ownerToken,
      lockIdentity,
    });
    if (!result.ok) {
      // Leave evidence; do not force-delete.
    }
  }

  /**
   * Scan for known leftover names but only remove entries whose owner record,
   * directory inode, uid, mode are fully verified AND owner is dead or token-matched.
   * Unknown/unsafe prefixed entries are preserved and cause no recursive cleanup.
   */
  function collectSafeLockLeftovers(session: RunDirHandle, _runId: string): void {
    let names: string[];
    try {
      names = fs.readdirSync(session.publicDir);
    } catch {
      return;
    }
    const tombPrefix = `${TX_LOCK_DIR_NAME}.tomb.`;
    for (const name of names) {
      const isCand = name.startsWith(`${TX_LOCK_DIR_NAME}.cand.`);
      const isQ = name.startsWith(`${TX_LOCK_DIR_NAME}.q.`);
      const isTomb = name.startsWith(tombPrefix);
      if (!isCand && !isQ && !isTomb) continue;
      // Side dir names are fixed private prefixes + validated token or local instance id.
      if (name.includes('/') || name.includes('\\') || name.includes('\0') || name.includes('..')) {
        continue;
      }
      const sidePath = childInDir(session.publicDir, name);
      // Symlink candidate/tombstone: never follow; leave evidence.
      if (pathEntryKind(sidePath) === 'symlink') {
        // Bounded failure only if this blocks acquisition of fixed lock — ignore.
        continue;
      }
      if (pathEntryKind(sidePath) !== 'directory') continue;
      const inspected = readLockOwnerVia(sidePath);
      if (!inspected) {
        // Incomplete/malformed — preserve; do not blind-delete.
        continue;
      }
      if (!isStrictLockToken(inspected.owner.token)) {
        // Malicious/invalid owner token — never derive cleanup paths from it.
        continue;
      }
      // Tombstone basename suffix must exactly equal verified owner token.
      if (isTomb) {
        const suffix = name.slice(tombPrefix.length);
        if (suffix !== inspected.owner.token) {
          // Wrong-token tombstone — preserve evidence.
          continue;
        }
      }
      // Only clean if owner is proven dead OR we can verify terminal abandoned state.
      const alive = isProcessAliveWithStart(inspected.owner.pid, inspected.owner.processStart);
      if (alive === false) {
        removeVerifiedLockSideDir(sidePath, {
          token: inspected.owner.token,
          lockIdentity: inspected.lockIdentity,
        });
        try {
          fsyncRunDir(session.publicDir);
        } catch {
          /* leave for next attempt */
        }
        continue;
      }
      // Live foreign candidate: leave untouched (contender may still be building).
    }
  }

  /**
   * Publish a fixed intent via write+fsync temp then atomic hard-link to the fixed
   * name (no-replace). EEXIST means another state transition owns the lock.
   * Never uses rename onto an existing fixed intent name.
   */
  function writeExclusiveInLockDir(lockDirPath: string, name: string, data: Buffer): FileIdentity {
    const dest = path.join(lockDirPath, name);
    if (pathEntryKind(dest) !== 'absent') {
      throw {
        code: 'run_busy',
        message: `lock intent already present: ${name}`,
      } satisfies RunStoreError;
    }
    // Locally generated random temp only — never from a read token.
    const tmpName = `.${name}.${randomUUID()}.tmp`;
    if (tmpName.includes('/') || tmpName.includes('..')) {
      throw {
        code: 'run_store_error',
        message: 'invalid intent temp name',
      } satisfies RunStoreError;
    }
    const tmp = path.join(lockDirPath, tmpName);
    let fd: number | undefined;
    try {
      fd = fs.openSync(
        tmp,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollowFlag(),
        FILE_MODE
      );
      try {
        fs.fchmodSync(fd, FILE_MODE);
      } catch {
        applyMode(tmp, FILE_MODE);
      }
      fs.writeFileSync(fd, data);
      fileFsyncImpl(fd);
      const written = identityOf(fs.fstatSync(fd));
      fs.closeSync(fd);
      fd = undefined;
      const tmpStat = fs.lstatSync(tmp);
      if (!sameIdentity(written, identityOf(tmpStat))) {
        throw {
          code: 'corrupt_run',
          message: 'lock intent temp replaced',
        } satisfies RunStoreError;
      }
      // Atomic no-replace publication: hard-link temp → fixed intent name.
      try {
        fs.linkSync(tmp, dest);
      } catch (linkErr) {
        if (isNoReplaceContentionError(linkErr, () => pathEntryKind(dest) !== 'absent')) {
          throw {
            code: 'run_busy',
            message: `lock intent already present: ${name}`,
          } satisfies RunStoreError;
        }
        throw linkErr;
      }
      const destStat = fs.lstatSync(dest);
      if (!sameIdentity(written, identityOf(destStat))) {
        try {
          fs.unlinkSync(dest);
        } catch {
          /* leave evidence */
        }
        throw {
          code: 'corrupt_run',
          message: 'lock intent identity mismatch after hard-link',
        } satisfies RunStoreError;
      }
      // Linked intent and temp share inode; drop temp link, fsync lock dir when supported.
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best-effort temp cleanup */
      }
      fsyncRunDir(lockDirPath);
      return written;
    } finally {
      closeFdQuiet(fd);
      try {
        if (pathEntryKind(tmp) !== 'absent') fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  function writeOwnerTempInLockDir(
    lockDirPath: string,
    owner: TxLockOwner,
    tmpName?: string
  ): { tmpName: string; identity: FileIdentity } {
    assertStrictLockToken(owner.token, 'owner');
    const name =
      tmpName ?? `${TX_OWNER_TMP_PREFIX}${randomUUID().replace(/-/g, '').slice(0, 16)}.tmp`;
    if (!isValidOwnerTempName(name)) {
      throw {
        code: 'run_store_error',
        message: 'invalid owner temp name',
      } satisfies RunStoreError;
    }
    const tmp = path.join(lockDirPath, name);
    const payload = Buffer.from(`${JSON.stringify(owner)}\n`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(
        tmp,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollowFlag(),
        FILE_MODE
      );
      try {
        fs.fchmodSync(fd, FILE_MODE);
      } catch {
        applyMode(tmp, FILE_MODE);
      }
      fs.writeFileSync(fd, payload);
      fileFsyncImpl(fd);
      const written = identityOf(fs.fstatSync(fd));
      fs.closeSync(fd);
      fd = undefined;
      fsyncRunDir(lockDirPath);
      return { tmpName: name, identity: written };
    } finally {
      closeFdQuiet(fd);
    }
  }

  /**
   * Dead-intent recovery for steal transfers using immutable intent identities.
   * Determines transfer state from exact file presence + intent identity matches.
   * All combinations restore the old owner and remove intent idempotently.
   */
  function recoverDeadStealIntent(
    session: RunDirHandle,
    lockPath: string,
    intent: StealIntent,
    intentIdentity: FileIdentity
  ): 'retry' | 'busy' {
    const contenderAlive = isProcessAliveWithStart(
      intent.contenderPid,
      intent.contenderProcessStart
    );
    if (contenderAlive !== false) return 'busy';

    const lockId: FileIdentity = { dev: intent.lockDev, ino: intent.lockIno };
    const ownerId: FileIdentity = { dev: intent.ownerDev, ino: intent.ownerIno };
    const tempId: FileIdentity = { dev: intent.newOwnerTempDev, ino: intent.newOwnerTempIno };
    const lockDirPath = lockPath;
    try {
      const lockSt = fs.lstatSync(lockPath);
      if (!lockSt.isDirectory() || !sameIdentity(lockId, identityOf(lockSt))) return 'busy';

      const ownerPath = path.join(lockDirPath, TX_LOCK_OWNER_NAME);
      const previousPath = path.join(lockDirPath, TX_OWNER_PREVIOUS_NAME);
      const tempPath = path.join(lockDirPath, intent.newOwnerTempName);
      const ownerKind = pathEntryKind(ownerPath);
      const previousKind = pathEntryKind(previousPath);
      const tempKind = pathEntryKind(tempPath);

      // State 1: old owner present + previous absent + temp present → remove temp + intent; old owner remains.
      if (ownerKind === 'regular' && previousKind === 'absent' && tempKind === 'regular') {
        const ownerSt = fs.lstatSync(ownerPath);
        if (!sameIdentity(ownerId, identityOf(ownerSt))) return 'busy';
        const tempSt = fs.lstatSync(tempPath);
        if (!sameIdentity(tempId, identityOf(tempSt))) return 'busy';
        unlinkNamedInDir(lockPath, intent.newOwnerTempName, tempId);
        unlinkNamedInDir(lockPath, TX_STEAL_INTENT_NAME, intentIdentity);
        fsyncRunDir(session.publicDir);
        return 'retry';
      }

      // State 2: owner absent + previous old + temp present → rename previous back to owner, remove temp + intent.
      if (ownerKind === 'absent' && previousKind === 'regular' && tempKind === 'regular') {
        const prevSt = fs.lstatSync(previousPath);
        if (!sameIdentity(ownerId, identityOf(prevSt))) return 'busy';
        const tempSt = fs.lstatSync(tempPath);
        if (!sameIdentity(tempId, identityOf(tempSt))) return 'busy';
        unlinkNamedInDir(lockPath, intent.newOwnerTempName, tempId);
        fs.renameSync(previousPath, ownerPath);
        const restored = fs.lstatSync(ownerPath);
        if (!sameIdentity(ownerId, identityOf(restored))) return 'busy';
        fsyncRunDir(lockPath);
        unlinkNamedInDir(lockPath, TX_STEAL_INTENT_NAME, intentIdentity);
        fsyncRunDir(session.publicDir);
        return 'retry';
      }

      // State 3: owner is new (≠ old owner inode) + previous old + temp absent → remove new owner, rename previous back, remove intent.
      if (ownerKind === 'regular' && previousKind === 'regular' && tempKind === 'absent') {
        const ownerSt = fs.lstatSync(ownerPath);
        if (sameIdentity(ownerId, identityOf(ownerSt))) {
          // Owner is old owner, not new — ambiguous.
          return 'busy';
        }
        const prevSt = fs.lstatSync(previousPath);
        if (!sameIdentity(ownerId, identityOf(prevSt))) return 'busy';
        unlinkNamedInDir(lockPath, TX_LOCK_OWNER_NAME);
        fs.renameSync(previousPath, ownerPath);
        const restored = fs.lstatSync(ownerPath);
        if (!sameIdentity(ownerId, identityOf(restored))) return 'busy';
        fsyncRunDir(lockPath);
        unlinkNamedInDir(lockPath, TX_STEAL_INTENT_NAME, intentIdentity);
        fsyncRunDir(session.publicDir);
        return 'retry';
      }

      // State 4: old owner present + previous absent + temp absent → remove intent.
      if (ownerKind === 'regular' && previousKind === 'absent' && tempKind === 'absent') {
        const ownerSt = fs.lstatSync(ownerPath);
        if (!sameIdentity(ownerId, identityOf(ownerSt))) return 'busy';
        unlinkNamedInDir(lockPath, TX_STEAL_INTENT_NAME, intentIdentity);
        fsyncRunDir(session.publicDir);
        return 'retry';
      }

      // Any other combination: ambiguous — fail closed preserving evidence.
      return 'busy';
    } catch {
      return 'busy';
    }
  }

  /**
   * Generation-safe stale transfer with immutable intent.
   * 1. Create and fsync contender's new-owner temp inside the fixed lock dir.
   * 2. Publish one immutable hard-link steal.intent with exact identities.
   * 3. Transfer: rename old owner → owner.previous, new temp → owner.json.
   * 4. Remove previous and intent by identity; return acquired.
   * Intent bytes never change after publication (no in-place phase updates).
   */
  function tryStealStaleLock(
    session: RunDirHandle,
    contender: TxLockOwner,
    _runId: string
  ): 'stolen' | 'busy' | 'retry' {
    assertStrictLockToken(contender.token, 'contender');
    const lockPath = childInDir(session.publicDir, TX_LOCK_DIR_NAME);
    if (pathEntryKind(lockPath) !== 'directory') return 'retry';

    // Foreign or dead steal intent present.
    const existingSteal = readIntentInLockDir(lockPath, TX_STEAL_INTENT_NAME);
    if (existingSteal) {
      let parsed: StealIntent | undefined;
      try {
        parsed = parseStealIntent(JSON.parse(existingSteal.raw.toString('utf8')));
      } catch {
        parsed = undefined;
      }
      if (!parsed) {
        // Unreadable intent — fail closed; never delete foreign/unknown intent blindly.
        return 'busy';
      }
      if (parsed.contenderToken === contender.token) {
        // Our own leftover: recover or drop via state machine.
        const rec = recoverDeadStealIntent(session, lockPath, parsed, existingSteal.identity);
        if (rec === 'busy') return 'busy';
        return 'retry';
      }
      // Foreign contender: if dead, recover their transfer; else busy.
      const rec = recoverDeadStealIntent(session, lockPath, parsed, existingSteal.identity);
      if (rec === 'retry') return 'retry';
      return 'busy';
    }

    // Complete a crashed release for a proven-dead owner before acquiring.
    const releaseIntent = readIntentInLockDir(lockPath, TX_RELEASE_INTENT_NAME);
    if (releaseIntent) {
      let rel: ReleaseIntent | undefined;
      try {
        rel = parseReleaseIntent(JSON.parse(releaseIntent.raw.toString('utf8')));
      } catch {
        rel = undefined;
      }
      if (!rel) return 'busy';
      const inspected = readLockOwnerVia(lockPath);
      if (inspected && inspected.owner.token === rel.token) {
        // PID/start identity must match release intent records.
        if (
          inspected.owner.pid !== rel.ownerPid ||
          inspected.owner.processStart !== rel.ownerProcessStart
        ) {
          return 'busy';
        }
        const alive = isProcessAliveWithStart(inspected.owner.pid, inspected.owner.processStart);
        if (alive === false) {
          try {
            if (
              !sameIdentity(inspected.lockIdentity, {
                dev: rel.lockDev,
                ino: rel.lockIno,
              }) ||
              !sameIdentity(inspected.ownerIdentity, {
                dev: rel.ownerDev,
                ino: rel.ownerIno,
              })
            ) {
              return 'busy';
            }
            // Tombstone name uses only the validated release token (exact equality).
            const tombName = tombstoneNameForToken(rel.token);
            const tombPath = childInDir(session.publicDir, tombName);
            fs.renameSync(lockPath, tombPath);
            fsyncRunDir(session.publicDir);
            removeVerifiedLockSideDir(tombPath, {
              token: rel.token,
              lockIdentity: inspected.lockIdentity,
            });
            fsyncRunDir(session.publicDir);
            return 'retry';
          } catch {
            return 'busy';
          }
        }
        if (alive === true) return 'busy';
      }
      // Unreadable/mismatched release intent: fail closed busy.
      return 'busy';
    }

    const inspected = readLockOwnerVia(lockPath);
    if (!inspected) {
      // Incomplete/malformed fixed lock — fail closed.
      return 'busy';
    }
    if (!isStrictLockToken(inspected.owner.token)) return 'busy';
    const alive = isProcessAliveWithStart(inspected.owner.pid, inspected.owner.processStart);
    if (alive !== false) return 'busy';

    // 1. Create new-owner temp FIRST, before publishing immutable intent.
    const tempToken = randomUUID().replace(/-/g, '').slice(0, 16);
    const newOwnerTempName = `${TX_OWNER_TMP_PREFIX}${tempToken}.tmp`;
    if (!isValidOwnerTempName(newOwnerTempName)) {
      throw {
        code: 'run_store_error',
        message: 'failed to generate valid owner temp name',
      } satisfies RunStoreError;
    }
    let tmpIdentity: FileIdentity;
    let tmpDigest: string;
    let tmpBytes: number;
    try {
      const built = writeOwnerTempInLockDir(lockPath, contender, newOwnerTempName);
      tmpIdentity = built.identity;
      // Re-open to capture digest/bytes for the immutable intent.
      const verified = openVerifiedPrivateFile(
        path.join(lockPath, newOwnerTempName),
        lockPath,
        newOwnerTempName,
        { skipPathBound: true }
      );
      tmpDigest = verified.digest;
      tmpBytes = verified.bytes;
    } catch {
      // Orphan temp; best-effort cleanup.
      try {
        unlinkNamedInDir(lockPath, newOwnerTempName);
      } catch {
        /* ignore */
      }
      return 'busy';
    }

    // 2. Publish immutable steal intent with exact identities (including new temp).
    const intent: StealIntent = {
      version: TX_LOCK_VERSION,
      kind: 'steal',
      contenderToken: contender.token,
      contenderPid: contender.pid,
      contenderProcessStart: contender.processStart,
      ownerToken: inspected.owner.token,
      ownerPid: inspected.owner.pid,
      ownerProcessStart: inspected.owner.processStart,
      ownerIno: inspected.ownerIdentity.ino,
      ownerDev: inspected.ownerIdentity.dev,
      lockIno: inspected.lockIdentity.ino,
      lockDev: inspected.lockIdentity.dev,
      newOwnerTempName,
      newOwnerTempIno: tmpIdentity.ino,
      newOwnerTempDev: tmpIdentity.dev,
      newOwnerTempDigest: tmpDigest,
      newOwnerTempBytes: tmpBytes,
    };
    let intentIdentity: FileIdentity;
    try {
      intentIdentity = writeExclusiveInLockDir(
        lockPath,
        TX_STEAL_INTENT_NAME,
        Buffer.from(`${JSON.stringify(intent)}\n`)
      );
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code: unknown }).code)
          : '';
      if (code === 'run_busy' || code === 'EEXIST') {
        unlinkNamedInDir(lockPath, newOwnerTempName, tmpIdentity);
        return 'busy';
      }
      unlinkNamedInDir(lockPath, newOwnerTempName, tmpIdentity);
      return 'busy';
    }

    // 3. Re-read identities after intent publication; verify nothing changed.
    const recheck = readLockOwnerVia(lockPath);
    if (
      !recheck ||
      recheck.owner.token !== inspected.owner.token ||
      recheck.owner.pid !== inspected.owner.pid ||
      recheck.owner.processStart !== inspected.owner.processStart ||
      !sameIdentity(recheck.ownerIdentity, inspected.ownerIdentity) ||
      !sameIdentity(recheck.lockIdentity, inspected.lockIdentity)
    ) {
      unlinkNamedInDir(lockPath, TX_STEAL_INTENT_NAME, intentIdentity);
      unlinkNamedInDir(lockPath, newOwnerTempName, tmpIdentity);
      return 'busy';
    }
    const stillDead = isProcessAliveWithStart(recheck.owner.pid, recheck.owner.processStart);
    if (stillDead !== false) {
      unlinkNamedInDir(lockPath, TX_STEAL_INTENT_NAME, intentIdentity);
      unlinkNamedInDir(lockPath, newOwnerTempName, tmpIdentity);
      return 'busy';
    }

    // 4. Transfer: rename old owner → owner.previous, new temp → owner.json. Intent unchanged.
    try {
      const lockDirPath = lockPath;
      const lockSt = fs.lstatSync(lockPath);
      if (!lockSt.isDirectory() || !sameIdentity(inspected.lockIdentity, identityOf(lockSt))) {
        throw new Error('lock dir identity changed');
      }
      const ownerPath = path.join(lockDirPath, TX_LOCK_OWNER_NAME);
      const previousPath = path.join(lockDirPath, TX_OWNER_PREVIOUS_NAME);
      const tmpPath = path.join(lockDirPath, newOwnerTempName);
      const ownerSt = fs.lstatSync(ownerPath);
      if (!sameIdentity(inspected.ownerIdentity, identityOf(ownerSt))) {
        throw new Error('owner identity changed');
      }
      if (pathEntryKind(previousPath) !== 'absent') {
        throw new Error('owner.previous already present');
      }
      fs.renameSync(ownerPath, previousPath);
      const tmpSt = fs.lstatSync(tmpPath);
      if (!sameIdentity(tmpIdentity, identityOf(tmpSt))) {
        throw new Error('owner temp replaced');
      }
      fs.renameSync(tmpPath, ownerPath);
      const newOwnerSt = fs.lstatSync(ownerPath);
      if (!sameIdentity(tmpIdentity, identityOf(newOwnerSt))) {
        throw new Error('new owner identity mismatch');
      }
      fsyncRunDir(lockPath);

      // 5. Drop intent + previous entry with exact identity checks. Transfer complete.
      unlinkNamedInDir(lockPath, TX_OWNER_PREVIOUS_NAME, inspected.ownerIdentity);
      unlinkNamedInDir(lockPath, TX_STEAL_INTENT_NAME, intentIdentity);
      fsyncRunDir(session.publicDir);
      return 'stolen';
    } catch {
      // Leave immutable intent + file evidence for dead-intent recovery; drop our temp if still named.
      try {
        unlinkNamedInDir(lockPath, newOwnerTempName, tmpIdentity);
      } catch {
        /* ignore */
      }
      return 'busy';
    }
  }

  function buildCompleteLockCandidate(
    session: RunDirHandle,
    owner: TxLockOwner
  ): { candidatePath: string; lockIdentity: FileIdentity } {
    const candName = `${TX_LOCK_DIR_NAME}.cand.${instanceId}.${randomUUID()}`;
    const candidatePath = childInDir(session.publicDir, candName);
    fs.mkdirSync(candidatePath, { mode: DIR_MODE });
    applyMode(candidatePath, DIR_MODE);
    const candStat = fs.lstatSync(candidatePath);
    const candMode = validatePrivateEntryStats(candStat, 'directory');
    if (!candMode.ok) {
      removeOwnCandidate(candidatePath, identityOf(candStat), owner.token);
      throw {
        code: 'run_store_error',
        message: `lock candidate directory unsafe: ${candMode.reason}`,
      } satisfies RunStoreError;
    }
    const lockIdentity = identityOf(candStat);
    const ownerPath = path.join(candidatePath, TX_LOCK_OWNER_NAME);
    const payload = Buffer.from(`${JSON.stringify(owner)}\n`);
    const candTempToken = randomUUID().replace(/-/g, '').slice(0, 16);
    const candTempName = `${TX_OWNER_TMP_PREFIX}${candTempToken}.tmp`;
    if (!isValidOwnerTempName(candTempName)) {
      removeOwnCandidate(candidatePath, lockIdentity, owner.token);
      throw {
        code: 'run_store_error',
        message: 'failed to generate valid owner temp name',
      } satisfies RunStoreError;
    }
    const tmp = path.join(candidatePath, candTempName);
    let fd: number | undefined;
    try {
      fd = fs.openSync(
        tmp,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollowFlag(),
        FILE_MODE
      );
      try {
        fs.fchmodSync(fd, FILE_MODE);
      } catch {
        applyMode(tmp, FILE_MODE);
      }
      fs.writeFileSync(fd, payload);
      fileFsyncImpl(fd);
      const written = identityOf(fs.fstatSync(fd));
      fs.closeSync(fd);
      fd = undefined;
      const tmpStat = fs.lstatSync(tmp);
      if (!sameIdentity(written, identityOf(tmpStat))) {
        throw {
          code: 'corrupt_run',
          message: 'lock owner temp replaced after close',
        } satisfies RunStoreError;
      }
      fs.renameSync(tmp, ownerPath);
      const ownerStat = fs.lstatSync(ownerPath);
      if (!sameIdentity(written, identityOf(ownerStat))) {
        throw {
          code: 'corrupt_run',
          message: 'lock owner identity mismatch after rename',
        } satisfies RunStoreError;
      }
      fsyncPathStrict(ownerPath);
      fsyncRunDir(candidatePath);
      return { candidatePath, lockIdentity };
    } catch (err) {
      closeFdQuiet(fd);
      removeOwnCandidate(candidatePath, lockIdentity, owner.token);
      throw err;
    }
  }

  type TxLockAttempt =
    | { kind: 'acquired'; held: HeldTxLock }
    | { kind: 'retry' }
    /** Steal claimed success but token not yet visible — retry without sleeping. */
    | { kind: 'retry_immediate' }
    | { kind: 'fail'; error: RunStoreError };

  /**
   * One lock-acquire attempt (sync). No sleep — caller decides wait policy.
   * Post-program leftover: shared by sync getRun recovery and async write paths.
   */
  function tryAcquireTxLockOnce(
    runId: string,
    publicDir: string,
    session: RunDirHandle,
    owner: TxLockOwner
  ): TxLockAttempt {
    revalidatePublicRunDir(session.publicDir, undefined);
    const lockPath = childInDir(session.publicDir, TX_LOCK_DIR_NAME);
    const lockKind = pathEntryKind(lockPath);
    if (lockKind === 'symlink' || lockKind === 'regular' || lockKind === 'other') {
      return {
        kind: 'fail',
        error: {
          code: 'corrupt_run',
          runId,
          message: `transaction lock path is unsafe (${lockKind})`,
        },
      };
    }

    if (lockKind === 'absent') {
      let candidatePath: string | undefined;
      let candIdentity: FileIdentity | undefined;
      try {
        const built = buildCompleteLockCandidate(session, owner);
        candidatePath = built.candidatePath;
        candIdentity = built.lockIdentity;
        try {
          fs.renameSync(candidatePath, lockPath);
          candidatePath = undefined;
        } catch (renameErr) {
          if (
            isNoReplaceContentionError(renameErr, () => pathEntryKind(lockPath) === 'directory')
          ) {
            if (candidatePath && candIdentity) {
              removeOwnCandidate(candidatePath, candIdentity, owner.token);
            }
            candidatePath = undefined;
          } else {
            throw renameErr;
          }
        }
        if (candidatePath === undefined && pathEntryKind(lockPath) === 'directory') {
          const published = readLockOwnerVia(lockPath);
          if (published && published.owner.token === owner.token) {
            fsyncRunDir(session.publicDir);
            revalidatePublicRunDir(session.publicDir, undefined);
            return {
              kind: 'acquired',
              held: {
                runId,
                dir: publicDir,
                lockDir: path.join(publicDir, TX_LOCK_DIR_NAME),
                token: owner.token,
                session,
                lockIdentity: published.lockIdentity,
              },
            };
          }
        }
      } catch (err) {
        if (candidatePath && candIdentity) {
          removeOwnCandidate(candidatePath, candIdentity, owner.token);
        }
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') {
          if (isRunStoreError(err)) {
            return { kind: 'fail', error: err as RunStoreError };
          }
          return {
            kind: 'fail',
            error: {
              code: 'run_store_error',
              runId,
              message: `transaction lock acquire failed: ${messageOf(err)}`,
            },
          };
        }
      }
      return { kind: 'retry' };
    }

    // Fixed lock present: try generation-safe stale transfer (never remove fixed name).
    const steal = tryStealStaleLock(session, owner, runId);
    if (steal === 'stolen') {
      const published = readLockOwnerVia(lockPath);
      if (published && published.owner.token === owner.token) {
        fsyncRunDir(session.publicDir);
        revalidatePublicRunDir(session.publicDir, undefined);
        return {
          kind: 'acquired',
          held: {
            runId,
            dir: publicDir,
            lockDir: path.join(publicDir, TX_LOCK_DIR_NAME),
            token: owner.token,
            session,
            lockIdentity: published.lockIdentity,
          },
        };
      }
      // Pre-extract control flow used `continue` here — no deadline sleep before retry.
      return { kind: 'retry_immediate' };
    }
    return { kind: 'retry' };
  }

  function createTxLockOwner(): TxLockOwner {
    return {
      version: TX_LOCK_VERSION,
      pid: process.pid,
      processStart: selfStartIdentity,
      token: randomUUID(),
      timestamp: now(),
    };
  }

  function runBusyError(runId: string): RunStoreError {
    return {
      code: 'run_busy',
      runId,
      message: 'run transaction lock held by another live owner',
    };
  }

  /** Sync acquire for getRun/list recovery (must stay sync). Uses Atomics.wait. */
  function acquireTxLock(runId: string): HeldTxLock {
    const publicDir = runDirOf(runId);
    const deadline = monotonicNowMs() + txLockWaitMs;
    const owner = createTxLockOwner();
    const session = openRunDirHandle(publicDir, runId);
    try {
      collectSafeLockLeftovers(session, runId);
      for (;;) {
        const attempt = tryAcquireTxLockOnce(runId, publicDir, session, owner);
        if (attempt.kind === 'acquired') return attempt.held;
        if (attempt.kind === 'fail') throw attempt.error;
        if (attempt.kind === 'retry_immediate') continue;
        if (monotonicNowMs() >= deadline) throw runBusyError(runId);
        const remaining = deadline - monotonicNowMs();
        sleepMs(Math.min(txLockRetryMs, Math.max(1, remaining)));
      }
    } catch (err) {
      closeRunDirHandle(session);
      throw err;
    }
  }

  /** Async delay for write-path lock wait (Effect sleep — not Atomics.wait). */
  async function sleepLockRetry(delayMs: number): Promise<void> {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return;
    const bounded = Math.min(Math.floor(delayMs), TX_LOCK_WAIT_MS_MAX);
    if (bounded <= 0) return;
    await runEffectPromise(Effect.sleep(Duration.millis(bounded)));
  }

  /**
   * Async acquire for mutating store paths (updateRun / writeRunJsonAtomic / …).
   * Wait uses Effect sleep; hold section after return remains sync (no await under hold).
   */
  async function acquireTxLockAsync(runId: string): Promise<HeldTxLock> {
    const publicDir = runDirOf(runId);
    const deadline = monotonicNowMs() + txLockWaitMs;
    const owner = createTxLockOwner();
    const session = openRunDirHandle(publicDir, runId);
    try {
      collectSafeLockLeftovers(session, runId);
      for (;;) {
        const attempt = tryAcquireTxLockOnce(runId, publicDir, session, owner);
        if (attempt.kind === 'acquired') return attempt.held;
        if (attempt.kind === 'fail') throw attempt.error;
        if (attempt.kind === 'retry_immediate') continue;
        const nowMs = monotonicNowMs();
        if (nowMs >= deadline) throw runBusyError(runId);
        const delayMs = Math.min(txLockRetryMs, Math.max(1, deadline - nowMs));
        await sleepLockRetry(delayMs);
      }
    } catch (err) {
      closeRunDirHandle(session);
      throw err;
    }
  }

  /**
   * Release: exclusive release.intent (hard-link) inside owned fixed lock, then
   * atomic rename of the verified fixed lock directory to a token tombstone.
   * Every failure is stored and thrown after safe cleanup attempts — never returns
   * success when intent/tombstone/public revalidation/verified release fails.
   */
  function releaseTxLock(held: HeldTxLock): void {
    let releaseError: unknown;
    try {
      revalidatePublicRunDir(held.session.publicDir, undefined);
      const lockPath = childInDir(held.session.publicDir, TX_LOCK_DIR_NAME);
      const current = readLockOwnerVia(lockPath);
      if (
        !current ||
        current.owner.token !== held.token ||
        !sameIdentity(current.lockIdentity, held.lockIdentity)
      ) {
        // Do not remove a lock we do not own / that was replaced.
        releaseError = {
          code: 'durable_write_error',
          runId: held.runId,
          message: 'transaction lock release: ownership lost before release',
        } satisfies RunStoreError;
      } else {
        assertStrictLockToken(held.token, 'release');
        const intent: ReleaseIntent = {
          version: TX_LOCK_VERSION,
          kind: 'release',
          token: held.token,
          ownerPid: current.owner.pid,
          ownerProcessStart: current.owner.processStart,
          ownerIno: current.ownerIdentity.ino,
          ownerDev: current.ownerIdentity.dev,
          lockIno: current.lockIdentity.ino,
          lockDev: current.lockIdentity.dev,
        };
        let intentIdentity: FileIdentity | undefined;
        try {
          intentIdentity = writeExclusiveInLockDir(
            lockPath,
            TX_RELEASE_INTENT_NAME,
            Buffer.from(`${JSON.stringify(intent)}\n`)
          );
        } catch (err) {
          // Cannot publish release intent safely — leave lock for recovery; propagate.
          releaseError = err;
        }

        if (!releaseError) {
          // Re-verify ownership after intent publication.
          const recheck = readLockOwnerVia(lockPath);
          if (
            !recheck ||
            recheck.owner.token !== held.token ||
            recheck.owner.pid !== current.owner.pid ||
            recheck.owner.processStart !== current.owner.processStart ||
            !sameIdentity(recheck.lockIdentity, held.lockIdentity) ||
            !sameIdentity(recheck.ownerIdentity, current.ownerIdentity)
          ) {
            if (intentIdentity) {
              unlinkNamedInDir(lockPath, TX_RELEASE_INTENT_NAME, intentIdentity);
            }
            releaseError = {
              code: 'durable_write_error',
              runId: held.runId,
              message: 'transaction lock release: ownership changed after intent',
            } satisfies RunStoreError;
          }
        }

        if (!releaseError) {
          // Tombstone basename requires exact equality with held/release-intent token.
          const tombName = tombstoneNameForToken(held.token);
          const tombPath = childInDir(held.session.publicDir, tombName);
          try {
            fs.renameSync(lockPath, tombPath);
          } catch (err) {
            releaseError = err;
          }
          if (!releaseError) {
            try {
              fsyncRunDir(held.session.publicDir);
            } catch (err) {
              releaseError = err;
            }
          }

          // Remove tombstone via verified inode/token and no-follow fd traversal.
          // Even if fsync failed, attempt cleanup; still surface the first error.
          const removed = removeVerifiedLockSideDir(tombPath, {
            token: held.token,
            lockIdentity: held.lockIdentity,
          });
          if (!removed.ok) {
            releaseError =
              releaseError ??
              ({
                code: 'durable_write_error',
                runId: held.runId,
                message: `transaction lock tombstone cleanup failed: ${removed.reason}`,
              } satisfies RunStoreError);
          }
          try {
            fsyncRunDir(held.session.publicDir);
          } catch (err) {
            releaseError = releaseError ?? err;
          }

          // Final public path check: replacement after release must surface.
          try {
            revalidatePublicRunDir(held.session.publicDir, undefined);
          } catch (err) {
            releaseError = releaseError ?? err;
          }
        }
      }
    } catch (err) {
      releaseError = releaseError ?? err;
    } finally {
      closeRunDirHandle(held.session);
    }
    if (releaseError) {
      if (isRunStoreError(releaseError)) {
        throw releaseError;
      }
      throw {
        code: 'durable_write_error',
        runId: held.runId,
        message: `transaction lock release failed: ${messageOf(releaseError)}`,
      } satisfies RunStoreError;
    }
  }

  function finishWithTxLock<T>(runId: string, held: HeldTxLock, fn: (held: HeldTxLock) => T): T {
    // Hold section is always sync — no await between acquire and release.
    let result: T;
    let fnError: unknown;
    try {
      result = fn(held);
    } catch (err) {
      fnError = err;
    }
    // Always attempt release; any release failure prevents success.
    let releaseError: unknown;
    try {
      releaseTxLock(held);
    } catch (err) {
      releaseError = err;
    }
    if (fnError && releaseError) {
      // Deterministic combination: surface operation error with release context.
      const fnMsg = messageOf(fnError);
      const relMsg = messageOf(releaseError);
      if (isRunStoreError(fnError)) {
        const e = fnError as RunStoreError;
        throw {
          ...e,
          message: `${e.message}; also release failed: ${relMsg}`,
        } satisfies RunStoreError;
      }
      throw {
        code: 'run_store_error',
        runId,
        message: `${fnMsg}; also release failed: ${relMsg}`,
      } satisfies RunStoreError;
    }
    if (fnError) throw fnError;
    if (releaseError) throw releaseError;
    return result!;
  }

  /** Sync lock wrapper for getRun/list recovery (sync public API). */
  function withTxLock<T>(runId: string, fn: (held: HeldTxLock) => T): T {
    const held = acquireTxLock(runId);
    return finishWithTxLock(runId, held, fn);
  }

  /** Async lock wrapper for mutating paths: Effect-sleep wait, sync hold. */
  async function withTxLockAsync<T>(runId: string, fn: (held: HeldTxLock) => T): Promise<T> {
    const held = await acquireTxLockAsync(runId);
    return finishWithTxLock(runId, held, fn);
  }

  function hasTxArtifacts(dir: string): boolean {
    const { rollback, marker, lockDir } = txPaths(dir);
    return (
      pathEntryKind(marker) !== 'absent' ||
      pathEntryKind(rollback) !== 'absent' ||
      pathEntryKind(lockDir) !== 'absent'
    );
  }

  /**
   * Recover an interrupted strict run.json transaction before load/parse.
   * Caller must hold the transaction lock. prepared → restore old authority;
   * committed → keep new authority and clean up. Malformed/unsafe state fails
   * closed without deleting forensic material.
   */
  function recoverStrictTransactionLocked(
    runId: string,
    session?: RunDirHandle
  ): { ok: true } | { ok: false; error: RunStoreError } {
    const dir = runDirOf(runId);
    if (pathEntryKind(dir) === 'absent') return { ok: true };
    if (session) {
      revalidatePublicRunDir(session.publicDir, undefined);
    }
    const target = session ? childInDir(session.publicDir, 'run.json') : path.join(dir, 'run.json');
    const rollback = session
      ? childInDir(session.publicDir, TX_ROLLBACK_NAME)
      : path.join(dir, TX_ROLLBACK_NAME);
    const marker = session
      ? childInDir(session.publicDir, TX_MARKER_NAME)
      : path.join(dir, TX_MARKER_NAME);
    const skipBound = !!session;
    const writeAtomic = (dest: string, base: string, data: Buffer) =>
      writePrivateBytesAtomic(dest, dir, base, data, fsyncRunDir, session);
    const syncDir = () => {
      if (session) fsyncRunDir(session.publicDir);
      else fsyncRunDir(dir);
    };

    const markerKind = pathEntryKind(marker);
    const rollbackKind = pathEntryKind(rollback);

    if (markerKind === 'symlink' || markerKind === 'directory' || markerKind === 'other') {
      return {
        ok: false,
        error: {
          code: 'corrupt_run',
          runId,
          message: 'strict transaction marker is not a safe regular file',
        },
      };
    }
    if (rollbackKind === 'symlink' || rollbackKind === 'directory' || rollbackKind === 'other') {
      return {
        ok: false,
        error: {
          code: 'corrupt_run',
          runId,
          message: 'strict transaction rollback is not a safe regular file',
        },
      };
    }

    const markerExists = markerKind === 'regular';
    const rollbackExists = rollbackKind === 'regular';

    if (markerExists) {
      try {
        const st = fs.lstatSync(marker);
        const v = validatePrivateEntryStats(st, 'file');
        if (!v.ok) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId,
              message: 'strict transaction marker is not a safe regular file',
            },
          };
        }
      } catch {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId,
            message: 'strict transaction marker is not a safe regular file',
          },
        };
      }
    }
    if (rollbackExists) {
      try {
        const st = fs.lstatSync(rollback);
        const v = validatePrivateEntryStats(st, 'file');
        if (!v.ok) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId,
              message: 'strict transaction rollback is not a safe regular file',
            },
          };
        }
      } catch {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId,
            message: 'strict transaction rollback is not a safe regular file',
          },
        };
      }
    }

    // Orphan rollback before marker durability: verify run.json still matches
    // the rollback bytes, then drop the redundant copy.
    if (!markerExists && rollbackExists) {
      try {
        const rbVerified = openVerifiedPrivateFile(rollback, dir, TX_ROLLBACK_NAME, {
          skipPathBound: skipBound,
        });
        if (pathEntryKind(target) === 'absent') {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId,
              message: 'orphan rollback without run.json',
            },
          };
        }
        const current = readAuthorityRunJson(target, dir, { skipPathBound: skipBound });
        if (!current.data.equals(rbVerified.data)) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId,
              message: 'orphan rollback does not match run.json',
            },
          };
        }
        const cleaned = cleanupTxPhase(dir, 'prepared', session, {
          rollback: rbVerified,
        });
        if (!cleaned.ok) {
          return {
            ok: false,
            error: {
              code: 'durable_write_error',
              runId,
              message: `strict transaction orphan cleanup failed: ${messageOf(cleaned.error)}`,
            },
          };
        }
        syncDir();
        return { ok: true };
      } catch (err) {
        if (err && typeof err === 'object' && 'code' in err) {
          return { ok: false, error: err as RunStoreError };
        }
        return {
          ok: false,
          error: {
            code: 'durable_write_error',
            runId,
            message: `strict transaction orphan cleanup failed: ${messageOf(err)}`,
          },
        };
      }
    }

    if (!markerExists) return { ok: true };

    let markerVerified: VerifiedPrivateFile;
    let parsed: unknown;
    try {
      markerVerified = openVerifiedPrivateFile(marker, dir, TX_MARKER_NAME, {
        skipPathBound: skipBound,
        parseMarkerPhase: true,
      });
      parsed = JSON.parse(markerVerified.data.toString('utf8'));
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as RunStoreError).code) {
        return { ok: false, error: err as RunStoreError };
      }
      return {
        ok: false,
        error: {
          code: 'corrupt_run',
          runId,
          message: `strict transaction marker unreadable: ${messageOf(err)}`,
        },
      };
    }
    const m = parseTxMarker(parsed);
    if (!m) {
      return {
        ok: false,
        error: {
          code: 'corrupt_run',
          runId,
          message: 'strict transaction marker is malformed',
        },
      };
    }
    // Carry phase from the authority-decision verified entry.
    if (markerVerified.phase !== undefined && markerVerified.phase !== m.phase) {
      return {
        ok: false,
        error: {
          code: 'corrupt_run',
          runId,
          message: 'strict transaction marker phase identity mismatch',
        },
      };
    }
    markerVerified = { ...markerVerified, phase: m.phase };

    if (m.phase === 'prepared') {
      if (!rollbackExists) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId,
            message: 'prepared transaction missing rollback bytes',
          },
        };
      }
      try {
        const rbVerified = openVerifiedPrivateFile(rollback, dir, TX_ROLLBACK_NAME, {
          skipPathBound: skipBound,
        });
        if (rbVerified.bytes !== m.oldBytes || rbVerified.digest !== m.oldSha256) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId,
              message: 'prepared transaction rollback digest mismatch',
            },
          };
        }
        // Restore previous authority over run.json.
        writeAtomic(target, 'run.json', rbVerified.data);
        fsyncPathStrict(target);
        syncDir();
        // Cleanup only the exact verified generations from the authority decision.
        const cleaned = cleanupTxPhase(dir, 'prepared', session, {
          marker: markerVerified,
          rollback: rbVerified,
        });
        if (!cleaned.ok) {
          return {
            ok: false,
            error: {
              code: 'durable_write_error',
              runId,
              message: `strict transaction prepared cleanup failed: ${messageOf(cleaned.error)}; recovery files preserved`,
            },
          };
        }
        return { ok: true };
      } catch (err) {
        if (isBypassCleanupError(err)) throw err;
        if (err && typeof err === 'object' && 'code' in err) {
          return { ok: false, error: err as RunStoreError };
        }
        return {
          ok: false,
          error: {
            code: 'durable_write_error',
            runId,
            message: `strict transaction prepared recovery failed: ${messageOf(err)}; recovery files preserved`,
          },
        };
      }
    }

    // committed: new authority must already be in run.json; only cleanup remains.
    // Committed marker without rollback is still valid (mid-cleanup).
    try {
      if (pathEntryKind(target) === 'absent') {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId,
            message: 'committed transaction missing run.json',
          },
        };
      }
      const current = readAuthorityRunJson(target, dir, { skipPathBound: skipBound });
      if (current.bytes !== m.newBytes || current.digest !== m.newSha256) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId,
            message: 'committed transaction run.json digest mismatch',
          },
        };
      }
      let rollbackVerified: VerifiedPrivateFile | undefined;
      if (rollbackExists) {
        rollbackVerified = openVerifiedPrivateFile(rollback, dir, TX_ROLLBACK_NAME, {
          skipPathBound: skipBound,
        });
      }
      const cleaned = cleanupTxPhase(dir, 'committed', session, {
        marker: markerVerified,
        rollback: rollbackVerified,
      });
      if (!cleaned.ok && !isBypassCleanupError(cleaned.error)) {
        if (
          cleaned.error &&
          typeof cleaned.error === 'object' &&
          'code' in cleaned.error &&
          (cleaned.error as RunStoreError).code === 'generation_mismatch'
        ) {
          return { ok: false, error: cleaned.error as RunStoreError };
        }
        const recheck = revalidateCommittedState(
          dir,
          { sha256: m.newSha256, bytes: m.newBytes },
          session,
          {
            markerIdentity: markerVerified.identity,
            rollbackIdentity: rollbackVerified?.identity,
          }
        );
        if (!recheck.ok) {
          return {
            ok: false,
            error: {
              ...recheck.error,
              runId: recheck.error.runId ?? runId,
              message:
                recheck.error.message ??
                `strict transaction committed cleanup failed: ${messageOf(cleaned.error)}; recovery files preserved`,
            },
          };
        }
      }
      return { ok: true };
    } catch (err) {
      if (isBypassCleanupError(err)) throw err;
      if (err && typeof err === 'object' && 'code' in err) {
        return { ok: false, error: err as RunStoreError };
      }
      return {
        ok: false,
        error: {
          code: 'durable_write_error',
          runId,
          message: `strict transaction committed cleanup failed: ${messageOf(err)}; recovery files preserved`,
        },
      };
    }
  }

  mkdirPrivate(rootDir);

  /**
   * Per-run serial executor (Phase 8 Slice A) via shared keyed helper:
   * continue-after-failure + rethrow as-is for plain `{ code, message }`.
   * assertValidRunId still runs before enqueue.
   */
  const serial = createKeyedSerialExecutor();

  function runSerial<T>(runId: string, task: () => Promise<T>): Promise<T> {
    assertValidRunId(runId);
    return serial.enqueue(runId, task);
  }

  function runDirOf(runId: string): string {
    assertValidRunId(runId);
    return path.join(rootDir, runId);
  }

  function getRunDir(runId: string): string {
    return runDirOf(runId);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function runJsonPath(runId: string): string {
    return path.join(runDirOf(runId), 'run.json');
  }

  function eventsPath(runId: string): string {
    return path.join(runDirOf(runId), 'events.jsonl');
  }

  function claimsDir(runId: string): string {
    return path.join(runDirOf(runId), 'claims');
  }

  function validateRunRecord(
    raw: unknown,
    expectedRunId: string,
    expectedDir: string
  ): { ok: true; record: AgentRunRecordV1 } | { ok: false; error: RunStoreError } {
    if (!raw || typeof raw !== 'object') {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: 'record is not an object' },
      };
    }
    const r = raw as Partial<AgentRunRecordV1>;
    if (r.version !== RUN_RECORD_VERSION) {
      return {
        ok: false,
        error: {
          code: 'corrupt_run',
          runId: expectedRunId,
          message: `unsupported version ${String(r.version)}`,
        },
      };
    }
    if (r.runId !== expectedRunId) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: 'runId mismatch' },
      };
    }
    if (typeof r.mode !== 'string' || !['single', 'parallel', 'chain'].includes(r.mode)) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: 'invalid mode' },
      };
    }
    if (typeof r.status !== 'string' || !RUN_STATUS_VALUES.has(r.status)) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: 'invalid status' },
      };
    }
    if (typeof r.details !== 'object' || r.details === null || Array.isArray(r.details)) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: 'invalid details' },
      };
    }
    if (typeof r.units !== 'object' || r.units === null) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: 'invalid units' },
      };
    }
    const requestError = validateStoredRequest(r.request, r.mode);
    if (requestError) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: requestError },
      };
    }
    // Explicit request.runtime is a run-wide override; every unit's effective
    // runtime (unit.runtime ?? pi default) must match so preflight and dispatch
    // cannot apply different rules. Absent request.runtime allows per-agent runtimes.
    const explicitRequestRuntime =
      r.request && typeof r.request === 'object' && 'runtime' in r.request
        ? (r.request as { runtime?: unknown }).runtime
        : undefined;
    for (const [unitId, unit] of Object.entries(r.units)) {
      if (!isUnitIdValid(unitId)) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `invalid unit id ${unitId}`,
          },
        };
      }
      if (!unit || typeof unit !== 'object') {
        return {
          ok: false,
          error: { code: 'corrupt_run', runId: expectedRunId, message: `invalid unit ${unitId}` },
        };
      }
      const u = unit as unknown as Record<string, unknown>;
      if (typeof u.agent !== 'string') {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} agent is not a string`,
          },
        };
      }
      // Canonical unit identity first so swapped positions fail closed on
      // identity rather than being misread through mutable fanoutIndex/step.
      if (u.unitId !== unitId) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} unitId field "${String(u.unitId)}" does not match record key`,
          },
        };
      }
      if (r.request && typeof r.request === 'object') {
        const identityError = validateUnitCanonicalIdentity(
          r.mode as string,
          r.request as unknown as Record<string, unknown>,
          unitId,
          { step: u.step, fanoutIndex: u.fanoutIndex }
        );
        if (identityError) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: identityError,
            },
          };
        }
        // Persisted unit.agent must match the request topology used at dispatch so
        // preflight fingerprint checks and runtime resolution stay consistent.
        const expectedAgent = expectedTopologyAgent(
          r.mode as string,
          r.request as unknown as Record<string, unknown>,
          unitId,
          { step: u.step, fanoutIndex: u.fanoutIndex }
        );
        if (expectedAgent === undefined) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `unit ${unitId} does not match request topology`,
            },
          };
        }
        if (u.agent !== expectedAgent) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `unit ${unitId} agent "${u.agent}" does not match request topology agent "${expectedAgent}"`,
            },
          };
        }
      }
      if (u.runtime !== undefined && !isAllowedDurableRuntime(u.runtime)) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} has unsupported runtime ${String(u.runtime)}`,
          },
        };
      }
      if (typeof explicitRequestRuntime === 'string') {
        const unitEffective = effectiveUnitRuntime(u.runtime);
        if (unitEffective !== explicitRequestRuntime) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `unit ${unitId} effective runtime ${unitEffective} conflicts with request.runtime ${explicitRequestRuntime}`,
            },
          };
        }
      }
      if (!isAllowedDurableCapability(u.capability)) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message:
              u.capability === undefined
                ? `unit ${unitId} is missing capability`
                : `unit ${unitId} has unsupported capability ${String(u.capability)}`,
          },
        };
      }
      // Core unit fields consumed by inspectResume/active resume must be well-typed.
      if (typeof u.status !== 'string' || !UNIT_STATUS_VALUES.has(u.status)) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} has unsupported status ${String(u.status)}`,
          },
        };
      }
      if (
        typeof u.attempt !== 'number' ||
        !Number.isInteger(u.attempt) ||
        u.attempt < 0 ||
        !Number.isFinite(u.attempt)
      ) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} attempt must be a non-negative integer`,
          },
        };
      }
      if (!Array.isArray(u.attempts)) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} attempts must be an array`,
          },
        };
      }
      for (let i = 0; i < u.attempts.length; i++) {
        const attemptRec = u.attempts[i];
        const attemptPath = `unit ${unitId} attempts[${i}]`;
        if (!attemptRec || typeof attemptRec !== 'object' || Array.isArray(attemptRec)) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `${attemptPath} must be an object`,
            },
          };
        }
        const a = attemptRec as Record<string, unknown>;
        if (
          typeof a.attempt !== 'number' ||
          !Number.isInteger(a.attempt) ||
          a.attempt < 0 ||
          !Number.isFinite(a.attempt)
        ) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `${attemptPath}.attempt must be a non-negative integer`,
            },
          };
        }
        if (typeof a.status !== 'string' || !UNIT_STATUS_VALUES.has(a.status)) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `${attemptPath} has unsupported status ${String(a.status)}`,
            },
          };
        }
        if (typeof a.startedAt !== 'number' || !Number.isFinite(a.startedAt)) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `${attemptPath}.startedAt must be a number`,
            },
          };
        }
        if (
          a.finishedAt !== undefined &&
          (typeof a.finishedAt !== 'number' || !Number.isFinite(a.finishedAt))
        ) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `${attemptPath}.finishedAt must be a number when present`,
            },
          };
        }
        if (a.stopReason !== undefined && typeof a.stopReason !== 'string') {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `${attemptPath}.stopReason must be a string when present`,
            },
          };
        }
        if (a.errorMessage !== undefined && typeof a.errorMessage !== 'string') {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `${attemptPath}.errorMessage must be a string when present`,
            },
          };
        }
      }
      // Resume always passes effectiveCwd to fs.existsSync; require a non-empty string.
      // Writers always set it; no valid V1 fixture omits it.
      if (typeof u.effectiveCwd !== 'string' || u.effectiveCwd.length === 0) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} effectiveCwd must be a non-empty string`,
          },
        };
      }
      if (u.agentFingerprint !== undefined && typeof u.agentFingerprint !== 'string') {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} agentFingerprint must be a string when present`,
          },
        };
      }
      // Crash-window flag is boolean-only; string "false" must not bypass handling.
      if (
        u.sessionPromptEstablished !== undefined &&
        typeof u.sessionPromptEstablished !== 'boolean'
      ) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} sessionPromptEstablished must be a boolean when present`,
          },
        };
      }
      // requireArtifactReader is an additive Version 1 boolean.
      if (u.requireArtifactReader !== undefined && typeof u.requireArtifactReader !== 'boolean') {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} requireArtifactReader must be a boolean when present`,
          },
        };
      }
      if (u.result !== undefined) {
        const shellError = validateResultShell(u.result, `unit ${unitId} result`, {
          unitStatus: typeof u.status === 'string' ? u.status : undefined,
          runId: expectedRunId,
        });
        if (shellError) {
          return {
            ok: false,
            error: { code: 'corrupt_run', runId: expectedRunId, message: shellError },
          };
        }
        const resumeCapability = (u.result as { resumeCapability?: unknown }).resumeCapability;
        if (resumeCapability !== undefined && !isAllowedDurableCapability(resumeCapability)) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `unit ${unitId} result.resumeCapability has unsupported value ${String(resumeCapability)}`,
            },
          };
        }
        const presentationError = validatePresentation(
          (u.result as { presentation?: unknown }).presentation,
          `unit ${unitId} result`
        );
        if (presentationError) {
          return {
            ok: false,
            error: { code: 'corrupt_run', runId: expectedRunId, message: presentationError },
          };
        }
      }
      if (u.sessionFile !== undefined) {
        if (typeof u.sessionFile !== 'string' || u.sessionFile.length === 0) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `unit ${unitId} sessionFile must be a non-empty string when present`,
            },
          };
        }
      }
      if (u.acpSessionId !== undefined) {
        if (
          typeof u.acpSessionId !== 'string' ||
          u.acpSessionId.trim().length === 0 ||
          u.acpSessionId !== u.acpSessionId.trim()
        ) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `unit ${unitId} acpSessionId must be a trimmed non-empty string`,
            },
          };
        }
      }
      if (u.worktreePath !== undefined) {
        if (typeof u.worktreePath !== 'string' || u.worktreePath.length === 0) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `unit ${unitId} worktreePath must be a non-empty string when present`,
            },
          };
        }
      }
    }
    // Exact coverage of statically known units (single / parallel / sequential
    // chain). Dynamic fanout children are allowed only as mapped expansions.
    if (r.request && typeof r.request === 'object') {
      const coverageError = validateStaticUnitCoverage(
        r.mode as string,
        r.request as unknown as Record<string, unknown>,
        r.units as Record<string, unknown>
      );
      if (coverageError) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: coverageError,
          },
        };
      }
    }
    // Mode-aware SubagentDetails minimum shape used by preflight/resume/chain restore.
    const detailsError = validateSubagentDetails(r.details, {
      mode: typeof r.mode === 'string' ? r.mode : undefined,
      request:
        r.request && typeof r.request === 'object' && !Array.isArray(r.request)
          ? (r.request as unknown as Record<string, unknown>)
          : undefined,
      runId: expectedRunId,
    });
    if (detailsError) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: detailsError },
      };
    }
    if (r.workflowState !== undefined) {
      if (
        r.workflowState === null ||
        typeof r.workflowState !== 'object' ||
        Array.isArray(r.workflowState)
      ) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: 'workflowState must be a non-null object',
          },
        };
      }
      const ws = r.workflowState as { fanouts?: unknown };
      if (ws.fanouts === null || typeof ws.fanouts !== 'object' || Array.isArray(ws.fanouts)) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: 'workflowState.fanouts must be a non-null object',
          },
        };
      }
      for (const [key, fanout] of Object.entries(ws.fanouts as Record<string, unknown>)) {
        const fanoutError = validateWorkflowFanoutState(
          fanout,
          `workflowState.fanouts[${key}]`,
          expectedRunId
        );
        if (fanoutError) {
          return {
            ok: false,
            error: { code: 'corrupt_run', runId: expectedRunId, message: fanoutError },
          };
        }
      }
    }
    if (r.continuationTasks !== undefined) {
      if (!Array.isArray(r.continuationTasks)) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: 'continuationTasks is not an array',
          },
        };
      }
      for (let i = 0; i < r.continuationTasks.length; i++) {
        if (typeof r.continuationTasks[i] !== 'string') {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `continuationTasks[${i}] is not a string`,
            },
          };
        }
      }
    }
    if (r.continuationDelivery !== undefined) {
      if (typeof r.continuationDelivery !== 'object' || r.continuationDelivery === null) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: 'continuationDelivery is not an object',
          },
        };
      }
      const continuationTaskCount = Array.isArray(r.continuationTasks)
        ? r.continuationTasks.length
        : 0;
      const units =
        r.units && typeof r.units === 'object' && r.units !== null
          ? (r.units as Record<string, unknown>)
          : undefined;
      for (const [unitId, entry] of Object.entries(r.continuationDelivery)) {
        // Orphan delivery keys (no matching unit) are corrupt.
        if (!units || !(unitId in units)) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `continuationDelivery[${unitId}] has no matching unit`,
            },
          };
        }
        if (!entry || typeof entry !== 'object') {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `continuationDelivery[${unitId}] is not an object`,
            },
          };
        }
        const deliveredCount = (entry as { deliveredCount?: unknown }).deliveredCount;
        if (
          typeof deliveredCount !== 'number' ||
          !Number.isInteger(deliveredCount) ||
          deliveredCount < 0
        ) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `continuationDelivery[${unitId}].deliveredCount is invalid`,
            },
          };
        }
        // deliveredCount is how many of continuationTasks[0..n) were confirmed.
        if (deliveredCount > continuationTaskCount) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `continuationDelivery[${unitId}].deliveredCount ${deliveredCount} exceeds continuationTasks length ${continuationTaskCount}`,
            },
          };
        }
      }
    }
    void expectedDir;
    return { ok: true, record: r as AgentRunRecordV1 };
  }

  /**
   * Validate that a unit key and its step/fanoutIndex fields form the canonical
   * identity for the stored request topology. Returns an error message or undefined.
   */
  function validateUnitCanonicalIdentity(
    mode: string,
    request: Record<string, unknown>,
    unitId: string,
    unit: { step?: unknown; fanoutIndex?: unknown }
  ): string | undefined {
    if (mode === 'single') {
      if (unitId !== 'single') {
        return `unit ${unitId} is not the canonical single-mode id`;
      }
      if (unit.step !== undefined) {
        return `unit ${unitId} must not have step in single mode`;
      }
      if (unit.fanoutIndex !== undefined) {
        return `unit ${unitId} must not have fanoutIndex in single mode`;
      }
      return undefined;
    }
    if (mode === 'parallel') {
      const match = /^parallel-(\d+)$/.exec(unitId);
      if (!match) {
        return `unit ${unitId} is not a canonical parallel id`;
      }
      const index = Number(match[1]) - 1;
      const tasks = request.tasks;
      if (!Array.isArray(tasks) || index < 0 || index >= tasks.length) {
        return `unit ${unitId} is outside parallel task range`;
      }
      if (unit.fanoutIndex !== index) {
        return `unit ${unitId} fanoutIndex ${String(unit.fanoutIndex)} does not match canonical index ${index}`;
      }
      if (unit.step !== undefined) {
        return `unit ${unitId} must not have step in parallel mode`;
      }
      return undefined;
    }
    if (mode === 'chain') {
      const chain = request.chain;
      if (!Array.isArray(chain)) {
        return `unit ${unitId} chain request is invalid`;
      }
      const fanoutMatch = /^chain-(\d+)-fanout-(\d+)$/.exec(unitId);
      if (fanoutMatch) {
        const step = Number(fanoutMatch[1]);
        const fanoutIndex = Number(fanoutMatch[2]) - 1;
        if (step < 1 || step > chain.length) {
          return `unit ${unitId} step is outside chain range`;
        }
        const entry = chain[step - 1];
        const isFanout =
          entry !== null && typeof entry === 'object' && 'expand' in entry && !('agent' in entry);
        if (!isFanout) {
          return `unit ${unitId} targets a non-fanout chain step`;
        }
        if (unit.step !== step) {
          return `unit ${unitId} step ${String(unit.step)} does not match canonical step ${step}`;
        }
        if (unit.fanoutIndex !== fanoutIndex) {
          return `unit ${unitId} fanoutIndex ${String(unit.fanoutIndex)} does not match canonical index ${fanoutIndex}`;
        }
        // Canonical id form must match helpers (rejects non-padded aliases).
        try {
          if (unitId !== chainFanoutUnitId(step, fanoutIndex)) {
            return `unit ${unitId} is not the canonical fanout id`;
          }
        } catch {
          return `unit ${unitId} has invalid fanout identity`;
        }
        return undefined;
      }
      const seqMatch = /^chain-(\d+)$/.exec(unitId);
      if (!seqMatch) {
        return `unit ${unitId} is not a canonical chain id`;
      }
      const step = Number(seqMatch[1]);
      if (step < 1 || step > chain.length) {
        return `unit ${unitId} step is outside chain range`;
      }
      const entry = chain[step - 1];
      const isFanout =
        entry !== null && typeof entry === 'object' && 'expand' in entry && !('agent' in entry);
      if (isFanout) {
        return `unit ${unitId} targets a fanout chain step without fanout identity`;
      }
      if (unit.step !== step) {
        return `unit ${unitId} step ${String(unit.step)} does not match canonical step ${step}`;
      }
      if (unit.fanoutIndex !== undefined) {
        return `unit ${unitId} must not have fanoutIndex on a sequential step`;
      }
      try {
        if (unitId !== chainStepUnitId(step)) {
          return `unit ${unitId} is not the canonical sequential id`;
        }
      } catch {
        return `unit ${unitId} has invalid sequential identity`;
      }
      return undefined;
    }
    return `unit ${unitId} has unsupported mode ${mode}`;
  }

  /**
   * Require exact coverage of statically known unit ids for the request topology.
   * Dynamic fanout children may appear only as canonical fanout unit ids.
   */
  function validateStaticUnitCoverage(
    mode: string,
    request: Record<string, unknown>,
    units: Record<string, unknown>
  ): string | undefined {
    const unitKeys = Object.keys(units);
    if (mode === 'single') {
      if (unitKeys.length !== 1 || unitKeys[0] !== 'single') {
        return `static unit coverage invalid for single mode: expected exactly [single], got [${unitKeys.join(', ')}]`;
      }
      return undefined;
    }
    if (mode === 'parallel') {
      const tasks = request.tasks;
      if (!Array.isArray(tasks)) {
        return 'static unit coverage invalid: parallel request.tasks is not an array';
      }
      const expected = Array.from({ length: tasks.length }, (_, i) => `parallel-${pad(i + 1)}`);
      if (unitKeys.length !== expected.length) {
        return `static unit coverage invalid for parallel mode: expected ${expected.length} units, got ${unitKeys.length}`;
      }
      for (const id of expected) {
        if (!(id in units)) {
          return `static unit coverage invalid for parallel mode: missing ${id}`;
        }
      }
      for (const id of unitKeys) {
        if (!expected.includes(id)) {
          return `static unit coverage invalid for parallel mode: unexpected unit ${id}`;
        }
      }
      return undefined;
    }
    if (mode === 'chain') {
      const expectedStatic = generateUnitIds('chain', {
        chain: Array.isArray(request.chain) ? request.chain : [],
      });
      for (const id of expectedStatic) {
        if (!(id in units)) {
          return `static unit coverage invalid for chain mode: missing ${id}`;
        }
      }
      for (const id of unitKeys) {
        if (expectedStatic.includes(id)) continue;
        // Dynamic fanout children only; reject extra sequential or arbitrary ids.
        if (!/^chain-\d+-fanout-\d+$/.test(id)) {
          return `static unit coverage invalid for chain mode: unexpected unit ${id}`;
        }
      }
      return undefined;
    }
    return undefined;
  }

  /**
   * Resolve the agent name selected by the stored request topology for a unit.
   * Used so preflight/dispatch cannot apply a different agent than durability.
   * Returns undefined when the unit position cannot be resolved from the request.
   */
  function expectedTopologyAgent(
    mode: string,
    request: Record<string, unknown>,
    unitId: string,
    unit: { step?: unknown; fanoutIndex?: unknown }
  ): string | undefined {
    if (mode === 'single') {
      return typeof request.agent === 'string' ? request.agent : undefined;
    }
    if (mode === 'parallel') {
      const tasks = request.tasks;
      if (!Array.isArray(tasks)) return undefined;
      let index: number | undefined;
      if (typeof unit.fanoutIndex === 'number' && Number.isInteger(unit.fanoutIndex)) {
        index = unit.fanoutIndex;
      } else {
        const match = /^parallel-(\d+)$/.exec(unitId);
        if (match) index = Number(match[1]) - 1;
      }
      if (index === undefined || index < 0 || index >= tasks.length) return undefined;
      const item = tasks[index];
      if (!item || typeof item !== 'object') return undefined;
      const agent = (item as { agent?: unknown }).agent;
      return typeof agent === 'string' ? agent : undefined;
    }
    if (mode === 'chain') {
      const chain = request.chain;
      if (!Array.isArray(chain)) return undefined;
      let step: number | undefined;
      if (typeof unit.step === 'number' && Number.isInteger(unit.step)) {
        step = unit.step;
      } else {
        const fanoutMatch = /^chain-(\d+)-fanout-(\d+)$/.exec(unitId);
        if (fanoutMatch) {
          step = Number(fanoutMatch[1]);
        } else {
          const seqMatch = /^chain-(\d+)$/.exec(unitId);
          if (seqMatch) step = Number(seqMatch[1]);
        }
      }
      if (step === undefined || step < 1 || step > chain.length) return undefined;
      const entry = chain[step - 1];
      if (!entry || typeof entry !== 'object') return undefined;
      const isFanout = 'expand' in entry && !('agent' in entry);
      const hasFanoutIndex =
        typeof unit.fanoutIndex === 'number' && Number.isInteger(unit.fanoutIndex);
      // Fanout child units must use the parallel agent; sequential units use step.agent.
      if (isFanout) {
        if (!hasFanoutIndex && !/^chain-\d+-fanout-\d+$/.test(unitId)) {
          // Sequential-shaped unit claiming a fanout step has no topology agent.
          return undefined;
        }
        const parallel = (entry as { parallel?: unknown }).parallel;
        if (!parallel || typeof parallel !== 'object') return undefined;
        const agent = (parallel as { agent?: unknown }).agent;
        return typeof agent === 'string' ? agent : undefined;
      }
      if (hasFanoutIndex) {
        // Fanout index on a sequential step is not a valid topology position.
        return undefined;
      }
      const agent = (entry as { agent?: unknown }).agent;
      return typeof agent === 'string' ? agent : undefined;
    }
    return undefined;
  }

  /**
   * Validate StoredRunRequest shape and mode/topology consistency.
   * Returns an error message or undefined when valid. Never throws.
   */
  function validateStoredRequest(request: unknown, mode: string): string | undefined {
    if (!request || typeof request !== 'object') {
      return 'request is not an object';
    }
    const req = request as Record<string, unknown>;
    if (req.mode !== mode) {
      return `request.mode (${String(req.mode)}) does not match record.mode (${mode})`;
    }
    if (typeof req.agentScope !== 'string') {
      return 'request.agentScope is not a string';
    }
    for (const key of [
      'model',
      'thinking',
      'runtime',
      'isolation',
      'agent',
      'task',
      'title',
      'cwd',
    ] as const) {
      if (req[key] !== undefined && typeof req[key] !== 'string') {
        return `request.${key} is not a string`;
      }
    }
    if (req.runtime !== undefined && !isAllowedDurableRuntime(req.runtime)) {
      return `request.runtime has unsupported value ${String(req.runtime)}`;
    }
    if (mode === 'single') {
      if (typeof req.agent !== 'string' || typeof req.task !== 'string') {
        return 'request single mode requires agent and task strings';
      }
      if (req.tasks !== undefined || req.chain !== undefined) {
        return 'request single mode must not include tasks or chain';
      }
    } else if (mode === 'parallel') {
      if (!Array.isArray(req.tasks) || req.tasks.length === 0) {
        return 'request parallel mode requires a non-empty tasks array';
      }
      for (let i = 0; i < req.tasks.length; i++) {
        const item = req.tasks[i];
        if (!item || typeof item !== 'object') {
          return `request.tasks[${i}] is not an object`;
        }
        const t = item as Record<string, unknown>;
        if (typeof t.agent !== 'string' || typeof t.task !== 'string') {
          return `request.tasks[${i}] requires agent and task strings`;
        }
        for (const key of ['title', 'cwd', 'isolation'] as const) {
          if (t[key] !== undefined && typeof t[key] !== 'string') {
            return `request.tasks[${i}].${key} is not a string`;
          }
        }
      }
      if (req.chain !== undefined) {
        return 'request parallel mode must not include chain';
      }
    } else if (mode === 'chain') {
      if (!Array.isArray(req.chain) || req.chain.length === 0) {
        return 'request chain mode requires a non-empty chain array';
      }
      for (let i = 0; i < req.chain.length; i++) {
        const item = req.chain[i];
        if (!item || typeof item !== 'object') {
          return `request.chain[${i}] is not an object`;
        }
        const step = item as Record<string, unknown>;
        const isFanout = 'expand' in step && !('agent' in step);
        if (isFanout) {
          if (!step.expand || typeof step.expand !== 'object') {
            return `request.chain[${i}].expand is invalid`;
          }
          if (!step.parallel || typeof step.parallel !== 'object') {
            return `request.chain[${i}].parallel is invalid`;
          }
          if (!step.collect || typeof step.collect !== 'object') {
            return `request.chain[${i}].collect is invalid`;
          }
          const parallel = step.parallel as Record<string, unknown>;
          if (typeof parallel.agent !== 'string' || typeof parallel.task !== 'string') {
            return `request.chain[${i}].parallel requires agent and task strings`;
          }
          const collect = step.collect as Record<string, unknown>;
          if (typeof collect.name !== 'string') {
            return `request.chain[${i}].collect.name is not a string`;
          }
          const expand = step.expand as Record<string, unknown>;
          if (!expand.from || typeof expand.from !== 'object') {
            return `request.chain[${i}].expand.from is invalid`;
          }
          const from = expand.from as Record<string, unknown>;
          if (typeof from.output !== 'string' || typeof from.path !== 'string') {
            return `request.chain[${i}].expand.from requires output and path strings`;
          }
        } else {
          if (typeof step.agent !== 'string' || typeof step.task !== 'string') {
            return `request.chain[${i}] requires agent and task strings`;
          }
        }
      }
      if (req.tasks !== undefined) {
        return 'request chain mode must not include tasks';
      }
    }
    return undefined;
  }

  function parseRunJsonBytes(
    runId: string,
    dir: string,
    content: string
  ): { ok: true; loaded: LoadedRun } | { ok: false; error: RunStoreError } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'corrupt_run',
          runId,
          message: `run.json is not valid JSON: ${messageOf(err)}`,
        },
      };
    }
    const validated = validateRunRecord(parsed, runId, dir);
    if (!validated.ok) return validated;
    return { ok: true, loaded: { runDir: dir, record: validated.record } };
  }

  function loadRunJson(
    runId: string
  ): { ok: true; loaded: LoadedRun } | { ok: false; error: RunStoreError } {
    const dir = runDirOf(runId);

    // Fast path: no transaction artifacts → pathname authority read of run.json.
    if (!hasTxArtifacts(dir)) {
      let content: string;
      try {
        content = readRunJsonViaDirComponents(runId, dir).toString('utf-8');
      } catch (err) {
        if (isRunStoreError(err)) {
          const e = err as RunStoreError;
          if (e.code === 'corrupt_run' && String(e.message).includes('not found')) {
            return {
              ok: false,
              error: { code: 'run_not_found', runId, message: 'run.json not found' },
            };
          }
          if (e.code === 'run_not_found') {
            return {
              ok: false,
              error: { code: 'run_not_found', runId, message: e.message ?? 'run.json not found' },
            };
          }
          return { ok: false, error: { ...e, runId } };
        }
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return {
            ok: false,
            error: { code: 'run_not_found', runId, message: 'run.json not found' },
          };
        }
        return {
          ok: false,
          error: { code: 'corrupt_run', runId, message: `cannot read run.json: ${messageOf(err)}` },
        };
      }
      // Re-check: a writer may have started between the artifact probe and read.
      if (!hasTxArtifacts(dir)) {
        return parseRunJsonBytes(runId, dir, content);
      }
    }

    // Transaction state present: acquire lock, recover, then read.
    try {
      return withTxLock(runId, (held) => {
        const recovered = recoverStrictTransactionLocked(runId, held.session);
        if (!recovered.ok) return recovered;
        revalidatePublicRunDir(held.session.publicDir, undefined, runId);
        const lockedFile = childInDir(held.session.publicDir, 'run.json');
        let content: string;
        try {
          content = readRunJsonNoFollow(lockedFile, dir, { skipPathBound: true }).toString('utf-8');
        } catch (err) {
          if (isRunStoreError(err)) {
            const e = err as RunStoreError;
            if (e.code === 'corrupt_run' && String(e.message).includes('not found')) {
              return {
                ok: false,
                error: { code: 'run_not_found', runId, message: 'run.json not found' },
              };
            }
            return { ok: false, error: { ...e, runId } };
          }
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            return {
              ok: false,
              error: { code: 'run_not_found', runId, message: 'run.json not found' },
            };
          }
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId,
              message: `cannot read run.json: ${messageOf(err)}`,
            },
          };
        }
        return parseRunJsonBytes(runId, dir, content);
      });
    } catch (err) {
      if (isRunStoreError(err)) {
        return { ok: false, error: err as RunStoreError };
      }
      return {
        ok: false,
        error: {
          code: 'run_store_error',
          runId,
          message: `load run lock failed: ${messageOf(err)}`,
        },
      };
    }
  }

  function writeRunContentsLocked(
    runId: string,
    record: AgentRunRecordV1,
    strict = false,
    held?: HeldTxLock
  ): void {
    const dir = runDirOf(runId);
    const session = held?.session;
    if (session) revalidatePublicRunDir(session.publicDir, undefined);
    const target = session ? childInDir(session.publicDir, 'run.json') : path.join(dir, 'run.json');
    const tmpName = `.run.json.${instanceId}.${randomUUID()}.tmp`;
    const tmp = session ? childInDir(session.publicDir, tmpName) : path.join(dir, tmpName);
    const dataBuf = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    const targetExisted = pathEntryKind(target) !== 'absent';
    const rollbackPath = session
      ? childInDir(session.publicDir, TX_ROLLBACK_NAME)
      : path.join(dir, TX_ROLLBACK_NAME);
    let previousBytes: Buffer | undefined;
    let rollbackPublished = false;
    let preparedDurable = false;
    let committedDurable = false;
    let fd: number | undefined;

    const cleanupStagingOnly = (): void => {
      try {
        if (pathEntryKind(tmp) !== 'absent') fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    };

    const isTerminalTxError = (err: unknown): boolean => {
      if (!err || typeof err !== 'object' || !('message' in err)) return false;
      const msg = String((err as { message: unknown }).message ?? '');
      const code =
        'code' in err && typeof (err as { code?: unknown }).code === 'string'
          ? (err as { code: string }).code
          : '';
      return (
        code === 'durable_commit_uncertain' ||
        code === 'durable_write_error' ||
        msg.includes('prior run.json restored') ||
        msg.includes('recovery files preserved') ||
        msg.includes('recovery material incomplete') ||
        msg.includes('commit publication is uncertain')
      );
    };

    const restoredFailureMessage = (causeMessage: string): string => {
      // Preserve the post-rename directory-sync wording expected by existing tests.
      if (causeMessage.includes('directory fsync failed')) {
        return `${causeMessage}; prior run.json restored`;
      }
      return `strict run.json update failed: ${causeMessage}; prior run.json restored`;
    };

    /**
     * Restore previous authority from the durable rollback copy.
     * On success removes marker/rollback. On I/O failure preserves recovery
     * material and throws durable_write_error (never generic leftover cleanup).
     */
    const restoreFromRollback = (causeMessage: string): never => {
      if (!previousBytes || pathEntryKind(rollbackPath) === 'absent') {
        throw {
          code: 'durable_write_error',
          runId,
          message: `strict run.json update failed: ${causeMessage}; recovery material incomplete`,
        } satisfies RunStoreError;
      }
      try {
        fireStrictTxHook('during_rollback_restore');
        const rb = readPrivateFileBytes(rollbackPath, dir, TX_ROLLBACK_NAME, {
          skipPathBound: !!session,
        });
        if (!rb.equals(previousBytes)) {
          throw {
            code: 'durable_write_error',
            runId,
            message: `strict run.json update failed: ${causeMessage}; rollback bytes mismatch; recovery files preserved`,
          } satisfies RunStoreError;
        }
        writePrivateBytesAtomic(target, dir, 'run.json', rb, fsyncRunDir, session);
        fsyncPathStrict(target);
        if (session) fsyncRunDir(session.publicDir);
        else fsyncRunDir(dir);
        // Restore succeeded — drop transaction leftovers (prepared order).
        const cleaned = cleanupTxPhase(dir, 'prepared', session);
        if (!cleaned.ok) {
          throw {
            code: 'durable_write_error',
            runId,
            message: `strict run.json recovery cleanup failed: ${messageOf(cleaned.error)}; recovery files preserved`,
          } satisfies RunStoreError;
        }
        cleanupStagingOnly();
        throw {
          code: 'run_store_error',
          runId,
          message: restoredFailureMessage(causeMessage),
        } satisfies RunStoreError;
      } catch (rollbackErr) {
        if (isBypassCleanupError(rollbackErr)) throw rollbackErr;
        if (isTerminalTxError(rollbackErr)) throw rollbackErr;
        // Preserve rollback + marker; do not call generic leftover cleanup.
        throw {
          code: 'durable_write_error',
          runId,
          message: `strict run.json recovery failed: ${messageOf(rollbackErr)}; recovery files preserved`,
        } satisfies RunStoreError;
      }
    };

    try {
      // Always clear any interrupted transaction before publishing a new one.
      // Ordinary writers also recover under the lock before reading/writing.
      {
        const recovered = recoverStrictTransactionLocked(runId, session);
        if (!recovered.ok) throw recovered.error;
      }

      // Strict replacement of an existing run.json: durable prepared/committed protocol.
      if (strict && targetExisted) {
        previousBytes = readRunJsonNoFollow(target, dir, {
          skipPathBound: !!session,
        });
        const markerBase: Omit<TxMarker, 'phase'> = {
          version: TX_MARKER_VERSION,
          oldSha256: sha256Hex(previousBytes),
          oldBytes: previousBytes.byteLength,
          newSha256: sha256Hex(dataBuf),
          newBytes: dataBuf.byteLength,
        };

        writePrivateBytesAtomic(
          rollbackPath,
          dir,
          TX_ROLLBACK_NAME,
          previousBytes,
          fsyncRunDir,
          session
        );
        rollbackPublished = true;
        fireStrictTxHook('after_rollback_publication');

        const preparedPub = writeMarkerStrict(
          dir,
          { ...markerBase, phase: 'prepared' },
          fsyncRunDir,
          session
        );
        if (!preparedPub.renameOccurred || !preparedPub.dirSyncCompleted) {
          const err =
            'error' in preparedPub
              ? preparedPub.error
              : 'syncError' in preparedPub
                ? preparedPub.syncError
                : new Error('prepared marker publication failed');
          // If rename happened but sync failed, prepared may be present; treat as prepared.
          if (preparedPub.renameOccurred) {
            preparedDurable = true;
            restoreFromRollback(messageOf(err));
          }
          throw err;
        }
        preparedDurable = true;
        fireStrictTxHook('after_prepared_marker');
      }

      // Staging file: O_CREAT|O_EXCL|pathname + identity-checked rename.
      fd = fs.openSync(
        tmp,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollowFlag(),
        FILE_MODE
      );
      try {
        fs.fchmodSync(fd, FILE_MODE);
      } catch {
        applyMode(tmp, FILE_MODE);
      }
      fs.writeFileSync(fd, dataBuf);
      fileFsyncImpl(fd);
      const stagingIdentity = identityOf(fs.fstatSync(fd));
      fs.closeSync(fd);
      fd = undefined;
      const tmpStat = fs.lstatSync(tmp);
      if (!sameIdentity(stagingIdentity, identityOf(tmpStat)) || !tmpStat.isFile()) {
        throw {
          code: 'corrupt_run',
          runId,
          message: 'run.json temp replaced after close',
        } satisfies RunStoreError;
      }
      fs.renameSync(tmp, target);
      const destStat = fs.lstatSync(target);
      if (!sameIdentity(stagingIdentity, identityOf(destStat)) || !destStat.isFile()) {
        throw {
          code: 'corrupt_run',
          runId,
          message: 'run.json identity mismatch after rename',
        } satisfies RunStoreError;
      }

      if (strict) {
        if (preparedDurable) fireStrictTxHook('after_new_rename');
        try {
          if (session) {
            fsyncRunDir(session.publicDir);
            revalidatePublicRunDir(session.publicDir, undefined);
          }
          strictPostRenameDirectorySync(dir);
        } catch (syncErr) {
          if (isBypassCleanupError(syncErr)) throw syncErr;
          const syncMessage = messageOf(syncErr);
          if (preparedDurable && previousBytes) {
            restoreFromRollback(syncMessage);
          }
          cleanupStagingOnly();
          if (syncErr && typeof syncErr === 'object' && 'code' in syncErr) throw syncErr;
          throw {
            code: 'run_store_error',
            runId,
            message: `directory fsync failed: ${syncMessage}`,
          } satisfies RunStoreError;
        }

        if (preparedDurable && previousBytes) {
          try {
            fireStrictTxHook('after_new_directory_sync');
          } catch (hookErr) {
            if (isBypassCleanupError(hookErr)) throw hookErr;
            restoreFromRollback(messageOf(hookErr));
          }

          // Durably mark committed before treating the update as authoritative.
          const committedMarker: TxMarker = {
            version: TX_MARKER_VERSION,
            phase: 'committed',
            oldSha256: sha256Hex(previousBytes),
            oldBytes: previousBytes.byteLength,
            newSha256: sha256Hex(dataBuf),
            newBytes: dataBuf.byteLength,
          };
          const commitPub = writeMarkerStrict(
            dir,
            committedMarker,
            strictCommittedMarkerDirectorySync,
            session
          );

          if (!commitPub.renameOccurred) {
            // Committed marker never published — restore old authority.
            restoreFromRollback(messageOf(commitPub.error));
          }

          if (commitPub.renameOccurred && !commitPub.dirSyncCompleted) {
            // Committed rename may be visible; try to re-publish prepared durably,
            // then rollback. If re-prepare fails, report durable_commit_uncertain.
            const reprepare: TxMarker = {
              version: TX_MARKER_VERSION,
              phase: 'prepared',
              oldSha256: sha256Hex(previousBytes),
              oldBytes: previousBytes.byteLength,
              newSha256: sha256Hex(dataBuf),
              newBytes: dataBuf.byteLength,
            };
            const reprepPub = writeMarkerStrict(dir, reprepare, fsyncRunDir, session);
            if (reprepPub.renameOccurred && reprepPub.dirSyncCompleted) {
              // Prepared durable again — safe to restore old authority.
              restoreFromRollback(
                `committed marker directory sync failed: ${messageOf(commitPub.syncError)}`
              );
            }
            // Cannot durably re-prepare: leave files as-is for locked recovery.
            throw {
              code: 'durable_commit_uncertain',
              runId,
              message:
                'strict run.json commit publication is uncertain; recovery files preserved for locked recovery',
            } satisfies RunStoreError;
          }

          // Committed marker fully durable.
          committedDurable = true;

          // Verify committed marker and rollback identities before any cleanup hooks
          // can replace them. Pass exact generation to cleanup so replacement is detected.
          const markerPathForCleanup = session
            ? childInDir(session.publicDir, TX_MARKER_NAME)
            : path.join(dir, TX_MARKER_NAME);
          const committedMarkerVerified: VerifiedPrivateFile | undefined =
            pathEntryKind(markerPathForCleanup) === 'regular'
              ? openVerifiedPrivateFile(markerPathForCleanup, dir, TX_MARKER_NAME, {
                  skipPathBound: !!session,
                  parseMarkerPhase: true,
                })
              : undefined;
          const cleanupRollbackVerified: VerifiedPrivateFile | undefined = rollbackPublished
            ? openVerifiedPrivateFile(rollbackPath, dir, TX_ROLLBACK_NAME, {
                skipPathBound: !!session,
              })
            : undefined;

          // Post-commit: authority is new. Hook/cleanup failures must not report
          // rollback; next load finishes leftover cleanup when state stays unambiguous.
          try {
            fireStrictTxHook('after_committed_marker');
          } catch (hookErr) {
            if (isBypassCleanupError(hookErr)) throw hookErr;
            /* ignore ordinary hooks — committed */
          }
          try {
            fireStrictTxHook('during_cleanup');
            const cleaned = cleanupTxPhase(dir, 'committed', session, {
              marker: committedMarkerVerified,
              rollback: cleanupRollbackVerified,
            });
            if (!cleaned.ok) {
              const errCode =
                cleaned.error && typeof cleaned.error === 'object' && 'code' in cleaned.error
                  ? (cleaned.error as RunStoreError).code
                  : undefined;
              if (errCode === 'generation_mismatch') {
                throw cleaned.error;
              }
              const recheck = revalidateCommittedState(
                dir,
                { sha256: sha256Hex(dataBuf), bytes: dataBuf.byteLength },
                session,
                {
                  markerIdentity: committedMarkerVerified?.identity,
                  rollbackIdentity: cleanupRollbackVerified?.identity,
                }
              );
              if (!recheck.ok) {
                throw {
                  code: recheck.error.code,
                  runId,
                  message:
                    recheck.error.message ??
                    `strict run.json committed cleanup failed: ${messageOf(cleaned.error)}`,
                } satisfies RunStoreError;
              }
            }
          } catch (cleanupErr) {
            if (isBypassCleanupError(cleanupErr)) throw cleanupErr;
            if (cleanupErr && typeof cleanupErr === 'object' && 'code' in cleanupErr) {
              const code = (cleanupErr as RunStoreError).code;
              if (
                code === 'corrupt_run' ||
                code === 'durable_write_error' ||
                code === 'generation_mismatch'
              )
                throw cleanupErr;
            }
            const recheck = revalidateCommittedState(
              dir,
              { sha256: sha256Hex(dataBuf), bytes: dataBuf.byteLength },
              session,
              {
                markerIdentity: committedMarkerVerified?.identity,
                rollbackIdentity: cleanupRollbackVerified?.identity,
              }
            );
            if (!recheck.ok) {
              throw {
                code: recheck.error.code,
                runId,
                message: recheck.error.message ?? messageOf(cleanupErr),
              } satisfies RunStoreError;
            }
          }
        }
      } else {
        if (session) fsyncRunDir(session.publicDir);
        else fsyncRunDir(dir);
      }
    } catch (err) {
      if (isBypassCleanupError(err)) throw err;
      if (isTerminalTxError(err)) throw err;
      // Pre-commit: prepared marker exists → restore old authority from rollback.
      if (strict && preparedDurable && !committedDurable && previousBytes) {
        restoreFromRollback(messageOf(err));
      }
      // Rollback published but marker never durable: run.json still old; drop orphan.
      if (strict && rollbackPublished && !preparedDurable && !committedDurable) {
        try {
          removeTxFiles(dir, 'prepared', session);
        } catch {
          /* leave for load recovery */
        }
        cleanupStagingOnly();
      }
      throw err;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      // Staging temps are safe to drop even after a bypass crash; transaction
      // marker/rollback/run.json are intentionally left untouched on bypass.
      try {
        cleanupStagingOnly();
      } catch {
        /* ignore */
      }
    }
  }

  async function writeRunContents(
    runId: string,
    record: AgentRunRecordV1,
    strict = false
  ): Promise<void> {
    // Every run.json writer holds the cross-instance transaction lock.
    await withTxLockAsync(runId, (held) => {
      writeRunContentsLocked(runId, record, strict, held);
    });
  }

  function writeRunJsonAtomic(runId: string, record: AgentRunRecordV1): Promise<void> {
    return runSerial(runId, async () => {
      await writeRunContents(runId, record);
    });
  }

  function appendEventLine(runId: string, event: RunLifecycleEvent, strict = false): Promise<void> {
    return runSerial(runId, async () => {
      if (!isRunIdValid(runId)) {
        throw {
          code: 'run_not_found',
          runId,
          message: 'invalid run id',
        } satisfies RunStoreError;
      }
      const dir = runDirOf(runId);
      if (!fs.existsSync(dir)) {
        throw {
          code: 'run_not_found',
          runId,
          message: 'run directory missing',
        } satisfies RunStoreError;
      }
      const file = eventsPath(runId);
      const line = `${JSON.stringify(event)}\n`;
      let fd: number | undefined;
      try {
        fd = fs.openSync(file, 'a', FILE_MODE);
        fs.writeFileSync(fd, line);
        fileFsyncImpl(fd);
        fs.closeSync(fd);
        fd = undefined;
        if (strict) fsyncRunDir(dir);
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }
    });
  }

  function ticketDirName(ticket: number): string {
    return ticket.toString().padStart(TICKET_WIDTH, '0');
  }

  function listPublishedTickets(runId: string): number[] {
    const dir = claimsDir(runId);
    if (!fs.existsSync(dir)) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const tickets: number[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      const n = parseInt(entry.name, 10);
      if (Number.isFinite(n) && entry.name === ticketDirName(n)) {
        tickets.push(n);
      }
    }
    return tickets.sort((a, b) => a - b);
  }

  function readOwner(
    ticket: number,
    runId: string
  ): { ok: true; owner: ClaimOwner } | { ok: false; error: RunStoreError } {
    const ownerPath = path.join(claimsDir(runId), ticketDirName(ticket), 'owner.json');
    let content: string;
    try {
      content = fs.readFileSync(ownerPath, 'utf-8');
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'claim_corrupt',
          runId,
          message: `cannot read owner.json: ${messageOf(err)}`,
        },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'claim_corrupt',
          runId,
          message: `owner.json is not valid JSON: ${messageOf(err)}`,
        },
      };
    }
    if (!parsed || typeof parsed !== 'object') {
      return {
        ok: false,
        error: { code: 'claim_corrupt', runId, message: 'owner.json is not an object' },
      };
    }
    const o = parsed as Partial<ClaimOwner>;
    if (
      typeof o.runId !== 'string' ||
      typeof o.claimId !== 'string' ||
      typeof o.instanceId !== 'string' ||
      typeof o.pid !== 'number' ||
      typeof o.acquiredAt !== 'number'
    ) {
      return {
        ok: false,
        error: { code: 'claim_corrupt', runId, message: 'owner.json missing required fields' },
      };
    }
    return { ok: true, owner: o as ClaimOwner };
  }

  function readTerminal(
    ticket: number,
    runId: string
  ):
    | { ok: true; terminal: ClaimTerminal }
    | { ok: false; error: RunStoreError }
    | { ok: false; missing: true } {
    const terminalPath = path.join(claimsDir(runId), ticketDirName(ticket), 'terminal.json');
    let content: string;
    try {
      content = fs.readFileSync(terminalPath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ok: false, missing: true };
      return {
        ok: false,
        error: {
          code: 'claim_corrupt',
          runId,
          message: `cannot read terminal.json: ${messageOf(err)}`,
        },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'claim_corrupt',
          runId,
          message: `terminal.json is not valid JSON: ${messageOf(err)}`,
        },
      };
    }
    if (!parsed || typeof parsed !== 'object') {
      return {
        ok: false,
        error: { code: 'claim_corrupt', runId, message: 'terminal.json is not an object' },
      };
    }
    const t = parsed as Partial<ClaimTerminal>;
    if (
      typeof t.claimId !== 'string' ||
      typeof t.timestamp !== 'number' ||
      (t.state !== 'released' && t.state !== 'abandoned')
    ) {
      return {
        ok: false,
        error: { code: 'claim_corrupt', runId, message: 'terminal.json missing required fields' },
      };
    }
    return { ok: true, terminal: t as ClaimTerminal };
  }

  function publishClaimTerminal(
    runId: string,
    ticket: number,
    claimId: string,
    state: 'released' | 'abandoned'
  ): Promise<void> {
    return runSerial(runId, async () => {
      const ticketDirectory = path.join(claimsDir(runId), ticketDirName(ticket));
      const terminalPath = path.join(ticketDirectory, 'terminal.json');
      const stagedPath = path.join(ticketDirectory, `.terminal.${instanceId}.${randomUUID()}.tmp`);
      const payload = JSON.stringify({ claimId, state, timestamp: now() }) + '\n';
      let fd: number | undefined;
      try {
        fd = fs.openSync(stagedPath, 'w', FILE_MODE);
        fs.writeFileSync(fd, payload);
        fileFsyncImpl(fd);
        fs.closeSync(fd);
        fd = undefined;
        try {
          fs.linkSync(stagedPath, terminalPath);
        } catch (err) {
          if (
            isNoReplaceContentionError(err, () => {
              try {
                fs.lstatSync(terminalPath);
                return true;
              } catch {
                return false;
              }
            })
          ) {
            const winner = readTerminal(ticket, runId);
            if ('ok' in winner && !winner.ok && !('missing' in winner)) {
              throw winner.error;
            }
            // If the winner's claimId does not match ours, another claimant
            // published a terminal for our ticket directory. Record the
            // diagnostic but do not throw — our release is still durable.
            if ('ok' in winner && winner.ok && winner.terminal.claimId !== claimId) {
              void winner;
            }
            // A terminal already exists; our release is redundant but not an error.
          } else {
            throw err;
          }
        }
        fsyncRunDir(ticketDirectory);
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore */
          }
        }
        try {
          if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
        } catch {
          /* ignore */
        }
      }
    });
  }

  function cleanupStaging(stagingDir: string): void {
    // Only remove the protocol-owned owner.json, then non-recursive rmdir. Preserve unknown entries.
    try {
      const ownerPath = path.join(stagingDir, 'owner.json');
      try {
        fs.unlinkSync(ownerPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          /* leave evidence */
        }
      }
      try {
        fs.rmdirSync(stagingDir);
      } catch {
        /* not empty or missing — preserve foreign entries */
      }
    } catch {
      /* ignore */
    }
  }

  function stageOwner(
    runId: string,
    ticket: number,
    owner: ClaimOwner
  ): { stagingDir: string; ticketDirectory: string; stagedOwnerPath: string } {
    const ticketDirectory = path.join(claimsDir(runId), ticketDirName(ticket));
    const stagingDir = path.join(claimsDir(runId), `.staging-${randomUUID()}`);
    mkdirPrivate(stagingDir);
    const stagedOwnerPath = path.join(stagingDir, 'owner.json');
    const data = JSON.stringify(owner, null, 2) + '\n';
    let fd: number | undefined;
    try {
      fd = fs.openSync(stagedOwnerPath, 'w', FILE_MODE);
      fs.writeFileSync(fd, data);
      fileFsyncImpl(fd);
      fs.closeSync(fd);
      fd = undefined;
      return { stagingDir, ticketDirectory, stagedOwnerPath };
    } catch (err) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      // Exact best-effort cleanup of only this attempt's recognized staging residue.
      cleanupStaging(stagingDir);
      throw err;
    }
  }

  type PublishResult =
    { ok: true } | { ok: false; retry: true } | { ok: false; error: RunStoreError };

  function publishStagedOwner(
    runId: string,
    ticket: number,
    stagingDir: string,
    _stagedOwnerPath: string
  ): PublishResult {
    const ticketDirectory = path.join(claimsDir(runId), ticketDirName(ticket));
    try {
      fs.renameSync(stagingDir, ticketDirectory);
      applyMode(ticketDirectory, DIR_MODE);
      return { ok: true };
    } catch (err) {
      if (
        isNoReplaceContentionError(err, () => {
          try {
            fs.lstatSync(ticketDirectory);
            return true;
          } catch {
            return false;
          }
        })
      ) {
        // A competing claimant won this ticket; retry with a higher ticket.
        return { ok: false, retry: true };
      }
      return {
        ok: false,
        error: {
          code: 'claim_corrupt',
          runId,
          message: `failed to publish owner: ${messageOf(err)}`,
        },
      };
    }
  }

  function writeOwnerForTicket(
    runId: string,
    ticket: number,
    claimId: string
  ): { stagingDir: string; stagedOwnerPath: string; owner: ClaimOwner } {
    const owner: ClaimOwner = {
      runId,
      claimId,
      instanceId,
      pid,
      acquiredAt: now(),
    };
    const { stagingDir, stagedOwnerPath } = stageOwner(runId, ticket, owner);
    return { stagingDir, stagedOwnerPath, owner };
  }

  function lowestEligibleTicket(
    runId: string
  ): { ok: true; ticket: number; owner?: ClaimOwner } | { ok: false; error: RunStoreError } {
    const tickets = listPublishedTickets(runId);
    for (const ticket of tickets) {
      const ownerResult = readOwner(ticket, runId);
      if (!ownerResult.ok) {
        return { ok: false, error: ownerResult.error };
      }
      const terminal = readTerminal(ticket, runId);
      if (!terminal.ok && !('missing' in terminal)) {
        return { ok: false, error: terminal.error };
      }
      if (terminal.ok) {
        // This ticket has terminated; skip it regardless of state.
        continue;
      }
      // Live or abandoned-without-terminal: candidate. Check PID liveness below.
      const owner = ownerResult.owner;
      if (owner.pid === pid && owner.instanceId === instanceId) {
        return { ok: true, ticket, owner };
      }
      if (isPidAlive(owner.pid)) {
        // Another live process owns this lower ticket; we must withdraw.
        return { ok: true, ticket, owner };
      }
      // Dead owner — abandon it so the high-water mark advances.
      try {
        publishClaimTerminalSync(runId, ticket, owner.claimId, 'abandoned');
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'claim_corrupt',
            runId,
            message: `failed to abandon dead claim: ${messageOf(err)}`,
          },
        };
      }
      continue;
    }
    return { ok: true, ticket: -1 };
  }

  function publishClaimTerminalSync(
    runId: string,
    ticket: number,
    claimId: string,
    state: 'released' | 'abandoned'
  ): void {
    const ticketDirectory = path.join(claimsDir(runId), ticketDirName(ticket));
    const terminalPath = path.join(ticketDirectory, 'terminal.json');
    const stagedPath = path.join(ticketDirectory, `.terminal.${instanceId}.${randomUUID()}.tmp`);
    const payload = JSON.stringify({ claimId, state, timestamp: now() }) + '\n';
    let fd: number | undefined;
    try {
      fd = fs.openSync(stagedPath, 'w', FILE_MODE);
      fs.writeFileSync(fd, payload);
      fileFsyncImpl(fd);
      fs.closeSync(fd);
      fd = undefined;
      try {
        fs.linkSync(stagedPath, terminalPath);
      } catch (err) {
        if (
          !isNoReplaceContentionError(err, () => {
            try {
              fs.lstatSync(terminalPath);
              return true;
            } catch {
              return false;
            }
          })
        ) {
          throw err;
        }
      }
      fsyncRunDir(ticketDirectory);
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      try {
        if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
      } catch {
        /* ignore */
      }
    }
  }

  function isPidAlive(pid: number): boolean {
    if (pid <= 0) return false;
    if (pid === (options.pid ?? process.pid)) return true;
    try {
      pidAliveKill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Only ESRCH proves death. EPERM/ENOSYS/unknown remain busy (alive).
      if (code === 'ESRCH') return false;
      return true;
    }
  }

  async function createRun(
    input: CreateRunInput
  ): Promise<{ runId: string; record: AgentRunRecordV1 }> {
    const runId = `run-${randomUUID()}`;
    if (!isRunIdValid(runId)) {
      throw new Error(`Invalid generated run id: ${runId}`);
    }
    const dir = runDirOf(runId);
    mkdirPrivate(dir);
    mkdirPrivate(claimsDir(runId));
    mkdirPrivate(path.join(dir, 'sessions'));
    const ts = now();
    const record: AgentRunRecordV1 = {
      version: RUN_RECORD_VERSION,
      runId,
      mode: input.mode,
      status: 'queued',
      request: input.request,
      background: input.background,
      agentScope: input.agentScope,
      createdAt: ts,
      updatedAt: ts,
      details: input.details,
      units: input.units,
      eventsFile: 'events.jsonl',
    };
    await writeRunJsonAtomic(runId, record);
    await appendEventLine(runId, { version: 1, event: 'run_created', runId, timestamp: ts });
    return { runId, record };
  }

  function getRun(runId: string): ReturnType<RunStore['getRun']> {
    if (!isRunIdValid(runId)) {
      return { ok: false, error: { code: 'run_not_found', runId, message: 'invalid run id' } };
    }
    return loadRunJson(runId);
  }

  async function updateRun(
    runId: string,
    mutate: (record: AgentRunRecordV1) => void
  ): Promise<AgentRunRecordV1> {
    return runSerial(runId, async () => {
      // Full RMW under one transaction lock: recover → load → mutate → write.
      return withTxLockAsync(runId, (held) => {
        const recovered = recoverStrictTransactionLocked(runId, held.session);
        if (!recovered.ok) throw recovered.error;
        revalidatePublicRunDir(held.session.publicDir, undefined, runId);
        const lockedFile = childInDir(held.session.publicDir, 'run.json');
        let content: string;
        try {
          content = readRunJsonNoFollow(lockedFile, held.dir, { skipPathBound: true }).toString(
            'utf-8'
          );
        } catch (err) {
          if (isRunStoreError(err)) {
            const e = err as RunStoreError;
            if (e.code === 'corrupt_run' && String(e.message).includes('not found')) {
              throw {
                code: 'run_not_found',
                runId,
                message: 'run.json not found',
              } satisfies RunStoreError;
            }
            throw { ...e, runId } satisfies RunStoreError;
          }
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            throw {
              code: 'run_not_found',
              runId,
              message: 'run.json not found',
            } satisfies RunStoreError;
          }
          throw {
            code: 'corrupt_run',
            runId,
            message: `cannot read run.json: ${messageOf(err)}`,
          } satisfies RunStoreError;
        }
        const parsed = parseRunJsonBytes(runId, held.dir, content);
        if (!parsed.ok) throw parsed.error;
        const record = parsed.loaded.record;
        mutate(record);
        record.updatedAt = now();
        writeRunContentsLocked(runId, record, false, held);
        return record;
      });
    });
  }

  async function updateRunStrict(
    runId: string,
    mutate: (record: AgentRunRecordV1) => void
  ): Promise<AgentRunRecordV1> {
    // Same serial queue as updateRun; full RMW under transaction lock.
    return runSerial(runId, async () => {
      return withTxLockAsync(runId, (held) => {
        const recovered = recoverStrictTransactionLocked(runId, held.session);
        if (!recovered.ok) throw recovered.error;
        revalidatePublicRunDir(held.session.publicDir, undefined, runId);
        const lockedFile = childInDir(held.session.publicDir, 'run.json');
        let content: string;
        try {
          content = readRunJsonNoFollow(lockedFile, held.dir, { skipPathBound: true }).toString(
            'utf-8'
          );
        } catch (err) {
          if (isRunStoreError(err)) {
            const e = err as RunStoreError;
            if (e.code === 'corrupt_run' && String(e.message).includes('not found')) {
              throw {
                code: 'run_not_found',
                runId,
                message: 'run.json not found',
              } satisfies RunStoreError;
            }
            throw { ...e, runId } satisfies RunStoreError;
          }
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            throw {
              code: 'run_not_found',
              runId,
              message: 'run.json not found',
            } satisfies RunStoreError;
          }
          throw {
            code: 'corrupt_run',
            runId,
            message: `cannot read run.json: ${messageOf(err)}`,
          } satisfies RunStoreError;
        }
        const parsed = parseRunJsonBytes(runId, held.dir, content);
        if (!parsed.ok) throw parsed.error;
        const record = structuredClone(parsed.loaded.record) as AgentRunRecordV1;
        mutate(record);
        record.updatedAt = now();
        const validated = validateRunRecord(record, runId, runDirOf(runId));
        if (!validated.ok) throw validated.error;
        writeRunContentsLocked(runId, validated.record, true, held);
        return validated.record;
      });
    });
  }

  async function appendEvent(runId: string, event: RunLifecycleEvent): Promise<void> {
    await appendEventLine(runId, event, false);
  }

  async function appendEventStrict(runId: string, event: RunLifecycleEvent): Promise<void> {
    await appendEventLine(runId, event, true);
  }

  async function writeTextArtifact(
    runId: string,
    payload: RunArtifactPayload,
    text: string
  ): Promise<RunArtifactRefV1> {
    if (!isRunIdValid(runId)) {
      throw { code: 'run_not_found', runId, message: 'invalid run id' } satisfies RunStoreError;
    }
    const dir = runDirOf(runId);
    if (!fs.existsSync(dir)) {
      throw {
        code: 'run_not_found',
        runId,
        message: 'run directory missing',
      } satisfies RunStoreError;
    }
    return artifacts.writeTextArtifact(runId, dir, payload, text);
  }

  async function writeJsonArtifact(
    runId: string,
    payload: RunArtifactPayload,
    value: unknown
  ): Promise<RunArtifactRefV1> {
    if (!isRunIdValid(runId)) {
      throw { code: 'run_not_found', runId, message: 'invalid run id' } satisfies RunStoreError;
    }
    const dir = runDirOf(runId);
    if (!fs.existsSync(dir)) {
      throw {
        code: 'run_not_found',
        runId,
        message: 'run directory missing',
      } satisfies RunStoreError;
    }
    return artifacts.writeJsonArtifact(runId, dir, payload, value);
  }

  async function readTextArtifact(runId: string, ref: RunArtifactRefV1): Promise<string> {
    if (!isRunIdValid(runId)) {
      throw { code: 'run_not_found', runId, message: 'invalid run id' } satisfies RunStoreError;
    }
    return artifacts.readTextArtifact(runId, runDirOf(runId), ref);
  }

  async function readJsonArtifact(runId: string, ref: RunArtifactRefV1): Promise<unknown> {
    if (!isRunIdValid(runId)) {
      throw { code: 'run_not_found', runId, message: 'invalid run id' } satisfies RunStoreError;
    }
    return artifacts.readJsonArtifact(runId, runDirOf(runId), ref);
  }

  async function resolveArtifactPath(runId: string, ref: RunArtifactRefV1): Promise<string> {
    if (!isRunIdValid(runId)) {
      throw { code: 'run_not_found', runId, message: 'invalid run id' } satisfies RunStoreError;
    }
    return artifacts.resolveArtifactPath(runId, runDirOf(runId), ref);
  }

  async function listRuns(): Promise<ListRunsResult> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const results: ListRunsResult = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runId = entry.name;
      if (!isRunIdValid(runId)) continue;
      const loaded = loadRunJson(runId);
      if (loaded.ok) {
        results.push(loaded.loaded);
      } else {
        const errCode = loaded.error.code;
        const preserved:
          | 'corrupt_run'
          | 'durable_write_error'
          | 'durable_commit_uncertain'
          | 'run_busy'
          | 'run_store_error' =
          errCode === 'durable_write_error' ||
          errCode === 'durable_commit_uncertain' ||
          errCode === 'run_busy' ||
          errCode === 'run_store_error'
            ? errCode
            : 'corrupt_run';
        const corrupt: CorruptRunEntry = {
          runId,
          runDir: runDirOf(runId),
          code: preserved,
          message: loaded.error.message,
        };
        results.push(corrupt);
      }
    }
    results.sort((a, b) => {
      const at = 'record' in a ? a.record.updatedAt : 0;
      const bt = 'record' in b ? b.record.updatedAt : 0;
      return bt - at;
    });
    return results;
  }

  async function claimRun(runId: string): Promise<ClaimResult> {
    if (!isRunIdValid(runId)) {
      return { ok: false, error: { code: 'run_not_found', runId, message: 'invalid run id' } };
    }
    const loaded = loadRunJson(runId);
    if (!loaded.ok) return { ok: false, error: loaded.error };

    const claimId = randomUUID();
    let ticket = 1;
    let attempt = 0;
    // Publish our ticket directory, retrying with higher tickets until we win or withdraw.
    for (;;) {
      attempt++;
      const tickets = listPublishedTickets(runId);
      if (tickets.length > 0) {
        ticket = tickets[tickets.length - 1] + 1;
      } else {
        ticket = 1;
      }
      const { stagingDir, stagedOwnerPath, owner } = writeOwnerForTicket(runId, ticket, claimId);
      const publish = publishStagedOwner(runId, ticket, stagingDir, stagedOwnerPath);
      if ('ok' in publish && publish.ok) {
        fsyncRunDir(path.join(claimsDir(runId), ticketDirName(ticket)));
        // We published a ticket. Determine if it is the lowest eligible.
        const lowest = lowestEligibleTicket(runId);
        cleanupStaging(stagingDir);
        if (!lowest.ok) {
          // Withdraw our published claim.
          await publishClaimTerminal(runId, ticket, claimId, 'released');
          return { ok: false, error: lowest.error };
        }
        if (lowest.ticket === ticket) {
          // We are the lowest eligible.
          try {
            await updateRun(runId, (record) => {
              record.owner = {
                claimId,
                ticket,
                instanceId,
                pid,
                acquiredAt: owner.acquiredAt,
              };
            });
          } catch (err) {
            await publishClaimTerminal(runId, ticket, claimId, 'released');
            return {
              ok: false,
              error: { code: 'run_store_error', runId, message: messageOf(err) },
            };
          }
          return { ok: true, claimId, ticket };
        }
        // A lower eligible ticket exists. Withdraw and report run_active.
        await publishClaimTerminal(runId, ticket, claimId, 'released');
        return {
          ok: false,
          error: { code: 'run_active', runId, message: 'another live claim holds this run' },
        };
      }
      if (!publish.ok && 'error' in publish) {
        cleanupStaging(stagingDir);
        return { ok: false, error: publish.error };
      }
      // Retry with a higher ticket.
      cleanupStaging(stagingDir);
      if (attempt > 10_000) {
        return {
          ok: false,
          error: { code: 'run_store_error', runId, message: 'claim loop overflow' },
        };
      }
    }
  }

  async function releaseRun(runId: string, claimId: string): Promise<void> {
    await releaseClaim(runId, claimId, 'released');
  }

  async function abandonRun(runId: string, claimId: string): Promise<void> {
    await releaseClaim(runId, claimId, 'abandoned');
  }

  async function releaseClaim(
    runId: string,
    claimId: string,
    state: 'released' | 'abandoned'
  ): Promise<void> {
    // Validate before queue/path join; invalid IDs never touch the filesystem.
    assertValidRunId(runId);
    // Resolve the ticket directory whose owner matches this claimId, and verify
    // the immutable owner payload belongs to *this* store instance. A foreign
    // caller must never terminate another owner's claim.
    const tickets = listPublishedTickets(runId);
    let resolvedTicket: number | undefined;
    for (const ticket of tickets) {
      const ownerResult = readOwner(ticket, runId);
      if (
        ownerResult.ok &&
        ownerResult.owner.claimId === claimId &&
        ownerResult.owner.instanceId === instanceId &&
        ownerResult.owner.pid === pid
      ) {
        resolvedTicket = ticket;
        break;
      }
    }
    if (resolvedTicket === undefined) {
      // No published claim owned by this instance+p+c with the given claimId.
      // A release for a foreign or nonexistent claim is a no-op; treat the
      // claim directory as durable precedent and do not modify it.
      return;
    }
    await publishClaimTerminal(runId, resolvedTicket, claimId, state);
  }

  function inspectClaims(runId: string):
    | {
        ok: true;
        claims: Array<{
          ticket: number;
          owner?: ClaimOwner;
          terminal?: ClaimTerminal;
          ownerError?: string;
          terminalError?: string;
        }>;
      }
    | { ok: false; error: RunStoreError } {
    if (!isRunIdValid(runId)) {
      return { ok: false, error: { code: 'run_not_found', runId, message: 'invalid run id' } };
    }
    const tickets = listPublishedTickets(runId);
    const claims: Array<{
      ticket: number;
      owner?: ClaimOwner;
      terminal?: ClaimTerminal;
      ownerError?: string;
      terminalError?: string;
    }> = [];
    for (const ticket of tickets) {
      const owner = readOwner(ticket, runId);
      const terminal = readTerminal(ticket, runId);
      claims.push({
        ticket,
        owner: owner.ok ? owner.owner : undefined,
        terminal: 'ok' in terminal && terminal.ok ? terminal.terminal : undefined,
        ...(!owner.ok ? { ownerError: owner.error.message } : {}),
        ...(!('ok' in terminal) || !terminal.ok
          ? !('missing' in terminal)
            ? { terminalError: (terminal as { error: RunStoreError }).error.message }
            : {}
          : {}),
      });
    }
    return { ok: true, claims };
  }

  return {
    rootDir,
    getRunDir,
    createRun,
    getRun,
    updateRun,
    appendEvent,
    updateRunStrict,
    appendEventStrict,
    writeTextArtifact,
    writeJsonArtifact,
    readTextArtifact,
    readJsonArtifact,
    resolveArtifactPath,
    listRuns,
    claimRun,
    releaseRun,
    abandonRun,
    inspectClaims,
    isPidAlive,
  };
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (
    err &&
    typeof err === 'object' &&
    'message' in err &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    return (err as { message: string }).message;
  }
  return String(err);
}
