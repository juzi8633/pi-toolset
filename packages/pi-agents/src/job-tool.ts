// ABOUTME: Execution logic for the `agent_job` tool - list, get, and resume durable runs.
// ABOUTME: Returns compact model-visible text with full records in tool details for rendering.

import { inspectResume } from './resume.ts';
import type { RunCoordinator } from './run-coordinator.ts';
import type { RunStore } from './run-store.ts';
import type { RunUnitRecord } from './run-types.ts';
import type { SubagentDetails } from './types.ts';
import { type Static } from '@earendil-works/pi-ai';
import { JobParams } from './job-schema.ts';
import type { StatusFilter } from './job-schema.ts';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';

type JobParamsInput = Static<typeof JobParams>;

const MAX_OUTPUT_CHARS = 50_000;
const MAX_OUTPUT_LINES = 2000;

function truncateOutput(text: string): string {
  const lines = text.split('\n');
  if (lines.length > MAX_OUTPUT_LINES) {
    return lines.slice(0, MAX_OUTPUT_LINES).join('\n') + '\n[truncated]';
  }
  if (text.length > MAX_OUTPUT_CHARS) {
    return text.slice(0, MAX_OUTPUT_CHARS) + '\n[truncated]';
  }
  return text;
}

function unitStatusSummary(units: Record<string, RunUnitRecord>): {
  completed: number;
  total: number;
} {
  const total = Object.keys(units).length;
  const completed = Object.values(units).filter((u) => u.status === 'completed').length;
  return { completed, total };
}

function capabilityLabel(units: Record<string, RunUnitRecord>): string {
  const caps = Object.values(units).map((u) => u.capability);
  if (caps.every((c) => c === 'session')) return 'session';
  if (caps.every((c) => c === 'replay')) return 'replay';
  return 'mixed';
}

export interface ExecuteJobToolOptions {
  runStore: RunStore;
  runCoordinator: RunCoordinator;
  agents: import('./agents.ts').AgentConfig[];
  /** Called to execute a resumed workflow; receives allowReplay and returns the tool result. */
  executeResume?: (
    allowReplay: boolean
  ) => Promise<AgentToolResult<SubagentDetails> & { isError?: boolean }>;
}

export async function executeJobTool(
  params: JobParamsInput,
  options: ExecuteJobToolOptions
): Promise<AgentToolResult<SubagentDetails> & { isError?: boolean }> {
  const { runStore, runCoordinator, agents, executeResume } = options;

  if (params.action === 'list') {
    return listRuns(runStore, params.status, params.limit ?? 20);
  }

  if (params.action === 'get') {
    return getRun(runStore, params.runId);
  }

  if (params.action === 'resume') {
    return resumeRun(
      runStore,
      runCoordinator,
      agents,
      params.runId,
      params.allowReplay ?? false,
      executeResume
    );
  }

  return errorResult(`Unknown action: ${(params as { action: string }).action}`);
}

