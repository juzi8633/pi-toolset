// ABOUTME: Tool orchestration for the `agent` tool - mode dispatch and result assembly.
// ABOUTME: Owns single/parallel/chain execution flows so `index.ts` stays a thin extension entrypoint.

import * as path from 'node:path';
import type { Static } from '@earendil-works/pi-ai';
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  type AgentConfig,
  type AgentScope,
  type Runtime,
  discoverAgents,
  getBuiltinAgentsDir,
} from './agents.ts';
import type { BackgroundManager } from './background.ts';
import {
  buildRestoredLogicalSteps,
  runChainWorkflow,
  synthesizeFailure,
  type FanoutExpandRequest,
} from './chain.ts';
import { attachErrorStack, classifyEarlyFailureStopReason } from './early-failure.ts';
import { emptyUsage } from './empty-usage.ts';
import { startProfile, stopProfile } from './profiler.ts';
import type { WorkflowFanoutState } from './run-types.ts';

import {
  GROK_ACP_RUNTIME,
  MAX_CONCURRENCY,
  MAX_PARALLEL_TASKS,
  PRESENTATION_OUTPUT_TAIL_CHARS,
  RESULT_UPDATE_INTERVAL_MS,
} from './constants.ts';
import { createLatestValueCoalescer } from './update-coalescer.ts';
import { enforceCompletionCheck } from './completion-check.ts';
import { prepareAgentContext } from './context.ts';
import { listAvailableSkillNames, resolveSkillNames } from './skills.ts';
import {
  ABORT_MESSAGE,
  AgentAbortError,
  getAbortResult,
  isAbortError,
  mapWithConcurrencyLimit,
  type OnUpdateCallback,
  runSingleAgent,
} from './execution.ts';
import {
  applyTerminalStatus,
  getResultFinalOutput,
  getResultOutput,
  getResultParentOutput,
  isFailedResult,
  resolveExecutionStatus,
  truncateParallelOutput,
} from './output.ts';
import { externalizeJsonPayload, externalizeTextPayload } from './result-payload.ts';
import { copySnapshotShell, snapshotSingleResult } from './result-snapshot.ts';
import {
  createRunLifecycle,
  bridgeIncomingSignal,
  originToFinalizeFlags,
  originToUnitStatus,
  originToRunStatus,
  type RunLifecycle,
} from './run-lifecycle.ts';
import {
  finalizeDurableRun,
  normalizeStoredRequest,
  safeAbandon,
  startDurableRun,
  type StartedRun,
} from './run-persistence.ts';
import type { RunAbortOrigin } from './run-types.ts';
import type { RunStore } from './run-store.ts';
import { chainFanoutUnitId, chainStepUnitId, pad } from './run-coordinator.ts';
import type { RunCoordinator, UnitExecutionContext } from './run-coordinator.ts';
import type { SubagentParams } from './schema.ts';
import { assertAgentDelegationAllowed } from './security.ts';
import {
  cloneSingleResult,
  type ExecutionStatus,
  type IsolationMode,
  type SingleResult,
  type SubagentDetails,
  type ChainOutputEntry,
} from './types.ts';
import {
  type AgentWorktree,
  createAgentWorktree,
  getGitRoot,
  getWorktreeDiffSummary,
  getWorktreeDirtyStatus,
  openAgentWorktree,
  removeAgentWorktree,
  runWorktreeSetupHook,
} from './worktree.ts';
import {
  inspectResumeRecord,
  resolveAndVerifyFanoutItems,
  incrementIncompleteAttempts,
  isNeverStartedUnit,
  reopenCompletedUnitsForResume,
} from './resume.ts';
import type { ResumePromptContext } from './execution.ts';
import type { StoredRunRequest } from './run-types.ts';

type Params = Static<typeof SubagentParams>;
type Mode = 'single' | 'parallel' | 'chain';
type AgentResult = AgentToolResult<SubagentDetails> & { isError?: boolean };
type DetailsFactory = (mode: Mode) => (results: SingleResult[]) => SubagentDetails;

/** Public resume inputs resolved at the start of executeAgentTool. */
interface ResumeDescriptor {
  runId: string;
  currentContinuationTask?: string;
}

/** Fresh-run fields that conflict with resume via runId. */
const RESUME_CONFLICT_FIELDS = [
  'agent',
  'tasks',
  'chain',
  'agentScope',
  'cwd',
  'isolation',
  'runInBackground',
  'model',
  'thinking',
  'runtime',
  'title',
] as const;

export interface ExecuteAgentToolOptions {
  backgroundManager?: BackgroundManager;
  /** Test seam: override the post-validation workflow runner. */
  runWorkflow?: WorkflowRunner;
  /** Durable run persistence; injected by the extension entrypoint. */
  runStore?: RunStore;
  runCoordinator?: RunCoordinator;
  /** Interactive TUI registry; when present, eligible Pi units register before spawn. */
  interactiveRegistry?: import('./interactive-agent.ts').InteractiveAgentRegistry;
  /** Test seam: inject child process spawn for orchestration-path tests. */
  spawnFn?: import('./execution.ts').SpawnFn;
  /**
   * Test-only seam: build restored chain state from the verified post-claim
   * record. Override to force a failure after ref validation but before any
   * durable mutation, event, registration, or dispatch. The production default
   * calls the real builder inline.
   */
  buildRestoredChainState?: (input: {
    mode: Mode;
    record: import('./run-types.ts').AgentRunRecordV1;
    units: Record<string, import('./run-types.ts').RunUnitRecord>;
    resolvedFanouts: Record<string, import('./run-types.ts').WorkflowFanoutState>;
  }) => import('./chain.ts').RestoredChainState | undefined;
}

/** Detect fresh-run configuration supplied alongside runId. */
function collectResumeConflicts(params: Params): string[] {
  const found: string[] = [];
  for (const field of RESUME_CONFLICT_FIELDS) {
    if (params[field] !== undefined) found.push(field);
  }
  return found.sort();
}

/** Hydrate workflow params from a stored run request (source of truth on resume). */
function paramsFromStoredRequest(request: StoredRunRequest, background: boolean): Params {
  const params: Params = {
    agentScope: request.agentScope,
  };
  if (request.agent !== undefined) params.agent = request.agent;
  if (request.task !== undefined) params.task = request.task;
  if (request.title !== undefined) params.title = request.title;
  if (request.cwd !== undefined) params.cwd = request.cwd;
  if (request.isolation !== undefined) params.isolation = request.isolation;
  if (request.model !== undefined) params.model = request.model;
  if (request.thinking !== undefined) params.thinking = request.thinking;
  if (request.runtime !== undefined) params.runtime = request.runtime;
  if (background) params.runInBackground = true;
  if (request.tasks) {
    params.tasks = request.tasks.map((t) => {
      const item: NonNullable<Params['tasks']>[number] = {
        agent: t.agent,
        task: t.task,
      };
      if (t.title !== undefined) item.title = t.title;
      if (t.cwd !== undefined) item.cwd = t.cwd;
      if (t.isolation !== undefined) item.isolation = t.isolation;
      return item;
    });
  }
  if (request.chain) {
    params.chain = request.chain as NonNullable<Params['chain']>;
  }
  return params;
}

type WorkflowRunner = (
  params: Params,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  ctx: ExtensionContext,
  agents: AgentConfig[],
  makeDetails: DetailsFactory
) => Promise<AgentResult>;

/**
 * Finalize a durable run from a workflow result or thrown error. Carries the
 * abort origin (user/session_shutdown/owner_process_missing/unknown) through
 * to the run-level status. No-op when persistence is not configured.
 */
async function finalizeDurable(
  durable: DurableRunContext | undefined,
  err: unknown,
  result?: AgentResult
): Promise<void> {
  if (!durable) return;
  const abortOrigin =
    err instanceof AgentAbortError
      ? err.origin
      : durable.lifecycle.signal.aborted
        ? durable.lifecycle.origin
        : undefined;
  // Prefer original AgentAbortError.origin; otherwise lifecycle abort origin.
  // The foreground workflow often catches aborts and surfaces them as isError
  // results, so `err` may be undefined — lifecycle signal still classifies then.
  if (abortOrigin !== undefined) {
    const flags = originToFinalizeFlags(abortOrigin);
    await durable.started.finalize({
      details: result?.details ?? { ...durable.started.record.details },
      units: durable.started.units,
      ...flags,
      lastError:
        err instanceof Error ? err.message : result?.isError ? extractErrorText(result) : undefined,
    });
    return;
  }
  const success = result ? !result.isError : err ? false : true;
  await durable.started.finalize({
    details: result?.details ?? durable.started.record.details,
    units: durable.started.units,
    success,
    ...(result?.isError ? { lastError: extractErrorText(result) } : {}),
  });
}

function extractErrorText(result: AgentResult): string | undefined {
  for (const part of result.content) {
    if (part.type === 'text' && typeof part.text === 'string') return part.text;
  }
  return undefined;
}

/** Stamp durable run metadata onto a result's details (foreground sync path). */
function stampRunOnDetails(
  details: SubagentDetails,
  durable: DurableRunContext,
  finalStatus: import('./run-types.ts').RunStatus
): void {
  // Apply terminal status before aggregate so resumability uses finalStatus
  // (failed/cancelled/interrupted with queued siblings), not a stale derived
  // running status from never-started units still marked queued.
  details.run = {
    runId: details.run?.runId ?? durable.started.runId,
    status: finalStatus,
    resumable: details.run?.resumable ?? false,
    capability: details.run?.capability ?? 'session',
  };
  const base = durable.coordinator.aggregateRun(details, durable.started.units);
  details.run = {
    runId: base.runId || durable.started.runId,
    status: finalStatus,
    resumable: base.resumable,
    capability: base.capability,
  };
}
/**
 * Shared durable-run handle threaded through workflow execution. Provides
 * per-unit context factories, the coordinator-owned abort lifecycle, and
 * per-unit begin/end hooks. When undefined, persistence is skipped (legacy).
 */
interface DurableRunContext {
  started: StartedRun;
  lifecycle: RunLifecycle;
  coordinator: RunCoordinator;
  /** Whether this context restored an existing run rather than starting a fresh one. */
  isResume: boolean;
  /** Resume prompt metadata when this durable context was restored via runId. */
  resume?: ResumePromptContext;
  /**
   * Project/workspace cwd restored from the durable run (request.cwd or unit
   * effectiveCwd). Used for agent discovery and git root resolution on resume.
   */
  projectCwd?: string;
  /** Resolve the UnitExecutionContext for a workflow position. */
  unitFor(
    step: number | undefined,
    fanoutIndex: number | undefined,
    agentName: string
  ): UnitExecutionContext;
  /** Stamp the per-unit start; awaited before session stamp / interactive register. */
  beginUnit(ctx: UnitExecutionContext): void | Promise<void>;
  /** Stamp the per-unit terminal. */
  endUnit(
    ctx: UnitExecutionContext,
    result: SingleResult,
    status: ExecutionStatus
  ): Promise<void | SingleResult>;
  /**
   * Strict awaited first-write of a unit sessionFile after Pi session creation.
   * Disk-first CAS via the coordinator; same path is idempotent.
   */
  stampUnitSessionFile(unitId: string, sessionFile: string): Promise<void>;
  /**
   * Strict awaited write of a Grok ACP session ID (disk-first). Must succeed
   * before the first session/prompt.
   */
  persistAcpSessionId?(unitId: string, sessionId: string): Promise<void>;
  /**
   * Strict awaited mark that Pi accepted the unit's original prompt.
   * Write failure must fail-close the current execution.
   */
  markSessionPromptEstablished?(unitId: string): Promise<void>;
  /**
   * Persist fanout expansion + child unit records before workers are scheduled.
   * Resolves the requested agent by exact name (synthetic fallback; never agents[0]).
   */
  expandFanout(req: FanoutExpandRequest): Promise<WorkflowFanoutState>;
  /** Build per-unit resume prompt context with undelivered continuation slice. */
  resumePromptForUnit?(unitId: string): ResumePromptContext | undefined;
  /**
   * Mark all current continuation tasks as delivered for a unit.
   * Pi: after prompt accept (may be fire-and-forget).
   * Grok ACP: after matching prompt completed; await the returned promise.
   */
  markContinuationDelivered?(unitId: string): void | Promise<void>;
}

/**
 * Build a DurableRunContext from validated params, or return undefined when
 * persistence is not configured. Resolves effective runtime/model/thinking/
 * isolation before creating the queued snapshot, then claims and transitions
 * to running.
 */
