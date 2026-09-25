/**
 * The `CharacterVoiceWorkflow` durable workflow (#1553 / #1715).
 *
 * One character's voice: draft a description from the bible when the
 * character has none, then either Voice Design on ElevenLabs (previews parked
 * in R2, the top one saved as a voice) or, when `voiceProvider` is 'seed'
 * (#1765), three Seed range reads, each its own take of reference clips. The generating husk already exists as `targetVersionId`;
 * persist completes it in place and promotes only if
 * `pendingPromoteVoiceVersionId` still names it. Otherwise the husk is failed
 * and the unused saved id is released. The current In use voice stays until
 * promote — do not release it first. Spawned per speaking character by
 * `CharacterBibleWorkflow`; triggered by Generate on the character card.
 */

import { base64ToBytes } from '@/platform/base64';
import {
  voiceDescriptionSchema,
  voiceRangeScriptSchema,
} from '@/sequences/response-schemas';
import {
  ELEVENLABS_ISOLATION_ENDPOINT,
  ELEVENLABS_SCRIBE_ENDPOINT,
  ELEVENLABS_VOICE_DESIGN_ENDPOINT,
  isolationCost,
  scribeCost,
  VOICE_DESIGN_COST,
} from '@/billing/elevenlabs-pricing';
import {
  SEED_AUDIO_ENDPOINT,
  seedAudioCost,
} from '@/billing/seed-speech-pricing';
import { newSeedVoiceId, SEED_AUDIO_MODEL } from '@/cast/seed-voice';
import { recordRangeRead } from '@/cast/server/voice/seed-voice';
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
import type {
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepConfig,
} from 'cloudflare:workers';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'workflow', 'character-voice']);

