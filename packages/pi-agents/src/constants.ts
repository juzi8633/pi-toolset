// ABOUTME: Shared limits and caps for subagent execution and output rendering.
// ABOUTME: Imported by execution, output, and tool orchestration modules.

export const MAX_PARALLEL_TASKS = 8;
export const MAX_FANOUT_ITEMS = MAX_PARALLEL_TASKS;
export const MAX_CONCURRENCY = 4;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

/** Total UTF-8 JSON size budget for a compact `presentation` object (transcript + latestActivity). */
export const RESULT_PRESENTATION_MAX_BYTES = 512 * 1024;
/** Per display-item UTF-8 JSON size budget before text/args bounding. */
export const RESULT_PRESENTATION_ITEM_MAX_BYTES = 64 * 1024;
/** Bound for non-authoritative `stderr` / `errorMessage` / `errorStack` snapshots. */
export const RESULT_DIAGNOSTIC_MAX_BYTES = 64 * 1024;

/** Parent content-update coalescing interval (matches TUI spinner cadence). */
export const RESULT_UPDATE_INTERVAL_MS = 150;

export const PI_AGENT_CHILD = 'PI_AGENT_CHILD';
export const PI_AGENT_DEPTH = 'PI_AGENT_DEPTH';
export const PI_AGENT_MAX_DEPTH = 'PI_AGENT_MAX_DEPTH';
export const PI_AGENT_TOOL_AVAILABLE = 'PI_AGENT_TOOL_AVAILABLE';
export const DEFAULT_AGENT_MAX_DEPTH = 2;
export const AGENT_TOOL_NAME = 'agent';

export const GROK_ACP_RUNTIME = 'grok-acp' as const;
export const DEFAULT_RUNTIME = 'pi' as const;
export const GROK_BINARY = 'grok' as const;
