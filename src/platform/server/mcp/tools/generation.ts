import { z } from 'zod';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { UPDATE_STALE_DEPTHS } from '@/shots/update-stale-depth';
import { GENERATION_STAGES } from '@/sequences/pipeline';
import {
  executeGeneration,
  getOperationStatus,
  planGeneration,
  type GenerationRequest,
} from '@/sequences/server/generation-operations';
import {
  openstoryTool,
  readToolDefinition,
  sequenceInput,
} from '../tool-context';

const paidAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const planInput = sequenceInput
  .extend({
    mode: z
      .enum(['stale', 'missing'])
      .describe(
        'stale: redo out-of-date work (Update all) up to depth; never a first render. missing: make what the sequence still owes up to stopAt (Continue); whole sequence only.'
      ),
    depth: z
      .enum(UPDATE_STALE_DEPTHS)
      .optional()
      .describe('Required for stale.'),
    stopAt: z
      .enum(GENERATION_STAGES)
      .optional()
      .describe('Required for missing.'),
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
    {
      message: 'mode "stale" takes depth; mode "missing" takes stopAt.',
    }
  );

function toRequest(input: z.output<typeof planInput>): GenerationRequest {
  const target = input.sceneIds
    ? { kind: 'scenes' as const, sceneIds: input.sceneIds }
    : input.shotIds
      ? { kind: 'shots' as const, shotIds: input.shotIds }
      : { kind: 'sequence' as const };
  if (input.mode === 'stale' && input.depth) {
    return { mode: 'stale', depth: input.depth, target };
  }
  if (input.mode === 'missing' && input.stopAt) {
    return { mode: 'missing', stopAt: input.stopAt, target };
  }
  throw new Error('unreachable: planInput refines mode against depth/stopAt');
}

const stageShots = z.array(z.string());
const workSchema = z.object({
  targetShotIds: z.array(z.string()),
  stages: z.object({
    visualPrompts: stageShots,
    motionPrompts: stageShots,
    specs: stageShots,
    images: stageShots,
    dialogue: stageShots,
    videos: stageShots,
  }),
  music: z.object({ prompt: z.boolean(), track: z.boolean() }).nullable(),
  skipped: z.array(z.object({ shotId: z.string(), reason: z.string() })),
  inFlightShotIds: z.array(z.string()),
  referenceOnlyShotIds: z.array(z.string()),
  models: z.object({
    image: z.string(),
    video: z.string(),
    perShotImage: z.record(z.string(), z.string()),
  }),
});

export const planGenerationTool = openstoryTool({
  name: 'plan_generation',
  description:
    'Plan paid generation without starting it. Returns the work per stage (shot IDs), what is skipped or already in flight, effective models, an estimate (null = a component has no price) and blockers, plus a planId valid for 30 minutes. Show the user this plan and get approval, then call execute_generation with the planId.',
  scope: 'generate',
  annotations: { ...paidAnnotations, openWorldHint: false },
  inputSchema: planInput,
  outputSchema: z.object({
    planId: z.string(),
    sequenceId: z.string(),
    digest: z.string(),
    expiresAt: z.string(),
    estimate: z.object({
      micros: z.number().nullable(),
      usd: z.number().nullable(),
      complete: z.boolean(),
    }),
    work: workSchema,
    blockers: z.array(z.object({ code: z.string(), message: z.string() })),
  }),
  run: async (input, { scopedDb, userId }) => {
    const plan = await planGeneration(
      scopedDb,
      { userId, teamId: scopedDb.teamId },
      input.sequenceId,
      toRequest(input)
    );
    const { request: _request, ...data } = plan;
    return {
      data,
      summary: `Plan ${plan.planId}: ${plan.work.targetShotIds.length} shots, estimate ${plan.estimate.usd === null ? 'unknown' : `$${plan.estimate.usd.toFixed(2)}`}${plan.blockers.length ? `; blocked: ${plan.blockers.map((b) => b.code).join(', ')}` : ''}.`,
    };
  },
});

const operationSchema = z.object({
  operationId: z.string(),
  sequenceId: z.string(),
  status: z.string(),
  workflowRunIds: z.array(z.string()),
  pollAfterSeconds: z.number(),
});

export const executeGenerationTool = openstoryTool({
  name: 'execute_generation',
  description:
    'Start an approved plan from plan_generation. confirm: true asserts the user approved that plan; the server still re-plans, refuses a plan whose work or cost changed (PLAN_CHANGED) or expired (PLAN_EXPIRED), and rechecks credits. Calling it again for the same plan returns the same operation and never starts or charges twice. Poll get_operation_status with the operationId.',
  scope: 'generate',
  annotations: { ...paidAnnotations, idempotentHint: true },
  inputSchema: sequenceInput.extend({
    planId: ulidSchema,
    confirm: z.literal(true),
  }),
  outputSchema: operationSchema,
  run: async (input, { scopedDb, userId }) => {
    const operation = await executeGeneration(
      scopedDb,
      { userId, teamId: scopedDb.teamId },
      input.sequenceId,
      input.planId
    );
    return {
      data: operation,
      summary: `Operation ${operation.operationId}: ${operation.status}. Poll get_operation_status in ${operation.pollAfterSeconds}s.`,
    };
  },
});

export const getOperationStatusTool = readToolDefinition({
  name: 'get_operation_status',
  description:
    'Poll one operation from execute_generation by its operationId: not_started, dispatching, running or unknown (keep polling every pollAfterSeconds), or terminal completed, partially_failed (per-shot failures), failed, dispatch_failed or dispatch_unknown. Reports that run only, not the whole sequence.',
  inputSchema: sequenceInput.extend({ operationId: ulidSchema }),
  outputSchema: operationSchema.extend({
    state: z.string(),
    terminal: z.boolean(),
    targeted: z.record(z.string(), z.unknown()),
    error: z.string().nullable().optional(),
    failures: z
      .array(
        z.object({ shotId: z.string(), stage: z.string(), error: z.string() })
      )
      .optional(),
    skipped: z
      .array(z.object({ shotId: z.string(), reason: z.string() }))
      .optional(),
    result: z.record(z.string(), z.unknown()).optional(),
  }),
  run: async (input, { scopedDb }) => {
    const status = await getOperationStatus(
      scopedDb,
      input.sequenceId,
      input.operationId
    );
    return {
      data: status,
      summary: `Operation ${status.operationId}: ${status.state}${status.terminal ? '' : `; poll again in ${status.pollAfterSeconds}s`}.`,
    };
  },
});
