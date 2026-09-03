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
} from '@/lib/billing/cost-estimation';
import { creditsShortStatusError } from '@/lib/billing/credits-short';
import { addMicros, microsToUsd } from '@/lib/billing/money';
import { gateStoryboardRenders } from '@/lib/billing/storyboard-render-gate';
import { reusesTalentSheet } from '@/lib/talent/reuse-talent-sheet';
import { generateId } from '@/lib/db/id';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { buildCastCharacterBible } from '@/lib/prompts/character-prompt';
import { getGenerationChannel } from '@/lib/realtime';
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
import { findMissingElementEntries } from '@/lib/workflows/element-sheet-workflow';
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
import { getLogger } from '@/lib/observability/logger';

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
      autoGenerateMotion = false,
      autoGenerateMusic = false,
      musicModel,
      audioModels: audioModelsInput,
      suggestedTalentIds,
      suggestedLocationIds,
      referenceOnly = false,
    } = input;

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

    // Automatic style (#1213): derived in parallel with scene-split, whose
    // preview stills render style-free on an automatic run.
    const [sceneSplitResult, styleConfig] = await Promise.all([
      spawnAndAwaitChild<SceneSplitWorkflowInput, SceneSplitWorkflowResult>(
        step,
        {
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
        }
      ),
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
        : Promise.resolve(inputStyleConfig),
    ]);

    const { scenes, shotMapping, characterBible, locationBible, elementBible } =
      sceneSplitResult;

    // ----------------------------------------------------------------------
    // PHASE 2: talent + location matching in parallel
    // ----------------------------------------------------------------------
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
    const { matches: talentCharacterMatches } = talentSettled.value;
    const { matches: libraryLocationMatches } = locationMatchSettled.value;

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
    const billedCharacterSheets = castCharacterBible.filter(
      (character) =>
        !reusesTalentSheet(
          character,
          talentCharacterMatches.find(
            (m) => m.characterId === character.characterId
          )
        )
    ).length;
    const billedElementSheets = findMissingElementEntries(
      elementBible,
      elementsMinimal
    ).length;

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
          locationSheets: locationBible.length,
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
    await step.do('phase-3-start', async () => {
      await getGenerationChannel(sequenceId).emit('generation.phase:start', {
        phase: 3,
        // Accurate in both modes: reference-only writes no VISUAL prompts here
        // but does write its motion/music prompts alongside the sheets.
        phaseName: 'Generating references & prompts…',
      });
    });

    // #835: element-bible entries the scene-split LLM detected (recurring
    // products/objects) that have no uploaded element row need an
    // auto-generated reference image, mirroring the character-sheet
    // treatment. Runs in parallel with the other phase-3 children — visual
    // prompts only consume the bible text, and the generated references are
    // concatenated with `elementsMinimal` into `allElements` before phase 4
    // attaches them to shots.
    //
    // Each entry carries a pre-allocated `sequence_elements.id`: the child's
    // idempotency guards key on it rather than on the (renameable) token, so a
    // replay after the element was renamed can't bill a second reference image.
    const missingElementEntries: ElementSheetEntry[] = sequenceId
      ? findMissingElementEntries(elementBible, elementsMinimal).map(
          (entry) => ({ ...entry, elementId: generateId() })
        )
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

    const [
      charSettled,
      locationSettled,
      framePromptsSettled,
      elementSheetSettled,
      referenceOnlyPromptsSettled,
    ] = await Promise.allSettled([
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
      spawnAndAwaitChild<LocationBibleWorkflowInput, SequenceLocationMinimal[]>(
        step,
        {
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
        }
      ),
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
    ]);

    if (charSettled.status === 'rejected') {
      throw new Error(
        `Character sheet generation failed: ${String(charSettled.reason)}`
      );
    }
    if (locationSettled.status === 'rejected') {
      throw new Error(
        `Location sheet generation failed: ${String(locationSettled.reason)}`
      );
    }
    if (framePromptsSettled.status === 'rejected') {
      throw new Error(
        `Frame prompt generation failed: ${String(framePromptsSettled.reason)}`
      );
    }
    if (elementSheetSettled.status === 'rejected') {
      throw new Error(
        `Element reference generation failed: ${String(elementSheetSettled.reason)}`
      );
    }

    const charactersWithSheets = charSettled.value;
    const locationsWithSheets = locationSettled.value;
    // The visual-prompt workflow returns the generated prompts in memory
    // (#713/#991): thread them straight to the next phase rather than re-reading
    // `frame.imagePrompt` from the DB — versions are append-only and a
    // concurrent run may have repointed the mirror, so a re-read would be racy.
    const scenesWithVisualPrompts = framePromptsSettled.value.scenes;
    const visualPromptBySceneId: Record<string, string> = Object.fromEntries(
      Object.entries(framePromptsSettled.value.visualPromptsBySceneId).map(
        ([sceneId, visual]) => [sceneId, visual.fullPrompt]
      )
    );
    const generatedElements = elementSheetSettled.value;
    const allElements = [...elementsMinimal, ...generatedElements];

    // ----------------------------------------------------------------------
    // PHASE 4: shot images + motion/music prompts in parallel
    // ----------------------------------------------------------------------
    // Reference-only has no phase 4: the stills are skipped and the prompts
    // finished in phase 3, so it emits nothing and the progress rail runs
    // Script → Casting → References → Music & Motion.
    if (!referenceOnly) {
      await step.do('phase-4-start', async () => {
        await getGenerationChannel(sequenceId).emit('generation.phase:start', {
          phase: 4,
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
    // below, after the analysis duration is recorded.
    const motionMusicSettled: PromiseSettledResult<MotionMusicPromptsWorkflowResult> =
      referenceOnlyPromptsSettled.status === 'rejected'
        ? referenceOnlyPromptsSettled
        : referenceOnlyPromptsSettled.value
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
          phase: 5,
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
    const { sequenceId, reservationId } = event.payload;
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
      (await handleLlmAuthFailure(scopedDb, sanitized)) ?? sanitized;

    await scopedDb.sequence(sequenceId).updateStatus('failed', userMessage);
    await getGenerationChannel(sequenceId).emit('generation.failed', {
      message: userMessage,
    });
  }
}
