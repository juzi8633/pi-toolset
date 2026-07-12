// ABOUTME: Integration-style tests for executeAgentTool() background dispatch and argument compatibility.
// ABOUTME: Uses an injected fake background manager and a fake workflow runner to avoid spawning real agents.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { AgentToolResult, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeAgentTool, type ExecuteAgentToolOptions } from '../src/tool.ts';
import type { BackgroundManager } from '../src/background.ts';
import { clearDiscoveredSkills, setDiscoveredSkills } from '../src/skills.ts';
import type { SubagentDetails } from '../src/types.ts';

type AgentResult = AgentToolResult<SubagentDetails> & { isError?: boolean };

function makeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    cwd: '/tmp/pi-agents-tool-test',
    mode: 'tui',
    hasUI: false,
    ui: {
      confirm: async () => true,
      select: async () => undefined,
      input: async () => undefined,
      notify: () => {},
    },
    ...overrides,
  } as unknown as ExtensionContext;
}

function okResult(text: string): AgentResult {
  return {
    content: [{ type: 'text', text }],
    details: {
      mode: 'single',
      agentScope: 'user',
      projectAgentsDir: null,
      builtinAgentsDir: '/builtin',
      results: [],
    },
  };
}

function fakeWorkflow(text: string): NonNullable<ExecuteAgentToolOptions['runWorkflow']> {
  return async () => okResult(text);
}

function fakeManager(): {
  manager: BackgroundManager;
  launches: Array<{ description: string; mode: string }>;
  runs: Array<Promise<AgentResult>>;
} {
  const launches: Array<{ description: string; mode: string }> = [];
  const runs: Array<Promise<AgentResult>> = [];
  const manager: BackgroundManager = {
    launch(request) {
      launches.push({ description: request.description, mode: request.mode });
      runs.push(request.run(new AbortController().signal) as Promise<AgentResult>);
      return {
        content: [{ type: 'text', text: `⧗ launched ${request.mode}` }],
        details: {
          mode: 'background',
          agentScope: request.agentScope,
          projectAgentsDir: request.projectAgentsDir,
          builtinAgentsDir: '/builtin',
          results: [],
          background: [
            {
              jobId: 'agent-bg-test',
              mode: request.mode,
              status: 'running',
              agentScope: request.agentScope,
              description: request.description,
              startedAt: 0,
              taskPreview: request.taskPreview,
            },
          ],
        },
      };
    },
    cancelAll() {},
    activeCount: () => launches.length,
    waitForIdle: async () => {
      await Promise.allSettled(runs);
    },
  };
  return { manager, launches, runs };
}

describe('executeAgentTool background dispatch', () => {
  it('runs synchronously when runInBackground is absent', async () => {
    let invoked = 0;
    const result = await executeAgentTool(
      { agent: 'noop', task: 'do it' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => {
          invoked++;
          return okResult('sync done');
        },
      }
    );
    expect(invoked).toBe(1);
    expect(result.details?.mode).toBe('single');
    expect((result.content[0] as { text: string }).text).toBe('sync done');
  });

  it('launches via the background manager when runInBackground is true', async () => {
    const { manager, launches, runs } = fakeManager();
    const result = await executeAgentTool(
      { agent: 'noop', task: 'do it later', runInBackground: true },
      undefined,
      undefined,
      makeCtx(),
      { backgroundManager: manager, runWorkflow: fakeWorkflow('bg done') }
    );
    expect(launches.length).toBe(1);
    expect(launches[0].mode).toBe('single');
    expect(result.details?.mode).toBe('background');
    expect((result.content[0] as { text: string }).text).toContain('launched single');
    const inner = await runs[0];
    expect((inner.content[0] as { text: string }).text).toBe('bg done');
  });

  it('strips runInBackground before invoking the workflow runner', async () => {
    const { manager } = fakeManager();
    let observed: { runInBackground?: boolean } | undefined;
    await executeAgentTool(
      { agent: 'noop', task: 'do it', runInBackground: true },
      undefined,
      undefined,
      makeCtx(),
      {
        backgroundManager: manager,
        runWorkflow: async (params) => {
          observed = params as { runInBackground?: boolean };
          return okResult('done');
        },
      }
    );
    expect(observed?.runInBackground).toBeUndefined();
  });

  it('rejects background execution in json mode', async () => {
    const { manager, launches } = fakeManager();
    const result = await executeAgentTool(
      { agent: 'noop', task: 'do it', runInBackground: true },
      undefined,
      undefined,
      makeCtx({ mode: 'json' } as Partial<ExtensionContext>),
      { backgroundManager: manager, runWorkflow: fakeWorkflow('should not run') }
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/long-lived/);
    expect(launches.length).toBe(0);
  });

  it('rejects background execution when no manager is provided', async () => {
    const result = await executeAgentTool(
      { agent: 'noop', task: 'do it', runInBackground: true },
      undefined,
      undefined,
      makeCtx(),
      { runWorkflow: fakeWorkflow('should not run') }
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/Background execution/);
  });

  it('reports invalid params when no mode is provided', async () => {
    const result = await executeAgentTool(
      {} as Parameters<typeof executeAgentTool>[0],
      undefined,
      undefined,
      makeCtx()
    );
    expect((result.content[0] as { text: string }).text).toMatch(/Invalid parameters/);
  });

  it('rejects oversized parallel tasks before launching a background job', async () => {
    const { manager, launches } = fakeManager();
    const oversized = Array.from({ length: 12 }, (_, i) => ({
      agent: 'noop',
      task: `task ${i}`,
    }));
    const result = await executeAgentTool(
      { tasks: oversized, runInBackground: true },
      undefined,
      undefined,
      makeCtx(),
      { backgroundManager: manager, runWorkflow: fakeWorkflow('should not run') }
    );
    expect(launches.length).toBe(0);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/Too many parallel tasks/);
  });
});

