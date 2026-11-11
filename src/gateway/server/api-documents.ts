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
  gatewayJobRequestSchema,
} from '@/gateway/schema';
import type { GatewayJobChargeLine } from '@/gateway/server/db/gateway-jobs';
import type { GatewayModelEntry } from '@/gateway/server/models';
import { z } from 'zod';

const GATEWAY_PATH = `${API_V1_BASE}/gateway`;
export const GATEWAY_MODELS_PATH = `${GATEWAY_PATH}/models`;
export const GATEWAY_JOBS_PATH = `${GATEWAY_PATH}/jobs`;

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

/** A representative submit body, valid against the request schema. */
export const EXAMPLE_GATEWAY_JOB_BODY = {
  kind: 'image',
  model: 'gpt_image_2',
  prompt: 'A lighthouse at dusk, oil painting',
  aspectRatio: '16:9',
} as const;

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
