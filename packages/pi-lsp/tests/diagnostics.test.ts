// ABOUTME: Tests for multi-server diagnostic registry behavior.
// ABOUTME: Verifies that diagnostics from multiple servers coexist per URI and per-server clearing.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Diagnostic as LspDiagnostic } from 'vscode-languageserver-types';
import {
  clearForFile,
  drain,
  formatDiagnosticsState,
  hasDiagnostics,
  onChanged,
  register,
  resetAll,
} from '../src/diagnostics.ts';

function diag(message: string, source?: string, line = 0): LspDiagnostic {
  return {
    range: {
      start: { line, character: 0 },
      end: { line, character: 10 },
    },
    message,
    severity: 1,
    source,
  };
}

beforeEach(() => {
  resetAll();
});

afterEach(() => {
  resetAll();
});

describe('multi-server diagnostics', () => {
  it('preserves diagnostics from two servers for the same URI in one drain', () => {
    const uri = 'file:///tmp/a.ts';
    register('typescript', uri, [diag('TS error', 'ts', 0)]);
    register('eslint', uri, [diag('lint error', 'eslint', 1)]);

    const block = drain();
    expect(block).not.toBeNull();
    expect(block!).toContain('TS error');
    expect(block!).toContain('lint error');
    // Single file section.
    const fileHeadings = block!.split('\n').filter((l) => l.endsWith(':') && !l.startsWith('  '));
    // The header (first line) ends with ':', plus the URI heading; expect at most one URI heading.
    const uriOccurrences = block!.split('\n').filter((l) => l.includes('a.ts:'));
    expect(uriOccurrences.length).toBe(1);
    expect(fileHeadings.length).toBeGreaterThan(0);
  });

  it('clears only the publishing server when an empty publish arrives', () => {
    const uri = 'file:///tmp/b.ts';
    register('typescript', uri, [diag('TS error', 'ts', 0)]);
    register('eslint', uri, [diag('lint error', 'eslint', 1)]);

    // ESLint publishes an empty set (file now clean from its perspective).
    register('eslint', uri, []);

    const block = drain();
    expect(block).not.toBeNull();
    expect(block!).toContain('TS error');
    expect(block!).not.toContain('lint error');
  });

  it('clears delivered diagnostics for the publishing server on clean publish', () => {
    const uri = 'file:///tmp/b-delivered.ts';
    register('typescript', uri, [diag('TS error', 'ts', 0)]);
    register('eslint', uri, [diag('lint error', 'eslint', 1)]);
    drain();

    expect(formatDiagnosticsState()).toContain('Delivered (2 issues across 1 file)');
    expect(hasDiagnostics()).toBe(true);

    // ESLint reports a clean publish: its delivered tracking should go away.
    register('eslint', uri, []);
    expect(formatDiagnosticsState()).toContain('TS error');
    expect(formatDiagnosticsState()).not.toContain('lint error');
    expect(hasDiagnostics()).toBe(true);

    // Once TypeScript also reports clean, nothing should remain.
    register('typescript', uri, []);
    expect(formatDiagnosticsState()).toBe(
      'LSP diagnostics\n\nNo pending or delivered diagnostics.'
    );
    expect(hasDiagnostics()).toBe(false);
  });

  it('keeps identical messages from different servers as separate diagnostics', () => {
    const uri = 'file:///tmp/c.ts';
    // Same message text but different originating servers must not be deduped.
    register('typescript', uri, [diag('shared message', undefined, 5)]);
    register('eslint', uri, [diag('shared message', undefined, 5)]);

    const block = drain();
    expect(block).not.toBeNull();
    // Both should appear; the formatter tags them with the server name when
    // `source` is absent.
    expect(block!.match(/shared message/g)?.length ?? 0).toBe(2);
    expect(block!).toContain('server: typescript');
    expect(block!).toContain('server: eslint');
  });

  it('clearForFile removes pending entries from every server for that URI', () => {
    const uri = 'file:///tmp/d.ts';
    register('typescript', uri, [diag('TS error', 'ts', 0)]);
    register('eslint', uri, [diag('lint error', 'eslint', 1)]);

    clearForFile(uri);

    expect(drain()).toBeNull();
  });
});

