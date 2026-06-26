// ABOUTME: Completion guard for mutating agents — checks output has required handoff headings.
// ABOUTME: Enforces `## Completed`, `## Files Changed`, and `## Validation` when an agent can mutate.

import type { AgentConfig } from './agents.ts';

const MUTATING_TOOLS = new Set(['edit', 'write', 'bash']);
const REQUIRED_HEADINGS = ['## Completed', '## Files Changed', '## Validation'] as const;

export function agentCanMutate(agent: AgentConfig): boolean {
  const excluded = new Set((agent.excludeTools ?? []).map((t) => t.trim().toLowerCase()));
  const tools = agent.tools;
  if (!tools) {
    return Array.from(MUTATING_TOOLS).some((t) => !excluded.has(t));
  }
  const allowed = new Set(tools.map((t) => t.trim().toLowerCase()));
  for (const tool of MUTATING_TOOLS) {
    if (allowed.has(tool) && !excluded.has(tool)) return true;
  }
  return false;
}

export function isCompletionGuardEnabled(agent: AgentConfig): boolean {
  if (typeof agent.completionGuard === 'boolean') return agent.completionGuard;
  return agentCanMutate(agent);
}

export interface CompletionValidation {
  ok: boolean;
  missing: string[];
}

function hasHeading(output: string, heading: string): boolean {
  // Require an exact heading line: optional leading whitespace, the heading text,
  // then either end-of-string or whitespace before the next character. Rejects
  // `### Completed`, `## CompletedItems`, but accepts `## Completed` with trailing
  // whitespace, `##  Completed` (extra space normalized via the prefix), or `## Completed\n...`.
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\n)\\s*${escaped}(\\s|$)`, 'i');
  return re.test(output);
}

export function validateCompletionOutput(agent: AgentConfig, output: string): CompletionValidation {
  if (!isCompletionGuardEnabled(agent)) {
    return { ok: true, missing: [] };
  }
  const missing = REQUIRED_HEADINGS.filter((h) => !hasHeading(output, h));
  return { ok: missing.length === 0, missing };
}
