/**
 * Cloudflare Workflows port of `sceneSplitWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/scene-split-workflow.ts`)
 * step for step — same step names, same control flow, same side effects.
 * Differences (all infrastructure-level, not behavioural):
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload`.
 *   - Gap C: the streaming LLM call + per-chunk DB writes + per-chunk
 *     `generation.scene:*` event emissions + per-chunk preview-image
 *     fire-and-forget trigger all run inline inside a single top-level
 *     `step.do('scene-splitting-stream', …)`. If that step fails partway,
 *     the engine replays the entire LLM call — acceptable per the
 *     investigation (`docs/investigations/cloudflare-workflows.md` §Gap C).
 *   - The final value returned from `scene-splitting-stream` is Zod-inferred
 *     and structurally rejected by CF's `Rpc.Serializable<T>` check, so we
 *     JSON-stringify around the step boundary (same pattern as
 *     `visual-prompt-scene-workflow.ts`). */

import {
  callLLMStream,
  llmCostFromUsage,
  PROMPT_REASONING,
} from '@/lib/ai/llm-client';
import { PREVIEW_IMAGE_MODEL } from '@/lib/ai/models';
import { getContextWindow } from '@/lib/ai/models.config';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import {
  type SceneWithShotsResult,
  sceneWithShotsResultSchema,
} from '@/lib/ai/shot-list.schema';
import {
  createStreamingShotListParser,
  type ShotListStreamedScene,
} from '@/lib/ai/streaming-shot-list-parser';
import type { Microdollars } from '@/lib/billing/money';
import type { TokenUsage } from '@tanstack/ai';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import {
  buildSceneInserts,
  buildShotInsertsForScene,
} from '@/lib/ai/scene-persistence';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import type { NewShot } from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { getChatPrompt } from '@/lib/prompts';
import { buildPreviewPrompt } from '@/lib/prompts/poster-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { previewImageDedupId } from '@/lib/workflow/dedup-ids';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { handleLlmAuthFailure } from '@/lib/workflow/llm-auth-failure';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import type {
  ImageWorkflowInput,
  SceneSplitWorkflowInput,
  SceneSplitWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'scene-split']);

const PHASE = { number: 1, name: 'Analyzing script…' } as const;
const STEP_NAME = 'scene-splitting';
const LOG_NAME = `phase-${PHASE.number}-${STEP_NAME}`;
const LOG_TAGS = [STEP_NAME, `phase-${PHASE.number}`, 'analysis'];
const LOG_METADATA = { phase: PHASE.number, phaseName: PHASE.name };

/**
 * Shape produced by the streaming step (post JSON round-trip).
 *
 * #910: the LLM now emits scenes that OWN a `shots[]` array
 * (`sceneWithShotsResultSchema`). `analysisScenes` carries the full structured
 * shot list — the `persist-scenes` step is the single source of truth that
 * expands it into per-shot `shots` rows. `projectMetadata` is preserved so the
 * persist step can extract the title.
 */
type StreamResult = {
  analysisScenes: SceneWithShotsResult['scenes'];
  projectMetadata: SceneWithShotsResult['projectMetadata'];
  characterBible: SceneWithShotsResult['characterBible'];
  locationBible: SceneWithShotsResult['locationBible'];
  elementBible: SceneWithShotsResult['elementBible'];
  /**
   * analysisSceneId → the representative shot id created live during the stream.
   * `persist-scenes` reuses it as the scene's shot 1 so the streamed preview
   * thumbnail survives the canonical rebuild; absent for any scene the stream
   * didn't reach (a replay reconstructs them).
   */
  streamedShotByScene: Record<string, string>;
  /** Provider-reported cost for the LLM call, billed after reconciliation. */
  llmCostMicros: Microdollars;
};

export class SceneSplitWorkflow extends OpenStoryWorkflowEntrypoint<SceneSplitWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<SceneSplitWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<SceneSplitWorkflowResult> {
    const input = event.payload;
    const {
      sequenceId,
      modelId,
      styleConfig,
      aspectRatio,
      elements = [],
    } = input;

