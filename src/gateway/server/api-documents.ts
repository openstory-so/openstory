/**
 * `/api/v1/gateway` response documents. Zod so `openapi.ts` publishes exactly
 * the shape the routes return.
 */

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
  GATEWAY_ERROR_CODES,
  GATEWAY_JOB_KINDS,
  GATEWAY_JOB_STATUSES,
  GATEWAY_PROVIDERS,
  gatewayChargeRequestSchema,
  gatewayProviderOfVia,
} from '@/gateway/schema';
import type { GatewayModelSummary } from '@/gateway/server/catalog';
import type { GatewayJobChargeLine } from '@/gateway/server/db/gateway-jobs';
import type { GrantStanding } from '@/gateway/apps';
import { z } from 'zod';

const GATEWAY_PATH = `${API_V1_BASE}/gateway`;
export const GATEWAY_MODELS_PATH = `${GATEWAY_PATH}/models`;
export const GATEWAY_JOBS_PATH = `${GATEWAY_PATH}/jobs`;
const GATEWAY_SUBMIT_TEMPLATE = `${GATEWAY_PATH}/{provider}/{model}`;
export const GATEWAY_GRANT_PATH = `${GATEWAY_PATH}/grant`;
const GATEWAY_ESTIMATE_TEMPLATE = `${GATEWAY_PATH}/estimate/{provider}/{model}`;
const GATEWAY_CHARGES_PATH = `${GATEWAY_PATH}/charges`;

const gatewayModelSchema = z
  .object({
    provider: z.enum(GATEWAY_PROVIDERS),
    id: z.string().describe("The provider's own model id."),
    name: z.string(),
    kind: z.enum(GATEWAY_JOB_KINDS),
    submit: z
      .string()
      .describe('POST the provider body here to run the model.'),
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
    provider: z.enum(GATEWAY_PROVIDERS),
    model: z.string(),
    kind: z.enum(GATEWAY_JOB_KINDS),
    status: z.enum(GATEWAY_JOB_STATUSES),
    outputs: z
      .array(z.object({ url: z.string(), contentType: z.string() }))
      .describe('Absolute result URLs, once the job has succeeded.'),
    error: z
      .object({ code: z.enum(GATEWAY_ERROR_CODES), message: z.string() })
      .nullable(),
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

/** A representative submit: a fal endpoint and a body in fal's own shape. */
export const EXAMPLE_GATEWAY_SUBMIT = {
  href: `${GATEWAY_PATH}/fal/fal-ai/flux/schnell`,
  body: {
    prompt:
      'Mara, a ferry mechanic, wipes her hands on a rag in the engine room',
  },
} as const;

export const gatewayEstimateResourceSchema = z
  .object({
    payer: z
      .enum(['user', 'app'])
      .describe('`user`: an OAuth token. `app`: an `osk_` key.'),
    provider: z.enum(GATEWAY_PROVIDERS),
    model: z.string(),
    kind: z.enum(GATEWAY_JOB_KINDS),
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
  provider: GatewayEstimateResource['provider'];
  model: string;
  kind: GatewayEstimateResource['kind'];
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
    href: GATEWAY_ESTIMATE_TEMPLATE,
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
    href: GATEWAY_SUBMIT_TEMPLATE,
    method: 'POST',
    templated: true,
    title:
      "Run a model with the provider's own request body. Responds 202 with the job; poll its self link.",
    contentType: 'application/json',
    examples: [EXAMPLE_GATEWAY_SUBMIT.body],
  };
}

/** The submit path for one model; a fal id keeps its slashes. */
function gatewaySubmitPath(model: GatewayModelSummary): string {
  return `${GATEWAY_PATH}/${model.provider}/${model.id}`;
}

export function gatewayModelsDocument(
  models: GatewayModelSummary[]
): GatewayModelsResult {
  return withLinks(
    {
      models: models.map((model) => ({
        ...model,
        submit: gatewaySubmitPath(model),
      })),
    },
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
  // Nullable in SQL only; every job is created with its provider's via.
  if (!job.via) throw new Error(`Gateway job ${job.id} has no provider`);
  return withLinks(
    {
      id: job.id,
      provider: gatewayProviderOfVia(job.via),
      model: job.modelKey,
      kind: job.kind,
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
