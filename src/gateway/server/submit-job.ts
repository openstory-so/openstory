/**
 * `POST /api/v1/gateway/{provider}/{model}` (docs/architecture/model-gateway.md).
 * Order: replay, model, schema, compliance, upload rights, price, row, hold,
 * trigger. A refused request leaves no row and no hold.
 */

import type { Microdollars } from '@/billing/money';
import {
  releaseReservationOnThrow,
  reserveRunCredits,
} from '@/billing/server/preflight';
import type { LikenessRequestContext } from '@/cast/server/upload-rights';
import { requireCheckedUploadRights } from '@/cast/server/upload-check';
import { ValidationError } from '@/platform/errors';
import { getLogger } from '@/platform/logger';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { GatewayJob, JsonValue } from '@/platform/server/db/schema';
import { requireGenerationAllowed } from '@/platform/server/compliance/generation-gate';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import {
  GATEWAY_VIA,
  type GatewayJobInput,
  type GatewayProvider,
} from '@/gateway/schema';
import { getGatewayModel, type GatewayModel } from '@/gateway/server/catalog';
import { withPlatformLlmKey } from '@/gateway/server/platform-credentials';
import { priceGatewayJob } from '@/gateway/server/price';
import type { GatewayGenerationWorkflowInput } from '@/gateway/server/workflows/gateway-generation-workflow';
import { RateCardError } from '@modelschemas/rate-card/evaluator';
import { z } from 'zod';

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

/** The body checked against the provider's schema, with the path's model on it where the schema has one. */
function validatedBody(
  model: GatewayModel,
  raw: GatewayJobInput
): GatewayJobInput {
  const properties = model.inputSchema.properties;
  const takesModel =
    typeof properties === 'object' &&
    properties !== null &&
    !Array.isArray(properties) &&
    'model' in properties;
  if (takesModel && raw.model !== undefined && raw.model !== model.id) {
    throw new ValidationError('`model` in the body differs from the path');
  }
  const body = takesModel ? { ...raw, model: model.id } : raw;
  const parsed = z.fromJSONSchema(model.inputSchema).safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('The body does not match the model schema', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return body;
}

/**
 * Every URL in the body, for the likeness check. Inline media is refused:
 * the check is keyed on a URL, and bytes it cannot see must not reach a model.
 */
export function gatedUrls(body: JsonValue, found: string[] = []): string[] {
  if (typeof body === 'string') {
    if (body.startsWith('data:')) {
      throw new ValidationError('Send media as a URL, not inline data');
    }
    // Our own stored uploads are origin-relative; they are checked too.
    if (/^https?:\/\//i.test(body) || body.startsWith('/r2/')) found.push(body);
  } else if (Array.isArray(body)) {
    for (const item of body) gatedUrls(item, found);
  } else if (body !== null && typeof body === 'object') {
    for (const [key, value] of Object.entries(body)) {
      if (key === 'inlineData' || key === 'inline_data') {
        throw new ValidationError('Send media as a URL, not inline data');
      }
      gatedUrls(value, found);
    }
  }
  return found;
}

export async function submitGatewayJob(
  request: {
    provider: GatewayProvider;
    modelId: string;
    body: GatewayJobInput;
  },
  ctx: GatewaySubmitContext
): Promise<GatewaySubmitResult> {
  const { scopedDb } = ctx;
  if (ctx.idempotencyKey) {
    const existing = await scopedDb.gatewayJobs.getByIdempotencyKey(
      ctx.idempotencyKey
    );
    if (existing) return { job: existing, replay: true };
  }

  const model = await getGatewayModel(request.provider, request.modelId);
  const input = validatedBody(model, request.body);
  const media = gatedUrls(input);

  await requireGenerationAllowed({
    userId: scopedDb.userId,
    organizationId: scopedDb.organizationId,
  });
  await requireCheckedUploadRights(
    withPlatformLlmKey(scopedDb),
    media,
    ctx.request
  );

  let estimate: Microdollars;
  try {
    estimate = priceGatewayJob(model.card, input);
  } catch (error) {
    if (!(error instanceof RateCardError)) throw error;
    // No floor and no guess: a request the card cannot price is not run.
    throw new ValidationError(
      `This request cannot be priced before it runs (${error.message})`
    );
  }

  const { job, created } = await scopedDb.gatewayJobs.create({
    kind: model.kind,
    modelKey: model.id,
    via: GATEWAY_VIA[model.provider],
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
    provider: model.provider,
    kind: model.kind,
    target: { modelId: model.id, endpointId: model.endpointId },
    card: model.card,
    input,
    holdMicros: estimate,
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
          message:
            'The job could not be started. Send it again with a new Idempotency-Key.',
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
