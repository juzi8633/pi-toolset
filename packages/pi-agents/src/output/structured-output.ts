// ABOUTME: Structured output helpers — JSON extraction, JSON Schema subset validation, prompt instruction builder.
// ABOUTME: Used by chain steps and fanout sub-tasks to enforce machine-readable final outputs without new deps.

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface JsonSchemaSubset {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, JsonSchemaSubset>;
  required?: string[];
  items?: JsonSchemaSubset;
  enum?: JsonValue[];
  additionalProperties?: boolean;
  minItems?: number;
  maxItems?: number;
}

const FENCE_RE = /^```(\w*)\s*\n([\s\S]*?)\n```$/;

export function extractJsonFromFinalOutput(
  text: string
): { ok: true; value: JsonValue } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: 'Output is empty; expected JSON.' };
  }

  const fenceMatch = trimmed.match(FENCE_RE);
  let candidate = trimmed;
  if (fenceMatch) {
    const lang = fenceMatch[1].trim().toLowerCase();
    if (lang !== '' && lang !== 'json') {
      return {
        ok: false,
        error: `Code fence language must be "json" or empty; got "${fenceMatch[1]}".`,
      };
    }
    candidate = fenceMatch[2].trim();
  }

  try {
    const parsed = JSON.parse(candidate) as JsonValue;
    return { ok: true, value: parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to parse JSON: ${message}` };
  }
}

function describeType(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isPlainObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function validateStructuredOutput(value: JsonValue, schema: JsonSchemaSubset): string[] {
  const errors: string[] = [];
  try {
    walk(value, schema, '$', errors);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`$: schema evaluation failed: ${message}`);
  }
  return errors;
}

function walk(value: JsonValue, schema: JsonSchemaSubset, pointer: string, errors: string[]): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    errors.push(`${pointer}: invalid schema node`);
    return;
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) {
      errors.push(`${pointer}: schema.enum must be an array`);
      return;
    }
    if (schema.enum.length > 0) {
      const matched = schema.enum.some((candidate) => jsonEquals(candidate, value));
      if (!matched) {
        errors.push(`${pointer}: value not in enum`);
        return;
      }
    }
  }
  if (schema.properties !== undefined && !isPlainObject(schema.properties as JsonValue)) {
    errors.push(`${pointer}: schema.properties must be an object`);
    return;
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    errors.push(`${pointer}: schema.required must be an array`);
    return;
  }
  if (schema.items !== undefined) {
    if (!schema.items || typeof schema.items !== 'object' || Array.isArray(schema.items)) {
      errors.push(`${pointer}: schema.items must be a schema object`);
      return;
    }
  }

  if (schema.type !== undefined) {
    const allowed = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
    if (typeof schema.type !== 'string' || !allowed.includes(schema.type)) {
      errors.push(`${pointer}: unsupported schema.type "${String(schema.type)}"`);
      return;
    }
  }

  switch (schema.type) {
    case 'object':
      validateObject(value, schema, pointer, errors);
      return;
    case 'array':
      validateArray(value, schema, pointer, errors);
      return;
    case 'string':
      if (typeof value !== 'string') errors.push(`${pointer}: expected string`);
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value))
        errors.push(`${pointer}: expected number`);
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value))
        errors.push(`${pointer}: expected integer`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${pointer}: expected boolean`);
      return;
    case 'null':
      if (value !== null) errors.push(`${pointer}: expected null`);
      return;
    default:
      return;
  }
}

function validateObject(
  value: JsonValue,
  schema: JsonSchemaSubset,
  pointer: string,
  errors: string[]
): void {
  if (!isPlainObject(value)) {
    errors.push(`${pointer}: expected object, got ${describeType(value)}`);
    return;
  }
  const properties = schema.properties ?? {};
  if (schema.required) {
    for (const key of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${pointer}.${key}: missing required property`);
      }
    }
  }
  for (const key of Object.keys(value)) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      walk(value[key], properties[key], `${pointer}.${key}`, errors);
    } else if (schema.additionalProperties === false) {
      errors.push(`${pointer}.${key}: additional property not allowed`);
    }
  }
}

function validateArray(
  value: JsonValue,
  schema: JsonSchemaSubset,
  pointer: string,
  errors: string[]
): void {
  if (!Array.isArray(value)) {
    errors.push(`${pointer}: expected array, got ${describeType(value)}`);
    return;
  }
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    errors.push(`${pointer}: expected at least ${schema.minItems} items, got ${value.length}`);
  }
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    errors.push(`${pointer}: expected at most ${schema.maxItems} items, got ${value.length}`);
  }
  if (schema.items !== undefined) {
    for (let i = 0; i < value.length; i++) {
      walk(value[i], schema.items, `${pointer}[${i}]`, errors);
    }
  }
}

export function buildStructuredOutputInstruction(schema: JsonSchemaSubset): string {
  const formatted = JSON.stringify(schema, null, 2);
  return [
    'IMPORTANT: Your final assistant message MUST be a single JSON value that exactly matches the schema below.',
    'Do not include Markdown, prose, explanations, or code fences. Emit JSON only.',
    '',
    'Schema:',
    formatted,
  ].join('\n');
}
