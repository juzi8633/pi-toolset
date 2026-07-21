// ABOUTME: Integration-style tests for executeAgentTool() background dispatch and argument compatibility.
// ABOUTME: Uses an injected fake background manager and a fake workflow runner to avoid spawning real agents.

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { AgentToolResult, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { EventEmitter } from 'node:events';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { discoverAgents } from '../../src/config/agents.ts';
import { AgentAbortError } from '../../src/execution/execution.ts';
import { executeAgentTool, type ExecuteAgentToolOptions } from '../../src/execution/tool.ts';
import type { BackgroundManager } from '../../src/execution/background.ts';
import { clearDiscoveredSkills, setDiscoveredSkills } from '../../src/config/skills.ts';
import { createRunStore } from '../../src/run/run-store.ts';
import { agentFingerprint, createRunCoordinator } from '../../src/run/run-coordinator.ts';
import type { ListRunsResult, AgentRunRecordV1, RunUnitRecord } from '../../src/run/run-types.ts';
import type { SubagentDetails } from '../../src/shared/types.ts';
import * as worktreeMod from '../../src/execution/worktree.ts';

type AgentResult = AgentToolResult<SubagentDetails> & { isError?: boolean };

/** Minimal headings that satisfy agents/general.md completionCheck. */
const GENERAL_COMPLETION_HEADINGS = '## Completed\n\n## Files Changed\n\n## Validation\n';
/** Minimal headings that satisfy agents/explore.md completionCheck. */
const EXPLORE_COMPLETION_HEADINGS =
  '## Files Retrieved\n\n## Key Code\n\n## Architecture\n\n## Start Here\n';

function withGeneralCompletion(body: string): string {
  return `${body}\n${GENERAL_COMPLETION_HEADINGS}`;
}

function withExploreCompletion(body: string): string {
  return `${body}\n${EXPLORE_COMPLETION_HEADINGS}`;
}

function loadedRecordOf(entry: ListRunsResult[number]): AgentRunRecordV1 {
  if ('record' in entry) return entry.record;
  throw new Error(`corrupt run: ${entry.code}`);
}

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

function errResult(text: string): AgentResult {
  return { ...okResult(text), isError: true };
}

function fakeWorkflow(text: string): NonNullable<ExecuteAgentToolOptions['runWorkflow']> {
  return async () => okResult(text);
}

function fakeGrokSpawn(
  onSpawn: (args: string[]) => void,
  emitGrokMessage = true
): import('../../src/execution/execution.ts').SpawnFn {
  return ((_command: string, args: string[]) => {
    onSpawn(args);
    const child = new (class extends EventEmitter {
      stdout = new Readable({ read() {} });
      stderr = new Readable({ read() {} });
      stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
      kill() {
        this.stdout.push(null);
        this.stderr.push(null);
        setImmediate(() => this.emit('close', 0));
        return true;
      }
    })();
    setImmediate(() => {
      if (emitGrokMessage) {
        child.stdout.push(
          `${JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'grok done' }],
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          })}\n`
        );
      }
      child.kill();
    });
    return child;
  }) as unknown as import('../../src/execution/execution.ts').SpawnFn;
}

function fakeManager(): {
  manager: BackgroundManager;
  launches: Array<{ description: string; mode: string; title?: string }>;
  runs: Array<Promise<AgentResult>>;
} {
  const launches: Array<{ description: string; mode: string; title?: string }> = [];
  const runs: Array<Promise<AgentResult>> = [];
  const manager: BackgroundManager = {
    launch(request) {
      launches.push({ description: request.description, mode: request.mode, title: request.title });
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
              title: request.title,
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
    const { normalizeAgentArgs } = await import('../../src/index.ts');
    const out = normalizeAgentArgs({
      agent: 'noop',
      task: 'go',
      run_in_background: true,
    });
    expect(out).toEqual({ agent: 'noop', task: 'go', runInBackground: true });
  });

  it('does not overwrite an explicit runInBackground value', async () => {
    const { normalizeAgentArgs } = await import('../../src/index.ts');
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
    const { normalizeAgentArgs } = await import('../../src/index.ts');
    const input = { agent: 'noop', task: 'go' };
    expect(normalizeAgentArgs(input)).toBe(input);
  });
});

