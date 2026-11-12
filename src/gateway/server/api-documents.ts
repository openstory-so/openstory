/**
 * `/api/v1/gateway` response documents. Zod so `openapi.ts` publishes exactly
 * the shape the routes return.
 */

import { aspectRatioSchema } from '@/models/aspect-ratios';
import {
  API_V1_BASE,
  getLink,
  halLinksSchema,
  waitLink,
  withLinks,
  type HalLink,
} from '@/platform/server/api-v1/hal';
import { CHARGE_LINE_KINDS } from '@/billing/charge-lines';
import type { GatewayJob } from '@/platform/server/db/schema';
import { toShareableUrl } from '@/platform/server/storage/buckets';
import {
  GATEWAY_JOB_KINDS,
  GATEWAY_JOB_STATUSES,
  gatewayChargeRequestSchema,
  gatewayJobRequestSchema,
} from '@/gateway/schema';
import type { GatewayJobChargeLine } from '@/gateway/server/db/gateway-jobs';
import type { GatewayModelEntry } from '@/gateway/server/models';
import type { GrantStanding } from '@/gateway/apps';
import { z } from 'zod';

const GATEWAY_PATH = `${API_V1_BASE}/gateway`;
export const GATEWAY_MODELS_PATH = `${GATEWAY_PATH}/models`;
export const GATEWAY_JOBS_PATH = `${GATEWAY_PATH}/jobs`;
export const GATEWAY_GRANT_PATH = `${GATEWAY_PATH}/grant`;
const GATEWAY_ESTIMATE_PATH = `${GATEWAY_JOBS_PATH}/estimate`;
const GATEWAY_CHARGES_PATH = `${GATEWAY_PATH}/charges`;

const gatewayModelSchema = z
  .object({
    kind: z.enum(GATEWAY_JOB_KINDS),
    key: z.string().describe('Send as `model` when submitting a job.'),
    name: z.string(),
    accepts: z.object({
      aspectRatios: z.array(aspectRatioSchema),
      durations: z
        .array(z.number())
        .optional()
        .describe('Video only: the lengths in seconds the model accepts.'),
      startImage: z.boolean().optional(),
      maxReferenceImages: z.number().int(),
    }),
  })
  .meta({ id: 'GatewayModel' });

export const gatewayModelsResultSchema = z
  .object({ models: z.array(gatewayModelSchema), _links: halLinksSchema })
  .meta({ id: 'GatewayModelsResult' });

export type GatewayModelsResult = z.infer<typeof gatewayModelsResultSchema>;

const chargeLinesSchema = z
  .array(
    z.object({
      kind: z.enum(CHARGE_LINE_KINDS),
      amountMicros: z.number().int(),
    })
  )
  .describe('What the debit is made of; the lines sum to `totalMicros`.');

export const gatewayJobResourceSchema = z
  .object({
    id: z.string(),
    kind: z.enum(GATEWAY_JOB_KINDS),
    model: z.string(),
    status: z.enum(GATEWAY_JOB_STATUSES),
    outputs: z
      .array(z.object({ url: z.string(), contentType: z.string() }))
      .describe('Absolute result URLs, once the job has succeeded.'),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
    charge: z
      .object({
        totalMicros: z
          .number()
          .int()
          .describe('The wallet debit, in microdollars.'),
        lines: chargeLinesSchema,
      })
      .nullable()
      .describe('What the job cost, once it succeeded.'),
    createdAt: z.string().meta({ format: 'date-time' }),
    completedAt: z.string().meta({ format: 'date-time' }).nullable(),
    _links: halLinksSchema,
  })
  .meta({ id: 'GatewayJob' });

export type GatewayJobResource = z.infer<typeof gatewayJobResourceSchema>;

const microsOrNull = (description: string) =>
  z.number().int().nullable().describe(description);

