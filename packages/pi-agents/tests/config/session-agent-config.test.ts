// ABOUTME: Tests for session agent config store, dirty tracking, unsets, and branch entry restore.
// ABOUTME: Covers snapshot round-trip, last-entry wins, version ignore, and clear/markSaved.

import { describe, expect, it } from 'bun:test';
import {
  createSessionAgentConfigStore,
  parseSessionEntry,
  PI_AGENTS_AGENT_CONFIG_ENTRY,
  restoreFromBranch,
} from '../../src/config/session-agent-config.ts';

describe('SessionAgentConfigStore', () => {
  it('setField updates override and dirty set; markSaved clears listed fields only', () => {
    const store = createSessionAgentConfigStore();
    store.setField('explore', 'thinking', 'high');
    store.setField('explore', 'model', 'gpt-5');
    expect(store.getAgentOverride('explore')).toEqual({ thinking: 'high', model: 'gpt-5' });
    expect(store.getDirtyFields('explore').sort()).toEqual(['model', 'thinking']);

    store.markSaved('explore', ['thinking']);
    expect(store.getDirtyFields('explore')).toEqual(['model']);
    expect(store.getAgentOverride('explore')).toEqual({ thinking: 'high', model: 'gpt-5' });
  });

  it('clearField removes key, records unset, and marks dirty', () => {
    const store = createSessionAgentConfigStore({
      explore: { thinking: 'high', model: 'm' },
    });
    store.clearField('explore', 'thinking');
    expect(store.getAgentOverride('explore')).toEqual({ model: 'm' });
    expect(store.getUnsetFields('explore')).toEqual(['thinking']);
    expect(store.getDirtyFields('explore').sort()).toEqual(['model', 'thinking']);
  });

  it('clearField on disk-only field still records unset for save removal', () => {
    const store = createSessionAgentConfigStore();
    store.clearField('explore', 'maxTurns');
    expect(store.getAgentOverride('explore')).toEqual({});
    expect(store.getUnsetFields('explore')).toEqual(['maxTurns']);
    expect(store.getDirtyFields('explore')).toEqual(['maxTurns']);
  });

  it('setField with empty string clears the field and records unset', () => {
    const store = createSessionAgentConfigStore({ explore: { model: 'm' } });
    store.setField('explore', 'model', '');
    expect(store.getAgentOverride('explore')).toEqual({});
    expect(store.getUnsetFields('explore')).toEqual(['model']);
    expect(store.getDirtyFields('explore')).toEqual(['model']);
  });

  it('setField after unset clears the unset tombstone', () => {
    const store = createSessionAgentConfigStore();
    store.clearField('explore', 'maxTurns');
    store.setField('explore', 'maxTurns', 5);
    expect(store.getUnsetFields('explore')).toEqual([]);
    expect(store.getAgentOverride('explore')).toEqual({ maxTurns: 5 });
  });

  it('rejects invalid values without mutating state', () => {
    const store = createSessionAgentConfigStore({ explore: { isolation: 'none' } });
    expect(() => store.setField('explore', 'isolation', 'docker')).toThrow(/Invalid value/);
    expect(store.getAgentOverride('explore')).toEqual({ isolation: 'none' });
    expect(store.getDirtyFields('explore')).toEqual(['isolation']);
  });

  it('replaceAll loads agents and marks restored fields dirty', () => {
    const store = createSessionAgentConfigStore();
    store.setField('explore', 'thinking', 'high');
    store.replaceAll({ reviewer: { model: 'x' } }, { explore: ['maxTurns'] });
    expect(store.getAgentOverride('explore')).toEqual({});
    expect(store.getAgentOverride('reviewer')).toEqual({ model: 'x' });
    expect(store.getDirtyFields('explore')).toEqual(['maxTurns']);
    expect(store.getUnsetFields('explore')).toEqual(['maxTurns']);
    expect(store.getDirtyFields('reviewer')).toEqual(['model']);
    expect(store.getSessionFields('reviewer')).toEqual(['model']);
  });

  it('snapshot round-trips overrides and unsets through replaceAll', () => {
    const store = createSessionAgentConfigStore();
    store.setField('explore', 'thinking', 'high');
    store.clearField('explore', 'maxTurns');
    store.setField('reviewer', 'tools', 'read, grep');
    const snap = store.snapshot();
    expect(snap.version).toBe(1);
    expect(snap.unsets?.explore).toEqual(['maxTurns']);

    const restored = createSessionAgentConfigStore();
    restored.replaceAll(snap.agents, snap.unsets);
    expect(restored.getAgentOverride('explore')).toEqual({ thinking: 'high' });
    expect(restored.getUnsetFields('explore')).toEqual(['maxTurns']);
    expect(restored.getAgentOverride('reviewer')).toEqual({ tools: ['read', 'grep'] });
  });
});

describe('parseSessionEntry / restoreFromBranch', () => {
  it('parses version 1 agents and ignores invalid keys', () => {
    const entry = parseSessionEntry({
      version: 1,
      agents: {
        explore: { thinking: 'high', maxTurns: -1 },
        '': { model: 'x' },
        bad: 'nope',
      },
      unsets: {
        explore: ['maxTurns', 'not-a-field'],
        other: 'nope',
      },
    });
    expect(entry.agents.explore).toEqual({ thinking: 'high' });
    expect(entry.agents['']).toBeUndefined();
    expect(entry.agents.bad).toBeUndefined();
    expect(entry.unsets?.explore).toEqual(['maxTurns']);
  });

  it('ignores unknown versions and malformed payloads', () => {
    expect(
      Object.keys(parseSessionEntry({ version: 2, agents: { a: { model: 'x' } } }).agents)
    ).toEqual([]);
    expect(Object.keys(parseSessionEntry(null).agents)).toEqual([]);
    expect(Object.keys(parseSessionEntry({ version: 1 }).agents)).toEqual([]);
  });

  it('restoreFromBranch takes the last matching custom entry', () => {
    const ctx = {
      sessionManager: {
        getBranch: () => [
          {
            type: 'custom',
            customType: PI_AGENTS_AGENT_CONFIG_ENTRY,
            data: { version: 1, agents: { explore: { thinking: 'low' } } },
          },
          { type: 'message' },
          {
            type: 'custom',
            customType: 'other',
            data: { version: 1, agents: { explore: { thinking: 'ignored' } } },
          },
          {
            type: 'custom',
            customType: PI_AGENTS_AGENT_CONFIG_ENTRY,
            data: {
              version: 1,
              agents: { explore: { thinking: 'high' } },
              unsets: { explore: ['maxTurns'] },
            },
          },
        ],
      },
    };
    const entry = restoreFromBranch(ctx as never);
    expect(entry.agents.explore).toEqual({ thinking: 'high' });
    expect(entry.unsets?.explore).toEqual(['maxTurns']);
  });
});
