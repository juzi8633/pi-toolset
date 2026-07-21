// ABOUTME: Session-scoped background job manager for the `agent` tool.
// ABOUTME: Owns job ids, limits, completion notifications, rendering, and shutdown cancellation.

import type {
  AgentToolResult,
  ExtensionAPI,
  MessageRenderOptions,
  Theme,
} from '@earendil-works/pi-coding-agent';
import { getMarkdownTheme } from '@earendil-works/pi-coding-agent';
import { Container, Markdown, Spacer, Text, type Component } from '@earendil-works/pi-tui';
import { Effect } from 'effect';
import { getBuiltinAgentsDir, type AgentScope } from './agents.ts';
import { PRESENTATION_ERROR_PREVIEW_CHARS } from './constants.ts';
import { runEffectPromise } from './effect-runtime.ts';
import { truncateParallelOutput } from './output.ts';
import type { RunAbortOrigin } from './run-types.ts';
import type {
  BackgroundJobStatus,
  BackgroundLaunchDetails,
  BackgroundNotificationDetails,
  SubagentDetails,
} from './types.ts';

export const BACKGROUND_MESSAGE_TYPE = 'pi-agents-background-result';

export const DEFAULT_MAX_BACKGROUND_JOBS = 4;

export interface BackgroundLaunchRequest {
  mode: 'single' | 'parallel' | 'chain';
  agentScope: AgentScope;
  description: string;
  taskPreview: string;
  /** Short launch-summary label; falls back to `taskPreview` when blank. */
  title?: string;
  projectAgentsDir: string | null;
  run: (signal: AbortSignal) => Promise<AgentToolResult<SubagentDetails> & { isError?: boolean }>;
  /** Durable run context; when present, the job's id equals the run id and shutdown interrupts. */
  durable?: DurableRunContextRef;
}

/**
 * Minimal durable-run handle carried into the background manager. Mirrors the
 * fields the manager needs to interrupt and finalize without coupling to tool.ts internals.
 */
export interface DurableRunContextRef {
  runId: string;
  abort(origin: RunAbortOrigin): void;
  finalize(input: {
    success?: boolean;
    cancelled?: boolean;
    interrupted?: boolean;
    lastError?: string;
  }): Promise<void>;
  lifecycle: { signal: AbortSignal };
}

export interface BackgroundManager {
  launch(
    request: BackgroundLaunchRequest
  ): AgentToolResult<SubagentDetails> & { isError?: boolean };
  cancelAll(reason: string): void;
  activeCount(): number;
  waitForIdle(): Promise<void>;
}

export interface BackgroundManagerOptions {
  maxJobs?: number;
  now?: () => number;
}

type MinimalSendMessageApi = Pick<ExtensionAPI, 'sendMessage'>;

interface BackgroundJob {
  details: BackgroundLaunchDetails;
  controller: AbortController;
  promise: Promise<void>;
  /**
   * Synchronously emit the terminal notification for this job, deduplicated
   * against any later run-side `finish()` via the per-job `settled` latch.
   * Used by `cancelAll()` so cancellation is recorded even when the process
   * exits before `request.run()` settles.
   */
  emitCancellation: () => void;
  /** Durable run context attached when launched with persistence. */
  durable?: DurableJobState;
}

interface DurableJobState {
  runId: string;
  abort: (origin: RunAbortOrigin) => void;
  finalize: (input: {
    success?: boolean;
    cancelled?: boolean;
    interrupted?: boolean;
    lastError?: string;
  }) => Promise<void>;
  lifecycle: { signal: AbortSignal };
}

interface BackgroundNotificationMessage {
  customType: string;
  content: string | { type: string; text?: string }[];
  display: boolean;
  details?: BackgroundNotificationDetails;
  timestamp: number;
}

