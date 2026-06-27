// ABOUTME: Tests for package agent discovery — settings.json packages[], scope, namespacing, and safety.
// ABOUTME: Writes a fake user+project layout under tmpdirs and asserts discoverPackageAgentDirs / discoverAgents output.

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverAgents } from '../src/agents.ts';
import { discoverPackageAgentDirs } from '../src/package-agents.ts';

interface FakeEnv {
  projectCwd: string;
  userAgentDir: string;
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

function makeEnv(layout: (env: FakeEnv) => void): FakeEnv {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pi-pkg-agents-test-'));
  const projectCwd = path.join(root, 'project');
  const userAgentDir = path.join(root, 'home', '.pi', 'agent');
  mkdirSync(projectCwd, { recursive: true });
  mkdirSync(userAgentDir, { recursive: true });
  const env: FakeEnv = {
    projectCwd,
    userAgentDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  layout(env);
  return env;
}

const REVIEWER_BODY = `---
name: reviewer
description: package reviewer
---
Review.`;

function withAgentDirEnv(envDir: string): () => void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = envDir;
  return () => {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
  };
}

describe('discoverPackageAgentDirs', () => {
  let env: FakeEnv | null = null;
  let restoreEnv: (() => void) | null = null;

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = null;
    env?.cleanup();
    env = null;
  });

