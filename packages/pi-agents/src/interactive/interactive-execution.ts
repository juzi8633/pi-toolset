// ABOUTME: Shared registry activation-to-SingleResult projection for interactive runtimes.
// ABOUTME: Pi RPC and Grok ACP TUI paths consume activation snapshots only — never dual-reduce.

import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { AgentConfig } from '../config/agents.ts';
import type { OnUpdateCallback, RunSingleAgentOptions } from '../execution/execution-types.ts';
import type { InteractiveAgentRegistry } from './interactive-agent.ts';
import { runSingleAgentPiRpc } from '../runtime/pi-rpc/pi-rpc-execution.ts';
import type { SingleResult, SubagentDetails } from '../shared/types.ts';

export interface RunSingleAgentInteractiveOptions extends RunSingleAgentOptions {
  interactiveRegistry: InteractiveAgentRegistry;
  endpointKey: string;
  hostMode: 'tui';
  /** Interactive runtime policy. Defaults to pi. */
  runtime?: 'pi' | 'grok-acp';
  settleTimeoutMs?: number;
  timers?: {
    setTimeout: (fn: () => void, ms?: number) => unknown;
    clearTimeout: (id: unknown) => void;
  };
  /**
   * Grok ACP only: awaited after the matching prompt completes (registry
   * agent_settled after prompt_completed). Never called from dispatch accept.
   */
  onAcpPromptCompleted?: () => void | Promise<void>;
}

/**
 * Run a single interactive agent (Pi or Grok ACP) through the registry.
 * Grok ACP: no maxTurns policy; resumeHadStoredSession follows acpSessionId.
 */
export async function runSingleAgentInteractive(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  options: RunSingleAgentInteractiveOptions
): Promise<SingleResult> {
  const runtime = options.runtime ?? 'pi';

  if (runtime === 'pi') {
    return runSingleAgentPiRpc(
      defaultCwd,
      agents,
      agentName,
      task,
      cwd,
      step,
      signal,
      onUpdate,
      makeDetails,
      {
        ...options,
        interactiveRegistry: options.interactiveRegistry,
        endpointKey: options.endpointKey,
        hostMode: 'tui',
      }
    );
  }

  return runGrokAcpInteractive(
    defaultCwd,
    agents,
    agentName,
    task,
    cwd,
    step,
    signal,
    onUpdate,
    makeDetails,
    options
  );
}

/**
 * Grok ACP interactive policy wrapper:
 * - No maxTurns enforcement (strip agent.maxTurns for this activation).
 * - Do not mark continuation delivery on activate accept; only after settle
 *   that observed a completed prompt (via onAcpPromptCompleted).
 */
async function runGrokAcpInteractive(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  options: RunSingleAgentInteractiveOptions
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);
  // Grok ACP policy: no client-side maxTurns enforcement.
  const agentsForRun = agent
    ? agents.map((a) => (a.name === agentName ? { ...a, maxTurns: undefined } : a))
    : agents;

  const acpSessionId = options.unitContext?.acpSessionId?.trim();
  const resumeHadStoredSession = options.resumeHadStoredSession ?? Boolean(acpSessionId);

  // Strip onResumePromptAccepted: Grok ACP marks delivery only after prompt completed.
  const { onResumePromptAccepted: _ignoredAccept, onAcpPromptCompleted, ...rest } = options;

  const result = await runSingleAgentPiRpc(
    defaultCwd,
    agentsForRun,
    agentName,
    task,
    cwd,
    step,
    signal,
    onUpdate,
    makeDetails,
    {
      ...rest,
      interactiveRegistry: options.interactiveRegistry,
      endpointKey: options.endpointKey,
      hostMode: 'tui',
      resumeHadStoredSession,
      sessionFile: undefined,
      // Intentionally omit onResumePromptAccepted for Grok ACP.
    }
  );

  // Delivery only after structured terminal mapping: matching response,
  // not aborted, final successful completed. Cancelled/failed/refusal/
  // max_tokens/max_turns never deliver.
  const mayDeliver =
    !!onAcpPromptCompleted &&
    result.status === 'completed' &&
    result.stopReason === 'end' &&
    result.exitCode === 0 &&
    !result.errorMessage &&
    // Explicit opt-in from projection when a real prompt_completed was observed.
    (result as { acpPromptCompleted?: boolean }).acpPromptCompleted === true;

  if (mayDeliver) {
    await onAcpPromptCompleted();
  }

  return result;
}

/** Type helper for callers that need the tool result shape. */
export type InteractiveAgentToolResult = AgentToolResult<SubagentDetails>;
