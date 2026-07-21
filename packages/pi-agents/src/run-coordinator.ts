// ABOUTME: Run coordinator — stable unit IDs, agent fingerprints, persistence throttling, status derivation.
// ABOUTME: Wraps existing workflow callbacks to persist durable snapshots without disrupting TUI streaming.

import * as crypto from 'node:crypto';
import { Cause, Effect, Exit, Option } from 'effect';
import type { AgentConfig, Runtime } from './agents.ts';
import {
  DEFAULT_RUNTIME,
  DEFAULT_COALESCE_MS,
  RESULT_INLINE_PAYLOAD_MAX_BYTES,
} from './constants.ts';
import { runEffectExit } from './effect-runtime.ts';
import type { RunStore } from './run-store.ts';
import type {
  AgentRunRecordV1,
  InteractiveAgentBindingV1,
  RunStatus,
  RunUnitRecord,
  RunUnitAttempt,
  ResumeCapability,
  WorkflowFanoutState,
} from './run-types.ts';
import { externalizeTerminalResult } from './result-payload.ts';
import { measureJsonArtifactBytes } from './artifact-store.ts';
import { snapshotSingleResult } from './result-snapshot.ts';
import type { ExecutionStatus, SingleResult, SubagentDetails } from './types.ts';
import { emptyUsage } from './empty-usage.ts';

/**
 * Stable execution-unit identity for a workflow position. Passed into execution
 * instead of adding more positional parameters to `runSingleAgent`.
 */
export interface UnitExecutionContext {
  runId: string;
  unitId: string;
  agent: string;
  runtime: Runtime | undefined;
  resumeCapability: ResumeCapability;
  effectiveCwd: string;
  sessionFile?: string;
  /**
   * ACP protocol session ID for `runtime: "grok-acp"` units.
   * Protocol identity only — never a private Grok session-file path.
   */
  acpSessionId?: string;
  /**
   * Pi original-prompt establishment flag mirrored from the durable unit.
   * `false` = session path stamped but original prompt not yet accepted.
   */
  sessionPromptEstablished?: boolean;
  worktreePath?: string;
  /** Directory for native Pi session files (<runDir>/sessions). Undefined when persistence is inactive. */
  sessionsDir?: string;
  /** 1-based attempt number; the coordinator increments it on resume. */
  attempt: number;
  /**
   * True when the durable unit is never-started (`queued`|`skipped` with empty
   * attempts). Used so a planned session path cannot flip resumeHadStoredSession.
   */
  neverStarted?: boolean;
  /** One-based chain step number; immutable once the unit is created. */
  step?: number;
  /** When true, Pi child launches receive the dedicated artifact reader extension. */
  requireArtifactReader?: boolean;
  /** Zero-based fanout item index within a chain fanout step. */
  fanoutIndex?: number;
}

/** Aggregate resume capability across a run's units (session-only). */
export type AggregateCapability = 'session';

const UNIT_ID_PATTERN = /^[a-z0-9-]+$/;

function assertValidUnitId(unitId: string): void {
  if (!UNIT_ID_PATTERN.test(unitId)) {
    throw new Error(`Invalid unit id: ${unitId}`);
  }
}

/** Pad a 1-based position number to 4 digits for stable lexical ordering. */
export function pad(n: number): string {
  return n.toString().padStart(4, '0');
}

/** Canonical unit id for a one-based chain sequential step. */
export function chainStepUnitId(step: number): string {
  if (!Number.isInteger(step) || step < 1) {
    throw new Error(`Invalid chain step: ${step}`);
  }
  return `chain-${pad(step)}`;
}

/**
 * Canonical workflow-state key for a one-based chain fanout step.
 * Reserved for `workflowState.fanouts`; never used as a `RunUnitRecord` id.
 */
export function chainFanoutStepId(step: number): string {
  if (!Number.isInteger(step) || step < 1) {
    throw new Error(`Invalid chain step: ${step}`);
  }
  return `chain-${pad(step)}-fanout`;
}

/**
 * Canonical unit id for a zero-based fanout item within a one-based chain step.
 * Item 0 → `chain-NNNN-fanout-0001`.
 */
export function chainFanoutUnitId(step: number, fanoutIndex: number): string {
  if (!Number.isInteger(step) || step < 1) {
    throw new Error(`Invalid chain step: ${step}`);
  }
  if (!Number.isInteger(fanoutIndex) || fanoutIndex < 0) {
    throw new Error(`Invalid fanout index: ${fanoutIndex}`);
  }
  return `chain-${pad(step)}-fanout-${pad(fanoutIndex + 1)}`;
}

/**
 * Deterministic unit ids derived from immutable workflow position:
 * - single mode: `single`
 * - parallel mode: `parallel-<NNNN>` (1-based)
 * - chain sequential: `chain-<NNNN>` (statically known only; fanout children
 *   are registered dynamically after expansion)
 *
 * All ids contain only lowercase ascii letters/digits/hyphens. Duplicate ids are
 * rejected by the caller (assertUniqueUnitIds) since a malformed workflow shape
 * could collide.
 */
export function generateUnitIds(
  mode: 'single' | 'parallel' | 'chain',
  request: {
    agent?: string;
    task?: string;
    tasks?: unknown[];
    chain?: unknown[];
  }
): string[] {
  if (mode === 'single') return ['single'];
  if (mode === 'parallel') {
    const n = request.tasks?.length ?? 0;
    return Array.from({ length: n }, (_, i) => `parallel-${pad(i + 1)}`);
  }
  // chain mode — only sequential steps have known cardinality at create time.
  // Fanout children are registered by expandFanout() after the source expands.
  const chain = request.chain ?? [];
  const ids: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const step = chain[i] as { agent?: unknown; expand?: unknown } | null;
    if (step && typeof step === 'object' && 'expand' in step && !('agent' in step)) {
      continue;
    }
    ids.push(chainStepUnitId(i + 1));
  }
  return ids;
}

/** Validate that a set of unit ids is unique; throw with `duplicate_unit_id` otherwise. */
export function assertUniqueUnitIds(unitIds: string[]): void {
  const seen = new Set<string>();
  for (const id of unitIds) {
    assertValidUnitId(id);
    if (seen.has(id)) {
      throw new Error(`duplicate_unit_id: ${id}`);
    }
    seen.add(id);
  }
}

/**
 * Canonical JSON serialization of a value with sorted object keys and sorted
 * set-like arrays so deterministic hashes can be computed.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** Sort an array of strings canonically (for set-like fields). */
function sortStringArray(arr: string[] | undefined): string[] | undefined {
  if (arr === undefined) return undefined;
  return [...arr].sort();
}

/**
 * SHA-256 fingerprint over the behavior-affecting fields of an AgentConfig.
 * Excludes only descriptive/provenance fields: description, filePath, localName,
 * packageName. Sorts object keys and set-like arrays before hashing.
 */
export function agentFingerprint(agent: AgentConfig): string {
  const behavior: Record<string, unknown> = {
    name: agent.name,
    source: agent.source,
    systemPrompt: agent.systemPrompt,
    systemPromptMode: agent.systemPromptMode ?? 'append',
    runtime: agent.runtime ?? DEFAULT_RUNTIME,
    model: agent.model ?? '',
    thinking: agent.thinking ?? '',
    tools: sortStringArray(agent.tools),
    excludeTools: sortStringArray(agent.excludeTools),
    skills: sortStringArray(agent.skills),
    noSkills: agent.noSkills ?? false,
    noContextFiles: agent.noContextFiles ?? false,
    defaultContext: agent.defaultContext ?? 'fresh',
    isolation: agent.isolation ?? 'none',
    worktreeSetupHook: agent.worktreeSetupHook ?? '',
    completionCheck: sortStringArray(agent.completionCheck),
    maxTurns: agent.maxTurns ?? 0,
    maxSubagentDepth: agent.maxSubagentDepth ?? 0,
  };
  const canon = canonicalJson(behavior);
  return crypto.createHash('sha256').update(canon).digest('hex');
}

/** Resolve the resume capability for a supported runtime. */
export function resumeCapabilityForRuntime(_runtime: Runtime | undefined): ResumeCapability {
  return 'session';
}

/** Aggregate per-unit capabilities into a single run-level capability label. */
export function aggregateCapability(_caps: ResumeCapability[]): AggregateCapability {
  return 'session';
}

/** Build a fresh run-unit record for a queued unit. */
export function createUnitRecord(ctx: UnitExecutionContext, _now: number): RunUnitRecord {
  return {
    unitId: ctx.unitId,
    agent: ctx.agent,
    agentFingerprint: 'fp-' + ctx.unitId, // overwritten by caller with real fingerprint
    runtime: ctx.runtime ?? DEFAULT_RUNTIME,
    capability: ctx.resumeCapability,
    status: 'queued',
    attempt: ctx.attempt,
    attempts: [],
    sessionFile: ctx.sessionFile,
    ...(ctx.acpSessionId !== undefined ? { acpSessionId: ctx.acpSessionId } : {}),
    effectiveCwd: ctx.effectiveCwd,
    worktreePath: ctx.worktreePath,
    ...(ctx.step !== undefined ? { step: ctx.step } : {}),
    ...(ctx.fanoutIndex !== undefined ? { fanoutIndex: ctx.fanoutIndex } : {}),
    ...(ctx.requireArtifactReader ? { requireArtifactReader: true } : {}),
  };
}

function emptyResultForUnit(ctx: UnitExecutionContext): SingleResult {
  return {
    agent: ctx.agent,
    agentSource: 'unknown',
    task: '',
    exitCode: -1,
    status: 'queued',
    messages: [],
    stderr: '',
    usage: emptyUsage(),
    runId: ctx.runId,
    unitId: ctx.unitId,
    attempt: ctx.attempt,
    sessionFile: ctx.sessionFile,
    ...(ctx.acpSessionId !== undefined ? { acpSessionId: ctx.acpSessionId } : {}),
    resumeCapability: ctx.resumeCapability,
  };
}

