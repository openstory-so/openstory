/** Analyze and cast the script, then persist each shot's spec and derived prompts. */
import { sanitizeScriptContent } from '@/sequences/prompt-validation';
import { resolveVideoModels } from '@/models/resolve-video-models';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { buildCastCharacterBible } from '@/cast/character-prompt';
import { getGenerationChannel } from '@/platform/realtime';
import { spawnAndAwaitChild } from '@/platform/server/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import { WorkflowValidationError } from '@/platform/server/workflow/errors';
import { queuedBeforeLooks } from '@/cast/server/workflows/sheet-snapshots';
import { handleLlmAuthFailure } from '@/platform/server/workflow/llm-auth-failure';
import { sanitizeFailResponse } from '@/platform/server/workflow/sanitize-fail-response';
import type {
  AnalyzeScriptWorkflowInput,
  LocationMatchingWorkflowInput,
  LocationMatchingWorkflowOutput,
  SceneSplitWorkflowInput,
  SceneSplitWorkflowResult,
  TalentMatchingWorkflowInput,
  TalentMatchingWorkflowOutput,
} from '@/platform/server/workflow/types';
import {
  GENERATION_STAGE_META,
  type GenerationStage,
} from '@/sequences/pipeline';
import { persistSceneLooks } from '@/sequences/server/scene-persistence';
import { relabelBibleLooks, relabelLookPicks } from '@/cast/bible-looks';
import { createCastRecords } from '@/cast/server/workflows/cast-records';
import { shotWorkItems } from '@/shots/server/shot-work-items';
import { persistShotSpec } from '@/shots/server/persist-shot-spec';
import { deriveAutoStyle } from '@/look/server/workflows/auto-style-step';
import { waitForElementVision } from '@/cast/server/workflows/wait-for-sheets';
import type { SequenceElement } from '@/platform/server/db/schema';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/platform/logger';

const logger = getLogger(['openstory', 'workflow', 'analyze-script']);

const PARENT_BINDING_NAME = 'ANALYZE_SCRIPT_WORKFLOW' as const;

export class AnalyzeScriptWorkflow extends OpenStoryWorkflowEntrypoint<AnalyzeScriptWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<AnalyzeScriptWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<void> {
    const input = event.payload;
    const parentInstanceId = event.instanceId;
    const {
      sequenceId,
      script,
      aspectRatio,
      styleConfig: inputStyleConfig,
      pendingAutoStyleId,
      analysisModelId,
      elementIds,
      videoModel,
      videoModels: videoModelsInput,
      suggestedTalentIds,
      suggestedLocationIds,
      referenceOnly,
    } = input;

    const videoModels = resolveVideoModels(videoModelsInput, videoModel);
    const primaryVideoModel = videoModels[0] ?? videoModel;

    // Top-level validation — base class re-wraps as CF NonRetryableError.
    if (!script) {
      throw new WorkflowValidationError('No script found');
    }

    // Record start time of analysis (used for analysis-duration metric below).
    const startTime = await step.do('start-time', () =>
      Promise.resolve(Date.now())
    );

    // The realtime banner's phase boundary. Nothing is persisted: a continue
    // derives what is left from live D1 (#1816), never from how far a run got.
    const stageComplete = async (stage: GenerationStage) => {
      if (!sequenceId) return;
      await step.do(`persist-pipeline-${stage}`, async () => {
        await getGenerationChannel(sequenceId).emit(
          'generation.phase:complete',
          { phase: GENERATION_STAGE_META[stage].phase }
        );
      });
    };

    const recordDuration = async (stage: GenerationStage) => {
      if (!sequenceId) return;
      await step.do(`record-analysis-duration-${stage}`, async () => {
        await scopedDb.sequences.updateAnalysisDurationMs(
          sequenceId,
          Date.now() - startTime
        );
      });
    };

    // ----------------------------------------------------------------------
    // PHASE 1: scene-split (LLM stream → scenes/bibles/shotMapping)
    // ----------------------------------------------------------------------
    await step.do('phase-1-start', async () => {
      await getGenerationChannel(sequenceId).emit('generation.phase:start', {
        phase: 1,
        phaseName: pendingAutoStyleId
          ? 'Analyzing script & deriving a style…'
          : 'Analyzing script…',
      });
    });

