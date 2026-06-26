// ABOUTME: Shared runtime types for subagent results, usage stats, and display items.
// ABOUTME: Re-exported from agents.ts scope/source types and consumed across execution and rendering.

import type { Message } from '@earendil-works/pi-ai';
import type { AgentScope, AgentSource } from './agents.ts';

export type SystemPromptMode = 'append' | 'replace';
export type DefaultContext = 'fresh' | 'fork';
export type IsolationMode = 'none' | 'worktree';

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: AgentSource | 'unknown';
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

export interface SubagentDetails {
  mode: 'single' | 'parallel' | 'chain';
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  builtinAgentsDir: string;
  results: SingleResult[];
}

export type DisplayItem =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; name: string; args: Record<string, unknown> };