/** A read that says anything but its script throws; the retry re-records it. */
const SEED_READ_STEP = {
  retries: { limit: 2, delay: '5 seconds', backoff: 'constant' },
  timeout: '10 minutes',
} as const satisfies WorkflowStepConfig;

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

    const designed =
      input.voiceProvider === 'seed'
        ? await this.designSeedVoice(step, scopedDb, event, voiceDescription)
        : await this.designElevenLabsVoice(
            step,
            scopedDb,
            event,
            voiceDescription
          );
    const { previews, voiceId } = designed;

    const persisted = await step.do('persist-voice', async () => {
      const top = previews[0];
      // A Seed take can be picked any number of times; an ElevenLabs preview
      // saves once.
      const parked =
        input.voiceProvider === 'seed'
          ? previews
          : ((top &&
              markPreviewUnusable(previews, top.generatedVoiceId, 'saved')) ??
            previews);
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

  /** ElevenLabs Voice Design: three previews, the first saved as a voice. */
  private async designElevenLabsVoice(
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb,
    event: Readonly<WorkflowEvent<CharacterVoiceWorkflowInput>>,
    voiceDescription: string
  ): Promise<{ previews: VoicePreview[]; voiceId: string }> {
    const input = event.payload;
    const { characterDbId, sequenceId, characterBible } = input;
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
          base64ToBytes(preview.audioBase64),
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

    await this.recordVoiceProvenance(step, scopedDb, event, {
      path: previews[0]?.path,
      provider: 'elevenlabs',
      model: 'eleven_ttv_v3',
      prompt: voiceDescription,
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
    return { previews, voiceId };
  }

  /**
   * Seed voice (#1765): an LLM writes a range script from the bible, Seed
   * reads it `takes` times, and each read that says its script
   * becomes a take — three reference clips in R2 under a `seed:` voice id.
   * The first take is the voice; picking another costs nothing.
   */
  private async designSeedVoice(
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb,
    event: Readonly<WorkflowEvent<CharacterVoiceWorkflowInput>>,
    voiceDescription: string
  ): Promise<{ previews: VoicePreview[]; voiceId: string }> {
    const input = event.payload;
    const { characterDbId, sequenceId, characterBible } = input;
    const script = await durableLLMCallCf(
      step,
      {
        name: 'voice-range-script',
        phase: { number: 3, name: 'Designing voices…' },
        promptName: 'phase/voice-range-script-chat',
        promptVariables: {
          character: JSON.stringify(characterBible, null, 2),
          voiceDescription,
        },
        modelId: input.analysisModelId,
        responseSchema: voiceRangeScriptSchema,
      },
      {
        sequenceId,
        userId: input.userId,
        workflowRunId: event.instanceId,
        scopedDb,
        reservationId: input.reservationId,
      }
    );

    // The takes run side by side; the governor spaces their Seed calls.
    const takes = Array.from({ length: input.takes }, (_, i) => i + 1);
    const recorded = await Promise.all(
      takes.map(async (take): Promise<VoicePreview | null> => {
        // Minted in a step so a replay reuses the id the clips were stored under.
        const voiceId = await step.do(`seed-voice-id-${take}`, async () =>
          newSeedVoiceId()
        );
        try {
          const read = await step.do(
            `seed-range-read-${take}`,
            SEED_READ_STEP,
            async () => {
              const [seed, eleven] = await Promise.all([
                scopedDb.credentials.resolveKey('seed-speech'),
                scopedDb.credentials.resolveKey('elevenlabs'),
              ]);
              // ponytail: a take that fails the check is re-recorded by the
              // step retry and not billed to the team; the platform eats it.
              const made = await recordRangeRead({
                seedKey: seed.key,
                elevenLabsKey: eleven.key,
                voiceId,
                description: voiceDescription,
                script,
              });
              // One ledger line per provider: Seed records, ElevenLabs checks
              // and cleans.
              const charges = [
                {
                  key: '',
                  endpointId: SEED_AUDIO_ENDPOINT,
                  seconds: made.seedSeconds,
                  costMicros: seedAudioCost(made.seedSeconds),
                },
                {
                  key: ':scribe',
                  endpointId: ELEVENLABS_SCRIBE_ENDPOINT,
                  seconds: made.transcribedSeconds,
                  costMicros: scribeCost(made.transcribedSeconds),
                },
                {
                  key: ':isolation',
                  endpointId: ELEVENLABS_ISOLATION_ENDPOINT,
                  seconds: made.isolatedSeconds,
                  costMicros: isolationCost(made.isolatedSeconds),
                },
              ];
              for (const charge of charges) {
                await deductWorkflowCredits({
                  scopedDb,
                  costMicros: charge.costMicros,
                  usedOwnKey: false,
                  description: `Voice take ${take} (${characterBible.name})`,
                  idempotencyKey: `${event.instanceId}:seed-voice:${take}${charge.key}`,
                  reservationId: input.reservationId,
                  metadata: {
                    endpointId: charge.endpointId,
                    characterDbId,
                    seconds: charge.seconds,
                  },
                  workflowName: 'CharacterVoiceWorkflow',
                });
              }
              return { url: made.url, path: made.path };
            }
          );
          return {
            generatedVoiceId: voiceId,
            url: read.url,
            path: read.path,
            takeNumber: take,
          };
        } catch (error) {
          // One bad take is not a failed voice: the user picks from the rest.
          logger.warn(
            `[CharacterVoiceWorkflow:cf] Seed take ${take} for ${characterDbId} failed`,
            { err: error }
          );
          return null;
        }
      })
    );
    // In take order, so the voice is the first take that passed.
    const previews = recorded.filter(
      (preview): preview is VoicePreview => preview !== null
    );
    const top = previews[0];
    if (!top) throw new Error('Every Seed voice take failed its check');

    await this.recordVoiceProvenance(step, scopedDb, event, {
      path: top.path,
      provider: 'byteplus',
      model: SEED_AUDIO_MODEL,
      prompt: voiceDescription,
    });
    return { previews, voiceId: top.generatedVoiceId };
  }

  private async recordVoiceProvenance(
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb,
    event: Readonly<WorkflowEvent<CharacterVoiceWorkflowInput>>,
    asset: {
      path: string | undefined;
      provider: string;
      model: string;
      prompt: string;
    }
  ): Promise<void> {
    const input = event.payload;
    await step.do('record-provenance', async () => {
      if (!asset.path) return;
      await recordProvenance(scopedDb.provenance, {
        teamId: input.teamId,
        userId: input.userId,
        assetKind: 'character_voice',
        assetId: input.characterDbId,
        storageKey: asset.path,
        provider: asset.provider,
        model: asset.model,
        workflowRunId: event.instanceId,
        prompt: asset.prompt,
        sequenceId: input.sequenceId,
      });
    });
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