export const gatewayGrantResourceSchema = z
  .object({
    payer: z
      .enum(['user', 'app'])
      .describe(
        "`user`: an OAuth token; the user's organization pays, up to the monthly cap they set. `app`: an `osk_` key; its organization pays, with no cap."
      ),
    organizationId: z.string().describe('The organization that pays.'),
    clientId: z
      .string()
      .nullable()
      .describe('The OAuth client the cap applies to; null when the app pays.'),
    monthlyCapMicros: microsOrNull('The cap per UTC calendar month.'),
    spentMicros: microsOrNull(
      "What this client's jobs settled for this month, for this organization."
    ),
    heldMicros: microsOrNull(
      "What this client's running jobs hold for this organization."
    ),
    remainingMicros: microsOrNull(
      'Cap minus spent minus held, never below zero. A job whose hold is above it is refused with SPEND_CAP_EXCEEDED.'
    ),
    periodStart: z.string().meta({ format: 'date-time' }),
    periodEnd: z
      .string()
      .meta({ format: 'date-time' })
      .describe('When the month resets (UTC).'),
    _links: halLinksSchema,
  })
  .meta({ id: 'GatewayGrant' });

export type GatewayGrantResource = z.infer<typeof gatewayGrantResourceSchema>;

/** The caller's grant as the API returns it; `standing` null means the app pays. */
export function gatewayGrantDocument(input: {
  organizationId: string;
  clientId: string | null;
  standing: GrantStanding | null;
  periodStart: Date;
  periodEnd: Date;
}): GatewayGrantResource {
  const { standing } = input;
  return withLinks(
    {
      payer: standing ? 'user' : 'app',
      organizationId: input.organizationId,
      clientId: standing ? input.clientId : null,
      monthlyCapMicros: standing?.monthlyCapMicros ?? null,
      spentMicros: standing?.spentMicros ?? null,
      heldMicros: standing?.heldMicros ?? null,
      remainingMicros: standing?.remainingMicros ?? null,
      periodStart: input.periodStart.toISOString(),
      periodEnd: input.periodEnd.toISOString(),
    },
    {
      self: getLink(GATEWAY_GRANT_PATH),
      models: getLink(GATEWAY_MODELS_PATH),
      'submit-job': submitGatewayJobLink(),
    }
  );
}

/** A representative submit body, valid against the request schema. */
export const EXAMPLE_GATEWAY_JOB_BODY = {
  kind: 'image',
  model: 'gpt_image_2',
  prompt: 'A lighthouse at dusk, oil painting',
  aspectRatio: '16:9',
} as const;

export const gatewayEstimateResourceSchema = z
  .object({
    payer: z
      .enum(['user', 'app'])
      .describe('`user`: an OAuth token. `app`: an `osk_` key.'),
    kind: z.enum(GATEWAY_JOB_KINDS),
    model: z.string(),
    totalMicros: z
      .number()
      .int()
      .describe(
        'What the submit would hold, in microdollars; a finished job is charged its actual cost.'
      ),
    lines: chargeLinesSchema.describe(
      "The estimated charge for this caller: provider cost, the platform fee, and the app's margin when one applies. They sum to `totalMicros`."
    ),
    remainingMicros: z
      .number()
      .int()
      .nullable()
      .describe(
        "What the user's monthly cap leaves for this client now; null when the app pays."
      ),
    fitsUnderCap: z
      .boolean()
      .nullable()
      .describe(
        'Whether the hold fits under the remaining cap now; null when the app pays.'
      ),
    _links: halLinksSchema,
  })
  .meta({ id: 'GatewayEstimate' });

export type GatewayEstimateResource = z.infer<
  typeof gatewayEstimateResourceSchema
>;

export const gatewayChargeResourceSchema = z
  .object({
    id: z.string().describe('The charge (its wallet debit).'),
    sku: z.string(),
    totalMicros: z
      .number()
      .int()
      .describe("The debit from the user's organization, in microdollars."),
    lines: chargeLinesSchema,
    replay: z
      .boolean()
      .describe('True when this `Idempotency-Key` was already charged.'),
    createdAt: z.string().meta({ format: 'date-time' }),
    _links: halLinksSchema,
  })
  .meta({ id: 'GatewayCharge' });

export type GatewayChargeResource = z.infer<typeof gatewayChargeResourceSchema>;

/** A representative charge body, valid against the request schema. */
export const EXAMPLE_GATEWAY_CHARGE_BODY = { sku: 'export-hd' } as const;

