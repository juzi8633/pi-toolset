// ABOUTME: Security helpers for subagent execution — nesting depth guard, child env, and tool CLI args.
// ABOUTME: Centralizes denylist enforcement and PI_AGENT_* environment variable conventions.

import type { AgentConfig } from './agents.ts';
import {
  AGENT_TOOL_NAME,
  DEFAULT_AGENT_MAX_DEPTH,
  PI_AGENT_CHILD,
  PI_AGENT_DEPTH,
  PI_AGENT_MAX_DEPTH,
  PI_AGENT_TOOL_AVAILABLE,
} from './constants.ts';

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function readNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return fallback;
  return n;
}

export function isAgentToolName(name: string): boolean {
  return name.trim().toLowerCase() === AGENT_TOOL_NAME;
}

export function getCurrentAgentDepth(env: EnvLike): number {
  return readNonNegativeInt(env[PI_AGENT_DEPTH], 0);
}

export function getMaxAgentDepth(env: EnvLike): number {
  return readPositiveInt(env[PI_AGENT_MAX_DEPTH], DEFAULT_AGENT_MAX_DEPTH);
}

export function agentToolAllowedByConfig(agent: AgentConfig): boolean {
  if (agent.excludeTools && agent.excludeTools.some(isAgentToolName)) return false;
  if (agent.tools && !agent.tools.some(isAgentToolName)) return false;
  return true;
}

export function isAgentDelegationAllowed(env: EnvLike): boolean {
  if (env[PI_AGENT_TOOL_AVAILABLE] === '0') return false;
  return getCurrentAgentDepth(env) < getMaxAgentDepth(env);
}

export function assertAgentDelegationAllowed(env: EnvLike): void {
  if (env[PI_AGENT_TOOL_AVAILABLE] === '0') {
    throw new Error('Agent tool is unavailable in this context');
  }
  const depth = getCurrentAgentDepth(env);
  const max = getMaxAgentDepth(env);
  if (depth >= max) {
    throw new Error(`Agent nesting depth exceeded: ${depth}/${max}`);
  }
}

/**
 * Depth-only guard kept for back-compat with callers that only cared about
 * `PI_AGENT_DEPTH` / `PI_AGENT_MAX_DEPTH`. New code should call
 * `assertAgentDelegationAllowed` so capability flags are honored too.
 */
export function assertDepthAllowed(env: EnvLike): void {
  const depth = getCurrentAgentDepth(env);
  const max = getMaxAgentDepth(env);
  if (depth >= max) {
    throw new Error(`Agent nesting depth exceeded: ${depth}/${max}`);
  }
}

export interface ChildEnvOptions {
  agent?: AgentConfig;
}

export function buildChildAgentEnv(
  parentEnv: EnvLike,
  options: ChildEnvOptions = {}
): NodeJS.ProcessEnv {
  const parentDepth = getCurrentAgentDepth(parentEnv);
  const childDepth = parentDepth + 1;
  const parentMax = getMaxAgentDepth(parentEnv);
  const parentAllowsDelegation = parentEnv[PI_AGENT_TOOL_AVAILABLE] !== '0';
  const agent = options.agent;
  const cappedMax =
    agent?.maxSubagentDepth === undefined
      ? parentMax
      : Math.min(parentMax, childDepth + agent.maxSubagentDepth);
  const childCanDelegate =
    parentAllowsDelegation &&
    childDepth < cappedMax &&
    (agent ? agentToolAllowedByConfig(agent) : true);
  return {
    ...parentEnv,
    [PI_AGENT_CHILD]: '1',
    [PI_AGENT_DEPTH]: String(childDepth),
    [PI_AGENT_MAX_DEPTH]: String(cappedMax),
    [PI_AGENT_TOOL_AVAILABLE]: childCanDelegate ? '1' : '0',
  } as NodeJS.ProcessEnv;
}

export interface ToolCliArgsOptions {
  disableAgentTool?: boolean;
  /** Force-include the dedicated child artifact reader when a handoff requires it. */
  requireArtifactReader?: boolean;
}

const ARTIFACT_READER_TOOL = 'pi_agents_read_artifact';

export function buildToolCliArgs(agent: AgentConfig, options: ToolCliArgsOptions = {}): string[] {
  const args: string[] = [];
  if (agent.tools && agent.tools.length > 0) {
    const tools = [...agent.tools];
    if (options.requireArtifactReader && !tools.includes(ARTIFACT_READER_TOOL)) {
      tools.push(ARTIFACT_READER_TOOL);
    }
    args.push('--tools', tools.join(','));
  }
  const excludes = agent.excludeTools ? [...agent.excludeTools] : [];
  if (options.disableAgentTool) {
    // Normalize any case/whitespace variant the agent author wrote and ensure
    // a canonical `agent` entry is present, so the CLI denylist always matches
    // the tool name Pi exposes.
    const filtered = excludes.filter((name) => !isAgentToolName(name));
    filtered.push(AGENT_TOOL_NAME);
    excludes.length = 0;
    excludes.push(...filtered);
  }
  if (options.requireArtifactReader) {
    // Only remove the dedicated reader from excludes; do not broaden other tools.
    const filtered = excludes.filter((name) => name !== ARTIFACT_READER_TOOL);
    excludes.length = 0;
    excludes.push(...filtered);
  }
  if (excludes.length > 0) {
    args.push('--exclude-tools', excludes.join(','));
  }
  return args;
}
