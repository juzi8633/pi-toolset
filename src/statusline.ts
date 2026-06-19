// ABOUTME: Pure formatter for the LSP statusLine indicator.
// ABOUTME: Maps {running, starting, error} into a colored display string.

export interface LspStatusCounts {
  running: number;
  starting: number;
  error: number;
}

/**
 * Color function injected by the caller (typically `theme.fg`). The formatter
 * stays decoupled from the TUI so it can be unit-tested with an identity stub.
 */
export type StatusColorFn = (color: 'border' | 'dim' | 'error', text: string) => string;

/**
 * Format the LSP statusLine segment from a live counts snapshot.
 *
 * Returns `undefined` when all tracked counts are zero so callers can clear
 * the segment via `setStatus(key, undefined)` instead of rendering "LSP 0".
 */
export function formatLspStatus(counts: LspStatusCounts, fg: StatusColorFn): string | undefined {
  const { running, starting, error } = counts;
  if (running === 0 && starting === 0 && error === 0) {
    return undefined;
  }

  const parts: string[] = [`${fg('border', '⚡')}LSP`];
  if (running > 0) {
    parts.push(`🟢${running}`);
  }
  if (starting > 0) {
    parts.push(fg('dim', `🟡${starting}`));
  }
  if (error > 0) {
    parts.push(fg('error', `🔴${error}`));
  }
  return parts.join(' ');
}
