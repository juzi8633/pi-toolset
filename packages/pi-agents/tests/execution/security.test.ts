// ABOUTME: Tests for security helpers — depth guard, child env, and tool CLI args.
// ABOUTME: Exercises PI_AGENT_DEPTH/MAX_DEPTH parsing and `--tools`/`--exclude-tools` construction.

import { describe, expect, it } from 'bun:test';
import type { AgentConfig } from '../../src/config/agents.ts';
import {
  agentToolAllowedByConfig,
  assertAgentDelegationAllowed,
  assertDepthAllowed,
  buildChildAgentEnv,
  buildToolCliArgs,
  getCurrentAgentDepth,
  getMaxAgentDepth,
  isAgentDelegationAllowed,
  isAgentToolName,
} from '../../src/execution/security.ts';

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'tester',
    description: 'test',
    systemPrompt: '',
    source: 'builtin',
    filePath: '/tmp/tester.md',
    ...overrides,
  };
}

describe('isAgentToolName', () => {
  it('recognizes agent regardless of case and surrounding whitespace', () => {
    expect(isAgentToolName('agent')).toBe(true);
    expect(isAgentToolName(' Agent ')).toBe(true);
    expect(isAgentToolName('AGENT')).toBe(true);
    expect(isAgentToolName('agents')).toBe(false);
    expect(isAgentToolName('subagent')).toBe(false);
  });
});

describe('assertAgentDelegationAllowed / assertDepthAllowed', () => {
  it('allows execution when no depth env is set', () => {
    expect(() => assertAgentDelegationAllowed({})).not.toThrow();
    expect(() => assertDepthAllowed({})).not.toThrow();
  });

  it('throws when depth has reached the max', () => {
    expect(() =>
      assertAgentDelegationAllowed({ PI_AGENT_DEPTH: '2', PI_AGENT_MAX_DEPTH: '2' })
    ).toThrow('Agent nesting depth exceeded: 2/2');
  });

  it('throws when PI_AGENT_TOOL_AVAILABLE=0 regardless of depth', () => {
    expect(() =>
      assertAgentDelegationAllowed({ PI_AGENT_TOOL_AVAILABLE: '0', PI_AGENT_DEPTH: '0' })
    ).toThrow('Agent tool is unavailable');
  });

  it('treats invalid depth values as zero', () => {
    expect(() => assertAgentDelegationAllowed({ PI_AGENT_DEPTH: 'nan' })).not.toThrow();
  });

  it('uses default max of 2 when unset', () => {
    expect(getMaxAgentDepth({})).toBe(2);
    expect(getCurrentAgentDepth({})).toBe(0);
  });

  it('treats PI_AGENT_MAX_DEPTH=0 and empty string as invalid and falls back to default', () => {
    expect(getMaxAgentDepth({ PI_AGENT_MAX_DEPTH: '0' })).toBe(2);
    expect(getMaxAgentDepth({ PI_AGENT_MAX_DEPTH: '' })).toBe(2);
    expect(getMaxAgentDepth({ PI_AGENT_MAX_DEPTH: '  ' })).toBe(2);
  });
});

describe('isAgentDelegationAllowed', () => {
  it('returns true with default env', () => {
    expect(isAgentDelegationAllowed({})).toBe(true);
  });

  it('returns false when capability env is 0', () => {
    expect(isAgentDelegationAllowed({ PI_AGENT_TOOL_AVAILABLE: '0' })).toBe(false);
  });

  it('returns false when depth is at max', () => {
    expect(isAgentDelegationAllowed({ PI_AGENT_DEPTH: '2', PI_AGENT_MAX_DEPTH: '2' })).toBe(false);
  });

  it('returns true when capability env is anything other than 0', () => {
    expect(isAgentDelegationAllowed({ PI_AGENT_TOOL_AVAILABLE: '1' })).toBe(true);
  });
});

