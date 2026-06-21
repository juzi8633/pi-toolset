// ABOUTME: Registers the /lsp slash command (status, start/stop) and its subcommand handlers.
// ABOUTME: /lsp status formats live state; /lsp start shows a picker to toggle each configured server.

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getSettingsListTheme } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import { Container, type SettingItem, SettingsList, Text } from '@earendil-works/pi-tui';
import type { LSPServerInstance } from './instance.ts';
import { errorMessage } from './log.ts';
import {
  getManager,
  initializeManager,
  type LSPServerManager,
  waitForInitialization,
} from './manager.ts';
import type { LspServerState } from './types.ts';

const STATUS_SUBCOMMAND = 'status';
const START_SUBCOMMAND = 'start';
const SUBCOMMANDS = [STATUS_SUBCOMMAND, START_SUBCOMMAND];

export function registerLspCommand(pi: ExtensionAPI): void {
  pi.registerCommand('lsp', {
    description: 'Inspect LSP server status or start/stop configured servers',
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      const trimmed = prefix.trim();
      const matches = SUBCOMMANDS.filter((name) => name.startsWith(trimmed));
      if (matches.length === 0) return null;
      return matches.map((name) => ({ value: name, label: name }));
    },
    handler: async (args, ctx) => {
      const subcommand = args.trim();

      initializeManager(ctx.cwd);
      await waitForInitialization();
      const manager = getManager();

      if (subcommand === START_SUBCOMMAND) {
        await handleStartCommand(manager, ctx);
        return;
      }

      // Empty input defaults to status.
      if (subcommand !== '' && subcommand !== STATUS_SUBCOMMAND) {
        ctx.ui.notify('Usage: /lsp status | /lsp start', 'info');
        return;
      }

      ctx.ui.notify(formatLspStatusDetails(manager), manager ? 'info' : 'warning');
    },
  });
}

type CommandContext = Parameters<Parameters<ExtensionAPI['registerCommand']>[1]['handler']>[1];

async function handleStartCommand(
  manager: LSPServerManager | undefined,
  ctx: CommandContext
): Promise<void> {
  if (!manager) {
    ctx.ui.notify('LSP manager is not initialized.', 'warning');
    return;
  }

  if (ctx.mode !== 'tui') {
    ctx.ui.notify('/lsp start requires TUI mode.', 'error');
    return;
  }

  const servers = Array.from(manager.getAllServers().values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  if (servers.length === 0) {
    ctx.ui.notify('No LSP servers are configured or autodetected for this session.', 'warning');
    return;
  }

  const byName = new Map(servers.map((s) => [s.name, s]));

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const items: SettingItem[] = servers.map((server) => ({
      id: server.name,
      label: server.name,
      currentValue: server.state,
      values: ['running', 'stopped'],
    }));

    const settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id) => {
        const server = byName.get(id);
        // Ignore toggles while a server is mid-transition; refresh resets the
        // row's displayed value back to the real state.
        if (!server || server.state === 'starting' || server.state === 'stopping') {
          refresh();
          return;
        }
        void toggleServer(server, ctx, () => refresh());
      },
      () => done(undefined)
    );

    function refresh(): void {
      for (const item of items) {
        item.currentValue = byName.get(item.id)?.state ?? item.currentValue;
      }
      tui.requestRender();
    }

    const unsubscribe = manager.onServersChanged(refresh);

    const container = new Container();
    container.addChild(
      new Text(
        theme.fg('accent', theme.bold('LSP servers — space to start/stop, esc to close')),
        0,
        0
      )
    );
    container.addChild(settingsList);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        settingsList.handleInput?.(data);
        tui.requestRender();
      },
      dispose: () => unsubscribe(),
    };
  });
}

async function toggleServer(
  server: LSPServerInstance,
  ctx: CommandContext,
  onSettled: () => void
): Promise<void> {
  const stopping = server.state === 'running' || server.state === 'stopping';
  try {
    if (stopping) {
      await server.stop();
    } else {
      await server.start();
    }
  } catch (error) {
    ctx.ui.notify(
      `Failed to ${stopping ? 'stop' : 'start'} LSP server '${server.name}': ${errorMessage(error)}`,
      'error'
    );
  } finally {
    onSettled();
  }
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
