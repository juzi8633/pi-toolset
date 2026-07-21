// ABOUTME: Chain execution engine — orchestrates sequential subagent steps with templated handoff.
// ABOUTME: Exposes runChainWorkflow with injectable runStep so the loop is unit-testable without spawning pi.

import type { Static } from '@earendil-works/pi-ai';
import type { AgentToolResult, AgentToolUpdateCallback } from '@earendil-works/pi-coding-agent';
import type { AgentConfig, AgentSource } from '../config/agents.ts';
import { MAX_CONCURRENCY, MAX_FANOUT_ITEMS, RESULT_UPDATE_INTERVAL_MS } from '../shared/constants.ts';
import { createLatestValueCoalescer } from '../shared/update-coalescer.ts';
import { runEffectThrowingAsIs, tryPromiseUnknown } from '../shared/effect-runtime.ts';
import { ABORT_MESSAGE, getAbortResult, isAbortError, type OnUpdateCallback } from './execution.ts';
import { readJsonPointer } from '../output/json-pointer.ts';
import {
  applyTerminalStatus,
  getResultFinalOutput,
  getResultOutput,
  getResultParentOutput,
  isFailedResult,
  resolveExecutionStatus,
} from '../output/output.ts';
import type { ChainItem } from '../shared/schema.ts';
import {
  buildStructuredOutputInstruction,
  extractJsonFromFinalOutput,
  validateStructuredOutput,
  type JsonSchemaSubset,
  type JsonValue,
} from '../output/structured-output.ts';
import { emptyUsage } from '../shared/empty-usage.ts';
import { renderTaskTemplate } from '../output/template.ts';
import { formatChildArtifactDescriptor } from '../output/result-payload.ts';
import { copySnapshotShell, snapshotSingleResult } from '../output/result-snapshot.ts';
import {
  cloneSingleResult,
  type ChainExecutionDetails,
  type ChainFanoutStep,
  type ChainLogicalStep,
  type ChainOutputEntry,
  type ChainSequentialStep,
  type IsolationMode,
  type SingleResult,
  type SubagentDetails,
} from '../shared/types.ts';
import { chainFanoutStepId, chainStepUnitId } from '../run/run-coordinator.ts';
import type { RunUnitRecord, WorkflowFanoutState } from '../run/run-types.ts';

export type ChainItemInput = Static<typeof ChainItem>;

type SequentialStep = Extract<ChainItemInput, { agent: string }>;
type FanoutStep = Extract<ChainItemInput, { expand: unknown }>;

export type DetailsFactory = (
  results: SingleResult[],
  outputs?: Record<string, ChainOutputEntry>
) => SubagentDetails;

export interface ChainStepRequest {
  agent: string;
  task: string;
  /** Short collapsed-summary label for this step. */
  title?: string;
  cwd: string | undefined;
  isolation: IsolationMode | undefined;
  taskIndex: number;
  step: number;
  /** Zero-based fanout item index when this request is a fanout child. */
  fanoutIndex?: number;
  signal: AbortSignal | undefined;
  onUpdate: OnUpdateCallback | undefined;
  skipCompletionCheck?: boolean;
  /**
   * Optional terminal postprocessor. Production adapters run this before worktree
   * cleanup and durable endUnit so schema-validated results are persisted.
   * Callers that ignore it still get the same result via the chain-side call.
   */
  postprocessTerminal?: (result: SingleResult) => void;
  /** When true, the Pi child needs the dedicated artifact reader for handoffs. */
  requireArtifactReader?: boolean;
}

export type ChainRunStep = (req: ChainStepRequest) => Promise<SingleResult>;

/**
 * Fanout worker pool (Phase 7):
 * Same cancel-safe scheduling contract as `mapWithConcurrencyLimit`:
 * - clamp concurrency to [1, items.length]
 * - stop scheduling on error or AbortSignal; wait for in-flight workers
 * - fill unstarted slots via onUnstarted; then rethrow first error
 * Each worker body runs through `runEffectThrowingAsIs(tryPromiseUnknown(...))`
 * so typed failures rethrow as-is (Error or plain objects).
 * Index-based slot writes stay inside the worker; pool order of completion
 * must not scramble fanout indices.
 */
async function runFanoutWorkers<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  signal: AbortSignal | undefined,
  worker: (item: TIn, index: number) => Promise<TOut>,
  onUnstarted?: (item: TIn, index: number) => TOut
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  const started = new Array<boolean>(items.length).fill(false);
  let nextIndex = 0;
  let stopScheduling = false;
  let firstError: unknown;

  const claim = (): number | null => {
    if (stopScheduling || signal?.aborted) {
      stopScheduling = true;
      return null;
    }
    const current = nextIndex++;
    if (current >= items.length) return null;
    started[current] = true;
    return current;
  };

  const runOne = (item: TIn, index: number): Promise<TOut> =>
    runEffectThrowingAsIs(tryPromiseUnknown(() => worker(item, index)));

  const pool = Array.from({ length: limit }, async () => {
    while (true) {
      const current = claim();
      if (current === null) return;
      try {
        results[current] = await runOne(items[current], current);
      } catch (err) {
        if (firstError === undefined) firstError = err;
        stopScheduling = true;
      }
    }
  });

  await Promise.all(pool);

  if (onUnstarted) {
    for (let i = 0; i < items.length; i++) {
      if (!started[i] || results[i] === undefined) {
        if (results[i] === undefined) {
          results[i] = onUnstarted(items[i], i);
        }
      }
    }
  }

  if (firstError !== undefined) throw firstError;
  return results;
}

export interface RestoredChainState {
  results: SingleResult[];
  outputs: Record<string, ChainOutputEntry>;
  logicalSteps: ChainLogicalStep[];
  units: Record<string, RunUnitRecord>;
  fanouts?: Record<string, WorkflowFanoutState>;
}

/** Storage-agnostic fanout expansion request passed to the durability hook. */
export interface FanoutExpandRequest {
  step: number;
  items: unknown[];
  agent: string;
  effectiveCwd?: string;
}

export interface RunChainWorkflowOptions {
  chain: ChainItemInput[];
  signal: AbortSignal | undefined;
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined;
  makeDetails: DetailsFactory;
  runStep: ChainRunStep;
  /** Restored state from a previous interrupted run; when present, completed steps are skipped. */
  restored?: RestoredChainState;
  /**
   * Optional awaited expansion hook. Called after items are known and before
   * any worker is scheduled. Must not receive RunStore/RunCoordinator.
   */
  onFanoutExpand?: (req: FanoutExpandRequest) => Promise<WorkflowFanoutState | void>;
  /** Trusted artifact resolver for structured refs (production workflow path only). */
  resolveArtifact?: (ref: import('../run/run-types.ts').RunArtifactRefV1) => Promise<unknown>;
  /**
   * Optional awaited Chain-output externalizer. Spills oversized collected
   * text/structured values to run artifacts before they enter details.outputs
   * or later {previous}/named outputs. Returns inline values or verified refs.
   */
  externalizeChainOutput?: ChainOutputExternalizer;
}

/** Spills oversized Chain collect text/structured values into run artifacts. */
export interface ChainOutputExternalizer {
  text?: (
    text: string
  ) => Promise<{ text?: string; textRef?: import('../run/run-types.ts').RunArtifactRefV1 }>;
  json?: (
    value: unknown
  ) => Promise<{ value?: unknown; valueRef?: import('../run/run-types.ts').RunArtifactRefV1 }>;
}

export type ChainResult = AgentToolResult<SubagentDetails> & { isError?: boolean };

