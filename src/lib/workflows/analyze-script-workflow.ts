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

import { sanitizeScriptContent } from '@/lib/ai/prompt-validation';
import { resolveAudioModels } from '@/lib/ai/resolve-audio-models';
import { resolveImageModels } from '@/lib/ai/resolve-image-models';
import { resolveVideoModels } from '@/lib/ai/resolve-video-models';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { generateId } from '@/lib/db/id';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { assembleMotionPrompt } from '@/lib/motion/assemble-motion-prompt';
import { buildMotionReferenceImages } from '@/lib/motion/build-motion-references';
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

    // ----------------------------------------------------------------------
    // PHASE 3: character bible + location bible + visual prompts in parallel
    // ----------------------------------------------------------------------
    await step.do('phase-3-start', async () => {
      await getGenerationChannel(sequenceId).emit('generation.phase:start', {
        phase: 3,
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
          entries: missingElementEntries,
          imageModel,
          styleConfig,
        },
        spawnStepName: 'spawn-element-sheets',
        awaitStepName: 'await-element-sheets',
      });
      return result.elements;
    };

    const [charSettled, locationSettled, visualSettled, elementSheetSettled] =
      await Promise.allSettled([
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
        spawnAndAwaitChild<
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
        }),
        runElementSheets(),
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
    if (visualSettled.status === 'rejected') {
      throw new Error(
        `Visual prompt generation failed: ${String(visualSettled.reason)}`
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
    const scenesWithVisualPrompts = visualSettled.value.scenes;
    const visualPromptBySceneId: Record<string, string> = Object.fromEntries(
      Object.entries(visualSettled.value.visualPromptsBySceneId).map(
        ([sceneId, visual]) => [sceneId, visual.fullPrompt]
      )
    );
    const generatedElements = elementSheetSettled.value;
    const allElements = [...elementsMinimal, ...generatedElements];

    // ----------------------------------------------------------------------
    // PHASE 4: shot images + motion/music prompts in parallel
    // ----------------------------------------------------------------------
    await step.do('phase-4-start', async () => {
      await getGenerationChannel(sequenceId).emit('generation.phase:start', {
        phase: 4,
        phaseName: 'Generating images…',
      });
    });

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
      scenesWithVisualPrompts,
      charactersWithSheets,
      locationsWithSheets,
      elements: allElements,
      shotMapping,
      imageModel,
      imageModels,
      aspectRatio,
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
    const [shotImagesSettled] = await Promise.allSettled([
      spawnAndAwaitChild<ShotImagesWorkflowInput, ShotImagesWorkflowResult>(
        step,
        {
          binding: this.env.SHOT_IMAGES_WORKFLOW,
          parentBindingName: PARENT_BINDING_NAME,
          parentInstanceId,
          childId: `shot-images:${sequenceId ?? 'no-seq'}`,
          childPayload: shotImagesPayload,
          spawnStepName: 'spawn-shot-images',
          awaitStepName: 'await-shot-images',
          // Must exceed the child's own budget — under a many-sequence burst
          // the image queue alone can outlast the 30-minute default.
          timeout: '90 minutes',
        }
      ),
    ]);

    // Snapshot the rendered primary still per scene. `imageUrls` is aligned to
    // `scenesWithVisualPrompts` order (shot-images preserves slots, null for a
    // failed scene); a rejected batch → empty map → motion falls back to
    // text-only (and the rejection is raised below regardless).
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

    const [motionMusicSettled] = await Promise.allSettled([
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
          scenesWithVisualPrompts,
          shotMapping,
          aspectRatio,
          characterBible: castCharacterBible,
          locationBible,
          elementBible,
          styleConfig,
          analysisModelId,
          videoModel,
          videoModels,
          startingFrameImageUrls,
          visualSummaryBySceneId: visualPromptBySceneId,
          musicPromptSource: input.musicPromptSource,
        },
        spawnStepName: 'spawn-motion-music-prompts',
        awaitStepName: 'await-motion-music-prompts',
        // Must exceed the child's own await budget: motion-prompt scene
        // children get 30 minutes each, plus notify lag under a burst.
        timeout: '60 minutes',
      }),
    ]);

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
    const { completeScenes, motionPromptsBySceneId, musicPrompt, musicTags } =
      motionMusicSettled.value;

    // ----------------------------------------------------------------------
    // PHASE 5: motion (+ optional music + merge) batch — single child
    // ----------------------------------------------------------------------
    const shouldGenerateMotion =
      autoGenerateMotion &&
      primaryVideoModel &&
      imageUrls.some((url) => url !== null);
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

      const batchShots = completeScenes.flatMap((scene, index) => {
        const matchedShot = shotMapping.find(
          (f) => f.analysisSceneId === scene.sceneId
        );
        // The structured motion prompt is threaded in from the motion-prompt
        // phase's return (#713/#991) — NOT re-read from the DB, which would be
        // racy against concurrent append-only version writes.
        // `imageUrls` is aligned to scene order; a null slot means that
        // scene's image generation failed (the shot is already marked
        // failed by the image workflow). Motion-prompt batch also skips
        // those scenes (no starting frame). Skip rather than throwing —
        // a missing still used to fail the whole storyboard.
        const imageUrl = imageUrls[index];
        if (!imageUrl) {
          logger.warn(
            `[AnalyzeScriptWorkflow:cf] Scene ${scene.sceneId} has no generated image (index ${index}); skipping its motion`
          );
          return [];
        }

        const motionPromptData = motionPromptsBySceneId[scene.sceneId];
        if (!motionPromptData?.fullPrompt) {
          throw new WorkflowValidationError(
            `Scene ${scene.sceneId} has no motion prompt`
          );
        }

        const characterTags = scene.continuity?.characterTags;

        return {
          shotId: matchedShot?.shotId ?? '',
          imageUrl,
          // Primary-model prompt (fallback / single-model). `motion-batch`
          // re-assembles per model from `motionPrompt` for the alternates.
          prompt: assembleMotionPrompt({
            motionPrompt: motionPromptData,
            model: primaryVideoModel,
            characterTags,
          }),
          model: primaryVideoModel,
          motionPrompt: motionPromptData,
          characterTags,
          duration: scene.metadata?.durationSeconds || 3,
          aspectRatio,
          // Cast/element refs so motion preserves identity across the clip
          // (#873) — only Kling v3 Pro emits them. Same library + matcher the
          // image step uses, so motion attaches the same references.
          referenceImages: buildMotionReferenceImages({
            scene,
            characters: charactersWithSheets,
            elements: allElements,
          }),
        };
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
    const { sequenceId } = event.payload;
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
