// ABOUTME: Synthetic Bun metafile graph coverage for bundle-graph helpers.
// ABOUTME: Exercises path normalization, static/dynamic closures, cycles, and missing edges.

import { describe, expect, it } from 'bun:test';
import {
  analyzeBundleGraph,
  inputPathLooksLikeAcpSdk,
  inputPathLooksLikeZod,
  normalizePath,
  resolveOutputImport,
  type Metafile,
} from '../../scripts/bundle-graph.ts';

describe('normalizePath / resolveOutputImport', () => {
  it('normalizes Windows separators', () => {
    expect(normalizePath('dist\\chunks\\a.js')).toBe('dist/chunks/a.js');
  });

  it('prefers outdir-rooted Bun metafile import paths', () => {
    const known = new Set(['chunks/a.js', 'chunks/nested/b.js', 'chunks/c.js', 'index.js']);
    expect(resolveOutputImport('index.js', './chunks/a.js', known)).toBe('chunks/a.js');
    expect(resolveOutputImport('chunks/a.js', './chunks/nested/b.js', known)).toBe(
      'chunks/nested/b.js'
    );
  });

  it('falls back to importer-relative resolution when needed', () => {
    const known = new Set(['dist/chunks/nested/b.js', 'dist/chunks/c.js']);
    expect(resolveOutputImport('dist/chunks/a.js', './nested/b.js', known)).toBe(
      'dist/chunks/nested/b.js'
    );
    expect(resolveOutputImport('dist/chunks/nested/b.js', '../c.js', known)).toBe(
      'dist/chunks/c.js'
    );
  });
});

describe('analyzeBundleGraph', () => {
  it('computes static closure, shared static chunks, and dynamic descendants', () => {
    const metafile: Metafile = {
      outputs: {
        './index.js': {
          bytes: 100,
          entryPoint: 'src/index.ts',
          imports: [
            { path: './chunks/shared.js', kind: 'import-statement' },
            { path: './chunks/lazy.js', kind: 'dynamic-import' },
          ],
          inputs: { 'src/index.ts': { bytesInOutput: 50 } },
        },
        './chunks/shared.js': {
          bytes: 40,
          imports: [],
          inputs: { 'src/shared.ts': { bytesInOutput: 40 } },
        },
        './chunks/lazy.js': {
          bytes: 200,
          imports: [{ path: './chunks/deep.js', kind: 'import-statement' }],
          inputs: {
            'src/lazy.ts': { bytesInOutput: 20 },
            'node_modules/@agentclientprotocol/sdk/dist/index.js': { bytesInOutput: 180 },
          },
        },
        './chunks/deep.js': {
          bytes: 30,
          imports: [],
          inputs: { 'src/deep.ts': { bytesInOutput: 30 } },
        },
        './other-entry.js': {
          bytes: 999,
          entryPoint: 'src/other.ts',
          imports: [],
        },
      },
    };

    const graph = analyzeBundleGraph(metafile);
    expect(graph.entryOutputPath).toBe('index.js');
    expect(graph.startupStaticOutputs).toEqual(['chunks/shared.js', 'index.js']);
    expect(graph.startupStaticBytes).toBe(140);
    expect(graph.dynamicReachableOutputs).toEqual(['chunks/deep.js', 'chunks/lazy.js']);
    expect(graph.dynamicReachableBytes).toBe(230);
    expect(graph.totalMainGraphBytes).toBe(370);
    expect(graph.totalMainGraphOutputs).not.toContain('other-entry.js');
  });

  it('handles path separator differences and cycles without looping forever', () => {
    const metafile: Metafile = {
      outputs: {
        'index.js': {
          bytes: 10,
          entryPoint: 'src\\index.ts',
          imports: [
            { path: './chunks\\a.js', kind: 'import-statement' },
            { path: './chunks\\lazy.js', kind: 'dynamic-import' },
          ],
        },
        'chunks\\a.js': {
          bytes: 5,
          imports: [{ path: './chunks\\b.js', kind: 'import-statement' }],
        },
        'chunks\\b.js': {
          bytes: 5,
          imports: [{ path: './chunks\\a.js', kind: 'import-statement' }],
        },
        'chunks\\lazy.js': {
          bytes: 7,
          imports: [{ path: './chunks\\lazy.js', kind: 'dynamic-import' }],
        },
      },
    };

    const graph = analyzeBundleGraph(metafile);
    expect(graph.startupStaticOutputs).toEqual(['chunks/a.js', 'chunks/b.js', 'index.js']);
    expect(graph.dynamicReachableOutputs).toEqual(['chunks/lazy.js']);
  });

  it('ignores require-call and external imports as startup ESM edges', () => {
    const metafile: Metafile = {
      outputs: {
        './index.js': {
          bytes: 10,
          entryPoint: 'packages/pi-agents/src/index.ts',
          imports: [
            { path: 'effect', kind: 'import-statement', external: true },
            { path: './chunks/req.js', kind: 'require-call' },
            { path: './chunks/static.js', kind: 'import-statement' },
          ],
        },
        './chunks/req.js': { bytes: 50, imports: [] },
        './chunks/static.js': { bytes: 3, imports: [] },
      },
    };

    const graph = analyzeBundleGraph(metafile);
    expect(graph.startupStaticOutputs).toEqual(['chunks/static.js', 'index.js']);
    expect(graph.startupStaticBytes).toBe(13);
  });

  it('records missing local imports', () => {
    const metafile: Metafile = {
      outputs: {
        './index.js': {
          bytes: 1,
          entryPoint: 'src/index.ts',
          imports: [{ path: './chunks/missing.js', kind: 'import-statement' }],
        },
      },
    };

    const graph = analyzeBundleGraph(metafile);
    expect(graph.missingLocalImports).toEqual([{ from: 'index.js', path: 'chunks/missing.js' }]);
  });

  it('throws when the entry output is missing', () => {
    expect(() =>
      analyzeBundleGraph({
        outputs: {
          './dist/other.js': { bytes: 1, entryPoint: 'src/other.ts' },
        },
      })
    ).toThrow(/Could not find entry output/);
  });
});

describe('dependency path classification', () => {
  it('recognizes standard and Bun-cache ACP SDK paths', () => {
    expect(
      inputPathLooksLikeAcpSdk('node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.js')
    ).toBe(true);
    expect(
      inputPathLooksLikeAcpSdk(
        'node_modules/.bun/@agentclientprotocol+sdk@1.2.1/node_modules/@agentclientprotocol/sdk/dist/acp.js'
      )
    ).toBe(true);
    expect(inputPathLooksLikeAcpSdk('src/runtime/grok-acp/grok-acp-client.ts')).toBe(false);
  });

  it('recognizes standard and Bun-cache zod paths', () => {
    expect(inputPathLooksLikeZod('node_modules/zod/v4/index.js')).toBe(true);
    expect(
      inputPathLooksLikeZod('node_modules/.bun/zod@3.24.1/node_modules/zod/lib/index.js')
    ).toBe(true);
    expect(inputPathLooksLikeZod('src/shared/schema.ts')).toBe(false);
  });
});