    // Gap C: this single `step.do` owns the prompt fetch + the entire
    // streaming session. Inside, the partial-JSON parser, per-chunk DB writes
    // (upsertFrame), per-chunk realtime event emissions
    // (`generation.scene:new`, `generation.shot:created`,
    // `generation.scene:updated`, `generation.updated`,
    // `generation.phase:start`) and per-chunk fire-and-forget preview-image
    // triggers all run inline. On step failure the engine replays the whole
    // stream — acceptable per the investigation. The prompt fetch is folded
    // in because the Langfuse `ChatPromptClient` reference is not
    // `Rpc.Serializable<T>` and so can't cross a step boundary; keeping it
    // local also means the per-chunk side effects share the same retry
    // boundary as the LLM call that produced them. JSON-stringify the final
    // value around the boundary so the Zod-inferred result survives CF's
    // `Rpc.Serializable<T>` typecheck.
    const streamResultJson = await step.do(
      'scene-splitting-stream',
      async (): Promise<string> => {
        const elementsBlock =
          elements.length > 0
            ? elements
                .map((el) => {
                  // analyzeScriptWorkflow refuses to start while any element
                  // is pending/analyzing, so a null description here means
                  // vision genuinely failed for this row.
                  const desc = el.description
                    ? `: ${el.description}`
                    : ' (no visual reference available)';
                  return `- ${el.token}${desc}`;
                })
                .join('\n')
            : '(none)';
        const { prompt: promptReference, messages } = await getChatPrompt(
          input.promptName,
          {
            aspectRatio,
            script: input.script,
            elements: elementsBlock,
          }
        );

        const llmKeyInfo = await scopedDb.apiKeys.resolveLlmKey();

        logger.info(
          `[SceneSplitWorkflow:cf] [LLM:${LOG_NAME}] Starting streaming call`,
          {
            model: modelId,
            keySource: llmKeyInfo.source,
            keyVia: llmKeyInfo.via,
            messageCount: messages.length,
          }
        );

        const parser = createStreamingShotListParser();
        // Representative shot per analysis scene, created live so scene tiles +
        // preview images appear during the stream. `persist-scenes` reconciles
        // this into the canonical per-shot rows (shot 1 reuses the streamed
        // representative, shots 2..N are added) from the validated shot list.
        const streamedShotByScene = new Map<string, string>();
        let finalText = '';
        let chunkCount = 0;
        let prevScene: ShotListStreamedScene | undefined = undefined;
        let prevFrameId: string | undefined = undefined;
        let parsedResult: SceneWithShotsResult | undefined;
        let capturedUsage: TokenUsage | undefined;

        for await (const chunk of callLLMStream<SceneWithShotsResult>({
          model: modelId,
          messages,
          max_tokens: Math.floor(getContextWindow(modelId) * 0.65),
          responseSchema: sceneWithShotsResultSchema,
          apiKey: llmKeyInfo,
          reasoning: PROMPT_REASONING,
          observationName: LOG_NAME,
          prompt: promptReference,
          tags: LOG_TAGS,
          metadata: LOG_METADATA,
          userId: input.userId,
          sessionId: input.sequenceId,
        })) {
          if (chunk.done) {
            if (chunk.parsed !== undefined) parsedResult = chunk.parsed;
            capturedUsage = chunk.usage;
          }
          chunkCount++;
          finalText = chunk.accumulated;
          const events = parser.feed(chunk.accumulated);

          if (chunkCount % 20 === 0) {
            logger.info(
              `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] chunk #${chunkCount} | ${finalText.length} chars | ${streamedShotByScene.size} scenes so far`
            );
          }

          for (const ev of events) {
            if (ev.type === 'title' && sequenceId) {
              logger.info(
                `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Title detected: "${ev.title}" (chunk #${chunkCount})`
              );
              await scopedDb.sequences.updateTitle(sequenceId, ev.title);
              await getGenerationChannel(sequenceId).emit(
                'generation.updated',
                { title: ev.title }
              );
            }

            if (ev.type === 'characterBible' && sequenceId) {
              logger.info(
                `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Character bible detected (${ev.bible.length} entries), advancing to phase 2`
              );
              await getGenerationChannel(sequenceId).emit(
                'generation.phase:start',
                {
                  phase: 2,
                  phaseName: 'Casting characters & locations…',
                }
              );
            }

            if (ev.type === 'scene:updated') {
              logger.info(
                `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Scene ${ev.index + 1} title updated: "${ev.scene.metadata.title}" (chunk #${chunkCount})`
              );

              if (sequenceId) {
                await scopedDb.shots.upsert({
                  sequenceId,
                  description: ev.scene.originalScript.extract || '',
                  orderIndex: ev.index,
                  metadata: ev.scene,
                  durationMs: Math.round(
                    (ev.scene.metadata.durationSeconds || 3) * 1000
                  ),
                  thumbnailStatus: 'generating',
                  videoStatus: 'pending',
                } satisfies NewShot);
              }

              await getGenerationChannel(sequenceId).emit(
                'generation.scene:updated',
                {
                  sceneId: ev.scene.sceneId,
                  sceneNumber: ev.scene.sceneNumber,
                  title: ev.scene.metadata.title || 'Untitled Scene',
                  scriptExtract: ev.scene.originalScript.extract || '',
                  durationSeconds: ev.scene.metadata.durationSeconds || 3,
                }
              );
            }

            if (ev.type === 'scene') {
              logger.info(
                `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Scene ${ev.index + 1} complete: "${ev.scene.metadata.title}" (chunk #${chunkCount}, ${finalText.length} chars)`
              );

              await getGenerationChannel(sequenceId).emit(
                'generation.scene:new',
                {
                  sceneId: ev.scene.sceneId,
                  sceneNumber: ev.scene.sceneNumber,
                  title: ev.scene.metadata.title || 'Untitled Scene',
                  scriptExtract: ev.scene.originalScript.extract || '',
                  durationSeconds: ev.scene.metadata.durationSeconds || 3,
                }
              );

              if (sequenceId) {
                const frame = await scopedDb.shots.upsert({
                  sequenceId,
                  description: ev.scene.originalScript.extract || '',
                  orderIndex: ev.index,
                  metadata: ev.scene,
                  durationMs: Math.round(
                    (ev.scene.metadata.durationSeconds || 3) * 1000
                  ),
                  thumbnailStatus: 'generating',
                  videoStatus: 'pending',
                } satisfies NewShot);

                logger.info(
                  `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Representative shot created: ${frame.id} for scene "${ev.scene.sceneId}"`
                );

                streamedShotByScene.set(ev.scene.sceneId, frame.id);

                await getGenerationChannel(sequenceId).emit(
                  'generation.shot:created',
                  {
                    shotId: frame.id,
                    sceneId: ev.scene.sceneId,
                    orderIndex: ev.index,
                  }
                );
                if (prevScene && prevFrameId) {
                  const sceneText =
                    prevScene.originalScript.extract ||
                    prevScene.metadata.title ||
                    'A cinematic scene';
                  const prompt = buildPreviewPrompt(sceneText, styleConfig);

                  // Fire-and-forget preview-image trigger for the previous
                  // scene. Routed through `triggerWorkflow` so the engine
                  // registry picks whichever engine is configured for
                  // `/image` at runtime. The deduplicationId makes a replay
                  // of this mega-step idempotent (see dedup-ids.ts).
                  await triggerWorkflow(
                    '/image',
                    {
                      userId: input.userId,
                      teamId: input.teamId,
                      sequenceId,
                      prompt,
                      model: PREVIEW_IMAGE_MODEL,
                      imageSize: aspectRatioToImageSize(aspectRatio),
                      numImages: 1,
                      shotId: prevFrameId,
                      skipStorage: true,
                    } satisfies ImageWorkflowInput,
                    {
                      label: buildWorkflowLabel(sequenceId),
                      deduplicationId: previewImageDedupId(
                        event.instanceId,
                        prevFrameId
                      ),
                    }
                  );
                }

                prevFrameId = frame.id;
              }
              prevScene = ev.scene;
            }
          }
        }

        // Trigger preview for the last scene (the loop only triggers N-1).
        if (prevScene && prevFrameId && sequenceId) {
          const sceneText =
            prevScene.originalScript.extract ||
            prevScene.metadata.title ||
            'A cinematic scene';
          const prompt = buildPreviewPrompt(sceneText, styleConfig);

          await triggerWorkflow(
            '/image',
            {
              userId: input.userId,
              teamId: input.teamId,
              sequenceId,
              prompt,
              model: PREVIEW_IMAGE_MODEL,
              imageSize: aspectRatioToImageSize(aspectRatio),
              numImages: 1,
              shotId: prevFrameId,
              skipStorage: true,
            } satisfies ImageWorkflowInput,
            {
              label: buildWorkflowLabel(sequenceId),
              deduplicationId: previewImageDedupId(
                event.instanceId,
                prevFrameId
              ),
            }
          );
        }

        if (!parsedResult) {
          throw new NonRetryableError(
            `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Stream ended without a validated structured-output payload. ` +
              `chunks=${chunkCount} chars=${finalText.length} ` +
              `streamedScenes=${streamedShotByScene.size} model=${modelId}. ` +
              `Likely cause: provider did not honor responseFormat:json_schema.`
          );
        }
        const parsed = parsedResult;
        const totalShots = parsed.scenes.reduce(
          (sum, s) => sum + s.shots.length,
          0
        );
        logger.info(
          `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Complete | ${chunkCount} chunks | ${parsed.scenes.length} scenes | ${totalShots} shots | ${finalText.length} chars`
        );

        // JSON round-trip: the inferred shape contains Zod discriminated
        // unions / catch-defaulted arrays that confuse CF's
        // `Rpc.Serializable<T>` typecheck. The value is JSON-clean at
        // runtime; stringify on the way out, parse on the way in.
        const streamResult: StreamResult = {
          analysisScenes: parsed.scenes,
          projectMetadata: parsed.projectMetadata,
          characterBible: parsed.characterBible,
          locationBible: parsed.locationBible,
          elementBible: parsed.elementBible,
          streamedShotByScene: Object.fromEntries(streamedShotByScene),
          llmCostMicros: llmCostFromUsage(capturedUsage, modelId),
        };
        return JSON.stringify(streamResult);
      }
    );
    // Defensive shape check on replay — the data was Zod-validated once
    // inside the step, but if CF's step-cache persisted something corrupt
    // we fail loud here instead of silently downstream.
    const streamResult: StreamResult = JSON.parse(streamResultJson);
    if (!Array.isArray(streamResult.analysisScenes)) {
      throw new NonRetryableError(
        'scene-splitting-stream returned a malformed result from cache',
        'WorkflowValidationError'
      );
    }