    // Elements uploaded while creating this sequence kick off `/element-vision`
    // (fire-and-forget) which writes their description/consistencyTag. Scene-
    // split reads those descriptions, so wait (bounded) for any still-running
    // vision before loading — mirrors the talent-sheet / location-reference
    // waits. Already-completed elements short-circuit with no added latency.
    //
    // Vision MUST be terminal before scene-split:
    // a scene split against a half-described element bakes the wrong look
    // into every downstream prompt. After the wait this only trips for vision
    // that genuinely failed to terminate within the timeout, in which case we
    // still surface the explicit error.
    //
    // The wait reads by the trigger-time `elementIds` — the vision-written
    // fields arrive late so the ROW read must be live, but re-enumerating the
    // sequence would pull in elements uploaded after generation started
    // (whose pending vision then hard-fails a run they were never part of).
    // Its rows ARE the load: a second read would re-open the window the wait
    // just closed (#1113).
    let elements: SequenceElement[] = [];
    if (sequenceId) {
      const vision = await waitForElementVision(
        step,
        scopedDb.liveRead,
        elementIds,
        {
          onWaitNeeded: async () => {
            await getGenerationChannel(sequenceId).emit(
              'generation.phase:start',
              {
                phase: 1,
                phaseName: 'Analyzing elements…',
              }
            );
          },
        }
      );
      if (!vision.ready) {
        throw new NonRetryableError(
          `Element vision is still running for ${vision.pendingIds.length} element(s). ` +
            `Wait for vision analysis to finish before regenerating.`,
          'WorkflowValidationError'
        );
      }
      elements = vision.rows;
    }

    const elementsMinimal = elements.map((el) => ({
      id: el.id,
      token: el.token,
      description: el.description,
      imageUrl: el.imageUrl,
      consistencyTag: el.consistencyTag,
      kind: el.kind,
      durationSeconds: el.durationSeconds,
    }));

    if (pendingAutoStyleId && !sequenceId) {
      throw new NonRetryableError(
        'Automatic style requested without a sequence to bind it to'
      );
    }

    // Automatic style (#1213) runs alongside scene-split — preview stills
    // render style-free on an automatic run — but it is a separate billed LLM
    // call that fails on its own (a model that answers in prose). Two rules
    // come out of that:
    //
    //  - It is started here and claimed AFTER the split lands. Awaiting both
    //    in one `Promise.all` threw the style failure before the split was
    //    in D1, so the only way forward was paying for the split again
    //    (#1408); with the scenes and shots persisted a continue picks up
    //    from them (#1816).
    //  - A style that already landed leaves a snapshot, which clears
    //    `pendingAutoStyleId` at the trigger — so this never re-bills.
    const stylePromise =
      pendingAutoStyleId && sequenceId
        ? deriveAutoStyle(step, {
            scopedDb,
            workflowRunId: parentInstanceId,
            sequenceId,
            styleId: pendingAutoStyleId,
            script,
            aspectRatio,
            analysisModelId,
            reservationId: input.reservationId,
          })
        : null;
    stylePromise?.catch(() => {});

    const sceneSplitResult = await spawnAndAwaitChild<
      SceneSplitWorkflowInput,
      SceneSplitWorkflowResult
    >(step, {
      binding: this.env.SCENE_SPLIT_WORKFLOW,
      parentBindingName: 'ANALYZE_SCRIPT_WORKFLOW',
      parentInstanceId: event.instanceId,
      childId: `scene-split:${sequenceId ?? 'no-seq'}`,
      childPayload: {
        userId: input.userId,
        teamId: input.teamId,
        sequenceId,
        reservationId: input.reservationId,
        promptName: 'phase/scene-splitting-boundaries-chat',
        aspectRatio,
        script: sanitizeScriptContent(script),
        userCountry: input.userCountry,
        modelId: analysisModelId,
        elements: elementsMinimal,
        videoModel: primaryVideoModel,
        // Shot-list covers scenes in this recipe. Auto-style derives in
        // parallel, so a first auto run still has the placeholder here.
        styleConfig: inputStyleConfig,
      },
      spawnStepName: 'spawn-scene-split',
      awaitStepName: 'await-scene-split',
      // LLM-only child, but under a many-sequence burst the engine's notify
      // delivery alone has been observed to lag >25 minutes — every await in
      // this workflow carries explicit burst headroom.
      timeout: '45 minutes',
    });

    const { shotMapping, characterBible, locationBible, elementBible } =
      sceneSplitResult;

    // Claimed only now: the split is in D1, so a style failure fails a run
    // the user can still continue.
    const styleConfig = (await stylePromise) ?? inputStyleConfig;

