// ABOUTME: Tests for run resume - worktree reopening, chain/parallel state restoration, and skip-completed behavior.
// ABOUTME: Uses injected runStep stubs and temp git repos; no real Pi processes are spawned.

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runChainWorkflow, type ChainItemInput, type ChainStepRequest } from '../src/chain.ts';
import { openAgentWorktree, createAgentWorktree, removeAgentWorktree } from '../src/worktree.ts';
import {
  incrementIncompleteAttempts,
  inspectResume,
  isNeverStartedUnit,
  reconcileDeadOwnerUnits,
  validateFanoutResumeState,
} from '../src/resume.ts';
import { createRunStore } from '../src/run-store.ts';
import {
  agentFingerprint,
  chainFanoutStepId,
  chainFanoutUnitId,
  createRunCoordinator,
} from '../src/run-coordinator.ts';
import type { AgentConfig } from '../src/agents.ts';
import type {
  ChainOutputEntry,
  ChainLogicalStep,
  SingleResult,
  SubagentDetails,
} from '../src/types.ts';
import type { AgentRunRecordV1, RunUnitRecord, WorkflowFanoutState } from '../src/run-types.ts';

/** Helper: create a run with a single unit in the given status. */
async function startDurableRunSync(
  store: ReturnType<typeof createRunStore>,
  _coordinator: ReturnType<typeof createRunCoordinator>,
  mode: 'single' | 'parallel' | 'chain',
  unitStatus: 'completed' | 'interrupted' | 'failed',
  agent?: AgentConfig
): Promise<{ runId: string }> {
  const agentConfig: AgentConfig = agent ?? {
    name: 'test-agent',
    description: 'test',
    systemPrompt: '',
    source: 'builtin',
    filePath: '/tmp/test.md',
  };
  const fp = agentFingerprint(agentConfig);
  const isGrok = agentConfig.runtime === 'grok' || agentConfig.runtime === 'grok-acp';
  const unitId = mode === 'single' ? 'single' : 'parallel-0001';
  const request =
    mode === 'single'
      ? {
          mode: 'single' as const,
          agentScope: 'user' as const,
          agent: agentConfig.name,
          task: 'stored task',
        }
      : mode === 'parallel'
        ? {
            mode: 'parallel' as const,
            agentScope: 'user' as const,
            tasks: [{ agent: agentConfig.name, task: 'stored task' }],
          }
        : {
            mode: 'chain' as const,
            agentScope: 'user' as const,
            chain: [{ agent: agentConfig.name, task: 'stored task' }],
          };
  const created = await store.createRun({
    mode,
    agentScope: 'user',
    background: false,
    request,
    details: {
      mode,
      agentScope: 'user',
      projectAgentsDir: null,
      builtinAgentsDir: '/tmp',
      results: [],
    } as SubagentDetails,
    units: {
      [unitId]: {
        unitId,
        agent: agentConfig.name,
        agentFingerprint: fp,
        runtime: agentConfig.runtime ?? undefined,
        capability: (isGrok ? 'replay' : 'session') as 'session' | 'replay',
        status: unitStatus,
        attempt: 1,
        attempts: [],
        effectiveCwd: '/tmp',
      } as RunUnitRecord,
    },
  });
  await store.updateRun(created.runId, (r) => {
    r.status = unitStatus === 'completed' ? 'completed' : 'interrupted';
    r.units[unitId]!.status = unitStatus;
  });
  return { runId: created.runId };
}

const makeDetails = (
  results: SingleResult[],
  outputs?: Record<string, ChainOutputEntry>
): SubagentDetails => ({
  mode: 'chain',
  agentScope: 'user',
  projectAgentsDir: null,
  builtinAgentsDir: '/tmp',
  results,
  ...(outputs && Object.keys(outputs).length > 0 ? { outputs } : {}),
});

function makeCompletedResult(agent: string, text: string, step: number): SingleResult {
  return {
    agent,
    agentSource: 'builtin',
    task: '',
    exitCode: 0,
    status: 'completed',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text }],
      } as unknown as SingleResult['messages'][number],
    ],
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
    step,
    finalOutput: text,
  };
}

function makeInterruptedResult(agent: string, text: string, step: number): SingleResult {
  return {
    ...makeCompletedResult(agent, text, step),
    status: 'interrupted',
    exitCode: 1,
    stopReason: 'aborted',
  };
}

function makeUnitRecord(status: 'completed' | 'interrupted' | 'failed'): RunUnitRecord {
  return {
    unitId: 'test',
    agent: 'test',
    agentFingerprint: 'fp',
    runtime: undefined,
    capability: 'session',
    status,
    attempt: 1,
    attempts: [],
    effectiveCwd: '/tmp',
  };
}

function makeRunStepStub(calls: { agent: string; task: string }[]) {
  return (req: ChainStepRequest): Promise<SingleResult> => {
    calls.push({ agent: req.agent, task: req.task });
    return Promise.resolve(makeCompletedResult(req.agent, `output-${req.step}`, req.step));
  };
}

// --- Worktree tests (Task 5) ---

function makeGitRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pi-wt-test-'));
  spawnSync('git', ['init'], { cwd: dir, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.email', 'test@test.test'], { cwd: dir, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf-8' });
  writeFileSync(path.join(dir, 'README.md'), 'init');
  spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: dir, encoding: 'utf-8' });
  return dir;
}

