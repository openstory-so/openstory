/**
 * What the gateway serves and what a job is held at. Platform keys only, so
 * the vias are the platform's: BytePlus Ark is claimed wherever it is configured.
 */

import {
  estimateImageCost,
  estimateStudioVideoCost,
  gateEstimate,
} from '@/billing/cost-estimation';
import type { Microdollars } from '@/billing/money';
import type { getEffectiveFalPricing } from '@/billing/server/fal-pricing-live';
import { ASPECT_RATIOS, type AspectRatio } from '@/models/aspect-ratios';
import {
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  isOfferedVideoModel,
  supportsReferenceImages,
} from '@/models/models';
import { claimBytePlusVia } from '@/models/server/byteplus-config';
import { DEFAULT_RESOLUTION } from '@/models/resolutions';
import {
  GATEWAY_IMAGE_MODELS,
  GATEWAY_VIDEO_MODELS,
  type GatewayJobInput,
} from '@/gateway/schema';
import {
  studioReferenceLimit,
  studioVideoAspectRatios,
  studioVideoDurations,
} from '@/studio/text-to-video';

export type GatewayVias = { byteplus: boolean };

export function gatewayVias(): GatewayVias {
  return {
    byteplus:
      claimBytePlusVia({ native: true, usingOwnFalKey: false }) === 'byteplus',
  };
}

export type GatewayModelEntry =
  | {
      kind: 'image';
      key: string;
      name: string;
      accepts: {
        aspectRatios: AspectRatio[];
        maxReferenceImages: number;
      };
    }
  | {
      kind: 'video';
      key: string;
      name: string;
      accepts: {
        aspectRatios: AspectRatio[];
        durations: number[];
        startImage: boolean;
        maxReferenceImages: number;
      };
    };

const ALL_ASPECTS = ASPECT_RATIOS.map((option) => option.value);

/** The catalog `GET /api/v1/gateway/models` lists. */
export function listGatewayModels(vias: GatewayVias): GatewayModelEntry[] {
  const images: GatewayModelEntry[] = GATEWAY_IMAGE_MODELS.map((key) => ({
    kind: 'image',
    key,
    name: IMAGE_MODELS[key].name,
    accepts: {
      aspectRatios: ALL_ASPECTS,
      maxReferenceImages: supportsReferenceImages(key) ? 9 : 0,
    },
  }));
  const videos: GatewayModelEntry[] = GATEWAY_VIDEO_MODELS.filter((key) =>
    isOfferedVideoModel(key, vias)
  ).map((key) => ({
    kind: 'video',
    key,
    name: IMAGE_TO_VIDEO_MODELS[key].name,
    accepts: {
      aspectRatios: [...studioVideoAspectRatios(key)],
      durations: [...studioVideoDurations(key)],
      startImage: true,
      maxReferenceImages: studioReferenceLimit(key),
    },
  }));
  return [...images, ...videos];
}

type FalPricing = Awaited<ReturnType<typeof getEffectiveFalPricing>>;

/** The hold a job reserves at submit; the settle captures what the provider billed. */
export function estimateGatewayJobCost(
  input: GatewayJobInput,
  pricing: FalPricing
): Microdollars {
  if (input.kind === 'image') {
    return gateEstimate(
      estimateImageCost(input.model, input.aspectRatio, 1, {
        pricing,
        resolution: DEFAULT_RESOLUTION,
        edit: input.referenceImageUrls.length > 0,
      }),
      { model: input.model, operation: 'gateway-image' }
    );
  }
  return gateEstimate(
    estimateStudioVideoCost(input.model, input.duration, {
      pricing,
      resolution: DEFAULT_RESOLUTION,
      mode: gatewayVideoMode(input),
    }),
    { model: input.model, operation: 'gateway-video' }
  );
}

/** Which Studio endpoint family a video job uses. */
export function gatewayVideoMode(
  input: Extract<GatewayJobInput, { kind: 'video' }>
): 'text' | 'frames' | 'reference' {
  if (input.startImageUrl) return 'frames';
  return input.referenceImageUrls.length > 0 ? 'reference' : 'text';
}
