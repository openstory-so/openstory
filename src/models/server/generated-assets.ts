/** The Models page create flow (#458, #2433): the gateway holds it on platform keys, or an own fal key runs it unbilled. */

import type { CreateGeneratedAssetData } from '@/models/model-assets.fn';
import { micros, microsToDisplayUsd } from '@/billing/money';
import { releaseReservationOnThrow } from '@/billing/server/preflight';
import type { LikenessRequestContext } from '@/cast/server/upload-rights';
import { requireCheckedUploadRights } from '@/cast/server/upload-check';
import { ValidationError } from '@/platform/errors';
import { generateId } from '@/platform/id';
import { requireGenerationAllowed } from '@/platform/server/compliance/generation-gate';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type {
  GeneratedAssetActivity,
  GeneratedAssetInput,
} from '@/platform/server/db/schema';
import { getGatewayModel } from '@/gateway/server/catalog';
import { gatedUrls, holdGatewayJob } from '@/gateway/server/submit-job';
import { GATEWAY_ERROR_MESSAGES } from '@/gateway/schema';
import {
  fetchModelInputSchema,
  type ModelInputJsonSchema,
} from './schema-fetch';
import { generationCouldNotStartMessage } from '@/motion/seedance-edit';
import { getLogger } from '@/platform/logger';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import type { AssetGenerationWorkflowInput } from '@/platform/server/workflow/types';
import { z } from 'zod';

const logger = getLogger(['openstory', 'functions', 'model-assets']);

/**
 * Validate an input against the model's input JSON Schema. Issues come back
 * per field for the form; a schema that cannot be converted throws.
 */
export function validateAssetInput(
  schema: ModelInputJsonSchema,
  input: GeneratedAssetInput
):
  | { success: true }
  | { success: false; issues: Array<{ path: string; message: string }> } {
  const parsed = z.fromJSONSchema(schema).safeParse(input);
  if (parsed.success) return { success: true };
  return {
    success: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

/** Validation failures are data, so the form gets typed per-field issues. */
export type CreateGeneratedAssetResult =
  | { ok: true; id: string; workflowRunId: string }
  | { ok: false; issues: Array<{ path: string; message: string }> };

const issuesSchema = z.object({
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
});

/** Order: the hold (which checks the body, account and media) or the own key's checks, the row, the run. A refusal leaves no row. */
export async function createGeneratedAsset(
  scopedDb: ScopedDb,
  data: CreateGeneratedAssetData,
  request: LikenessRequestContext
): Promise<CreateGeneratedAssetResult> {
  const assetId = generateId();
  let route: AssetGenerationWorkflowInput['route'];
  let activity: GeneratedAssetActivity;
  try {
    // Own keys stay on today's direct path, unbilled (#2439 moves them).
    if (
      data.provider === 'fal' &&
      (await scopedDb.apiKeys.hasUsableKey('fal'))
    ) {
      const validation = validateAssetInput(
        await fetchModelInputSchema(data.endpointId, data.activity),
        data.input
      );
      if (!validation.success) return { ok: false, issues: validation.issues };
      await requireGenerationAllowed({
        userId: scopedDb.userId,
        organizationId: scopedDb.organizationId,
      });
      await requireCheckedUploadRights(
        scopedDb,
        gatedUrls(data.input),
        request
      );
      route = { via: 'fal', endpointId: data.endpointId };
      activity = data.activity;
    } else {
      const model = await getGatewayModel(data.provider, data.endpointId);
      const held = await holdGatewayJob(model, data.input, {
        scopedDb,
        rights: { scopedDb, request },
        idempotencyKey: `asset:${assetId}`,
        oauthClientId: null,
        runReservationId: null,
      });
      route = {
        via: 'openstory',
        model,
        hold: { jobId: held.job.id, reservationId: held.run.reservationId },
      };
      // The model's kind, never the client's word, picks the call and the bucket.
      activity = model.kind;
    }
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    const parsed = issuesSchema.safeParse(error.details);
    return {
      ok: false,
      issues: parsed.success
        ? parsed.data.issues
        : [{ path: '', message: error.message }],
    };
  }
  const hold = route.via === 'openstory' ? route.hold : null;

  const row = await scopedDb.generatedAssets.insert({
    id: assetId,
    provider: route.via,
    endpointId: data.endpointId,
    activity,
    modelName: data.modelName,
    input: data.input,
    status: 'queued',
    gatewayJobId: hold?.jobId ?? null,
  });

  const workflowInput: AssetGenerationWorkflowInput = {
    userId: scopedDb.userId,
    organizationId: scopedDb.organizationId,
    assetId: row.id,
    activity,
    input: data.input,
    route,
  };

  const workflowRunId = await releaseReservationOnThrow(
    scopedDb,
    hold?.reservationId,
    async () => {
      try {
        return await triggerWorkflow('/asset', workflowInput, {
          deduplicationId: `asset-${row.id}`,
        });
      } catch (error) {
        // No run will flip these rows, so they fail here.
        await scopedDb.generatedAssets.markFailed(
          row.id,
          generationCouldNotStartMessage(activity)
        );
        if (hold) {
          await scopedDb.gatewayJobs.markFailed(hold.jobId, {
            code: 'NOT_STARTED',
            message: GATEWAY_ERROR_MESSAGES.NOT_STARTED,
          });
        }
        throw error;
      }
    }
  );

  try {
    await scopedDb.generatedAssets.setWorkflowRunId(row.id, workflowRunId);
    if (hold) {
      // The sweep ends the job if this run dies without a word.
      await scopedDb.gatewayJobs.attachRun(hold.jobId, {
        reservationId: hold.reservationId,
        workflowRunId,
      });
    }
  } catch (error) {
    // The run is going: failing the request would invite a second paid run.
    logger.error(`Failed to record run ${workflowRunId} on asset ${row.id}`, {
      err: error,
    });
  }

  return { ok: true, id: row.id, workflowRunId };
}

/** A run with what its gateway job charged; `charged` is null for an own-key run or one not yet settled. */
export async function getGeneratedAssetWithCharge(
  scopedDb: ScopedDb,
  id: string
) {
  const asset = await scopedDb.generatedAssets.getById(id);
  if (!asset) return null;
  const job = asset.gatewayJobId
    ? await scopedDb.gatewayJobs.getById(asset.gatewayJobId)
    : null;
  const charged =
    job?.status === 'succeeded' && job.costMicros !== null
      ? microsToDisplayUsd(micros(job.costMicros))
      : null;
  return { ...asset, charged };
}
