// ABOUTME: Run coordinator — stable unit IDs, agent fingerprints, persistence throttling, status derivation.
// ABOUTME: Wraps existing workflow callbacks to persist durable snapshots without disrupting TUI streaming.

import * as crypto from 'node:crypto';
import type { AgentConfig, Runtime } from './agents.ts';
import { DEFAULT_RUNTIME, GROK_ACP_RUNTIME, GROK_RUNTIME } from './constants.ts';
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
import type { ExecutionStatus, SingleResult, SubagentDetails } from './types.ts';
import { emptyUsage } from './types.ts';

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
  worktreePath?: string;
  /** Directory for native Pi session files (<runDir>/sessions). Undefined when persistence is inactive. */
  sessionsDir?: string;
  /** 1-based attempt number; the coordinator increments it on resume. */
  attempt: number;
  /** One-based chain step number; immutable once the unit is created. */
  step?: number;
  /** Zero-based fanout item index within a chain fanout step. */
  fanoutIndex?: number;
}

/** Aggregate resume capability across a run's units. */
export type AggregateCapability = 'session' | 'replay' | 'mixed';

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

/** Resolve the resume capability for a runtime. */
export function resumeCapabilityForRuntime(runtime: Runtime | undefined): ResumeCapability {
  return runtime === GROK_RUNTIME || runtime === GROK_ACP_RUNTIME ? 'replay' : 'session';
}

/** Aggregate per-unit capabilities into a single run-level capability label. */
export function aggregateCapability(caps: ResumeCapability[]): AggregateCapability {
  if (caps.length === 0) return 'session';
  const anySession = caps.some((c) => c === 'session');
  const anyReplay = caps.some((c) => c === 'replay');
  if (anySession && anyReplay) return 'mixed';
  return anyReplay ? 'replay' : 'session';
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
    effectiveCwd: ctx.effectiveCwd,
    worktreePath: ctx.worktreePath,
    ...(ctx.step !== undefined ? { step: ctx.step } : {}),
    ...(ctx.fanoutIndex !== undefined ? { fanoutIndex: ctx.fanoutIndex } : {}),
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
  /** Mark a unit as started for the current attempt. Marks empty results + flushes. */
  startUnit(runId: string, ctx: UnitExecutionContext, result?: SingleResult): void;
  /** Mark a unit's terminal state for its current attempt. Preserves attempt history. */
  finishUnit(
    runId: string,
    ctx: UnitExecutionContext,
    result: SingleResult,
    finalStatus: ExecutionStatus | 'interrupted'
  ): void;
  /** Persist `details` and `units` snapshots (coalesced except for flushNow). */
  persist(input: PersistUpdateInput): void;
  /** Finalize a run: derive terminal status, flush, and publish the owner claim release. */
  finalizeRun(
    runId: string,
    details: SubagentDetails,
    units: Record<string, RunUnitRecord>,
    options: { success?: boolean; cancelled?: boolean; interrupted?: boolean; lastError?: string }
  ): Promise<void>;
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
}

