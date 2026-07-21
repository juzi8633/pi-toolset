// ABOUTME: Zero-dependency empty UsageStats factory for failure and running slots.
// ABOUTME: Import-free leaf so setup paths cannot hit circular module initialization.

/** Matches `UsageStats` in types.ts; duplicated here to keep this module import-free. */
export interface EmptyUsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export function emptyUsage(): EmptyUsageStats {
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
