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
  Theme,
} from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { registerAgentCommand } from '../../src/execution/command.ts';
import { executeAgentTool } from '../../src/execution/tool.ts';
import {
  clearDiscoveredSkills,
  resolveSkillNames,
  setDiscoveredSkills,
  type SkillResolution,
} from '../../src/config/skills.ts';
import { createRunStore } from '../../src/run/run-store.ts';
import type { RunUnitRecord } from '../../src/run/run-types.ts';
import type { SubagentDetails } from '../../src/shared/types.ts';

type AgentResult = AgentToolResult<SubagentDetails> & { isError?: boolean };
type Params = Parameters<typeof executeAgentTool>[0];
type ExecOptions = Parameters<typeof executeAgentTool>[4];
type ExecCall = { params: Params; options?: ExecOptions };
type WidgetComponent = Component & { dispose?(): void };
type WidgetFactory = (tui: TUI, theme: Theme) => WidgetComponent;
type WidgetValue = string[] | WidgetFactory | undefined;
type WidgetUpdate = { key: string; value: WidgetValue; component?: WidgetComponent };

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
  options: { skills?: Skill[]; mode?: 'tui' | 'json' | 'print' | 'rpc'; hasUI?: boolean } = {}
): {
  ctx: ExtensionCommandContext;
  notifications: Array<{ message: string; type: string }>;
  widgets: WidgetUpdate[];
  state: { idleCalls: number; customCalls: number };
} {
  const notifications: Array<{ message: string; type: string }> = [];
  const widgets: WidgetUpdate[] = [];
  const state = { idleCalls: 0, customCalls: 0 };
  const fakeTui = { requestRender: () => undefined } as TUI;
  const fakeTheme = {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
  } as Theme;
  let currentWidget: WidgetComponent | undefined;
  const ctx = {
    cwd,
    mode: options.mode ?? 'tui',
    hasUI: options.hasUI ?? true,
    signal: undefined,
    waitForIdle: async () => {
      state.idleCalls++;
    },
    isProjectTrusted: () => true,
    getSystemPromptOptions: () => ({ cwd, skills: options.skills ?? [] }),
    ui: {
      notify: (message: string, type?: 'info' | 'warning' | 'error') =>
        notifications.push({ message, type: type ?? 'info' }),
      setWidget: (key: string, value?: WidgetValue) => {
        currentWidget?.dispose?.();
        currentWidget = typeof value === 'function' ? value(fakeTui, fakeTheme) : undefined;
        widgets.push({ key, value, component: currentWidget });
      },
      custom: async () => {
        state.customCalls++;
        return null;
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, widgets, state };
}

function renderWidget(update: WidgetUpdate): string {
  return update.component?.render(80).join('\n') ?? '';
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
  const execute: typeof executeAgentTool = async (params, _signal, _onUpdate, _ctx, options) => {
    calls.push({ params: params as Params, options });
    return result;
  };
  return { execute, calls };
}

function streamingExec(
  finalResult: AgentResult,
  partialResult: AgentResult
): { execute: typeof executeAgentTool; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const execute: typeof executeAgentTool = async (params, _signal, onUpdate, _ctx, options) => {
    calls.push({ params: params as Params, options });
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
    probed = await resolveSkillNames(probeNames);
    return result;
  };
  return { execute, probe: () => probed };
}

describe('registerAgentCommand durable resume guidance', () => {
  it('/agent resume prints agent({ runId }) guidance without starting a run', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const storeRoot = mkdtempSync(path.join(tmpRoot, 'runs-'));
    const store = createRunStore({ rootDir: storeRoot });
    const created = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: { mode: 'single', agentScope: 'both', agent: 'myagent', task: 't' },
      details: {
        mode: 'single',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        results: [],
      },
      units: {
        single: {
          unitId: 'single',
          agent: 'myagent',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'interrupted',
          attempt: 1,
          attempts: [],
          effectiveCwd: cwd,
        } as RunUnitRecord,
      },
    });
    const { pi, commands } = fakePi();
    const exec = fakeExec(okResult('should not run'));
    registerAgentCommand(pi, { cwd, execute: exec.execute, runStore: store });
    const { ctx, notifications } = fakeCtx(cwd);

    await commands.get('agent')!.handler(`resume ${created.runId}`, ctx);

    expect(exec.calls).toHaveLength(0);
    expect(notifications[0]?.type).toBe('info');
    expect(notifications[0]?.message).toContain(`agent({ runId: "${created.runId}" })`);
  });
});