describe('agent tool title parameter', () => {
  it('accepts titles longer than 30 chars on single, task, chain, and fanout schemas', async () => {
    const { SubagentParams, TaskItem, SequentialChainItem, FanoutChainItem } =
      await import('../../src/shared/schema.ts');
    const { Value } = await import('typebox/value');
    const shortTitle = 'a'.repeat(30);
    const longTitle = 'a'.repeat(31);
    expect(Value.Check(SubagentParams, { agent: 'x', task: 'y', title: shortTitle })).toBe(true);
    expect(Value.Check(SubagentParams, { agent: 'x', task: 'y', title: longTitle })).toBe(true);
    expect(Value.Check(SubagentParams, { agent: 'x', task: 'y' })).toBe(true);
    expect(Value.Check(TaskItem, { agent: 'x', task: 'y', title: shortTitle })).toBe(true);
    expect(Value.Check(TaskItem, { agent: 'x', task: 'y', title: longTitle })).toBe(true);
    expect(Value.Check(SequentialChainItem, { agent: 'x', task: 'y', title: shortTitle })).toBe(
      true
    );
    expect(Value.Check(SequentialChainItem, { agent: 'x', task: 'y', title: longTitle })).toBe(
      true
    );
    const fanout = {
      expand: { from: { output: 'o', path: '/p' } },
      parallel: { agent: 'x', task: 'y', title: shortTitle },
      collect: { name: 'r' },
    };
    expect(Value.Check(FanoutChainItem, fanout)).toBe(true);
    const fanoutLong = {
      expand: { from: { output: 'o', path: '/p' } },
      parallel: { agent: 'x', task: 'y', title: longTitle },
      collect: { name: 'r' },
    };
    expect(Value.Check(FanoutChainItem, fanoutLong)).toBe(true);
  });

  it('passes the single title through to the workflow runner', async () => {
    let observed: { title?: string } | undefined;
    await executeAgentTool(
      { agent: 'noop', task: 'do it', title: '干活' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async (params) => {
          observed = params as { title?: string };
          return okResult('done');
        },
      }
    );
    expect(observed?.title).toBe('干活');
  });

  it('passes the first title to the background launch request', async () => {
    const { manager, launches } = fakeManager();
    await executeAgentTool(
      { agent: 'noop', task: 'do it later', title: '后台活', runInBackground: true },
      undefined,
      undefined,
      makeCtx(),
      { backgroundManager: manager, runWorkflow: fakeWorkflow('bg done') }
    );
    expect(launches.length).toBe(1);
    expect(launches[0].title).toBe('后台活');
  });

  it('uses the first chain step title for a background launch', async () => {
    const { manager, launches } = fakeManager();
    await executeAgentTool(
      {
        chain: [
          { agent: 'a', task: 'first', title: '首步' },
          { agent: 'b', task: 'second' },
        ],
        runInBackground: true,
      },
      undefined,
      undefined,
      makeCtx(),
      { backgroundManager: manager, runWorkflow: fakeWorkflow('bg done') }
    );
    expect(launches.length).toBe(1);
    expect(launches[0].title).toBe('首步');
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

  it('accepts only pi and grok-acp and omits replay parameters', async () => {
    const { RuntimeSchema, SubagentParams } = await import('../../src/shared/schema.ts');
    const { Value } = await import('typebox/value');
    expect(Value.Check(RuntimeSchema, 'pi')).toBe(true);
    expect(Value.Check(RuntimeSchema, 'grok')).toBe(false);
    expect(Value.Check(RuntimeSchema, 'grok-acp')).toBe(true);
    expect(Value.Check(RuntimeSchema, 'claude')).toBe(false);
    expect(Value.Check(RuntimeSchema, 'weird')).toBe(false);
    expect('allowReplay' in SubagentParams.properties).toBe(false);
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

describe('executeAgentTool durable run persistence', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-durable-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeStore() {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    return { store, coordinator };
  }

  it('dispatches a fresh Grok ACP run', async () => {
    const { store, coordinator } = makeStore();
    let spawnCount = 0;

    await executeAgentTool(
      { agent: 'general', task: 'fresh Grok ACP task', runtime: 'grok-acp' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runStore: store,
        runCoordinator: coordinator,
        spawnFn: fakeGrokSpawn(() => spawnCount++, false),
      }
    );

    expect(spawnCount).toBe(1);
  });

  it('creates a durable run before the workflow starts and finalizes completed on success', async () => {
    const { store, coordinator } = makeStore();
    let observedRunId: string | undefined;
    let workflowStarted = false;
    const result = await executeAgentTool(
      { agent: 'noop', task: 'do it' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async (_params, _signal, _onUpdate, _ctx, _agents, _makeDetails) => {
          // The run must already exist on disk before the workflow runs.
          workflowStarted = true;
          const runs = await store.listRuns();
          expect(runs.length).toBe(1);
          const record = loadedRecordOf(runs[0]!);
          observedRunId = record.runId;
          expect(record.status).toBe('running');
          return okResult('sync done');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(workflowStarted).toBe(true);
    expect(result.details?.run?.runId).toBe(observedRunId);
    expect(result.details?.run?.status).toBe('completed');
    // The stored record persists on disk; the seam workflow does not call
    // beginUnit/endUnit, so unit-derived status stays 'running' while the
    // returned details.run summary reflects the foreground completion.
    const loaded = store.getRun(observedRunId!);
    expect(loaded.ok).toBe(true);
    const finalRecord = (loaded as { ok: true; loaded: { record: { runId: string } } }).loaded
      .record;
    expect(finalRecord.runId).toBe(observedRunId!);
  });

  it('creates only sequential chain unit records at start (no fanout placeholders)', async () => {
    const { store, coordinator } = makeStore();
    let unitKeys: string[] = [];
    await executeAgentTool(
      {
        chain: [
          { agent: 'noop', task: 'seed', name: 'seed' },
          {
            expand: { from: { output: 'seed', path: '' } },
            parallel: { agent: 'noop', task: 'item {item}' },
            collect: { name: 'items' },
          },
          { agent: 'noop', task: 'done' },
        ],
      },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => {
          const runs = await store.listRuns();
          const record = loadedRecordOf(runs[0]!);
          unitKeys = Object.keys(record.units).sort();
          return okResult('chain done');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(unitKeys).toEqual(['chain-0001', 'chain-0003']);
    expect(unitKeys.some((id) => id.endsWith('-fanout') && !id.match(/fanout-\d{4}$/))).toBe(false);
  });

  it('does not create a run when persistence is not injected (legacy path)', async () => {
    let observedCount = -1;
    await executeAgentTool({ agent: 'noop', task: 'do it' }, undefined, undefined, makeCtx(), {
      runWorkflow: async () => {
        // No store injected; nothing to list.
        observedCount = 0;
        return okResult('done');
      },
    });
    expect(observedCount).toBe(0);
  });

  it('finalizes as cancelled when the workflow aborts with a user signal', async () => {
    const { store, coordinator } = makeStore();
    const controller = new AbortController();
    let runId: string | undefined;
    await executeAgentTool(
      { agent: 'noop', task: 'do it' },
      controller.signal,
      undefined,
      makeCtx(),
      {
        runWorkflow: async (_params, signal) => {
          const runs = await store.listRuns();
          runId = loadedRecordOf(runs[0]!).runId;
          // Bridge the incoming signal onto the coordinator-owned lifecycle.
          controller.abort();
          // Wait for the workflow signal (coordinator-owned) to observe the abort.
          if (signal?.aborted) {
            // already aborted
          } else {
            await new Promise<void>((resolve) => {
              signal!.addEventListener('abort', () => resolve(), { once: true });
            });
          }
          throw new Error('aborted');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    ).catch(() => {
      // Expected to reject; the durable finalize still runs in finally.
    });
    const loaded = store.getRun(runId!);
    expect(loaded.ok).toBe(true);
    const record = (loaded as { ok: true; loaded: { record: { status: string } } }).loaded.record;
    expect(record.status).toBe('cancelled');
  });

  it('finalizes as failed when the workflow returns isError', async () => {
    const { store, coordinator } = makeStore();
    const result = await executeAgentTool(
      { agent: 'noop', task: 'do it' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => errResult('boom'),
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBe(true);
    const runs = await store.listRuns();
    const record = loadedRecordOf(runs[0]!);
    expect(record.status).toBe('failed');
  });

  it('stamps foreground terminal failure with queued siblings as resumable', async () => {
    const { store, coordinator } = makeStore();
    // Parallel launch creates two units that remain queued when the seam
    // workflow returns isError without beginUnit/endUnit. stampRunOnDetails
    // must use finalStatus=failed (not derived running) for resumability.
    const result = await executeAgentTool(
      {
        tasks: [
          { agent: 'noop', task: 'first' },
          { agent: 'noop', task: 'second' },
        ],
      },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => errResult('first failed'),
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBe(true);
    expect(result.details?.run?.status).toBe('failed');
    expect(result.details?.run?.resumable).toBe(true);
    const runs = await store.listRuns();
    const record = loadedRecordOf(runs[0]!);
    expect(Object.values(record.units).some((u) => u.status === 'queued')).toBe(true);
  });

  it('stamps foreground terminal cancellation with queued siblings as resumable', async () => {
    const { store, coordinator } = makeStore();
    const controller = new AbortController();
    const result = await executeAgentTool(
      {
        tasks: [
          { agent: 'noop', task: 'first' },
          { agent: 'noop', task: 'second' },
        ],
      },
      controller.signal,
      undefined,
      makeCtx(),
      {
        runWorkflow: async (_params, signal) => {
          controller.abort();
          if (signal && !signal.aborted) {
            await new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
          }
          // Return (do not throw) so stampRunOnDetails runs on the foreground path.
          return errResult('cancelled mid-run');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBe(true);
    expect(result.details?.run?.status).toBe('cancelled');
    expect(result.details?.run?.resumable).toBe(true);
  });

  it('uses the run id as the background job id', async () => {
    const { manager, launches, runs } = fakeManager();
    const { store, coordinator } = makeStore();
    let runId: string | undefined;
    await executeAgentTool(
      { agent: 'noop', task: 'bg', runInBackground: true },
      undefined,
      undefined,
      makeCtx(),
      {
        backgroundManager: manager,
        runWorkflow: async () => {
          const listRuns = await store.listRuns();
          runId = loadedRecordOf(listRuns[0]!).runId;
          return okResult('bg done');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    await Promise.allSettled(runs);
    // The fake manager's jobId is hardcoded to 'agent-bg-test'; the real manager
    // would use the run id. Here we assert the run exists and is completed.
    expect(launches.length).toBe(1);
    const loaded = store.getRun(runId!);
    expect(loaded.ok).toBe(true);
  });

  it('returns run_store_error and does not spawn the workflow when pre-spawn persistence fails', async () => {
    const { store, coordinator } = makeStore();
    // Wrap the store so createRun rejects, simulating a pre-spawn persistence failure.
    const failingStore: typeof store = {
      ...store,
      createRun: async () => {
        throw new Error('disk full');
      },
    };
    let workflowCalled = false;
    const result = await executeAgentTool(
      { agent: 'noop', task: 'do it' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => {
          workflowCalled = true;
          return okResult('should not run');
        },
        runStore: failingStore,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect((result.content[0] as { text: string }).text).toContain('run_store_error');
    expect((result.content[0] as { text: string }).text).toContain('disk full');
    expect(workflowCalled).toBe(false);
  });

  it('terminates the owned claim even when terminal snapshot persistence fails', async () => {
    const { store, coordinator } = makeStore();
    // Wrap the store so the terminal run_terminal event write rejects, simulating
    // a terminal persistence failure. Startup events still succeed so the run
    // starts; the claim must still be released via the finally path.
    const failingStore: typeof store = {
      ...store,
      appendEvent: async (_runId, event) => {
        if (event.event === 'run_terminal') {
          throw new Error('terminal event write failed');
        }
      },
    };
    let runId: string | undefined;
    await executeAgentTool({ agent: 'noop', task: 'do it' }, undefined, undefined, makeCtx(), {
      runWorkflow: async () => {
        const runs = await store.listRuns();
        runId = loadedRecordOf(runs[0]!).runId;
        return okResult('done');
      },
      runStore: failingStore,
      runCoordinator: coordinator,
    }).catch(() => {
      // finalizeDurableRun may reject; the claim must still be released.
    });
    // Inspect claims: the terminal marker must be published (released or abandoned).
    const claims = store.inspectClaims(runId!);
    expect(claims.ok).toBe(true);
    if (claims.ok) {
      const terminal = claims.claims.find((c) => c.terminal !== undefined)?.terminal;
      expect(terminal).toBeDefined();
      expect(terminal!.state === 'released' || terminal!.state === 'abandoned').toBe(true);
    }
  });

  it('fresh success publishes exactly one run_terminal and releases the claim', async () => {
    const { store, coordinator } = makeStore();
    let runId: string | undefined;
    await executeAgentTool({ agent: 'noop', task: 'do it' }, undefined, undefined, makeCtx(), {
      runWorkflow: async () => {
        const runs = await store.listRuns();
        runId = loadedRecordOf(runs[0]!).runId;
        return okResult('done');
      },
      runStore: store,
      runCoordinator: coordinator,
    });
    const eventsFile = path.join(store.getRunDir(runId!), 'events.jsonl');
    const lines = readFileSync(eventsFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    const terminals = lines.filter((l) => l.includes('"run_terminal"'));
    expect(terminals.length).toBe(1);
    const claims = store.inspectClaims(runId!);
    expect(claims.ok).toBe(true);
    if (claims.ok) {
      const terminal = claims.claims.find((c) => c.terminal !== undefined)?.terminal;
      expect(terminal).toBeDefined();
      expect(terminal!.state).toBe('released');
    }
    expect(coordinator.isActive(runId!)).toBe(false);
  });

  it('strict run.json failure abandons the claim with no run_terminal and rethrows', async () => {
    const { store } = makeStore();
    let runId: string | undefined;
    const failingStore: typeof store = {
      ...store,
      updateRunStrict: async (_runId, mutate) => {
        // Mutate the real record then reject the strict write so finalize sees failure.
        const real = store.getRun(_runId);
        if (real.ok) mutate(real.loaded.record);
        throw new Error('strict run.json write failed');
      },
    };
    const failingCoordinator = createRunCoordinator({ store: failingStore });
    let threw = false;
    await executeAgentTool({ agent: 'noop', task: 'do it' }, undefined, undefined, makeCtx(), {
      runWorkflow: async () => {
        const runs = await store.listRuns();
        runId = loadedRecordOf(runs[0]!).runId;
        return okResult('done');
      },
      runStore: failingStore,
      runCoordinator: failingCoordinator,
    }).catch(() => {
      threw = true;
    });
    expect(threw).toBe(true);
    const eventsFile = path.join(store.getRunDir(runId!), 'events.jsonl');
    const lines = readFileSync(eventsFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines.filter((l) => l.includes('"run_terminal"')).length).toBe(0);
    const claims = store.inspectClaims(runId!);
    expect(claims.ok).toBe(true);
    if (claims.ok) {
      const terminal = claims.claims.find((c) => c.terminal !== undefined)?.terminal;
      expect(terminal).toBeDefined();
      expect(terminal!.state).toBe('abandoned');
    }
  });

  it('strict run_terminal append failure abandons the claim and rethrows', async () => {
    const { store } = makeStore();
    let runId: string | undefined;
    const failingStore: typeof store = {
      ...store,
      appendEventStrict: async (_runId, event) => {
        if (event.event === 'run_terminal') {
          throw new Error('strict run_terminal append failed');
        }
        await store.appendEvent(_runId, event);
      },
    };
    const failingCoordinator = createRunCoordinator({ store: failingStore });
    let threw = false;
    await executeAgentTool({ agent: 'noop', task: 'do it' }, undefined, undefined, makeCtx(), {
      runWorkflow: async () => {
        const runs = await store.listRuns();
        runId = loadedRecordOf(runs[0]!).runId;
        return okResult('done');
      },
      runStore: failingStore,
      runCoordinator: failingCoordinator,
    }).catch(() => {
      threw = true;
    });
    expect(threw).toBe(true);
    const eventsFile = path.join(store.getRunDir(runId!), 'events.jsonl');
    const lines = readFileSync(eventsFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines.filter((l) => l.includes('"run_terminal"')).length).toBe(0);
    // run.json stays authoritative: strict finalizeRun wrote finishedAt before the
    // terminal-event failure (status derives from durable unit state).
    const loaded = store.getRun(runId!);
    if (loaded.ok) expect(loaded.loaded.record.finishedAt).toBeDefined();
    const claims = store.inspectClaims(runId!);
    expect(claims.ok).toBe(true);
    if (claims.ok) {
      const terminal = claims.claims.find((c) => c.terminal !== undefined)?.terminal;
      expect(terminal).toBeDefined();
      expect(terminal!.state).toBe('abandoned');
    }
  });

  it('release failure attempts abandon and rethrows', async () => {
    const { store } = makeStore();
    let runId: string | undefined;
    let abandonCalled = false;
    const realAbandon = store.abandonRun.bind(store);
    const failingStore: typeof store = {
      ...store,
      releaseRun: async (_runId, _claimId) => {
        throw new Error('release failed');
      },
      abandonRun: async (runId2, claimId) => {
        abandonCalled = true;
        await realAbandon(runId2, claimId);
      },
    };
    const failingCoordinator = createRunCoordinator({ store: failingStore });
    let threw = false;
    await executeAgentTool({ agent: 'noop', task: 'do it' }, undefined, undefined, makeCtx(), {
      runWorkflow: async () => {
        const runs = await store.listRuns();
        runId = loadedRecordOf(runs[0]!).runId;
        return okResult('done');
      },
      runStore: failingStore,
      runCoordinator: failingCoordinator,
    }).catch(() => {
      threw = true;
    });
    expect(threw).toBe(true);
    expect(abandonCalled).toBe(true);
    const eventsFile = path.join(store.getRunDir(runId!), 'events.jsonl');
    const lines = readFileSync(eventsFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines.filter((l) => l.includes('"run_terminal"')).length).toBe(1);
    const claims = store.inspectClaims(runId!);
    expect(claims.ok).toBe(true);
    if (claims.ok) {
      const terminal = claims.claims.find((c) => c.terminal !== undefined)?.terminal;
      expect(terminal).toBeDefined();
      expect(terminal!.state).toBe('abandoned');
    }
  });
});

describe('durable chain fanout item lifecycle', () => {
  const AGENT_DIR_BEFORE_FANOUT = process.env.PI_CODING_AGENT_DIR;
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-fanout-'));
    process.env.PI_CODING_AGENT_DIR = path.join(tmpRoot, 'pi-agent');
  });
  afterEach(() => {
    if (AGENT_DIR_BEFORE_FANOUT !== undefined) {
      process.env.PI_CODING_AGENT_DIR = AGENT_DIR_BEFORE_FANOUT;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('isolates out-of-order fanout item terminals across three unit records', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const created = await store.createRun({
      mode: 'chain',
      agentScope: 'user',
      background: false,
      request: {
        mode: 'chain',
        agentScope: 'user',
        chain: [
          { agent: 'seed', task: 'seed step' },
          {
            expand: { from: { output: 'seed', path: '/items' } },
            parallel: { agent: 'worker', task: 'Process {item}' },
            collect: { name: 'out' },
          },
        ],
      },
      details: {
        mode: 'chain',
        agentScope: 'user',
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
        results: [],
      },
      units: {
        'chain-0001': {
          unitId: 'chain-0001',
          agent: 'seed',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          step: 1,
          attempt: 1,
          attempts: [],
          effectiveCwd: '/tmp',
        },
      },
    });
    const runId = created.runId;
    const live = created.record;
    live.status = 'running';
    coordinator.registerRun(runId, live);

    const expansion = await coordinator.expandFanout(runId, {
      step: 2,
      items: ['a', 'b', 'c'],
      agent: {
        name: 'worker',
        description: '',
        systemPrompt: '',
        source: 'builtin',
        filePath: '/tmp/w.md',
      },
      runtime: undefined,
      effectiveCwd: '/tmp',
    });
    expect(expansion.unitIds).toEqual([
      'chain-0002-fanout-0001',
      'chain-0002-fanout-0002',
      'chain-0002-fanout-0003',
    ]);

    // Production order: persistSessionFile (strict first-write) before start/finish.
    // Full merge is disk-exact for sessionFile — startUnit/finishUnit alone cannot
    // establish a first path (stale live snapshots must not inject sessionFile).
    const finish = async (index: number, text: string) => {
      const unitId = expansion.unitIds[index]!;
      const sessionFile = `/sessions/${unitId}.jsonl`;
      const ctx = {
        runId,
        unitId,
        agent: 'worker',
        runtime: undefined,
        resumeCapability: 'session' as const,
        effectiveCwd: '/tmp',
        attempt: 1,
        step: 2,
        fanoutIndex: index,
        sessionFile,
      };
      await coordinator.persistSessionFile({ runId, unitId, sessionFile });
      coordinator.startUnit(runId, ctx);
      const result = {
        agent: 'worker',
        agentSource: 'builtin' as const,
        task: text,
        exitCode: 0,
        status: 'completed' as const,
        messages: [],
        stderr: '',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 1,
        },
        step: 2,
        fanout: { index, count: 3, itemTask: text },
        finalOutput: text,
      };
      await coordinator.finishUnit(runId, ctx, result, 'completed');
    };

    // Out-of-order terminals (1, 2, 0) — each unit keeps its own sessionFile.
    await finish(1, 'item-1');
    await finish(2, 'item-2');
    await finish(0, 'item-0');
    await new Promise((r) => setTimeout(r, 30));

    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const units = loaded.loaded.record.units;
    expect(units['chain-0002-fanout-0001']!.result?.finalOutput).toBe('item-0');
    expect(units['chain-0002-fanout-0002']!.result?.finalOutput).toBe('item-1');
    expect(units['chain-0002-fanout-0003']!.result?.finalOutput).toBe('item-2');
    expect(units['chain-0002-fanout-0001']!.sessionFile).toContain('chain-0002-fanout-0001');
    expect(units['chain-0002-fanout-0002']!.sessionFile).toContain('chain-0002-fanout-0002');
    expect(units['chain-0002-fanout-0003']!.sessionFile).toContain('chain-0002-fanout-0003');
    expect(units['chain-0002-fanout-0001']!.result?.sessionFile).toContain(
      'chain-0002-fanout-0001'
    );
    expect(units['chain-0002-fanout-0002']!.result?.sessionFile).toContain(
      'chain-0002-fanout-0002'
    );
    expect(units['chain-0002-fanout-0003']!.result?.sessionFile).toContain(
      'chain-0002-fanout-0003'
    );
    expect(units['chain-0002-fanout-0001']!.attempt).toBe(1);
    expect(units['chain-0002-fanout-0002']!.attempt).toBe(1);
    expect(units['chain-0002-fanout-0003']!.attempt).toBe(1);
    expect(units['chain-0002-fanout']).toBeUndefined();
  });

  it('live-only sessionFile on start/finish is not first-written by full merge', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const created = await store.createRun({
      mode: 'chain',
      agentScope: 'user',
      background: false,
      request: {
        mode: 'chain',
        agentScope: 'user',
        chain: [
          { agent: 'seed', task: 'seed step' },
          {
            expand: { from: { output: 'seed', path: '/items' } },
            parallel: { agent: 'worker', task: 'Process {item}' },
            collect: { name: 'out' },
          },
        ],
      },
      details: {
        mode: 'chain',
        agentScope: 'user',
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
        results: [],
      },
      units: {
        'chain-0001': {
          unitId: 'chain-0001',
          agent: 'seed',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          step: 1,
          attempt: 1,
          attempts: [],
          effectiveCwd: '/tmp',
        },
      },
    });
    const runId = created.runId;
    const live = created.record;
    live.status = 'running';
    coordinator.registerRun(runId, live);

    const expansion = await coordinator.expandFanout(runId, {
      step: 2,
      items: ['only'],
      agent: {
        name: 'worker',
        description: '',
        systemPrompt: '',
        source: 'builtin',
        filePath: '/tmp/w.md',
      },
      runtime: undefined,
      effectiveCwd: '/tmp',
    });
    const unitId = expansion.unitIds[0]!;
    const ctx = {
      runId,
      unitId,
      agent: 'worker',
      runtime: undefined,
      resumeCapability: 'session' as const,
      effectiveCwd: '/tmp',
      attempt: 1,
      step: 2,
      fanoutIndex: 0,
      sessionFile: `/sessions/${unitId}.jsonl`,
    };
    // Intentionally skip persistSessionFile — full merge must not accept live-only path.
    coordinator.startUnit(runId, ctx);
    await coordinator.finishUnit(
      runId,
      ctx,
      {
        agent: 'worker',
        agentSource: 'builtin' as const,
        task: 'only',
        exitCode: 0,
        status: 'completed' as const,
        messages: [],
        stderr: '',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 1,
        },
        step: 2,
        fanout: { index: 0, count: 1, itemTask: 'only' },
        finalOutput: 'only',
      },
      'completed'
    );
    await new Promise((r) => setTimeout(r, 30));

    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const unit = loaded.loaded.record.units[unitId]!;
    expect(unit.result?.finalOutput).toBe('only');
    expect(unit.sessionFile).toBeUndefined();
    expect(unit.result?.sessionFile).toBeUndefined();
  });

  it('persists empty fanout mapping with no child units or placeholder', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const created = await store.createRun({
      mode: 'chain',
      agentScope: 'user',
      background: false,
      request: {
        mode: 'chain',
        agentScope: 'user',
        chain: [
          { agent: 'seed', task: 'seed step' },
          {
            expand: { from: { output: 'seed', path: '/items' } },
            parallel: { agent: 'worker', task: 'Process {item}' },
            collect: { name: 'out' },
          },
        ],
      },
      details: {
        mode: 'chain',
        agentScope: 'user',
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
        results: [],
      },
      units: {
        'chain-0001': {
          unitId: 'chain-0001',
          agent: 'seed',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          step: 1,
          attempt: 1,
          attempts: [],
          effectiveCwd: '/tmp',
        },
      },
    });
    const live = created.record;
    live.status = 'running';
    coordinator.registerRun(created.runId, live);

    await coordinator.expandFanout(created.runId, {
      step: 2,
      items: [],
      agent: {
        name: 'worker',
        description: '',
        systemPrompt: '',
        source: 'builtin',
        filePath: '/tmp/w.md',
      },
      runtime: undefined,
      effectiveCwd: '/tmp',
    });

    await coordinator.finalizeRun(created.runId, live.details, live.units, { success: true });
    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const record = loaded.loaded.record;
    expect(record.workflowState?.fanouts?.['chain-0002-fanout']).toEqual({
      step: 2,
      items: [],
      unitIds: [],
    });
    expect(Object.keys(record.units)).toEqual(['chain-0001']);
    expect(record.units['chain-0002-fanout']).toBeUndefined();
    expect(record.status).toBe('completed');
  });

  it('expansion write failure leaves no child units and surfaces the error', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const created = await store.createRun({
      mode: 'chain',
      agentScope: 'user',
      background: false,
      request: {
        mode: 'chain',
        agentScope: 'user',
        chain: [
          { agent: 'seed', task: 'seed step' },
          {
            expand: { from: { output: 'seed', path: '/items' } },
            parallel: { agent: 'worker', task: 'Process {item}' },
            collect: { name: 'out' },
          },
        ],
      },
      details: {
        mode: 'chain',
        agentScope: 'user',
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
        results: [],
      },
      units: {
        'chain-0001': {
          unitId: 'chain-0001',
          agent: 'seed',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          step: 1,
          attempt: 1,
          attempts: [],
          effectiveCwd: '/tmp',
        },
      },
    });
    const live = created.record;
    live.status = 'running';
    coordinator.registerRun(created.runId, live);

    store.updateRun = (async () => {
      throw new Error('disk full');
    }) as typeof store.updateRun;

    await expect(
      coordinator.expandFanout(created.runId, {
        step: 2,
        items: ['a'],
        agent: {
          name: 'worker',
          description: '',
          systemPrompt: '',
          source: 'builtin',
          filePath: '/tmp/w.md',
        },
        runtime: undefined,
        effectiveCwd: '/tmp',
      })
    ).rejects.toThrow(/disk full/);

    expect(live.units['chain-0002-fanout-0001']).toBeUndefined();
    expect(live.workflowState?.fanouts?.['chain-0002-fanout']).toBeUndefined();
  });

  it('terminal postprocess failure status is what finishUnit persists', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const created = await store.createRun({
      mode: 'chain',
      agentScope: 'user',
      background: false,
      request: {
        mode: 'chain',
        agentScope: 'user',
        // Fanout-only topology at step 1 (matches expandFanout step below).
        chain: [
          {
            expand: { from: { output: 'seed', path: '/items' } },
            parallel: { agent: 'worker', task: 'Process {item}' },
            collect: { name: 'out' },
          },
        ],
      },
      details: {
        mode: 'chain',
        agentScope: 'user',
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
        results: [],
      },
      units: {},
    });
    const live = created.record;
    live.status = 'running';
    coordinator.registerRun(created.runId, live);
    await coordinator.expandFanout(created.runId, {
      step: 1,
      items: ['x'],
      agent: {
        name: 'worker',
        description: '',
        systemPrompt: '',
        source: 'builtin',
        filePath: '/tmp/w.md',
      },
      runtime: undefined,
      effectiveCwd: '/tmp',
    });

    const unitId = 'chain-0001-fanout-0001';
    const ctx = {
      runId: created.runId,
      unitId,
      agent: 'worker',
      runtime: undefined,
      resumeCapability: 'session' as const,
      effectiveCwd: '/tmp',
      attempt: 1,
      step: 1,
      fanoutIndex: 0,
    };
    await coordinator.startUnit(created.runId, ctx);
    const result = {
      agent: 'worker',
      agentSource: 'builtin' as const,
      task: 'x',
      exitCode: 1,
      status: 'failed' as const,
      messages: [],
      stderr: 'Structured output error: bad',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 1,
      },
      step: 1,
      fanout: { index: 0, count: 1, itemTask: 'x' },
      stopReason: 'structured_output_error',
      errorMessage: 'Structured output error: bad',
      worktreePath: '/tmp/.worktrees/kept',
      worktreeDirty: false,
    };
    // Production order: postprocess (already applied) then finishUnit.
    await coordinator.finishUnit(created.runId, ctx, result, 'failed');
    await new Promise((r) => setTimeout(r, 20));

    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const unit = loaded.loaded.record.units[unitId]!;
    expect(unit.status).toBe('failed');
    expect(unit.result?.status).toBe('failed');
    expect(unit.result?.stopReason).toBe('structured_output_error');
    expect(unit.result?.worktreePath).toBe('/tmp/.worktrees/kept');
  });

  it('cancel mid-fanout keeps completed terminal, cancels started, leaves unstarted queued', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const created = await store.createRun({
      mode: 'chain',
      agentScope: 'user',
      background: false,
      request: {
        mode: 'chain',
        agentScope: 'user',
        chain: [
          { agent: 'seed', task: 'seed step' },
          {
            expand: { from: { output: 'seed', path: '/items' } },
            parallel: { agent: 'worker', task: 'Process {item}' },
            collect: { name: 'out' },
          },
        ],
      },
      details: {
        mode: 'chain',
        agentScope: 'user',
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
        results: [],
      },
      units: {
        'chain-0001': {
          unitId: 'chain-0001',
          agent: 'seed',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          step: 1,
          attempt: 1,
          attempts: [],
          effectiveCwd: '/tmp',
        },
      },
    });
    const live = created.record;
    live.status = 'running';
    coordinator.registerRun(created.runId, live);

    const agent = {
      name: 'worker',
      description: '',
      systemPrompt: '',
      source: 'builtin' as const,
      filePath: '/tmp/w.md',
    };
    const expansion = await coordinator.expandFanout(created.runId, {
      step: 2,
      items: ['a', 'b', 'c', 'd'],
      agent,
      runtime: undefined,
      effectiveCwd: '/tmp',
    });

    const makeCtx = (index: number) => ({
      runId: created.runId,
      unitId: expansion.unitIds[index]!,
      agent: 'worker',
      runtime: undefined,
      resumeCapability: 'session' as const,
      effectiveCwd: '/tmp',
      attempt: 1,
      step: 2,
      fanoutIndex: index,
    });

    const completedResult = {
      agent: 'worker',
      agentSource: 'builtin' as const,
      task: 'a',
      exitCode: 0,
      status: 'completed' as const,
      messages: [],
      stderr: '',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 1,
      },
      step: 2,
      fanout: { index: 0, count: 4, itemTask: 'a' },
      finalOutput: 'done-a',
    };
    coordinator.startUnit(created.runId, makeCtx(0));
    await coordinator.finishUnit(created.runId, makeCtx(0), completedResult, 'completed');

    coordinator.startUnit(created.runId, makeCtx(1));
    await coordinator.finishUnit(
      created.runId,
      makeCtx(1),
      {
        ...completedResult,
        task: 'b',
        status: 'cancelled',
        exitCode: 1,
        fanout: { index: 1, count: 4, itemTask: 'b' },
        finalOutput: undefined,
        stopReason: 'aborted',
      },
      'cancelled'
    );
    // Items 2 and 3 remain queued — never started.

    const fanoutResults = [
      completedResult,
      {
        ...completedResult,
        task: 'b',
        status: 'cancelled' as const,
        exitCode: 1,
        fanout: { index: 1, count: 4, itemTask: 'b' },
        stopReason: 'aborted' as const,
        finalOutput: undefined,
      },
    ];
    live.details = {
      ...live.details,
      results: fanoutResults,
    };
    await coordinator.finalizeRun(created.runId, live.details, live.units, { cancelled: true });
    await new Promise((r) => setTimeout(r, 20));

    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const record = loaded.loaded.record;
    expect(record.status).toBe('cancelled');
    expect(record.units['chain-0002-fanout']).toBeUndefined();
    expect(record.units['chain-0002-fanout-0001']!.status).toBe('completed');
    expect(record.units['chain-0002-fanout-0001']!.result?.finalOutput).toBe('done-a');
    expect(record.units['chain-0002-fanout-0002']!.status).toBe('cancelled');
    expect(record.units['chain-0002-fanout-0002']!.attempts.length).toBeGreaterThan(0);
    expect(record.units['chain-0002-fanout-0003']!.status).toBe('queued');
    expect(record.units['chain-0002-fanout-0003']!.attempts).toEqual([]);
    expect(record.units['chain-0002-fanout-0004']!.status).toBe('queued');
    expect(record.units['chain-0002-fanout-0004']!.attempts).toEqual([]);
    // Position / capability metadata intact on every child.
    for (let i = 0; i < 4; i++) {
      const u = record.units[expansion.unitIds[i]!]!;
      expect(u.step).toBe(2);
      expect(u.fanoutIndex).toBe(i);
      expect(u.capability).toBe('session');
      expect(u.agentFingerprint.length).toBeGreaterThan(0);
    }
  });

  it('final run.json unit results agree with details.results and carry positions', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const created = await store.createRun({
      mode: 'chain',
      agentScope: 'user',
      background: false,
      request: {
        mode: 'chain',
        agentScope: 'user',
        // Fanout-only topology at step 1 (matches expandFanout step below).
        chain: [
          {
            expand: { from: { output: 'seed', path: '/items' } },
            parallel: { agent: 'worker', task: 'Process {item}' },
            collect: { name: 'out' },
          },
        ],
      },
      details: {
        mode: 'chain',
        agentScope: 'user',
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
        results: [],
      },
      units: {},
    });
    const live = created.record;
    live.status = 'running';
    coordinator.registerRun(created.runId, live);

    const expansion = await coordinator.expandFanout(created.runId, {
      step: 1,
      items: ['x', 'y'],
      agent: {
        name: 'worker',
        description: '',
        systemPrompt: 'sys',
        source: 'builtin',
        filePath: '/tmp/w.md',
      },
      runtime: undefined,
      effectiveCwd: '/tmp',
    });

    const results: Array<{
      agent: string;
      agentSource: 'builtin';
      task: string;
      exitCode: number;
      status: 'completed';
      messages: [];
      stderr: string;
      usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: number;
        contextTokens: number;
        turns: number;
      };
      step: number;
      fanout: { index: number; count: number; itemTask: string };
      finalOutput: string;
    }> = [];

    for (let i = 0; i < 2; i++) {
      const unitId = expansion.unitIds[i]!;
      const ctx = {
        runId: created.runId,
        unitId,
        agent: 'worker',
        runtime: undefined,
        resumeCapability: 'session' as const,
        effectiveCwd: '/tmp',
        attempt: 1,
        step: 1,
        fanoutIndex: i,
      };
      coordinator.startUnit(created.runId, ctx);
      const result = {
        agent: 'worker',
        agentSource: 'builtin' as const,
        task: (expansion.items ?? [])[i] as string,
        exitCode: 0,
        status: 'completed' as const,
        messages: [] as [],
        stderr: '',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          contextTokens: 0,
          turns: 1,
        },
        step: 1,
        fanout: { index: i, count: 2, itemTask: (expansion.items ?? [])[i] as string },
        finalOutput: `out-${i}`,
      };
      results.push(result);
      await coordinator.finishUnit(created.runId, ctx, result, 'completed');
    }

    live.details = { ...live.details, results };
    await coordinator.finalizeRun(created.runId, live.details, live.units, { success: true });
    await new Promise((r) => setTimeout(r, 20));

    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const record = loaded.loaded.record;
    expect(record.status).toBe('completed');
    expect(record.units['chain-0001-fanout']).toBeUndefined();
    expect(Object.keys(record.units).sort()).toEqual([
      'chain-0001-fanout-0001',
      'chain-0001-fanout-0002',
    ]);
    for (let i = 0; i < 2; i++) {
      const unitId = expansion.unitIds[i]!;
      const unit = record.units[unitId]!;
      const presented = record.details.results[i]!;
      expect(unit.result?.finalOutput).toBe(presented.finalOutput);
      expect(unit.result?.status).toBe(presented.status);
      expect(unit.step).toBe(1);
      expect(unit.fanoutIndex).toBe(i);
      expect(unit.capability).toBe('session');
      expect(unit.agentFingerprint.length).toBeGreaterThan(0);
      expect(unit.runtime === undefined || unit.runtime === 'pi').toBe(true);
    }
  });
});

describe('executeAgentTool terminal finalization', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-term-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('preserves AgentAbortError.origin through terminal replacement', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const agent = discoverAgents(process.cwd(), 'both').agents.find((a) => a.name === 'explore')!;
    let thrown: unknown;
    try {
      await executeAgentTool(
        { agent: 'explore', task: 'abort me' },
        undefined,
        undefined,
        {
          cwd: process.cwd(),
          sessionManager: {
            getSessionId: () => 'host-term',
            getBranch: () => [],
            appendCustomEntry: () => undefined,
          },
          ui: { notify: () => undefined },
        } as never,
        {
          runWorkflow: async () => {
            const provisional = {
              agent: 'explore',
              agentSource: agent.source,
              task: 'abort me',
              exitCode: 1,
              status: 'cancelled' as const,
              messages: [
                {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'partial before abort' }],
                } as never,
              ],
              stderr: '',
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                cost: 0,
                contextTokens: 2,
                turns: 1,
              },
              stopReason: 'aborted' as const,
              errorMessage: 'Subagent was aborted',
              sessionFile: path.join(tmpRoot, 's.jsonl'),
            };
            throw new AgentAbortError(provisional, 'user');
          },
          runStore: store,
          runCoordinator: coordinator,
        }
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AgentAbortError);
    expect((thrown as AgentAbortError).origin).toBe('user');
    expect((thrown as AgentAbortError).result.messages).toEqual([]);
    expect((thrown as AgentAbortError).result.finalOutput).toBe('partial before abort');
    // Durable finalize from abort should classify as cancelled for user origin.
    const runs = await store.listRuns();
    const record = (runs.find((r) => 'record' in r) as { record: { status: string } } | undefined)
      ?.record;
    expect(record?.status).toBe('cancelled');
  });

  it('persists early unknown-agent failure with compact durable result identity', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const result = await executeAgentTool(
      { agent: 'does-not-exist-xyz', task: 'fail early' },
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        sessionManager: {
          getSessionId: () => 'host-early',
          getBranch: () => [],
          appendCustomEntry: () => undefined,
        },
        ui: { notify: () => undefined },
      } as never,
      {
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBe(true);
    const runs = await store.listRuns();
    const entry = runs.find((r) => 'record' in r) as
      | {
          record: {
            status: string;
            units: Record<
              string,
              { status: string; result?: { messages: unknown[]; agent: string; task: string } }
            >;
          };
        }
      | undefined;
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry.record.status).toBe('failed');
    const unit = Object.values(entry.record.units)[0]!;
    expect(unit.status).toBe('failed');
    expect(unit.result).toBeDefined();
    expect(unit.result!.messages).toEqual([]);
    expect(unit.result!.agent).toBe('does-not-exist-xyz');
    expect(unit.result!.task).toBe('fail early');
  });
});

describe('executeAgentTool public runId resume', () => {
  let tmpRoot: string;
  const AGENT_DIR_BEFORE = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-runid-'));
    // Isolate user agent discovery so local ~/.pi agents with missing skills
    // cannot poison package tool tests.
    process.env.PI_CODING_AGENT_DIR = path.join(tmpRoot, 'pi-agent');
  });
  afterEach(() => {
    if (AGENT_DIR_BEFORE !== undefined) process.env.PI_CODING_AGENT_DIR = AGENT_DIR_BEFORE;
    else delete process.env.PI_CODING_AGENT_DIR;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeStore() {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    return { store, coordinator };
  }

  function exploreAgent() {
    // Discover from tmpRoot so fingerprint matches executeAgentTool(cwd: tmpRoot)
    // under PI_CODING_AGENT_DIR isolation (no project overrides from repo cwd).
    const agents = discoverAgents(tmpRoot, 'both').agents;
    const explore = agents.find((a) => a.name === 'explore');
    if (!explore) throw new Error('builtin explore agent not found');
    return explore;
  }

  async function seedInterruptedRun(options: {
    store: ReturnType<typeof createRunStore>;
    mode?: 'single' | 'parallel' | 'chain';
    background?: boolean;
    unitStatus?: RunUnitRecord['status'];
    sessionFile?: string | null;
    /** When set, stamps the durable original-prompt establishment flag. */
    sessionPromptEstablished?: boolean;
    continuationTasks?: string[];
    request?: Partial<AgentRunRecordV1['request']>;
  }): Promise<string> {
    const agent = exploreAgent();
    const mode = options.mode ?? 'single';
    const unitStatus = options.unitStatus ?? 'interrupted';
    const sessionFile =
      options.sessionFile === null
        ? undefined
        : (options.sessionFile ?? path.join(tmpRoot, 'seed-session.jsonl'));
    if (sessionFile) writeFileSync(sessionFile, '{}\n');

    const request: AgentRunRecordV1['request'] = {
      mode,
      agentScope: 'both',
      agent: 'explore',
      task: 'Original stored task',
      ...options.request,
    };
    if (mode === 'parallel' && !request.tasks) {
      request.tasks = [{ agent: 'explore', task: 'Parallel original' }];
      delete request.agent;
      delete request.task;
    }
    if (mode === 'chain' && !request.chain) {
      request.chain = [{ agent: 'explore', task: 'Chain original' }];
      delete request.agent;
      delete request.task;
    }

    const unitId =
      mode === 'single' ? 'single' : mode === 'parallel' ? 'parallel-0001' : 'chain-0001';
    const units: Record<string, RunUnitRecord> = {
      [unitId]: {
        unitId,
        agent: agent.name,
        agentFingerprint: agentFingerprint(agent),
        runtime: undefined,
        capability: 'session',
        status: unitStatus,
        attempt: 1,
        attempts:
          unitStatus === 'queued'
            ? []
            : [
                {
                  attempt: 1,
                  status: unitStatus === 'completed' ? 'completed' : 'interrupted',
                  startedAt: Date.now() - 1000,
                },
              ],
        effectiveCwd: tmpRoot,
        ...(mode === 'parallel' ? { fanoutIndex: 0 } : {}),
        ...(mode === 'chain' ? { step: 1 } : {}),
        ...(sessionFile ? { sessionFile } : {}),
        ...(options.sessionPromptEstablished !== undefined
          ? { sessionPromptEstablished: options.sessionPromptEstablished }
          : {}),
      },
    };

    const created = await options.store.createRun({
      mode,
      agentScope: 'both',
      background: options.background ?? false,
      request,
      details: {
        mode,
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        results: [],
      },
      units,
    });
    await options.store.updateRun(created.runId, (r) => {
      r.status = unitStatus === 'completed' ? 'completed' : 'interrupted';
      if (options.continuationTasks) r.continuationTasks = [...options.continuationTasks];
    });
    return created.runId;
  }

  it('normalizes legacy full-message results on active resume and leaves read-only inspection unchanged', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const bigBody = 'L'.repeat(64 * 1024);
    const legacyResult = {
      agent: agent.name,
      agentSource: agent.source,
      task: 'Original stored task',
      exitCode: 0,
      status: 'completed',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'bash', arguments: { cmd: 'cat' } }],
        },
        {
          role: 'toolResult',
          toolCallId: 'tc',
          toolName: 'bash',
          content: [{ type: 'text', text: bigBody }],
          isError: false,
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'legacy-final' }],
        },
      ],
      stderr: '',
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 3,
        turns: 1,
      },
      finalOutput: 'legacy-final',
    };
    const created = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: agent.name,
        task: 'Original stored task',
      },
      details: {
        mode: 'single',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        results: [legacyResult as never],
      },
      units: {
        single: {
          unitId: 'single',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'interrupted',
          attempt: 1,
          attempts: [{ attempt: 1, status: 'interrupted', startedAt: Date.now() - 1000 }],
          effectiveCwd: tmpRoot,
          sessionFile: (() => {
            const sf = path.join(tmpRoot, 'legacy-session.jsonl');
            writeFileSync(sf, '{}\n');
            return sf;
          })(),
          sessionPromptEstablished: true,
          result: legacyResult as never,
        },
      },
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
    });

    // Read-only inspection must not rewrite the on-disk legacy payload.
    const before = readFileSync(path.join(store.getRunDir(created.runId), 'run.json'), 'utf8');
    const inspected = store.getRun(created.runId);
    expect(inspected.ok).toBe(true);
    const afterInspect = readFileSync(
      path.join(store.getRunDir(created.runId), 'run.json'),
      'utf8'
    );
    expect(afterInspect).toBe(before);
    expect(afterInspect).toContain(bigBody.slice(0, 64));

    const result = await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => okResult('resumed'),
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    const resultText = Array.isArray(result.content)
      ? result.content.map((c) => ('text' in c ? String(c.text) : '')).join('\n')
      : String(result.content);
    expect(resultText).not.toMatch(/resume_error|preflight_failed/);
    expect(result.isError).toBeUndefined();

    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const unitResult = loaded.loaded.record.units.single!.result!;
    expect(unitResult.messages).toEqual([]);
    expect(unitResult.finalOutput).toBe('legacy-final');
    expect(unitResult.presentation).toBeDefined();
    // Active resume post-claim write must compact the stored details/unit shells.
    // Workflow may replace details.results with its own terminal output; unit.result
    // remains the normalized legacy shell until the workflow endUnit overwrites it.
    // Either way, the raw 64 KiB tool body must not remain on disk after resume.
    const disk = readFileSync(path.join(store.getRunDir(created.runId), 'run.json'), 'utf8');
    expect(disk).not.toContain(bigBody.slice(0, 64));
    // Capture mid-resume compact state by inspecting that presentation survived normalization path.
    expect(
      unitResult.presentation?.transcript.some((i) => i.type === 'toolCall') ||
        unitResult.finalOutput === 'legacy-final'
    ).toBe(true);
  });

  it('abandons claim when post-claim setup fails so a later claim can succeed', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store });
    let failNextUpdate = true;
    let abandonCount = 0;
    let releaseCount = 0;
    const realAbandon = store.abandonRun.bind(store);
    const realRelease = store.releaseRun.bind(store);
    const realStrict = store.updateRunStrict.bind(store);
    const wrappedStore = {
      ...store,
      // Production post-claim running commit uses updateRunStrict.
      updateRunStrict: async (id: string, mutator: Parameters<typeof store.updateRunStrict>[1]) => {
        if (failNextUpdate && id === runId) {
          failNextUpdate = false;
          throw new Error('injected post-claim write failure');
        }
        return realStrict(id, mutator);
      },
      abandonRun: async (id: string, claimId: string) => {
        abandonCount += 1;
        return realAbandon(id, claimId);
      },
      releaseRun: async (id: string, claimId: string) => {
        releaseCount += 1;
        return realRelease(id, claimId);
      },
    };

    const failed = await executeAgentTool({ runId }, undefined, undefined, makeCtx(), {
      runWorkflow: async () => okResult('should-not-run'),
      runStore: wrappedStore as never,
      runCoordinator: coordinator,
    });
    expect(failed.isError).toBe(true);
    const failedText = Array.isArray(failed.content)
      ? failed.content.map((c) => ('text' in c ? String(c.text) : '')).join('\n')
      : String(failed.content);
    expect(failedText).toMatch(/resume_setup_failed|injected post-claim/i);
    expect(abandonCount).toBe(1);
    expect(releaseCount).toBe(0);

    const claimsAfterFail = store.inspectClaims(runId);
    expect(claimsAfterFail.ok).toBe(true);
    if (claimsAfterFail.ok) {
      const live = claimsAfterFail.claims.filter((c) => c.terminal === undefined && c.owner);
      expect(live).toHaveLength(0);
      const abandoned = claimsAfterFail.claims.filter((c) => c.terminal?.state === 'abandoned');
      expect(abandoned.length).toBeGreaterThanOrEqual(1);
    }

    // Later claim / resume can succeed after cleanup.
    const ok = await executeAgentTool({ runId }, undefined, undefined, makeCtx(), {
      runWorkflow: async () => okResult('recovered'),
      runStore: store,
      runCoordinator: coordinator,
    });
    expect(ok.isError).toBeUndefined();
    const okText = Array.isArray(ok.content)
      ? ok.content.map((c) => ('text' in c ? String(c.text) : '')).join('\n')
      : String(ok.content);
    expect(okText).toContain('recovered');
  });

  it('resumes by runId alone and reuses the same durable run record', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store });
    let seenParams: Record<string, unknown> | undefined;
    const result = await executeAgentTool({ runId }, undefined, undefined, makeCtx(), {
      runWorkflow: async (params) => {
        seenParams = params as Record<string, unknown>;
        return okResult('resumed');
      },
      runStore: store,
      runCoordinator: coordinator,
    });
    expect(result.isError).toBeUndefined();
    expect(seenParams?.agent).toBe('explore');
    expect(seenParams?.task).toBe('Original stored task');
    expect(seenParams?.runId).toBeUndefined();
    const runs = await store.listRuns();
    expect(runs.filter((r) => 'record' in r)).toHaveLength(1);
    expect(loadedRecordOf(runs[0]!).runId).toBe(runId);
  });

  it('appends a trimmed continuation task after a successful claim', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store });
    await executeAgentTool(
      { runId, task: '  Also verify migration.  ' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => okResult('resumed'),
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.continuationTasks).toEqual(['Also verify migration.']);
  });

  it('does not persist a continuation task when preflight fails', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({
      store,
      sessionFile: null,
    });
    const result = await executeAgentTool(
      { runId, task: 'Should not persist' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => okResult('should not run'),
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('preflight_failed');
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.continuationTasks).toBeUndefined();
    expect(loaded.loaded.record.status).toBe('interrupted');
  });

  it('does not persist a continuation task when another owner holds the claim', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store });
    const claim = await store.claimRun(runId);
    expect(claim.ok).toBe(true);
    const result = await executeAgentTool(
      { runId, task: 'Blocked by claim' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => okResult('should not run'),
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/claim_failed|run_active/);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.continuationTasks).toBeUndefined();
    if (claim.ok) await store.releaseRun(runId, claim.claimId);
  });

  it('rejects conflicting fresh-launch fields with a sorted field list', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store });
    const result = await executeAgentTool(
      { runId, agent: 'explore', model: 'gpt-5', cwd: '/tmp' },
      undefined,
      undefined,
      makeCtx(),
      { runStore: store, runCoordinator: coordinator }
    );
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('resume_error: conflicting parameters for runId:');
    expect(text).toContain('agent');
    expect(text).toContain('cwd');
    expect(text).toContain('model');
    // Sorted: agent, cwd, model
    expect(text.indexOf('agent')).toBeLessThan(text.indexOf('cwd'));
    expect(text.indexOf('cwd')).toBeLessThan(text.indexOf('model'));
  });

  it('returns run_not_found for an unknown runId', async () => {
    const { store, coordinator } = makeStore();
    const result = await executeAgentTool(
      { runId: 'run-does-not-exist' },
      undefined,
      undefined,
      makeCtx(),
      { runStore: store, runCoordinator: coordinator }
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('run_not_found');
  });

  it('resumes a completed run and reopens completed units for continuation', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store, unitStatus: 'completed' });
    let workflowRan = false;
    const result = await executeAgentTool(
      { runId, task: 'Also refine the earlier work.' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async (params) => {
          workflowRan = true;
          expect(params.task).toBe('Original stored task');
          return okResult('continued');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).not.toBe(true);
    expect(workflowRan).toBe(true);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // Resume claim transitions the run to running (or terminal after workflow).
    expect(['running', 'completed', 'failed', 'interrupted', 'cancelled']).toContain(
      loaded.loaded.record.status
    );
    expect(loaded.loaded.record.continuationTasks).toEqual(['Also refine the earlier work.']);
    const unit = loaded.loaded.record.units['single'];
    expect(unit).toBeDefined();
    // Reopened unit advanced past the original completed attempt.
    expect(unit!.attempt).toBeGreaterThanOrEqual(2);
  });

  it('clears finishedAt on disk and in-memory live record before coordinator registration', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store, unitStatus: 'completed' });
    const finishedAt = 1_700_000_000_000;
    await store.updateRun(runId, (r) => {
      r.status = 'completed';
      r.finishedAt = finishedAt;
    });
    const before = store.getRun(runId);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.loaded.record.finishedAt).toBe(finishedAt);

    const originalRegister = coordinator.registerRun.bind(coordinator);
    let registeredFinishedAt: number | undefined | 'missing' = 'missing';
    coordinator.registerRun = (id, record) => {
      if (id === runId) {
        registeredFinishedAt = record.finishedAt;
      }
      originalRegister(id, record);
    };

    const result = await executeAgentTool(
      { runId, task: 'Continue after terminal timestamp.' },
      undefined,
      undefined,
      makeCtx(),
      {
        runWorkflow: async () => {
          // Disk must already be non-terminal before workers run.
          const mid = store.getRun(runId);
          expect(mid.ok).toBe(true);
          if (mid.ok) expect(mid.loaded.record.finishedAt).toBeUndefined();
          return okResult('continued');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).not.toBe(true);
    expect(registeredFinishedAt).not.toBe('missing');
    expect(registeredFinishedAt).toBeUndefined();
  });

  it('rejects resuming a completed run without a continuation task', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store, unitStatus: 'completed' });
    let workflowRan = false;
    const result = await executeAgentTool({ runId }, undefined, undefined, makeCtx(), {
      runWorkflow: async () => {
        workflowRan = true;
        return okResult('should not run');
      },
      runStore: store,
      runCoordinator: coordinator,
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      'completed_without_continuation'
    );
    expect(workflowRan).toBe(false);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.status).toBe('completed');
    expect(loaded.loaded.record.continuationTasks).toBeUndefined();
    const unit = loaded.loaded.record.units['single'];
    expect(unit?.status).toBe('completed');
  });

  it('restores parallel mode and original background delivery from the stored run', async () => {
    const { store, coordinator } = makeStore();
    const { manager, launches, runs } = fakeManager();
    const runId = await seedInterruptedRun({
      store,
      mode: 'parallel',
      background: true,
      request: {
        mode: 'parallel',
        agentScope: 'both',
        tasks: [{ agent: 'explore', task: 'Inspect parallel' }],
      },
    });
    await executeAgentTool({ runId }, undefined, undefined, makeCtx(), {
      backgroundManager: manager,
      runWorkflow: async (params) => {
        expect(params.tasks?.[0]?.task).toBe('Inspect parallel');
        expect(params.runInBackground).toBe(true);
        return okResult('bg resumed');
      },
      runStore: store,
      runCoordinator: coordinator,
    });
    await Promise.allSettled(runs);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.mode).toBe('parallel');
    const list = await store.listRuns();
    expect(list.filter((r) => 'record' in r)).toHaveLength(1);
  });

  it('restores chain mode from the stored request', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({
      store,
      mode: 'chain',
      request: {
        mode: 'chain',
        agentScope: 'both',
        chain: [{ agent: 'explore', task: 'Chain step one' }],
      },
    });
    let modeSeen: string | undefined;
    await executeAgentTool({ runId }, undefined, undefined, makeCtx(), {
      runWorkflow: async (params, _s, _u, _c, _a, makeDetails) => {
        modeSeen = params.chain ? 'chain' : 'other';
        return {
          content: [{ type: 'text', text: 'chain resumed' }],
          details: makeDetails('chain')([]),
        };
      },
      runStore: store,
      runCoordinator: coordinator,
    });
    expect(modeSeen).toBe('chain');
  });

  it('resumes chain when details.chain presentation is absent using frozen fanout mapping', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const items = ['a'];
    const unitIds = ['chain-0002-fanout-0001'];
    const sessionDir = path.join(tmpRoot, 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    const seedSession = path.join(sessionDir, 'chain-0001.jsonl');
    const childSession = path.join(sessionDir, `${unitIds[0]}.jsonl`);
    writeFileSync(seedSession, '{}\n');
    writeFileSync(childSession, '{}\n');

    const created = await store.createRun({
      mode: 'chain',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'chain',
        agentScope: 'both',
        chain: [
          { agent: 'explore', task: 'seed' },
          {
            expand: { from: { output: 'seed', path: '/items' } },
            parallel: { agent: 'explore', task: 'Process {item}' },
            collect: { name: 'out' },
          },
        ],
      },
      // No details.chain presentation metadata — restore must use request topology.
      details: {
        mode: 'chain',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        results: [],
      },
      units: {
        'chain-0001': {
          unitId: 'chain-0001',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          step: 1,
          attempt: 1,
          attempts: [{ attempt: 1, status: 'completed', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          sessionFile: seedSession,
          sessionPromptEstablished: true,
        },
        [unitIds[0]!]: {
          unitId: unitIds[0]!,
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'interrupted',
          step: 2,
          fanoutIndex: 0,
          attempt: 1,
          attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          sessionFile: childSession,
          sessionPromptEstablished: true,
        },
      },
      // workflowState is attached after create via updateRun.
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
      r.workflowState = {
        fanouts: {
          'chain-0002-fanout': { step: 2, items, unitIds },
        },
      };
    });

    let workflowRan = false;
    const result = await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runWorkflow: async (params) => {
          workflowRan = true;
          expect(params.chain).toHaveLength(2);
          return okResult('restored without presentation');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).not.toBe(true);
    expect(workflowRan).toBe(true);
    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // Presentation still absent; durable mapping retained.
    expect(loaded.loaded.record.details.chain).toBeUndefined();
    expect(loaded.loaded.record.workflowState?.fanouts?.['chain-0002-fanout']).toEqual({
      step: 2,
      items,
      unitIds,
    });
  });

  it('selective chain resume with absent details.chain skips completed seed and runs later step', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const sessionDir = path.join(tmpRoot, 'sessions-selective-chain');
    mkdirSync(sessionDir, { recursive: true });
    const seedSession = path.join(sessionDir, 'chain-0001.jsonl');
    const finishSession = path.join(sessionDir, 'chain-0002.jsonl');
    writeFileSync(seedSession, '{}\n');
    writeFileSync(finishSession, '{}\n');

    const seedOutput = 'seed-done';
    const created = await store.createRun({
      mode: 'chain',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'chain',
        agentScope: 'both',
        chain: [
          { agent: 'explore', task: 'seed work', name: 'seed' },
          { agent: 'explore', task: 'finish {previous}' },
        ],
      },
      // No details.chain — restore must derive completed seed from durable units.
      details: {
        mode: 'chain',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        results: [
          {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'seed work',
            exitCode: 0,
            status: 'completed',
            messages: [
              {
                role: 'assistant',
                content: [{ type: 'text', text: seedOutput }],
              } as never,
            ],
            stderr: '',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
            step: 1,
            finalOutput: seedOutput,
          },
        ],
        outputs: {
          seed: {
            text: seedOutput,
            agent: 'explore',
            step: 1,
          },
        },
      },
      units: {
        'chain-0001': {
          unitId: 'chain-0001',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          step: 1,
          attempt: 1,
          attempts: [{ attempt: 1, status: 'completed', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          sessionFile: seedSession,
          sessionPromptEstablished: true,
          result: {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'seed work',
            exitCode: 0,
            status: 'completed',
            messages: [],
            stderr: '',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
            step: 1,
            finalOutput: seedOutput,
          },
        },
        'chain-0002': {
          unitId: 'chain-0002',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'interrupted',
          step: 2,
          attempt: 1,
          attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          sessionFile: finishSession,
          sessionPromptEstablished: true,
        },
      },
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
    });

    const dispatchedUnitIds: string[] = [];
    const result = await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        // Real chain path (no runWorkflow seam) so skip-completed is exercised.
        runStore: store,
        runCoordinator: coordinator,
        spawnFn: ((_cmd: string, args: string[]) => {
          // Session path appears in args; extract unit id from planned session file name.
          const sessionArg = args.find((a) => a.includes('chain-'));
          if (sessionArg) {
            const match = /chain-\d+/.exec(sessionArg);
            if (match) dispatchedUnitIds.push(match[0]!);
          } else {
            dispatchedUnitIds.push('unknown');
          }
          const EventEmitter = require('node:events').EventEmitter;
          const { Readable, Writable } = require('node:stream');
          const child = new (class extends EventEmitter {
            stdout = new Readable({ read() {} });
            stderr = new Readable({ read() {} });
            stdin = new Writable({ write: (_c: unknown, _e: unknown, cb: () => void) => cb() });
            kill() {
              this.stdout.push(null);
              this.stderr.push(null);
              setImmediate(() => this.emit('close', 0));
              return true;
            }
          })();
          setImmediate(() => {
            child.stdout.push(
              `${JSON.stringify({
                type: 'message_end',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: withExploreCompletion('finish-out') }],
                  usage: { input: 1, output: 1, totalTokens: 2 },
                },
              })}\n`
            );
            child.kill();
          });
          return child;
        }) as unknown as import('../../src/execution/execution.ts').SpawnFn,
      }
    );
    expect(result.isError).not.toBe(true);
    // Completed seed must not be redispatched; only the incomplete later step runs.
    expect(dispatchedUnitIds.every((id) => id !== 'chain-0001')).toBe(true);
    expect(dispatchedUnitIds.some((id) => id === 'chain-0002' || id === 'unknown')).toBe(true);
    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units['chain-0001']!.status).toBe('completed');
    expect(loaded.loaded.record.units['chain-0001']!.attempt).toBe(1);
  });

  it('treats an absent continuationTasks history as empty on resume', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store });
    const loadedBefore = store.getRun(runId);
    expect(loadedBefore.ok).toBe(true);
    if (loadedBefore.ok) expect(loadedBefore.loaded.record.continuationTasks).toBeUndefined();

    await executeAgentTool({ runId }, undefined, undefined, makeCtx(), {
      runWorkflow: async () => okResult('resumed'),
      runStore: store,
      runCoordinator: coordinator,
    });
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // No new task appended; field stays absent or empty.
    expect(loaded.loaded.record.continuationTasks ?? []).toEqual([]);
  });

  it('rejects a blank runId', async () => {
    const { store, coordinator } = makeStore();
    const blank = await executeAgentTool({ runId: '   ' }, undefined, undefined, makeCtx(), {
      runStore: store,
      runCoordinator: coordinator,
    });
    expect(blank.isError).toBe(true);
    expect((blank.content[0] as { text: string }).text).toContain('runId must be a non-empty');
  });

  it('marks continuation delivery after spawn and redelivers only undelivered on next resume', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store });
    const EventEmitter = (await import('node:events')).EventEmitter;
    const { Readable } = await import('node:stream');

    class FakeChild extends EventEmitter {
      stdout = new Readable({ read() {} });
      stderr = new Readable({ read() {} });
      kill() {
        this.stdout.push(null);
        this.stderr.push(null);
        setImmediate(() => this.emit('close', 0));
        return true;
      }
    }

    let lastPrompt = '';
    const spawnFn = ((_cmd: string, args: string[]) => {
      lastPrompt = args[args.length - 1] ?? '';
      const fake = new FakeChild();
      setImmediate(() => {
        fake.stdout.push(
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'done' }],
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          }) + '\n'
        );
        fake.kill();
      });
      return fake as never;
    }) as unknown as import('../../src/execution/execution.ts').SpawnFn;

    // First resume with a continuation: orchestration path (no runWorkflow seam).
    await executeAgentTool(
      { runId, task: 'First continuation' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      { runStore: store, runCoordinator: coordinator, spawnFn }
    );
    expect(lastPrompt).toContain('resuming');
    expect(lastPrompt).toContain('First continuation');
    expect(lastPrompt).not.toContain('Task: Original stored task');

    const afterFirst = store.getRun(runId);
    expect(afterFirst.ok).toBe(true);
    if (!afterFirst.ok) return;
    expect(afterFirst.loaded.record.continuationTasks).toEqual(['First continuation']);
    const unitId = Object.keys(afterFirst.loaded.record.units)[0]!;
    expect(afterFirst.loaded.record.continuationDelivery?.[unitId]?.deliveredCount).toBe(1);

    // Re-interrupt for a second resume.
    await store.updateRun(runId, (r) => {
      r.status = 'interrupted';
      for (const u of Object.values(r.units)) {
        u.status = 'interrupted';
      }
    });

    await executeAgentTool(
      { runId, task: 'Second continuation' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      { runStore: store, runCoordinator: coordinator, spawnFn }
    );
    // Existing session already delivered the first; only second is new.
    expect(lastPrompt).toContain('Second continuation');
    expect(lastPrompt).not.toContain('First continuation');
    expect(lastPrompt).not.toContain('Task: Original stored task');

    const afterSecond = store.getRun(runId);
    expect(afterSecond.ok).toBe(true);
    if (!afterSecond.ok) return;
    expect(afterSecond.loaded.record.continuationTasks).toEqual([
      'First continuation',
      'Second continuation',
    ]);
    expect(afterSecond.loaded.record.continuationDelivery?.[unitId]?.deliveredCount).toBe(2);
  });

  it('never-started queued unit receives original task plus all continuations via orchestration', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({
      store,
      unitStatus: 'queued',
      sessionFile: null,
      continuationTasks: ['Prior undelivered'],
    });
    const EventEmitter = (await import('node:events')).EventEmitter;
    const { Readable } = await import('node:stream');
    class FakeChild extends EventEmitter {
      stdout = new Readable({ read() {} });
      stderr = new Readable({ read() {} });
      kill() {
        this.stdout.push(null);
        this.stderr.push(null);
        setImmediate(() => this.emit('close', 0));
        return true;
      }
    }
    let lastPrompt = '';
    const spawnFn = ((_cmd: string, args: string[]) => {
      lastPrompt = args[args.length - 1] ?? '';
      const fake = new FakeChild();
      setImmediate(() => {
        fake.stdout.push(
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'ok' }],
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          }) + '\n'
        );
        fake.kill();
      });
      return fake as never;
    }) as unknown as import('../../src/execution/execution.ts').SpawnFn;

    await executeAgentTool(
      { runId, task: 'New continuation' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      { runStore: store, runCoordinator: coordinator, spawnFn }
    );
    expect(lastPrompt).toContain('Task: Original stored task');
    expect(lastPrompt).toContain('Prior undelivered');
    expect(lastPrompt).toContain('New continuation');
  });

  it('skips completed parallel units by unit.status even when details.results lag', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const sessionA = path.join(tmpRoot, 'a.jsonl');
    const sessionB = path.join(tmpRoot, 'b.jsonl');
    writeFileSync(sessionA, '{}\n');
    writeFileSync(sessionB, '{}\n');
    const created = await store.createRun({
      mode: 'parallel',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'parallel',
        agentScope: 'both',
        tasks: [
          { agent: 'explore', task: 'Task A' },
          { agent: 'explore', task: 'Task B' },
        ],
      },
      details: {
        mode: 'parallel',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        // Lagging/inconsistent: both slots look incomplete in details.
        results: [],
      },
      units: {
        'parallel-0001': {
          unitId: 'parallel-0001',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          fanoutIndex: 0,
          attempt: 1,
          attempts: [{ attempt: 1, status: 'completed', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          sessionFile: sessionA,
          result: {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'Task A',
            exitCode: 0,
            status: 'completed',
            messages: [],
            stderr: '',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
          },
        },
        'parallel-0002': {
          unitId: 'parallel-0002',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'interrupted',
          fanoutIndex: 1,
          attempt: 1,
          attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          sessionFile: sessionB,
        },
      },
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
    });

    const dispatched: string[] = [];
    await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        // Real orchestration path (no runWorkflow seam) so parallel skip runs.
        runStore: store,
        runCoordinator: coordinator,
        spawnFn: ((_cmd: string, args: string[]) => {
          const prompt = args[args.length - 1] ?? '';
          dispatched.push(prompt);
          const EventEmitter = require('node:events').EventEmitter;
          const { Readable } = require('node:stream');
          const fake = new (class extends EventEmitter {
            stdout = new Readable({ read() {} });
            stderr = new Readable({ read() {} });
            kill() {
              this.stdout.push(null);
              this.stderr.push(null);
              setImmediate(() => this.emit('close', 0));
              return true;
            }
          })();
          setImmediate(() => {
            fake.stdout.push(
              JSON.stringify({
                type: 'message_end',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'b done' }],
                  usage: { input: 1, output: 1, totalTokens: 2 },
                },
              }) + '\n'
            );
            fake.kill();
          });
          return fake;
        }) as unknown as import('../../src/execution/execution.ts').SpawnFn,
      }
    );
    // Only incomplete unit B should spawn (one prompt).
    expect(dispatched.length).toBe(1);
    expect(dispatched[0]).toContain('resuming');
  });

  it('uses persisted effectiveCwd for discovery and child cwd across different ctx.cwd', async () => {
    const { store, coordinator } = makeStore();
    const projectDir = path.join(tmpRoot, 'original-project');
    mkdirSync(projectDir, { recursive: true });
    const runId = await seedInterruptedRun({
      store,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'Original stored task',
        cwd: projectDir,
      },
    });
    // Point unit effectiveCwd at the original project.
    await store.updateRun(runId, (r) => {
      for (const u of Object.values(r.units)) {
        u.effectiveCwd = projectDir;
      }
    });

    let childCwd: string | undefined;
    const EventEmitter = (await import('node:events')).EventEmitter;
    const { Readable } = await import('node:stream');
    class FakeChild extends EventEmitter {
      stdout = new Readable({ read() {} });
      stderr = new Readable({ read() {} });
      kill() {
        this.stdout.push(null);
        this.stderr.push(null);
        setImmediate(() => this.emit('close', 0));
        return true;
      }
    }
    const spawnFn = ((_cmd: string, _args: string[], opts: { cwd?: string }) => {
      childCwd = opts.cwd;
      const fake = new FakeChild();
      setImmediate(() => {
        fake.stdout.push(
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'ok' }],
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          }) + '\n'
        );
        fake.kill();
      });
      return fake as never;
    }) as unknown as import('../../src/execution/execution.ts').SpawnFn;

    await executeAgentTool(
      { runId },
      undefined,
      undefined,
      makeCtx({ cwd: '/tmp/different-session-cwd' }),
      {
        runStore: store,
        runCoordinator: coordinator,
        spawnFn,
      }
    );
    expect(childCwd).toBe(projectDir);
  });

  it('abandons claim when post-claim preflight fails (cross-store race corrupts unit cwd)', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({ store });
    // Second store instance over the same root simulates a concurrent writer.
    const store2 = createRunStore({ rootDir: tmpRoot });
    const originalClaim = store.claimRun.bind(store);
    store.claimRun = async (id: string) => {
      const claim = await originalClaim(id);
      if (claim.ok) {
        // Another process corrupts the unit after we hold the claim.
        await store2.updateRun(id, (r) => {
          for (const u of Object.values(r.units)) {
            u.effectiveCwd = path.join(tmpRoot, 'missing-cwd-after-race');
          }
        });
      }
      return claim;
    };

    const result = await executeAgentTool({ runId }, undefined, undefined, makeCtx(), {
      runWorkflow: async () => okResult('should not run'),
      runStore: store,
      runCoordinator: coordinator,
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/preflight_failed/);
    // Claim must be released (no live owner).
    const claims = store.inspectClaims(runId);
    expect(claims.ok).toBe(true);
    if (claims.ok) {
      const live = claims.claims.filter((c) => c.terminal === undefined && c.owner);
      expect(live).toHaveLength(0);
    }
  });

  it('keeps continuation undelivered when background mode rejects after claim', async () => {
    const { store, coordinator } = makeStore();
    const runId = await seedInterruptedRun({
      store,
      background: true,
    });
    const result = await executeAgentTool(
      { runId, task: 'Should stay pending' },
      undefined,
      undefined,
      makeCtx({ mode: 'json' }),
      {
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBe(true);
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // Continuation was claimed into history...
    expect(loaded.loaded.record.continuationTasks).toEqual(['Should stay pending']);
    // ...but no unit marked delivery (spawn never ran).
    expect(loaded.loaded.record.continuationDelivery ?? {}).toEqual({});
  });

  it('mixed parallel Pi completed + Pi incomplete blocks on missing session', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const sessionA = path.join(tmpRoot, 'pi.jsonl');
    writeFileSync(sessionA, '{}\n');
    const created = await store.createRun({
      mode: 'parallel',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'parallel',
        agentScope: 'both',
        tasks: [
          { agent: 'explore', task: 'Pi task' },
          { agent: 'explore', task: 'Incomplete Pi task' },
        ],
      },
      details: {
        mode: 'parallel',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        // Inconsistent: details says both completed, units disagree for the second Pi unit.
        results: [
          {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'Pi task',
            exitCode: 0,
            status: 'completed',
            messages: [],
            stderr: '',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
          },
          {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'Incomplete Pi task',
            exitCode: 0,
            status: 'completed',
            messages: [],
            stderr: '',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
          },
        ],
      },
      units: {
        'parallel-0001': {
          unitId: 'parallel-0001',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          fanoutIndex: 0,
          attempt: 1,
          attempts: [{ attempt: 1, status: 'completed', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          sessionFile: sessionA,
          result: {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'Pi task',
            exitCode: 0,
            status: 'completed',
            messages: [],
            stderr: '',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
          },
        },
        'parallel-0002': {
          unitId: 'parallel-0002',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'interrupted',
          fanoutIndex: 1,
          attempt: 1,
          attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
        },
      },
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
    });

    const blocked = await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      { runStore: store, runCoordinator: coordinator }
    );
    expect(blocked.isError).toBe(true);
    expect((blocked.content[0] as { text: string }).text).toContain('session file unavailable');
  });

  it('blocks resume when a skipped attempted unit is missing its session artifact', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const created = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'Skipped after attempt',
      },
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
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'skipped',
          attempt: 1,
          attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          sessionFile: path.join(tmpRoot, 'skipped-missing-session.jsonl'),
        },
      },
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
    });

    const blocked = await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runWorkflow: async () => okResult('should not run'),
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(blocked.isError).toBe(true);
    expect((blocked.content[0] as { text: string }).text).toMatch(
      /session file missing|session file unavailable|preflight_failed/
    );
    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single!.status).toBe('skipped');
    expect(loaded.loaded.record.units.single!.attempt).toBe(1);
  });

  it('selectively resumes a never-started skipped unit without reopening completed siblings', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const completedSession = path.join(tmpRoot, 'completed-sibling.jsonl');
    writeFileSync(completedSession, '{}\n');
    const created = await store.createRun({
      mode: 'parallel',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'parallel',
        agentScope: 'both',
        tasks: [
          { agent: 'explore', task: 'Completed sibling' },
          { agent: 'explore', task: 'Never-started skipped' },
        ],
      },
      details: {
        mode: 'parallel',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        results: [
          {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'Completed sibling',
            exitCode: 0,
            status: 'completed',
            messages: [],
            stderr: '',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
          },
        ],
      },
      units: {
        'parallel-0001': {
          unitId: 'parallel-0001',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'completed',
          fanoutIndex: 0,
          attempt: 1,
          attempts: [{ attempt: 1, status: 'completed', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          sessionFile: completedSession,
          result: {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'Completed sibling',
            exitCode: 0,
            status: 'completed',
            messages: [],
            stderr: '',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
          },
        },
        'parallel-0002': {
          unitId: 'parallel-0002',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: undefined,
          capability: 'session',
          status: 'skipped',
          fanoutIndex: 1,
          attempt: 1,
          attempts: [],
          effectiveCwd: tmpRoot,
        },
      },
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
    });

    let workflowRan = false;
    const result = await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runWorkflow: async () => {
          workflowRan = true;
          return okResult('skipped resumed');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).not.toBe(true);
    expect(workflowRan).toBe(true);
    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const completed = loaded.loaded.record.units['parallel-0001']!;
    const skipped = loaded.loaded.record.units['parallel-0002']!;
    // Completed sibling must stay completed (not bulk-reopened).
    expect(completed.status).toBe('completed');
    expect(completed.attempt).toBe(1);
    // Never-started skipped unit was queued without inflating attempt.
    expect(skipped.attempt).toBe(1);
    expect(skipped.attempts).toHaveLength(0);
  });

  it('single queued Grok ACP resumes with session capability', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const created = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'Legacy ACP queued',
        runtime: 'grok-acp',
      },
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
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'queued',
          attempt: 1,
          attempts: [],
          effectiveCwd: tmpRoot,
          result: {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'Legacy ACP queued',
            exitCode: -1,
            status: 'queued',
            messages: [],
            stderr: '',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
            resumeCapability: 'session',
          },
        },
      },
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
    });

    let invoked = false;
    const result = await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runWorkflow: async () => {
          invoked = true;
          const mid = store.getRun(created.runId);
          expect(mid.ok).toBe(true);
          if (mid.ok) {
            expect(mid.loaded.record.units.single.capability).toBe('session');
            expect(mid.loaded.record.units.single.result?.resumeCapability).toBe('session');
          }
          return okResult('acp queued ok');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBeUndefined();
    expect(invoked).toBe(true);
    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.capability).toBe('session');
  });

  it('parallel queued Grok ACP dispatches with session capability', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const created = await store.createRun({
      mode: 'parallel',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'parallel',
        agentScope: 'both',
        tasks: [
          { agent: 'explore', task: 'Legacy ACP A' },
          { agent: 'explore', task: 'Legacy ACP B' },
        ],
        runtime: 'grok-acp',
      },
      details: {
        mode: 'parallel',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        results: [],
      },
      units: {
        'parallel-0001': {
          unitId: 'parallel-0001',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'queued',
          fanoutIndex: 0,
          attempt: 1,
          attempts: [],
          effectiveCwd: tmpRoot,
        },
        'parallel-0002': {
          unitId: 'parallel-0002',
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'queued',
          fanoutIndex: 1,
          attempt: 1,
          attempts: [],
          effectiveCwd: tmpRoot,
        },
      },
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
    });

    let spawnCount = 0;
    await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runStore: store,
        runCoordinator: coordinator,
        // Grok ACP may still fail client-side; assert dispatch reached the ACP client.
        spawnFn: fakeGrokSpawn(() => spawnCount++, false),
      }
    );
    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units['parallel-0001']!.capability).toBe('session');
    expect(loaded.loaded.record.units['parallel-0002']!.capability).toBe('session');
    // Spawn attempted; the client may still error without a real ACP process.
    expect(spawnCount).toBeGreaterThanOrEqual(1);
  });

  it('attempted Grok ACP with acpSessionId resumes as canonical session', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const created = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'Legacy ACP attempted',
        runtime: 'grok-acp',
      },
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
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'interrupted',
          attempt: 1,
          attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
          acpSessionId: 'sess-legacy-id',
          result: {
            agent: 'explore',
            agentSource: 'builtin',
            task: 'Legacy ACP attempted',
            exitCode: 1,
            status: 'interrupted',
            messages: [],
            stderr: '',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              contextTokens: 0,
              turns: 0,
            },
            resumeCapability: 'session',
            acpSessionId: 'sess-legacy-id',
          },
        },
      },
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
    });

    let seenCapability: string | undefined;
    const result = await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runWorkflow: async () => {
          const mid = store.getRun(created.runId);
          if (mid.ok) {
            seenCapability = mid.loaded.record.units.single.capability;
            expect(mid.loaded.record.units.single.acpSessionId).toBe('sess-legacy-id');
            expect(mid.loaded.record.units.single.result?.resumeCapability).toBe('session');
          }
          return okResult('acp load ok');
        },
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBeUndefined();
    expect(seenCapability).toBe('session');
    // Canonical session without calling persistAcpSessionId on this path.
    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.units.single.capability).toBe('session');
    expect(loaded.loaded.record.units.single.acpSessionId).toBe('sess-legacy-id');
  });

  it('attempted Grok ACP without acpSessionId stays unavailable', async () => {
    const { store, coordinator } = makeStore();
    const agent = exploreAgent();
    const created = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: {
        mode: 'single',
        agentScope: 'both',
        agent: 'explore',
        task: 'Legacy ACP missing id',
        runtime: 'grok-acp',
      },
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
          agent: agent.name,
          agentFingerprint: agentFingerprint(agent),
          runtime: 'grok-acp',
          capability: 'session',
          status: 'interrupted',
          attempt: 1,
          attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
          effectiveCwd: tmpRoot,
        },
      },
    });
    await store.updateRun(created.runId, (r) => {
      r.status = 'interrupted';
    });

    const result = await executeAgentTool(
      { runId: created.runId },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runWorkflow: async () => okResult('should not run'),
        runStore: store,
        runCoordinator: coordinator,
      }
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('acp_session_unavailable');
    const loaded = store.getRun(created.runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    // Preflight blocked before claim write — unit is unchanged.
    expect(loaded.loaded.record.units.single.capability).toBe('session');
    expect(loaded.loaded.record.units.single.acpSessionId).toBeUndefined();
  });

  it('worktree strict stamp failure cleans resources, fails unit, leaves no uncommitted session path', async () => {
    const { spawnSync } = await import('node:child_process');
    const gitOk = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
    if (!gitOk) return;

    const repo = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-stamp-fail-wt-'));
    try {
      spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'user.email', 'pi@test.example'], {
        encoding: 'utf-8',
      });
      spawnSync('git', ['-C', repo, 'config', 'user.name', 'Pi Test'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'], { encoding: 'utf-8' });
      writeFileSync(path.join(repo, 'README.md'), '# tmp\n');
      spawnSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { encoding: 'utf-8' });

      const store = createRunStore({ rootDir: path.join(repo, '.pi-runs') });
      const coordinator = createRunCoordinator({ store });
      let stampCalls = 0;
      const origStamp = coordinator.persistSessionFile.bind(coordinator);
      coordinator.persistSessionFile = async (input) => {
        stampCalls++;
        void origStamp;
        throw new Error(
          `session_file_conflict: unit ${input.unitId} already has sessionFile /other.jsonl, refusing ${input.sessionFile}`
        );
      };

      let spawnCount = 0;
      const result = await executeAgentTool(
        {
          agent: 'explore',
          task: 'stamp should fail',
          isolation: 'worktree',
        },
        undefined,
        undefined,
        makeCtx({ cwd: repo }),
        {
          runStore: store,
          runCoordinator: coordinator,
          spawnFn: ((_cmd: string) => {
            spawnCount++;
            throw new Error('spawn must not run after stamp failure');
          }) as unknown as import('../../src/execution/execution.ts').SpawnFn,
        }
      );

      expect(result.isError).toBe(true);
      expect(stampCalls).toBeGreaterThanOrEqual(1);
      expect(spawnCount).toBe(0);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toMatch(/session_file_conflict|context_error|Agent failed/);

      const runs = await store.listRuns();
      expect(runs.length).toBe(1);
      const rec = loadedRecordOf(runs[0]!);
      const unit = rec.units.single ?? Object.values(rec.units)[0]!;
      expect(unit.status).toBe('failed');
      expect(unit.sessionFile).toBeUndefined();
      expect(unit.result?.sessionFile).toBeUndefined();

      // New worktree cleaned up on pre-execution stamp failure after beginUnit.
      // Must clear durable unit path so resume cannot block on a missing tree.
      const wtRoot = path.join(repo, '.worktrees');
      if (existsSync(wtRoot)) {
        expect(readdirSync(wtRoot).length).toBe(0);
      }
      expect(unit.worktreePath).toBeUndefined();
      expect(unit.result?.worktreePath).toBeUndefined();
      expect(unit.result?.worktreeDirty).toBeUndefined();
      expect(unit.result?.worktreeChangedFiles).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('registerInitial failure retains dirty stored worktree and durable path diagnostic', async () => {
    const { spawnSync } = await import('node:child_process');
    const gitOk = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
    if (!gitOk) return;

    const repo = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-dirty-wt-resume-'));
    try {
      spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'user.email', 'pi@test.example'], {
        encoding: 'utf-8',
      });
      spawnSync('git', ['-C', repo, 'config', 'user.name', 'Pi Test'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'], { encoding: 'utf-8' });
      writeFileSync(path.join(repo, 'README.md'), '# tmp\n');
      spawnSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { encoding: 'utf-8' });

      // Create a real dirty worktree under the repo.
      const wtPath = path.join(repo, '.worktrees', 'resume-dirty');
      mkdirSync(path.dirname(wtPath), { recursive: true });
      const add = spawnSync('git', ['-C', repo, 'worktree', 'add', '--detach', wtPath, 'HEAD'], {
        encoding: 'utf-8',
      });
      expect(add.status).toBe(0);
      const dirtyFile = path.join(wtPath, 'dirty-marker.txt');
      writeFileSync(dirtyFile, 'keep me\n');

      const agent = exploreAgent();
      const sessionFile = path.join(repo, 'seed-session.jsonl');
      writeFileSync(sessionFile, '{}\n');
      const store = createRunStore({ rootDir: path.join(repo, '.pi-runs') });
      const coordinator = createRunCoordinator({ store });
      const created = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'single',
          agentScope: 'both',
          agent: 'explore',
          task: 'Resume with dirty worktree',
          isolation: 'worktree',
        },
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
            agent: agent.name,
            agentFingerprint: agentFingerprint(agent),
            runtime: undefined,
            capability: 'session',
            status: 'interrupted',
            attempt: 1,
            attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
            effectiveCwd: wtPath,
            worktreePath: wtPath,
            sessionFile,
          },
        },
      });
      await store.updateRun(created.runId, (r) => {
        r.status = 'interrupted';
      });

      const interactiveRegistry = {
        registerInitial: async () => {
          throw Object.assign(new Error('forced registerInitial failure'), {
            code: 'validation_error',
          });
        },
      } as unknown as import('../../src/interactive/interactive-agent.ts').InteractiveAgentRegistry;

      let spawnCount = 0;
      const result = await executeAgentTool(
        { runId: created.runId },
        undefined,
        undefined,
        makeCtx({
          cwd: repo,
          mode: 'tui',
          sessionManager: {
            getSessionId: () => 'host-session',
            getBranch: () => [],
            getSessionFile: () => undefined,
            getLeafId: () => undefined,
          },
        } as never),
        {
          runStore: store,
          runCoordinator: coordinator,
          interactiveRegistry,
          spawnFn: ((_cmd: string) => {
            spawnCount++;
            throw new Error('spawn must not run after registerInitial failure');
          }) as unknown as import('../../src/execution/execution.ts').SpawnFn,
        }
      );

      expect(result.isError).toBe(true);
      expect(spawnCount).toBe(0);
      // Dirty stored worktree must remain on disk with modifications intact.
      expect(existsSync(wtPath)).toBe(true);
      expect(existsSync(dirtyFile)).toBe(true);
      expect(readdirSync(path.join(repo, '.worktrees'))).toContain('resume-dirty');

      const loaded = store.getRun(created.runId);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      const unit = loaded.loaded.record.units.single!;
      expect(unit.status).toBe('failed');
      expect(unit.worktreePath).toBe(wtPath);
      expect(unit.result?.worktreePath).toBe(wtPath);
      expect(unit.result?.worktreeDirty).toBe(true);
      expect(unit.result?.errorMessage ?? unit.result?.stderr ?? '').toMatch(
        /Interactive link registration failed|validation_error/
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('never-started with planned sessionFile path sends original task (not continuation-only)', async () => {
    const { store, coordinator } = makeStore();
    const planned = path.join(tmpRoot, 'planned-crash-window.jsonl');
    // Path is recorded on the durable unit but the native file was never created
    // (stamp-before-begin crash window from older ordering).
    const runId = await seedInterruptedRun({
      store,
      unitStatus: 'queued',
      sessionFile: planned,
      continuationTasks: ['Prior undelivered'],
    });
    // Ensure the planned path is absent so resume must not treat it as established.
    if (existsSync(planned)) rmSync(planned);

    const EventEmitter = (await import('node:events')).EventEmitter;
    const { Readable } = await import('node:stream');
    class FakeChild extends EventEmitter {
      stdout = new Readable({ read() {} });
      stderr = new Readable({ read() {} });
      kill() {
        this.stdout.push(null);
        this.stderr.push(null);
        setImmediate(() => this.emit('close', 0));
        return true;
      }
    }
    let lastPrompt = '';
    const spawnFn = ((_cmd: string, args: string[]) => {
      lastPrompt = args[args.length - 1] ?? '';
      const fake = new FakeChild();
      setImmediate(() => {
        fake.stdout.push(
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: withExploreCompletion('ok') }],
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          }) + '\n'
        );
        fake.kill();
      });
      return fake as never;
    }) as unknown as import('../../src/execution/execution.ts').SpawnFn;

    const result = await executeAgentTool(
      { runId, task: 'New continuation' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      { runStore: store, runCoordinator: coordinator, spawnFn }
    );
    expect(result.isError).toBeUndefined();
    // Original task must be delivered; must not send continuation-only resume text.
    expect(lastPrompt).toContain('Task: Original stored task');
    expect(lastPrompt).toContain('Prior undelivered');
    expect(lastPrompt).toContain('New continuation');
    expect(lastPrompt).not.toMatch(/continuing from a previous interruption/i);
  });

  it('attempted Pi with planned missing sessionFile fail-closes without replaying original task', async () => {
    const { store, coordinator } = makeStore();
    const planned = path.join(tmpRoot, 'attempted-planned-missing.jsonl');
    const runId = await seedInterruptedRun({
      store,
      unitStatus: 'interrupted',
      sessionFile: planned,
      continuationTasks: ['Do not deliver this'],
    });
    if (existsSync(planned)) rmSync(planned);

    let spawnCount = 0;
    const result = await executeAgentTool(
      { runId, task: 'Should not run' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runStore: store,
        runCoordinator: coordinator,
        spawnFn: ((_cmd: string) => {
          spawnCount++;
          throw new Error('spawn must not run when session file is missing');
        }) as unknown as import('../../src/execution/execution.ts').SpawnFn,
      }
    );
    expect(result.isError).toBe(true);
    expect(spawnCount).toBe(0);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/session file missing|preflight_failed|session_unavailable/);
    // Durable unit remains unrecovered — no original-task replay side effects.
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.status).toBe('interrupted');
    expect(loaded.loaded.record.units.single!.attempts.length).toBe(1);
  });

  it('attempted Pi with sessionFile but unestablished original prompt fail-closes (fork crash window)', async () => {
    const { store, coordinator } = makeStore();
    // Fork-like: session file exists on disk (branched parent history) but the
    // unit's original prompt was never accepted after begin+stamp.
    const forkSession = path.join(tmpRoot, 'fork-existing.jsonl');
    writeFileSync(
      forkSession,
      `${JSON.stringify({ type: 'session', version: 1 })}\n${JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'parent history only' }] },
      })}\n`
    );
    const runId = await seedInterruptedRun({
      store,
      unitStatus: 'interrupted',
      sessionFile: forkSession,
      sessionPromptEstablished: false,
      continuationTasks: ['Must not deliver as continuation-only'],
    });

    let spawnCount = 0;
    const result = await executeAgentTool(
      { runId, task: 'Must not run' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runStore: store,
        runCoordinator: coordinator,
        spawnFn: ((_cmd: string) => {
          spawnCount++;
          throw new Error('spawn must not run when original prompt is unestablished');
        }) as unknown as import('../../src/execution/execution.ts').SpawnFn,
      }
    );
    expect(result.isError).toBe(true);
    expect(spawnCount).toBe(0);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(
      /session_prompt_unestablished|preflight_failed|original prompt not established/
    );
    // No continuation-only and no original-task auto-replay side effects.
    const loaded = store.getRun(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.record.status).toBe('interrupted');
    expect(loaded.loaded.record.units.single!.sessionPromptEstablished).toBe(false);
    expect(loaded.loaded.record.units.single!.attempts.length).toBe(1);
  });

  it('fresh Pi marks sessionPromptEstablished after original prompt accept', async () => {
    const { store, coordinator } = makeStore();
    const EventEmitter = (await import('node:events')).EventEmitter;
    const { Readable } = await import('node:stream');
    class FakeChild extends EventEmitter {
      stdout = new Readable({ read() {} });
      stderr = new Readable({ read() {} });
      kill() {
        this.stdout.push(null);
        this.stderr.push(null);
        setImmediate(() => this.emit('close', 0));
        return true;
      }
    }
    let lastPrompt = '';
    const spawnFn = ((_cmd: string, args: string[]) => {
      lastPrompt = args[args.length - 1] ?? '';
      const fake = new FakeChild();
      setImmediate(() => {
        fake.stdout.push(
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: withExploreCompletion('done') }],
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          }) + '\n'
        );
        fake.kill();
      });
      return fake as never;
    }) as unknown as import('../../src/execution/execution.ts').SpawnFn;

    const result = await executeAgentTool(
      { agent: 'explore', task: 'Establish original prompt' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      { runStore: store, runCoordinator: coordinator, spawnFn }
    );
    expect(result.isError).toBeUndefined();
    expect(lastPrompt).toContain('Task: Establish original prompt');
    const runs = await store.listRuns();
    expect(runs.length).toBe(1);
    const rec = loadedRecordOf(runs[0]!);
    const unit = rec.units.single ?? Object.values(rec.units)[0]!;
    expect(unit.sessionFile).toBeDefined();
    expect(unit.sessionPromptEstablished).toBe(true);
  });

  it('confirmed Pi session resume sends continuation-only (not original task)', async () => {
    const { store, coordinator } = makeStore();
    const sessionFile = path.join(tmpRoot, 'confirmed-resume.jsonl');
    writeFileSync(sessionFile, '{}\n');
    const runId = await seedInterruptedRun({
      store,
      unitStatus: 'interrupted',
      sessionFile,
      sessionPromptEstablished: true,
      continuationTasks: ['Prior undelivered'],
    });

    const EventEmitter = (await import('node:events')).EventEmitter;
    const { Readable } = await import('node:stream');
    class FakeChild extends EventEmitter {
      stdout = new Readable({ read() {} });
      stderr = new Readable({ read() {} });
      kill() {
        this.stdout.push(null);
        this.stderr.push(null);
        setImmediate(() => this.emit('close', 0));
        return true;
      }
    }
    let lastPrompt = '';
    const spawnFn = ((_cmd: string, args: string[]) => {
      lastPrompt = args[args.length - 1] ?? '';
      const fake = new FakeChild();
      setImmediate(() => {
        fake.stdout.push(
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: withExploreCompletion('resumed') }],
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          }) + '\n'
        );
        fake.kill();
      });
      return fake as never;
    }) as unknown as import('../../src/execution/execution.ts').SpawnFn;

    const result = await executeAgentTool(
      { runId, task: 'New continuation' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      { runStore: store, runCoordinator: coordinator, spawnFn }
    );
    expect(result.isError).toBeUndefined();
    // Session-continuation prompt: no original task resend.
    expect(lastPrompt).not.toContain('Original stored task');
    expect(lastPrompt).toMatch(
      /continuing|resume|interrupt|undelivered|Prior undelivered|New continuation/i
    );
  });

  it('retains dirty new worktree when execution started then fails', async () => {
    const { spawnSync } = await import('node:child_process');
    const gitOk = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
    if (!gitOk) return;

    const repo = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-wt-retain-'));
    try {
      spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'user.email', 'pi@test.example'], {
        encoding: 'utf-8',
      });
      spawnSync('git', ['-C', repo, 'config', 'user.name', 'Pi Test'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'], { encoding: 'utf-8' });
      writeFileSync(path.join(repo, 'README.md'), '# tmp\n');
      spawnSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { encoding: 'utf-8' });

      const store = createRunStore({ rootDir: path.join(repo, '.pi-runs') });
      const coordinator = createRunCoordinator({ store });

      // After spawn (execution started), agent dirties the worktree then crashes.
      const spawnFn = ((_cmd: string, _args: string[], opts?: { cwd?: string }) => {
        const cwd = opts?.cwd ?? repo;
        writeFileSync(path.join(cwd, 'agent-edited.txt'), 'agent work product\n');
        throw new Error('simulated crash after agent modified worktree');
      }) as unknown as import('../../src/execution/execution.ts').SpawnFn;

      const result = await executeAgentTool(
        {
          agent: 'explore',
          task: 'modify then crash',
          isolation: 'worktree',
        },
        undefined,
        undefined,
        makeCtx({ cwd: repo }),
        { runStore: store, runCoordinator: coordinator, spawnFn }
      );

      expect(result.isError).toBe(true);
      const wtRoot = path.join(repo, '.worktrees');
      expect(existsSync(wtRoot)).toBe(true);
      const entries = readdirSync(wtRoot);
      expect(entries.length).toBe(1);
      const wtPath = path.join(wtRoot, entries[0]!);
      expect(existsSync(path.join(wtPath, 'agent-edited.txt'))).toBe(true);

      const runs = await store.listRuns();
      expect(runs.length).toBe(1);
      const rec = loadedRecordOf(runs[0]!);
      const unit = rec.units.single ?? Object.values(rec.units)[0]!;
      expect(unit.status).toBe('failed');
      expect(unit.result?.worktreePath).toBe(wtPath);
      expect(unit.result?.worktreeDirty).toBe(true);
      expect(unit.worktreePath ?? unit.result?.worktreePath).toBe(wtPath);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('clean worktree retained when postprocess/schema fails after successful run', async () => {
    const { spawnSync } = await import('node:child_process');
    const gitOk = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
    if (!gitOk) return;

    const repo = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-wt-schema-fail-'));
    try {
      spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'user.email', 'pi@test.example'], {
        encoding: 'utf-8',
      });
      spawnSync('git', ['-C', repo, 'config', 'user.name', 'Pi Test'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'], { encoding: 'utf-8' });
      writeFileSync(path.join(repo, 'README.md'), '# tmp\n');
      spawnSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { encoding: 'utf-8' });

      const store = createRunStore({ rootDir: path.join(repo, '.pi-runs') });
      const coordinator = createRunCoordinator({ store });

      // Child succeeds with clean worktree but final output fails structured-output schema.
      const spawnFn = ((_cmd: string, _args: string[], _opts?: { cwd?: string }) => {
        const EventEmitter = require('node:events').EventEmitter;
        const { Readable, Writable } = require('node:stream');
        const child = new (class extends EventEmitter {
          stdout = new Readable({ read() {} });
          stderr = new Readable({ read() {} });
          stdin = new Writable({ write: (_c: unknown, _e: unknown, cb: () => void) => cb() });
          kill() {
            this.stdout.push(null);
            this.stderr.push(null);
            setImmediate(() => this.emit('close', 0));
            return true;
          }
        })();
        setImmediate(() => {
          child.stdout.push(
            `${JSON.stringify({
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'not-valid-json-for-schema' }],
                usage: { input: 1, output: 1, totalTokens: 2 },
              },
            })}\n`
          );
          child.kill();
        });
        return child;
      }) as unknown as import('../../src/execution/execution.ts').SpawnFn;

      const result = await executeAgentTool(
        {
          chain: [
            {
              agent: 'explore',
              task: 'emit invalid structured output',
              isolation: 'worktree',
              name: 'out',
              outputSchema: {
                type: 'object',
                required: ['files'],
                properties: { files: { type: 'array', items: { type: 'string' } } },
              },
            },
          ],
        },
        undefined,
        undefined,
        makeCtx({ cwd: repo }),
        { runStore: store, runCoordinator: coordinator, spawnFn }
      );

      expect(result.isError).toBe(true);
      const parent = result.details.results[0];
      expect(parent?.status).toBe('failed');
      expect(parent?.stopReason).toBe('structured_output_error');
      // Clean worktree must be retained under the failed terminal status.
      expect(parent?.worktreePath).toBeDefined();
      expect(parent?.worktreeDirty).toBe(false);
      expect(existsSync(parent!.worktreePath!)).toBe(true);

      const runs = await store.listRuns();
      expect(runs.length).toBe(1);
      const rec = loadedRecordOf(runs[0]!);
      const unit = Object.values(rec.units)[0]!;
      expect(unit.status).toBe('failed');
      expect(unit.result?.status).toBe('failed');
      expect(unit.result?.stopReason).toBe('structured_output_error');
      // Durable and parent results agree on worktree retention.
      expect(unit.result?.worktreePath).toBe(parent?.worktreePath);
      expect(unit.result?.worktreeDirty).toBe(false);
      expect(unit.worktreePath).toBe(parent?.worktreePath);
      expect(existsSync(unit.worktreePath!)).toBe(true);
      expect(existsSync(unit.result!.worktreePath!)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('successful clean worktree is still removed after terminal completion', async () => {
    const { spawnSync } = await import('node:child_process');
    const gitOk = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
    if (!gitOk) return;

    const repo = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-wt-clean-ok-'));
    try {
      spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'user.email', 'pi@test.example'], {
        encoding: 'utf-8',
      });
      spawnSync('git', ['-C', repo, 'config', 'user.name', 'Pi Test'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'], { encoding: 'utf-8' });
      writeFileSync(path.join(repo, 'README.md'), '# tmp\n');
      spawnSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { encoding: 'utf-8' });

      const store = createRunStore({ rootDir: path.join(repo, '.pi-runs') });
      const coordinator = createRunCoordinator({ store });

      const spawnFn = ((_cmd: string) => {
        const EventEmitter = require('node:events').EventEmitter;
        const { Readable, Writable } = require('node:stream');
        const child = new (class extends EventEmitter {
          stdout = new Readable({ read() {} });
          stderr = new Readable({ read() {} });
          stdin = new Writable({ write: (_c: unknown, _e: unknown, cb: () => void) => cb() });
          kill() {
            this.stdout.push(null);
            this.stderr.push(null);
            setImmediate(() => this.emit('close', 0));
            return true;
          }
        })();
        setImmediate(() => {
          child.stdout.push(
            `${JSON.stringify({
              type: 'message_end',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: withExploreCompletion('all good') }],
                usage: { input: 1, output: 1, totalTokens: 2 },
              },
            })}\n`
          );
          child.kill();
        });
        return child;
      }) as unknown as import('../../src/execution/execution.ts').SpawnFn;

      const result = await executeAgentTool(
        {
          agent: 'explore',
          task: 'succeed cleanly',
          isolation: 'worktree',
        },
        undefined,
        undefined,
        makeCtx({ cwd: repo }),
        { runStore: store, runCoordinator: coordinator, spawnFn }
      );

      expect(result.isError).not.toBe(true);
      const parent = result.details.results[0];
      expect(parent?.status === 'completed' || parent?.exitCode === 0).toBe(true);
      // Successful clean worktree is removed — no retained path on the result.
      expect(parent?.worktreePath).toBeUndefined();
      const wtRoot = path.join(repo, '.worktrees');
      if (existsSync(wtRoot)) {
        expect(readdirSync(wtRoot).length).toBe(0);
      }

      const runs = await store.listRuns();
      expect(runs.length).toBe(1);
      const rec = loadedRecordOf(runs[0]!);
      const unit = rec.units.single ?? Object.values(rec.units)[0]!;
      expect(unit.status).toBe('completed');
      expect(unit.result?.worktreePath).toBeUndefined();
      // Unit-level path must also be cleared so resume is not blocked.
      expect(unit.worktreePath).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('early post-begin clean failure clears unit worktreePath and does not leave missing path', async () => {
    const { spawnSync } = await import('node:child_process');
    const gitOk = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
    if (!gitOk) return;

    const repo = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-wt-early-fail-'));
    try {
      spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'user.email', 'pi@test.example'], {
        encoding: 'utf-8',
      });
      spawnSync('git', ['-C', repo, 'config', 'user.name', 'Pi Test'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'], { encoding: 'utf-8' });
      writeFileSync(path.join(repo, 'README.md'), '# tmp\n');
      spawnSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { encoding: 'utf-8' });

      const store = createRunStore({ rootDir: path.join(repo, '.pi-runs') });
      const coordinator = createRunCoordinator({ store });

      // Fail after beginUnit by making session stamp throw (post-begin, pre-execution).
      coordinator.persistSessionFile = async () => {
        throw new Error('simulated stamp failure after beginUnit');
      };

      const result = await executeAgentTool(
        {
          agent: 'explore',
          task: 'early fail after begin',
          isolation: 'worktree',
        },
        undefined,
        undefined,
        makeCtx({ cwd: repo }),
        {
          runStore: store,
          runCoordinator: coordinator,
          spawnFn: (() => {
            throw new Error('spawn must not run');
          }) as unknown as import('../../src/execution/execution.ts').SpawnFn,
        }
      );

      expect(result.isError).toBe(true);
      const parent = result.details.results[0];
      expect(parent?.status).toBe('failed');
      expect(parent?.worktreePath).toBeUndefined();

      const wtRoot = path.join(repo, '.worktrees');
      if (existsSync(wtRoot)) {
        expect(readdirSync(wtRoot).length).toBe(0);
      }

      const runs = await store.listRuns();
      expect(runs.length).toBe(1);
      const rec = loadedRecordOf(runs[0]!);
      const unit = rec.units.single ?? Object.values(rec.units)[0]!;
      expect(unit.status).toBe('failed');
      // Authoritative: deleted clean tree is not retained on unit or result.
      expect(unit.worktreePath).toBeUndefined();
      expect(unit.result?.worktreePath).toBeUndefined();
      expect(unit.result?.worktreeDirty).toBeUndefined();

      // Resume preflight must not block on a phantom missing worktree path.
      const { inspectResume } = await import('../../src/run/resume.ts');
      const discovered = discoverAgents(repo, 'both');
      const preflight = await inspectResume(rec.runId, store, { agents: discovered.agents });
      expect(preflight.ok).toBe(true);
      if (preflight.ok) {
        const worktreeMissing = preflight.blockingReasons.some((r) =>
          r.includes('worktree missing')
        );
        expect(worktreeMissing).toBe(false);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('dirty setup-hook failure retains worktree with modifications and durable path agreement', async () => {
    const { spawnSync } = await import('node:child_process');
    const gitOk = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
    if (!gitOk) return;

    const repo = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-hook-dirty-'));
    try {
      spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'user.email', 'pi@test.example'], {
        encoding: 'utf-8',
      });
      spawnSync('git', ['-C', repo, 'config', 'user.name', 'Pi Test'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'], { encoding: 'utf-8' });
      writeFileSync(path.join(repo, 'README.md'), '# tmp\n');
      spawnSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { encoding: 'utf-8' });

      const agentsDir = path.join(repo, '.pi', 'agents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        path.join(agentsDir, 'hooky.md'),
        `---
name: hooky
description: setup hook dirties then fails
isolation: worktree
worktreeSetupHook: "printf hook-mod > hook-mod.txt && exit 11"
---
Body.
`
      );

      const store = createRunStore({ rootDir: path.join(repo, '.pi-runs') });
      const coordinator = createRunCoordinator({ store });
      let spawnCount = 0;
      const result = await executeAgentTool(
        { agent: 'hooky', task: 'never starts' },
        undefined,
        undefined,
        makeCtx({ cwd: repo }),
        {
          runStore: store,
          runCoordinator: coordinator,
          spawnFn: (() => {
            spawnCount++;
            throw new Error('spawn must not run after dirty setup hook failure');
          }) as unknown as import('../../src/execution/execution.ts').SpawnFn,
        }
      );

      expect(result.isError).toBe(true);
      expect(spawnCount).toBe(0);
      const parent = result.details.results[0];
      expect(parent?.status).toBe('failed');
      expect(parent?.stopReason).toBe('worktree_setup_error');
      expect(parent?.worktreePath).toBeDefined();
      expect(parent?.worktreeDirty).toBe(true);
      expect(existsSync(parent!.worktreePath!)).toBe(true);
      expect(existsSync(path.join(parent!.worktreePath!, 'hook-mod.txt'))).toBe(true);
      expect(readFileSync(path.join(parent!.worktreePath!, 'hook-mod.txt'), 'utf-8')).toContain(
        'hook-mod'
      );

      const runs = await store.listRuns();
      expect(runs.length).toBe(1);
      const rec = loadedRecordOf(runs[0]!);
      const unit = rec.units.single ?? Object.values(rec.units)[0]!;
      expect(unit.status).toBe('failed');
      expect(unit.worktreePath).toBe(parent?.worktreePath);
      expect(unit.result?.worktreePath).toBe(parent?.worktreePath);
      expect(unit.result?.worktreeDirty).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('clean setup-hook failure removes worktree and clears durable path metadata', async () => {
    const { spawnSync } = await import('node:child_process');
    const gitOk = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
    if (!gitOk) return;

    const repo = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-hook-clean-'));
    try {
      spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'user.email', 'pi@test.example'], {
        encoding: 'utf-8',
      });
      spawnSync('git', ['-C', repo, 'config', 'user.name', 'Pi Test'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'], { encoding: 'utf-8' });
      writeFileSync(path.join(repo, 'README.md'), '# tmp\n');
      spawnSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { encoding: 'utf-8' });

      const agentsDir = path.join(repo, '.pi', 'agents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        path.join(agentsDir, 'hooky.md'),
        `---
name: hooky
description: clean setup hook fails
isolation: worktree
worktreeSetupHook: "exit 12"
---
Body.
`
      );

      const store = createRunStore({ rootDir: path.join(repo, '.pi-runs') });
      const coordinator = createRunCoordinator({ store });
      const result = await executeAgentTool(
        { agent: 'hooky', task: 'never starts' },
        undefined,
        undefined,
        makeCtx({ cwd: repo }),
        {
          runStore: store,
          runCoordinator: coordinator,
          spawnFn: (() => {
            throw new Error('spawn must not run');
          }) as unknown as import('../../src/execution/execution.ts').SpawnFn,
        }
      );

      expect(result.isError).toBe(true);
      const parent = result.details.results[0];
      expect(parent?.status).toBe('failed');
      expect(parent?.stopReason).toBe('worktree_setup_error');
      expect(parent?.worktreePath).toBeUndefined();

      const wtRoot = path.join(repo, '.worktrees');
      if (existsSync(wtRoot)) {
        expect(readdirSync(wtRoot).length).toBe(0);
      }

      const runs = await store.listRuns();
      const rec = loadedRecordOf(runs[0]!);
      const unit = rec.units.single ?? Object.values(rec.units)[0]!;
      expect(unit.status).toBe('failed');
      expect(unit.worktreePath).toBeUndefined();
      expect(unit.result?.worktreePath).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('context-path clean removal failure retains worktree path metadata', async () => {
    const { spawnSync } = await import('node:child_process');
    const gitOk = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
    if (!gitOk) return;

    const repo = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-ctx-remove-fail-'));
    const removeSpy = spyOn(worktreeMod, 'removeAgentWorktree').mockImplementation((wt) => ({
      removed: false,
      error: `injected context-path removal failure for ${wt.path}`,
    }));
    try {
      spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'user.email', 'pi@test.example'], {
        encoding: 'utf-8',
      });
      spawnSync('git', ['-C', repo, 'config', 'user.name', 'Pi Test'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'], { encoding: 'utf-8' });
      writeFileSync(path.join(repo, 'README.md'), '# tmp\n');
      spawnSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { encoding: 'utf-8' });

      // Force prepareAgentContext to throw after the worktree is created by
      // requesting fork context with a host that has no session (context_error).
      const agentsDir = path.join(repo, '.pi', 'agents');
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        path.join(agentsDir, 'forky.md'),
        `---
name: forky
description: fork context fails pre-execution
isolation: worktree
defaultContext: fork
---
Body.
`
      );

      const store = createRunStore({ rootDir: path.join(repo, '.pi-runs') });
      const coordinator = createRunCoordinator({ store });
      const result = await executeAgentTool(
        { agent: 'forky', task: 'context should fail' },
        undefined,
        undefined,
        makeCtx({ cwd: repo, sessionManager: undefined }),
        {
          runStore: store,
          runCoordinator: coordinator,
          spawnFn: (() => {
            throw new Error('spawn must not run');
          }) as unknown as import('../../src/execution/execution.ts').SpawnFn,
        }
      );

      expect(result.isError).toBe(true);
      const parent = result.details.results[0];
      // Either context_error with retained path (removal injected fail) or similar early fail.
      expect(parent?.status).toBe('failed');
      expect(parent?.worktreePath).toBeDefined();
      expect(existsSync(parent!.worktreePath!)).toBe(true);
      expect(parent?.stderr ?? '').toMatch(/injected context-path removal failure|context/i);

      const runs = await store.listRuns();
      const rec = loadedRecordOf(runs[0]!);
      const unit = rec.units.single ?? Object.values(rec.units)[0]!;
      expect(unit.worktreePath ?? unit.result?.worktreePath).toBe(parent?.worktreePath);
      expect(removeSpy).toHaveBeenCalled();
    } finally {
      removeSpy.mockRestore();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('post-begin clean removal failure retains unit worktreePath', async () => {
    const { spawnSync } = await import('node:child_process');
    const gitOk = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
    if (!gitOk) return;

    const repo = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-postbegin-remove-fail-'));
    const removeSpy = spyOn(worktreeMod, 'removeAgentWorktree').mockImplementation((wt) => ({
      removed: false,
      error: `injected post-begin removal failure for ${wt.path}`,
    }));
    try {
      spawnSync('git', ['-C', repo, 'init', '-q'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'user.email', 'pi@test.example'], {
        encoding: 'utf-8',
      });
      spawnSync('git', ['-C', repo, 'config', 'user.name', 'Pi Test'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false'], { encoding: 'utf-8' });
      writeFileSync(path.join(repo, 'README.md'), '# tmp\n');
      spawnSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf-8' });
      spawnSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { encoding: 'utf-8' });

      const store = createRunStore({ rootDir: path.join(repo, '.pi-runs') });
      const coordinator = createRunCoordinator({ store });
      coordinator.persistSessionFile = async () => {
        throw new Error('simulated stamp failure after beginUnit');
      };

      const result = await executeAgentTool(
        {
          agent: 'explore',
          task: 'stamp fails after begin',
          isolation: 'worktree',
        },
        undefined,
        undefined,
        makeCtx({ cwd: repo }),
        {
          runStore: store,
          runCoordinator: coordinator,
          spawnFn: (() => {
            throw new Error('spawn must not run');
          }) as unknown as import('../../src/execution/execution.ts').SpawnFn,
        }
      );

      expect(result.isError).toBe(true);
      const parent = result.details.results[0];
      expect(parent?.status).toBe('failed');
      expect(parent?.worktreePath).toBeDefined();
      expect(existsSync(parent!.worktreePath!)).toBe(true);
      expect(parent?.stderr ?? '').toContain('injected post-begin removal failure');

      const runs = await store.listRuns();
      const rec = loadedRecordOf(runs[0]!);
      const unit = rec.units.single ?? Object.values(rec.units)[0]!;
      expect(unit.status).toBe('failed');
      expect(unit.worktreePath).toBe(parent?.worktreePath);
      expect(unit.result?.worktreePath).toBe(parent?.worktreePath);
      expect(removeSpy).toHaveBeenCalled();
    } finally {
      removeSpy.mockRestore();
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('durable begin runs before session stamp so crash leaves attempted state', async () => {
    const { store, coordinator } = makeStore();
    const order: string[] = [];
    const origStart = coordinator.startUnit.bind(coordinator);
    coordinator.startUnit = async (runId, ctx, result) => {
      order.push('begin');
      await origStart(runId, ctx, result);
    };
    const origStamp = coordinator.persistSessionFile.bind(coordinator);
    coordinator.persistSessionFile = async (input) => {
      order.push('stamp');
      // After begin, durable unit must already be running with attempt history.
      const mid = store.getRun(input.runId);
      expect(mid.ok).toBe(true);
      if (mid.ok) {
        const unit = mid.loaded.record.units.single ?? Object.values(mid.loaded.record.units)[0]!;
        expect(unit.status).toBe('running');
        expect(unit.attempts.length).toBeGreaterThan(0);
      }
      await origStamp(input);
    };

    const EventEmitter = (await import('node:events')).EventEmitter;
    const { Readable } = await import('node:stream');
    class FakeChild extends EventEmitter {
      stdout = new Readable({ read() {} });
      stderr = new Readable({ read() {} });
      kill() {
        this.stdout.push(null);
        this.stderr.push(null);
        setImmediate(() => this.emit('close', 0));
        return true;
      }
    }
    const spawnFn = ((_cmd: string) => {
      order.push('spawn');
      const fake = new FakeChild();
      setImmediate(() => {
        fake.stdout.push(
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: withExploreCompletion('ok') }],
              usage: { input: 1, output: 1, totalTokens: 2 },
            },
          }) + '\n'
        );
        fake.kill();
      });
      return fake as never;
    }) as unknown as import('../../src/execution/execution.ts').SpawnFn;

    const result = await executeAgentTool(
      { agent: 'explore', task: 'order check' },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      { runStore: store, runCoordinator: coordinator, spawnFn }
    );
    expect(result.isError).toBeUndefined();
    expect(order.indexOf('begin')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('stamp')).toBeGreaterThan(order.indexOf('begin'));
    expect(order.indexOf('spawn')).toBeGreaterThan(order.indexOf('stamp'));
  });

  describe('post-claim transactional resume preparation', () => {
    async function seedChainFanoutRun(
      store: ReturnType<typeof createRunStore>,
      itemsValue: unknown,
      opts: { itemsRefValue?: unknown } = {}
    ): Promise<string> {
      const agent = exploreAgent();
      const sessionDir = path.join(tmpRoot, 'sessions-t2');
      mkdirSync(sessionDir, { recursive: true });
      const seedSession = path.join(sessionDir, 'chain-0001.jsonl');
      const childSession = path.join(sessionDir, 'chain-0002-fanout-0001.jsonl');
      writeFileSync(seedSession, '{}\n');
      writeFileSync(childSession, '{}\n');
      const unitIds = ['chain-0002-fanout-0001'];
      const chain = [
        { agent: 'explore', task: 'seed', name: 'seed' },
        {
          expand: { from: { output: 'seed', path: '/items' } },
          parallel: { agent: 'explore', task: 'Process {item}' },
          collect: { name: 'out' },
        },
      ];
      const created = await store.createRun({
        mode: 'chain',
        agentScope: 'both',
        background: false,
        request: { mode: 'chain', agentScope: 'both', chain } as never,
        details: {
          mode: 'chain',
          agentScope: 'both',
          projectAgentsDir: null,
          builtinAgentsDir: '/builtin',
          results: [],
        },
        units: {
          'chain-0001': {
            unitId: 'chain-0001',
            agent: agent.name,
            agentFingerprint: agentFingerprint(agent),
            runtime: undefined,
            capability: 'session' as const,
            status: 'completed' as const,
            step: 1,
            attempt: 1,
            attempts: [{ attempt: 1, status: 'completed', startedAt: 1, finishedAt: 2 }],
            effectiveCwd: tmpRoot,
            sessionFile: seedSession,
            sessionPromptEstablished: true,
          },
          [unitIds[0]!]: {
            unitId: unitIds[0]!,
            agent: agent.name,
            agentFingerprint: agentFingerprint(agent),
            runtime: undefined,
            capability: 'session' as const,
            status: 'interrupted' as const,
            step: 2,
            fanoutIndex: 0,
            attempt: 1,
            attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
            effectiveCwd: tmpRoot,
            sessionFile: childSession,
            sessionPromptEstablished: true,
          },
        },
      });
      await store.updateRun(created.runId, (r) => {
        r.status = 'interrupted';
        if (opts.itemsRefValue !== undefined) {
          // itemsRef set atomically with the mapping; items absent.
        } else {
          r.workflowState = {
            fanouts: {
              'chain-0002-fanout': { step: 2, items: itemsValue as unknown[], unitIds },
            },
          };
        }
      });
      if (opts.itemsRefValue !== undefined) {
        const ref = await store.writeJsonArtifact(
          created.runId,
          'fanout-items',
          opts.itemsRefValue
        );
        await store.updateRun(created.runId, (r) => {
          r.workflowState = {
            fanouts: {
              'chain-0002-fanout': { step: 2, itemsRef: ref, unitIds },
            },
          };
        });
      }
      return created.runId;
    }

    it('rejects valid-JSON non-array itemsRef before any event/mutation/register/dispatch', async () => {
      const { store, coordinator } = makeStore();
      const runId = await seedChainFanoutRun(store, null, { itemsRefValue: { not: 'array' } });
      let workflowRan = false;
      const result = await executeAgentTool(
        { runId },
        undefined,
        undefined,
        makeCtx({ cwd: tmpRoot }),
        {
          runWorkflow: async () => {
            workflowRan = true;
            return okResult('should not run');
          },
          runStore: store,
          runCoordinator: coordinator,
        }
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/preflight_failed/);
      expect(workflowRan).toBe(false);
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      // No run_resumed event was appended; durable status/itemsRef unchanged.
      expect(loaded.loaded.record.status).toBe('interrupted');
      expect(
        loaded.loaded.record.workflowState?.fanouts?.['chain-0002-fanout']?.itemsRef
      ).toBeDefined();
      const claims = store.inspectClaims(runId);
      expect(claims.ok).toBe(true);
      if (claims.ok) {
        const live = claims.claims.filter((c) => c.terminal === undefined && c.owner);
        expect(live).toHaveLength(0);
      }
    });

    it('rejects itemsRef length mismatch with frozen unitIds before mutation', async () => {
      const { store, coordinator } = makeStore();
      // Write an array of length 2 but the mapping declares 1 unit id.
      const runId = await seedChainFanoutRun(store, null, { itemsRefValue: ['a', 'b'] });
      let workflowRan = false;
      const result = await executeAgentTool(
        { runId },
        undefined,
        undefined,
        makeCtx({ cwd: tmpRoot }),
        {
          runWorkflow: async () => {
            workflowRan = true;
            return okResult('should not run');
          },
          runStore: store,
          runCoordinator: coordinator,
        }
      );
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(/preflight_failed.*length/);
      expect(workflowRan).toBe(false);
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.loaded.record.status).toBe('interrupted');
      const claims = store.inspectClaims(runId);
      expect(claims.ok).toBe(true);
      if (claims.ok) {
        const live = claims.claims.filter((c) => c.terminal === undefined && c.owner);
        expect(live).toHaveLength(0);
      }
    });

    it('no run_resumed event when restored-state construction throws after claim', async () => {
      const { store, coordinator } = makeStore();
      const runId = await seedChainFanoutRun(store, ['a']);
      let workflowRan = false;
      let abandonCount = 0;
      let releaseCount = 0;
      const realAbandon = store.abandonRun.bind(store);
      const realRelease = store.releaseRun.bind(store);
      const wrapped = {
        ...store,
        abandonRun: async (id: string, claimId: string) => {
          abandonCount += 1;
          return realAbandon(id, claimId);
        },
        releaseRun: async (id: string, claimId: string) => {
          releaseCount += 1;
          return realRelease(id, claimId);
        },
      };
      const before = store.getRun(runId);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const beforeAttempt = before.loaded.record.units['chain-0002-fanout-0001']!.attempt;
      const beforeStatus = before.loaded.record.status;

      const result = await executeAgentTool(
        { runId },
        undefined,
        undefined,
        makeCtx({ cwd: tmpRoot }),
        {
          runWorkflow: async () => {
            workflowRan = true;
            return okResult('should not run');
          },
          runStore: wrapped as never,
          runCoordinator: coordinator,
          buildRestoredChainState: () => {
            throw new Error('injected restored-state construction failure');
          },
        }
      );
      expect(result.isError).toBe(true);
      expect(workflowRan).toBe(false);
      expect(abandonCount).toBe(1);
      expect(releaseCount).toBe(0);
      expect(coordinator.isActive(runId)).toBe(false);

      const after = store.getRun(runId);
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.loaded.record.status).toBe(beforeStatus);
      expect(after.loaded.record.units['chain-0002-fanout-0001']!.attempt).toBe(beforeAttempt);
      const eventsFile = path.join(store.getRunDir(runId), 'events.jsonl');
      const events = existsSync(eventsFile)
        ? readFileSync(eventsFile, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { event?: string })
        : [];
      expect(events.some((e) => e.event === 'run_resumed')).toBe(false);

      const claims = store.inspectClaims(runId);
      expect(claims.ok).toBe(true);
      if (claims.ok) {
        const live = claims.claims.filter((c) => c.terminal === undefined && c.owner);
        expect(live).toHaveLength(0);
        expect(claims.claims.filter((c) => c.terminal?.state === 'abandoned')).toHaveLength(1);
        expect(claims.claims.filter((c) => c.terminal?.state === 'released')).toHaveLength(0);
      }
    });

    async function assertExactlyOneAbandonZeroRelease(
      store: ReturnType<typeof createRunStore>,
      runId: string,
      abandonCount: number,
      releaseCount: number,
      coordinator: ReturnType<typeof createRunCoordinator>,
      opts: { expectRunResumed?: boolean } = {}
    ): Promise<void> {
      expect(abandonCount).toBe(1);
      expect(releaseCount).toBe(0);
      expect(coordinator.isActive(runId)).toBe(false);
      const claims = store.inspectClaims(runId);
      expect(claims.ok).toBe(true);
      if (!claims.ok) return;
      expect(claims.claims.filter((c) => c.terminal === undefined && c.owner)).toHaveLength(0);
      expect(claims.claims.filter((c) => c.terminal?.state === 'abandoned')).toHaveLength(1);
      expect(claims.claims.filter((c) => c.terminal?.state === 'released')).toHaveLength(0);
      const eventsFile = path.join(store.getRunDir(runId), 'events.jsonl');
      if (existsSync(eventsFile)) {
        const events = readFileSync(eventsFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { event?: string });
        // Pre-commit failures must not emit run_resumed; post-commit
        // (after appendEvent, during update/register) may already have it.
        if (opts.expectRunResumed) {
          expect(events.some((e) => e.event === 'run_resumed')).toBe(true);
        } else {
          expect(events.some((e) => e.event === 'run_resumed')).toBe(false);
        }
      }
    }

    function wrapAbandonRelease(store: ReturnType<typeof createRunStore>): {
      wrapped: typeof store;
      getAbandon: () => number;
      getRelease: () => number;
    } {
      let abandonCount = 0;
      let releaseCount = 0;
      const realAbandon = store.abandonRun.bind(store);
      const realRelease = store.releaseRun.bind(store);
      return {
        wrapped: {
          ...store,
          abandonRun: async (id: string, claimId: string) => {
            abandonCount += 1;
            return realAbandon(id, claimId);
          },
          releaseRun: async (id: string, claimId: string) => {
            releaseCount += 1;
            return realRelease(id, claimId);
          },
        } as typeof store,
        getAbandon: () => abandonCount,
        getRelease: () => releaseCount,
      };
    }

    it('post-claim getRun failure: exactly one abandon, zero release', async () => {
      const { store, coordinator } = makeStore();
      const runId = await seedInterruptedRun({ store });
      const { wrapped, getAbandon, getRelease } = wrapAbandonRelease(store);
      const realGet = store.getRun.bind(store);
      let postClaim = false;
      // claimRun succeeds; next getRun (post-claim) fails.
      const origClaim = store.claimRun.bind(store);
      wrapped.claimRun = async (id: string) => {
        const c = await origClaim(id);
        postClaim = true;
        return c;
      };
      wrapped.getRun = ((id: string) => {
        if (postClaim && id === runId) {
          return {
            ok: false as const,
            error: { code: 'run_not_found' as const, runId: id, message: 'injected getRun miss' },
          };
        }
        return realGet(id);
      }) as typeof store.getRun;

      let workflowRan = false;
      const result = await executeAgentTool(
        { runId },
        undefined,
        undefined,
        makeCtx({ cwd: tmpRoot }),
        {
          runWorkflow: async () => {
            workflowRan = true;
            return okResult('should not run');
          },
          runStore: wrapped as never,
          runCoordinator: coordinator,
        }
      );
      expect(result.isError).toBe(true);
      expect(workflowRan).toBe(false);
      await assertExactlyOneAbandonZeroRelease(
        store,
        runId,
        getAbandon(),
        getRelease(),
        coordinator
      );
    });

    it('post-claim inspect/ref inject after claim: exactly one abandon, zero release', async () => {
      const { store, coordinator } = makeStore();
      // Seed a run with a valid text artifact ref so preflight passes, then fail post-claim read.
      const agent = exploreAgent();
      const sessionFile = path.join(tmpRoot, 'ref-session.jsonl');
      writeFileSync(sessionFile, '{}\n');
      const created = await store.createRun({
        mode: 'single',
        agentScope: 'both',
        background: false,
        request: {
          mode: 'single',
          agentScope: 'both',
          agent: 'explore',
          task: 'Original',
        },
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
            agent: agent.name,
            agentFingerprint: agentFingerprint(agent),
            runtime: undefined,
            capability: 'session',
            status: 'interrupted',
            attempt: 1,
            attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
            effectiveCwd: tmpRoot,
            sessionFile,
            sessionPromptEstablished: true,
          },
        },
      });
      const runId = created.runId;
      const ref = await store.writeTextArtifact(runId, 'final-output', 'reachable-payload');
      await store.updateRun(runId, (r) => {
        r.status = 'interrupted';
        r.units.single.result = {
          agent: agent.name,
          agentSource: 'unknown',
          task: 'Original',
          exitCode: 0,
          status: 'interrupted',
          messages: [],
          stderr: '',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
          },
          finalOutputRef: ref,
        };
      });

      const { wrapped, getAbandon, getRelease } = wrapAbandonRelease(store);
      const realRead = store.readTextArtifact.bind(store);
      let claimed = false;
      const realClaim = store.claimRun.bind(store);
      wrapped.claimRun = async (id: string) => {
        const c = await realClaim(id);
        claimed = true;
        return c;
      };
      wrapped.readTextArtifact = async (id, r) => {
        if (claimed) throw new Error('injected post-claim ref read failure');
        return realRead(id, r);
      };

      let workflowRan = false;
      const result = await executeAgentTool(
        { runId },
        undefined,
        undefined,
        makeCtx({ cwd: tmpRoot }),
        {
          runWorkflow: async () => {
            workflowRan = true;
            return okResult('should not run');
          },
          runStore: wrapped as never,
          runCoordinator: coordinator,
        }
      );
      expect(result.isError).toBe(true);
      expect(workflowRan).toBe(false);
      await assertExactlyOneAbandonZeroRelease(
        store,
        runId,
        getAbandon(),
        getRelease(),
        coordinator
      );
    });

    it('post-claim fanout ref resolution failure: exactly one abandon, zero release', async () => {
      const { store, coordinator } = makeStore();
      // Seed chain fanout with a valid itemsRef for preflight; fail read after claim.
      const runId = await seedChainFanoutRun(store, null, { itemsRefValue: ['only-one'] });
      const before = store.getRun(runId);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const beforeSnap = {
        status: before.loaded.record.status,
        attempts: before.loaded.record.units['chain-0002-fanout-0001']!.attempt,
        unitStatus: before.loaded.record.units['chain-0002-fanout-0001']!.status,
        itemsRef: before.loaded.record.workflowState?.fanouts?.['chain-0002-fanout']?.itemsRef,
        continuationTasks: before.loaded.record.continuationTasks,
      };

      const { wrapped, getAbandon, getRelease } = wrapAbandonRelease(store);
      let claimed = false;
      let postClaimInspectReads = 0;
      let postClaimResolveReads = 0;
      let registerCount = 0;
      let spawnCount = 0;
      const realClaim = store.claimRun.bind(store);
      const realReadJson = store.readJsonArtifact.bind(store);
      const realRegister = coordinator.registerRun.bind(coordinator);
      coordinator.registerRun = (id, record) => {
        registerCount += 1;
        return realRegister(id, record);
      };
      wrapped.claimRun = async (id: string) => {
        const c = await realClaim(id);
        claimed = true;
        return c;
      };
      // Inspection (verifyReachableRefs) must succeed; the subsequent
      // resolveAndVerifyFanoutItems read is the intended failure boundary.
      wrapped.readJsonArtifact = async (id, r) => {
        if (!claimed) return realReadJson(id, r);
        if (postClaimInspectReads === 0) {
          postClaimInspectReads += 1;
          return realReadJson(id, r);
        }
        postClaimResolveReads += 1;
        throw new Error('injected fanout ref resolution failure');
      };

      let workflowRan = false;
      try {
        const result = await executeAgentTool(
          { runId },
          undefined,
          undefined,
          makeCtx({ cwd: tmpRoot }),
          {
            runWorkflow: async () => {
              workflowRan = true;
              return okResult('should not run');
            },
            runStore: wrapped as never,
            runCoordinator: coordinator,
            spawnFn: ((_cmd: string) => {
              spawnCount += 1;
              throw new Error('spawn must not run');
            }) as never,
          }
        );
        expect(result.isError).toBe(true);
        expect(workflowRan).toBe(false);
        expect(postClaimInspectReads).toBe(1);
        expect(postClaimResolveReads).toBe(1);
        expect(registerCount).toBe(0);
        expect(spawnCount).toBe(0);
        await assertExactlyOneAbandonZeroRelease(
          store,
          runId,
          getAbandon(),
          getRelease(),
          coordinator
        );
        const after = store.getRun(runId);
        expect(after.ok).toBe(true);
        if (!after.ok) return;
        expect(after.loaded.record.status).toBe(beforeSnap.status);
        expect(after.loaded.record.units['chain-0002-fanout-0001']!.attempt).toBe(
          beforeSnap.attempts
        );
        expect(after.loaded.record.units['chain-0002-fanout-0001']!.status).toBe(
          beforeSnap.unitStatus
        );
        expect(after.loaded.record.workflowState?.fanouts?.['chain-0002-fanout']?.itemsRef).toEqual(
          beforeSnap.itemsRef
        );
        expect(after.loaded.record.continuationTasks).toEqual(beforeSnap.continuationTasks);
      } finally {
        coordinator.registerRun = realRegister;
      }
    });

    it('post-claim getRunDir failure: exactly one abandon, zero release', async () => {
      const { store, coordinator } = makeStore();
      const runId = await seedInterruptedRun({ store });
      const { wrapped, getAbandon, getRelease } = wrapAbandonRelease(store);
      let claimed = false;
      const realClaim = store.claimRun.bind(store);
      const realGetRunDir = store.getRunDir.bind(store);
      wrapped.claimRun = async (id: string) => {
        const c = await realClaim(id);
        claimed = true;
        return c;
      };
      wrapped.getRunDir = ((id: string) => {
        if (claimed && id === runId) throw new Error('injected getRunDir failure');
        return realGetRunDir(id);
      }) as typeof store.getRunDir;

      let workflowRan = false;
      const result = await executeAgentTool(
        { runId },
        undefined,
        undefined,
        makeCtx({ cwd: tmpRoot }),
        {
          runWorkflow: async () => {
            workflowRan = true;
            return okResult('should not run');
          },
          runStore: wrapped as never,
          runCoordinator: coordinator,
        }
      );
      expect(result.isError).toBe(true);
      expect(workflowRan).toBe(false);
      await assertExactlyOneAbandonZeroRelease(
        store,
        runId,
        getAbandon(),
        getRelease(),
        coordinator
      );
    });

    it('post-claim restored-state builder failure: exactly one abandon, zero release', async () => {
      const { store, coordinator } = makeStore();
      const runId = await seedChainFanoutRun(store, ['a']);
      const { wrapped, getAbandon, getRelease } = wrapAbandonRelease(store);
      let workflowRan = false;
      const result = await executeAgentTool(
        { runId },
        undefined,
        undefined,
        makeCtx({ cwd: tmpRoot }),
        {
          runWorkflow: async () => {
            workflowRan = true;
            return okResult('should not run');
          },
          runStore: wrapped as never,
          runCoordinator: coordinator,
          buildRestoredChainState: () => {
            throw new Error('injected builder failure');
          },
        }
      );
      expect(result.isError).toBe(true);
      expect(workflowRan).toBe(false);
      await assertExactlyOneAbandonZeroRelease(
        store,
        runId,
        getAbandon(),
        getRelease(),
        coordinator
      );
    });

    it('post-claim strict running update failure: exactly one abandon, zero release', async () => {
      const { store, coordinator } = makeStore();
      const runId = await seedInterruptedRun({ store });
      const before = store.getRun(runId);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const beforeStatus = before.loaded.record.status;
      const beforeAttempt = before.loaded.record.units.single.attempt;

      const { wrapped, getAbandon, getRelease } = wrapAbandonRelease(store);
      let claimed = false;
      let strictUpdateHits = 0;
      let registerCount = 0;
      let spawnCount = 0;
      const realClaim = store.claimRun.bind(store);
      const realStrict = store.updateRunStrict.bind(store);
      const realRegister = coordinator.registerRun.bind(coordinator);
      coordinator.registerRun = (id, record) => {
        registerCount += 1;
        return realRegister(id, record);
      };
      wrapped.claimRun = async (id: string) => {
        const c = await realClaim(id);
        claimed = true;
        return c;
      };
      // Fail through updateRunStrict (production commit path), not updateRun.
      wrapped.updateRunStrict = async (id, mutate) => {
        if (claimed && id === runId) {
          strictUpdateHits += 1;
          throw new Error('injected running update failure');
        }
        return realStrict(id, mutate);
      };

      let workflowRan = false;
      try {
        const result = await executeAgentTool(
          { runId },
          undefined,
          undefined,
          makeCtx({ cwd: tmpRoot }),
          {
            runWorkflow: async () => {
              workflowRan = true;
              return okResult('should not run');
            },
            runStore: wrapped as never,
            runCoordinator: coordinator,
            spawnFn: ((_cmd: string) => {
              spawnCount += 1;
              throw new Error('spawn must not run');
            }) as never,
          }
        );
        expect(result.isError).toBe(true);
        expect(workflowRan).toBe(false);
        expect(strictUpdateHits).toBe(1);
        expect(registerCount).toBe(0);
        expect(spawnCount).toBe(0);
        // run_resumed is appended before the running update; abandon still fires once.
        await assertExactlyOneAbandonZeroRelease(
          store,
          runId,
          getAbandon(),
          getRelease(),
          coordinator,
          {
            expectRunResumed: true,
          }
        );
        // Running status must not stick after failed strict update.
        const loaded = store.getRun(runId);
        expect(loaded.ok).toBe(true);
        if (loaded.ok) {
          expect(loaded.loaded.record.status).not.toBe('running');
          expect(loaded.loaded.record.status).toBe(beforeStatus);
          expect(loaded.loaded.record.units.single.attempt).toBe(beforeAttempt);
        }
      } finally {
        coordinator.registerRun = realRegister;
      }
    });

    it('post-claim plain-object durable_write_error retains code/message (not [object Object])', async () => {
      const { store, coordinator } = makeStore();
      const runId = await seedInterruptedRun({ store });
      const { wrapped, getAbandon, getRelease } = wrapAbandonRelease(store);
      let claimed = false;
      let strictUpdateHits = 0;
      const realClaim = store.claimRun.bind(store);
      const realStrict = store.updateRunStrict.bind(store);
      wrapped.claimRun = async (id: string) => {
        const c = await realClaim(id);
        claimed = true;
        return c;
      };
      // Inject a plain object through the real strict running-update path.
      wrapped.updateRunStrict = async (id, mutate) => {
        if (claimed && id === runId) {
          strictUpdateHits += 1;
          throw {
            code: 'durable_write_error',
            message: 'post-rename sync failed',
          };
        }
        return realStrict(id, mutate);
      };

      const result = await executeAgentTool(
        { runId },
        undefined,
        undefined,
        makeCtx({ cwd: tmpRoot }),
        {
          runWorkflow: async () => okResult('should not run'),
          runStore: wrapped as never,
          runCoordinator: coordinator,
        }
      );
      expect(result.isError).toBe(true);
      expect(strictUpdateHits).toBe(1);
      const errText = Array.isArray(result.content)
        ? result.content.map((c) => ('text' in c ? String(c.text) : '')).join('\n')
        : String(result.content);
      expect(errText).not.toContain('[object Object]');
      expect(errText).toMatch(/durable_write_error/);
      expect(errText).toMatch(/post-rename sync failed/);
      await assertExactlyOneAbandonZeroRelease(
        store,
        runId,
        getAbandon(),
        getRelease(),
        coordinator,
        { expectRunResumed: true }
      );
    });

    it('post-claim multi-megabyte store error diagnostics stay UTF-8 bounded', async () => {
      const { store, coordinator } = makeStore();
      const runId = await seedInterruptedRun({ store });
      const { wrapped, getAbandon, getRelease } = wrapAbandonRelease(store);
      let claimed = false;
      const realClaim = store.claimRun.bind(store);
      const realStrict = store.updateRunStrict.bind(store);
      const hugeMessage = '💥' + 'm'.repeat(2 * 1024 * 1024);
      const hugeCode = 'durable_write_error_' + 'c'.repeat(1024 * 1024);
      wrapped.claimRun = async (id: string) => {
        const c = await realClaim(id);
        claimed = true;
        return c;
      };
      wrapped.updateRunStrict = async (id, mutate) => {
        if (claimed && id === runId) {
          throw {
            code: hugeCode,
            message: hugeMessage,
          };
        }
        return realStrict(id, mutate);
      };

      const result = await executeAgentTool(
        { runId },
        undefined,
        undefined,
        makeCtx({ cwd: tmpRoot }),
        {
          runWorkflow: async () => okResult('should not run'),
          runStore: wrapped as never,
          runCoordinator: coordinator,
        }
      );
      expect(result.isError).toBe(true);
      const errText = Array.isArray(result.content)
        ? result.content.map((c) => ('text' in c ? String(c.text) : '')).join('\n')
        : String(result.content);
      expect(errText).not.toContain('[object Object]');
      expect(errText).toMatch(/durable_write_error/);
      // Complete final diagnostic (prefix + body + omission) is strictly ≤ 64 KiB.
      expect(Buffer.byteLength(errText, 'utf8')).toBeLessThanOrEqual(64 * 1024);
      expect(errText).toContain('…[truncated]');
      // No broken UTF-8: re-decode round-trip equals.
      expect(Buffer.from(errText, 'utf8').toString('utf8')).toBe(errText);
      await assertExactlyOneAbandonZeroRelease(
        store,
        runId,
        getAbandon(),
        getRelease(),
        coordinator,
        { expectRunResumed: true }
      );
    });

    const storeErrorShapes: Array<{ label: string; err: unknown; expectSubstr: RegExp }> = [
      {
        label: 'Error with own code',
        err: Object.assign(new Error('boom-msg'), { code: 'durable_write_error' }),
        expectSubstr: /durable_write_error:\s*boom-msg/,
      },
      {
        label: 'code+message object',
        err: { code: 'corrupt_run', message: 'object-msg' },
        expectSubstr: /corrupt_run:\s*object-msg/,
      },
      {
        label: 'message-only object',
        err: { message: 'message-only-payload' },
        expectSubstr: /message-only-payload/,
      },
      {
        label: 'code-only object',
        err: { code: 'run_busy' },
        expectSubstr: /run_busy/,
      },
      {
        label: 'primitive string',
        err: 'primitive-store-failure',
        expectSubstr: /primitive-store-failure/,
      },
      {
        label: 'fallback object without code/message',
        err: { nested: true, reason: 42 },
        expectSubstr: /\{"nested":true,"reason":42\}/,
      },
      {
        label: 'primitive number',
        err: 404,
        expectSubstr: /\b404\b/,
      },
      {
        label: 'primitive boolean',
        err: false,
        expectSubstr: /false/,
      },
      {
        label: 'null',
        err: null,
        expectSubstr: /null/,
      },
      {
        label: 'undefined',
        err: undefined,
        expectSubstr: /undefined/,
      },
      {
        label: 'empty object fallback',
        err: {},
        expectSubstr: /unserializable_Object/,
      },
    ];

    for (const shape of storeErrorShapes) {
      it(`post-claim store error shape ${shape.label}: exact code/prefix and bounded`, async () => {
        const { store, coordinator } = makeStore();
        const runId = await seedInterruptedRun({ store });
        const { wrapped, getAbandon, getRelease } = wrapAbandonRelease(store);
        let claimed = false;
        const realClaim = store.claimRun.bind(store);
        const realStrict = store.updateRunStrict.bind(store);
        wrapped.claimRun = async (id: string) => {
          const c = await realClaim(id);
          claimed = true;
          return c;
        };
        wrapped.updateRunStrict = async (id, mutate) => {
          if (claimed && id === runId) throw shape.err;
          return realStrict(id, mutate);
        };

        const result = await executeAgentTool(
          { runId },
          undefined,
          undefined,
          makeCtx({ cwd: tmpRoot }),
          {
            runWorkflow: async () => okResult('should not run'),
            runStore: wrapped as never,
            runCoordinator: coordinator,
          }
        );
        expect(result.isError).toBe(true);
        const errText = Array.isArray(result.content)
          ? result.content.map((c) => ('text' in c ? String(c.text) : '')).join('\n')
          : String(result.content);
        expect(errText).toMatch(/resume_setup_failed/);
        expect(errText).toMatch(shape.expectSubstr);
        expect(errText).not.toContain('[object Object]');
        expect(Buffer.byteLength(errText, 'utf8')).toBeLessThanOrEqual(64 * 1024);
        expect(Buffer.from(errText, 'utf8').toString('utf8')).toBe(errText);
        await assertExactlyOneAbandonZeroRelease(
          store,
          runId,
          getAbandon(),
          getRelease(),
          coordinator,
          { expectRunResumed: true }
        );
      });
    }

    it('post-claim multibyte boundary: exact budget, omission marker, useful code/prefix', async () => {
      const { store, coordinator } = makeStore();
      const runId = await seedInterruptedRun({ store });
      const { wrapped, getAbandon, getRelease } = wrapAbandonRelease(store);
      let claimed = false;
      const realClaim = store.claimRun.bind(store);
      const realStrict = store.updateRunStrict.bind(store);
      // Multibyte code points that cross the 64KiB budget exactly when repeated.
      const unit = '💥'; // 4 UTF-8 bytes
      const hugeMessage = unit.repeat(20_000); // 80_000 bytes
      wrapped.claimRun = async (id: string) => {
        const c = await realClaim(id);
        claimed = true;
        return c;
      };
      wrapped.updateRunStrict = async (id, mutate) => {
        if (claimed && id === runId) {
          throw { code: 'durable_write_error', message: hugeMessage };
        }
        return realStrict(id, mutate);
      };

      const result = await executeAgentTool(
        { runId },
        undefined,
        undefined,
        makeCtx({ cwd: tmpRoot }),
        {
          runWorkflow: async () => okResult('should not run'),
          runStore: wrapped as never,
          runCoordinator: coordinator,
        }
      );
      expect(result.isError).toBe(true);
      const errText = Array.isArray(result.content)
        ? result.content.map((c) => ('text' in c ? String(c.text) : '')).join('\n')
        : String(result.content);
      expect(errText).toMatch(/resume_setup_failed/);
      expect(errText).toMatch(/durable_write_error/);
      expect(errText).toContain('…[truncated]');
      // Exact complete final diagnostic budget including prefix + body + omission.
      expect(Buffer.byteLength(errText, 'utf8')).toBeLessThanOrEqual(64 * 1024);
      expect(Buffer.byteLength(errText, 'utf8')).toBe(64 * 1024);
      // Valid UTF-8 round-trip (no split code point).
      expect(Buffer.from(errText, 'utf8').toString('utf8')).toBe(errText);
      // Marker is complete (not a partial multi-byte split of the omission text).
      expect(errText.endsWith('…[truncated]')).toBe(true);
      await assertExactlyOneAbandonZeroRelease(
        store,
        runId,
        getAbandon(),
        getRelease(),
        coordinator,
        { expectRunResumed: true }
      );
    });

    it('post-claim coordinator registration failure: exactly one abandon, zero release', async () => {
      const { store, coordinator } = makeStore();
      const runId = await seedInterruptedRun({ store });
      const { wrapped, getAbandon, getRelease } = wrapAbandonRelease(store);
      const originalRegister = coordinator.registerRun.bind(coordinator);
      coordinator.registerRun = (id, record) => {
        if (id === runId) throw new Error('injected registerRun failure');
        return originalRegister(id, record);
      };

      let workflowRan = false;
      try {
        const result = await executeAgentTool(
          { runId },
          undefined,
          undefined,
          makeCtx({ cwd: tmpRoot }),
          {
            runWorkflow: async () => {
              workflowRan = true;
              return okResult('should not run');
            },
            runStore: wrapped as never,
            runCoordinator: coordinator,
          }
        );
        expect(result.isError).toBe(true);
        expect(workflowRan).toBe(false);
        // Commit wrote run_resumed + running before register; cleanup still abandons.
        await assertExactlyOneAbandonZeroRelease(
          store,
          runId,
          getAbandon(),
          getRelease(),
          coordinator,
          { expectRunResumed: true }
        );
        expect(coordinator.isActive(runId)).toBe(false);
      } finally {
        coordinator.registerRun = originalRegister;
      }
    });
  });
});

describe('copy-on-write parallel updates', () => {
  it('copySnapshotShell shares frozen presentation and isolates mutable shell fields', async () => {
    const { copySnapshotShell, snapshotSingleResult } = await import('../../src/output/result-snapshot.ts');
    // Externally frozen presentation is not owned — reproject first to establish ownership.
    const owned = snapshotSingleResult({
      agent: 'a',
      agentSource: 'unknown',
      task: 't',
      exitCode: 0,
      status: 'completed',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'note' }],
        } as never,
      ],
      stderr: '',
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 1,
      },
      finalOutput: 'done',
      structuredOutput: { ok: true },
      worktreeChangedFiles: ['a.ts'],
      fanout: { index: 0, count: 2 },
    });
    const shellA = copySnapshotShell(owned);
    const shellB = copySnapshotShell(owned);
    expect(shellA).not.toBe(shellB);
    expect(shellA.presentation).toBe(owned.presentation);
    expect(shellB.presentation).toBe(owned.presentation);
    expect(shellA.structuredOutput).toBe(owned.structuredOutput);
    shellA.usage.input = 99;
    shellA.status = 'failed';
    shellA.worktreeChangedFiles!.push('b.ts');
    shellA.fanout!.index = 7;
    expect(owned.usage.input).toBe(1);
    expect(shellB.usage.input).toBe(1);
    expect(shellB.status).toBe('completed');
    expect(shellB.worktreeChangedFiles).toEqual(['a.ts']);
    expect(shellB.fanout?.index).toBe(0);
  });
});

describe('spill-before-clone and parent ref orchestration', () => {
  const ref = (sha256: string, bytes = 100): import('../../src/run/run-types.ts').RunArtifactRefV1 => ({
    kind: 'run-artifact',
    version: 1,
    runId: 'r',
    payload: 'final-output',
    relativePath: `artifacts/sha256/${sha256.slice(0, 2)}/${sha256}.txt`,
    sha256,
    bytes,
    mediaType: 'text/plain; charset=utf-8',
  });

  it('Single terminal result with finalOutputRef shows bounded metadata, not (no output)', async () => {
    const { getResultParentOutput } = await import('../../src/output/output.ts');
    const single = {
      agent: 'test',
      agentSource: 'unknown' as const,
      task: 't',
      exitCode: 0,
      status: 'completed' as const,
      messages: [],
      stderr: '',
      usage: {
        input: 10,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 100,
        turns: 1,
      },
      finalOutputRef: ref('f'.repeat(64), 1024),
    };
    const out = getResultParentOutput(single);
    expect(out).not.toBe('(no output)');
    expect(out).toContain('run-artifact');
    expect(out).toContain('bytes=1024');
    // Artifact content must never appear in the parent descriptor.
    expect(out).not.toContain('actual-secret');
  });

  it('Chain terminal result with finalOutputRef shows bounded metadata', async () => {
    const { getResultParentOutput } = await import('../../src/output/output.ts');
    const chain = {
      agent: 'chain-agent',
      agentSource: 'unknown' as const,
      task: 'chain-task',
      exitCode: 0,
      status: 'completed' as const,
      messages: [],
      stderr: '',
      usage: {
        input: 10,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 100,
        turns: 1,
      },
      finalOutputRef: ref('c'.repeat(64), 2048),
    };
    const out = getResultParentOutput(chain);
    expect(out).not.toBe('(no output)');
    expect(out).toContain('run-artifact');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(2048);
  });

  it('Parallel terminal result with finalOutputRef shows bounded metadata', async () => {
    const { getResultParentOutput } = await import('../../src/output/output.ts');
    const parallel = {
      agent: 'par-agent',
      agentSource: 'unknown' as const,
      task: 'par-task',
      exitCode: 0,
      status: 'completed' as const,
      messages: [],
      stderr: '',
      usage: {
        input: 10,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 100,
        turns: 1,
      },
      finalOutputRef: ref('p'.repeat(64), 512),
    };
    const out = getResultParentOutput(parallel);
    expect(out).not.toBe('(no output)');
    expect(out).toContain('run-artifact');
    expect(out).toContain('bytes=512');
  });

  it('spill before clone: oversized finalOutputRef renders as bounded parent descriptor', async () => {
    const { getResultParentOutput } = await import('../../src/output/output.ts');
    const resultWithRef = {
      agent: 'test',
      agentSource: 'unknown' as const,
      task: 'hello',
      exitCode: 0,
      status: 'completed' as const,
      messages: [],
      stderr: '',
      usage: {
        input: 5,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 50,
        turns: 1,
      },
      finalOutputRef: ref('s'.repeat(64), 99999),
    };
    const out = getResultParentOutput(resultWithRef);
    expect(out).not.toBe('(no output)');
    expect(out).toContain('run-artifact');
    expect(out).toContain('bytes=99999');
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(2048);
    // Artifact content is never inline in the parent descriptor.
    expect(out).not.toContain('secret-payload');
  });

  it('finishUnit externalizes overflow before publishing stable result to durable store', async () => {
    const { createRunStore } = await import('../../src/run/run-store.ts');
    const { createRunCoordinator } = await import('../../src/run/run-coordinator.ts');
    const tmpRoot = `${import.meta.dir}/.tmp-ext-${Date.now()}`;
    await fsPromises.mkdir(tmpRoot, { recursive: true });
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const unitId = 'single';
    // Create the run and register so finishUnit can operate.
    const { runId, record } = await store.createRun({
      mode: 'single',
      agentScope: 'both',
      background: false,
      request: { mode: 'single', agentScope: 'both', agent: 'test', task: 't' },
      details: {
        mode: 'single',
        agentScope: 'both',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        results: [],
      },
      units: {
        [unitId]: {
          unitId,
          agent: 'test',
          agentFingerprint: 'fp',
          runtime: undefined,
          capability: 'session',
          status: 'running',
          attempt: 1,
          attempts: [{ attempt: 1, status: 'running', startedAt: Date.now() }],
          effectiveCwd: tmpRoot,
        },
      },
    });
    coordinator.registerRun(runId, record);
    const big = 'x'.repeat(300 * 1024);
    try {
      const ctx = {
        runId,
        unitId,
        agent: 'test',
        runtime: undefined,
        resumeCapability: 'session' as const,
        effectiveCwd: tmpRoot,
        attempt: 1,
      };
      const result = await coordinator.finishUnit(
        runId,
        ctx,
        {
          agent: 'test',
          agentSource: 'unknown',
          task: 't',
          exitCode: 0,
          status: 'completed',
          messages: [],
          stderr: '',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            contextTokens: 0,
            turns: 0,
          },
          finalOutput: big,
        },
        'completed'
      );
      // Oversized text is externalized to a ref BEFORE snapshotSingleResult clones it.
      expect(result.finalOutputRef).toBeDefined();
      expect(result.finalOutput).toBeUndefined();
      expect(result.finalOutputRef!.sha256).toHaveLength(64);
      expect(result.finalOutputRef!.bytes).toBeGreaterThan(0);
      // Committed record also has the ref, not inline content.
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        const unit = loaded.loaded.record.units[unitId];
        expect(unit?.result?.finalOutputRef).toBeDefined();
        expect(unit?.result?.finalOutput).toBeUndefined();
      }
    } finally {
      await fsPromises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('strict startUnit failure has zero launch side effects', () => {
  let tmpRoot: string;
  const AGENT_DIR_BEFORE = process.env.PI_CODING_AGENT_DIR;
  /** Canonical second chain step unit id (exact event/live identity). */
  const STEP2_UNIT_ID = 'chain-0002';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-strict-launch-'));
    process.env.PI_CODING_AGENT_DIR = path.join(tmpRoot, 'pi-agent');
  });
  afterEach(() => {
    if (AGENT_DIR_BEFORE !== undefined) process.env.PI_CODING_AGENT_DIR = AGENT_DIR_BEFORE;
    else delete process.env.PI_CODING_AGENT_DIR;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function oversizedText(sentinel: string): string {
    // Sentinel first for identity assertions; general headings keep completion_check green.
    return withGeneralCompletion(sentinel + 'X'.repeat(300 * 1024));
  }

  function isReaderLaunchArgs(args: string[]): boolean {
    return args.some(
      (a) =>
        a.includes('artifact-reader-extension') ||
        a.includes('pi_agents_read_artifact') ||
        a === '--extension'
    );
  }

  /** Count stdin RPC prompt/activate independently of the spawn branch. */
  function watchRpcActivation(child: EventEmitter & { stdin: Writable }, onRpc: () => void): void {
    const stdin = child.stdin;
    const originalWrite = stdin.write.bind(stdin);
    (stdin as Writable).write = ((chunk: unknown, ...rest: unknown[]) => {
      const text =
        typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : String(chunk ?? '');
      if (
        text.includes('"method":"prompt"') ||
        text.includes('"method": "prompt"') ||
        text.includes('"method":"activate"') ||
        text.includes('pi_agents_read_artifact') ||
        text.includes('"type":"prompt"')
      ) {
        onRpc();
      }
      return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stdin.write;
  }

  function fakeChild(output: string, onRpc?: () => void): EventEmitter {
    const child = new (class extends EventEmitter {
      stdout = new Readable({ read() {} });
      stderr = new Readable({ read() {} });
      stdin = new Writable({ write: (_c, _e, cb) => cb() });
      kill() {
        this.stdout.push(null);
        this.stderr.push(null);
        setImmediate(() => this.emit('close', 0));
        return true;
      }
    })();
    if (onRpc) watchRpcActivation(child as never, onRpc);
    setImmediate(() => {
      child.stdout.push(
        `${JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: output }],
            usage: { input: 1, output: 1, totalTokens: 2 },
          },
        })}\n`
      );
      child.kill();
    });
    return child;
  }

  async function runChainWithStrictFail(mode: 'strict-write' | 'directory-sync'): Promise<{
    seedSpawnCount: number;
    readerSpawnCount: number;
    readerRpcActivationCount: number;
    strictFaultHits: number;
    result: AgentResult;
    store: ReturnType<typeof createRunStore>;
    coordinator: ReturnType<typeof createRunCoordinator>;
    liveRecord: AgentRunRecordV1 | undefined;
    /** Live step-2 snapshot at the strict-start fault (before tool cleanup). */
    step2AtFault: AgentRunRecordV1['units'][string] | undefined;
    step2AttemptBefore: number | undefined;
  }> {
    const sentinel = 'STRICT_START_SENTINEL_';
    let seedSpawnCount = 0;
    let readerSpawnCount = 0;
    let readerRpcActivationCount = 0;
    let strictFaultHits = 0;
    let liveRecord: AgentRunRecordV1 | undefined;
    let step2AtFault: AgentRunRecordV1['units'][string] | undefined;
    let step2AttemptBefore: number | undefined;

    const snapshotStep2AtFault = (): void => {
      if (liveRecord?.units[STEP2_UNIT_ID]) {
        step2AtFault = structuredClone(liveRecord.units[STEP2_UNIT_ID]);
      }
    };

    const store =
      mode === 'directory-sync'
        ? createRunStore({
            rootDir: tmpRoot,
            strictPostRenameDirectorySync: (dirPath) => {
              // Fail only the reader-handoff publication (requireArtifactReader + running).
              // Seed start/finish and other strict writes still get a real directory sync.
              const runJson = path.join(dirPath, 'run.json');
              let hasReaderStart: boolean;
              try {
                const parsed = JSON.parse(readFileSync(runJson, 'utf8')) as AgentRunRecordV1;
                hasReaderStart = Object.values(parsed.units ?? {}).some(
                  (u) => u.requireArtifactReader === true && u.status === 'running'
                );
              } catch {
                hasReaderStart = false;
              }
              if (hasReaderStart) {
                strictFaultHits += 1;
                // startUnit applies live mutation only after durable success; snapshot now.
                snapshotStep2AtFault();
                throw {
                  code: 'run_store_error' as const,
                  message: 'directory fsync failed: injected',
                };
              }
              if (process.platform !== 'win32') {
                const dirFd = openSync(dirPath, 'r');
                try {
                  fsyncSync(dirFd);
                } finally {
                  closeSync(dirFd);
                }
              }
            },
          })
        : createRunStore({ rootDir: tmpRoot });

    const coordinator = createRunCoordinator({ store });
    const realRegister = coordinator.registerRun.bind(coordinator);
    coordinator.registerRun = (id, record) => {
      liveRecord = record;
      step2AttemptBefore = record.units[STEP2_UNIT_ID]?.attempt;
      return realRegister(id, record);
    };

    if (mode === 'strict-write') {
      const realStrict = store.updateRunStrict.bind(store);
      store.updateRunStrict = async (runId, mutate) => {
        const loaded = store.getRun(runId);
        if (!loaded.ok) return realStrict(runId, mutate);
        const clone = structuredClone(loaded.loaded.record);
        mutate(clone);
        const startingReader = Object.values(clone.units).some(
          (u) => u.requireArtifactReader === true && u.status === 'running'
        );
        if (startingReader) {
          strictFaultHits += 1;
          snapshotStep2AtFault();
          throw new Error('strict write failed');
        }
        return realStrict(runId, mutate);
      };
    }

    const result = await executeAgentTool(
      {
        chain: [
          { agent: 'general', task: 'produce-oversize', name: 'seed' },
          { agent: 'general', task: 'consume {previous}' },
        ],
        agentScope: 'user',
      },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runStore: store,
        runCoordinator: coordinator,
        spawnFn: ((_cmd: string, args: string[]) => {
          const isReader = isReaderLaunchArgs(args);
          if (isReader) {
            readerSpawnCount += 1;
            // RPC activation counted only via stdin observation, not spawn branch.
            return fakeChild(oversizedText(sentinel), () => {
              readerRpcActivationCount += 1;
            }) as never;
          }
          seedSpawnCount += 1;
          return fakeChild(oversizedText(sentinel), () => {
            /* seed prompt traffic ignored for reader-activation counter */
          }) as never;
        }) as import('../../src/execution/execution.ts').SpawnFn,
      }
    );
    return {
      seedSpawnCount,
      readerSpawnCount,
      readerRpcActivationCount,
      strictFaultHits,
      result,
      store,
      coordinator,
      liveRecord,
      step2AtFault,
      step2AttemptBefore,
    };
  }

  it('strict write failure on reader-requiring handoff: zero second-step launch', async () => {
    const {
      seedSpawnCount,
      readerSpawnCount,
      readerRpcActivationCount,
      strictFaultHits,
      result,
      store,
      liveRecord,
      step2AtFault,
      step2AttemptBefore,
    } = await runChainWithStrictFail('strict-write');

    // Exact independent counters — never conditional.
    expect(seedSpawnCount).toBe(1);
    expect(readerSpawnCount).toBe(0);
    expect(readerRpcActivationCount).toBe(0);
    expect(strictFaultHits).toBe(1);
    expect(result.isError).toBeTruthy();
    const errText = Array.isArray(result.content)
      ? result.content.map((c) => ('text' in c ? String(c.text) : '')).join('\n')
      : String(result.content);
    expect(errText).toMatch(/strict write failed/);

    // Known registered live record; step-2 snapshot at fault is exact queued.
    expect(liveRecord).toBeDefined();
    expect(step2AtFault).toBeDefined();
    if (!step2AtFault) return;
    expect(step2AtFault.status).toBe('queued');
    expect(step2AtFault.requireArtifactReader).toBeUndefined();
    expect(step2AtFault.attempts.filter((a) => a.status === 'running')).toHaveLength(0);
    expect(typeof step2AttemptBefore).toBe('number');
    expect(step2AtFault.attempt).toBe(step2AttemptBefore as number);

    const runs = await store.listRuns();
    const entry = runs.find((r) => 'record' in r) as { record: AgentRunRecordV1 } | undefined;
    expect(entry).toBeDefined();
    if (!entry) return;

    const diskUnit = entry.record.units[STEP2_UNIT_ID];
    expect(diskUnit).toBeDefined();
    // Durable start never published: no running attempt / reader flag from startUnit.
    // Tool failure cleanup may terminalize the unit, but never unit_started.
    expect(diskUnit!.status).not.toBe('running');
    expect(diskUnit!.attempts.filter((a) => a.status === 'running')).toHaveLength(0);
    expect(diskUnit!.requireArtifactReader).toBeUndefined();

    const eventsFile = path.join(store.getRunDir(entry.record.runId), 'events.jsonl');
    expect(existsSync(eventsFile)).toBe(true);
    const events = readFileSync(eventsFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event?: string; unitId?: string });
    // Exact second-unit identity — no unit_started for chain-0002.
    expect(events.some((e) => e.event === 'unit_started' && e.unitId === STEP2_UNIT_ID)).toBe(
      false
    );
  }, 60_000);

  it('directory-sync failure on reader-requiring handoff: zero second-step launch', async () => {
    const {
      seedSpawnCount,
      readerSpawnCount,
      readerRpcActivationCount,
      strictFaultHits,
      result,
      store,
      liveRecord,
      step2AtFault,
      step2AttemptBefore,
    } = await runChainWithStrictFail('directory-sync');

    expect(seedSpawnCount).toBe(1);
    expect(readerSpawnCount).toBe(0);
    expect(readerRpcActivationCount).toBe(0);
    expect(strictFaultHits).toBe(1);
    expect(result.isError).toBeTruthy();
    const errText = Array.isArray(result.content)
      ? result.content.map((c) => ('text' in c ? String(c.text) : '')).join('\n')
      : String(result.content);
    expect(errText).toMatch(/directory fsync failed/);
    expect(errText).toMatch(/prior run\.json restored|directory fsync failed/);

    expect(liveRecord).toBeDefined();
    expect(step2AtFault).toBeDefined();
    if (!step2AtFault) return;
    expect(step2AtFault.status).toBe('queued');
    expect(step2AtFault.requireArtifactReader).toBeUndefined();
    expect(step2AtFault.attempts.filter((a) => a.status === 'running')).toHaveLength(0);
    expect(typeof step2AttemptBefore).toBe('number');
    expect(step2AtFault.attempt).toBe(step2AttemptBefore as number);

    const runs = await store.listRuns();
    const entry = runs.find((r) => 'record' in r) as { record: AgentRunRecordV1 } | undefined;
    expect(entry).toBeDefined();
    if (!entry) return;

    const diskUnit = entry.record.units[STEP2_UNIT_ID];
    expect(diskUnit).toBeDefined();
    // After durable rollback the start never committed; cleanup may terminalize.
    expect(diskUnit!.status).not.toBe('running');
    expect(diskUnit!.attempts.filter((a) => a.status === 'running')).toHaveLength(0);
    expect(diskUnit!.requireArtifactReader).toBeUndefined();

    const eventsFile = path.join(store.getRunDir(entry.record.runId), 'events.jsonl');
    expect(existsSync(eventsFile)).toBe(true);
    const events = readFileSync(eventsFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { event?: string; unitId?: string });
    expect(events.some((e) => e.event === 'unit_started' && e.unitId === STEP2_UNIT_ID)).toBe(
      false
    );
  }, 60_000);
});

describe('real executeAgentTool Chain/Parallel artifact orchestration', () => {
  let tmpRoot: string;
  const AGENT_DIR_BEFORE = process.env.PI_CODING_AGENT_DIR;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-real-orch-'));
    process.env.PI_CODING_AGENT_DIR = path.join(tmpRoot, 'pi-agent');
  });
  afterEach(() => {
    if (AGENT_DIR_BEFORE !== undefined) process.env.PI_CODING_AGENT_DIR = AGENT_DIR_BEFORE;
    else delete process.env.PI_CODING_AGENT_DIR;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function fakeChild(output: string): EventEmitter {
    const child = new (class extends EventEmitter {
      stdout = new Readable({ read() {} });
      stderr = new Readable({ read() {} });
      stdin = new Writable({ write: (_c, _e, cb) => cb() });
      kill() {
        this.stdout.push(null);
        this.stderr.push(null);
        setImmediate(() => this.emit('close', 0));
        return true;
      }
    })();
    setImmediate(() => {
      child.stdout.push(
        `${JSON.stringify({
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: output }],
            usage: { input: 1, output: 1, totalTokens: 2 },
          },
        })}\n`
      );
      child.kill();
    });
    return child;
  }

  it('real two-step Chain: second child receives artifact descriptor, final content is bounded', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const sentinel1 = 'REAL_CHAIN_SENTINEL1_';
    const sentinel2 = 'REAL_CHAIN_SENTINEL2_';
    const oversized1 = withGeneralCompletion(sentinel1 + 'C'.repeat(300 * 1024));
    const oversized2 = withGeneralCompletion(sentinel2 + 'D'.repeat(300 * 1024));
    let spawnIndex = 0;
    /** Tasks captured by spawn index (1-based) for identity-exact correlation. */
    const tasksBySpawnIndex = new Map<number, string[]>();

    const result = await executeAgentTool(
      {
        chain: [
          { agent: 'general', task: 'emit-oversize', name: 'seed' },
          { agent: 'general', task: 'use previous {previous}' },
        ],
        agentScope: 'user',
      },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runStore: store,
        runCoordinator: coordinator,
        // No runWorkflow shortcut — production chain orchestration only.
        spawnFn: ((_cmd: string, args: string[]) => {
          spawnIndex += 1;
          const idx = spawnIndex;
          const captured: string[] = [];
          for (const a of args) {
            if (
              a.startsWith('Task:') ||
              a.includes('run-artifact') ||
              a.includes('{previous}') ||
              a.includes('pi_agents_read_artifact')
            ) {
              captured.push(a);
            }
          }
          tasksBySpawnIndex.set(idx, captured);
          // Both steps emit oversized terminal output so intermediate and final
          // assembly must be ref-backed.
          const output = idx === 1 ? oversized1 : oversized2;
          return fakeChild(output) as never;
        }) as import('../../src/execution/execution.ts').SpawnFn,
      }
    );

    // Exactly two spawns — identity-exact chain orchestration.
    expect(spawnIndex).toBe(2);
    expect(tasksBySpawnIndex.size).toBe(2);
    expect(tasksBySpawnIndex.has(1)).toBe(true);
    expect(tasksBySpawnIndex.has(2)).toBe(true);

    const text = Array.isArray(result.content)
      ? result.content.map((c) => ('text' in c ? String(c.text) : '')).join('\n')
      : String(result.content);

    expect(text).not.toContain(sentinel1);
    expect(text).not.toContain(sentinel2);
    expect(text).not.toBe('(no output)');
    expect(text).toContain('run-artifact');
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2048);

    const details = result.details;
    expect(details).toBeDefined();
    const results = details?.results ?? [];
    expect(results.length).toBeGreaterThanOrEqual(2);
    // First step authority spilled to a ref.
    expect(results[0]!.finalOutput).toBeUndefined();
    expect(results[0]!.finalOutputRef).toBeDefined();
    const step1Digest = results[0]!.finalOutputRef!.sha256;
    expect(step1Digest).toHaveLength(64);
    // Second step also spills oversized terminal output.
    expect(results[1]!.finalOutput).toBeUndefined();
    expect(results[1]!.finalOutputRef).toBeDefined();
    const step2Digest = results[1]!.finalOutputRef!.sha256;
    expect(step2Digest).toHaveLength(64);
    expect(step2Digest).not.toBe(step1Digest);

    // Second step task must contain step 1's exact digest and reader instruction, no sentinel.
    const step2Task = results[1]!.task ?? '';
    expect(step2Task).toContain(step1Digest);
    expect(step2Task).toContain('pi_agents_read_artifact');
    expect(step2Task).not.toContain(sentinel1);
    expect(step2Task).not.toContain(step2Digest);

    // Directly inspect spawn-index 2 invocation: step 1 digest only.
    const secondChildArgs = (tasksBySpawnIndex.get(2) ?? []).join('\n');
    expect(secondChildArgs).toContain(step1Digest);
    expect(secondChildArgs).toContain('run-artifact');
    expect(secondChildArgs).not.toContain(sentinel1);
    expect(secondChildArgs).not.toContain(step2Digest);

    // Terminal tool content must be step 2's ref specifically (digest prefix).
    const step2Prefix = step2Digest.slice(0, 16);
    const step1Prefix = step1Digest.slice(0, 16);
    expect(text).toContain(step2Prefix);
    // Parent descriptor uses first 16 hex of terminal authority digest — not step 1.
    expect(text).not.toContain(step1Prefix);
    expect(JSON.stringify(details)).not.toContain(sentinel1);
    expect(JSON.stringify(details)).not.toContain(sentinel2);
    expect(results[0]!.finalOutputRef!.sha256).toBe(step1Digest);
    expect(results[1]!.finalOutputRef!.sha256).toBe(step2Digest);
  }, 60_000);

  it('real Parallel children with oversized outputs return bounded aggregate metadata', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const sentinel = 'REAL_PAR_SENTINEL_';
    const oversized = withGeneralCompletion(sentinel + 'P'.repeat(300 * 1024));

    const result = await executeAgentTool(
      {
        tasks: [
          { agent: 'general', task: 'par-1' },
          { agent: 'general', task: 'par-2' },
        ],
        agentScope: 'user',
      },
      undefined,
      undefined,
      makeCtx({ cwd: tmpRoot }),
      {
        runStore: store,
        runCoordinator: coordinator,
        spawnFn: ((_cmd: string) =>
          fakeChild(oversized) as never) as import('../../src/execution/execution.ts').SpawnFn,
      }
    );

    const text = Array.isArray(result.content)
      ? result.content.map((c) => ('text' in c ? String(c.text) : '')).join('\n')
      : String(result.content);

    expect(text).not.toContain(sentinel);
    expect(text).not.toContain('(no output)');
    expect(text).toMatch(/Parallel:/);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2048);

    const results = result.details?.results ?? [];
    expect(results.length).toBeGreaterThanOrEqual(2);
    const successful = results.filter((r) => r.status === 'completed');
    expect(successful.length).toBeGreaterThanOrEqual(2);
    for (const r of successful) {
      expect(r.finalOutputRef).toBeDefined();
      expect(r.finalOutput).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain(sentinel);
    }
    // One bounded run-artifact descriptor in tool content per successful child.
    const descriptors = text.match(/\[run-artifact[^\]]*\]/g) ?? [];
    expect(descriptors.length).toBe(successful.length);
  }, 60_000);
});
