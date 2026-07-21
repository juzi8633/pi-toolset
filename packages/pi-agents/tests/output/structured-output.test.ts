// ABOUTME: Tests for structured output helpers — JSON extraction modes and the JSON Schema subset validator.
// ABOUTME: Covers required fields, type checks, additionalProperties, arrays, enums, and integer semantics.

import { describe, expect, it } from 'bun:test';
import {
  buildStructuredOutputInstruction,
  extractJsonFromFinalOutput,
  validateStructuredOutput,
  type JsonSchemaSubset,
} from '../../src/output/structured-output.ts';

describe('extractJsonFromFinalOutput', () => {
  it('parses bare JSON output', () => {
    const res = extractJsonFromFinalOutput('{"a":1}');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ a: 1 });
  });

  it('parses a fenced ```json block', () => {
    const res = extractJsonFromFinalOutput('```json\n{"a":1}\n```');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ a: 1 });
  });

  it('parses a fenced bare block (no language)', () => {
    const res = extractJsonFromFinalOutput('```\n{"a":1}\n```');
    expect(res.ok).toBe(true);
  });

  it('rejects Markdown prose around JSON', () => {
    const res = extractJsonFromFinalOutput('Here is JSON: {"a":1}');
    expect(res.ok).toBe(false);
  });

  it('rejects non-json fenced language', () => {
    const res = extractJsonFromFinalOutput('```yaml\na: 1\n```');
    expect(res.ok).toBe(false);
  });

  it('rejects empty output', () => {
    const res = extractJsonFromFinalOutput('   \n');
    expect(res.ok).toBe(false);
  });
});

describe('validateStructuredOutput', () => {
  it('passes a fully valid object', () => {
    const schema: JsonSchemaSubset = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    };
    expect(validateStructuredOutput({ name: 'a' }, schema)).toEqual([]);
  });

  it('reports missing required fields', () => {
    const schema: JsonSchemaSubset = {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    };
    const errors = validateStructuredOutput({}, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('$.name');
    expect(errors[0]).toContain('missing required');
  });

  it('reports array element type mismatch', () => {
    const schema: JsonSchemaSubset = {
      type: 'array',
      items: { type: 'string' },
    };
    const errors = validateStructuredOutput(['ok', 7], schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('$[1]');
    expect(errors[0]).toContain('expected string');
  });

  it('honors additionalProperties: false', () => {
    const schema: JsonSchemaSubset = {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    };
    const errors = validateStructuredOutput({ a: 'x', extra: 1 }, schema);
    expect(errors.some((e) => e.includes('$.extra'))).toBe(true);
  });

  it('accepts enum match and rejects non-members', () => {
    const schema: JsonSchemaSubset = { enum: ['a', 'b', 'c'] };
    expect(validateStructuredOutput('a', schema)).toEqual([]);
    const errors = validateStructuredOutput('z', schema);
    expect(errors[0]).toContain('not in enum');
  });

  it('integer type rejects floats', () => {
    const schema: JsonSchemaSubset = { type: 'integer' };
    expect(validateStructuredOutput(3, schema)).toEqual([]);
    expect(validateStructuredOutput(3.5, schema)).toHaveLength(1);
  });

  it('reports nested validation errors with array+object pointer paths', () => {
    const schema: JsonSchemaSubset = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: ['path'],
            properties: { path: { type: 'string' } },
          },
        },
      },
    };
    const errors = validateStructuredOutput({ items: [{ path: 'ok' }, {}] }, schema);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('$.items[1].path');
  });

  it('checks minItems / maxItems', () => {
    const schema: JsonSchemaSubset = { type: 'array', minItems: 1, maxItems: 2 };
    expect(validateStructuredOutput([], schema)[0]).toContain('at least 1');
    expect(validateStructuredOutput([1, 2, 3], schema)[0]).toContain('at most 2');
  });

  it('rejects unsupported schema.type values', () => {
    const schema = { type: 'objectt' } as unknown as JsonSchemaSubset;
    const errors = validateStructuredOutput({ a: 1 }, schema);
    expect(errors[0]).toContain('unsupported schema.type');
  });

  it('rejects malformed keyword shapes even when type is omitted', () => {
    expect(
      validateStructuredOutput({}, { properties: [] } as unknown as JsonSchemaSubset)[0]
    ).toContain('schema.properties must be an object');
    expect(validateStructuredOutput([], { items: [] } as unknown as JsonSchemaSubset)[0]).toContain(
      'schema.items must be a schema object'
    );
  });

  it('uses own-property checks for required and additionalProperties (no prototype leakage)', () => {
    const requiredSchema: JsonSchemaSubset = {
      type: 'object',
      required: ['toString'],
      properties: { toString: { type: 'string' as const } },
    };
    const requiredErrors = validateStructuredOutput({}, requiredSchema);
    expect(requiredErrors[0]).toContain('missing required');

    const additionalSchema: JsonSchemaSubset = {
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    };
    const additionalErrors = validateStructuredOutput(
      { name: 'a', toString: 'x' },
      additionalSchema
    );
    expect(additionalErrors.some((e) => e.includes('$.toString'))).toBe(true);
  });
});

describe('buildStructuredOutputInstruction', () => {
  it('returns text containing the schema and a JSON-only directive', () => {
    const text = buildStructuredOutputInstruction({ type: 'object' });
    expect(text).toContain('JSON');
    expect(text).toContain('"type": "object"');
  });
});
