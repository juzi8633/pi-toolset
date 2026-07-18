// ABOUTME: Incremental LF JSONL projector that validates Pi RPC records and emits bounded shells.
// ABOUTME: Grants a 64 MiB budget only to exact-prefix canonical replayable Pi 0.80.9 events.

import {
  MAX_PROJECTABLE_RPC_RECORD_BYTES,
  MAX_STDOUT_RECORD_BYTES,
  RPC_JSON_MAX_DEPTH,
  RPC_PREFIX_PROBE_BYTES,
  RPC_PROJECTED_SHELL_FIELD_MAX_BYTES,
} from './constants.ts';

export interface CompactPiRpcAgentEnd {
  type: 'agent_end';
  messages: [];
  messagesOmitted: true;
  willRetry: boolean;
}

export interface CompactPiRpcMessageEvent {
  type: 'message_start' | 'message_update' | 'message_end';
  payloadOmitted: true;
  role: string;
}

export interface CompactPiRpcToolEvent {
  type: 'tool_execution_start' | 'tool_execution_update' | 'tool_execution_end';
  payloadOmitted: true;
  toolCallId: string;
  toolName: string;
  isError?: boolean;
}

export interface CompactPiRpcTurnEnd {
  type: 'turn_end';
  payloadOmitted: true;
}

export type CompactPiRpcReplayableEvent =
  CompactPiRpcAgentEnd | CompactPiRpcMessageEvent | CompactPiRpcToolEvent | CompactPiRpcTurnEnd;

export type PiRpcProjectedRecord =
  | { kind: 'ordinary'; line: string; bytes: number }
  | {
      kind: 'projected';
      event: CompactPiRpcReplayableEvent;
      bytes: number;
      requiresSettleRehydrate: boolean;
    };

export interface PiRpcRecordProjectorLimits {
  ordinaryMaxBytes?: number;
  projectableMaxBytes?: number;
  prefixProbeBytes?: number;
  shellFieldMaxBytes?: number;
  maxDepth?: number;
}

export interface PiRpcRecordProjector {
  push(chunk: Buffer | string): PiRpcProjectedRecord[];
  finish(): PiRpcProjectedRecord[];
}

export class PiRpcProjectorError extends Error {
  readonly code: 'stdout_overflow' | 'malformed_json';
  /** Complete records already validated in the same push/finish before the failure. */
  readonly priorRecords: PiRpcProjectedRecord[];

  constructor(
    code: 'stdout_overflow' | 'malformed_json',
    message: string,
    priorRecords: PiRpcProjectedRecord[] = []
  ) {
    super(message);
    this.name = 'PiRpcProjectorError';
    this.code = code;
    this.priorRecords = priorRecords;
  }
}

type ProjectableType =
  | 'agent_end'
  | 'message_start'
  | 'message_update'
  | 'message_end'
  | 'turn_end'
  | 'tool_execution_start'
  | 'tool_execution_update'
  | 'tool_execution_end';

const PROJECTABLE_PREFIXES: Record<ProjectableType, readonly string[]> = {
  agent_end: ['type', 'messages', 'willRetry'],
  message_start: ['type', 'message'],
  message_update: ['type', 'assistantMessageEvent', 'message'],
  message_end: ['type', 'message'],
  turn_end: ['type', 'message', 'toolResults'],
  tool_execution_start: ['type', 'toolCallId', 'toolName', 'args'],
  tool_execution_update: ['type', 'toolCallId', 'toolName', 'args', 'partialResult'],
  tool_execution_end: ['type', 'toolCallId', 'toolName', 'result', 'isError'],
};

const PROJECTABLE_TYPE_SET = new Set<string>(Object.keys(PROJECTABLE_PREFIXES));

const REHYDRATE_TYPES = new Set<ProjectableType>([
  'message_start',
  'message_update',
  'message_end',
  'turn_end',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
]);

interface ResolvedLimits {
  ordinaryMaxBytes: number;
  projectableMaxBytes: number;
  prefixProbeBytes: number;
  shellFieldMaxBytes: number;
  maxDepth: number;
}

type FrameKind = 'object' | 'array';

interface Frame {
  kind: FrameKind;
  /** True only for the root object. */
  topLevel: boolean;
  /** For objects: keys seen (top-level only uses this for prefix checks). */
  keys: string[];
  /** For arrays: number of complete elements seen. */
  elementCount: number;
  /** Current object key awaiting/receiving its value. */
  currentKey?: string;
}

