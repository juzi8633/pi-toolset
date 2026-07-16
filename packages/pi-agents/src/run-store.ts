// ABOUTME: Durable run store — versioned snapshots, event log, and append-only ticket claims.
// ABOUTME: All paths resolve under ~/.pi/agent/@balaenis/pi-agents/runs/; tests inject a temp root.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { DEFAULT_RUNTIME, GROK_ACP_RUNTIME } from './constants.ts';
import { chainFanoutUnitId, chainStepUnitId, generateUnitIds, pad } from './run-coordinator.ts';
import type {
  AgentRunRecordV1,
  ClaimOwner,
  ClaimResult,
  ClaimTerminal,
  CorruptRunEntry,
  ListRunsResult,
  LoadedRun,
  RunLifecycleEvent,
  RunStoreError,
} from './run-types.ts';
import { RUN_RECORD_VERSION } from './run-types.ts';

/** Fixed-width decimal ticket width; preserves lexical ordering of claim directories. */
const TICKET_WIDTH = 16;

const RUN_STATUS_VALUES = new Set([
  'queued',
  'running',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
]);

/** Durable unit/attempt statuses accepted for resume (includes skipped). */
const UNIT_STATUS_VALUES = new Set([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'skipped',
  'interrupted',
]);

/** Durable runtimes accepted on current records; absent means the Pi default. */
const ALLOWED_DURABLE_RUNTIMES = new Set<string>([DEFAULT_RUNTIME, GROK_ACP_RUNTIME]);

/** Durable resume capabilities accepted on current records (session-only). */
const ALLOWED_DURABLE_CAPABILITIES = new Set<string>(['session']);

function isAllowedDurableRuntime(runtime: unknown): boolean {
  return typeof runtime === 'string' && ALLOWED_DURABLE_RUNTIMES.has(runtime);
}

function isAllowedDurableCapability(capability: unknown): boolean {
  return typeof capability === 'string' && ALLOWED_DURABLE_CAPABILITIES.has(capability);
}

/**
 * Minimum durable SingleResult shell: non-null non-array object with `messages` array.
 * Accepts legacy populated messages and compact empty messages; optional presentation
 * is validated separately when present.
 *
 * When `unitStatus` is `completed`, rejects contradictory result shells that would
 * redispatch a completed unit (status running/failed/…, exitCode -1, or status-less
 * non-zero exitCode). Message entries must be non-null objects so post-claim snapshot
 * normalization cannot throw on primitives.
 */
function validateResultShell(
  result: unknown,
  pathLabel: string,
  options?: { unitStatus?: string }
): string | undefined {
  if (result === undefined) return undefined;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return `${pathLabel} must be a non-null object`;
  }
  const r = result as Record<string, unknown>;
  const messages = r.messages;
  if (!Array.isArray(messages)) {
    return `${pathLabel}.messages must be an array`;
  }
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
      return `${pathLabel}.messages[${i}] must be a non-null object`;
    }
  }
  if (r.status !== undefined) {
    if (typeof r.status !== 'string' || !UNIT_STATUS_VALUES.has(r.status)) {
      return `${pathLabel}.status has unsupported value ${String(r.status)}`;
    }
  }
  if (r.exitCode !== undefined) {
    if (typeof r.exitCode !== 'number' || !Number.isInteger(r.exitCode)) {
      return `${pathLabel}.exitCode must be an integer when present`;
    }
  }
  // Completed unit must carry a terminal completed result shell so Parallel/resume
  // skip-by-status cannot redispatch via lagging result.status / exitCode -1.
  if (options?.unitStatus === 'completed') {
    if (r.status !== undefined && r.status !== 'completed') {
      return `${pathLabel}.status must be completed when unit is completed (got ${String(r.status)})`;
    }
    if (r.exitCode === -1) {
      return `${pathLabel}.exitCode must not be -1 when unit is completed`;
    }
    // Absent status falls back to exitCode: only 0 resolves to completed.
    if (r.status === undefined) {
      if (typeof r.exitCode !== 'number') {
        return `${pathLabel} must have status completed or exitCode 0 when unit is completed`;
      }
      if (r.exitCode !== 0) {
        return `${pathLabel}.exitCode must be 0 when status is absent and unit is completed`;
      }
    }
  }
  return undefined;
}

/** Validate optional compact ResultPresentation on a durable SingleResult. */
function validatePresentation(presentation: unknown, pathLabel: string): string | undefined {
  if (presentation === undefined) return undefined;
  if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)) {
    return `${pathLabel}.presentation must be an object`;
  }
  const p = presentation as Record<string, unknown>;
  if (!Array.isArray(p.transcript)) {
    return `${pathLabel}.presentation.transcript must be an array`;
  }
  for (let i = 0; i < p.transcript.length; i++) {
    const itemError = validateDisplayItem(
      p.transcript[i],
      `${pathLabel}.presentation.transcript[${i}]`
    );
    if (itemError) return itemError;
  }
  if (p.latestActivity !== undefined) {
    const latestError = validateDisplayItem(
      p.latestActivity,
      `${pathLabel}.presentation.latestActivity`
    );
    if (latestError) return latestError;
  }
  if (p.truncated === true) {
    if (
      typeof p.omittedItems !== 'number' ||
      !Number.isInteger(p.omittedItems) ||
      p.omittedItems <= 0
    ) {
      return `${pathLabel}.presentation.omittedItems must be a positive integer when truncated`;
    }
  } else if (p.truncated === false) {
    return `${pathLabel}.presentation.truncated must be true or absent`;
  } else if (p.truncated !== undefined) {
    return `${pathLabel}.presentation.truncated must be true or absent`;
  } else if (p.omittedItems !== undefined) {
    return `${pathLabel}.presentation.omittedItems requires truncated: true`;
  }
  return undefined;
}

function validateDisplayItem(item: unknown, pathLabel: string): string | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return `${pathLabel} must be a display item object`;
  }
  const d = item as Record<string, unknown>;
  if (d.type === 'text') {
    if (typeof d.text !== 'string') return `${pathLabel}.text must be a string`;
    return undefined;
  }
  if (d.type === 'toolCall') {
    if (typeof d.name !== 'string') return `${pathLabel}.name must be a string`;
    if (d.args === null || typeof d.args !== 'object' || Array.isArray(d.args)) {
      return `${pathLabel}.args must be a non-null object`;
    }
    return undefined;
  }
  return `${pathLabel}.type must be text or toolCall`;
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && Number.isFinite(value)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && Number.isFinite(value)
  );
}

/** Validate one durable ChainOutputEntry used by resume/restore. */
function validateChainOutputEntry(entry: unknown, pathLabel: string): string | undefined {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return `${pathLabel} must be a non-null object`;
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.text !== 'string') {
    return `${pathLabel}.text must be a string`;
  }
  if (typeof e.agent !== 'string') {
    return `${pathLabel}.agent must be a string`;
  }
  if (!isPositiveInteger(e.step)) {
    return `${pathLabel}.step must be a positive integer`;
  }
  // structured is optional unknown; any JSON value including null is accepted when present.
  return undefined;
}

