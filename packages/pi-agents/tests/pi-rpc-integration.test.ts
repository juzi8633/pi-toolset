// ABOUTME: Integration test launching local Pi in RPC mode without model requests.
// ABOUTME: Verifies get_state against a planned SessionManager session path, then stops cleanly.

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PiRpcTransport } from '../src/pi-rpc-transport.ts';
import { getPiInvocation } from '../src/invocation.ts';

function resolvePiCli(): { command: string; baseArgs: string[] } {
  // Prefer the package-local pi-coding-agent CLI so the test stays offline and version-aligned.
  const pkgRoot = path.dirname(
    fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/package.json'))
  );
  const cliPath = path.join(pkgRoot, 'dist', 'cli.js');
  if (fs.existsSync(cliPath)) {
    return { command: process.execPath, baseArgs: [cliPath] };
  }
  const inv = getPiInvocation([]);
  return { command: inv.command, baseArgs: inv.args };
}

describe('PiRpcTransport integration (no model)', () => {
  it('starts RPC, get_state on planned session path, and stops cleanly', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rpc-int-'));
    const sessionDir = path.join(tmp, 'sessions');
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

    const manager = SessionManager.create(tmp, sessionDir);
    const sessionFile = manager.getSessionFile();
    expect(sessionFile).toBeTruthy();
    // Planned path must not exist yet before first message.
    expect(fs.existsSync(sessionFile!)).toBe(false);

    const { command, baseArgs } = resolvePiCli();
    // Isolated RPC child: no extension discovery, no skills, offline, planned session path.
    const rpcArgs = [
      ...baseArgs,
      '--mode',
      'rpc',
      '--session',
      sessionFile!,
      '-ne',
      '-ns',
      '-np',
      '--offline',
    ];

    const transport = await PiRpcTransport.spawn({
      command,
      args: rpcArgs,
      cwd: tmp,
      env: {
        ...process.env,
        PI_SKIP_VERSION_CHECK: '1',
        PI_OFFLINE: '1',
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      requestTimeoutMs: 15_000,
      killTimeoutMs: 3000,
    });

    try {
      // Small settle so the process binds stdin.
      await new Promise((r) => setTimeout(r, 200));
      const state = await transport.getState();
      expect(state.sessionId).toBeTruthy();
      if (state.sessionFile) {
        expect(path.resolve(state.sessionFile)).toBe(path.resolve(sessionFile!));
      }
      // Do not send prompt — no model / API key required.
    } finally {
      await transport.dispose();
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }, 30_000);
});
