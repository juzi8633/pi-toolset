// ABOUTME: TypeBox parameter schema for the `agent_job` tool - list, get, and resume durable runs.
// ABOUTME: Registered with `pi.registerTool` alongside the main `agent` tool.

import { StringEnum, Type } from '@earendil-works/pi-ai';

export type JobAction = 'list' | 'get' | 'resume';
export type StatusFilter =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export const JobActionSchema = StringEnum(['list', 'get', 'resume'] as const, {
  description: 'Action to perform: list runs, get details, or resume an interrupted run.',
});

export const StatusFilterSchema = StringEnum(
  ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] as const,
  {
    description: 'Filter runs by durable status. Omit to list all statuses.',
  }
);

export const JobParams = Type.Union([
  Type.Object({
    action: StringEnum(['list'] as const, {
      description: 'List recent runs with status, unit counts, and capability.',
    }),
    status: Type.Optional(StatusFilterSchema),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        description: 'Maximum number of runs to list (default 20, max 100).',
      })
    ),
  }),
  Type.Object({
    action: StringEnum(['get'] as const, {
      description: 'Get detailed status for a specific run.',
    }),
    runId: Type.String({
      description: 'Run ID (required).',
    }),
  }),
  Type.Object({
    action: StringEnum(['resume'] as const, {
      description: 'Resume an interrupted run.',
    }),
    runId: Type.String({
      description: 'Run ID (required).',
    }),
    allowReplay: Type.Optional(
      Type.Boolean({
        description:
          'Allow replay-capable units to re-run from the beginning. Only set after accepting duplicate-side-effect risk.',
      })
    ),
  }),
]);