describe('diagnostic presence indicator', () => {
  it('reflects pending and delivered state', () => {
    expect(hasDiagnostics()).toBe(false);

    register('ts', 'file:///x.ts', [diag('e')]);
    expect(hasDiagnostics()).toBe(true);

    drain();
    expect(hasDiagnostics()).toBe(true);

    clearForFile('file:///x.ts');
    expect(hasDiagnostics()).toBe(false);
  });

  it('notifies onChanged only on the empty <-> non-empty transition', () => {
    const calls: number[] = [];
    let n = 0;
    const off = onChanged(() => calls.push(++n));

    register('ts', 'file:///x.ts', [diag('e')]);
    expect(calls).toEqual([1]);

    register('ts', 'file:///x.ts', [diag('e2')]);
    expect(calls).toEqual([1]);

    register('ts', 'file:///x.ts', []);
    expect(calls).toEqual([1, 2]);

    off();
  });

  it('does not notify when drain moves pending to delivered', () => {
    const calls: number[] = [];
    const off = onChanged(() => calls.push(1));

    register('ts', 'file:///x.ts', [diag('e')]);
    calls.length = 0;

    drain();
    expect(calls).toEqual([]);
    expect(hasDiagnostics()).toBe(true);

    off();
  });
});

describe('formatDiagnosticsState', () => {
  it('reports no diagnostics when empty', () => {
    expect(formatDiagnosticsState()).toBe(
      'LSP diagnostics\n\nNo pending or delivered diagnostics.'
    );
  });

  it('shows pending diagnostics', () => {
    register('ts', 'file:///x.ts', [diag('pending error', 'ts', 2)]);
    const output = formatDiagnosticsState();
    expect(output).toContain('Pending (1 issue across 1 file):');
    expect(output).toContain('x.ts:');
    expect(output).toContain('pending error');
    expect(output).toContain('[3:1]');
    expect(output).not.toContain('Delivered');
  });

  it('shows delivered diagnostics after drain', () => {
    register('ts', 'file:///x.ts', [diag('delivered error', 'ts', 4)]);
    drain();
    const output = formatDiagnosticsState();
    expect(output).toContain('Delivered (1 issue across 1 file):');
    expect(output).toContain('delivered error');
    expect(output).toContain('[5:1]');
    expect(output).not.toContain('Pending');
  });

  it('groups multiple servers for the same file', () => {
    register('ts', 'file:///x.ts', [diag('ts error', 'ts', 0)]);
    register('eslint', 'file:///x.ts', [diag('lint error', 'eslint', 1)]);
    const output = formatDiagnosticsState();
    expect(output).toContain('Pending (2 issues across 1 file):');
    const uriOccurrences = output.split('\n').filter((l) => l.includes('x.ts:'));
    expect(uriOccurrences.length).toBe(1);
  });

  it('clears delivered diagnostics for a file on clearForFile', () => {
    const uri = 'file:///x.ts';
    register('ts', uri, [diag('e')]);
    drain();
    clearForFile(uri);
    expect(formatDiagnosticsState()).toContain('No pending or delivered diagnostics.');
  });

  it('shows the originating server for delivered diagnostics without a source', () => {
    // No `source` on the diagnostic — formatter must still tag the line with
    // the originating server after the delivered key round-trip.
    register('eslint', 'file:///x.ts', [diag('no-source error', undefined, 3)]);
    drain();
    const output = formatDiagnosticsState();
    expect(output).toContain('Delivered (1 issue across 1 file):');
    expect(output).toContain('no-source error');
    expect(output).toContain('server: eslint');
  });

  it('preserves the diagnostic code through delivered-key parsing', () => {
    const withCode: LspDiagnostic = {
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 },
      },
      message: 'coded error',
      severity: 1,
      source: 'ts',
      code: 2322,
    };
    register('ts', 'file:///x.ts', [withCode]);
    drain();
    const output = formatDiagnosticsState();
    expect(output).toContain('coded error');
    expect(output).toContain('[2322]');
  });

  it('shows pending and delivered sections for the same file', () => {
    const uri = 'file:///x.ts';
    register('ts', uri, [diag('first', 'ts', 0)]);
    drain();
    register('ts', uri, [diag('second', 'ts', 1)]);
    const output = formatDiagnosticsState();
    expect(output).toContain('Pending (1 issue across 1 file):');
    expect(output).toContain('Delivered (1 issue across 1 file):');
    expect(output).toContain('first');
    expect(output).toContain('second');
    expect(output.indexOf('Pending')).toBeLessThan(output.indexOf('Delivered'));
  });
});
