// ABOUTME: Regression tests that shipped prompts/docs only name bundled agents that exist on disk.
// ABOUTME: Catches rename drift (e.g. prompts still say worker after agents/general.md) and pack manifest.

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAgents } from '../../src/config/agents.ts';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const agentsDir = path.join(packageRoot, 'agents');
const promptsDir = path.join(packageRoot, 'prompts');
const docsDir = path.join(packageRoot, 'docs');
const readmePath = path.join(packageRoot, 'README.md');

/** Agent id tokens: lowercase identifier, no path/template noise. */
const AGENT_ID = '[a-z][a-z0-9_-]*';

/**
 * Explicit agent-name mentions in shipped markdown (prompts, README, package docs).
 * Deliberately avoids bare words (e.g. "fanout worker") and template placeholders ({item}, $@).
 * Unquoted "the X agent" is only accepted after use/invoke to skip prose like "the parent agent".
 */
const EXPLICIT_AGENT_PATTERNS: RegExp[] = [
  // use/invoke the "explore" agent | use/invoke the `general` agent | use/invoke the general agent
  new RegExp(
    String.raw`\b(?:use|invoke)\s+the\s+(?:["'\`](${AGENT_ID})["'\`]|(${AGENT_ID}))\s+agent\b`,
    'gi'
  ),
  // the "general" agent / the `general` agent (quoted/backticked only)
  new RegExp(String.raw`\bthe\s+["'\`](${AGENT_ID})["'\`]\s+agent\b`, 'gi'),
  // "agent": "general" / 'agent': 'general'
  new RegExp(String.raw`["']agent["']\s*:\s*["'](${AGENT_ID})["']`, 'gi'),
  // YAML-ish: agent: general
  new RegExp(String.raw`\bagent:\s+(${AGENT_ID})\b`, 'gi'),
  // Markdown table / catalogue rows that name bundled agents as a first column token
  // e.g. | `general` | General-purpose |
  new RegExp(String.raw`\|\s*[\`']?(${AGENT_ID})[\`']?\s*\|\s*[^|\n]+\|`, 'gi'),
  // Slash-workflow phrasing: /implement-and-review general agent
  new RegExp(
    String.raw`/(?:implement-and-review|implement|explore-and-plan)\s+(?:["'\`](${AGENT_ID})["'\`]|(${AGENT_ID}))\s+agent\b`,
    'gi'
  ),
];

function listMarkdownFiles(dir: string, recursive = false): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip plans/draft/analysis noise; ship-facing docs only at docs/*.md and immediate children we care about.
      if (recursive && !['plans', 'draft', 'analysis'].includes(name)) {
        out.push(...listMarkdownFiles(full, true));
      }
      continue;
    }
    if (name.endsWith('.md')) out.push(full);
  }
  return out.sort();
}

/** Shipped docs that must not drift agent names (top-level package docs only). */
function shippedDocFiles(): string[] {
  const topLevel = listMarkdownFiles(docsDir, false);
  const files = [...topLevel];
  if (statSync(readmePath, { throwIfNoEntry: false })?.isFile()) files.push(readmePath);
  return files.sort();
}

function extractExplicitAgentNames(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of EXPLICIT_AGENT_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1] ?? match[2];
      // Skip template-looking tokens (should already be excluded by AGENT_ID).
      if (!name || name.includes('{') || name.includes('$')) continue;
      // Table rows can match non-agent first columns; only keep known-looking agent ids later.
      found.add(name);
    }
  }
  return [...found].sort();
}

function bundledAgentNamesFromFiles(): string[] {
  const names: string[] = [];
  for (const filePath of listMarkdownFiles(agentsDir)) {
    const content = readFileSync(filePath, 'utf-8');
    const nameMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!nameMatch) continue;
    const fmName = nameMatch[1].match(/^name:\s*(\S+)\s*$/m);
    if (fmName) names.push(fmName[1]);
  }
  return names.sort();
}

/** Collect explicit agent refs from a list of markdown files, filtered to plausible agents. */
function collectExplicitRefs(
  files: string[],
  bundled: Set<string>
): { referenced: Set<string>; missing: Array<{ file: string; agent: string }> } {
  const referenced = new Set<string>();
  const missing: Array<{ file: string; agent: string }> = [];
  // Table pattern is noisy; only treat tokens as agent refs when they match a known agent
  // OR appear via the stricter use/invoke/YAML patterns (already constrained).
  for (const filePath of files) {
    const text = readFileSync(filePath, 'utf-8');
    for (const name of extractExplicitAgentNames(text)) {
      // Ignore table false-positives that are not real agent ids (Mode, Field, …).
      const looksLikeAgent =
        bundled.has(name) ||
        name === 'worker' ||
        name === 'debugger' ||
        name === 'general' ||
        name === 'explore' ||
        name === 'planner' ||
        name === 'reviewer';
      if (!looksLikeAgent) continue;
      referenced.add(name);
      if (!bundled.has(name)) {
        missing.push({ file: path.relative(packageRoot, filePath), agent: name });
      }
    }
  }
  return { referenced, missing };
}

/**
 * Parse `npm pack --dry-run` / `bun pm pack --dry-run` style file listings.
 * Returns relative paths that would be included in the tarball.
 */
