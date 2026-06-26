// ABOUTME: Shared limits and caps for subagent execution and output rendering.
// ABOUTME: Imported by execution, output, and tool orchestration modules.

export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const COLLAPSED_ITEM_COUNT = 10;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

export const PI_AGENT_CHILD = 'PI_AGENT_CHILD';
export const PI_AGENT_DEPTH = 'PI_AGENT_DEPTH';
export const PI_AGENT_MAX_DEPTH = 'PI_AGENT_MAX_DEPTH';
export const DEFAULT_AGENT_MAX_DEPTH = 2;