async function maybeStartDurableRun(
  params: Params,
  mode: Mode,
  agentScope: AgentScope,
  options: ExecuteAgentToolOptions,
  ctx: ExtensionContext,
  agents: AgentConfig[],
  makeDetails: DetailsFactory
): Promise<DurableRunContext | undefined> {
  const store = options.runStore;
  const coordinator = options.runCoordinator;
  if (!store || !coordinator) return undefined;

  const request = normalizeStoredRequest({
    mode,
    agentScope,
    ...(params.model !== undefined ? { model: params.model } : {}),
    ...(params.thinking !== undefined ? { thinking: params.thinking } : {}),
    ...(params.runtime !== undefined ? { runtime: params.runtime } : {}),
    ...(params.isolation !== undefined ? { isolation: params.isolation } : {}),
    ...(params.agent !== undefined ? { agent: params.agent } : {}),
    ...(params.task !== undefined ? { task: params.task } : {}),
    ...(params.title !== undefined ? { title: params.title } : {}),
    ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
    ...(params.tasks !== undefined ? { tasks: params.tasks } : {}),
    ...(params.chain !== undefined ? { chain: params.chain } : {}),
  });

  const resolvedUnits = collectResolvedUnits(mode, params, agents, ctx);
  const started = await startDurableRun({
    store,
    coordinator,
    mode,
    agentScope,
    background: Boolean(params.runInBackground),
    request,
    details: makeDetails(mode)([]),
    agents,
    resolvedUnits,
  });
  const lifecycle = createRunLifecycle(started.runId);
  const unitIds = started.unitIds;
  const units = started.units;
  const sessionsDir = path.join(store.getRunDir(started.runId), 'sessions');
  const unitFor = (
    step: number | undefined,
    fanoutIndex: number | undefined,
    agentName: string
  ): UnitExecutionContext => {
    const unitId = resolveUnitId(mode, unitIds, step, fanoutIndex);
    const base = units[unitId];
    const neverStarted = base ? isNeverStartedUnit(base) : true;
    return {
      runId: started.runId,
      unitId,
      agent: agentName,
      runtime: base?.runtime,
      resumeCapability: base?.capability ?? 'session',
      effectiveCwd: base?.effectiveCwd ?? ctx.cwd,
      attempt: base?.attempt ?? 1,
      sessionsDir,
      neverStarted,
      ...(base?.sessionFile !== undefined ? { sessionFile: base.sessionFile } : {}),
      ...(base?.acpSessionId !== undefined ? { acpSessionId: base.acpSessionId } : {}),
      ...(base?.sessionPromptEstablished !== undefined
        ? { sessionPromptEstablished: base.sessionPromptEstablished }
        : {}),
      ...(base?.worktreePath !== undefined ? { worktreePath: base.worktreePath } : {}),
      ...(base?.requireArtifactReader ? { requireArtifactReader: true } : {}),
      ...(step !== undefined ? { step } : {}),
      ...(fanoutIndex !== undefined ? { fanoutIndex } : {}),
    };
  };
  const beginUnit = async (unitCtx: UnitExecutionContext) => {
    await coordinator.startUnit(started.runId, unitCtx);
  };
  const endUnit = async (
    unitCtx: UnitExecutionContext,
    result: SingleResult,
    status: ExecutionStatus
  ): Promise<SingleResult> => {
    return coordinator.finishUnit(started.runId, unitCtx, result, status);
  };
  const stampUnitSessionFile = async (unitId: string, sessionFile: string): Promise<void> => {
    const unit = units[unitId];
    // Only first path write marks unestablished; restamp must not regress legacy/true.
    const firstWrite = !unit?.sessionFile?.trim();
    await coordinator.persistSessionFile({
      runId: started.runId,
      unitId,
      sessionFile,
    });
    if (unit) {
      unit.sessionFile = sessionFile.trim();
      if (firstWrite && unit.sessionPromptEstablished !== true) {
        unit.sessionPromptEstablished = false;
      }
    }
  };
  const markSessionPromptEstablished = async (unitId: string): Promise<void> => {
    await coordinator.persistSessionPromptEstablished({
      runId: started.runId,
      unitId,
    });
    const unit = units[unitId];
    if (unit) {
      unit.sessionPromptEstablished = true;
    }
  };
  const persistAcpSessionId = async (unitId: string, sessionId: string): Promise<void> => {
    await coordinator.persistAcpSessionId({
      runId: started.runId,
      unitId,
      sessionId,
    });
    const unit = units[unitId];
    if (unit) {
      unit.acpSessionId = sessionId.trim();
    }
  };
  const expandFanout = async (req: FanoutExpandRequest): Promise<WorkflowFanoutState> => {
    // Exact name match only; never substitute agents[0] for a missing fanout agent.
    const agent = agents.find((a) => a.name === req.agent) ?? syntheticAgent(req.agent);
    const runtime = params.runtime ?? agent.runtime;
    return coordinator.expandFanout(started.runId, {
      step: req.step,
      items: req.items,
      agent,
      runtime,
      effectiveCwd: req.effectiveCwd ?? ctx.cwd,
    });
  };
  return {
    started,
    lifecycle,
    coordinator,
    isResume: false,
    unitFor,
    beginUnit,
    endUnit,
    persistAcpSessionId,
    stampUnitSessionFile,
    markSessionPromptEstablished,
    expandFanout,
  };
}

/**
 * Project/workspace cwd for a stored run: prefer request.cwd, else the first
 * unit's effectiveCwd (non-worktree original location).
 */
/** UTF-8 budget for resume/store diagnostic strings (matches RESULT_DIAGNOSTIC_MAX_BYTES). */
const STORE_ERROR_DIAGNOSTIC_MAX_BYTES = 64 * 1024;
const STORE_ERROR_OMISSION_MARKER = '…[truncated]';

function utf8BytesOf(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Truncate to at most maxBytes UTF-8, on a Unicode code-point boundary. */
function truncateUtf8CodePoints(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8BytesOf(value) <= maxBytes) return value;
  let lo = 0;
  let hi = value.length;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    // Do not end on a high surrogate (incomplete pair).
    let end = mid;
    if (end > 0) {
      const prev = value.charCodeAt(end - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) end = end - 1;
    }
    if (utf8BytesOf(value.slice(0, end)) <= maxBytes) {
      best = end;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return value.slice(0, best);
}

function boundDiagnosticText(value: string): string {
  if (utf8BytesOf(value) <= STORE_ERROR_DIAGNOSTIC_MAX_BYTES) return value;
  const marker = STORE_ERROR_OMISSION_MARKER;
  const budget = STORE_ERROR_DIAGNOSTIC_MAX_BYTES - utf8BytesOf(marker);
  if (budget <= 0) return truncateUtf8CodePoints(marker, STORE_ERROR_DIAGNOSTIC_MAX_BYTES);
  return `${truncateUtf8CodePoints(value, budget)}${marker}`;
}

/**
 * Deterministic useful fallback for non-Error throwables that lack own
 * code/message. Never returns the useless `[object Object]` string.
 */
function fallbackDiagnosticPayload(err: unknown): string {
  if (err === null) return 'null';
  if (err === undefined) return 'undefined';
  const t = typeof err;
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') {
    return String(err);
  }
  if (t === 'symbol') return err.toString();
  try {
    const json = JSON.stringify(err);
    if (typeof json === 'string' && json.length > 0 && json !== '{}') return json;
  } catch {
    /* cyclic / non-serializable */
  }
  const tag =
    err && typeof err === 'object' && err.constructor && err.constructor.name
      ? err.constructor.name
      : t;
  return `unserializable_${tag}`;
}

/**
 * Bounded diagnostic for store/resume failures. Prefer own string `code` and
 * `message` from Error and plain-object failures; never surface `[object Object]`.
 * When `prefix` is provided, the complete final string (prefix + body + omission
 * marker) is UTF-8-bounded to STORE_ERROR_DIAGNOSTIC_MAX_BYTES.
 */
function formatBoundedStoreError(err: unknown, prefix = ''): string {
  let raw: string;
  if (err instanceof Error) {
    const rec = err as unknown as Record<string, unknown>;
    const ownCode =
      Object.prototype.hasOwnProperty.call(err, 'code') && typeof rec.code === 'string'
        ? rec.code
        : undefined;
    raw = ownCode ? `${ownCode}: ${err.message}` : err.message;
  } else if (err && typeof err === 'object') {
    const rec = err as Record<string, unknown>;
    const ownCode =
      Object.prototype.hasOwnProperty.call(err, 'code') && typeof rec.code === 'string'
        ? rec.code
        : undefined;
    const ownMessage =
      Object.prototype.hasOwnProperty.call(err, 'message') && typeof rec.message === 'string'
        ? rec.message
        : undefined;
    if (ownCode && ownMessage) raw = `${ownCode}: ${ownMessage}`;
    else if (ownMessage) raw = ownMessage;
    else if (ownCode) raw = ownCode;
    else raw = fallbackDiagnosticPayload(err);
  } else {
    raw = fallbackDiagnosticPayload(err);
  }
  if (!prefix) return boundDiagnosticText(raw);
  // Cap the complete final diagnostic including prefix and omission marker.
  const full = `${prefix}${raw}`;
  if (utf8BytesOf(full) <= STORE_ERROR_DIAGNOSTIC_MAX_BYTES) return full;
  const marker = STORE_ERROR_OMISSION_MARKER;
  const prefixBytes = utf8BytesOf(prefix);
  const markerBytes = utf8BytesOf(marker);
  const bodyBudget = STORE_ERROR_DIAGNOSTIC_MAX_BYTES - prefixBytes - markerBytes;
  if (bodyBudget <= 0) {
    // Prefix alone exceeds budget: truncate the whole string.
    return boundDiagnosticText(full);
  }
  const body = truncateUtf8CodePoints(raw, bodyBudget);
  const budgetUsed = prefixBytes + utf8BytesOf(body) + markerBytes;
  const padding = STORE_ERROR_DIAGNOSTIC_MAX_BYTES - budgetUsed;
  if (padding > 0) {
    // Pad with spaces to fill exact diagnostic budget so output is deterministic.
    return `${prefix}${body}${' '.repeat(padding)}${marker}`;
  }
  return `${prefix}${body}${marker}`;
}

function projectCwdFromRecord(
  record: import('./run-types.ts').AgentRunRecordV1,
  fallback: string
): string {
  if (record.request.cwd && record.request.cwd.trim()) return record.request.cwd;
  for (const unit of Object.values(record.units)) {
    if (unit.effectiveCwd && unit.effectiveCwd.trim()) return unit.effectiveCwd;
  }
  return fallback;
}

/**
 * Build a DurableRunContext from a stored run for resume. Loads the record,
 * runs preflight, claims the run, re-validates eligibility on the claimed
 * record, increments incomplete unit attempts, and registers with the
 * coordinator. Returns an error when preflight fails.
 */
async function maybeResumeDurableRun(
  resume: ResumeDescriptor,
  mode: Mode,
  options: ExecuteAgentToolOptions,
  ctx: ExtensionContext,
  agents: AgentConfig[]
): Promise<
  | { durable: DurableRunContext; restoredChain?: import('./chain.ts').RestoredChainState }
  | { error: string }
