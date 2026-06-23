// ABOUTME: Tests for the /format slash command.
// ABOUTME: Uses an in-memory ExtensionAPI and ExtensionCommandContext stub.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { registerFormatCommand } from '../src/command.ts';

let tmpRoot: string;
let agentDir: string;

const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-format-command-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (ORIGINAL_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
});

beforeEach(() => {
  agentDir = mkdtempSync(path.join(tmpRoot, 'agent-'));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

function writeProjectConfig(cwd: string, content: string): void {
  const dir = path.join(cwd, '.pi', '@balaenis', 'pi-format');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.json'), content);
}

function createFakePi(): {
  pi: ExtensionAPI;
  commands: Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>;
} {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
  >();
  const pi = {
    registerCommand(
      name: string,
      options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
    ) {
      commands.set(name, options);
    },
    exec: async () => ({ stdout: '', stderr: '', code: 0, killed: false }),
  } as unknown as ExtensionAPI;
  return { pi, commands };
}

function fakeCtx(cwd: string): ExtensionCommandContext {
  return {
    cwd,
    waitForIdle: async () => undefined,
    ui: {
      notify: () => undefined,
    },
  } as unknown as ExtensionCommandContext;
}

describe('registerFormatCommand', () => {
  it('registers a /format command', () => {
    const { pi, commands } = createFakePi();
    registerFormatCommand(pi);
    expect(commands.has('format')).toBe(true);
  });

  it('formats a single file', async () => {
    const cwd = mkdtempSync(path.join(tmpRoot, 'case-'));
    writeProjectConfig(
      cwd,
      JSON.stringify({
        formatters: {
          custom: { command: ['custom', '$FILE'], extensions: ['.ts'] },
        },
      })
    );
    writeFileSync(path.join(cwd, 'file.ts'), 'const x=1');

    let ran = false;
    const { pi, commands } = createFakePi();
    (pi as unknown as { exec: (command: string) => Promise<unknown> }).exec = async (
      command: string
    ) => {
      expect(command).toBe('custom');
      ran = true;
      return { stdout: '', stderr: '', code: 0, killed: false };
    };

    registerFormatCommand(pi);
    const command = commands.get('format')!;

    await command.handler('file.ts', fakeCtx(cwd));
    expect(ran).toBe(true);
  });

  it('shows usage when no path is provided', async () => {
    const { pi, commands } = createFakePi();
    registerFormatCommand(pi);
    const command = commands.get('format')!;

    await command.handler('', fakeCtx('/project'));
  });

  it('parses --formatter flag', async () => {
    const cwd = mkdtempSync(path.join(tmpRoot, 'case-'));
    writeFileSync(path.join(cwd, 'file.ts'), 'x');
    writeProjectConfig(
      cwd,
      JSON.stringify({
        formatters: {
          custom: { command: ['custom', '$FILE'], extensions: ['.ts'] },
        },
      })
    );

    let ran = false;
    const { pi, commands } = createFakePi();
    (pi as unknown as { exec: (command: string) => Promise<unknown> }).exec = async (
      command: string
    ) => {
      expect(command).toBe('custom');
      ran = true;
      return { stdout: '', stderr: '', code: 0, killed: false };
    };

    registerFormatCommand(pi);
    const command = commands.get('format')!;
    await command.handler('--formatter custom file.ts', fakeCtx(cwd));
    expect(ran).toBe(true);
  });
});