type Mode =
  | 'start'
  | 'value'
  | 'object_key'
  | 'object_colon'
  | 'object_next'
  | 'array_value'
  | 'array_next'
  | 'string'
  | 'escape'
  | 'unicode'
  | 'number'
  | 'literal'
  | 'done';

export function createPiRpcRecordProjector(
  limits?: PiRpcRecordProjectorLimits
): PiRpcRecordProjector {
  const resolved: ResolvedLimits = {
    ordinaryMaxBytes: limits?.ordinaryMaxBytes ?? MAX_STDOUT_RECORD_BYTES,
    projectableMaxBytes: limits?.projectableMaxBytes ?? MAX_PROJECTABLE_RPC_RECORD_BYTES,
    prefixProbeBytes: limits?.prefixProbeBytes ?? RPC_PREFIX_PROBE_BYTES,
    shellFieldMaxBytes: limits?.shellFieldMaxBytes ?? RPC_PROJECTED_SHELL_FIELD_MAX_BYTES,
    maxDepth: limits?.maxDepth ?? RPC_JSON_MAX_DEPTH,
  };

  let carry = Buffer.alloc(0);
  let lineBuf = '';
  let active: JsonRecordParser | null = null;
  let failed = false;

  const decodeChunk = (chunk: Buffer | string): string => {
    if (typeof chunk === 'string') {
      if (carry.length > 0) {
        const text = carry.toString('utf8') + chunk;
        carry = Buffer.alloc(0);
        return text;
      }
      return chunk;
    }
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    let end = buf.length;
    // Retain incomplete trailing UTF-8 sequence.
    if (end > 0) {
      let i = end - 1;
      let cont = 0;
      while (i >= 0 && (buf[i]! & 0b1100_0000) === 0b1000_0000) {
        cont++;
        i--;
      }
      if (i >= 0) {
        const lead = buf[i]!;
        const need =
          (lead & 0b1000_0000) === 0
            ? 1
            : (lead & 0b1110_0000) === 0b1100_0000
              ? 2
              : (lead & 0b1111_0000) === 0b1110_0000
                ? 3
                : (lead & 0b1111_1000) === 0b1111_0000
                  ? 4
                  : 1;
        const have = cont + 1;
        if (have < need) end = i;
      }
    }
    carry = end < buf.length ? Buffer.from(buf.subarray(end)) : Buffer.alloc(0);
    return buf.subarray(0, end).toString('utf8');
  };

  const pushText = (text: string, out: PiRpcProjectedRecord[]): void => {
    let offset = 0;
    while (offset < text.length) {
      if (!active) active = new JsonRecordParser(resolved);

      const nl = text.indexOf('\n', offset);
      const end = nl === -1 ? text.length : nl;
      const piece = text.slice(offset, end);
      active.push(piece);
      if (active.retainsLine) lineBuf += piece;
      else lineBuf = '';

      if (nl === -1) return;

      // Complete record at LF.
      let line = lineBuf;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const result = active.finish(line);
      out.push(result);
      active = null;
      lineBuf = '';
      offset = nl + 1;
    }
  };

  const rethrowWithPrior = (err: unknown, out: PiRpcProjectedRecord[]): never => {
    failed = true;
    if (err instanceof PiRpcProjectorError) {
      throw new PiRpcProjectorError(err.code, err.message, out);
    }
    throw err;
  };

  return {
    push(chunk: Buffer | string): PiRpcProjectedRecord[] {
      if (failed) return [];
      const out: PiRpcProjectedRecord[] = [];
      try {
        pushText(decodeChunk(chunk), out);
        return out;
      } catch (err) {
        throw rethrowWithPrior(err, out);
      }
    },

    finish(): PiRpcProjectedRecord[] {
      if (failed) return [];
      const out: PiRpcProjectedRecord[] = [];
      try {
        if (carry.length > 0) {
          const text = carry.toString('utf8');
          carry = Buffer.alloc(0);
          pushText(text, out);
        }
        if (active || lineBuf.length > 0) {
          if (!active) active = new JsonRecordParser(resolved);
          if (lineBuf.length > 0 && active.retainsLine && active.byteLength === 0) {
            // finish() with only buffered line text not yet pushed through parser
            // (should not happen — push always feeds active). Re-feed for safety.
            active.push(lineBuf);
          }
          let line = lineBuf;
          if (line.endsWith('\r')) line = line.slice(0, -1);
          out.push(active.finish(line));
          active = null;
          lineBuf = '';
        }
        return out;
      } catch (err) {
        throw rethrowWithPrior(err, out);
      }
    },
  };
}

