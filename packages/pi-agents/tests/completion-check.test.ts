// ABOUTME: Tests for completion checks — configured heading validation and opt-in behavior.
// ABOUTME: Pure function tests; no subprocess or git interaction required.

import { describe, expect, it } from 'bun:test';
import type { AgentConfig } from '../src/agents.ts';
import { validateCompletionOutput } from '../src/completion-check.ts';

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'guardy',
    description: 'test',
    systemPrompt: '',
    source: 'builtin',
    filePath: '/tmp/guardy.md',
    ...overrides,
  };
}

describe('validateCompletionOutput', () => {
  const worker = makeAgent({
    tools: ['read', 'edit', 'bash'],
    completionCheck: ['## Completed', '## Files Changed', '## Validation'],
  });
  const goodOutput = `## Completed\n\nDid the thing.\n\n## Files Changed\n\n- a.ts\n\n## Validation\n\nRan bun test, all pass.`;

  it('passes when completionCheck is omitted', () => {
    const mutatingAgent = makeAgent({ tools: ['read', 'edit', 'bash'] });
    expect(validateCompletionOutput(mutatingAgent, '').ok).toBe(true);
  });

  it('passes for valid configured output with all required headings', () => {
    const result = validateCompletionOutput(worker, goodOutput);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('fails when a configured heading is missing', () => {
    const output = `## Completed\n\nx\n\n## Files Changed\n\n- a.ts`;
    const result = validateCompletionOutput(worker, output);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('## Validation');
  });

  it('reports every missing configured heading', () => {
    const result = validateCompletionOutput(worker, 'just a sentence');
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['## Completed', '## Files Changed', '## Validation']);
  });

  it('supports agent-specific heading checks with parenthetical suffixes', () => {
    const reviewer = makeAgent({
      completionCheck: [
        '## Files Reviewed',
        '## Critical (must fix)',
        '## Warnings (should fix)',
        '## Suggestions (consider)',
        '## Summary',
      ],
    });
    const output = `## Files Reviewed\n\n- a.ts\n\n## Critical (must fix)\n\n- None.\n\n## Warnings (should fix)\n\n- None.\n\n## Suggestions (consider)\n\n- None.\n\n## Summary\n\nLooks good.`;
    expect(validateCompletionOutput(reviewer, output)).toEqual({ ok: true, missing: [] });
  });

  it('rejects partial-line matches like `## Completed extra` or `## Critical (must fix)` for `## Critical`', () => {
    const reviewerPartial = makeAgent({ completionCheck: ['## Critical', '## Warnings'] });
    const result = validateCompletionOutput(
      reviewerPartial,
      `## Critical (must fix)\n\n- None.\n\n## Warnings (should fix)`
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['## Critical', '## Warnings']);

    const trailing = `## Completed extra\n## Files Changed\n## Validation`;
    expect(validateCompletionOutput(worker, trailing).missing).toContain('## Completed');
  });

  it('accepts headings with trailing horizontal whitespace before a newline', () => {
    const output = `## Completed   \n## Files Changed\t\n## Validation`;
    const result = validateCompletionOutput(worker, output);
    expect(result.ok).toBe(true);
  });

  it('rejects looser matches like `## Completed!` or `### Completed`', () => {
    const looser = `## Completed!\n## Files Changed\n## Validation`;
    expect(validateCompletionOutput(worker, looser).missing).toContain('## Completed');
    const deeper = `### Completed\n## Files Changed\n## Validation`;
    expect(validateCompletionOutput(worker, deeper).missing).toContain('## Completed');
  });
});
