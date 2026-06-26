// ABOUTME: Tests for renderTaskTemplate — handles {previous} and {outputs.<name>} substitution.
// ABOUTME: Asserts the unknown-output error path stops template expansion before spawning.

import { describe, expect, it } from 'bun:test';
import { renderTaskTemplate } from '../src/template.ts';

function ctx(previous: string, outputs: Record<string, string> = {}) {
  return {
    previous,
    outputs: new Map(Object.entries(outputs)),
  };
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
});