export function createRunCoordinator(options: RunCoordinatorOptions): RunCoordinator {
  const store = options.store;
  const now = options.now ?? (() => Date.now());
  const coalesceMs = options.coalesceMs ?? 250;

  const active = new Map<string, AgentRunRecordV1>();
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastPersist = new Map<string, number>();

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
  }

  function isActive(runId: string): boolean {
    return active.has(runId);
  }

  function writeRun(runId: string): Promise<void> {
    return store
      .updateRun(runId, (record) => {
        const live = active.get(runId);
        if (live) {
          // Copy authoritative in-memory fields back over the durable record.
          record.status = live.status;
          record.details = live.details;
          record.units = live.units;
          // Preserve expansion mappings written by expandFanout.
          if (live.workflowState !== undefined) {
            record.workflowState = live.workflowState;
          }
          // Preserve continuation delivery progress written during resume.
          if (live.continuationTasks !== undefined) {
            record.continuationTasks = live.continuationTasks;
          }
          if (live.continuationDelivery !== undefined) {
            record.continuationDelivery = live.continuationDelivery;
          }
          record.updatedAt = now();
        }
      })
      .then(
        () => undefined,
        () => {
          // Persistence failure is reported elsewhere; swallow here to avoid
          // unhandled rejections from coalesced timers.
        }
      );
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
    if (a.items.length !== b.items.length) return false;
    return JSON.stringify(a.items) === JSON.stringify(b.items);
  }

  async function expandFanout(
    runId: string,
    input: FanoutExpansionInput
  ): Promise<WorkflowFanoutState> {
    const live = active.get(runId);
    if (!live) {
      throw new Error(`fanout_state_conflict: run ${runId} is not active`);
    }

    const fanoutKey = chainFanoutStepId(input.step);
    const unitIds = input.items.map((_, i) => chainFanoutUnitId(input.step, i));
    const expansion: WorkflowFanoutState = {
      step: input.step,
      items: input.items,
      unitIds,
    };

    const existing = live.workflowState?.fanouts?.[fanoutKey];
    if (existing) {
      if (!fanoutStateEqual(existing, expansion)) {
        throw new Error(
          `fanout_state_conflict: step ${input.step} already expanded with different items`
        );
      }
      // Idempotent: verify child units still match.
      for (let i = 0; i < unitIds.length; i++) {
        const id = unitIds[i]!;
        const unit = live.units[id];
        if (!unit || unit.step !== input.step || unit.fanoutIndex !== i) {
          throw new Error(
            `fanout_state_conflict: step ${input.step} unit mapping mismatch for ${id}`
          );
        }
      }
      return existing;
    }

    // Reject collisions with non-fanout units already registered under a child id.
    for (const id of unitIds) {
      if (live.units[id] !== undefined) {
        throw new Error(`fanout_state_conflict: unit ${id} already exists`);
      }
    }

    const fingerprint = agentFingerprint(input.agent);
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

    // Strict awaited write: cancel coalesced timers and surface failures.
    // Mutate the store record inside updateRun; after success, ensure the live
    // units object (often the same reference) carries the children without
    // replacing the shared object held by StartedRun / lifecycle hooks.
    cancelPendingTimer(runId);
    try {
      await store.updateRun(runId, (record) => {
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
      // If the store mutated before failing the write and shares our units
      // object, roll back the child keys so live state stays clean.
      for (const id of unitIds) {
        if (live.units[id] !== undefined && childUnits[id] !== undefined) {
          delete live.units[id];
        }
      }
      if (live.workflowState?.fanouts?.[fanoutKey] === expansion) {
        delete live.workflowState.fanouts[fanoutKey];
      }
      throw err;
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
      // No active registration: apply directly through the store as a fallback.
      store
        .updateRun(runId, (record) => {
          record.details = input.details;
          record.units = input.units;
          record.updatedAt = now();
          if (input.mutate) input.mutate(record);
        })
        .catch(() => {
          /* best-effort */
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

  function startUnit(runId: string, ctx: UnitExecutionContext, result?: SingleResult): void {
    if (result) {
      stampResultMetadata(result, ctx);
      result.status = 'running';
    }
    const live = ensureLiveRecord(runId);
    if (live) {
      const unit = live.units[ctx.unitId];
      if (unit) {
        unit.status = 'running';
        unit.attempt = ctx.attempt;
        unit.sessionFile = ctx.sessionFile;
        unit.worktreePath = ctx.worktreePath;
        // Record a running attempt so finishUnit can finalize it with real timestamps.
        unit.attempts.push({
          attempt: ctx.attempt,
          status: 'running',
          startedAt: now(),
        });
      }
      void store
        .appendEvent(runId, {
          version: 1,
          event: 'unit_started',
          runId,
          timestamp: now(),
          unitId: ctx.unitId,
          attempt: ctx.attempt,
        })
        .catch(() => {});
      persist({
        runId,
        details: live.details,
        units: live.units,
        flushNow: true,
      });
    }
  }

  function finishUnit(
    runId: string,
    ctx: UnitExecutionContext,
    result: SingleResult,
    finalStatus: ExecutionStatus | 'interrupted'
  ): void {
    stampResultMetadata(result, ctx);
    result.status = finalStatus;
    const live = ensureLiveRecord(runId);
    if (!live) return;
    const unit = live.units[ctx.unitId];
    if (unit) {
      const last = unit.attempts[unit.attempts.length - 1];
      if (last && last.attempt === ctx.attempt && last.status === 'running') {
        // Finalize the running attempt recorded by startUnit with real timestamps.
        last.status = finalStatus;
        last.finishedAt = now();
        if (result.stopReason !== undefined) last.stopReason = result.stopReason;
        if (result.errorMessage !== undefined) last.errorMessage = result.errorMessage;
      } else {
        // No running attempt (pre-execution failure or crash recovery).
        recordAttempt(unit, finalStatus, last?.startedAt ?? now(), now(), {
          stopReason: result.stopReason,
          errorMessage: result.errorMessage,
        });
      }
      unit.status = finalStatus;
      unit.result = result;
    }
    void store
      .appendEvent(runId, {
        version: 1,
        event: 'unit_terminal',
        runId,
        timestamp: now(),
        unitId: ctx.unitId,
        attempt: ctx.attempt,
        status: finalStatus,
      })
      .catch(() => {});
    persist({
      runId,
      details: live.details,
      units: live.units,
      flushNow: true,
    });
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
  ): Promise<void> {
    const live = active.get(runId);
    if (!live) {
      // Still try to persist against the durable record for runs we didn't register.
      try {
        await store.updateRun(runId, (record) => {
          record.details = details;
          record.units = units;
          record.finishedAt = now();
          record.updatedAt = now();
          const status = deriveRunStatus(units, details);
          record.status = status;
          if (options.lastError !== undefined) record.lastError = options.lastError;
        });
      } catch {
        /* best-effort */
      }
      return;
    }
    live.details = details;
    live.units = units;
    live.finishedAt = now();
    live.updatedAt = now();
    let status: RunStatus;
    if (options.cancelled) status = 'cancelled';
    else if (options.interrupted) status = 'interrupted';
    else if (options.success === false) status = 'failed';
    else status = deriveRunStatus(units, details);
    live.status = status;
    if (options.lastError !== undefined) live.lastError = options.lastError;

    // Wait for any pending coalesced write, then do one final flush and release.
    cancelPendingTimer(runId);
    await writeRun(runId);
    lastPersist.set(runId, now());
    // The run is settled; drop the in-memory registration so subsequent
    // `isActive`/reconciliation can treat it as a past run.
    unregisterRun(runId);
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
    const anyIncomplete = Object.values(units).some(
      (u) => u.status === 'interrupted' || u.status === 'failed' || u.status === 'cancelled'
    );
    const resumable = status !== 'completed' && anyIncomplete;
    return { runId, status, resumable, capability };
  }

  /**
   * Idempotently persist one interactive binding on a unit, then flush the run
   * snapshot. Must succeed before the host-session link is appended. Existing
   * Version 1 records without `interactiveBindings` remain valid.
   */
  async function persistInteractiveBinding(input: {
    runId: string;
    unitId: string;
    binding: InteractiveAgentBindingV1;
  }): Promise<void> {
    const { runId, unitId, binding } = input;
    const live = active.get(runId);

    const apply = (record: AgentRunRecordV1): void => {
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

    cancelPendingTimer(runId);
    // Apply to the live snapshot first (authoritative while registered), then
    // flush through updateRun so disk failures surface to the caller. Do not use
    // writeRun here — it swallows persistence errors.
    if (live) {
      apply(live);
    }
    await store.updateRun(runId, (record) => {
      if (live) {
        // Mirror authoritative live fields onto the durable snapshot.
        record.status = live.status;
        record.details = live.details;
        record.units = live.units;
        if (live.workflowState !== undefined) {
          record.workflowState = live.workflowState;
        }
        record.updatedAt = now();
      } else {
        apply(record);
      }
    });
    lastPersist.set(runId, now());
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
