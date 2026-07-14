// ABOUTME: Tests for agent frontmatter parsing — extended fields, defaults, and invalid value handling.
// ABOUTME: Writes temporary markdown agent files and reads them back via discoverAgents.

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
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
skills: librarian, code-reviewer
defaultContext: fork
isolation: worktree
completionCheck: "## Completed, ## Files Changed, ## Validation"
maxSubagentDepth: 0
runtime: grok
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
    expect(a!.skills).toEqual(['librarian', 'code-reviewer']);
    expect(a!.defaultContext).toBe('fork');
    expect(a!.isolation).toBe('worktree');
    expect(a!.completionCheck).toEqual(['## Completed', '## Files Changed', '## Validation']);
    expect(a!.maxSubagentDepth).toBe(0);
    expect(a!.runtime).toBe('grok');
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
    expect(a.skills).toBeUndefined();
    expect(a.defaultContext).toBe('fresh');
    expect(a.isolation).toBe('none');
    expect(a.completionCheck).toBeUndefined();
    expect(a.maxSubagentDepth).toBeUndefined();
    expect(a.runtime).toBeUndefined();
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
runtime: weird
noContextFiles: maybe
noSkills: yep
completionCheck: ""
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
    expect(a.completionCheck).toBeUndefined();
    expect(a.maxSubagentDepth).toBeUndefined();
    expect(a.runtime).toBeUndefined();
  });

  it('ignores negative, fractional, and blank maxSubagentDepth values', () => {
    env = withAgentsDir((dir) => {
      writeFileSync(
        path.join(dir, 'depth-neg.md'),
        `---
name: depth-neg
description: bad depth
maxSubagentDepth: -1
---
Body.`
      );
      writeFileSync(
        path.join(dir, 'depth-frac.md'),
        `---
name: depth-frac
description: fractional depth
maxSubagentDepth: 1.5
---
Body.`
      );
      writeFileSync(
        path.join(dir, 'depth-blank.md'),
        `---
name: depth-blank
description: blank depth
maxSubagentDepth: ""
---
Body.`
      );
    });
    const { agents } = discoverAgents(env.cwd, 'project');
    expect(agents.find((x) => x.name === 'depth-neg')!.maxSubagentDepth).toBeUndefined();
    expect(agents.find((x) => x.name === 'depth-frac')!.maxSubagentDepth).toBeUndefined();
    expect(agents.find((x) => x.name === 'depth-blank')!.maxSubagentDepth).toBeUndefined();
  });

  it('parses worktreeSetupHook as a trimmed non-empty string', () => {
    env = withAgentsDir((dir) => {
      writeFileSync(
        path.join(dir, 'setup.md'),
        `---
name: setup
description: worktree hook
worktreeSetupHook: "  bun install  "
---
Body.`
      );
      writeFileSync(
        path.join(dir, 'setup-empty.md'),
        `---
name: setup-empty
description: blank hook
worktreeSetupHook: "   "
---
Body.`
      );
    });
    const { agents } = discoverAgents(env.cwd, 'project');
    expect(agents.find((a) => a.name === 'setup')!.worktreeSetupHook).toBe('bun install');
    expect(agents.find((a) => a.name === 'setup-empty')!.worktreeSetupHook).toBeUndefined();
  });

  it('parses string maxSubagentDepth as integer', () => {
    env = withAgentsDir((dir) => {
      writeFileSync(
        path.join(dir, 'depth-str.md'),
        `---
name: depth-str
description: string depth
maxSubagentDepth: "2"
---
Body.`
      );
    });
    const { agents } = discoverAgents(env.cwd, 'project');
    expect(agents.find((x) => x.name === 'depth-str')!.maxSubagentDepth).toBe(2);
  });

  it('bundled built-in agents declare expected maxSubagentDepth values', () => {
    env = withAgentsDir(() => {});
    const { agents } = discoverAgents(env.cwd, 'project');
    const get = (name: string) => agents.find((a) => a.name === name);
    expect(get('explore')?.maxSubagentDepth).toBe(0);
    expect(get('planner')?.maxSubagentDepth).toBe(0);
    expect(get('reviewer')?.maxSubagentDepth).toBe(0);
    expect(get('general')?.maxSubagentDepth).toBeUndefined();
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

describe('agent config overrides', () => {
  let env: { cwd: string; cleanup: () => void } | null = null;
  let userAgentDir: string | null = null;
  const ENV_KEY = 'PI_CODING_AGENT_DIR';
  let originalEnv: string | undefined;
  let originalEnvPresent = false;

  beforeAll(() => {
    originalEnvPresent = ENV_KEY in process.env;
    originalEnv = process.env[ENV_KEY];
  });

  afterEach(() => {
    env?.cleanup();
    env = null;
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
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-user-'));
    process.env[ENV_KEY] = dir;
    userAgentDir = dir;
    return dir;
  }

  function writeAgent(dir: string, name: string, frontmatter: string): void {
    writeFileSync(
      path.join(dir, `${name}.md`),
      `---\nname: ${name}\ndescription: base\n${frontmatter}\n---\nBody.`
    );
  }

  it('project config overrides frontmatter fields and wins over user config', () => {
    const userDir = setUserAgentDir();
    const userConfigDir = path.join(userDir, '@balaenis', 'pi-agents');
    mkdirSync(userConfigDir, { recursive: true });
    writeFileSync(
      path.join(userConfigDir, 'config.json'),
      JSON.stringify({
        agents: {
          target: {
            model: 'user-model',
            thinking: 'low',
            systemPromptMode: 'replace',
            tools: 'read, grep',
          },
        },
      })
    );

    env = withAgentsDir((dir) => {
      writeAgent(dir, 'target', 'model: original-model');
    });

    const projectConfigDir = path.join(env.cwd, '.pi', '@balaenis', 'pi-agents');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      path.join(projectConfigDir, 'config.json'),
      JSON.stringify({
        agents: {
          target: { model: 'project-model', maxTurns: 5, skills: 'librarian, planner' },
        },
      })
    );

    const { agents } = discoverAgents(env.cwd, 'both');
    const a = agents.find((x) => x.name === 'target')!;
    expect(a.model).toBe('project-model');
    expect(a.thinking).toBe('low');
    expect(a.systemPromptMode).toBe('replace');
    expect(a.tools).toEqual(['read', 'grep']);
    expect(a.maxTurns).toBe(5);
    expect(a.skills).toEqual(['librarian', 'planner']);
  });

  it('drops invalid override values and leaves frontmatter intact', () => {
    env = withAgentsDir((dir) => {
      writeAgent(dir, 'strict', 'systemPromptMode: replace\nmaxTurns: 3');
    });
    const projectConfigDir = path.join(env.cwd, '.pi', '@balaenis', 'pi-agents');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      path.join(projectConfigDir, 'config.json'),
      JSON.stringify({
        agents: {
          strict: { systemPromptMode: 'weird', maxTurns: -1, isolation: 'docker' },
        },
      })
    );

    const { agents } = discoverAgents(env.cwd, 'project');
    const a = agents.find((x) => x.name === 'strict')!;
    expect(a.systemPromptMode).toBe('replace');
    expect(a.maxTurns).toBe(3);
    expect(a.isolation).toBe('none');
  });

  it('config override can set runtime to grok', () => {
    env = withAgentsDir((dir) => {
      writeAgent(dir, 'overridable', 'model: original-model');
    });
    const projectConfigDir = path.join(env.cwd, '.pi', '@balaenis', 'pi-agents');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      path.join(projectConfigDir, 'config.json'),
      JSON.stringify({
        agents: { overridable: { runtime: 'grok' } },
      })
    );
    const { agents } = discoverAgents(env.cwd, 'project');
    const a = agents.find((x) => x.name === 'overridable')!;
    expect(a.runtime).toBe('grok');
  });

  it('parses runtime: grok-acp from frontmatter', () => {
    env = withAgentsDir((dir) => {
      writeFileSync(
        path.join(dir, 'acp.md'),
        `---
name: acp-agent
description: ACP runtime agent
runtime: grok-acp
---
Body.`
      );
    });
    const { agents } = discoverAgents(env.cwd, 'project');
    const a = agents.find((x) => x.name === 'acp-agent');
    expect(a).toBeDefined();
    expect(a!.runtime).toBe('grok-acp');
  });

  it('config override can set runtime to grok-acp with project overriding user', () => {
    const userDir = setUserAgentDir();
    const userAgentsSubDir = path.join(userDir, 'agents');
    mkdirSync(userAgentsSubDir, { recursive: true });
    writeAgent(userAgentsSubDir, 'shared-acp', 'runtime: grok');

    env = withAgentsDir((dir) => {
      writeAgent(dir, 'shared-acp', 'model: project-model');
    });
    const projectConfigDir = path.join(env.cwd, '.pi', '@balaenis', 'pi-agents');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      path.join(projectConfigDir, 'config.json'),
      JSON.stringify({
        agents: { 'shared-acp': { runtime: 'grok-acp' } },
      })
    );

    const { agents } = discoverAgents(env.cwd, 'both');
    const a = agents.find((x) => x.name === 'shared-acp')!;
    expect(a.runtime).toBe('grok-acp');
    expect(a.model).toBe('project-model');
  });

  it('does not apply project config overrides when scope is user', () => {
    const userDir = setUserAgentDir();
    const userAgentsSubDir = path.join(userDir, 'agents');
    mkdirSync(userAgentsSubDir, { recursive: true });
    writeAgent(userAgentsSubDir, 'shared', 'model: original-model');

    env = withAgentsDir(() => {});
    const projectConfigDir = path.join(env.cwd, '.pi', '@balaenis', 'pi-agents');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      path.join(projectConfigDir, 'config.json'),
      JSON.stringify({ agents: { shared: { model: 'project-model' } } })
    );

    const { agents } = discoverAgents(env.cwd, 'user');
    const a = agents.find((x) => x.name === 'shared')!;
    expect(a.model).toBe('original-model');
  });

  it('applies project config overrides to non-project agents', () => {
    const userDir = setUserAgentDir();
    const userAgentsSubDir = path.join(userDir, 'agents');
    mkdirSync(userAgentsSubDir, { recursive: true });
    writeAgent(userAgentsSubDir, 'shared', 'model: original-model');

    env = withAgentsDir(() => {});
    const projectConfigDir = path.join(env.cwd, '.pi', '@balaenis', 'pi-agents');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(
      path.join(projectConfigDir, 'config.json'),
      JSON.stringify({
        agents: { shared: { isolation: 'worktree', worktreeSetupHook: 'echo hi' } },
      })
    );

    const { agents } = discoverAgents(env.cwd, 'both');
    const a = agents.find((x) => x.name === 'shared')!;
    expect(a.source).toBe('user');
    expect(a.isolation).toBe('worktree');
    expect(a.worktreeSetupHook).toBe('echo hi');
  });

  it('ignores malformed config files', () => {
    env = withAgentsDir((dir) => {
      writeAgent(dir, 'safe', 'model: original-model');
    });
    const projectConfigDir = path.join(env.cwd, '.pi', '@balaenis', 'pi-agents');
    mkdirSync(projectConfigDir, { recursive: true });
    writeFileSync(path.join(projectConfigDir, 'config.json'), '{ not valid json');

    const { agents } = discoverAgents(env.cwd, 'project');
    const a = agents.find((x) => x.name === 'safe')!;
    expect(a.model).toBe('original-model');
  });
});
