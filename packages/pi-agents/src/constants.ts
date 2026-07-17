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

/** Default RPC request timeout before rejecting with a timeout error. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** Grace period to wait for child stdout/stderr to drain before forcing exit. */
export const DEFAULT_KILL_TIMEOUT_MS = 5_000;
/** Unified absolute budget for the entire interactive shutdown dispose path. */
export const DEFAULT_SHUTDOWN_DISPOSE_BUDGET_MS = 5_500;
/** Coalescing interval for per-run persistence writes. */
export const DEFAULT_COALESCE_MS = 250;
/** Timeout for `npm root -g` discovery. */
export const NPM_ROOT_TIMEOUT_MS = 5_000;

/** Max chars for error/details preview in compact message views. */
export const PRESENTATION_ERROR_PREVIEW_CHARS = 240;
/** Max chars for bash command preview in rendered tool calls. */
export const PRESENTATION_COMMAND_PREVIEW_CHARS = 60;
/** Max chars for unknown tool-call args JSON preview. */
export const PRESENTATION_ARGS_PREVIEW_CHARS = 50;
/** Max chars for tool-call names in compact items. */
export const PRESENTATION_NAME_TRUNC_CHARS = 32;
/** Max tail chars retained for worktree error detail. */
export const PRESENTATION_OUTPUT_TAIL_CHARS = 400;
/** Max chars for malformed JSON preview in protocol errors. */
export const JSON_ERROR_PREVIEW_CHARS = 200;
/** Max chars for background run-id prefix in continuation headers. */
export const PRESENTATION_RUNID_PREVIEW_CHARS = 8;

/** Max chars for auto-generated worktree directory name prefix. */
export const WORKTREE_NAME_MAX_CHARS = 40;

/** Per non-authoritative interactive message payload cap (thinking/tool args/results). */
export const INTERACTIVE_NON_AUTHORITATIVE_ITEM_MAX_BYTES = 64 * 1024;
/** Total warm idle endpoint transcript budget before eviction/rehydration. */
export const INTERACTIVE_IDLE_TRANSCRIPT_MAX_BYTES = 512 * 1024;

export const PI_AGENT_CHILD = 'PI_AGENT_CHILD';
export const PI_AGENT_DEPTH = 'PI_AGENT_DEPTH';
export const PI_AGENT_MAX_DEPTH = 'PI_AGENT_MAX_DEPTH';
export const PI_AGENT_TOOL_AVAILABLE = 'PI_AGENT_TOOL_AVAILABLE';
export const DEFAULT_AGENT_MAX_DEPTH = 2;
export const AGENT_TOOL_NAME = 'agent';

export const GROK_ACP_RUNTIME = 'grok-acp' as const;
export const DEFAULT_RUNTIME = 'pi' as const;
export const GROK_BINARY = 'grok' as const;