export function gatewayEstimateDocument(input: {
  payer: 'user' | 'app';
  kind: GatewayEstimateResource['kind'];
  model: string;
  totalMicros: number;
  lines: {
    kind: GatewayEstimateResource['lines'][number]['kind'];
    amountMicros: number;
  }[];
  remainingMicros: number | null;
}): GatewayEstimateResource {
  return withLinks(
    {
      ...input,
      lines: input.lines.map(({ kind, amountMicros }) => ({
        kind,
        amountMicros,
      })),
      fitsUnderCap:
        input.remainingMicros === null
          ? null
          : input.totalMicros <= input.remainingMicros,
    },
    {
      self: estimateGatewayJobLink(),
      'submit-job': submitGatewayJobLink(),
      grant: getLink(GATEWAY_GRANT_PATH),
    }
  );
}

export function gatewayChargeDocument(charge: {
  id: string;
  sku: string;
  totalMicros: number;
  lines: {
    kind: GatewayChargeResource['lines'][number]['kind'];
    amountMicros: number;
  }[];
  createdAt: Date;
  replay: boolean;
}): GatewayChargeResource {
  return withLinks(
    {
      id: charge.id,
      sku: charge.sku,
      totalMicros: charge.totalMicros,
      lines: charge.lines.map(({ kind, amountMicros }) => ({
        kind,
        amountMicros,
      })),
      replay: charge.replay,
      createdAt: charge.createdAt.toISOString(),
    },
    {
      grant: getLink(GATEWAY_GRANT_PATH),
      'create-charge': createGatewayChargeLink(),
    }
  );
}

export function estimateGatewayJobLink(): HalLink {
  return {
    ...submitGatewayJobLink(),
    href: GATEWAY_ESTIMATE_PATH,
    title:
      'Price a job for this caller before submitting it: the same body; nothing is held or started.',
  };
}

export function createGatewayChargeLink(): HalLink {
  return {
    href: GATEWAY_CHARGES_PATH,
    method: 'POST',
    title:
      "An app charges the signed-in user's organization for one of its declared SKUs. OAuth only; needs an Idempotency-Key.",
    contentType: 'application/json',
    examples: [gatewayChargeRequestSchema.parse(EXAMPLE_GATEWAY_CHARGE_BODY)],
  };
}

export function submitGatewayJobLink(): HalLink {
  return {
    href: GATEWAY_JOBS_PATH,
    method: 'POST',
    title:
      'Run an image or video model. Responds 202 with the job; poll its self link.',
    contentType: 'application/json',
    examples: [gatewayJobRequestSchema.parse(EXAMPLE_GATEWAY_JOB_BODY)],
  };
}

export function gatewayModelsDocument(
  models: GatewayModelEntry[]
): GatewayModelsResult {
  return withLinks(
    { models },
    {
      self: getLink(GATEWAY_MODELS_PATH),
      'submit-job': submitGatewayJobLink(),
      'estimate-job': estimateGatewayJobLink(),
    }
  );
}

/** A job as the API returns it; stored URLs become absolute against `origin`. */
export function gatewayJobDocument(
  job: GatewayJob,
  chargeLines: GatewayJobChargeLine[],
  origin: string
): GatewayJobResource {
  const self = `${GATEWAY_JOBS_PATH}/${job.id}`;
  return withLinks(
    {
      id: job.id,
      kind: job.kind,
      model: job.modelKey,
      status: job.status,
      // Recorded before the charge, so shown only once the job succeeded.
      outputs: (job.status === 'succeeded' ? (job.outputs ?? []) : []).map(
        (output) => ({
          url: toShareableUrl(output.url, origin),
          contentType: output.contentType,
        })
      ),
      error: job.error ?? null,
      charge:
        job.status === 'succeeded' && job.costMicros !== null
          ? {
              totalMicros: job.costMicros,
              lines: chargeLines.map(({ kind, amountMicros }) => ({
                kind,
                amountMicros,
              })),
            }
          : null,
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
    },
    {
      self: getLink(self),
      poll: waitLink(self),
      models: getLink(GATEWAY_MODELS_PATH),
    }
  );
}

export function isTerminalGatewayJob(job: GatewayJob): boolean {
  return job.status === 'succeeded' || job.status === 'failed';
}