describe('openAgentWorktree', () => {
  it('reopens a registered worktree beneath <repo>/.worktrees/', () => {
    const repo = makeGitRepo();
    try {
      const wt = createAgentWorktree(repo, 'test-agent', 0);
      const opened = openAgentWorktree(repo, wt.path);
      expect(opened.ok).toBe(true);
      if (opened.ok) {
        expect(opened.worktree.path).toBe(wt.path);
        expect(opened.worktree.repoRoot).toBe(path.resolve(repo));
      }
      removeAgentWorktree(wt);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects a missing worktree path', () => {
    const repo = makeGitRepo();
    try {
      const opened = openAgentWorktree(repo, path.join(repo, '.worktrees', 'nonexistent'));
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.code).toBe('worktree_unavailable');
        expect(opened.error).toContain('no longer exists');
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects a path outside <repo>/.worktrees/', () => {
    const repo = makeGitRepo();
    try {
      const opened = openAgentWorktree(repo, '/tmp/some-other-dir');
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.code).toBe('worktree_unavailable');
        expect(opened.error).toContain('outside');
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects an unregistered worktree path', () => {
    const repo = makeGitRepo();
    try {
      const fakeDir = path.join(repo, '.worktrees', 'fake');
      mkdirSync(fakeDir, { recursive: true });
      const opened = openAgentWorktree(repo, fakeDir);
      expect(opened.ok).toBe(false);
      if (!opened.ok) {
        expect(opened.code).toBe('worktree_unavailable');
        expect(opened.error).toContain('no longer registered');
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// --- Chain restore tests (Task 6) ---

describe('runChainWorkflow with restored state', () => {
  it('skips completed steps and only retries the interrupted one', async () => {
    const calls: { agent: string; task: string }[] = [];
    const chain: ChainItemInput[] = [
      { agent: 'step1', task: 'Do step 1', name: 'first' },
      { agent: 'step2', task: 'Use {outputs.first} output', name: 'second' },
      { agent: 'step3', task: 'Use {outputs.second} output' },
    ];
    const restoredResults: SingleResult[] = [
      makeCompletedResult('step1', 'step1-output', 1),
      makeInterruptedResult('step2', 'partial', 2),
    ];
    const restoredOutputs: Record<string, ChainOutputEntry> = {
      first: { text: 'step1-output', agent: 'step1', step: 1 },
    };
    const restoredLogicalSteps: ChainLogicalStep[] = [
      {
        kind: 'sequential',
        step: 1,
        agent: 'step1',
        task: 'Do step 1',
        status: 'completed',
      },
      {
        kind: 'sequential',
        step: 2,
        agent: 'step2',
        task: 'Use {outputs.first} output',
        status: 'interrupted',
      },
      {
        kind: 'sequential',
        step: 3,
        agent: 'step3',
        task: 'Use {outputs.second} output',
        status: 'queued',
      },
    ];

    const result = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: makeRunStepStub(calls),
      restored: {
        results: restoredResults,
        outputs: restoredOutputs,
        logicalSteps: restoredLogicalSteps,
        units: {
          'chain-0001': makeUnitRecord('completed'),
          'chain-0002': makeUnitRecord('interrupted'),
        },
      },
    });

    // Step 1 should NOT be called (completed). Steps 2 and 3 should be called.
    expect(calls.length).toBe(2);
    expect(calls[0].agent).toBe('step2');
    expect(calls[1].agent).toBe('step3');
    // The {outputs.first} template should resolve from restored output.
    expect(calls[0].task).toContain('step1-output');
    expect(result.isError).toBeUndefined();
  });

  it('rejects resume when all steps are completed (no-op)', async () => {
    const calls: { agent: string; task: string }[] = [];
    const chain: ChainItemInput[] = [
      { agent: 'step1', task: 'Do step 1', name: 'first' },
      { agent: 'step2', task: 'Use {outputs.first} output', name: 'second' },
      { agent: 'step3', task: 'Use {outputs.second} output' },
    ];
    const restoredResults: SingleResult[] = [
      makeCompletedResult('step1', 's1', 1),
      makeCompletedResult('step2', 's2', 2),
      makeCompletedResult('step3', 's3', 3),
    ];
    const restoredOutputs: Record<string, ChainOutputEntry> = {
      first: { text: 's1', agent: 'step1', step: 1 },
      second: { text: 's2', agent: 'step2', step: 2 },
    };
    const restoredLogicalSteps: ChainLogicalStep[] = [
      {
        kind: 'sequential',
        step: 1,
        agent: 'step1',
        task: 'Do step 1',
        status: 'completed',
      },
      {
        kind: 'sequential',
        step: 2,
        agent: 'step2',
        task: 'Use {outputs.first} output',
        status: 'completed',
      },
      {
        kind: 'sequential',
        step: 3,
        agent: 'step3',
        task: 'Use {outputs.second} output',
        status: 'completed',
      },
    ];

    const result = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: makeRunStepStub(calls),
      restored: {
        results: restoredResults,
        outputs: restoredOutputs,
        logicalSteps: restoredLogicalSteps,
        units: {},
      },
    });

    // No steps should be called.
    expect(calls.length).toBe(0);
    expect(result.isError).toBeUndefined();
  });

  it('restores {previous} from the last completed step', async () => {
    const calls: { agent: string; task: string }[] = [];
    const chain: ChainItemInput[] = [
      { agent: 'step1', task: 'Do step 1', name: 'first' },
      { agent: 'step2', task: 'Use {previous}', name: 'second' },
      { agent: 'step3', task: 'Use {outputs.second}' },
    ];
    const restoredResults: SingleResult[] = [
      makeCompletedResult('step1', 'previous-output', 1),
      makeInterruptedResult('step2', '', 2),
    ];
    const restoredOutputs: Record<string, ChainOutputEntry> = {
      first: { text: 'previous-output', agent: 'step1', step: 1 },
    };
    const restoredLogicalSteps: ChainLogicalStep[] = [
      {
        kind: 'sequential',
        step: 1,
        agent: 'step1',
        task: 'Do step 1',
        status: 'completed',
      },
      {
        kind: 'sequential',
        step: 2,
        agent: 'step2',
        task: 'Use {previous}',
        status: 'interrupted',
      },
      {
        kind: 'sequential',
        step: 3,
        agent: 'step3',
        task: 'Use {outputs.second}',
        status: 'queued',
      },
    ];

    await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: makeRunStepStub(calls),
      restored: {
        results: restoredResults,
        outputs: restoredOutputs,
        logicalSteps: restoredLogicalSteps,
        units: {},
      },
    });

    // Step 2 should receive the previous output from step 1.
    expect(calls[0].task).toContain('previous-output');
  });
});

// --- Resume preflight tests (Task 7) ---

describe('inspectResume', () => {
  it('rejects a completed run', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-resume-'));
    try {
      const store = createRunStore({ rootDir: tmpRoot });
      const coordinator = createRunCoordinator({ store });
      // Create a completed run.
      const { runId } = await startDurableRunSync(store, coordinator, 'single', 'completed');
      const result = inspectResume(runId, store, { agents: [] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('completed');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('rejects an unknown run id', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-resume-'));
    try {
      const store = createRunStore({ rootDir: tmpRoot });
      const result = inspectResume('run-nonexistent', store, { agents: [] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain('not_found');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('reports fingerprint mismatch as a blocking reason', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-resume-'));
    try {
      const store = createRunStore({ rootDir: tmpRoot });
      const coordinator = createRunCoordinator({ store });
      const agent: AgentConfig = {
        name: 'test-agent',
        description: 'test',
        systemPrompt: 'original',
        source: 'builtin',
        filePath: '/tmp/test.md',
      };
      const { runId } = await startDurableRunSync(
        store,
        coordinator,
        'single',
        'interrupted',
        agent
      );
      // Use an agent with a different system prompt -> fingerprint mismatch.
      const changedAgent: AgentConfig = { ...agent, systemPrompt: 'changed' };
      const result = inspectResume(runId, store, { agents: [changedAgent] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.blockingReasons.some((r) => r.includes('fingerprint mismatch'))).toBe(true);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('reports replay requirement without allowReplay', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-resume-'));
    try {
      const store = createRunStore({ rootDir: tmpRoot });
      const coordinator = createRunCoordinator({ store });
      const agent: AgentConfig = {
        name: 'grok-agent',
        description: 'grok',
        systemPrompt: '',
        source: 'builtin',
        filePath: '/tmp/grok.md',
        runtime: 'grok',
      };
      const { runId } = await startDurableRunSync(
        store,
        coordinator,
        'single',
        'interrupted',
        agent
      );
      const result = inspectResume(runId, store, {
        agents: [agent],
        allowReplay: false,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.requiresReplay).toBe(true);
        expect(result.blockingReasons.some((r) => r.includes('replay'))).toBe(true);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('blocks attempted Grok ACP units missing acpSessionId without allowReplay escape', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-resume-'));
    try {
      const store = createRunStore({ rootDir: tmpRoot });
      const coordinator = createRunCoordinator({ store });
      const agent: AgentConfig = {
        name: 'grok-acp-agent',
        description: 'grok-acp',
        systemPrompt: '',
        source: 'builtin',
        filePath: '/tmp/grok-acp.md',
        runtime: 'grok-acp',
      };
      const { runId } = await startDurableRunSync(
        store,
        coordinator,
        'single',
        'interrupted',
        agent
      );
      // Legacy attempted unit may still store capability "replay" without an ID.
      await store.updateRun(runId, (r) => {
        r.units.single!.runtime = 'grok-acp';
        r.units.single!.capability = 'replay';
        r.units.single!.effectiveCwd = tmpRoot;
        delete r.units.single!.acpSessionId;
      });
      const result = inspectResume(runId, store, {
        agents: [agent],
        allowReplay: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.requiresReplay).toBe(false);
        expect(result.blockingReasons.some((r) => r.includes('acp_session_unavailable'))).toBe(
          true
        );
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('allows never-started Grok ACP units without an ACP session ID', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-resume-'));
    try {
      const store = createRunStore({ rootDir: tmpRoot });
      const coordinator = createRunCoordinator({ store });
      const agent: AgentConfig = {
        name: 'grok-acp-agent',
        description: 'grok-acp',
        systemPrompt: '',
        source: 'builtin',
        filePath: '/tmp/grok-acp.md',
        runtime: 'grok-acp',
      };
      // Start as interrupted then rewrite to never-started queued for preflight.
      const { runId } = await startDurableRunSync(
        store,
        coordinator,
        'single',
        'interrupted',
        agent
      );
      await store.updateRun(runId, (r) => {
        r.status = 'interrupted';
        r.units.single!.runtime = 'grok-acp';
        r.units.single!.capability = 'session';
        r.units.single!.status = 'queued';
        r.units.single!.attempts = [];
        r.units.single!.effectiveCwd = tmpRoot;
        delete r.units.single!.acpSessionId;
      });
      const result = inspectResume(runId, store, { agents: [agent] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.requiresReplay).toBe(false);
        expect(result.blockingReasons).toEqual([]);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('allows attempted Grok ACP units with a stored acpSessionId without allowReplay', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-resume-'));
    try {
      const store = createRunStore({ rootDir: tmpRoot });
      const coordinator = createRunCoordinator({ store });
      const agent: AgentConfig = {
        name: 'grok-acp-agent',
        description: 'grok-acp',
        systemPrompt: '',
        source: 'builtin',
        filePath: '/tmp/grok-acp.md',
        runtime: 'grok-acp',
      };
      const { runId } = await startDurableRunSync(
        store,
        coordinator,
        'single',
        'interrupted',
        agent
      );
      await store.updateRun(runId, (r) => {
        r.units.single!.runtime = 'grok-acp';
        r.units.single!.capability = 'session';
        r.units.single!.acpSessionId = 'sess-stored';
        r.units.single!.effectiveCwd = tmpRoot;
      });
      const result = inspectResume(runId, store, { agents: [agent] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.requiresReplay).toBe(false);
        expect(result.blockingReasons).toEqual([]);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('blocks queued Grok ACP units that have attempt history but no acpSessionId', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-resume-'));
    try {
      const store = createRunStore({ rootDir: tmpRoot });
      const coordinator = createRunCoordinator({ store });
      const agent: AgentConfig = {
        name: 'grok-acp-agent',
        description: 'grok-acp',
        systemPrompt: '',
        source: 'builtin',
        filePath: '/tmp/grok-acp.md',
        runtime: 'grok-acp',
      };
      const { runId } = await startDurableRunSync(
        store,
        coordinator,
        'single',
        'interrupted',
        agent
      );
      // Re-queued after a prior attempt — not never-started despite status=queued.
      await store.updateRun(runId, (r) => {
        r.status = 'interrupted';
        r.units.single!.runtime = 'grok-acp';
        r.units.single!.capability = 'session';
        r.units.single!.status = 'queued';
        r.units.single!.attempt = 2;
        r.units.single!.attempts = [
          { attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 },
        ];
        r.units.single!.effectiveCwd = tmpRoot;
        delete r.units.single!.acpSessionId;
      });
      const result = inspectResume(runId, store, {
        agents: [agent],
        allowReplay: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.blockingReasons.some((b) => b.includes('acp_session_unavailable'))).toBe(
          true
        );
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('allows queued Grok ACP units with attempt history when acpSessionId is present', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-resume-'));
    try {
      const store = createRunStore({ rootDir: tmpRoot });
      const coordinator = createRunCoordinator({ store });
      const agent: AgentConfig = {
        name: 'grok-acp-agent',
        description: 'grok-acp',
        systemPrompt: '',
        source: 'builtin',
        filePath: '/tmp/grok-acp.md',
        runtime: 'grok-acp',
      };
      const { runId } = await startDurableRunSync(
        store,
        coordinator,
        'single',
        'interrupted',
        agent
      );
      await store.updateRun(runId, (r) => {
        r.status = 'interrupted';
        r.units.single!.runtime = 'grok-acp';
        r.units.single!.capability = 'session';
        r.units.single!.status = 'queued';
        r.units.single!.attempt = 2;
        r.units.single!.attempts = [
          { attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 },
        ];
        r.units.single!.acpSessionId = 'sess-after-history';
        r.units.single!.effectiveCwd = tmpRoot;
      });
      const result = inspectResume(runId, store, { agents: [agent] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.blockingReasons).toEqual([]);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('fail-closes attempted Pi units whose planned sessionFile does not exist on disk', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-resume-'));
    try {
      const store = createRunStore({ rootDir: tmpRoot });
      const coordinator = createRunCoordinator({ store });
      const agent: AgentConfig = {
        name: 'pi-agent',
        description: 'pi',
        systemPrompt: '',
        source: 'builtin',
        filePath: '/tmp/pi.md',
      };
      const { runId } = await startDurableRunSync(
        store,
        coordinator,
        'single',
        'interrupted',
        agent
      );
      const planned = path.join(tmpRoot, 'planned-missing.jsonl');
      await store.updateRun(runId, (r) => {
        r.units.single!.status = 'interrupted';
        r.units.single!.capability = 'session';
        r.units.single!.sessionFile = planned;
        r.units.single!.attempts = [
          { attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 },
        ];
        r.units.single!.effectiveCwd = tmpRoot;
      });
      const result = inspectResume(runId, store, { agents: [agent] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.blockingReasons.some((b) => b.includes('session file missing'))).toBe(true);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('fail-closes attempted Pi units with sessionFile but unestablished original prompt', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-resume-'));
    try {
      const store = createRunStore({ rootDir: tmpRoot });
      const coordinator = createRunCoordinator({ store });
      const agent: AgentConfig = {
        name: 'pi-agent',
        description: 'pi',
        systemPrompt: '',
        source: 'builtin',
        filePath: '/tmp/pi.md',
      };
      const { runId } = await startDurableRunSync(
        store,
        coordinator,
        'single',
        'interrupted',
        agent
      );
      const sessionFile = path.join(tmpRoot, 'fork-existing.jsonl');
      writeFileSync(sessionFile, '{}\n');
      await store.updateRun(runId, (r) => {
        r.units.single!.status = 'interrupted';
        r.units.single!.capability = 'session';
        r.units.single!.sessionFile = sessionFile;
        r.units.single!.sessionPromptEstablished = false;
        r.units.single!.attempts = [
          { attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 },
        ];
        r.units.single!.effectiveCwd = tmpRoot;
      });
      const result = inspectResume(runId, store, { agents: [agent] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.blockingReasons.some((b) => b.includes('session_prompt_unestablished'))).toBe(
          true
        );
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('allows never-started Pi units with a planned sessionFile path (preflight)', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-resume-'));
    try {
      const store = createRunStore({ rootDir: tmpRoot });
      const coordinator = createRunCoordinator({ store });
      const agent: AgentConfig = {
        name: 'pi-agent',
        description: 'pi',
        systemPrompt: '',
        source: 'builtin',
        filePath: '/tmp/pi.md',
      };
      const { runId } = await startDurableRunSync(
        store,
        coordinator,
        'single',
        'interrupted',
        agent
      );
      const planned = path.join(tmpRoot, 'planned-not-prompted.jsonl');
      await store.updateRun(runId, (r) => {
        r.status = 'interrupted';
        r.units.single!.status = 'queued';
        r.units.single!.attempts = [];
        r.units.single!.capability = 'session';
        r.units.single!.sessionFile = planned;
        r.units.single!.effectiveCwd = tmpRoot;
      });
      const result = inspectResume(runId, store, { agents: [agent] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.blockingReasons).toEqual([]);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('treats an absent continuationTasks field as an empty history (backward compatible)', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-resume-'));
    try {
      const store = createRunStore({ rootDir: tmpRoot });
      const coordinator = createRunCoordinator({ store });
      const agent: AgentConfig = {
        name: 'test-agent',
        description: 'test',
        systemPrompt: '',
        source: 'builtin',
        filePath: '/tmp/test.md',
      };
      const { runId } = await startDurableRunSync(
        store,
        coordinator,
        'single',
        'interrupted',
        agent
      );
      // Ensure session exists for session-capable preflight.
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.loaded.record.continuationTasks).toBeUndefined();
      const sessionFile = path.join(tmpRoot, 'session.jsonl');
      writeFileSync(sessionFile, '{}\n');
      await store.updateRun(runId, (r) => {
        r.units.single!.sessionFile = sessionFile;
        r.units.single!.effectiveCwd = tmpRoot;
      });
      const result = inspectResume(runId, store, { agents: [agent] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.blockingReasons).toEqual([]);
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('does not mutate continuationTasks when preflight fails', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-resume-'));
    try {
      const store = createRunStore({ rootDir: tmpRoot });
      const coordinator = createRunCoordinator({ store });
      const agent: AgentConfig = {
        name: 'grok-agent',
        description: 'grok',
        systemPrompt: '',
        source: 'builtin',
        filePath: '/tmp/grok.md',
        runtime: 'grok',
      };
      const { runId } = await startDurableRunSync(
        store,
        coordinator,
        'single',
        'interrupted',
        agent
      );
      // Preflight blocks on missing allowReplay; inspect is non-mutating.
      const result = inspectResume(runId, store, {
        agents: [agent],
        allowReplay: false,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.blockingReasons.length).toBeGreaterThan(0);
      const loaded = store.getRun(runId);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.loaded.record.continuationTasks).toBeUndefined();
      expect(loaded.loaded.record.status).toBe('interrupted');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

// --- Fanout selective resume ---

function fanoutUnit(
  step: number,
  index: number,
  status: RunUnitRecord['status'],
  result?: SingleResult
): RunUnitRecord {
  const unitId = chainFanoutUnitId(step, index);
  return {
    unitId,
    agent: 'worker',
    agentFingerprint: 'fp',
    runtime: undefined,
    capability: 'session',
    status,
    step,
    fanoutIndex: index,
    attempt: 1,
    attempts:
      status === 'queued'
        ? []
        : [
            {
              attempt: 1,
              status: status === 'interrupted' ? 'interrupted' : status,
              startedAt: 1,
              finishedAt: status === 'running' ? undefined : 2,
            },
          ],
    effectiveCwd: '/tmp',
    ...(status !== 'queued' && status !== 'skipped'
      ? { sessionFile: `/tmp/sessions/${unitId}.jsonl` }
      : {}),
    ...(result ? { result } : {}),
  };
}

function makeFanoutResult(
  index: number,
  status: SingleResult['status'],
  text: string
): SingleResult {
  return {
    agent: 'worker',
    agentSource: 'builtin',
    task: `item ${index}`,
    exitCode: status === 'completed' ? 0 : 1,
    status,
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
    fanout: { index, count: 4, itemTask: `item ${index}` },
    finalOutput: text,
  };
}

describe('isNeverStartedUnit', () => {
  it('is true only for queued/skipped with empty attempts', () => {
    expect(isNeverStartedUnit({ status: 'queued', attempts: [] })).toBe(true);
    expect(isNeverStartedUnit({ status: 'skipped', attempts: [] })).toBe(true);
    expect(
      isNeverStartedUnit({
        status: 'queued',
        attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
      })
    ).toBe(false);
    expect(
      isNeverStartedUnit({
        status: 'skipped',
        attempts: [{ attempt: 1, status: 'failed', startedAt: 1, finishedAt: 2 }],
      })
    ).toBe(false);
    expect(
      isNeverStartedUnit({
        status: 'interrupted',
        attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
      })
    ).toBe(false);
    expect(isNeverStartedUnit({ status: 'running', attempts: [] })).toBe(false);
  });
});

describe('incrementIncompleteAttempts', () => {
  it('does not increment never-started queued/skipped units', () => {
    const units: Record<string, RunUnitRecord> = {
      a: fanoutUnit(2, 0, 'queued'),
      b: {
        ...fanoutUnit(2, 1, 'skipped'),
        attempts: [],
      },
      c: fanoutUnit(2, 2, 'interrupted'),
    };
    incrementIncompleteAttempts(units);
    expect(units.a!.attempt).toBe(1);
    expect(units.a!.status).toBe('queued');
    expect(units.b!.attempt).toBe(1);
    expect(units.b!.status).toBe('queued');
    expect(units.c!.attempt).toBe(2);
    expect(units.c!.status).toBe('queued');
  });

  it('increments queued units that already have attempt history', () => {
    const units: Record<string, RunUnitRecord> = {
      requeued: {
        ...fanoutUnit(2, 0, 'queued'),
        attempt: 2,
        attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
      },
    };
    incrementIncompleteAttempts(units);
    expect(units.requeued!.attempt).toBe(3);
    expect(units.requeued!.status).toBe('queued');
  });
});

describe('reconcileDeadOwnerUnits', () => {
  it('leaves never-started queued units queued and does not inflate attempt', () => {
    const units: Record<string, RunUnitRecord> = {
      never: {
        ...fanoutUnit(2, 0, 'queued'),
        attempts: [],
        attempt: 1,
      },
      running: {
        ...fanoutUnit(2, 1, 'running'),
        attempts: [{ attempt: 1, status: 'running', startedAt: 1 }],
        attempt: 1,
      },
      claimedQueued: {
        ...fanoutUnit(2, 2, 'queued'),
        attempts: [{ attempt: 1, status: 'interrupted', startedAt: 1, finishedAt: 2 }],
        attempt: 2,
      },
    };
    reconcileDeadOwnerUnits(units);
    expect(units.never!.status).toBe('queued');
    expect(units.never!.attempt).toBe(1);
    expect(units.running!.status).toBe('interrupted');
    expect(units.claimedQueued!.status).toBe('interrupted');
    // Attempt counters are not touched by reconciliation.
    expect(units.running!.attempt).toBe(1);
    expect(units.claimedQueued!.attempt).toBe(2);
  });
});

describe('validateFanoutResumeState', () => {
  function baseRecord(
    units: Record<string, RunUnitRecord>,
    fanouts?: Record<string, WorkflowFanoutState>
  ): AgentRunRecordV1 {
    return {
      version: 1,
      runId: 'r1',
      mode: 'chain',
      status: 'interrupted',
      request: {
        mode: 'chain',
        agentScope: 'user',
        chain: [{ agent: 'seed', task: 'seed' }],
      },
      background: false,
      agentScope: 'user',
      createdAt: 0,
      updatedAt: 0,
      details: {
        mode: 'chain',
        agentScope: 'user',
        projectAgentsDir: null,
        builtinAgentsDir: '/tmp',
        results: [],
        chain: {
          totalSteps: 2,
          steps: [
            {
              kind: 'sequential',
              step: 1,
              agent: 'seed',
              task: 'seed',
              status: 'completed',
            },
            {
              kind: 'fanout',
              step: 2,
              agent: 'worker',
              taskTemplate: 't',
              status: 'interrupted',
              sourceOutput: 'seed',
              sourcePath: '/items',
              collectName: 'out',
              executedCount: 4,
              completedCount: 2,
              failedCount: 0,
              runningCount: 0,
              queuedCount: 1,
              skippedCount: 0,
            },
          ],
        },
      },
      units,
      ...(fanouts ? { workflowState: { fanouts } } : {}),
      eventsFile: 'events.jsonl',
    };
  }

  it('rejects incomplete fanout without a stored mapping', () => {
    const units = {
      [chainFanoutUnitId(2, 0)]: fanoutUnit(
        2,
        0,
        'completed',
        makeFanoutResult(0, 'completed', 'a')
      ),
      [chainFanoutUnitId(2, 1)]: fanoutUnit(2, 1, 'interrupted'),
    };
    const reasons = validateFanoutResumeState(baseRecord(units));
    expect(reasons.some((r) => r.includes('stored_fanout_state_unavailable'))).toBe(true);
  });

  it('rejects completed unit missing terminal result', () => {
    const ids = [0, 1].map((i) => chainFanoutUnitId(2, i));
    const mapping: WorkflowFanoutState = {
      step: 2,
      items: ['a', 'b'],
      unitIds: ids,
    };
    const units = {
      [ids[0]!]: fanoutUnit(2, 0, 'completed'), // no result
      [ids[1]!]: fanoutUnit(2, 1, 'interrupted'),
    };
    const reasons = validateFanoutResumeState(
      baseRecord(units, { [chainFanoutStepId(2)]: mapping })
    );
    expect(reasons.some((r) => r.includes('stored_output_invalid'))).toBe(true);
  });

  it('rejects non-canonical unit id mappings', () => {
    const mapping: WorkflowFanoutState = {
      step: 2,
      items: ['a'],
      unitIds: ['chain-0002-fanout-9999'],
    };
    const units = {
      'chain-0002-fanout-9999': {
        ...fanoutUnit(2, 0, 'interrupted'),
        unitId: 'chain-0002-fanout-9999',
      },
    };
    const reasons = validateFanoutResumeState(
      baseRecord(units, { [chainFanoutStepId(2)]: mapping })
    );
    expect(reasons.some((r) => r.includes('not canonical'))).toBe(true);
  });
});

describe('runChainWorkflow selective fanout resume', () => {
  it('retries only incomplete items in original order with correct attempts', async () => {
    const calls: { agent: string; fanoutIndex?: number; task: string }[] = [];
    const items = ['a', 'b', 'c', 'd'];
    const unitIds = items.map((_, i) => chainFanoutUnitId(2, i));
    const completed0 = makeFanoutResult(0, 'completed', 'out-0');
    const completed1 = makeFanoutResult(1, 'completed', 'out-1');
    const units: Record<string, RunUnitRecord> = {
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
        result: makeCompletedResult('seed', JSON.stringify({ items }), 1),
      },
      [unitIds[0]!]: fanoutUnit(2, 0, 'completed', completed0),
      [unitIds[1]!]: fanoutUnit(2, 1, 'completed', completed1),
      [unitIds[2]!]: fanoutUnit(2, 2, 'interrupted'),
      [unitIds[3]!]: fanoutUnit(2, 3, 'queued'),
    };
    // Simulate resume setup attempt semantics.
    incrementIncompleteAttempts(units);
    expect(units[unitIds[2]!]!.attempt).toBe(2);
    expect(units[unitIds[3]!]!.attempt).toBe(1);

    const chain: ChainItemInput[] = [
      {
        agent: 'seed',
        task: 'seed',
        name: 'seed',
        outputSchema: {
          type: 'object',
          required: ['items'],
          properties: { items: { type: 'array', items: { type: 'string' } } },
        },
      },
      {
        expand: { from: { output: 'seed', path: '/items' } },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'out' },
      },
    ];

    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req: ChainStepRequest) => {
        calls.push({ agent: req.agent, fanoutIndex: req.fanoutIndex, task: req.task });
        return makeFanoutResult(req.fanoutIndex ?? 0, 'completed', `retry-${req.fanoutIndex}`);
      },
      restored: {
        results: [
          makeCompletedResult('seed', JSON.stringify({ items: ['MUTATED'] }), 1),
          completed0,
          completed1,
          makeFanoutResult(2, 'interrupted', 'partial'),
        ],
        outputs: {
          seed: {
            text: JSON.stringify({ items: ['MUTATED'] }),
            structured: { items: ['MUTATED'] },
            agent: 'seed',
            step: 1,
          },
        },
        logicalSteps: [
          {
            kind: 'sequential',
            step: 1,
            agent: 'seed',
            task: 'seed',
            status: 'completed',
          },
          {
            kind: 'fanout',
            step: 2,
            agent: 'worker',
            taskTemplate: 'Process {item}',
            status: 'interrupted',
            sourceOutput: 'seed',
            sourcePath: '/items',
            collectName: 'out',
            executedCount: 4,
            completedCount: 2,
            failedCount: 0,
            runningCount: 0,
            queuedCount: 1,
            skippedCount: 0,
          },
        ],
        units,
        fanouts: {
          [chainFanoutStepId(2)]: {
            step: 2,
            items, // original expansion, not MUTATED
            unitIds,
          },
        },
      },
    });

    // Only incomplete items 2 and 3 dispatch; seed and completed fanout items do not.
    expect(calls.map((c) => c.fanoutIndex)).toEqual([2, 3]);
    expect(calls.every((c) => c.task.includes('Process'))).toBe(true);
    // Tasks come from original items c,d — not MUTATED upstream.
    expect(calls[0]!.task).toContain('c');
    expect(calls[1]!.task).toContain('d');
    expect(res.isError).toBeUndefined();
    const fanoutResults = res.details.results.filter((r) => r.fanout);
    expect(fanoutResults.map((r) => r.fanout?.index)).toEqual([0, 1, 2, 3]);
    expect(fanoutResults[0]!.finalOutput).toBe('out-0');
    expect(fanoutResults[1]!.finalOutput).toBe('out-1');
    expect(fanoutResults[2]!.finalOutput).toBe('retry-2');
    expect(fanoutResults[3]!.finalOutput).toBe('retry-3');
  });

  it('does not dispatch when all fanout items are already completed', async () => {
    const calls: number[] = [];
    const items = ['a', 'b'];
    const unitIds = items.map((_, i) => chainFanoutUnitId(2, i));
    const units: Record<string, RunUnitRecord> = {
      [unitIds[0]!]: fanoutUnit(2, 0, 'completed', makeFanoutResult(0, 'completed', 'a')),
      [unitIds[1]!]: fanoutUnit(2, 1, 'completed', makeFanoutResult(1, 'completed', 'b')),
    };
    const chain: ChainItemInput[] = [
      { agent: 'seed', task: 'seed', name: 'seed' },
      {
        expand: { from: { output: 'seed', path: '/items' } },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'out' },
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        if (req.fanoutIndex !== undefined) calls.push(req.fanoutIndex);
        return makeFanoutResult(req.fanoutIndex ?? 0, 'completed', 'x');
      },
      restored: {
        results: [],
        outputs: {
          seed: { text: '[]', structured: { items: ['MUTATED'] }, agent: 'seed', step: 1 },
        },
        logicalSteps: [
          { kind: 'sequential', step: 1, agent: 'seed', task: 'seed', status: 'completed' },
          {
            kind: 'fanout',
            step: 2,
            agent: 'worker',
            taskTemplate: 'Process {item}',
            status: 'interrupted',
            sourceOutput: 'seed',
            sourcePath: '/items',
            collectName: 'out',
            executedCount: 2,
            completedCount: 2,
            failedCount: 0,
            runningCount: 0,
            queuedCount: 0,
            skippedCount: 0,
          },
        ],
        units,
        fanouts: {
          [chainFanoutStepId(2)]: { step: 2, items, unitIds },
        },
      },
    });
    expect(calls).toEqual([]);
    expect(res.isError).toBeUndefined();
    expect(res.details.results.filter((r) => r.fanout)).toHaveLength(2);
  });

  it('preserves maxItems skipped count from restored logical step', async () => {
    const items = ['a']; // only scheduled subset stored
    const unitIds = [chainFanoutUnitId(2, 0)];
    const units: Record<string, RunUnitRecord> = {
      [unitIds[0]!]: fanoutUnit(2, 0, 'interrupted'),
    };
    incrementIncompleteAttempts(units);
    const chain: ChainItemInput[] = [
      { agent: 'seed', task: 'seed', name: 'seed' },
      {
        expand: { from: { output: 'seed', path: '/items' }, maxItems: 1 },
        parallel: { agent: 'worker', task: 'Process {item}' },
        collect: { name: 'out' },
      },
    ];
    const res = await runChainWorkflow({
      chain,
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) =>
        makeFanoutResult(req.fanoutIndex ?? 0, 'completed', `ok-${req.fanoutIndex}`),
      restored: {
        results: [],
        outputs: {
          seed: {
            text: '',
            structured: { items: ['a', 'b', 'c'] },
            agent: 'seed',
            step: 1,
          },
        },
        logicalSteps: [
          { kind: 'sequential', step: 1, agent: 'seed', task: 'seed', status: 'completed' },
          {
            kind: 'fanout',
            step: 2,
            agent: 'worker',
            taskTemplate: 'Process {item}',
            status: 'interrupted',
            sourceOutput: 'seed',
            sourcePath: '/items',
            collectName: 'out',
            executedCount: 1,
            completedCount: 0,
            failedCount: 0,
            runningCount: 0,
            queuedCount: 0,
            skippedCount: 2,
          },
        ],
        units,
        fanouts: {
          [chainFanoutStepId(2)]: { step: 2, items, unitIds },
        },
      },
    });
    const fanoutStep = res.details.chain?.steps[1];
    expect(fanoutStep?.kind).toBe('fanout');
    if (fanoutStep?.kind === 'fanout') {
      expect(fanoutStep.skippedCount).toBe(2);
      expect(fanoutStep.executedCount).toBe(1);
    }
  });

  it('after cancel-style partial progress, resume schedules only non-completed children', async () => {
    const items = ['a', 'b', 'c', 'd'];
    const unitIds = items.map((_, i) => chainFanoutUnitId(2, i));
    // Item 0 completed, 1 interrupted (started), 2+3 never started (queued).
    const units: Record<string, RunUnitRecord> = {
      [unitIds[0]!]: fanoutUnit(2, 0, 'completed', makeFanoutResult(0, 'completed', 'done-0')),
      [unitIds[1]!]: fanoutUnit(2, 1, 'interrupted'),
      [unitIds[2]!]: fanoutUnit(2, 2, 'queued'),
      [unitIds[3]!]: fanoutUnit(2, 3, 'queued'),
    };
    incrementIncompleteAttempts(units);
    expect(units[unitIds[1]!]!.attempt).toBe(2);
    expect(units[unitIds[2]!]!.attempt).toBe(1);
    expect(units[unitIds[3]!]!.attempt).toBe(1);

    const dispatched: number[] = [];
    await runChainWorkflow({
      chain: [
        { agent: 'seed', task: 'seed', name: 'seed' },
        {
          expand: { from: { output: 'seed', path: '/items' } },
          parallel: { agent: 'worker', task: 'Process {item}' },
          collect: { name: 'out' },
        },
      ],
      signal: undefined,
      onUpdate: undefined,
      makeDetails,
      runStep: async (req) => {
        dispatched.push(req.fanoutIndex!);
        return makeFanoutResult(req.fanoutIndex!, 'completed', `r-${req.fanoutIndex}`);
      },
      restored: {
        results: [makeFanoutResult(0, 'completed', 'done-0')],
        outputs: {
          seed: { text: '', structured: { items }, agent: 'seed', step: 1 },
        },
        logicalSteps: [
          { kind: 'sequential', step: 1, agent: 'seed', task: 'seed', status: 'completed' },
          {
            kind: 'fanout',
            step: 2,
            agent: 'worker',
            taskTemplate: 'Process {item}',
            status: 'cancelled',
            sourceOutput: 'seed',
            sourcePath: '/items',
            collectName: 'out',
            executedCount: 4,
            completedCount: 1,
            failedCount: 0,
            runningCount: 0,
            queuedCount: 2,
            skippedCount: 0,
          },
        ],
        units,
        fanouts: {
          [chainFanoutStepId(2)]: { step: 2, items, unitIds },
        },
      },
    });
    expect(dispatched.sort()).toEqual([1, 2, 3]);
  });
});
