// ABOUTME: Subagent tool entrypoint — registers the `agent` tool and the `before_agent_start` hook.
// ABOUTME: Delegates discovery, orchestration, and rendering to focused modules.

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Static } from '@earendil-works/pi-ai';
import { discoverAgents } from './agents.ts';
import {
  BACKGROUND_MESSAGE_TYPE,
  createBackgroundManager,
  renderBackgroundMessage,
} from './background.ts';
import { renderAgentCatalogue, shouldInjectAgentCatalogue } from './catalogue.ts';
import { registerAgentCommand } from './command.ts';
import { createInteractiveAgentRegistry, INTERACTIVE_LINK_TYPE } from './interactive-agent.ts';
import {
  CONTINUATION_MESSAGE_TYPE,
  createInteractiveRelayCoordinator,
  renderContinuationMessage,
} from './interactive-relay.ts';
import { createInteractiveViewController } from './interactive-view.ts';
import { withAgentToolFailureLogging } from './log.ts';
import { createRunStore } from './run-store.ts';
import { createRunCoordinator } from './run-coordinator.ts';
import { reconcileDeadOwnerUnits } from './resume.ts';
import {
  type AgentRenderState,
  renderCall,
  renderResult,
  stopAllSpinners,
  stopSpinner,
} from './render.ts';
import { SubagentParams } from './schema.ts';
import { setDiscoveredSkillsFromOptions } from './skills.ts';
import { executeAgentTool } from './tool.ts';
import type { SubagentDetails } from './types.ts';

type RawArgs = Record<string, unknown> & { run_in_background?: unknown };

export function normalizeAgentArgs(args: unknown): unknown {
  if (!args || typeof args !== 'object') return args;
  const obj = args as RawArgs;
  if (
    typeof obj.run_in_background === 'boolean' &&
    (obj as { runInBackground?: unknown }).runInBackground === undefined
  ) {
    const { run_in_background, ...rest } = obj;
    return { ...rest, runInBackground: run_in_background };
  }
  return args;
}

/**
 * Register lifecycle hooks so the shared spinner ticker cannot leak past tool or
 * session teardown. Event names match Pi 0.80.6 ExtensionAPI (including /tree).
 * Handlers are additive with other extension listeners on the same event.
 */
export function registerSpinnerLifecycle(pi: ExtensionAPI): void {
  pi.on('tool_execution_end', (event) => {
    if (event.toolName === 'agent') stopSpinner(event.toolCallId);
  });
  pi.on('agent_end', stopAllSpinners);
  pi.on('session_before_compact', stopAllSpinners);
  pi.on('session_before_switch', stopAllSpinners);
  pi.on('session_before_tree', stopAllSpinners);
  pi.on('session_tree', stopAllSpinners);
  pi.on('session_start', stopAllSpinners);
  pi.on('session_shutdown', stopAllSpinners);
}