/** Validate one durable presentation ChainLogicalStep enough for resume/restore. */
function validateChainLogicalStep(step: unknown, pathLabel: string): string | undefined {
  if (step === null || typeof step !== 'object' || Array.isArray(step)) {
    return `${pathLabel} must be a non-null object`;
  }
  const s = step as Record<string, unknown>;
  if (s.kind !== 'sequential' && s.kind !== 'fanout') {
    return `${pathLabel}.kind must be sequential or fanout`;
  }
  if (!isPositiveInteger(s.step)) {
    return `${pathLabel}.step must be a positive integer`;
  }
  if (typeof s.agent !== 'string') {
    return `${pathLabel}.agent must be a string`;
  }
  if (typeof s.status !== 'string' || !UNIT_STATUS_VALUES.has(s.status)) {
    return `${pathLabel}.status has unsupported value ${String(s.status)}`;
  }
  if (s.title !== undefined && typeof s.title !== 'string') {
    return `${pathLabel}.title must be a string when present`;
  }
  if (s.kind === 'sequential') {
    if (typeof s.task !== 'string') {
      return `${pathLabel}.task must be a string`;
    }
    return undefined;
  }
  if (typeof s.taskTemplate !== 'string') {
    return `${pathLabel}.taskTemplate must be a string`;
  }
  if (typeof s.collectName !== 'string') {
    return `${pathLabel}.collectName must be a string`;
  }
  if (s.sourceOutput !== undefined && typeof s.sourceOutput !== 'string') {
    return `${pathLabel}.sourceOutput must be a string when present`;
  }
  if (s.sourcePath !== undefined && typeof s.sourcePath !== 'string') {
    return `${pathLabel}.sourcePath must be a string when present`;
  }
  if (s.concurrency !== undefined && !isNonNegativeInteger(s.concurrency)) {
    return `${pathLabel}.concurrency must be a non-negative integer when present`;
  }
  for (const countField of [
    'executedCount',
    'completedCount',
    'failedCount',
    'runningCount',
    'queuedCount',
    'skippedCount',
  ] as const) {
    if (!isNonNegativeInteger(s[countField])) {
      return `${pathLabel}.${countField} must be a non-negative integer`;
    }
  }
  if (s.latestIndex !== undefined && !isNonNegativeInteger(s.latestIndex)) {
    return `${pathLabel}.latestIndex must be a non-negative integer when present`;
  }
  return undefined;
}

/** Resolve agent name for request.chain[step-1] (sequential agent or fanout parallel.agent). */
function chainRequestStepAgent(chain: unknown[], step: number): string | undefined {
  if (step < 1 || step > chain.length) return undefined;
  const entry = chain[step - 1];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const e = entry as Record<string, unknown>;
  const isFanout = 'expand' in e && !('agent' in e);
  if (isFanout) {
    const parallel = e.parallel;
    if (!parallel || typeof parallel !== 'object' || Array.isArray(parallel)) return undefined;
    const agent = (parallel as { agent?: unknown }).agent;
    return typeof agent === 'string' ? agent : undefined;
  }
  return typeof e.agent === 'string' ? e.agent : undefined;
}

/**
 * Minimum mode-aware SubagentDetails shape consumed by getRun / preflight / chain restore.
 * Requires results; validates optional chain/outputs enough that resume cannot throw.
 *
 * Compatibility: `details.chain` / `details.outputs` may appear on single/parallel records
 * as ignored presentation (legacy fixtures). Topology provenance is enforced only when
 * `mode === 'chain'` so impossible step/agent entries cannot poison later-step-wins restore.
 */
function validateSubagentDetails(
  details: unknown,
  options?: { mode?: string; request?: Record<string, unknown> }
): string | undefined {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) {
    return 'invalid details';
  }
  const d = details as Record<string, unknown>;

  if (!Array.isArray(d.results)) {
    return 'details.results must be an array';
  }
  for (let i = 0; i < d.results.length; i++) {
    const result = d.results[i];
    const pathLabel = `details.results[${i}]`;
    const shellError = validateResultShell(result, pathLabel);
    if (shellError) return shellError;
    if (!result || typeof result !== 'object') continue;
    const resumeCapability = (result as { resumeCapability?: unknown }).resumeCapability;
    if (resumeCapability !== undefined && !isAllowedDurableCapability(resumeCapability)) {
      return `${pathLabel}.resumeCapability has unsupported value ${String(resumeCapability)}`;
    }
    const presentationError = validatePresentation(
      (result as { presentation?: unknown }).presentation,
      pathLabel
    );
    if (presentationError) return presentationError;
  }

  if (d.outputs !== undefined) {
    if (d.outputs === null || typeof d.outputs !== 'object' || Array.isArray(d.outputs)) {
      return 'details.outputs must be a non-null object';
    }
    for (const [name, entry] of Object.entries(d.outputs as Record<string, unknown>)) {
      const entryError = validateChainOutputEntry(entry, `details.outputs[${name}]`);
      if (entryError) return entryError;
    }
  }

  if (d.chain !== undefined) {
    if (d.chain === null || typeof d.chain !== 'object' || Array.isArray(d.chain)) {
      return 'details.chain must be a non-null object';
    }
    const chain = d.chain as Record<string, unknown>;
    if (!isNonNegativeInteger(chain.totalSteps)) {
      return 'details.chain.totalSteps must be a non-negative integer';
    }
    if (!Array.isArray(chain.steps)) {
      return 'details.chain.steps must be an array';
    }
    for (let i = 0; i < chain.steps.length; i++) {
      const stepError = validateChainLogicalStep(chain.steps[i], `details.chain.steps[${i}]`);
      if (stepError) return stepError;
    }
  }

  // Chain-mode topology provenance: reject impossible output/step agents that can
  // win later-step-wins and poison named templates. Non-chain modes may still carry
  // ignored legacy chain/outputs presentation (accepted without topology checks).
  if (options?.mode === 'chain' && options.request) {
    const requestChain = options.request.chain;
    const topology = Array.isArray(requestChain) ? requestChain : [];
    const totalSteps = topology.length;

    if (d.outputs !== undefined && totalSteps > 0) {
      for (const [name, entry] of Object.entries(d.outputs as Record<string, unknown>)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const e = entry as { step?: unknown; agent?: unknown };
        if (typeof e.step === 'number' && isPositiveInteger(e.step) && e.step > totalSteps) {
          return `details.outputs[${name}].step ${e.step} is outside chain topology (1..${totalSteps})`;
        }
        if (
          typeof e.step === 'number' &&
          isPositiveInteger(e.step) &&
          typeof e.agent === 'string'
        ) {
          const expected = chainRequestStepAgent(topology, e.step);
          if (expected !== undefined && e.agent !== expected) {
            return `details.outputs[${name}].agent "${e.agent}" does not match topology agent "${expected}" at step ${e.step}`;
          }
        }
      }
    }

    if (d.chain !== undefined && totalSteps > 0) {
      const chain = d.chain as { steps?: unknown };
      if (Array.isArray(chain.steps)) {
        for (let i = 0; i < chain.steps.length; i++) {
          const step = chain.steps[i];
          if (!step || typeof step !== 'object' || Array.isArray(step)) continue;
          const s = step as { step?: unknown; agent?: unknown };
          if (typeof s.step === 'number' && isPositiveInteger(s.step) && s.step > totalSteps) {
            return `details.chain.steps[${i}].step ${s.step} is outside chain topology (1..${totalSteps})`;
          }
          if (
            typeof s.step === 'number' &&
            isPositiveInteger(s.step) &&
            typeof s.agent === 'string'
          ) {
            const expected = chainRequestStepAgent(topology, s.step);
            if (expected !== undefined && s.agent !== expected) {
              return `details.chain.steps[${i}].agent "${s.agent}" does not match topology agent "${expected}" at step ${s.step}`;
            }
          }
        }
      }
    }
  }

  const runMeta = d.run;
  if (runMeta !== undefined) {
    if (runMeta === null || typeof runMeta !== 'object' || Array.isArray(runMeta)) {
      return 'details.run must be a non-null object when present';
    }
    const cap = (runMeta as { capability?: unknown }).capability;
    if (cap !== undefined && !isAllowedDurableCapability(cap)) {
      return `details.run.capability has unsupported value ${String(cap)}`;
    }
  }

  return undefined;
}

/** Effective unit runtime: explicit value or the Pi default when absent. */
function effectiveUnitRuntime(runtime: unknown): string {
  return typeof runtime === 'string' ? runtime : DEFAULT_RUNTIME;
}

export function getDefaultRunsRoot(): string {
  // Tests inject a custom rootDir; the process-level HOME env override
  // ensures getDefaultRunsRoot picks up temp directories during testing.
  const home = process.env.HOME ?? os.homedir();
  return path.join(home, '.pi', 'agent', '@balaenis', 'pi-agents', 'runs');
}

const POSIX = process.platform !== 'win32';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function applyMode(targetPath: string, mode: number): void {
  if (!POSIX) return;
  try {
    fs.chmodSync(targetPath, mode);
  } catch {
    // best-effort
  }
}

function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  applyMode(dir, DIR_MODE);
}

