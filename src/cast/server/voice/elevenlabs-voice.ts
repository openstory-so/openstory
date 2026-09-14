/**
 * ElevenLabs Voice Design + saved voices (#1553), through the official SDK
 * (`@tanstack/ai-elevenlabs` wraps TTS only). Platform key only — see
 * `elevenlabs-config.ts`.
 */

import {
  toCatalogVoiceFromLibrary,
  voiceConsumesAccountSlot,
  type CatalogVoiceFilters,
  type CatalogVoicePage,
  type SavedVoiceMeta,
} from '@/cast/voice';
import { createElevenLabsSdk } from '@/models/server/elevenlabs-config';

export type DesignedPreview = {
  generatedVoiceId: string;
  audioBase64: string;
  mediaType: string;
};

/**
 * ElevenLabs' own examples sit at 20–40. The API default (5) under-follows a
 * structured brief; high values make the take sound artificial / robotic.
 * https://elevenlabs.io/docs/eleven-creative/voices/voice-design#prompting-guide
 */
export const VOICE_DESIGN_GUIDANCE_SCALE = 25;

/** -1..1. Higher is cleaner with less variety. */
export const VOICE_DESIGN_QUALITY = 0.5;

/** Previews cost no voice slot; only `saveDesignedVoice` does. */
export async function designVoicePreviews(
  apiKey: string,
  voiceDescription: string
): Promise<DesignedPreview[]> {
  const client = await createElevenLabsSdk(apiKey, 120);
  const result = await client.textToVoice.design({
    voiceDescription,
    modelId: 'eleven_ttv_v3',
    autoGenerateText: true,
    shouldEnhance: true,
    guidanceScale: VOICE_DESIGN_GUIDANCE_SCALE,
    quality: VOICE_DESIGN_QUALITY,
    // 192 kbps needs the Creator tier; 128 does not.
    outputFormat: 'mp3_44100_128',
  });
  return result.previews.map((preview) => ({
    generatedVoiceId: preview.generatedVoiceId,
    audioBase64: preview.audioBase64,
    mediaType: preview.mediaType,
  }));
}

/** HTTP status of an SDK error, if it carried one. */
export function elevenLabsStatus(error: unknown): number | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
    ? error.statusCode
    : undefined;
}

/** ElevenLabs' own `detail.message` (or `detail.status`) from an SDK error body. */
export function elevenLabsDetail(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('body' in error)) return;
  const body: unknown = error.body;
  if (typeof body !== 'object' || body === null || !('detail' in body)) return;
  const detail: unknown = body.detail;
  if (typeof detail === 'string') return detail;
  if (typeof detail !== 'object' || detail === null) return;
  for (const key of ['message', 'status'] as const) {
    if (key in detail) {
      const value: unknown = Reflect.get(detail, key);
      if (typeof value === 'string' && value) return value;
    }
  }
  return;
}

/**
 * Spends one account-wide voice slot. Release through
 * `releaseVoiceIfUnreferenced` (`release-voice.ts`), never this file's delete.
 */
export async function saveDesignedVoice(
  apiKey: string,
  args: {
    voiceName: string;
    voiceDescription: string;
    generatedVoiceId: string;
  }
): Promise<string> {
  const client = await createElevenLabsSdk(apiKey);
  const voice = await client.textToVoice.create(args);
  return voice.voiceId;
}

/** Idempotent: a voice that is already gone is not an error. */
export async function deleteElevenLabsVoice(
  apiKey: string,
  voiceId: string
): Promise<void> {
  const client = await createElevenLabsSdk(apiKey);
  try {
    await client.voices.delete(voiceId);
  } catch (error) {
    if (elevenLabsStatus(error) === 404) return;
    throw error;
  }
}

export async function getElevenLabsVoice(
  apiKey: string,
  voiceId: string
): Promise<SavedVoiceMeta | null> {
  const client = await createElevenLabsSdk(apiKey);
  try {
    const voice = await client.voices.get(voiceId);
    const category = voice.category ?? '';
    return {
      voiceId: voice.voiceId,
      name: voice.name?.trim() || 'Saved voice',
      category,
      previewUrl: voice.previewUrl ?? null,
      isPremade: !voiceConsumesAccountSlot(category),
    };
  } catch (error) {
    if (elevenLabsStatus(error) === 404) return null;
    throw error;
  }
}

export async function listLibraryVoices(
  apiKey: string,
  args: {
    search?: string;
    page?: number;
    filters?: CatalogVoiceFilters;
  } = {}
): Promise<CatalogVoicePage> {
  const client = await createElevenLabsSdk(apiKey);
  const page = args.page ?? 0;
  const filters = args.filters ?? {};
  const result = await client.voices.getShared({
    pageSize: 30,
    page,
    sort: args.search ? 'usage_character_count_1y' : 'trending',
    includeCustomRates: false,
    ...(args.search && { search: args.search }),
    ...(filters.gender && { gender: filters.gender }),
    ...(filters.age && { age: filters.age }),
    ...(filters.quality === 'studio' && { category: 'high_quality' }),
  });
  return {
    voices: result.voices.map((voice) =>
      toCatalogVoiceFromLibrary({
        voiceId: voice.voiceId,
        publicOwnerId: voice.publicOwnerId,
        name: voice.name,
        description: voice.description,
        previewUrl: voice.previewUrl,
        category: voice.category,
        gender: voice.gender,
        age: voice.age,
        accent: voice.accent,
        language: voice.language,
        useCase: voice.useCase,
        descriptive: voice.descriptive,
      })
    ),
    hasMore: result.hasMore,
    nextPage: result.hasMore ? page + 1 : undefined,
  };
}

async function addSharedVoice(
  apiKey: string,
  args: { publicOwnerId: string; voiceId: string; name: string }
): Promise<string> {
  const client = await createElevenLabsSdk(apiKey);
  const added = await client.voices.share(args.publicOwnerId, args.voiceId, {
    newName: args.name,
  });
  return added.voiceId;
}

export type AssignableVoicePick =
  | { source: 'premade'; voiceId: string }
  | {
      source: 'library';
      voiceId: string;
      publicOwnerId: string;
      name: string;
    };

/**
 * Resolve a picker selection to an account voice id. Premade ids are used
 * as-is (no slot). Library voices are copied onto the platform account.
 */
export async function resolveAssignableVoiceId(
  apiKey: string,
  pick: AssignableVoicePick
): Promise<string> {
  if (pick.source === 'premade') {
    const voice = await getElevenLabsVoice(apiKey, pick.voiceId);
    if (!voice) {
      throw Object.assign(new Error('Voice not found'), { statusCode: 404 });
    }
    if (voiceConsumesAccountSlot(voice.category)) {
      throw Object.assign(new Error('Not a default ElevenLabs voice'), {
        statusCode: 400,
      });
    }
    return voice.voiceId;
  }
  return addSharedVoice(apiKey, {
    publicOwnerId: pick.publicOwnerId,
    voiceId: pick.voiceId,
    name: pick.name,
  });
}