> {
  /** Centralized bounded resume error with prefix. Every return <= 64 KiB UTF-8. */
  const resumeError = (cause: unknown, prefix = 'resume_error: '): { error: string } => ({
    error: formatBoundedStoreError(cause, prefix),
  });

  const store = options.runStore;
  const coordinator = options.runCoordinator;
  if (!store || !coordinator) return resumeError('persistence_not_configured');

  const resumeRunId = resume.runId;
  const hasContinuation = Boolean(resume.currentContinuationTask);
  const inspectOptions = {
    agents,
    hasContinuation,
  };
  // Preflight: load once and verify that exact loaded record.
  const preflightLoaded = store.getRun(resumeRunId);
  if (!preflightLoaded.ok)
    return resumeError(preflightLoaded.error, 'resume_error: run_not_found: ');
  const preflightRecord = preflightLoaded.loaded.record;
  const preflightInspection = await inspectResumeRecord(
    resumeRunId,
    preflightRecord,
    store,
    inspectOptions
  );
  if (!preflightInspection.ok) return resumeError(preflightInspection.reason);
  if (preflightInspection.blockingReasons.length > 0) {
    return resumeError(
      preflightInspection.blockingReasons.join('; '),
      'resume_error: preflight_failed: '
    );
  }
  if (coordinator.isActive(resumeRunId)) return resumeError('run_active');

  const claim = await store.claimRun(resumeRunId);
  if (!claim.ok) return resumeError(claim.error, 'resume_error: claim_failed: ');

  // Every post-claim operation lives inside one unified abandon boundary.
  // A single unregister+abandon on any error ensures the claim is never
  // leaked; prepare + commit + validation all share the same cleanup path.
  let record!: import('./run-types.ts').AgentRunRecordV1;
  let resolvedFanouts!: Record<string, WorkflowFanoutState>;
  let priorContinuations!: string[];
  let accumulatedContinuations!: string[];
  let priorDelivery!: Record<string, { deliveredCount: number }>;
  let units!: Record<string, import('./run-types.ts').RunUnitRecord>;
  let restoredChain: import('./chain.ts').RestoredChainState | undefined;
  let lifecycle!: ReturnType<typeof createRunLifecycle>;
  let projectCwd!: string;
  let sessionsDir!: string;
  let unitIds!: string[];
  let unitFor!: DurableRunContext['unitFor'];
  let beginUnit!: DurableRunContext['beginUnit'];
  let endUnit!: DurableRunContext['endUnit'];
  let stampUnitSessionFile!: DurableRunContext['stampUnitSessionFile'];
  let markSessionPromptEstablished!: NonNullable<DurableRunContext['markSessionPromptEstablished']>;
  let persistAcpSessionId!: NonNullable<DurableRunContext['persistAcpSessionId']>;
  let expandFanout!: DurableRunContext['expandFanout'];
  let resumePromptForUnit!: NonNullable<DurableRunContext['resumePromptForUnit']>;
  let markContinuationDelivered!: NonNullable<DurableRunContext['markContinuationDelivered']>;
  let started!: StartedRun;
  let resumePrompt!: ResumePromptContext;
  try {
    // === POST-CLAIM VALIDATION: re-verify eligibility after claim; every
    // failure throws through the single abandon boundary below.
    const loaded = store.getRun(resumeRunId);
    if (!loaded.ok) throw new Error('run_not_found_after_claim');
    record = loaded.loaded.record;
    const postClaim = await inspectResumeRecord(resumeRunId, record, store, inspectOptions);
    if (!postClaim.ok) throw new Error(postClaim.reason);
    if (postClaim.blockingReasons.length > 0) {
      throw new Error(`preflight_failed: ${postClaim.blockingReasons.join('; ')}`);
    }
    const fanoutResolution = await resolveAndVerifyFanoutItems(resumeRunId, store, record);
    if (!fanoutResolution.ok) {
      throw new Error(`preflight_failed: ${fanoutResolution.reasons.join('; ')}`);
    }
    resolvedFanouts = fanoutResolution.resolved;

    priorContinuations = record.continuationTasks ?? [];
    accumulatedContinuations = resume.currentContinuationTask
      ? [...priorContinuations, resume.currentContinuationTask]
      : [...priorContinuations];
    priorDelivery = { ...(record.continuationDelivery ?? {}) };

    // === PREPARE: construct every value that can throw; no durable mutations ===

    // Normalize legacy full-message results once after post-claim revalidation and
    // before any resume write can reserialize raw transcripts.
    if (Array.isArray(record.details.results)) {
      record.details.results = record.details.results.map((r) => snapshotSingleResult(r));
    }
    for (const unit of Object.values(record.units)) {
      if (unit.result) unit.result = snapshotSingleResult(unit.result);
    }
    // Shallow-copy units so we can stage attempt increments before write.
    units = {};
    for (const [id, unit] of Object.entries(record.units)) {
      units[id] = { ...unit, attempts: [...unit.attempts] };
    }

    // Fully completed runs reopen finished units so continuation can continue
    // from stored context; selective resume leaves completed siblings alone.
    reopenCompletedUnitsForResume(units);
    // Increment attempts only after post-claim eligibility succeeds.
    incrementIncompleteAttempts(units);

    // Drop planned-only session paths from never-started units. A pre-begin stamp
    // crash window may have left a path without attempt history; those are not
    // established sessions and must not block a fresh first-write or flip
    // resumeHadStoredSession.
    for (const unit of Object.values(units)) {
      if (isNeverStartedUnit(unit) && unit.sessionFile) {
        delete unit.sessionFile;
        delete unit.sessionPromptEstablished;
        if (unit.result) delete unit.result.sessionFile;
      }
    }

    // Build restored chain state from the verified post-claim record before any
    // durable mutation, event, registration, or dispatch. Every failure here
    // leaves zero side effects (unregister + abandon, never release).
    if (options.buildRestoredChainState) {
      restoredChain = options.buildRestoredChainState({
        mode,
        record,
        units,
        resolvedFanouts,
      });
    } else if (
      mode === 'chain' &&
      Array.isArray(record.request.chain) &&
      record.request.chain.length > 0
    ) {
      const chain = record.request.chain as import('./chain.ts').ChainItemInput[];
      const fanoutRuntimeState: Record<string, WorkflowFanoutState> | undefined =
        Object.keys(resolvedFanouts).length > 0
          ? Object.fromEntries(
              Object.entries(resolvedFanouts).map(([k, v]) => [
                k,
                { step: v.step, items: v.items, unitIds: v.unitIds },
              ])
            )
          : undefined;
      const logicalSteps = buildRestoredLogicalSteps(
        chain,
        record.details.chain?.steps,
        units,
        fanoutRuntimeState
      );
      restoredChain = {
        results: record.details.results,
        outputs: record.details.outputs ?? {},
        logicalSteps,
        units,
        fanouts: fanoutRuntimeState,
      };
    }

    // Build every runtime closure from the verified post-claim state.  All of
    // these are side-effect-free to construct and must succeed before any
    // durable mutation, event, registration, or dispatch.
    lifecycle = createRunLifecycle(resumeRunId);
    sessionsDir = path.join(store.getRunDir(resumeRunId), 'sessions');
    unitIds = Object.keys(units);
    projectCwd = projectCwdFromRecord(record, ctx.cwd);

    unitFor = (
      step: number | undefined,
      fanoutIndex: number | undefined,
      agentName: string
    ): UnitExecutionContext => {
      const unitId = resolveUnitId(mode, unitIds, step, fanoutIndex);
      const base = units[unitId];
      const neverStarted = base ? isNeverStartedUnit(base) : true;
      return {
        runId: resumeRunId,
        unitId,
        agent: agentName,
        runtime: base?.runtime,
        resumeCapability: base?.capability ?? 'session',
        effectiveCwd: base?.effectiveCwd ?? projectCwd,
        attempt: base?.attempt ?? 1,
        sessionsDir,
        neverStarted,
        ...(base?.sessionFile !== undefined ? { sessionFile: base.sessionFile } : {}),
        ...(base?.acpSessionId !== undefined ? { acpSessionId: base.acpSessionId } : {}),
        ...(base?.sessionPromptEstablished !== undefined
          ? { sessionPromptEstablished: base.sessionPromptEstablished }
          : {}),
        ...(base?.worktreePath !== undefined ? { worktreePath: base.worktreePath } : {}),
        ...(base?.requireArtifactReader ? { requireArtifactReader: true } : {}),
        ...(step !== undefined ? { step } : {}),
        ...(fanoutIndex !== undefined ? { fanoutIndex } : {}),
      };
    };
    beginUnit = async (unitCtx: UnitExecutionContext) => {
      await coordinator.startUnit(resumeRunId, unitCtx);
    };
    endUnit = async (
      unitCtx: UnitExecutionContext,
      result: SingleResult,
      status: ExecutionStatus
    ): Promise<SingleResult> => {
      return coordinator.finishUnit(resumeRunId, unitCtx, result, status);
    };
    stampUnitSessionFile = async (unitId: string, sessionFile: string): Promise<void> => {
      const unit = units[unitId];
      const firstWrite = !unit?.sessionFile?.trim();
      await coordinator.persistSessionFile({
        runId: resumeRunId,
        unitId,
        sessionFile,
      });
      if (unit) {
        unit.sessionFile = sessionFile.trim();
        if (firstWrite && unit.sessionPromptEstablished !== true) {
          unit.sessionPromptEstablished = false;
        }
      }
    };
    markSessionPromptEstablished = async (unitId: string): Promise<void> => {
      await coordinator.persistSessionPromptEstablished({
        runId: resumeRunId,
        unitId,
      });
      const unit = units[unitId];
      if (unit) {
        unit.sessionPromptEstablished = true;
      }
    };
    persistAcpSessionId = async (unitId: string, sessionId: string): Promise<void> => {
      await coordinator.persistAcpSessionId({
        runId: resumeRunId,
        unitId,
        sessionId,
      });
      const unit = units[unitId];
      if (unit) {
        unit.acpSessionId = sessionId.trim();
      }
    };
    expandFanout = async (req: FanoutExpandRequest): Promise<WorkflowFanoutState> => {
      const agent = agents.find((a) => a.name === req.agent) ?? syntheticAgent(req.agent);
      const runtime = record.request.runtime ?? agent.runtime;
      return coordinator.expandFanout(resumeRunId, {
        step: req.step,
        items: req.items,
        agent,
        runtime,
        effectiveCwd: req.effectiveCwd ?? projectCwd,
      });
    };
    resumePromptForUnit = (unitId: string): ResumePromptContext => {
      const delivered = record.continuationDelivery?.[unitId]?.deliveredCount ?? 0;
      const undelivered = accumulatedContinuations.slice(delivered);
      return {
        continuationTasks: accumulatedContinuations,
        undeliveredContinuationTasks: undelivered,
        ...(resume.currentContinuationTask
          ? { currentContinuationTask: resume.currentContinuationTask }
          : {}),
      };
    };
    markContinuationDelivered = async (unitId: string): Promise<void> => {
      const deliveredCount = accumulatedContinuations.length;
      await coordinator.persistContinuationDelivery({
        runId: resumeRunId,
        unitId,
        deliveredCount,
        continuationTasks: accumulatedContinuations,
      });
      if (!record.continuationDelivery) record.continuationDelivery = {};
      record.continuationDelivery[unitId] = { deliveredCount };
    };

    started = {
      runId: resumeRunId,
      record: { ...record, units },
      claimId: claim.claimId,
      ticket: claim.ticket,
      units,
      unitIds,
      finalize: async (input) =>
        finalizeDurableRun({
          store,
          coordinator,
          runId: resumeRunId,
          claimId: claim.claimId,
          details: input.details,
          units: input.units,
          success: input.success,
          cancelled: input.cancelled,
          interrupted: input.interrupted,
          lastError: input.lastError,
        }),
    };

    resumePrompt = {
      continuationTasks: accumulatedContinuations,
      undeliveredContinuationTasks: accumulatedContinuations,
      ...(resume.currentContinuationTask
        ? { currentContinuationTask: resume.currentContinuationTask }
        : {}),
    };

    // === COMMIT: durable mutations, events, registration (only after prepare) ===

    // Transition to running and append the current continuation task atomically.
    await store.appendEvent(resumeRunId, {
      version: 1,
      event: 'run_resumed',
      runId: resumeRunId,
      timestamp: Date.now(),
      claimId: claim.claimId,
      ticket: claim.ticket,
    });
    await store.updateRunStrict(resumeRunId, (r) => {
      r.status = 'running';
      delete r.finishedAt;
      r.units = units;
      // Persist compact-normalized presentation results in the same post-claim write.
      r.details = {
        ...r.details,
        results: record.details.results,
      };
      r.updatedAt = Date.now();
      r.startedAt = r.startedAt ?? Date.now();
      if (resume.currentContinuationTask) {
        r.continuationTasks = [...(r.continuationTasks ?? []), resume.currentContinuationTask];
      }
      // Preserve existing per-unit delivery progress across the resume claim.
      if (Object.keys(priorDelivery).length > 0) {
        r.continuationDelivery = { ...priorDelivery };
      }
    });

    // Sync the in-memory record with the persisted running state before
    // registering so the coordinator's live units stay aliased to the handle
    // the workflow mutates via beginUnit/endUnit/stampUnitSessionFile.
    // Clear finishedAt here too: disk already dropped it, and a stale terminal
    // timestamp on the live record would re-persist on the next flush.
    record.status = 'running';
    delete record.finishedAt;
    record.units = units;
    record.continuationTasks = accumulatedContinuations;
    record.continuationDelivery = { ...priorDelivery };
    if (record.startedAt === undefined) record.startedAt = Date.now();
    record.updatedAt = Date.now();
    coordinator.registerRun(resumeRunId, record);
  } catch (err) {
    coordinator.unregisterRun(resumeRunId);
    await safeAbandon(store, resumeRunId, claim.claimId);
    return {
      error: formatBoundedStoreError(err, 'resume_setup_failed: '),
    };
  }

  return {
    durable: {
      started,
      lifecycle,
      coordinator,
      isResume: true,
      resume: resumePrompt,
      projectCwd,
      unitFor,
      beginUnit,
      endUnit,
      stampUnitSessionFile,
      markSessionPromptEstablished,
      persistAcpSessionId,
      expandFanout,
      resumePromptForUnit,
      markContinuationDelivered,
    },
    restoredChain,
  };
}

/** Synthesize a minimal unknown-source AgentConfig for an agent not found in discovery. */
function syntheticAgent(name: string): AgentConfig {
  return {
    name,
    description: '',
    systemPrompt: '',
    source: 'unknown' as AgentConfig['source'],
    filePath: '',
  };
}

/**
 * Map a workflow position to its stable canonical unit id.
 * Never derives identity from Object.keys order or mutable position fields.
 */
function resolveUnitId(
  mode: Mode,
  _unitIds: string[],
  step: number | undefined,
  fanoutIndex: number | undefined
): string {
  if (mode === 'single') return 'single';
  if (mode === 'parallel') {
    const idx = fanoutIndex ?? 0;
    return `parallel-${pad(idx + 1)}`;
  }
  // chain — resolve directly from immutable step/index; never index unitIds.
  if (fanoutIndex !== undefined) return chainFanoutUnitId(step ?? 1, fanoutIndex);
  return chainStepUnitId(step ?? 1);
}

