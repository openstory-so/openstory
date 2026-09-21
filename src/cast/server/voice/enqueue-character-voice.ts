/**
 * Enqueue Voice Design as a stills-style husk (#1715): insert the generating
 * version, point pending-promote at it, then trigger. Does not release the
 * current voice — the In use take stays until this husk promotes.
 */

import { characterToBible } from '@/cast/server/bibles-from-scoped';
import type { CharacterWithSheet } from '@/platform/server/db/schema';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { CharacterVoiceWorkflowInput } from '@/platform/server/workflow/types';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/models/models.config';

const VOICE_DESIGN_NEVER_STARTED = 'Voice design never started';

export async function enqueueCharacterVoiceDesign(args: {
  scopedDb: ScopedDb;
  character: CharacterWithSheet;
  userId: string;
  analysisModel: string | null;
  trigger: (payload: CharacterVoiceWorkflowInput) => Promise<string>;
}): Promise<{
  characterId: string;
  workflowRunId: string | null;
  alreadyInFlight: boolean;
  targetVersionId: string;
}> {
  const { scopedDb, character, userId, analysisModel, trigger } = args;
  const claim = await takeLiveVoiceClaimOrInsert(
    scopedDb,
    character.id,
    userId
  );
  if (claim.alreadyInFlight) {
    return {
      characterId: character.id,
      workflowRunId: claim.version.workflowRunId,
      alreadyInFlight: true,
      targetVersionId: claim.version.id,
    };
  }
  const husk = claim.version;
  const payload: CharacterVoiceWorkflowInput = {
    userId,
    teamId: scopedDb.teamId,
    sequenceId: character.sequenceId,
    characterDbId: character.id,
    characterBible: characterToBible(character),
    voiceDescription: character.voiceDescription ?? '',
    analysisModelId:
      (analysisModel ? getAnalysisModelById(analysisModel)?.id : undefined) ??
      DEFAULT_ANALYSIS_MODEL,
    targetVersionId: husk.id,
  };

  let workflowRunId: string;
  try {
    workflowRunId = await trigger(payload);
  } catch (error) {
    await scopedDb.characters.markVoiceClaimTerminal(
      husk.id,
      'failed',
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
  await scopedDb.characters.stampVoiceClaimWorkflowRunId(
    husk.id,
    workflowRunId
  );
  return {
    characterId: character.id,
    workflowRunId,
    alreadyInFlight: false,
    targetVersionId: husk.id,
  };
}

/**
 * A live husk with a run id is in flight. A live husk with none is a zombie
 * (insert-then-crash); fail it so Generate can insert a new claim.
 */
async function takeLiveVoiceClaimOrInsert(
  scopedDb: ScopedDb,
  characterId: string,
  userId: string
): Promise<{
  alreadyInFlight: boolean;
  version: { id: string; workflowRunId: string | null };
}> {
  const existing = (
    await scopedDb.characters.listLiveVoiceClaims(characterId)
  )[0];
  if (existing?.workflowRunId) {
    return { alreadyInFlight: true, version: existing };
  }
  if (existing) {
    await scopedDb.characters.markVoiceClaimTerminal(
      existing.id,
      'failed',
      VOICE_DESIGN_NEVER_STARTED
    );
  }
  let inserted = await scopedDb.characters.createPendingVoiceClaim(
    characterId,
    userId
  );
  if (inserted.created) {
    return { alreadyInFlight: false, version: inserted.version };
  }
  if (inserted.version.workflowRunId) {
    return { alreadyInFlight: true, version: inserted.version };
  }
  await scopedDb.characters.markVoiceClaimTerminal(
    inserted.version.id,
    'failed',
    VOICE_DESIGN_NEVER_STARTED
  );
  inserted = await scopedDb.characters.createPendingVoiceClaim(
    characterId,
    userId
  );
  if (inserted.created) {
    return { alreadyInFlight: false, version: inserted.version };
  }
  return { alreadyInFlight: true, version: inserted.version };
}
