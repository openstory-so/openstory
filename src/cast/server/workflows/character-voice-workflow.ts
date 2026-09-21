/**
 * The `CharacterVoiceWorkflow` durable workflow (#1553 / #1715).
 *
 * One character's ElevenLabs voice: draft a description from the bible when
 * the character has none, Voice Design → previews parked in R2, save the top
 * preview as a voice. The generating husk already exists as `targetVersionId`;
 * persist completes it in place and promotes only if
 * `pendingPromoteVoiceVersionId` still names it. Otherwise the husk is failed
 * and the unused saved id is released. The current In use voice stays until
 * promote — do not release it first. Spawned per speaking character by
 * `CharacterBibleWorkflow`; triggered by Generate on the character card.
 */

import { voiceDescriptionSchema } from '@/sequences/response-schemas';
import {
  ELEVENLABS_VOICE_DESIGN_ENDPOINT,
  VOICE_DESIGN_COST,
} from '@/billing/elevenlabs-pricing';
import { deductWorkflowCredits } from '@/billing/server/workflow-deduction';
import { generateId } from '@/platform/id';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { VoicePreview } from '@/platform/server/db/schema';
import { getGenerationChannel } from '@/platform/realtime';
import { recordProvenance } from '@/platform/server/compliance/provenance';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { uploadFile } from '#storage';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import type {
  CharacterVoiceWorkflowInput,
  CharacterVoiceWorkflowResult,
} from '@/platform/server/workflow/types';
import { markPreviewUnusable } from '@/cast/voice';
import {
  releaseReplacedVoice,
  releaseVoiceIfUnreferenced,
} from '@/cast/server/voice/release-voice';
import { durableLLMCallCf } from '@/models/server/llm-call-helper';
import {
  designVoicePreviews,
  saveDesignedVoice,
} from '../voice/elevenlabs-voice';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'workflow', 'character-voice']);

export class CharacterVoiceWorkflow extends OpenStoryWorkflowEntrypoint<CharacterVoiceWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<CharacterVoiceWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<CharacterVoiceWorkflowResult> {
    const input = event.payload;
    const { characterDbId, sequenceId, characterBible } = input;
    const channel = getGenerationChannel(sequenceId);
    const targetVersionId = input.targetVersionId;
    // Stamp the child instance id before design so reconcile can verify a
    // bible-spawned husk (insert has no run id) instead of failing it at 5 min.
    if (targetVersionId) {
      await step.do('stamp-voice-claim-run', async () =>
        scopedDb.characters.stampVoiceClaimWorkflowRunId(
          targetVersionId,
          event.instanceId
        )
      );
    }
    await channel.emit('generation.character-voice:progress', {
      characterId: characterDbId,
      status: 'generating',
    });

    const voiceDescription =
      input.voiceDescription.trim() ||
      (
        await durableLLMCallCf(
          step,
          {
            name: 'voice-description',
            phase: { number: 3, name: 'Designing voices…' },
            promptName: 'phase/voice-design-chat',
            promptVariables: {
              character: JSON.stringify(characterBible, null, 2),
            },
            modelId: input.analysisModelId,
            responseSchema: voiceDescriptionSchema,
          },
          {
            sequenceId,
            userId: input.userId,
            workflowRunId: event.instanceId,
            scopedDb,
            reservationId: input.reservationId,
          }
        )
      ).voiceDescription;

    // Previews are free of slots; they land in R2 so the card can audition
    // them after the ElevenLabs preview ids age out.
    const previews = await step.do('design-voice', async () => {
      const { key } = await scopedDb.credentials.resolveKey('elevenlabs');
      const designed = await designVoicePreviews(key, voiceDescription);
      const stored: VoicePreview[] = [];
      for (const preview of designed) {
        const path = `${input.teamId}/${sequenceId}/${characterDbId}/${generateId()}.mp3`;
        const result = await uploadFile(
          STORAGE_BUCKETS.AUDIO,
          path,
          Buffer.from(preview.audioBase64, 'base64'),
          { contentType: preview.mediaType || 'audio/mpeg', upsert: true }
        );
        stored.push({
          generatedVoiceId: preview.generatedVoiceId,
          url: result.publicUrl,
          path,
          takeNumber: stored.length + 1,
        });
      }
      if (stored.length === 0) {
        throw new Error('Voice Design returned no previews');
      }
      return stored;
    });

    await step.do('record-provenance', async () => {
      const top = previews[0];
      if (!top) return;
      await recordProvenance(scopedDb.provenance, {
        teamId: input.teamId,
        userId: input.userId,
        assetKind: 'character_voice',
        assetId: characterDbId,
        storageKey: top.path,
        provider: 'elevenlabs',
        model: 'eleven_ttv_v3',
        workflowRunId: event.instanceId,
        prompt: voiceDescription,
        sequenceId,
      });
    });

