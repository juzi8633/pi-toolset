// ABOUTME: Tests formatting of failed agent tool invocation logs.
// ABOUTME: Verifies complete nested parameters, failure details, and stack capture.

import { describe, expect, it } from 'bun:test';
import {
  collectFailureStacks,
  formatFailedAgentToolCall,
  withAgentToolFailureLogging,
} from '../../src/shared/log.ts';

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

  it('appends captured stacks from Error instances', () => {
    const error = new Error('spawn failed');
    error.stack = 'Error: spawn failed\n    at test';
    const message = formatFailedAgentToolCall(params, error);
    expect(message).toContain('failure=');
    expect(message).toContain('"stack":"Error: spawn failed\\n    at test"');
    expect(message).toContain('stack=');
    expect(message).toContain('Error: spawn failed\\n    at test');
  });

  it('appends errorStack values nested under details.results', () => {
    const payload = {
      content: [{ type: 'text', text: 'Agent error: boom' }],
      details: {
        results: [{ errorStack: 'Error: boom\n    at run' }],
      },
    };
    const message = formatFailedAgentToolCall(params, payload);
    expect(message).toContain('stack=');
    expect(message).toContain('Error: boom\\n    at run');
  });
});

describe('collectFailureStacks', () => {
  it('dedupes identical stacks', () => {
    const stack = 'Error: x\n    at a';
    expect(
      collectFailureStacks({
        errorStack: stack,
        details: { results: [{ errorStack: stack }, { errorStack: 'Error: y' }] },
      })
    ).toEqual([stack, 'Error: y']);
  });
});

describe('withAgentToolFailureLogging', () => {
  it('reports content and details when the tool returns isError', async () => {
    const reports: Array<[unknown, unknown]> = [];
    const details = { results: [{ errorStack: 'Error: nested\n    at f' }] };
    const result = await withAgentToolFailureLogging(
      params,
      async () => ({ ...failure, details, isError: true }),
      (reportedParams, reportedFailure) => reports.push([reportedParams, reportedFailure])
    );

    expect(result.isError).toBe(true);
    expect(reports).toEqual([[params, { content: failure.content, details }]]);
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
