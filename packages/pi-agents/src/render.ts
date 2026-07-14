// ABOUTME: TUI rendering for the `agent` tool — tool-call previews and single/parallel/chain result views.
// ABOUTME: Owns all pi-tui component construction and theme color usage so `index.ts` stays UI-free.

import * as os from 'node:os';
import type { Static } from '@earendil-works/pi-ai';
import {
  getMarkdownTheme,
  type Theme,
  type ThemeColor,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  type Component,
  Container,
  Markdown,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';
import {
  formatAggregateUsageStats,
  formatUsageStats,
  getLatestActivity,
  getTranscriptAndFinal,
  resolveExecutionStatus,
} from './output.ts';
import type { SubagentParams } from './schema.ts';
import type {
  ChainExecutionDetails,
  ChainFanoutStep,
  ChainLogicalStep,
  DisplayItem,
  ExecutionStatus,
  SingleResult,
  SubagentDetails,
  UsageStats,
} from './types.ts';

type ThemeFg = (color: ThemeColor, text: string) => string;

/** Outline-fill spinner frames('▫▪◻◼□■Explore') for collapsed running status. */
export const SPINNER_FRAMES = ['▫', '▪', '□', '■', '□', '▪', '▫'] as const;
/** Frame step for spinner invalidation and elapsed-time frame selection. */
export const SPINNER_INTERVAL_MS = 150;

/** Static running glyph: background launches and non-animated fallbacks. */
export const RUNNING_STATUS_GLYPH = '▣';

const QUEUED_GLYPH = '·';
const SKIPPED_GLYPH = '–';
const CANCELLED_GLYPH = '⊘';
const INTERRUPTED_GLYPH = '⧖';
const EXPAND_HINT = '(ctrl+o to expand)';

/** Row-local renderer state for `registerTool<..., AgentRenderState>`. */
export interface AgentRenderState {
  /** Wall-clock start of the current collapsed running phase; cleared when idle. */
  spinnerStartedAt?: number;
}

/**
 * Official tool-renderer context for this tool, recovered from ToolDefinition
 * (ToolRenderContext is not re-exported from the package entrypoint).
 */
export type AgentToolRenderContext = Parameters<
  NonNullable<
    ToolDefinition<typeof SubagentParams, SubagentDetails, AgentRenderState>['renderResult']
  >
>[3];

/**
 * Minimal renderer context surface used by renderResult and helpers. Relaxes the
 * args type so the same renderer can serve tools with different parameter schemas
 * (e.g. `agent` and `agent_job`) while sharing state/spinner wiring.
 */
export type RenderContext = {
  toolCallId: string;
  invalidate: () => void;
  state: AgentRenderState;
};

/** Minimal context surface used by frame calculation helpers. */
export type AgentRenderContext = Pick<RenderContext, 'state'>;

/** Injectable timer surface so tests can drive the shared ticker without wall-clock waits. */
export type SpinnerScheduler = {
  setInterval: (handler: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
};

const defaultSpinnerScheduler: SpinnerScheduler = {
  setInterval(handler, ms) {
    const id = globalThis.setInterval(handler, ms);
    id.unref?.();
    return id;
  },
  clearInterval(id) {
    globalThis.clearInterval(id as ReturnType<typeof setInterval>);
  },
};

let spinnerScheduler: SpinnerScheduler = defaultSpinnerScheduler;

/** Active collapsed-partial tool rows keyed by toolCallId. One shared interval drives all. */
const activeSpinners = new Map<string, RenderContext>();
let sharedTickerId: unknown | undefined;

/** Clear spinner bookkeeping. Safe on missing/partial state. */
export function clearSpinnerState(state: AgentRenderState | undefined): void {
  if (!state) return;
  state.spinnerStartedAt = undefined;
}

/** Replace the shared ticker scheduler (tests). Pass undefined to restore defaults. */
export function installSpinnerScheduler(scheduler: SpinnerScheduler | undefined): void {
  stopAllSpinners();
  spinnerScheduler = scheduler ?? defaultSpinnerScheduler;
}

function stopSharedTicker(): void {
  if (sharedTickerId === undefined) return;
  spinnerScheduler.clearInterval(sharedTickerId);
  sharedTickerId = undefined;
}

function ensureSharedTicker(): void {
  if (sharedTickerId !== undefined || activeSpinners.size === 0) return;
  sharedTickerId = spinnerScheduler.setInterval(() => {
    for (const [toolCallId, context] of [...activeSpinners.entries()]) {
      try {
        context.invalidate();
      } catch {
        stopSpinner(toolCallId);
      }
    }
  }, SPINNER_INTERVAL_MS);
}

/**
 * Arm continuous invalidation for a collapsed partial tool row.
 * Frame origin is set once per armed phase; re-renders refresh the context ref only.
 */
export function startSpinner(
  context: RenderContext | undefined,
  now: () => number = Date.now
): void {
  if (!context) return;
  if (typeof context.state.spinnerStartedAt !== 'number') {
    context.state.spinnerStartedAt = now();
  }
  activeSpinners.set(context.toolCallId, context);
  ensureSharedTicker();
}

export function stopSpinner(context: RenderContext | string | undefined): void {
  if (!context) return;
  const toolCallId = typeof context === 'string' ? context : context.toolCallId;
  const active = activeSpinners.get(toolCallId);
  if (!active) {
    if (typeof context !== 'string') clearSpinnerState(context.state);
    return;
  }
  clearSpinnerState(active.state);
  if (typeof context !== 'string' && context !== active) clearSpinnerState(context.state);
  activeSpinners.delete(toolCallId);
  if (activeSpinners.size === 0) stopSharedTicker();
}

export function stopAllSpinners(): void {
  for (const toolCallId of [...activeSpinners.keys()]) stopSpinner(toolCallId);
  stopSharedTicker();
}

/** Number of tool rows currently armed for continuous spinner invalidation. */
export function activeSpinnerCount(): number {
  return activeSpinners.size;
}

/** Whether the single shared interval is running (0 or 1 intervals total). */
export function isSharedSpinnerTickerActive(): boolean {
  return sharedTickerId !== undefined;
}

/**
 * Start/stop the shared ticker only for live collapsed partial results that are
 * still running. History restore, final results (isPartial=false), expanded view,
 * and terminal/error paths never arm an interval — even if details still say running.
 */
function syncCollapsedPartialSpinner(
  context: RenderContext | undefined,
  options: { expanded: boolean; isPartial: boolean },
  detailsRunning: boolean
): void {
  const shouldAnimate = options.isPartial && !options.expanded && detailsRunning;
  if (shouldAnimate) startSpinner(context);
  else stopSpinner(context);
}

/**
 * Collapsed running-status glyph. Animates only when startSpinner armed the row
 * (spinnerStartedAt set); otherwise returns the static running glyph.
 */
export function runningStatusGlyph(
  isRunning: boolean,
  context: AgentRenderContext | undefined,
  now: () => number = Date.now
): string {
  if (!isRunning) {
    clearSpinnerState(context?.state);
    return RUNNING_STATUS_GLYPH;
  }
  const startedAt = context?.state.spinnerStartedAt;
  if (typeof startedAt !== 'number') return RUNNING_STATUS_GLYPH;
  const elapsed = Math.max(0, now() - startedAt);
  const frame = Math.floor(elapsed / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[frame]!;
}

/** Component that builds text at render time using the available terminal width. */
class WidthText implements Component {
  constructor(private readonly build: (width: number) => string) {}
  invalidate(): void {}
  render(width: number): string[] {
    return new Text(this.build(width), 0, 0).render(width);
  }
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: ThemeFg
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case 'bash': {
      const command = (args.command as string) || '...';
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg('muted', '$ ') + themeFg('toolOutput', preview);
    }
    case 'read': {
      const rawPath = (args.file_path || args.path || '...') as string;
      const filePath = shortenPath(rawPath);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = themeFg('accent', filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : '';
        text += themeFg('warning', `:${startLine}${endLine ? `-${endLine}` : ''}`);
      }
      return themeFg('muted', 'read ') + text;
    }
    case 'write': {
      const rawPath = (args.file_path || args.path || '...') as string;
      const filePath = shortenPath(rawPath);
      const content = (args.content || '') as string;
      const lines = content.split('\n').length;
      let text = themeFg('muted', 'write ') + themeFg('accent', filePath);
      if (lines > 1) text += themeFg('dim', ` (${lines} lines)`);
      return text;
    }
    case 'edit': {
      const rawPath = (args.file_path || args.path || '...') as string;
      return themeFg('muted', 'edit ') + themeFg('accent', shortenPath(rawPath));
    }
    case 'ls': {
      const rawPath = (args.path || '.') as string;
      return themeFg('muted', 'ls ') + themeFg('accent', shortenPath(rawPath));
    }
    case 'find': {
      const pattern = (args.pattern || '*') as string;
      const rawPath = (args.path || '.') as string;
      return (
        themeFg('muted', 'find ') +
        themeFg('accent', pattern) +
        themeFg('dim', ` in ${shortenPath(rawPath)}`)
      );
    }
    case 'grep': {
      const pattern = (args.pattern || '') as string;
      const rawPath = (args.path || '.') as string;
      return (
        themeFg('muted', 'grep ') +
        themeFg('accent', `/${pattern}/`) +
        themeFg('dim', ` in ${shortenPath(rawPath)}`)
      );
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg('accent', toolName) + themeFg('dim', ` ${preview}`);
    }
  }
}

/** Call title is hidden; result view is the visible tool block. */
export function renderCall(_args: Static<typeof SubagentParams>, _theme: Theme): Component {
  return new Text('', 0, 0);
}

/** `agent_job` call preview: shows the action (and runId when present). */
export function renderJobCall(
  args: { action?: string; runId?: string; status?: string },
  theme: Theme
): Component {
  const action = args.action ?? 'job';
  const label = theme.fg('muted', 'agent_job ') + theme.fg('accent', action);
  const tail = args.runId ? theme.fg('dim', ` ${args.runId.slice(0, 12)}`) : '';
  return new Text(`${label}${tail}`, 0, 0);
}

interface RenderResultOptions {
  expanded: boolean;
  isPartial?: boolean;
}

interface RenderResultInput {
  content: Array<{ type: string; text?: string }>;
  details?: SubagentDetails;
}

function truncateText(text: string, max: number): string {
  if (max <= 0) return '';
  return truncateToWidth(text, max, '...');
}

/** Max terminal columns for a collapsed-summary title. */
const TITLE_MAX_COLUMNS = 30;

/** Clamp a value to at most `maxColumns` terminal columns, ellipsis included. */
function clampToWidth(value: string | undefined, maxColumns: number): string {
  if (value === undefined) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return truncateToWidth(trimmed, maxColumns, '…');
}

/** Like clampToWidth but returns undefined when blank, so callers can fall back. */
function clampTitle(title: string | undefined, maxColumns: number): string | undefined {
  const clamped = clampToWidth(title, maxColumns);
  return clamped || undefined;
}

/** Capitalize the first character of an agent name for display. */
function displayAgentName(name: string): string {
  if (!name) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function statusGlyph(status: ExecutionStatus, theme: Theme, context?: AgentRenderContext): string {
  switch (status) {
    case 'queued':
      return theme.fg('muted', QUEUED_GLYPH);
    case 'running':
      return theme.fg('accent', runningStatusGlyph(true, context));
    case 'completed':
      return theme.fg('success', '✔');
    case 'failed':
      return theme.fg('error', '✗');
    case 'cancelled':
      return theme.fg('warning', CANCELLED_GLYPH);
    case 'interrupted':
      return theme.fg('warning', INTERRUPTED_GLYPH);
    case 'skipped':
      return theme.fg('muted', SKIPPED_GLYPH);
  }
}

function hasRunningResults(results: SingleResult[]): boolean {
  return results.some((r) => resolveExecutionStatus(r) === 'running');
}

function hasRunningChain(chain: ChainExecutionDetails): boolean {
  return chain.steps.some((s) => s.status === 'running');
}

function detailsNeedsCollapsedSpinner(details: SubagentDetails): boolean {
  if (details.mode === 'background') return false;
  if (details.mode === 'chain') {
    const chain = details.chain ?? fallbackChainFromResults(details.results);
    return hasRunningChain(chain);
  }
  return hasRunningResults(details.results);
}

function aggregateUsage(results: SingleResult[]): UsageStats {
  const total = emptyUsageAggregate();
  for (const r of results) {
    total.input += r.usage.input;
    total.output += r.usage.output;
    total.cacheRead += r.usage.cacheRead;
    total.cacheWrite += r.usage.cacheWrite;
    total.cost += r.usage.cost;
    total.turns += r.usage.turns;
    if (r.usage.contextTokens > total.contextTokens) {
      total.contextTokens = r.usage.contextTokens;
    }
  }
  return total;
}

function emptyUsageAggregate(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

function formatActivityLine(
  item: DisplayItem,
  theme: Theme,
  themeFg: ThemeFg,
  width: number,
  prefix = ''
): string {
  const prefixStr = theme.fg('muted', `  └─ ${prefix}`);
  if (item.type === 'toolCall') {
    return fitActivityLine(prefixStr + formatToolCall(item.name, item.args, themeFg), width);
  }
  const preview = item.text.split('\n')[0] ?? '';
  return fitActivityLine(prefixStr + theme.fg('toolOutput', preview), width);
}

/** Truncate a collapsed activity line to the available width (ANSI-safe, single `…`). */
function fitActivityLine(line: string, width: number): string {
  return width > 0 ? truncateToWidth(line, width, '…') : line;
}

interface SummaryParts {
  glyph: string;
  label: string;
  task: string;
  /** Short title (<=30 columns) shown in place of the task preview when present. */
  titlePreview?: string;
  progress?: string;
  usage: string;
}

/**
 * Build a compact summary line; truncates task preview first, then moves usage
 * to a continuation line when the primary line still cannot fit.
 */
function formatSummaryLine(parts: SummaryParts, width: number, theme: Theme): string {
  const usagePart = parts.usage ? ` · ${parts.usage}` : '';
  const progressPart = parts.progress ? ` · ${parts.progress}` : '';
  const minTaskBudget = 8;
  const parenOverhead = 3; // " ()"

  const buildPreview = (budget: number): string => {
    if (parts.titlePreview) {
      if (visibleWidth(parts.titlePreview) <= budget) return parts.titlePreview;
      return truncateToWidth(parts.titlePreview, budget, '…');
    }
    return truncateText(parts.task.replace(/\s+/g, ' ').trim(), budget);
  };

  const fixedWithoutTask = `${parts.glyph} ${parts.label}${progressPart}${usagePart}`;
  const availableForTask =
    width > 0
      ? Math.max(minTaskBudget, width - visibleWidth(fixedWithoutTask) - parenOverhead)
      : 40;

  let taskPreview = buildPreview(availableForTask);
  let line = `${parts.glyph} ${parts.label} ${theme.fg('dim', `(${taskPreview})${progressPart}${usagePart}`)}`;

  if (width > 0 && visibleWidth(line) > width && parts.usage) {
    // Drop usage onto a continuation line
    const withoutUsage = `${parts.glyph} ${parts.label}`;
    const avail = Math.max(
      minTaskBudget,
      width - visibleWidth(withoutUsage) - visibleWidth(progressPart) - parenOverhead
    );
    taskPreview = buildPreview(avail);
    line = `${parts.glyph} ${parts.label} ${theme.fg('dim', `(${taskPreview})${progressPart}`)}\n  ${theme.fg('dim', parts.usage)}`;
  }
  return line;
}

function resultSummaryParts(
  r: SingleResult,
  theme: Theme,
  options?: {
    labelPrefix?: string;
    agentSuffix?: string;
    progress?: string;
    /** When set, running glyphs animate with the outline-fill spinner. */
    animateContext?: AgentRenderContext;
  }
): SummaryParts {
  const status = resolveExecutionStatus(r);
  const agentLabel =
    (options?.labelPrefix ?? '') + displayAgentName(r.agent) + (options?.agentSuffix ?? '');
  return {
    glyph: statusGlyph(status, theme, options?.animateContext),
    label: theme.fg('accent', agentLabel),
    task: r.task,
    titlePreview: clampTitle(r.title, TITLE_MAX_COLUMNS),
    progress: options?.progress,
    usage: formatUsageStats(r.usage, r.model, r.thinking),
  };
}

function appendExpandedResultSections(
  container: Container,
  r: SingleResult,
  theme: Theme,
  themeFg: ThemeFg,
  mdTheme: ReturnType<typeof getMarkdownTheme>
): void {
  const status = resolveExecutionStatus(r);
  const { transcript, finalOutput } = getTranscriptAndFinal(r.messages);

  container.addChild(new Text(theme.fg('muted', '─── Task ───'), 0, 0));
  container.addChild(new Text(theme.fg('dim', r.task), 0, 0));
  container.addChild(new Spacer(1));

  container.addChild(new Text(theme.fg('muted', '─── Output ───'), 0, 0));
  if (transcript.length === 0 && !finalOutput) {
    container.addChild(
      new Text(theme.fg('muted', status === 'running' ? '(running...)' : '(no output)'), 0, 0)
    );
  } else {
    for (const item of transcript) {
      if (item.type === 'toolCall') {
        container.addChild(
          new Text(theme.fg('muted', '→ ') + formatToolCall(item.name, item.args, themeFg), 0, 0)
        );
      } else {
        container.addChild(new Text(theme.fg('toolOutput', item.text), 0, 0));
      }
    }
  }

  if (finalOutput) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg('muted', '─── Final ───'), 0, 0));
    container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
  }

  if (r.errorMessage || (status === 'failed' && r.stopReason)) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg('muted', '─── Error ───'), 0, 0));
    if (r.stopReason) {
      container.addChild(new Text(theme.fg('error', `stopReason: ${r.stopReason}`), 0, 0));
    }
    if (r.errorMessage) {
      container.addChild(new Text(theme.fg('error', r.errorMessage), 0, 0));
    }
  }

  if (r.worktreePath || r.worktreeSetupError) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg('muted', '─── Worktree ───'), 0, 0));
    if (r.worktreePath) {
      container.addChild(new Text(theme.fg('dim', `path: ${r.worktreePath}`), 0, 0));
    }
    if (r.worktreeDirty !== undefined) {
      container.addChild(
        new Text(theme.fg('dim', `dirty: ${r.worktreeDirty ? 'yes' : 'no'}`), 0, 0)
      );
    }
    if (r.worktreeDiffStat) {
      container.addChild(new Text(theme.fg('dim', r.worktreeDiffStat), 0, 0));
    }
    if (r.worktreeChangedFiles?.length) {
      container.addChild(
        new Text(theme.fg('dim', `files: ${r.worktreeChangedFiles.join(', ')}`), 0, 0)
      );
    }
    if (r.worktreeSetupError) {
      container.addChild(new Text(theme.fg('error', r.worktreeSetupError), 0, 0));
    }
  }

  if (r.structuredOutputError || r.structuredOutput !== undefined) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg('muted', '─── Structured output ───'), 0, 0));
    if (r.structuredOutputError) {
      container.addChild(new Text(theme.fg('error', r.structuredOutputError), 0, 0));
    } else {
      container.addChild(
        new Text(theme.fg('dim', JSON.stringify(r.structuredOutput, null, 2)), 0, 0)
      );
    }
  }

  // Durable run identity and resume info in expanded view.
  if (r.runId) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg('muted', '─── Run ───'), 0, 0));
    container.addChild(new Text(theme.fg('dim', `runId: ${r.runId}`), 0, 0));
    if (r.unitId) {
      container.addChild(new Text(theme.fg('dim', `unit: ${r.unitId}`), 0, 0));
    }
    container.addChild(new Text(theme.fg('dim', `attempt: ${r.attempt ?? '—'}`), 0, 0));
    if (r.resumeCapability) {
      const capLabel =
        r.resumeCapability === 'replay'
          ? theme.fg('warning', 'replay (⚠ may repeat side effects)')
          : 'session';
      container.addChild(new Text(theme.fg('dim', `capability: ${capLabel}`), 0, 0));
    }
    if (r.sessionFile) {
      container.addChild(new Text(theme.fg('dim', `session: ${r.sessionFile}`), 0, 0));
    }
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        theme.fg('dim', `To resume: agent_job({ action: "resume", runId: "${r.runId}" })`),
        0,
        0
      )
    );
  }

  const usageStr = formatUsageStats(r.usage, r.model, r.thinking);
  if (usageStr) {
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        `${statusGlyph(status, theme)} ${theme.fg('accent', displayAgentName(r.agent))} ${theme.fg('dim', usageStr)}`,
        0,
        0
      )
    );
  }
}

