// ABOUTME: Pi CLI invocation helpers — argument construction, prompt temp-file, and runtime resolution.
// ABOUTME: Resolves the right `pi` binary or current bundle entry and assembles `--mode json -p` argument lists.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import type { AgentConfig } from './agents.ts';
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

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/');
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: 'pi', args };
}

export interface BuildPiArgsOptions {
  tmpPromptPath?: string;
  sessionFile?: string;
  disableAgentTool?: boolean;
  resolvedSkillPaths?: string[];
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
  if (agent.model) args.push('--model', agent.model);
  if (agent.thinking) args.push('--thinking', agent.thinking);
  args.push(...buildToolCliArgs(agent, { disableAgentTool: options.disableAgentTool }));
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
  args.push(`Task: ${task}`);
  return args;
}
