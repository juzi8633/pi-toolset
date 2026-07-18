// ABOUTME: Resume preflight and runtime dispatch - inspects stored runs and continues interrupted work.
// ABOUTME: Verifies agent fingerprints, session artifacts, and worktrees before claiming and executing.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { AgentConfig } from './agents.ts';
import { DEFAULT_RUNTIME, GROK_ACP_RUNTIME } from './constants.ts';
import { agentFingerprint, chainFanoutStepId, chainFanoutUnitId } from './run-coordinator.ts';
import type { RunCoordinator } from './run-coordinator.ts';
import type { RunStore } from './run-store.ts';
import { createRunLifecycle } from './run-lifecycle.ts';
import type { AgentRunRecordV1, ResumeCapability, RunUnitRecord, RunStatus } from './run-types.ts';

/** Pi-default-normalized runtime for durable unit or agent config values. */
function normalizeRuntime(runtime: unknown): string {
  return typeof runtime === 'string' ? runtime : DEFAULT_RUNTIME;
}

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
      blockingReasons: string[];
    }
  | { ok: false; runId: string; reason: string };

export interface InspectResumeOptions {
  agents: AgentConfig[];
  /**
   * True when the resume request supplies a non-empty continuation instruction
   * (public `task`). Required to reopen a fully completed run.
   */
  hasContinuation?: boolean;
}

/**
 * Never-started means the unit is still `queued` or `skipped` with an empty
 * attempt history. Queued/skipped units that already have attempt entries are
 * attempted (e.g. re-queued after a prior run) and must not create first sessions.
 */
export function isNeverStartedUnit(unit: Pick<RunUnitRecord, 'status' | 'attempts'>): boolean {
  return (unit.status === 'queued' || unit.status === 'skipped') && unit.attempts.length === 0;
}

export interface ValidateFanoutResumeOptions {
  /**
   * When true, completed logical fanout steps must also have a frozen
   * `workflowState.fanouts` mapping that passes canonical validation.
   * Used only for all-completed runs resumed with a continuation task.
   */
  requireCompletedFanoutMappings?: boolean;
}

/** True when a stored request chain entry is a fanout step (expand without agent). */
function isStoredRequestFanoutStep(step: unknown): boolean {
  return step !== null && typeof step === 'object' && 'expand' in step && !('agent' in step);
}

/**
 * Validate persisted fanout mappings for incomplete fanout work. Rejects legacy
 * partial state without a mapping and completed children missing terminal results.
 * Optionally also requires frozen mappings for completed fanout steps when an
 * all-completed run is reopened with a continuation.
 */
export function validateFanoutResumeState(
  record: AgentRunRecordV1,
  options?: ValidateFanoutResumeOptions
): string[] {
  const reasons: string[] = [];
  const fanouts = record.workflowState?.fanouts ?? {};
  const stepsToValidate = new Set<number>();

  for (const step of record.details.chain?.steps ?? []) {
    if (step.kind !== 'fanout') continue;
    if (step.status !== 'completed') {
      stepsToValidate.add(step.step);
    } else if (options?.requireCompletedFanoutMappings) {
      stepsToValidate.add(step.step);
    }
  }

  // Durable units are authoritative for which fanout steps exist. Incomplete
  // children always require mapping validation; when completed-run continuation
  // requires frozen mappings, completed children also contribute steps even if
  // `details.chain.steps` is absent or stale.
  for (const unit of Object.values(record.units)) {
    if (unit.fanoutIndex === undefined || unit.step === undefined) continue;
    if (unit.status !== 'completed' || options?.requireCompletedFanoutMappings) {
      stepsToValidate.add(unit.step);
    }
  }

  // Presentation-only fanout results without a mapping also count as unsafe legacy evidence.
  for (const result of record.details.results) {
    if (result.fanout !== undefined && typeof result.step === 'number') {
      const key = chainFanoutStepId(result.step);
      if (
        !fanouts[key] &&
        (result.status !== 'completed' || options?.requireCompletedFanoutMappings)
      ) {
        stepsToValidate.add(result.step);
      }
    }
  }

  // Completed continuation must cover every request-topology fanout step,
  // including empty fanouts that never produced durable children.
  if (options?.requireCompletedFanoutMappings) {
    const chain = record.request.chain ?? [];
    for (let i = 0; i < chain.length; i++) {
      if (isStoredRequestFanoutStep(chain[i])) {
        stepsToValidate.add(i + 1);
      }
    }
  }

  const validatedKeys = new Set<string>();
  for (const step of stepsToValidate) {
    const key = chainFanoutStepId(step);
    const mapping = fanouts[key];
    if (!mapping) {
      reasons.push(`stored_fanout_state_unavailable: step ${step} has no persisted expansion`);
      continue;
    }
    reasons.push(...validateFanoutMapping(record, key, mapping));
    validatedKeys.add(key);
  }

  // Validate every persisted mapping key independently. An alias or wrong key
  // for a step must fail closed even when the canonical mapping already passed.
  for (const [key, mapping] of Object.entries(fanouts)) {
    if (validatedKeys.has(key)) continue;
    reasons.push(...validateFanoutMapping(record, key, mapping));
  }

  return reasons;
}

