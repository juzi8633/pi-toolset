// ABOUTME: Pi CLI invocation helpers — argument construction, prompt temp-file, and runtime resolution.
// ABOUTME: Resolves the right `pi` binary or current bundle entry and assembles `--mode json -p` argument lists.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import type { AgentConfig } from '../config/agents.ts';
import { buildToolCliArgs } from './security.ts';

export async function writePromptToTempFile(
  agentName: string,
  prompt: string
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pi-subagent-'));
  const safeName = agentName.replace(/[^\w.-]+/g, '_');
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: 'utf-8', mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

const PI_CODING_AGENT_NPM_CLI_ENTRY = '/node_modules/@earendil-works/pi-coding-agent/dist/cli.js';
const PI_CODING_AGENT_NPM_BUNDLE_CLI_ENTRY =
  '/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
const PI_CODING_AGENT_MONOREPO_CLI_ENTRY = '/packages/coding-agent/dist/cli.js';

function isPiCodingAgentScript(scriptPath: string): boolean {
  let resolved = scriptPath;
  try {
    resolved = fs.realpathSync(scriptPath);
  } catch {
    // keep the given path when realpath is unavailable
  }
  const normalized = resolved.replace(/\\/g, '/').toLowerCase();
  return (
    normalized.endsWith(PI_CODING_AGENT_NPM_CLI_ENTRY) ||
    normalized.endsWith(PI_CODING_AGENT_NPM_BUNDLE_CLI_ENTRY) ||
    normalized.endsWith(PI_CODING_AGENT_MONOREPO_CLI_ENTRY)
  );
}

/**
 * Resolve how to spawn a child pi coding-agent.
 * Prefer PI_AGENTS_PI_PATH when set. Default to PATH `pi` unless the host process
 * is already a real pi coding-agent entry (or standalone pi.exe).
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const override = process.env.PI_AGENTS_PI_PATH?.trim() || process.env.PI_BINARY?.trim();
  if (override) {
    return { command: override, args };
  }

  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/');
  if (
    currentScript &&
    !isBunVirtualScript &&
    fs.existsSync(currentScript) &&
    isPiCodingAgentScript(currentScript)
  ) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime && (execName === 'pi' || execName === 'pi.exe')) {
    return { command: process.execPath, args };
  }

  return { command: 'pi', args };
}

/** How the JSON Pi argv prompt is built. Default is a fresh `Task: <task>` invocation. */
export type PiPromptOption =
  | { kind: 'task' }
  | {
      kind: 'session_continuation';
      /** Undelivered continuation tasks for this unit (existing Pi session). */
      undeliveredContinuationTasks?: string[];
      /**
       * Single current-call continuation. Used when `undeliveredContinuationTasks`
       * is absent (simple call sites / tests).
       */
      currentContinuationTask?: string;
    };

export interface BuildPiArgsOptions {
  tmpPromptPath?: string;
  sessionFile?: string;
  disableAgentTool?: boolean;
  resolvedSkillPaths?: string[];
  requireArtifactReader?: boolean;
  artifactReaderExtensionPath?: string;
  /**
   * Prompt construction mode. `task` (default) sends `Task: <task>`.
   * `session_continuation` reuses `--session` and sends the shared resume prompt
   * without resending the original task.
   */
  prompt?: PiPromptOption;
}

/**
 * Append durable continuation instructions to an already-resolved original task.
 * Blank entries are ignored; when none remain, the original task is unchanged.
 */
export function appendContinuationTasks(originalTask: string, continuationTasks: string[]): string {
  let result = originalTask;
  for (const entry of continuationTasks) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    result = `${result}\n\nAdditional instruction for this resumed run:\n${trimmed}`;
  }
  return result;
}

/**
 * Normalize undelivered continuations for an existing-session resume prompt.
 * Prefers an explicit list; falls back to a single current-call task string.
 */
export function resolveUndeliveredContinuations(options: {
  undeliveredContinuationTasks?: string[];
  currentContinuationTask?: string;
}): string[] {
  if (options.undeliveredContinuationTasks !== undefined) {
    return options.undeliveredContinuationTasks.filter((t) => t.trim().length > 0);
  }
  const single = options.currentContinuationTask?.trim();
  return single ? [single] : [];
}

/**
 * Build the Pi session-continuation prompt: the fixed safety instruction plus
 * every undelivered continuation task. Used by JSON CLI and TUI RPC paths.
 */
