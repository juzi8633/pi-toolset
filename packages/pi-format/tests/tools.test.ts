// ABOUTME: Tests for the explicit `format` tool registration and behavior.
// ABOUTME: Uses an in-memory ExtensionAPI stub.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerFormatTool } from '../src/tools.ts';

let tmpRoot: string;
let agentDir: string;

const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-format-tools-'));
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
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  tools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>;
} {
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];

  const pi = {
    registerTool(definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
      tools.set(definition.name, definition);
    },
    exec: async () => ({ stdout: '', stderr: '', code: 0, killed: false }),
  } as unknown as ExtensionAPI;

  return { pi, calls, tools };
}

function fakeCtx(cwd: string): ExtensionContext {
  return { cwd } as ExtensionContext;
}

describe('registerFormatTool', () => {
  it('registers a tool named format', () => {
    const { pi, tools } = createFakePi();
    registerFormatTool(pi);
    expect(tools.has('format')).toBe(true);
  });

  it('formats a single file successfully', async () => {
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

    const { pi, tools } = createFakePi();
    registerFormatTool(pi);
    const tool = tools.get('format')!;

    const result = await tool.execute(
      'id-1',
      { paths: ['file.ts'] },
      undefined,
      undefined,
      fakeCtx(cwd)
    );
    expect((result as { content: Array<{ text: string }> }).content[0].text).toContain(
      'Formatted 1 file'
    );
  });

  it('throws when paths is empty', async () => {
    const { pi, tools } = createFakePi();
    registerFormatTool(pi);
    const tool = tools.get('format')!;

    expect(
      tool.execute('id-1', { paths: [] }, undefined, undefined, fakeCtx('/project'))
    ).rejects.toThrow();
  });
});