export function synthesizeFailure(
  agentName: string,
  agent: AgentConfig | undefined,
  task: string,
  step: number | undefined,
  stopReason: string,
  message: string,
  title?: string
): SingleResult {
  return {
    agent: agentName,
    agentSource: (agent?.source ?? 'unknown') as AgentSource | 'unknown',
    task,
    title,
    exitCode: 1,
    status: 'failed',
    messages: [],
    stderr: message,
    usage: emptyUsage(),
    stopReason,
    errorMessage: message,
    step,
  };
}

function initLogicalSteps(chain: ChainItemInput[]): ChainLogicalStep[] {
  return chain.map((step, i) => {
    const stepNumber = i + 1;
    if (isFanoutChainStep(step)) {
      const fanout: ChainFanoutStep = {
        kind: 'fanout',
        step: stepNumber,
        agent: step.parallel.agent,
        taskTemplate: step.parallel.task,
        title: step.parallel.title,
        status: 'queued',
        sourceOutput: step.expand.from.output,
        sourcePath: step.expand.from.path,
        collectName: step.collect.name,
        concurrency:
          typeof step.concurrency === 'number' ? Math.floor(step.concurrency) : undefined,
        executedCount: 0,
        completedCount: 0,
        failedCount: 0,
        runningCount: 0,
        queuedCount: 0,
        skippedCount: 0,
      };
      return fanout;
    }
    const sequential = step as SequentialStep;
    const seq: ChainSequentialStep = {
      kind: 'sequential',
      step: stepNumber,
      agent: sequential.agent,
      task: sequential.task,
      title: sequential.title,
      status: 'queued',
    };
    return seq;
  });
}

/**
 * Overlay trustworthy presentation counters/status onto a topology-backed step.
 * Topology fields (agent, task, expand source) stay from the request; only
 * presentation progress fields are copied when kinds match.
 */
function overlayPresentationStep(
  base: ChainLogicalStep,
  presentation: ChainLogicalStep
): ChainLogicalStep {
  if (base.kind !== presentation.kind || base.step !== presentation.step) {
    return base;
  }
  if (base.kind === 'sequential' && presentation.kind === 'sequential') {
    return {
      ...base,
      status: presentation.status,
      ...(presentation.title !== undefined ? { title: presentation.title } : {}),
    };
  }
  if (base.kind === 'fanout' && presentation.kind === 'fanout') {
    return {
      ...base,
      status: presentation.status,
      ...(presentation.title !== undefined ? { title: presentation.title } : {}),
      ...(presentation.concurrency !== undefined ? { concurrency: presentation.concurrency } : {}),
      executedCount: presentation.executedCount,
      completedCount: presentation.completedCount,
      failedCount: presentation.failedCount,
      runningCount: presentation.runningCount,
      queuedCount: presentation.queuedCount,
      skippedCount: presentation.skippedCount,
      ...(presentation.latestIndex !== undefined ? { latestIndex: presentation.latestIndex } : {}),
    };
  }
  return base;
}

/**
 * True when an empty fanout has durable completion evidence beyond the frozen
 * expansion mapping. Expansion is persisted before collect output, so mapping
 * alone is not proof that `[]` was written into previous/output context.
 */
function hasEmptyFanoutCompletionEvidence(
  logical: ChainFanoutStep,
  outputs?: Record<string, ChainOutputEntry>
): boolean {
  if (logical.status === 'completed') return true;
  const entry = outputs?.[logical.collectName];
  return entry !== undefined && entry.step === logical.step;
}

/** Copy an output entry and isolate structured payload from shared mutable sources. */
function isolateOutputEntry(entry: ChainOutputEntry): ChainOutputEntry {
  return {
    ...(entry.text !== undefined ? { text: entry.text } : {}),
    ...(entry.textRef ? { textRef: { ...entry.textRef } } : {}),
    ...(entry.structured !== undefined ? { structured: structuredClone(entry.structured) } : {}),
    ...(entry.structuredRef ? { structuredRef: { ...entry.structuredRef } } : {}),
    agent: entry.agent,
    step: entry.step,
  };
}

/** Build chain previous/named output from a terminal unit result (inline or ref). */
function chainOutputFromResult(
  result: SingleResult,
  agent: string,
  step: number
): ChainOutputEntry {
  const entry: ChainOutputEntry = { agent, step };
  if (result.finalOutputRef)
    entry.textRef = { ...result.finalOutputRef, payload: 'chain-output-text' };
  else entry.text = getResultFinalOutput(result);
  if (result.structuredOutputRef) {
    entry.structuredRef = { ...result.structuredOutputRef, payload: 'chain-output-structured' };
  } else if (result.structuredOutput !== undefined) {
    entry.structured = result.structuredOutput;
  }
  return entry;
}

function previousTextFromResult(result: SingleResult): string {
  if (result.finalOutputRef) {
    return formatChildArtifactDescriptor({
      ...result.finalOutputRef,
      payload: 'chain-output-text',
    });
  }
  return getResultFinalOutput(result);
}

/**
 * Build a complete restored logical-step array from request topology.
 * Overlays trustworthy presentation state by step number (never by unchecked
 * index into a shortened presentation array). When presentation is absent or
 * short, derive completed/queued status from durable units and frozen fanout
 * mappings so selective resume skips finished sequential work. All-completed
 * continuation reopens units to non-completed first, so those steps re-queue.
 */
export function buildRestoredLogicalSteps(
  chain: ChainItemInput[],
  presentationSteps: ChainLogicalStep[] | undefined,
  units: Record<string, RunUnitRecord>,
  fanouts?: Record<string, WorkflowFanoutState>,
  outputs?: Record<string, ChainOutputEntry>
): ChainLogicalStep[] {
  const logicalSteps = initLogicalSteps(chain);

  if (presentationSteps && presentationSteps.length > 0) {
    const byStep = new Map<number, ChainLogicalStep>();
    for (const step of presentationSteps) {
      if (typeof step.step === 'number' && step.step >= 1) {
        byStep.set(step.step, step);
      }
    }
    for (let i = 0; i < logicalSteps.length; i++) {
      const base = logicalSteps[i]!;
      const presentation = byStep.get(base.step);
      if (presentation) {
        logicalSteps[i] = overlayPresentationStep(base, presentation);
      }
    }
  }

  // Authoritative status from durable units / frozen mappings. Presentation
  // may be absent, shortened, or stale; unit status is the resume authority.
  // Sequential completed work is marked completed so selective resume skips it.
  // Fanout steps re-queue whenever any child is incomplete (including reopened
  // continuation units). Fully completed fanouts keep presentation status so
  // runFanoutStep can rebuild slots without redispatch when needed.
  for (let i = 0; i < logicalSteps.length; i++) {
    const logical = logicalSteps[i]!;
    const stepNumber = logical.step;
    if (logical.kind === 'sequential') {
      const unit = units[chainStepUnitId(stepNumber)];
      if (!unit) continue;
      logicalSteps[i] = {
        ...logical,
        status: unit.status === 'completed' ? 'completed' : 'queued',
      };
      continue;
    }

    // Fanout: prefer frozen mapping; fall back to durable children for the step.
    const mapping = fanouts?.[chainFanoutStepId(stepNumber)];
    if (mapping) {
      if (mapping.unitIds.length === 0) {
        // Empty frozen mapping alone is not completed evidence: expansion is
        // written before collect output. Absent/incomplete presentation/output
        // re-queues so the zero-worker fanout reconstructs `[]` context.
        const fanout = logical as ChainFanoutStep;
        logicalSteps[i] = {
          ...fanout,
          status: hasEmptyFanoutCompletionEvidence(fanout, outputs) ? 'completed' : 'queued',
        };
        continue;
      }
      const anyIncomplete = mapping.unitIds.some((id) => {
        const unit = units[id];
        return !unit || unit.status !== 'completed';
      });
      if (anyIncomplete) {
        logicalSteps[i] = { ...logical, status: 'queued' };
      }
      continue;
    }

    const children = Object.values(units).filter(
      (u) => u.step === stepNumber && u.fanoutIndex !== undefined
    );
    if (children.length === 0) continue;
    if (children.some((u) => u.status !== 'completed')) {
      logicalSteps[i] = { ...logical, status: 'queued' };
    }
  }

  return logicalSteps;
}

