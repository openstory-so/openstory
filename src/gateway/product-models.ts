/** Every gateway model the product itself calls: what the snapshot always holds and the coverage check walks. */

import {
  ELEVENLABS_GATEWAY_MODELS,
  type GatewayProvider,
  type TextGatewayProvider,
} from '@/gateway/schema';
import { getFalEndpointIds } from '@/models/fal-endpoints';
import {
  nativeGeminiImageModel,
  nativeGeminiTextModel,
  NATIVE_GEMINI_VIDEO_MODEL,
} from '@/models/gemini-native';
import {
  nativeGrokImageModel,
  nativeGrokTextModel,
  NATIVE_GROK_VIDEO_MODEL,
} from '@/models/grok-native';
import { SCRIPT_ANALYSIS_MODELS } from '@/models/models.config';
import {
  getBytePlusImageModelId,
  getBytePlusVideoModelId,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
} from '@/models/models';
import { LIPSYNC_FAL_ENDPOINT } from '@/motion/lipsync';
import { SEED_AUDIO_MODEL } from '@/cast/seed-voice';
import { typedEntries } from '@/platform/typed-object';

export type ProductGatewayModel = {
  readonly provider: GatewayProvider;
  readonly id: string;
};

export function productGatewayModels(): ProductGatewayModel[] {
  const imageKeys = typedEntries(IMAGE_MODELS).map(([key]) => key);
  const videoKeys = typedEntries(IMAGE_TO_VIDEO_MODELS).map(([key]) => key);
  const ids: Record<GatewayProvider, (string | undefined)[]> = {
    fal: [...getFalEndpointIds(), LIPSYNC_FAL_ENDPOINT],
    byteplus: [
      ...imageKeys.map(getBytePlusImageModelId),
      ...videoKeys.map(getBytePlusVideoModelId),
      SEED_AUDIO_MODEL,
    ],
    grok: [...imageKeys.map(nativeGrokImageModel), NATIVE_GROK_VIDEO_MODEL],
    gemini: [
      ...imageKeys.map(nativeGeminiImageModel),
      NATIVE_GEMINI_VIDEO_MODEL,
    ],
    // Voice design, dialogue and speech-to-speech stay direct (multipart and query parameters).
    elevenlabs: Object.keys(ELEVENLABS_GATEWAY_MODELS),
  };
  return typedEntries(ids).flatMap(([provider, list]) =>
    [...new Set(list)].flatMap((id) => (id ? [{ provider, id }] : []))
  );
}

export type ProductTextModel = {
  readonly provider: TextGatewayProvider;
  readonly id: string;
};

/** Every text card a platform-key LLM call can be priced from: OpenRouter's, and xAI's or Google's for a native route. */
export function productTextModels(): ProductTextModel[] {
  return SCRIPT_ANALYSIS_MODELS.flatMap(({ id }) => {
    const grok = nativeGrokTextModel(id);
    const gemini = nativeGeminiTextModel(id);
    return [
      { provider: 'openrouter' as const, id },
      ...(grok ? [{ provider: 'grok' as const, id: grok }] : []),
      ...(gemini ? [{ provider: 'gemini' as const, id: gemini }] : []),
    ];
  });
}