export function createBackgroundManager(
  pi: MinimalSendMessageApi,
  options: BackgroundManagerOptions = {}
): BackgroundManager {
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_BACKGROUND_JOBS;
  const now = options.now ?? (() => Date.now());
  const jobs = new Map<string, BackgroundJob>();

  const runningCount = (): number => {
    let count = 0;
    for (const job of jobs.values()) if (job.details.status === 'running') count++;
    return count;
  };

  const makeJobId = (): string => {
    const stamp = Date.now().toString(36);
    const suffix = Math.random().toString(36).slice(2, 8);
    return `agent-bg-${stamp}-${suffix}`;
  };

  const launch = (
    request: BackgroundLaunchRequest
  ): AgentToolResult<SubagentDetails> & { isError?: boolean } => {
    if (runningCount() >= maxJobs) {
      return {
        content: [
          {
            type: 'text',
            text: `Too many background agent jobs in flight (max ${maxJobs}). Wait for one to finish, or run this agent in the foreground.`,
          },
        ],
        details: {
          mode: 'background',
          agentScope: request.agentScope,
          projectAgentsDir: request.projectAgentsDir,
          builtinAgentsDir: getBuiltinAgentsDir(),
          results: [],
          background: [],
        },
        isError: true,
      };
    }

    const jobId = request.durable ? request.durable.runId : makeJobId();
    const startedAt = now();
    const durable = request.durable;
    const launchDetails: BackgroundLaunchDetails = {
      jobId,
      mode: request.mode,
      status: 'running',
      agentScope: request.agentScope,
      description: request.description,
      startedAt,
      taskPreview: request.taskPreview,
      ...(request.title ? { title: request.title } : {}),
    };
    const controller = new AbortController();
    // When a durable lifecycle is attached, the run observes the coordinator-
    // owned signal so shutdown surfaces as `interrupted` rather than a bare
    // job-local cancellation. Otherwise the job-local controller is the source.
    const runSignal = durable ? durable.lifecycle.signal : controller.signal;
    let settled = false;

    const finish = (status: BackgroundJobStatus, result?: string, error?: string): void => {
      if (settled) return;
      settled = true;
      const job = jobs.get(jobId);
      if (job) job.details.status = status;
      const finishedAt = now();
      const notification: BackgroundNotificationDetails = {
        jobId,
        mode: request.mode,
        status,
        description: request.description,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        ...(result !== undefined ? { result } : {}),
        ...(error !== undefined ? { error } : {}),
      };

      const safeResult = result ? truncateParallelOutput(result) : undefined;
      const safeError = error ? truncateParallelOutput(error) : undefined;
      const sections: string[] = [];
      sections.push(`<pi-agents-background jobId="${jobId}" status="${status}">`);
      sections.push(`<summary>${escapeXml(request.description)}</summary>`);
      if (safeResult) sections.push(`<result>\n${safeResult}\n</result>`);
      if (safeError) sections.push(`<error>\n${safeError}\n</error>`);
      sections.push('</pi-agents-background>');
      const messageContent = sections.join('\n');

      try {
        pi.sendMessage(
          {
            customType: BACKGROUND_MESSAGE_TYPE,
            content: messageContent,
            display: true,
            details: notification,
          },
          { triggerTurn: status !== 'cancelled', deliverAs: 'followUp' }
        );
      } catch {
        // Best-effort: completion notification is informational. Continue.
      }
    };

    // Register the job before invoking request.run() so that synchronous
    // failures and concurrent launches account for it correctly.
    let runPromise: Promise<void> = Promise.resolve();
    /**
     * Send only the terminal notification without settling or removing the
     * job. Used by cancelAll() so the notification is recorded synchronously
     * (surviving process exit) while the runPromise still drives finalize,
     * flush, and the eventual finish()/delete. The per-job `settled` latch
     * deduplicates the later run-side finish().
     */
    const emitCancellation = (): void => {
      const job = jobs.get(jobId);
      if (!job) return;
      if (settled) return;
      settled = true;
      job.details.status = 'cancelled';
      const finishedAt = now();
      const notification: BackgroundNotificationDetails = {
        jobId,
        mode: request.mode,
        status: 'cancelled',
        description: request.description,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      };
      try {
        pi.sendMessage(
          {
            customType: BACKGROUND_MESSAGE_TYPE,
            content: `<pi-agents-background jobId="${jobId}" status="cancelled">\n<summary>${escapeXml(request.description)}</summary>\n</pi-agents-background>`,
            display: true,
            details: notification,
          },
          { triggerTurn: false, deliverAs: 'followUp' }
        );
      } catch {
        // Best-effort.
      }
    };
    jobs.set(jobId, {
      details: launchDetails,
      controller,
      promise: runPromise,
      durable: durable
        ? {
            runId: durable.runId,
            abort: durable.abort,
            finalize: durable.finalize,
            lifecycle: durable.lifecycle,
          }
        : undefined,
      emitCancellation: () => emitCancellation(),
    });

    runPromise = (async () => {
      let runResult: (AgentToolResult<SubagentDetails> & { isError?: boolean }) | undefined;
      let runError: unknown;
      try {
        runResult = await request.run(runSignal);
      } catch (err) {
        runError = err;
      }
      try {
        const aborted = durable ? durable.lifecycle.signal.aborted : controller.signal.aborted;
        if (aborted) {
          if (durable) await durable.finalize({ interrupted: true });
          finish('cancelled');
          return;
        }
        if (runError !== undefined) {
          const message = runError instanceof Error ? runError.message : String(runError);
          if (durable) await durable.finalize({ success: false, lastError: message });
          finish('failed', undefined, message);
          return;
        }
        const text = extractText(runResult!);
        if (runResult!.isError) {
          if (durable) await durable.finalize({ success: false, lastError: text });
          finish('failed', undefined, text);
        } else {
          if (durable) await durable.finalize({ success: true });
          finish('completed', text);
        }
      } finally {
        // finish() may have been a no-op if emitCancellation() already settled
        // (cancelAll). Ensure the job is removed so waitForIdle() can drain.
        jobs.delete(jobId);
      }
    })();
    runPromise.catch(() => {});
    // Update the recorded promise so waitForIdle() awaits the actual work.
    const job = jobs.get(jobId);
    if (job) job.promise = runPromise;

    const launchText =
      `⧗ Background agent launched (${jobId}).\n` +
      `Mode: ${request.mode}. ${request.description}\n` +
      `Completion arrives as a follow-up that starts a new turn. Never sleep, poll, or call agent({ runId }) to wait — continue other work or end the turn.`;

    return {
      content: [{ type: 'text', text: launchText }],
      details: {
        mode: 'background',
        agentScope: request.agentScope,
        projectAgentsDir: request.projectAgentsDir,
        builtinAgentsDir: getBuiltinAgentsDir(),
        results: [],
        background: [launchDetails],
      },
    };
  };

  const cancelAll = (_reason: string): void => {
    for (const job of jobs.values()) {
      if (job.details.status === 'running') {
        job.details.status = 'cancelled';
        // When a durable run is attached, interrupt via the coordinator-owned
        // lifecycle as `session_shutdown` so the terminal snapshot classifies
        // as interrupted rather than user-cancelled. Otherwise abort the
        // job-local controller.
        try {
          if (job.durable) job.durable.abort('session_shutdown');
          else job.controller.abort();
        } catch {
          // ignore
        }
        // Record the cancellation notification synchronously so it is not lost
        // when the process exits before request.run() settles. The per-job
        // `settled` latch deduplicates against any later run-side finish().
        job.emitCancellation();
      }
    }
  };

  /**
   * Drain until the job map is empty. Uses Effect.promise + allSettled so a
   * single job rejection cannot abort waiting for siblings (same as before).
   */
  const waitForIdle = (): Promise<void> =>
    runEffectPromise(
      Effect.gen(function* () {
        while (jobs.size > 0) {
          const pending = Array.from(jobs.values()).map((j) => j.promise);
          yield* Effect.promise(() => Promise.allSettled(pending));
        }
      })
    );

  return {
    launch,
    cancelAll,
    activeCount: () => runningCount(),
    waitForIdle,
  };
}