function renderSingleCollapsed(
  r: SingleResult,
  theme: Theme,
  themeFg: ThemeFg,
  context?: AgentRenderContext
): Component {
  return new WidthText((width) => {
    const status = resolveExecutionStatus(r);
    let text = formatSummaryLine(
      resultSummaryParts(r, theme, { animateContext: context }),
      width,
      theme
    );

    if (status === 'running') {
      const latest = getLatestActivity(r.messages);
      if (latest) text += `\n${formatActivityLine(latest, theme, themeFg, width)}`;
    } else if (status === 'failed' && r.errorMessage) {
      text += `\n${theme.fg('error', `  Error: ${r.errorMessage}`)}`;
    }

    text += `\n${theme.fg('muted', EXPAND_HINT)}`;
    return text;
  });
}

function renderSingleExpanded(
  r: SingleResult,
  theme: Theme,
  themeFg: ThemeFg,
  mdTheme: ReturnType<typeof getMarkdownTheme>
): Component {
  const container = new Container();
  appendExpandedResultSections(container, r, theme, themeFg, mdTheme);
  return container;
}

function renderParallelCollapsed(
  results: SingleResult[],
  theme: Theme,
  themeFg: ThemeFg,
  context?: AgentRenderContext
): Component {
  return new WidthText((width) => {
    const lines: string[] = [];
    for (const r of results) {
      const status = resolveExecutionStatus(r);
      lines.push(
        formatSummaryLine(resultSummaryParts(r, theme, { animateContext: context }), width, theme)
      );
      if (status === 'running') {
        const latest = getLatestActivity(r.messages);
        if (latest) lines.push(formatActivityLine(latest, theme, themeFg, width));
      }
    }
    const completed = results.filter((r) => resolveExecutionStatus(r) === 'completed').length;
    const total = results.length;
    const agg = formatAggregateUsageStats(aggregateUsage(results));
    const footer = `Total: ${completed}/${total} completed${agg ? ` · ${agg}` : ''}`;
    lines.push(theme.fg('dim', footer));
    lines.push(theme.fg('muted', EXPAND_HINT));
    return lines.join('\n');
  });
}

