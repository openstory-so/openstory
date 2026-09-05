/**
 * Cloudflare Workflows port of `analyzeScriptWorkflow` — the deepest
 * orchestrator in the system. Sequences scene-split → talent/location
 * matching → character/location bibles + visual prompts → shot images +
 * motion/music prompts → motion-batch.
 *
 * Mirrors the QStash version (`src/lib/workflows/analyze-script-workflow.ts`)
 * phase for phase. Key differences:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Every `context.invoke('child', { workflow, body })` becomes a
 *     `spawnAndAwaitChild` Pattern 3 call (await-child.ts). Parallel
 *     `Promise.all([context.invoke, context.invoke])` becomes
 *     `Promise.all` over `spawnAndAwaitChild` calls; we use
 *     `Promise.allSettled` where the QStash original individually checked
 *     `.isFailed` so a single child failure surfaces as a typed error
 *     instead of an unhandled rejection.
 *
 * Every child workflow is CF-ported and spawned via `spawnAndAwaitChild`,
 * including `scene-split` (LLM streaming wrapped in a single `step.do`) and
 * `motion-batch` (Phase 5 motion + music + merge tree). */

import { getEffectiveFalPricing } from '@/lib/ai/fal-pricing-live';
import { sanitizeScriptContent } from '@/lib/ai/prompt-validation';
import { resolveAudioModels } from '@/lib/ai/resolve-audio-models';
import { resolveImageModels } from '@/lib/ai/resolve-image-models';
import { resolveVideoModels } from '@/lib/ai/resolve-video-models';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import {
  estimateReferenceSheetCost,
  estimateStoryboardRenderCost,
} from '@/shared/billing/cost-estimation';
import { creditsShortStatusError } from '@/shared/billing/credits-short';
import { addMicros, microsToUsd } from '@/shared/billing/money';
import { gateStoryboardRenders } from '@/lib/billing/storyboard-render-gate';
import { reusesTalentSheet } from '@/lib/talent/reuse-talent-sheet';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { buildCastCharacterBible } from '@/shared/prompts/character-prompt';
import { getGenerationChannel } from '@/shared/realtime';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { handleLlmAuthFailure } from '@/lib/workflow/llm-auth-failure';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import type {
  AnalyzeScriptWorkflowInput,
  BatchMotionMusicWorkflowInput,
  CharacterBibleWorkflowInput,
  ElementSheetEntry,
  ElementSheetWorkflowInput,
  ElementSheetWorkflowResult,
  ShotImagesWorkflowInput,
  ShotImagesWorkflowResult,
  LocationBibleWorkflowInput,
  LocationMatchingWorkflowInput,
  LocationMatchingWorkflowOutput,
  MotionMusicPromptsWorkflowInput,
  MotionMusicPromptsWorkflowResult,
  SceneSplitWorkflowInput,
  SceneSplitWorkflowResult,
  TalentMatchingWorkflowInput,
  TalentMatchingWorkflowOutput,
  FramePromptBatchWorkflowInput,
  FramePromptBatchWorkflowResult,
} from '@/lib/workflow/types';
import {
  GENERATION_STAGE_META,
  flagsFromStopAt,
  shouldRunStage,
  type GenerationCheckpoint,
  type GenerationStage,
} from '@/shared/generation/pipeline';
import {
  createCastRecords,
  findMissingElementEntries,
} from '@/lib/workflows/cast-records';
import { buildStoryboardMotionBatchShots } from '@/lib/workflows/storyboard-motion-batch-shots';
import {
  computeShotImagesHashFromDto,
  type ShotImageSceneSnapshot,
  resolveSceneShotImageReferences,
} from '@/lib/workflows/sheet-snapshots';
import { deriveAutoStyle } from '@/lib/workflows/auto-style-step';
import { waitForElementVision } from '@/lib/workflows/wait-for-sheets';
import type {
  CharacterMinimal,
  SequenceElementMinimal,
  SequenceLocationMinimal,
} from '@/lib/db/schema';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/shared/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'analyze-script']);

const PARENT_BINDING_NAME = 'ANALYZE_SCRIPT_WORKFLOW' as const;

export class AnalyzeScriptWorkflow extends OpenStoryWorkflowEntrypoint<AnalyzeScriptWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<AnalyzeScriptWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<Scene[]> {
    const input = event.payload;
    const parentInstanceId = event.instanceId;
    const {
      sequenceId,
      script,
      aspectRatio,
      resolution,
      styleConfig: inputStyleConfig,
      pendingAutoStyleId,
      analysisModelId,
      elementIds,
      imageModel,
      imageModels: imageModelsInput,
      videoModel,
      videoModels: videoModelsInput,
      stopAt,
      startFrom: startFromInput,
      checkpoint: checkpointInput,
      musicModel,
      audioModels: audioModelsInput,
      suggestedTalentIds,
      suggestedLocationIds,
      referenceOnly = false,
    } = input;

