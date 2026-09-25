/**
 * ElevenLabs Voice Design + saved voices (#1553). Preview generation goes
 * through the `@tanstack/ai-elevenlabs` Voice Design adapter (#1640); saving
 * a preview and all voice management (delete/get/list/share) stay on the
 * official SDK because the adapter has no standalone surface for them — see
 * `elevenlabs-config.ts`. Platform key only.
 */

import { generateVoice } from '@tanstack/ai';
import {
  toCatalogVoiceFromLibrary,
  voiceConsumesAccountSlot,
  type CatalogVoiceFilters,
  type CatalogVoicePage,
  type SavedVoiceMeta,
} from '@/cast/voice';
import {
  createElevenLabsSdk,
  elevenLabsAdapterConfig,
  loadElevenLabsVoiceDesign,
} from '@/models/server/elevenlabs-config';

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

// No `quality` here, though the adapter's provider options accept one: the
// live /v1/text-to-voice/design endpoint rejects it, so sending it fails
// every design call. `guidanceScale` is the knob that actually shapes the
// take.

/** Previews cost no voice slot; only `saveDesignedVoice` does. */
export async function designVoicePreviews(
  apiKey: string,
  voiceDescription: string
): Promise<DesignedPreview[]> {
  const createElevenLabsVoiceDesign = await loadElevenLabsVoiceDesign();
  const adapterConfig = elevenLabsAdapterConfig(apiKey, 120);
  const adapter = createElevenLabsVoiceDesign('eleven_ttv_v3', apiKey, {
    timeoutInSeconds: adapterConfig.timeoutInSeconds,
    ...(adapterConfig.baseURL && { baseURL: adapterConfig.baseURL }),
  });
  const result = await generateVoice({
    adapter,
    prompt: voiceDescription,
    modelOptions: {
      autoGenerateText: true,
      shouldEnhance: true,
      guidanceScale: VOICE_DESIGN_GUIDANCE_SCALE,
      // 192 kbps needs the Creator tier; 128 does not.
      outputFormat: 'mp3_44100_128',
    },
  });
  return result.voices.map((voice) => {
    // `audio`/`contentType` are optional on the generic `GeneratedVoice`
    // shape, but ElevenLabs' design endpoint always returns both.
    if (!voice.audio || !voice.contentType) {
      throw new Error('ElevenLabs voice preview is missing audio data');
    }
    return {
      generatedVoiceId: voice.voiceId,
      audioBase64: voice.audio,
      mediaType: voice.contentType,
    };
  });
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

const elevenLabsDetailCode = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('body' in error)) return;
  const body: unknown = error.body;
  if (typeof body !== 'object' || body === null || !('detail' in body)) return;
  const detail: unknown = body.detail;
  if (typeof detail !== 'object' || detail === null || !('code' in detail)) {
    return;
  }
  const code: unknown = detail.code;
  return typeof code === 'string' && code ? code : undefined;
};

/**
 * A voice (or preview) ElevenLabs no longer has. GET/DELETE use HTTP 400
 * + `voice_not_found`, not 404 (#1709). Other 400s (slot limit, rejected
 * description) must still propagate.
 */
export function isElevenLabsVoiceMissing(error: unknown): boolean {
  const status = elevenLabsStatus(error);
  if (status === 404) return true;
  return status === 400 && elevenLabsDetailCode(error) === 'voice_not_found';
}

/** A generatedVoiceId that already ran create() — ElevenLabs will not save it twice. */
export function isElevenLabsVoiceAlreadyCreated(error: unknown): boolean {
  const status = elevenLabsStatus(error);
  if (status !== 400 && status !== 409) return false;
  return /already been created/i.test(elevenLabsDetail(error) ?? '');
}

/**
 * Spends one account-wide voice slot. Release through
 * `releaseVoiceIfUnreferenced` (`release-voice.ts`), never this file's delete.
 *
 * Stays on the raw SDK: the Voice Design adapter's `generateVoice` only
 * promotes the preview it just generated (`voices[0]`) and can't save an
 * arbitrary previously-generated `generatedVoiceId` on its own, which is
 * what this workflow step needs.
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
    if (isElevenLabsVoiceMissing(error)) return;
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
    if (isElevenLabsVoiceMissing(error)) return null;
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
    ...(filters.language && { language: filters.language }),
    ...(filters.accent && { accent: filters.accent }),
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

/** The Scribe model every take is checked with (#1765). */
export const SCRIBE_MODEL = 'scribe_v2';

/** A word Scribe heard, seconds. */
export type HeardWord = { text: string; start: number; end: number };

/**
 * Scribe transcription with word timings (#1765). The check that a Seed take
 * said the script and nothing else — Seed's own subtitles only align the
 * script, so they can never show an invented word.
 */
export async function transcribeSpeech(
  apiKey: string,
  audio: Uint8Array<ArrayBuffer>,
  contentType: string
): Promise<{ text: string; words: HeardWord[]; seconds: number }> {
  const client = await createElevenLabsSdk(apiKey, 120);
  const result = await client.speechToText.convert({
    modelId: SCRIBE_MODEL,
    file: new Blob([audio], { type: contentType }),
    languageCode: 'en',
    timestampsGranularity: 'word',
    tagAudioEvents: false,
  });
  if (!('words' in result)) {
    throw new Error('Scribe returned no word timings');
  }
  return {
    text: result.text,
    words: result.words.flatMap((word) =>
      word.type === 'word' && word.start != null && word.end != null
        ? [{ text: word.text, start: word.start, end: word.end }]
        : []
    ),
    seconds: result.audioDurationSecs ?? 0,
  };
}

/** Voice isolation (#1765): strips what Seed adds around a voice. Returns MP3. */
export async function isolateVoice(
  apiKey: string,
  audio: Uint8Array<ArrayBuffer>,
  contentType: string
): Promise<Uint8Array<ArrayBuffer>> {
  const client = await createElevenLabsSdk(apiKey, 120);
  const stream = await client.audioIsolation.convert({
    audio: new Blob([audio], { type: contentType }),
  });
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