/** Collect the resolved unit descriptors for initial record creation. */
function collectResolvedUnits(
  mode: Mode,
  params: Params,
  agents: AgentConfig[],
  ctx: ExtensionContext
): Array<{
  agent: AgentConfig;
  runtime: Runtime | undefined;
  effectiveCwd: string;
  step?: number;
  fanoutIndex?: number;
}> {
  if (mode === 'single') {
    // Exact topology name; synthetic fallback never substitutes agents[0].
    const name = params.agent ?? 'agent';
    const agent = agents.find((a) => a.name === name) ?? syntheticAgent(name);
    return [
      {
        agent,
        runtime: params.runtime ?? agent.runtime,
        effectiveCwd: params.cwd ?? ctx.cwd,
      },
    ];
  }
  if (mode === 'parallel') {
    const tasks = params.tasks ?? [];
    return tasks.map((t, i) => {
      const agent = agents.find((a) => a.name === t.agent) ?? syntheticAgent(t.agent);
      return {
        agent,
        runtime: params.runtime ?? agent.runtime,
        effectiveCwd: t.cwd ?? ctx.cwd,
        fanoutIndex: i,
      };
    });
  }
  // chain — only sequential steps have known cardinality; omit fanout descriptors.
  const chain = params.chain ?? [];
  const resolved: Array<{
    agent: AgentConfig;
    runtime: Runtime | undefined;
    effectiveCwd: string;
    step?: number;
    fanoutIndex?: number;
  }> = [];
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i] as {
      agent?: string;
      parallel?: { agent?: string };
      expand?: unknown;
    };
    if (entry && typeof entry === 'object' && 'expand' in entry && !('agent' in entry)) {
      continue;
    }
    const name = entry.agent ?? 'agent';
    const agent = agents.find((a) => a.name === name) ?? syntheticAgent(name);
    resolved.push({
      agent,
      runtime: params.runtime ?? agent.runtime,
      effectiveCwd: ctx.cwd,
      step: i + 1,
    });
  }
  return resolved;
}

function emptyErrorDetails(agentScope: AgentScope = 'both'): SubagentDetails {
  return {
    mode: 'single',
    agentScope,
    projectAgentsDir: null,
    builtinAgentsDir: getBuiltinAgentsDir(),
    results: [],
  };
}

