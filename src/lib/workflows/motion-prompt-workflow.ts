/**
 * Per-scene motion prompt generation.
 *
 * Extends `OpenStoryWorkflowEntrypoint` (failure handling from the base class,
 * see base-workflow.ts); the streaming LLM call runs through
 * `durableStreamingLLMCallCf`, driven by `step.do`. Spawned per scene by
 * `MotionPromptBatchWorkflow`. */

import { computeMotionPromptInputHash } from '@/lib/ai/input-hash';
import { narrowShotPromptContext } from '@/lib/ai/prompt-context';
import {
  motionPromptSchema,
  type MotionPrompt,
} from '@/lib/ai/scene-analysis.schema';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { getShotPromptChannel, getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type { MotionPromptWorkflowInput } from '@/lib/workflow/types';
import { hydrateMotionPromptFromScene } from '@/lib/motion/hydrate-motion-prompt';
import { durableStreamingLLMCallCf } from '@/lib/workflows/llm-call-helper';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'motion-prompt']);

export type MotionPromptWorkflowResult = {
  sceneId: string;
  motionPrompt: MotionPrompt;
  /**
   * The version id that ended up live for this run (#1067) — the completed
   * claim, or, on the unique-index collision path, the identical existing row
   * the claim retired in favour of. Null when nothing was persisted (no shot,
   * or the claim was cancelled mid-flight). Parents chain their render off
   * THIS id rather than re-reading the shot's selection pointer, which a
   * concurrent edit can move to a different prompt between the two steps.
   */
  finalVersionId: string | null;
};

export class MotionPromptWorkflow extends OpenStoryWorkflowEntrypoint<MotionPromptWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<MotionPromptWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<MotionPromptWorkflowResult> {
    const input = event.payload;
    const {
      scene,
      sceneBefore,
      sceneAfter,
      aspectRatio,
      characterBible,
      locationBible,
      elementBible = [],
      styleConfig,
      analysisModelId,
      sequenceId,
      shotId,
      startingFrameImageUrl,
      referenceOnly = false,
    } = input;

    // ============================================================
    // PHASE 3: Motion Prompt Generation (using durableLLMCall helper)
    // ============================================================

    // The motion prompt is conditioned on the rendered starting frame (#929):
    // it's passed to the LLM as a vision input so motion continues the exact
    // pose/composition the image committed to, and the image URL is folded
    // into the staleness hash so a re-render re-stales the prompt.
    //
    // CRITICAL: the still arrives as an INPUT (`startingFrameImageUrl`),
    // snapshotted by the trigger when shot images finished — this workflow
    // must NOT look it up from the DB. A workflow can run/retry/replay at any
    // time, and a concurrent re-render could swap `shot.thumbnailUrl` mid-run;
    // reading it here would condition the prompt on an image the trigger never
    // saw. Null/absent → no still, text-only path.
    if (!startingFrameImageUrl && !referenceOnly) {
      logger.info(
        `[MotionPromptWorkflow:cf] No starting frame provided for ${scene.sceneId}; generating motion prompt without vision input`
      );
    }

    // Reference-only sequences never render a still, so the image-to-video
    // template's central instruction — "do not describe static details, the
    // video model already sees them in the starting frame" — is exactly wrong
    // here: nothing has been seen. The reference-only template asks the LLM to
    // compose the opening frame in words AND direct the motion, while still
    // leaving identity to the bound reference sheets. Two templates rather
    // than one conditional block: the two jobs disagree on their most
    // load-bearing rule, and a prompt that hedges between them gets both
    // half-right.
    const promptName = referenceOnly
      ? ('phase/motion-prompt-reference-only-chat' as const)
      : ('phase/motion-prompt-scene-generation-chat' as const);

    // Narrow the bibles to this scene's entities (via `scene.continuity`, set
    // by scene-split) before the LLM call, so the model and the staleness hash
    // see the same minimal, scene-scoped input. See #867.
    const narrowed = narrowShotPromptContext({
      scene,
      styleConfig,
      characterBible,
      locationBible,
      elementBible,
      aspectRatio,
      analysisModel: analysisModelId,
      startingFrameImageUrl: startingFrameImageUrl ?? null,
      referenceOnly,
    });

    const promptVariables = {
      // Deterministic per input: the note states what IS attached, never a
      // hedged "when available". The pipeline path always has a still (the
      // batch workflow fails a scene without one); the text-only wording only
      // appears for explicit user regenerates before any image exists. The
      // reference-only template does not interpolate this at all — it states
      // the no-still premise in its own first line.
      startingFrameNote: startingFrameImageUrl
        ? 'The rendered starting frame is attached below as an image — animate strictly from it.'
        : 'No rendered starting frame exists yet — derive the motion strictly from the scene data below.',
      sceneBefore: sceneBefore
        ? JSON.stringify(sceneBefore, null, 2)
        : '(none)',
      sceneAfter: sceneAfter ? JSON.stringify(sceneAfter, null, 2) : '(none)',
      scene: JSON.stringify(scene, null, 2),
      characterBible: JSON.stringify(narrowed.characterBible, null, 2),
      locationBible: JSON.stringify(narrowed.locationBible, null, 2),
      elementBible: JSON.stringify(narrowed.elementBible, null, 2),
      styleConfig: JSON.stringify(styleConfig, null, 2),
      aspectRatio,
    };

