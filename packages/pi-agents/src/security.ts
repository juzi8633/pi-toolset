// ABOUTME: Security helpers for subagent execution — nesting depth guard, child env, and tool CLI args.
// ABOUTME: Centralizes denylist enforcement and PI_AGENT_* environment variable conventions.

import type { AgentConfig } from './agents.ts';
import {
  DEFAULT_AGENT_MAX_DEPTH,
  PI_AGENT_CHILD,
  PI_AGENT_DEPTH,
  PI_AGENT_MAX_DEPTH,
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

export function getCurrentAgentDepth(env: EnvLike): number {
  return readNonNegativeInt(env[PI_AGENT_DEPTH], 0);
}

export function getMaxAgentDepth(env: EnvLike): number {
  return readPositiveInt(env[PI_AGENT_MAX_DEPTH], DEFAULT_AGENT_MAX_DEPTH);
}

export function assertDepthAllowed(env: EnvLike): void {
  const depth = getCurrentAgentDepth(env);
  const max = getMaxAgentDepth(env);
  if (depth >= max) {
    throw new Error(`Agent nesting depth exceeded: ${depth}/${max}`);
  }
}

export function buildChildAgentEnv(parentEnv: EnvLike): NodeJS.ProcessEnv {
  const depth = getCurrentAgentDepth(parentEnv);
  const existingMax = parentEnv[PI_AGENT_MAX_DEPTH];
  const maxParsed = existingMax !== undefined ? Number(existingMax) : NaN;
  const maxValue =
    Number.isFinite(maxParsed) && Number.isInteger(maxParsed) && maxParsed > 0
      ? String(maxParsed)
      : String(DEFAULT_AGENT_MAX_DEPTH);
  return {
    ...parentEnv,
    [PI_AGENT_CHILD]: '1',
    [PI_AGENT_DEPTH]: String(depth + 1),
    [PI_AGENT_MAX_DEPTH]: maxValue,
  } as NodeJS.ProcessEnv;
}

export function buildToolCliArgs(agent: AgentConfig): string[] {
  const args: string[] = [];
  if (agent.tools && agent.tools.length > 0) {
    args.push('--tools', agent.tools.join(','));
  }
  if (agent.excludeTools && agent.excludeTools.length > 0) {
    args.push('--exclude-tools', agent.excludeTools.join(','));
  }
  return args;
}