    // ----------------------------------------------------------------------
    // Step 3 (#910): persist scenes + per-shot rows as the single source of
    // truth, and build the FLAT per-shot downstream payload.
    //
    // Each analysis scene owns a `shots[]` list. We expand it via
    // `buildShotInsertsForScene` into N `shots` rows, each carrying a UNIQUE
    // `metadata.sceneId` token (`<analysisSceneId>#<shotNumber>`, or the bare id
    // for a single-shot scene). The downstream chain (visual-prompt / image /
    // motion) stays one-unit-per-element and keeps keying on `metadata.sceneId`
    // unchanged — a single-shot scene is byte-for-byte the same as before.
    //
    // The streamed representative shot is reused as each scene's shot 1 (so its
    // live preview thumbnail survives); shots 2..N are created fresh. Stale
    // shots from a prior run / extra streamed rows are pruned. Idempotent on
    // replay: scenes + shots are rebuilt from the validated `analysisScenes`.
    // ----------------------------------------------------------------------
    const resolvedTitle = streamResult.projectMetadata.title || 'Untitled';

    const persistJson = await step.do(
      'persist-scenes',
      async (): Promise<string> => {
        // Build the flat per-shot downstream payload from the validated shot
        // list. `deriveShotScenes` (inside buildShotInsertsForScene) is the one
        // place visual+motion prompts are derived (#908).
        const flatScenes: Scene[] = [];
        const shotMapping: SceneSplitWorkflowResult['shotMapping'] = [];

        if (!sequenceId) {
          // No persistence target (anonymous preview path) — still expand the
          // shot list so downstream gets per-shot units, with empty shotIds.
          for (const analysisScene of streamResult.analysisScenes) {
            const inserts = buildShotInsertsForScene({
              sequenceId: 'preview',
              // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- preview path has no real scene row; id is unused without a sequence
              sceneId: '' as never,
              scene: analysisScene,
              styleConfig,
              baseOrderIndex: 0,
            });
            for (const ins of inserts) {
              if (ins.metadata) flatScenes.push(ins.metadata);
            }
          }
          return JSON.stringify({
            scenes: flatScenes,
            title: resolvedTitle,
            shotMapping,
            characterBible: streamResult.characterBible,
            locationBible: streamResult.locationBible,
            elementBible: streamResult.elementBible,
          } satisfies SceneSplitWorkflowResult);
        }

        // Rebuild scenes (only ever written here). Shots are reconciled in
        // place: each scene's shot 1 reuses the streamed representative id so
        // its live preview thumbnail survives; shots 2..N are created fresh;
        // any pre-existing shot not kept (a prior run, or extra streamed rows
        // when the final shot count shrank) is pruned at the end. Avoiding a
        // blanket delete keeps the representative rows — and their previews —
        // alive across the rebuild and across CF step replays.
        await scopedDb.scenes.deleteBySequence(sequenceId);

        const existingShots = await scopedDb.shots.listBySequence(sequenceId);
        const existingShotIds = new Set(existingShots.map((s) => s.id));
        const keptShotIds = new Set<string>();

        const sceneInserts = buildSceneInserts(
          sequenceId,
          streamResult.analysisScenes
        );
        const sceneRows = await scopedDb.scenes.createBulk(sceneInserts);
        // createBulk is 1:1 with its inserts, which are 1:1 with analysisScenes.
        // A shortfall means a partial DB write — fail loudly rather than silently
        // dropping a scene's entire shot set (missing storyboard content, no trace).
        if (sceneRows.length !== sceneInserts.length) {
          throw new NonRetryableError(
            `Scene persistence count mismatch for sequence ${sequenceId}: ` +
              `expected ${sceneInserts.length} scene rows, got ${sceneRows.length}`
          );
        }

        let orderIndex = 0;
        for (const [
          sceneIndex,
          analysisScene,
        ] of streamResult.analysisScenes.entries()) {
          const sceneRow = sceneRows[sceneIndex];
          if (!sceneRow) {
            // Unreachable given the count guard above; throw to satisfy
            // narrowing and never silently skip a scene.
            throw new NonRetryableError(
              `Missing persisted scene row at index ${sceneIndex} for sequence ${sequenceId}`
            );
          }

          const inserts = buildShotInsertsForScene({
            sequenceId,
            sceneId: sceneRow.id,
            scene: analysisScene,
            styleConfig,
            baseOrderIndex: orderIndex,
          });
          orderIndex += inserts.length;

          // Reuse the streamed representative shot id (if it still exists) for
          // shot 1 so its live preview thumbnail survives the rebuild.
          const representativeId =
            streamResult.streamedShotByScene[analysisScene.sceneId];

          for (const [i, ins] of inserts.entries()) {
            const reuseId =
              i === 0 &&
              representativeId &&
              existingShotIds.has(representativeId)
                ? representativeId
                : undefined;
            const shot = reuseId
              ? ((await scopedDb.shots.update(reuseId, ins, {
                  throwOnMissing: false,
                })) ?? (await scopedDb.shots.create(ins)))
              : await scopedDb.shots.create(ins);

            keptShotIds.add(shot.id);
            if (ins.metadata) flatScenes.push(ins.metadata);
            shotMapping.push({
              // The per-shot unique token is the downstream key.
              analysisSceneId: ins.metadata?.sceneId ?? analysisScene.sceneId,
              shotId: shot.id,
            });

            await getGenerationChannel(sequenceId).emit(
              'generation.shot:created',
              {
                shotId: shot.id,
                sceneId: analysisScene.sceneId,
                orderIndex: ins.orderIndex,
              }
            );
          }
        }

        // Prune any leftover shots not part of the canonical rebuild.
        for (const stale of existingShots) {
          if (!keptShotIds.has(stale.id)) {
            await scopedDb.shots.delete(stale.id);
          }
        }

        await scopedDb.sequences.updateTitle(sequenceId, resolvedTitle);
        await scopedDb.sequences.updateWorkflow(
          sequenceId,
          'analyze-script-shorter-prompts-batch-size-1'
        );

        return JSON.stringify({
          scenes: flatScenes,
          title: resolvedTitle,
          shotMapping,
          characterBible: streamResult.characterBible,
          locationBible: streamResult.locationBible,
          elementBible: streamResult.elementBible,
        } satisfies SceneSplitWorkflowResult);
      }
    );
    const reconciled: SceneSplitWorkflowResult = JSON.parse(persistJson);
    if (
      !Array.isArray(reconciled.scenes) ||
      !Array.isArray(reconciled.shotMapping)
    ) {
      throw new NonRetryableError(
        'persist-scenes returned a malformed result from cache',
        'WorkflowValidationError'
      );
    }

