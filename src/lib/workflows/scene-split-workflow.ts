/**
 * Scene-split workflow (#1035: two parallel LLM calls, boundary annotation).
 *
 * The old single mega-call (scenes + bibles in one 8.2KB schema) exceeded
 * Anthropic's native strict-output grammar budget and re-emitted the entire
 * script through the LLM. It is replaced by two independent calls over the
 * same script, run concurrently as sibling `step.do`s:
 *
 *   - `scene-splitting-stream` — the scenes call. A boundary-annotation
 *     contract: the LLM returns `{ hintLine, quote }` anchors against a
 *     line-gutter copy of the script (no per-scene metadata). The ORIGINAL
 *     script is sliced locally (`boundary-split.ts`); title/location/
 *     dialogue/duration come from each slice (`scene-from-slice.ts`). Scene
 *     ids/numbers are minted server-side. Streaming: boundary k+1 arriving
 *     finalizes scene k via a local slice, so scene cards appear with real
 *     script text in seconds.
 *   - `scene-bibles` — character/location/element bibles.
 *
 * After the join, scene continuity tags are assigned from bibles ∩ slice
 * (`tag-reconcile.ts`) and bible `firstMention`s get their owning scene id
 * derived from the gutter line.
 *
 * Excessive *drops* trigger one retry with feedback; a second degraded
 * result keeps the first-pass LLM scenes (verbatim slices + metadata).
 * Fuzzy/normalized repairs that still produce a full partition are kept
 * without a second LLM call — #1218 timed out three times retrying 14
 * locally-repaired quotes with empty feedback. Dropped boundaries are
 * always logged and emitted as a non-fatal `generation.error`. Preview-image
 * triggers fire as each scene finalizes (one per boundary as it settles)
 * so a burst of boundaries does not wait on a metadata tail.
 *
 * Infrastructure notes (unchanged from the previous version): per-chunk DB
 * writes + realtime emissions run inline inside the streaming step (a step
 * failure replays the whole LLM call — accepted); step return values are
 * JSON-stringified around the boundary for CF's `Rpc.Serializable<T>` check.
 */

import {
  callLLMStream,
  llmCostFromUsage,
  PROMPT_REASONING,
} from '@/lib/ai/llm-client';
import { PREVIEW_IMAGE_MODEL } from '@/lib/ai/models';
import { getMaxOutputTokens, SCENE_SPLIT_MODEL } from '@/lib/ai/models.config';
import {
  type SceneSplitBiblesResult,
  type SceneSplitScenesResult,
  sceneSplitBiblesResultSchema,
  sceneSplitScenesResultSchema,
} from '@/lib/ai/response-schemas';
import {
  addLineGutter,
  isExcessivelyRepaired,
  sceneIndexForLine,
  type ResolvedBoundaries,
} from '@/lib/ai/boundary-split';
import {
  assembleScenes,
  createStreamingSceneParser,
  type SceneSplittingScene,
} from '@/lib/ai/streaming-scene-parser';
import { reconcileSceneTags } from '@/lib/ai/tag-reconcile';
import type {
  ElementBibleEntry,
  LocationBibleEntry,
} from '@/lib/ai/scene-analysis.schema';
import { addMicros, type Microdollars } from '@/lib/billing/money';
import type { TokenUsage } from '@tanstack/ai';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import {
  buildSceneInsert,
  buildSceneShotLinks,
} from '@/lib/ai/scene-persistence';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import { generateId } from '@/lib/db/id';
import { dbSceneId, type NewShot } from '@/lib/db/schema';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import type { ShotWithAnchorFrame } from '@/lib/db/scoped/shots';
import { getChatPrompt, type ChatMessage } from '@/lib/prompts';
import { buildPreviewPrompt } from '@/lib/prompts/poster-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { previewImageDedupId } from '@/lib/workflow/dedup-ids';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { handleLlmAuthFailure } from '@/lib/workflow/llm-auth-failure';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import type {
  ImageWorkflowInput,
  SceneSplitWorkflowInput,
  SceneSplitWorkflowResult,
} from '@/lib/workflow/types';
import type {
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepConfig,
} from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'scene-split']);

/**
 * Re-parse the accumulated stream at most once per this many new characters.
 *
 * `parser.feed` is O(buffer): it re-parses the WHOLE response so far. Called
 * on every delta — one token, ~4 chars — that is O(n²) over the response and
 * is what exceeded the 128 MB isolate ceiling under the old contract (#1161).
 * The boundary contract shrinks the response ~10×, but the coalescing stays:
 * it cuts the parse count ~60× for well under a second of extra latency.
 */
const PARSE_COALESCE_CHARS = 256;

