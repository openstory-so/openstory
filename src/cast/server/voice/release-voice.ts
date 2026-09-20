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
import {
  deleteElevenLabsVoice,
  elevenLabsStatus,
  getElevenLabsVoice,
} from './elevenlabs-voice';
import { voiceConsumesAccountSlot } from '@/cast/voice';
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
    const voice = await getElevenLabsVoice(apiKey, voiceId);
    if (!voice) {
      // Already gone at the provider (a retry after a failed row write, or a
      // dashboard delete): the history rows naming it are dead all the same.
      await scopedDb.characters.markVoiceReleased(voiceId);
      return;
    }
    if (!voiceConsumesAccountSlot(voice.category)) {
      return;
    }
    await deleteElevenLabsVoice(apiKey, voiceId);
    // The id is gone at the provider, so every history row still naming it is
    // now unselectable (#1657) — stamp them before anyone offers one back.
    await scopedDb.characters.markVoiceReleased(voiceId);
  } catch (error) {
    // A revoked / wrong key is the unconfigured case with extra steps: no
    // retry with this key can free the slot, so it must not wedge the
    // delete or archive that called us. Everything else (5xx, network) is
    // retryable and propagates so the caller keeps its pointer.
    const status = elevenLabsStatus(error);
    if (status === 401 || status === 403 || status === 400) {
      logger.warn('ElevenLabs refused the delete; voice slot not released', {
        voiceId,
        status,
      });
      return;
    }
    throw error;
  }
}

/**
 * Release the voice a row WAS holding, after the row already points at its
 * replacement. The switch is committed, so a failed release must not read as
 * a failed switch: it is logged, and the old id's history row stays
 * un-released, so selecting it and switching away again retries.
 */
export async function releaseReplacedVoice(
  scopedDb: ScopedDb,
  replacedVoiceId: string | null,
  currentVoiceId: string | null
): Promise<void> {
  if (!replacedVoiceId || replacedVoiceId === currentVoiceId) return;
  try {
    await releaseVoiceIfUnreferenced(scopedDb, replacedVoiceId);
  } catch (error) {
    logger.error('Replaced voice not released; its slot is still held', {
      replacedVoiceId,
      currentVoiceId,
      err: error,
    });
  }
}

/** Free the slot if nothing else uses it, then drop the character's pointer. */
export async function releaseCharacterVoice(
  scopedDb: ScopedDb,
  character: { id: string; voiceId: string | null }
): Promise<void> {
  if (!character.voiceId) return;
  await releaseVoiceIfUnreferenced(scopedDb, character.voiceId, { heldBy: 1 });
  await scopedDb.characters.updateVoice(
    character.id,
    { voiceId: null },
    // 'removed' says the character dropped the id; only `releasedAt` says the
    // provider slot was actually freed.
    'removed'
  );
}