class JsonRecordParser {
  private readonly limits: ResolvedLimits;
  private mode: Mode = 'start';
  private readonly stack: Frame[] = [];
  private recordedBytes = 0;
  private line = '';
  private droppedLine = false;
  private projectableBudget = false;
  private sawValue = false;

  // Shell capture
  private revoked = false;
  private knownOrdinary = false;
  private projectableType?: ProjectableType;
  private topLevelKeys: string[] = [];
  private willRetry?: boolean;
  private role?: string;
  private toolCallId?: string;
  private toolName?: string;
  private isError?: boolean;

  // Bulk-field structural type tracking (token kind only, no payload retained).
  // Keys are canonical top-level field names; values are the first JSON token
  // kind observed for that field's value (object/array/string/number/boolean/null).
  private readonly bulkFieldShapes = new Map<
    string,
    'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'
  >();

  // String state
  private stringKind: 'key' | 'value' = 'value';
  private stringCapture: 'shell' | 'role' | 'none' = 'none';
  private stringBuf = '';
  private stringBytes = 0;
  private stringOverflow = false;
  private unicodeBuf = '';

  // Number / literal
  private tokenBuf = '';

  constructor(limits: ResolvedLimits) {
    this.limits = limits;
  }

  get retainsLine(): boolean {
    return !this.droppedLine;
  }

  get byteLength(): number {
    return this.recordedBytes;
  }

  push(text: string): void {
    // Iterate Unicode code points so non-BMP scalars count as one UTF-8 sequence.
    const chars = Array.from(text);
    for (let i = 0; i < chars.length;) {
      const ch = chars[i]!;
      const consumed = this.consume(ch);
      // consume returns false when the character must be reprocessed under a new mode
      // (number/literal terminator). In that case do not advance.
      if (consumed) i++;
    }
  }

  finish(retainedLine: string): PiRpcProjectedRecord {
    if (this.mode === 'number') this.endNumber();
    else if (this.mode === 'literal') this.endLiteral();

    if (
      this.mode === 'string' ||
      this.mode === 'escape' ||
      this.mode === 'unicode' ||
      this.mode !== 'done' ||
      this.stack.length !== 0 ||
      !this.sawValue
    ) {
      throw new PiRpcProjectorError('malformed_json', 'Incomplete or invalid JSON RPC record');
    }

    if (this.canProject()) {
      if (this.recordedBytes > this.limits.ordinaryMaxBytes || this.droppedLine) {
        return {
          kind: 'projected',
          event: this.buildShell(),
          bytes: this.recordedBytes,
          requiresSettleRehydrate: REHYDRATE_TYPES.has(this.projectableType!),
        };
      }
    }

    if (this.recordedBytes > this.limits.ordinaryMaxBytes || this.droppedLine) {
      throw new PiRpcProjectorError('stdout_overflow', 'RPC stdout record exceeded 8 MiB');
    }

    return {
      kind: 'ordinary',
      line: retainedLine.length > 0 ? retainedLine : this.line,
      bytes: this.recordedBytes,
    };
  }

