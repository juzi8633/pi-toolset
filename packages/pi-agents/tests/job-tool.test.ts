// ABOUTME: Tests for the agent_job tool - list, get, and resume inspection.
// ABOUTME: Uses a temporary RunStore root; no real Pi processes are spawned.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeJobTool } from '../src/job-tool.ts';
import { createRunStore } from '../src/run-store.ts';
import { createRunCoordinator, agentFingerprint } from '../src/run-coordinator.ts';
import type { AgentConfig } from '../src/agents.ts';
import type { SubagentDetails } from '../src/types.ts';
import type { RunUnitRecord } from '../src/run-types.ts';

function makeAgent(): AgentConfig {
  return {
    name: 'test-agent',
    description: 'test',
    systemPrompt: '',
    source: 'builtin',
    filePath: '/tmp/test.md',
  };
}

function makeDetails(): SubagentDetails {
  return {
    mode: 'single',
    agentScope: 'user',
    projectAgentsDir: null,
    builtinAgentsDir: '/tmp',
    results: [],
  };
}

async function createTestRun(
  store: ReturnType<typeof createRunStore>,
  unitStatus: 'completed' | 'interrupted' = 'interrupted'
): Promise<string> {
  const agent = makeAgent();
  const sessionFile = path.join(store.rootDir, 'test-session.jsonl');
  // Ensure the session file parent dir exists (the store root already does).
  writeFileSync(sessionFile, '{}\n');
  const created = await store.createRun({
    mode: 'single',
    agentScope: 'user',
    background: false,
    request: { mode: 'single', agentScope: 'user' },
    details: makeDetails(),
    units: {
      single: {
        unitId: 'single',
        agent: agent.name,
        agentFingerprint: agentFingerprint(agent),
        runtime: undefined,
        capability: 'session',
        sessionFile,
        status: unitStatus,
        attempt: 1,
        attempts: [],
        effectiveCwd: store.rootDir,
      } as RunUnitRecord,
    },
  });
  await store.updateRun(created.runId, (r) => {
    r.status = unitStatus;
  });
  return created.runId;
}

describe('executeJobTool', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-job-test-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('lists runs with status and unit counts', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    await createTestRun(store, 'interrupted');
    await createTestRun(store, 'completed');

    const result = await executeJobTool(
      { action: 'list' },
      { runStore: store, runCoordinator: coordinator, agents: [] }
    );
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('interrupted');
    expect(text).toContain('completed');
  });

  it('filters runs by status', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    await createTestRun(store, 'interrupted');
    await createTestRun(store, 'completed');

    const result = await executeJobTool(
      { action: 'list', status: 'interrupted' },
      { runStore: store, runCoordinator: coordinator, agents: [] }
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('interrupted');
    expect(text).not.toContain('completed');
  });

  it('gets detailed status for a run', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const runId = await createTestRun(store, 'interrupted');

    const result = await executeJobTool(
      { action: 'get', runId },
      { runStore: store, runCoordinator: coordinator, agents: [] }
    );
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(runId);
    expect(text).toContain('interrupted');
    expect(text).toContain('single');
  });

  it('returns error for unknown run id on get', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });

    const result = await executeJobTool(
      { action: 'get', runId: 'run-nonexistent' },
      { runStore: store, runCoordinator: coordinator, agents: [] }
    );
    expect(result.isError).toBe(true);
  });

  it('inspects resume eligibility for an interrupted run', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const runId = await createTestRun(store, 'interrupted');
    const agent = makeAgent();

    const result = await executeJobTool(
      { action: 'resume', runId },
      { runStore: store, runCoordinator: coordinator, agents: [agent] }
    );
    expect(result.isError).toBeUndefined();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('ready to resume');
  });

  it('rejects resume for a completed run', async () => {
    const store = createRunStore({ rootDir: tmpRoot });
    const coordinator = createRunCoordinator({ store });
    const runId = await createTestRun(store, 'completed');

    const result = await executeJobTool(
      { action: 'resume', runId },
      { runStore: store, runCoordinator: coordinator, agents: [] }
    );
    expect(result.isError).toBe(true);
  });
});
