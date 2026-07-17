// ABOUTME: Shared constants for LSP server lifecycle, diagnostics, and timeouts.
// ABOUTME: Imported by instance, recipes, client, and diagnostics modules.

/** Default startup timeout before rejecting with a timeout error (ms). */
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
/** Default graceful shutdown timeout before forcing kill (ms). */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
/** Fallback startup timeout for recipes that don't specify one (ms). */
export const FALLBACK_STARTUP_TIMEOUT_MS = 10_000;
