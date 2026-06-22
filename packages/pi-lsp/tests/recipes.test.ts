// ABOUTME: Tests for recipe registry: PATH executable discovery and extension matching.
// ABOUTME: Uses temp directories with synthetic executables to avoid relying on host LSP installs.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BUILTIN_RECIPES,
  findExecutable,
  getDetectedRecipeServers,
  getRecipeHintForExtension,
  recipeCoversExtension,
} from '../src/recipes.ts';

const isWindows = process.platform === 'win32';

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-lsp-recipes-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeExecutable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const filename = isWindows && !name.includes('.') ? `${name}.cmd` : name;
  const full = path.join(dir, filename);
  writeFileSync(full, isWindows ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  if (!isWindows) chmodSync(full, 0o755);
  return full;
}

function makePlainFile(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const full = path.join(dir, name);
  writeFileSync(full, 'not executable');
  return full;
}

describe('findExecutable', () => {
  let pathDir: string;

  beforeAll(() => {
    pathDir = path.join(tmpRoot, 'bin-find');
    makeExecutable(pathDir, 'fake-lsp');
  });

  it('returns absolute path when command exists on PATH', () => {
    const found = findExecutable('fake-lsp', pathDir);
    expect(found).toBeDefined();
    expect(found!.includes('fake-lsp')).toBe(true);
  });

  it('returns undefined when command is missing on PATH', () => {
    const found = findExecutable('does-not-exist-zz', pathDir);
    expect(found).toBeUndefined();
  });

  it('returns undefined for empty PATH', () => {
    expect(findExecutable('fake-lsp', '')).toBeUndefined();
    expect(findExecutable('fake-lsp', undefined)).toBeUndefined();
  });

  it('searches multiple PATH entries', () => {
    const dirA = path.join(tmpRoot, 'multi-a');
    const dirB = path.join(tmpRoot, 'multi-b');
    makeExecutable(dirB, 'tool-b');
    mkdirSync(dirA, { recursive: true });
    const sep = isWindows ? ';' : ':';
    const found = findExecutable('tool-b', `${dirA}${sep}${dirB}`);
    expect(found).toBeDefined();
    expect(found!.includes('tool-b')).toBe(true);
  });

  it('resolves absolute path when given directly', () => {
    const exe = makeExecutable(path.join(tmpRoot, 'abs'), 'direct');
    const found = findExecutable(exe, '');
    expect(found).toBe(exe);
  });

  if (!isWindows) {
    it('rejects non-executable files on POSIX', () => {
      const dir = path.join(tmpRoot, 'noexec');
      makePlainFile(dir, 'not-runnable');
      expect(findExecutable('not-runnable', dir)).toBeUndefined();
    });
  }
});

