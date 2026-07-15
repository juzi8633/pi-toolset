// ABOUTME: Versioned persisted run, unit, attempt, lock, event, and resume-capability types.
// ABOUTME: Shared by the run store, coordinator, and resume paths; the durable data contract.

import type { AgentScope, Runtime } from './agents.ts';
import type { ExecutionStatus, SingleResult, SubagentDetails } from './types.ts';

export const RUN_RECORD_VERSION = 1;

/** Durable run-level status persisted in `run.json`. */
export type RunStatus = 'queued' | 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled';

/** Resume behavior a runtime unit supports. */
export type ResumeCapability = 'session' | 'replay';

/** Where an abort originated, carried through abort errors and lifecycle events. */
export type RunAbortOrigin = 'user' | 'session_shutdown' | 'owner_process_missing' | 'unknown';

/** JSON-safe normalized copy of the request that launched the run. */
export interface StoredRunRequest {
  mode: 'single' | 'parallel' | 'chain';
  agentScope: AgentScope;
  model?: string;
  thinking?: string;
  runtime?: Runtime;
  isolation?: 'none' | 'worktree';
  /** Single-mode agent name and task. */
  agent?: string;
  task?: string;
  title?: string;
  cwd?: string;
  /** Parallel-mode task items. */
  tasks?: Array<{
    agent: string;
    task: string;
    title?: string;
    cwd?: string;
    isolation?: 'none' | 'worktree';
  }>;
  /** Chain-mode step items (serialized shape; fanout carries expand/parallel/collect). */
  chain?: unknown[];
}

/** Owner of an acquired ticket claim on a run. */
export interface RunOwner {
  claimId: string;
  ticket: number;
  instanceId: string;
  pid: number;
  acquiredAt: number;
}

/** One execution attempt for a unit (initial or resumed). */
export interface RunUnitAttempt {
  attempt: number;
  status: ExecutionStatus | 'interrupted';
  startedAt: number;
  finishedAt?: number;
  stopReason?: string;
  errorMessage?: string;
}

/**
 * Dual-bound interactive link identity stored on a durable unit.
 * Paired with a host-session `pi-agents-interactive-link` custom entry.
 */
export interface InteractiveAgentBindingV1 {
  bindingId: string;
  hostSessionId: string;
  createdAt: number;
}

/** Minimal untrusted host-session link claim for interactive navigator endpoints. */
export interface InteractiveAgentLinkV1 {
  version: 1;
  runId: string;
  unitId: string;
  bindingId: string;
  hostSessionId: string;
  createdAt: number;
}

/**
 * One execution unit within a run (single, one parallel task, or one chain unit).
 * `step` is one-based when present; `fanoutIndex` is zero-based for fanout children.
 * Both are immutable once the unit is created.
 */
export interface RunUnitRecord {
  unitId: string;
  agent: string;
  agentFingerprint: string;
  runtime: Runtime | undefined;
  capability: ResumeCapability;
  status: ExecutionStatus | 'interrupted';
  step?: number;
  fanoutIndex?: number;
  attempt: number;
  attempts: RunUnitAttempt[];
  sessionFile?: string;
  /**
   * ACP protocol session ID for `runtime: "grok-acp"` units.
   * Protocol identity only — never a private Grok session-file path.
   */
  acpSessionId?: string;
  /**
   * Pi original-prompt establishment. `false` after a first sessionFile stamp and
   * before the unit's original prompt is accepted; `true` after accept is durably
   * recorded. Absent on legacy units (treat as established when a sessionFile is
   * present). Session file presence alone must not imply the original task ran.
   */
  sessionPromptEstablished?: boolean;
  effectiveCwd: string;
  worktreePath?: string;
  result?: SingleResult;
  /** Optional dual bindings for interactive TUI endpoints (Version 1 additive). */
  interactiveBindings?: Record<string, InteractiveAgentBindingV1>;
}