export async function executeAgentTool(
  params: Params,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  ctx: ExtensionContext,
  options: ExecuteAgentToolOptions = {}
): Promise<AgentResult> {
  // Strict runId shape: present but empty/whitespace is a resume_error, not a fresh launch.
  if (params.runId !== undefined) {
    if (typeof params.runId !== 'string' || params.runId.trim().length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'resume_error: runId must be a non-empty string',
          },
        ],
        details: emptyErrorDetails(),
        isError: true,
      };
    }
  }
  // Resolve public runId resume before discovery so stored scope is authoritative.
  const publicRunId =
    typeof params.runId === 'string' && params.runId.trim().length > 0
      ? params.runId.trim()
      : undefined;
  let resumeDescriptor: ResumeDescriptor | undefined;
  let effectiveParams: Params = params;
  let discoveryCwd = ctx.cwd;
  let restoredProjectCwd: string | undefined;

  if (publicRunId) {
    const conflicts = collectResumeConflicts(params);
    if (conflicts.length > 0) {
      return {
        content: [
          {
            type: 'text',
            text: `resume_error: conflicting parameters for runId: ${conflicts.join(', ')}`,
          },
        ],
        details: emptyErrorDetails(),
        isError: true,
      };
    }
    if (!options.runStore || !options.runCoordinator) {
      return {
        content: [{ type: 'text', text: 'resume_error: persistence_not_configured' }],
        details: emptyErrorDetails(),
        isError: true,
      };
    }
    const loaded = options.runStore.getRun(publicRunId);
    if (!loaded.ok) {
      return {
        content: [
          {
            type: 'text',
            text: `resume_error: run_not_found: ${loaded.error.message}`,
          },
        ],
        details: emptyErrorDetails(),
        isError: true,
      };
    }
    const trimmedContinuation = params.task?.trim();
    resumeDescriptor = {
      runId: publicRunId,
      ...(trimmedContinuation ? { currentContinuationTask: trimmedContinuation } : {}),
    };
    effectiveParams = paramsFromStoredRequest(
      loaded.loaded.record.request,
      loaded.loaded.record.background
    );
    restoredProjectCwd = projectCwdFromRecord(loaded.loaded.record, ctx.cwd);
    discoveryCwd = restoredProjectCwd;
  }

  const agentScope: AgentScope = effectiveParams.agentScope ?? 'both';

  try {
    assertAgentDelegationAllowed(process.env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: message }],
      details: emptyErrorDetails(agentScope),
      isError: true,
    };
  }

  const discovery = discoverAgents(discoveryCwd, agentScope);
  const agents = discovery.agents;

  const hasChain = (effectiveParams.chain?.length ?? 0) > 0;
  const hasTasks = (effectiveParams.tasks?.length ?? 0) > 0;
  const hasSingle = Boolean(effectiveParams.agent && effectiveParams.task);
  const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

  const makeDetails: DetailsFactory =
    (mode) =>
    (results): SubagentDetails => ({
      mode,
      agentScope,
      projectAgentsDir: discovery.projectAgentsDir,
      builtinAgentsDir: discovery.builtinAgentsDir,
      results,
    });

  if (!resumeDescriptor) {
    if (modeCount !== 1) {
      const available = agents.map((a) => `${a.name} (${a.source})`).join(', ') || 'none';
      return {
        content: [
          {
            type: 'text',
            text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
          },
        ],
        details: makeDetails('single')([]),
      };
    }

    if (effectiveParams.tasks && effectiveParams.tasks.length > MAX_PARALLEL_TASKS) {
      return {
        content: [
          {
            type: 'text',
            text: `Too many parallel tasks (${effectiveParams.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
          },
        ],
        details: makeDetails('parallel')([]),
        isError: true,
      };
    }
  }

  let mode: Mode;
  if (effectiveParams.chain && effectiveParams.chain.length > 0) mode = 'chain';
  else if (effectiveParams.tasks && effectiveParams.tasks.length > 0) mode = 'parallel';
  else if (effectiveParams.agent && effectiveParams.task) mode = 'single';
  else {
    const available = agents.map((a) => `${a.name} (${a.source})`).join(', ') || 'none';
    return {
      content: [{ type: 'text', text: `Invalid parameters. Available agents: ${available}` }],
      details: makeDetails('single')([]),
    };
  }

  startProfile(mode ?? 'agent');

  // Start a durable run before launching the workflow (persistence optional).
  // When resumeDescriptor is set, resume the stored run instead of creating new.
  let durable: DurableRunContext | undefined;
  let restoredChain: import('./chain.ts').RestoredChainState | undefined;
  try {
    if (resumeDescriptor && options.runStore && options.runCoordinator) {
      const result = await maybeResumeDurableRun(resumeDescriptor, mode, options, ctx, agents);
      if ('error' in result) {
        // Result.error is already bounded by formatBoundedStoreError to 64KiB.
        return {
          content: [
            {
              type: 'text',
              text: result.error,
            },
          ],
          details: makeDetails(mode)([]),
          isError: true,
        };
      }
      durable = result.durable;
      restoredChain = result.restoredChain;
    } else {
      durable = await maybeStartDurableRun(
        effectiveParams,
        mode,
        agentScope,
        options,
        ctx,
        agents,
        makeDetails
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `run_store_error: ${message}` }],
      details: makeDetails(mode)([]),
      isError: true,
    };
  }

  const interactiveRegistry = options.interactiveRegistry;

  const spawnFn = options.spawnFn;

  const selectWorkflow = (
    workflowSignal: AbortSignal | undefined,
    workflowOnUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined
  ): Promise<AgentResult> => {
    if (mode === 'chain')
      return runChain(
        ctx,
        agents,
        effectiveParams.chain!,
        workflowSignal,
        workflowOnUpdate,
        makeDetails,
        effectiveParams.model,
        effectiveParams.thinking,
        effectiveParams.runtime,
        durable,
        restoredChain,
        interactiveRegistry,
        spawnFn,
        options.runStore
      );
    if (mode === 'parallel')
      return runParallel(
        ctx,
        agents,
        effectiveParams.tasks!,
        workflowSignal,
        workflowOnUpdate,
        makeDetails,
        effectiveParams.model,
        effectiveParams.thinking,
        effectiveParams.runtime,
        durable,
        interactiveRegistry,
        spawnFn
      );
    return runSingle(
      ctx,
      agents,
      effectiveParams.agent!,
      effectiveParams.task!,
      effectiveParams.cwd,
      effectiveParams.isolation,
      workflowSignal,
      workflowOnUpdate,
      makeDetails,
      effectiveParams.model,
      effectiveParams.thinking,
      effectiveParams.runtime,
      effectiveParams.title,
      durable,
      interactiveRegistry,
      spawnFn
    );
  };

  return await runWithBackgroundOption(
    effectiveParams,
    signal,
    onUpdate,
    ctx,
    agents,
    makeDetails,
    mode,
    options,
    durable,
    (workflowSignal, workflowOnUpdate) => selectWorkflow(workflowSignal, workflowOnUpdate)
  );
}

async function runWithBackgroundOption(
  params: Params,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  ctx: ExtensionContext,
  agents: AgentConfig[],
  makeDetails: DetailsFactory,
  mode: Mode,
  options: ExecuteAgentToolOptions,
  durable: DurableRunContext | undefined,
  runWorkflow: (
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined
  ) => Promise<AgentResult>
): Promise<AgentResult> {
  // Bridge Pi's incoming tool signal onto the coordinator-owned lifecycle so
  // an external abort is classified as `user` and shutdown as `session_shutdown`.
  if (durable) bridgeIncomingSignal(signal, durable.lifecycle);
  const runSignal = durable ? durable.lifecycle.signal : signal;
  // Wrap the upstream onUpdate so streaming persists durable snapshots.
  const persistUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined = durable
    ? (partial) => {
        if (onUpdate) onUpdate(partial);
        if (partial.details) {
          durable.coordinator.persist({
            runId: durable.started.runId,
            details: partial.details,
            units: durable.started.units,
          });
        }
      }
    : onUpdate;

  if (!params.runInBackground) {
    let result: AgentResult;
    try {
      if (options.runWorkflow)
        result = await options.runWorkflow(
          params,
          runSignal,
          persistUpdate,
          ctx,
          agents,
          makeDetails
        );
      else result = await runWorkflow(runSignal, persistUpdate);
    } catch (err) {
      await finalizeDurable(durable, err);
      throw err;
    }
    await finalizeDurable(durable, undefined, result);
    if (durable && result.details) {
      const finalStatus = durable.lifecycle.signal.aborted
        ? originToRunStatus(durable.lifecycle.origin)
        : result.isError
          ? 'failed'
          : 'completed';
      stampRunOnDetails(result.details, durable, finalStatus);
    }
    return result;
  }

  if (ctx.mode === 'json' || ctx.mode === 'print') {
    const error: AgentResult = {
      content: [
        {
          type: 'text',
          text: `Background agents require a long-lived TUI or RPC session; current mode "${ctx.mode}" exits after the tool returns. Re-run without runInBackground.`,
        },
      ],
      details: makeDetails(mode)([]),
      isError: true,
    };
    await finalizeDurable(durable, undefined, error);
    return error;
  }

  const manager = options.backgroundManager;
  if (!manager) {
    const error: AgentResult = {
      content: [
        {
          type: 'text',
          text: 'Background execution is not available in this session.',
        },
      ],
      details: makeDetails(mode)([]),
      isError: true,
    };
    await finalizeDurable(durable, undefined, error);
    return error;
  }

  const description = describeWorkflow(params, mode);
  const taskPreview = buildTaskPreview(params, mode);
  const title = extractLaunchTitle(params, mode);
  const projectAgentsDir = discoverAgents(
    durable?.projectCwd ?? ctx.cwd,
    params.agentScope ?? 'user'
  ).projectAgentsDir;

  const launchResult = manager.launch({
    mode,
    agentScope: params.agentScope ?? 'user',
    description,
    taskPreview,
    title,
    projectAgentsDir,
    run: (bgSignal) => {
      // Background jobs receive the manager's signal (which forwards shutdown
      // as session_shutdown through the coordinator-owned lifecycle when durable).
      const effectiveSignal = durable ? durable.lifecycle.signal : bgSignal;
      if (options.runWorkflow) {
        const copy = stripRunInBackground(params);
        return options.runWorkflow(copy, effectiveSignal, undefined, ctx, agents, makeDetails);
      }
      return runWorkflow(effectiveSignal, undefined);
    },
    ...(durable
      ? {
          durable: {
            runId: durable.started.runId,
            abort: (origin: RunAbortOrigin) => durable.lifecycle.abort(origin),
            finalize: (input: {
              success?: boolean;
              cancelled?: boolean;
              interrupted?: boolean;
              lastError?: string;
            }) =>
              durable.started.finalize({
                details: durable.started.record.details,
                units: durable.started.units,
                ...input,
              }),
            lifecycle: durable.lifecycle,
          },
        }
      : {}),
  });
  // If launch rejected (e.g. max jobs reached), the durable never started;
  // finalize it so the claim is released and the run records the failure.
  if (launchResult.isError && durable) {
    await finalizeDurable(durable, undefined, launchResult);
  }
  return launchResult;
}

function stripRunInBackground(params: Params): Params {
  const { runInBackground: _ignore, ...rest } = params;
  return rest as Params;
}

function describeWorkflow(params: Params, mode: Mode): string {
  if (mode === 'chain') return `chain (${params.chain?.length ?? 0} steps)`;
  if (mode === 'parallel') return `parallel (${params.tasks?.length ?? 0} tasks)`;
  return `${params.agent ?? 'agent'}: ${truncatePreview(params.task ?? '', 80)}`;
}

function buildTaskPreview(params: Params, mode: Mode): string {
  if (mode === 'chain') {
    const first = params.chain?.[0];
    if (!first) return '';
    const task = 'task' in first ? first.task : first.parallel.task;
    return truncatePreview(task, 120);
  }
  if (mode === 'parallel') {
    const first = params.tasks?.[0];
    return first ? truncatePreview(first.task, 120) : '';
  }
  return truncatePreview(params.task ?? '', 120);
}

/** Short launch label; for multi-task modes use the first item's title. */
function extractLaunchTitle(params: Params, mode: Mode): string | undefined {
  if (mode === 'single') return params.title;
  if (mode === 'parallel') return params.tasks?.[0]?.title;
  if (mode === 'chain') {
    const first = params.chain?.[0];
    if (!first) return undefined;
    if ('expand' in first) return first.parallel.title;
    return first.title;
  }
  return undefined;
}

function truncatePreview(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

async function runChain(
  ctx: ExtensionContext,
  agents: AgentConfig[],
  chain: NonNullable<Params['chain']>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  makeDetails: DetailsFactory,
  modelOverride?: string,
  thinkingOverride?: string,
  runtimeOverride?: Runtime,
  durable: DurableRunContext | undefined = undefined,
  restored?: import('./chain.ts').RestoredChainState,
  interactiveRegistry?: import('./interactive-agent.ts').InteractiveAgentRegistry,
  spawnFn?: import('./execution.ts').SpawnFn,
  runStore?: RunStore
): Promise<AgentResult> {
  const chainDetails = (results: SingleResult[], outputs?: Record<string, ChainOutputEntry>) => ({
    ...makeDetails('chain')(results),
    ...(outputs && Object.keys(outputs).length > 0 ? { outputs } : {}),
  });
  return runChainWorkflow({
    chain,
    signal,
    onUpdate,
    makeDetails: chainDetails,
    restored,
    ...(durable ? { onFanoutExpand: (req) => durable.expandFanout(req) } : {}),
    ...(runStore
      ? {
          resolveArtifact: async (
            ref: import('./run-types.ts').RunArtifactRefV1
          ): Promise<unknown> => {
            if (ref.mediaType === 'text/plain; charset=utf-8') {
              return runStore.readTextArtifact(ref.runId, ref);
            }
            return runStore.readJsonArtifact(ref.runId, ref);
          },
          externalizeChainOutput: {
            text: (text: string) =>
              externalizeTextPayload(runStore, durable?.started.runId, 'chain-output-text', text),
            json: (value: unknown) =>
              externalizeJsonPayload(
                runStore,
                durable?.started.runId,
                'chain-output-structured',
                value
              ),
          },
        }
      : {}),
    runStep: (req) =>
      runStepWithContext(
        ctx,
        agents,
        req.agent,
        req.task,
        req.cwd,
        req.isolation,
        req.taskIndex,
        req.step,
        req.signal,
        req.onUpdate,
        (results) => chainDetails(results),
        {
          skipCompletionCheck: req.skipCompletionCheck,
          modelOverride,
          thinkingOverride,
          runtimeOverride,
          title: req.title,
          ...(req.postprocessTerminal ? { postprocessTerminal: req.postprocessTerminal } : {}),
          ...(interactiveRegistry ? { interactiveRegistry } : {}),
          ...(spawnFn ? { spawnFn } : {}),
          ...(durable
            ? (() => {
                const unitContext = durable.unitFor(req.step, req.fanoutIndex, req.agent);
                if (req.requireArtifactReader) {
                  unitContext.requireArtifactReader = true;
                }
                return {
                  unitContext,
                  getAbortOrigin: () => durable.lifecycle.origin,
                  beginUnit: durable.beginUnit,
                  endUnit: durable.endUnit,
                  stampUnitSessionFile: (sf: string) =>
                    durable.stampUnitSessionFile(unitContext.unitId, sf),
                  ...(durable.markSessionPromptEstablished
                    ? {
                        markSessionPromptEstablished: () =>
                          durable.markSessionPromptEstablished!(unitContext.unitId),
                      }
                    : {}),
                  ...(durable.persistAcpSessionId
                    ? {
                        persistAcpSessionId: (id: string) =>
                          durable.persistAcpSessionId!(unitContext.unitId, id),
                      }
                    : {}),
                  ...(durable.resumePromptForUnit
                    ? { resumePrompt: durable.resumePromptForUnit(unitContext.unitId) }
                    : durable.resume
                      ? { resumePrompt: durable.resume }
                      : {}),
                  ...(durable.markContinuationDelivered
                    ? {
                        markContinuationDelivered: durable.markContinuationDelivered,
                      }
                    : {}),
                  ...(durable.projectCwd ? { projectCwd: durable.projectCwd } : {}),
                };
              })()
            : {}),
        }
      ),
  });
}

async function runParallel(
  ctx: ExtensionContext,
  agents: AgentConfig[],
  tasks: NonNullable<Params['tasks']>,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  makeDetails: DetailsFactory,
  modelOverride?: string,
  thinkingOverride?: string,
  runtimeOverride?: Runtime,
  durable: DurableRunContext | undefined = undefined,
  interactiveRegistry?: import('./interactive-agent.ts').InteractiveAgentRegistry,
  spawnFn?: import('./execution.ts').SpawnFn
): Promise<AgentResult> {
  if (tasks.length > MAX_PARALLEL_TASKS)
    return {
      content: [
        {
          type: 'text',
          text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
        },
      ],
      details: makeDetails('parallel')([]),
      isError: true,
    };

  // When resuming, skip by authoritative unit.status (stable unit ID), not lagging
  // details.results. Prefer unit.result; fall back to details only when consistent.
  const restoredResults = durable?.started.record.details.results ?? [];
  const allResults: SingleResult[] = tasks.map((t, index) => {
    const unitCtx = durable?.unitFor(undefined, index, t.agent);
    const unit = unitCtx ? durable?.started.units[unitCtx.unitId] : undefined;
    if (unit?.status === 'completed') {
      if (unit.result) return snapshotSingleResult(unit.result);
      const existing = restoredResults[index];
      if (existing && resolveExecutionStatus(existing) === 'completed') {
        return snapshotSingleResult(existing);
      }
      // Completed unit without a usable result: keep a completed slot so we do
      // not re-dispatch (selective resume leaves completed siblings alone).
      return {
        agent: t.agent,
        agentSource: 'unknown' as const,
        task: t.task,
        title: t.title,
        exitCode: 0,
        status: 'completed' as const,
        messages: [],
        stderr: '',
        usage: emptyUsage(),
        ...(unitCtx ? { unitId: unitCtx.unitId, runId: unitCtx.runId } : {}),
      };
    }
    return {
      agent: t.agent,
      agentSource: 'unknown' as const,
      task: t.task,
      title: t.title,
      exitCode: -1,
      status: 'queued' as const,
      messages: [],
      stderr: '',
      usage: emptyUsage(),
    };
  });

  const emitParallelSnapshot = () => {
    if (!onUpdate) return;
    // Copy-on-write: new array + shell clones; share frozen presentation/structuredOutput.
    const snapshot = allResults.map(copySnapshotShell);
    const running = snapshot.filter((r) => resolveExecutionStatus(r) === 'running').length;
    const done = snapshot.filter((r) => {
      const s = resolveExecutionStatus(r);
      return s === 'completed' || s === 'failed' || s === 'cancelled';
    }).length;
    onUpdate({
      content: [
        {
          type: 'text',
          text: `Parallel: ${done}/${snapshot.length} done, ${running} running...`,
        },
      ],
      details: makeDetails('parallel')(snapshot),
    });
  };
  // Structural transitions flush immediately; content/usage partials are coalesced.
  const contentCoalescer = createLatestValueCoalescer<void>(() => {
    emitParallelSnapshot();
  }, RESULT_UPDATE_INTERVAL_MS);
  const emitParallelUpdate = (mode: 'immediate' | 'content' = 'immediate') => {
    if (mode === 'content') {
      contentCoalescer.schedule(undefined);
      return;
    }
    contentCoalescer.cancel();
    emitParallelSnapshot();
  };

  emitParallelUpdate('immediate');

  const makeCancelledSlot = (t: (typeof tasks)[number], index: number): SingleResult => {
    const cancelled = copySnapshotShell(allResults[index]);
    cancelled.agent = t.agent;
    cancelled.task = t.task;
    cancelled.exitCode = 1;
    cancelled.status = 'cancelled';
    cancelled.stopReason = 'aborted';
    cancelled.errorMessage = cancelled.errorMessage || ABORT_MESSAGE;
    return cancelled;
  };

  let results: SingleResult[];
  try {
    results = await mapWithConcurrencyLimit(
      tasks,
      MAX_CONCURRENCY,
      async (t, index) => {
        // Skip by unit.status / restored completed slot (not lagging details alone).
        if (resolveExecutionStatus(allResults[index]) === 'completed') {
          emitParallelUpdate('immediate');
          return allResults[index];
        }
        const unitCtx = durable?.unitFor(undefined, index, t.agent);
        {
          const runningShell = copySnapshotShell(allResults[index]);
          runningShell.status = 'running';
          runningShell.exitCode = -1;
          allResults[index] = runningShell;
        }
        emitParallelUpdate();

        try {
          const result = await runStepWithContext(
            ctx,
            agents,
            t.agent,
            t.task,
            t.cwd ?? unitCtx?.effectiveCwd,
            t.isolation,
            index,
            undefined,
            signal,
            (partial) => {
              if (partial.details?.results[0]) {
                const partialResult = partial.details.results[0];
                const shell = copySnapshotShell(partialResult);
                shell.status = shell.status ?? 'running';
                allResults[index] = shell;
                emitParallelUpdate('content');
              }
            },
            makeDetails('parallel'),
            {
              modelOverride,
              thinkingOverride,
              runtimeOverride,
              title: t.title,
              ...(interactiveRegistry ? { interactiveRegistry } : {}),
              ...(spawnFn ? { spawnFn } : {}),
              ...(durable && unitCtx
                ? {
                    unitContext: unitCtx,
                    getAbortOrigin: () => durable.lifecycle.origin,
                    stampUnitSessionFile: (sf: string) =>
                      durable.stampUnitSessionFile(unitCtx.unitId, sf),
                    beginUnit: durable.beginUnit,
                    endUnit: durable.endUnit,
                    ...(durable.markSessionPromptEstablished
                      ? {
                          markSessionPromptEstablished: () =>
                            durable.markSessionPromptEstablished!(unitCtx.unitId),
                        }
                      : {}),
                    ...(durable.persistAcpSessionId
                      ? {
                          persistAcpSessionId: (id: string) =>
                            durable.persistAcpSessionId!(unitCtx.unitId, id),
                        }
                      : {}),
                    ...(durable.resumePromptForUnit
                      ? { resumePrompt: durable.resumePromptForUnit(unitCtx.unitId) }
                      : durable.resume
                        ? { resumePrompt: durable.resume }
                        : {}),
                    ...(durable.markContinuationDelivered
                      ? {
                          markContinuationDelivered: durable.markContinuationDelivered,
                        }
                      : {}),
                    ...(durable.projectCwd ? { projectCwd: durable.projectCwd } : {}),
                  }
                : {}),
            }
          );
          // Always store a private compact shell; never alias the returned endUnit object.
          let stored = snapshotSingleResult(result);
          if (!stored.status || stored.status === 'running') {
            const working = cloneSingleResult(stored);
            applyTerminalStatus(working);
            stored = snapshotSingleResult(working);
          }
          allResults[index] = stored;
          emitParallelUpdate();
          return stored;
        } catch (err) {
          if (isAbortError(err)) {
            const fromErr = getAbortResult(err);
            let cancelled: SingleResult;
            if (fromErr) {
              cancelled = copySnapshotShell(fromErr);
              cancelled.status = 'cancelled';
              cancelled.stopReason = fromErr.stopReason ?? 'aborted';
            } else {
              cancelled = makeCancelledSlot(t, index);
            }
            if (cancelled.exitCode === 0 || cancelled.exitCode === -1) cancelled.exitCode = 1;
            allResults[index] = cancelled;
            emitParallelUpdate();
            return cancelled;
          }
          throw err;
        }
      },
      {
        signal,
        onUnstarted: (t, index) => {
          const cancelled = makeCancelledSlot(t, index);
          allResults[index] = cancelled;
          return cancelled;
        },
      }
    );
  } finally {
    contentCoalescer.cancel();
  }
  emitParallelUpdate('immediate');

  const successCount = results.filter((r) => !isFailedResult(r)).length;
  const cancelledCount = results.filter((r) => resolveExecutionStatus(r) === 'cancelled').length;
  const summaries = results.map((r) => {
    const output =
      isFailedResult(r) || resolveExecutionStatus(r) === 'cancelled'
        ? truncateParallelOutput(getResultOutput(r))
        : truncateParallelOutput(getResultParentOutput(r));
    const status =
      resolveExecutionStatus(r) === 'cancelled'
        ? 'cancelled'
        : isFailedResult(r)
          ? `failed${r.stopReason && r.stopReason !== 'end' ? ` (${r.stopReason})` : ''}`
          : 'completed';
    return `### [${r.agent}] ${status}\n\n${output}`;
  });
  return {
    content: [
      {
        type: 'text',
        text:
          cancelledCount > 0
            ? `Parallel cancelled: ${successCount}/${results.length} succeeded\n\n${summaries.join('\n\n---\n\n')}`
            : `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join('\n\n---\n\n')}`,
      },
    ],
    details: makeDetails('parallel')(results.map(copySnapshotShell)),
    ...(cancelledCount > 0 || successCount < results.length ? { isError: true } : {}),
  };
}

async function runSingle(
  ctx: ExtensionContext,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  isolation: IsolationMode | undefined,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  makeDetails: DetailsFactory,
  modelOverride?: string,
  thinkingOverride?: string,
  runtimeOverride?: Runtime,
  title?: string,
  durable: DurableRunContext | undefined = undefined,
  interactiveRegistry?: import('./interactive-agent.ts').InteractiveAgentRegistry,
  spawnFn?: import('./execution.ts').SpawnFn
): Promise<AgentResult> {
  // Reject resume when the sole unit is already completed (unit.status is
  // authoritative; details.results alone must not skip incomplete units).
  if (durable) {
    const unitCtx = durable.unitFor(undefined, undefined, agentName);
    const unit = durable.started.units[unitCtx.unitId];
    if (unit?.status === 'completed') {
      const existing =
        unit.result ??
        (durable.started.record.details.results ?? []).find(
          (r) => resolveExecutionStatus(r) === 'completed'
        );
      if (existing) {
        return {
          content: [
            {
              type: 'text',
              text: 'Run already completed; nothing to resume.',
            },
          ],
          details: makeDetails('single')([existing]),
        };
      }
    }
  }
  try {
    const unitCtx = durable?.unitFor(undefined, undefined, agentName);
    const result = await runStepWithContext(
      ctx,
      agents,
      agentName,
      task,
      cwd ?? unitCtx?.effectiveCwd,
      isolation,
      0,
      undefined,
      signal,
      onUpdate,
      makeDetails('single'),
      {
        modelOverride,
        thinkingOverride,
        runtimeOverride,
        title,
        ...(interactiveRegistry ? { interactiveRegistry } : {}),
        ...(spawnFn ? { spawnFn } : {}),
        ...(durable && unitCtx
          ? {
              unitContext: unitCtx,
              getAbortOrigin: () => durable.lifecycle.origin,
              beginUnit: durable.beginUnit,
              endUnit: durable.endUnit,
              stampUnitSessionFile: (sf: string) =>
                durable.stampUnitSessionFile(unitCtx.unitId, sf),
              ...(durable.markSessionPromptEstablished
                ? {
                    markSessionPromptEstablished: () =>
                      durable.markSessionPromptEstablished!(unitCtx.unitId),
                  }
                : {}),
              ...(durable.persistAcpSessionId
                ? {
                    persistAcpSessionId: (id: string) =>
                      durable.persistAcpSessionId!(unitCtx.unitId, id),
                  }
                : {}),
              ...(durable.resumePromptForUnit
                ? { resumePrompt: durable.resumePromptForUnit(unitCtx.unitId) }
                : durable.resume
                  ? { resumePrompt: durable.resume }
                  : {}),
              ...(durable.markContinuationDelivered
                ? { markContinuationDelivered: durable.markContinuationDelivered }
                : {}),
              ...(durable.projectCwd ? { projectCwd: durable.projectCwd } : {}),
            }
          : {}),
      }
    );
    if (isFailedResult(result) || resolveExecutionStatus(result) === 'cancelled') {
      const errorMsg = getResultOutput(result);
      return {
        content: [
          {
            type: 'text',
            text: `Agent ${result.stopReason || resolveExecutionStatus(result)}: ${errorMsg}`,
          },
        ],
        details: makeDetails('single')([snapshotSingleResult(result)]),
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: getResultParentOutput(result) || '(no output)' }],
      details: makeDetails('single')([snapshotSingleResult(result)]),
    };
  } catch (err) {
    if (isAbortError(err)) {
      const result =
        getAbortResult(err) ??
        ({
          agent: agentName,
          agentSource: 'unknown' as const,
          task,
          title,
          exitCode: 1,
          status: 'cancelled' as const,
          messages: [],
          stderr: ABORT_MESSAGE,
          usage: emptyUsage(),
          stopReason: 'aborted',
          errorMessage: ABORT_MESSAGE,
        } satisfies SingleResult);
      return {
        content: [{ type: 'text', text: `Agent cancelled: ${getResultOutput(result)}` }],
        details: makeDetails('single')([snapshotSingleResult(result)]),
        isError: true,
      };
    }
    throw err;
  }
}

function resolveIsolation(
  agent: AgentConfig,
  taskIsolation: IsolationMode | undefined
): IsolationMode {
  return taskIsolation ?? agent.isolation ?? 'none';
}

async function runStepWithContext(
  ctx: ExtensionContext,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  taskIsolation: IsolationMode | undefined,
  taskIndex: number,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  options: {
    skipCompletionCheck?: boolean;
    modelOverride?: string;
    thinkingOverride?: string;
    runtimeOverride?: Runtime;
    title?: string;
    unitContext?: UnitExecutionContext;
    getAbortOrigin?: () => RunAbortOrigin;
    stampUnitSessionFile?: (sessionFile: string) => void | Promise<void>;
    beginUnit?: (ctx: UnitExecutionContext) => void | Promise<void>;
    endUnit?: (
      ctx: UnitExecutionContext,
      result: SingleResult,
      status: ExecutionStatus
    ) => void | Promise<void | SingleResult>;
    /** Runs before worktree cleanup and durable endUnit (schema validation, metadata). */
    postprocessTerminal?: (result: SingleResult) => void;
    interactiveRegistry?: import('./interactive-agent.ts').InteractiveAgentRegistry;
    /** Durable resume prompt context (session continuation vs original task). */
    resumePrompt?: ResumePromptContext;
    /** Mark continuation delivery (Pi: after accept; Grok ACP: after prompt completed). */
    markContinuationDelivered?: (unitId: string) => void | Promise<void>;
    /** Strict Pi original-prompt establishment after spawn/RPC activate. */
    markSessionPromptEstablished?: () => Promise<void>;
    /** Strict Grok ACP session-ID persistence before the first prompt. */
    persistAcpSessionId?: (sessionId: string) => Promise<void>;
    /** Restored project/workspace cwd for resume (overrides ctx.cwd for git/cwd fallbacks). */
    projectCwd?: string;
    spawnFn?: import('./execution.ts').SpawnFn;
  } = {}
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);
  // Capture before prepareAgentContext may create a new session for never-started units.
  // Pi: only a session whose original prompt was confirmed counts as stored.
  // Explicit sessionPromptEstablished === false is the stamp-before-prompt crash
  // window and must not flip resumeHadStoredSession (preflight fail-closes it).
  // Legacy units without the field still count when a sessionFile is present.
  // Grok ACP: protocol session ID. Never-started units never count as prior.
  const hadStoredSession =
    options.unitContext?.neverStarted !== true &&
    (Boolean(options.unitContext?.acpSessionId) ||
      (Boolean(options.unitContext?.sessionFile) &&
        options.unitContext?.sessionPromptEstablished !== false));
  // Prefer explicit task cwd, then persisted unit effectiveCwd, then project cwd.
  const fallbackCwd = cwd ?? options.unitContext?.effectiveCwd ?? options.projectCwd ?? ctx.cwd;
  // Declared early so the terminal finalizer can close over them. Populated when
  // worktree isolation is active; success path requests finalization after postprocess.
  let worktree: AgentWorktree | undefined;
  let retainCleanWorktree = false;
  let pendingWorktreeFinalization = false;
  /**
   * Terminal compaction boundary for every exit:
   * 1. terminal postprocess/schema/status/identity exactly once
   * 2. worktree finalization using the final terminal status (success path only)
   * 3. compact snapshot
   * 4. endUnit/durability
   * 5. return authoritative compact result
   * Abort/early-failure paths handle worktree retention themselves before calling this;
   * they leave pendingWorktreeFinalization false so finalizeWorktree is not re-applied.
   */
  const finalizeTerminalResult = async (
    working: SingleResult,
    status?: ExecutionStatus
  ): Promise<SingleResult> => {
    if (options.postprocessTerminal) options.postprocessTerminal(working);
    if (working.finalOutput === undefined && working.messages.length > 0) {
      working.finalOutput = getResultFinalOutput(working);
    }
    // Worktree finalization must observe the postprocess-final status (e.g. schema
    // failure retains a clean tree instead of deleting it as completed).
    if (pendingWorktreeFinalization && worktree) {
      pendingWorktreeFinalization = false;
      finalizeWorktree(worktree, working, { retainClean: retainCleanWorktree });
    }
    // Authoritative unit/result path agreement: only retained existing worktrees
    // keep a durable path. Deleted clean trees must clear unit + result metadata.
    if (options.unitContext) {
      if (working.worktreePath) {
        options.unitContext.worktreePath = working.worktreePath;
      } else {
        delete options.unitContext.worktreePath;
      }
    }
    // Pass the private unsnapshotted result to endUnit so finishUnit externalizes
    // oversized authority before snapshotSingleResult. Snapshot directly only when
    // endUnit is unavailable (non-durable paths).
    if (options.unitContext && options.endUnit) {
      const committed = await options.endUnit(
        options.unitContext,
        working,
        status ?? resolveExecutionStatus(working)
      );
      // Prefer the artifact-aware snapshot returned by finishUnit when present.
      if (committed && typeof committed === 'object' && 'agent' in committed) {
        return committed as SingleResult;
      }
    }
    return snapshotSingleResult(working);
  };
  if (!agent) {
    const failed = await runSingleAgent(
      fallbackCwd,
      agents,
      agentName,
      task,
      cwd,
      step,
      signal,
      onUpdate,
      makeDetails,
      {
        modelOverride: options.modelOverride,
        thinkingOverride: options.thinkingOverride,
        runtimeOverride: options.runtimeOverride,
        title: options.title,
        ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
        ...(options.unitContext ? { unitContext: options.unitContext } : {}),
        ...(options.getAbortOrigin ? { getAbortOrigin: options.getAbortOrigin } : {}),
        ...(options.resumePrompt
          ? {
              resumePrompt: options.resumePrompt,
              resumeHadStoredSession: hadStoredSession,
            }
          : {}),
      }
    );
    return await finalizeTerminalResult(failed, 'failed');
  }

  const effectiveRuntime: Runtime | undefined = options.runtimeOverride ?? agent.runtime;

  const isGrokFamily = effectiveRuntime === GROK_ACP_RUNTIME;

  let resolvedSkillPaths: string[] | undefined;
  if (isGrokFamily) {
    if (agent.skills && agent.skills.length > 0) {
      ctx.ui.notify(
        `Agent "${agentName}" uses runtime: ${effectiveRuntime}; skills are ignored (not transferable to Grok).`,
        'warning'
      );
    }
  } else if (agent.skills && agent.skills.length > 0) {
    const { resolved, missing } = resolveSkillNames(agent.skills);
    if (missing.length > 0) {
      const available = listAvailableSkillNames();
      const MAX_LIST = 20;
      const availableText =
        available.length === 0
          ? 'none'
          : available.length > MAX_LIST
            ? `${available.slice(0, MAX_LIST).join(', ')}, +${available.length - MAX_LIST} more`
            : available.join(', ');
      const failure = synthesizeFailure(
        agentName,
        agent,
        task,
        step,
        'skill_error',
        `Cannot resolve skill name(s): ${missing.join(', ')}. Available skills: ${availableText}.`,
        options.title
      );
      return await finalizeTerminalResult(failure, 'failed');
    }
    resolvedSkillPaths = resolved;
  }

  // Select/create the worktree before creating the Pi session so the session
  // header cwd matches the actual child cwd. On resume, reopen the stored
  // worktree instead of creating a new one.
  const isolation = resolveIsolation(agent, taskIsolation);
  let effectiveCwd: string | undefined = cwd ?? options.unitContext?.effectiveCwd;
  const storedWorktreePath = options.unitContext?.worktreePath;
  const gitLookupCwd = options.unitContext?.effectiveCwd ?? options.projectCwd ?? cwd ?? ctx.cwd;
  if (isolation === 'worktree') {
    if (storedWorktreePath) {
      // Resume: reopen the stored worktree without recreating or re-running hooks.
      // Prefer deriving repo root from the stored worktree path, then unit cwd.
      const repoRoot =
        getGitRoot(path.resolve(storedWorktreePath, '..', '..')) ?? getGitRoot(gitLookupCwd);
      if (!repoRoot) {
        const failure1 = synthesizeFailure(
          agentName,
          agent,
          task,
          step,
          'isolation_error',
          'Worktree isolation requires a git repository.',
          options.title
        );
        return await finalizeTerminalResult(failure1, 'failed');
      }
      const opened = openAgentWorktree(repoRoot, storedWorktreePath);
      if (!opened.ok) {
        const failure2 = synthesizeFailure(
          agentName,
          agent,
          task,
          step,
          'isolation_error',
          opened.error,
          options.title
        );
        return await finalizeTerminalResult(failure2, 'failed');
      }
      worktree = opened.worktree;
      effectiveCwd = worktree.path;
    } else {
      const repoRoot = getGitRoot(gitLookupCwd);
      if (!repoRoot) {
        const failure3 = synthesizeFailure(
          agentName,
          agent,
          task,
          step,
          'isolation_error',
          'Worktree isolation requires a git repository.',
          options.title
        );
        return await finalizeTerminalResult(failure3, 'failed');
      }
      try {
        worktree = createAgentWorktree(repoRoot, agentName, taskIndex);
        effectiveCwd = worktree.path;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const failure5 = synthesizeFailure(
          agentName,
          agent,
          task,
          step,
          'isolation_error',
          message,
          options.title
        );
        return await finalizeTerminalResult(failure5, 'failed');
      }

      if (agent.worktreeSetupHook) {
        const failure = runHookOrSynthesizeFailure(
          agentName,
          agent,
          task,
          step,
          worktree,
          options.title
        );
        if (failure) {
          // runHookOrSynthesizeFailure already made the sole retain/remove decision.
          // Retained (dirty/unknown/removal-failed) trees stay on disk with path metadata;
          // only confirmed clean removals leave worktreePath unset.
          if (!failure.worktreePath) {
            worktree = undefined;
          }
          return await finalizeTerminalResult(failure, 'failed');
        }
      }
    }
  }

  let agentContext;
  try {
    if (isGrokFamily) {
      if (agent.defaultContext === 'fork') {
        ctx.ui.notify(
          `Agent "${agentName}" uses runtime: ${effectiveRuntime}; defaultContext: fork is ignored (runs as fresh).`,
          'warning'
        );
      }
      agentContext = {
        mode: 'fresh' as const,
        sessionFile: undefined,
        cleanup: async () => {},
      };
    } else {
      agentContext = prepareAgentContext(agent, ctx, {
        effectiveCwd: effectiveCwd ?? fallbackCwd,
        ...(options.unitContext?.runId !== undefined ? { runId: options.unitContext.runId } : {}),
        ...(options.unitContext?.unitId !== undefined
          ? { unitId: options.unitContext.unitId }
          : {}),
        ...(options.unitContext?.sessionsDir !== undefined
          ? { sessionsDir: options.unitContext.sessionsDir }
          : {}),
        // Only pass storedSessionFile when the unit already owned a session
        // before this invocation (hadStoredSession). A just-created path is
        // stamped after prepare so result metadata stays correct.
        ...(hadStoredSession && options.unitContext?.sessionFile !== undefined
          ? { storedSessionFile: options.unitContext.sessionFile }
          : {}),
      });
    }
  } catch (err) {
    // Pre-execution context failure: only remove owned-new clean worktrees.
    const message = err instanceof Error ? err.message : String(err);
    const failure4 = attachErrorStack(
      synthesizeFailure(agentName, agent, task, step, 'context_error', message, options.title),
      err
    );
    if (worktree && !storedWorktreePath) {
      const status = getWorktreeDirtyStatus(worktree.path);
      if (status.ok && status.output.trim().length === 0) {
        const removal = removeAgentWorktree(worktree);
        if (removal.removed) {
          worktree = undefined;
        } else {
          // Removal failed: retain path so durability/resume can inspect the orphan.
          failure4.worktreePath = worktree.path;
          failure4.worktreeDirty = false;
          failure4.stderr += failure4.stderr ? '\n' : '';
          failure4.stderr += `Worktree cleanup failed: ${removal.error ?? 'unknown'}. Retaining ${worktree.path}.`;
        }
      } else {
        failure4.worktreePath = worktree.path;
        failure4.worktreeDirty = status.ok ? status.output.trim().length > 0 : true;
        if (failure4.worktreeDirty) {
          const diff = getWorktreeDiffSummary(worktree.path);
          if (diff.ok) {
            if (diff.stat) failure4.worktreeDiffStat = diff.stat;
            if (diff.changedFiles) failure4.worktreeChangedFiles = diff.changedFiles;
          }
        }
      }
    } else if (storedWorktreePath) {
      failure4.worktreePath = storedWorktreePath;
      const dirty = getWorktreeDirtyStatus(storedWorktreePath);
      failure4.worktreeDirty = dirty.ok ? dirty.output.trim().length > 0 : true;
    }
    return await finalizeTerminalResult(failure4, 'failed');
  }

  // Interactive TUI registration: Pi (pre-spawn with session file) or Grok ACP
  // (resume with stored acpSessionId). Fresh Grok ACP registers after session/new.
  let endpointKey: string | undefined;
  const isGrokAcp = effectiveRuntime === GROK_ACP_RUNTIME;
  const acpSessionId = options.unitContext?.acpSessionId?.trim();
  const canRegisterInteractivePi =
    ctx.mode === 'tui' &&
    options.interactiveRegistry &&
    options.unitContext &&
    agentContext.sessionFile &&
    !isGrokFamily;
  const canRegisterInteractiveGrokAcp =
    ctx.mode === 'tui' &&
    options.interactiveRegistry &&
    options.unitContext &&
    isGrokAcp &&
    Boolean(acpSessionId);
  // Whether a worktree was created for this invocation (vs reopened stored path).
  const createdNewWorktree = Boolean(worktree && !storedWorktreePath);
  // Artifact handoffs require the Pi-only reader extension; reject Grok ACP early.
  if (options.unitContext?.requireArtifactReader && isGrokAcp) {
    const failure = {
      agent: agentName,
      agentSource: agent.source ?? ('unknown' as const),
      task,
      title: options.title,
      exitCode: 1,
      status: 'failed' as const,
      messages: [] as SingleResult['messages'],
      stderr: 'artifact_handoff_unsupported',
      usage: emptyUsage(),
      stopReason: 'error',
      errorCode: 'artifact_handoff_unsupported',
      errorMessage:
        'Artifact handoffs are not supported for runtime grok-acp; use pi runtime for oversized chain outputs.',
    };
    return await finalizeTerminalResult(failure, 'failed');
  }

  // True once beginUnit has been called (spawn may have side effects).
  let beganUnit = false;
  // True once runSingleAgent is entered (child may have modified the worktree).
  let executionStarted = false;
  // Crash-window detection must use pre-stamp durable state: a first path write
  // this turn sets sessionPromptEstablished false and still sends the original
  // prompt. Only a prior unestablished path fail-closes resume.
  const priorUnestablishedSession =
    options.unitContext?.neverStarted !== true &&
    Boolean(options.unitContext?.sessionFile?.trim()) &&
    options.unitContext?.sessionPromptEstablished === false;

  /** Stamp worktree path + dirty diagnostics onto a failure result. */
  const stampWorktreeOnFailure = (failure: SingleResult): void => {
    if (!worktree) return;
    failure.worktreePath = worktree.path;
    const status = getWorktreeDirtyStatus(worktree.path);
    failure.worktreeDirty = status.ok ? status.output.trim().length > 0 : true;
    if (failure.worktreeDirty) {
      const diff = getWorktreeDiffSummary(worktree.path);
      if (diff.ok) {
        if (diff.stat) failure.worktreeDiffStat = diff.stat;
        if (diff.changedFiles) failure.worktreeChangedFiles = diff.changedFiles;
      }
    }
  };

  /**
   * Remove an owned-new worktree only when execution never started and the tree
   * is confirmed clean. Once execution starts or the tree is dirty/unknown,
   * retain it and stamp diagnostics on the failure result.
   */
  const maybeRemoveOwnedCleanWorktree = (failure?: SingleResult): boolean => {
    if (!worktree || !createdNewWorktree || executionStarted) {
      if (worktree && failure) stampWorktreeOnFailure(failure);
      return false;
    }
    const status = getWorktreeDirtyStatus(worktree.path);
    if (!status.ok || status.output.trim().length > 0) {
      if (failure) stampWorktreeOnFailure(failure);
      return false;
    }
    const removal = removeAgentWorktree(worktree);
    if (!removal.removed) {
      // Keep durable path/dirty metadata when cleanup fails so the orphan is inspectable.
      if (failure) {
        failure.worktreePath = worktree.path;
        failure.worktreeDirty = false;
        delete failure.worktreeDiffStat;
        delete failure.worktreeChangedFiles;
        failure.stderr += failure.stderr ? '\n' : '';
        failure.stderr += `Worktree cleanup failed: ${removal.error ?? 'unknown'}. Retaining ${worktree.path}.`;
      }
      if (options.unitContext) {
        options.unitContext.worktreePath = worktree.path;
      }
      return false;
    }
    // Clear path only after confirmed removal so endUnit cannot persist a missing tree.
    if (failure) {
      delete failure.worktreePath;
      delete failure.worktreeDirty;
      delete failure.worktreeDiffStat;
      delete failure.worktreeChangedFiles;
    }
    if (options.unitContext) {
      delete options.unitContext.worktreePath;
    }
    worktree = undefined;
    return true;
  };

  // Unified cleanup boundary. Durable begin runs first so crash recovery sees an
  // attempted unit before session stamp/register; only owned-new worktrees are
  // removed on failure (never stored resume paths, dirty or clean).
  try {
    // Stamp the worktree path onto the unit context before begin so durable
    // attempt history records the reopen path.
    if (options.unitContext && worktree) {
      options.unitContext.worktreePath = worktree.path;
    }

    // Await durable unit_started + attempt write before stamp/register so a crash
    // never leaves a stamped session path on a still never-started unit.
    if (options.unitContext && options.beginUnit) {
      await options.beginUnit(options.unitContext);
      beganUnit = true;
    }

    // Strict first-write of a newly prepared Pi session path (or idempotent
    // restamp of an existing path). Do not mutate unitContext until success so
    // a conflict/disk failure cannot leave a live-only uncommitted path.
    // First path write records sessionPromptEstablished: false; restamp of an
    // existing path must not regress legacy (undefined) or true.
    if (options.unitContext && agentContext.sessionFile) {
      const priorPath = Boolean(options.unitContext.sessionFile?.trim());
      const priorEstablished = options.unitContext.sessionPromptEstablished;
      await options.stampUnitSessionFile?.(agentContext.sessionFile);
      options.unitContext.sessionFile = agentContext.sessionFile;
      if (priorEstablished === true) {
        options.unitContext.sessionPromptEstablished = true;
      } else if (!priorPath) {
        options.unitContext.sessionPromptEstablished = false;
      } else if (priorEstablished === false) {
        options.unitContext.sessionPromptEstablished = false;
      }
      // else: legacy resume (path already present, field absent) — leave undefined
    }

    if (
      (canRegisterInteractivePi || canRegisterInteractiveGrokAcp) &&
      options.interactiveRegistry &&
      options.unitContext
    ) {
      try {
        const hostSessionId = ctx.sessionManager.getSessionId();
        const unitCtx = options.unitContext;
        const launchAgent: AgentConfig = {
          ...agent,
          model: options.modelOverride ?? agent.model,
          thinking: options.thinkingOverride ?? agent.thinking,
          runtime: options.runtimeOverride ?? agent.runtime,
        };
        const sessionArtifact = isGrokAcp
          ? ({ runtime: 'grok-acp' as const, sessionId: acpSessionId! } as const)
          : ({ runtime: 'pi' as const, sessionFile: agentContext.sessionFile! } as const);
        const snap = await options.interactiveRegistry.registerInitial({
          runId: unitCtx.runId,
          unitId: unitCtx.unitId,
          hostSessionId,
          launchSpec: {
            agent: launchAgent,
            request: {
              mode: 'single',
              agentScope: 'both',
              model: options.modelOverride,
              thinking: options.thinkingOverride,
              runtime: options.runtimeOverride,
              isolation: resolveIsolation(agent, taskIsolation),
              agent: agentName,
              task,
              title: options.title,
              cwd: effectiveCwd ?? fallbackCwd,
            },
            resolvedSkillPaths,
            sessionFile: agentContext.sessionFile ?? '',
            sessionArtifact,
            effectiveCwd: effectiveCwd ?? fallbackCwd,
            worktreePath: worktree?.path,
            title: options.title,
            modelOverride: options.modelOverride,
            thinkingOverride: options.thinkingOverride,
            runtimeOverride: options.runtimeOverride,
            isolation: resolveIsolation(agent, taskIsolation),
            agentScope: 'both',
            registrationKind: 'initial',
            ...(unitCtx.requireArtifactReader ? { requireArtifactReader: true } : {}),
          },
          getBranchEntries: () =>
            ctx.sessionManager.getBranch().map((e) => {
              if (e.type === 'custom') {
                return {
                  type: 'custom',
                  customType: (e as { customType?: string }).customType,
                  data: (e as { data?: unknown }).data,
                };
              }
              return { type: e.type };
            }),
        });
        endpointKey = snap.key;
        retainCleanWorktree = true;
      } catch (err) {
        // Pre-execution register failure: only remove owned-new clean trees.
        const message = err instanceof Error ? err.message : String(err);
        // Preserve formal structured codes (validation_error, dispose_failed, acp_*, …).
        const formalCode =
          err &&
          typeof err === 'object' &&
          'code' in err &&
          typeof (err as { code?: unknown }).code === 'string'
            ? (err as { code: string }).code
            : undefined;
        const failure = attachErrorStack(
          synthesizeFailure(
            agentName,
            agent,
            task,
            step,
            formalCode ?? 'error',
            `Interactive link registration failed: ${message}`,
            options.title
          ),
          err
        );
        if (formalCode) failure.errorCode = formalCode;
        maybeRemoveOwnedCleanWorktree(failure);
        return await finalizeTerminalResult(failure, 'failed');
      }
    }

    // Fail closed before spawn when this invocation began with an attempted Pi
    // unit that already had a session path with original prompt unconfirmed
    // (prior stamp-before-prompt crash window). Do not send continuation-only
    // and do not auto-replay the original task. A first path write this turn
    // still proceeds to send the original prompt and then mark established.
    if (options.resumePrompt && !isGrokFamily && priorUnestablishedSession) {
      const failure = synthesizeFailure(
        agentName,
        agent,
        task,
        step,
        'session_prompt_unestablished',
        'Original prompt was never established for this Pi session (session_prompt_unestablished). Resume is blocked; do not continuation-only and do not auto-replay the original task.',
        options.title
      );
      failure.errorCode = 'session_prompt_unestablished';
      maybeRemoveOwnedCleanWorktree(failure);
      return await finalizeTerminalResult(failure, 'failed');
    }

    executionStarted = true;
    const result = await runSingleAgent(
      fallbackCwd,
      agents,
      agentName,
      task,
      effectiveCwd ?? fallbackCwd,
      step,
      signal,
      onUpdate,
      makeDetails,
      {
        sessionFile: agentContext.sessionFile,
        resolvedSkillPaths,
        modelOverride: options.modelOverride,
        thinkingOverride: options.thinkingOverride,
        runtimeOverride: options.runtimeOverride,
        title: options.title,
        hostMode: ctx.mode,
        ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
        ...(options.unitContext ? { unitContext: options.unitContext } : {}),
        ...(options.getAbortOrigin ? { getAbortOrigin: options.getAbortOrigin } : {}),
        // Pi: durable original-prompt establishment after spawn/RPC activate.
        ...(!isGrokAcp && options.markSessionPromptEstablished
          ? {
              onSessionPromptEstablished: async () => {
                await options.markSessionPromptEstablished!();
                if (options.unitContext) {
                  options.unitContext.sessionPromptEstablished = true;
                }
              },
            }
          : {}),
        ...(options.resumePrompt
          ? {
              resumePrompt: options.resumePrompt,
              resumeHadStoredSession: hadStoredSession,
              // Pi marks delivery on accept; Grok ACP uses onAcpPromptCompleted below.
              ...(!isGrokAcp && options.markContinuationDelivered && options.unitContext
                ? {
                    onResumePromptAccepted: () =>
                      options.markContinuationDelivered!(options.unitContext!.unitId),
                  }
                : {}),
              ...(isGrokAcp && options.markContinuationDelivered && options.unitContext
                ? {
                    onAcpPromptCompleted: () =>
                      options.markContinuationDelivered!(options.unitContext!.unitId),
                  }
                : {}),
            }
          : {}),
        // Pass registry for TUI Pi (with key) and TUI Grok ACP (with or without key).
        ...(options.interactiveRegistry && (endpointKey || (isGrokAcp && ctx.mode === 'tui'))
          ? {
              interactiveRegistry: options.interactiveRegistry,
              ...(endpointKey ? { endpointKey } : {}),
            }
          : {}),
        // Fresh Grok ACP: persist protocol session ID before the first prompt.
        ...(isGrokAcp && options.unitContext
          ? {
              onAcpSessionEstablished: async (sessionId: string) => {
                const unitCtx = options.unitContext!;
                if (options.persistAcpSessionId) {
                  await options.persistAcpSessionId(sessionId);
                }
                unitCtx.acpSessionId = sessionId;
              },
              // TUI fresh: attach live transport after ID flush (same process for first prompt).
              // Precompute throwable work before acceptOwnership so a throw leaves
              // transport/lease with the execution caller (dispose + release once).
              ...(ctx.mode === 'tui' && options.interactiveRegistry && !endpointKey
                ? {
                    registerGrokAcpLiveEndpoint: async (input: {
                      sessionId: string;
                      transport: import('./interactive-transport.ts').InteractiveAgentTransport;
                      leaseRelease: (err?: Error) => void;
                      acceptOwnership: () => void;
                    }) => {
                      const unitCtx = options.unitContext!;
                      // Throwable precompute — ownership still with execution caller.
                      const hostSessionId = ctx.sessionManager.getSessionId();
                      const isolation = resolveIsolation(agent!, taskIsolation);
                      const launchAgent: AgentConfig = {
                        ...agent!,
                        model: options.modelOverride ?? agent!.model,
                        thinking: options.thinkingOverride ?? agent!.thinking,
                        runtime: options.runtimeOverride ?? agent!.runtime ?? GROK_ACP_RUNTIME,
                      };
                      // Pure handoff: beginPendingOwner + acceptOwnership, then register.
                      return options
                        .interactiveRegistry!.registerGrokAcpLive({
                          runId: unitCtx.runId,
                          unitId: unitCtx.unitId,
                          hostSessionId,
                          transport: input.transport,
                          leaseRelease: input.leaseRelease,
                          acceptOwnership: input.acceptOwnership,
                          launchSpec: {
                            agent: launchAgent,
                            request: {
                              mode: 'single',
                              agentScope: 'both',
                              model: options.modelOverride,
                              thinking: options.thinkingOverride,
                              runtime: options.runtimeOverride ?? GROK_ACP_RUNTIME,
                              isolation,
                              agent: agentName,
                              task,
                              title: options.title,
                              cwd: effectiveCwd ?? fallbackCwd,
                            },
                            sessionFile: '',
                            sessionArtifact: {
                              runtime: 'grok-acp',
                              sessionId: input.sessionId,
                            },
                            effectiveCwd: effectiveCwd ?? fallbackCwd,
                            worktreePath: worktree?.path,
                            title: options.title,
                            modelOverride: options.modelOverride,
                            thinkingOverride: options.thinkingOverride,
                            runtimeOverride: options.runtimeOverride ?? GROK_ACP_RUNTIME,
                            isolation,
                            agentScope: 'both',
                            registrationKind: 'initial',
                          },
                          getBranchEntries: () =>
                            ctx.sessionManager.getBranch().map((e) => {
                              if (e.type === 'custom') {
                                return {
                                  type: 'custom',
                                  customType: (e as { customType?: string }).customType,
                                  data: (e as { data?: unknown }).data,
                                };
                              }
                              return { type: e.type };
                            }),
                        })
                        .then((snap) => {
                          endpointKey = snap.key;
                          retainCleanWorktree = true;
                          return snap.key;
                        });
                    },
                  }
                : {}),
            }
          : {}),
      }
    );
    if (!options.skipCompletionCheck) {
      enforceCompletionCheck(agent, result);
    }
    // Request worktree finalization after postprocess so retention uses the final
    // terminal status (schema/completion failure retains clean trees).
    if (worktree) pendingWorktreeFinalization = true;
    return await finalizeTerminalResult(result);
  } catch (err) {
    if (isAbortError(err)) {
      // Prefer the original abort origin; fall back to lifecycle/signal origin.
      const originalOrigin = err instanceof AgentAbortError ? err.origin : undefined;
      const origin = originalOrigin ?? options.getAbortOrigin?.() ?? 'unknown';
      const provisional = getAbortResult(err);
      if (provisional) {
        // Mutable working state from the provisional compact/low-level snapshot.
        const working = cloneSingleResult(provisional);
        if (worktree) stampWorktreeOnFailure(working);
        const snapshot = await finalizeTerminalResult(working, originToUnitStatus(origin));
        // Replacement abort error carries the authoritative compact terminal snapshot.
        throw new AgentAbortError(snapshot, origin);
      }
      throw err;
    }

    // Failure path: only remove owned-new worktrees that never started execution
    // and are confirmed clean. Once execution started or the tree is dirty,
    // retain and stamp path/dirty on the failure result.
    if (options.unitContext && !hadStoredSession) {
      delete options.unitContext.sessionFile;
      delete options.unitContext.sessionPromptEstablished;
    }
    const message =
      err instanceof Error
        ? err.message
        : err &&
            typeof err === 'object' &&
            'message' in err &&
            typeof (err as { message?: unknown }).message === 'string'
          ? (err as { message: string }).message
          : String(err);
    const failureCode = classifyEarlyFailureStopReason(err, message);
    const formalCode =
      err &&
      typeof err === 'object' &&
      'code' in err &&
      typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : undefined;
    const failure = attachErrorStack(
      synthesizeFailure(agentName, agent, task, step, failureCode, message, options.title),
      err
    );
    if (formalCode) failure.errorCode = formalCode;
    maybeRemoveOwnedCleanWorktree(failure);
    // Always terminalize when we own a unit context (including post-begin stamp
    // failure) so durable state is not left running without a finishUnit.
    if (options.unitContext && options.endUnit) {
      return await finalizeTerminalResult(failure, 'failed');
    }
    if (beganUnit) throw err;
    // Compact even non-durable early failures so raw transcripts never escape.
    return await finalizeTerminalResult(failure, 'failed');
  } finally {
    const profilePath = await stopProfile();
    if (profilePath) {
      // eslint-disable-next-line no-console
      console.error(`[pi-agents] CPU profile written to ${profilePath}`);
    }
    await agentContext.cleanup();
  }
}

