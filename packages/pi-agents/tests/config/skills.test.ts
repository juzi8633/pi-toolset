// ABOUTME: Tests for the skills cache — host seed, name→path resolution, and disk discovery fallback.
// ABOUTME: Disk fallback uses official PackageManager; isolation via PI_CODING_AGENT_DIR + temp cwd.

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Skill } from '@earendil-works/pi-coding-agent';
import {
  clearDiscoveredSkills,
  ensureDiscoveredSkills,
  getSkillsCacheSource,
  listAvailableSkillNames,
  refreshSkillsFromDisk,
  resolveSkillNames,
  setDiscoveredSkills,
  setDiscoveredSkillsFromOptions,
} from '../../src/config/skills.ts';

/** Mirrors pi's ENV_AGENT_DIR (not re-exported from the package entry). */
const PI_CODING_AGENT_DIR = 'PI_CODING_AGENT_DIR';

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

function writeSkill(root: string, name: string, body = 'instructions'): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const skillPath = path.join(dir, 'SKILL.md');
  writeFileSync(skillPath, `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`);
  return skillPath;
}

describe('skills cache', () => {
  const savedAgentDir = process.env[PI_CODING_AGENT_DIR];
  let tmpRoot: string | null = null;

  afterEach(() => {
    clearDiscoveredSkills();
    if (savedAgentDir === undefined) delete process.env[PI_CODING_AGENT_DIR];
    else process.env[PI_CODING_AGENT_DIR] = savedAgentDir;
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  function isolateAgentDirs(): { agentDir: string; cwd: string } {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-skills-cache-'));
    const agentDir = path.join(tmpRoot, 'agent');
    const cwd = path.join(tmpRoot, 'project');
    mkdirSync(path.join(agentDir, 'skills'), { recursive: true });
    mkdirSync(path.join(cwd, '.pi', 'skills'), { recursive: true });
    process.env[PI_CODING_AGENT_DIR] = agentDir;
    return { agentDir, cwd };
  }

  it('resolves known skill names to their file paths', async () => {
    setDiscoveredSkills([
      makeSkill('librarian', '/abs/librarian/SKILL.md'),
      makeSkill('code-reviewer', '/abs/code-reviewer/SKILL.md'),
    ]);
    const { resolved, missing } = await resolveSkillNames(['librarian', 'code-reviewer']);
    expect(resolved).toEqual(['/abs/librarian/SKILL.md', '/abs/code-reviewer/SKILL.md']);
    expect(missing).toEqual([]);
  });

  it('reports missing skill names', async () => {
    setDiscoveredSkills([makeSkill('librarian', '/abs/librarian/SKILL.md')]);
    const { resolved, missing } = await resolveSkillNames(['librarian', 'ghost']);
    expect(resolved).toEqual(['/abs/librarian/SKILL.md']);
    expect(missing).toEqual(['ghost']);
  });

  it('returns empty results for empty input', async () => {
    setDiscoveredSkills([makeSkill('librarian', '/abs/librarian/SKILL.md')]);
    const { resolved, missing } = await resolveSkillNames([]);
    expect(resolved).toEqual([]);
    expect(missing).toEqual([]);
  });

  it('resolves against an unset empty disk as all missing', async () => {
    const { cwd } = isolateAgentDirs();
    const { resolved, missing } = await resolveSkillNames(['librarian'], cwd);
    expect(resolved).toEqual([]);
    expect(missing).toEqual(['librarian']);
    expect(getSkillsCacheSource()).toBe('disk');
  });

  it('keeps the first skill when names collide', async () => {
    setDiscoveredSkills([
      makeSkill('dup', '/first/dup/SKILL.md'),
      makeSkill('dup', '/second/dup/SKILL.md'),
    ]);
    const { resolved } = await resolveSkillNames(['dup']);
    expect(resolved).toEqual(['/first/dup/SKILL.md']);
  });

  it('listAvailableSkillNames returns cached names sorted', async () => {
    setDiscoveredSkills([makeSkill('b', '/b/SKILL.md'), makeSkill('a', '/a/SKILL.md')]);
    expect(await listAvailableSkillNames()).toEqual(['a', 'b']);
  });

  it('excludes disableModelInvocation skills from resolution and listing', async () => {
    setDiscoveredSkills([
      makeSkill('visible', '/abs/visible/SKILL.md'),
      { ...makeSkill('hidden', '/abs/hidden/SKILL.md'), disableModelInvocation: true },
    ]);
    const { resolved, missing } = await resolveSkillNames(['visible', 'hidden']);
    expect(resolved).toEqual(['/abs/visible/SKILL.md']);
    expect(missing).toEqual(['hidden']);
    expect(await listAvailableSkillNames()).toEqual(['visible']);
  });

  it('setDiscoveredSkillsFromOptions refreshes the cache from system prompt options', async () => {
    setDiscoveredSkillsFromOptions({
      cwd: '/proj',
      skills: [makeSkill('librarian', '/abs/librarian/SKILL.md')],
    });
    expect((await resolveSkillNames(['librarian'])).resolved).toEqual(['/abs/librarian/SKILL.md']);
    expect(getSkillsCacheSource()).toBe('host');
  });

  it('setDiscoveredSkillsFromOptions treats missing skills as empty host seed', async () => {
    setDiscoveredSkills([makeSkill('librarian', '/abs/librarian/SKILL.md')]);
    setDiscoveredSkillsFromOptions({ cwd: '/proj' });
    expect((await resolveSkillNames(['librarian'])).missing).toEqual(['librarian']);
    expect(getSkillsCacheSource()).toBe('host');
  });

  it('disk fallback loads default skill dirs when cache is unset', async () => {
    const { agentDir, cwd } = isolateAgentDirs();
    const skillPath = writeSkill(path.join(agentDir, 'skills'), 'disk-only');
    const { resolved, missing } = await resolveSkillNames(['disk-only'], cwd);
    expect(missing).toEqual([]);
    expect(resolved).toEqual([skillPath]);
    expect(getSkillsCacheSource()).toBe('disk');
    expect(await listAvailableSkillNames(cwd)).toContain('disk-only');
  });

  it('disk fallback loads project .agents/skills', async () => {
    const { cwd } = isolateAgentDirs();
    const skillPath = writeSkill(path.join(cwd, '.agents', 'skills'), 'agents-project');
    const { resolved, missing } = await resolveSkillNames(['agents-project'], cwd);
    expect(missing).toEqual([]);
    expect(resolved).toEqual([skillPath]);
    expect(getSkillsCacheSource()).toBe('disk');
  });

  it('disk fallback loads ancestor .agents/skills up to git root', async () => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-skills-agents-'));
    const agentDir = path.join(tmpRoot, 'agent');
    const nested = path.join(tmpRoot, 'nested');
    mkdirSync(path.join(agentDir, 'skills'), { recursive: true });
    mkdirSync(path.join(nested, '.pi', 'skills'), { recursive: true });
    mkdirSync(path.join(tmpRoot, '.git'), { recursive: true });
    process.env[PI_CODING_AGENT_DIR] = agentDir;

    const skillPath = writeSkill(path.join(tmpRoot, '.agents', 'skills'), 'agents-ancestor');
    const { resolved, missing } = await resolveSkillNames(['agents-ancestor'], nested);
    expect(missing).toEqual([]);
    expect(resolved).toEqual([skillPath]);
  });

  it('disk fallback honors settings skills exclusions and extra paths', async () => {
    const { agentDir, cwd } = isolateAgentDirs();
    writeSkill(path.join(agentDir, 'skills'), 'user-a');
    writeSkill(path.join(cwd, '.pi', 'skills'), 'proj-b');
    const extraPath = writeSkill(path.join(cwd, 'extra-skill'), 'extra');
    // User settings: exclude user-a, add absolute extra skill path.
    writeFileSync(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({ skills: ['!skills/user-a', path.join(cwd, 'extra-skill')] })
    );
    // Project settings: exclude proj-b from auto-discovered .pi/skills.
    writeFileSync(
      path.join(cwd, '.pi', 'settings.json'),
      JSON.stringify({ skills: ['!skills/proj-b'] })
    );

    const names = await listAvailableSkillNames(cwd);
    expect(names).not.toContain('user-a');
    expect(names).not.toContain('proj-b');
    expect(names).toContain('extra');
    expect((await resolveSkillNames(['extra'], cwd)).resolved).toEqual([extraPath]);
  });

  it('host empty seed does not fall back to disk skills', async () => {
    const { agentDir, cwd } = isolateAgentDirs();
    writeSkill(path.join(agentDir, 'skills'), 'on-disk');
    setDiscoveredSkills([]);
    const { resolved, missing } = await resolveSkillNames(['on-disk'], cwd);
    expect(resolved).toEqual([]);
    expect(missing).toEqual(['on-disk']);
    expect(getSkillsCacheSource()).toBe('host');
  });

  it('ensureDiscoveredSkills is a no-op after host seed', async () => {
    const { agentDir, cwd } = isolateAgentDirs();
    writeSkill(path.join(agentDir, 'skills'), 'on-disk');
    setDiscoveredSkills([makeSkill('host-only', '/host/SKILL.md')]);
    await ensureDiscoveredSkills(cwd);
    expect(getSkillsCacheSource()).toBe('host');
    expect((await resolveSkillNames(['host-only'], cwd)).resolved).toEqual(['/host/SKILL.md']);
    expect((await resolveSkillNames(['on-disk'], cwd)).missing).toEqual(['on-disk']);
  });

  it('refreshSkillsFromDisk overwrites host seed when called explicitly', async () => {
    const { agentDir, cwd } = isolateAgentDirs();
    const skillPath = writeSkill(path.join(agentDir, 'skills'), 'forced');
    setDiscoveredSkills([makeSkill('host-only', '/host/SKILL.md')]);
    const skills = await refreshSkillsFromDisk(cwd);
    expect(getSkillsCacheSource()).toBe('disk');
    expect(skills.some((s) => s.name === 'forced' && s.filePath === skillPath)).toBe(true);
    expect((await resolveSkillNames(['forced'], cwd)).resolved).toEqual([skillPath]);
  });
});
