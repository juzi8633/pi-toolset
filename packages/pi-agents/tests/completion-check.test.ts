// ABOUTME: Tests for completion checks — configured heading validation and opt-in behavior.
// ABOUTME: Pure function tests; no subprocess or git interaction required.

import { describe, expect, it } from 'bun:test';
import type { AgentConfig } from '../src/agents.ts';
import { enforceCompletionCheck, validateCompletionOutput } from '../src/completion-check.ts';
import { getResultOutput } from '../src/output.ts';
import { emptyUsage, type SingleResult } from '../src/types.ts';

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

describe('enforceCompletionCheck', () => {
  function completedResult(text: string): SingleResult {
    return {
      agent: 'guardy',
      agentSource: 'builtin',
      task: 'do work',
      exitCode: 0,
      status: 'completed',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text }],
        } as SingleResult['messages'][number],
      ],
      stderr: '',
      usage: emptyUsage(),
    };
  }

  it('sets explicit status failed when required headings are missing', () => {
    const agent = makeAgent({
      completionCheck: ['## Completed', '## Validation'],
    });
    const result = completedResult('no headings here');
    enforceCompletionCheck(agent, result);
    expect(result.status).toBe('failed');
    expect(result.stopReason).toBe('completion_check');
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain('## Completed');
  });

  it('relays unchecked final output after a completion-check warning', () => {
    const agent = makeAgent({
      completionCheck: ['## Completed', '## Validation'],
    });
    const original = '## Completed\n\nDid partial work without Validation.';
    const result = completedResult(original);
    enforceCompletionCheck(agent, result);

    expect(result.status).toBe('failed');
    expect(result.stopReason).toBe('completion_check');
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe('Completion check failed: missing ## Validation');

    const formatted = getResultOutput(result);
    expect(formatted.startsWith('Completion check failed: missing ## Validation')).toBe(true);
    expect(formatted).toContain('Unchecked agent output:');
    const warningEnd = formatted.indexOf('Unchecked agent output:');
    const outputStart = formatted.indexOf(original);
    expect(warningEnd).toBeGreaterThanOrEqual(0);
    expect(outputStart).toBeGreaterThan(warningEnd);
    expect(formatted.slice(outputStart)).toBe(original);
  });

  it('uses the no-output fallback when completion check fails without assistant text', () => {
    const agent = makeAgent({ completionCheck: ['## Completed'] });
    const result = completedResult('');
    result.messages = [];
    enforceCompletionCheck(agent, result);
    const formatted = getResultOutput(result);
    expect(formatted).toContain('Completion check failed: missing ## Completed');
    expect(formatted).toContain('Unchecked agent output:\n(no output)');
  });

  it('leaves successful results with matching headings unchanged', () => {
    const agent = makeAgent({ completionCheck: ['## Completed'] });
    const result = completedResult('## Completed\n\nok');
    enforceCompletionCheck(agent, result);
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.stopReason).toBeUndefined();
  });

  it('does not override an already-failed result', () => {
    const agent = makeAgent({ completionCheck: ['## Completed'] });
    const result = completedResult('nope');
    result.status = 'failed';
    result.exitCode = 1;
    result.stopReason = 'error';
    result.errorMessage = 'prior';
    enforceCompletionCheck(agent, result);
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toBe('prior');
  });

  it('keeps generic error-message precedence for non-completion failures', () => {
    const result = completedResult('agent said this');
    result.status = 'failed';
    result.exitCode = 1;
    result.stopReason = 'error';
    result.errorMessage = 'boom';
    result.stderr = 'stderr noise';
    expect(getResultOutput(result)).toBe('boom');

    delete result.errorMessage;
    expect(getResultOutput(result)).toBe('stderr noise');

    result.stderr = '';
    expect(getResultOutput(result)).toBe('agent said this');
  });
});
