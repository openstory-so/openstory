import { z } from 'zod';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { UPDATE_STALE_DEPTHS } from '@/shots/update-stale-depth';
import { GENERATION_STAGES } from '@/sequences/pipeline';
import {
  executeGeneration,
  getOperationStatus,
  planExport,
  planGeneration,
  planWorkSchema,
  startExportOperation,
  type GenerationRequest,
} from '@/sequences/server/generation-operations';
import {
  openstoryTool,
  readToolDefinition,
  sequenceInput,
} from '../tool-context';

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const planOutput = z.object({
  planToken: z.string(),
  sequenceId: z.string(),
  digest: z.string(),
  estimate: z.object({
    micros: z.number().nullable(),
    usd: z.number().nullable(),
  }),
  work: planWorkSchema,
  blockers: z.array(z.object({ code: z.string(), message: z.string() })),
});

const operationSchema = z.object({
  sequenceId: z.string(),
  workflowRunIds: z.array(z.string()),
  pollAfterSeconds: z.number(),
});

// No length cap: a plan of 200 shot ids encodes past 4 KiB, and decode
// zod-parses the token anyway.
const planToken = z
  .string()
  .min(1)
  .describe('The planToken from plan_generation or retry_failed_work.');

function planSummary(plan: z.output<typeof planOutput>) {
  const cost =
    plan.estimate.usd === null ? 'unknown' : `$${plan.estimate.usd.toFixed(2)}`;
  const blocked = plan.blockers.length
    ? `; blocked: ${plan.blockers.map((b) => b.code).join(', ')}`
    : '';
  return `Plan: estimate ${cost}${blocked}. Show it to the user before starting it.`;
}

export const planGenerationInput = sequenceInput
  .extend({
    mode: z
      .enum(['stale', 'missing'])
      .describe(
        'stale: redo out-of-date work (Update all) up to depth; never a first render. missing: make what the sequence still owes up to stopAt (Continue), with startFrames and draftMotion if sent; whole sequence only.'
      ),
    depth: z
      .enum(UPDATE_STALE_DEPTHS)
      .optional()
      .describe('Required for stale.'),
    stopAt: z
      .enum(GENERATION_STAGES)
      .optional()
      .describe('Required for missing.'),
    startFrames: z
      .boolean()
      .optional()
      .describe(
        'missing only. Render a still per shot and animate it; false renders straight to video from the reference sheets. Omit to keep the sequence’s setting.'
      ),
    draftMotion: z
      .boolean()
      .optional()
      .describe(
        'missing only. Render motion as low-resolution drafts first (Seedance 2.5 only). Omit to keep the sequence’s setting.'
      ),
    sceneIds: z
      .array(ulidSchema)
      .min(1)
      .max(100)
      .optional()
      .describe('Database scene IDs. Omit both lists for the whole sequence.'),
    shotIds: z
      .array(ulidSchema)
      .min(1)
      .max(200)
      .optional()
      .describe('Database shot IDs. Not combined with sceneIds.'),
  })
  .refine((i) => !(i.sceneIds && i.shotIds), {
    message: 'Send sceneIds or shotIds, not both.',
  })
  .refine(
    (i) => (i.mode === 'stale' ? i.depth && !i.stopAt : i.stopAt && !i.depth),
    { message: 'mode "stale" takes depth; mode "missing" takes stopAt.' }
  )
  .refine(
    (i) =>
      i.mode === 'missing' ||
      (i.startFrames === undefined && i.draftMotion === undefined),
    { message: 'startFrames and draftMotion go with mode "missing".' }
  );

function toRequest(
  input: z.output<typeof planGenerationInput>
): GenerationRequest {
  const target = input.sceneIds
    ? { kind: 'scenes' as const, sceneIds: input.sceneIds }
    : input.shotIds
      ? { kind: 'shots' as const, shotIds: input.shotIds }
      : { kind: 'sequence' as const };
  if (input.mode === 'stale' && input.depth) {
    return { mode: 'stale', depth: input.depth, target };
  }
  if (input.mode === 'missing' && input.stopAt) {
    return {
      mode: 'missing',
      stopAt: input.stopAt,
      generateStartFrames: input.startFrames,
      draftMotion: input.draftMotion,
      target,
    };
  }
  throw new Error('unreachable: planInput refines mode against depth/stopAt');
}

export const planGenerationTool = openstoryTool({
  name: 'plan_generation',
  description:
    'Plan paid generation without starting it. Returns the work per stage (shot IDs), what is skipped or already in flight, effective models, an estimate (null = a component has no price), blockers and a planToken. Show the user this plan and get approval, then call execute_generation with the planToken.',
  scope: 'generate',
  annotations: writeAnnotations,
  inputSchema: planGenerationInput,
  outputSchema: planOutput,
  run: async (input, { scopedDb, userId }) => {
    const plan = await planGeneration(
      scopedDb,
      { userId, teamId: scopedDb.teamId },
      input.sequenceId,
      toRequest(input)
    );
    return { data: plan, summary: planSummary(plan) };
  },
});