function renderParallelExpanded(
  results: SingleResult[],
  theme: Theme,
  themeFg: ThemeFg,
  mdTheme: ReturnType<typeof getMarkdownTheme>
): Component {
  const container = new Container();

  for (const [index, r] of results.entries()) {
    if (index > 0) container.addChild(new Spacer(1));
    appendExpandedResultSections(container, r, theme, themeFg, mdTheme);
  }

  const agg = formatAggregateUsageStats(aggregateUsage(results));
  if (agg) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg('dim', `Total: ${agg}`), 0, 0));
  }
  return container;
}

function fallbackChainFromResults(results: SingleResult[]): ChainExecutionDetails {
  const steps: ChainLogicalStep[] = [];
  const seen = new Set<number>();
  for (const r of results) {
    const step = r.step ?? steps.length + 1;
    if (seen.has(step)) continue;
    seen.add(step);
    const sameStep = results.filter((x) => (x.step ?? step) === step);
    if (sameStep.some((x) => x.fanout) || sameStep.length > 1) {
      const statuses = sameStep.map(resolveExecutionStatus);
      const overall: ExecutionStatus = statuses.every((s) => s === 'completed')
        ? 'completed'
        : statuses.some((s) => s === 'running')
          ? 'running'
          : statuses.some((s) => s === 'failed')
            ? 'failed'
            : statuses.some((s) => s === 'cancelled')
              ? 'cancelled'
              : 'completed';
      steps.push({
        kind: 'fanout',
        step,
        agent: sameStep[0].agent,
        taskTemplate: sameStep[0].task,
        status: overall,
        collectName: '',
        executedCount: sameStep.length,
        completedCount: statuses.filter((s) => s === 'completed').length,
        failedCount: statuses.filter((s) => s === 'failed').length,
        runningCount: statuses.filter((s) => s === 'running').length,
        queuedCount: statuses.filter((s) => s === 'queued').length,
        skippedCount: 0,
      });
    } else {
      steps.push({
        kind: 'sequential',
        step,
        agent: r.agent,
        task: r.task,
        status: resolveExecutionStatus(r),
      });
    }
  }
  return { totalSteps: steps.length, steps };
}

