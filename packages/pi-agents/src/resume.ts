// ABOUTME: Resume preflight and runtime dispatch - inspects stored runs and continues interrupted work.
// ABOUTME: Verifies agent fingerprints, artifacts, and replay capability before claiming and executing.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AgentConfig } from './agents.ts';
import { agentFingerprint, chainFanoutStepId, chainFanoutUnitId } from './run-coordinator.ts';
import type { RunCoordinator } from './run-coordinator.ts';
import type { RunStore } from './run-store.ts';
import { createRunLifecycle } from './run-lifecycle.ts';
import type {
  AgentRunRecordV1,
  ResumeCapability,
  RunUnitRecord,
  RunStatus,
  WorkflowFanoutState,
} from './run-types.ts';

export type InspectResumeResult =
  | {
      ok: true;
      runId: string;
      status: RunStatus;
      mode: 'single' | 'parallel' | 'chain';
      incompleteUnits: Array<{
        unitId: string;
        agent: string;
        status: string;
        capability: ResumeCapability;
        attempt: number;
      }>;
      requiresReplay: boolean;
      blockingReasons: string[];
    }
  | { ok: false; runId: string; reason: string };

export interface InspectResumeOptions {
  agents: AgentConfig[];
  /** Allow replay-capable units to re-run from the beginning. */
  allowReplay?: boolean;
}

/**
 * Validate persisted fanout mappings for incomplete fanout work. Rejects legacy
 * partial state without a mapping and completed children missing terminal results.
 */
export function validateFanoutResumeState(record: AgentRunRecordV1): string[] {
  const reasons: string[] = [];
  const fanouts = record.workflowState?.fanouts ?? {};
  const incompleteFanoutSteps = new Set<number>();

  for (const step of record.details.chain?.steps ?? []) {
    if (step.kind === 'fanout' && step.status !== 'completed') {
      incompleteFanoutSteps.add(step.step);
    }
  }

  // Units with fanout positions that are not completed imply incomplete fanout work.
  for (const unit of Object.values(record.units)) {
    if (unit.fanoutIndex !== undefined && unit.step !== undefined && unit.status !== 'completed') {
      incompleteFanoutSteps.add(unit.step);
    }
  }

  // Presentation-only fanout results without a mapping also count as unsafe legacy evidence.
  for (const result of record.details.results) {
    if (result.fanout !== undefined && typeof result.step === 'number') {
      const key = chainFanoutStepId(result.step);
      if (!fanouts[key] && result.status !== 'completed') {
        incompleteFanoutSteps.add(result.step);
      }
    }
  }

  for (const step of incompleteFanoutSteps) {
    const key = chainFanoutStepId(step);
    const mapping = fanouts[key];
    if (!mapping) {
      reasons.push(`stored_fanout_state_unavailable: step ${step} has no persisted expansion`);
      continue;
    }
    reasons.push(...validateFanoutMapping(record, key, mapping));
  }

  // Also validate mappings that have incomplete children even if the logical step is absent.
  for (const [key, mapping] of Object.entries(fanouts)) {
    if (incompleteFanoutSteps.has(mapping.step)) continue;
    const hasIncompleteChild = mapping.unitIds.some((id) => {
      const unit = record.units[id];
      return unit !== undefined && unit.status !== 'completed';
    });
    if (hasIncompleteChild) {
      reasons.push(...validateFanoutMapping(record, key, mapping));
    }
  }

  return reasons;
}

