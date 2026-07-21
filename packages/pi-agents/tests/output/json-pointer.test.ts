// ABOUTME: Tests for JSON Pointer reads used by dynamic fanout expansion.
// ABOUTME: Covers root, arrays, object properties, RFC6901 escapes, and missing path errors.

import { describe, expect, it } from 'bun:test';
import { readJsonPointer } from '../../src/output/json-pointer.ts';

describe('readJsonPointer', () => {
  const value = {
    items: [{ path: 'a.ts' }, { path: 'b.ts' }],
    nested: { 'a/b': { 'c~d': 7 } },
  };

  it('returns the root for an empty pointer', () => {
    const res = readJsonPointer(value, '');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual(value);
  });

  it('reads object properties and array indices', () => {
    const res = readJsonPointer(value, '/items/1/path');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe('b.ts');
  });

  it('supports ~1 and ~0 escaping', () => {
    const res = readJsonPointer(value, '/nested/a~1b/c~0d');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(7);
  });

  it('reports missing object properties', () => {
    const res = readJsonPointer(value, '/items/2/path');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('/items/2');
  });

  it('rejects invalid pointers', () => {
    const res = readJsonPointer(value, 'items/0');
    expect(res.ok).toBe(false);
  });
});
