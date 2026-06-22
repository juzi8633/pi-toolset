// ABOUTME: Tests for config: zero-config recipe fallback, user precedence, and supplementation.
// ABOUTME: Drives behavior via temp HOME (PI_CODING_AGENT_DIR), temp cwd, and synthetic PATH executables.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getAllLspServers } from '../src/config.ts';

const isWindows = process.platform === 'win32';

let tmpRoot: string;
let agentDir: string;
let cwdDir: string;
let pathDir: string;

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

function makeExecutable(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  const filename = isWindows && !name.includes('.') ? `${name}.cmd` : name;
  const full = path.join(dir, filename);
  writeFileSync(full, isWindows ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  if (!isWindows) chmodSync(full, 0o755);
}

function writeAgentSettings(content: string): void {
  const dir = path.join(agentDir, '@balaenis', 'pi-lsp');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.json'), content);
}

function writeProjectSettings(content: string): void {
  const dir = path.join(cwdDir, '.pi', '@balaenis', 'pi-lsp');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'config.json'), content);
}

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-lsp-config-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  if (ORIGINAL_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_PATH;
  if (ORIGINAL_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR;
});

beforeEach(() => {
  // Fresh per-test agent dir, cwd, and PATH dir so settings/PATH state cannot leak.
  const sub = mkdtempSync(path.join(tmpRoot, 'case-'));
  agentDir = path.join(sub, 'agent');
  cwdDir = path.join(sub, 'cwd');
  pathDir = path.join(sub, 'bin');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwdDir, { recursive: true });
  mkdirSync(pathDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PATH = pathDir; // isolate from host installs
});

describe('zero-config: PATH detection drives the server set', () => {
  it('returns no servers when PATH has no recipe binaries', async () => {
    const result = await getAllLspServers(cwdDir);
    expect(result.servers).toEqual({});
  });

  it('returns the typescript recipe when typescript-language-server is on PATH', async () => {
    makeExecutable(pathDir, 'typescript-language-server');
    const { servers } = await getAllLspServers(cwdDir);
    expect(Object.keys(servers)).toEqual(['typescript']);
    expect(servers.typescript!.command).toBe('typescript-language-server');
    expect(servers.typescript!.extensionToLanguage['.tsx']).toBe('typescriptreact');
  });

  it('returns multiple recipes when multiple binaries exist', async () => {
    makeExecutable(pathDir, 'typescript-language-server');
    makeExecutable(pathDir, 'pyright-langserver');
    const { servers } = await getAllLspServers(cwdDir);
    expect(Object.keys(servers).sort()).toEqual(['python', 'typescript']);
  });
});

describe('user config precedence', () => {
  it('user server wins on server name collision', async () => {
    makeExecutable(pathDir, 'typescript-language-server');
    writeProjectSettings(
      JSON.stringify({
        servers: {
          typescript: {
            command: 'typescript-language-server',
            args: ['--stdio', '--my-flag'],
            extensionToLanguage: { '.ts': 'typescript' },
          },
        },
      })
    );
    const { servers } = await getAllLspServers(cwdDir);
    expect(Object.keys(servers)).toEqual(['typescript']);
    expect(servers.typescript!.args).toEqual(['--stdio', '--my-flag']);
    // Recipe was skipped: only the user mapping is present.
    expect(Object.keys(servers.typescript!.extensionToLanguage)).toEqual(['.ts']);
  });

  it('skips a recipe when its extensions overlap user-covered extensions', async () => {
    makeExecutable(pathDir, 'typescript-language-server');
    // User binds .ts to a custom server name; recipe extension overlap must skip the recipe.
    writeProjectSettings(
      JSON.stringify({
        servers: {
          'my-ts': {
            command: 'typescript-language-server',
            args: ['--stdio'],
            extensionToLanguage: { '.ts': 'typescript' },
          },
        },
      })
    );
    const { servers } = await getAllLspServers(cwdDir);
    expect(Object.keys(servers)).toEqual(['my-ts']);
  });

  it('supplements with non-conflicting recipes when user config covers a different language', async () => {
    makeExecutable(pathDir, 'pyright-langserver');
    writeProjectSettings(
      JSON.stringify({
        servers: {
          'my-ts': {
            command: 'typescript-language-server',
            args: ['--stdio'],
            extensionToLanguage: { '.ts': 'typescript' },
          },
        },
      })
    );
    const { servers } = await getAllLspServers(cwdDir);
    expect(Object.keys(servers).sort()).toEqual(['my-ts', 'python']);
    expect(servers.python!.command).toBe('pyright-langserver');
  });

  it('falls back to recipes when all user entries are invalid', async () => {
    makeExecutable(pathDir, 'typescript-language-server');
    writeProjectSettings(
      JSON.stringify({
        servers: {
          broken: { extensionToLanguage: { '.foo': 'foo' } }, // missing command
        },
      })
    );
    const { servers } = await getAllLspServers(cwdDir);
    expect(Object.keys(servers)).toEqual(['typescript']);
  });

  it('project overrides global on server-name collision', async () => {
    writeAgentSettings(
      JSON.stringify({
        servers: {
          mysrv: {
            command: '/abs/path/global-srv',
            extensionToLanguage: { '.x': 'x' },
          },
        },
      })
    );
    writeProjectSettings(
      JSON.stringify({
        servers: {
          mysrv: {
            command: '/abs/path/project-srv',
            extensionToLanguage: { '.x': 'x' },
          },
        },
      })
    );
    const { servers } = await getAllLspServers(cwdDir);
    expect(servers.mysrv!.command).toBe('/abs/path/project-srv');
  });
});

