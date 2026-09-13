/**
 * ElevenLabs Voice Design + saved voices (#1553), through the official SDK
 * (`@tanstack/ai-elevenlabs` wraps TTS only). Platform key only — see
 * `elevenlabs-config.ts`.
 */

import { createElevenLabsSdk } from '@/models/server/elevenlabs-config';

export type DesignedPreview = {
  generatedVoiceId: string;
  audioBase64: string;
  mediaType: string;
};

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