/**
 * Retry / timeout budget for `scene-splitting-stream`.
 *
 * Retry limit is lower than the engine default on purpose. This step owns
 * an entire LLM call, so every retry re-runs and re-bills a full generation.
 * Two retries still cover a genuinely transient provider error.
 *
 * Timeout is raised above the engine's 10-minute default (#1218). Grok 4.6
 * with reasoning can spend several minutes thinking before the first
 * boundary token; a dropped-quote repair retry is a second pass. 20
 * minutes covers one pass plus that retry. The previous 10-minute default
 * killed a usable first pass three times (and billed five generations)
 * when the call still emitted per-scene metadata.
 */
const STREAM_STEP_RETRIES = {
  retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
  timeout: '20 minutes',
} as const satisfies WorkflowStepConfig;

const PHASE = { number: 1, name: 'Analyzing script…' } as const;
const STEP_NAME = 'scene-splitting';
const LOG_NAME = `phase-${PHASE.number}-${STEP_NAME}`;
const LOG_TAGS = [STEP_NAME, `phase-${PHASE.number}`, 'analysis'];
const LOG_METADATA = { phase: PHASE.number, phaseName: PHASE.name };

const BIBLES_STEP_NAME = 'scene-bibles';
const BIBLES_PROMPT_NAME = 'phase/scene-bibles-chat';
const BIBLES_LOG_NAME = `phase-${PHASE.number}-${BIBLES_STEP_NAME}`;

/**
 * Persist one analysis scene as a `scenes` row and its 1:1 shot, linked via
 * `shots.sceneId`, as soon as the stream emits it. Without this the Scenes
 * spine (#986) only has flat unassigned shots until the late `persist-scenes`
 * step — the pre-#1055 look. Multi-shot analysis (#910) will attach N shots
 * to the same scene row; today every scene is still one shot at shotNumber 1.
 */
async function persistStreamedSceneAndShot(
  scopedDb: WorkflowScopedDb,
  sequenceId: string,
  scene: SceneSplittingScene,
  orderIndex: number
): Promise<ShotWithAnchorFrame> {
  const sceneRow = await scopedDb.scenes.upsert(
    buildSceneInsert(sequenceId, scene, orderIndex)
  );
  // Seed the split script version as soon as the scene lands so composed
  // script / the Scenes script view have text mid-stream. Idempotent: the
  // final persist-scenes step re-seeds without duplicating.
  await scopedDb.sceneScriptVersions.seedSplitVersions([
    {
      sceneId: sceneRow.id,
      content: scene.originalScript,
      createdAt: sceneRow.createdAt,
    },
  ]);
  return scopedDb.shots.upsert({
    sequenceId,
    durationMs: Math.round((scene.metadata.durationSeconds || 3) * 1000),
    sceneId: sceneRow.id,
    shotNumber: 1,
  } satisfies NewShot);
}

/**
 * Fire-and-forget preview image for one shot, routed through `triggerWorkflow`
 * so the engine registry picks whichever engine is configured for `/image` at
 * runtime. The deduplicationId makes a replay of the mega-step idempotent (see
 * dedup-ids.ts).
 *
 * Failures are swallowed by design (#1149). Previews are decorative
 * (`skipStorage: true`) and nothing downstream reads the result, but a throw
 * here fails `scene-splitting-stream` → `scene-split` → `analyze-script` → the
 * whole sequence, discarding every still that already rendered and cost money.
 * A content-checker hit on one of ~18 previews is a routine outcome, not a
 * reason to lose the run.
 */
async function triggerPreviewImage({
  input,
  sequenceId,
  parentInstanceId,
  shot,
  scene,
  scopedDb,
}: {
  input: SceneSplitWorkflowInput;
  sequenceId: string;
  parentInstanceId: string;
  shot: { id: string; frameId: string };
  scene: SceneSplittingScene;
  scopedDb: WorkflowScopedDb;
}): Promise<void> {
  const sceneText =
    scene.originalScript.extract || scene.metadata.title || 'A cinematic scene';

  try {
    const enforcement = await scopedDb.liveRead.compliance.listEnforcementFor(
      input.userId,
      input.teamId
    );
    await triggerWorkflow(
      '/image',
      {
        userId: input.userId,
        teamId: input.teamId,
        sequenceId,
        prompt: buildPreviewPrompt(sceneText),
        model: PREVIEW_IMAGE_MODEL,
        imageSize: aspectRatioToImageSize(input.aspectRatio),
        numImages: 1,
        shotId: shot.id,
        // Without this the run stands down before generating — and before
        // #1101 it generated, billed, then dropped the preview at
        // `record-preview-variant` (#1119).
        frameId: shot.frameId,
        skipStorage: true,
      } satisfies ImageWorkflowInput,
      {
        label: buildWorkflowLabel(sequenceId),
        deduplicationId: previewImageDedupId(parentInstanceId, shot.id),
        enforcement,
      }
    );
  } catch (error) {
    logger.warn(
      `[SceneSplitWorkflow:cf] preview image trigger failed for shot ${shot.id}; continuing without it`,
      { sequenceId, err: error }
    );
  }
}

