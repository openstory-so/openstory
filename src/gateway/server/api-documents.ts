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
  GATEWAY_ERROR_MESSAGES,
  GATEWAY_JOB_KINDS,
  GATEWAY_JOB_STATUSES,
  GATEWAY_PROVIDERS,
  gatewayProviderOfVia,
} from '@/gateway/schema';
import type { GatewayModelSummary } from '@/gateway/server/catalog';
import type { GatewayJobChargeLine } from '@/gateway/server/db/gateway-jobs';
import { z } from 'zod';

const GATEWAY_PATH = `${API_V1_BASE}/gateway`;
export const GATEWAY_MODELS_PATH = `${GATEWAY_PATH}/models`;
export const GATEWAY_JOBS_PATH = `${GATEWAY_PATH}/jobs`;
const GATEWAY_SUBMIT_TEMPLATE = `${GATEWAY_PATH}/{provider}/{model}`;

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
    data: z
      .record(z.string(), z.json())
      .nullable()
      .describe(
        "The provider's JSON beside the files, such as timestamps; null when it sent only files."
      ),
    error: z
      .object({ code: z.enum(GATEWAY_ERROR_CODES), message: z.string() })
      .nullable(),
    charge: z
      .object({
        totalMicros: z
          .number()
          .int()
          .describe('The wallet debit, in microdollars.'),
        lines: z
          .array(
            z.object({
              kind: z.enum(CHARGE_LINE_KINDS),
              amountMicros: z.number().int(),
            })
          )
          .describe(
            'What the debit is made of; the lines sum to `totalMicros`.'
          ),
      })
      .nullable()
      .describe('What the job cost, once it succeeded.'),
    createdAt: z.string().meta({ format: 'date-time' }),
    completedAt: z.string().meta({ format: 'date-time' }).nullable(),
    _links: halLinksSchema,
  })
  .meta({ id: 'GatewayJob' });

export type GatewayJobResource = z.infer<typeof gatewayJobResourceSchema>;

/** A representative submit: a fal endpoint and a body in fal's own shape. */
export const EXAMPLE_GATEWAY_SUBMIT = {
  href: `${GATEWAY_PATH}/fal/fal-ai/flux/schnell`,
  body: {
    prompt:
      'Mara, a ferry mechanic, wipes her hands on a rag in the engine room',
  },
} as const;

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
      data: job.status === 'succeeded' ? job.data : null,
      // A closed set: the provider's raw text never reaches the caller.
      error: job.error
        ? {
            code: job.error.code,
            message: GATEWAY_ERROR_MESSAGES[job.error.code],
          }
        : null,
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
