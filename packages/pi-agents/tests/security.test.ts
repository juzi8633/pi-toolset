// ABOUTME: Tests for security helpers — depth guard, child env, and tool CLI args.
// ABOUTME: Exercises PI_AGENT_DEPTH/MAX_DEPTH parsing and `--tools`/`--exclude-tools` construction.

import { describe, expect, it } from 'bun:test';
import type { AgentConfig } from '../src/agents.ts';
import {
  assertDepthAllowed,
  buildChildAgentEnv,
  buildToolCliArgs,
  getCurrentAgentDepth,
  getMaxAgentDepth,
} from '../src/security.ts';

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

describe('assertDepthAllowed', () => {
  it('allows execution when no depth env is set', () => {
    expect(() => assertDepthAllowed({})).not.toThrow();
  });

  it('throws when depth has reached the max', () => {
    expect(() => assertDepthAllowed({ PI_AGENT_DEPTH: '2', PI_AGENT_MAX_DEPTH: '2' })).toThrow(
      'Agent nesting depth exceeded: 2/2'
    );
  });

  it('treats invalid depth values as zero', () => {
    expect(() => assertDepthAllowed({ PI_AGENT_DEPTH: 'nan' })).not.toThrow();
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

describe('buildChildAgentEnv', () => {
  it('produces child depth 1 from empty parent env', () => {
    const env = buildChildAgentEnv({});
    expect(env.PI_AGENT_CHILD).toBe('1');
    expect(env.PI_AGENT_DEPTH).toBe('1');
    expect(env.PI_AGENT_MAX_DEPTH).toBe('2');
  });

  it('increments existing depth and preserves max', () => {
    const env = buildChildAgentEnv({
      PI_AGENT_DEPTH: '1',
      PI_AGENT_MAX_DEPTH: '5',
      OTHER: 'keep',
    });
    expect(env.PI_AGENT_DEPTH).toBe('2');
    expect(env.PI_AGENT_MAX_DEPTH).toBe('5');
    expect(env.OTHER).toBe('keep');
  });

  it('falls back to default max when existing value is invalid', () => {
    const env = buildChildAgentEnv({ PI_AGENT_MAX_DEPTH: 'oops' });
    expect(env.PI_AGENT_MAX_DEPTH).toBe('2');
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
});