function fsyncFd(fd: number): void {
  try {
    fs.fsyncSync(fd);
  } catch {
    // best-effort
  }
}

function fsyncDir(dirPath: string): void {
  if (!POSIX) return;
  try {
    const dirFd = fs.openSync(dirPath, 'r');
    fsyncFd(dirFd);
    fs.closeSync(dirFd);
  } catch {
    // best-effort
  }
}

function isUnitIdValid(id: string): boolean {
  return /^[a-z0-9-]+$/.test(id);
}

function isRunIdValid(id: string): boolean {
  if (!id || id.includes(path.sep) || id.includes('/') || id.includes('\\')) return false;
  return /^[a-zA-Z0-9-]+$/.test(id);
}

/** Per-run write queue so overlapping streaming updates cannot interleave temp renames. */
type QueuedTask<T> = () => Promise<T>;
interface RunQueue {
  tail: Promise<unknown>;
}

export interface CreateRunStoreOptions {
  rootDir?: string;
  now?: () => number;
  randomUUID?: () => string;
  pid?: number;
  instanceId?: string;
}

export interface CreateRunInput {
  mode: 'single' | 'parallel' | 'chain';
  agentScope: import('./agents.ts').AgentScope;
  background: boolean;
  request: import('./run-types.ts').StoredRunRequest;
  details: import('./types.ts').SubagentDetails;
  units: Record<string, import('./run-types.ts').RunUnitRecord>;
}

export interface UpdateRunInput {
  record: AgentRunRecordV1;
}

export interface ClaimInfo {
  claimId: string;
  ticket: number;
}

export interface RunStore {
  readonly rootDir: string;
  /** Resolve the on-disk directory for a run id (exists once createRun succeeds). */
  getRunDir(runId: string): string;
  createRun(input: CreateRunInput): Promise<{ runId: string; record: AgentRunRecordV1 }>;
  getRun(runId: string): { ok: true; loaded: LoadedRun } | { ok: false; error: RunStoreError };
  updateRun(runId: string, mutate: (record: AgentRunRecordV1) => void): Promise<AgentRunRecordV1>;
  appendEvent(runId: string, event: RunLifecycleEvent): Promise<void>;
  listRuns(): Promise<ListRunsResult>;
  claimRun(runId: string): Promise<ClaimResult>;
  releaseRun(runId: string, claimId: string): Promise<void>;
  abandonRun(runId: string, claimId: string): Promise<void>;
  /** Inspect published claims for a run without participating. */
  inspectClaims(runId: string):
    | {
        ok: true;
        claims: Array<{
          ticket: number;
          owner?: ClaimOwner;
          terminal?: ClaimTerminal;
          ownerError?: string;
          terminalError?: string;
        }>;
      }
    | { ok: false; error: RunStoreError };
  /** Test/inspection helper: is the given PID alive (false on ESRCH/ENOSYS). */
  isPidAlive(pid: number): boolean;
}

