// ABOUTME: Completion check validation for agent outputs that declare required headings.
// ABOUTME: Enforces frontmatter-configured heading checks against final assistant messages.

import * as Either from 'effect/Either';
import type { AgentConfig } from '../config/agents.ts';
import { getResultFinalOutput, isFailedResult } from '../output/output.ts';
import type { SingleResult } from '../shared/types.ts';

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

/** Pure core: Right = pass; Left = missing required headings. */
function validateCompletionOutputEither(
  agent: AgentConfig,
  output: string
): Either.Either<void, string[]> {
  const requiredHeadings = agent.completionCheck ?? [];
  if (requiredHeadings.length === 0) {
    return Either.void;
  }
  const missing = requiredHeadings.filter((h) => !hasHeading(output, h));
  if (missing.length === 0) {
    return Either.void;
  }
  return Either.left(missing);
}

export function validateCompletionOutput(agent: AgentConfig, output: string): CompletionValidation {
  return Either.match(validateCompletionOutputEither(agent, output), {
    onLeft: (missing) => ({ ok: false, missing }),
    onRight: () => ({ ok: true, missing: [] }),
  });
}

/**
 * Apply completion-check failure fields, including explicit status: failed.
 * No-op when the result already failed or headings are present.
 */
export function enforceCompletionCheck(agent: AgentConfig, result: SingleResult): void {
  if (isFailedResult(result)) return;
  const finalOutput = getResultFinalOutput(result);
  const validation = validateCompletionOutput(agent, finalOutput);
  if (validation.ok) return;
  const missing = validation.missing.join(', ');
  result.stopReason = 'completion_check';
  result.errorMessage = `Completion check failed: missing ${missing}`;
  result.status = 'failed';
  if (result.exitCode === 0) {
    result.exitCode = 1;
  }
}
