// ABOUTME: Pure helpers for the `before_agent_start` agent-catalogue prompt injection.
// ABOUTME: Decides whether to inject the list and renders the system-prompt block.

import type { AgentConfig } from './agents.ts';
import { isAgentDelegationAllowed } from '../execution/security.ts';

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

export function shouldInjectAgentCatalogue(env: EnvLike, agents: AgentConfig[]): boolean {
  if (!isAgentDelegationAllowed(env)) return false;
  return agents.length > 0;
}

export function renderAgentCatalogue(agents: AgentConfig[]): string {
  const lines = agents.map((a) => `- ${a.name}: ${a.description}`).join('\n');
  return `Available agent types for the \`agent\` tool:\n${lines}`;
}