  /**
   * @returns true if `ch` was consumed; false if caller must reprocess `ch`.
   */
  private consume(ch: string): boolean {
    switch (this.mode) {
      case 'start':
        this.note(ch);
        if (isWs(ch)) return true;
        this.beginValue(ch);
        return true;

      case 'done':
        this.note(ch);
        if (isWs(ch)) return true;
        throw new PiRpcProjectorError('malformed_json', 'Trailing data after JSON RPC record');

      case 'value':
      case 'array_value':
        this.note(ch);
        if (isWs(ch)) return true;
        // Empty array `[]` only — after a comma `array_value` requires a value (no trailing comma).
        if (ch === ']' && this.mode === 'array_value') {
          const frame = this.stack[this.stack.length - 1];
          if (frame && frame.kind === 'array' && frame.elementCount === 0) {
            this.closeContainer();
            return true;
          }
          throw new PiRpcProjectorError('malformed_json', 'Trailing comma in JSON array');
        }
        this.beginValue(ch);
        return true;

      case 'object_key':
        this.note(ch);
        if (isWs(ch)) return true;
        // Empty object `{}` is allowed only when no keys have been seen yet.
        // After a comma (trailing comma) a key is required — `}` is malformed.
        if (ch === '}') {
          const frame = this.stack[this.stack.length - 1];
          if (frame && frame.keys.length === 0) {
            this.closeContainer();
            return true;
          }
          throw new PiRpcProjectorError('malformed_json', 'Trailing comma in JSON object');
        }
        if (ch === '"') {
          this.stringKind = 'key';
          this.stringCapture = 'none';
          this.resetString();
          this.mode = 'string';
          return true;
        }
        throw new PiRpcProjectorError('malformed_json', 'Expected string key in JSON object');

      case 'object_colon':
        this.note(ch);
        if (isWs(ch)) return true;
        if (ch === ':') {
          this.mode = 'value';
          return true;
        }
        throw new PiRpcProjectorError('malformed_json', 'Expected colon after object key');

      case 'object_next':
        this.note(ch);
        if (isWs(ch)) return true;
        if (ch === ',') {
          this.mode = 'object_key';
          return true;
        }
        if (ch === '}') {
          this.closeContainer();
          return true;
        }
        throw new PiRpcProjectorError('malformed_json', 'Expected comma or }} after object value');

      case 'array_next':
        this.note(ch);
        if (isWs(ch)) return true;
        if (ch === ',') {
          this.mode = 'array_value';
          return true;
        }
        if (ch === ']') {
          this.closeContainer();
          return true;
        }
        throw new PiRpcProjectorError('malformed_json', 'Expected comma or ] after array value');

      case 'string':
        this.note(ch);
        this.consumeString(ch);
        return true;

      case 'escape':
        this.note(ch);
        this.consumeEscape(ch);
        return true;

      case 'unicode':
        this.note(ch);
        this.consumeUnicode(ch);
        return true;

      case 'number':
        if (isNumberContinue(ch)) {
          this.note(ch);
          this.tokenBuf += ch;
          return true;
        }
        this.endNumber();
        return false; // reprocess terminator

      case 'literal':
        if (ch >= 'a' && ch <= 'z') {
          this.note(ch);
          this.tokenBuf += ch;
          if (this.tokenBuf === 'true' || this.tokenBuf === 'false' || this.tokenBuf === 'null') {
            this.endLiteral();
            return true;
          }
          if (!['true', 'false', 'null'].some((l) => l.startsWith(this.tokenBuf))) {
            throw new PiRpcProjectorError(
              'malformed_json',
              `Invalid JSON literal '${this.tokenBuf}'`
            );
          }
          return true;
        }
        this.endLiteral();
        return false;

      default:
        throw new PiRpcProjectorError('malformed_json', 'Invalid projector state');
    }
  }

  private note(ch: string): void {
    const n = Buffer.byteLength(ch, 'utf8');
    this.recordedBytes += n;
    if (!this.droppedLine) this.line += ch;
    this.enforceBudgets();
  }

  private enforceBudgets(): void {
    if (this.projectableBudget) {
      // If projectability was revoked after the budget switch, fail closed at ordinary.
      if (this.revoked || this.knownOrdinary || !this.isKnownProjectablePrefix()) {
        throw new PiRpcProjectorError('stdout_overflow', 'RPC stdout record exceeded 8 MiB');
      }
      if (this.recordedBytes > this.limits.projectableMaxBytes) {
        throw new PiRpcProjectorError('stdout_overflow', 'RPC stdout record exceeded 8 MiB');
      }
      return;
    }
    if (this.recordedBytes <= this.limits.ordinaryMaxBytes) return;

    // Grant the projectable budget only after a known projectable type and valid prefix.
    // Unknown / non-canonical records fail at the ordinary 8 MiB boundary.
    if (this.isKnownProjectablePrefix()) {
      this.projectableBudget = true;
      this.droppedLine = true;
      this.line = '';
      if (this.recordedBytes > this.limits.projectableMaxBytes) {
        throw new PiRpcProjectorError('stdout_overflow', 'RPC stdout record exceeded 8 MiB');
      }
      return;
    }
    throw new PiRpcProjectorError('stdout_overflow', 'RPC stdout record exceeded 8 MiB');
  }