export const retryFailedWorkTool = openstoryTool({
  name: 'retry_failed_work',
  description:
    'Plan a retry of failed images, videos and music without starting it (the same plan contract as plan_generation). mode smart retries only the failed items and refuses when recovery needs a full storyboard; full_if_required plans that storyboard run and shows its cost. Start the plan with execute_generation.',
  scope: 'generate',
  annotations: writeAnnotations,
  inputSchema: sequenceInput.extend({
    mode: z.enum(['smart', 'full_if_required']).default('smart'),
  }),
  outputSchema: planOutput,
  run: async (input, { scopedDb, userId }) => {
    const plan = await planGeneration(
      scopedDb,
      { userId, teamId: scopedDb.teamId },
      input.sequenceId,
      { mode: 'retry', retry: input.mode }
    );
    return { data: plan, summary: planSummary(plan) };
  },
});

export const executeGenerationTool = openstoryTool({
  name: 'execute_generation',
  description:
    'Start an approved plan from plan_generation or retry_failed_work. confirm: true asserts the user approved that plan; the server still re-plans, refuses a plan whose work or cost changed (PLAN_CHANGED) and rechecks credits. Safe to call again after a timeout: a repeat returns the same runs and never charges twice; PLAN_CHANGED or GENERATION_IN_PROGRESS on a repeat means the earlier call started it — check get_sequence_status. Poll get_operation_status with the workflowRunIds.',
  scope: 'generate',
  annotations: {
    ...writeAnnotations,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: sequenceInput.extend({ planToken, confirm: z.literal(true) }),
  outputSchema: operationSchema,
  run: async (input, { scopedDb, userId }) => {
    const operation = await executeGeneration(
      scopedDb,
      { userId, teamId: scopedDb.teamId },
      input.sequenceId,
      input.planToken
    );
    return {
      data: operation,
      summary: `Started ${operation.workflowRunIds.length} run(s). Poll get_operation_status in ${operation.pollAfterSeconds}s.`,
    };
  },
});

export const getOperationStatusTool = readToolDefinition({
  name: 'get_operation_status',
  description:
    'Poll the runs execute_generation returned: running or unknown (keep polling every pollAfterSeconds; if unknown persists, check get_sequence_status), or terminal completed, partially_failed (what is failed, per shot) or failed. Reports those runs, not the whole sequence.',
  inputSchema: sequenceInput.extend({
    // A retry starts one image run per failed shot, plus a motion batch and
    // music runs: the cap must hold what execute_generation can return.
    workflowRunIds: z.array(z.string().min(1)).min(1).max(1000),
  }),
  outputSchema: operationSchema.extend({
    state: z.string(),
    terminal: z.boolean(),
    error: z.string().optional(),
    failures: z
      .array(
        z.object({ shotId: z.string(), stage: z.string(), error: z.string() })
      )
      .optional(),
    skipped: z
      .array(z.object({ shotId: z.string(), reason: z.string() }))
      .optional(),
  }),
  run: async (input, { scopedDb }) => {
    const status = await getOperationStatus(
      scopedDb,
      input.sequenceId,
      input.workflowRunIds
    );
    return {
      data: status,
      summary: `Operation: ${status.state}${status.terminal ? '' : `; poll again in ${status.pollAfterSeconds}s`}.`,
    };
  },
});

const exportActions = z.enum([
  'reuse_ready',
  'join_in_flight',
  'busy_other_cut',
  'render',
]);

export const planExportTool = readToolDefinition({
  name: 'plan_export',
  description:
    'Preview a server MP4 export of the current cut: the cut hash and what start_export will do — reuse_ready (an MP4 of this exact cut exists), join_in_flight (a render of this cut is running), busy_other_cut (a render of an earlier cut is running; start_export refuses with EXPORT_BUSY) or render. Starts nothing; renders use no credits.',
  inputSchema: sequenceInput,
  outputSchema: z.object({
    sequenceId: z.string(),
    sourceShotsHash: z.string(),
    action: exportActions,
    exportId: z.string().nullable(),
  }),
  run: async (input, { scopedDb }) => {
    const plan = await planExport(scopedDb, input.sequenceId);
    return {
      data: plan,
      summary: `Export of cut ${plan.sourceShotsHash}: ${plan.action}.`,
    };
  },
});

export const startExportTool = openstoryTool({
  name: 'start_export',
  description:
    'Render the current cut to an MP4 on the server. A ready MP4 of this exact cut is reused and nothing renders; a running render of it is joined; EXPORT_BUSY while an earlier cut renders. Safe to repeat. Uses no credits. Poll get_export_status with the exportId.',
  scope: 'sequences:write',
  annotations: { ...writeAnnotations, idempotentHint: true },
  inputSchema: sequenceInput,
  outputSchema: z.object({
    sequenceId: z.string(),
    exportId: z.string(),
    status: z.string(),
    action: exportActions,
    workflowRunId: z.string().nullable(),
  }),
  run: async (input, { scopedDb, userId }) => {
    const started = await startExportOperation(
      scopedDb,
      { userId, teamId: scopedDb.teamId },
      input.sequenceId
    );
    return {
      data: started,
      summary: `Export ${started.exportId}: ${started.status} (${started.action}). Poll get_export_status.`,
    };
  },
});