export function buildSessionContinuationPrompt(
  undeliveredOrCurrent?: string | string[],
  currentContinuationTask?: string
): string {
  let undelivered: string[];
  if (Array.isArray(undeliveredOrCurrent)) {
    undelivered = undeliveredOrCurrent;
  } else if (typeof undeliveredOrCurrent === 'string' && currentContinuationTask === undefined) {
    // Legacy single-string form: treat as one current continuation task.
    undelivered = undeliveredOrCurrent.trim() ? [undeliveredOrCurrent] : [];
  } else {
    undelivered = resolveUndeliveredContinuations({
      undeliveredContinuationTasks: undefined,
      currentContinuationTask: undeliveredOrCurrent ?? currentContinuationTask,
    });
  }
  return appendContinuationTasks(RESUME_CONTINUATION_PROMPT, undelivered);
}

export function buildPiArgs(
  agent: AgentConfig,
  task: string,
  options: BuildPiArgsOptions = {}
): string[] {
  const args: string[] = ['--mode', 'json', '-p'];
  if (options.sessionFile) {
    args.push('--session', options.sessionFile);
  } else {
    args.push('--no-session');
  }
  args.push(...buildSharedPiFlags(agent, options));
  if (options.prompt?.kind === 'session_continuation') {
    const undelivered = resolveUndeliveredContinuations(options.prompt);
    args.push(buildSessionContinuationPrompt(undelivered));
  } else {
    args.push(`Task: ${task}`);
  }
  return args;
}

export interface BuildPiRpcArgsOptions {
  tmpPromptPath?: string;
  sessionFile?: string;
  disableAgentTool?: boolean;
  resolvedSkillPaths?: string[];
  requireArtifactReader?: boolean;
  /** Absolute path to dist/artifact-reader-extension.js when reader is required. */
  artifactReaderExtensionPath?: string;
}

/**
 * Build argv for an interactive Pi child in RPC mode.
 * Same session/model/thinking/tool/skill/system-prompt flags as JSON mode,
 * but without `-p`, an argv prompt, or `--no-session`.
 */
export function buildPiRpcArgs(agent: AgentConfig, options: BuildPiRpcArgsOptions = {}): string[] {
  const args: string[] = ['--mode', 'rpc'];
  if (options.sessionFile) {
    args.push('--session', options.sessionFile);
  }
  // Interactive children always keep discovery off so host extensions do not load twice.
  args.push('--offline');
  args.push(...buildSharedPiFlags(agent, options));
  return args;
}

function buildSharedPiFlags(
  agent: AgentConfig,
  options: {
    tmpPromptPath?: string;
    disableAgentTool?: boolean;
    resolvedSkillPaths?: string[];
    requireArtifactReader?: boolean;
    artifactReaderExtensionPath?: string;
  }
): string[] {
  const args: string[] = [];
  if (agent.model) args.push('--model', agent.model);
  if (agent.thinking) args.push('--thinking', agent.thinking);
  args.push(
    ...buildToolCliArgs(agent, {
      disableAgentTool: options.disableAgentTool,
      requireArtifactReader: options.requireArtifactReader,
    })
  );
  if (options.requireArtifactReader && options.artifactReaderExtensionPath) {
    args.push('--extension', options.artifactReaderExtensionPath);
  }
  if (agent.noContextFiles) args.push('--no-context-files');
  if (options.resolvedSkillPaths && options.resolvedSkillPaths.length > 0) {
    args.push('--no-skills');
    for (const skillPath of options.resolvedSkillPaths) {
      args.push('--skill', skillPath);
    }
  } else if (agent.noSkills) {
    args.push('--no-skills');
  }
  if (options.tmpPromptPath) {
    const promptFlag =
      agent.systemPromptMode === 'replace' ? '--system-prompt' : '--append-system-prompt';
    args.push(promptFlag, options.tmpPromptPath);
  }
  return args;
}

/** Resolve shipped dist/artifact-reader-extension.js next to this package entry. */
export function resolveArtifactReaderExtensionPath(): string {
  return new URL('./artifact-reader-extension.js', import.meta.url).pathname;
}

/**
 * Fixed continuation instruction for resumed native sessions (Pi session files
 * and Grok ACP protocol sessions). Text must remain stable across runtimes.
 */
export const RESUME_CONTINUATION_PROMPT =
  'You are resuming an interrupted task. Inspect the filesystem and git state to understand what was already completed. Treat any unfinished tool call as unconfirmed. Continue the original task to completion, and run validation before finishing.';
