// ABOUTME: Tests for layered agent config inspect/merge and atomic config.json patch writes.
// ABOUTME: Covers provenance, dirty patch build, sibling preservation, and malformed-file repair.

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildDirtyPatch,
  formatOverrideValue,
  inspectAgentConfig,
  mergeAgentOverride,
  parseAgentOverride,
  projectAgentConfigPath,
  userAgentConfigPath,
  writeAgentConfigPatch,
  type AgentOverride,
} from '../../src/config/agent-config.ts';
import type { AgentConfig } from '../../src/config/agents.ts';

const ENV_KEY = 'PI_CODING_AGENT_DIR';
let originalEnv: string | undefined;
let originalEnvPresent = false;
let userAgentDir: string | null = null;
let tmpDirs: string[] = [];

beforeAll(() => {
  originalEnvPresent = ENV_KEY in process.env;
  originalEnv = process.env[ENV_KEY];
});

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  if (userAgentDir) {
    rmSync(userAgentDir, { recursive: true, force: true });
    userAgentDir = null;
  }
  if (originalEnvPresent) {
    process.env[ENV_KEY] = originalEnv ?? '';
  } else {
    delete process.env[ENV_KEY];
  }
});

function setUserAgentDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-user-cfg-'));
  process.env[ENV_KEY] = dir;
  userAgentDir = dir;
  return dir;
}

function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-cfg-'));
  tmpDirs.push(dir);
  return dir;
}

function baseAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'target',
    description: 'base',
    systemPrompt: 'prompt body',
    source: 'project',
    filePath: '/tmp/target.md',
    systemPromptMode: 'append',
    defaultContext: 'fresh',
    isolation: 'none',
    model: 'frontmatter-model',
    thinking: 'low',
    ...overrides,
  };
}

describe('parseAgentOverride', () => {
  it('accepts CSV strings and string arrays for list fields', () => {
    const fromCsv = parseAgentOverride({ tools: 'read, grep', skills: 'a, b' });
    expect(fromCsv.tools).toEqual(['read', 'grep']);
    expect(fromCsv.skills).toEqual(['a', 'b']);

    const fromArr = parseAgentOverride({ tools: ['read', 'grep'], skills: ['a', 'b'] });
    expect(fromArr.tools).toEqual(['read', 'grep']);
    expect(fromArr.skills).toEqual(['a', 'b']);
  });

  it('drops invalid enum and number values', () => {
    const parsed = parseAgentOverride({
      systemPromptMode: 'weird',
      maxTurns: -1,
      isolation: 'docker',
      runtime: 'grok',
    });
    expect(parsed).toEqual({});
  });
});

describe('mergeAgentOverride', () => {
  it('later parts win field-level; arrays replace', () => {
    const a: AgentOverride = { model: 'a', tools: ['read'], thinking: 'low' };
    const b: AgentOverride = { model: 'b', tools: ['write'] };
    expect(mergeAgentOverride(a, b)).toEqual({
      model: 'b',
      tools: ['write'],
      thinking: 'low',
    });
  });
});

describe('inspectAgentConfig', () => {
  it('records provenance frontmatter < user < project < session', () => {
    const inspection = inspectAgentConfig(baseAgent(), {
      user: { model: 'user-model', thinking: 'medium' },
      project: { model: 'project-model', maxTurns: 3 },
      session: { model: 'session-model' },
    });

    expect(inspection.effective.model).toBe('session-model');
    expect(inspection.fields.model.source).toBe('session');
    expect(inspection.fields.model.layers).toEqual({
      frontmatter: 'frontmatter-model',
      user: 'user-model',
      project: 'project-model',
      session: 'session-model',
    });

    expect(inspection.fields.thinking.source).toBe('user');
    expect(inspection.effective.thinking).toBe('medium');
    expect(inspection.fields.maxTurns.source).toBe('project');
    expect(inspection.effective.maxTurns).toBe(3);
    expect(inspection.fields.isolation.source).toBe('frontmatter');
    expect(inspection.systemPrompt).toBe('prompt body');
  });
});

