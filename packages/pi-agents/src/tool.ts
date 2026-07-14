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
import { runChainWorkflow, synthesizeFailure, type FanoutExpandRequest } from './chain.ts';
import type { WorkflowFanoutState } from './run-types.ts';
import {
  GROK_ACP_RUNTIME,
  GROK_RUNTIME,
  MAX_CONCURRENCY,
  MAX_PARALLEL_TASKS,
} from './constants.ts';
import { enforceCompletionCheck } from './completion-check.ts';
import { prepareAgentContext } from './context.ts';
import { listAvailableSkillNames, resolveSkillNames } from './skills.ts';
import {
  ABORT_MESSAGE,
  getAbortResult,
  isAbortError,
  mapWithConcurrencyLimit,
  type OnUpdateCallback,
  runSingleAgent,
} from './execution.ts';
import {
  applyTerminalStatus,
  getFinalOutput,
  getResultOutput,
  isFailedResult,
  resolveExecutionStatus,
  truncateParallelOutput,
} from './output.ts';
import {
  createRunLifecycle,
  bridgeIncomingSignal,
  originToFinalizeFlags,
  originToUnitStatus,
  originToRunStatus,
  type RunLifecycle,
} from './run-lifecycle.ts';
import { normalizeStoredRequest, startDurableRun, type StartedRun } from './run-persistence.ts';
import type { RunAbortOrigin } from './run-types.ts';
import type { RunStore } from './run-store.ts';
import { chainFanoutUnitId, chainStepUnitId, pad } from './run-coordinator.ts';
import type { RunCoordinator, UnitExecutionContext } from './run-coordinator.ts';
import type { SubagentParams } from './schema.ts';
import { assertAgentDelegationAllowed } from './security.ts';
import {
  cloneResults,
  cloneSingleResult,
  emptyUsage,
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
import { inspectResume, incrementIncompleteAttempts } from './resume.ts';
import type { ResumePromptContext } from './execution.ts';
import type { StoredRunRequest } from './run-types.ts';

type Params = Static<typeof SubagentParams>;
type Mode = 'single' | 'parallel' | 'chain';
type AgentResult = AgentToolResult<SubagentDetails> & { isError?: boolean };
type DetailsFactory = (mode: Mode) => (results: SingleResult[]) => SubagentDetails;

/** Public resume inputs resolved at the start of executeAgentTool. */
interface ResumeDescriptor {
  runId: string;
  allowReplay: boolean;
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
  const origin = durable.lifecycle.origin;
  const lifecycleAborted = durable.lifecycle.signal.aborted;
  // The foreground workflow catches aborts and surfaces them as isError results,
  // so `err` is usually undefined on this path. The coordinator-owned lifecycle
  // signal is the reliable indicator: when it aborted, classify the terminal as
  // cancelled (user) or interrupted (shutdown/unknown) by the carried origin.
  if (lifecycleAborted) {
    const flags = originToFinalizeFlags(origin);
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
  /** Whether the caller acknowledged replay side effects. */
  allowReplay?: boolean;
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
  /** Stamp the per-unit start; called before runStepWithContext. */
  beginUnit(ctx: UnitExecutionContext): void;
  /** Stamp the per-unit terminal. */
  endUnit(ctx: UnitExecutionContext, result: SingleResult, status: ExecutionStatus): void;
  /** Update a unit's sessionFile after Pi session creation (persisted on next flush). */
  stampUnitSessionFile(unitId: string, sessionFile: string): void;
  /**
   * Persist fanout expansion + child unit records before workers are scheduled.
   * Resolves the requested agent by exact name (synthetic fallback; never agents[0]).
   */
  expandFanout(req: FanoutExpandRequest): Promise<WorkflowFanoutState>;
  /** Build per-unit resume prompt context with undelivered continuation slice. */
  resumePromptForUnit?(unitId: string): ResumePromptContext | undefined;
  /** Mark all current continuation tasks as delivered for a unit (after prompt accept). */
  markContinuationDelivered?(unitId: string): void;
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
    return {
      runId: started.runId,
      unitId,
      agent: agentName,
      runtime: base?.runtime,
      resumeCapability: base?.capability ?? 'session',
      effectiveCwd: base?.effectiveCwd ?? ctx.cwd,
      attempt: base?.attempt ?? 1,
      sessionsDir,
      ...(base?.sessionFile !== undefined ? { sessionFile: base.sessionFile } : {}),
      ...(base?.worktreePath !== undefined ? { worktreePath: base.worktreePath } : {}),
      ...(step !== undefined ? { step } : {}),
      ...(fanoutIndex !== undefined ? { fanoutIndex } : {}),
    };
  };
  const beginUnit = (unitCtx: UnitExecutionContext) => {
    coordinator.startUnit(started.runId, unitCtx);
  };
  const endUnit = (
    unitCtx: UnitExecutionContext,
    result: SingleResult,
    status: ExecutionStatus
  ) => {
    coordinator.finishUnit(started.runId, unitCtx, result, status);
  };
  const stampUnitSessionFile = (unitId: string, sessionFile: string) => {
    const unit = units[unitId];
    if (unit) {
      unit.sessionFile = sessionFile;
      coordinator.persist({
        runId: started.runId,
        details: started.record.details,
        units,
        flushNow: true,
      });
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
    stampUnitSessionFile,
    expandFanout,
  };
}

/**
 * Project/workspace cwd for a stored run: prefer request.cwd, else the first
 * unit's effectiveCwd (non-worktree original location).
 */
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
  const store = options.runStore;
  const coordinator = options.runCoordinator;
  if (!store || !coordinator) return { error: 'persistence_not_configured' };

  const resumeRunId = resume.runId;
  const inspection = inspectResume(resumeRunId, store, {
    agents,
    allowReplay: resume.allowReplay,
  });
  if (!inspection.ok) return { error: inspection.reason };
  if (inspection.blockingReasons.length > 0) {
    return { error: `preflight_failed: ${inspection.blockingReasons.join('; ')}` };
  }
  if (coordinator.isActive(resumeRunId)) return { error: 'run_active' };

  const claim = await store.claimRun(resumeRunId);
  if (!claim.ok) return { error: `claim_failed: ${claim.error.message}` };

  // Re-validate eligibility on the post-claim record so a race that completed
  // or corrupted the run between preflight and claim fails safely without
  // mutating a completed run.
  const loaded = store.getRun(resumeRunId);
  if (!loaded.ok) {
    await store.releaseRun(resumeRunId, claim.claimId);
    return { error: 'run_not_found_after_claim' };
  }
  const postClaim = inspectResume(resumeRunId, store, {
    agents,
    allowReplay: resume.allowReplay,
  });
  if (!postClaim.ok) {
    await store.releaseRun(resumeRunId, claim.claimId);
    return { error: postClaim.reason };
  }
  if (postClaim.blockingReasons.length > 0) {
    await store.releaseRun(resumeRunId, claim.claimId);
    return { error: `preflight_failed: ${postClaim.blockingReasons.join('; ')}` };
  }
  if (loaded.loaded.record.status === 'completed') {
    await store.releaseRun(resumeRunId, claim.claimId);
    return { error: 'run_already_completed' };
  }

  const record = loaded.loaded.record;
  // Shallow-copy units so we can stage attempt increments before write.
  const units: typeof record.units = {};
  for (const [id, unit] of Object.entries(record.units)) {
    units[id] = { ...unit, attempts: [...unit.attempts] };
  }

  // Increment attempts only after post-claim eligibility succeeds.
  incrementIncompleteAttempts(units);

  // Transition to running and append the current continuation task atomically.
  // Guard the post-claim persistence so a write failure releases the claim.
  const priorContinuations = record.continuationTasks ?? [];
  const accumulatedContinuations = resume.currentContinuationTask
    ? [...priorContinuations, resume.currentContinuationTask]
    : [...priorContinuations];
  const priorDelivery = { ...(record.continuationDelivery ?? {}) };
  try {
    await store.appendEvent(resumeRunId, {
      version: 1,
      event: 'run_resumed',
      runId: resumeRunId,
      timestamp: Date.now(),
      claimId: claim.claimId,
      ticket: claim.ticket,
    });
    await store.updateRun(resumeRunId, (r) => {
      r.status = 'running';
      r.units = units;
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
  } catch (err) {
    await store.releaseRun(resumeRunId, claim.claimId);
    return {
      error: `resume_setup_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Sync the in-memory record with the persisted running state before
  // registering so the coordinator's live units stay aliased to the handle
  // the workflow mutates via beginUnit/endUnit/stampUnitSessionFile.
  record.status = 'running';
  record.units = units;
  record.continuationTasks = accumulatedContinuations;
  record.continuationDelivery = { ...priorDelivery };
  if (record.startedAt === undefined) record.startedAt = Date.now();
  record.updatedAt = Date.now();
  coordinator.registerRun(resumeRunId, record);

  const lifecycle = createRunLifecycle(resumeRunId);
  const sessionsDir = path.join(store.getRunDir(resumeRunId), 'sessions');
  const unitIds = Object.keys(units);
  const projectCwd = projectCwdFromRecord(record, ctx.cwd);

  const unitFor = (
    step: number | undefined,
    fanoutIndex: number | undefined,
    agentName: string
  ): UnitExecutionContext => {
    const unitId = resolveUnitId(mode, unitIds, step, fanoutIndex);
    const base = units[unitId];
    return {
      runId: resumeRunId,
      unitId,
      agent: agentName,
      runtime: base?.runtime,
      resumeCapability: base?.capability ?? 'session',
      effectiveCwd: base?.effectiveCwd ?? projectCwd,
      attempt: base?.attempt ?? 1,
      sessionsDir,
      ...(base?.sessionFile !== undefined ? { sessionFile: base.sessionFile } : {}),
      ...(base?.worktreePath !== undefined ? { worktreePath: base.worktreePath } : {}),
      ...(step !== undefined ? { step } : {}),
      ...(fanoutIndex !== undefined ? { fanoutIndex } : {}),
    };
  };
  const beginUnit = (unitCtx: UnitExecutionContext) => {
    coordinator.startUnit(resumeRunId, unitCtx);
  };
  const endUnit = (
    unitCtx: UnitExecutionContext,
    result: SingleResult,
    status: ExecutionStatus
  ) => {
    coordinator.finishUnit(resumeRunId, unitCtx, result, status);
  };
  const stampUnitSessionFile = (unitId: string, sessionFile: string) => {
    const unit = units[unitId];
    if (unit) {
      unit.sessionFile = sessionFile;
      coordinator.persist({
        runId: resumeRunId,
        details: record.details,
        units,
        flushNow: true,
      });
    }
  };
  const expandFanout = async (req: FanoutExpandRequest): Promise<WorkflowFanoutState> => {
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
  const resumePromptForUnit = (unitId: string): ResumePromptContext => {
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
  const markContinuationDelivered = (unitId: string): void => {
    const deliveredCount = accumulatedContinuations.length;
    if (!record.continuationDelivery) record.continuationDelivery = {};
    record.continuationDelivery[unitId] = { deliveredCount };
    coordinator.persist({
      runId: resumeRunId,
      details: record.details,
      units,
      flushNow: true,
      mutate: (r) => {
        if (!r.continuationDelivery) r.continuationDelivery = {};
        r.continuationDelivery[unitId] = { deliveredCount };
        r.continuationTasks = accumulatedContinuations;
      },
    });
  };

  const started: StartedRun = {
    runId: resumeRunId,
    record: { ...record, units },
    claimId: claim.claimId,
    ticket: claim.ticket,
    units,
    unitIds,
    finalize: async (input) => {
      try {
        await coordinator.finalizeRun(resumeRunId, input.details, input.units, {
          success: input.success,
          cancelled: input.cancelled,
          interrupted: input.interrupted,
          lastError: input.lastError,
        });
        const status = input.cancelled
          ? 'cancelled'
          : input.interrupted
            ? 'interrupted'
            : input.success === false
              ? 'failed'
              : 'completed';
        await store.appendEvent(resumeRunId, {
          version: 1,
          event: 'run_terminal',
          runId: resumeRunId,
          timestamp: Date.now(),
          status,
        });
      } finally {
        await store.releaseRun(resumeRunId, claim.claimId);
      }
    },
  };

  // Build restored chain state if applicable.
  let restoredChain: import('./chain.ts').RestoredChainState | undefined;
  if (mode === 'chain' && record.details.chain) {
    restoredChain = {
      results: record.details.results,
      outputs: record.details.outputs ?? {},
      logicalSteps: record.details.chain.steps,
      units,
      fanouts: record.workflowState?.fanouts,
    };
  }

  const resumePrompt: ResumePromptContext = {
    continuationTasks: accumulatedContinuations,
    undeliveredContinuationTasks: accumulatedContinuations,
    ...(resume.currentContinuationTask
      ? { currentContinuationTask: resume.currentContinuationTask }
      : {}),
  };

  return {
    durable: {
      started,
      lifecycle,
      coordinator,
      isResume: true,
      resume: resumePrompt,
      allowReplay: resume.allowReplay,
      projectCwd,
      unitFor,
      beginUnit,
      endUnit,
      stampUnitSessionFile,
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

/** Map a workflow position to its stable unit id. */
function resolveUnitId(
  mode: Mode,
  unitIds: string[],
  step: number | undefined,
  fanoutIndex: number | undefined
): string {
  if (mode === 'single') return unitIds[0] ?? 'single';
  if (mode === 'parallel') {
    const idx = fanoutIndex ?? 0;
    return unitIds[idx] ?? `parallel-${pad(idx + 1)}`;
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
    const agent = agents.find((a) => a.name === params.agent) ?? agents[0];
    return [
      {
        agent: agent ?? syntheticAgent(params.agent ?? 'agent'),
        runtime: params.runtime ?? agent?.runtime,
        effectiveCwd: params.cwd ?? ctx.cwd,
      },
    ];
  }
  if (mode === 'parallel') {
    const tasks = params.tasks ?? [];
    return tasks.map((t, i) => {
      const agent = agents.find((a) => a.name === t.agent) ?? agents[0];
      return {
        agent: agent ?? syntheticAgent(t.agent),
        runtime: params.runtime ?? agent?.runtime,
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
    const agent = agents.find((a) => a.name === name) ?? agents[0];
    resolved.push({
      agent: agent ?? syntheticAgent(name),
      runtime: params.runtime ?? agent?.runtime,
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
  // allowReplay is resume-only.
  if (params.allowReplay !== undefined && params.runId === undefined) {
    return {
      content: [
        {
          type: 'text',
          text: 'resume_error: allowReplay requires runId',
        },
      ],
      details: emptyErrorDetails(),
      isError: true,
    };
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
      allowReplay: params.allowReplay === true,
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

  // Start a durable run before launching the workflow (persistence optional).
  // When resumeDescriptor is set, resume the stored run instead of creating new.
  let durable: DurableRunContext | undefined;
  let restoredChain: import('./chain.ts').RestoredChainState | undefined;
  try {
    if (resumeDescriptor && options.runStore && options.runCoordinator) {
      const result = await maybeResumeDurableRun(resumeDescriptor, mode, options, ctx, agents);
      if ('error' in result) {
        return {
          content: [{ type: 'text', text: `resume_error: ${result.error}` }],
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
        spawnFn
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
  spawnFn?: import('./execution.ts').SpawnFn
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
                return {
                  unitContext,
                  getAbortOrigin: () => durable.lifecycle.origin,
                  beginUnit: durable.beginUnit,
                  endUnit: durable.endUnit,
                  stampUnitSessionFile: (sf: string) =>
                    durable.stampUnitSessionFile(unitContext.unitId, sf),
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
                  ...(durable.allowReplay !== undefined
                    ? { allowReplay: durable.allowReplay }
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
      if (unit.result) return { ...unit.result };
      const existing = restoredResults[index];
      if (existing && resolveExecutionStatus(existing) === 'completed') {
        return { ...existing };
      }
      // Completed unit without a usable result: keep a completed slot so we do
      // not re-dispatch (replay gate still applies to incomplete units only).
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

  const emitParallelUpdate = () => {
    if (onUpdate) {
      const snapshot = cloneResults(allResults);
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
    }
  };

  emitParallelUpdate();

  const makeCancelledSlot = (t: (typeof tasks)[number], index: number): SingleResult => {
    const existing = allResults[index];
    const cancelled: SingleResult = {
      ...existing,
      agent: t.agent,
      task: t.task,
      exitCode: 1,
      status: 'cancelled',
      stopReason: 'aborted',
      errorMessage: existing.errorMessage || ABORT_MESSAGE,
    };
    return cancelled;
  };

  const results = await mapWithConcurrencyLimit(
    tasks,
    MAX_CONCURRENCY,
    async (t, index) => {
      // Skip by unit.status / restored completed slot (not lagging details alone).
      if (resolveExecutionStatus(allResults[index]) === 'completed') {
        emitParallelUpdate();
        return allResults[index];
      }
      const unitCtx = durable?.unitFor(undefined, index, t.agent);
      // Replay gate at dispatch: refuse resumed replay units without allowReplay.
      if (
        unitCtx &&
        durable?.isResume &&
        unitCtx.resumeCapability === 'replay' &&
        !durable.allowReplay
      ) {
        const blocked: SingleResult = {
          ...allResults[index],
          agent: t.agent,
          task: t.task,
          exitCode: 1,
          status: 'failed',
          stopReason: 'error',
          errorMessage: `unit ${unitCtx.unitId}: requires replay (allowReplay not set)`,
        };
        allResults[index] = blocked;
        emitParallelUpdate();
        return blocked;
      }
      allResults[index] = {
        ...allResults[index],
        status: 'running',
        exitCode: -1,
      };
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
              partialResult.status = partialResult.status ?? 'running';
              allResults[index] = partialResult;
              emitParallelUpdate();
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
                  ...(durable.allowReplay !== undefined
                    ? { allowReplay: durable.allowReplay }
                    : {}),
                  ...(durable.projectCwd ? { projectCwd: durable.projectCwd } : {}),
                }
              : {}),
          }
        );
        if (!result.status || result.status === 'running') applyTerminalStatus(result);
        allResults[index] = result;
        emitParallelUpdate();
        return result;
      } catch (err) {
        if (isAbortError(err)) {
          const fromErr = getAbortResult(err);
          const cancelled = fromErr
            ? {
                ...fromErr,
                status: 'cancelled' as const,
                stopReason: fromErr.stopReason ?? 'aborted',
              }
            : makeCancelledSlot(t, index);
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

  emitParallelUpdate();

  const successCount = results.filter((r) => !isFailedResult(r)).length;
  const cancelledCount = results.filter((r) => resolveExecutionStatus(r) === 'cancelled').length;
  const summaries = results.map((r) => {
    const output = truncateParallelOutput(getResultOutput(r));
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
    details: makeDetails('parallel')(cloneResults(results)),
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
    if (durable.isResume && unitCtx.resumeCapability === 'replay' && !durable.allowReplay) {
      return {
        content: [
          {
            type: 'text',
            text: `resume_error: preflight_failed: unit ${unitCtx.unitId}: requires replay (allowReplay not set)`,
          },
        ],
        details: makeDetails('single')([]),
        isError: true,
      };
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
              ...(durable.resumePromptForUnit
                ? { resumePrompt: durable.resumePromptForUnit(unitCtx.unitId) }
                : durable.resume
                  ? { resumePrompt: durable.resume }
                  : {}),
              ...(durable.markContinuationDelivered
                ? { markContinuationDelivered: durable.markContinuationDelivered }
                : {}),
              ...(durable.allowReplay !== undefined ? { allowReplay: durable.allowReplay } : {}),
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
        details: makeDetails('single')([cloneSingleResult(result)]),
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: getFinalOutput(result.messages) || '(no output)' }],
      details: makeDetails('single')([cloneSingleResult(result)]),
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
        details: makeDetails('single')([cloneSingleResult(result)]),
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
    stampUnitSessionFile?: (sessionFile: string) => void;
    beginUnit?: (ctx: UnitExecutionContext) => void;
    endUnit?: (ctx: UnitExecutionContext, result: SingleResult, status: ExecutionStatus) => void;
    /** Runs before worktree cleanup and durable endUnit (schema validation, metadata). */
    postprocessTerminal?: (result: SingleResult) => void;
    interactiveRegistry?: import('./interactive-agent.ts').InteractiveAgentRegistry;
    /** Durable resume prompt context (session continuation vs fresh/replay). */
    resumePrompt?: ResumePromptContext;
    /** Mark continuation delivery after the child accepts the prompt. */
    markContinuationDelivered?: (unitId: string) => void;
    allowReplay?: boolean;
    /** Restored project/workspace cwd for resume (overrides ctx.cwd for git/cwd fallbacks). */
    projectCwd?: string;
    spawnFn?: import('./execution.ts').SpawnFn;
  } = {}
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);
  // Capture before prepareAgentContext may create a new session for never-started units.
  const hadStoredSession = Boolean(options.unitContext?.sessionFile);
  // Prefer explicit task cwd, then persisted unit effectiveCwd, then project cwd.
  const fallbackCwd = cwd ?? options.unitContext?.effectiveCwd ?? options.projectCwd ?? ctx.cwd;
  const applyPostprocess = (result: SingleResult): void => {
    if (options.postprocessTerminal) options.postprocessTerminal(result);
  };
  const markEnd = (result: SingleResult, status?: ExecutionStatus): void => {
    if (options.unitContext && options.endUnit) {
      options.endUnit(options.unitContext, result, status ?? resolveExecutionStatus(result));
    }
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
    markEnd(failed, 'failed');
    return failed;
  }

  const effectiveRuntime: Runtime | undefined = options.runtimeOverride ?? agent.runtime;

  const isGrokFamily = effectiveRuntime === GROK_RUNTIME || effectiveRuntime === GROK_ACP_RUNTIME;

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
      markEnd(failure, 'failed');
      return failure;
    }
    resolvedSkillPaths = resolved;
  }

  // Select/create the worktree before creating the Pi session so the session
  // header cwd matches the actual child cwd. On resume, reopen the stored
  // worktree instead of creating a new one.
  const isolation = resolveIsolation(agent, taskIsolation);
  let worktree: AgentWorktree | undefined;
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
        markEnd(failure1, 'failed');
        return failure1;
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
        markEnd(failure2, 'failed');
        return failure2;
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
        markEnd(failure3, 'failed');
        return failure3;
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
        markEnd(failure5, 'failed');
        return failure5;
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
          removeAgentWorktree(worktree);
          markEnd(failure, 'failed');
          return failure;
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
    if (worktree) removeAgentWorktree(worktree);
    const message = err instanceof Error ? err.message : String(err);
    const failure4 = synthesizeFailure(
      agentName,
      agent,
      task,
      step,
      'context_error',
      message,
      options.title
    );
    markEnd(failure4, 'failed');
    return failure4;
  }

  // Persist the newly created session file onto the unit record and mutate the
  // unit context so stampUnitContext() stamps the correct path onto the result.
  // Do not flip hadStoredSession: prompt kind was decided from the pre-prepare state.
  if (options.unitContext && agentContext.sessionFile) {
    options.unitContext.sessionFile = agentContext.sessionFile;
    options.stampUnitSessionFile?.(agentContext.sessionFile);
  }
  // Stamp the worktree path onto the unit context so the coordinator persists it.
  if (options.unitContext && worktree) {
    options.unitContext.worktreePath = worktree.path;
  }

  // Interactive TUI Pi registration: after cwd/session resolution, before begin/spawn.
  let endpointKey: string | undefined;
  let retainCleanWorktree = false;
  const canRegisterInteractive =
    ctx.mode === 'tui' &&
    options.interactiveRegistry &&
    options.unitContext &&
    agentContext.sessionFile &&
    !isGrokFamily;

  if (canRegisterInteractive && options.interactiveRegistry && options.unitContext) {
    try {
      const hostSessionId = ctx.sessionManager.getSessionId();
      const unitCtx = options.unitContext;
      const launchAgent: AgentConfig = {
        ...agent,
        model: options.modelOverride ?? agent.model,
        thinking: options.thinkingOverride ?? agent.thinking,
        runtime: options.runtimeOverride ?? agent.runtime,
      };
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
          sessionFile: agentContext.sessionFile!,
          effectiveCwd: effectiveCwd ?? fallbackCwd,
          worktreePath: worktree?.path,
          title: options.title,
          modelOverride: options.modelOverride,
          thinkingOverride: options.thinkingOverride,
          runtimeOverride: options.runtimeOverride,
          isolation: resolveIsolation(agent, taskIsolation),
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
      });
      endpointKey = snap.key;
      retainCleanWorktree = true;
    } catch (err) {
      if (worktree) removeAgentWorktree(worktree);
      const message = err instanceof Error ? err.message : String(err);
      const failure = synthesizeFailure(
        agentName,
        agent,
        task,
        step,
        'context_error',
        `Interactive link registration failed: ${message}`,
        options.title
      );
      markEnd(failure, 'failed');
      return failure;
    }
  }

  // Mark the unit started (running attempt + unit_started event) before spawn.
  if (options.unitContext && options.beginUnit) {
    options.beginUnit(options.unitContext);
  }

  try {
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
        ...(options.resumePrompt
          ? {
              resumePrompt: options.resumePrompt,
              resumeHadStoredSession: hadStoredSession,
              ...(options.markContinuationDelivered && options.unitContext
                ? {
                    onResumePromptAccepted: () =>
                      options.markContinuationDelivered!(options.unitContext!.unitId),
                  }
                : {}),
            }
          : {}),
        ...(options.interactiveRegistry && endpointKey
          ? {
              interactiveRegistry: options.interactiveRegistry,
              endpointKey,
            }
          : {}),
      }
    );
    if (!options.skipCompletionCheck) {
      enforceCompletionCheck(agent, result);
    }
    // Schema validation / identity stamping before worktree cleanup and endUnit
    // so durable terminal state reflects the final validated result.
    applyPostprocess(result);
    if (worktree) {
      finalizeWorktree(worktree, result, { retainClean: retainCleanWorktree });
    }
    markEnd(result);
    return result;
  } catch (err) {
    if (isAbortError(err) && options.unitContext && options.endUnit) {
      const origin = options.getAbortOrigin?.() ?? 'unknown';
      const abortResult = getAbortResult(err);
      if (abortResult) {
        applyPostprocess(abortResult);
        markEnd(abortResult, originToUnitStatus(origin));
      }
    }
    if (worktree) {
      // Retain worktrees for aborted/failed units (their Pi session cwd must
      // remain valid for resume). Stamp path + dirty metadata so the
      // coordinator can persist them.
      const status = getWorktreeDirtyStatus(worktree.path);
      // We cannot stamp onto the result here (it doesn't exist yet), but the
      // worktree path is already on options.unitContext.worktreePath.
      void status;
    }
    throw err;
  } finally {
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
  const detail = tail ? `\n${tail.slice(-400)}` : '';
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
    removeAgentWorktree(worktree);
  } else {
    failure.worktreePath = worktree.path;
    failure.worktreeDirty = true;
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
