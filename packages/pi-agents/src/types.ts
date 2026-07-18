// ABOUTME: Shared runtime types for subagent results, usage stats, and display items.
// ABOUTME: Re-exported from agents.ts scope/source types and consumed across execution and rendering.

import type { Message } from '@earendil-works/pi-ai';
import type { AgentScope, AgentSource } from './agents.ts';
import type { ResumeCapability, RunArtifactRefV1 } from './run-types.ts';

export type SystemPromptMode = 'append' | 'replace';
export type DefaultContext = 'fresh' | 'fork';
export type IsolationMode = 'none' | 'worktree';

/** Authoritative execution-unit status for rendering and progress counts. */
export type ExecutionStatus =
  'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped' | 'interrupted';

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/** Fanout item identity on a SingleResult execution unit. */
export interface FanoutIdentity {
  /** Zero-based index among actually executed items. */
  index: number;
  /** Number of items that actually ran (not skipped by maxItems). */
  count: number;
  /** Rendered task text for this item. */
  itemTask?: string;
}

export type DisplayItem =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; name: string; args: Record<string, unknown> };

/** Shared presentation fields for compact parent/durable results. */
interface ResultPresentationBase {
  /** Ordered assistant text/tool-call items except the text selected as final output. */
  transcript: DisplayItem[];
  /**
   * Latest activity when it cannot be derived from `finalOutput`
   * (e.g. a trailing tool call, or text that differs from final output).
   */
  latestActivity?: DisplayItem;
}

/**
 * Compact assistant presentation for parent/durable results.
 * Truncation is either absent (both `truncated` and `omittedItems` forbidden)
 * or `truncated: true` with a required positive `omittedItems` count.
 */
export type ResultPresentation =
  | (ResultPresentationBase & { truncated?: never; omittedItems?: never })
  | (ResultPresentationBase & { truncated: true; omittedItems: number });

export interface SingleResult {
  agent: string;
  agentSource: AgentSource | 'unknown';
  task: string;
  /** Short collapsed-summary label (soft ~30 char guidance); clamped to 30 terminal columns when rendering. */
  title?: string;
  exitCode: number;
  /** Explicit status; older sessions may omit this and renderers fall back. */
  status?: ExecutionStatus;
  messages: Message[];
  /**
   * Compact presentation for parent/durable snapshots.
   * When present, rendering and result-aware helpers prefer this over `messages`.
   * Legacy Version 1 records omit this field and keep full `messages`.
   */
  presentation?: ResultPresentation;
  stderr: string;
  usage: UsageStats;
  model?: string;
  thinking?: string;
  stopReason?: string;
  errorMessage?: string;
  /**
   * Structured failure code when available (e.g. `dispose_failed`,
   * `acp_session_not_found`, `acp_cwd_mismatch`, `transport_error`).
   * Copied from InteractiveAgentError / GrokAcpClientError / endpoint snapshots.
   */
  errorCode?: string;
  /** Captured `Error.stack` when a thrown error is turned into a failed result. */
  errorStack?: string;
  step?: number;
  /** Present when this result is a fanout execution unit. */
  fanout?: FanoutIdentity;
  worktreePath?: string;
  worktreeDirty?: boolean;
  worktreeDiffStat?: string;
  worktreeChangedFiles?: string[];
  worktreeSetupError?: string;
  finalOutput?: string;
  /** Artifact ref for oversized final text; mutually exclusive with finalOutput. */
  finalOutputRef?: RunArtifactRefV1;
  structuredOutput?: unknown;
  /** Artifact ref for oversized structured output; mutually exclusive with structuredOutput. */
  structuredOutputRef?: RunArtifactRefV1;
  structuredOutputError?: string;
  /** Durable run this unit belongs to; additive for older sessions. */
  runId?: string;
  /** Stable execution-unit id within the run. */
  unitId?: string;
  /** Current attempt number (1-based) for this unit. */
  attempt?: number;
  /** Persisted Pi session file backing this unit, when any. */
  sessionFile?: string;
  /**
   * ACP protocol session ID for `runtime: "grok-acp"` units.
   * Protocol identity only — never a private Grok session-file path.
   */
  acpSessionId?: string;
  /** Resume capability this unit advertises (`session`). */
  resumeCapability?: ResumeCapability;
}