function markLaterSkipped(logicalSteps: ChainLogicalStep[], fromIndex: number): void {
  for (let j = fromIndex; j < logicalSteps.length; j++) {
    if (logicalSteps[j].status === 'queued' || logicalSteps[j].status === 'running') {
      if (logicalSteps[j].status === 'queued') logicalSteps[j].status = 'skipped';
    }
  }
}

function upsertSequentialResult(results: SingleResult[], result: SingleResult): void {
  const step = result.step;
  const idx = results.findIndex((r) => r.step === step && r.fanout === undefined);
  if (idx >= 0) results[idx] = result;
  else results.push(result);
}

function cloneLogicalSteps(steps: ChainLogicalStep[]): ChainLogicalStep[] {
  return steps.map((s) => ({ ...s }));
}

/** Read-only completed sequential unit result; never mutate the returned object. */
function durableCompletedSequentialResult(
  units: Record<string, RunUnitRecord>,
  stepNumber: number
): SingleResult | undefined {
  const unit = units[chainStepUnitId(stepNumber)];
  if (unit?.status === 'completed' && unit.result) return unit.result;
  return undefined;
}

function resultText(result: SingleResult): string {
  return getResultFinalOutput(result);
}

/**
 * Prefer authoritative durable sequential unit results over lagging presentation
 * `details.results` / `details.outputs`. Clones into mutable workflow state so
 * stored unit results are never mutated.
 */
function rehydrateCompletedSequentialFromDurable(
  chain: ChainItemInput[],
  results: SingleResult[],
  outputs: Map<string, ChainOutputEntry>,
  units: Record<string, RunUnitRecord>
): void {
  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    if (!step || isFanoutChainStep(step) || isAmbiguousChainStep(step)) continue;
    const sequential = step as SequentialStep;
    const stepNumber = i + 1;
    const durableResult = durableCompletedSequentialResult(units, stepNumber);
    if (!durableResult) continue;

    // Compact into snapshot-owned immutable results before aggregate sharing.
    let snap = snapshotSingleResult(durableResult);
    if (snap.step === undefined) {
      const shell = copySnapshotShell(snap);
      shell.step = stepNumber;
      snap = snapshotSingleResult(shell);
    }
    upsertSequentialResult(results, snap);

    if (!sequential.name) continue;
    // Later-step-wins: never overwrite a same-named entry recorded by a later
    // sequential or fanout collect step. Replace only missing, same-step stale,
    // or earlier-step entries.
    const existing = outputs.get(sequential.name);
    if (existing !== undefined && existing.step > stepNumber) continue;
    outputs.set(
      sequential.name,
      isolateOutputEntry(chainOutputFromResult(durableResult, sequential.agent, stepNumber))
    );
  }
}

/**
 * Previous-output text for a completed logical step.
 * Fanout: collect output is authoritative; never select a single child result.
 * Sequential: presentation result first, else durable unit result.
 */
function completedStepPreviousOutput(
  logical: ChainLogicalStep,
  results: SingleResult[],
  outputs: Map<string, ChainOutputEntry>,
  units: Record<string, RunUnitRecord> | undefined
): string | undefined {
  const stepNumber = logical.step;

  if (logical.kind === 'fanout') {
    const entry = outputs.get(logical.collectName);
    if (entry) return entry.text ?? '';
    return undefined;
  }

  const stepResults = results.filter((r) => r.step === stepNumber && r.fanout === undefined);
  const last = stepResults[stepResults.length - 1];
  if (last) return resultText(last);

  if (logical.kind === 'sequential' && units) {
    const durableResult = durableCompletedSequentialResult(units, stepNumber);
    if (durableResult) return resultText(durableResult);
  }

  return undefined;
}

/**
 * Previous-output textRef for a completed logical step, when its authority is a
 * spilled text artifact.
 * Fanout: collect textRef is authoritative; never select a single child ref.
 * Sequential: presentation result first, else durable unit result.
 */
function completedStepPreviousRef(
  logical: ChainLogicalStep,
  results: SingleResult[],
  outputs: Map<string, ChainOutputEntry>,
  units: Record<string, RunUnitRecord> | undefined
): ChainOutputEntry['textRef'] | undefined {
  const stepNumber = logical.step;

  if (logical.kind === 'fanout') {
    const entry = outputs.get(logical.collectName);
    if (entry?.textRef) return { ...entry.textRef };
    return undefined;
  }

  const stepResults = results.filter((r) => r.step === stepNumber && r.fanout === undefined);
  const last = stepResults[stepResults.length - 1];
  if (last?.finalOutputRef) {
    return { ...last.finalOutputRef, payload: 'chain-output-text' };
  }
  if (logical.kind === 'sequential' && units) {
    const durableResult = durableCompletedSequentialResult(units, stepNumber);
    if (durableResult?.finalOutputRef) {
      return { ...durableResult.finalOutputRef, payload: 'chain-output-text' };
    }
  }
  return undefined;
}