  /** True only when type is a known projectable event and top-level keys match its prefix so far. */
  private isKnownProjectablePrefix(): boolean {
    if (this.revoked || this.knownOrdinary || !this.projectableType) return false;
    const expected = PROJECTABLE_PREFIXES[this.projectableType];
    for (let i = 0; i < this.topLevelKeys.length; i++) {
      if (i >= expected.length || this.topLevelKeys[i] !== expected[i]) return false;
    }
    return true;
  }

  private beginValue(ch: string): void {
    // Track bulk-field structural type at the top level (token kind only).
    this.recordBulkFieldShape(ch);
    if (ch === '{') {
      this.openContainer('object');
      return;
    }
    if (ch === '[') {
      this.openContainer('array');
      return;
    }
    if (ch === '"') {
      this.stringKind = 'value';
      this.stringCapture = this.decideStringCapture();
      this.resetString();
      this.mode = 'string';
      return;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      this.tokenBuf = ch;
      this.mode = 'number';
      return;
    }
    if (ch === 't' || ch === 'f' || ch === 'n') {
      this.tokenBuf = ch;
      this.mode = 'literal';
      return;
    }
    throw new PiRpcProjectorError('malformed_json', `Unexpected character in JSON value`);
  }

  private openContainer(kind: FrameKind): void {
    if (this.stack.length + 1 > this.limits.maxDepth) {
      throw new PiRpcProjectorError('malformed_json', 'JSON depth exceeded in RPC record');
    }
    const topLevel = this.stack.length === 0 && kind === 'object';
    this.stack.push({ kind, topLevel, keys: [], elementCount: 0 });
    this.mode = kind === 'object' ? 'object_key' : 'array_value';
  }

  /** Canonical top-level bulk fields whose structural token kind is validated. */
  private static readonly BULK_FIELD_KEYS = new Set([
    'messages',
    'toolResults',
    'message',
    'assistantMessageEvent',
    'args',
    'partialResult',
    'result',
  ]);

  /** Top-level bulk fields that must be arrays. */
  private static readonly ARRAY_BULK_FIELDS = new Set(['messages', 'toolResults']);

  /** Top-level bulk fields that must be non-array objects. */
  private static readonly OBJECT_BULK_FIELDS = new Set(['message', 'assistantMessageEvent']);

  private recordBulkFieldShape(ch: string): void {
    const frame = this.stack[this.stack.length - 1];
    if (!frame || !frame.topLevel || frame.kind !== 'object') return;
    const key = frame.currentKey;
    if (!key || !JsonRecordParser.BULK_FIELD_KEYS.has(key)) return;
    // Only record the first token kind observed for this field value.
    if (this.bulkFieldShapes.has(key)) return;
    let kind: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null' | undefined;
    if (ch === '{') kind = 'object';
    else if (ch === '[') kind = 'array';
    else if (ch === '"') kind = 'string';
    else if (ch === '-' || (ch >= '0' && ch <= '9')) kind = 'number';
    else if (ch === 't' || ch === 'f') kind = 'boolean';
    else if (ch === 'n') kind = 'null';
    if (kind === undefined) return;
    this.bulkFieldShapes.set(key, kind);
    // Revoke projectability immediately on a constrained wrong kind so a scalar
    // or wrong container cannot receive the 64 MiB projectable budget.
    if (
      (JsonRecordParser.ARRAY_BULK_FIELDS.has(key) && kind !== 'array') ||
      (JsonRecordParser.OBJECT_BULK_FIELDS.has(key) && kind !== 'object')
    ) {
      this.revokeProjectability();
    }
  }

  private closeContainer(): void {
    if (this.stack.length === 0) {
      throw new PiRpcProjectorError('malformed_json', 'Unbalanced JSON container');
    }
    this.stack.pop();
    this.afterValue();
  }

  private decideStringCapture(): 'shell' | 'role' | 'none' {
    const frame = this.stack[this.stack.length - 1];
    if (!frame || frame.kind !== 'object') return 'none';
    const key = frame.currentKey;
    if (frame.topLevel) {
      if (key === 'type' || key === 'toolCallId' || key === 'toolName') return 'shell';
      return 'none';
    }
    // Nested message.role under top-level "message".
    if (
      key === 'role' &&
      this.stack.length === 2 &&
      this.stack[0]?.topLevel &&
      this.stack[0]?.currentKey === 'message'
    ) {
      return 'role';
    }
    return 'none';
  }

