/**
 * Freeing ElevenLabs voice slots (#1553). One voice id can sit on several
 * rows (character ↔ talent copies), so the slot is released only when the
 * last reference goes. Callers null their own row FIRST, then release: the
 * count then says whether anyone else still needs the voice.
 */

import { getElevenLabsApiKey } from '@/models/server/elevenlabs-config';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { deleteElevenLabsVoice } from './elevenlabs-voice';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'cast', 'release-voice']);

export async function releaseVoiceIfUnreferenced(
  scopedDb: ScopedDb,
  voiceId: string
): Promise<void> {
  if ((await scopedDb.characters.countVoiceReferences(voiceId)) > 0) return;
  const apiKey = getElevenLabsApiKey();
  if (!apiKey) {
    logger.warn('ELEVENLABS_API_KEY unset; voice slot not released', {
      voiceId,
    });
    return;
  }
  await deleteElevenLabsVoice(apiKey, voiceId);
}

/** Drop the character's voice pointer and free the slot if nothing else uses it. */
export async function releaseCharacterVoice(
  scopedDb: ScopedDb,
  character: { id: string; voiceId: string | null }
): Promise<void> {
  if (!character.voiceId) return;
  await scopedDb.characters.update(character.id, { voiceId: null });
  await releaseVoiceIfUnreferenced(scopedDb, character.voiceId);
}
