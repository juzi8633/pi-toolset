// ABOUTME: Caches skills discovered by the host for name→path resolution, refreshed before agent runs.
// ABOUTME: Lets agent definitions restrict loaded skills by name without re-discovering resources.

import type { BuildSystemPromptOptions, Skill } from '@earendil-works/pi-coding-agent';

let discoveredSkills: Skill[] = [];

export function setDiscoveredSkills(skills: Skill[]): void {
  discoveredSkills = [...skills];
}

/** Refresh the cache from the host's system prompt options (the skills source of truth). */
export function setDiscoveredSkillsFromOptions(options: BuildSystemPromptOptions): void {
  setDiscoveredSkills(options.skills ?? []);
}

export function clearDiscoveredSkills(): void {
  discoveredSkills = [];
}

export function getDiscoveredSkills(): Skill[] {
  return [...discoveredSkills];
}

export interface SkillResolution {
  resolved: string[];
  missing: string[];
}

export function resolveSkillNames(names: string[]): SkillResolution {
  const byName = new Map<string, Skill>();
  for (const skill of discoveredSkills) {
    if (skill.disableModelInvocation) continue;
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  const resolved: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const skill = byName.get(name);
    if (skill) {
      resolved.push(skill.filePath);
    } else {
      missing.push(name);
    }
  }
  return { resolved, missing };
}

export function listAvailableSkillNames(): string[] {
  return discoveredSkills
    .filter((s) => !s.disableModelInvocation)
    .map((s) => s.name)
    .sort((a, b) => a.localeCompare(b));
}
