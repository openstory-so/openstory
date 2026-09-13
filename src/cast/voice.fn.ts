/**
 * Is Voice Design available on this deployment (#1553)? Platform key only,
 * so it is a deployment fact, not a team one — the Generate dialog hides the
 * Voices switch when false (the launcher refuses the flag regardless).
 */

import { isElevenLabsConfigured } from '@/models/server/elevenlabs-config';
import { createServerFn } from '@tanstack/react-start';

export const getVoiceDesignAvailableFn = createServerFn({
  method: 'GET',
}).handler((): { available: boolean } => ({
  available: isElevenLabsConfigured(),
}));