/**
 * Validate one frozen fanout mapping as a complete canonical bijection with
 * durable children for that step. Key must equal chainFanoutStepId(mapping.step).
 * Accepts untrusted persisted shapes and never throws on malformed data.
 */
function validateFanoutMapping(record: AgentRunRecordV1, key: string, mapping: unknown): string[] {
  const reasons: string[] = [];

  if (mapping === null || typeof mapping !== 'object' || Array.isArray(mapping)) {
    reasons.push(`stored_fanout_state_unavailable: ${key} mapping is not an object`);
    return reasons;
  }
  const raw = mapping as Record<string, unknown>;
  if (typeof raw.step !== 'number' || !Number.isInteger(raw.step) || raw.step < 1) {
    reasons.push(`stored_fanout_state_unavailable: ${key} invalid step ${String(raw.step)}`);
    return reasons;
  }
  if (!Array.isArray(raw.unitIds)) {
    reasons.push(`stored_fanout_state_unavailable: ${key} unitIds must be an array`);
    return reasons;
  }
  const hasItems = Array.isArray(raw.items);
  const hasItemsRef =
    raw.itemsRef !== null && typeof raw.itemsRef === 'object' && !Array.isArray(raw.itemsRef);
  if (hasItems === hasItemsRef) {
    reasons.push(
      `stored_fanout_state_unavailable: ${key} must set exactly one of items or itemsRef`
    );
    return reasons;
  }
  // Only string unit ids participate in bijection checks; reject non-strings.
  if (raw.unitIds.some((id) => typeof id !== 'string')) {
    reasons.push(`stored_fanout_state_unavailable: ${key} unitIds must be strings`);
    return reasons;
  }

  const step = raw.step;
  // For itemsRef, item count is taken from unitIds (bijection); full content is
  // re-verified at resolve time after claim.
  const items = hasItems ? (raw.items as unknown[]) : new Array(raw.unitIds.length).fill(null);
  const unitIds = raw.unitIds as string[];

  // mapping.step must name an actual fanout entry in the stored request chain.
  const chain = record.request.chain ?? [];
  const requestStep = chain[step - 1];
  if (requestStep === undefined || !isStoredRequestFanoutStep(requestStep)) {
    reasons.push(
      `stored_fanout_state_unavailable: ${key} step ${step} is not a fanout request step`
    );
    return reasons;
  }

  let expectedKey: string;
  try {
    expectedKey = chainFanoutStepId(step);
  } catch {
    reasons.push(`stored_fanout_state_unavailable: ${key} invalid step ${step}`);
    return reasons;
  }
  if (key !== expectedKey) {
    reasons.push(
      `stored_fanout_state_unavailable: ${key} key/step mismatch (expected ${expectedKey} for step ${step})`
    );
  }

  if (items.length !== unitIds.length) {
    reasons.push(
      `stored_fanout_state_unavailable: ${key} items.length (${items.length}) !== unitIds.length (${unitIds.length})`
    );
  }

  const seen = new Set<string>();
  for (let i = 0; i < unitIds.length; i++) {
    const id = unitIds[i]!;
    if (seen.has(id)) {
      reasons.push(`stored_fanout_state_unavailable: ${key} duplicate unit id ${id}`);
      continue;
    }
    seen.add(id);
    let expected: string;
    try {
      expected = chainFanoutUnitId(step, i);
    } catch {
      reasons.push(`stored_fanout_state_unavailable: ${key} invalid step ${step}`);
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
    if (unit.step !== step || unit.fanoutIndex !== i) {
      reasons.push(
        `stored_fanout_state_unavailable: ${id} step/fanoutIndex mismatch (expected ${step}/${i})`
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

  // Complete bijection: every durable fanout child for this step must appear in
  // the mapping at its canonical index; reject truncated/extra durable sets.
  const durableChildren = Object.values(record.units).filter(
    (u) => u.step === step && u.fanoutIndex !== undefined
  );
  if (durableChildren.length !== unitIds.length) {
    reasons.push(
      `stored_fanout_state_unavailable: ${key} durable children (${durableChildren.length}) !== mapping unitIds (${unitIds.length})`
    );
  }
  for (const unit of durableChildren) {
    const index = unit.fanoutIndex!;
    let expectedId: string;
    try {
      expectedId = chainFanoutUnitId(step, index);
    } catch {
      reasons.push(
        `stored_fanout_state_unavailable: ${key} durable unit ${unit.unitId} has invalid fanoutIndex ${index}`
      );
      continue;
    }
    if (unit.unitId !== expectedId) {
      reasons.push(
        `stored_fanout_state_unavailable: ${key} durable unit ${unit.unitId} is not canonical ${expectedId}`
      );
      continue;
    }
    if (unitIds[index] !== unit.unitId) {
      reasons.push(
        `stored_fanout_state_unavailable: ${key} durable unit ${unit.unitId} missing or misplaced in mapping`
      );
    }
  }

  return reasons;
}

/** Collect all reachable artifact refs that must be verified before resume. */
function collectReachableRefs(
  record: AgentRunRecordV1
): Array<{ label: string; ref: import('./run-types.ts').RunArtifactRefV1 }> {
  const refs: Array<{ label: string; ref: import('./run-types.ts').RunArtifactRefV1 }> = [];
  for (const [id, unit] of Object.entries(record.units)) {
    const r = unit.result;
    if (r?.finalOutputRef) refs.push({ label: `unit ${id} finalOutputRef`, ref: r.finalOutputRef });
    if (r?.structuredOutputRef)
      refs.push({ label: `unit ${id} structuredOutputRef`, ref: r.structuredOutputRef });
  }
  for (const result of record.details.results) {
    if (result.finalOutputRef)
      refs.push({ label: `details result finalOutputRef`, ref: result.finalOutputRef });
    if (result.structuredOutputRef)
      refs.push({ label: `details result structuredOutputRef`, ref: result.structuredOutputRef });
  }
  if (record.details.outputs) {
    for (const [name, entry] of Object.entries(record.details.outputs)) {
      if (entry.textRef) refs.push({ label: `output ${name} textRef`, ref: entry.textRef });
      if (entry.structuredRef)
        refs.push({ label: `output ${name} structuredRef`, ref: entry.structuredRef });
    }
  }
  for (const [key, mapping] of Object.entries(record.workflowState?.fanouts ?? {})) {
    if (mapping.itemsRef) refs.push({ label: `fanout ${key} itemsRef`, ref: mapping.itemsRef });
  }
  return refs;
}

/** Verify all reachable artifact refs in a stored run record are readable. */
async function verifyReachableRefs(
  runId: string,
  store: RunStore,
  record: AgentRunRecordV1
): Promise<string[]> {
  const reasons: string[] = [];
  const refs = collectReachableRefs(record);
  for (const { label, ref } of refs) {
    if (ref.runId !== runId) {
      reasons.push(`stored_output_invalid: ${label} references run ${ref.runId} (cross-run)`);
      continue;
    }
    try {
      if (ref.mediaType === 'text/plain; charset=utf-8') {
        await store.readTextArtifact(runId, ref);
      } else if (ref.mediaType === 'application/json') {
        await store.readJsonArtifact(runId, ref);
      } else {
        reasons.push(`stored_output_invalid: ${label} has unknown mediaType ${ref.mediaType}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'artifact unavailable';
      reasons.push(`stored_output_invalid: ${label} unreadable: ${message}`);
    }
  }
  return reasons;
}

/**
 * Resolve every persisted fanout itemsRef against the store and verify it is an
 * array whose length matches the frozen mapping unitIds. Returns resolved
 * runtime-only items keyed by fanout step id, or blocking reasons on failure.
 * Durable records retain itemsRef; hydration is never written back.
 */
export async function resolveAndVerifyFanoutItems(
  runId: string,
  store: RunStore,
  record: AgentRunRecordV1
): Promise<
  | { ok: true; resolved: Record<string, { step: number; items: unknown[]; unitIds: string[] }> }
  | { ok: false; reasons: string[] }
> {
  const fanouts = record.workflowState?.fanouts ?? {};
  const resolved: Record<string, { step: number; items: unknown[]; unitIds: string[] }> = {};
  const reasons: string[] = [];
  for (const [key, mapping] of Object.entries(fanouts)) {
    if (!mapping.itemsRef) {
      // Inline items: verify length matches unitIds without re-reading.
      const items = mapping.items ?? [];
      if (!Array.isArray(items)) {
        reasons.push(`stored_fanout_state_unavailable: ${key} items is not an array`);
        continue;
      }
      if (items.length !== mapping.unitIds.length) {
        reasons.push(
          `stored_fanout_state_unavailable: ${key} items.length (${items.length}) !== unitIds.length (${mapping.unitIds.length})`
        );
        continue;
      }
      resolved[key] = {
        step: mapping.step,
        items: items.slice(),
        unitIds: mapping.unitIds.slice(),
      };
      continue;
    }
    const ref = mapping.itemsRef;
    if (ref.runId !== runId) {
      reasons.push(
        `stored_output_invalid: fanout ${key} itemsRef references run ${ref.runId} (cross-run)`
      );
      continue;
    }
    if (ref.mediaType !== 'application/json') {
      reasons.push(`stored_output_invalid: fanout ${key} itemsRef has mediaType ${ref.mediaType}`);
      continue;
    }
    let value: unknown;
    try {
      value = await store.readJsonArtifact(runId, ref);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'artifact unavailable';
      reasons.push(`stored_output_invalid: fanout ${key} itemsRef unreadable: ${message}`);
      continue;
    }
    if (!Array.isArray(value)) {
      reasons.push(`stored_output_invalid: fanout ${key} itemsRef resolved to non-array`);
      continue;
    }
    if (value.length !== mapping.unitIds.length) {
      reasons.push(
        `stored_output_invalid: fanout ${key} itemsRef length (${value.length}) !== unitIds.length (${mapping.unitIds.length})`
      );
      continue;
    }
    resolved[key] = { step: mapping.step, items: value, unitIds: mapping.unitIds.slice() };
  }
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, resolved };
}

/** Inspect a stored run for resume eligibility without mutating it. */
export async function inspectResume(
  runId: string,
  store: RunStore,
  options: InspectResumeOptions
): Promise<InspectResumeResult> {
  const loaded = store.getRun(runId);
  if (!loaded.ok) {
    return { ok: false, runId, reason: `run_not_found: ${loaded.error.message}` };
  }
  const record = loaded.loaded.record;
  return inspectResumeRecord(runId, record, store, options);
}

/**
 * Verify a single in-hand record for resume eligibility without rereading run.json.
 * Used for both the preflight load and the fresh post-claim record so a race
 * that corrupts the run between preflight and claim fails safely on the exact
 * object later consumed. Reads only artifact refs through the store.
 */
export async function inspectResumeRecord(
  runId: string,
  record: AgentRunRecordV1,
  store: RunStore,
  options: InspectResumeOptions
): Promise<InspectResumeResult> {
  if (record.version !== 1) {
    return { ok: false, runId, reason: `unsupported_schema_version: ${record.version}` };
  }

  const units = Object.values(record.units);
  // Every non-completed unit is a selective resume target, including skipped.
  const incomplete = units.filter((u) => u.status !== 'completed');
  // completed_without_continuation applies only when every unit is completed.
  const fullyCompleted = incomplete.length === 0;
  if (fullyCompleted && !options.hasContinuation) {
    const hasCompleted = units.some((u) => u.status === 'completed');
    if (hasCompleted) {
      return { ok: false, runId, reason: 'completed_without_continuation' };
    }
  }
  // Incomplete (including skipped) units are selective targets. Only when every
  // unit is truly completed do we treat completed units as continuation targets.
  const resumeTargets =
    incomplete.length > 0 ? incomplete : units.filter((u) => u.status === 'completed');

  if (resumeTargets.length === 0) {
    return { ok: false, runId, reason: 'no_incomplete_units' };
  }

  const blockingReasons: string[] = [];
  // Fanout mapping integrity before per-unit preflight. Fully completed runs
  // reopened with a continuation must also have frozen mappings for completed
  // fanout steps so claim/mutation cannot proceed without them.
  blockingReasons.push(
    ...validateFanoutResumeState(record, {
      requireCompletedFanoutMappings: fullyCompleted && Boolean(options.hasContinuation),
    })
  );

  // Verify all reachable artifact refs are readable before claim.
  blockingReasons.push(...(await verifyReachableRefs(runId, store, record)));

  for (const unit of resumeTargets) {
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

    // Effective dispatch runtime must match durable unit runtime (Pi-default
    // normalized). Dispatch uses request override when present, otherwise the
    // fingerprint-matched agent runtime — same resolution as resume tool path.
    const durableRuntime = normalizeRuntime(unit.runtime);
    const dispatchRuntime =
      record.request.runtime !== undefined
        ? normalizeRuntime(record.request.runtime)
        : normalizeRuntime(agent.runtime);
    if (durableRuntime !== dispatchRuntime) {
      blockingReasons.push(
        `unit ${unit.unitId}: runtime mismatch (durable ${durableRuntime}, dispatch ${dispatchRuntime})`
      );
      continue;
    }

    // Only true never-started units may lack session artifacts. Queued/skipped
    // with prior attempt history are attempted and must have session identity.
    const needsSessionArtifact = !isNeverStartedUnit(unit);

    // Grok ACP: attempted units require a stored protocol session ID. Never-started
    // units may create their first session during resume. Attempted units without
    // an ID are blocked (never normalize/create a replacement session).
    if (durableRuntime === GROK_ACP_RUNTIME) {
      if (needsSessionArtifact) {
        const acpId = unit.acpSessionId?.trim();
        if (!acpId) {
          blockingReasons.push(
            `unit ${unit.unitId}: ACP session unavailable (acp_session_unavailable)`
          );
        }
      }
    } else if (unit.capability === 'session') {
      // Pi (and other session-capable non-Grok runtimes): require a persisted
      // session file that exists on disk for attempted units. Planned paths that
      // were stamped before the native file/history existed fail closed so resume
      // neither sends continuation-only nor silently replays the original task.
      // sessionFile existence alone is not enough: original prompt must be
      // established (`sessionPromptEstablished !== false`). Explicit false means
      // stamp-before-prompt crash window — fail closed, never continuation-only
      // and never auto-replay original. Legacy units without the field remain
      // admissible when the session file exists.
      if (needsSessionArtifact) {
        if (!unit.sessionFile) {
          blockingReasons.push(
            `unit ${unit.unitId}: session file unavailable (session_unavailable)`
          );
        } else if (!fs.existsSync(unit.sessionFile)) {
          blockingReasons.push(`unit ${unit.unitId}: session file missing: ${unit.sessionFile}`);
        } else if (unit.sessionPromptEstablished === false) {
          blockingReasons.push(
            `unit ${unit.unitId}: original prompt not established (session_prompt_unestablished)`
          );
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
    incompleteUnits: resumeTargets.map((u) => ({
      unitId: u.unitId,
      agent: u.agent,
      status: u.status,
      capability: u.capability,
      attempt: u.attempt,
    })),
    blockingReasons,
  };
}

export type ResumeRunResult =
  { ok: true; runId: string } | { ok: false; runId: string; reason: string };

export interface ResumeRunOptions {
  store: RunStore;
  coordinator: RunCoordinator;
  ctx: ExtensionContext;
  agents: AgentConfig[];
  /** Non-empty continuation instruction present on the resume request. */
  hasContinuation?: boolean;
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
  const { store, coordinator, agents, hasContinuation } = options;

  // Read-only preflight.
  const inspection = await inspectResume(runId, store, { agents, hasContinuation });
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
 * When every unit is already completed, mark them interrupted so a finished
 * run can accept continuation work. No-op when any unit is still incomplete
 * (including skipped) so selective resume does not re-open finished siblings.
 */
export function reopenCompletedUnitsForResume(units: Record<string, RunUnitRecord>): void {
  const values = Object.values(units);
  const hasIncomplete = values.some((u) => u.status !== 'completed');
  if (hasIncomplete) return;
  for (const unit of values) {
    if (unit.status === 'completed') {
      unit.status = 'interrupted';
    }
  }
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

    if (isNeverStartedUnit(unit)) {
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

/**
 * Mark units interrupted when reconciling a dead-owner run. Never-started
 * queued units (no attempt history) stay queued so resume does not require a
 * session or inflate attempt counters.
 */
export function reconcileDeadOwnerUnits(units: Record<string, RunUnitRecord>): void {
  for (const unit of Object.values(units)) {
    if (unit.status === 'running') {
      unit.status = 'interrupted';
    } else if (unit.status === 'queued' && unit.attempts.length > 0) {
      unit.status = 'interrupted';
    }
  }
}