describe('agentToolAllowedByConfig', () => {
  it('returns true for default agent config', () => {
    expect(agentToolAllowedByConfig(makeAgent())).toBe(true);
  });

  it('returns false when excludeTools contains agent', () => {
    expect(agentToolAllowedByConfig(makeAgent({ excludeTools: ['agent'] }))).toBe(false);
    expect(agentToolAllowedByConfig(makeAgent({ excludeTools: ['edit', 'Agent'] }))).toBe(false);
  });

  it('returns false when tools allowlist omits agent', () => {
    expect(agentToolAllowedByConfig(makeAgent({ tools: ['read'] }))).toBe(false);
  });

  it('returns true when tools allowlist includes agent', () => {
    expect(agentToolAllowedByConfig(makeAgent({ tools: ['agent', 'read'] }))).toBe(true);
  });
});

describe('buildChildAgentEnv', () => {
  it('produces child depth 1 from empty parent env', () => {
    const env = buildChildAgentEnv({});
    expect(env.PI_AGENT_CHILD).toBe('1');
    expect(env.PI_AGENT_DEPTH).toBe('1');
    expect(env.PI_AGENT_MAX_DEPTH).toBe('2');
    expect(env.PI_AGENT_TOOL_AVAILABLE).toBe('1');
  });

  it('increments existing depth and preserves max', () => {
    const env = buildChildAgentEnv({
      PI_AGENT_DEPTH: '1',
      PI_AGENT_MAX_DEPTH: '5',
      OTHER: 'keep',
    });
    expect(env.PI_AGENT_DEPTH).toBe('2');
    expect(env.PI_AGENT_MAX_DEPTH).toBe('5');
    expect(env.PI_AGENT_TOOL_AVAILABLE).toBe('1');
    expect(env.OTHER).toBe('keep');
  });

  it('falls back to default max when existing value is invalid', () => {
    const env = buildChildAgentEnv({ PI_AGENT_MAX_DEPTH: 'oops' });
    expect(env.PI_AGENT_MAX_DEPTH).toBe('2');
  });

  it('caps child max at child depth when maxSubagentDepth is 0', () => {
    const env = buildChildAgentEnv({}, { agent: makeAgent({ maxSubagentDepth: 0 }) });
    expect(env.PI_AGENT_DEPTH).toBe('1');
    expect(env.PI_AGENT_MAX_DEPTH).toBe('1');
    expect(env.PI_AGENT_TOOL_AVAILABLE).toBe('0');
  });

  it('caps child max by min(parentMax, childDepth + maxSubagentDepth)', () => {
    const env = buildChildAgentEnv(
      { PI_AGENT_MAX_DEPTH: '5' },
      { agent: makeAgent({ maxSubagentDepth: 1 }) }
    );
    expect(env.PI_AGENT_DEPTH).toBe('1');
    expect(env.PI_AGENT_MAX_DEPTH).toBe('2');
    expect(env.PI_AGENT_TOOL_AVAILABLE).toBe('1');
  });

  it('does not raise parent max when agent maxSubagentDepth is larger', () => {
    const env = buildChildAgentEnv(
      { PI_AGENT_MAX_DEPTH: '2' },
      { agent: makeAgent({ maxSubagentDepth: 10 }) }
    );
    expect(env.PI_AGENT_DEPTH).toBe('1');
    expect(env.PI_AGENT_MAX_DEPTH).toBe('2');
    expect(env.PI_AGENT_TOOL_AVAILABLE).toBe('1');
  });

  it('sets PI_AGENT_TOOL_AVAILABLE=0 when tools allowlist omits agent', () => {
    const env = buildChildAgentEnv({}, { agent: makeAgent({ tools: ['read'] }) });
    expect(env.PI_AGENT_TOOL_AVAILABLE).toBe('0');
  });

  it('sets PI_AGENT_TOOL_AVAILABLE=0 when excludeTools includes agent', () => {
    const env = buildChildAgentEnv({}, { agent: makeAgent({ excludeTools: ['agent'] }) });
    expect(env.PI_AGENT_TOOL_AVAILABLE).toBe('0');
  });

  it('sets PI_AGENT_TOOL_AVAILABLE=1 when tools allowlist includes agent', () => {
    const env = buildChildAgentEnv({}, { agent: makeAgent({ tools: ['agent'] }) });
    expect(env.PI_AGENT_TOOL_AVAILABLE).toBe('1');
  });

  it('sets PI_AGENT_TOOL_AVAILABLE=0 when child would already be at the depth cap', () => {
    const env = buildChildAgentEnv({ PI_AGENT_DEPTH: '1', PI_AGENT_MAX_DEPTH: '2' });
    expect(env.PI_AGENT_DEPTH).toBe('2');
    expect(env.PI_AGENT_MAX_DEPTH).toBe('2');
    expect(env.PI_AGENT_TOOL_AVAILABLE).toBe('0');
  });

  it('keeps PI_AGENT_TOOL_AVAILABLE=0 when parent already disabled delegation', () => {
    const env = buildChildAgentEnv({ PI_AGENT_TOOL_AVAILABLE: '0' });
    expect(env.PI_AGENT_TOOL_AVAILABLE).toBe('0');
  });

  it('keeps PI_AGENT_TOOL_AVAILABLE=0 even when child agent would otherwise allow it', () => {
    const env = buildChildAgentEnv(
      { PI_AGENT_TOOL_AVAILABLE: '0' },
      { agent: makeAgent({ tools: ['agent'] }) }
    );
    expect(env.PI_AGENT_TOOL_AVAILABLE).toBe('0');
  });
});

