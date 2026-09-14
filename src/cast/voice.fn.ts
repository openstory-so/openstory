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
import { authWithTeamMiddleware } from '@/platform/middleware.fn';
import { ValidationError } from '@/platform/errors';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

export const getVoiceDesignAvailableFn = createServerFn({
  method: 'GET',
}).handler((): { available: boolean } => ({
  available: isElevenLabsConfigured(),
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
      },
    });
  });

export const getElevenLabsVoiceFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.object({ voiceId: z.string().min(1).max(128) })))
  .handler(async ({ data }) => {
    const apiKey = requireElevenLabsKey();
    return getElevenLabsVoice(apiKey, data.voiceId);
  });