export async function runChainWorkflow(options: RunChainWorkflowOptions): Promise<ChainResult> {
  const {
    chain,
    signal,
    onUpdate,
    makeDetails,
    runStep,
    restored,
    onFanoutExpand,
    resolveArtifact,
    externalizeChainOutput,
  } = options;
  let results: SingleResult[];
  let previousOutput = '';
  let previousRef: ChainOutputEntry['textRef'] | undefined;
  const outputs = new Map<string, ChainOutputEntry>();
  let logicalSteps: ChainLogicalStep[];

  if (restored) {
    // Normalize into snapshot-owned immutable results before workflow mutation/sharing.
    results = restored.results.map((r) => snapshotSingleResult(r));
    for (const [name, entry] of Object.entries(restored.outputs)) {
      // Isolate structured payloads so mutation of restored details.outputs cannot leak.
      outputs.set(name, isolateOutputEntry(entry));
    }
    // Prefer durable completed sequential unit results when presentation lags.
    rehydrateCompletedSequentialFromDurable(chain, results, outputs, restored.units);
    // Prefer a complete topology-backed array; pad any short restored snapshot
    // from the request chain so later step indexing is never unchecked.
    logicalSteps = buildRestoredLogicalSteps(
      chain,
      restored.logicalSteps,
      restored.units,
      restored.fanouts,
      Object.fromEntries(outputs)
    );
    // Recompute previousOutput/previousRef from the last completed sequential/fanout step.
    for (let i = logicalSteps.length - 1; i >= 0; i--) {
      const logical = logicalSteps[i];
      if (logical?.status === 'completed') {
        const text = completedStepPreviousOutput(logical, results, outputs, restored.units);
        if (text !== undefined) previousOutput = text;
        const ref = completedStepPreviousRef(logical, results, outputs, restored.units);
        previousRef = ref;
        break;
      }
    }
  } else {
    results = [];
    logicalSteps = initLogicalSteps(chain);
  }

  const outputsRecord = (): Record<string, ChainOutputEntry> => {
    const out: Record<string, ChainOutputEntry> = {};
    for (const [name, entry] of outputs) {
      out[name] = isolateOutputEntry(entry);
    }
    return out;
  };

  const buildDetails = (): SubagentDetails => {
    // Copy-on-write result shells; share frozen presentation/structuredOutput payloads.
    const base = makeDetails(results.map(copySnapshotShell), outputsRecord());
    const chainDetails: ChainExecutionDetails = {
      totalSteps: chain.length,
      steps: cloneLogicalSteps(logicalSteps),
    };
    return { ...base, chain: chainDetails };
  };

  const emit = (content: string) => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: 'text', text: content }],
        details: buildDetails(),
      });
    }
  };

  try {
    for (let i = 0; i < chain.length; i++) {
      const logical = logicalSteps[i];
      if (!logical) {
        // Topology length is authoritative; a short restored array is a hard error.
        return {
          content: [
            {
              type: 'text',
              text: `Chain restore error: missing logical step ${i + 1} of ${chain.length}`,
            },
          ],
          details: buildDetails(),
          isError: true,
        };
      }

      if (signal?.aborted) {
        logical.status = 'cancelled';
        markLaterSkipped(logicalSteps, i + 1);
        return {
          content: [{ type: 'text', text: `Chain cancelled at step ${i + 1}` }],
          details: buildDetails(),
          isError: true,
        };
      }

      const step = chain[i];
      const stepNumber = i + 1;

      // Skip completed steps from restored state; their outputs are already in `outputs`.
      // Prefer presentation results, then durable sequential unit results, then fanout collect.
      if (logical.status === 'completed') {
        const text = completedStepPreviousOutput(logical, results, outputs, restored?.units);
        if (text !== undefined) previousOutput = text;
        previousRef = completedStepPreviousRef(logical, results, outputs, restored?.units);
        continue;
      }
      // Reset non-completed steps to queued for retry.
      if (logical.status !== 'queued') {
        logical.status = 'queued';
      }

      if (isFanoutChainStep(step)) {
        const fanout = await runFanoutStep({
          step,
          stepNumber,
          stepIndex: i,
          results,
          outputs,
          previousOutput,
          previousRef,
          signal,
          onUpdate,
          makeDetails,
          outputsRecord,
          runStep,
          logicalSteps,
          buildDetails,
          emit,
          restored,
          onFanoutExpand,
          resolveArtifact,
          externalizeChainOutput,
        });
        if (fanout.done) return fanout.result;
        previousOutput = fanout.previousOutput;
        previousRef = fanout.previousRef;
        continue;
      }

      if (isAmbiguousChainStep(step)) {
        logicalSteps[i].status = 'failed';
        const failure = synthesizeFailure(
          'unknown',
          undefined,
          '',
          stepNumber,
          'fanout_error',
          'Chain step must be sequential (agent/task) or fanout (expand/parallel/collect), not both.'
        );
        upsertSequentialResult(results, failure);
        markLaterSkipped(logicalSteps, i + 1);
        return {
          content: [
            { type: 'text', text: `Chain stopped at step ${stepNumber}: ${failure.errorMessage}` },
          ],
          details: buildDetails(),
          isError: true,
        };
      }

      const sequential = await runSequentialStep({
        step: step as SequentialStep,
        stepNumber,
        stepIndex: i,
        taskIndex: i,
        results,
        outputs,
        previousOutput,
        previousRef,
        signal,
        onUpdate,
        makeDetails,
        outputsRecord,
        runStep,
        logicalSteps,
        buildDetails,
        emit,
        restored,
        externalizeChainOutput,
      });
      if (sequential.done) return sequential.result;
      previousOutput = sequential.previousOutput;
      previousRef = sequential.previousRef;
    }

    return {
      content: [
        {
          type: 'text',
          text:
            previousOutput ||
            (results[results.length - 1]
              ? getResultParentOutput(results[results.length - 1]!)
              : '(no output)'),
        },
      ],
      details: buildDetails(),
    };
  } catch (err) {
    if (isAbortError(err)) {
      const runningIdx = logicalSteps.findIndex(
        (s) => s.status === 'running' || s.status === 'queued'
      );
      const idx = runningIdx >= 0 ? runningIdx : logicalSteps.length - 1;
      if (idx >= 0 && logicalSteps[idx]) {
        if (logicalSteps[idx].status === 'running' || logicalSteps[idx].status === 'queued') {
          logicalSteps[idx].status = 'cancelled';
        }
        markLaterSkipped(logicalSteps, idx + 1);
      }
      // Mark any in-flight sequential result cancelled via slot replacement.
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        if (resolveExecutionStatus(r) === 'running') {
          const cancelled = copySnapshotShell(r);
          cancelled.status = 'cancelled';
          cancelled.stopReason = r.stopReason ?? 'aborted';
          if (cancelled.exitCode === 0 || cancelled.exitCode === -1) cancelled.exitCode = 1;
          results[i] = cancelled;
        }
      }
      return {
        content: [{ type: 'text', text: 'Chain cancelled' }],
        details: buildDetails(),
        isError: true,
      };
    }
    throw err;
  }
}

export function isFanoutChainStep(step: ChainItemInput): step is FanoutStep {
  return typeof step === 'object' && step !== null && !('agent' in step) && 'expand' in step;
}

function isAmbiguousChainStep(step: ChainItemInput): boolean {
  return typeof step === 'object' && step !== null && 'agent' in step && 'expand' in step;
}

function parseOutputSchema(
  rawSchema: unknown,
  agent: string,
  task: string,
  stepNumber: number,
  title?: string
): { ok: true; schema: JsonSchemaSubset | undefined } | { ok: false; failure: SingleResult } {
  if (rawSchema === undefined || rawSchema === null) return { ok: true, schema: undefined };
  if (typeof rawSchema === 'object' && !Array.isArray(rawSchema)) {
    return { ok: true, schema: rawSchema as JsonSchemaSubset };
  }
  return {
    ok: false,
    failure: synthesizeFailure(
      agent,
      undefined,
      task,
      stepNumber,
      'structured_output_error',
      `Invalid outputSchema: expected object, got ${Array.isArray(rawSchema) ? 'array' : typeof rawSchema}`,
      title
    ),
  };
}

function applyStructuredOutputValidation(
  result: SingleResult,
  schema: JsonSchemaSubset | undefined,
  stepNumber: number
): void {
  if (result.messages.length > 0) {
    result.finalOutput = getResultFinalOutput(result);
  }
  if (isFailedResult(result) || !schema) return;

  const extracted = extractJsonFromFinalOutput(result.finalOutput ?? '');
  if (!extracted.ok) {
    markStructuredFailure(result, extracted.error, stepNumber);
    return;
  }
  const errors = validateStructuredOutput(extracted.value, schema);
  if (errors.length > 0) {
    markStructuredFailure(result, errors.join('; '), stepNumber);
    return;
  }
  result.structuredOutput = extracted.value;
}