describe('buildToolCliArgs', () => {
  it('returns --tools and --exclude-tools when both are set', () => {
    const args = buildToolCliArgs(
      makeAgent({ tools: ['read', 'bash'], excludeTools: ['write', 'edit'] })
    );
    expect(args).toEqual(['--tools', 'read,bash', '--exclude-tools', 'write,edit']);
  });

  it('omits both when neither is set', () => {
    expect(buildToolCliArgs(makeAgent())).toEqual([]);
  });

  it('returns only --exclude-tools when tools is empty', () => {
    expect(buildToolCliArgs(makeAgent({ excludeTools: ['edit'] }))).toEqual([
      '--exclude-tools',
      'edit',
    ]);
  });

  it('forces agent exclusion when disableAgentTool is true', () => {
    expect(buildToolCliArgs(makeAgent(), { disableAgentTool: true })).toEqual([
      '--exclude-tools',
      'agent',
    ]);
  });

  it('does not duplicate agent in excludeTools when disableAgentTool is true', () => {
    expect(
      buildToolCliArgs(makeAgent({ excludeTools: ['write', 'agent'] }), { disableAgentTool: true })
    ).toEqual(['--exclude-tools', 'write,agent']);
  });

  it('canonicalizes case-variant agent entries to lowercase when forcing exclusion', () => {
    expect(
      buildToolCliArgs(makeAgent({ excludeTools: ['Agent'] }), { disableAgentTool: true })
    ).toEqual(['--exclude-tools', 'agent']);
    expect(
      buildToolCliArgs(makeAgent({ excludeTools: ['write', '  AGENT '] }), {
        disableAgentTool: true,
      })
    ).toEqual(['--exclude-tools', 'write,agent']);
  });

  it('appends agent to existing excludeTools when missing', () => {
    expect(
      buildToolCliArgs(makeAgent({ excludeTools: ['write'] }), { disableAgentTool: true })
    ).toEqual(['--exclude-tools', 'write,agent']);
  });

  it('combines tools allowlist with forced agent exclusion', () => {
    const args = buildToolCliArgs(makeAgent({ tools: ['agent', 'read'] }), {
      disableAgentTool: true,
    });
    expect(args).toEqual(['--tools', 'agent,read', '--exclude-tools', 'agent']);
  });
});