export function runHookOrSynthesizeFailure(
  agentName: string,
  agent: AgentConfig,
  task: string,
  step: number | undefined,
  worktree: AgentWorktree,
  title?: string
): SingleResult | undefined {
  const hook = agent.worktreeSetupHook;
  if (!hook) return undefined;
  const hookResult = runWorktreeSetupHook(worktree.path, hook);
  if (hookResult.ok) return undefined;
  const errSummary = hookResult.error
    ? `error: ${hookResult.error}`
    : `exit ${hookResult.exitCode}`;
  const tail = (hookResult.stderr || hookResult.stdout).trim();
  const detail = tail ? `\n${tail.slice(-PRESENTATION_OUTPUT_TAIL_CHARS)}` : '';
  const failure = synthesizeFailure(
    agentName,
    agent,
    task,
    step,
    'worktree_setup_error',
    `worktreeSetupHook "${hook}" failed (${errSummary})${detail}`,
    title
  );
  failure.worktreeSetupError = failure.errorMessage;
  const cleanupStatus = getWorktreeDirtyStatus(worktree.path);
  if (cleanupStatus.ok && cleanupStatus.output.trim().length === 0) {
    const removal = removeAgentWorktree(worktree);
    if (!removal.removed) {
      failure.worktreePath = worktree.path;
      failure.worktreeDirty = false;
      failure.stderr += failure.stderr ? '\n' : '';
      failure.stderr += `Worktree cleanup failed: ${removal.error ?? 'unknown'}. Retaining ${worktree.path}.`;
    }
  } else {
    failure.worktreePath = worktree.path;
    failure.worktreeDirty = true;
    const diff = getWorktreeDiffSummary(worktree.path);
    if (diff.ok) {
      if (diff.stat) failure.worktreeDiffStat = diff.stat;
      if (diff.changedFiles) failure.worktreeChangedFiles = diff.changedFiles;
    }
  }
  return failure;
}

