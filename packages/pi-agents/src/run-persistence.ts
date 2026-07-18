// ABOUTME: Run persistence glue — creates, claims, and finalizes durable runs for tool execution.
// ABOUTME: Optional; persistence is skipped when no store/coordinator is injected.

import type { AgentConfig, AgentScope, Runtime } from './agents.ts';
import type { RunStore } from './run-store.ts';
import type { CreateRunInput } from './run-store.ts';
import type { RunCoordinator, UnitExecutionContext } from './run-coordinator.ts';
import {
  agentFingerprint,
  assertUniqueUnitIds,
  generateUnitIds,
  resumeCapabilityForRuntime,
  createUnitRecord,
} from './run-coordinator.ts';
import type {
  AgentRunRecordV1,
  RunAbortOrigin,
  RunUnitRecord,
  StoredRunRequest,
} from './run-types.ts';
import type { ExecutionStatus, IsolationMode, SubagentDetails } from './types.ts';

/** Result of starting a durable run; the caller drives the workflow with this. */
export interface StartedRun {
  runId: string;
  record: AgentRunRecordV1;
  claimId: string;
  ticket: number;
  units: Record<string, RunUnitRecord>;
  /**
   * Statically known unit ids at run creation (or resume snapshot order).
   * Dynamically expanded fanout children are added to `record.units` later and
   * may not appear here.
   */
  unitIds: string[];
  finalize: (input: RunFinalizeInput) => Promise<void>;
}

export interface RunFinalizeInput {
  details: SubagentDetails;
  units: Record<string, RunUnitRecord>;
  success?: boolean;
  cancelled?: boolean;
  interrupted?: boolean;
  lastError?: string;
}

export interface StartRunOptions {
  store: RunStore;
  coordinator: RunCoordinator;
  mode: 'single' | 'parallel' | 'chain';
  agentScope: AgentScope;
  background: boolean;
  request: StoredRunRequest;
  details: SubagentDetails;
  agents: AgentConfig[];
  /** Runtime/model/thinking/isolation used for the resolved unit capabilities. */
  resolvedUnits: Array<{
    agent: AgentConfig;
    runtime: Runtime | undefined;
    effectiveCwd: string;
    step?: number;
    fanoutIndex?: number;
  }>;
}

export type { RunAbortOrigin };

/**
 * Create a durable run record, claim it, transition to running, and return a
 * driver handle. Throws `run_store_error` if persistence fails; the caller must
 * not spawn a child that cannot be tracked.
 */
export async function startDurableRun(options: StartRunOptions): Promise<StartedRun> {
  const { store, coordinator } = options;
  const unitIds = generateUnitIds(options.mode, options.request);
  assertUniqueUnitIds(unitIds);
  if (unitIds.length !== options.resolvedUnits.length) {
    throw new Error(
      `run_store_error: unit count mismatch (${unitIds.length} ids vs ${options.resolvedUnits.length} resolved)`
    );
  }
  const now = Date.now();
  const units: Record<string, RunUnitRecord> = {};
  for (let i = 0; i < unitIds.length; i++) {
    const id = unitIds[i];
    const resolved = options.resolvedUnits[i];
    const ctx: UnitExecutionContext = {
      runId: '',
      unitId: id,
      agent: resolved.agent.name,
      runtime: resolved.runtime,
      resumeCapability: resumeCapabilityForRuntime(resolved.runtime),
      effectiveCwd: resolved.effectiveCwd,
      attempt: 1,
      ...(resolved.step !== undefined ? { step: resolved.step } : {}),
      ...(resolved.fanoutIndex !== undefined ? { fanoutIndex: resolved.fanoutIndex } : {}),
    };
    units[id] = createUnitRecord(ctx, now);
    units[id].agentFingerprint = agentFingerprint(resolved.agent);
  }

  const input: CreateRunInput = {
    mode: options.mode,
    agentScope: options.agentScope,
    background: options.background,
    request: options.request,
    details: options.details,
    units,
  };

  let created: { runId: string; record: AgentRunRecordV1 };
  try {
    created = await store.createRun(input);
  } catch (err) {
    throw new RunStoreError('run_store_error', messageOf(err));
  }
  const { runId, record } = created;

  let claim:
    | { ok: true; claimId: string; ticket: number }
    | { ok: false; error: { code: string; message: string } };
  try {
    claim = await store.claimRun(runId);
  } catch (err) {
    await safeAbandon(store, runId, '');
    throw new RunStoreError('run_store_error', messageOf(err));
  }
  if (!claim.ok) {
    await safeAbandon(store, runId, '');
    throw new RunStoreError(claim.error.code, claim.error.message);
  }
  const { claimId, ticket } = claim;

  try {
    await store.appendEvent(runId, {
      version: 1,
      event: 'run_claimed',
      runId,
      timestamp: Date.now(),
      claimId,
      ticket,
    });
    await store.updateRun(runId, (r) => {
      r.status = 'running';
      r.startedAt = Date.now();
      r.updatedAt = Date.now();
    });
  } catch (err) {
    await safeRelease(store, runId, claimId);
    throw new RunStoreError('run_store_error', messageOf(err));
  }

  // Sync the in-memory record with the persisted running state before registering.
  // record.units is the same object as the local `units`, so registering this
  // record keeps the coordinator's live units aliased to the handle the
  // workflow mutates via beginUnit/endUnit/stampUnitSessionFile.
  record.status = 'running';
  if (record.startedAt === undefined) record.startedAt = Date.now();
  record.updatedAt = Date.now();
  coordinator.registerRun(runId, record);

  return {
    runId,
    record,
    claimId,
    ticket,
    units,
    unitIds,
    finalize: (input2) =>
      finalizeDurableRun({
        store,
        coordinator,
        runId,
        claimId,
        ...input2,
      }),
  };
}