interface StepShared {
  results: SingleResult[];
  outputs: Map<string, ChainOutputEntry>;
  previousOutput: string;
  previousRef?: ChainOutputEntry['textRef'];
  signal: AbortSignal | undefined;
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined;
  makeDetails: DetailsFactory;
  outputsRecord: () => Record<string, ChainOutputEntry>;
  runStep: ChainRunStep;
  logicalSteps: ChainLogicalStep[];
  buildDetails: () => SubagentDetails;
  emit: (content: string) => void;
  restored?: RestoredChainState;
  onFanoutExpand?: (req: FanoutExpandRequest) => Promise<WorkflowFanoutState | void>;
  resolveArtifact?: (ref: import('../run/run-types.ts').RunArtifactRefV1) => Promise<unknown>;
  externalizeChainOutput?: ChainOutputExternalizer;
}

async function runSequentialStep(
  opts: StepShared & {
    step: SequentialStep;
    stepNumber: number;
    stepIndex: number;
    taskIndex: number;
  }
): Promise<
  | { done: false; previousOutput: string; previousRef?: ChainOutputEntry['textRef'] }
  | { done: true; result: ChainResult }
> {
  const {
    step,
    stepNumber,
    stepIndex,
    results,
    outputs,
    previousOutput,
    signal,
    logicalSteps,
    buildDetails,
    emit,
  } = opts;

  logicalSteps[stepIndex].status = 'running';
  emit(`Chain step ${stepNumber}/${logicalSteps.length} running...`);

  const rendered = renderTaskTemplate(step.task, {
    previous: previousOutput,
    outputs,
    ...(opts.previousRef ? { previousRef: opts.previousRef } : {}),
  });
  if (!rendered.ok) {
    const failure = synthesizeFailure(
      step.agent,
      undefined,
      step.task,
      stepNumber,
      'template_error',
      `Unknown chain output: ${rendered.unknown}`,
      step.title
    );
    upsertSequentialResult(results, failure);
    logicalSteps[stepIndex].status = 'failed';
    markLaterSkipped(logicalSteps, stepIndex + 1);
    return {
      done: true,
      result: {
        content: [
          {
            type: 'text',
            text: `Chain stopped at step ${stepNumber} (${step.agent}): Unknown chain output: ${rendered.unknown}`,
          },
        ],
        details: buildDetails(),
        isError: true,
      },
    };
  }

  const parsedSchema = parseOutputSchema(
    step.outputSchema,
    step.agent,
    step.task,
    stepNumber,
    step.title
  );
  if (!parsedSchema.ok) {
    upsertSequentialResult(results, parsedSchema.failure);
    logicalSteps[stepIndex].status = 'failed';
    markLaterSkipped(logicalSteps, stepIndex + 1);
    return {
      done: true,
      result: {
        content: [
          {
            type: 'text',
            text: `Chain stopped at step ${stepNumber} (${step.agent}): ${parsedSchema.failure.errorMessage}`,
          },
        ],
        details: buildDetails(),
        isError: true,
      },
    };
  }

  const outputSchema = parsedSchema.schema;
  const taskWithContext = outputSchema
    ? `${rendered.text}\n\n${buildStructuredOutputInstruction(outputSchema)}`
    : rendered.text;

  const chainUpdate = makeSequentialUpdate(results, stepNumber, opts.onUpdate, buildDetails);

  // Exactly-once: production runStep invokes the callback; stubs that ignore it get one fallback.
  let terminalPostprocessed = false;
  const postprocessTerminal = (result: SingleResult): void => {
    terminalPostprocessed = true;
    applyStructuredOutputValidation(result, outputSchema, stepNumber);
    if (!result.status || result.status === 'running') applyTerminalStatus(result);
    result.step = stepNumber;
  };

  let result: SingleResult;
  try {
    result = await opts.runStep({
      agent: step.agent,
      task: taskWithContext,
      title: step.title,
      cwd: step.cwd,
      isolation: step.isolation,
      taskIndex: opts.taskIndex,
      step: stepNumber,
      signal,
      onUpdate: chainUpdate,
      skipCompletionCheck: outputSchema !== undefined,
      postprocessTerminal,
      ...(rendered.requiresArtifactReader ? { requireArtifactReader: true } : {}),
    });
    if (!terminalPostprocessed) {
      // Injected runStep stubs that ignore postprocessTerminal get exactly one fallback.
      const working = cloneSingleResult(result);
      postprocessTerminal(working);
      result = snapshotSingleResult(working);
    } else {
      // Production already postprocessed + snapshotted; re-snapshot is an owned fast path.
      result = snapshotSingleResult(result);
    }
  } catch (err) {
    if (isAbortError(err)) {
      const cancelled: SingleResult = {
        agent: step.agent,
        agentSource: 'unknown',
        task: taskWithContext,
        title: step.title,
        exitCode: 1,
        status: 'cancelled',
        messages: [],
        stderr: ABORT_MESSAGE,
        usage: emptyUsage(),
        stopReason: 'aborted',
        errorMessage: ABORT_MESSAGE,
        step: stepNumber,
      };
      // Prefer any partial that was upserted — replace the slot, never mutate it.
      const existingIdx = results.findIndex((r) => r.step === stepNumber && r.fanout === undefined);
      if (existingIdx >= 0) {
        const shell = copySnapshotShell(results[existingIdx]!);
        shell.status = 'cancelled';
        shell.stopReason = shell.stopReason ?? 'aborted';
        if (shell.exitCode === 0 || shell.exitCode === -1) shell.exitCode = 1;
        results[existingIdx] = shell;
      } else {
        upsertSequentialResult(results, cancelled);
      }
      logicalSteps[stepIndex].status = 'cancelled';
      markLaterSkipped(logicalSteps, stepIndex + 1);
      throw err;
    }
    throw err;
  }

  // postprocessTerminal already ran (production runStep and/or stub fallback above).
  // Do not mutate the compact snapshot — only store it.
  upsertSequentialResult(results, result);

  if (isFailedResult(result) || resolveExecutionStatus(result) === 'failed') {
    logicalSteps[stepIndex].status = 'failed';
    markLaterSkipped(logicalSteps, stepIndex + 1);
    const errorMsg = getResultOutput(result);
    return {
      done: true,
      result: {
        content: [
          {
            type: 'text',
            text: `Chain stopped at step ${stepNumber} (${step.agent}): ${errorMsg}`,
          },
        ],
        details: buildDetails(),
        isError: true,
      },
    };
  }

  if (resolveExecutionStatus(result) === 'cancelled') {
    logicalSteps[stepIndex].status = 'cancelled';
    markLaterSkipped(logicalSteps, stepIndex + 1);
    return {
      done: true,
      result: {
        content: [
          {
            type: 'text',
            text: `Chain cancelled at step ${stepNumber} (${step.agent})`,
          },
        ],
        details: buildDetails(),
        isError: true,
      },
    };
  }

  logicalSteps[stepIndex].status = 'completed';
  const nextPreviousOutput = previousTextFromResult(result);
  if (step.name) {
    outputs.set(
      step.name,
      isolateOutputEntry(chainOutputFromResult(result, step.agent, stepNumber))
    );
  }
  return {
    done: false,
    previousOutput: nextPreviousOutput,
    ...(result.finalOutputRef
      ? { previousRef: { ...result.finalOutputRef, payload: 'chain-output-text' as const } }
      : {}),
  };
}

async function runFanoutStep(
  opts: StepShared & { step: FanoutStep; stepNumber: number; stepIndex: number }
): Promise<
  | { done: false; previousOutput: string; previousRef?: ChainOutputEntry['textRef'] }
  | { done: true; result: ChainResult }
