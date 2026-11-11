/**
 * `POST /api/v1/gateway/jobs` (docs/architecture/model-gateway.md). Order:
 * replay → validate → compliance → upload rights → estimate → row → hold →
 * trigger. A refused request leaves no row and no hold; a replayed
 * `Idempotency-Key` returns the job it first made.
 */

import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import {
  releaseReservationOnThrow,
  reserveRunCredits,
} from '@/billing/server/preflight';
import {
  likenessFromLedger,
  type LikenessRequestContext,
} from '@/cast/server/upload-rights';
import { requireCheckedUploadRights } from '@/cast/server/upload-check';
import { isOfferedVideoModel } from '@/models/models';
import { ValidationError } from '@/platform/errors';
import { getLogger } from '@/platform/logger';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { GatewayJob } from '@/platform/server/db/schema';
import { requireGenerationAllowed } from '@/platform/server/compliance/generation-gate';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import { studioBillableSeconds } from '@/studio/text-to-video';
import type { GatewayJobInput, GatewayJobRequest } from '@/gateway/schema';
import { estimateGatewayJobCost, gatewayVias } from '@/gateway/server/models';
import type { GatewayGenerationWorkflowInput } from '@/gateway/server/workflows/gateway-generation-workflow';

const logger = getLogger(['openstory', 'gateway', 'submit']);

export type GatewaySubmitContext = {
  scopedDb: ScopedDb;
  request: LikenessRequestContext;
  /** The `Idempotency-Key` header, when sent. */
  idempotencyKey: string | null;
  /** `context.oauth?.clientId`; null for an `osk_` key or a session. */
  oauthClientId: string | null;
};

export type GatewaySubmitResult = { job: GatewayJob; replay: boolean };

/** The `Idempotency-Key` header, trimmed; refused past 255 characters. */
export function readIdempotencyKey(headers: Headers): string | null {
  const key = headers.get('idempotency-key')?.trim();
  if (!key) return null;
  if (key.length > 255) {
    throw new ValidationError('Idempotency-Key is longer than 255 characters');
  }
  return key;
}

/** The request as the run will see it: durations snapped, defaults applied. */
function normalizeGatewayRequest(request: GatewayJobRequest): GatewayJobInput {
  if (request.kind === 'image') {
    return {
      kind: 'image',
      model: request.model,
      prompt: request.prompt,
      aspectRatio: request.aspectRatio,
      referenceImageUrls: request.referenceImageUrls,
    };
  }
  return {
    kind: 'video',
    model: request.model,
    prompt: request.prompt,
    aspectRatio: request.aspectRatio,
    duration: studioBillableSeconds(request.duration, request.model),
    ...(request.startImageUrl && { startImageUrl: request.startImageUrl }),
    referenceImageUrls: request.referenceImageUrls,
  };
}

function gatedMedia(input: GatewayJobInput): string[] {
  return [
    ...input.referenceImageUrls,
    ...(input.kind === 'video' && input.startImageUrl
      ? [input.startImageUrl]
      : []),
  ];
}

export async function submitGatewayJob(
  request: GatewayJobRequest,
  ctx: GatewaySubmitContext
): Promise<GatewaySubmitResult> {
  const { scopedDb } = ctx;
  if (ctx.idempotencyKey) {
    const existing = await scopedDb.gatewayJobs.getByIdempotencyKey(
      ctx.idempotencyKey
    );
    if (existing) return { job: existing, replay: true };
  }

  const input = normalizeGatewayRequest(request);
  if (
    input.kind === 'video' &&
    !isOfferedVideoModel(input.model, gatewayVias())
  ) {
    throw new ValidationError('Unknown video model');
  }

  await requireGenerationAllowed({
    userId: scopedDb.userId,
    organizationId: scopedDb.organizationId,
  });
  const media = gatedMedia(input);
  await requireCheckedUploadRights(scopedDb, media, ctx.request);
  const noPersonImages: string[] = [];
  if (input.kind === 'video') {
    for (const url of media) {
      if ((await likenessFromLedger(scopedDb, url)) === 'none') {
        noPersonImages.push(url);
      }
    }
  }

  const estimate = estimateGatewayJobCost(
    input,
    await getEffectiveFalPricing()
  );

  const { job, created } = await scopedDb.gatewayJobs.create({
    input,
    idempotencyKey: ctx.idempotencyKey,
    oauthClientId: ctx.oauthClientId,
  });
  if (!created) return { job, replay: true };

  // Platform keys only, so no BYOK skip: `providers: []` always holds.
  let reservationId: string | undefined;
  try {
    reservationId = await reserveRunCredits(scopedDb, estimate, {
      providers: [],
      idempotencyKey: `gateway:${job.id}`,
      errorMessage: 'Insufficient credits for this model',
    });
  } catch (error) {
    await scopedDb.gatewayJobs.deleteUnstarted(job.id);
    throw error;
  }

  const payload: GatewayGenerationWorkflowInput = {
    userId: scopedDb.userId,
    organizationId: scopedDb.organizationId,
    reservationId,
    ownsReservation: true,
    jobId: job.id,
    input,
    noPersonImages,
  };
  const workflowRunId = await releaseReservationOnThrow(
    scopedDb,
    reservationId,
    async () => {
      try {
        return await triggerWorkflow('/gateway', payload, {
          deduplicationId: `gateway-${job.id}`,
        });
      } catch (error) {
        await scopedDb.gatewayJobs.markFailed(job.id, {
          code: 'NOT_STARTED',
          message: 'The job could not be started. Try again.',
        });
        throw error;
      }
    }
  );

  try {
    await scopedDb.gatewayJobs.attachRun(job.id, {
      reservationId: reservationId ?? null,
      workflowRunId,
    });
  } catch (error) {
    logger.error(
      `Failed to record run ${workflowRunId} on gateway job ${job.id}`,
      {
        err: error,
      }
    );
  }
  return {
    job: (await scopedDb.gatewayJobs.getById(job.id)) ?? job,
    replay: false,
  };
}
