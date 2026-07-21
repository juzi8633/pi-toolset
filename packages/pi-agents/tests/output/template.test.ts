// ABOUTME: Tests for renderTaskTemplate — handles {previous}, {outputs.<name>}, and {item} substitution.
// ABOUTME: Asserts the unknown-output error path stops template expansion before spawning.

import { describe, expect, it } from 'bun:test';
import { renderTaskTemplate } from '../../src/output/template.ts';
import type { ChainOutputEntry } from '../../src/shared/types.ts';

function entry(text: string, agent = 'a', step = 1): ChainOutputEntry {
  return { text, agent, step };
}

function ctx(previous: string, outputs: Record<string, string> = {}, item?: { value: unknown }) {
  const map = new Map<string, ChainOutputEntry>(
    Object.entries(outputs).map(([name, text]) => [name, entry(text)])
  );
  const base = { previous, outputs: map };
  return item ? { ...base, item: item.value } : base;
}

describe('renderTaskTemplate', () => {
  it('replaces {previous} verbatim', () => {
    const res = renderTaskTemplate('Echo: {previous}', ctx('hello'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toBe('Echo: hello');
  });

  it('replaces every {outputs.<name>} from the outputs map', () => {
    const res = renderTaskTemplate(
      'Plan: {outputs.plan}; Prev: {previous}',
      ctx('p', { plan: 'P' })
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toBe('Plan: P; Prev: p');
  });

  it('supports multiple references to the same name', () => {
    const res = renderTaskTemplate('{outputs.x}-{outputs.x}', ctx('', { x: 'A' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toBe('A-A');
  });

  it('reports the first unknown output and does not substitute anything', () => {
    const res = renderTaskTemplate('Use {outputs.missing} now', ctx(''));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.unknown).toBe('missing');
  });

  it('leaves text untouched when neither token appears', () => {
    const res = renderTaskTemplate('plain text', ctx(''));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toBe('plain text');
  });

  it('treats nested-looking names as flat keys (no hierarchy lookup)', () => {
    const res = renderTaskTemplate('{outputs.a.b}', ctx('', { 'a.b': 'flat' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toBe('flat');
  });

  it('replaces {item} with a string verbatim', () => {
    const res = renderTaskTemplate('Process {item}', ctx('', {}, { value: 'a.ts' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.text).toBe('Process a.ts');
  });

  it('serializes object/array items as JSON', () => {
    const obj = renderTaskTemplate('{item}', ctx('', {}, { value: { path: 'a.ts' } }));
    expect(obj.ok).toBe(true);
    if (obj.ok) expect(obj.text).toBe('{"path":"a.ts"}');
    const arr = renderTaskTemplate('{item}', ctx('', {}, { value: [1, 2] }));
    expect(arr.ok).toBe(true);
    if (arr.ok) expect(arr.text).toBe('[1,2]');
  });

  it('renders null item as the literal null', () => {
    const nullRes = renderTaskTemplate('{item}', ctx('', {}, { value: null }));
    expect(nullRes.ok).toBe(true);
    if (nullRes.ok) expect(nullRes.text).toBe('null');
  });

  it('reports {item} as unknown when no item is in context', () => {
    const res = renderTaskTemplate('{item}', ctx(''));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.unknown).toBe('item');
  });
});