describe('registerAgentCommand config', () => {
  it('includes config in argument completions', () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    registerAgentCommand(pi, { cwd, execute: fakeExec(okResult('done')).execute });
    const completions = commands.get('agent')!.getArgumentCompletions?.('') as Array<{
      value: string;
    }>;
    expect(completions.some((c) => c.value === 'config')).toBe(true);
  });

  it('notifies that config is TUI-only outside TUI mode', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    registerAgentCommand(pi, {
      cwd,
      execute: fakeExec(okResult('done')).execute,
      sessionAgentConfig: {
        getOverrides: () => new Map(),
      } as never,
    });
    const { ctx, notifications, state } = fakeCtx(cwd, { mode: 'json' });
    await commands.get('agent')!.handler('config', ctx);
    expect(state.idleCalls).toBe(0);
    expect(notifications[0]?.type).toBe('warning');
    expect(notifications[0]?.message).toMatch(/requires TUI mode/i);
  });

  it('opens config UI with optional name without waitForIdle', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    const opens: Array<{ name?: string }> = [];
    registerAgentCommand(pi, {
      cwd,
      execute: fakeExec(okResult('done')).execute,
      sessionAgentConfig: {
        getOverrides: () => new Map(),
      } as never,
      openConfigUi: async (_ctx, _deps, name) => {
        opens.push({ name });
      },
    });
    const { ctx, state } = fakeCtx(cwd, { mode: 'tui' });
    await commands.get('agent')!.handler('config myagent', ctx);
    expect(state.idleCalls).toBe(0);
    expect(opens).toEqual([{ name: 'myagent' }]);
  });
});

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

  it('opens /agent view immediately without waitForIdle while host is busy', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    let openCalls = 0;
    registerAgentCommand(pi, {
      cwd,
      execute: fakeExec(okResult('done')).execute,
      interactiveView: {
        openView: async () => {
          openCalls++;
        },
      },
    });
    const { ctx, state } = fakeCtx(cwd, { mode: 'tui' });

    await commands.get('agent')!.handler('view', ctx);

    expect(state.idleCalls).toBe(0);
    expect(openCalls).toBe(1);
  });

  it('does not open custom UI for /agent view outside TUI', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    let openCalls = 0;
    registerAgentCommand(pi, {
      cwd,
      execute: fakeExec(okResult('done')).execute,
      interactiveView: {
        openView: async () => {
          openCalls++;
        },
      },
    });
    const { ctx, notifications, state } = fakeCtx(cwd, { mode: 'json', hasUI: false });

    await commands.get('agent')!.handler('view', ctx);

    expect(state.idleCalls).toBe(0);
    expect(openCalls).toBe(0);
    expect(notifications).toHaveLength(0);
  });

  it('offers view in argument completions', () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    registerAgentCommand(pi, { cwd, execute: fakeExec(okResult('done')).execute });
    const items = commands.get('agent')!.getArgumentCompletions?.('v') as Array<{ value: string }>;
    expect(items?.some((i) => i.value === 'view')).toBe(true);
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
    expect(widgets[0].key).toBe('pi-agents-command');
    expect(typeof widgets[0].value).toBe('function');
    const rendered = renderWidget(widgets[0]);
    expect(rendered).toContain('subagent myagent');
    expect(rendered).toContain('Task: find the auth code');
    expect(rendered).toContain('Status: running...');
    expect(rendered).toContain('Turns: 2');
    expect(rendered).toContain('Latest: searching files');
    expect(widgets.at(-1)).toMatchObject({ key: 'pi-agents-command', value: undefined });
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

    expect(typeof widgets[0].value).toBe('function');
    expect(renderWidget(widgets[0])).toContain('Latest: working before failure');
    expect(widgets.at(-1)).toMatchObject({ key: 'pi-agents-command', value: undefined });
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

  it('completes /agent arguments without the removed list subcommand', () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    registerAgentCommand(pi, { cwd, execute: fakeExec(okResult('x')).execute });

    const completions = commands.get('agent')!.getArgumentCompletions!('') as Array<{
      value: string;
    }>;
    const values = completions.map((c) => c.value);
    expect(values).not.toContain('list');
    expect(values).toContain('view');
    expect(values).toContain('config');
    expect(values).toContain('runs');
  });

  it('filters completions by prefix', () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    registerAgentCommand(pi, { cwd, execute: fakeExec(okResult('x')).execute });

    const completions = commands.get('agent')!.getArgumentCompletions!('co') as Array<{
      value: string;
    }>;
    const values = completions.map((c) => c.value);
    expect(values).toEqual(['config']);
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
    expect((await resolveSkillNames(['librarian'])).resolved).toEqual([
      '/stale/librarian/SKILL.md',
    ]);
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

  it('forwards interactiveRegistry on TUI /agent:<name> so RPC/link path is used', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    const exec = fakeExec(okResult('done'));
    const interactiveRegistry = {
      registerInitial: async () => {
        throw new Error('not used by fake executor');
      },
    } as never;
    registerAgentCommand(pi, {
      cwd,
      execute: exec.execute,
      interactiveRegistry,
    });
    const { ctx } = fakeCtx(cwd, { mode: 'tui' });

    await commands.get('agent:myagent')!.handler('inspect things', ctx);

    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0]!.options?.interactiveRegistry).toBe(interactiveRegistry);
    expect(exec.calls[0]!.params).toMatchObject({ agent: 'myagent', task: 'inspect things' });
  });

  it('still forwards interactiveRegistry outside TUI (dispatch decides RPC vs JSON)', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    const exec = fakeExec(okResult('done'));
    const interactiveRegistry = { id: 'reg-print' } as never;
    registerAgentCommand(pi, {
      cwd,
      execute: exec.execute,
      interactiveRegistry,
    });
    const { ctx } = fakeCtx(cwd, { mode: 'print' });

    await commands.get('agent:myagent')!.handler('task', ctx);

    expect(exec.calls[0]!.options?.interactiveRegistry).toBe(interactiveRegistry);
  });
});