describe('normalizeAgentArgs', () => {
  it('rewrites snake_case run_in_background to camelCase runInBackground', async () => {
    const { normalizeAgentArgs } = await import('../src/index.ts');
    const out = normalizeAgentArgs({
      agent: 'noop',
      task: 'go',
      run_in_background: true,
    });
    expect(out).toEqual({ agent: 'noop', task: 'go', runInBackground: true });
  });

  it('does not overwrite an explicit runInBackground value', async () => {
    const { normalizeAgentArgs } = await import('../src/index.ts');
    const out = normalizeAgentArgs({
      agent: 'noop',
      task: 'go',
      run_in_background: true,
      runInBackground: false,
    });
    expect(out).toEqual({
      agent: 'noop',
      task: 'go',
      run_in_background: true,
      runInBackground: false,
    });
  });

  it('returns the input untouched when run_in_background is missing', async () => {
    const { normalizeAgentArgs } = await import('../src/index.ts');
    const input = { agent: 'noop', task: 'go' };
    expect(normalizeAgentArgs(input)).toBe(input);
  });
});

describe('executeAgentTool skill resolution', () => {
  const piAgentKeys = [
    'PI_AGENT_CHILD',
    'PI_AGENT_DEPTH',
    'PI_AGENT_MAX_DEPTH',
    'PI_AGENT_TOOL_AVAILABLE',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};
  let tmpCwd: string | null = null;

  beforeEach(() => {
    for (const key of piAgentKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    clearDiscoveredSkills();
  });

  afterEach(() => {
    for (const key of piAgentKeys) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (tmpCwd) {
      rmSync(tmpCwd, { recursive: true, force: true });
      tmpCwd = null;
    }
    clearDiscoveredSkills();
  });

  it('returns skill_error without spawning when a declared skill name is missing', async () => {
    tmpCwd = mkdtempSync(path.join(os.tmpdir(), 'pi-skills-int-'));
    const agentsDir = path.join(tmpCwd, '.pi', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      path.join(agentsDir, 'picky.md'),
      `---\nname: picky\ndescription: wants skills\nskills: ghost, librarian\n---\nBody.`
    );
    setDiscoveredSkills([]);

    const result = await executeAgentTool(
      { agent: 'picky', task: 'go' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpCwd })
    );

    expect(result.isError).toBe(true);
    const single = result.details?.results[0];
    expect(single?.stopReason).toBe('skill_error');
    expect(single?.errorMessage).toContain('ghost');
    expect(single?.errorMessage).toContain('librarian');
  });
});

describe('runtime override schema and grok-acp skill/fork warnings', () => {
  const piAgentKeys = [
    'PI_AGENT_CHILD',
    'PI_AGENT_DEPTH',
    'PI_AGENT_MAX_DEPTH',
    'PI_AGENT_TOOL_AVAILABLE',
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};
  let tmpCwd: string | null = null;

  beforeEach(() => {
    for (const key of piAgentKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    clearDiscoveredSkills();
  });

  afterEach(() => {
    for (const key of piAgentKeys) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (tmpCwd) {
      rmSync(tmpCwd, { recursive: true, force: true });
      tmpCwd = null;
    }
    clearDiscoveredSkills();
  });

  it('accepts runtimeOverride grok-acp in the tool parameter schema', async () => {
    const { RuntimeSchema } = await import('../src/schema.ts');
    const { Value } = await import('typebox/value');
    expect(Value.Check(RuntimeSchema, 'pi')).toBe(true);
    expect(Value.Check(RuntimeSchema, 'grok')).toBe(true);
    expect(Value.Check(RuntimeSchema, 'grok-acp')).toBe(true);
    expect(Value.Check(RuntimeSchema, 'claude')).toBe(false);
    expect(Value.Check(RuntimeSchema, 'weird')).toBe(false);
  });

  it('emits skill and fork warnings for grok-acp before spawn failure', async () => {
    tmpCwd = mkdtempSync(path.join(os.tmpdir(), 'pi-acp-warn-'));
    const agentsDir = path.join(tmpCwd, '.pi', 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      path.join(agentsDir, 'acp.md'),
      `---\nname: acp\ndescription: acp agent\nruntime: grok-acp\nskills: ghost\ndefaultContext: fork\n---\nBody.`
    );

    const warnings: string[] = [];
    const ctx = makeCtx({
      cwd: tmpCwd,
      ui: {
        confirm: async () => true,
        select: async () => undefined,
        input: async () => undefined,
        notify: (msg: string, level?: string) => {
          if (level === 'warning') warnings.push(msg);
        },
      } as unknown as ExtensionContext['ui'],
    });

    // PATH without grok causes spawn ENOENT; warnings fire before spawn.
    const savedPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      const result = await executeAgentTool(
        { agent: 'acp', task: 'go' },
        undefined,
        undefined,
        ctx
      );
      expect(warnings.some((w) => w.includes('runtime: grok-acp') && w.includes('skills'))).toBe(
        true
      );
      expect(warnings.some((w) => w.includes('runtime: grok-acp') && w.includes('fork'))).toBe(
        true
      );
      // Result may be error from spawn; skill_error must not occur (skills ignored).
      const single = result.details?.results[0];
      expect(single?.stopReason).not.toBe('skill_error');
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