function sequentialResultForStep(
  results: SingleResult[],
  stepNumber: number
): SingleResult | undefined {
  return results.find((r) => r.step === stepNumber && r.fanout === undefined);
}

function fanoutResultsForStep(results: SingleResult[], stepNumber: number): SingleResult[] {
  return results
    .filter((r) => r.step === stepNumber && r.fanout !== undefined)
    .sort((a, b) => (a.fanout?.index ?? 0) - (b.fanout?.index ?? 0));
}

function fanoutProgressText(meta: ChainFanoutStep): string {
  const parts: string[] = [];
  const done = meta.completedCount;
  const total = meta.executedCount;
  parts.push(`${done}/${total} done`);
  if (meta.runningCount > 0) parts.push(`${meta.runningCount} running`);
  if (meta.queuedCount > 0) parts.push(`${meta.queuedCount} queued`);
  if (meta.failedCount > 0) parts.push(`${meta.failedCount} failed`);
  if (meta.skippedCount > 0) parts.push(`${meta.skippedCount} skipped`);
  return parts.join(', ');
}

function chainFooter(chain: ChainExecutionDetails, results: SingleResult[], theme: Theme): string {
  const steps = chain.steps;
  const completed = steps.filter((s) => s.status === 'completed').length;
  const failed = steps.some((s) => s.status === 'failed');
  const cancelled = steps.some((s) => s.status === 'cancelled');
  const skipped = steps.filter((s) => s.status === 'skipped').length;
  const active =
    steps.find((s) => s.status === 'running') ??
    steps.find((s) => s.status === 'failed' || s.status === 'cancelled') ??
    steps[steps.length - 1];
  const currentStep = active?.step ?? steps.length;
  const parts = [`step ${currentStep}/${chain.totalSteps}`, `${completed} completed`];
  if (failed) parts.push('failed');
  if (cancelled) parts.push('cancelled');
  if (skipped > 0) parts.push(`${skipped} skipped`);
  const agg = formatAggregateUsageStats(aggregateUsage(results));
  if (agg) parts.push(agg);
  return theme.fg('dim', `Chain: ${parts.join(' · ')}`);
}

