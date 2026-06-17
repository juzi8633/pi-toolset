// ABOUTME: Pi LSP extension entry point and session lifecycle wiring.
// ABOUTME: Lazily starts the LSP manager on session_start and tears it down on session_shutdown.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { initializeManager, shutdownManager } from './manager.ts';
import { registerLspTool } from './tools.ts';

export default function (pi: ExtensionAPI): void {
  // No process/timer/watcher work in the factory body — registering the tool is
  // pure metadata. All process spawning is deferred to first tool use.
  registerLspTool(pi);

  pi.on('session_start', (_event, ctx) => {
    // Synchronous, non-blocking, idempotent. Servers are lazily started on the
    // first tool call, not here.
    initializeManager(ctx.cwd);
  });

  pi.on('session_shutdown', async () => {
    // Idempotent: fires on quit/reload/new/resume/fork. Tears down all servers.
    await shutdownManager();
  });
}