  private resetString(): void {
    this.stringBuf = '';
    this.stringBytes = 0;
    this.stringOverflow = false;
    this.unicodeBuf = '';
  }

  private consumeString(ch: string): void {
    if (ch === '\\') {
      this.mode = 'escape';
      return;
    }
    if (ch === '"') {
      this.endString();
      return;
    }
    if (ch.charCodeAt(0) < 0x20) {
      throw new PiRpcProjectorError('malformed_json', 'Unescaped control character in JSON string');
    }
    this.appendString(ch);
  }

  private consumeEscape(ch: string): void {
    const map: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    if (ch === 'u') {
      this.unicodeBuf = '';
      this.mode = 'unicode';
      return;
    }
    const mapped = map[ch];
    if (mapped === undefined) {
      throw new PiRpcProjectorError('malformed_json', `Invalid JSON escape \\${ch}`);
    }
    this.appendString(mapped);
    this.mode = 'string';
  }

  private consumeUnicode(ch: string): void {
    if (!/[0-9a-fA-F]/.test(ch)) {
      throw new PiRpcProjectorError('malformed_json', 'Invalid \\u escape in JSON string');
    }
    this.unicodeBuf += ch;
    if (this.unicodeBuf.length < 4) return;
    this.appendString(String.fromCharCode(parseInt(this.unicodeBuf, 16)));
    this.mode = 'string';
  }

  private appendString(ch: string): void {
    if (this.stringCapture === 'none' && this.stringKind === 'value') return;
    const n = Buffer.byteLength(ch, 'utf8');
    this.stringBytes += n;
    if (
      (this.stringCapture === 'shell' || this.stringCapture === 'role') &&
      this.stringBytes > this.limits.shellFieldMaxBytes
    ) {
      this.stringOverflow = true;
      this.stringBuf = '';
      this.stringCapture = 'none';
      return;
    }
    if (this.stringKind === 'key' || this.stringCapture !== 'none') {
      this.stringBuf += ch;
    }
  }

  private endString(): void {
    if (this.stringKind === 'key') {
      const key = this.stringBuf;
      const frame = this.stack[this.stack.length - 1];
      if (!frame || frame.kind !== 'object') {
        throw new PiRpcProjectorError('malformed_json', 'Object key outside object');
      }
      if (frame.keys.includes(key)) {
        // Duplicate keys: JSON.parse accepts them; revoke projectability only.
        this.revokeProjectability();
      } else {
        frame.keys.push(key);
      }
      frame.currentKey = key;
      if (frame.topLevel) {
        if (this.topLevelKeys.includes(key)) this.revokeProjectability();
        else this.topLevelKeys.push(key);
        this.validatePrefix();
      }
      this.mode = 'object_colon';
      return;
    }

    // Value string.
    if (this.stringOverflow) {
      this.revokeProjectability();
    } else if (this.stringCapture === 'shell') {
      this.captureShellString(this.stringBuf);
    } else if (this.stringCapture === 'role') {
      this.role = this.stringBuf;
    }
    this.afterValue();
  }

  private captureShellString(value: string): void {
    const frame = this.stack[this.stack.length - 1];
    const key = frame?.currentKey;
    if (key === 'type') {
      if (PROJECTABLE_TYPE_SET.has(value)) {
        this.projectableType = value as ProjectableType;
        this.validatePrefix();
      } else {
        // Non-projectable type — fail closed immediately if already over ordinary.
        this.revokeProjectability();
      }
      return;
    }
    if (key === 'toolCallId') this.toolCallId = value;
    if (key === 'toolName') this.toolName = value;
  }

  private endNumber(): void {
    if (!isValidJsonNumber(this.tokenBuf)) {
      throw new PiRpcProjectorError('malformed_json', `Invalid JSON number '${this.tokenBuf}'`);
    }
    this.tokenBuf = '';
    this.afterValue();
  }