async function listRuns(
  store: RunStore,
  statusFilter?: StatusFilter,
  limit?: number
): Promise<AgentToolResult<SubagentDetails> & { isError?: boolean }> {
  const clamped = Math.min(Math.max(limit ?? 20, 1), 100);
  const allRuns = await store.listRuns();
  // Filter before slicing so matching runs are not skipped by pagination.
  const filtered = statusFilter
    ? allRuns.filter((r) => 'record' in r && r.record.status === statusFilter)
    : allRuns;
  const runs = filtered.slice(0, clamped);

  const lines: string[] = ['Run ID | Mode | Status | Units | Capability | Updated'];
  for (const entry of runs) {
    if (!('record' in entry)) continue;
    const r = entry.record;
    const { completed, total } = unitStatusSummary(r.units);
    const cap = capabilityLabel(r.units);
    const updated = new Date(r.updatedAt).toISOString().slice(0, 19);
    lines.push(
      `${r.runId} | ${r.mode} | ${r.status} | ${completed}/${total} | ${cap} | ${updated}`
    );
  }

  if (lines.length === 1) {
    lines.push('(no runs found)');
  }

  const text = truncateOutput(lines.join('\n'));
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

function getRun(
  store: RunStore,
  runId: string
): AgentToolResult<SubagentDetails> & { isError?: boolean } {
  const loaded = store.getRun(runId);
  if (!loaded.ok) {
    return errorResult(`Run not found: ${runId} (${loaded.error.message})`);
  }
  const record = loaded.loaded.record;
  const lines: string[] = [
    `Run: ${record.runId}`,
    `Mode: ${record.mode}`,
    `Status: ${record.status}`,
  ];

  const { completed, total } = unitStatusSummary(record.units);
  lines.push(`Units: ${completed}/${total} completed`);

  if (record.lastError) {
    lines.push(`Last error: ${record.lastError}`);
  }

  lines.push('');
  lines.push('Units:');
  for (const unit of Object.values(record.units)) {
    const parts = [
      `  ${unit.unitId}: ${unit.status}`,
      `agent=${unit.agent}`,
      `attempt=${unit.attempt}`,
      `capability=${unit.capability}`,
    ];
    if (unit.runtime) parts.push(`runtime=${unit.runtime}`);
    if (unit.sessionFile) parts.push(`session=yes`);
    if (unit.worktreePath) parts.push(`worktree=yes`);
    lines.push(parts.join(' '));
  }

  if (
    record.status === 'interrupted' ||
    record.status === 'failed' ||
    record.status === 'cancelled'
  ) {
    lines.push('');
    lines.push(`To resume: agent_job({ action: "resume", runId: "${record.runId}" })`);
  }

  const text = truncateOutput(lines.join('\n'));
  return {
    content: [{ type: 'text', text }],
    details: {
      mode: 'single',
      agentScope: 'user',
      projectAgentsDir: null,
      builtinAgentsDir: '/builtin',
      results: [],
      run: {
        runId: record.runId,
        status: record.status,
        resumable: record.status !== 'completed',
        capability: capabilityLabel(record.units) as 'session' | 'replay' | 'mixed',
      },
    },
  };
}

async function resumeRun(
  store: RunStore,
  coordinator: RunCoordinator,
  agents: import('./agents.ts').AgentConfig[],
  runId: string,
  allowReplay: boolean,
  executeResume?: ExecuteJobToolOptions['executeResume']
): Promise<AgentToolResult<SubagentDetails> & { isError?: boolean }> {
  const inspection = inspectResume(runId, store, { agents, allowReplay });
  if (!inspection.ok) {
    return errorResult(`Cannot resume: ${inspection.reason}`);
  }
  if (inspection.blockingReasons.length > 0) {
    return errorResult(`Cannot resume: ${inspection.blockingReasons.join('; ')}`);
  }
  if (coordinator.isActive(runId)) {
    return errorResult('Cannot resume: run is currently active');
  }
  if (!executeResume) {
    // Return inspection result when execution is not wired (e.g. tests).
    const lines: string[] = [
      `Run ${runId} is ready to resume.`,
      `Mode: ${inspection.mode}`,
      `Incomplete units: ${inspection.incompleteUnits.length}`,
      `Requires replay: ${inspection.requiresReplay}`,
    ];
    for (const unit of inspection.incompleteUnits) {
      lines.push(
        `  ${unit.unitId}: ${unit.agent} (${unit.status}, attempt ${unit.attempt}, ${unit.capability})`
      );
    }
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      details: {
        mode: 'single',
        agentScope: 'user',
        projectAgentsDir: null,
        builtinAgentsDir: '/builtin',
        results: [],
      },
    };
  }
  // Execute the resumed workflow through the injected callback.
  return executeResume(allowReplay);
}

function errorResult(
  message: string
): AgentToolResult<SubagentDetails> & { isError?: boolean } & { isError?: boolean } {
  return {
    content: [{ type: 'text', text: message }],
    details: {
      mode: 'single',
      agentScope: 'user',
      projectAgentsDir: null,
      builtinAgentsDir: '/builtin',
      results: [],
    },
    isError: true,
  };
}
