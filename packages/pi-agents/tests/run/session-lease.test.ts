// ABOUTME: Tests for process-global session lease keys, ownership, and sticky failure.
// ABOUTME: Covers Pi path keys, Grok ACP runtime/cwd/session keys, and cross-key isolation.

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  acquireSessionLease,
  awaitSessionLease,
  buildSessionLeaseKey,
  canonicalizeSessionLeaseKey,
  getSessionLeaseStoreSizesForTest,
} from '../../src/run/session-lease.ts';

describe('session-lease', () => {
  it('canonicalizes symlink aliases to the same path key', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lease-'));
    try {
      const real = path.join(root, 'real-session.jsonl');
      fs.writeFileSync(real, '{}\n');
      const alias = path.join(root, 'alias-session.jsonl');
      fs.symlinkSync(real, alias);
      expect(canonicalizeSessionLeaseKey(alias)).toBe(canonicalizeSessionLeaseKey(real));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds Grok ACP keys from runtime, cwd, and session id without private paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lease-cwd-'));
    try {
      const key = buildSessionLeaseKey({
        runtime: 'grok-acp',
        cwd: root,
        sessionIdentity: 'sess-abc',
      });
      expect(key.startsWith('grok-acp\0')).toBe(true);
      expect(key.endsWith('\0sess-abc')).toBe(true);
      expect(key).not.toContain('.grok');
      expect(key).not.toContain('sessions/');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes same-key acquire and isolates different session ids', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lease-ser-'));
    try {
      const keyA = buildSessionLeaseKey({
        runtime: 'grok-acp',
        cwd: root,
        sessionIdentity: 'sess-a',
      });
      const keyB = buildSessionLeaseKey({
        runtime: 'grok-acp',
        cwd: root,
        sessionIdentity: 'sess-b',
      });
      const first = await acquireSessionLease(keyA);
      let secondAcquired = false;
      const secondPromise = acquireSessionLease(keyA).then((h) => {
        secondAcquired = true;
        return h;
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(secondAcquired).toBe(false);

      const other = await acquireSessionLease(keyB);
      expect(other.key).toBe(keyB);
      other.release();

      first.release();
      const second = await secondPromise;
      expect(secondAcquired).toBe(true);
      second.release();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps sticky fail-closed after dispose error', async () => {
    const key = `sticky-${Date.now()}-${Math.random()}`;
    const lease = await acquireSessionLease(key);
    lease.release(new Error('dispose failed'));
    await expect(awaitSessionLease(key)).rejects.toThrow(/dispose failed/);
    const sizes = getSessionLeaseStoreSizesForTest();
    expect(sizes.leases).toBeGreaterThan(0);
  });
});