describe('getDetectedRecipeServers', () => {
  it('returns empty record when no recipe binaries are on PATH', () => {
    const empty = path.join(tmpRoot, 'empty');
    mkdirSync(empty, { recursive: true });
    const detected = getDetectedRecipeServers(empty);
    expect(detected).toEqual({});
  });

  it('detects only recipes whose command is on PATH', () => {
    const dir = path.join(tmpRoot, 'partial');
    makeExecutable(dir, 'typescript-language-server');
    const detected = getDetectedRecipeServers(dir);
    expect(Object.keys(detected)).toEqual(['typescript']);
    const ts = detected.typescript!;
    expect(ts.command).toBe('typescript-language-server');
    expect(ts.args).toEqual(['--stdio']);
    expect(ts.extensionToLanguage['.ts']).toBe('typescript');
    expect(ts.transport).toBe('stdio');
    expect(ts.role).toBe('primary');
    expect(ts.startupMode).toBe('auto');
    expect(ts.conflictGroup).toBe('typescript');
  });

  it('detects multiple recipes when several binaries exist', () => {
    const dir = path.join(tmpRoot, 'multi');
    makeExecutable(dir, 'typescript-language-server');
    makeExecutable(dir, 'pyright-langserver');
    makeExecutable(dir, 'gopls');
    makeExecutable(dir, 'kotlin-lsp');
    makeExecutable(dir, 'lua-language-server');
    makeExecutable(dir, 'clangd');
    makeExecutable(dir, 'bash-language-server');
    makeExecutable(dir, 'vscode-json-language-server');
    makeExecutable(dir, 'yaml-language-server');
    makeExecutable(dir, 'vscode-html-language-server');
    makeExecutable(dir, 'vscode-css-language-server');
    makeExecutable(dir, 'vue-language-server');
    makeExecutable(dir, 'vscode-eslint-language-server');
    const detected = getDetectedRecipeServers(dir);
    const names = Object.keys(detected).sort();
    expect(names).toEqual([
      'bash',
      'clangd',
      'css',
      'eslint',
      'go',
      'html',
      'json',
      'kotlin',
      'lua',
      'python',
      'typescript',
      'vue',
      'yaml',
    ]);
    expect(detected.eslint!.role).toBe('companion');
    expect(detected.eslint!.conflictGroup).toBeUndefined();
    expect(detected.eslint!.extensionToLanguage['.ts']).toBe('typescript');
    expect(detected.eslint!.extensionToLanguage['.vue']).toBe('vue');
    const eslintSettings = detected.eslint!.settings as Record<string, unknown>;
    expect(eslintSettings).toBeDefined();
    expect(eslintSettings.validate).toBe('on');
    expect(eslintSettings.packageManager).toBe('npm');
    expect(eslintSettings.useFlatConfig).toBe(true);
    expect(eslintSettings.workingDirectory).toEqual({ mode: 'location' });
    expect(detected.typescript!.role).toBe('primary');
    expect(detected.typescript!.conflictGroup).toBe('typescript');
    expect(detected.python!.extensionToLanguage['.py']).toBe('python');
    expect(detected.go!.extensionToLanguage['.go']).toBe('go');
    expect(detected.kotlin!.extensionToLanguage['.kt']).toBe('kotlin');
    expect(detected.kotlin!.args).toEqual(['--stdio']);
    expect(detected.lua!.extensionToLanguage['.lua']).toBe('lua');
    expect(detected.clangd!.extensionToLanguage['.cpp']).toBe('cpp');
    expect(detected.bash!.args).toEqual(['start']);
    expect(detected.json!.extensionToLanguage['.jsonc']).toBe('jsonc');
    expect(detected.css!.extensionToLanguage['.scss']).toBe('scss');
    expect(detected.vue!.extensionToLanguage['.vue']).toBe('vue');
    expect(detected.vue!.args).toEqual(['--stdio']);
  });
});

describe('recipe hint helpers', () => {
  it('returns the install hint for a known extension', () => {
    const hint = getRecipeHintForExtension('.py');
    expect(hint).toBeDefined();
    expect(hint!.toLowerCase().includes('pyright')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(getRecipeHintForExtension('.TS')).toBeDefined();
  });

  it('returns undefined for unknown extensions', () => {
    expect(getRecipeHintForExtension('.unknown-ext')).toBeUndefined();
    expect(getRecipeHintForExtension('')).toBeUndefined();
  });

  it('returns the primary recipe hint for .vue, not the ESLint companion', () => {
    const hint = getRecipeHintForExtension('.vue');
    expect(hint).toBeDefined();
    expect(hint!.toLowerCase().includes('@vue/language-server')).toBe(true);
    expect(hint!.toLowerCase().includes('eslint')).toBe(false);
  });

  it('recipeCoversExtension reports coverage', () => {
    expect(recipeCoversExtension('.go')).toBe(true);
    expect(recipeCoversExtension('.lua')).toBe(true);
    expect(recipeCoversExtension('.cpp')).toBe(true);
    expect(recipeCoversExtension('.sh')).toBe(true);
    expect(recipeCoversExtension('.yaml')).toBe(true);
    expect(recipeCoversExtension('.html')).toBe(true);
    expect(recipeCoversExtension('.css')).toBe(true);
    expect(recipeCoversExtension('.vue')).toBe(true);
    expect(recipeCoversExtension('.mjs')).toBe(true);
    expect(recipeCoversExtension('.foo')).toBe(false);
  });
});

describe('BUILTIN_RECIPES integrity', () => {
  it('has unique server names', () => {
    const names = BUILTIN_RECIPES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every extension starts with a dot', () => {
    for (const recipe of BUILTIN_RECIPES) {
      for (const ext of Object.keys(recipe.extensionToLanguage)) {
        expect(ext.startsWith('.')).toBe(true);
      }
    }
  });
});

afterEach(() => {
  // Each describe block uses its own subdirectory; nothing per-test to clean.
});
