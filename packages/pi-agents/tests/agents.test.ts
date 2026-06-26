// ABOUTME: Tests for agent frontmatter parsing — extended fields, defaults, and invalid value handling.
// ABOUTME: Writes temporary markdown agent files and reads them back via discoverAgents.

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverAgents } from '../src/agents.ts';

function withAgentsDir(write: (dir: string) => void): {
  cwd: string;
  cleanup: () => void;
} {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-test-'));
  const agentsDir = path.join(cwd, '.pi', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  write(agentsDir);
  return {
    cwd,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

describe('agent frontmatter parsing', () => {
  let env: { cwd: string; cleanup: () => void } | null = null;

  afterEach(() => {
    env?.cleanup();
    env = null;
  });

  it('parses all extended fields with expected values', () => {
    env = withAgentsDir((dir) => {
      writeFileSync(
        path.join(dir, 'fancy.md'),
        `---
name: fancy
description: an agent with everything
tools: read, grep
excludeTools: write, edit
systemPromptMode: replace
maxTurns: 4
noContextFiles: true
noSkills: true
defaultContext: fork
isolation: worktree
completionGuard: false
---
System prompt body.`
      );
    });
    const { agents } = discoverAgents(env.cwd, 'project');
    const a = agents.find((x) => x.name === 'fancy');
    expect(a).toBeDefined();
    expect(a!.tools).toEqual(['read', 'grep']);
    expect(a!.excludeTools).toEqual(['write', 'edit']);
    expect(a!.systemPromptMode).toBe('replace');
    expect(a!.maxTurns).toBe(4);
    expect(a!.noContextFiles).toBe(true);
    expect(a!.noSkills).toBe(true);
    expect(a!.defaultContext).toBe('fork');
    expect(a!.isolation).toBe('worktree');
    expect(a!.completionGuard).toBe(false);
  });

  it('leaves omitted optional fields undefined and applies enum defaults', () => {
    env = withAgentsDir((dir) => {
      writeFileSync(
        path.join(dir, 'minimal.md'),
        `---
name: minimal
description: minimal agent
---
Body.`
      );
    });
    const { agents } = discoverAgents(env.cwd, 'project');
    const a = agents.find((x) => x.name === 'minimal')!;
    expect(a.tools).toBeUndefined();
    expect(a.excludeTools).toBeUndefined();
    expect(a.systemPromptMode).toBe('append');
    expect(a.maxTurns).toBeUndefined();
    expect(a.noContextFiles).toBeUndefined();
    expect(a.noSkills).toBeUndefined();
    expect(a.defaultContext).toBe('fresh');
    expect(a.isolation).toBe('none');
    expect(a.completionGuard).toBeUndefined();
  });

  it('ignores invalid enum and integer values, falling back to defaults', () => {
    env = withAgentsDir((dir) => {
      writeFileSync(
        path.join(dir, 'bad.md'),
        `---
name: bad
description: bad values
systemPromptMode: weird
maxTurns: -3
defaultContext: shared
isolation: docker
noContextFiles: maybe
noSkills: yep
completionGuard: nope
---
Body.`
      );
    });
    const { agents } = discoverAgents(env.cwd, 'project');
    const a = agents.find((x) => x.name === 'bad')!;
    expect(a.systemPromptMode).toBe('append');
    expect(a.maxTurns).toBeUndefined();
    expect(a.defaultContext).toBe('fresh');
    expect(a.isolation).toBe('none');
    expect(a.noContextFiles).toBeUndefined();
    expect(a.noSkills).toBeUndefined();
    expect(a.completionGuard).toBeUndefined();
  });

  it('parses comma lists with trimming and drops empty items', () => {
    env = withAgentsDir((dir) => {
      writeFileSync(
        path.join(dir, 'list.md'),
        `---
name: list
description: list cleanup
tools: " read , , grep , "
excludeTools: ""
---
Body.`
      );
    });
    const { agents } = discoverAgents(env.cwd, 'project');
    const a = agents.find((x) => x.name === 'list')!;
    expect(a.tools).toEqual(['read', 'grep']);
    expect(a.excludeTools).toBeUndefined();
  });
});
