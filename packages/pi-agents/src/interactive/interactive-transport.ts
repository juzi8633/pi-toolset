// ABOUTME: Runtime-neutral interactive session artifact, transport, state, and event contracts.
// ABOUTME: Shared by Pi RPC and Grok ACP so one registry owns either long-lived child process.

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { UsageStats } from '../shared/types.ts';

/** Discriminated session identity carried by interactive endpoints and launch specs. */
export type InteractiveSessionArtifact =
  { runtime: 'pi'; sessionFile: string } | { runtime: 'grok-acp'; sessionId: string };

/** How text input is handled while a turn is starting or running. */
export type InteractiveRunningInput = 'steer-follow-up' | 'unsupported';

export type InteractiveTransportRuntime = InteractiveSessionArtifact['runtime'];

export interface InteractiveTransportState {
  running: boolean;
  idle: boolean;
  disposed: boolean;
  /** Post-baseline message count when known. */
  messageCount?: number;
  model?: string;
  usage?: UsageStats;
  lastError?: string;
}

export interface InteractivePromptCompletedEvent {
  type: 'prompt_completed';
  /** Formal SingleResult stop reason (end / max_turns / error / aborted). */
  stopReason: string;
  usage?: UsageStats;
  model?: string;
  responseMeta?: Record<string, unknown>;
  /** Present when stopReason is a non-success terminal (refusal, max tokens, …). */
  errorMessage?: string;
}

/** Structured prompt/transport failure before or instead of a real response. */
export interface InteractivePromptFailedEvent {
  type: 'prompt_failed';
  error: string;
  code?: string;
}

export type InteractiveTransportEvent =
  | { type: 'agent_start' }
  | { type: 'agent_settled' }
  | { type: 'message_start'; message: AgentMessage }
  | { type: 'message_update'; message: AgentMessage }
  | { type: 'message_end'; message: AgentMessage }
  | {
      type: 'tool_execution_start';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      type: 'tool_execution_update';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      partialResult?: unknown;
    }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result?: unknown;
      isError?: boolean;
    }
  | {
      type: 'turn_start';
      turnIndex?: number;
    }
  | {
      type: 'turn_end';
      message?: AgentMessage;
      toolResults?: AgentMessage[];
    }
  | InteractivePromptCompletedEvent
  | InteractivePromptFailedEvent
  | {
      type: 'exit';
      intentional: boolean;
      error: Error;
      code?: number | null;
    }
  | {
      type: 'usage_update';
      usage: UsageStats;
      model?: string;
    }
  | {
      type: 'queue_update';
      steering?: string[];
      followUp?: string[];
    }
  | {
      type: 'compaction_start';
    }
  | {
      type: 'compaction_end';
    }
  | {
      type: 'auto_retry_start';
    }
  | {
      type: 'auto_retry_end';
    };

/**
 * Minimum shared contract for long-lived interactive child transports.
 * `prompt()` resolves at dispatch acceptance, not turn completion.
 * Turn completion is reported via `prompt_completed` then the settled boundary.
 */
export interface InteractiveAgentTransport {
  readonly runtime: InteractiveTransportRuntime;
  readonly runningInput: InteractiveRunningInput;
  subscribe(listener: (event: InteractiveTransportEvent) => void): () => void;
  /** Accept a prompt for dispatch; resolves when the write/request is registered. */
  prompt(message: string): Promise<void>;
  steer?(message: string): Promise<void>;
  followUp?(message: string): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<InteractiveTransportState>;
  dispose(): Promise<void>;
  getStderr(): string;
}

/** Type guard for Pi session artifacts. */
export function isPiSessionArtifact(
  artifact: InteractiveSessionArtifact | undefined
): artifact is { runtime: 'pi'; sessionFile: string } {
  return artifact?.runtime === 'pi';
}

/** Type guard for Grok ACP session artifacts. */
export function isGrokAcpSessionArtifact(
  artifact: InteractiveSessionArtifact | undefined
): artifact is { runtime: 'grok-acp'; sessionId: string } {
  return artifact?.runtime === 'grok-acp';
}

/** Extract Pi session file from an artifact, or empty string when not Pi. */
export function piSessionFile(artifact: InteractiveSessionArtifact | undefined): string {
  return artifact?.runtime === 'pi' ? artifact.sessionFile : '';
}

/** Short display label for a session artifact (never a private Grok path). */
export function sessionArtifactLabel(artifact: InteractiveSessionArtifact | undefined): string {
  if (!artifact) return '';
  if (artifact.runtime === 'pi') return artifact.sessionFile;
  const id = artifact.sessionId;
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}
