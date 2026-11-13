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
import { cardParams, RateCardError } from '@modelschemas/rate-card/evaluator';
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

/** Providers that read the model from the body; the path's model is always written there. */
const MODEL_IN_BODY: ReadonlySet<GatewayProvider> = new Set([
  'grok',
  'byteplus',
]);

// ponytail: a name list, not the card. Drop it when every card prices its own count lever.
const COUNT_FIELDS = [
  'n',
  'num_images',
  'num_outputs',
  'num_videos',
  'number_of_images',
  'sample_count',
  'max_images',
];

function isObject(
  value: JsonValue | undefined
): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The body checked against the provider's schema. Three refusals keep the
 * price honest: a `model` that differs from the path, a field the schema
 * does not name, and more than one output the card does not price.
 */
function validatedBody(
  model: GatewayModel,
  raw: GatewayJobInput
): GatewayJobInput {
  const modelInBody = MODEL_IN_BODY.has(model.provider);
  if (modelInBody && raw.model !== undefined && raw.model !== model.id) {
    throw new ValidationError('`model` in the body differs from the path');
  }
  const body = modelInBody ? { ...raw, model: model.id } : raw;

  const { properties, additionalProperties } = model.inputSchema;
  if (isObject(properties) && !additionalProperties) {
    const unknown = Object.keys(body).filter(
      (key) =>
        !Object.hasOwn(properties, key) && !(modelInBody && key === 'model')
    );
    if (unknown.length > 0) {
      throw new ValidationError(
        `The model schema has no field named ${unknown.join(', ')}`
      );
    }
  }
  const parsed = z.fromJSONSchema(model.inputSchema).safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('The body does not match the model schema', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const priced = new Set(cardParams(model.card).request);
  const unpriced = COUNT_FIELDS.find((field) => {
    const count = body[field];
    return typeof count === 'number' && count > 1 && !priced.has(field);
  });
  if (unpriced) {
    throw new ValidationError(
      `The rate card does not price \`${unpriced}\` above 1 for this model`
    );
  }
  return body;
}

const INLINE = 'Send media as a URL, not inline data';

/**
 * Every URL in the body, for the likeness check. Anything else that could
 * carry media is refused: the check is keyed on a URL, and bytes it cannot
 * see must not reach a model.
 */
export function gatedUrls(body: JsonValue, found: string[] = []): string[] {
  if (typeof body === 'string') {
    const trimmed = body.trim();
    // `data:<type>,<bytes>` and `blob:<url>`; a prompt that starts "Data: ..." is neither.
    if (/^data:[^\s,]*,/i.test(trimmed) || /^blob:\S/i.test(trimmed)) {
      throw new ValidationError(INLINE);
    }
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i
      .exec(trimmed)?.[1]
      ?.toLowerCase();
    if (scheme !== undefined || trimmed.startsWith('//')) {
      // Only http(s), exactly as sent: a provider may fetch what we did not check.
      if ((scheme !== 'http' && scheme !== 'https') || trimmed !== body) {
        throw new ValidationError('Media URLs must be plain http(s) URLs');
      }
      found.push(body);
    } else if (trimmed.startsWith('/r2/')) {
      // Our own stored uploads are origin-relative; they are checked too.
      found.push(trimmed);
    }
  } else if (Array.isArray(body)) {
    for (const item of body) gatedUrls(item, found);
  } else if (body !== null && typeof body === 'object') {
    for (const [key, value] of Object.entries(body)) {
      if (key === 'inlineData' || key === 'inline_data') {
        throw new ValidationError(INLINE);
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
