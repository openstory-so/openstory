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
  listPremadeVoices,
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
        source: z.enum(['premade', 'library']),
        search: z.string().trim().max(200).optional(),
        page: z.number().int().min(0).optional(),
        nextPageToken: z.string().min(1).optional(),
      })
    )
  )
  .handler(async ({ data }) => {
    const apiKey = requireElevenLabsKey();
    const search = data.search || undefined;
    if (data.source === 'premade') {
      return listPremadeVoices(apiKey, {
        search,
        nextPageToken: data.nextPageToken,
      });
    }
    return listLibraryVoices(apiKey, { search, page: data.page });
  });

export const getElevenLabsVoiceFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .validator(zodValidator(z.object({ voiceId: z.string().min(1).max(128) })))
  .handler(async ({ data }) => {
    const apiKey = requireElevenLabsKey();
    return getElevenLabsVoice(apiKey, data.voiceId);
  });