function validateFanoutMapping(
  record: AgentRunRecordV1,
  key: string,
  mapping: WorkflowFanoutState
): string[] {
  const reasons: string[] = [];
  if (mapping.items.length !== mapping.unitIds.length) {
    reasons.push(
      `stored_fanout_state_unavailable: ${key} items.length (${mapping.items.length}) !== unitIds.length (${mapping.unitIds.length})`
    );
  }
  const seen = new Set<string>();
  for (let i = 0; i < mapping.unitIds.length; i++) {
    const id = mapping.unitIds[i]!;
    if (seen.has(id)) {
      reasons.push(`stored_fanout_state_unavailable: ${key} duplicate unit id ${id}`);
      continue;
    }
    seen.add(id);
    let expected: string;
    try {
      expected = chainFanoutUnitId(mapping.step, i);
    } catch {
      reasons.push(`stored_fanout_state_unavailable: ${key} invalid step ${mapping.step}`);
      continue;
    }
    if (id !== expected) {
      reasons.push(
        `stored_fanout_state_unavailable: ${key} unit id ${id} is not canonical ${expected}`
      );
      continue;
    }
    const unit = record.units[id];
    if (!unit) {
      reasons.push(`stored_fanout_state_unavailable: ${key} missing unit record ${id}`);
      continue;
    }
    if (unit.step !== mapping.step || unit.fanoutIndex !== i) {
      reasons.push(
        `stored_fanout_state_unavailable: ${id} step/fanoutIndex mismatch (expected ${mapping.step}/${i})`
      );
    }
    if (unit.status === 'completed' && !unit.result) {
      reasons.push(`stored_output_invalid: completed unit ${id} has no terminal result`);
    } else if (unit.status === 'completed' && unit.result) {
      // Completed unit must carry a completed terminal status on the result.
      if (unit.result.status !== 'completed') {
        reasons.push(
          `stored_output_invalid: completed unit ${id} result status is ${unit.result.status}`
        );
      }
    }
  }
  return reasons;
}

/** Inspect a stored run for resume eligibility without mutating it. */
export function inspectResume(
  runId: string,
  store: RunStore,
  options: InspectResumeOptions
): InspectResumeResult {
  const loaded = store.getRun(runId);
  if (!loaded.ok) {
    return { ok: false, runId, reason: `run_not_found: ${loaded.error.message}` };
  }
  const record = loaded.loaded.record;
  if (record.version !== 1) {
    return { ok: false, runId, reason: `unsupported_schema_version: ${record.version}` };
  }
  if (record.status === 'completed') {
    return { ok: false, runId, reason: 'run_already_completed' };
  }

  const units = Object.values(record.units);
  const incomplete = units.filter((u) => u.status !== 'completed');

  if (incomplete.length === 0) {
    return { ok: false, runId, reason: 'no_incomplete_units' };
  }

  const blockingReasons: string[] = [];
  let requiresReplay = false;

  // Fanout mapping integrity before per-unit preflight.
  blockingReasons.push(...validateFanoutResumeState(record));

  for (const unit of incomplete) {
    // Verify effective cwd exists (worktree or original workspace).
    if (!fs.existsSync(unit.effectiveCwd)) {
      blockingReasons.push(`unit ${unit.unitId}: working directory missing: ${unit.effectiveCwd}`);
    }

    // Verify agent exists and fingerprint matches.
    const agent = options.agents.find((a) => a.name === unit.agent);
    if (!agent) {
      blockingReasons.push(`unit ${unit.unitId}: agent "${unit.agent}" not found`);
      continue;
    }
    if (agentFingerprint(agent) !== unit.agentFingerprint) {
      blockingReasons.push(`unit ${unit.unitId}: agent "${unit.agent}" fingerprint mismatch`);
    }

    // Check replay capability.
    if (unit.capability === 'replay') {
      requiresReplay = true;
      if (!options.allowReplay) {
        blockingReasons.push(`unit ${unit.unitId}: requires replay (allowReplay not set)`);
      }
    }

    // Verify session file for session-capable Pi units. Units that never
    // started (queued/skipped) legitimately lack a session; only require the
    // file when the unit was already running, interrupted, or failed.
    if (unit.capability === 'session') {
      const needsSession = unit.status !== 'queued' && unit.status !== 'skipped';
      if (needsSession) {
        if (!unit.sessionFile) {
          blockingReasons.push(
            `unit ${unit.unitId}: session file unavailable (session_unavailable)`
          );
        } else if (!fs.existsSync(unit.sessionFile)) {
          blockingReasons.push(`unit ${unit.unitId}: session file missing: ${unit.sessionFile}`);
        }
      }
    }

    // Verify worktree is live and still registered for isolated units.
    if (unit.worktreePath) {
      if (!fs.existsSync(unit.worktreePath)) {
        blockingReasons.push(`unit ${unit.unitId}: worktree missing: ${unit.worktreePath}`);
      } else {
        // Derive repo root from the worktree path (<repo>/.worktrees/<name>)
        const repoRoot = path.resolve(unit.worktreePath, '..', '..');
        const list = spawnSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
          encoding: 'utf-8',
        });
        if (list.status !== 0) {
          blockingReasons.push(
            `unit ${unit.unitId}: cannot verify worktree: ${(list.stderr || '').trim()}`
          );
        } else {
          const registered = list.stdout
            .split('\n')
            .filter((line) => line.startsWith('worktree '))
            .map((line) => path.resolve(line.slice('worktree '.length).trim()));
          if (!registered.includes(path.resolve(unit.worktreePath))) {
            blockingReasons.push(
              `unit ${unit.unitId}: worktree no longer registered: ${unit.worktreePath}`
            );
          }
        }
      }
    }
  }

  return {
    ok: true,
    runId,
    status: record.status,
    mode: record.mode,
    incompleteUnits: incomplete.map((u) => ({
      unitId: u.unitId,
      agent: u.agent,
      status: u.status,
      capability: u.capability,
      attempt: u.attempt,
    })),
    requiresReplay,
    blockingReasons,
  };
}

