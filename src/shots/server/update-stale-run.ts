/**
 * Launch and read an "Update all" run (#1077, #1819). Shared by the editor
 * (`updateStaleShotsFn`, `getUpdateStaleShotsRunFn`) and agent operations
 * (#1460).
 */

import { z } from 'zod';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import { getWorkflowRunOutcome } from '@/platform/server/workflow/run-outcome';
import { workflowNameFromRunId } from '@/platform/server/workflow/trigger-bindings';
import type { UpdateStaleShotsWorkflowInput } from '@/platform/server/workflow/types';
import { getLogger } from '@/platform/logger';
import type { UpdateStalePlan } from './update-stale-plan';

const logger = getLogger(['openstory', 'update-stale-run']);

/**
 * Shape of `UpdateStaleShotsWorkflow`'s return value. Parsed rather than cast:
 * it crosses the Cloudflare Workflows boundary as `unknown`, and a run from a
 * previously-deployed version of the workflow can legitimately not match.
 */
const updateStaleShotsResultSchema = z.object({
  totalShots: z.number(),
  visualPrompts: z.number(),
  motionPrompts: z.number(),
  images: z.number(),
  // Depth-picker levels (#1085). Defaulted so a run from a pre-picker
  // deployment still parses during version skew.
  videos: z.number().default(0),
  // Dialogue depth (#1703/#1740), defaulted for the same version skew.
  dialogues: z.number().default(0),
  musicPrompts: z.number().default(0),
  musicTracks: z.number().default(0),
  failures: z.array(
    z.object({ shotId: z.string(), stage: z.string(), error: z.string() })
  ),
  skipped: z.array(z.object({ shotId: z.string(), reason: z.string() })),
});

/**
 * Enqueue the frozen plan. `runKey` must start with the sequence id: the
 * instance id embeds it, and `readUpdateStaleRun` requires it before reading a
 * caller-supplied run id. A stable key makes the trigger idempotent while the
 * instance lives.
 */
export function launchUpdateStale(input: {
  userId: string;
  teamId: string;
  sequenceId: string;
  plan: UpdateStalePlan;
  runKey: string;
}): Promise<string> {
  return triggerWorkflow<UpdateStaleShotsWorkflowInput>(
    '/update-stale-shots',
    {
      userId: input.userId,
      teamId: input.teamId,
      sequenceId: input.sequenceId,
      plan: input.plan,
    },
    { deduplicationId: input.runKey }
  );
}

/**
 * Terminal outcome of one Update all run, or `unknown` when the id is not an
 * Update all run of this sequence (it is caller-supplied).
 */
export async function readUpdateStaleRun(sequenceId: string, runId: string) {
  if (
    workflowNameFromRunId(runId) !== 'update-stale-shots' ||
    !runId.includes(sequenceId)
  ) {
    return { state: 'unknown' as const };
  }
  const outcome = await getWorkflowRunOutcome(runId);
  if (outcome.state !== 'complete') return outcome;
  const parsed = updateStaleShotsResultSchema.safeParse(outcome.output);
  // A complete run whose output we can't read is not a failure to report as
  // one — fall back to 'unknown' so the UI defers to the staleness map.
  if (!parsed.success) {
    logger.error(`readUpdateStaleRun: unrecognised output for ${runId}`, {
      issues: parsed.error.issues,
    });
    return { state: 'unknown' as const };
  }
  return { state: 'complete' as const, result: parsed.data };
}