/**
 * Shape produced by the scenes streaming step (post JSON round-trip).
 * `offsets` are the resolved boundary offsets (used to derive owning scenes
 * for bible `firstMention` lines); `shotMapping` reflects only the shots
 * written inline during streaming.
 */
type StreamResult = {
  scenes: SceneSplittingScene[];
  title: string;
  shotMapping: Array<{
    analysisSceneId: string;
    shotId: string;
    frameId: string | null;
  }>;
  /** Raw-script start offset per final scene (a true partition of the script). */
  offsets: number[];
  /** Provider-reported cost for the LLM call(s), billed after reconciliation. */
  llmCostMicros: Microdollars;
  /**
   * Non-secret source of the key the streaming call actually used. Carried out
   * of the step so the (much later) deduction bills the same resolution
   * instead of re-reading mutable key state mid-run.
   */
  llmKeySource: 'team' | 'platform';
};

/** Shape produced by the bibles step (post JSON round-trip). */
type BiblesStepResult = SceneSplitBiblesResult & {
  llmCostMicros: Microdollars;
  llmKeySource: 'team' | 'platform';
};

async function reportDroppedBoundaries(
  sequenceId: string | undefined,
  resolution: ResolvedBoundaries,
  boundaries: ReadonlyArray<{ quote: string }>
): Promise<void> {
  if (resolution.dropped.length === 0) return;
  const quotes = resolution.dropped
    .map((i) => boundaries[i]?.quote)
    .filter((q): q is string => typeof q === 'string' && q.length > 0);
  logger.warn(
    `[SceneSplitWorkflow:cf] Dropped unresolvable scene boundaries; those scenes merged into their predecessor`,
    { sequenceId, dropped: resolution.dropped, quotes, kept: resolution.kept }
  );
  if (!sequenceId) return;
  const n = resolution.dropped.length;
  await getGenerationChannel(sequenceId).emit('generation.error', {
    message:
      n === 1
        ? 'One scene boundary could not be found in the script and was merged into the previous scene.'
        : `${n} scene boundaries could not be found in the script and were merged into neighbouring scenes.`,
    phase: PHASE.number,
  });
}