export type ResumeRunResult =
  | { ok: true; runId: string }
  | { ok: false; runId: string; reason: string };

export interface ResumeRunOptions {
  store: RunStore;
  coordinator: RunCoordinator;
  ctx: ExtensionContext;
  agents: AgentConfig[];
  allowReplay?: boolean;
  signal?: AbortSignal;
}

/**
 * Resume an interrupted run: run read-only preflight, claim the run, then
 * delegate to the caller for workflow execution. Returns the loaded record
 * and claim info on success; the caller is responsible for executing the
 * workflow and finalizing.
 */
export async function preflightAndClaim(
  runId: string,
  options: ResumeRunOptions
): Promise<
  | {
      ok: true;
      record: AgentRunRecordV1;
      claimId: string;
      ticket: number;
      inspection: InspectResumeResult;
    }
  | { ok: false; runId: string; reason: string }
> {
  const { store, coordinator, agents, allowReplay } = options;

  // Read-only preflight.
  const inspection = inspectResume(runId, store, { agents, allowReplay });
  if (!inspection.ok) return inspection;
  if (inspection.blockingReasons.length > 0) {
    return {
      ok: false,
      runId,
      reason: `preflight_failed: ${inspection.blockingReasons.join('; ')}`,
    };
  }

  // Check the run is not actively owned by another live process.
  if (coordinator.isActive(runId)) {
    return { ok: false, runId, reason: 'run_active' };
  }

  // Claim the run.
  const claim = await store.claimRun(runId);
  if (!claim.ok) {
    return { ok: false, runId, reason: `claim_failed: ${claim.error.message}` };
  }

  const loaded = store.getRun(runId);
  if (!loaded.ok) {
    await store.releaseRun(runId, claim.claimId);
    return { ok: false, runId, reason: 'run_not_found_after_claim' };
  }

  return {
    ok: true,
    record: loaded.loaded.record,
    claimId: claim.claimId,
    ticket: claim.ticket,
    inspection,
  };
}

/** Build a restored durable context for a resumed run. */
export function buildRestoredDurable(
  record: AgentRunRecordV1,
  store: RunStore
): {
  runId: string;
  lifecycle: ReturnType<typeof createRunLifecycle>;
  units: Record<string, RunUnitRecord>;
  unitIds: string[];
  sessionsDir: string;
} {
  const runId = record.runId;
  const lifecycle = createRunLifecycle(runId);
  const units = { ...record.units };
  const unitIds = Object.keys(units);
  const sessionsDir = path.join(store.getRunDir(runId), 'sessions');

  return { runId, lifecycle, units, unitIds, sessionsDir };
}

/**
 * Prepare incomplete units for resume. Never-started units (queued/skipped with
 * no attempt history) stay at attempt 1 without fabricating history. Units that
 * previously started close any open attempt and advance attempt.
 */
export function incrementIncompleteAttempts(units: Record<string, RunUnitRecord>): void {
  const now = Date.now();
  for (const unit of Object.values(units)) {
    if (unit.status === 'completed') continue;

    const neverStarted =
      (unit.status === 'queued' || unit.status === 'skipped') && unit.attempts.length === 0;
    if (neverStarted) {
      unit.status = 'queued';
      continue;
    }

    // Finalize an unterminated running attempt left behind by a hard crash;
    // a gracefully interrupted unit already has a terminal attempt summary.
    const last = unit.attempts[unit.attempts.length - 1];
    if (last && last.status === 'running' && last.finishedAt === undefined) {
      last.status = unit.status === 'interrupted' ? 'interrupted' : 'failed';
      last.finishedAt = now;
    }
    unit.attempt += 1;
    unit.status = 'queued';
  }
}
