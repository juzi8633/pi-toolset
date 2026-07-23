// ABOUTME: Shared single-agent execution contracts with no value imports from execution implementations.
// ABOUTME: Leaf types for spawn, resume prompts, update callbacks, and run options.

import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Runtime } from '../config/agents.ts';
import type { UnitExecutionContext } from '../run/run-coordinator.ts';
import type { RunAbortOrigin } from '../run/run-types.ts';
import type { SubagentDetails } from '../shared/types.ts';

export interface SpawnedChild extends ChildProcess {
  stdout: Readable;
  stderr: Readable;
}

export type SpawnFn = (command: string, args: string[], options: object) => SpawnedChild;

/** Resume prompt metadata threaded from a durable resume into child invocation. */
export interface ResumePromptContext {
  /** Full durable continuation history (including the current call when already claimed). */
  continuationTasks: string[];
  /**
   * Continuations not yet confirmed delivered for this unit. Existing Pi sessions
   * receive only these (plus the fixed safety prompt). Prefer this over
   * `currentContinuationTask` when delivery tracking is active.
   */
  undeliveredContinuationTasks?: string[];
  /** Current call's continuation; used when undelivered list is not provided. */
  currentContinuationTask?: string;
}

export interface RunSingleAgentOptions {
  spawnFn?: SpawnFn;
  sessionFile?: string;
  resolvedSkillPaths?: string[];
  modelOverride?: string;
  thinkingOverride?: string;
  runtimeOverride?: Runtime;
  /** Short collapsed-summary label stamped onto every emitted result snapshot. */
  title?: string;
  /** Durable run/unit/attempt identity stamped onto every emitted snapshot. */
  unitContext?: UnitExecutionContext;
  /** Supplies the carried abort origin so terminal snapshots classify as cancelled/interrupted. */
  getAbortOrigin?: () => RunAbortOrigin;
  /** Host extension mode; TUI Pi units with a registry endpoint use RPC execution. */
  hostMode?: 'tui' | 'rpc' | 'json' | 'print';
  /** Interactive registry handle for TUI Pi RPC execution. */
  interactiveRegistry?: import('../interactive/interactive-agent.ts').InteractiveAgentRegistry;
  /** Endpoint key (`runId:unitId`) registered before spawn. */
  endpointKey?: string;
  /**
   * When set, this invocation is part of a durable resume. Existing Pi sessions
   * receive a session-continuation prompt; never-started units receive the
   * original task plus accumulated continuation tasks.
   */
  resumePrompt?: ResumePromptContext;
  /**
   * Explicit prompt-kind flag for resume. When true, send session-continuation
   * (unit already owned a stored session before this invocation). When false,
   * send original task + continuations even if a session file was just created.
   * Required for correct never-started unit resume after prepareAgentContext.
   */
  resumeHadStoredSession?: boolean;
  /** Called once the child has accepted the resume or original prompt (spawn or RPC activate). */
  onResumePromptAccepted?: () => void;
  /**
   * Awaited once Pi has accepted the unit's original (or fresh) prompt so durable
   * sessionPromptEstablished can be written. Write failure must fail-close the turn.
   * Not used for Grok ACP (session history after load is the authority).
   */
  onSessionPromptEstablished?: () => void | Promise<void>;
  /**
   * Awaited after session/new returns a non-empty ACP session ID and before the
   * first prompt. Used for durable disk-first session-ID persistence.
   */
  onAcpSessionEstablished?: (sessionId: string) => void | Promise<void>;
  /**
   * Grok ACP only: awaited after the matching prompt response (not dispatch accept).
   * Used for strict continuation-delivery persistence.
   */
  onAcpPromptCompleted?: () => void | Promise<void>;
  /**
   * Fresh TUI Grok ACP: after durable session ID + lease, register the live
   * transport on the interactive registry (binding/link) and return endpoint key.
   *
   * Ownership: caller keeps transport/lease until `acceptOwnership` runs
   * (synchronously after registry `beginPendingOwner`). Adapter may throw during
   * precompute before that call; caller catch still disposes.
   */
  registerGrokAcpLiveEndpoint?: (input: {
    sessionId: string;
    transport: import('../interactive/interactive-transport.ts').InteractiveAgentTransport;
    leaseRelease: (err?: Error) => void;
    /** Sync handoff: registry owns cleanup after this returns. */
    acceptOwnership: () => void;
  }) => Promise<string>;
}

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;
