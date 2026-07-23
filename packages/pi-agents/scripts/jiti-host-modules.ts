// ABOUTME: Shared Jiti host virtual-module construction for startup and built-runtime workers.
// ABOUTME: Virtualizes Pi host peers so extension import benchmarks do not require a full Pi process.

import * as piAgentCore from '@earendil-works/pi-agent-core';
import * as piAiCompat from '@earendil-works/pi-ai/compat';
import * as piCodingAgent from '@earendil-works/pi-coding-agent';
import * as piTui from '@earendil-works/pi-tui';
import * as typebox from 'typebox';

/** Build a fresh host virtual-module map for one Jiti instance. */
export function createHostVirtualModules(): Record<string, unknown> {
  return {
    '@earendil-works/pi-coding-agent': piCodingAgent,
    '@earendil-works/pi-agent-core': piAgentCore,
    '@earendil-works/pi-tui': piTui,
    '@earendil-works/pi-ai': piAiCompat,
    typebox,
  };
}
