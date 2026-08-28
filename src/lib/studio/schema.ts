/**
 * Images and Videos (#1274). Client-safe: no env, no adapters.
 *
 * Sequence image + video families only — not the flagged `/models` catalog.
 * Video `mode` picks the endpoint: T2V sibling, reference-to-video sibling,
 * or the sequence image-to-video endpoint (frames).
 */

import {
  getEditEndpoint,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  isValidImageToVideoModel,
  isValidTextToImageModel,
  supportsReferenceImages,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import { aspectRatioSchema } from '@/lib/constants/aspect-ratios';
import { mediaUrlSchema } from '@/lib/schemas/media-url.schemas';
import {
  STUDIO_VIDEO_MODES,
  studioAudioLimit,
  studioReferenceLimit,
  studioSupportsEndFrame,
  studioVideoEndpointId,
  studioVideoRefLimit,
} from '@/lib/studio/text-to-video';
import { z } from 'zod';

const visibleImageModelKeys = Object.entries(IMAGE_MODELS)
  .filter(([, model]) => !('hidden' in model))
  .map(([key]) => key);

const imageModelKeySchema = z
  .string()
  .refine(
    (value): value is TextToImageModel =>
      isValidTextToImageModel(value) && visibleImageModelKeys.includes(value),
    { message: 'Unknown image model' }
  );

const videoModelKeySchema = z
  .string()
  .refine(
    (value): value is ImageToVideoModel => isValidImageToVideoModel(value),
    { message: 'Unknown video model' }
  );

const promptSchema = z
  .string()
  .trim()
  .min(1, 'Enter a prompt')
  .max(50_000, 'Prompt is too long');

const countSchema = z.number().int().min(1).max(4);

export const studioActivitySchema = z.enum(['image', 'video']);
export const studioSortSchema = z.enum(['newest', 'oldest']);
export const studioReferenceKindSchema = z.enum(['image', 'video', 'audio']);

export type StudioActivity = z.infer<typeof studioActivitySchema>;
export type StudioSort = z.infer<typeof studioSortSchema>;
export type StudioReferenceKind = z.infer<typeof studioReferenceKindSchema>;

export const studioCreateInputSchema = z.discriminatedUnion('activity', [
  z
    .object({
      activity: z.literal('image'),
      prompt: promptSchema,
      imageModel: imageModelKeySchema,
      aspectRatio: aspectRatioSchema,
      count: countSchema.default(1),
      /** Routes to the model's edit endpoint; bound as `@Image1`…`@ImageN`. */
      referenceImages: z.array(mediaUrlSchema).max(9).default([]),
    })
    .superRefine((input, ctx) => {
      if (
        input.referenceImages.length > 0 &&
        !supportsReferenceImages(input.imageModel)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['referenceImages'],
          message: `${IMAGE_MODELS[input.imageModel].name} does not take reference images`,
        });
      }
    }),
  z
    .object({
      activity: z.literal('video'),
      prompt: promptSchema,
      videoModel: videoModelKeySchema,
      aspectRatio: aspectRatioSchema,
      duration: z.number().positive(),
      count: countSchema.default(1),
      generateAudio: z.boolean().optional(),
      mode: z.enum(STUDIO_VIDEO_MODES).default('text'),
      /** Reference mode: stills bound as `@Image1`…`@ImageN`, in order. */
      referenceImages: z.array(mediaUrlSchema).max(9).default([]),
      /** Reference mode: clips bound as `@Video1`…`@VideoN`. */
      referenceVideos: z.array(mediaUrlSchema).max(3).default([]),
      /** Reference mode: audio clips bound as `@Audio1`…`@AudioN`. */
      referenceAudio: z.array(mediaUrlSchema).max(3).default([]),
      /** Frames mode: the first frame, and optionally the last. */
      startImageUrl: mediaUrlSchema.optional(),
      endImageUrl: mediaUrlSchema.optional(),
    })
    .superRefine((input, ctx) => {
      const limit = studioReferenceLimit(input.videoModel);
      if (input.mode === 'reference') {
        if (limit === 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['mode'],
            message: `${IMAGE_TO_VIDEO_MODELS[input.videoModel].name} does not take reference images`,
          });
        }
        if (input.referenceImages.length + input.referenceVideos.length === 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['referenceImages'],
            message: 'Attach at least one reference image or video',
          });
        }
        if (
          input.referenceVideos.length > studioVideoRefLimit(input.videoModel)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['referenceVideos'],
            message: `Up to ${studioVideoRefLimit(input.videoModel)} reference videos`,
          });
        }
        if (input.referenceAudio.length > studioAudioLimit(input.videoModel)) {
          ctx.addIssue({
            code: 'custom',
            path: ['referenceAudio'],
            message: `Up to ${studioAudioLimit(input.videoModel)} audio clips`,
          });
        }
        if (input.referenceImages.length > limit) {
          ctx.addIssue({
            code: 'custom',
            path: ['referenceImages'],
            message: `Up to ${limit} reference images`,
          });
        }
      }
      if (input.mode === 'frames') {
        if (!input.startImageUrl) {
          ctx.addIssue({
            code: 'custom',
            path: ['startImageUrl'],
            message: 'Pick a start frame',
          });
        }
        if (input.endImageUrl && !studioSupportsEndFrame(input.videoModel)) {
          ctx.addIssue({
            code: 'custom',
            path: ['endImageUrl'],
            message: `${IMAGE_TO_VIDEO_MODELS[input.videoModel].name} does not take an end frame`,
          });
        }
      }
    }),
]);

export type StudioCreateInput = z.infer<typeof studioCreateInputSchema>;

type StudioCreateAsset = {
  id: string;
  workflowRunId: string;
};

export type StudioCreateResult = {
  assets: StudioCreateAsset[];
};

export function studioEndpointId(input: StudioCreateInput): string {
  if (input.activity === 'video') {
    return studioVideoEndpointId(input.videoModel, input.mode);
  }
  return (
    (input.referenceImages.length > 0
      ? getEditEndpoint(input.imageModel)
      : null) ?? IMAGE_MODELS[input.imageModel].id
  );
}

export function studioModelName(input: StudioCreateInput): string {
  if (input.activity === 'video') {
    return IMAGE_TO_VIDEO_MODELS[input.videoModel].name;
  }
  return IMAGE_MODELS[input.imageModel].name;
}