describe('formatOverrideValue', () => {
  it('stringifies common override shapes', () => {
    expect(formatOverrideValue(undefined)).toBe('(unset)');
    expect(formatOverrideValue(['a', 'b'])).toBe('a, b');
    expect(formatOverrideValue(true)).toBe('true');
    expect(formatOverrideValue(3)).toBe('3');
    expect(formatOverrideValue('x')).toBe('x');
  });
});

describe('buildDirtyPatch', () => {
  it('includes only dirty keys present in the session override', () => {
    const override: AgentOverride = { model: 'm', thinking: 'high' };
    const patch = buildDirtyPatch(override, ['model', 'maxTurns', 'thinking']);
    expect(patch).toEqual({ model: 'm', thinking: 'high' });
  });
});

describe('writeAgentConfigPatch', () => {
  it('merges without deleting sibling agents or fields', () => {
    const dir = tmpDir();
    const configPath = path.join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        meta: 'keep',
        agents: {
          other: { model: 'other-model' },
          target: { model: 'old', thinking: 'low' },
        },
      })
    );

    writeAgentConfigPatch(configPath, 'target', { model: 'new', maxTurns: 4 });

    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      meta: string;
      agents: Record<string, AgentOverride>;
    };
    expect(parsed.meta).toBe('keep');
    expect(parsed.agents.other).toEqual({ model: 'other-model' });
    expect(parsed.agents.target).toEqual({ model: 'new', thinking: 'low', maxTurns: 4 });
  });

  it('repairs malformed existing file when writing a valid patch', () => {
    const dir = tmpDir();
    const configPath = path.join(dir, 'config.json');
    writeFileSync(configPath, '{ not valid json');

    writeAgentConfigPatch(configPath, 'target', { model: 'fixed' });

    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      agents: Record<string, AgentOverride>;
    };
    expect(parsed.agents.target).toEqual({ model: 'fixed' });
  });

  it('is a no-op for empty patches', () => {
    const dir = tmpDir();
    const configPath = path.join(dir, 'config.json');
    writeAgentConfigPatch(configPath, 'target', {});
    expect(() => readFileSync(configPath, 'utf-8')).toThrow();
  });

  it('removes listed fields and drops empty agent entries', () => {
    const dir = tmpDir();
    const configPath = path.join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          target: { model: 'm', maxTurns: 10, thinking: 'high' },
          other: { model: 'keep' },
        },
      })
    );

    writeAgentConfigPatch(configPath, 'target', {}, { removeFields: ['maxTurns', 'thinking'] });

    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      agents: Record<string, AgentOverride>;
    };
    expect(parsed.agents.target).toEqual({ model: 'm' });
    expect(parsed.agents.other).toEqual({ model: 'keep' });

    writeAgentConfigPatch(configPath, 'target', {}, { removeFields: ['model'] });
    const after = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      agents: Record<string, AgentOverride>;
    };
    expect(after.agents.target).toBeUndefined();
    expect(after.agents.other).toEqual({ model: 'keep' });
  });

  it('creates parent directories', () => {
    const dir = tmpDir();
    const configPath = path.join(dir, 'nested', 'a', 'config.json');
    writeAgentConfigPatch(configPath, 'target', { thinking: 'high' });
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      agents: Record<string, AgentOverride>;
    };
    expect(parsed.agents.target).toEqual({ thinking: 'high' });
  });
});

describe('path helpers', () => {
  it('resolves user and project config paths', () => {
    setUserAgentDir();
    expect(userAgentConfigPath()).toContain(path.join('@balaenis', 'pi-agents', 'config.json'));

    const cwd = tmpDir();
    mkdirSync(path.join(cwd, '.pi'), { recursive: true });
    expect(projectAgentConfigPath(cwd)).toBe(
      path.join(cwd, '.pi', '@balaenis', 'pi-agents', 'config.json')
    );

    const bare = tmpDir();
    expect(projectAgentConfigPath(bare)).toBe(
      path.join(bare, '.pi', '@balaenis', 'pi-agents', 'config.json')
    );
  });
});
