// ABOUTME: Pure formatter for the LSP statusLine indicator.
// ABOUTME: Maps {running, starting, error} into a colored display string.

import type { ThemeColor } from '@earendil-works/pi-coding-agent';

export interface LspStatusCounts {
  running: number;
  starting: number;
  error: number;
}

/**
 * Color function injected by the caller (typically `theme.fg`). The formatter
 * stays decoupled from the TUI so it can be unit-tested with an identity stub.
 */
export type StatusColorFn = (color: ThemeColor, text: string) => string;

/**
 * Format the LSP statusLine segment from a live counts snapshot.
 *
 * Philosophy: ambient when healthy, loud when broken. The base `⚡LSP` label
 * stays visible whenever any server is tracked; only abnormal states append
 * extra segments. Returns `undefined` when nothing is tracked so callers can
 * clear the segment via `setStatus(key, undefined)`.
 */
export function formatLspStatus(
  counts: LspStatusCounts,
  fg: StatusColorFn,
  hasDiagnostics = false
): string | undefined {
  const { running, starting, error } = counts;
  if (running === 0 && starting === 0 && error === 0) {
    return undefined;
  }

  // The bolt turns error-colored while any diagnostic is tracked so the user
  // gets an ambient "something needs attention" cue; the "LSP" suffix keeps
  // the accent color so the segment stays readable.
  const label = hasDiagnostics
    ? `${fg('error', '⚡')}${fg('accent', 'LSP')}`
    : fg('accent', '⚡LSP');
  const parts: string[] = [label];
  if (starting > 0) {
    parts.push(fg('dim', `…${starting}`));
  }
  if (error > 0) {
    parts.push(fg('error', `✕${error}`));
  }
  return parts.join(' ');
}