export function createRunStore(options: CreateRunStoreOptions = {}): RunStore {
  const rootDir = options.rootDir ?? getDefaultRunsRoot();
  const now = options.now ?? (() => Date.now());
  const randomUUID = options.randomUUID ?? crypto.randomUUID;
  const pid = options.pid ?? process.pid;
  const instanceId = options.instanceId ?? `${process.ppid ?? 0}-${Date.now()}-${randomUUID()}`;

  mkdirPrivate(rootDir);

  const queues = new Map<string, RunQueue>();

  function getQueue(runId: string): RunQueue {
    let q = queues.get(runId);
    if (!q) {
      q = { tail: Promise.resolve() };
      queues.set(runId, q);
    }
    return q;
  }

  function runSerial<T>(runId: string, task: QueuedTask<T>): Promise<T> {
    const q = getQueue(runId);
    const result = q.tail.then(task, task);
    q.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  function runDirOf(runId: string): string {
    return path.join(rootDir, runId);
  }

  function getRunDir(runId: string): string {
    return runDirOf(runId);
  }

  function runJsonPath(runId: string): string {
    return path.join(runDirOf(runId), 'run.json');
  }

  function eventsPath(runId: string): string {
    return path.join(runDirOf(runId), 'events.jsonl');
  }

  function claimsDir(runId: string): string {
    return path.join(runDirOf(runId), 'claims');
  }

  function validateRunRecord(
    raw: unknown,
    expectedRunId: string,
    expectedDir: string
  ): { ok: true; record: AgentRunRecordV1 } | { ok: false; error: RunStoreError } {
    if (!raw || typeof raw !== 'object') {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: 'record is not an object' },
      };
    }
    const r = raw as Partial<AgentRunRecordV1>;
    if (r.version !== RUN_RECORD_VERSION) {
      return {
        ok: false,
        error: {
          code: 'corrupt_run',
          runId: expectedRunId,
          message: `unsupported version ${String(r.version)}`,
        },
      };
    }
    if (r.runId !== expectedRunId) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: 'runId mismatch' },
      };
    }
    if (typeof r.mode !== 'string' || !['single', 'parallel', 'chain'].includes(r.mode)) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: 'invalid mode' },
      };
    }
    if (typeof r.status !== 'string' || !RUN_STATUS_VALUES.has(r.status)) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: 'invalid status' },
      };
    }
    if (typeof r.details !== 'object' || r.details === null || Array.isArray(r.details)) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: 'invalid details' },
      };
    }
    if (typeof r.units !== 'object' || r.units === null) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: 'invalid units' },
      };
    }
    const requestError = validateStoredRequest(r.request, r.mode);
    if (requestError) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: requestError },
      };
    }
    // Explicit request.runtime is a run-wide override; every unit's effective
    // runtime (unit.runtime ?? pi default) must match so preflight and dispatch
    // cannot apply different rules. Absent request.runtime allows per-agent runtimes.
    const explicitRequestRuntime =
      r.request && typeof r.request === 'object' && 'runtime' in r.request
        ? (r.request as { runtime?: unknown }).runtime
        : undefined;
    for (const [unitId, unit] of Object.entries(r.units)) {
      if (!isUnitIdValid(unitId)) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `invalid unit id ${unitId}`,
          },
        };
      }
      if (!unit || typeof unit !== 'object') {
        return {
          ok: false,
          error: { code: 'corrupt_run', runId: expectedRunId, message: `invalid unit ${unitId}` },
        };
      }
      const u = unit as unknown as Record<string, unknown>;
      if (typeof u.agent !== 'string') {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} agent is not a string`,
          },
        };
      }
      // Canonical unit identity first so swapped positions fail closed on
      // identity rather than being misread through mutable fanoutIndex/step.
      if (u.unitId !== unitId) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} unitId field "${String(u.unitId)}" does not match record key`,
          },
        };
      }
      if (r.request && typeof r.request === 'object') {
        const identityError = validateUnitCanonicalIdentity(
          r.mode as string,
          r.request as unknown as Record<string, unknown>,
          unitId,
          { step: u.step, fanoutIndex: u.fanoutIndex }
        );
        if (identityError) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: identityError,
            },
          };
        }
        // Persisted unit.agent must match the request topology used at dispatch so
        // preflight fingerprint checks and runtime resolution stay consistent.
        const expectedAgent = expectedTopologyAgent(
          r.mode as string,
          r.request as unknown as Record<string, unknown>,
          unitId,
          { step: u.step, fanoutIndex: u.fanoutIndex }
        );
        if (expectedAgent === undefined) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `unit ${unitId} does not match request topology`,
            },
          };
        }
        if (u.agent !== expectedAgent) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `unit ${unitId} agent "${u.agent}" does not match request topology agent "${expectedAgent}"`,
            },
          };
        }
      }
      if (u.runtime !== undefined && !isAllowedDurableRuntime(u.runtime)) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} has unsupported runtime ${String(u.runtime)}`,
          },
        };
      }
      if (typeof explicitRequestRuntime === 'string') {
        const unitEffective = effectiveUnitRuntime(u.runtime);
        if (unitEffective !== explicitRequestRuntime) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `unit ${unitId} effective runtime ${unitEffective} conflicts with request.runtime ${explicitRequestRuntime}`,
            },
          };
        }
      }
      if (!isAllowedDurableCapability(u.capability)) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message:
              u.capability === undefined
                ? `unit ${unitId} is missing capability`
                : `unit ${unitId} has unsupported capability ${String(u.capability)}`,
          },
        };
      }
      // Core unit fields consumed by inspectResume/active resume must be well-typed.
      if (typeof u.status !== 'string' || !UNIT_STATUS_VALUES.has(u.status)) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} has unsupported status ${String(u.status)}`,
          },
        };
      }
      if (
        typeof u.attempt !== 'number' ||
        !Number.isInteger(u.attempt) ||
        u.attempt < 0 ||
        !Number.isFinite(u.attempt)
      ) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} attempt must be a non-negative integer`,
          },
        };
      }
      if (!Array.isArray(u.attempts)) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} attempts must be an array`,
          },
        };
      }
      for (let i = 0; i < u.attempts.length; i++) {
        const attemptRec = u.attempts[i];
        const attemptPath = `unit ${unitId} attempts[${i}]`;
        if (!attemptRec || typeof attemptRec !== 'object' || Array.isArray(attemptRec)) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `${attemptPath} must be an object`,
            },
          };
        }
        const a = attemptRec as Record<string, unknown>;
        if (
          typeof a.attempt !== 'number' ||
          !Number.isInteger(a.attempt) ||
          a.attempt < 0 ||
          !Number.isFinite(a.attempt)
        ) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `${attemptPath}.attempt must be a non-negative integer`,
            },
          };
        }
        if (typeof a.status !== 'string' || !UNIT_STATUS_VALUES.has(a.status)) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `${attemptPath} has unsupported status ${String(a.status)}`,
            },
          };
        }
        if (typeof a.startedAt !== 'number' || !Number.isFinite(a.startedAt)) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `${attemptPath}.startedAt must be a number`,
            },
          };
        }
        if (
          a.finishedAt !== undefined &&
          (typeof a.finishedAt !== 'number' || !Number.isFinite(a.finishedAt))
        ) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `${attemptPath}.finishedAt must be a number when present`,
            },
          };
        }
        if (a.stopReason !== undefined && typeof a.stopReason !== 'string') {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `${attemptPath}.stopReason must be a string when present`,
            },
          };
        }
        if (a.errorMessage !== undefined && typeof a.errorMessage !== 'string') {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `${attemptPath}.errorMessage must be a string when present`,
            },
          };
        }
      }
      // Resume always passes effectiveCwd to fs.existsSync; require a non-empty string.
      // Writers always set it; no valid V1 fixture omits it.
      if (typeof u.effectiveCwd !== 'string' || u.effectiveCwd.length === 0) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} effectiveCwd must be a non-empty string`,
          },
        };
      }
      if (u.agentFingerprint !== undefined && typeof u.agentFingerprint !== 'string') {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} agentFingerprint must be a string when present`,
          },
        };
      }
      // Crash-window flag is boolean-only; string "false" must not bypass handling.
      if (
        u.sessionPromptEstablished !== undefined &&
        typeof u.sessionPromptEstablished !== 'boolean'
      ) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: `unit ${unitId} sessionPromptEstablished must be a boolean when present`,
          },
        };
      }
      if (u.result !== undefined) {
        const shellError = validateResultShell(u.result, `unit ${unitId} result`, {
          unitStatus: typeof u.status === 'string' ? u.status : undefined,
        });
        if (shellError) {
          return {
            ok: false,
            error: { code: 'corrupt_run', runId: expectedRunId, message: shellError },
          };
        }
        const resumeCapability = (u.result as { resumeCapability?: unknown }).resumeCapability;
        if (resumeCapability !== undefined && !isAllowedDurableCapability(resumeCapability)) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `unit ${unitId} result.resumeCapability has unsupported value ${String(resumeCapability)}`,
            },
          };
        }
        const presentationError = validatePresentation(
          (u.result as { presentation?: unknown }).presentation,
          `unit ${unitId} result`
        );
        if (presentationError) {
          return {
            ok: false,
            error: { code: 'corrupt_run', runId: expectedRunId, message: presentationError },
          };
        }
      }
      if (u.sessionFile !== undefined) {
        if (typeof u.sessionFile !== 'string' || u.sessionFile.length === 0) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `unit ${unitId} sessionFile must be a non-empty string when present`,
            },
          };
        }
      }
      if (u.acpSessionId !== undefined) {
        if (
          typeof u.acpSessionId !== 'string' ||
          u.acpSessionId.trim().length === 0 ||
          u.acpSessionId !== u.acpSessionId.trim()
        ) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `unit ${unitId} acpSessionId must be a trimmed non-empty string`,
            },
          };
        }
      }
      if (u.worktreePath !== undefined) {
        if (typeof u.worktreePath !== 'string' || u.worktreePath.length === 0) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `unit ${unitId} worktreePath must be a non-empty string when present`,
            },
          };
        }
      }
    }
    // Exact coverage of statically known units (single / parallel / sequential
    // chain). Dynamic fanout children are allowed only as mapped expansions.
    if (r.request && typeof r.request === 'object') {
      const coverageError = validateStaticUnitCoverage(
        r.mode as string,
        r.request as unknown as Record<string, unknown>,
        r.units as Record<string, unknown>
      );
      if (coverageError) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: coverageError,
          },
        };
      }
    }
    // Mode-aware SubagentDetails minimum shape used by preflight/resume/chain restore.
    const detailsError = validateSubagentDetails(r.details, {
      mode: typeof r.mode === 'string' ? r.mode : undefined,
      request:
        r.request && typeof r.request === 'object' && !Array.isArray(r.request)
          ? (r.request as unknown as Record<string, unknown>)
          : undefined,
    });
    if (detailsError) {
      return {
        ok: false,
        error: { code: 'corrupt_run', runId: expectedRunId, message: detailsError },
      };
    }
    if (r.continuationTasks !== undefined) {
      if (!Array.isArray(r.continuationTasks)) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: 'continuationTasks is not an array',
          },
        };
      }
      for (let i = 0; i < r.continuationTasks.length; i++) {
        if (typeof r.continuationTasks[i] !== 'string') {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `continuationTasks[${i}] is not a string`,
            },
          };
        }
      }
    }
    if (r.continuationDelivery !== undefined) {
      if (typeof r.continuationDelivery !== 'object' || r.continuationDelivery === null) {
        return {
          ok: false,
          error: {
            code: 'corrupt_run',
            runId: expectedRunId,
            message: 'continuationDelivery is not an object',
          },
        };
      }
      const continuationTaskCount = Array.isArray(r.continuationTasks)
        ? r.continuationTasks.length
        : 0;
      const units =
        r.units && typeof r.units === 'object' && r.units !== null
          ? (r.units as Record<string, unknown>)
          : undefined;
      for (const [unitId, entry] of Object.entries(r.continuationDelivery)) {
        // Orphan delivery keys (no matching unit) are corrupt.
        if (!units || !(unitId in units)) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `continuationDelivery[${unitId}] has no matching unit`,
            },
          };
        }
        if (!entry || typeof entry !== 'object') {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `continuationDelivery[${unitId}] is not an object`,
            },
          };
        }
        const deliveredCount = (entry as { deliveredCount?: unknown }).deliveredCount;
        if (
          typeof deliveredCount !== 'number' ||
          !Number.isInteger(deliveredCount) ||
          deliveredCount < 0
        ) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `continuationDelivery[${unitId}].deliveredCount is invalid`,
            },
          };
        }
        // deliveredCount is how many of continuationTasks[0..n) were confirmed.
        if (deliveredCount > continuationTaskCount) {
          return {
            ok: false,
            error: {
              code: 'corrupt_run',
              runId: expectedRunId,
              message: `continuationDelivery[${unitId}].deliveredCount ${deliveredCount} exceeds continuationTasks length ${continuationTaskCount}`,
            },
          };
        }
      }
    }
    void expectedDir;
    return { ok: true, record: r as AgentRunRecordV1 };
  }

  /**
   * Validate that a unit key and its step/fanoutIndex fields form the canonical
   * identity for the stored request topology. Returns an error message or undefined.
   */
  function validateUnitCanonicalIdentity(
    mode: string,
    request: Record<string, unknown>,
    unitId: string,
    unit: { step?: unknown; fanoutIndex?: unknown }
  ): string | undefined {
    if (mode === 'single') {
      if (unitId !== 'single') {
        return `unit ${unitId} is not the canonical single-mode id`;
      }
      if (unit.step !== undefined) {
        return `unit ${unitId} must not have step in single mode`;
      }
      if (unit.fanoutIndex !== undefined) {
        return `unit ${unitId} must not have fanoutIndex in single mode`;
      }
      return undefined;
    }
    if (mode === 'parallel') {
      const match = /^parallel-(\d+)$/.exec(unitId);
      if (!match) {
        return `unit ${unitId} is not a canonical parallel id`;
      }
      const index = Number(match[1]) - 1;
      const tasks = request.tasks;
      if (!Array.isArray(tasks) || index < 0 || index >= tasks.length) {
        return `unit ${unitId} is outside parallel task range`;
      }
      if (unit.fanoutIndex !== index) {
        return `unit ${unitId} fanoutIndex ${String(unit.fanoutIndex)} does not match canonical index ${index}`;
      }
      if (unit.step !== undefined) {
        return `unit ${unitId} must not have step in parallel mode`;
      }
      return undefined;
    }
    if (mode === 'chain') {
      const chain = request.chain;
      if (!Array.isArray(chain)) {
        return `unit ${unitId} chain request is invalid`;
      }
      const fanoutMatch = /^chain-(\d+)-fanout-(\d+)$/.exec(unitId);
      if (fanoutMatch) {
        const step = Number(fanoutMatch[1]);
        const fanoutIndex = Number(fanoutMatch[2]) - 1;
        if (step < 1 || step > chain.length) {
          return `unit ${unitId} step is outside chain range`;
        }
        const entry = chain[step - 1];
        const isFanout =
          entry !== null && typeof entry === 'object' && 'expand' in entry && !('agent' in entry);
        if (!isFanout) {
          return `unit ${unitId} targets a non-fanout chain step`;
        }
        if (unit.step !== step) {
          return `unit ${unitId} step ${String(unit.step)} does not match canonical step ${step}`;
        }
        if (unit.fanoutIndex !== fanoutIndex) {
          return `unit ${unitId} fanoutIndex ${String(unit.fanoutIndex)} does not match canonical index ${fanoutIndex}`;
        }
        // Canonical id form must match helpers (rejects non-padded aliases).
        try {
          if (unitId !== chainFanoutUnitId(step, fanoutIndex)) {
            return `unit ${unitId} is not the canonical fanout id`;
          }
        } catch {
          return `unit ${unitId} has invalid fanout identity`;
        }
        return undefined;
      }
      const seqMatch = /^chain-(\d+)$/.exec(unitId);
      if (!seqMatch) {
        return `unit ${unitId} is not a canonical chain id`;
      }
      const step = Number(seqMatch[1]);
      if (step < 1 || step > chain.length) {
        return `unit ${unitId} step is outside chain range`;
      }
      const entry = chain[step - 1];
      const isFanout =
        entry !== null && typeof entry === 'object' && 'expand' in entry && !('agent' in entry);
      if (isFanout) {
        return `unit ${unitId} targets a fanout chain step without fanout identity`;
      }
      if (unit.step !== step) {
        return `unit ${unitId} step ${String(unit.step)} does not match canonical step ${step}`;
      }
      if (unit.fanoutIndex !== undefined) {
        return `unit ${unitId} must not have fanoutIndex on a sequential step`;
      }
      try {
        if (unitId !== chainStepUnitId(step)) {
          return `unit ${unitId} is not the canonical sequential id`;
        }
      } catch {
        return `unit ${unitId} has invalid sequential identity`;
      }
      return undefined;
    }
    return `unit ${unitId} has unsupported mode ${mode}`;
  }

  /**
   * Require exact coverage of statically known unit ids for the request topology.
   * Dynamic fanout children may appear only as canonical fanout unit ids.
   */
  function validateStaticUnitCoverage(
    mode: string,
    request: Record<string, unknown>,
    units: Record<string, unknown>
  ): string | undefined {
    const unitKeys = Object.keys(units);
    if (mode === 'single') {
      if (unitKeys.length !== 1 || unitKeys[0] !== 'single') {
        return `static unit coverage invalid for single mode: expected exactly [single], got [${unitKeys.join(', ')}]`;
      }
      return undefined;
    }
    if (mode === 'parallel') {
      const tasks = request.tasks;
      if (!Array.isArray(tasks)) {
        return 'static unit coverage invalid: parallel request.tasks is not an array';
      }
      const expected = Array.from({ length: tasks.length }, (_, i) => `parallel-${pad(i + 1)}`);
      if (unitKeys.length !== expected.length) {
        return `static unit coverage invalid for parallel mode: expected ${expected.length} units, got ${unitKeys.length}`;
      }
      for (const id of expected) {
        if (!(id in units)) {
          return `static unit coverage invalid for parallel mode: missing ${id}`;
        }
      }
      for (const id of unitKeys) {
        if (!expected.includes(id)) {
          return `static unit coverage invalid for parallel mode: unexpected unit ${id}`;
        }
      }
      return undefined;
    }
    if (mode === 'chain') {
      const expectedStatic = generateUnitIds('chain', {
        chain: Array.isArray(request.chain) ? request.chain : [],
      });
      for (const id of expectedStatic) {
        if (!(id in units)) {
          return `static unit coverage invalid for chain mode: missing ${id}`;
        }
      }
      for (const id of unitKeys) {
        if (expectedStatic.includes(id)) continue;
        // Dynamic fanout children only; reject extra sequential or arbitrary ids.
        if (!/^chain-\d+-fanout-\d+$/.test(id)) {
          return `static unit coverage invalid for chain mode: unexpected unit ${id}`;
        }
      }
      return undefined;
    }
    return undefined;
  }

  /**
   * Resolve the agent name selected by the stored request topology for a unit.
   * Used so preflight/dispatch cannot apply a different agent than durability.
   * Returns undefined when the unit position cannot be resolved from the request.
   */
  function expectedTopologyAgent(
    mode: string,
    request: Record<string, unknown>,
    unitId: string,
    unit: { step?: unknown; fanoutIndex?: unknown }
  ): string | undefined {
    if (mode === 'single') {
      return typeof request.agent === 'string' ? request.agent : undefined;
    }
    if (mode === 'parallel') {
      const tasks = request.tasks;
      if (!Array.isArray(tasks)) return undefined;
      let index: number | undefined;
      if (typeof unit.fanoutIndex === 'number' && Number.isInteger(unit.fanoutIndex)) {
        index = unit.fanoutIndex;
      } else {
        const match = /^parallel-(\d+)$/.exec(unitId);
        if (match) index = Number(match[1]) - 1;
      }
      if (index === undefined || index < 0 || index >= tasks.length) return undefined;
      const item = tasks[index];
      if (!item || typeof item !== 'object') return undefined;
      const agent = (item as { agent?: unknown }).agent;
      return typeof agent === 'string' ? agent : undefined;
    }
    if (mode === 'chain') {
      const chain = request.chain;
      if (!Array.isArray(chain)) return undefined;
      let step: number | undefined;
      if (typeof unit.step === 'number' && Number.isInteger(unit.step)) {
        step = unit.step;
      } else {
        const fanoutMatch = /^chain-(\d+)-fanout-(\d+)$/.exec(unitId);
        if (fanoutMatch) {
          step = Number(fanoutMatch[1]);
        } else {
          const seqMatch = /^chain-(\d+)$/.exec(unitId);
          if (seqMatch) step = Number(seqMatch[1]);
        }
      }
      if (step === undefined || step < 1 || step > chain.length) return undefined;
      const entry = chain[step - 1];
      if (!entry || typeof entry !== 'object') return undefined;
      const isFanout = 'expand' in entry && !('agent' in entry);
      const hasFanoutIndex =
        typeof unit.fanoutIndex === 'number' && Number.isInteger(unit.fanoutIndex);
      // Fanout child units must use the parallel agent; sequential units use step.agent.
      if (isFanout) {
        if (!hasFanoutIndex && !/^chain-\d+-fanout-\d+$/.test(unitId)) {
          // Sequential-shaped unit claiming a fanout step has no topology agent.
          return undefined;
        }
        const parallel = (entry as { parallel?: unknown }).parallel;
        if (!parallel || typeof parallel !== 'object') return undefined;
        const agent = (parallel as { agent?: unknown }).agent;
        return typeof agent === 'string' ? agent : undefined;
      }
      if (hasFanoutIndex) {
        // Fanout index on a sequential step is not a valid topology position.
        return undefined;
      }
      const agent = (entry as { agent?: unknown }).agent;
      return typeof agent === 'string' ? agent : undefined;
    }
    return undefined;
  }

  /**
   * Validate StoredRunRequest shape and mode/topology consistency.
   * Returns an error message or undefined when valid. Never throws.
   */
  function validateStoredRequest(request: unknown, mode: string): string | undefined {
    if (!request || typeof request !== 'object') {
      return 'request is not an object';
    }
    const req = request as Record<string, unknown>;
    if (req.mode !== mode) {
      return `request.mode (${String(req.mode)}) does not match record.mode (${mode})`;
    }
    if (typeof req.agentScope !== 'string') {
      return 'request.agentScope is not a string';
    }
    for (const key of [
      'model',
      'thinking',
      'runtime',
      'isolation',
      'agent',
      'task',
      'title',
      'cwd',
    ] as const) {
      if (req[key] !== undefined && typeof req[key] !== 'string') {
        return `request.${key} is not a string`;
      }
    }
    if (req.runtime !== undefined && !isAllowedDurableRuntime(req.runtime)) {
      return `request.runtime has unsupported value ${String(req.runtime)}`;
    }
    if (mode === 'single') {
      if (typeof req.agent !== 'string' || typeof req.task !== 'string') {
        return 'request single mode requires agent and task strings';
      }
      if (req.tasks !== undefined || req.chain !== undefined) {
        return 'request single mode must not include tasks or chain';
      }
    } else if (mode === 'parallel') {
      if (!Array.isArray(req.tasks) || req.tasks.length === 0) {
        return 'request parallel mode requires a non-empty tasks array';
      }
      for (let i = 0; i < req.tasks.length; i++) {
        const item = req.tasks[i];
        if (!item || typeof item !== 'object') {
          return `request.tasks[${i}] is not an object`;
        }
        const t = item as Record<string, unknown>;
        if (typeof t.agent !== 'string' || typeof t.task !== 'string') {
          return `request.tasks[${i}] requires agent and task strings`;
        }
        for (const key of ['title', 'cwd', 'isolation'] as const) {
          if (t[key] !== undefined && typeof t[key] !== 'string') {
            return `request.tasks[${i}].${key} is not a string`;
          }
        }
      }
      if (req.chain !== undefined) {
        return 'request parallel mode must not include chain';
      }
    } else if (mode === 'chain') {
      if (!Array.isArray(req.chain) || req.chain.length === 0) {
        return 'request chain mode requires a non-empty chain array';
      }
      for (let i = 0; i < req.chain.length; i++) {
        const item = req.chain[i];
        if (!item || typeof item !== 'object') {
          return `request.chain[${i}] is not an object`;
        }
        const step = item as Record<string, unknown>;
        const isFanout = 'expand' in step && !('agent' in step);
        if (isFanout) {
          if (!step.expand || typeof step.expand !== 'object') {
            return `request.chain[${i}].expand is invalid`;
          }
          if (!step.parallel || typeof step.parallel !== 'object') {
            return `request.chain[${i}].parallel is invalid`;
          }
          if (!step.collect || typeof step.collect !== 'object') {
            return `request.chain[${i}].collect is invalid`;
          }
          const parallel = step.parallel as Record<string, unknown>;
          if (typeof parallel.agent !== 'string' || typeof parallel.task !== 'string') {
            return `request.chain[${i}].parallel requires agent and task strings`;
          }
          const collect = step.collect as Record<string, unknown>;
          if (typeof collect.name !== 'string') {
            return `request.chain[${i}].collect.name is not a string`;
          }
          const expand = step.expand as Record<string, unknown>;
          if (!expand.from || typeof expand.from !== 'object') {
            return `request.chain[${i}].expand.from is invalid`;
          }
          const from = expand.from as Record<string, unknown>;
          if (typeof from.output !== 'string' || typeof from.path !== 'string') {
            return `request.chain[${i}].expand.from requires output and path strings`;
          }
        } else {
          if (typeof step.agent !== 'string' || typeof step.task !== 'string') {
            return `request.chain[${i}] requires agent and task strings`;
          }
        }
      }
      if (req.tasks !== undefined) {
        return 'request chain mode must not include tasks';
      }
    }
    return undefined;
  }

  function loadRunJson(
    runId: string
  ): { ok: true; loaded: LoadedRun } | { ok: false; error: RunStoreError } {
    const dir = runDirOf(runId);
    const file = runJsonPath(runId);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          ok: false,
          error: { code: 'run_not_found', runId, message: 'run.json not found' },
        };
      }
      return {
        ok: false,
        error: { code: 'corrupt_run', runId, message: `cannot read run.json: ${messageOf(err)}` },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'corrupt_run',
          runId,
          message: `run.json is not valid JSON: ${messageOf(err)}`,
        },
      };
    }
    const validated = validateRunRecord(parsed, runId, dir);
    if (!validated.ok) return validated;
    return { ok: true, loaded: { runDir: dir, record: validated.record } };
  }

  function writeRunContents(runId: string, record: AgentRunRecordV1): void {
    const dir = runDirOf(runId);
    const target = path.join(dir, 'run.json');
    const tmp = path.join(dir, `.run.json.${instanceId}.${randomUUID()}.tmp`);
    const data = `${JSON.stringify(record, null, 2)}\n`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmp, 'w', FILE_MODE);
      fs.writeFileSync(fd, data);
      fsyncFd(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(tmp, target);
      fsyncDir(dir);
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  function writeRunJsonAtomic(runId: string, record: AgentRunRecordV1): Promise<void> {
    return runSerial(runId, async () => {
      writeRunContents(runId, record);
    });
  }

  function appendEventLine(runId: string, event: RunLifecycleEvent): Promise<void> {
    return runSerial(runId, async () => {
      const file = eventsPath(runId);
      mkdirPrivate(runDirOf(runId));
      const line = `${JSON.stringify(event)}\n`;
      let fd: number | undefined;
      try {
        fd = fs.openSync(file, 'a', FILE_MODE);
        fs.writeFileSync(fd, line);
        fsyncFd(fd);
        fs.closeSync(fd);
        fd = undefined;
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore */
          }
        }
      }
    });
  }

  function ticketDirName(ticket: number): string {
    return ticket.toString().padStart(TICKET_WIDTH, '0');
  }

  function listPublishedTickets(runId: string): number[] {
    const dir = claimsDir(runId);
    if (!fs.existsSync(dir)) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const tickets: number[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      const n = parseInt(entry.name, 10);
      if (Number.isFinite(n) && entry.name === ticketDirName(n)) {
        tickets.push(n);
      }
    }
    return tickets.sort((a, b) => a - b);
  }

  function readOwner(
    ticket: number,
    runId: string
  ): { ok: true; owner: ClaimOwner } | { ok: false; error: RunStoreError } {
    const ownerPath = path.join(claimsDir(runId), ticketDirName(ticket), 'owner.json');
    let content: string;
    try {
      content = fs.readFileSync(ownerPath, 'utf-8');
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'claim_corrupt',
          runId,
          message: `cannot read owner.json: ${messageOf(err)}`,
        },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'claim_corrupt',
          runId,
          message: `owner.json is not valid JSON: ${messageOf(err)}`,
        },
      };
    }
    if (!parsed || typeof parsed !== 'object') {
      return {
        ok: false,
        error: { code: 'claim_corrupt', runId, message: 'owner.json is not an object' },
      };
    }
    const o = parsed as Partial<ClaimOwner>;
    if (
      typeof o.runId !== 'string' ||
      typeof o.claimId !== 'string' ||
      typeof o.instanceId !== 'string' ||
      typeof o.pid !== 'number' ||
      typeof o.acquiredAt !== 'number'
    ) {
      return {
        ok: false,
        error: { code: 'claim_corrupt', runId, message: 'owner.json missing required fields' },
      };
    }
    return { ok: true, owner: o as ClaimOwner };
  }

  function readTerminal(
    ticket: number,
    runId: string
  ):
    | { ok: true; terminal: ClaimTerminal }
    | { ok: false; error: RunStoreError }
    | { ok: false; missing: true } {
    const terminalPath = path.join(claimsDir(runId), ticketDirName(ticket), 'terminal.json');
    let content: string;
    try {
      content = fs.readFileSync(terminalPath, 'utf-8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ok: false, missing: true };
      return {
        ok: false,
        error: {
          code: 'claim_corrupt',
          runId,
          message: `cannot read terminal.json: ${messageOf(err)}`,
        },
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'claim_corrupt',
          runId,
          message: `terminal.json is not valid JSON: ${messageOf(err)}`,
        },
      };
    }
    if (!parsed || typeof parsed !== 'object') {
      return {
        ok: false,
        error: { code: 'claim_corrupt', runId, message: 'terminal.json is not an object' },
      };
    }
    const t = parsed as Partial<ClaimTerminal>;
    if (
      typeof t.claimId !== 'string' ||
      typeof t.timestamp !== 'number' ||
      (t.state !== 'released' && t.state !== 'abandoned')
    ) {
      return {
        ok: false,
        error: { code: 'claim_corrupt', runId, message: 'terminal.json missing required fields' },
      };
    }
    return { ok: true, terminal: t as ClaimTerminal };
  }

  function publishClaimTerminal(
    runId: string,
    ticket: number,
    claimId: string,
    state: 'released' | 'abandoned'
  ): Promise<void> {
    return runSerial(runId, async () => {
      const ticketDirectory = path.join(claimsDir(runId), ticketDirName(ticket));
      const terminalPath = path.join(ticketDirectory, 'terminal.json');
      const stagedPath = path.join(ticketDirectory, `.terminal.${instanceId}.${randomUUID()}.tmp`);
      const payload = JSON.stringify({ claimId, state, timestamp: now() }) + '\n';
      let fd: number | undefined;
      try {
        fd = fs.openSync(stagedPath, 'w', FILE_MODE);
        fs.writeFileSync(fd, payload);
        fsyncFd(fd);
        fs.closeSync(fd);
        fd = undefined;
        try {
          fs.linkSync(stagedPath, terminalPath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'EEXIST') {
            const winner = readTerminal(ticket, runId);
            if ('ok' in winner && !winner.ok && !('missing' in winner)) {
              throw winner.error;
            }
            // If the winner's claimId does not match ours, another claimant
            // published a terminal for our ticket directory. Record the
            // diagnostic but do not throw — our release is still durable.
            if ('ok' in winner && winner.ok && winner.terminal.claimId !== claimId) {
              void winner;
            }
            // A terminal already exists; our release is redundant but not an error.
          } else {
            throw err;
          }
        }
        fsyncDir(ticketDirectory);
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            /* ignore */
          }
        }
        try {
          if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
        } catch {
          /* ignore */
        }
      }
    });
  }

  function stageOwner(
    runId: string,
    ticket: number,
    owner: ClaimOwner
  ): { stagingDir: string; ticketDirectory: string; stagedOwnerPath: string } {
    const ticketDirectory = path.join(claimsDir(runId), ticketDirName(ticket));
    const stagingDir = path.join(claimsDir(runId), `.staging-${randomUUID()}`);
    mkdirPrivate(stagingDir);
    const stagedOwnerPath = path.join(stagingDir, 'owner.json');
    const data = JSON.stringify(owner, null, 2) + '\n';
    let fd: number | undefined;
    try {
      fd = fs.openSync(stagedOwnerPath, 'w', FILE_MODE);
      fs.writeFileSync(fd, data);
      fsyncFd(fd);
      fs.closeSync(fd);
      fd = undefined;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
    return { stagingDir, ticketDirectory, stagedOwnerPath };
  }

  function cleanupStaging(stagingDir: string): void {
    try {
      if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  type PublishResult =
    { ok: true } | { ok: false; retry: true } | { ok: false; error: RunStoreError };

  function publishStagedOwner(
    runId: string,
    ticket: number,
    stagingDir: string,
    _stagedOwnerPath: string
  ): PublishResult {
    const ticketDirectory = path.join(claimsDir(runId), ticketDirName(ticket));
    try {
      fs.renameSync(stagingDir, ticketDirectory);
      applyMode(ticketDirectory, DIR_MODE);
      return { ok: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') {
        // A competing claimant won this ticket; retry with a higher ticket.
        return { ok: false, retry: true };
      }
      return {
        ok: false,
        error: {
          code: 'claim_corrupt',
          runId,
          message: `failed to publish owner: ${messageOf(err)}`,
        },
      };
    }
  }

  function writeOwnerForTicket(
    runId: string,
    ticket: number,
    claimId: string
  ): { stagingDir: string; stagedOwnerPath: string; owner: ClaimOwner } {
    const owner: ClaimOwner = {
      runId,
      claimId,
      instanceId,
      pid,
      acquiredAt: now(),
    };
    const { stagingDir, stagedOwnerPath } = stageOwner(runId, ticket, owner);
    return { stagingDir, stagedOwnerPath, owner };
  }

  function lowestEligibleTicket(
    runId: string
  ): { ok: true; ticket: number; owner?: ClaimOwner } | { ok: false; error: RunStoreError } {
    const tickets = listPublishedTickets(runId);
    for (const ticket of tickets) {
      const ownerResult = readOwner(ticket, runId);
      if (!ownerResult.ok) {
        return { ok: false, error: ownerResult.error };
      }
      const terminal = readTerminal(ticket, runId);
      if (!terminal.ok && !('missing' in terminal)) {
        return { ok: false, error: terminal.error };
      }
      if (terminal.ok) {
        // This ticket has terminated; skip it regardless of state.
        continue;
      }
      // Live or abandoned-without-terminal: candidate. Check PID liveness below.
      const owner = ownerResult.owner;
      if (owner.pid === pid && owner.instanceId === instanceId) {
        return { ok: true, ticket, owner };
      }
      if (isPidAlive(owner.pid)) {
        // Another live process owns this lower ticket; we must withdraw.
        return { ok: true, ticket, owner };
      }
      // Dead owner — abandon it so the high-water mark advances.
      try {
        publishClaimTerminalSync(runId, ticket, owner.claimId, 'abandoned');
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'claim_corrupt',
            runId,
            message: `failed to abandon dead claim: ${messageOf(err)}`,
          },
        };
      }
      continue;
    }
    return { ok: true, ticket: -1 };
  }

  function publishClaimTerminalSync(
    runId: string,
    ticket: number,
    claimId: string,
    state: 'released' | 'abandoned'
  ): void {
    const ticketDirectory = path.join(claimsDir(runId), ticketDirName(ticket));
    const terminalPath = path.join(ticketDirectory, 'terminal.json');
    const stagedPath = path.join(ticketDirectory, `.terminal.${instanceId}.${randomUUID()}.tmp`);
    const payload = JSON.stringify({ claimId, state, timestamp: now() }) + '\n';
    let fd: number | undefined;
    try {
      fd = fs.openSync(stagedPath, 'w', FILE_MODE);
      fs.writeFileSync(fd, payload);
      fsyncFd(fd);
      fs.closeSync(fd);
      fd = undefined;
      try {
        fs.linkSync(stagedPath, terminalPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw err;
      }
      fsyncDir(ticketDirectory);
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      try {
        if (fs.existsSync(stagedPath)) fs.unlinkSync(stagedPath);
      } catch {
        /* ignore */
      }
    }
  }

  function isPidAlive(pid: number): boolean {
    if (pid <= 0) return false;
    if (pid === (options.pid ?? process.pid)) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH' || code === 'ENOSYS' || code === 'EPERM') {
        // EPERM means the process exists but we lack permission — treat as alive.
        return code === 'EPERM';
      }
      return false;
    }
  }

  async function createRun(
    input: CreateRunInput
  ): Promise<{ runId: string; record: AgentRunRecordV1 }> {
    const runId = `run-${randomUUID()}`;
    if (!isRunIdValid(runId)) {
      throw new Error(`Invalid generated run id: ${runId}`);
    }
    const dir = runDirOf(runId);
    mkdirPrivate(dir);
    mkdirPrivate(claimsDir(runId));
    mkdirPrivate(path.join(dir, 'sessions'));
    const ts = now();
    const record: AgentRunRecordV1 = {
      version: RUN_RECORD_VERSION,
      runId,
      mode: input.mode,
      status: 'queued',
      request: input.request,
      background: input.background,
      agentScope: input.agentScope,
      createdAt: ts,
      updatedAt: ts,
      details: input.details,
      units: input.units,
      eventsFile: 'events.jsonl',
    };
    await writeRunJsonAtomic(runId, record);
    await appendEventLine(runId, { version: 1, event: 'run_created', runId, timestamp: ts });
    return { runId, record };
  }

  function getRun(runId: string): ReturnType<RunStore['getRun']> {
    if (!isRunIdValid(runId)) {
      return { ok: false, error: { code: 'run_not_found', runId, message: 'invalid run id' } };
    }
    return loadRunJson(runId);
  }

  async function updateRun(
    runId: string,
    mutate: (record: AgentRunRecordV1) => void
  ): Promise<AgentRunRecordV1> {
    return runSerial(runId, async () => {
      const loaded = loadRunJson(runId);
      if (!loaded.ok) throw loaded.error;
      const record = loaded.loaded.record;
      mutate(record);
      record.updatedAt = now();
      writeRunContents(runId, record);
      return record;
    });
  }

  async function appendEvent(runId: string, event: RunLifecycleEvent): Promise<void> {
    await appendEventLine(runId, event);
  }

  async function listRuns(): Promise<ListRunsResult> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const results: ListRunsResult = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runId = entry.name;
      if (!isRunIdValid(runId)) continue;
      const loaded = loadRunJson(runId);
      if (loaded.ok) {
        results.push(loaded.loaded);
      } else {
        const corrupt: CorruptRunEntry = {
          runId,
          runDir: runDirOf(runId),
          code: 'corrupt_run',
          message: loaded.error.message,
        };
        results.push(corrupt);
      }
    }
    results.sort((a, b) => {
      const at = 'record' in a ? a.record.updatedAt : 0;
      const bt = 'record' in b ? b.record.updatedAt : 0;
      return bt - at;
    });
    return results;
  }

  async function claimRun(runId: string): Promise<ClaimResult> {
    if (!isRunIdValid(runId)) {
      return { ok: false, error: { code: 'run_not_found', runId, message: 'invalid run id' } };
    }
    const loaded = loadRunJson(runId);
    if (!loaded.ok) return { ok: false, error: loaded.error };

    const claimId = randomUUID();
    let ticket = 1;
    let attempt = 0;
    // Publish our ticket directory, retrying with higher tickets until we win or withdraw.
    for (;;) {
      attempt++;
      const tickets = listPublishedTickets(runId);
      if (tickets.length > 0) {
        ticket = tickets[tickets.length - 1] + 1;
      } else {
        ticket = 1;
      }
      const { stagingDir, stagedOwnerPath, owner } = writeOwnerForTicket(runId, ticket, claimId);
      const publish = publishStagedOwner(runId, ticket, stagingDir, stagedOwnerPath);
      if ('ok' in publish && publish.ok) {
        fsyncDir(path.join(claimsDir(runId), ticketDirName(ticket)));
        // We published a ticket. Determine if it is the lowest eligible.
        const lowest = lowestEligibleTicket(runId);
        cleanupStaging(stagingDir);
        if (!lowest.ok) {
          // Withdraw our published claim.
          await publishClaimTerminal(runId, ticket, claimId, 'released');
          return { ok: false, error: lowest.error };
        }
        if (lowest.ticket === ticket) {
          // We are the lowest eligible.
          try {
            await updateRun(runId, (record) => {
              record.owner = {
                claimId,
                ticket,
                instanceId,
                pid,
                acquiredAt: owner.acquiredAt,
              };
            });
          } catch (err) {
            await publishClaimTerminal(runId, ticket, claimId, 'released');
            return {
              ok: false,
              error: { code: 'run_store_error', runId, message: messageOf(err) },
            };
          }
          return { ok: true, claimId, ticket };
        }
        // A lower eligible ticket exists. Withdraw and report run_active.
        await publishClaimTerminal(runId, ticket, claimId, 'released');
        return {
          ok: false,
          error: { code: 'run_active', runId, message: 'another live claim holds this run' },
        };
      }
      if (!publish.ok && 'error' in publish) {
        cleanupStaging(stagingDir);
        return { ok: false, error: publish.error };
      }
      // Retry with a higher ticket.
      cleanupStaging(stagingDir);
      if (attempt > 10_000) {
        return {
          ok: false,
          error: { code: 'run_store_error', runId, message: 'claim loop overflow' },
        };
      }
    }
  }

  async function releaseRun(runId: string, claimId: string): Promise<void> {
    await releaseClaim(runId, claimId, 'released');
  }

  async function abandonRun(runId: string, claimId: string): Promise<void> {
    await releaseClaim(runId, claimId, 'abandoned');
  }

  async function releaseClaim(
    runId: string,
    claimId: string,
    state: 'released' | 'abandoned'
  ): Promise<void> {
    // Resolve the ticket directory whose owner matches this claimId, and verify
    // the immutable owner payload belongs to *this* store instance. A foreign
    // caller must never terminate another owner's claim.
    const tickets = listPublishedTickets(runId);
    let resolvedTicket: number | undefined;
    for (const ticket of tickets) {
      const ownerResult = readOwner(ticket, runId);
      if (
        ownerResult.ok &&
        ownerResult.owner.claimId === claimId &&
        ownerResult.owner.instanceId === instanceId &&
        ownerResult.owner.pid === pid
      ) {
        resolvedTicket = ticket;
        break;
      }
    }
    if (resolvedTicket === undefined) {
      // No published claim owned by this instance+p+c with the given claimId.
      // A release for a foreign or nonexistent claim is a no-op; treat the
      // claim directory as durable precedent and do not modify it.
      return;
    }
    await publishClaimTerminal(runId, resolvedTicket, claimId, state);
  }

  function inspectClaims(runId: string):
    | {
        ok: true;
        claims: Array<{
          ticket: number;
          owner?: ClaimOwner;
          terminal?: ClaimTerminal;
          ownerError?: string;
          terminalError?: string;
        }>;
      }
    | { ok: false; error: RunStoreError } {
    if (!isRunIdValid(runId)) {
      return { ok: false, error: { code: 'run_not_found', runId, message: 'invalid run id' } };
    }
    const tickets = listPublishedTickets(runId);
    const claims: Array<{
      ticket: number;
      owner?: ClaimOwner;
      terminal?: ClaimTerminal;
      ownerError?: string;
      terminalError?: string;
    }> = [];
    for (const ticket of tickets) {
      const owner = readOwner(ticket, runId);
      const terminal = readTerminal(ticket, runId);
      claims.push({
        ticket,
        owner: owner.ok ? owner.owner : undefined,
        terminal: 'ok' in terminal && terminal.ok ? terminal.terminal : undefined,
        ...(!owner.ok ? { ownerError: owner.error.message } : {}),
        ...(!('ok' in terminal) || !terminal.ok
          ? !('missing' in terminal)
            ? { terminalError: (terminal as { error: RunStoreError }).error.message }
            : {}
          : {}),
      });
    }
    return { ok: true, claims };
  }

  return {
    rootDir,
    getRunDir,
    createRun,
    getRun,
    updateRun,
    appendEvent,
    listRuns,
    claimRun,
    releaseRun,
    abandonRun,
    inspectClaims,
    isPidAlive,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
