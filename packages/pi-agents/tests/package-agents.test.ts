// ABOUTME: Tests for package agent discovery — node_modules resolution, namespacing, scope, and override safety.
// ABOUTME: Writes a fake project layout under a tmpdir and asserts discoverAgents output.

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverAgents } from '../src/agents.ts';
import { discoverPackageAgentDirs } from '../src/package-agents.ts';

interface FakeProject {
  cwd: string;
  cleanup: () => void;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function writeText(filePath: string, value: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value);
}

function makeProject(layout: (root: string) => void): FakeProject {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pi-pkg-agents-test-'));
  layout(root);
  return { cwd: root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const REVIEWER_BODY = `---
name: reviewer
description: package reviewer
---
Review.`;

describe('discoverPackageAgentDirs', () => {
  let env: FakeProject | null = null;
  afterEach(() => {
    env?.cleanup();
    env = null;
  });

  it('finds agents directories declared by direct dependencies', () => {
    env = makeProject((root) => {
      writeJson(path.join(root, 'package.json'), {
        name: 'host',
        dependencies: { '@acme/pi-demo': '*' },
      });
      writeJson(path.join(root, 'node_modules', '@acme', 'pi-demo', 'package.json'), {
        name: '@acme/pi-demo',
        pi: { agents: ['./agents'] },
      });
      writeText(
        path.join(root, 'node_modules', '@acme', 'pi-demo', 'agents', 'reviewer.md'),
        REVIEWER_BODY
      );
    });

    const dirs = discoverPackageAgentDirs(env.cwd);
    expect(dirs).toHaveLength(1);
    expect(dirs[0].packageName).toBe('@acme/pi-demo');
    expect(dirs[0].agentPath.endsWith('agents')).toBe(true);
  });

  it('skips packages without a pi.agents field and missing directories', () => {
    env = makeProject((root) => {
      writeJson(path.join(root, 'package.json'), {
        name: 'host',
        dependencies: { 'no-agents': '*', 'broken-path': '*' },
      });
      writeJson(path.join(root, 'node_modules', 'no-agents', 'package.json'), {
        name: 'no-agents',
      });
      writeJson(path.join(root, 'node_modules', 'broken-path', 'package.json'), {
        name: 'broken-path',
        pi: { agents: ['./missing'] },
      });
    });
    expect(discoverPackageAgentDirs(env.cwd)).toEqual([]);
  });

  it('rejects pi.agents paths that escape the package root', () => {
    env = makeProject((root) => {
      writeJson(path.join(root, 'package.json'), {
        name: 'host',
        dependencies: { evil: '*' },
      });
      writeJson(path.join(root, 'node_modules', 'evil', 'package.json'), {
        name: 'evil',
        pi: { agents: ['../../shared-agents'] },
      });
      writeText(path.join(root, 'shared-agents', 'reviewer.md'), REVIEWER_BODY);
    });
    expect(discoverPackageAgentDirs(env.cwd)).toEqual([]);
  });

  it('rejects symlinked agent paths that resolve outside the package root', () => {
    env = makeProject((root) => {
      writeJson(path.join(root, 'package.json'), {
        name: 'host',
        dependencies: { tricky: '*' },
      });
      const pkgRoot = path.join(root, 'node_modules', 'tricky');
      mkdirSync(pkgRoot, { recursive: true });
      writeJson(path.join(pkgRoot, 'package.json'), {
        name: 'tricky',
        pi: { agents: ['./agents'] },
      });
      const outside = path.join(root, 'outside-agents');
      mkdirSync(outside, { recursive: true });
      writeText(path.join(outside, 'reviewer.md'), REVIEWER_BODY);
      symlinkSync(outside, path.join(pkgRoot, 'agents'), 'dir');
    });
    expect(discoverPackageAgentDirs(env.cwd)).toEqual([]);
  });
});

describe('discoverAgents with package source', () => {
  let env: FakeProject | null = null;
  afterEach(() => {
    env?.cleanup();
    env = null;
  });

  it('does not load package agents under scope "user"', () => {
    env = makeProject((root) => {
      writeJson(path.join(root, 'package.json'), {
        name: 'host',
        dependencies: { '@acme/pi-demo': '*' },
      });
      writeJson(path.join(root, 'node_modules', '@acme', 'pi-demo', 'package.json'), {
        name: '@acme/pi-demo',
        pi: { agents: ['./agents'] },
      });
      writeText(
        path.join(root, 'node_modules', '@acme', 'pi-demo', 'agents', 'reviewer.md'),
        REVIEWER_BODY
      );
    });

    const { agents } = discoverAgents(env.cwd, 'user');
    expect(agents.find((a) => a.name === '@acme/pi-demo.reviewer')).toBeUndefined();
  });

  it('loads package agents under scope "project" with namespaced name', () => {
    env = makeProject((root) => {
      writeJson(path.join(root, 'package.json'), {
        name: 'host',
        dependencies: { '@acme/pi-demo': '*' },
      });
      writeJson(path.join(root, 'node_modules', '@acme', 'pi-demo', 'package.json'), {
        name: '@acme/pi-demo',
        pi: { agents: ['./agents'] },
      });
      writeText(
        path.join(root, 'node_modules', '@acme', 'pi-demo', 'agents', 'reviewer.md'),
        REVIEWER_BODY
      );
    });

    const { agents } = discoverAgents(env.cwd, 'project');
    const reviewer = agents.find((a) => a.name === '@acme/pi-demo.reviewer');
    expect(reviewer).toBeDefined();
    expect(reviewer!.source).toBe('package');
    expect(reviewer!.localName).toBe('reviewer');
    expect(reviewer!.packageName).toBe('@acme/pi-demo');
    expect(reviewer!.filePath.endsWith('reviewer.md')).toBe(true);
  });

  it('accepts pi.agents as a string and resolves a single file path', () => {
    env = makeProject((root) => {
      writeJson(path.join(root, 'package.json'), {
        name: 'host',
        dependencies: { 'pi-singletton': '*' },
      });
      writeJson(path.join(root, 'node_modules', 'pi-singletton', 'package.json'), {
        name: 'pi-singletton',
        pi: { agents: './reviewer.md' },
      });
      writeText(path.join(root, 'node_modules', 'pi-singletton', 'reviewer.md'), REVIEWER_BODY);
    });

    const { agents } = discoverAgents(env.cwd, 'both');
    const reviewer = agents.find((a) => a.name === 'pi-singletton.reviewer');
    expect(reviewer).toBeDefined();
    expect(reviewer!.source).toBe('package');
  });

  it('does not throw when a declared package is missing in node_modules', () => {
    env = makeProject((root) => {
      writeJson(path.join(root, 'package.json'), {
        name: 'host',
        dependencies: { 'never-installed': '*' },
      });
    });
    const { agents } = discoverAgents(env.cwd, 'project');
    expect(agents.every((a) => a.source !== 'package')).toBe(true);
  });

  it('drops individual agent .md files that symlink outside the package root', () => {
    env = makeProject((root) => {
      writeJson(path.join(root, 'package.json'), {
        name: 'host',
        dependencies: { tricky2: '*' },
      });
      const pkgRoot = path.join(root, 'node_modules', 'tricky2');
      const pkgAgents = path.join(pkgRoot, 'agents');
      mkdirSync(pkgAgents, { recursive: true });
      writeJson(path.join(pkgRoot, 'package.json'), {
        name: 'tricky2',
        pi: { agents: ['./agents'] },
      });
      writeText(path.join(pkgAgents, 'safe.md'), REVIEWER_BODY.replace('reviewer', 'safe'));
      const outsideMd = path.join(root, 'evil-reviewer.md');
      writeText(outsideMd, REVIEWER_BODY);
      symlinkSync(outsideMd, path.join(pkgAgents, 'evil.md'));
    });

    const { agents } = discoverAgents(env.cwd, 'project');
    const fromPackage = agents.filter((a) => a.source === 'package');
    expect(fromPackage).toHaveLength(1);
    expect(fromPackage[0].localName).toBe('safe');
  });
});
