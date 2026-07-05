// ABOUTME: Tests for the skills cache — name→path resolution and missing-name handling.
// ABOUTME: Uses setDiscoveredSkills to inject mock skills without touching the filesystem.

import { afterEach, describe, expect, it } from 'bun:test';
import type { Skill } from '@earendil-works/pi-coding-agent';
import {
  clearDiscoveredSkills,
  listAvailableSkillNames,
  resolveSkillNames,
  setDiscoveredSkills,
} from '../src/skills.ts';

function makeSkill(name: string, filePath: string): Skill {
  return {
    name,
    description: `${name} skill`,
    filePath,
    baseDir: filePath.replace(/\/[^/]+$/, ''),
    sourceInfo: { path: filePath, source: 'user', scope: 'user', origin: 'top-level' },
    disableModelInvocation: false,
  };
}

describe('skills cache', () => {
  afterEach(() => {
    clearDiscoveredSkills();
  });

  it('resolves known skill names to their file paths', () => {
    setDiscoveredSkills([
      makeSkill('librarian', '/abs/librarian/SKILL.md'),
      makeSkill('code-reviewer', '/abs/code-reviewer/SKILL.md'),
    ]);
    const { resolved, missing } = resolveSkillNames(['librarian', 'code-reviewer']);
    expect(resolved).toEqual(['/abs/librarian/SKILL.md', '/abs/code-reviewer/SKILL.md']);
    expect(missing).toEqual([]);
  });

  it('reports missing skill names', () => {
    setDiscoveredSkills([makeSkill('librarian', '/abs/librarian/SKILL.md')]);
    const { resolved, missing } = resolveSkillNames(['librarian', 'ghost']);
    expect(resolved).toEqual(['/abs/librarian/SKILL.md']);
    expect(missing).toEqual(['ghost']);
  });

  it('returns empty results for empty input', () => {
    setDiscoveredSkills([makeSkill('librarian', '/abs/librarian/SKILL.md')]);
    const { resolved, missing } = resolveSkillNames([]);
    expect(resolved).toEqual([]);
    expect(missing).toEqual([]);
  });

  it('resolves against an empty cache as all missing', () => {
    const { resolved, missing } = resolveSkillNames(['librarian']);
    expect(resolved).toEqual([]);
    expect(missing).toEqual(['librarian']);
  });

  it('keeps the first skill when names collide', () => {
    setDiscoveredSkills([
      makeSkill('dup', '/first/dup/SKILL.md'),
      makeSkill('dup', '/second/dup/SKILL.md'),
    ]);
    const { resolved } = resolveSkillNames(['dup']);
    expect(resolved).toEqual(['/first/dup/SKILL.md']);
  });

  it('listAvailableSkillNames returns cached names sorted', () => {
    setDiscoveredSkills([makeSkill('b', '/b/SKILL.md'), makeSkill('a', '/a/SKILL.md')]);
    expect(listAvailableSkillNames()).toEqual(['a', 'b']);
  });

  it('excludes disableModelInvocation skills from resolution and listing', () => {
    setDiscoveredSkills([
      makeSkill('visible', '/abs/visible/SKILL.md'),
      { ...makeSkill('hidden', '/abs/hidden/SKILL.md'), disableModelInvocation: true },
    ]);
    const { resolved, missing } = resolveSkillNames(['visible', 'hidden']);
    expect(resolved).toEqual(['/abs/visible/SKILL.md']);
    expect(missing).toEqual(['hidden']);
    expect(listAvailableSkillNames()).toEqual(['visible']);
  });
});