/**
 * Stamp a running/terminal snapshot with durable identity metadata so every
 * emitted update is traceable back to its run/unit/attempt.
 */
export function stampResultMetadata(result: SingleResult, ctx: UnitExecutionContext): void {
  result.runId = ctx.runId;
  result.unitId = ctx.unitId;
  result.attempt = ctx.attempt;
  result.sessionFile = ctx.sessionFile;
  if (ctx.acpSessionId !== undefined) {
    result.acpSessionId = ctx.acpSessionId;
  }
  result.resumeCapability = ctx.resumeCapability;
  void emptyResultForUnit;
}

/** Derive the run-level status from a snapshot's unit records and details. */
export function deriveRunStatus(
  units: Record<string, RunUnitRecord>,
  details?: SubagentDetails,
  suppressErrorStatus?: boolean
): RunStatus {
  const records = Object.values(units);
  if (records.length === 0) return 'queued';
  const anyActive = records.some((u) => u.status === 'running' || u.status === 'queued');
  if (anyActive) return 'running';
  const anyInterrupted = records.some((u) => u.status === 'interrupted');
  if (anyInterrupted) return 'interrupted';
  const allCompleted = records.every((u) => u.status === 'completed');
  if (allCompleted) return 'completed';
  const anyCancelled = records.some((u) => u.status === 'cancelled' || u.status === 'skipped');
  const anyFailed = records.some((u) => u.status === 'failed');
  void details;
  void suppressErrorStatus;
  if (anyFailed) return 'failed';
  if (anyCancelled) return 'cancelled';
  return 'completed';
}

/** Preserve a terminal attempt summary before incrementing `attempt` on resume. */
export function recordAttempt(
  unit: RunUnitRecord,
  status: ExecutionStatus | 'interrupted',
  startedAt: number,
  now: number,
  extras: { stopReason?: string; errorMessage?: string } = {}
): void {
  const attempt: RunUnitAttempt = {
    attempt: unit.attempt,
    status,
    startedAt,
    finishedAt: now,
    ...(extras.stopReason !== undefined ? { stopReason: extras.stopReason } : {}),
    ...(extras.errorMessage !== undefined ? { errorMessage: extras.errorMessage } : {}),
  };
  unit.attempts.push(attempt);
}

export interface RunCoordinatorOptions {
  store: RunStore;
  now?: () => number;
  /** Flush interval for coalesced run.json writes. */
  coalesceMs?: number;
}

export interface PersistUpdateInput {
  runId: string;
  details: SubagentDetails;
  units: Record<string, RunUnitRecord>;
  /** Mutates the record with extra fields (status, startedAt, etc.) before persist. */
  mutate?: (record: AgentRunRecordV1) => void;
  /** Immediacy hint: terminal/unit-start transitions flush immediately. */
  flushNow?: boolean;
}

/** Input for atomic fanout expansion: ordered post-maxItems items plus agent identity. */
export interface FanoutExpansionInput {
  /** One-based chain step number. */
  step: number;
  /** Ordered items that will actually be scheduled (already truncated by maxItems). */
  items: unknown[];
  agent: AgentConfig;
  runtime: Runtime | undefined;
  effectiveCwd: string;
}

/**
 * Active-run coordinator. Owns the in-memory registry of live runs so multiple
 * tool calls (or background workers) can persist through a single shared store
 * without colliding on per-run write queues.
 */
export interface RunCoordinator {
  /** Register a new run with its initial unit records. */
  registerRun(runId: string, record: AgentRunRecordV1): void;
  /**
   * Atomically persist a fanout expansion mapping and all queued child unit
   * records. Resolves only after the store write succeeds. Identical retries
   * are idempotent; conflicting expansions throw `fanout_state_conflict`.
   */
  expandFanout(runId: string, input: FanoutExpansionInput): Promise<WorkflowFanoutState>;
  /**
   * Mark a unit as started for the current attempt. Awaits unit_started event +
   * durable attempt write so stamp/register cannot run before attempted state is
   * recoverable after a crash.
   */
  startUnit(runId: string, ctx: UnitExecutionContext, result?: SingleResult): Promise<void>;
  /**
   * Mark a unit's terminal state for its current attempt. Externalizes oversized
   * authority, strictly persists run.json + unit_terminal, then returns the
   * committed artifact-aware snapshot.
   */
  finishUnit(
    runId: string,
    ctx: UnitExecutionContext,
    result: SingleResult,
    finalStatus: ExecutionStatus | 'interrupted'
  ): Promise<SingleResult>;
  /** Persist `details` and `units` snapshots (coalesced except for flushNow). */
  persist(input: PersistUpdateInput): void;
  /**
   * Strictly persist the terminal `run.json` clone and return its committed
   * terminal status. Does NOT append `run_terminal`, unregister the run,
   * release/abandon a claim, or fall back to coalesced/best-effort writes.
   * The shared barrier in `run-persistence.ts` owns those follow-up steps.
   */
  finalizeRun(
    runId: string,
    details: SubagentDetails,
    units: Record<string, RunUnitRecord>,
    options: { success?: boolean; cancelled?: boolean; interrupted?: boolean; lastError?: string }
  ): Promise<RunStatus>;
  /** Drop an in-memory run registration. */
  unregisterRun(runId: string): void;
  /** Is this run registered as active right now? */
  isActive(runId: string): boolean;
  /** Compute aggregate capability summary for `details.run`. */
  aggregateRun(
    details: SubagentDetails,
    units: Record<string, RunUnitRecord>
  ): {
    runId: string;
    status: RunStatus;
    resumable: boolean;
    capability: AggregateCapability;
  };
  /**
   * Idempotently write one interactive binding onto a unit and flush the run
   * snapshot. Callers must await success before appending the host-session link.
   */
  persistInteractiveBinding(input: {
    runId: string;
    unitId: string;
    binding: InteractiveAgentBindingV1;
  }): Promise<void>;
  /**
   * Strict awaited write of a Grok ACP protocol session ID. Disk-first on the
   * shared durable queue; does not cancel pending coalesced timers so ordinary
   * live updates still flush afterward. Same-ID is idempotent; rejects a
   * conflicting existing ID.
   */
  persistAcpSessionId(input: { runId: string; unitId: string; sessionId: string }): Promise<void>;
  /**
   * Strict awaited first-write of a Pi unit sessionFile. Disk-first CAS on the
   * shared durable queue; does not cancel pending coalesced timers. Same path is
   * idempotent; a different existing path throws `session_file_conflict`. Full
   * merge never accepts a live-only sessionFile when disk has none — this is the
   * only legal establishment path for a first session path.
   */
  persistSessionFile(input: { runId: string; unitId: string; sessionFile: string }): Promise<void>;
  /**
   * Strict awaited mark that Pi accepted the unit's original prompt.
   * Disk-first; write failure must fail-close the current execution.
   */
  persistSessionPromptEstablished(input: { runId: string; unitId: string }): Promise<void>;
  /**
   * Strict awaited write of continuation delivery progress for a unit.
   * Does not cancel pending coalesced timers. Used by Grok ACP after the matching
   * prompt response (never from dispatch accept).
   */
  persistContinuationDelivery(input: {
    runId: string;
    unitId: string;
    deliveredCount: number;
    continuationTasks?: string[];
  }): Promise<void>;
}

