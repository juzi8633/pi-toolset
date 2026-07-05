// ABOUTME: Tests for the /agent and /agent:<name> slash commands.
// ABOUTME: Uses an in-memory ExtensionAPI stub and an injected fake executor to avoid spawning real pi.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionCommandContext,
  Skill,
} from '@earendil-works/pi-coding-agent';
import { registerAgentCommand } from '../src/command.ts';
import { executeAgentTool } from '../src/tool.ts';
import {
  clearDiscoveredSkills,
  resolveSkillNames,
  setDiscoveredSkills,
  type SkillResolution,
} from '../src/skills.ts';
import type { SubagentDetails } from '../src/types.ts';

type AgentResult = AgentToolResult<SubagentDetails> & { isError?: boolean };
type Params = Parameters<typeof executeAgentTool>[0];
type ExecCall = { params: Params };
type WidgetUpdate = { key: string; value: string[] | undefined };

let tmpRoot: string;
let userAgentDir: string;
const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-command-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (ORIGINAL_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
});

beforeEach(() => {
  userAgentDir = mkdtempSync(path.join(tmpRoot, 'user-'));
  process.env.PI_CODING_AGENT_DIR = userAgentDir;
  clearDiscoveredSkills();
});

function makeProjectCwd(agentName: string, description: string, skills?: string): string {
  const cwd = mkdtempSync(path.join(tmpRoot, 'proj-'));
  const agentsDir = path.join(cwd, '.pi', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  const frontmatter = [
    '---',
    `name: ${agentName}`,
    `description: ${description}`,
    skills ? `skills: ${skills}` : '',
    '---',
  ]
    .filter((l) => l.length > 0)
    .join('\n');
  writeFileSync(path.join(agentsDir, `${agentName}.md`), `${frontmatter}\nBody.`);
  return cwd;
}

interface CapturedCommand {
  description?: string;
  getArgumentCompletions?: (prefix: string) => unknown[] | null;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function fakePi(): { pi: ExtensionAPI; commands: Map<string, CapturedCommand> } {
  const commands = new Map<string, CapturedCommand>();
  const pi = {
    registerCommand(name: string, options: Omit<CapturedCommand, never>) {
      commands.set(name, options as CapturedCommand);
    },
  } as unknown as ExtensionAPI;
  return { pi, commands };
}

function fakeCtx(
  cwd: string,
  options: { skills?: Skill[] } = {}
): {
  ctx: ExtensionCommandContext;
  notifications: Array<{ message: string; type: string }>;
  widgets: WidgetUpdate[];
  state: { idleCalls: number };
} {
  const notifications: Array<{ message: string; type: string }> = [];
  const widgets: WidgetUpdate[] = [];
  const state = { idleCalls: 0 };
  const ctx = {
    cwd,
    signal: undefined,
    waitForIdle: async () => {
      state.idleCalls++;
    },
    getSystemPromptOptions: () => ({ cwd, skills: options.skills ?? [] }),
    ui: {
      notify: (message: string, type?: 'info' | 'warning' | 'error') =>
        notifications.push({ message, type: type ?? 'info' }),
      setWidget: (key: string, value?: string[]) => widgets.push({ key, value }),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, widgets, state };
}

function okResult(text: string): AgentResult {
  return {
    content: [{ type: 'text', text }],
    details: {
      mode: 'single',
      agentScope: 'both',
      projectAgentsDir: null,
      builtinAgentsDir: '/builtin',
      results: [],
    },
  };
}

function errorResult(text: string): AgentResult {
  return { ...okResult(text), isError: true };
}

function progressResult(text: string, turns: number): AgentResult {
  return {
    content: [{ type: 'text', text }],
    details: {
      mode: 'single',
      agentScope: 'both',
      projectAgentsDir: null,
      builtinAgentsDir: '/builtin',
      results: [
        {
          agent: 'myagent',
          agentSource: 'project',
          task: 'task',
          exitCode: 0,
          messages: [],
          stderr: '',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns,
          },
        },
      ],
    },
  };
}

function fakeExec(result: AgentResult): { execute: typeof executeAgentTool; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const execute: typeof executeAgentTool = async (params) => {
    calls.push({ params: params as Params });
    return result;
  };
  return { execute, calls };
}

function streamingExec(
  finalResult: AgentResult,
  partialResult: AgentResult
): { execute: typeof executeAgentTool; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const execute: typeof executeAgentTool = async (params, _signal, onUpdate) => {
    calls.push({ params: params as Params });
    onUpdate?.(partialResult);
    return finalResult;
  };
  return { execute, calls };
}

function makeSkill(name: string, filePath: string, disableModelInvocation = false): Skill {
  return {
    name,
    description: `${name} skill`,
    filePath,
    baseDir: filePath.replace(/\/[^/]+$/, ''),
    sourceInfo: { path: filePath, source: 'user', scope: 'user', origin: 'top-level' },
    disableModelInvocation,
  };
}

/** Fake executor that probes the skills cache at execution time to assert refresh timing. */
function cacheProbingExec(
  result: AgentResult,
  probeNames: string[]
): { execute: typeof executeAgentTool; probe: () => SkillResolution } {
  let probed: SkillResolution = { resolved: [], missing: [] };
  const execute: typeof executeAgentTool = async () => {
    probed = resolveSkillNames(probeNames);
    return result;
  };
  return { execute, probe: () => probed };
}

describe('registerAgentCommand', () => {
  it('registers /agent and /agent:<name> for discovered agents', () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    registerAgentCommand(pi, { cwd, execute: fakeExec(okResult('done')).execute });

    expect(commands.has('agent')).toBe(true);
    expect(commands.has('agent:myagent')).toBe(true);
    expect(commands.has('agent:explore')).toBe(true);
    expect(commands.get('agent:myagent')?.description).toContain('myagent');
  });

  it('waits for idle before listing agents', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    const exec = fakeExec(okResult('done'));
    registerAgentCommand(pi, { cwd, execute: exec.execute });
    const { ctx, notifications, state } = fakeCtx(cwd);

    await commands.get('agent')!.handler('list', ctx);

    expect(exec.calls).toHaveLength(0);
    expect(state.idleCalls).toBe(1);
    expect(notifications[0].type).toBe('info');
    expect(notifications[0].message).toContain('myagent');
    expect(notifications[0].message).toContain('[project]');
  });

  it('shows usage when called with no args', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    const exec = fakeExec(okResult('nope'));
    registerAgentCommand(pi, { cwd, execute: exec.execute });
    const { ctx, notifications } = fakeCtx(cwd);

    await commands.get('agent')!.handler('', ctx);

    expect(exec.calls).toHaveLength(0);
    expect(notifications[0].type).toBe('warning');
    expect(notifications[0].message).toContain('Usage:');
    expect(notifications[0].message).toContain('myagent');
  });

  it('shows usage when called with a non-list argument', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    const exec = fakeExec(okResult('nope'));
    registerAgentCommand(pi, { cwd, execute: exec.execute });
    const { ctx, notifications } = fakeCtx(cwd);

    await commands.get('agent')!.handler('myagent', ctx);

    expect(exec.calls).toHaveLength(0);
    expect(notifications[0].type).toBe('warning');
    expect(notifications[0].message).toContain('Usage:');
  });

  it('shows usage when /agent <name> <task> is used instead of /agent:<name>', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    const exec = fakeExec(okResult('nope'));
    registerAgentCommand(pi, { cwd, execute: exec.execute });
    const { ctx, notifications } = fakeCtx(cwd);

    await commands.get('agent')!.handler('myagent find the auth code', ctx);

    expect(exec.calls).toHaveLength(0);
    expect(notifications[0].type).toBe('warning');
    expect(notifications[0].message).toContain('Usage:');
  });

  it('/agent:<name> <task> invokes the named agent', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    const exec = fakeExec(okResult('named result'));
    registerAgentCommand(pi, { cwd, execute: exec.execute });
    const { ctx, notifications } = fakeCtx(cwd);

    await commands.get('agent:myagent')!.handler('do the thing', ctx);

    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].params).toEqual({ agent: 'myagent', task: 'do the thing' });
    expect(notifications[0].type).toBe('info');
    expect(notifications[0].message).toBe('named result');
  });

  it('shows a live widget while /agent:<name> is running and clears it afterwards', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    const exec = streamingExec(okResult('final result'), progressResult('searching files', 2));
    registerAgentCommand(pi, { cwd, execute: exec.execute });
    const { ctx, notifications, widgets } = fakeCtx(cwd);

    await commands.get('agent:myagent')!.handler('find the auth code', ctx);

    expect(exec.calls).toHaveLength(1);
    expect(widgets[0]).toEqual({
      key: 'pi-agent-command',
      value: ['Agent: myagent', 'Task: find the auth code', 'Status: starting...', 'Turns: 0'],
    });
    expect(widgets[1].key).toBe('pi-agent-command');
    expect(widgets[1].value).toContain('Status: running...');
    expect(widgets[1].value).toContain('Turns: 2');
    expect(widgets[1].value).toContain('Latest: searching files');
    expect(widgets.at(-1)).toEqual({ key: 'pi-agent-command', value: undefined });
    expect(notifications[0].message).toBe('final result');
  });

  it('clears the live widget when executor throws', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    const exec: typeof executeAgentTool = async (_params, _signal, onUpdate) => {
      onUpdate?.(progressResult('working before failure', 1));
      throw new Error('spawn failed');
    };
    registerAgentCommand(pi, { cwd, execute: exec });
    const { ctx, notifications, widgets } = fakeCtx(cwd);

    await commands.get('agent:myagent')!.handler('go', ctx);

    expect(widgets[0].value).toContain('Status: starting...');
    expect(widgets[1].value).toContain('Latest: working before failure');
    expect(widgets.at(-1)).toEqual({ key: 'pi-agent-command', value: undefined });
    expect(notifications[0].type).toBe('error');
    expect(notifications[0].message).toContain('spawn failed');
  });

  it('warns when /agent:<name> is called without a task', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    const exec = fakeExec(okResult('nope'));
    registerAgentCommand(pi, { cwd, execute: exec.execute });
    const { ctx, notifications } = fakeCtx(cwd);

    await commands.get('agent:myagent')!.handler('   ', ctx);

    expect(exec.calls).toHaveLength(0);
    expect(notifications[0].type).toBe('warning');
    expect(notifications[0].message).toContain('Missing task');
  });

  it('notifies error for an unknown /agent:<name> when the agent file is removed mid-session', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    const exec = fakeExec(okResult('should not run'));
    registerAgentCommand(pi, { cwd, execute: exec.execute });
    rmSync(path.join(cwd, '.pi', 'agents', 'myagent.md'));
    const { ctx, notifications } = fakeCtx(cwd);

    await commands.get('agent:myagent')!.handler('do something', ctx);

    expect(exec.calls).toHaveLength(0);
    expect(notifications[0].type).toBe('error');
    expect(notifications[0].message).toContain('Unknown agent');
    expect(notifications[0].message).toContain('myagent');
  });

  it('notifies error when the executor returns isError', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    const exec = fakeExec(errorResult('boom'));
    registerAgentCommand(pi, { cwd, execute: exec.execute });
    const { ctx, notifications } = fakeCtx(cwd);

    await commands.get('agent:myagent')!.handler('go', ctx);

    expect(notifications[0].type).toBe('error');
    expect(notifications[0].message).toBe('boom');
  });

  it('notifies error when the executor throws', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    const exec: typeof executeAgentTool = async () => {
      throw new Error('spawn failed');
    };
    registerAgentCommand(pi, { cwd, execute: exec });
    const { ctx, notifications } = fakeCtx(cwd);

    await commands.get('agent:myagent')!.handler('go', ctx);

    expect(notifications[0].type).toBe('error');
    expect(notifications[0].message).toContain('spawn failed');
  });

  it('completes /agent arguments with only the list subcommand', () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    registerAgentCommand(pi, { cwd, execute: fakeExec(okResult('x')).execute });

    const completions = commands.get('agent')!.getArgumentCompletions!('') as Array<{
      value: string;
    }>;
    const values = completions.map((c) => c.value);
    expect(values).toEqual(['list']);
  });

  it('filters completions by prefix', () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    registerAgentCommand(pi, { cwd, execute: fakeExec(okResult('x')).execute });

    const completions = commands.get('agent')!.getArgumentCompletions!('li') as Array<{
      value: string;
    }>;
    const values = completions.map((c) => c.value);
    expect(values).toEqual(['list']);
  });

  it('invokes a builtin agent via /agent:<name>', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    const exec = fakeExec(okResult('explored'));
    registerAgentCommand(pi, { cwd, execute: exec.execute });
    const { ctx, notifications } = fakeCtx(cwd);

    await commands.get('agent:explore')!.handler('find auth code', ctx);

    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].params).toEqual({ agent: 'explore', task: 'find auth code' });
    expect(notifications[0].message).toBe('explored');
  });

  it('refreshes skill cache from system prompt options before /agent:<name> executes', async () => {
    const cwd = makeProjectCwd('skilled', 'uses a skill', 'librarian');
    const { pi, commands } = fakePi();
    const exec = cacheProbingExec(okResult('done'), ['librarian']);
    registerAgentCommand(pi, { cwd, execute: exec.execute });
    const { ctx, notifications } = fakeCtx(cwd, {
      skills: [makeSkill('librarian', '/abs/librarian/SKILL.md')],
    });

    await commands.get('agent:skilled')!.handler('do the thing', ctx);

    const probed = exec.probe();
    expect(probed.missing).toEqual([]);
    expect(probed.resolved).toEqual(['/abs/librarian/SKILL.md']);
    expect(notifications[0].message).toBe('done');
  });

  it('does not refresh skill cache when agent is unknown', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    const exec = fakeExec(okResult('done'));
    registerAgentCommand(pi, { cwd, execute: exec.execute });
    rmSync(path.join(cwd, '.pi', 'agents', 'myagent.md'));
    setDiscoveredSkills([makeSkill('librarian', '/stale/librarian/SKILL.md')]);
    const { ctx, notifications } = fakeCtx(cwd, {
      skills: [makeSkill('librarian', '/fresh/librarian/SKILL.md')],
    });

    await commands.get('agent:myagent')!.handler('do something', ctx);

    expect(exec.calls).toHaveLength(0);
    expect(resolveSkillNames(['librarian']).resolved).toEqual(['/stale/librarian/SKILL.md']);
    expect(notifications[0].type).toBe('error');
    expect(notifications[0].message).toContain('Unknown agent');
  });

  it('still excludes disabled skills after refresh', async () => {
    const cwd = makeProjectCwd('skilled', 'uses a disabled skill', 'hidden');
    const { pi, commands } = fakePi();
    const exec = cacheProbingExec(okResult('done'), ['hidden']);
    registerAgentCommand(pi, { cwd, execute: exec.execute });
    const { ctx } = fakeCtx(cwd, {
      skills: [makeSkill('hidden', '/abs/hidden/SKILL.md', true)],
    });

    await commands.get('agent:skilled')!.handler('go', ctx);

    const probed = exec.probe();
    expect(probed.resolved).toEqual([]);
    expect(probed.missing).toEqual(['hidden']);
  });
});
