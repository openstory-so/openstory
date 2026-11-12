/**
 * Model gateway request and response shapes (docs/architecture/model-gateway.md).
 * Client-safe: no env, no adapters. A request names a model key, never an endpoint.
 */

import {
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  supportsReferenceImages,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/models/models';
import { aspectRatioSchema } from '@/models/aspect-ratios';
import { mediaUrlSchema } from '@/platform/schemas/media-url.schemas';
import { studioReferenceLimit } from '@/studio/text-to-video';
import { APP_SKU_KEY_PATTERN } from '@/gateway/apps';
import { z } from 'zod';

export const GATEWAY_JOB_KINDS = ['image', 'video'] as const;
export type GatewayJobKind = (typeof GATEWAY_JOB_KINDS)[number];

export const GATEWAY_JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
] as const;
export type GatewayJobStatus = (typeof GATEWAY_JOB_STATUSES)[number];

function visibleKeys<T extends string>(models: Record<T, object>): T[] {
  return Object.entries<object>(models)
    .filter(([, entry]) => !('hidden' in entry))
    .map(([key]) => key)
    .filter((key): key is T => key in models);
}

/** Image models the gateway can serve: every visible sequence still model. */
export const GATEWAY_IMAGE_MODELS: readonly TextToImageModel[] =
  visibleKeys(IMAGE_MODELS);

/** Video models the gateway can serve; a `requiresVia` one only where that via is claimed. */
export const GATEWAY_VIDEO_MODELS: readonly ImageToVideoModel[] = visibleKeys(
  IMAGE_TO_VIDEO_MODELS
);

function isGatewayImageModel(value: string): value is TextToImageModel {
  return GATEWAY_IMAGE_MODELS.some((key) => key === value);
}

function isGatewayVideoModel(value: string): value is ImageToVideoModel {
  return GATEWAY_VIDEO_MODELS.some((key) => key === value);
}

const promptSchema = z.string().trim().min(1).max(50_000);

const imageRequestSchema = z.object({
  kind: z.literal('image'),
  model: z
    .string()
    .refine(isGatewayImageModel, { message: 'Unknown image model' })
    .describe('An image model key from GET /api/v1/gateway/models.'),
  prompt: promptSchema,
  aspectRatio: aspectRatioSchema.default('16:9'),
  referenceImageUrls: z
    .array(mediaUrlSchema)
    .max(9)
    .default([])
    .describe('Stills the model edits from, bound as @Image1…@ImageN.'),
});

const videoRequestSchema = z.object({
  kind: z.literal('video'),
  model: z
    .string()
    .refine(isGatewayVideoModel, { message: 'Unknown video model' })
    .describe('A video model key from GET /api/v1/gateway/models.'),
  prompt: promptSchema,
  aspectRatio: aspectRatioSchema.default('16:9'),
  duration: z
    .number()
    .positive()
    .optional()
    .describe(
      'Seconds; snapped to the nearest length the model accepts. Omitted: the shortest.'
    ),
  startImageUrl: mediaUrlSchema
    .optional()
    .describe('The first frame. Not with referenceImageUrls.'),
  referenceImageUrls: z
    .array(mediaUrlSchema)
    .max(9)
    .default([])
    .describe(
      'Reference stills, bound as @Image1…@ImageN. Not with startImageUrl.'
    ),
});

export const gatewayJobRequestSchema = z
  .discriminatedUnion('kind', [imageRequestSchema, videoRequestSchema])
  .superRefine((input, ctx) => {
    if (input.kind === 'image') {
      if (
        input.referenceImageUrls.length > 0 &&
        isGatewayImageModel(input.model) &&
        !supportsReferenceImages(input.model)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['referenceImageUrls'],
          message: 'This model does not take reference images',
        });
      }
      return;
    }
    if (input.startImageUrl && input.referenceImageUrls.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['referenceImageUrls'],
        message: 'Send a start frame or reference images, not both',
      });
    }
    if (!isGatewayVideoModel(input.model)) return;
    const limit = studioReferenceLimit(input.model);
    if (input.referenceImageUrls.length > limit) {
      ctx.addIssue({
        code: 'custom',
        path: ['referenceImageUrls'],
        message:
          limit === 0
            ? 'This model does not take reference images'
            : `Up to ${limit} reference images`,
      });
    }
  })
  .meta({ id: 'GatewayJobRequest' });

export type GatewayJobRequest = z.infer<typeof gatewayJobRequestSchema>;

/** The request as stored on the job and snapshotted onto the run. */
export type GatewayJobInput =
  | {
      kind: 'image';
      model: TextToImageModel;
      prompt: string;
      aspectRatio: GatewayJobRequest['aspectRatio'];
      referenceImageUrls: string[];
    }
  | {
      kind: 'video';
      model: ImageToVideoModel;
      prompt: string;
      aspectRatio: GatewayJobRequest['aspectRatio'];
      /** Already snapped to a length the model accepts. */
      duration: number;
      startImageUrl?: string;
      referenceImageUrls: string[];
    };

/** One stored output; `url` is origin-relative R2 until the API absolutizes it. */
export type GatewayJobOutput = {
  url: string;
  path: string;
  contentType: string;
};

export type GatewayJobError = { code: string; message: string };

/** `POST /api/v1/gateway/charges`: one of the caller app's declared SKUs. */
export const gatewayChargeRequestSchema = z
  .object({
    sku: z
      .string()
      .regex(APP_SKU_KEY_PATTERN, 'A SKU key from Settings → Developer → Apps')
      .describe(
        "The key of an active SKU the app declared. Its price is the app's, never the request's."
      ),
  })
  .meta({ id: 'GatewayChargeRequest' });
