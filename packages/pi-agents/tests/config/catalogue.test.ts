// ABOUTME: Tests for the agent-catalogue prompt injection decision and rendering.
// ABOUTME: Covers depth caps, capability env flag, empty agent lists, and block content.

import { describe, expect, it } from 'bun:test';
import type { AgentConfig } from '../../src/config/agents.ts';
import { renderAgentCatalogue, shouldInjectAgentCatalogue } from '../../src/config/catalogue.ts';

function makeAgent(name: string, description = `${name} agent`): AgentConfig {
  return {
    name,
    description,
    systemPrompt: '',
    source: 'builtin',
    filePath: `/tmp/${name}.md`,
  };
}

describe('shouldInjectAgentCatalogue', () => {
  it('injects when delegation is allowed and at least one agent exists', () => {
    expect(shouldInjectAgentCatalogue({}, [makeAgent('explore')])).toBe(true);
  });

  it('does not inject when the agent list is empty', () => {
    expect(shouldInjectAgentCatalogue({}, [])).toBe(false);
  });

  it('does not inject when PI_AGENT_TOOL_AVAILABLE=0', () => {
    expect(
      shouldInjectAgentCatalogue({ PI_AGENT_TOOL_AVAILABLE: '0' }, [makeAgent('explore')])
    ).toBe(false);
  });

  it('does not inject when nesting depth has reached the cap', () => {
    expect(
      shouldInjectAgentCatalogue({ PI_AGENT_DEPTH: '2', PI_AGENT_MAX_DEPTH: '2' }, [
        makeAgent('explore'),
      ])
    ).toBe(false);
  });
});

describe('renderAgentCatalogue', () => {
  it('produces a labeled block listing every agent', () => {
    const block = renderAgentCatalogue([
      makeAgent('explore', 'fast recon'),
      makeAgent('worker', 'general purpose'),
    ]);
    expect(block).toBe(
      'Available agent types for the `agent` tool:\n- explore: fast recon\n- worker: general purpose'
    );
  });
});
