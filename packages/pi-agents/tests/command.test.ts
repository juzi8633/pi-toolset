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
} from '@earendil-works/pi-coding-agent';
import { registerAgentCommand } from '../src/command.ts';
import { executeAgentTool } from '../src/tool.ts';
import type { SubagentDetails } from '../src/types.ts';

type AgentResult = AgentToolResult<SubagentDetails> & { isError?: boolean };
type Params = Parameters<typeof executeAgentTool>[0];
type ExecCall = { params: Params };

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
});

function makeProjectCwd(agentName: string, description: string): string {
  const cwd = mkdtempSync(path.join(tmpRoot, 'proj-'));
  const agentsDir = path.join(cwd, '.pi', 'agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    path.join(agentsDir, `${agentName}.md`),
    `---\nname: ${agentName}\ndescription: ${description}\n---\nBody.`
  );
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

function fakeCtx(cwd: string): {
  ctx: ExtensionCommandContext;
  notifications: Array<{ message: string; type: string }>;
  state: { idleCalls: number };
} {
  const notifications: Array<{ message: string; type: string }> = [];
  const state = { idleCalls: 0 };
  const ctx = {
    cwd,
    signal: undefined,
    waitForIdle: async () => {
      state.idleCalls++;
    },
    ui: {
      notify: (message: string, type?: 'info' | 'warning' | 'error') =>
        notifications.push({ message, type: type ?? 'info' }),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, state };
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

function fakeExec(result: AgentResult): { execute: typeof executeAgentTool; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const execute: typeof executeAgentTool = async (params) => {
    calls.push({ params: params as Params });
    return result;
  };
  return { execute, calls };
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

  it('/agent <name> <task> invokes the executor with agent and task', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    const exec = fakeExec(okResult('result text'));
    registerAgentCommand(pi, { cwd, execute: exec.execute });
    const { ctx, notifications, state } = fakeCtx(cwd);

    await commands.get('agent')!.handler('myagent find the auth code', ctx);

    expect(state.idleCalls).toBe(1);
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].params).toEqual({ agent: 'myagent', task: 'find the auth code' });
    expect(notifications[0].type).toBe('info');
    expect(notifications[0].message).toBe('result text');
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

  it('warns when /agent <name> has no task text', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    const exec = fakeExec(okResult('nope'));
    registerAgentCommand(pi, { cwd, execute: exec.execute });
    const { ctx, notifications } = fakeCtx(cwd);

    await commands.get('agent')!.handler('myagent', ctx);

    expect(exec.calls).toHaveLength(0);
    expect(notifications[0].type).toBe('warning');
    expect(notifications[0].message).toContain('Missing task');
  });

  it('notifies error for an unknown agent and does not invoke the executor', async () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    const exec = fakeExec(okResult('should not run'));
    registerAgentCommand(pi, { cwd, execute: exec.execute });
    const { ctx, notifications } = fakeCtx(cwd);

    await commands.get('agent')!.handler('ghost do something', ctx);

    expect(exec.calls).toHaveLength(0);
    expect(notifications[0].type).toBe('error');
    expect(notifications[0].message).toContain('Unknown agent');
    expect(notifications[0].message).toContain('ghost');
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

  it('completes /agent arguments with list and agent names', () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    registerAgentCommand(pi, { cwd, execute: fakeExec(okResult('x')).execute });

    const completions = commands.get('agent')!.getArgumentCompletions!('') as Array<{
      value: string;
    }>;
    const values = completions.map((c) => c.value);
    expect(values).toContain('list');
    expect(values).toContain('myagent');
    expect(values).toContain('explore');
  });

  it('filters completions by prefix', () => {
    const cwd = makeProjectCwd('myagent', 'does a thing');
    const { pi, commands } = fakePi();
    registerAgentCommand(pi, { cwd, execute: fakeExec(okResult('x')).execute });

    const completions = commands.get('agent')!.getArgumentCompletions!('my') as Array<{
      value: string;
    }>;
    const values = completions.map((c) => c.value);
    expect(values).toEqual(['myagent']);
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
});
