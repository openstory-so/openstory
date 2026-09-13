/**
 * Freeing ElevenLabs voice slots (#1553). One voice id can sit on several
 * rows (character ↔ talent copies), so the slot is released only when the
 * last reference goes. Provider FIRST, row second: a failed delete leaves
 * the pointer on the row, so the next release attempt can try again. A
 * caller whose own row still holds the id passes `heldBy: 1` so that row
 * does not count as "someone else".
 */

import {
  getElevenLabsApiKey,
  isElevenLabsConfigured,
} from '@/models/server/elevenlabs-config';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { deleteElevenLabsVoice, elevenLabsStatus } from './elevenlabs-voice';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'cast', 'release-voice']);

export async function releaseVoiceIfUnreferenced(
  scopedDb: ScopedDb,
  voiceId: string,
  { heldBy = 0 }: { heldBy?: number } = {}
): Promise<void> {
  if ((await scopedDb.characters.getVoiceReferenceCount(voiceId)) > heldBy) {
    return;
  }
  const apiKey = getElevenLabsApiKey();
  if (!apiKey || !isElevenLabsConfigured()) {
    logger.warn('ElevenLabs not configured; voice slot not released', {
      voiceId,
    });
    return;
  }
  try {
    await deleteElevenLabsVoice(apiKey, voiceId);
  } catch (error) {
    // A revoked / wrong key is the unconfigured case with extra steps: no
    // retry with this key can free the slot, so it must not wedge the
    // delete or archive that called us. Everything else (5xx, network) is
    // retryable and propagates so the caller keeps its pointer.
    const status = elevenLabsStatus(error);
    if (status === 401 || status === 403) {
      logger.warn('ElevenLabs key rejected; voice slot not released', {
        voiceId,
        status,
      });
      return;
    }
    throw error;
  }
}

/** Free the slot if nothing else uses it, then drop the character's pointer. */
export async function releaseCharacterVoice(
  scopedDb: ScopedDb,
  character: { id: string; voiceId: string | null }
): Promise<void> {
  if (!character.voiceId) return;
  await releaseVoiceIfUnreferenced(scopedDb, character.voiceId, { heldBy: 1 });
  await scopedDb.characters.update(character.id, { voiceId: null });
}
