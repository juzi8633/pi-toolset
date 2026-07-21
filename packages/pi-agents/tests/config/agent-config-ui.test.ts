// ABOUTME: Pure helper tests for /agent config save patch build and project-trust refusal.
// ABOUTME: Avoids full TUI harness; covers session-delta patches and untrusted project save.

import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  prepareDirtySave,
  resolveConfigSaveTarget,
  saveDirtyFields,
} from '../../src/config/agent-config-ui.ts';
import { createSessionAgentConfigStore } from '../../src/config/session-agent-config.ts';

const ENV_KEY = 'PI_CODING_AGENT_DIR';
let originalEnv: string | undefined;
let originalEnvPresent = false;
let userAgentDir: string | null = null;

beforeAll(() => {
  originalEnvPresent = ENV_KEY in process.env;
  originalEnv = process.env[ENV_KEY];
});

afterEach(() => {
  if (userAgentDir) {
    rmSync(userAgentDir, { recursive: true, force: true });
    userAgentDir = null;
  }
  if (originalEnvPresent) {
    process.env[ENV_KEY] = originalEnv ?? '';
  } else {
    delete process.env[ENV_KEY];
  }
});

function setUserAgentDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-ui-user-'));
  process.env[ENV_KEY] = dir;
  userAgentDir = dir;
  return dir;
}

describe('prepareDirtySave', () => {
  it('builds a patch from all session fields, including restored/non-dirty ones', () => {
    const store = createSessionAgentConfigStore();
    store.setField('explore', 'thinking', 'high');
    store.setField('explore', 'model', 'gpt-5');
    store.markSaved('explore', ['model']); // dirty badge cleared; session value remains
    store.setField('explore', 'maxTurns', 3);

    const prepared = prepareDirtySave({
      store,
      agentName: 'explore',
      target: 'user',
      cwd: '/tmp',
      isProjectTrusted: () => true,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.fields.sort()).toEqual(['maxTurns', 'model', 'thinking']);
    expect(prepared.patch).toEqual({ thinking: 'high', model: 'gpt-5', maxTurns: 3 });
  });

  it('saves restored session fields without re-editing after replaceAll', () => {
    const store = createSessionAgentConfigStore();
    store.replaceAll({ explore: { model: 'gpt-5', thinking: 'high' } });

    const prepared = prepareDirtySave({
      store,
      agentName: 'explore',
      target: 'project',
      cwd: '/tmp',
      isProjectTrusted: () => true,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.fields.sort()).toEqual(['model', 'thinking']);
    expect(prepared.patch).toEqual({ model: 'gpt-5', thinking: 'high' });
  });

  it('refuses project save when project is not trusted', () => {
    const store = createSessionAgentConfigStore();
    store.setField('explore', 'thinking', 'high');
    const prepared = prepareDirtySave({
      store,
      agentName: 'explore',
      target: 'project',
      cwd: '/tmp',
      isProjectTrusted: () => false,
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.message).toMatch(/not trusted/i);
  });

  it('reports empty session override set', () => {
    const store = createSessionAgentConfigStore();
    const prepared = prepareDirtySave({
      store,
      agentName: 'explore',
      target: 'user',
      cwd: '/tmp',
      isProjectTrusted: () => true,
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.message).toBe('No session overrides to save');
  });

  it('includes cleared fields as removeFields for disk unset', () => {
    const store = createSessionAgentConfigStore();
    store.setField('explore', 'maxTurns', 10);
    store.setField('explore', 'thinking', 'high');
    store.clearField('explore', 'maxTurns');

    const prepared = prepareDirtySave({
      store,
      agentName: 'explore',
      target: 'user',
      cwd: '/tmp',
      isProjectTrusted: () => true,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.fields).toEqual(['thinking']);
    expect(prepared.removeFields).toEqual(['maxTurns']);
    expect(prepared.patch).toEqual({ thinking: 'high' });
  });

  it('allows save that only removes fields', () => {
    const store = createSessionAgentConfigStore();
    store.setField('explore', 'maxTurns', 10);
    store.clearField('explore', 'maxTurns');

    const prepared = prepareDirtySave({
      store,
      agentName: 'explore',
      target: 'project',
      cwd: '/tmp',
      isProjectTrusted: () => true,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.fields).toEqual([]);
    expect(prepared.removeFields).toEqual(['maxTurns']);
    expect(prepared.patch).toEqual({});
  });
});

describe('resolveConfigSaveTarget', () => {
  it('maps plain ctrl+s (legacy DC3) to user', () => {
    expect(resolveConfigSaveTarget('\x13')).toBe('user');
  });

  it('maps plain ctrl+p (legacy DLE) to project', () => {
    expect(resolveConfigSaveTarget('\x10')).toBe('project');
  });

  it('does not map ctrl+alt+s or ctrl+shift+s to project', () => {
    expect(resolveConfigSaveTarget('\x1b\x13')).toBeNull();
    expect(resolveConfigSaveTarget('\x1b[115;6u')).toBeNull();
  });
});

describe('saveDirtyFields', () => {
  it('writes patch and clears dirty marks without clearing session values', () => {
    setUserAgentDir();
    const store = createSessionAgentConfigStore();
    store.setField('explore', 'thinking', 'high');
    const writes: Array<{
      path: string;
      agent: string;
      patch: unknown;
      removeFields: readonly string[];
    }> = [];
    const result = saveDirtyFields({
      store,
      agentName: 'explore',
      target: 'user',
      cwd: '/tmp',
      isProjectTrusted: () => true,
      writePatchFn: (configPath, agentName, patch, options) => {
        writes.push({
          path: configPath,
          agent: agentName,
          patch,
          removeFields: options?.removeFields ?? [],
        });
      },
    });
    expect(result.ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.agent).toBe('explore');
    expect(writes[0]!.patch).toEqual({ thinking: 'high' });
    expect(writes[0]!.removeFields).toEqual([]);
    expect(store.getDirtyFields('explore')).toEqual([]);
    expect(store.getAgentOverride('explore')).toEqual({ thinking: 'high' });
  });

  it('passes removeFields for unset keys and clears their dirty marks', () => {
    setUserAgentDir();
    const store = createSessionAgentConfigStore();
    store.setField('explore', 'maxTurns', 10);
    store.clearField('explore', 'maxTurns');
    const writes: Array<{ patch: unknown; removeFields: readonly string[] }> = [];
    const result = saveDirtyFields({
      store,
      agentName: 'explore',
      target: 'user',
      cwd: '/tmp',
      isProjectTrusted: () => true,
      writePatchFn: (_path, _agent, patch, options) => {
        writes.push({ patch, removeFields: options?.removeFields ?? [] });
      },
    });
    expect(result.ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.patch).toEqual({});
    expect(writes[0]!.removeFields).toEqual(['maxTurns']);
    expect(store.getDirtyFields('explore')).toEqual([]);
    expect(store.getAgentOverride('explore')).toEqual({});
    expect(store.getUnsetFields('explore')).toEqual(['maxTurns']);
    expect(result.message).toMatch(/unset maxTurns/);
  });
});