export interface ChainOutputEntry {
  text?: string;
  /** Artifact ref for oversized chain text; mutually exclusive with text. */
  textRef?: RunArtifactRefV1;
  structured?: unknown;
  /** Artifact ref for oversized structured chain output; mutually exclusive with structured. */
  structuredRef?: RunArtifactRefV1;
  agent: string;
  step: number;
}

/** Sequential logical step in a Chain workflow. */
export interface ChainSequentialStep {
  kind: 'sequential';
  step: number;
  agent: string;
  task: string;
  /** Short collapsed-summary label from the step `title` parameter. */
  title?: string;
  status: ExecutionStatus;
}

/** Fanout logical step - one Chain step regardless of item count. */
export interface ChainFanoutStep {
  kind: 'fanout';
  step: number;
  agent: string;
  taskTemplate: string;
  /** Short collapsed-summary label from `parallel.title`. */
  title?: string;
  status: ExecutionStatus;
  sourceOutput?: string;
  sourcePath?: string;
  collectName: string;
  concurrency?: number;
  executedCount: number;
  completedCount: number;
  failedCount: number;
  runningCount: number;
  queuedCount: number;
  skippedCount: number;
  /** Zero-based index of the fanout item that last produced activity. */
  latestIndex?: number;
}

export type ChainLogicalStep = ChainSequentialStep | ChainFanoutStep;

/**
 * Logical Chain progress. Fanout produces many results but counts as one step.
 * `results` remain ordered execution-unit snapshots; do not derive step count from results.length.
 */
export interface ChainExecutionDetails {
  totalSteps: number;
  steps: ChainLogicalStep[];
}

export type BackgroundJobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackgroundLaunchDetails {
  jobId: string;
  mode: 'single' | 'parallel' | 'chain';
  status: BackgroundJobStatus;
  agentScope: AgentScope;
  description: string;
  /** Short label for the launch summary; falls back to `taskPreview` when blank. */
  title?: string;
  startedAt: number;
  taskPreview: string;
}

export interface BackgroundNotificationDetails {
  jobId: string;
  mode: 'single' | 'parallel' | 'chain';
  status: BackgroundJobStatus;
  description: string;
  startedAt: number;
  finishedAt: number;
  durationMs?: number;
  result?: string;
  error?: string;
}

export interface SubagentDetails {
  mode: 'single' | 'parallel' | 'chain' | 'background';
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  builtinAgentsDir: string;
  /** Ordered execution-unit snapshots (Single, Parallel tasks, or Chain units including fanout items). */
  results: SingleResult[];
  outputs?: Record<string, ChainOutputEntry>;
  /** Logical Chain workflow state; additive for older sessions without it. */
  chain?: ChainExecutionDetails;
  background?: BackgroundLaunchDetails[];
  /** Durable run metadata; additive for older sessions without a run. */
  run?: {
    runId: string;
    status: import('./run-types.ts').RunStatus;
    resumable: boolean;
    /** Aggregate resume capability across units (`session`). */
    capability: 'session';
  };
}

/** Re-export leaf factory so tests/callers can keep importing from types. */
export { emptyUsage } from './empty-usage.ts';

/**
 * Deep-clone a result for delivery snapshots.
 * Parsers mutate messages/content/tool arguments/usage in place; consumers must not share those refs.
 */
export function cloneSingleResult(result: SingleResult): SingleResult {
  return {
    ...result,
    messages: result.messages.map((message) => structuredClone(message)),
    presentation: result.presentation ? structuredClone(result.presentation) : undefined,
    usage: { ...result.usage },
    fanout: result.fanout ? { ...result.fanout } : undefined,
    worktreeChangedFiles: result.worktreeChangedFiles
      ? [...result.worktreeChangedFiles]
      : undefined,
    structuredOutput:
      result.structuredOutput !== undefined ? structuredClone(result.structuredOutput) : undefined,
  };
}

export function cloneResults(results: SingleResult[]): SingleResult[] {
  return results.map(cloneSingleResult);
}