  it('resolves npm: sources from the user settings.json packages[]', () => {
    env = makeEnv((e) => {
      const pkgRoot = path.join(e.userAgentDir, 'npm', 'node_modules', '@acme', 'pi-demo');
      writeJson(path.join(pkgRoot, 'package.json'), {
        name: '@acme/pi-demo',
        pi: { agents: ['./agents'] },
      });
      writeText(path.join(pkgRoot, 'agents', 'reviewer.md'), REVIEWER_BODY);
      writeJson(path.join(e.userAgentDir, 'settings.json'), {
        packages: ['npm:@acme/pi-demo@1.0.0'],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    const dirs = discoverPackageAgentDirs(env.projectCwd, 'user');
    expect(dirs).toHaveLength(1);
    expect(dirs[0].packageName).toBe('@acme/pi-demo');
    expect(dirs[0].agentPath.endsWith('agents')).toBe(true);
  });

  it('resolves git: sources from the project settings.json packages[]', () => {
    env = makeEnv((e) => {
      const pkgRoot = path.join(e.projectCwd, '.pi', 'git', 'github.com', 'user', 'repo');
      writeJson(path.join(pkgRoot, 'package.json'), {
        name: 'repo-agents',
        pi: { agents: ['./agents'] },
      });
      writeText(path.join(pkgRoot, 'agents', 'reviewer.md'), REVIEWER_BODY);
      writeJson(path.join(e.projectCwd, '.pi', 'settings.json'), {
        packages: ['git:github.com/user/repo@v1'],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    const dirs = discoverPackageAgentDirs(env.projectCwd, 'project');
    expect(dirs).toHaveLength(1);
    expect(dirs[0].packageName).toBe('repo-agents');
  });

  it('resolves local absolute path sources', () => {
    env = makeEnv((e) => {
      const pkgRoot = path.join(e.projectCwd, 'vendor', 'local-pkg');
      writeJson(path.join(pkgRoot, 'package.json'), {
        name: 'local-pkg',
        pi: { agents: ['./agents'] },
      });
      writeText(path.join(pkgRoot, 'agents', 'reviewer.md'), REVIEWER_BODY);
      writeJson(path.join(e.projectCwd, '.pi', 'settings.json'), {
        packages: [pkgRoot],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    const dirs = discoverPackageAgentDirs(env.projectCwd, 'project');
    expect(dirs).toHaveLength(1);
    expect(dirs[0].packageName).toBe('local-pkg');
  });

  it('accepts package entries in the {source} object form', () => {
    env = makeEnv((e) => {
      const pkgRoot = path.join(e.userAgentDir, 'npm', 'node_modules', 'object-form');
      writeJson(path.join(pkgRoot, 'package.json'), {
        name: 'object-form',
        pi: { agents: ['./agents'] },
      });
      writeText(path.join(pkgRoot, 'agents', 'reviewer.md'), REVIEWER_BODY);
      writeJson(path.join(e.userAgentDir, 'settings.json'), {
        packages: [{ source: 'npm:object-form', extensions: [] }],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    const dirs = discoverPackageAgentDirs(env.projectCwd, 'user');
    expect(dirs).toHaveLength(1);
    expect(dirs[0].packageName).toBe('object-form');
  });

  it('skips packages without a pi.agents field or with missing directories', () => {
    env = makeEnv((e) => {
      const a = path.join(e.userAgentDir, 'npm', 'node_modules', 'no-agents');
      writeJson(path.join(a, 'package.json'), { name: 'no-agents' });
      const b = path.join(e.userAgentDir, 'npm', 'node_modules', 'broken-path');
      writeJson(path.join(b, 'package.json'), {
        name: 'broken-path',
        pi: { agents: ['./missing'] },
      });
      writeJson(path.join(e.userAgentDir, 'settings.json'), {
        packages: ['npm:no-agents', 'npm:broken-path'],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    expect(discoverPackageAgentDirs(env.projectCwd, 'user')).toEqual([]);
  });

  it('rejects pi.agents paths that escape the package root', () => {
    env = makeEnv((e) => {
      const pkgRoot = path.join(e.userAgentDir, 'npm', 'node_modules', 'evil');
      writeJson(path.join(pkgRoot, 'package.json'), {
        name: 'evil',
        pi: { agents: ['../../shared-agents'] },
      });
      writeText(
        path.join(e.userAgentDir, 'npm', 'node_modules', 'shared-agents', 'reviewer.md'),
        REVIEWER_BODY
      );
      writeJson(path.join(e.userAgentDir, 'settings.json'), {
        packages: ['npm:evil'],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    expect(discoverPackageAgentDirs(env.projectCwd, 'user')).toEqual([]);
  });

  it('rejects agent directories that symlink outside the package root', () => {
    env = makeEnv((e) => {
      const pkgRoot = path.join(e.userAgentDir, 'npm', 'node_modules', 'tricky');
      mkdirSync(pkgRoot, { recursive: true });
      writeJson(path.join(pkgRoot, 'package.json'), {
        name: 'tricky',
        pi: { agents: ['./agents'] },
      });
      const outside = path.join(e.userAgentDir, 'outside-agents');
      mkdirSync(outside, { recursive: true });
      writeText(path.join(outside, 'reviewer.md'), REVIEWER_BODY);
      symlinkSync(outside, path.join(pkgRoot, 'agents'), 'dir');
      writeJson(path.join(e.userAgentDir, 'settings.json'), {
        packages: ['npm:tricky'],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    expect(discoverPackageAgentDirs(env.projectCwd, 'user')).toEqual([]);
  });

  it('accepts a bare https:// git URL without the git: prefix', () => {
    env = makeEnv((e) => {
      const pkgRoot = path.join(e.userAgentDir, 'git', 'github.com', 'acme', 'pi-frontend');
      writeJson(path.join(pkgRoot, 'package.json'), {
        name: '@acme/pi-frontend',
        pi: { agents: ['./agents'] },
      });
      writeText(path.join(pkgRoot, 'agents', 'reviewer.md'), REVIEWER_BODY);
      writeJson(path.join(e.userAgentDir, 'settings.json'), {
        packages: ['https://github.com/acme/pi-frontend@v1.2.0'],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    const dirs = discoverPackageAgentDirs(env.projectCwd, 'user');
    expect(dirs).toHaveLength(1);
    expect(dirs[0].packageName).toBe('@acme/pi-frontend');
  });

  it('accepts a git@host:path SSH shorthand under git: prefix with a ref', () => {
    env = makeEnv((e) => {
      const pkgRoot = path.join(e.userAgentDir, 'git', 'github.com', 'user', 'repo');
      writeJson(path.join(pkgRoot, 'package.json'), {
        name: 'repo-agents',
        pi: { agents: ['./agents'] },
      });
      writeText(path.join(pkgRoot, 'agents', 'reviewer.md'), REVIEWER_BODY);
      writeJson(path.join(e.userAgentDir, 'settings.json'), {
        packages: ['git:git@github.com:user/repo@v2'],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    const dirs = discoverPackageAgentDirs(env.projectCwd, 'user');
    expect(dirs).toHaveLength(1);
    expect(dirs[0].packageName).toBe('repo-agents');
  });

  it('accepts a bare git:// protocol URL as a git source (not the git: package prefix)', () => {
    env = makeEnv((e) => {
      const pkgRoot = path.join(e.userAgentDir, 'git', 'example.com', 'team', 'repo');
      writeJson(path.join(pkgRoot, 'package.json'), {
        name: 'team-repo',
        pi: { agents: ['./agents'] },
      });
      writeText(path.join(pkgRoot, 'agents', 'reviewer.md'), REVIEWER_BODY);
      writeJson(path.join(e.userAgentDir, 'settings.json'), {
        packages: ['git://example.com/team/repo'],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    const dirs = discoverPackageAgentDirs(env.projectCwd, 'user');
    expect(dirs).toHaveLength(1);
    expect(dirs[0].packageName).toBe('team-repo');
  });

  it('rejects bare SCP shorthand without the git: prefix', () => {
    env = makeEnv((e) => {
      writeJson(path.join(e.userAgentDir, 'settings.json'), {
        packages: ['git@github.com:user/repo'],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    expect(discoverPackageAgentDirs(env.projectCwd, 'user')).toEqual([]);
  });

  it('rejects sources containing percent-encoded characters', () => {
    env = makeEnv((e) => {
      writeJson(path.join(e.userAgentDir, 'settings.json'), {
        packages: ['git:github.com/user/repo%2e%2e/escape'],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    expect(discoverPackageAgentDirs(env.projectCwd, 'user')).toEqual([]);
  });

  it('rejects shorthand git sources whose host has no dot', () => {
    env = makeEnv((e) => {
      writeJson(path.join(e.userAgentDir, 'settings.json'), {
        packages: ['git:notahost/user/repo'],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    expect(discoverPackageAgentDirs(env.projectCwd, 'user')).toEqual([]);
  });

  it('decodes file:// URLs as local paths', () => {
    env = makeEnv((e) => {
      const pkgRoot = path.join(e.projectCwd, 'vendor', 'local-pkg');
      writeJson(path.join(pkgRoot, 'package.json'), {
        name: 'local-pkg',
        pi: { agents: ['./agents'] },
      });
      writeText(path.join(pkgRoot, 'agents', 'reviewer.md'), REVIEWER_BODY);
      writeJson(path.join(e.projectCwd, '.pi', 'settings.json'), {
        packages: [`file://${pkgRoot}`],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    const dirs = discoverPackageAgentDirs(env.projectCwd, 'project');
    expect(dirs).toHaveLength(1);
    expect(dirs[0].packageName).toBe('local-pkg');
  });

  it('finds project .pi/settings.json from an ancestor directory', () => {
    env = makeEnv((e) => {
      const pkgRoot = path.join(e.projectCwd, '.pi', 'npm', 'node_modules', 'nested-pkg');
      writeJson(path.join(pkgRoot, 'package.json'), {
        name: 'nested-pkg',
        pi: { agents: ['./agents'] },
      });
      writeText(path.join(pkgRoot, 'agents', 'reviewer.md'), REVIEWER_BODY);
      writeJson(path.join(e.projectCwd, '.pi', 'settings.json'), {
        packages: ['npm:nested-pkg'],
      });
      mkdirSync(path.join(e.projectCwd, 'sub', 'deeper'), { recursive: true });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    const dirs = discoverPackageAgentDirs(path.join(env.projectCwd, 'sub', 'deeper'), 'project');
    expect(dirs).toHaveLength(1);
    expect(dirs[0].packageName).toBe('nested-pkg');
  });

  it('prefers the project entry when the same identity is configured in both scopes at different roots', () => {
    env = makeEnv((e) => {
      const userRoot = path.join(e.userAgentDir, 'npm', 'node_modules', 'identity-pkg');
      writeJson(path.join(userRoot, 'package.json'), {
        name: 'identity-pkg',
        pi: { agents: ['./agents'] },
      });
      writeText(
        path.join(userRoot, 'agents', 'reviewer.md'),
        REVIEWER_BODY.replace('package reviewer', 'user copy')
      );
      const projectRoot = path.join(e.projectCwd, '.pi', 'npm', 'node_modules', 'identity-pkg');
      writeJson(path.join(projectRoot, 'package.json'), {
        name: 'identity-pkg',
        pi: { agents: ['./agents'] },
      });
      writeText(
        path.join(projectRoot, 'agents', 'reviewer.md'),
        REVIEWER_BODY.replace('package reviewer', 'project copy')
      );
      writeJson(path.join(e.userAgentDir, 'settings.json'), { packages: ['npm:identity-pkg'] });
      writeJson(path.join(e.projectCwd, '.pi', 'settings.json'), {
        packages: ['npm:identity-pkg'],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    const dirs = discoverPackageAgentDirs(env.projectCwd, 'both');
    expect(dirs).toHaveLength(1);
    expect(dirs[0].packageRoot).toBe(
      path.join(env.projectCwd, '.pi', 'npm', 'node_modules', 'identity-pkg')
    );
  });
});

describe('discoverAgents with package source', () => {
  let env: FakeEnv | null = null;
  let restoreEnv: (() => void) | null = null;

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = null;
    env?.cleanup();
    env = null;
  });

  function setupUserPackage(
    name: string,
    agentsField: string | string[] = ['./agents']
  ): { agentsDir: string; pkgRoot: string } {
    let agentsDir = '';
    let pkgRoot = '';
    env = makeEnv((e) => {
      const segments = name.startsWith('@') ? name.split('/') : [name];
      pkgRoot = path.join(e.userAgentDir, 'npm', 'node_modules', ...segments);
      writeJson(path.join(pkgRoot, 'package.json'), {
        name,
        pi: { agents: agentsField },
      });
      agentsDir = path.join(pkgRoot, 'agents');
      writeText(path.join(agentsDir, 'reviewer.md'), REVIEWER_BODY);
      writeJson(path.join(e.userAgentDir, 'settings.json'), {
        packages: [`npm:${name}`],
      });
    });
    restoreEnv = withAgentDirEnv(env!.userAgentDir);
    return { agentsDir, pkgRoot };
  }

  it('does not load package agents under scope "project" when the package is in user settings', () => {
    setupUserPackage('@acme/pi-demo');

    const { agents } = discoverAgents(env!.projectCwd, 'project');
    expect(agents.find((a) => a.name === '@acme/pi-demo.reviewer')).toBeUndefined();
  });

  it('loads package agents under scope "user" with a namespaced name', () => {
    setupUserPackage('@acme/pi-demo');

    const { agents } = discoverAgents(env!.projectCwd, 'user');
    const reviewer = agents.find((a) => a.name === '@acme/pi-demo.reviewer');
    expect(reviewer).toBeDefined();
    expect(reviewer!.source).toBe('package');
    expect(reviewer!.localName).toBe('reviewer');
    expect(reviewer!.packageName).toBe('@acme/pi-demo');
    expect(reviewer!.filePath.endsWith('reviewer.md')).toBe(true);
  });

  it('accepts pi.agents as a string and resolves a single file path', () => {
    env = makeEnv((e) => {
      const pkgRoot = path.join(e.userAgentDir, 'npm', 'node_modules', 'pi-singletton');
      writeJson(path.join(pkgRoot, 'package.json'), {
        name: 'pi-singletton',
        pi: { agents: './reviewer.md' },
      });
      writeText(path.join(pkgRoot, 'reviewer.md'), REVIEWER_BODY);
      writeJson(path.join(e.userAgentDir, 'settings.json'), {
        packages: ['npm:pi-singletton'],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    const { agents } = discoverAgents(env.projectCwd, 'both');
    const reviewer = agents.find((a) => a.name === 'pi-singletton.reviewer');
    expect(reviewer).toBeDefined();
    expect(reviewer!.source).toBe('package');
  });

  it('does not throw when a configured package is missing on disk', () => {
    env = makeEnv((e) => {
      writeJson(path.join(e.userAgentDir, 'settings.json'), {
        packages: ['npm:never-installed'],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    const { agents } = discoverAgents(env.projectCwd, 'both');
    expect(agents.every((a) => a.source !== 'package')).toBe(true);
  });

  it('drops individual agent .md files that symlink outside the package root', () => {
    env = makeEnv((e) => {
      const pkgRoot = path.join(e.userAgentDir, 'npm', 'node_modules', 'tricky2');
      const pkgAgents = path.join(pkgRoot, 'agents');
      mkdirSync(pkgAgents, { recursive: true });
      writeJson(path.join(pkgRoot, 'package.json'), {
        name: 'tricky2',
        pi: { agents: ['./agents'] },
      });
      writeText(path.join(pkgAgents, 'safe.md'), REVIEWER_BODY.replace('reviewer', 'safe'));
      const outsideMd = path.join(e.userAgentDir, 'evil-reviewer.md');
      writeText(outsideMd, REVIEWER_BODY);
      symlinkSync(outsideMd, path.join(pkgAgents, 'evil.md'));
      writeJson(path.join(e.userAgentDir, 'settings.json'), {
        packages: ['npm:tricky2'],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    const { agents } = discoverAgents(env.projectCwd, 'both');
    const fromPackage = agents.filter((a) => a.source === 'package');
    expect(fromPackage).toHaveLength(1);
    expect(fromPackage[0].localName).toBe('safe');
  });

  it('does not even read .md files that symlink outside the package root', () => {
    env = makeEnv((e) => {
      const pkgRoot = path.join(e.userAgentDir, 'npm', 'node_modules', 'tricky3');
      const pkgAgents = path.join(pkgRoot, 'agents');
      mkdirSync(pkgAgents, { recursive: true });
      writeJson(path.join(pkgRoot, 'package.json'), {
        name: 'tricky3',
        pi: { agents: ['./agents'] },
      });
      writeText(path.join(pkgAgents, 'safe.md'), REVIEWER_BODY.replace('reviewer', 'safe'));
      const outsideMd = path.join(e.userAgentDir, 'evil-target.md');
      writeText(outsideMd, REVIEWER_BODY);
      symlinkSync(outsideMd, path.join(pkgAgents, 'evil.md'));
      writeJson(path.join(e.userAgentDir, 'settings.json'), {
        packages: ['npm:tricky3'],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    const fs = require('node:fs') as typeof import('node:fs');
    const realReadFileSync = fs.readFileSync;
    const outsideMd = path.join(env.userAgentDir, 'evil-target.md');
    const reads: string[] = [];
    let outsideRead = false;
    fs.readFileSync = ((p: unknown, ...rest: unknown[]) => {
      const target = typeof p === 'string' ? p : String(p);
      reads.push(target);
      if (target === outsideMd) outsideRead = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (realReadFileSync as any)(p, ...rest);
    }) as typeof fs.readFileSync;

    try {
      const { agents } = discoverAgents(env.projectCwd, 'both');
      const fromPackage = agents.filter((a) => a.source === 'package');
      expect(fromPackage).toHaveLength(1);
      expect(fromPackage[0].localName).toBe('safe');
      expect(outsideRead).toBe(false);
    } finally {
      fs.readFileSync = realReadFileSync;
    }
  });

  it('loads project-scope package agents under scope "project"', () => {
    env = makeEnv((e) => {
      const pkgRoot = path.join(e.projectCwd, '.pi', 'npm', 'node_modules', '@acme', 'pi-project');
      writeJson(path.join(pkgRoot, 'package.json'), {
        name: '@acme/pi-project',
        pi: { agents: ['./agents'] },
      });
      writeText(path.join(pkgRoot, 'agents', 'reviewer.md'), REVIEWER_BODY);
      writeJson(path.join(e.projectCwd, '.pi', 'settings.json'), {
        packages: ['npm:@acme/pi-project'],
      });
    });
    restoreEnv = withAgentDirEnv(env.userAgentDir);

    const { agents } = discoverAgents(env.projectCwd, 'project');
    const reviewer = agents.find((a) => a.name === '@acme/pi-project.reviewer');
    expect(reviewer).toBeDefined();
    expect(reviewer!.source).toBe('package');
    expect(reviewer!.packageName).toBe('@acme/pi-project');
  });
});