    await step.do('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: VOICE_DESIGN_COST,
        usedOwnKey: false,
        description: `Voice design (${characterBible.name})`,
        idempotencyKey: `${event.instanceId}:voice-design`,
        reservationId: input.reservationId,
        metadata: {
          endpointId: ELEVENLABS_VOICE_DESIGN_ENDPOINT,
          characterDbId,
        },
        workflowName: 'CharacterVoiceWorkflow',
      });
    });

    // ponytail: a lost response after ElevenLabs saved the voice would save it
    // again on retry (one leaked slot); the hourly sweep is the upgrade path.
    const voiceId = await step.do('save-voice', async () => {
      const { key } = await scopedDb.credentials.resolveKey('elevenlabs');
      const top = previews[0];
      if (!top) throw new Error('No preview to save');
      return saveDesignedVoice(key, {
        voiceName: `${characterBible.name} · ${sequenceId.slice(-6)}`,
        voiceDescription,
        generatedVoiceId: top.generatedVoiceId,
      });
    });

    const persisted = await step.do('persist-voice', async () => {
      const top = previews[0];
      const parked =
        (top && markPreviewUnusable(previews, top.generatedVoiceId, 'saved')) ??
        previews;
      const releaseDb = {
        characters: {
          getVoiceReferenceCount: (id: string) =>
            scopedDb.liveRead.characters.getVoiceReferenceCount(id),
          markVoiceReleased: (id: string) =>
            scopedDb.characters.markVoiceReleased(id),
        },
      };
      // Pre-#1715 payloads have no husk. Write the old way; do not release
      // a slot this run never claimed as a version.
      if (!targetVersionId) {
        await scopedDb.characters.updateVoice(
          characterDbId,
          {
            voiceId,
            voiceDescription,
            voicePreviews: parked,
            useVoice: true,
          },
          'generated',
          input.userId
        );
        return { voiceId, emit: 'completed' as const };
      }
      const live = await scopedDb.liveRead.characters.getById(characterDbId);
      const shouldPromote =
        live?.pendingPromoteVoiceVersionId === targetVersionId;
      if (!shouldPromote) {
        // Persist replay after promote: pointer is already cleared and this
        // husk is the selected voice. Do not treat that as a demote.
        const existing =
          await scopedDb.claims.characters.getVoiceVersionById(targetVersionId);
        if (
          existing?.status === 'completed' &&
          existing.voiceId === voiceId &&
          (live?.selectedVoiceVersionId === targetVersionId ||
            live?.voiceId === voiceId)
        ) {
          return { voiceId, emit: 'completed' as const };
        }
        await scopedDb.characters.markVoiceClaimTerminal(
          targetVersionId,
          'failed',
          'Voice design was superseded'
        );
        await releaseVoiceIfUnreferenced(releaseDb, voiceId);
        return { voiceId: null, emit: 'completed' as const };
      }
      const completed = await scopedDb.characters.completeVoiceClaimIfLive(
        targetVersionId,
        {
          voiceId,
          description: voiceDescription,
          previews: parked,
        }
      );
      if (!completed) {
        // step.do replay after D1 committed: the husk is already completed.
        // Releasing here would delete the slot this run just saved.
        const existing =
          await scopedDb.claims.characters.getVoiceVersionById(targetVersionId);
        if (existing?.status !== 'completed' || existing.voiceId !== voiceId) {
          await releaseVoiceIfUnreferenced(releaseDb, voiceId);
          return { voiceId: null, emit: 'failed' as const };
        }
      }
      const promoted = await scopedDb.characters.promoteVoiceClaimIfPending(
        characterDbId,
        targetVersionId
      );
      if (!promoted) {
        await releaseVoiceIfUnreferenced(releaseDb, voiceId);
        return { voiceId: null, emit: 'completed' as const };
      }
      await releaseReplacedVoice(releaseDb, live.voiceId, voiceId);
      return { voiceId, emit: 'completed' as const };
    });

    await channel.emit('generation.character-voice:progress', {
      characterId: characterDbId,
      status: persisted.emit,
      ...(persisted.emit === 'failed'
        ? { error: 'Voice claim is no longer live' }
        : {}),
    });
    return { voiceId: persisted.voiceId, voiceDescription };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<CharacterVoiceWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const { sequenceId, characterDbId, targetVersionId } = event.payload;
    logger.error(
      `[CharacterVoiceWorkflow:cf] Voice design failed for ${characterDbId}: ${error}`
    );
    if (targetVersionId) {
      await scopedDb.characters.markVoiceClaimTerminal(
        targetVersionId,
        'failed',
        error
      );
    }
    await getGenerationChannel(sequenceId).emit(
      'generation.character-voice:progress',
      { characterId: characterDbId, status: 'failed', error }
    );
  }
}