export default function (pi: ExtensionAPI) {
  const backgroundManager = createBackgroundManager(pi);
  registerSpinnerLifecycle(pi);

  pi.registerMessageRenderer(BACKGROUND_MESSAGE_TYPE, renderBackgroundMessage);
  // Interactive links are custom entries (not model messages). Renderer returns
  // undefined so any accidental custom_message of this type stays invisible.
  pi.registerMessageRenderer(INTERACTIVE_LINK_TYPE, () => undefined);
  // Continuation relays are real custom messages injected into host context.
  pi.registerMessageRenderer(CONTINUATION_MESSAGE_TYPE, renderContinuationMessage);

  const runStore = createRunStore();
  const runCoordinator = createRunCoordinator({ store: runStore });

  // Latest UI context and per-session interactive runtime (recreated on session_start).
  let latestUiCtx: ExtensionContext | undefined;
  let interactiveRegistry = createInteractiveAgentRegistry({ runStore, runCoordinator });
  let viewController = createInteractiveViewController({
    registry: interactiveRegistry,
    isTui: () => latestUiCtx?.mode === 'tui',
    getUi: () => latestUiCtx?.ui,
  });
  // Relay coordinator forwards interrupted/cancelled view continuations to the
  // bound host model. Rebuilt with the registry on every session start/tree swap.
  let relayCoordinator: ReturnType<typeof createInteractiveRelayCoordinator> | undefined;

  function bindHostLinkAppender(): void {
    interactiveRegistry.setHostLinkAppender((link) => {
      pi.appendEntry(INTERACTIVE_LINK_TYPE, link);
    });
  }
  bindHostLinkAppender();

  function bindRelayCoordinator(): void {
    relayCoordinator?.dispose();
    relayCoordinator = createInteractiveRelayCoordinator({
      registry: interactiveRegistry,
      pi,
      getCtx: () => latestUiCtx,
    });
  }
  bindRelayCoordinator();

  function recreateInteractiveRuntime(): void {
    relayCoordinator?.dispose();
    relayCoordinator = undefined;
    interactiveRegistry = createInteractiveAgentRegistry({ runStore, runCoordinator });
    bindHostLinkAppender();
    viewController = createInteractiveViewController({
      registry: interactiveRegistry,
      isTui: () => latestUiCtx?.mode === 'tui',
      getUi: () => latestUiCtx?.ui,
    });
    bindRelayCoordinator();
  }

  // Shutdown order: spinners → background cancel → await idle → dispose relay → dispose registry.
  pi.on('session_shutdown', async () => {
    stopAllSpinners();
    backgroundManager.cancelAll('session_shutdown');
    await backgroundManager.waitForIdle();
    viewController.clearWidget();
    relayCoordinator?.dispose();
    relayCoordinator = undefined;
    await interactiveRegistry.shutdown();
    latestUiCtx = undefined;
  });

  // On session start, recreate interactive state, reconcile dead-owner runs, restore links.
  pi.on('session_start', async (_event, ctx) => {
    latestUiCtx = ctx;
    recreateInteractiveRuntime();

    try {
      const runs = await runStore.listRuns();
      for (const entry of runs) {
        if (!('record' in entry)) continue;
        const record = entry.record;
        if (record.status !== 'running' && record.status !== 'queued') continue;
        if (runCoordinator.isActive(record.runId)) continue;
        const claims = runStore.inspectClaims(record.runId);
        if (!claims.ok) continue;
        const unterminated = claims.claims
          .filter((c) => c.terminal === undefined)
          .sort((a, b) => a.ticket - b.ticket);
        if (unterminated.length === 0) continue;
        const lowest = unterminated[0];
        if (!lowest.owner) continue;
        if (runStore.isPidAlive(lowest.owner.pid)) continue;
        try {
          const claim = await runStore.claimRun(record.runId);
          if (!claim.ok) continue;
          try {
            await runStore.updateRun(record.runId, (r) => {
              r.status = 'interrupted';
              r.updatedAt = Date.now();
              reconcileDeadOwnerUnits(r.units);
            });
            await runStore.appendEvent(record.runId, {
              version: 1,
              event: 'run_interrupted',
              runId: record.runId,
              timestamp: Date.now(),
              origin: 'owner_process_missing',
            });
          } finally {
            await runStore.releaseRun(record.runId, claim.claimId);
          }
        } catch {
          // continue
        }
      }
    } catch {
      // Best-effort reconciliation.
    }

    try {
      interactiveRegistry.restoreActiveBranch(ctx);
      if (ctx.mode === 'tui') {
        viewController.installWidget();
      }
    } catch {
      // Best-effort restore.
    }
  });

  pi.on('session_tree', async (_event, ctx) => {
    latestUiCtx = ctx;
    try {
      interactiveRegistry.restoreActiveBranch(ctx);
      if (ctx.mode === 'tui') {
        viewController.installWidget();
      } else {
        viewController.clearWidget();
      }
    } catch {
      // Best-effort.
    }
  });

  pi.on('before_agent_start', async (event, ctx) => {
    latestUiCtx = ctx;
    setDiscoveredSkillsFromOptions(event.systemPromptOptions);
    const discovery = discoverAgents(ctx.cwd, 'both');
    const safeAgents = discovery.agents.filter((a) => a.source !== 'package');
    if (!shouldInjectAgentCatalogue(process.env, safeAgents)) return;
    const block = renderAgentCatalogue(safeAgents);
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  pi.registerShortcut('ctrl+alt+down', {
    description: 'Open interactive agent navigator',
    handler: async (ctx) => {
      latestUiCtx = ctx;
      if (ctx.mode !== 'tui') return;
      await viewController.openView();
    },
  });

  pi.registerTool<typeof SubagentParams, SubagentDetails, AgentRenderState>({
    name: 'agent',
    label: 'Agent',
    description: `Launch a new agent to handle complex, multi-step tasks, or resume an interrupted durable run. Available agent types are listed in the system prompt.
Provide exactly one entry form:
- \`agent\` + \`task\`: run a single agent.
- \`tasks\`: run multiple {agent, task} items in parallel.
- \`chain\`: run sequential steps with output passing between them, optionally fanning out one step's structured output across parallel workers.
- \`runId\`: resume a durable run from its stored workflow and sessions. Optional \`task\` appends a continuation instruction (required to resume a fully completed run). Do not supply fresh launch fields with \`runId\`.
## When to use
Use when the task matches an agent type, for parallel independent work, or when answering requires reading several files - delegate and keep the conclusion, not the file dumps. For a single-fact lookup, search directly. Once delegated, don't redo the work yourself - wait for the result.
- The agent's final message is returned as the tool result (not shown to the user) - relay what matters.
- Durable run IDs appear on tool results; use \`agent({ runId })\` to resume. List/inspect runs with \`/agent runs\` and \`/agent status <run-id>\`.`,
    promptGuidelines: [
      '!! Use the `explore` agent when you need to search across multiple files or do broad code analysis exploration.',
    ],
    parameters: SubagentParams,
    prepareArguments: (args) => normalizeAgentArgs(args) as Static<typeof SubagentParams>,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      latestUiCtx = ctx;
      return withAgentToolFailureLogging(params, () =>
        executeAgentTool(params, signal, onUpdate, ctx, {
          backgroundManager,
          runStore,
          runCoordinator,
          interactiveRegistry,
        })
      );
    },
    renderCall,
    renderResult,
  });

  registerAgentCommand(pi, {
    backgroundManager,
    runStore,
    runCoordinator,
    // Always resolve the current session registry (recreated on session_start).
    get interactiveRegistry() {
      return interactiveRegistry;
    },
    interactiveView: {
      openView: () => viewController.openView(),
    },
  });
}