    // Stop-at is the only word on how far to run; the legacy flags on the
    // payload are derived from it and never consulted (#1408).
    const { autoGenerateMotion, autoGenerateMusic } = flagsFromStopAt(stopAt);
    const startFrom: GenerationStage = startFromInput ?? 'script';
    let checkpoint: GenerationCheckpoint | undefined = checkpointInput;

    const imageModels = resolveImageModels(imageModelsInput, imageModel);
    const videoModels = resolveVideoModels(videoModelsInput, videoModel);
    const audioModels = resolveAudioModels(audioModelsInput, musicModel);
    // First selected model is primary: it drives the legacy `shots.video*`
    // columns and the model-aware duration snapping; the rest are alternates.
    const primaryVideoModel = videoModels[0] ?? videoModel;

    // Top-level validation — base class re-wraps as CF NonRetryableError.
    if (!script) {
      throw new WorkflowValidationError('No script found');
    }

    // Record start time of analysis (used for analysis-duration metric below).
    const startTime = await step.do('start-time', () =>
      Promise.resolve(Date.now())
    );

    const persistProgress = async (next: GenerationCheckpoint) => {
      checkpoint = next;
      if (!sequenceId) return;
      await step.do(`persist-pipeline-${next.completedStage}`, async () => {
        await scopedDb.sequences.update({
          id: sequenceId,
          pipelineStage: next.completedStage,
          generationCheckpoint: next,
        });
        await getGenerationChannel(sequenceId).emit(
          'generation.phase:complete',
          { phase: GENERATION_STAGE_META[next.completedStage].phase }
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
    if (shouldRunStage(startFrom, stopAt, 'script')) {
      await step.do('phase-1-start', async () => {
        await getGenerationChannel(sequenceId).emit('generation.phase:start', {
          phase: 1,
          phaseName: pendingAutoStyleId
            ? 'Analyzing script & deriving a style…'
            : 'Analyzing script…',
        });
      });
    }

    // Elements uploaded while creating this sequence kick off `/element-vision`
    // (fire-and-forget) which writes their description/consistencyTag. Scene-
    // split reads those descriptions, so wait (bounded) for any still-running
    // vision before loading — mirrors the talent-sheet / location-reference
    // waits. Already-completed elements short-circuit with no added latency.
    if (sequenceId) {
      await waitForElementVision(step, scopedDb.liveRead, elementIds, {
        onWaitNeeded: async () => {
          await getGenerationChannel(sequenceId).emit(
            'generation.phase:start',
            {
              phase: 1,
              phaseName: 'Analyzing elements…',
            }
          );
        },
      });
    }

    // Load sequence elements. Vision MUST be terminal before scene-split.
    // See QStash original for the full rationale. After the wait above this
    // only trips for vision that genuinely failed to terminate within the
    // timeout, in which case we still surface the explicit error.
    //
    // Reads by the trigger-time `elementIds` — the vision-written fields
    // arrive late so the ROW read must be live, but re-enumerating the
    // sequence here would pull in elements uploaded after generation started
    // (whose pending vision then hard-fails a run they were never part of).
    const elements = await step.do('load-elements', async () => {
      if (!sequenceId) return [];
      const list =
        await scopedDb.liveRead.sequenceElements.listByIds(elementIds);
      const stillRunning = list.filter(
        (el) => el.visionStatus === 'pending' || el.visionStatus === 'analyzing'
      );
      if (stillRunning.length > 0) {
        // NonRetryableError (not WorkflowValidationError) because the base
        // class's re-wrap only runs at the runImpl catch boundary; a throw
        // inside step.do gets retried by CF's step machinery first.
        throw new NonRetryableError(
          `Element vision is still running for ${stillRunning.length} element(s). ` +
            `Wait for vision analysis to finish before regenerating.`,
          'WorkflowValidationError'
        );
      }
      return list;
    });

    const elementsMinimal = elements.map((el) => ({
      id: el.id,
      token: el.token,
      description: el.description,
      imageUrl: el.imageUrl,
      consistencyTag: el.consistencyTag,
    }));

    if (pendingAutoStyleId && !sequenceId) {
      throw new NonRetryableError(
        'Automatic style requested without a sequence to bind it to'
      );
    }

    let sceneSplitResult: SceneSplitWorkflowResult;

    // Automatic style (#1213) runs alongside scene-split — preview stills
    // render style-free on an automatic run — but it is a separate billed LLM
    // call that fails on its own (a model that answers in prose). Two rules
    // come out of that:
    //
    //  - It is started here and claimed AFTER the script checkpoint is
    //    persisted. Awaiting both in one `Promise.all` threw the style failure
    //    before the checkpoint was written, leaving scenes and shots in D1
    //    with `generation_checkpoint` NULL — unresumable, so the only way
    //    forward was paying for the split again (#1408).
    //  - It is NOT gated on the script stage, because it reads the script and
    //    nothing else. A continue that resumes after the style call failed
    //    still has no recipe, and skipping it would render every image against
    //    the placeholder. A style that already landed leaves a snapshot, which
    //    clears `pendingAutoStyleId` at the trigger — so this never re-bills.
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

    if (shouldRunStage(startFrom, stopAt, 'script')) {
      sceneSplitResult = await spawnAndAwaitChild<
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
          modelId: analysisModelId,
          elements: elementsMinimal,
        },
        spawnStepName: 'spawn-scene-split',
        awaitStepName: 'await-scene-split',
        // LLM-only child, but under a many-sequence burst the engine's notify
        // delivery alone has been observed to lag >25 minutes — every await in
        // this workflow carries explicit burst headroom.
        timeout: '45 minutes',
      });
    } else {
      if (
        !checkpoint?.scenes ||
        !checkpoint.shotMapping ||
        !checkpoint.characterBible
      ) {
        throw new WorkflowValidationError(
          'Cannot continue generation: missing script checkpoint'
        );
      }
      sceneSplitResult = {
        scenes: checkpoint.scenes,
        title: '',
        shotMapping: checkpoint.shotMapping,
        characterBible: checkpoint.characterBible,
        locationBible: checkpoint.locationBible ?? [],
        elementBible: checkpoint.elementBible ?? [],
      };
    }

    const { scenes, shotMapping, characterBible, locationBible, elementBible } =
      sceneSplitResult;

    // Checkpoint the split before anything else can fail — the scenes and
    // shots are in D1 either way, and this is what makes them resumable
    // (#1408). Re-written with the casting matches once they land.
    if (shouldRunStage(startFrom, stopAt, 'script')) {
      await persistProgress({
        completedStage: 'script',
        scenes,
        shotMapping,
        characterBible,
        locationBible,
        elementBible,
      });
    }

    // Claimed only now: the checkpoint above is durable, so a style failure
    // fails a run the user can still continue.
    const styleConfig = (await stylePromise) ?? inputStyleConfig;

    // ----------------------------------------------------------------------
    // PHASE 1b: talent + location matching in parallel, then the cast rows.
    // Still the Script stage — same banner segment, new caption.
    // ----------------------------------------------------------------------
    const runScript = shouldRunStage(startFrom, stopAt, 'script');
    if (runScript) {
      await step.do('phase-1-casting', async () => {
        await getGenerationChannel(sequenceId).emit('generation.phase:start', {
          phase: GENERATION_STAGE_META.script.phase,
          phaseName: 'Casting characters & locations…',
        });
      });
    }
    const matchingSettled = runScript
      ? await Promise.allSettled([
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
        ])
      : null;
    const talentSettled = matchingSettled?.[0];
    const locationMatchSettled = matchingSettled?.[1];

    let talentCharacterMatches: TalentMatchingWorkflowOutput['matches'];
    let libraryLocationMatches: LocationMatchingWorkflowOutput['matches'];
    if (talentSettled && locationMatchSettled) {
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
      talentCharacterMatches = talentSettled.value.matches;
      libraryLocationMatches = locationMatchSettled.value.matches;
    } else {
      talentCharacterMatches = checkpoint?.talentMatches ?? [];
      libraryLocationMatches = checkpoint?.locationMatches ?? [];
    }

    // Apply casting to the bible NOW, before prompt generation. Talent matching
    // (above) has resolved, so casting is known. Feeding the cast bible into the
    // visual/motion prompt children means those prompts are generated from — and
    // hashed against — the exact values the character-bible workflow persists, so
    // staleness verification (which reads the cast DB row) matches by
    // construction. Unmatched characters pass through unchanged. The character-
    // bible child still receives the raw bible + matches (its sheet-generation
    // path is unchanged). See #867.
    const castCharacterBible = buildCastCharacterBible(
      characterBible,
      talentCharacterMatches
    );

    // Cast, locations and script-detected elements land NOW, sheet-less, so a
    // run stopped at Script shows the whole bible for review before any
    // reference image is billed. The References stage re-upserts the same
    // rows (stable ids) and fills the sheets in.
    const createdElements = runScript
      ? (
          await step.do('create-cast-records', async () => {
            if (!sequenceId) return { elements: [] };
            return createCastRecords(scopedDb, {
              sequenceId,
              characterBible,
              talentMatches: talentCharacterMatches,
              locationBible,
              locationMatches: libraryLocationMatches,
              elementBible,
              existingElements: elementsMinimal,
            });
          })
        ).elements
      : [];
    // Every element row this run knows about: trigger-time uploads (which, on
    // a continue, already include the Script-stage placeholders) plus the
    // placeholders created above.
    const knownElements = [...elementsMinimal, ...createdElements];

    if (runScript) {
      await persistProgress({
        completedStage: 'script',
        scenes,
        shotMapping,
        characterBible,
        locationBible,
        elementBible,
        talentMatches: talentCharacterMatches,
        locationMatches: libraryLocationMatches,
      });
      if (stopAt === 'script') {
        await recordDuration('script');
        return scenes;
      }
    }

    const runReferences = shouldRunStage(startFrom, stopAt, 'references');

    const totalDurationSeconds = scenes.reduce(
      (sum, scene) => sum + (scene.metadata?.durationSeconds || 5),
      0
    );

    // The reference sheets phase 3 is about to bill, counted EXACTLY rather
    // than guessed. Casting has resolved, so this is one sheet per bible entry
    // minus the characters whose matched talent sheet is reused (a storage
    // copy, no generation) — the same question `character-bible-workflow` asks
    // per character, via the same helper. Auto-generated element references
    // (#835) are likewise decided by `findMissingElementEntries`, which reads
    // only phase-1 output. Every location gets a sheet: a library match
    // supplies a reference image but the styled sheet is still generated.
    // A continue that starts after References bills no sheets (#1408).
    const billedCharacterSheets = runReferences
      ? castCharacterBible.filter(
          (character) =>
            !reusesTalentSheet(
              character,
              talentCharacterMatches.find(
                (m) => m.characterId === character.characterId
              )
            )
        ).length
      : 0;
    const billedLocationSheets = runReferences ? locationBible.length : 0;
    const billedElementSheets = runReferences
      ? findMissingElementEntries(elementBible, knownElements).length
      : 0;

    // Runs BEFORE phase 3, not after it (#929 had it downstream of the sheets).
    // `peek.remaining` is a live balance, so a gate placed after phase 3 could
    // only compare against money the sheets had already spent — which is why
    // `estimateStoryboardRenderCost` excludes them. Moving it here means the
    // sheet cost has to be added back, and in exchange a credits-short run
    // fails in seconds rather than after a full set of sheets is paid for.
    const renderGate = await step.do('grow-reservation', async () => {
      const pricing = await getEffectiveFalPricing();
      const remainingWork = addMicros(
        estimateStoryboardRenderCost({
          imageModel,
          imageModelCount: imageModels.length,
          aspectRatio,
          resolution,
          estimatedSceneCount: scenes.length,
          autoGenerateMotion,
          stopAt,
          startFrom,
          referenceOnly,
          videoModels: autoGenerateMotion ? videoModels : undefined,
          videoDurationSeconds: Math.max(
            5,
            Math.round(totalDurationSeconds / Math.max(scenes.length, 1))
          ),
          autoGenerateMusic: autoGenerateMusic && autoGenerateMotion,
          audioModels:
            autoGenerateMusic && autoGenerateMotion ? audioModels : undefined,
          audioDurationSeconds: totalDurationSeconds,
          pricing,
        }),
        estimateReferenceSheetCost({
          imageModel,
          characterSheets: billedCharacterSheets,
          locationSheets: billedLocationSheets,
          elementSheets: billedElementSheets,
          pricing,
        })
      );
      return gateStoryboardRenders({
        scopedDb,
        reservationId: input.reservationId,
        remainingWork,
        sceneCount: scenes.length,
        sequenceId,
      });
    });

    if (!renderGate.spawnRenders) {
      // Gate already zeroed leftover. Fail the sequence and throw so the
      // parent does not mark it completed with no stills.
      const shortMessage = creditsShortStatusError({
        sceneCount: scenes.length,
        neededMicros: renderGate.neededMicros,
      });
      await step.do('emit-reservation-short', async () => {
        if (!sequenceId) return;
        await scopedDb
          .sequence(sequenceId)
          .updateStatus('failed', shortMessage);
        await getGenerationChannel(sequenceId).emit(
          'generation.reservation:short',
          {
            neededUsd: microsToUsd(renderGate.neededMicros),
            remainingUsd: microsToUsd(renderGate.remainingMicros),
            sceneCount: scenes.length,
          }
        );
      });
      await step.do('record-analysis-duration', async () => {
        if (sequenceId) {
          await scopedDb.sequences.updateAnalysisDurationMs(
            sequenceId,
            Date.now() - startTime
          );
        }
      });
      throw new NonRetryableError(shortMessage);
    }

    const runMotionMusicPrompts = (args: {
      scenesForPrompts: Scene[];
      startingFrameImageUrls: Record<string, string | null>;
      visualSummaryBySceneId: Record<string, string>;
    }) =>
      spawnAndAwaitChild<
        MotionMusicPromptsWorkflowInput,
        MotionMusicPromptsWorkflowResult
      >(step, {
        binding: this.env.MOTION_MUSIC_PROMPTS_WORKFLOW,
        parentBindingName: PARENT_BINDING_NAME,
        parentInstanceId,
        childId: `motion-music-prompts:${sequenceId ?? 'no-seq'}`,
        childPayload: {
          userId: input.userId,
          teamId: input.teamId,
          sequenceId,
          reservationId: input.reservationId,
          scenesWithVisualPrompts: args.scenesForPrompts,
          shotMapping,
          aspectRatio,
          characterBible: castCharacterBible,
          locationBible,
          elementBible,
          styleConfig,
          analysisModelId,
          videoModel,
          videoModels,
          startingFrameImageUrls: args.startingFrameImageUrls,
          visualSummaryBySceneId: args.visualSummaryBySceneId,
          musicPromptSource: input.musicPromptSource,
          referenceOnly,
        },
        spawnStepName: 'spawn-motion-music-prompts',
        awaitStepName: 'await-motion-music-prompts',
        // Must exceed the child's own await budget: motion-prompt scene
        // children get 30 minutes each, plus notify lag under a burst.
        timeout: '60 minutes',
      });

    // ----------------------------------------------------------------------
    // PHASE 3: character bible + location bible + frame prompts (or,
    // reference-only, motion/music prompts) in parallel
    // ----------------------------------------------------------------------
    if (runReferences) {
      await step.do('phase-3-start', async () => {
        await getGenerationChannel(sequenceId).emit('generation.phase:start', {
          phase: GENERATION_STAGE_META.references.phase,
          // Accurate in both modes: reference-only writes no VISUAL prompts here
          // but does write its motion/music prompts alongside the sheets.
          phaseName: 'Generating references & prompts…',
        });
      });
    }

    // #835: element-bible entries the scene-split LLM detected (recurring
    // products/objects) that have no reference image yet — the Script stage
    // created their rows image-less — get an auto-generated one, mirroring
    // the character-sheet treatment. Runs in parallel with the other phase-3
    // children — visual prompts only consume the bible text, and the
    // generated references are merged into `allElements` before phase 4
    // attaches them to shots.
    //
    // Each entry carries its `sequence_elements.id`: the child's idempotency
    // guards key on it rather than on the (renameable) token, so a replay
    // after the element was renamed can't bill a second reference image.
    const missingElementEntries: ElementSheetEntry[] = sequenceId
      ? findMissingElementEntries(elementBible, knownElements)
      : [];
    const runElementSheets = async (): Promise<SequenceElementMinimal[]> => {
      if (!sequenceId || missingElementEntries.length === 0) {
        return [];
      }
      const result = await spawnAndAwaitChild<
        ElementSheetWorkflowInput,
        ElementSheetWorkflowResult
      >(step, {
        binding: this.env.ELEMENT_SHEET_WORKFLOW,
        parentBindingName: PARENT_BINDING_NAME,
        parentInstanceId,
        childId: `element-sheets:${sequenceId}`,
        childPayload: {
          userId: input.userId,
          teamId: input.teamId,
          sequenceId,
          reservationId: input.reservationId,
          entries: missingElementEntries,
          imageModel,
          styleConfig,
        },
        spawnStepName: 'spawn-element-sheets',
        awaitStepName: 'await-element-sheets',
      });
      return result.elements;
    };

    // The STILL's prompt (`frame_prompt_versions`) — named for the frame, not
    // "visual", so it cannot be confused with the motion prompt below now that
    // both run in this phase.
    //
    // REFERENCE-ONLY skips it: one LLM call per scene for a
    // prompt nothing in this mode reads. No still is rendered from it, and the
    // reference-only motion template composes its own opening frame from the
    // bibles — it is never handed the visual prompt (see
    // `phase/motion-prompt-reference-only-chat`, whose inputs are the scene
    // JSON and the bibles). The one consumer left is the music prompt's visual
    // grounding, which falls back to `scene.metadata`.
    //
    // The anchor frame is still materialized and the per-scene storyboard
    // preview still is untouched — the rail needs a thumbnail while the clip
    // renders, and that preview is what fills it.
    const runFramePrompts =
      async (): Promise<FramePromptBatchWorkflowResult> => {
        if (referenceOnly) {
          return { scenes, visualPromptsBySceneId: {} };
        }
        return spawnAndAwaitChild<
          FramePromptBatchWorkflowInput,
          FramePromptBatchWorkflowResult
        >(step, {
          binding: this.env.FRAME_PROMPT_BATCH_WORKFLOW,
          parentBindingName: PARENT_BINDING_NAME,
          parentInstanceId,
          childId: `frame-prompts-batch:${sequenceId ?? 'no-seq'}`,
          childPayload: {
            userId: input.userId,
            teamId: input.teamId,
            sequenceId,
            reservationId: input.reservationId,
            scenes,
            aspectRatio,
            characterBible: castCharacterBible,
            locationBible,
            elementBible,
            styleConfig,
            analysisModelId,
            shotMapping,
          },
          spawnStepName: 'spawn-visual-prompts',
          awaitStepName: 'await-visual-prompts',
          // See await-character-bible — same grandchild budget + notify lag.
          timeout: '60 minutes',
        });
      };

    const referenceSettled = runReferences
      ? await Promise.allSettled([
          spawnAndAwaitChild<CharacterBibleWorkflowInput, CharacterMinimal[]>(
            step,
            {
              binding: this.env.CHARACTER_BIBLE_WORKFLOW,
              parentBindingName: PARENT_BINDING_NAME,
              parentInstanceId,
              childId: `character-bible:${sequenceId ?? 'no-seq'}`,
              childPayload: {
                sequenceId,
                userId: input.userId,
                teamId: input.teamId,
                reservationId: input.reservationId,
                characterBible,
                talentMatches: talentCharacterMatches,
                imageModel,
                styleConfig,
              },
              spawnStepName: 'spawn-character-bible',
              awaitStepName: 'await-character-bible',
              // Must exceed the child's own await budget: the bible awaits each
              // sheet grandchild for 30 minutes, plus notify lag under a burst
              // (the June 7 run lost a sequence to the 30-minute default here
              // when a finished child's notify took >25 minutes to deliver).
              timeout: '60 minutes',
            }
          ),
          spawnAndAwaitChild<
            LocationBibleWorkflowInput,
            SequenceLocationMinimal[]
          >(step, {
            binding: this.env.LOCATION_BIBLE_WORKFLOW,
            parentBindingName: PARENT_BINDING_NAME,
            parentInstanceId,
            childId: `location-bible:${sequenceId ?? 'no-seq'}`,
            childPayload: {
              sequenceId,
              userId: input.userId,
              teamId: input.teamId,
              reservationId: input.reservationId,
              locationBible,
              libraryLocationMatches,
              // Use the sequence's image model for location sheets, mirroring
              // the character-bible payload above — omitting it silently fell
              // back to DEFAULT_IMAGE_MODEL for every location reference.
              imageModel,
              styleConfig,
            },
            spawnStepName: 'spawn-location-bible',
            awaitStepName: 'await-location-bible',
            // See await-character-bible — same grandchild budget + notify lag.
            timeout: '60 minutes',
          }),
          runFramePrompts(),
          runElementSheets(),
          // REFERENCE-ONLY writes its MOTION prompts in this slot — the same
          // phase as the sheets, in place of the frame prompts it skips. They
          // read bible TEXT, not sheets: the bibles are phase-1 output, casting
          // resolved at the end of phase 2, and the only real dependency in the
          // image path is the rendered still (#929 conditions the motion prompt
          // on it as vision input), which this mode never produces. Null in
          // every other mode, where they wait for phase 4's stills.
          referenceOnly
            ? runMotionMusicPrompts({
                scenesForPrompts: scenes,
                startingFrameImageUrls: Object.fromEntries(
                  scenes.map((scene) => [scene.sceneId, null])
                ),
                visualSummaryBySceneId: {},
              })
            : Promise.resolve(null),
        ])
      : null;
    const charSettled = referenceSettled?.[0];
    const locationSettled = referenceSettled?.[1];
    const framePromptsSettled = referenceSettled?.[2];
    const elementSheetSettled = referenceSettled?.[3];
    const referenceOnlyPromptsSettled = referenceSettled?.[4];

    if (runReferences) {
      if (!charSettled || charSettled.status !== 'fulfilled') {
        throw new Error(
          `Character sheet generation failed: ${String(charSettled?.reason ?? 'missing result')}`
        );
      }
      if (!locationSettled || locationSettled.status !== 'fulfilled') {
        throw new Error(
          `Location sheet generation failed: ${String(locationSettled?.reason ?? 'missing result')}`
        );
      }
      if (!framePromptsSettled || framePromptsSettled.status !== 'fulfilled') {
        throw new Error(
          `Frame prompt generation failed: ${String(framePromptsSettled?.reason ?? 'missing result')}`
        );
      }
      if (!elementSheetSettled || elementSheetSettled.status !== 'fulfilled') {
        throw new Error(
          `Element reference generation failed: ${String(elementSheetSettled?.reason ?? 'missing result')}`
        );
      }
    }

    const charactersWithSheets =
      charSettled?.status === 'fulfilled'
        ? charSettled.value
        : (checkpoint?.charactersWithSheets ?? []);
    const locationsWithSheets =
      locationSettled?.status === 'fulfilled'
        ? locationSettled.value
        : (checkpoint?.locationsWithSheets ?? []);
    // The visual-prompt workflow returns the generated prompts in memory
    // (#713/#991): thread them straight to the next phase rather than re-reading
    // `frame.imagePrompt` from the DB — versions are append-only and a
    // concurrent run may have repointed the mirror, so a re-read would be racy.
    const scenesWithVisualPrompts =
      framePromptsSettled?.status === 'fulfilled'
        ? framePromptsSettled.value.scenes
        : (checkpoint?.scenesWithVisualPrompts ?? scenes);
    const visualPromptBySceneId: Record<string, string> =
      framePromptsSettled?.status === 'fulfilled'
        ? Object.fromEntries(
            Object.entries(
              framePromptsSettled.value.visualPromptsBySceneId
            ).map(([sceneId, visual]) => [sceneId, visual.fullPrompt])
          )
        : (checkpoint?.visualPromptBySceneId ?? {});
    const generatedElements =
      elementSheetSettled?.status === 'fulfilled'
        ? elementSheetSettled.value
        : [];
    // Generated rows first so a filled-in placeholder wins over its
    // image-less twin in `knownElements`.
    const allElements = runReferences
      ? dedupeById([...generatedElements, ...knownElements])
      : dedupeById([...(checkpoint?.allElements ?? []), ...elementsMinimal]);

    if (runReferences) {
      await persistProgress({
        completedStage: 'references',
        scenes,
        shotMapping,
        characterBible,
        locationBible,
        elementBible,
        talentMatches: talentCharacterMatches,
        locationMatches: libraryLocationMatches,
        charactersWithSheets,
        locationsWithSheets,
        allElements,
        visualPromptBySceneId,
        scenesWithVisualPrompts,
      });
      if (stopAt === 'references') {
        await recordDuration('references');
        return scenesWithVisualPrompts;
      }
    }

    // ----------------------------------------------------------------------
    // PHASE 4: shot images + motion/music prompts in parallel
    // ----------------------------------------------------------------------
    // Reference-only has no phase 4: the stills are skipped and the prompts
    // finished in phase 3, so it emits nothing and the progress rail runs
    // Script → References → Motion & Music.
    if (!referenceOnly) {
      await step.do('phase-4-start', async () => {
        await getGenerationChannel(sequenceId).emit('generation.phase:start', {
          phase: GENERATION_STAGE_META.images.phase,
          phaseName: 'Generating images…',
        });
      });
    }

    // Build per-scene snapshots for shot-images divergence detection. Resolve
    // references through the SAME helper the image-gen stamp and staleness
    // verify use (`resolveSceneShotImageReferences`) so the three sites can't
    // drift on matcher choice or hash-filtering — that drift was the #867 bug.
    const sceneSnapshots: ShotImageSceneSnapshot[] =
      scenesWithVisualPrompts.map((scene) => {
        const refs = resolveSceneShotImageReferences({
          scene,
          visualPrompt: visualPromptBySceneId[scene.sceneId] ?? '',
          characters: charactersWithSheets,
          locations: locationsWithSheets,
          elements: allElements,
        });
        return {
          sceneId: scene.sceneId,
          visualPrompt: visualPromptBySceneId[scene.sceneId] ?? '',
          characterSheetHashes: refs.characterSheetHashes,
          locationSheetHashes: refs.locationSheetHashes,
          elementReferenceHashes: refs.elementReferenceHashes,
        };
      });

    const shotImagesPayload: ShotImagesWorkflowInput = {
      userId: input.userId,
      teamId: input.teamId,
      sequenceId,
      reservationId: input.reservationId,
      scenesWithVisualPrompts,
      charactersWithSheets,
      locationsWithSheets,
      elements: allElements,
      shotMapping,
      imageModel,
      imageModels,
      aspectRatio,
      resolution,
      sceneSnapshots,
    };
    shotImagesPayload.snapshotInputHash = await computeShotImagesHashFromDto({
      ...shotImagesPayload,
      sceneSnapshots,
    });

    // Render shot images FIRST, then run motion/music prompts — the prior
    // parallel fan-out is now sequential (#929). The motion-prompt pass is
    // conditioned on the ACTUAL rendered starting frame (vision input), which
    // only exists once images have rendered. We capture each scene's primary
    // still here and thread it down as an INPUT — the motion children must
    // never look it up mid-run (a concurrent re-render could swap it). Music
    // has no image dependency but rides along with motion in the same child,
    // so it inherits the wait — an accepted latency cost on the non-critical
    // music artifact in exchange for image-grounded motion. Each child is
    // wrapped in `Promise.allSettled` so a rejection is captured (not thrown)
    // and surfaced together below after recording the analysis duration.
    //
    // REFERENCE-ONLY skips this phase outright: no still is rendered, so the
    // reason motion waits on images disappears and with it the whole image
    // pass. Its motion/music prompts already settled in phase 3
    // (`referenceOnlyPromptsSettled`); nothing is awaited here.
    const shotImagesSettled: PromiseSettledResult<ShotImagesWorkflowResult> =
      referenceOnly
        ? {
            status: 'fulfilled',
            value: { imageUrls: [], frameVersionIds: [] },
          }
        : (
            await Promise.allSettled([
              spawnAndAwaitChild<
                ShotImagesWorkflowInput,
                ShotImagesWorkflowResult
              >(step, {
                binding: this.env.SHOT_IMAGES_WORKFLOW,
                parentBindingName: PARENT_BINDING_NAME,
                parentInstanceId,
                childId: `shot-images:${sequenceId ?? 'no-seq'}`,
                childPayload: shotImagesPayload,
                spawnStepName: 'spawn-shot-images',
                awaitStepName: 'await-shot-images',
                // Must exceed the child's own budget — under a many-sequence
                // burst the image queue alone can outlast the 30-minute
                // default.
                timeout: '90 minutes',
              }),
            ])
          )[0];

    // Snapshot the rendered primary still per scene. `imageUrls` is aligned to
    // `scenesWithVisualPrompts` order (shot-images preserves slots, null for a
    // failed scene); a rejected batch → empty map → motion falls back to
    // text-only (and the rejection is raised below regardless). Reference-only
    // leaves every entry null, which is what the mode means.
    const shotImageUrls =
      shotImagesSettled.status === 'fulfilled'
        ? shotImagesSettled.value.imageUrls
        : [];
    const startingFrameImageUrls: Record<string, string | null> =
      Object.fromEntries(
        scenesWithVisualPrompts.map((scene, i) => [
          scene.sceneId,
          shotImageUrls[i] ?? null,
        ])
      );

    // Settled back in phase 3 when reference-only; otherwise it starts here,
    // because it needs the stills phase 4 just rendered. A phase-3 rejection
    // is carried through unchanged so it surfaces at the shared raise site
    // below, after the analysis duration is recorded. A continue that skipped
    // phase 3 (#1408) has no settled prompts and runs them here regardless.
    const motionMusicSettled: PromiseSettledResult<MotionMusicPromptsWorkflowResult> =
      referenceOnlyPromptsSettled?.status === 'rejected'
        ? referenceOnlyPromptsSettled
        : referenceOnlyPromptsSettled?.status === 'fulfilled' &&
            referenceOnlyPromptsSettled.value
          ? { status: 'fulfilled', value: referenceOnlyPromptsSettled.value }
          : (
              await Promise.allSettled([
                runMotionMusicPrompts({
                  scenesForPrompts: scenesWithVisualPrompts,
                  startingFrameImageUrls,
                  visualSummaryBySceneId: visualPromptBySceneId,
                }),
              ])
            )[0];

    // Record analysis duration before raising failures (mirrors QStash).
    await step.do('record-analysis-duration', async () => {
      if (sequenceId) {
        await scopedDb.sequences.updateAnalysisDurationMs(
          sequenceId,
          Date.now() - startTime
        );
      }
    });

    if (shotImagesSettled.status === 'rejected') {
      throw new Error(
        `Shot image generation failed: ${String(shotImagesSettled.reason)}`
      );
    }
    if (motionMusicSettled.status === 'rejected') {
      throw new Error(
        `Motion/music prompt generation failed: ${String(motionMusicSettled.reason)}`
      );
    }

    const imageUrls = shotImagesSettled.value.imageUrls;
    const frameVersionIds = shotImagesSettled.value.frameVersionIds ?? [];
    const {
      completeScenes,
      motionPromptsBySceneId,
      motionPromptVersionIdsBySceneId,
      musicPrompt,
      musicTags,
    } = motionMusicSettled.value;

    await persistProgress({
      ...(checkpoint ?? { completedStage: 'images' }),
      completedStage: 'images',
    });
    if (stopAt === 'images') {
      return completeScenes;
    }

    // ----------------------------------------------------------------------
    // PHASE 5: motion (+ optional music + merge) batch — single child
    // ----------------------------------------------------------------------
    // Reference-only has no stills to require: the sheets and the prompt are
    // the whole input, so the "at least one image rendered" gate would skip
    // motion on every reference-only sequence.
    const shouldGenerateMotion =
      autoGenerateMotion &&
      primaryVideoModel &&
      (referenceOnly || imageUrls.some((url) => url !== null));
    const shouldGenerateMusic = Boolean(
      autoGenerateMusic &&
      sequenceId &&
      completeScenes.some(
        (s) => s.musicDesign?.presence && s.musicDesign.presence !== 'none'
      )
    );

    if (shouldGenerateMotion) {
      let totalDuration = 0;
      for (const scene of completeScenes) {
        totalDuration += scene.metadata?.durationSeconds || 5;
      }

      const batchShots = buildStoryboardMotionBatchShots({
        scenes: completeScenes,
        shotMapping,
        imageUrls,
        frameVersionIds,
        motionPromptsBySceneId,
        motionPromptVersionIdsBySceneId: motionPromptVersionIdsBySceneId ?? {},
        videoModel: primaryVideoModel,
        aspectRatio,
        resolution,
        characters: charactersWithSheets,
        elements: allElements,
        // Reference-only motion attaches the location sheet too — with no
        // still, it is the only thing establishing the set.
        locations: locationsWithSheets,
        referenceOnly,
      });

      await step.do('phase-5-start', async () => {
        await getGenerationChannel(sequenceId).emit('generation.phase:start', {
          phase: GENERATION_STAGE_META.motion.phase,
          phaseName: shouldGenerateMusic
            ? 'Generating motion & music…'
            : 'Generating motion…',
        });
      });

      await spawnAndAwaitChild<BatchMotionMusicWorkflowInput, unknown>(step, {
        binding: this.env.MOTION_BATCH_WORKFLOW,
        parentBindingName: 'ANALYZE_SCRIPT_WORKFLOW',
        parentInstanceId: event.instanceId,
        childId: `motion-batch:${sequenceId ?? 'no-seq'}`,
        childPayload: {
          userId: input.userId,
          teamId: input.teamId,
          sequenceId,
          reservationId: input.reservationId,
          includeMusic: shouldGenerateMusic,
          shots: batchShots,
          videoModels,
          audioModels: shouldGenerateMusic ? audioModels : undefined,
          music: shouldGenerateMusic
            ? {
                prompt: musicPrompt,
                tags: musicTags,
                duration: totalDuration,
                model: musicModel,
              }
            : undefined,
        },
        spawnStepName: 'spawn-motion-batch',
        awaitStepName: 'await-motion-batch',
        // Must exceed the child's own await budget: motion-batch waits up to
        // 45 minutes per motion/music grandchild (in parallel) plus queue
        // backlog under a many-sequence burst.
        timeout: '90 minutes',
      });

      await persistProgress({
        ...(checkpoint ?? {
          completedStage: shouldGenerateMusic ? 'music' : 'motion',
        }),
        completedStage: shouldGenerateMusic ? 'music' : 'motion',
      });
    }

    return completeScenes;
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

function dedupeById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}
