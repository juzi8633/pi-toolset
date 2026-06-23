// ABOUTME: Tests for formatter registry: precedence, overrides, and extension matching.
// ABOUTME: Uses synthetic recipes and user configs without requiring real formatters.

import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFormatterRegistry } from '../src/registry.ts';
import type { FormatterConfig, FormatterRecipe } from '../src/types.ts';

let tmpRoot: string;
let cwd: string;

beforeEach(() => {
  if (!tmpRoot) tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-format-registry-'));
  cwd = mkdtempSync(path.join(tmpRoot, 'case-'));
});

afterAllRegistry();

function afterAllRegistry(): void {
  // bun:test does not export afterAll in all contexts; schedule cleanup via process hook.
  process.on('exit', () => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  });
}

function makeRecipe(name: string, extensions: string[], available: boolean): FormatterRecipe {
  return {
    name,
    extensions,
    async resolve() {
      return available ? { command: [name, '$FILE'] } : false;
    },
  };
}

function makeConfig(name: string, overrides: Partial<FormatterConfig> = {}): FormatterConfig {
  return {
    name,
    disabled: false,
    command: [],
    extensions: [],
    timeoutMs: 30_000,
    source: 'user',
    ...overrides,
  };
}

describe('createFormatterRegistry', () => {
  it('matches built-in recipe by extension', async () => {
    const registry = createFormatterRegistry(cwd, {}, [makeRecipe('builtin', ['.ts'], true)]);
    const result = await registry.getFormatterForFile(path.join(cwd, 'file.ts'));
    expect(result?.formatter.name).toBe('builtin');
    expect(result?.command).toEqual(['builtin', '$FILE']);
  });

  it('returns undefined when no formatter supports the extension', async () => {
    const registry = createFormatterRegistry(cwd, {}, [makeRecipe('builtin', ['.ts'], true)]);
    const result = await registry.getFormatterForFile(path.join(cwd, 'file.rs'));
    expect(result).toBeUndefined();
  });

  it('skips disabled formatters', async () => {
    const registry = createFormatterRegistry(
      cwd,
      { builtin: makeConfig('builtin', { disabled: true, extensions: ['.ts'] }) },
      [makeRecipe('builtin', ['.ts'], true)]
    );
    const result = await registry.getFormatterForFile(path.join(cwd, 'file.ts'));
    expect(result).toBeUndefined();
  });

  it('lets custom user formatter take precedence over built-ins', async () => {
    const registry = createFormatterRegistry(
      cwd,
      {
        custom: makeConfig('custom', {
          command: ['custom', '$FILE'],
          extensions: ['.ts'],
        }),
      },
      [makeRecipe('builtin', ['.ts'], true)]
    );
    const result = await registry.getFormatterForFile(path.join(cwd, 'file.ts'));
    expect(result?.formatter.name).toBe('custom');
    expect(result?.command).toEqual(['custom', '$FILE']);
  });

  it('overrides built-in command while preserving built-in precedence', async () => {
    const registry = createFormatterRegistry(
      cwd,
      {
        builtin: makeConfig('builtin', {
          command: ['overridden', '$FILE'],
          extensions: ['.ts'],
        }),
      },
      [makeRecipe('builtin', ['.ts'], true)]
    );
    const result = await registry.getFormatterForFile(path.join(cwd, 'file.ts'));
    expect(result?.formatter.name).toBe('builtin');
    expect(result?.command).toEqual(['overridden', '$FILE']);
  });

  it('overrides built-in extensions', async () => {
    const registry = createFormatterRegistry(
      cwd,
      {
        builtin: makeConfig('builtin', {
          command: ['builtin', '$FILE'],
          extensions: ['.js'],
        }),
      },
      [makeRecipe('builtin', ['.ts'], true)]
    );
    const tsResult = await registry.getFormatterForFile(path.join(cwd, 'file.ts'));
    expect(tsResult).toBeUndefined();
    const jsResult = await registry.getFormatterForFile(path.join(cwd, 'file.js'));
    expect(jsResult?.formatter.name).toBe('builtin');
  });

  it('falls back to next available formatter when the first is unavailable', async () => {
    const registry = createFormatterRegistry(cwd, {}, [
      makeRecipe('first', ['.ts'], false),
      makeRecipe('second', ['.ts'], true),
    ]);
    const result = await registry.getFormatterForFile(path.join(cwd, 'file.ts'));
    expect(result?.formatter.name).toBe('second');
  });

  it('caches recipe resolution results', async () => {
    let calls = 0;
    const recipe: FormatterRecipe = {
      name: 'cached',
      extensions: ['.ts'],
      async resolve() {
        calls++;
        return { command: ['cached', '$FILE'] };
      },
    };
    const registry = createFormatterRegistry(cwd, {}, [recipe]);
    await registry.getFormatterForFile(path.join(cwd, 'a.ts'));
    await registry.getFormatterForFile(path.join(cwd, 'b.ts'));
    expect(calls).toBe(1);
  });

  it('keeps overridden built-ins at their built-in precedence position', async () => {
    const registry = createFormatterRegistry(
      cwd,
      {
        // Override the lower-priority built-in. It must not jump ahead of the
        // higher-priority built-in.
        second: makeConfig('second', {
          command: ['second-overridden', '$FILE'],
          extensions: ['.ts'],
        }),
      },
      [makeRecipe('first', ['.ts'], true), makeRecipe('second', ['.ts'], true)]
    );
    const result = await registry.getFormatterForFile(path.join(cwd, 'file.ts'));
    expect(result?.formatter.name).toBe('first');
  });

  it('inherits recipe extensions when override omits them', async () => {
    const registry = createFormatterRegistry(
      cwd,
      {
        builtin: makeConfig('builtin', {
          command: ['overridden', '$FILE'],
          extensions: [],
        }),
      },
      [makeRecipe('builtin', ['.ts'], true)]
    );
    const result = await registry.getFormatterForFile(path.join(cwd, 'file.ts'));
    expect(result?.formatter.name).toBe('builtin');
    expect(result?.command).toEqual(['overridden', '$FILE']);
  });
});