    logger.info(
      `[MotionPromptWorkflow:cf] Generating motion prompt for scene ${scene.sceneId}`
    );

    const llmMotionPrompt: MotionPrompt = await durableStreamingLLMCallCf(
      step,
      {
        name: 'motion-prompts',
        phase: { number: 5, name: 'Writing motion prompts…' },
        promptName,
        promptVariables,
        modelId: analysisModelId,
        responseSchema: motionPromptSchema,
        additionalMetadata: { shotId },
        reasoning: true,
        // Attach the rendered still whenever we have one. The LLM helper owns
        // the vision-routing policy: it runs the call on a vision-capable model
        // (the chosen model if it sees images, else DEFAULT_VISION_MODEL —
        // e.g. DeepSeek V3.2 → Claude Sonnet, #944). The staleness hash always folds
        // in the image regardless, so a re-render re-stales the prompt.
        visionImageUrls: startingFrameImageUrl
          ? [startingFrameImageUrl]
          : undefined,
      },
      {
        sequenceId,
        workflowRunId: event.instanceId,
        scopedDb,
        reservationId: input.reservationId,
        shotPromptStream:
          input.emitStreaming && shotId
            ? { shotId, promptType: 'motion' }
            : undefined,
      }
    );

    // Mirror the analysis pipeline: dialogue lines come from the scene script
    // when the LLM omits them (common on explicit regenerate runs).
    const motionPrompt = hydrateMotionPromptFromScene(scene, llmMotionPrompt);

    // The version this run left live, returned to the parent so a chained
    // render resolves its prompt by explicit id instead of re-reading the
    // shot's selection pointer (#1067).
    let finalVersionId: string | null = null;

    if (sequenceId && shotId) {
      if (!motionPrompt.fullPrompt) {
        throw new Error(
          `Motion prompt generation returned empty fullPrompt for scene ${scene.sceneId}`
        );
      }

      // Hash the same scene-scoped `narrowed` context the LLM was given above,
      // so the stored hash equals the verify-time recompute by construction.
      const inputHash = await computeMotionPromptInputHash(narrowed);

      finalVersionId = await step.do(
        'save-motion-prompt-to-db',
        async (): Promise<string | null> => {
          let persistedVersionId: string | null = null;
          // The motion prompt is NOT written into `scene.metadata` any more
          // (#713). The version write mirrors its text onto `shot.motionPrompt`
          // and repoints `selectedMotionPromptVersionId` — superseding any prior
          // user override automatically (the override stays in history and can
          // be restored).
          if (input.targetVersionId) {
            // #1085: complete the pre-created pending claim in place. Null =
            // cancelled mid-flight; the output is deliberately discarded.
            const completed =
              await scopedDb.shotPromptVersions.completePendingAiVersion({
                versionId: input.targetVersionId,
                shotId,
                text: motionPrompt.fullPrompt,
                dialogue: motionPrompt.dialogue,
                audio: motionPrompt.audio,
                usesStartFrame: !referenceOnly,
                inputHash,
                analysisModel: analysisModelId,
              });
            if (!completed) {
              logger.info(
                `[MotionPromptWorkflow:cf] claim ${input.targetVersionId} was cancelled mid-run; output discarded`
              );
              return null;
            }
            // The claim itself when it completed; the identical existing row it
            // retired in favour of on the unique-index collision path. Either
            // way this is the version a chained render must consume.
            persistedVersionId = completed.id;
          } else {
            const written = await scopedDb.shotPromptVersions.writeAiVersion({
              shotId,
              text: motionPrompt.fullPrompt,
              dialogue: motionPrompt.dialogue,
              audio: motionPrompt.audio,
              usesStartFrame: !referenceOnly,
              inputHash,
              analysisModel: analysisModelId,
            });
            persistedVersionId = written.id;
          }

          // The prompt lives on `shot.motionPrompt` (mirror) now, not metadata;
          // carry the base scene so the client refreshes the shot on this event.
          await getGenerationChannel(sequenceId).emit(
            'generation.shot:updated',
            {
              shotId,
              updateType: 'motion-prompt',
              metadata: scene,
            }
          );

          if (input.emitStreaming) {
            await getShotPromptChannel(shotId).emit('shotPrompt.completed', {
              promptType: 'motion',
            });
          }
          return persistedVersionId;
        }
      );
    }
    return { sceneId: scene.sceneId, motionPrompt, finalVersionId };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<MotionPromptWorkflowInput>>;
    error: string;
    scopedDb: WorkflowScopedDb;
  }): Promise<void> {
    logger.error('[MotionPromptWorkflow:cf] Failed', { error });
    // #1085: fail the pending claim so it stops reading as "updating".
    // Best-effort — the reconciler sweeps anything this misses.
    if (event.payload.targetVersionId) {
      try {
        await scopedDb.shotPromptVersions.markTerminal(
          event.payload.targetVersionId,
          'failed'
        );
      } catch (dbErr) {
        logger.warn('[MotionPromptWorkflow:cf] failed to mark claim failed', {
          err: dbErr,
        });
      }
    }
    try {
      const payload = event.payload;
      if (payload.emitStreaming && payload.shotId) {
        await getShotPromptChannel(payload.shotId).emit('shotPrompt.failed', {
          promptType: 'motion',
          error,
        });
      }
    } catch (emitErr) {
      logger.warn('[MotionPromptWorkflow:cf] failed to emit failure', {
        err: emitErr,
      });
    }
  }
}
