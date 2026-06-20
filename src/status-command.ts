// ABOUTME: Registers the /lsp status slash command for inspecting live LSP server details.
// ABOUTME: Formats manager and server state without starting language-server processes.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import type { LSPServerInstance } from './instance.ts';
import {
  getManager,
  initializeManager,
  type LSPServerManager,
  waitForInitialization,
} from './manager.ts';
import type { LspServerState } from './types.ts';

const STATUS_SUBCOMMAND = 'status';

export function registerLspStatusCommand(pi: ExtensionAPI): void {
  pi.registerCommand('lsp', {
    description: 'Show LSP server status and configuration details',
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      if (STATUS_SUBCOMMAND.startsWith(prefix.trim())) {
        return [{ value: STATUS_SUBCOMMAND, label: STATUS_SUBCOMMAND }];
      }
      return null;
    },
    handler: async (args, ctx) => {
      const subcommand = args.trim();
      if (subcommand !== STATUS_SUBCOMMAND) {
        ctx.ui.notify('Usage: /lsp status', 'info');
        return;
      }

      initializeManager(ctx.cwd);
      await waitForInitialization();

      const manager = getManager();
      ctx.ui.notify(formatLspStatusDetails(manager), manager ? 'info' : 'warning');
    },
  });
}

export function formatLspStatusDetails(manager: LSPServerManager | undefined): string {
  if (!manager) {
    return ['LSP status', '', 'Manager: not initialized or initialization failed.'].join('\n');
  }

  const servers = Array.from(manager.getAllServers().values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const counts = countServerStates(servers);

  const lines = [
    'LSP status',
    '',
    'Manager: initialized',
    `Servers: ${servers.length}`,
    `States: running ${counts.running}, starting ${counts.starting}, stopped ${counts.stopped}, stopping ${counts.stopping}, error ${counts.error}`,
  ];

  if (servers.length === 0) {
    lines.push('', 'No LSP servers are configured or autodetected for this session.');
    return lines.join('\n');
  }

  lines.push('', 'Server details:');
  for (const server of servers) {
    lines.push(...formatServerDetails(server));
  }

  return lines.join('\n');
}

function countServerStates(servers: LSPServerInstance[]): Record<LspServerState, number> {
  const counts: Record<LspServerState, number> = {
    stopped: 0,
    starting: 0,
    running: 0,
    stopping: 0,
    error: 0,
  };

  for (const server of servers) {
    counts[server.state]++;
  }

  return counts;
}

function formatServerDetails(server: LSPServerInstance): string[] {
  const extensions = Object.keys(server.config.extensionToLanguage).sort();
  const lines = [
    `- ${server.name}: ${server.state}`,
    `  command: ${formatCommand(server.config.command, server.config.args ?? [])}`,
    `  workspace: ${server.config.workspaceFolder ?? '(session cwd)'}`,
    `  extensions: ${extensions.length > 0 ? extensions.join(', ') : '(none)'}`,
  ];

  if (server.startTime) {
    lines.push(`  started: ${server.startTime.toISOString()}`);
  }
  if (server.restartCount > 0) {
    lines.push(`  restarts: ${server.restartCount}`);
  }
  if (server.lastError) {
    lines.push(`  last error: ${server.lastError.message}`);
  }

  return lines;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteShellArg).join(' ');
}

function quoteShellArg(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
