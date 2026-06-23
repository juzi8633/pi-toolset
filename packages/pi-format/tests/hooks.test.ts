// ABOUTME: Tests for automatic post-write/edit formatting hook.
// ABOUTME: Verifies the hook triggers formatting for successful write/edit results.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerFormatHooks } from '../src/hooks.ts';

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-format-hooks-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function createFakePi(): {
  pi: ExtensionAPI;
  handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<unknown>>>;
} {
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => Promise<unknown>>
  >();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    exec: async () => ({ stdout: '', stderr: '', code: 0, killed: false }),
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

function fakeCtx(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    ui: { notify: () => undefined },
  } as unknown as ExtensionContext;
}

function setExec(pi: ExtensionAPI, exec: ExtensionAPI['exec']): void {
  (pi as unknown as { exec: ExtensionAPI['exec'] }).exec = exec;
}

function makeEvent(toolName: 'write' | 'edit', isError: boolean, filePath: string) {
  return {
    toolName,
    isError,
    input: { path: filePath },
    content: [],
    details: {},
  };
}

async function triggerHook(
  handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<unknown>>>,
  event: unknown,
  ctx: ExtensionContext
): Promise<void> {
  for (const handler of handlers.get('tool_result') ?? []) {
    await handler(event, ctx);
  }
}

describe('registerFormatHooks', () => {
  it('formats after a successful write result', async () => {
    const cwd = mkdtempSync(path.join(tmpRoot, 'case-'));
    mkdirSync(path.join(cwd, '.pi', '@balaenis', 'pi-format'), { recursive: true });
    writeFileSync(
      path.join(cwd, '.pi', '@balaenis', 'pi-format', 'config.json'),
      JSON.stringify({
        formatters: {
          custom: { command: ['custom', '$FILE'], extensions: ['.ts'] },
        },
      })
    );
    writeFileSync(path.join(cwd, 'file.ts'), 'x');

    const { pi, handlers } = createFakePi();
    let ran = false;
    setExec(pi, async (command: string) => {
      expect(command).toBe('custom');
      ran = true;
      return { stdout: '', stderr: '', code: 0, killed: false };
    });

    registerFormatHooks(pi);
    await triggerHook(handlers, makeEvent('write', false, 'file.ts'), fakeCtx(cwd));
    expect(ran).toBe(true);
  });

  it('formats after a successful edit result', async () => {
    const cwd = mkdtempSync(path.join(tmpRoot, 'case-'));
    mkdirSync(path.join(cwd, '.pi', '@balaenis', 'pi-format'), { recursive: true });
    writeFileSync(
      path.join(cwd, '.pi', '@balaenis', 'pi-format', 'config.json'),
      JSON.stringify({
        formatters: {
          custom: { command: ['custom', '$FILE'], extensions: ['.ts'] },
        },
      })
    );
    writeFileSync(path.join(cwd, 'file.ts'), 'x');

    const { pi, handlers } = createFakePi();
    let ran = false;
    setExec(pi, async (command: string) => {
      expect(command).toBe('custom');
      ran = true;
      return { stdout: '', stderr: '', code: 0, killed: false };
    });

    registerFormatHooks(pi);
    await triggerHook(handlers, makeEvent('edit', false, 'file.ts'), fakeCtx(cwd));
    expect(ran).toBe(true);
  });

  it('skips failed tool results', async () => {
    const cwd = mkdtempSync(path.join(tmpRoot, 'case-'));
    writeFileSync(path.join(cwd, 'file.ts'), 'x');

    const { pi, handlers } = createFakePi();
    let ran = false;
    setExec(pi, async () => {
      ran = true;
      return { stdout: '', stderr: '', code: 0, killed: false };
    });

    registerFormatHooks(pi);
    await triggerHook(handlers, makeEvent('write', true, 'file.ts'), fakeCtx(cwd));
    expect(ran).toBe(false);
  });

  it('skips when formatOnWrite is false', async () => {
    const cwd = mkdtempSync(path.join(tmpRoot, 'case-'));
    mkdirSync(path.join(cwd, '.pi', '@balaenis', 'pi-format'), { recursive: true });
    writeFileSync(
      path.join(cwd, '.pi', '@balaenis', 'pi-format', 'config.json'),
      JSON.stringify({ formatOnWrite: false })
    );
    writeFileSync(path.join(cwd, 'file.ts'), 'x');

    const { pi, handlers } = createFakePi();
    let ran = false;
    setExec(pi, async () => {
      ran = true;
      return { stdout: '', stderr: '', code: 0, killed: false };
    });

    registerFormatHooks(pi);
    await triggerHook(handlers, makeEvent('write', false, 'file.ts'), fakeCtx(cwd));
    expect(ran).toBe(false);
  });

  it('does not throw on formatter failure', async () => {
    const cwd = mkdtempSync(path.join(tmpRoot, 'case-'));
    mkdirSync(path.join(cwd, '.pi', '@balaenis', 'pi-format'), { recursive: true });
    writeFileSync(
      path.join(cwd, '.pi', '@balaenis', 'pi-format', 'config.json'),
      JSON.stringify({
        formatters: {
          custom: { command: ['custom', '$FILE'], extensions: ['.ts'] },
        },
      })
    );
    writeFileSync(path.join(cwd, 'file.ts'), 'x');

    const { pi, handlers } = createFakePi();
    setExec(pi, async () => ({
      stdout: '',
      stderr: 'fail',
      code: 1,
      killed: false,
    }));

    registerFormatHooks(pi);
    await expect(
      triggerHook(handlers, makeEvent('write', false, 'file.ts'), fakeCtx(cwd))
    ).resolves.toBeUndefined();
  });
});
