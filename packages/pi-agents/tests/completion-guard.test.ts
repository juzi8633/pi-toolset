// ABOUTME: Tests for the completion guard — mutating detection, heading validation, and opt-out.
// ABOUTME: Pure function tests; no subprocess or git interaction required.

import { describe, expect, it } from 'bun:test';
import type { AgentConfig } from '../src/agents.ts';
import {
  agentCanMutate,
  isCompletionGuardEnabled,
  validateCompletionOutput,
} from '../src/completion-guard.ts';

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

describe('agentCanMutate', () => {
  it('treats undefined tools (inherits all) as mutating', () => {
    expect(agentCanMutate(makeAgent())).toBe(true);
  });

  it('returns true when tools includes edit, write, or bash and they are not excluded', () => {
    expect(agentCanMutate(makeAgent({ tools: ['read', 'edit'] }))).toBe(true);
    expect(agentCanMutate(makeAgent({ tools: ['bash'] }))).toBe(true);
    expect(agentCanMutate(makeAgent({ tools: ['write', 'read'] }))).toBe(true);
  });

  it('returns false when all mutating tools are excluded', () => {
    expect(
      agentCanMutate(
        makeAgent({
          tools: ['read', 'edit', 'write', 'bash'],
          excludeTools: ['edit', 'write', 'bash'],
        })
      )
    ).toBe(false);
  });

  it('returns false when tools is a read-only allowlist', () => {
    expect(agentCanMutate(makeAgent({ tools: ['read', 'grep', 'find'] }))).toBe(false);
  });
});

describe('isCompletionGuardEnabled', () => {
  it('honors explicit completionGuard=true even for read-only agents', () => {
    expect(isCompletionGuardEnabled(makeAgent({ tools: ['read'], completionGuard: true }))).toBe(
      true
    );
  });

  it('honors explicit completionGuard=false even for mutating agents', () => {
    expect(
      isCompletionGuardEnabled(
        makeAgent({
          tools: ['read', 'bash'],
          excludeTools: ['edit', 'write', 'agent'],
          completionGuard: false,
        })
      )
    ).toBe(false);
  });

  it('infers from agentCanMutate when not set', () => {
    expect(isCompletionGuardEnabled(makeAgent({ tools: ['read'] }))).toBe(false);
    expect(isCompletionGuardEnabled(makeAgent({ tools: ['edit'] }))).toBe(true);
  });
});

describe('validateCompletionOutput', () => {
  const mutatingAgent = makeAgent({ tools: ['read', 'edit', 'bash'] });
  const goodOutput = `## Completed\n\nDid the thing.\n\n## Files Changed\n\n- a.ts\n\n## Validation\n\nRan bun test, all pass.`;

  it('passes when guard is disabled', () => {
    const reviewer = makeAgent({
      tools: ['read', 'grep', 'find', 'ls', 'bash'],
      excludeTools: ['edit', 'write', 'agent'],
      completionGuard: false,
    });
    expect(validateCompletionOutput(reviewer, '').ok).toBe(true);
  });

  it('passes for valid mutating-agent output with all three headings', () => {
    const result = validateCompletionOutput(mutatingAgent, goodOutput);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('fails when ## Validation is missing', () => {
    const output = `## Completed\n\nx\n\n## Files Changed\n\n- a.ts`;
    const result = validateCompletionOutput(mutatingAgent, output);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('## Validation');
  });

  it('reports every missing heading', () => {
    const result = validateCompletionOutput(mutatingAgent, 'just a sentence');
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['## Completed', '## Files Changed', '## Validation']);
  });

  it('accepts headings with trailing newline or end-of-string boundary', () => {
    const output = `## Completed\n## Files Changed\n## Validation`;
    const result = validateCompletionOutput(mutatingAgent, output);
    expect(result.ok).toBe(true);
  });

  it('rejects looser matches like `## Completed!` or `### Completed`', () => {
    const looser = `## Completed!\n## Files Changed\n## Validation`;
    expect(validateCompletionOutput(mutatingAgent, looser).missing).toContain('## Completed');
    const deeper = `### Completed\n## Files Changed\n## Validation`;
    expect(validateCompletionOutput(mutatingAgent, deeper).missing).toContain('## Completed');
  });
});
