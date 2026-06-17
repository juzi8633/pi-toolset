// ABOUTME: Minimal internal logger for the LSP extension.
// ABOUTME: Replaces Claude Code's debug/error helpers; gated by PI_LSP_DEBUG, never uses console.

const DEBUG = process.env.PI_LSP_DEBUG === '1' || process.env.PI_LSP_DEBUG === 'true';

export function logForDebugging(message: string, options?: { level?: string }): void {
  if (DEBUG) {
    const level = options?.level ? `[${options.level}]` : '';
    process.stderr.write(`[pi-lsp]${level} ${message}\n`);
  }
}

export function logError(error: unknown): void {
  if (DEBUG) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[pi-lsp][error] ${message}\n`);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