export class SceneSplitWorkflow extends OpenStoryWorkflowEntrypoint<SceneSplitWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<SceneSplitWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: WorkflowScopedDb
  ): Promise<SceneSplitWorkflowResult> {
    const input = event.payload;
    const { sequenceId, modelId, elements = [] } = input;
    const script = input.script;

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
    // Both calls see the same numbered-gutter copy of the script: the scenes
    // call reports hintLine against it, the bibles call firstMention lines.
    const gutteredScript = addLineGutter(script);
    const splitMaxTokens = getMaxOutputTokens(SCENE_SPLIT_MODEL, 0.65);
    const biblesMaxTokens = getMaxOutputTokens(modelId, 0.65);

    // The two LLM calls are independent given the script, so their steps run
    // concurrently — output length drives latency and the scenes stream is
    // what the user watches. Each step resolves its own key INSIDE the step
    // (mutable D1 state must not be read between steps).
    const scenesStep = step.do(
      'scene-splitting-stream',
      STREAM_STEP_RETRIES,
      async (): Promise<string> => {
        const { messages } = await getChatPrompt(input.promptName, {
          script: gutteredScript,
        });

        const llmKeyInfo =
          await scopedDb.credentials.resolveLlmKey(SCENE_SPLIT_MODEL);

        logger.info(
          `[SceneSplitWorkflow:cf] [LLM:${LOG_NAME}] Starting streaming call`,
          {
            model: SCENE_SPLIT_MODEL,
            keySource: llmKeyInfo.source,
            keyVia: llmKeyInfo.via,
            messageCount: messages.length,
          }
        );

        const parser = createStreamingSceneParser(script, generateId);
        const shotMapping: StreamResult['shotMapping'] = [];
        const shotByIndex = new Map<number, { id: string; frameId: string }>();
        const sceneByIndex = new Map<number, SceneSplittingScene>();
        const previewTriggered = new Set<number>();
        let finalText = '';
        let chunkCount = 0;
        /** Buffer length at the last `parser.feed` — see PARSE_COALESCE_CHARS. */
        let parsedChars = 0;

        // `withEvents: false` (the repair retry) drains for the final parsed
        // payload only: the parser is stateful against pass-1's stream, so
        // re-feeding it a different response would emit nonsense events. The
        // rows written during pass 1 are reconciled by persist-scenes.
        const runStreamingPass = async (
          passMessages: ChatMessage[],
          { withEvents }: { withEvents: boolean }
        ): Promise<{
          parsed: SceneSplitScenesResult | undefined;
          usage: TokenUsage | undefined;
        }> => {
          let parsed: SceneSplitScenesResult | undefined;
          let usage: TokenUsage | undefined;
          for await (const chunk of callLLMStream<SceneSplitScenesResult>({
            model: SCENE_SPLIT_MODEL,
            messages: passMessages,
            max_tokens: splitMaxTokens,
            responseSchema: sceneSplitScenesResultSchema,
            apiKey: llmKeyInfo,
            reasoning: PROMPT_REASONING,
            observationName: LOG_NAME,
            tags: LOG_TAGS,
            metadata: LOG_METADATA,
            userId: input.userId,
            sessionId: input.sequenceId,
          })) {
            if (chunk.done) {
              if (chunk.parsed !== undefined) parsed = chunk.parsed;
              usage = chunk.usage;
            }
            chunkCount++;
            finalText = chunk.accumulated;

            if (chunkCount % 20 === 0) {
              logger.info(
                `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] chunk #${chunkCount} | ${finalText.length} chars | ${shotMapping.length} shots so far`
              );
            }

            // The final feed runs with done=true, so the last scene (whose
            // end is the script end) is still emitted before the loop ends.
            if (
              !withEvents ||
              (!chunk.done &&
                finalText.length - parsedChars < PARSE_COALESCE_CHARS)
            ) {
              continue;
            }
            parsedChars = finalText.length;
            const events = parser.feed(finalText, chunk.done);

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

              if (ev.type === 'scene') {
                logger.info(
                  `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Scene ${ev.index + 1} finalized: ${ev.scene.originalScript.extract.length} chars (chunk #${chunkCount})`
                );
                sceneByIndex.set(ev.index, ev.scene);

                if (sequenceId) {
                  // Persist before emitting so cache invalidation from the
                  // realtime events cannot race ahead of the DB write (#1072).
                  const shot = await persistStreamedSceneAndShot(
                    scopedDb,
                    sequenceId,
                    ev.scene,
                    ev.index
                  );
                  shotByIndex.set(ev.index, {
                    id: shot.id,
                    frameId: shot.anchorFrameId,
                  });
                  shotMapping.push({
                    analysisSceneId: ev.scene.sceneId,
                    shotId: shot.id,
                    // Anchor frame id captured from the same write (no read-back).
                    frameId: shot.anchorFrameId,
                  });

                  await getGenerationChannel(sequenceId).emit(
                    'generation.scene:new',
                    {
                      sceneId: ev.scene.sceneId,
                      sceneNumber: ev.scene.sceneNumber,
                      title: ev.scene.metadata.title,
                      scriptExtract: ev.scene.originalScript.extract,
                      durationSeconds: ev.scene.metadata.durationSeconds,
                    }
                  );
                  await getGenerationChannel(sequenceId).emit(
                    'generation.shot:created',
                    {
                      shotId: shot.id,
                      sceneId: ev.scene.sceneId,
                      orderIndex: ev.index,
                    }
                  );
                  if (!previewTriggered.has(ev.index)) {
                    previewTriggered.add(ev.index);
                    await triggerPreviewImage({
                      input,
                      sequenceId,
                      parentInstanceId: event.instanceId,
                      shot: {
                        id: shot.id,
                        frameId: shot.anchorFrameId,
                      },
                      scene: ev.scene,
                      scopedDb,
                    });
                  }
                }
              }
            }
          }
          return { parsed, usage };
        };

        const firstPass = await runStreamingPass(messages, {
          withEvents: true,
        });
        const parsedResult = firstPass.parsed;

        if (!parsedResult) {
          throw new NonRetryableError(
            `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Stream ended without a validated structured-output payload. ` +
              `chunks=${chunkCount} chars=${finalText.length} ` +
              `streamedScenes=${shotMapping.length} model=${SCENE_SPLIT_MODEL}. ` +
              `Likely cause: provider did not honor responseFormat:json_schema.`
          );
        }

        // Post-stream boundary resolution. Reuse the parser's minted ids so
        // the final scene set matches the rows already written mid-stream.
        const mintedIds = parser.mintedSceneIds();
        const sceneIdFor = (index: number): string =>
          mintedIds.get(index) ?? generateId();
        let assembled = assembleScenes(script, parsedResult, sceneIdFor);
        let resolvedTitle = parsedResult.projectMetadata.title;
        let finalBoundaries = parsedResult.boundaries;
        let llmCostMicros = llmCostFromUsage(
          firstPass.usage,
          SCENE_SPLIT_MODEL
        );

        const degraded = isExcessivelyRepaired(
          assembled.resolution,
          parsedResult.boundaries.length
        );
        if (degraded && assembled.resolution.dropped.length > 0) {
          // One retry with explicit feedback about the quotes that failed to
          // anchor. Skip when every quote still resolved (fuzzy/normalized
          // repairs): the feedback list would be empty and a second 5–8 min
          // generation is what timed out #1218. A second degraded result
          // (or a retry with no payload) keeps these first-pass LLM scenes
          // — never a heuristic split.
          const failedQuotes = assembled.resolution.dropped
            .map((i) => parsedResult.boundaries[i]?.quote)
            .filter((q): q is string => typeof q === 'string');
          logger.warn(
            `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Boundary resolution degraded (dropped=${assembled.resolution.dropped.length} repairs=${assembled.resolution.repairs} of ${parsedResult.boundaries.length}); retrying with feedback`,
            { failedQuotes }
          );
          const retryPass = await runStreamingPass(
            [
              ...messages,
              { role: 'assistant', content: finalText },
              {
                role: 'user',
                content:
                  `Some of your boundary quotes could not be located verbatim in the script and were discarded:\n` +
                  failedQuotes.map((q) => `- ${JSON.stringify(q)}`).join('\n') +
                  `\n\nRe-emit the COMPLETE result. Every quote must be copied character-for-character from the script (no line-number gutter, no paraphrasing, no smart-quote substitution), in script order.`,
              },
            ],
            { withEvents: false }
          );
          if (retryPass.parsed) {
            llmCostMicros = addMicros(
              llmCostMicros,
              llmCostFromUsage(retryPass.usage, SCENE_SPLIT_MODEL)
            );
            const retryAssembled = assembleScenes(
              script,
              retryPass.parsed,
              sceneIdFor
            );
            if (
              !isExcessivelyRepaired(
                retryAssembled.resolution,
                retryPass.parsed.boundaries.length
              )
            ) {
              assembled = retryAssembled;
              resolvedTitle = retryPass.parsed.projectMetadata.title;
              finalBoundaries = retryPass.parsed.boundaries;
            } else {
              logger.warn(
                `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Retry still degraded; keeping first-pass LLM scenes`
              );
            }
          } else {
            logger.warn(
              `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Retry ended without a validated payload; keeping first-pass LLM scenes`
            );
          }
        } else if (degraded) {
          logger.warn(
            `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Boundary resolution used fuzzy/normalized repairs (repairs=${assembled.resolution.repairs} of ${parsedResult.boundaries.length}); keeping first-pass LLM scenes (no dropped quotes to retry)`
          );
        }

        await reportDroppedBoundaries(
          sequenceId,
          assembled.resolution,
          finalBoundaries
        );

        // Slices are adjacent substrings by construction — this assert is a
        // pure-logic invariant, not an LLM behaviour: a failure means a bug
        // in boundary-split, so fail loud rather than persist drifted text.
        if (assembled.slices.join('') !== script) {
          throw new NonRetryableError(
            `[SceneSplitWorkflow:cf] boundary slices do not reassemble the script (${assembled.slices.join('').length} vs ${script.length} chars)`,
            'WorkflowValidationError'
          );
        }
        const scenes = assembled.scenes;
        const offsets = assembled.resolution.offsets;

        // Advance the UI to the casting label once scene cards exist; the
        // parent still awaits both sibling steps before matching.
        if (sequenceId) {
          await getGenerationChannel(sequenceId).emit(
            'generation.phase:start',
            { phase: 2, phaseName: 'Casting characters & locations…' }
          );
        }

        // Preview sweep: any scene persisted without a trigger (e.g. a
        // replay that skipped the stream loop) still gets one.
        if (sequenceId) {
          for (const [index, shot] of shotByIndex) {
            if (previewTriggered.has(index)) continue;
            const scene = scenes[index] ?? sceneByIndex.get(index);
            if (!scene) continue;
            previewTriggered.add(index);
            await triggerPreviewImage({
              input,
              sequenceId,
              parentInstanceId: event.instanceId,
              shot,
              scene,
              scopedDb,
            });
          }
        }

        logger.info(
          `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Complete | ${chunkCount} chunks | ${scenes.length} scenes`
        );

        const streamResult: StreamResult = {
          scenes,
          title: resolvedTitle || 'Untitled',
          shotMapping,
          offsets,
          llmCostMicros,
          llmKeySource: llmKeyInfo.source,
        };
        return JSON.stringify(streamResult);
      }
    );

    const biblesStep = step.do(BIBLES_STEP_NAME, async (): Promise<string> => {
      const { messages } = await getChatPrompt(BIBLES_PROMPT_NAME, {
        script: gutteredScript,
        elements: elementsBlock,
      });
      const llmKeyInfo = await scopedDb.credentials.resolveLlmKey(modelId);

      logger.info(
        `[SceneSplitWorkflow:cf] [LLM:${BIBLES_LOG_NAME}] Starting call`,
        {
          model: modelId,
          keySource: llmKeyInfo.source,
          keyVia: llmKeyInfo.via,
          messageCount: messages.length,
        }
      );

      let parsed: SceneSplitBiblesResult | undefined;
      let usage: TokenUsage | undefined;
      for await (const chunk of callLLMStream<SceneSplitBiblesResult>({
        model: modelId,
        messages,
        max_tokens: biblesMaxTokens,
        responseSchema: sceneSplitBiblesResultSchema,
        apiKey: llmKeyInfo,
        reasoning: PROMPT_REASONING,
        observationName: BIBLES_LOG_NAME,
        tags: [BIBLES_STEP_NAME, `phase-${PHASE.number}`, 'analysis'],
        metadata: LOG_METADATA,
        userId: input.userId,
        sessionId: input.sequenceId,
      })) {
        if (chunk.done) {
          parsed = chunk.parsed;
          usage = chunk.usage;
        }
      }
      if (!parsed) {
        throw new NonRetryableError(
          `[SceneSplitWorkflow:cf] [LLM:${BIBLES_LOG_NAME}] Stream ended without a validated structured-output payload (model=${modelId})`
        );
      }

      logger.info(
        `[SceneSplitWorkflow:cf] [LLM:${BIBLES_LOG_NAME}] Complete | ${parsed.characterBible.length} characters | ${parsed.locationBible.length} locations | ${parsed.elementBible.length} elements`
      );

      const result: BiblesStepResult = {
        ...parsed,
        llmCostMicros: llmCostFromUsage(usage, modelId),
        llmKeySource: llmKeyInfo.source,
      };
      return JSON.stringify(result);
    });

    const [streamResultJson, biblesResultJson] = await Promise.all([
      scenesStep,
      biblesStep,
    ]);

    // Defensive shape check on replay — the data was Zod-validated once
    // inside the steps, but if CF's step-cache persisted something corrupt
    // we fail loud here instead of silently downstream.
    const streamResult: StreamResult = JSON.parse(streamResultJson);
    const biblesResult: BiblesStepResult = JSON.parse(biblesResultJson);
    if (
      !Array.isArray(streamResult.scenes) ||
      !Array.isArray(streamResult.shotMapping) ||
      !Array.isArray(biblesResult.characterBible)
    ) {
      throw new NonRetryableError(
        'scene-split steps returned a malformed result from cache',
        'WorkflowValidationError'
      );
    }

    // Join the two independent results (pure computation over cached step
    // outputs — deterministic on replay, so no step wrapper needed):
    // 1. Bible firstMentions get their owning scene id from the gutter line.
    const sceneIdForLine = (lineNumber: number): string =>
      streamResult.scenes[
        sceneIndexForLine(script, streamResult.offsets, lineNumber)
      ]?.sceneId ?? '';
    // sceneId first: downstream prompt interpolation serializes these entries
    // with JSON.stringify, and the aimock fixtures match on that text — keep
    // the key order the old single-call contract produced.
    const locationBible: LocationBibleEntry[] = biblesResult.locationBible.map(
      (entry) => ({
        ...entry,
        firstMention: {
          sceneId: sceneIdForLine(entry.firstMention.lineNumber),
          text: entry.firstMention.text,
          lineNumber: entry.firstMention.lineNumber,
        },
      })
    );
    const elementBible: ElementBibleEntry[] = biblesResult.elementBible.map(
      (entry) => ({
        ...entry,
        firstMention: {
          sceneId: sceneIdForLine(entry.firstMention.lineNumber),
          text: entry.firstMention.text,
          lineNumber: entry.firstMention.lineNumber,
        },
      })
    );
    // 2. Scene continuity tags from bibles ∩ verbatim slice (#1218).
    const { scenes: reconciledScenes, stats: tagStats } = reconcileSceneTags(
      streamResult.scenes,
      {
        characterBible: biblesResult.characterBible,
        locationBible,
        elementBible,
      }
    );
    if (
      tagStats.assignedCharacterTags +
        tagStats.assignedEnvironmentTags +
        tagStats.assignedElementTags >
      0
    ) {
      logger.info('[SceneSplitWorkflow:cf] Scene↔bible tag assign', {
        sequenceId,
        ...tagStats,
      });
    }

    // Step 3: Reconcile — ensure all shots exist (handles cached step replay).
    const reconcileJson = await step.do(
      'reconcile-shots',
      async (): Promise<string> => {
        const scenes = reconciledScenes;
        const resolvedTitle = streamResult.title || 'Untitled';

        if (!sequenceId) {
          return JSON.stringify({
            scenes,
            title: resolvedTitle,
            shotMapping: streamResult.shotMapping,
            characterBible: biblesResult.characterBible,
            locationBible,
            elementBible,
          } satisfies SceneSplitWorkflowResult);
        }

        // Bulk upsert scenes first, then shots with sceneId links. Shots'
        // onConflictDoUpdate overwrites sceneId from the insert payload —
        // omitting it here would null out the stream-time links (#1072).
        const sceneRows = [];
        for (let index = 0; index < scenes.length; index++) {
          const scene = scenes[index];
          if (!scene) continue;
          sceneRows.push(
            await scopedDb.scenes.upsert(
              buildSceneInsert(sequenceId, scene, index)
            )
          );
        }
        const sceneIdByOrderIndex = new Map(
          sceneRows.map((row) => [row.orderIndex, row.id])
        );

        const shotInserts = scenes.map(
          (scene, index) =>
            ({
              sequenceId,
              durationMs: Math.round(
                (scene.metadata.durationSeconds || 3) * 1000
              ),
              sceneId: sceneIdByOrderIndex.get(index) ?? null,
              shotNumber: 1,
            }) satisfies NewShot
        );

        // Correlate on the row's OWN scene link, never on array position:
        // `bulkUpsert` builds its result from each chunk's `RETURNING`, whose
        // row order SQLite does not guarantee (and `ON CONFLICT DO UPDATE`
        // makes divergence likelier). A positional map would silently pair each
        // shot with a neighbouring scene's script and prompts.
        const analysisSceneIdByDbSceneId = new Map<string, string>();
        for (const [index, scene] of scenes.entries()) {
          const dbId = sceneIdByOrderIndex.get(index);
          if (dbId) analysisSceneIdByDbSceneId.set(dbId, scene.sceneId);
        }

        const reconciledShots = await scopedDb.shots.bulkUpsert(shotInserts);
        const reconciledMapping = reconciledShots.map((f) => {
          const analysisSceneId = f.sceneId
            ? analysisSceneIdByDbSceneId.get(dbSceneId(f.sceneId))
            : undefined;
          if (!analysisSceneId) {
            // The shot came back without a resolvable scene link, so nothing
            // downstream could address it. Fail loudly rather than emit a
            // blank id that silently drops the shot from every later step.
            throw new WorkflowValidationError(
              `Shot ${f.id} has no resolvable analysis scene after reconcile (sceneId: ${f.sceneId ?? 'null'})`
            );
          }
          return {
            analysisSceneId,
            shotId: f.id,
            // Anchor frame id captured from the same bulkUpsert write — the batch
            // prompt workflow reads it from here instead of querying the DB (#991).
            frameId: f.anchorFrameId,
          };
        });

        // Ensure title and workflow are set (status stays 'processing'
        // until storyboard-workflow completes all phases).
        await scopedDb.sequences.updateTitle(sequenceId, resolvedTitle);
        await scopedDb.sequences.updateWorkflow(
          sequenceId,
          'analyze-script-shorter-prompts-batch-size-1'
        );

        // Emit shot:created for any shots the streaming step didn't cover.
        const streamedSceneIds = new Set(
          streamResult.shotMapping.map((f) => f.analysisSceneId)
        );
        for (const { analysisSceneId: sId, shotId } of reconciledMapping) {
          if (!streamedSceneIds.has(sId)) {
            const scene = scenes.find((s) => s.sceneId === sId);
            await getGenerationChannel(sequenceId).emit(
              'generation.shot:created',
              {
                shotId,
                sceneId: sId,
                orderIndex: scene?.sceneNumber ? scene.sceneNumber - 1 : 0,
              }
            );
          }
        }

        return JSON.stringify({
          scenes,
          title: resolvedTitle,
          shotMapping: reconciledMapping,
          characterBible: biblesResult.characterBible,
          locationBible,
          elementBible,
        } satisfies SceneSplitWorkflowResult);
      }
    );
    const reconciled: SceneSplitWorkflowResult = JSON.parse(reconcileJson);
    if (
      !Array.isArray(reconciled.scenes) ||
      !Array.isArray(reconciled.shotMapping)
    ) {
      throw new NonRetryableError(
        'reconcile-shots returned a malformed result from cache',
        'WorkflowValidationError'
      );
    }

    // Step 4: Reconcile element bible → update firstMention on existing rows.
    // Addressed by the element ids snapshotted in the payload, not by a live
    // token lookup: tokens are user-renameable mid-run, so a re-read could
    // resolve the same token to a different row (or miss a renamed one).
    if (sequenceId && reconciled.elementBible.length > 0) {
      const elementIdByToken = new Map(elements.map((el) => [el.token, el.id]));
      await step.do('reconcile-element-bible', async () => {
        for (const entry of reconciled.elementBible) {
          const elementId = elementIdByToken.get(entry.token);
          // Absent id = the element was deleted (or the LLM invented a token).
          if (!elementId) continue;
          await scopedDb.sequenceElements.updateFirstMention(elementId, {
            sceneId: entry.firstMention.sceneId,
            text: entry.firstMention.text,
            lineNumber: entry.firstMention.lineNumber,
          });
        }
      });
    }

    // Step 4b (#908 / #1072): authoritative upsert of `scenes` rows + shot
    // links after reconcile. Streaming and reconcile already wrote 1:1 rows;
    // this step re-upserts the final set (stable ids via orderIndex), re-links
    // shots, seeds scene_script_versions, and trims orphan tail rows if a
    // re-analyze produced fewer scenes.
    //
    // Do NOT delete-then-recreate: `shots.scene_id` is a bare
    // `REFERENCES scenes(id)` in the migration (no ON DELETE SET NULL), so
    // deleting stream-linked scenes fails with DrizzleQueryError (#1072).
    if (sequenceId && reconciled.scenes.length > 0) {
      await step.do('persist-scenes', async () => {
        const sceneRows = [];
        const scriptSeeds = [];
        for (let index = 0; index < reconciled.scenes.length; index++) {
          const scene = reconciled.scenes[index];
          if (!scene) continue;
          const sceneRow = await scopedDb.scenes.upsert(
            buildSceneInsert(sequenceId, scene, index)
          );
          sceneRows.push(sceneRow);
          scriptSeeds.push({
            sceneId: sceneRow.id,
            content: scene.originalScript,
            createdAt: sceneRow.createdAt,
          });
        }

        // Link each shot to its scene row by analysisSceneId → orderIndex →
        // row (see buildSceneShotLinks — keyed on the unique orderIndex, not
        // array position). A shot whose scene is missing is surfaced, not
        // silently skipped: every mapped shot should belong to a scene.
        const { links, unmappedShotIds } = buildSceneShotLinks(
          reconciled.scenes,
          sceneRows,
          reconciled.shotMapping
        );
        const missingShotIds: string[] = [];
        for (const { shotId, sceneId, shotNumber } of links) {
          const updated = await scopedDb.shots.update(
            shotId,
            { sceneId, shotNumber },
            { throwOnMissing: false }
          );
          if (!updated) missingShotIds.push(shotId);
        }
        if (missingShotIds.length > 0) {
          logger.warn(
            `[SceneSplitWorkflow:cf] persist-scenes: ${missingShotIds.length} shot(s) missing at link time`,
            { sequenceId, missingShotIds }
          );
        }

        // Two disjoint sets of shots have to go, and neither is found by
        // listing the sequence — a live listing also returns rows a concurrent
        // run just created, and would delete them. First: shots THIS run
        // mapped but could not place on any scene row.
        if (unmappedShotIds.length > 0) {
          logger.warn(
            `[SceneSplitWorkflow:cf] persist-scenes: deleting ${unmappedShotIds.length} shot(s) with no matching scene row`,
            { sequenceId, unmappedShotIds }
          );
          for (const shotId of unmappedShotIds) {
            await scopedDb.shots.delete(shotId);
          }
        }
        // Second, the re-analyze edge — fewer scenes than last run. A shot
        // whose scene is about to go has nothing left to belong to (order,
        // script and prompt context all resolve through the scene), so it goes
        // too; detaching it instead left a row that every read fetched and no
        // view rendered. The scenes FK is RESTRICT, so shots go first.
        await scopedDb.shots.deleteByScenesFromOrderIndex(
          sequenceId,
          reconciled.scenes.length
        );
        await scopedDb.scenes.deleteFromOrderIndex(
          sequenceId,
          reconciled.scenes.length
        );

        await scopedDb.sceneScriptVersions.seedSplitVersions(scriptSeeds);
      });
    }

    // Step 5: Deduct credits — one deduction per LLM call.
    await step.do('deduct-llm-credits-scene-splitting', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: streamResult.llmCostMicros,
        usedOwnKey: streamResult.llmKeySource === 'team',
        description: `LLM analysis (${SCENE_SPLIT_MODEL})`,
        idempotencyKey: `${event.instanceId}:llm-${STEP_NAME}`,
        reservationId: input.reservationId,
        metadata: {
          model: SCENE_SPLIT_MODEL,
          phase: PHASE.number,
          phaseName: PHASE.name,
          stepName: STEP_NAME,
          sequenceId,
          costMicros: streamResult.llmCostMicros,
        },
      });
    });
    await step.do('deduct-llm-credits-scene-bibles', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: biblesResult.llmCostMicros,
        usedOwnKey: biblesResult.llmKeySource === 'team',
        description: `LLM analysis (${modelId})`,
        idempotencyKey: `${event.instanceId}:llm-${BIBLES_STEP_NAME}`,
        reservationId: input.reservationId,
        metadata: {
          model: modelId,
          phase: PHASE.number,
          phaseName: PHASE.name,
          stepName: BIBLES_STEP_NAME,
          sequenceId,
          costMicros: biblesResult.llmCostMicros,
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
    scopedDb: WorkflowScopedDb;
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