  private endLiteral(): void {
    const lit = this.tokenBuf;
    if (lit !== 'true' && lit !== 'false' && lit !== 'null') {
      throw new PiRpcProjectorError('malformed_json', `Invalid JSON literal '${lit}'`);
    }
    const frame = this.stack[this.stack.length - 1];
    if (frame?.topLevel) {
      if (frame.currentKey === 'willRetry') {
        if (lit === 'null') this.revokeProjectability();
        else this.willRetry = lit === 'true';
      } else if (frame.currentKey === 'isError') {
        if (lit === 'null') this.revokeProjectability();
        else this.isError = lit === 'true';
      }
    }
    this.tokenBuf = '';
    this.afterValue();
  }

  private afterValue(): void {
    this.sawValue = true;
    const frame = this.stack[this.stack.length - 1];
    if (!frame) {
      this.mode = 'done';
      return;
    }
    if (frame.kind === 'object') {
      frame.currentKey = undefined;
      this.mode = 'object_next';
      return;
    }
    frame.elementCount += 1;
    this.mode = 'array_next';
  }

  private validatePrefix(): void {
    if (this.revoked || this.knownOrdinary) return;
    if (this.topLevelKeys.length === 0) return;
    if (this.topLevelKeys[0] !== 'type') {
      this.revokeProjectability();
      return;
    }
    if (!this.projectableType) return;
    const expected = PROJECTABLE_PREFIXES[this.projectableType];
    for (let i = 0; i < this.topLevelKeys.length; i++) {
      if (i >= expected.length || this.topLevelKeys[i] !== expected[i]) {
        this.revokeProjectability();
        return;
      }
    }
  }

  private revokeProjectability(): void {
    this.revoked = true;
    this.knownOrdinary = true;
    if (this.projectableBudget || this.recordedBytes > this.limits.ordinaryMaxBytes) {
      throw new PiRpcProjectorError('stdout_overflow', 'RPC stdout record exceeded 8 MiB');
    }
  }

  private canProject(): boolean {
    if (this.revoked || this.knownOrdinary || !this.projectableType) return false;
    const expected = PROJECTABLE_PREFIXES[this.projectableType];
    if (this.topLevelKeys.length !== expected.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (this.topLevelKeys[i] !== expected[i]) return false;
    }
    // Validate bulk-field structural types.
    for (const [key, shape] of this.bulkFieldShapes) {
      if (JsonRecordParser.ARRAY_BULK_FIELDS.has(key) && shape !== 'array') return false;
      if (JsonRecordParser.OBJECT_BULK_FIELDS.has(key) && shape !== 'object') return false;
    }
    switch (this.projectableType) {
      case 'agent_end':
        return typeof this.willRetry === 'boolean';
      case 'message_start':
      case 'message_update':
      case 'message_end':
        return typeof this.role === 'string';
      case 'turn_end':
        return true;
      case 'tool_execution_start':
      case 'tool_execution_update':
        return typeof this.toolCallId === 'string' && typeof this.toolName === 'string';
      case 'tool_execution_end':
        return (
          typeof this.toolCallId === 'string' &&
          typeof this.toolName === 'string' &&
          typeof this.isError === 'boolean'
        );
      default:
        return false;
    }
  }

  private buildShell(): CompactPiRpcReplayableEvent {
    const t = this.projectableType!;
    switch (t) {
      case 'agent_end':
        return {
          type: 'agent_end',
          messages: [],
          messagesOmitted: true,
          willRetry: this.willRetry!,
        };
      case 'message_start':
      case 'message_update':
      case 'message_end':
        return { type: t, payloadOmitted: true, role: this.role! };
      case 'turn_end':
        return { type: 'turn_end', payloadOmitted: true };
      case 'tool_execution_start':
      case 'tool_execution_update':
        return {
          type: t,
          payloadOmitted: true,
          toolCallId: this.toolCallId!,
          toolName: this.toolName!,
        };
      case 'tool_execution_end':
        return {
          type: 'tool_execution_end',
          payloadOmitted: true,
          toolCallId: this.toolCallId!,
          toolName: this.toolName!,
          isError: this.isError!,
        };
    }
  }
}

function isWs(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isNumberContinue(ch: string): boolean {
  return (
    (ch >= '0' && ch <= '9') || ch === '+' || ch === '-' || ch === 'e' || ch === 'E' || ch === '.'
  );
}

function isValidJsonNumber(text: string): boolean {
  return /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(text);
}