export function parsePackDryRunListing(stdout: string): string[] {
  const files: string[] = [];
  for (const line of stdout.split('\n')) {
    // npm: "npm notice 123B agents/general.md"
    // bun: may print path alone or with size prefix
    const npmNotice = line.match(/npm notice\s+\S+\s+(.+\S)\s*$/);
    if (npmNotice) {
      files.push(npmNotice[1].replace(/\\/g, '/'));
      continue;
    }
    const bare = line.match(/^\s*((?:agents|prompts|dist)\/\S+)\s*$/);
    if (bare) files.push(bare[1].replace(/\\/g, '/'));
  }
  return files;
}

describe('bundled agents on disk', () => {
  it('ships debugger.md and general.md, not worker.md', () => {
    const files = readdirSync(agentsDir)
      .filter((n) => n.endsWith('.md'))
      .sort();
    expect(files).toContain('debugger.md');
    expect(files).toContain('general.md');
    expect(files).not.toContain('worker.md');
  });

  it('frontmatter names match discoverAgents builtin catalogue', () => {
    const fromFiles = bundledAgentNamesFromFiles();
    expect(fromFiles).toContain('debugger');
    expect(fromFiles).toContain('general');
    expect(fromFiles).not.toContain('worker');

    // Isolated cwd so monorepo project agents cannot override builtins.
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'pi-agents-builtin-'));
    try {
      const { agents } = discoverAgents(cwd, 'project');
      const builtins = agents
        .filter((a) => a.source === 'builtin')
        .map((a) => a.name)
        .sort();
      expect(builtins).toEqual(fromFiles);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('shipped prompt agent name references', () => {
  it('every explicitly named agent exists as a bundled agent', () => {
    const bundled = new Set(bundledAgentNamesFromFiles());
    expect(bundled.size).toBeGreaterThan(0);

    const promptFiles = listMarkdownFiles(promptsDir);
    expect(promptFiles.length).toBeGreaterThan(0);

    const { referenced, missing } = collectExplicitRefs(promptFiles, bundled);

    // Sanity: workflows must mention real agents (catches empty extractor regressions).
    expect(
      referenced.has('explore') || referenced.has('planner') || referenced.has('general')
    ).toBe(true);

    expect(missing).toEqual([]);
  });

  it('does not still name the removed worker agent in explicit agent slots', () => {
    for (const filePath of listMarkdownFiles(promptsDir)) {
      const text = readFileSync(filePath, 'utf-8');
      const names = extractExplicitAgentNames(text);
      expect(names).not.toContain('worker');
    }
  });
});

describe('shipped README/docs agent name references', () => {
  it('explicit agent refs in README and package docs resolve to bundled agents', () => {
    const bundled = new Set(bundledAgentNamesFromFiles());
    const files = shippedDocFiles();
    expect(files.length).toBeGreaterThan(0);

    const { missing } = collectExplicitRefs(files, bundled);
    // worker must not appear as an explicit agent reference in ship docs.
    expect(missing.filter((m) => m.agent === 'worker')).toEqual([]);
    expect(missing).toEqual([]);
  });
});

describe('pack manifest includes debugger and general, not worker', () => {
  it('npm/bun pack dry-run lists debugger/general agents and omits worker', () => {
    // Prefer npm pack --dry-run (stable listing); fall back to parsing package files field + disk.
    const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: packageRoot,
      encoding: 'utf-8',
      env: { ...process.env, npm_config_loglevel: 'notice' },
    });

    let listed: string[] = [];
    if (result.status === 0 && result.stdout) {
      // --json prints an array of package contents in modern npm.
      try {
        const parsed = JSON.parse(result.stdout) as Array<{ files?: Array<{ path: string }> }>;
        if (Array.isArray(parsed) && parsed[0]?.files) {
          listed = parsed[0].files.map((f) => f.path.replace(/\\/g, '/'));
        }
      } catch {
        listed = parsePackDryRunListing(result.stdout + (result.stderr ?? ''));
      }
      if (listed.length === 0) {
        listed = parsePackDryRunListing(result.stdout + (result.stderr ?? ''));
      }
    }

    if (listed.length === 0) {
      // Fallback without network/registry: honor package.json "files" + on-disk agents.
      const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf-8')) as {
        files?: string[];
      };
      expect(pkg.files ?? []).toContain('agents');
      const agentFiles = readdirSync(agentsDir).filter((n) => n.endsWith('.md'));
      listed = agentFiles.map((n) => `agents/${n}`);
      if ((pkg.files ?? []).includes('THIRD_PARTY_NOTICES.md')) {
        listed.push('THIRD_PARTY_NOTICES.md');
      }
    }

    const normalized = listed.map((p) => p.replace(/\\/g, '/'));
    expect(normalized).toContain('THIRD_PARTY_NOTICES.md');
    expect(
      normalized.some((p) => p === 'agents/debugger.md' || p.endsWith('/agents/debugger.md'))
    ).toBe(true);
    expect(
      normalized.some((p) => p === 'agents/general.md' || p.endsWith('/agents/general.md'))
    ).toBe(true);
    expect(
      normalized.some((p) => p === 'agents/worker.md' || p.endsWith('/agents/worker.md'))
    ).toBe(false);
  });
});
