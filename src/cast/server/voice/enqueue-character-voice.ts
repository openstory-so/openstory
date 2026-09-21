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
  const live = await scopedDb.characters.listLiveVoiceClaims(character.id);
  const existing = live[0];
  if (existing) {
    return {
      characterId: character.id,
      workflowRunId: existing.workflowRunId,
      alreadyInFlight: true,
      targetVersionId: existing.id,
    };
  }

  let husk: { id: string };
  try {
    husk = await scopedDb.characters.createPendingVoiceClaim(
      character.id,
      userId
    );
  } catch (error) {
    const raced = (
      await scopedDb.characters.listLiveVoiceClaims(character.id)
    )[0];
    if (!raced) throw error;
    return {
      characterId: character.id,
      workflowRunId: raced.workflowRunId,
      alreadyInFlight: true,
      targetVersionId: raced.id,
    };
  }
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