    // Step 4: Reconcile element bible → update firstMention on existing rows.
    // `firstMention.sceneId` references the ORIGINAL analysis scene id (not the
    // per-shot token), which the element-bible entries carry verbatim.
    if (sequenceId && reconciled.elementBible.length > 0) {
      await step.do('reconcile-element-bible', async () => {
        for (const entry of reconciled.elementBible) {
          const existing = await scopedDb.sequenceElements.getByToken(
            sequenceId,
            entry.token
          );
          if (!existing) continue;
          await scopedDb.sequenceElements.updateFirstMention(existing.id, {
            sceneId: entry.firstMention.sceneId,
            text: entry.firstMention.text,
            lineNumber: entry.firstMention.lineNumber,
          });
        }
      });
    }

    // Step 5: Deduct credits.
    const llmCreditKeyInfo = await scopedDb.apiKeys.resolveLlmKey();
    await step.do('deduct-llm-credits-scene-splitting', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: streamResult.llmCostMicros,
        usedOwnKey: llmCreditKeyInfo.source === 'team',
        description: `LLM analysis (${modelId})`,
        idempotencyKey: `${event.instanceId}:llm-${STEP_NAME}`,
        metadata: {
          model: modelId,
          phase: PHASE.number,
          phaseName: PHASE.name,
          stepName: STEP_NAME,
          sequenceId,
          costMicros: streamResult.llmCostMicros,
        },
      });
    });

    return reconciled;
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<SceneSplitWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const { sequenceId } = event.payload;
    logger.error('[SceneSplitWorkflow:cf] Failure:', {
      err: error,
    });

    const userMessage =
      (await handleLlmAuthFailure(scopedDb, sanitizeFailResponse(error))) ??
      'Scene splitting failed';

    if (sequenceId) {
      try {
        await getGenerationChannel(sequenceId).emit('generation.error', {
          message: userMessage,
        });
      } catch (emitError) {
        logger.error(
          `[SceneSplitWorkflow:cf] Failed to emit failure event for sequence ${sequenceId}:`,
          {
            err: emitError,
          }
        );
      }
    }
  }
}
