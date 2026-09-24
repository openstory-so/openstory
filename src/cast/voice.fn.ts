/**
 * Voice Design availability and the ElevenLabs catalog (#1553 / #1629).
 * Platform key only, so availability is a deployment fact — the Generate
 * dialog hides the Voices switch when false.
 */

import {
  getElevenLabsApiKey,
  isElevenLabsConfigured,
} from '@/models/server/elevenlabs-config';
import {
  getElevenLabsVoice,
  listLibraryVoices,
} from '@/cast/server/voice/elevenlabs-voice';
import { voiceProviderOf, seedVoiceFolder } from '@/cast/seed-voice';
import { isSeedVoiceConfigured } from '@/models/server/seed-speech-config';
import {
  getPublicUrl,
  STORAGE_BUCKETS,
} from '@/platform/server/storage/buckets';
import {
  VOICE_LANGUAGES,
  VOICE_NATIONALITIES,
  type SavedVoiceMeta,
  type VoiceLanguageFilter,
  type VoiceNationalityFilter,
} from '@/cast/voice';
import { authWithTeamMiddleware } from '@/platform/middleware.fn';
import { ValidationError } from '@/platform/errors';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

const languageSchema = z
  .string()
  .refine((value): value is VoiceLanguageFilter =>
    VOICE_LANGUAGES.some((language) => language.value === value)
  );
const nationalitySchema = z
  .string()
  .refine((value): value is VoiceNationalityFilter =>
    VOICE_NATIONALITIES.some((nationality) => nationality.value === value)
  );

export const getVoiceDesignAvailableFn = createServerFn({
  method: 'GET',
}).handler((): { available: boolean; seed: boolean } => ({
  available: isElevenLabsConfigured(),
  // New voices are Seed voices, whose takes are paid one by one (#1765).
  seed: isSeedVoiceConfigured(),
}));

function requireElevenLabsKey(): string {
  const apiKey = getElevenLabsApiKey();
  if (!apiKey || !isElevenLabsConfigured()) {
    throw new ValidationError('Voice design is not configured');
  }
  return apiKey;
}

export const listElevenLabsVoicesFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(
    zodValidator(
      z.object({
        search: z.string().trim().max(200).optional(),
        page: z.number().int().min(0).optional(),
        gender: z.enum(['male', 'female', 'neutral']).optional(),
        age: z.enum(['young', 'middle_aged', 'old']).optional(),
        quality: z.enum(['studio', 'any']).optional(),
        language: languageSchema.optional(),
        accent: nationalitySchema.optional(),
      })
    )
  )
  .handler(async ({ data }) => {
    const apiKey = requireElevenLabsKey();
    return listLibraryVoices(apiKey, {
      search: data.search || undefined,
      page: data.page,
      filters: {
        gender: data.gender,
        age: data.age,
        quality: data.quality,
        language: data.language,
        accent: data.accent,
      },
    });
  });

export const getSavedVoiceFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.object({ voiceId: z.string().min(1).max(128) })))
  .handler(async ({ data }): Promise<SavedVoiceMeta | null> => {
    // A Seed voice is clips in R2, not an ElevenLabs voice (#1765).
    if (voiceProviderOf(data.voiceId) === 'seed') {
      return {
        voiceId: data.voiceId,
        name: 'Seed voice',
        category: 'generated',
        previewUrl: getPublicUrl(
          STORAGE_BUCKETS.AUDIO,
          `${seedVoiceFolder(data.voiceId)}/read.wav`
        ),
        isPremade: false,
      };
    }
    const apiKey = requireElevenLabsKey();
    return getElevenLabsVoice(apiKey, data.voiceId);
  });