> {
  const {
    step,
    stepNumber,
    stepIndex,
    results,
    outputs,
    previousOutput,
    signal,
    onUpdate,
    logicalSteps,
    buildDetails,
    emit,
  } = opts;

  const fanoutMeta = logicalSteps[stepIndex] as ChainFanoutStep;
  fanoutMeta.status = 'running';
  emit(`Chain step ${stepNumber}/${logicalSteps.length} fanout running...`);

  // Use restored items when available; otherwise expand from the source output.
  const fanoutUnitId = `chain-${String(stepNumber).padStart(4, '0')}-fanout`;
  const restoredFanout = opts.restored?.fanouts?.[fanoutUnitId];
  const isRestoredExpansion = restoredFanout !== undefined;

  let items: unknown[];
  let skipped: number;

  if (isRestoredExpansion) {
    // Authoritative stored expansion: do not re-read source or reapply maxItems.
    items = restoredFanout.items ?? [];
    // Preserve the logical step's original skipped count when present.
    skipped = fanoutMeta.skippedCount ?? 0;
  } else {
    const outputName = step.expand.from.output;
    const outputEntry = outputs.get(outputName);
    if (!outputEntry) {
      return fanoutFailure(
        opts,
        `Fanout source output "${outputName}" is missing structured output.`
      );
    }
    // Resolve structuredRef before JSON Pointer use. Missing resolver, wrong
    // media type, cross-run, missing, or corrupt refs must fail before dispatch.
    let structured: unknown;
    if (outputEntry.structured !== undefined) {
      structured = outputEntry.structured;
    } else if (outputEntry.structuredRef) {
      if (!opts.resolveArtifact) {
        return fanoutFailure(
          opts,
          `Fanout source output "${outputName}" has a structuredRef but no trusted resolver.`
        );
      }
      try {
        structured = await opts.resolveArtifact(outputEntry.structuredRef);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'structured ref resolution failed';
        return fanoutFailure(
          opts,
          `Fanout source output "${outputName}" ref unreadable: ${message}`
        );
      }
    } else {
      return fanoutFailure(
        opts,
        `Fanout source output "${outputName}" is missing structured output.`
      );
    }
    const pointer = readJsonPointer(structured as JsonValue, step.expand.from.path);
    if (!pointer.ok) return fanoutFailure(opts, pointer.error);
    if (!Array.isArray(pointer.value)) {
      return fanoutFailure(
        opts,
        `Fanout source ${outputName}${step.expand.from.path} is not an array.`
      );
    }
    const allSourceItems = pointer.value;

    const rawMaxItems = step.expand.maxItems;
    if (rawMaxItems !== undefined) {
      if (typeof rawMaxItems !== 'number' || !Number.isFinite(rawMaxItems) || rawMaxItems < 1) {
        return fanoutFailure(
          opts,
          `Invalid expand.maxItems: expected positive integer, got ${String(rawMaxItems)}`
        );
      }
    }
    const requestedMax =
      typeof rawMaxItems === 'number' ? Math.floor(rawMaxItems) : MAX_FANOUT_ITEMS;
    const maxItems = Math.min(requestedMax, MAX_FANOUT_ITEMS);
    items = allSourceItems.slice(0, maxItems);
    skipped = allSourceItems.length - items.length;
    fanoutMeta.skippedCount = skipped;
  }

  const parsedSchema = parseOutputSchema(
    step.parallel.outputSchema,
    step.parallel.agent,
    step.parallel.task,
    stepNumber,
    step.parallel.title
  );
  if (!parsedSchema.ok) {
    upsertSequentialResult(results, parsedSchema.failure);
    fanoutMeta.status = 'failed';
    markLaterSkipped(logicalSteps, stepIndex + 1);
    return {
      done: true,
      result: {
        content: [{ type: 'text', text: `Fanout failed: ${parsedSchema.failure.errorMessage}` }],
        details: buildDetails(),
        isError: true,
      },
    };
  }
  const outputSchema = parsedSchema.schema;

  // Render tasks for every scheduled item before expansion persistence / dispatch.
  const renderedTasks: string[] = [];
  let fanoutRequiresArtifactReader = false;
  for (const item of items) {
    const rendered = renderTaskTemplate(step.parallel.task, {
      previous: previousOutput,
      outputs,
      item,
    });
    if (!rendered.ok) {
      return fanoutFailure(opts, `Unknown fanout template value: ${rendered.unknown}`);
    }
    if (rendered.requiresArtifactReader) fanoutRequiresArtifactReader = true;
    renderedTasks.push(
      outputSchema
        ? `${rendered.text}\n\n${buildStructuredOutputInstruction(outputSchema)}`
        : rendered.text
    );
  }

  // Await expansion persistence before creating running slots or scheduling workers.
  if (opts.onFanoutExpand) {
    try {
      await opts.onFanoutExpand({
        step: stepNumber,
        items,
        agent: step.parallel.agent,
        ...(step.parallel.cwd !== undefined ? { effectiveCwd: step.parallel.cwd } : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fanoutFailure(opts, `Fanout expansion persistence failed: ${message}`);
    }
  }

  // Empty source: successful 0/0 fanout (expansion already persisted above).
  if (items.length === 0) {
    fanoutMeta.executedCount = 0;
    fanoutMeta.completedCount = 0;
    fanoutMeta.failedCount = 0;
    fanoutMeta.runningCount = 0;
    fanoutMeta.queuedCount = 0;
    fanoutMeta.skippedCount = skipped;
    fanoutMeta.status = 'completed';
    const text = '[]';
    outputs.set(
      step.collect.name,
      isolateOutputEntry({
        text,
        structured: [],
        agent: step.parallel.agent,
        step: stepNumber,
      })
    );
    emit(`Fanout: 0/0 done`);
    return { done: false, previousOutput: text };
  }

  const concurrency = Math.max(
    1,
    Math.min(
      typeof step.concurrency === 'number' ? Math.floor(step.concurrency) : MAX_CONCURRENCY,
      MAX_CONCURRENCY
    )
  );
  fanoutMeta.concurrency = concurrency;

  // Ordered slots for every item that will actually run.
  // When restoring, remove old fanout results for this step so we can merge
  // completed items with freshly retried incomplete ones.
  if (opts.restored) {
    for (let i = results.length - 1; i >= 0; i--) {
      if (results[i].step === stepNumber && results[i].fanout !== undefined) {
        results.splice(i, 1);
      }
    }
  }

  const slots: SingleResult[] = renderedTasks.map((task, index) => {
    // Durable unit status is authoritative when a mapped unit exists.
    // Completed units keep their terminal result; reopened/incomplete units get
    // a queued slot and must not fall back to stale completed presentation.
    if (opts.restored) {
      const unitId = restoredFanout?.unitIds[index];
      const unit = unitId ? opts.restored.units[unitId] : undefined;
      if (unit?.status === 'completed' && unit.result) {
        return snapshotSingleResult(unit.result);
      }
      // Mapped unit that is not completed: skip presentation fallback and queue.
      if (!unit || unit.status === 'completed') {
        const existing = opts.restored.results.find(
          (r) => r.step === stepNumber && r.fanout?.index === index
        );
        if (existing && resolveExecutionStatus(existing) === 'completed') {
          return snapshotSingleResult(existing);
        }
      }
    }
    return {
      agent: step.parallel.agent,
      agentSource: 'unknown' as const,
      task,
      title: step.parallel.title,
      exitCode: -1,
      status: 'queued' as const,
      messages: [],
      stderr: '',
      usage: emptyUsage(),
      step: stepNumber,
      fanout: { index, count: renderedTasks.length, itemTask: task },
    };
  });

  const baseLength = results.length;
  results.push(...slots);

  const recount = () => {
    fanoutMeta.executedCount = slots.length;
    fanoutMeta.completedCount = slots.filter(
      (s) => resolveExecutionStatus(s) === 'completed'
    ).length;
    fanoutMeta.failedCount = slots.filter((s) => resolveExecutionStatus(s) === 'failed').length;
    fanoutMeta.runningCount = slots.filter((s) => resolveExecutionStatus(s) === 'running').length;
    fanoutMeta.queuedCount = slots.filter((s) => resolveExecutionStatus(s) === 'queued').length;
    fanoutMeta.skippedCount = skipped;
  };

  const syncSlotsToResults = () => {
    for (let i = 0; i < slots.length; i++) {
      results[baseLength + i] = slots[i];
    }
  };

  const emitFanoutSnapshot = () => {
    recount();
    syncSlotsToResults();
    if (!onUpdate) return;
    const done = fanoutMeta.completedCount + fanoutMeta.failedCount;
    onUpdate({
      content: [
        {
          type: 'text',
          text: `Fanout: ${done}/${slots.length} done, ${fanoutMeta.runningCount} running, ${fanoutMeta.queuedCount} queued...`,
        },
      ],
      details: buildDetails(),
    });
  };
  // Structural fanout transitions are immediate; worker content partials are coalesced.
  const fanoutContentCoalescer = createLatestValueCoalescer<void>(() => {
    emitFanoutSnapshot();
  }, RESULT_UPDATE_INTERVAL_MS);
  const emitFanout = (mode: 'immediate' | 'content' = 'immediate') => {
    if (mode === 'content') {
      fanoutContentCoalescer.schedule(undefined);
      return;
    }
    fanoutContentCoalescer.cancel();
    emitFanoutSnapshot();
  };

  recount();
  emitFanout('immediate');

  /** After terminal, ignore late worker onUpdate callbacks. */
  let fanoutTerminal = false;

  const markSlotCancelled = (index: number, fromErr?: unknown): SingleResult => {
    const fromAbort = fromErr ? getAbortResult(fromErr) : undefined;
    const base = fromAbort ?? slots[index];
    // CoW shell — never mutate the abort error's result or a prior snapshot in place.
    const cancelled = copySnapshotShell(base);
    cancelled.status = 'cancelled';
    cancelled.stopReason = base.stopReason ?? 'aborted';
    if (cancelled.exitCode === 0 || cancelled.exitCode === -1) cancelled.exitCode = 1;
    cancelled.errorMessage = cancelled.errorMessage ?? ABORT_MESSAGE;
    cancelled.step = stepNumber;
    cancelled.fanout = {
      index,
      count: renderedTasks.length,
      itemTask: renderedTasks[index],
    };
    slots[index] = cancelled;
    fanoutMeta.latestIndex = index;
    return cancelled;
  };

  const makeTerminalPostprocess = (index: number, task: string) => {
    // Per-invocation flag: production runStep sets it; stubs that ignore get one fallback.
    let invoked = false;
    const postprocessTerminal = (result: SingleResult): void => {
      invoked = true;
      applyStructuredOutputValidation(result, outputSchema, stepNumber);
      if (!result.status || result.status === 'running') applyTerminalStatus(result);
      result.step = stepNumber;
      result.fanout = {
        index,
        count: renderedTasks.length,
        itemTask: task,
      };
    };
    return {
      postprocessTerminal,
      wasInvoked: () => invoked,
    };
  };

  try {
    await runFanoutWorkers(
      renderedTasks,
      concurrency,
      signal,
      async (task, index) => {
        // Skip already-completed slots from restored state.
        if (resolveExecutionStatus(slots[index]) === 'completed') {
          return slots[index];
        }
        // Skip units already completed in durable state even if presentation was missing.
        if (opts.restored) {
          const unitId = restoredFanout?.unitIds[index];
          const unit = unitId ? opts.restored.units[unitId] : undefined;
          if (unit?.status === 'completed') {
            return slots[index];
          }
        }
        {
          const runningShell = copySnapshotShell(slots[index]);
          runningShell.status = 'running';
          runningShell.exitCode = -1;
          slots[index] = runningShell;
        }
        fanoutMeta.latestIndex = index;
        if (!fanoutTerminal) emitFanout();

        const itemUpdate: OnUpdateCallback | undefined = onUpdate
          ? (partial) => {
              // After terminal (or once abort is known), ignore late worker updates.
              if (fanoutTerminal || signal?.aborted) return;
              const current = partial.details?.results[0];
              if (!current) return;
              // Replace the slot with a new shell — never mutate the partial snapshot.
              const shell = copySnapshotShell(current);
              shell.status = shell.status ?? 'running';
              shell.step = stepNumber;
              shell.fanout = {
                index,
                count: renderedTasks.length,
                itemTask: task,
              };
              slots[index] = shell;
              fanoutMeta.latestIndex = index;
              emitFanout('content');
            }
          : undefined;

        const { postprocessTerminal, wasInvoked } = makeTerminalPostprocess(index, task);

        try {
          const result = await opts.runStep({
            agent: step.parallel.agent,
            task,
            title: step.parallel.title,
            cwd: step.parallel.cwd,
            isolation: step.parallel.isolation,
            taskIndex: stepNumber * (MAX_FANOUT_ITEMS + 1) + index,
            step: stepNumber,
            fanoutIndex: index,
            signal,
            onUpdate: itemUpdate,
            skipCompletionCheck: outputSchema !== undefined,
            postprocessTerminal,
            ...(fanoutRequiresArtifactReader ? { requireArtifactReader: true } : {}),
          });
          if (fanoutTerminal || signal?.aborted) {
            // Worker finished after cancel: keep cancelled if we already marked it.
            if (resolveExecutionStatus(slots[index]) === 'cancelled') return slots[index];
          }
          let compact: SingleResult;
          if (!wasInvoked()) {
            // Injected stubs that ignore the callback get exactly one fallback.
            const working = cloneSingleResult(result);
            postprocessTerminal(working);
            compact = snapshotSingleResult(working);
          } else {
            // Production already postprocessed + snapshotted; share owned payloads only.
            compact = snapshotSingleResult(result);
          }
          slots[index] = compact;
          fanoutMeta.latestIndex = index;
          if (!fanoutTerminal && !signal?.aborted) emitFanout();
          return compact;
        } catch (err) {
          if (isAbortError(err)) {
            markSlotCancelled(index, err);
            // Do not rethrow — let other in-flight workers settle.
            return slots[index];
          }
          throw err;
        }
      },
      (_task, index) => {
        // Presentation may mark skipped; durable state keeps the unit queued.
        const skippedSlot = copySnapshotShell(slots[index]);
        skippedSlot.status = 'skipped';
        skippedSlot.exitCode = 1;
        skippedSlot.stopReason = skippedSlot.stopReason ?? 'aborted';
        slots[index] = skippedSlot;
        return skippedSlot;
      }
    );
  } catch (err) {
    // Non-abort worker failures still settle via the pool; rethrow if unexpected.
    if (!isAbortError(err)) throw err;
  } finally {
    // Permanent terminal gate first so late worker callbacks cannot reschedule the
    // coalescer after cancel (including unexpected non-abort exceptional exits).
    fanoutTerminal = true;
    fanoutContentCoalescer.cancel();
  }

  recount();
  syncSlotsToResults();

  const successCount = slots.filter((r) => resolveExecutionStatus(r) === 'completed').length;
  const cancelledCount = slots.filter((r) => resolveExecutionStatus(r) === 'cancelled').length;
  const skippedCount = slots.filter((r) => resolveExecutionStatus(r) === 'skipped').length;
  const abortedFanout = signal?.aborted || cancelledCount > 0 || skippedCount > 0;

  if (abortedFanout && successCount !== slots.length) {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i]!;
      const st = resolveExecutionStatus(slot);
      if (st === 'queued' || st === 'running') {
        const shell = copySnapshotShell(slot);
        shell.status = st === 'running' ? 'cancelled' : 'skipped';
        if (shell.status === 'cancelled') {
          shell.stopReason = shell.stopReason ?? 'aborted';
          if (shell.exitCode === 0 || shell.exitCode === -1) shell.exitCode = 1;
        }
        slots[i] = shell;
      }
    }
    fanoutMeta.status = 'cancelled';
    recount();
    syncSlotsToResults();
    markLaterSkipped(logicalSteps, stepIndex + 1);
    // Single terminal snapshot for cancel; subsequent worker onUpdate is ignored.
    emit(`Chain cancelled at step ${stepNumber} (fanout)`);
    return {
      done: true,
      result: {
        content: [{ type: 'text', text: `Chain cancelled at step ${stepNumber} (fanout)` }],
        details: buildDetails(),
        isError: true,
      },
    };
  }

  if (successCount !== slots.length) {
    fanoutMeta.status = 'failed';
    markLaterSkipped(logicalSteps, stepIndex + 1);
    return {
      done: true,
      result: {
        content: [
          {
            type: 'text',
            text: `Fanout failed: ${successCount}/${slots.length} succeeded`,
          },
        ],
        details: buildDetails(),
        isError: true,
      },
    };
  }

  fanoutMeta.status = 'completed';
  // Resolve refs through the trusted resolver to get real authority values.
  // Descriptors must not substitute for JSON/text authority in collect output.
  const collected: JsonValue[] = [];
  for (const result of slots) {
    if (result.structuredOutputRef) {
      if (!opts.resolveArtifact) {
        return fanoutFailure(
          opts,
          `Fanout collect: item has structuredOutputRef but no trusted resolver available.`
        );
      }
      try {
        const resolved = await opts.resolveArtifact(result.structuredOutputRef);
        collected.push(resolved as JsonValue);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'ref resolution failed';
        return fanoutFailure(
          opts,
          `Fanout collect: failed to resolve structuredOutputRef: ${message}`
        );
      }
    } else if (result.structuredOutput !== undefined) {
      collected.push(result.structuredOutput as JsonValue);
    } else if (result.finalOutputRef) {
      if (!opts.resolveArtifact) {
        return fanoutFailure(
          opts,
          `Fanout collect: item has finalOutputRef but no trusted resolver available.`
        );
      }
      try {
        const resolved = await opts.resolveArtifact(result.finalOutputRef);
        collected.push(
          typeof resolved === 'string' ? resolved : (JSON.stringify(resolved) as JsonValue)
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'ref resolution failed';
        return fanoutFailure(opts, `Fanout collect: failed to resolve finalOutputRef: ${message}`);
      }
    } else {
      collected.push(getResultFinalOutput(result) as JsonValue);
    }
  }
  const maxItemsNote =
    typeof step.expand.maxItems === 'number' ? Math.floor(step.expand.maxItems) : undefined;
  // Append skipped-item notes to the authoritative text BEFORE externalization so
  // a referenced collect never becomes an inline descriptor plus a trailing note.
  const note =
    skipped > 0
      ? `\n\n[Fanout skipped ${skipped} item${skipped === 1 ? '' : 's'}${
          maxItemsNote !== undefined ? ` due to maxItems=${maxItemsNote}` : ''
        }]`
      : '';
  const fullCollectedText = `${JSON.stringify(collected, null, 2)}${note}`;
  const collectedStructured: unknown = collected;
  // Keep full text/JSON in runtime variables until externalization returns; store
  // returned refs in textRef/structuredRef, never in text/structured.
  let textValue: string | undefined = fullCollectedText;
  let textRef: import('../run/run-types.ts').RunArtifactRefV1 | undefined;
  let structuredValue: unknown = collectedStructured;
  let structuredRef: import('../run/run-types.ts').RunArtifactRefV1 | undefined;
  if (opts.externalizeChainOutput) {
    if (opts.externalizeChainOutput.text) {
      const spilled = await opts.externalizeChainOutput.text(fullCollectedText);
      if (spilled.textRef) {
        textRef = spilled.textRef;
        textValue = undefined;
      } else if (spilled.text !== undefined) {
        textValue = spilled.text;
      }
    }
    if (opts.externalizeChainOutput.json) {
      const spilled = await opts.externalizeChainOutput.json(collectedStructured);
      if (spilled.valueRef) {
        structuredRef = spilled.valueRef;
        structuredValue = undefined;
      } else if (spilled.value !== undefined) {
        structuredValue = spilled.value;
      }
    }
  }
  // One ChainOutputEntry with strict unions: exactly one of text/textRef;
  // structured data absent or exactly one of structured/structuredRef.
  const entry: ChainOutputEntry = { agent: step.parallel.agent, step: stepNumber };
  if (textRef) entry.textRef = textRef;
  else entry.text = textValue;
  if (structuredRef) entry.structuredRef = structuredRef;
  else if (structuredValue !== undefined) entry.structured = structuredValue;
  outputs.set(step.collect.name, isolateOutputEntry(entry));
  // Previous handoff: inline final text or a child descriptor derived from textRef.
  const handoffOutput = textRef ? formatChildArtifactDescriptor(textRef) : (textValue ?? '');
  return {
    done: false,
    previousOutput: handoffOutput,
    ...(textRef ? { previousRef: { ...textRef } } : {}),
  };
}

function fanoutFailure(
  opts: StepShared & { step: FanoutStep; stepNumber: number; stepIndex: number },
  message: string
): { done: true; result: ChainResult } {
  const failure = synthesizeFailure(
    opts.step.parallel.agent,
    undefined,
    opts.step.parallel.task,
    opts.stepNumber,
    'fanout_error',
    message,
    opts.step.parallel.title
  );
  opts.results.push(failure);
  const fanoutMeta = opts.logicalSteps[opts.stepIndex] as ChainFanoutStep;
  fanoutMeta.status = 'failed';
  markLaterSkipped(opts.logicalSteps, opts.stepIndex + 1);
  return {
    done: true,
    result: {
      content: [{ type: 'text', text: `Fanout failed: ${message}` }],
      details: opts.buildDetails(),
      isError: true,
    },
  };
}

function makeSequentialUpdate(
  results: SingleResult[],
  stepNumber: number,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
  buildDetails: () => SubagentDetails
): OnUpdateCallback | undefined {
  return onUpdate
    ? (partial) => {
        const currentResult = partial.details?.results[0];
        if (currentResult) {
          // CoW: never mutate the inbound partial snapshot in place.
          const shell = copySnapshotShell(currentResult);
          shell.status = shell.status ?? 'running';
          shell.step = stepNumber;
          upsertSequentialResult(results, shell);
          onUpdate({
            content: partial.content,
            details: buildDetails(),
          });
        }
      }
    : undefined;
}

function markStructuredFailure(result: SingleResult, message: string, step: number): void {
  result.exitCode = result.exitCode === 0 ? 1 : result.exitCode;
  result.stopReason = 'structured_output_error';
  result.structuredOutputError = message;
  result.errorMessage = `Structured output error: ${message}`;
  result.status = 'failed';
  if (typeof result.step !== 'number') result.step = step;
}
