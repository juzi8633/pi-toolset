// ABOUTME: JSON Pointer reader for dynamic fanout expansion over structured chain outputs.
// ABOUTME: Supports RFC6901-style path segments and returns explicit errors instead of throwing.

import type { JsonValue } from './structured-output.ts';

export type JsonPointerResult = { ok: true; value: JsonValue } | { ok: false; error: string };

function decodeSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function readJsonPointer(value: JsonValue, pointer: string): JsonPointerResult {
  if (pointer === '') return { ok: true, value };
  if (!pointer.startsWith('/')) return { ok: false, error: `Invalid JSON Pointer: ${pointer}` };

  let current: JsonValue = value;
  const segments = pointer.slice(1).split('/').map(decodeSegment);
  const traversed: string[] = [];

  for (const segment of segments) {
    traversed.push(segment);
    const path = `/${traversed.join('/')}`;
    if (Array.isArray(current)) {
      if (!/^0$|^[1-9]\d*$/.test(segment)) {
        return { ok: false, error: `Missing path segment ${path}: expected array index` };
      }
      const index = Number(segment);
      if (index < 0 || index >= current.length) {
        return { ok: false, error: `Missing path segment ${path}` };
      }
      current = current[index];
      continue;
    }
    if (current && typeof current === 'object') {
      const obj = current as Record<string, JsonValue>;
      if (!Object.prototype.hasOwnProperty.call(obj, segment)) {
        return { ok: false, error: `Missing path segment ${path}` };
      }
      current = obj[segment];
      continue;
    }
    return { ok: false, error: `Missing path segment ${path}: cannot traverse ${typeof current}` };
  }

  return { ok: true, value: current };
}