function renderChainCollapsed(
  details: SubagentDetails,
  theme: Theme,
  themeFg: ThemeFg,
  context?: AgentRenderContext
): Component {
  return new WidthText((width) => {
    const chain = details.chain ?? fallbackChainFromResults(details.results);
    const lines: string[] = [];

    for (const step of chain.steps) {
      if (step.status === 'queued' || step.status === 'skipped') continue;

      if (step.kind === 'sequential') {
        const r = sequentialResultForStep(details.results, step.step);
        const synthetic: SingleResult = r ?? {
          agent: step.agent,
          agentSource: 'unknown',
          task: step.task,
          title: step.title,
          exitCode: step.status === 'completed' ? 0 : -1,
          status: step.status,
          messages: [],
          stderr: '',
          usage: emptyUsageAggregate(),
          step: step.step,
        };
        const parts = resultSummaryParts(synthetic, theme, {
          labelPrefix: `${step.step}. `,
          animateContext: context,
        });
        // Prefer logical status for glyph
        parts.glyph = statusGlyph(step.status, theme, context);
        lines.push(formatSummaryLine(parts, width, theme));
        if (step.status === 'running' && r) {
          const latest = getLatestActivity(r.messages);
          if (latest) lines.push(formatActivityLine(latest, theme, themeFg, width));
        }
      } else {
        const items = fanoutResultsForStep(details.results, step.step);
        const usage = aggregateUsage(items.length > 0 ? items : []);
        const parts: SummaryParts = {
          glyph: statusGlyph(step.status, theme, context),
          label: theme.fg('accent', `${step.step}. ${displayAgentName(step.agent)} fanout`),
          task: step.taskTemplate,
          titlePreview: clampTitle(step.title, TITLE_MAX_COLUMNS),
          progress: fanoutProgressText(step),
          usage: formatAggregateUsageStats(usage),
        };
        lines.push(formatSummaryLine(parts, width, theme));
        if (step.status === 'running' && typeof step.latestIndex === 'number') {
          const latestItem = items.find((it) => it.fanout?.index === step.latestIndex);
          if (latestItem) {
            const activity = getLatestActivity(latestItem.messages);
            if (activity) {
              const total = step.executedCount || latestItem.fanout?.count || items.length;
              const oneBased = (step.latestIndex ?? 0) + 1;
              lines.push(
                formatActivityLine(activity, theme, themeFg, width, `[${oneBased}/${total}] `)
              );
            }
          }
        }
      }
    }

    lines.push(chainFooter(chain, details.results, theme));
    lines.push(theme.fg('muted', EXPAND_HINT));
    return lines.join('\n');
  });
}