export function finalizeWorktree(
  worktree: AgentWorktree,
  result: SingleResult,
  options: { retainClean?: boolean } = {}
): void {
  const status = getWorktreeDirtyStatus(worktree.path);
  if (!status.ok) {
    result.worktreePath = worktree.path;
    result.worktreeDirty = true;
    result.stderr += result.stderr ? '\n' : '';
    result.stderr += `Worktree status check failed: ${status.error ?? 'unknown'}. Retaining ${worktree.path}.`;
    return;
  }
  if (status.output.trim().length > 0) {
    result.worktreePath = worktree.path;
    result.worktreeDirty = true;
    const diff = getWorktreeDiffSummary(worktree.path);
    if (diff.ok) {
      if (diff.stat) result.worktreeDiffStat = diff.stat;
      if (diff.changedFiles) result.worktreeChangedFiles = diff.changedFiles;
    } else {
      result.stderr += result.stderr ? '\n' : '';
      result.stderr += `Worktree diff summary failed: ${diff.error ?? 'unknown'}.`;
    }
    return;
  }
  // Only remove clean worktrees for completed units. Retain clean worktrees
  // for failed/cancelled/interrupted units so their Pi session cwd remains
  // valid for resume. Linked interactive TUI units always retain clean worktrees.
  const terminal = resolveExecutionStatus(result);
  if (terminal !== 'completed' || options.retainClean) {
    result.worktreePath = worktree.path;
    result.worktreeDirty = false;
    return;
  }
  const removal = removeAgentWorktree(worktree);
  if (!removal.removed) {
    result.worktreePath = worktree.path;
    result.worktreeDirty = false;
    result.stderr += result.stderr ? '\n' : '';
    result.stderr += `Worktree cleanup failed: ${removal.error ?? 'unknown'}. Retaining ${worktree.path}.`;
  }
}
