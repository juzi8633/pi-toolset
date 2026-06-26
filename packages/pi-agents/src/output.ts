// ABOUTME: Pure output helpers for subagent results: final output extraction, failure detection, and byte-safe truncation.
// ABOUTME: Consumed by execution streaming, tool orchestration, and TUI rendering.

import type { Message } from '@earendil-works/pi-ai';
import { PER_TASK_OUTPUT_CAP } from './constants.ts';
import type { DisplayItem, SingleResult } from './types.ts';

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

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
  model?: string
): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
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
  'completion_guard',
  'template_error',
]);

export function isFailedResult(result: SingleResult): boolean {
  if (result.exitCode !== 0) return true;
  return result.stopReason !== undefined && FAILURE_STOP_REASONS.has(result.stopReason);
}

export function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || '(no output)';
  }
  return getFinalOutput(result.messages) || '(no output)';
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