function renderChainExpanded(
  details: SubagentDetails,
  theme: Theme,
  themeFg: ThemeFg,
  mdTheme: ReturnType<typeof getMarkdownTheme>
): Component {
  const container = new Container();
  const chain = details.chain ?? fallbackChainFromResults(details.results);

  for (const [index, step] of chain.steps.entries()) {
    if (index > 0) container.addChild(new Spacer(1));
    if (step.kind === 'sequential') {
      const r = sequentialResultForStep(details.results, step.step);
      if (r) {
        appendExpandedResultSections(container, r, theme, themeFg, mdTheme);
      } else {
        container.addChild(
          new Text(theme.fg('muted', 'Task: ') + theme.fg('dim', step.task), 0, 0)
        );
        container.addChild(new Text(theme.fg('muted', `(${step.status})`), 0, 0));
      }
    } else {
      container.addChild(new Text(theme.fg('muted', `─── Fanout step ${step.step} ───`), 0, 0));
      if (step.sourceOutput) {
        container.addChild(
          new Text(theme.fg('dim', `expand: ${step.sourceOutput}${step.sourcePath ?? ''}`), 0, 0)
        );
      }
      container.addChild(new Text(theme.fg('dim', `template: ${step.taskTemplate}`), 0, 0));
      if (step.collectName) {
        container.addChild(new Text(theme.fg('dim', `collect: ${step.collectName}`), 0, 0));
      }
      if (step.concurrency) {
        container.addChild(new Text(theme.fg('dim', `concurrency: ${step.concurrency}`), 0, 0));
      }
      if (step.skippedCount > 0) {
        container.addChild(
          new Text(theme.fg('dim', `skipped source items: ${step.skippedCount}`), 0, 0)
        );
      }
      container.addChild(new Text(theme.fg('dim', `progress: ${fanoutProgressText(step)}`), 0, 0));

      const items = fanoutResultsForStep(details.results, step.step);
      for (const item of items) {
        container.addChild(new Spacer(1));
        const idx = (item.fanout?.index ?? 0) + 1;
        const total = item.fanout?.count ?? items.length;
        container.addChild(new Text(theme.fg('muted', `─── Item ${idx}/${total} ───`), 0, 0));
        appendExpandedResultSections(container, item, theme, themeFg, mdTheme);
      }

      if (details.outputs && step.collectName && details.outputs[step.collectName]) {
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(theme.fg('muted', `─── Collect: ${step.collectName} ───`), 0, 0)
        );
        container.addChild(new Text(theme.fg('dim', details.outputs[step.collectName].text), 0, 0));
      }
    }
  }

  container.addChild(new Spacer(1));
  container.addChild(new Text(chainFooter(chain, details.results, theme), 0, 0));
  return container;
}

