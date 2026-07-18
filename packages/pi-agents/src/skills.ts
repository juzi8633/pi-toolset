// ABOUTME: Caches host-discovered skills for name→path resolution; falls back via official discovery.
// ABOUTME: Disk fallback uses DefaultPackageManager (settings/packages/agents) then loadSkills.

import {
  DefaultPackageManager,
  getAgentDir,
  loadSkills,
  SettingsManager,
  type BuildSystemPromptOptions,
  type Skill,
} from '@earendil-works/pi-coding-agent';

/** How the current cache was populated. */
export type SkillsCacheSource = 'unset' | 'host' | 'disk';

let discoveredSkills: Skill[] = [];
let cacheSource: SkillsCacheSource = 'unset';

export function setDiscoveredSkills(skills: Skill[]): void {
  discoveredSkills = [...skills];
  cacheSource = 'host';
}

/** Refresh the cache from the host's system prompt options (the skills source of truth). */
export function setDiscoveredSkillsFromOptions(options: BuildSystemPromptOptions): void {
  setDiscoveredSkills(options.skills ?? []);
}

export function clearDiscoveredSkills(): void {
  discoveredSkills = [];
  cacheSource = 'unset';
}

export function getDiscoveredSkills(): Skill[] {
  return [...discoveredSkills];
}

export function getSkillsCacheSource(): SkillsCacheSource {
  return cacheSource;
}

/**
 * Discover skills through the same pipeline pi uses for resource loading:
 * settings paths/exclusions, packages (missing sources skipped), and auto dirs
 * including ~/.agents/skills and ancestor .agents/skills.
 * Always overwrites the cache and marks the source as `disk`.
 */
export async function refreshSkillsFromDisk(cwd: string = process.cwd()): Promise<Skill[]> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir,
    settingsManager,
  });
  // Skip missing package installs — disk fallback must stay local and offline-safe.
  const resolved = await packageManager.resolve(async () => 'skip');
  const skillPaths = resolved.skills.filter((entry) => entry.enabled).map((entry) => entry.path);
  const { skills } = loadSkills({
    cwd,
    agentDir,
    skillPaths,
    includeDefaults: false,
  });
  discoveredSkills = [...skills];
  cacheSource = 'disk';
  return [...discoveredSkills];
}

/**
 * Ensure the cache is populated. Host-seeded (including empty) caches are left alone;
 * only an unset cache triggers the official disk discovery fallback.
 */
export async function ensureDiscoveredSkills(cwd: string = process.cwd()): Promise<Skill[]> {
  if (cacheSource !== 'unset') return [...discoveredSkills];
  return refreshSkillsFromDisk(cwd);
}

export interface SkillResolution {
  resolved: string[];
  missing: string[];
}

export async function resolveSkillNames(
  names: string[],
  cwd: string = process.cwd()
): Promise<SkillResolution> {
  await ensureDiscoveredSkills(cwd);
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

export async function listAvailableSkillNames(cwd: string = process.cwd()): Promise<string[]> {
  await ensureDiscoveredSkills(cwd);
  return discoveredSkills
    .filter((s) => !s.disableModelInvocation)
    .map((s) => s.name)
    .sort((a, b) => a.localeCompare(b));
}