/**
 * Persisted fanout expansion captured before the first worker is dispatched.
 * Keyed in `workflowState.fanouts` by `chainFanoutStepId(step)` (`chain-NNNN-fanout`).
 * `items` is the ordered, post-maxItems list that can actually be scheduled;
 * `unitIds[i]` is the canonical id for `items[i]` (`chain-NNNN-fanout-MMMM`).
 */
export interface WorkflowFanoutState {
  step: number;
  items: unknown[];
  unitIds: string[];
}

/** Version 1 authoritative run snapshot written to `run.json`. */
export interface AgentRunRecordV1 {
  version: 1;
  runId: string;
  mode: 'single' | 'parallel' | 'chain';
  status: RunStatus;
  request: StoredRunRequest;
  background: boolean;
  agentScope: AgentScope;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  owner?: RunOwner;
  details: SubagentDetails;
  units: Record<string, RunUnitRecord>;
  workflowState?: {
    fanouts: Record<string, WorkflowFanoutState>;
  };
  eventsFile: 'events.jsonl';
  lastError?: string;
  /**
   * Accumulated continuation instructions appended on resume via `agent({ runId, task })`.
   * Optional for backward compatibility; absent means an empty history.
   */
  continuationTasks?: string[];
  /**
   * Per-unit continuation delivery progress. `deliveredCount` is how many of
   * `continuationTasks[0..n)` have been confirmed accepted by that unit's prompt.
   * Missing entry means zero delivered. Optional for backward compatibility.
   */
  continuationDelivery?: Record<string, UnitContinuationDelivery>;
}

/** Per-unit progress for durable continuation-task delivery. */
export interface UnitContinuationDelivery {
  deliveredCount: number;
}

/** Claim owner payload written to `claims/<ticket>/owner.json`. */
export interface ClaimOwner {
  runId: string;
  claimId: string;
  instanceId: string;
  pid: number;
  acquiredAt: number;
}

/** Claim terminal payload written to `claims/<ticket>/terminal.json`. */
export interface ClaimTerminal {
  claimId: string;
  state: 'released' | 'abandoned';
  timestamp: number;
}

/** Coarse lifecycle events appended to `events.jsonl`. */
export type RunLifecycleEvent =
  | { version: 1; event: 'run_created'; runId: string; timestamp: number }
  | {
      version: 1;
      event: 'run_claimed';
      runId: string;
      timestamp: number;
      claimId: string;
      ticket: number;
    }
  | {
      version: 1;
      event: 'unit_started';
      runId: string;
      timestamp: number;
      unitId: string;
      attempt: number;
    }
  | {
      version: 1;
      event: 'unit_terminal';
      runId: string;
      timestamp: number;
      unitId: string;
      attempt: number;
      status: ExecutionStatus | 'interrupted';
    }
  | {
      version: 1;
      event: 'run_interrupted';
      runId: string;
      timestamp: number;
      origin: RunAbortOrigin;
    }
  | {
      version: 1;
      event: 'run_resumed';
      runId: string;
      timestamp: number;
      claimId: string;
      ticket: number;
    }
  | { version: 1; event: 'run_terminal'; runId: string; timestamp: number; status: RunStatus };

/** Error codes returned by the run store. */
export type RunStoreErrorCode =
  'corrupt_run' | 'run_not_found' | 'run_active' | 'claim_corrupt' | 'run_store_error';

export interface RunStoreError {
  code: RunStoreErrorCode;
  message: string;
  runId?: string;
}

/** A run record plus its resolved directory path, returned by list/get. */
export interface LoadedRun {
  runDir: string;
  record: AgentRunRecordV1;
}

/** A corrupt or unreadable run surfaced as a diagnostic by listRuns. */
export interface CorruptRunEntry {
  runId: string;
  runDir: string;
  code: 'corrupt_run';
  message: string;
}

export type ListRunsResult = Array<LoadedRun | CorruptRunEntry>;

/** Result of an acquire attempt against a run's ticket lock. */
export type ClaimResult =
  { ok: true; claimId: string; ticket: number } | { ok: false; error: RunStoreError };
