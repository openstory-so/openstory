/**
 * `POST /api/v1/gateway/jobs` (docs/architecture/model-gateway.md). Order:
 * replay → validate → app and grant → compliance → upload rights → estimate
 * → row → hold → trigger. A refused request leaves no row and no hold; a
 * replayed `Idempotency-Key` returns the job it first made.
 */

import { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import type { Microdollars } from '@/billing/money';
import { releaseReservationOnThrow } from '@/billing/server/preflight';
import {
  likenessFromLedger,
  type LikenessRequestContext,
} from '@/cast/server/upload-rights';
import { requireCheckedUploadRights } from '@/cast/server/upload-check';
import { isOfferedVideoModel } from '@/models/models';
import { InsufficientCreditsError, ValidationError } from '@/platform/errors';
import { getLogger } from '@/platform/logger';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { GatewayJob } from '@/platform/server/db/schema';
import { requireGenerationAllowed } from '@/platform/server/compliance/generation-gate';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import { studioBillableSeconds } from '@/studio/text-to-video';
import {
  GATEWAY_PLATFORM_FEE_BPS,
  gatewayCharge,
} from '@/gateway/charge-lines';
import type { GatewayJobInput, GatewayJobRequest } from '@/gateway/schema';
import { estimateGatewayJobCost, gatewayVias } from '@/gateway/server/models';
import { withPlatformLlmKey } from '@/gateway/server/platform-credentials';
import {
  AppSuspendedError,
  GrantRequiredError,
  SpendCapExceededError,
} from '@/gateway/server/errors';
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

/**
 * A user-pays caller's app: refused when suspended, its id when active,
 * null when the client is not a registered app. Then the grant must be live.
 */
async function userPaysApp(
  scopedDb: ScopedDb,
  oauthClientId: string
): Promise<string | null> {
  const app = await scopedDb.gatewayApps.getByOAuthClient(oauthClientId);
  if (app?.status === 'suspended') throw new AppSuspendedError();
  const standing = await scopedDb.gatewayGrants.getStanding(
    oauthClientId,
    scopedDb.organizationId
  );
  if (!standing) throw new GrantRequiredError();
  return app?.id ?? null;
}

/**
 * Hold the charge. A user-pays hold carries its client and is refused in
 * the same statement when it would pass the grant's cap; the refusal is
 * then told apart by reading the grant again.
 */
async function holdCharge(
  scopedDb: ScopedDb,
  hold: Microdollars,
  jobId: string,
  userPays: { oauthClientId: string; appId: string | null } | null
): Promise<string> {
  const result = await scopedDb.billing.createReservation(hold, {
    idempotencyKey: `gateway:${jobId}`,
    ...(userPays && { spendCap: userPays }),
  });
  if (result.ok) return result.reservationId;
  if (userPays) {
    const standing = await scopedDb.gatewayGrants.getStanding(
      userPays.oauthClientId,
      scopedDb.organizationId
    );
    if (!standing) throw new GrantRequiredError();
    if (hold > standing.remainingMicros) {
      throw new SpendCapExceededError(standing, hold);
    }
  }
  throw new InsufficientCreditsError('Insufficient credits for this model');
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
  const appId = ctx.oauthClientId
    ? await userPaysApp(scopedDb, ctx.oauthClientId)
    : null;

  await requireGenerationAllowed({
    userId: scopedDb.userId,
    organizationId: scopedDb.organizationId,
  });
  const media = gatedMedia(input);
  await requireCheckedUploadRights(
    withPlatformLlmKey(scopedDb),
    media,
    ctx.request
  );
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
  // The hold covers every line of the charge the estimate would settle to.
  const platformFeeBps = GATEWAY_PLATFORM_FEE_BPS;
  const hold = gatewayCharge({
    providerCostMicros: estimate,
    platformFeeBps,
  }).totalMicros;
  const userPays = ctx.oauthClientId
    ? { oauthClientId: ctx.oauthClientId, appId }
    : null;

  const { job, created } = await scopedDb.gatewayJobs.create({
    input,
    idempotencyKey: ctx.idempotencyKey,
    oauthClientId: ctx.oauthClientId,
  });
  if (!created) return { job, replay: true };

  // Platform keys only, so no BYOK skip: the hold is always taken.
  let reservationId: string;
  try {
    reservationId = await holdCharge(scopedDb, hold, job.id, userPays);
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
    estimateMicros: estimate,
    platformFeeBps,
    oauthClientId: ctx.oauthClientId,
    appId,
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
      reservationId,
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
