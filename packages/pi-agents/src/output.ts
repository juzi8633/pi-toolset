// ABOUTME: Pure output helpers for subagent results: final output extraction, failure detection, and byte-safe truncation.
// ABOUTME: Consumed by execution streaming, tool orchestration, and TUI rendering.

import type { Message } from '@earendil-works/pi-ai';
import { PER_TASK_OUTPUT_CAP } from './constants.ts';
import { formatParentArtifactDescriptor } from './result-payload.ts';
import type { DisplayItem, ExecutionStatus, SingleResult } from './types.ts';

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

// Only non-zero fields are emitted so partial stats can stream (e.g. ctx mid-turn).
export function formatUsageStats(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens?: number;
    turns?: number;
  },
  model?: string,
  thinking?: string
): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(thinking ? `${model} • ${thinking}` : model);
  return parts.join(' ');
}

/** Aggregate usage: sum token/turn fields; max context as `ctx:max N`; no model/thinking. */
export function formatAggregateUsageStats(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens?: number;
  turns?: number;
}): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:max ${formatTokens(usage.contextTokens)}`);
  }
  return parts.join(' ');
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      for (const part of msg.content) {
        if (part.type === 'text') return part.text;
      }
    }
  }
  return '';
}

const FAILURE_STOP_REASONS = new Set([
  'error',
  'aborted',
  'max_turns',
  'context_error',
  'isolation_error',
  'completion_check',
  'template_error',
  'structured_output_error',
  'fanout_error',
  'worktree_setup_error',
]);

export function isFailedResult(result: SingleResult): boolean {
  if (result.exitCode !== 0) return true;
  return result.stopReason !== undefined && FAILURE_STOP_REASONS.has(result.stopReason);
}

/** Resolve authoritative status with conservative fallback for older sessions. */
export function resolveExecutionStatus(result: SingleResult): ExecutionStatus {
  if (result.status) return result.status;
  if (result.exitCode === -1) return 'running';
  if (result.stopReason === 'interrupted') return 'interrupted';
  if (result.stopReason === 'aborted') return 'cancelled';
  if (isFailedResult(result)) return 'failed';
  return 'completed';
}

/** Set terminal status from stop reason and exit code after a run finishes. */
export function applyTerminalStatus(result: SingleResult): void {
  if (result.stopReason === 'aborted') {
    result.status = 'cancelled';
  } else if (isFailedResult(result)) {
    result.status = 'failed';
  } else {
    result.status = 'completed';
  }
}

/** Prefer explicit `finalOutput`, then legacy message scan. */
export function getResultFinalOutput(result: SingleResult): string {
  if (result.finalOutput !== undefined) return result.finalOutput;
  return getFinalOutput(result.messages);
}

/**
 * Latest display activity for collapsed rendering.
 * Compact precedence: explicit `latestActivity`, then synthesized text from
 * de-duplicated `finalOutput`, then the last retained transcript item as a
 * defensive fallback. Legacy results fall back to message scanning.
 */
export function getResultLatestActivity(result: SingleResult): DisplayItem | undefined {
  const presentation = result.presentation;
  if (presentation) {
    if (presentation.latestActivity) return presentation.latestActivity;
    // De-duplicated latest text: synthesize even when finalOutput is ''.
    if (result.finalOutput !== undefined) return { type: 'text', text: result.finalOutput };
    // Defensive fallback for incomplete compact data without finalOutput.
    const transcript = presentation.transcript;
    if (transcript.length > 0) return transcript[transcript.length - 1];
    return undefined;
  }
  return getLatestActivity(result.messages);
}

/**
 * Ordered transcript plus final output for expanded rendering.
 * Uses compact presentation when present; otherwise derives both from messages.
 */
export function getResultTranscriptAndFinal(result: SingleResult): {
  transcript: DisplayItem[];
  finalOutput: string;
} {
  if (result.presentation) {
    return {
      transcript: result.presentation.transcript,
      finalOutput: getResultFinalOutput(result),
    };
  }
  return getTranscriptAndFinal(result.messages);
}

export function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    if (result.stopReason === 'completion_check') {
      const reason = result.errorMessage || 'Completion check failed';
      const agentOutput = getResultFinalOutput(result) || '(no output)';
      return `${reason}\n\nUnchecked agent output:\n${agentOutput}`;
    }
    return result.errorMessage || result.stderr || getResultFinalOutput(result) || '(no output)';
  }
  return getResultFinalOutput(result) || '(no output)';
}

export function truncateParallelOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, 'utf8');
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, 'utf8') > PER_TASK_OUTPUT_CAP) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, 'utf8')} bytes omitted. Full output preserved in tool details.]`;
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const part of msg.content) {
        if (part.type === 'text') items.push({ type: 'text', text: part.text });
        else if (part.type === 'toolCall')
          items.push({ type: 'toolCall', name: part.name, args: part.arguments });
      }
    }
  }
  return items;
}

/** Last displayable tool call or assistant text item, or undefined when empty. */
export function getLatestActivity(messages: Message[]): DisplayItem | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const part = msg.content[j];
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'toolCall')
        return { type: 'toolCall', name: part.name, args: part.arguments };
    }
  }
  return undefined;
}

/**
 * Ordered transcript (tool calls + earlier assistant text) plus separately identified final output.
 * The assistant text selected as final output is excluded from the transcript so Expanded renders it once.
 * Trailing tool-only assistant messages do not steal final-output identity from earlier text.
 */
export function getTranscriptAndFinal(messages: Message[]): {
  transcript: DisplayItem[];
  finalOutput: string;
} {
  let finalMsgIdx = -1;
  let finalPartIdx = -1;
  let finalOutput = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant') continue;
    for (let j = 0; j < msg.content.length; j++) {
      const part = msg.content[j];
      if (part.type === 'text') {
        finalMsgIdx = i;
        finalPartIdx = j;
        finalOutput = part.text;
        break;
      }
    }
    if (finalMsgIdx >= 0) break;
  }

  if (!finalOutput) {
    return { transcript: getDisplayItems(messages), finalOutput: '' };
  }

  const transcript: DisplayItem[] = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi];
    if (msg.role !== 'assistant') continue;
    for (let pi = 0; pi < msg.content.length; pi++) {
      const part = msg.content[pi];
      if (part.type === 'text') {
        if (mi === finalMsgIdx && pi === finalPartIdx) continue;
        transcript.push({ type: 'text', text: part.text });
      } else if (part.type === 'toolCall') {
        transcript.push({ type: 'toolCall', name: part.name, args: part.arguments });
      }
    }
  }
  return { transcript, finalOutput };
}

/** Parent artifact descriptor max UTF-8 bytes (2 KiB metadata cap). */
const PARENT_DESCRIPTOR_MAX_BYTES = 2048;

/**
 * Ref-aware parent output text for terminal result delivery.
 * Inline finalOutput text wins; finalOutputRef produces a metadata-only
 * descriptor capped at 2 KiB; only absent authority produces "(no output)".
 */
export function getResultParentOutput(result: SingleResult): string {
  if (result.finalOutput !== undefined && result.finalOutput !== '') return result.finalOutput;
  if (result.finalOutputRef) {
    const descriptor = formatParentArtifactDescriptor(result.finalOutputRef);
    if (Buffer.byteLength(descriptor, 'utf8') <= PARENT_DESCRIPTOR_MAX_BYTES) return descriptor;
    return `[run-artifact payload=${result.finalOutputRef.payload} bytes=${result.finalOutputRef.bytes}]`;
  }
  const scanned = getResultFinalOutput(result);
  if (scanned) return scanned;
  return '(no output)';
}