export function createRunCoordinator(options: RunCoordinatorOptions): RunCoordinator {
  const store = options.store;
  const now = options.now ?? (() => Date.now());
  const coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;

  const active = new Map<string, AgentRunRecordV1>();
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastPersist = new Map<string, number>();
  /**
   * Per-run serial queue for all durable writes (strict field updates, live
   * commit, coalesced/full flush). Prevents a full snapshot flush from running
   * between a strict disk write and its live mirror and wiping bindings/session.
   *
   * Effect mapping (Phase 5):
   * - Task body: Effect.tryPromise + runEffectExit
   * - Awaiter rejection: typed failure rethrown as-is (Error or plain {code,message})
   *   so store/coordinator callers keep instanceof / toMatchObject semantics
   * - Tail chain: Promise-based continue-after-failure
   *   (`prev.then(run, run)` — one rejected write must not wedge the run)
   * - Map entry stores a swallowed promise so unhandled rejections never wedge
   */
  const durableWriteTails = new Map<string, Promise<unknown>>();

  function enqueueDurableWrite<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const prev = durableWriteTails.get(runId) ?? Promise.resolve();
    const runTask = async (): Promise<T> => {
      const exit = await runEffectExit(
        Effect.tryPromise({
          try: work,
          catch: (cause) => cause,
        })
      );
      if (Exit.isSuccess(exit)) {
        return exit.value;
      }
      const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
      if (failure !== undefined) {
        // Preserve non-Error rejections (e.g. run_store plain { code, message }).
        throw failure;
      }
      for (const defect of Cause.defects(exit.cause)) {
        throw defect;
      }
      throw new Error(Cause.pretty(exit.cause));
    };
    // Continue after previous success or failure so one rejected write cannot wedge the run.
    const next = prev.then(runTask, runTask);
    durableWriteTails.set(
      runId,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }

  function registerRun(runId: string, record: AgentRunRecordV1): void {
    active.set(runId, record);
  }

  function unregisterRun(runId: string): void {
    active.delete(runId);
    const timer = pendingTimers.get(runId);
    if (timer !== undefined) {
      clearTimeout(timer);
      pendingTimers.delete(runId);
    }
    lastPersist.delete(runId);
    // Keep durableWriteTails so late non-active persist/finalize stay serial
    // with any in-flight queue work after the run leaves the active map.
  }

  function isActive(runId: string): boolean {
    return active.has(runId);
  }

  /**
   * Disk-first append-only/prefix merge for continuationTasks.
   * When either side is a prefix of the other, take the longer list without
   * rewriting existing items. Incompatible content keeps disk and sets
   * `compatible: false` so callers ignore live continuationDelivery.
   */
  function mergeContinuationTasks(
    disk: string[] | undefined,
    live: string[] | undefined
  ): { tasks: string[] | undefined; compatible: boolean } {
    if (live === undefined) return { tasks: disk, compatible: true };
    if (disk === undefined) return { tasks: live, compatible: true };
    const diskIsPrefix = disk.every((t, i) => live[i] === t);
    const liveIsPrefix = live.every((t, i) => disk[i] === t);
    if (diskIsPrefix) {
      return { tasks: live.length >= disk.length ? live : disk, compatible: true };
    }
    if (liveIsPrefix) return { tasks: disk, compatible: true };
    // Incompatible content: disk wins (strict conflict — do not apply live).
    return { tasks: disk, compatible: false };
  }

  /**
   * Full persist/finalize workflowState merge: disk is sole authority.
   * Live must never introduce fanout keys; only `expandFanout` may add mapping.
   */
  function mergeWorkflowState(
    disk: AgentRunRecordV1['workflowState'],
    _live: AgentRunRecordV1['workflowState']
  ): AgentRunRecordV1['workflowState'] {
    return disk;
  }

  /** Unit ids that are children of any committed disk fanout expansion. */
  function diskFanoutChildIds(record: AgentRunRecordV1): Set<string> {
    const ids = new Set<string>();
    for (const expansion of Object.values(record.workflowState?.fanouts ?? {})) {
      for (const id of expansion.unitIds) ids.add(id);
    }
    return ids;
  }

  /**
   * Mirror disk-authoritative slices (fanout mapping/child identity, unit
   * identity, nested result identity, continuation) back onto live after a
   * merge so stale live cannot re-pollute later flushes.
   * ACP/session/capability/attempt use precise set-or-delete from the
   * post-merge record (never leave a live-only stale identity field).
   */
  function mirrorAuthoritativeToLive(record: AgentRunRecordV1, live: AgentRunRecordV1): void {
    if (live === record) return;
    live.workflowState = record.workflowState
      ? {
          fanouts: Object.fromEntries(
            Object.entries(record.workflowState.fanouts).map(([k, v]) => [
              k,
              { step: v.step, items: (v.items ?? []).slice(), unitIds: v.unitIds.slice() },
            ])
          ),
        }
      : undefined;
    const fanoutChildren = diskFanoutChildIds(record);
    for (const [id, diskUnit] of Object.entries(record.units)) {
      const liveUnit = live.units[id];
      if (!liveUnit) {
        // Only materialize missing fanout children that exist on disk.
        if (fanoutChildren.has(id)) {
          live.units[id] = {
            ...diskUnit,
            unitId: id,
            attempts: diskUnit.attempts.map((a) => ({ ...a })),
          };
        }
        continue;
      }
      // Immutable identity + canonical session/capability/attempt from post-merge.
      liveUnit.unitId = id;
      liveUnit.agent = diskUnit.agent;
      liveUnit.agentFingerprint = diskUnit.agentFingerprint;
      liveUnit.runtime = diskUnit.runtime;
      liveUnit.step = diskUnit.step;
      liveUnit.fanoutIndex = diskUnit.fanoutIndex;
      liveUnit.effectiveCwd = diskUnit.effectiveCwd;
      liveUnit.attempt = diskUnit.attempt;
      liveUnit.capability = diskUnit.capability;
      if (diskUnit.acpSessionId !== undefined && diskUnit.acpSessionId !== '') {
        liveUnit.acpSessionId = diskUnit.acpSessionId;
      } else {
        delete liveUnit.acpSessionId;
      }
      // sessionFile: exact set/delete from disk for every runtime.
      if (diskUnit.sessionFile !== undefined) {
        liveUnit.sessionFile = diskUnit.sessionFile;
      } else {
        delete liveUnit.sessionFile;
      }
      // sessionPromptEstablished: exact set/delete from disk.
      if (diskUnit.sessionPromptEstablished !== undefined) {
        liveUnit.sessionPromptEstablished = diskUnit.sessionPromptEstablished;
      } else {
        delete liveUnit.sessionPromptEstablished;
      }
      // requireArtifactReader: monotonic OR (disk true or live true yields true).
      if (diskUnit.requireArtifactReader || liveUnit.requireArtifactReader) {
        liveUnit.requireArtifactReader = true;
      } else {
        delete liveUnit.requireArtifactReader;
      }
      if (diskUnit.result) {
        if (!liveUnit.result) {
          liveUnit.result = { ...diskUnit.result };
        } else {
          liveUnit.result.runId = diskUnit.result.runId;
          liveUnit.result.unitId = diskUnit.result.unitId;
          liveUnit.result.attempt = diskUnit.result.attempt;
          liveUnit.result.sessionFile = diskUnit.sessionFile;
          if (diskUnit.sessionFile === undefined) {
            delete liveUnit.result.sessionFile;
          }
          if (diskUnit.acpSessionId !== undefined && diskUnit.acpSessionId !== '') {
            liveUnit.result.acpSessionId = diskUnit.acpSessionId;
          } else {
            delete liveUnit.result.acpSessionId;
          }
          liveUnit.result.resumeCapability = diskUnit.capability;
        }
      }
    }
    // Drop mapped-but-missing children and every live-only unit (full merge
    // never admits new units; only expandFanout may add children).
    for (const id of fanoutChildren) {
      if (!record.units[id]) delete live.units[id];
    }
    for (const id of Object.keys(live.units)) {
      if (!record.units[id]) delete live.units[id];
    }
    live.continuationTasks = record.continuationTasks ? [...record.continuationTasks] : undefined;
    if (record.continuationDelivery) {
      live.continuationDelivery = Object.fromEntries(
        Object.entries(record.continuationDelivery).map(([uid, d]) => [
          uid,
          { deliveredCount: d.deliveredCount },
        ])
      );
    } else {
      live.continuationDelivery = undefined;
    }
  }

  /**
   * Merge live snapshot into the latest disk record without wiping durable
   * field-level writes (bindings, acpSessionId, continuation delivery, fanout
   * mapping/child identity) that may still be authoritative on disk if live
   * lagged — defensive under the shared serial queue.
   *
   * Strict fields already present on disk win on conflict; live must never
   * downgrade them. Nested result identity is re-stamped from the canonical
   * unit/record after ordinary terminal/output field merge.
   */
  function mergeLiveIntoRecord(record: AgentRunRecordV1, live: AgentRunRecordV1): void {
    // Ordinary run status/details may advance from live.
    record.status = live.status;
    record.details = live.details;

    // Fanout mapping: disk is sole authority (never add keys from live).
    const diskFanoutsBefore = record.workflowState;
    record.workflowState = mergeWorkflowState(diskFanoutsBefore, live.workflowState);

    const mergedUnits: Record<string, RunUnitRecord> = {};
    const unitIds = new Set([...Object.keys(live.units), ...Object.keys(record.units)]);
    for (const id of unitIds) {
      const liveUnit = live.units[id];
      const diskUnit = record.units[id];
      if (liveUnit) {
        // Full merge never admits new units. Only expandFanout may add children
        // (including units that happen to use a canonical fanout id without a mapping).
        if (!diskUnit) {
          continue;
        }
        const unit: RunUnitRecord = { ...liveUnit };
        // Immutable unit identity is disk/canonical-map-key authoritative.
        unit.unitId = id;
        unit.agent = diskUnit.agent;
        unit.agentFingerprint = diskUnit.agentFingerprint;
        unit.runtime = diskUnit.runtime;
        unit.step = diskUnit.step;
        unit.fanoutIndex = diskUnit.fanoutIndex;
        unit.effectiveCwd = diskUnit.effectiveCwd;
        // Attempt + capability: disk is sole authority on full persist/finalize.
        unit.attempt = diskUnit.attempt;
        unit.capability = diskUnit.capability;
        // ACP id: exact set/delete from disk — never write back a live-only stale id.
        if (diskUnit.acpSessionId !== undefined && diskUnit.acpSessionId !== '') {
          unit.acpSessionId = diskUnit.acpSessionId;
        } else {
          delete unit.acpSessionId;
        }
        // sessionFile: exact set/delete from disk for every runtime. Live must
        // never introduce a first path via full merge — use persistSessionFile.
        if (diskUnit.sessionFile !== undefined) {
          unit.sessionFile = diskUnit.sessionFile;
        } else {
          delete unit.sessionFile;
        }
        // sessionPromptEstablished: disk is sole authority (strict write only).
        if (diskUnit.sessionPromptEstablished !== undefined) {
          unit.sessionPromptEstablished = diskUnit.sessionPromptEstablished;
        } else {
          delete unit.sessionPromptEstablished;
        }
        // requireArtifactReader: monotonic OR (disk true or live true yields true).
        if (diskUnit.requireArtifactReader || liveUnit.requireArtifactReader) {
          unit.requireArtifactReader = true;
        } else {
          delete unit.requireArtifactReader;
        }
        // interactiveBindings: disk entries win on id conflict; live may only add.
        if (diskUnit.interactiveBindings || liveUnit.interactiveBindings) {
          const merged: NonNullable<RunUnitRecord['interactiveBindings']> = {
            ...(diskUnit.interactiveBindings ?? {}),
          };
          for (const [bid, b] of Object.entries(liveUnit.interactiveBindings ?? {})) {
            const existing = merged[bid];
            if (existing) {
              // Conflict: keep disk; live must not overwrite a different binding.
              if (
                existing.bindingId !== b.bindingId ||
                existing.hostSessionId !== b.hostSessionId ||
                existing.createdAt !== b.createdAt
              ) {
                continue;
              }
            } else {
              merged[bid] = b;
            }
          }
          unit.interactiveBindings = merged;
        }
        // Result: live missing keeps disk; both present field-merge ordinary
        // terminal/output fields, then re-stamp durable identity from unit/record.
        if (!liveUnit.result) {
          if (diskUnit.result) unit.result = diskUnit.result;
        } else if (diskUnit.result) {
          unit.result = { ...diskUnit.result, ...liveUnit.result };
        } else {
          unit.result = liveUnit.result;
        }
        // Re-stamp durable identity from the canonical unit/map key so stale live
        // cannot overwrite runId/unitId/attempt/sessionFile/acpSessionId/capability.
        if (unit.result) {
          const nextResult = { ...unit.result };
          nextResult.runId = record.runId;
          nextResult.unitId = id;
          nextResult.attempt = unit.attempt;
          if (unit.sessionFile !== undefined) {
            nextResult.sessionFile = unit.sessionFile;
          } else {
            delete nextResult.sessionFile;
          }
          // Canonical unit session id is authoritative: set or clear unconditionally.
          if (unit.acpSessionId !== undefined && unit.acpSessionId !== '') {
            nextResult.acpSessionId = unit.acpSessionId;
          } else {
            delete nextResult.acpSessionId;
          }
          // Canonical unit capability is authoritative for nested resumeCapability.
          nextResult.resumeCapability = unit.capability;
          unit.result = nextResult;
        }
        mergedUnits[id] = unit;
      } else if (diskUnit) {
        // Keep disk-only units (do not wipe peers), including fanout children.
        // Never fill a disk mapping target from live when the disk unit is absent.
        mergedUnits[id] = diskUnit;
      }
    }
    record.units = mergedUnits;

    // continuationTasks: disk-first append-only/prefix; take longer compatible list.
    const tasksMerge = mergeContinuationTasks(record.continuationTasks, live.continuationTasks);
    record.continuationTasks = tasksMerge.tasks;
    // continuationDelivery: only merge live when tasks are compatible append-only.
    // Incompatible → ignore live delivery entirely; keep disk tasks+delivery.
    if (!tasksMerge.compatible) {
      const tasksLen = (record.continuationTasks ?? []).length;
      if (record.continuationDelivery) {
        const kept: NonNullable<AgentRunRecordV1['continuationDelivery']> = {};
        for (const [uid, d] of Object.entries(record.continuationDelivery)) {
          if (!mergedUnits[uid]) continue;
          kept[uid] = { deliveredCount: Math.min(d.deliveredCount, tasksLen) };
        }
        record.continuationDelivery = Object.keys(kept).length > 0 ? kept : undefined;
      }
    } else if (live.continuationDelivery || record.continuationDelivery) {
      const tasksLen = (record.continuationTasks ?? []).length;
      const merged: NonNullable<AgentRunRecordV1['continuationDelivery']> = {};
      for (const [uid, d] of Object.entries(record.continuationDelivery ?? {})) {
        if (!mergedUnits[uid]) continue;
        merged[uid] = {
          deliveredCount: Math.min(d.deliveredCount, tasksLen),
        };
      }
      for (const [uid, d] of Object.entries(live.continuationDelivery ?? {})) {
        if (!mergedUnits[uid]) continue;
        const existing = merged[uid]?.deliveredCount ?? 0;
        const next = Math.min(d.deliveredCount, tasksLen);
        if (next >= existing) merged[uid] = { deliveredCount: next };
      }
      record.continuationDelivery = Object.keys(merged).length > 0 ? merged : undefined;
    }
    if (live.finishedAt !== undefined) record.finishedAt = live.finishedAt;
    if (live.lastError !== undefined) record.lastError = live.lastError;
    // startedAt: disk keeps the first value; live may fill only when disk is missing.
    if (record.startedAt === undefined && live.startedAt !== undefined) {
      record.startedAt = live.startedAt;
    }
    record.updatedAt = now();

    // Correct stale live so a later flush cannot re-apply rejected fanout/continuation.
    mirrorAuthoritativeToLive(record, live);
  }

  function writeRun(runId: string): Promise<void> {
    return enqueueDurableWrite(runId, async () => {
      try {
        await store.updateRun(runId, (record) => {
          const live = active.get(runId);
          if (live) {
            mergeLiveIntoRecord(record, live);
          }
        });
      } catch {
        // Persistence failure is reported elsewhere; swallow here to avoid
        // unhandled rejections from coalesced timers.
      }
    });
  }

  function cancelPendingTimer(runId: string): void {
    const timer = pendingTimers.get(runId);
    if (timer !== undefined) {
      clearTimeout(timer);
      pendingTimers.delete(runId);
    }
  }

  function fanoutStateEqual(a: WorkflowFanoutState, b: WorkflowFanoutState): boolean {
    if (a.step !== b.step) return false;
    if (a.unitIds.length !== b.unitIds.length) return false;
    for (let i = 0; i < a.unitIds.length; i++) {
      if (a.unitIds[i] !== b.unitIds[i]) return false;
    }
    const aItems = a.items ?? [];
    const bItems = b.items ?? [];
    if (aItems.length !== bItems.length) return false;
    if (a.itemsRef || b.itemsRef) {
      return (
        !!a.itemsRef &&
        !!b.itemsRef &&
        a.itemsRef.sha256 === b.itemsRef.sha256 &&
        a.itemsRef.mediaType === b.itemsRef.mediaType &&
        a.itemsRef.bytes === b.itemsRef.bytes
      );
    }
    return JSON.stringify(aItems) === JSON.stringify(bItems);
  }

  async function expandFanout(
    runId: string,
    input: FanoutExpansionInput
  ): Promise<WorkflowFanoutState> {
    // Fast pre-check only: all idempotence/conflict/collision decisions re-run
    // inside the durable queue against the latest live + disk records.
    if (!active.has(runId)) {
      throw new Error(`fanout_state_conflict: run ${runId} is not active`);
    }

    const fanoutKey = chainFanoutStepId(input.step);
    const unitIds = input.items.map((_, i) => chainFanoutUnitId(input.step, i));
    // Reject individual fanout items above the inline payload budget using exact
    // persisted JSON bytes (pretty JSON plus LF) so a compact-JSON item cannot
    // exceed the persisted inline budget after spill.
    for (let i = 0; i < input.items.length; i++) {
      const itemBytes = measureJsonArtifactBytes(input.items[i]);
      if (itemBytes > RESULT_INLINE_PAYLOAD_MAX_BYTES) {
        throw new Error(`fanout_item_too_large: item ${i} is ${itemBytes} bytes (max 256 KiB)`);
      }
    }
    // Aggregate list may spill as itemsRef when above the inline budget (exact
    // pretty-JSON-plus-LF bytes).
    let expansion: WorkflowFanoutState = {
      step: input.step,
      items: input.items,
      unitIds,
    };
    const aggregateBytes = measureJsonArtifactBytes(input.items);
    if (
      aggregateBytes > RESULT_INLINE_PAYLOAD_MAX_BYTES &&
      typeof store.writeJsonArtifact === 'function'
    ) {
      const itemsRef = await store.writeJsonArtifact(runId, 'fanout-items', input.items);
      expansion = { step: input.step, itemsRef, unitIds };
    }
    const fingerprint = agentFingerprint(input.agent);
    const expectedRuntime = input.runtime ?? DEFAULT_RUNTIME;

    /**
     * Compare full worker identity (agent/fingerprint/runtime/cwd + child mapping).
     * Mapping-only equality is not enough: a different agent/cwd must conflict.
     */
    const childIdentityMatches = (unit: RunUnitRecord, fanoutIndex: number): boolean => {
      return (
        unit.step === input.step &&
        unit.fanoutIndex === fanoutIndex &&
        unit.agent === input.agent.name &&
        unit.agentFingerprint === fingerprint &&
        (unit.runtime ?? DEFAULT_RUNTIME) === expectedRuntime &&
        unit.effectiveCwd === input.effectiveCwd
      );
    };

    /**
     * Re-check idempotence / conflict / child collision on the latest record
     * (live and disk, both inside the durable queue). Any mutation is refused
     * when a different expansion or worker identity already committed.
     */
    const evaluateExpansion = (
      record: AgentRunRecordV1
    ):
      | { kind: 'idempotent'; existing: WorkflowFanoutState }
      | { kind: 'conflict'; message: string }
      | { kind: 'expand' } => {
      const existing = record.workflowState?.fanouts?.[fanoutKey];
      if (existing) {
        if (!fanoutStateEqual(existing, expansion)) {
          return {
            kind: 'conflict',
            message: `fanout_state_conflict: step ${input.step} already expanded with different items`,
          };
        }
        for (let i = 0; i < unitIds.length; i++) {
          const id = unitIds[i]!;
          const unit = record.units[id];
          if (!unit || !childIdentityMatches(unit, i)) {
            return {
              kind: 'conflict',
              message: `fanout_state_conflict: step ${input.step} unit identity mismatch for ${id}`,
            };
          }
        }
        return { kind: 'idempotent', existing };
      }
      for (const id of unitIds) {
        if (record.units[id] !== undefined) {
          return {
            kind: 'conflict',
            message: `fanout_state_conflict: unit ${id} already exists`,
          };
        }
      }
      return { kind: 'expand' };
    };

    // Strict awaited write on the shared durable queue so concurrent expand
    // calls and full snapshot flushes cannot interleave between decision and
    // disk+live commit. Do not cancel pending coalesced timers — the durable
    // queue serializes them after this write so ordinary live updates still land.
    // All final idempotent/conflict/collision decisions use durable disk via
    // updateRun; live is only mirrored after success. Stale live conflict must
    // never fail the call before reading latest disk.
    return enqueueDurableWrite(runId, async () => {
      const live = active.get(runId);
      if (!live) {
        throw new Error(`fanout_state_conflict: run ${runId} is not active`);
      }

      const cloneUnit = (u: RunUnitRecord): RunUnitRecord => ({
        ...u,
        attempts: u.attempts.map((a) => ({ ...a })),
      });

      /**
       * Capture this step's disk-authoritative mapping + existing children so a
       * conflict path can precisely repair live (including "no mapping" cases).
       * Attempt unit ids present on disk (collision) are captured even without a mapping.
       */
      const captureStepAuthority = (
        diskRecord: AgentRunRecordV1
      ): {
        expansion: WorkflowFanoutState | undefined;
        units: Record<string, RunUnitRecord>;
      } => {
        const existing = diskRecord.workflowState?.fanouts?.[fanoutKey];
        const units: Record<string, RunUnitRecord> = {};
        if (existing) {
          for (const id of existing.unitIds) {
            const u = diskRecord.units[id];
            if (u) units[id] = cloneUnit(u);
          }
        }
        // Collision / pre-existing units that share attempt ids must be restored.
        for (const id of unitIds) {
          if (!units[id] && diskRecord.units[id]) {
            units[id] = cloneUnit(diskRecord.units[id]!);
          }
        }
        return {
          expansion: existing
            ? {
                step: existing.step,
                items: (existing.items ?? []).slice(),
                unitIds: existing.unitIds.slice(),
              }
            : undefined,
          units,
        };
      };

      /**
       * Fanout/canonical identity match between live and disk child units.
       * When matched, preserve timer-unflushed mutable payload on live.
       */
      const fanoutChildIdentityMatches = (a: RunUnitRecord, b: RunUnitRecord): boolean => {
        return (
          a.agent === b.agent &&
          a.agentFingerprint === b.agentFingerprint &&
          (a.runtime ?? DEFAULT_RUNTIME) === (b.runtime ?? DEFAULT_RUNTIME) &&
          a.effectiveCwd === b.effectiveCwd &&
          a.step === b.step &&
          a.fanoutIndex === b.fanoutIndex
        );
      };

      /**
       * Stamp disk canonical/strict/fanout identity onto an existing live child
       * without replacing ordinary mutable status/result/messages/attempts.
       */
      const applyDiskIdentityToLiveChild = (
        liveUnit: RunUnitRecord,
        diskUnit: RunUnitRecord,
        id: string
      ): void => {
        liveUnit.unitId = id;
        liveUnit.agent = diskUnit.agent;
        liveUnit.agentFingerprint = diskUnit.agentFingerprint;
        liveUnit.runtime = diskUnit.runtime;
        liveUnit.step = diskUnit.step;
        liveUnit.fanoutIndex = diskUnit.fanoutIndex;
        liveUnit.effectiveCwd = diskUnit.effectiveCwd;
        liveUnit.attempt = diskUnit.attempt;
        liveUnit.capability = diskUnit.capability;
        if (diskUnit.sessionFile !== undefined) {
          liveUnit.sessionFile = diskUnit.sessionFile;
        } else {
          delete liveUnit.sessionFile;
        }
        if (diskUnit.acpSessionId !== undefined && diskUnit.acpSessionId !== '') {
          liveUnit.acpSessionId = diskUnit.acpSessionId;
        } else {
          delete liveUnit.acpSessionId;
        }
        if (diskUnit.sessionPromptEstablished !== undefined) {
          liveUnit.sessionPromptEstablished = diskUnit.sessionPromptEstablished;
        } else {
          delete liveUnit.sessionPromptEstablished;
        }
        if (liveUnit.result) {
          liveUnit.result.runId = live.runId;
          liveUnit.result.unitId = id;
          liveUnit.result.attempt = liveUnit.attempt;
          if (liveUnit.sessionFile !== undefined) {
            liveUnit.result.sessionFile = liveUnit.sessionFile;
          } else {
            delete liveUnit.result.sessionFile;
          }
          if (liveUnit.acpSessionId !== undefined && liveUnit.acpSessionId !== '') {
            liveUnit.result.acpSessionId = liveUnit.acpSessionId;
          } else {
            delete liveUnit.result.acpSessionId;
          }
          liveUnit.result.resumeCapability = liveUnit.capability;
        }
      };

      /**
       * Precise step mirror: restore disk mapping/children; delete live-only
       * mapping for this step and this attempt's live-only children. Never fill
       * a disk mapping target from live when the disk unit is absent.
       * Identity-matched live children keep unflushed mutable payload.
       */
      const mirrorStepAuthorityToLive = (captured: {
        expansion: WorkflowFanoutState | undefined;
        units: Record<string, RunUnitRecord>;
      }): WorkflowFanoutState | undefined => {
        if (captured.expansion) {
          if (!live.workflowState) live.workflowState = { fanouts: {} };
          live.workflowState.fanouts[fanoutKey] = {
            step: captured.expansion.step,
            items: (captured.expansion.items ?? []).slice(),
            unitIds: captured.expansion.unitIds.slice(),
          };
        } else if (live.workflowState?.fanouts) {
          delete live.workflowState.fanouts[fanoutKey];
          if (Object.keys(live.workflowState.fanouts).length === 0) {
            live.workflowState = undefined;
          }
        }

        const diskMappedIds = new Set(captured.expansion?.unitIds ?? []);
        // Drop this attempt's live-only children (not present on disk capture).
        for (const id of unitIds) {
          if (!captured.units[id]) delete live.units[id];
        }
        // Drop other live-only fanout children for this step, and mapped-but-missing targets.
        for (const [id, liveUnit] of Object.entries(live.units)) {
          if (captured.units[id]) continue;
          if (diskMappedIds.has(id)) {
            delete live.units[id];
            continue;
          }
          if (liveUnit.step === input.step && liveUnit.fanoutIndex !== undefined) {
            delete live.units[id];
          }
        }

        for (const [id, diskUnit] of Object.entries(captured.units)) {
          const existing = live.units[id];
          if (existing && fanoutChildIdentityMatches(existing, diskUnit)) {
            applyDiskIdentityToLiveChild(existing, diskUnit, id);
          } else {
            live.units[id] = cloneUnit({ ...diskUnit, unitId: id });
          }
        }

        live.updatedAt = now();
        lastPersist.set(runId, now());
        return captured.expansion;
      };

      // Optional fast path: live already matches request → recheck disk only.
      // Stale live (conflict / expand / wrong identity) falls through to disk.
      const liveDecision = evaluateExpansion(live);
      if (liveDecision.kind === 'idempotent') {
        const loaded = store.getRun(runId);
        if (!loaded.ok) {
          throw new Error(
            `fanout_state_conflict: cannot revalidate disk for run ${runId}: ${loaded.error.message}`
          );
        }
        const diskRecord = loaded.loaded.record;
        const diskDecision = evaluateExpansion(diskRecord);
        if (diskDecision.kind === 'conflict') {
          mirrorStepAuthorityToLive(captureStepAuthority(diskRecord));
          throw new Error(diskDecision.message);
        }
        if (diskDecision.kind === 'idempotent') {
          const mirrored = mirrorStepAuthorityToLive(captureStepAuthority(diskRecord));
          return mirrored ?? diskDecision.existing;
        }
        // Disk missing expansion while live has it — fall through to durable write.
      }

      const capability = resumeCapabilityForRuntime(input.runtime);
      const childUnits: Record<string, RunUnitRecord> = {};
      for (let i = 0; i < unitIds.length; i++) {
        const unitId = unitIds[i]!;
        const ctx: UnitExecutionContext = {
          runId,
          unitId,
          agent: input.agent.name,
          runtime: input.runtime,
          resumeCapability: capability,
          effectiveCwd: input.effectiveCwd,
          attempt: 1,
          step: input.step,
          fanoutIndex: i,
        };
        const unit = createUnitRecord(ctx, now());
        unit.agentFingerprint = fingerprint;
        childUnits[unitId] = unit;
      }

      /** When disk is already idempotent, mirror those children onto live — never B's units. */
      let diskMirror:
        | { expansion: WorkflowFanoutState | undefined; units: Record<string, RunUnitRecord> }
        | undefined;
      /** On conflict, mirror latest disk step authority (including no-mapping collision). */
      let conflictMirror:
        | { expansion: WorkflowFanoutState | undefined; units: Record<string, RunUnitRecord> }
        | undefined;

      try {
        await store.updateRun(runId, (record) => {
          // Always decide against the latest disk record before any write.
          const diskDecision = evaluateExpansion(record);
          if (diskDecision.kind === 'idempotent') {
            diskMirror = captureStepAuthority(record);
            return;
          }
          if (diskDecision.kind === 'conflict') {
            conflictMirror = captureStepAuthority(record);
            throw new Error(diskDecision.message);
          }
          for (const [id, unit] of Object.entries(childUnits)) {
            record.units[id] = unit;
          }
          record.workflowState = {
            fanouts: {
              ...(record.workflowState?.fanouts ?? {}),
              [fanoutKey]: expansion,
            },
          };
          record.updatedAt = now();
        });
      } catch (err) {
        // Conflict: precise mirror of disk step authority before rethrow.
        if (conflictMirror) {
          mirrorStepAuthorityToLive(conflictMirror);
        }
        throw err;
      }

      // Disk idempotent path: mirror disk children onto live (do not install B units).
      if (diskMirror) {
        const mirrored = mirrorStepAuthorityToLive(diskMirror);
        return mirrored ?? diskMirror.expansion!;
      }

      // Persist succeeded: ensure live units/workflowState are populated in place.
      for (const [id, unit] of Object.entries(childUnits)) {
        if (live.units[id] !== unit) {
          live.units[id] = unit;
        }
      }
      if (!live.workflowState) {
        live.workflowState = { fanouts: {} };
      }
      live.workflowState.fanouts[fanoutKey] = expansion;
      live.updatedAt = now();
      lastPersist.set(runId, now());

      return expansion;
    });
  }

  function persist(input: PersistUpdateInput): void {
    const runId = input.runId;
    const live = active.get(runId);
    if (live) {
      live.details = input.details;
      // Mutate shared units in place when the caller passes a different object
      // reference that is a superset (or equal) of the live units. Prefer keeping
      // the live alias when the caller reuses live.units.
      if (input.units !== live.units) {
        for (const [id, unit] of Object.entries(input.units)) {
          live.units[id] = unit;
        }
      }
      if (input.mutate) input.mutate(live);
      live.updatedAt = now();
    } else {
      // No active registration: still enter the shared durable queue and apply
      // field-level disk-first merge so a late stale snapshot cannot erase
      // bindings / acpSessionId / continuation delivery written by peers.
      // Deep-clone the full incoming snapshot before mutate so workflowState /
      // request / continuationDelivery / details / units never share disk refs.
      // Mutate then only affects the clone; disk-authoritative merge admits
      // ordinary/allowed fields (e.g. startedAt) only.
      void enqueueDurableWrite(runId, async () => {
        try {
          await store.updateRun(runId, (record) => {
            const incoming = structuredClone({
              ...record,
              details: input.details,
              units: input.units,
            });
            if (input.mutate) input.mutate(incoming);
            mergeLiveIntoRecord(record, incoming);
          });
        } catch {
          /* best-effort */
        }
      });
      return;
    }

    if (input.flushNow) {
      cancelPendingTimer(runId);
      void writeRun(runId).then(() => {
        lastPersist.set(runId, now());
      });
      return;
    }

    // Coalesce: schedule a flush at most once per coalesceMs window.
    const prev = lastPersist.get(runId) ?? 0;
    const elapsed = now() - prev;
    const existing = pendingTimers.has(runId);
    if (existing) return;
    const delay = Math.max(0, coalesceMs - elapsed);
    const timer = setTimeout(() => {
      pendingTimers.delete(runId);
      void writeRun(runId).then(() => {
        lastPersist.set(runId, now());
      });
    }, delay);
    pendingTimers.set(runId, timer);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function ensureLiveRecord(runId: string): AgentRunRecordV1 | undefined {
    return active.get(runId);
  }

  async function startUnit(
    runId: string,
    ctx: UnitExecutionContext,
    result?: SingleResult
  ): Promise<void> {
    if (result) {
      stampResultMetadata(result, ctx);
      result.status = 'running';
    }
    const live = ensureLiveRecord(runId);
    if (!live) return;
    const existingUnit = live.units[ctx.unitId];
    if (!existingUnit) return;

    // Local stage: build the pending started attempt without mutating live.
    const stagedAttempt: RunUnitAttempt = {
      attempt: ctx.attempt,
      status: 'running',
      startedAt: now(),
    };
    const stagedWorktreePath = ctx.worktreePath;
    const stagedRequireReader = ctx.requireArtifactReader;

    const applyStartToDisk = (record: AgentRunRecordV1): void => {
      const diskUnit = record.units[ctx.unitId];
      if (!diskUnit) return;
      // Merge other accumulated live state first, then apply the staged start
      // transition on top so disk-authoritative start fields are never downgraded.
      const liveRec = active.get(runId);
      if (liveRec) mergeLiveIntoRecord(record, liveRec);
      const merged = record.units[ctx.unitId];
      if (merged) {
        merged.status = 'running';
        merged.attempt = ctx.attempt;
        merged.worktreePath = stagedWorktreePath;
        // Reassign attempts so a shallow merge cannot mutate live's array when
        // the strict write later fails and live must remain queued/unchanged.
        merged.attempts = [...(merged.attempts ?? []), { ...stagedAttempt }];
        if (stagedRequireReader) {
          merged.requireArtifactReader = true;
        }
      }
    };

    const mirrorStartToLive = (): void => {
      const liveRec = active.get(runId);
      const liveUnit = liveRec?.units[ctx.unitId];
      if (liveUnit) {
        liveUnit.status = 'running';
        liveUnit.attempt = ctx.attempt;
        liveUnit.worktreePath = stagedWorktreePath;
        liveUnit.attempts.push({ ...stagedAttempt });
        if (stagedRequireReader) {
          liveUnit.requireArtifactReader = true;
        }
      }
    };

    cancelPendingTimer(runId);

    // Disk-first: persist staged start state via strict write on the durable
    // queue. Only after the strict write succeeds do we append the event and
    // mirror the committed state into live. If the strict write fails, no
    // event is emitted, no live started state is exposed, and the error
    // propagates before any spawn/RPC activation.
    await enqueueDurableWrite(runId, async () => {
      await store.updateRunStrict(runId, (record) => {
        applyStartToDisk(record);
      });
      await store.appendEvent(runId, {
        version: 1,
        event: 'unit_started',
        runId,
        timestamp: now(),
        unitId: ctx.unitId,
        attempt: ctx.attempt,
      });
      mirrorStartToLive();
    });
    lastPersist.set(runId, now());
  }

  async function finishUnit(
    runId: string,
    ctx: UnitExecutionContext,
    result: SingleResult,
    finalStatus: ExecutionStatus | 'interrupted'
  ): Promise<SingleResult> {
    // Spill oversized authority before any durable ref is published.
    let externalized: SingleResult;
    let status: ExecutionStatus | 'interrupted' = finalStatus;
    try {
      externalized = await externalizeTerminalResult(result, store, runId);
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code: unknown }).code)
          : 'artifact_write_error';
      const message = err instanceof Error ? err.message : 'artifact externalization failed';
      externalized = snapshotSingleResult({
        ...result,
        status: 'failed',
        exitCode: result.exitCode === 0 ? 1 : result.exitCode,
        errorCode: code,
        errorMessage: message,
        finalOutput: undefined,
        finalOutputRef: undefined,
        structuredOutput: undefined,
        structuredOutputRef: undefined,
      });
      status = 'failed';
    }

    // Private compact shell — never mutate the caller-supplied result object.
    const stored = snapshotSingleResult(externalized);
    stampResultMetadata(stored, ctx);
    stored.status = status;

    const live = ensureLiveRecord(runId);
    if (!live) return stored;

    // Cancel coalesced ordinary flushes so a mid-flight write cannot merge a
    // still-running live unit over the terminal disk commit below.
    cancelPendingTimer(runId);

    // Mutate only this unit on a private clone; never replace the whole units map
    // (concurrent finishUnit for another unit must not be clobbered).
    const unitClone = live.units[ctx.unitId]
      ? (structuredClone(live.units[ctx.unitId]) as RunUnitRecord)
      : undefined;
    if (unitClone) {
      const last = unitClone.attempts[unitClone.attempts.length - 1];
      if (last && last.attempt === ctx.attempt && last.status === 'running') {
        last.status = status;
        last.finishedAt = now();
        if (stored.stopReason !== undefined) last.stopReason = stored.stopReason;
        if (stored.errorMessage !== undefined) last.errorMessage = stored.errorMessage;
      } else {
        recordAttempt(unitClone, status, last?.startedAt ?? now(), now(), {
          stopReason: stored.stopReason,
          errorMessage: stored.errorMessage,
        });
      }
      const unitSession =
        unitClone.sessionFile !== undefined && unitClone.sessionFile.trim() !== ''
          ? unitClone.sessionFile
          : undefined;
      if (unitSession !== undefined) {
        stored.sessionFile = unitSession;
        ctx.sessionFile = unitSession;
      } else {
        delete stored.sessionFile;
        delete ctx.sessionFile;
      }
      const unitAcp =
        unitClone.acpSessionId !== undefined && unitClone.acpSessionId !== ''
          ? unitClone.acpSessionId
          : undefined;
      if (unitAcp !== undefined) {
        stored.acpSessionId = unitAcp;
        ctx.acpSessionId = unitAcp;
      } else {
        delete stored.acpSessionId;
        delete ctx.acpSessionId;
      }
      stored.resumeCapability = unitClone.capability;
      ctx.resumeCapability = unitClone.capability;
      if (stored.worktreePath !== undefined && stored.worktreePath.trim() !== '') {
        unitClone.worktreePath = stored.worktreePath;
        ctx.worktreePath = stored.worktreePath;
      } else {
        delete unitClone.worktreePath;
        delete ctx.worktreePath;
      }
      unitClone.status = status;
      unitClone.result = stored;
    }

    // Strict run.json (target unit only), then unit_terminal event, then mirror into live.
    // Live mutation happens only after disk commit succeeds so rejected authority
    // cannot leak to parent/coalesced paths.
    await store.updateRunStrict(runId, (record) => {
      if (unitClone) {
        record.units[ctx.unitId] = unitClone;
      }
      if (Array.isArray(record.details.results)) {
        const idx = record.details.results.findIndex(
          (r) => r.unitId === ctx.unitId || (r.agent === stored.agent && r.task === stored.task)
        );
        if (idx >= 0) record.details.results[idx] = stored;
        else record.details.results.push(stored);
      }
    });
    try {
      await store.appendEventStrict(runId, {
        version: 1,
        event: 'unit_terminal',
        runId,
        timestamp: now(),
        unitId: ctx.unitId,
        attempt: ctx.attempt,
        status,
      });
    } catch (err) {
      // run.json is authoritative; mirror disk but report durable write failure.
      const disk = store.getRun(runId);
      if (disk.ok) {
        const liveRec = active.get(runId);
        if (liveRec) {
          const diskUnit = disk.loaded.record.units[ctx.unitId];
          if (diskUnit && liveRec.units[ctx.unitId]) {
            liveRec.units[ctx.unitId] = structuredClone(diskUnit);
          }
          liveRec.details = structuredClone(disk.loaded.record.details);
        }
      }
      throw {
        code: 'durable_write_error',
        message: err instanceof Error ? err.message : 'unit_terminal append failed',
        runId,
      };
    }

    // Mirror committed authority into the existing live unit objects in place so
    // DurableRunContext.started.units (same references) observes the terminal state.
    const liveRec = active.get(runId);
    if (liveRec) {
      const liveUnit = liveRec.units[ctx.unitId];
      if (liveUnit && unitClone) {
        liveUnit.status = unitClone.status;
        liveUnit.attempt = unitClone.attempt;
        liveUnit.attempts = unitClone.attempts;
        liveUnit.result = unitClone.result;
        if (unitClone.sessionFile !== undefined) liveUnit.sessionFile = unitClone.sessionFile;
        else delete liveUnit.sessionFile;
        if (unitClone.acpSessionId !== undefined) liveUnit.acpSessionId = unitClone.acpSessionId;
        else delete liveUnit.acpSessionId;
        if (unitClone.worktreePath !== undefined) liveUnit.worktreePath = unitClone.worktreePath;
        else delete liveUnit.worktreePath;
        if (unitClone.sessionPromptEstablished !== undefined) {
          liveUnit.sessionPromptEstablished = unitClone.sessionPromptEstablished;
        }
        if (unitClone.requireArtifactReader) {
          liveUnit.requireArtifactReader = true;
        } else {
          delete liveUnit.requireArtifactReader;
        }
      } else if (unitClone) {
        liveRec.units[ctx.unitId] = unitClone;
      }
      if (Array.isArray(liveRec.details.results)) {
        const idx = liveRec.details.results.findIndex(
          (r) => r.unitId === ctx.unitId || (r.agent === stored.agent && r.task === stored.task)
        );
        if (idx >= 0) liveRec.details.results[idx] = stored;
        else liveRec.details.results.push(stored);
      }
    }
    return stored;
  }

  async function finalizeRun(
    runId: string,
    details: SubagentDetails,
    units: Record<string, RunUnitRecord>,
    options: {
      success?: boolean;
      cancelled?: boolean;
      interrupted?: boolean;
      lastError?: string;
    }
  ): Promise<RunStatus> {
    let status: RunStatus;
    if (options.cancelled) status = 'cancelled';
    else if (options.interrupted) status = 'interrupted';
    else if (options.success === false) status = 'failed';
    else status = deriveRunStatus(units, details);

    const finishedAt = now();
    const lastError = options.lastError;

    // Serialize through the shared durable queue. Do not mutate live terminal
    // fields before the strict disk write succeeds; mirror the committed record
    // onto live only after success. No best-effort/coalesced fallback.
    await enqueueDurableWrite(runId, async () => {
      const live = active.get(runId);
      await store.updateRunStrict(runId, (record) => {
        if (live) {
          mergeLiveIntoRecord(record, {
            ...record,
            details,
            units,
            status,
            finishedAt,
            updatedAt: finishedAt,
            ...(lastError !== undefined ? { lastError } : {}),
          });
        } else {
          // Inactive: deep-clone so merge/mirror cannot share refs with disk.
          const snapshot = structuredClone({ ...record, details, units });
          mergeLiveIntoRecord(record, snapshot);
          record.finishedAt = finishedAt;
          record.updatedAt = finishedAt;
          record.status = status;
          if (lastError !== undefined) record.lastError = lastError;
        }
      });
      // Mirror committed terminal fields to live only after disk success.
      if (live) {
        live.details = details;
        live.units = units;
        live.status = status;
        live.finishedAt = finishedAt;
        live.updatedAt = finishedAt;
        if (lastError !== undefined) live.lastError = lastError;
      }
      lastPersist.set(runId, finishedAt);
    });
    return status;
  }

  function aggregateRun(
    details: SubagentDetails,
    units: Record<string, RunUnitRecord>
  ): {
    runId: string;
    status: RunStatus;
    resumable: boolean;
    capability: AggregateCapability;
  } {
    const runId = details.run?.runId ?? '';
    const status: RunStatus = details.run?.status ?? deriveRunStatus(units, details);
    const caps = Object.values(units).map((u) => u.capability);
    const capability = aggregateCapability(caps);
    const unitList = Object.values(units);
    // Failed/cancelled/interrupted, skipped, and queued units can be selectively
    // resumed once the run is terminal. Queued work is included so a crashed
    // terminal snapshot with never-started siblings reports resumable.
    const hasResumableUnits = unitList.some(
      (u) =>
        u.status === 'interrupted' ||
        u.status === 'failed' ||
        u.status === 'cancelled' ||
        u.status === 'skipped' ||
        u.status === 'queued'
    );
    // Completed runs accept a non-empty continuation task. Active running/queued
    // runs must not claim concurrent resume; only terminal incomplete states are
    // resumable (including terminal snapshots that still carry queued units).
    const resumable =
      status === 'completed'
        ? unitList.length > 0
        : status !== 'running' && status !== 'queued' && hasResumableUnits;
    return { runId, status, resumable, capability };
  }

  /**
   * Idempotently persist one interactive binding on a unit with disk-first
   * strict flush. Must succeed before the host-session link is appended.
   * Field-level merge runs inside RunStore's serial `updateRun` callback on the
   * latest disk record; live state is mutated only after the atomic disk write
   * succeeds. On failure neither live nor disk change, and no coalesced flush
   * may later write a half-applied binding.
   * Existing Version 1 records without `interactiveBindings` remain valid.
   */
  async function persistInteractiveBinding(input: {
    runId: string;
    unitId: string;
    binding: InteractiveAgentBindingV1;
  }): Promise<void> {
    const { runId, unitId, binding } = input;

    /** Field-level merge for one unit only — never replaces `record.units`. */
    const applyBinding = (record: AgentRunRecordV1): void => {
      const unit = record.units[unitId];
      if (!unit) {
        throw new Error(`persistInteractiveBinding: unit ${unitId} not found in run ${runId}`);
      }
      if (!unit.interactiveBindings) unit.interactiveBindings = {};
      const existing = unit.interactiveBindings[binding.bindingId];
      if (existing) {
        if (
          existing.bindingId !== binding.bindingId ||
          existing.hostSessionId !== binding.hostSessionId ||
          existing.createdAt !== binding.createdAt
        ) {
          throw new Error(
            `persistInteractiveBinding: binding ${binding.bindingId} already exists with different data`
          );
        }
        return; // idempotent
      }
      unit.interactiveBindings[binding.bindingId] = {
        bindingId: binding.bindingId,
        hostSessionId: binding.hostSessionId,
        createdAt: binding.createdAt,
      };
      record.updatedAt = now();
    };

    // Shared serial queue: conflict decided only against latest disk inside updateRun.
    // Live is overwrite-synced from the committed binding after success (no re-apply).
    // Pending coalesced timers are left armed so ordinary live updates still flush.
    await enqueueDurableWrite(runId, async () => {
      let committed: InteractiveAgentBindingV1 | undefined;

      await store.updateRun(runId, (record) => {
        applyBinding(record);
        const unit = record.units[unitId];
        const b = unit?.interactiveBindings?.[binding.bindingId];
        if (b) {
          committed = {
            bindingId: b.bindingId,
            hostSessionId: b.hostSessionId,
            createdAt: b.createdAt,
          };
        }
      });

      const live = active.get(runId);
      if (live && committed) {
        const unit = live.units[unitId];
        if (unit) {
          if (!unit.interactiveBindings) unit.interactiveBindings = {};
          unit.interactiveBindings[binding.bindingId] = {
            bindingId: committed.bindingId,
            hostSessionId: committed.hostSessionId,
            createdAt: committed.createdAt,
          };
        }
        live.updatedAt = now();
      }
      lastPersist.set(runId, now());
    });
  }

  /**
   * Persist a Pi unit sessionFile with disk-first CAS. Same path is idempotent;
   * a different existing path throws `session_file_conflict`. Empty paths are
   * rejected. This is the only legal first-write path — full merge never accepts
   * a live-only sessionFile when disk has none.
   *
   * Conflict check runs only inside RunStore's serial `updateRun` on the latest
   * disk record. After commit, live is overwrite-synced. Pending coalesced timers
   * are left armed so ordinary live updates still flush.
   */
  async function persistSessionFile(input: {
    runId: string;
    unitId: string;
    sessionFile: string;
  }): Promise<void> {
    const { runId, unitId } = input;
    const sessionFile = input.sessionFile.trim();
    if (!sessionFile) {
      throw new Error('session_file_unavailable: sessionFile must be a non-empty string');
    }

    const applyUnit = (record: AgentRunRecordV1): void => {
      const unit = record.units[unitId];
      if (!unit) {
        throw new Error(`persistSessionFile: unit ${unitId} not found in run ${runId}`);
      }
      const existing = unit.sessionFile?.trim();
      if (existing) {
        if (existing !== sessionFile) {
          throw new Error(
            `session_file_conflict: unit ${unitId} already has sessionFile ${existing}, refusing ${sessionFile}`
          );
        }
        // Idempotent same path: still restamp nested result if present.
        // Do not regress sessionPromptEstablished on restamp.
      } else {
        unit.sessionFile = sessionFile;
        // First path write: original prompt is not yet established. Resume must
        // fail closed until persistSessionPromptEstablished succeeds.
        if (unit.sessionPromptEstablished !== true) {
          unit.sessionPromptEstablished = false;
        }
      }
      if (unit.result) {
        unit.result.sessionFile = sessionFile;
      }
      record.updatedAt = now();
    };

    await enqueueDurableWrite(runId, async () => {
      let committed: string | undefined;
      let committedEstablished: boolean | undefined;

      await store.updateRun(runId, (record) => {
        applyUnit(record);
        const unit = record.units[unitId];
        if (unit?.sessionFile) {
          committed = unit.sessionFile;
          committedEstablished = unit.sessionPromptEstablished;
        }
      });

      const live = active.get(runId);
      if (live && committed) {
        const liveUnit = live.units[unitId];
        if (liveUnit) {
          liveUnit.sessionFile = committed;
          if (committedEstablished !== undefined) {
            liveUnit.sessionPromptEstablished = committedEstablished;
          }
          if (liveUnit.result) {
            liveUnit.result.sessionFile = committed;
          }
        }
        live.updatedAt = now();
      }
      lastPersist.set(runId, now());
    });
  }

  /**
   * Mark that Pi accepted the unit's original prompt. Idempotent once true.
   * Disk-first; callers must await and fail-close the turn on write error.
   */
  async function persistSessionPromptEstablished(input: {
    runId: string;
    unitId: string;
  }): Promise<void> {
    const { runId, unitId } = input;

    await enqueueDurableWrite(runId, async () => {
      await store.updateRun(runId, (record) => {
        const unit = record.units[unitId];
        if (!unit) {
          throw new Error(
            `persistSessionPromptEstablished: unit ${unitId} not found in run ${runId}`
          );
        }
        unit.sessionPromptEstablished = true;
        record.updatedAt = now();
      });

      const live = active.get(runId);
      if (live) {
        const liveUnit = live.units[unitId];
        if (liveUnit) {
          liveUnit.sessionPromptEstablished = true;
        }
        live.updatedAt = now();
      }
      lastPersist.set(runId, now());
    });
  }

  /**
   * Persist a Grok ACP session ID with disk-first strict flush. Same-ID is
   * idempotent; a different existing ID throws `acp_session_conflict`.
   *
   * Conflict check and field-level unit merge run only inside RunStore's serial
   * `updateRun` callback on the latest disk record — never from a stale live
   * precheck. After disk commit, live is overwrite-synced from the committed
   * unit fields (no re-apply that could throw if live changed mid-write).
   */
  async function persistAcpSessionId(input: {
    runId: string;
    unitId: string;
    sessionId: string;
  }): Promise<void> {
    const { runId, unitId } = input;
    const sessionId = input.sessionId.trim();
    if (!sessionId) {
      throw new Error('acp_session_unavailable: sessionId must be a non-empty string');
    }

    /** Field-level merge for one unit only — never replaces `record.units`. */
    const applyUnit = (record: AgentRunRecordV1): void => {
      const unit = record.units[unitId];
      if (!unit) {
        throw new Error(`persistAcpSessionId: unit ${unitId} not found in run ${runId}`);
      }
      const existing = unit.acpSessionId?.trim();
      if (existing) {
        if (existing !== sessionId) {
          throw new Error(
            `acp_session_conflict: unit ${unitId} already has session ${existing}, refusing ${sessionId}`
          );
        }
        // Idempotent same-ID: leave stored identity unchanged.
      } else {
        unit.acpSessionId = sessionId;
      }

      // Keep nested result identity aligned when present.
      if (unit.result) {
        unit.result.acpSessionId = sessionId;
        unit.result.resumeCapability = unit.capability;
      }

      record.updatedAt = now();
    };

    // Do not cancel pending coalesced timers — ordinary live updates stay scheduled.
    await enqueueDurableWrite(runId, async () => {
      let committed:
        | {
            acpSessionId: string | undefined;
            capability: ResumeCapability;
          }
        | undefined;

      await store.updateRun(runId, (record) => {
        applyUnit(record);
        const unit = record.units[unitId];
        if (unit) {
          committed = {
            acpSessionId: unit.acpSessionId,
            capability: unit.capability,
          };
        }
      });

      // Disk succeeded: overwrite-sync live from committed fields (never re-apply).
      const live = active.get(runId);
      if (live && committed) {
        const liveUnit = live.units[unitId];
        if (liveUnit) {
          liveUnit.acpSessionId = committed.acpSessionId;
          liveUnit.capability = committed.capability;
          if (liveUnit.result) {
            if (committed.acpSessionId !== undefined && committed.acpSessionId !== '') {
              liveUnit.result.acpSessionId = committed.acpSessionId;
            } else {
              delete liveUnit.result.acpSessionId;
            }
            liveUnit.result.resumeCapability = committed.capability;
          }
        }
        live.updatedAt = now();
      }
      lastPersist.set(runId, now());
    });
  }

  /**
   * Strict awaited continuation-delivery write for Grok ACP (disk-first).
   * Marks `deliveredCount` only after the atomic run.json write succeeds.
   * Updates only the target unit's delivery entry inside the serial callback;
   * rejects regression, counts above the continuationTasks upper bound, and
   * refuses continuationTasks lists that change or shorten the durable history.
   * Live is mirrored from the committed disk result (never authoritative alone).
   * Pending coalesced timers are left armed so ordinary live updates still flush.
   */
  async function persistContinuationDelivery(input: {
    runId: string;
    unitId: string;
    deliveredCount: number;
    continuationTasks?: string[];
  }): Promise<void> {
    const { runId, unitId, deliveredCount } = input;
    if (!Number.isInteger(deliveredCount) || deliveredCount < 0) {
      throw new Error('persistContinuationDelivery: deliveredCount must be a non-negative integer');
    }

    /**
     * Field-level delivery update for one unit only (disk-authoritative).
     * When `continuationTasks` is supplied, it must be append-only relative to
     * the record's existing list (existing is a prefix; no item rewrite/shorten).
     */
    const applyDelivery = (record: AgentRunRecordV1): void => {
      if (!record.units[unitId]) {
        throw new Error(
          `persistContinuationDelivery: unit ${unitId} does not exist on run ${runId}`
        );
      }
      if (input.continuationTasks !== undefined) {
        const existingTasks = record.continuationTasks ?? [];
        const nextTasks = input.continuationTasks;
        const existingIsPrefix = existingTasks.every((t, i) => nextTasks[i] === t);
        if (!existingIsPrefix) {
          throw new Error(
            `persistContinuationDelivery: continuationTasks would change or regress durable history on run ${runId}`
          );
        }
        record.continuationTasks = nextTasks;
      }
      const tasks = record.continuationTasks ?? [];
      if (deliveredCount > tasks.length) {
        throw new Error(
          `persistContinuationDelivery: deliveredCount ${deliveredCount} exceeds continuationTasks length ${tasks.length}`
        );
      }
      const existing = record.continuationDelivery?.[unitId]?.deliveredCount ?? 0;
      if (deliveredCount < existing) {
        throw new Error(
          `persistContinuationDelivery: deliveredCount ${deliveredCount} would regress from ${existing} for unit ${unitId}`
        );
      }
      if (!record.continuationDelivery) record.continuationDelivery = {};
      record.continuationDelivery[unitId] = { deliveredCount };
      record.updatedAt = now();
    };

    await enqueueDurableWrite(runId, async () => {
      // Monotonic / upper-bound / task checks run only against latest disk inside
      // updateRun — never reject early from a wrongly-ahead live count.
      let committedTasks: string[] | undefined;
      let committedCount: number | undefined;
      let sawDelivery = false;

      await store.updateRun(runId, (record) => {
        applyDelivery(record);
        committedTasks = record.continuationTasks ? [...record.continuationTasks] : undefined;
        const entry = record.continuationDelivery?.[unitId];
        if (entry) {
          sawDelivery = true;
          committedCount = entry.deliveredCount;
        } else {
          sawDelivery = false;
          committedCount = undefined;
        }
      });

      // Unconditionally mirror committed tasks/count onto live (undefined clears stale).
      const live = active.get(runId);
      if (live) {
        live.continuationTasks = committedTasks !== undefined ? [...committedTasks] : undefined;
        if (sawDelivery && committedCount !== undefined) {
          if (!live.continuationDelivery) live.continuationDelivery = {};
          live.continuationDelivery[unitId] = { deliveredCount: committedCount };
        } else if (live.continuationDelivery) {
          delete live.continuationDelivery[unitId];
          if (Object.keys(live.continuationDelivery).length === 0) {
            live.continuationDelivery = undefined;
          }
        }
        live.updatedAt = now();
      }
      lastPersist.set(runId, now());
    });
  }

  return {
    registerRun,
    expandFanout,
    startUnit,
    finishUnit,
    persist,
    finalizeRun,
    unregisterRun,
    isActive,
    aggregateRun,
    persistInteractiveBinding,
    persistAcpSessionId,
    persistSessionFile,
    persistSessionPromptEstablished,
    persistContinuationDelivery,
  };
}

/**
 * Build the SSE-style persistent update by attaching the coordinator to an
 * existing tool `onUpdate` callback. The user-facing update is forwarded
 * immediately; the durable write is coalesced.
 */
export function wrapOnUpdateForPersistence(
  runId: string,
  coordinator: RunCoordinator,
  details: () => SubagentDetails,
  units: () => Record<string, RunUnitRecord>,
  upstream:
    | ((
        partial: import('@earendil-works/pi-coding-agent').AgentToolUpdateCallback<SubagentDetails>
      ) => void)
    | undefined
): (
  partial: import('@earendil-works/pi-coding-agent').AgentToolUpdateCallback<SubagentDetails>
) => void {
  return (partial) => {
    // Forward to the TUI/renderer first.
    if (upstream) upstream(partial);
    // Coalesce durable persistence from the latest details snapshot.
    const d = details();
    const u = units();
    if (d && u) {
      coordinator.persist({ runId, details: d, units: u });
    }
  };
}