interface FinalizeDurableRunInput extends RunFinalizeInput {
  store: RunStore;
  coordinator: RunCoordinator;
  runId: string;
  claimId: string;
}

/**
 * Shared strict terminal barrier for both fresh and resumed run completion.
 * Success order: strict `finalizeRun()` -> one `appendEventStrict(run_terminal)`
 * -> `unregisterRun()` -> `releaseRun()`. Any failure (including a release
 * failure) enters the failure path: `unregisterRun()` -> `abandonRun()` -> rethrow.
 * Never reports success, appends a terminal event, or releases a claim when a
 * barrier step fails; the claim is abandoned so it cannot be silently retained.
 */
export async function finalizeDurableRun(input: FinalizeDurableRunInput): Promise<void> {
  const { store, coordinator, runId, claimId, details, units } = input;
  try {
    const status = await coordinator.finalizeRun(runId, details, units, {
      success: input.success,
      cancelled: input.cancelled,
      interrupted: input.interrupted,
      lastError: input.lastError,
    });
    await store.appendEventStrict(runId, {
      version: 1,
      event: 'run_terminal',
      runId,
      timestamp: Date.now(),
      status,
    });
    coordinator.unregisterRun(runId);
    await store.releaseRun(runId, claimId);
  } catch (err) {
    coordinator.unregisterRun(runId);
    try {
      await store.abandonRun(runId, claimId);
    } catch {
      /* abandon is best-effort after a barrier failure */
    }
    throw err;
  }
}

export class RunStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'RunStoreError';
    this.code = code;
  }
}

async function safeRelease(store: RunStore, runId: string, claimId: string): Promise<void> {
  try {
    await store.releaseRun(runId, claimId);
  } catch {
    /* best-effort */
  }
}

export async function safeAbandon(store: RunStore, runId: string, claimId: string): Promise<void> {
  if (!claimId) return;
  try {
    await store.abandonRun(runId, claimId);
  } catch {
    /* best-effort */
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Normalize a tool params object into a JSON-safe stored request.
 */
export function normalizeStoredRequest(params: {
  mode: 'single' | 'parallel' | 'chain';
  agentScope: AgentScope;
  model?: string;
  thinking?: string;
  runtime?: Runtime;
  isolation?: IsolationMode;
  agent?: string;
  task?: string;
  title?: string;
  cwd?: string;
  tasks?: Array<{
    agent: string;
    task: string;
    title?: string;
    cwd?: string;
    isolation?: IsolationMode;
  }>;
  chain?: unknown[];
}): StoredRunRequest {
  const stored: StoredRunRequest = {
    mode: params.mode,
    agentScope: params.agentScope,
  };
  if (params.model !== undefined) stored.model = params.model;
  if (params.thinking !== undefined) stored.thinking = params.thinking;
  if (params.runtime !== undefined) stored.runtime = params.runtime;
  if (params.isolation !== undefined) stored.isolation = params.isolation;
  if (params.agent !== undefined) stored.agent = params.agent;
  if (params.task !== undefined) stored.task = params.task;
  if (params.title !== undefined) stored.title = params.title;
  if (params.cwd !== undefined) stored.cwd = params.cwd;
  if (params.tasks !== undefined) stored.tasks = params.tasks;
  if (params.chain !== undefined) stored.chain = params.chain;
  return stored;
}

export type { ExecutionStatus };