export function renderResult(
  result: RenderResultInput,
  { expanded, isPartial = false }: RenderResultOptions,
  theme: Theme,
  context?: RenderContext
): Component {
  const details = result.details;
  const mdTheme = getMarkdownTheme();
  const themeFg: ThemeFg = theme.fg.bind(theme);
  // Gate continuous invalidation on ToolRenderResultOptions (isPartial + expanded).
  // History/final renders use isPartial=false, so orphan tickers cannot arm from restored running status.
  const view = { expanded, isPartial };

  if (details && details.mode === 'background') {
    // One-shot launch notice — static hourglass, no continuous spinner.
    stopSpinner(context);
    const launches = details.background ?? [];
    if (launches.length > 0) {
      const launch = launches[0];
      let text =
        theme.fg('warning', `${RUNNING_STATUS_GLYPH} `) +
        theme.fg('toolTitle', theme.bold('background ')) +
        theme.fg('accent', launch.jobId) +
        theme.fg('muted', ` [${launch.mode}]`);
      const launchLabel =
        clampToWidth(launch.title, TITLE_MAX_COLUMNS) ||
        clampToWidth(launch.taskPreview, TITLE_MAX_COLUMNS) ||
        launch.description;
      text += `\n${theme.fg('dim', launchLabel)}`;
      text += `\n${theme.fg('muted', 'You will be notified when it completes.')}`;
      return new Text(text, 0, 0);
    }
  }

  if (!details || details.results.length === 0) {
    // Empty results may still carry Chain logical state (e.g. early validation).
    if (details?.mode === 'chain' && details.chain) {
      syncCollapsedPartialSpinner(context, view, hasRunningChain(details.chain));
      return expanded
        ? renderChainExpanded(details, theme, themeFg, mdTheme)
        : renderChainCollapsed(details, theme, themeFg, context);
    }
    stopSpinner(context);
    const text = result.content[0];
    return new Text(text?.type === 'text' ? (text.text ?? '(no output)') : '(no output)', 0, 0);
  }

  if (details.mode === 'single' && details.results.length === 1) {
    const r = details.results[0];
    syncCollapsedPartialSpinner(context, view, resolveExecutionStatus(r) === 'running');
    return expanded
      ? renderSingleExpanded(r, theme, themeFg, mdTheme)
      : renderSingleCollapsed(r, theme, themeFg, context);
  }

  if (details.mode === 'chain') {
    syncCollapsedPartialSpinner(context, view, detailsNeedsCollapsedSpinner(details));
    return expanded
      ? renderChainExpanded(details, theme, themeFg, mdTheme)
      : renderChainCollapsed(details, theme, themeFg, context);
  }

  if (details.mode === 'parallel') {
    syncCollapsedPartialSpinner(context, view, hasRunningResults(details.results));
    return expanded
      ? renderParallelExpanded(details.results, theme, themeFg, mdTheme)
      : renderParallelCollapsed(details.results, theme, themeFg, context);
  }

  stopSpinner(context);
  const text = result.content[0];
  return new Text(text?.type === 'text' ? (text.text ?? '(no output)') : '(no output)', 0, 0);
}