describe('getFormatterByName', () => {
  it('returns match for a known formatter that supports the file', async () => {
    const registry = createFormatterRegistry(cwd, {}, [makeRecipe('builtin', ['.ts'], true)]);
    const result = await registry.getFormatterByName('builtin', path.join(cwd, 'file.ts'));
    expect(result.kind).toBe('match');
  });

  it('returns unknown for an unconfigured formatter', async () => {
    const registry = createFormatterRegistry(cwd, {}, []);
    const result = await registry.getFormatterByName('missing', path.join(cwd, 'file.ts'));
    expect(result.kind).toBe('unknown');
  });

  it('returns disabled when the formatter is disabled', async () => {
    const registry = createFormatterRegistry(
      cwd,
      { builtin: makeConfig('builtin', { disabled: true, extensions: ['.ts'] }) },
      [makeRecipe('builtin', ['.ts'], true)]
    );
    const result = await registry.getFormatterByName('builtin', path.join(cwd, 'file.ts'));
    expect(result.kind).toBe('disabled');
  });

  it('returns extension-mismatch for unsupported extension', async () => {
    const registry = createFormatterRegistry(cwd, {}, [makeRecipe('builtin', ['.ts'], true)]);
    const result = await registry.getFormatterByName('builtin', path.join(cwd, 'file.rs'));
    expect(result.kind).toBe('extension-mismatch');
  });

  it('returns unavailable when the recipe cannot resolve', async () => {
    const registry = createFormatterRegistry(cwd, {}, [makeRecipe('builtin', ['.ts'], false)]);
    const result = await registry.getFormatterByName('builtin', path.join(cwd, 'file.ts'));
    expect(result.kind).toBe('unavailable');
  });
});
