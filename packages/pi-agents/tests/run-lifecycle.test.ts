// ABOUTME: Tests for the per-run abort lifecycle - origin mutation, signal bridging, and status mapping.
// ABOUTME: Verifies shutdown precedence, user-never-downgrades-shutdown, and origin-to-status derivation.

import { describe, expect, it } from 'bun:test';
import {
  bridgeIncomingSignal,
  createRunLifecycle,
  describeAbortOrigin,
  originToFinalizeFlags,
  originToRunStatus,
  originToUnitStatus,
} from '../src/run-lifecycle.ts';

describe('createRunLifecycle', () => {
  it('starts with unknown origin and an un-aborted signal', () => {
    const lc = createRunLifecycle('run-1');
    expect(lc.origin).toBe('unknown');
    expect(lc.signal.aborted).toBe(false);
  });

  it('setOrigin upgrades unknown to user', () => {
    const lc = createRunLifecycle('run-1');
    lc.setOrigin('user');
    expect(lc.origin).toBe('user');
  });

  it('setOrigin upgrades unknown to session_shutdown', () => {
    const lc = createRunLifecycle('run-1');
    lc.setOrigin('session_shutdown');
    expect(lc.origin).toBe('session_shutdown');
  });

  it('session_shutdown overrides a prior user origin', () => {
    const lc = createRunLifecycle('run-1');
    lc.setOrigin('user');
    lc.setOrigin('session_shutdown');
    expect(lc.origin).toBe('session_shutdown');
  });

  it('user never downgrades an existing session_shutdown while draining', () => {
    const lc = createRunLifecycle('run-1');
    lc.setOrigin('session_shutdown');
    lc.setOrigin('user');
    expect(lc.origin).toBe('session_shutdown');
  });

  it('abort sets the origin and aborts the signal', () => {
    const lc = createRunLifecycle('run-1');
    lc.abort('user');
    expect(lc.origin).toBe('user');
    expect(lc.signal.aborted).toBe(true);
  });

  it('abort is idempotent - second call does not change origin', () => {
    const lc = createRunLifecycle('run-1');
    lc.abort('session_shutdown');
    lc.abort('user');
    expect(lc.origin).toBe('session_shutdown');
    expect(lc.signal.aborted).toBe(true);
  });
});

describe('bridgeIncomingSignal', () => {
  it('aborts the lifecycle as user when the incoming signal is already aborted', () => {
    const lc = createRunLifecycle('run-1');
    const incoming = new AbortController();
    incoming.abort();
    bridgeIncomingSignal(incoming.signal, lc);
    expect(lc.origin).toBe('user');
    expect(lc.signal.aborted).toBe(true);
  });

  it('aborts the lifecycle as user when the incoming signal aborts later', () => {
    const lc = createRunLifecycle('run-1');
    const incoming = new AbortController();
    bridgeIncomingSignal(incoming.signal, lc);
    expect(lc.signal.aborted).toBe(false);
    incoming.abort();
    expect(lc.origin).toBe('user');
    expect(lc.signal.aborted).toBe(true);
  });

  it('does nothing when the incoming signal is undefined', () => {
    const lc = createRunLifecycle('run-1');
    bridgeIncomingSignal(undefined, lc);
    expect(lc.signal.aborted).toBe(false);
    expect(lc.origin).toBe('unknown');
  });
});

describe('origin status mapping', () => {
  it('originToRunStatus maps user to cancelled and shutdown/unknown to interrupted', () => {
    expect(originToRunStatus('user')).toBe('cancelled');
    expect(originToRunStatus('session_shutdown')).toBe('interrupted');
    expect(originToRunStatus('unknown')).toBe('interrupted');
  });

  it('originToUnitStatus maps user to cancelled and shutdown/unknown to interrupted', () => {
    expect(originToUnitStatus('user')).toBe('cancelled');
    expect(originToUnitStatus('session_shutdown')).toBe('interrupted');
    expect(originToUnitStatus('unknown')).toBe('interrupted');
  });

  it('originToFinalizeFlags sets cancelled for user and interrupted for shutdown/unknown', () => {
    expect(originToFinalizeFlags('user')).toEqual({ cancelled: true });
    expect(originToFinalizeFlags('session_shutdown')).toEqual({ interrupted: true });
    expect(originToFinalizeFlags('unknown')).toEqual({ interrupted: true });
  });

  it('describeAbortOrigin returns a diagnostic string for unknown origin', () => {
    expect(describeAbortOrigin('unknown')).toBe('abort origin unknown; treated as interrupted');
    expect(describeAbortOrigin('user')).toBeUndefined();
    expect(describeAbortOrigin('session_shutdown')).toBeUndefined();
  });
});