describe('role and startup mode normalization', () => {
  it('defaults omitted role and startupMode to primary/auto for user servers', async () => {
    writeProjectSettings(
      JSON.stringify({
        servers: {
          mysrv: {
            command: '/abs/path/srv',
            extensionToLanguage: { '.x': 'x' },
          },
        },
      })
    );
    const { servers } = await getAllLspServers(cwdDir);
    expect(servers.mysrv!.role).toBe('primary');
    expect(servers.mysrv!.startupMode).toBe('auto');
    expect(servers.mysrv!.conflictGroup).toBe('mysrv');
  });

  it('preserves role: companion and startupMode: manual when provided', async () => {
    writeProjectSettings(
      JSON.stringify({
        servers: {
          tailwind: {
            command: '/abs/path/tailwindcss-language-server',
            extensionToLanguage: { '.ts': 'typescript' },
            role: 'companion',
            startupMode: 'manual',
          },
        },
      })
    );
    const { servers } = await getAllLspServers(cwdDir);
    expect(servers.tailwind!.role).toBe('companion');
    expect(servers.tailwind!.startupMode).toBe('manual');
    // Companion servers without an explicit conflictGroup leave it undefined.
    expect(servers.tailwind!.conflictGroup).toBeUndefined();
  });

  it('rejects invalid role values while keeping valid sibling servers', async () => {
    makeExecutable(pathDir, 'typescript-language-server');
    writeProjectSettings(
      JSON.stringify({
        servers: {
          bad: {
            command: '/abs/path/srv',
            extensionToLanguage: { '.x': 'x' },
            role: 'auxiliary',
          },
          good: {
            command: '/abs/path/srv2',
            extensionToLanguage: { '.y': 'y' },
          },
        },
      })
    );
    const { servers } = await getAllLspServers(cwdDir);
    expect(servers.bad).toBeUndefined();
    expect(servers.good).toBeDefined();
    // Recipe still autodetected for unrelated extension.
    expect(servers.typescript).toBeDefined();
  });

  it('rejects invalid startupMode values while keeping valid sibling servers', async () => {
    writeProjectSettings(
      JSON.stringify({
        servers: {
          bad: {
            command: '/abs/path/srv',
            extensionToLanguage: { '.x': 'x' },
            startupMode: 'eager',
          },
          good: {
            command: '/abs/path/srv2',
            extensionToLanguage: { '.y': 'y' },
          },
        },
      })
    );
    const { servers } = await getAllLspServers(cwdDir);
    expect(servers.bad).toBeUndefined();
    expect(servers.good).toBeDefined();
  });
});

describe('recipe merge rules for role and startup mode', () => {
  it('keeps the typescript recipe when a user eslint companion overlaps .ts', async () => {
    makeExecutable(pathDir, 'typescript-language-server');
    writeProjectSettings(
      JSON.stringify({
        servers: {
          eslint: {
            command: '/abs/path/eslint-lsp',
            extensionToLanguage: { '.ts': 'typescript', '.js': 'javascript' },
            role: 'companion',
          },
        },
      })
    );
    const { servers } = await getAllLspServers(cwdDir);
    expect(Object.keys(servers).sort()).toEqual(['eslint', 'typescript']);
    expect(servers.eslint!.role).toBe('companion');
    expect(servers.typescript!.role).toBe('primary');
  });

  it('keeps the typescript recipe when a manual tailwindcss companion overlaps .ts', async () => {
    makeExecutable(pathDir, 'typescript-language-server');
    writeProjectSettings(
      JSON.stringify({
        servers: {
          tailwindcss: {
            command: '/abs/path/tailwindcss-language-server',
            extensionToLanguage: { '.ts': 'typescript' },
            role: 'companion',
            startupMode: 'manual',
          },
        },
      })
    );
    const { servers } = await getAllLspServers(cwdDir);
    expect(Object.keys(servers).sort()).toEqual(['tailwindcss', 'typescript']);
    expect(servers.tailwindcss!.startupMode).toBe('manual');
    expect(servers.typescript!.startupMode).toBe('auto');
  });

  it('does not let a manual primary user server suppress the auto primary recipe', async () => {
    makeExecutable(pathDir, 'typescript-language-server');
    writeProjectSettings(
      JSON.stringify({
        servers: {
          'opt-in-ts': {
            command: '/abs/path/some-ts-lsp',
            extensionToLanguage: { '.ts': 'typescript' },
            startupMode: 'manual',
          },
        },
      })
    );
    const { servers } = await getAllLspServers(cwdDir);
    expect(Object.keys(servers).sort()).toEqual(['opt-in-ts', 'typescript']);
  });
});