function extractText(result: AgentToolResult<SubagentDetails>): string {
  const parts: string[] = [];
  for (const part of result.content) {
    if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
      parts.push(part.text);
    }
  }
  return parts.join('\n').trim();
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds - minutes * 60);
  return `${minutes}m${rem}s`;
}

export function renderBackgroundMessage(
  message: BackgroundNotificationMessage,
  options: MessageRenderOptions,
  theme: Theme
): Component {
  const details = message.details;
  if (!details) {
    return new Text(theme.fg('muted', '(background agent: no details)'), 0, 0);
  }

  const statusIcon = (() => {
    switch (details.status) {
      case 'completed':
        return theme.fg('success', '✔');
      case 'failed':
        return theme.fg('error', '✗');
      case 'cancelled':
        return theme.fg('warning', '⊘');
      default:
        return theme.fg('warning', '⧗');
    }
  })();

  const header =
    `${statusIcon} ${theme.fg('toolTitle', theme.bold('background '))}` +
    theme.fg('accent', details.jobId) +
    theme.fg('muted', ` [${details.mode}]`);

  if (!options.expanded) {
    let text = header;
    text += `\n${theme.fg('dim', details.description)}`;
    if (details.status === 'failed' && details.error) {
      text += `\n${theme.fg('error', truncate(details.error, PRESENTATION_ERROR_PREVIEW_CHARS))}`;
    } else if (details.result) {
      text += `\n${theme.fg('toolOutput', truncate(details.result, PRESENTATION_ERROR_PREVIEW_CHARS))}`;
    }
    if (details.durationMs !== undefined) {
      text += `\n${theme.fg('muted', `(${formatDuration(details.durationMs)})`)}`;
    }
    return new Text(text, 0, 0);
  }

  const container = new Container();
  container.addChild(new Text(header, 0, 0));
  container.addChild(new Text(theme.fg('muted', `Status: ${details.status}`), 0, 0));
  container.addChild(
    new Text(theme.fg('muted', 'Task: ') + theme.fg('dim', details.description), 0, 0)
  );
  if (details.durationMs !== undefined) {
    container.addChild(
      new Text(theme.fg('muted', `Duration: ${formatDuration(details.durationMs)}`), 0, 0)
    );
  }
  if (details.result) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg('muted', '─── Result ───'), 0, 0));
    container.addChild(new Markdown(details.result.trim(), 0, 0, getMarkdownTheme()));
  }
  if (details.error) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg('muted', '─── Error ───'), 0, 0));
    container.addChild(new Text(theme.fg('error', details.error.trim()), 0, 0));
  }
  return container;
}