    // ----------------------------------------------------------------------
    // PHASE 1b: talent + location matching in parallel, then the cast rows.
    // Still the Script stage — same banner segment, new caption.
    // ----------------------------------------------------------------------
    await step.do('phase-1-casting', async () => {
      await getGenerationChannel(sequenceId).emit('generation.phase:start', {
        phase: GENERATION_STAGE_META.script.phase,
        phaseName: 'Casting characters & locations…',
      });
    });
    const [talentSettled, locationMatchSettled] = await Promise.allSettled([
      spawnAndAwaitChild<
        TalentMatchingWorkflowInput,
        TalentMatchingWorkflowOutput
      >(step, {
        binding: this.env.TALENT_MATCHING_WORKFLOW,
        parentBindingName: PARENT_BINDING_NAME,
        parentInstanceId,
        childId: `talent-matching:${sequenceId ?? 'no-seq'}`,
        childPayload: {
          sequenceId,
          userId: input.userId,
          teamId: input.teamId,
          reservationId: input.reservationId,
          analysisModelId,
          suggestedTalentIds,
          suggestedTalent: input.suggestedTalent,
          characterBible,
        },
        spawnStepName: 'spawn-talent-matching',
        awaitStepName: 'await-talent-matching',
        timeout: '45 minutes',
      }),
      spawnAndAwaitChild<
        LocationMatchingWorkflowInput,
        LocationMatchingWorkflowOutput
      >(step, {
        binding: this.env.LOCATION_MATCHING_WORKFLOW,
        parentBindingName: PARENT_BINDING_NAME,
        parentInstanceId,
        childId: `location-matching:${sequenceId ?? 'no-seq'}`,
        childPayload: {
          sequenceId,
          userId: input.userId,
          teamId: input.teamId,
          reservationId: input.reservationId,
          analysisModelId,
          suggestedLocationIds,
          suggestedLocations: input.suggestedLocations,
          locationBible,
        },
        spawnStepName: 'spawn-location-matching',
        awaitStepName: 'await-location-matching',
        timeout: '45 minutes',
      }),
    ]);
    if (talentSettled.status === 'rejected') {
      throw new Error(
        `Talent matching failed: ${String(talentSettled.reason)}`
      );
    }
    if (locationMatchSettled.status === 'rejected') {
      throw new Error(
        `Location matching failed: ${String(locationMatchSettled.reason)}`
      );
    }
    const talentCharacterMatches = talentSettled.value.matches;
    const libraryLocationMatches = locationMatchSettled.value.matches;

    // Derive and hash against the same cast attributes persisted below, so
    // live verification agrees with the first prompts from analysis.
    const analysedCastBible = buildCastCharacterBible(
      characterBible,
      talentCharacterMatches
    );
    // Cast, locations and script-detected elements land NOW, sheet-less, so a
    // run stopped at Script shows the whole bible for review before any
    // reference image is billed. The executor later fills their selected sheets.
    const castRecords = await step.do('create-cast-records', async () => {
      if (!sequenceId) return { elements: [], lookIds: {} };
      return createCastRecords(scopedDb, {
        sequenceId,
        characterBible,
        talentMatches: talentCharacterMatches,
        locationBible,
        locationMatches: libraryLocationMatches,
        elementBible,
        existingElements: elementsMinimal,
      });
    });
    // Looks (#2015): the bibles call named each outfit by a slug. The cast is
    // persisted now, so swap the slugs for `character_looks.id` on the bible
    // the prompts read and on the scenes that pick a non-default look, and
    // write those picks onto the scenes. Only persisted ids are ever stored.
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: step results cached by a run that started before #2015
    if (!castRecords.lookIds || !sceneSplitResult.sceneLooks) {
      throw queuedBeforeLooks();
    }
    const lookIds = castRecords.lookIds;
    const castCharacterBible = relabelBibleLooks(analysedCastBible, lookIds);
    const sceneLooks = sceneSplitResult.sceneLooks;
    const scenes = sceneSplitResult.scenes.map((scene) => {
      const picks = relabelLookPicks(sceneLooks[scene.sceneId] ?? {}, lookIds);
      return Object.keys(picks).length > 0 && scene.continuity
        ? {
            ...scene,
            continuity: { ...scene.continuity, characterLooks: picks },
          }
        : scene;
    });
    await step.do('persist-scene-looks', async () => {
      if (sequenceId) await persistSceneLooks(scopedDb, sequenceId, scenes);
    });
    // Each shot's spec lands as its first version, with the prompts derived
    // from it (#1915). Derivation reads only the spec and the frozen bibles.
    await step.do('persist-shot-specs', async () => {
      for (const item of shotWorkItems(scenes, shotMapping)) {
        const written = await persistShotSpec(scopedDb, item, {
          styleConfig,
          characterBible: castCharacterBible,
          locationBible,
          elementBible,
          aspectRatio,
          analysisModel: analysisModelId,
          referenceOnly,
        });
        const channel = getGenerationChannel(sequenceId);
        const { shotId } = item.mapping;
        if (written.stillPrompt) {
          await channel.emit('generation.shot:updated', {
            shotId,
            updateType: 'visual-prompt',
          });
        }
        await channel.emit('generation.shot:updated', {
          shotId,
          updateType: 'motion-prompt',
        });
      }
    });
    await stageComplete('script');
    await recordDuration('script');
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<AnalyzeScriptWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    const { sequenceId, reservationId, analysisModelId } = event.payload;
    if (reservationId) {
      try {
        await scopedDb.billing.zeroReservation(reservationId);
      } catch (releaseError) {
        logger.error(
          `[AnalyzeScriptWorkflow:cf] Failed to zero reservation ${reservationId}:`,
          { err: releaseError }
        );
      }
    }
    if (!sequenceId) return;

    const sanitized = sanitizeFailResponse(error);
    logger.error('[AnalyzeScriptWorkflow:cf] Failure:', {
      sanitized,
    });

    const userMessage =
      (await handleLlmAuthFailure(scopedDb, sanitized, analysisModelId)) ??
      sanitized;

    await scopedDb.sequence(sequenceId).updateStatus('failed', userMessage);
    await getGenerationChannel(sequenceId).emit('generation.failed', {
      message: userMessage,
    });
  }
}
