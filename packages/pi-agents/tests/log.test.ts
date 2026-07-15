// ABOUTME: Tests formatting of failed agent tool invocation logs.
// ABOUTME: Verifies complete nested parameters and failure details remain present.

import { describe, expect, it } from 'bun:test';
import { formatFailedAgentToolCall, withAgentToolFailureLogging } from '../src/log.ts';

const params = {
  agent: 'general',
  task: 'task',
  runtime: 'grok-acp',
  model: 'grok-4.5',
  thinking: 'high',
  runInBackground: false,
  chain: [
    {
      agent: 'planner',
      task: 'plan',
      outputSchema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
      },
    },
  ],
};

const failure = {
  content: [
    {
      type: 'text',
      text: 'resume_error: preflight_failed: unit single: ACP session unavailable',
    },
  ],
};

describe('formatFailedAgentToolCall', () => {
  it('records the complete tool call parameters and failure details', () => {
    const message = formatFailedAgentToolCall(params, failure);

    expect(message).toBe(
      `agent tool call failed params=${JSON.stringify(params)} failure=${JSON.stringify(failure)}`
    );
  });
});

describe('withAgentToolFailureLogging', () => {
  it('reports complete parameters when the tool returns isError', async () => {
    const reports: Array<[unknown, unknown]> = [];
    const result = await withAgentToolFailureLogging(
      params,
      async () => ({ ...failure, isError: true }),
      (reportedParams, reportedFailure) => reports.push([reportedParams, reportedFailure])
    );

    expect(result.isError).toBe(true);
    expect(reports).toEqual([[params, failure.content]]);
  });

  it('reports complete parameters and rethrows an execution exception', async () => {
    const reports: Array<[unknown, unknown]> = [];
    const error = new Error('spawn failed');

    let caught: unknown;
    try {
      await withAgentToolFailureLogging(
        params,
        async () => {
          throw error;
        },
        (reportedParams, reportedFailure) => reports.push([reportedParams, reportedFailure])
      );
    } catch (thrown) {
      caught = thrown;
    }

    expect(caught).toBe(error);
    expect(reports).toEqual([[params, error]]);
  });
});
