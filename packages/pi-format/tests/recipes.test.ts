// ABOUTME: Tests for built-in formatter recipe detection.
// ABOUTME: Uses temp directories with synthetic executables and project files.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BUILTIN_FORMATTER_RECIPES } from '../src/recipes.ts';
import { findExecutable, findUp, readPackageJson } from '../src/utils.ts';
import type { RecipeContext } from '../src/types.ts';

const isWindows = process.platform === 'win32';

let tmpRoot: string;
let cwd: string;
let pathDir: string;

function makeExecutable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const filename = isWindows && !name.includes('.') ? `${name}.exe` : name;
  const full = path.join(dir, filename);
  writeFileSync(full, isWindows ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  if (!isWindows) chmodSync(full, 0o755);
  return full;
}

function makeContext(overrideCwd?: string): RecipeContext {
  return {
    cwd: overrideCwd ?? cwd,
    findExecutable: (name) => findExecutable(name, pathDir),
    readPackageJson: (dir) => readPackageJson(dir),
    findUp: (names) => findUp(overrideCwd ?? cwd, names),
  };
}

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-format-recipes-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  const sub = mkdtempSync(path.join(tmpRoot, 'case-'));
  cwd = sub;
  pathDir = path.join(sub, 'bin');
  mkdirSync(pathDir, { recursive: true });
});

describe('prettier', () => {
  it('returns false when prettier binary is missing even with dependency', async () => {
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ devDependencies: { prettier: '^3.0.0' } })
    );
    const recipe = BUILTIN_FORMATTER_RECIPES.find((r) => r.name === 'prettier')!;
    const resolved = await recipe.resolve(makeContext());
    expect(resolved).toBe(false);
  });

  it('resolves when prettier binary is on PATH', async () => {
    makeExecutable(pathDir, 'prettier');
    const recipe = BUILTIN_FORMATTER_RECIPES.find((r) => r.name === 'prettier')!;
    const resolved = await recipe.resolve(makeContext());
    expect(resolved).toBeDefined();
    expect(resolved && resolved.command).toEqual(['prettier', '--write', '$FILE']);
  });

  it('returns false when binary is missing', async () => {
    const recipe = BUILTIN_FORMATTER_RECIPES.find((r) => r.name === 'prettier')!;
    const resolved = await recipe.resolve(makeContext());
    expect(resolved).toBe(false);
  });
});

describe('biome', () => {
  it('resolves when biome.json exists and biome binary is on PATH', async () => {
    writeFileSync(path.join(cwd, 'biome.json'), '{}');
    makeExecutable(pathDir, 'biome');
    const recipe = BUILTIN_FORMATTER_RECIPES.find((r) => r.name === 'biome')!;
    const resolved = await recipe.resolve(makeContext());
    expect(resolved && resolved.command).toEqual(['biome', 'format', '--write', '$FILE']);
  });

  it('returns false when biome.json is missing', async () => {
    makeExecutable(pathDir, 'biome');
    const recipe = BUILTIN_FORMATTER_RECIPES.find((r) => r.name === 'biome')!;
    const resolved = await recipe.resolve(makeContext());
    expect(resolved).toBe(false);
  });
});

describe('ruff', () => {
  it('returns false when ruff binary is missing even with config', async () => {
    writeFileSync(path.join(cwd, 'pyproject.toml'), '[tool.ruff]');
    const recipe = BUILTIN_FORMATTER_RECIPES.find((r) => r.name === 'ruff')!;
    const resolved = await recipe.resolve(makeContext());
    expect(resolved).toBe(false);
  });

  it('resolves when ruff binary is on PATH', async () => {
    makeExecutable(pathDir, 'ruff');
    const recipe = BUILTIN_FORMATTER_RECIPES.find((r) => r.name === 'ruff')!;
    const resolved = await recipe.resolve(makeContext());
    expect(resolved).toBeDefined();
    expect(resolved && resolved.command).toEqual(['ruff', 'format', '$FILE']);
  });
});

describe('gofmt', () => {
  it('resolves when gofmt is on PATH', async () => {
    makeExecutable(pathDir, 'gofmt');
    const recipe = BUILTIN_FORMATTER_RECIPES.find((r) => r.name === 'gofmt')!;
    const resolved = await recipe.resolve(makeContext());
    expect(resolved && resolved.command).toEqual(['gofmt', '-w', '$FILE']);
  });

  it('returns false when gofmt is missing', async () => {
    const recipe = BUILTIN_FORMATTER_RECIPES.find((r) => r.name === 'gofmt')!;
    const resolved = await recipe.resolve(makeContext());
    expect(resolved).toBe(false);
  });
});

describe('clang-format', () => {
  it('resolves when .clang-format exists and binary is on PATH', async () => {
    writeFileSync(path.join(cwd, '.clang-format'), 'BasedOnStyle: LLVM');
    makeExecutable(pathDir, 'clang-format');
    const recipe = BUILTIN_FORMATTER_RECIPES.find((r) => r.name === 'clang-format')!;
    const resolved = await recipe.resolve(makeContext());
    expect(resolved && resolved.command).toEqual(['clang-format', '-i', '$FILE']);
  });

  it('returns false when config is missing', async () => {
    makeExecutable(pathDir, 'clang-format');
    const recipe = BUILTIN_FORMATTER_RECIPES.find((r) => r.name === 'clang-format')!;
    const resolved = await recipe.resolve(makeContext());
    expect(resolved).toBe(false);
  });
});

describe('BUILTIN_FORMATTER_RECIPES', () => {
  it('has unique names', () => {
    const names = BUILTIN_FORMATTER_RECIPES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has extensions starting with a dot', () => {
    for (const recipe of BUILTIN_FORMATTER_RECIPES) {
      for (const ext of recipe.extensions) {
        expect(ext.startsWith('.')).toBe(true);
      }
    }
  });
});
