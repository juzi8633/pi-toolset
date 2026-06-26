// ABOUTME: Completion check validation for agent outputs that declare required headings.
// ABOUTME: Enforces frontmatter-configured heading checks against final assistant messages.

import type { AgentConfig } from './agents.ts';

export interface CompletionValidation {
  ok: boolean;
  missing: string[];
}

function hasHeading(output: string, heading: string): boolean {
  // Require an exact heading line: optional horizontal whitespace before and
  // after the heading text, then a line boundary. Rejects `### Completed`,
  // `## CompletedItems`, and `## Completed extra`; accepts `## Completed`,
  // `## Completed\n`, and `## Completed   ` followed by newline / EOF.
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\n)[\\t ]*${escaped}[\\t ]*(\\r?\\n|$)`, 'i');
  return re.test(output);
}

export function validateCompletionOutput(agent: AgentConfig, output: string): CompletionValidation {
  const requiredHeadings = agent.completionCheck ?? [];
  if (requiredHeadings.length === 0) {
    return { ok: true, missing: [] };
  }
  const missing = requiredHeadings.filter((h) => !hasHeading(output, h));
  return { ok: missing.length === 0, missing };
}
