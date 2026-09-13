/**
 * Scene-split workflow (#1035: boundary annotation, several small LLM calls).
 *
 * The old single mega-call (scenes + bibles in one 8.2KB schema) exceeded
 * Anthropic's native strict-output grammar budget and re-emitted the entire
 * script through the LLM. It is replaced by three calls over the same script:
 * two concurrent siblings (scenes, bibles), then the shot list after the join:
 *
 *   - `scene-splitting-stream` — the scenes call. A boundary-annotation
 *     contract: the LLM returns `{ hintLine, quote }` anchors against a
 *     line-gutter copy of the script (no per-scene metadata). The ORIGINAL
 *     script is sliced locally (`boundary-split.ts`); title/location/
 *     duration come from each slice (`scene-from-slice.ts`), plus a regex
 *     dialogue preview the shot-list call replaces. Scene ids/numbers are
 *     minted server-side. Streaming: boundary k+1 arriving
 *     finalizes scene k via a local slice, so scene cards appear with real
 *     script text in seconds.
 *   - `scene-bibles` — character/location/element bibles.
 *   - `scene-shot-list-N` — after slices exist, structured calls cover
 *     each scene with 1..N setups (`shotListPassResultSchema`), directed by
 *     the snapshotted style, and place every spoken line in the shot it is
 *     spoken in (#1585), speakers named from the character bible. The regex
 *     parser in `scene-from-slice.ts` only sees screenplay cues, so this
 *     REPLACES `originalScript.dialogue`. The scenes go out in batches of
 *     `SHOT_LIST_BATCH_SCENES`, one concurrent step each, so a feature-length
 *     paste never puts one call's output at the token cap. Inside a call the
 *     response streams: as soon as a scene's entry has settled its shots are
 *     allocated, written, announced (`generation.shot:created`) and each
 *     shot's preview fired — the rail fills scene by scene, not all at the end.
 *     Fails the run like the bibles call, and also when a batch omits a scene
 *     (`attachShotLists`): a one-shot fallback would silently leave that
 *     scene on the regex preview, which is empty for prose. Each scene's
 *     shots divide ITS label (#1593): the slice's `Shot N — Xs` labels fix
 *     count and durations when present, otherwise the label is spread over
 *     the shots on the video model's grid. No film-wide target enters the run.
 *
 * After the join, scene continuity tags are assigned from bibles ∩ slice
 * (`tag-reconcile.ts`) and bible `firstMention`s get their owning scene id
 * derived from the gutter line.
 *
 * No placeholder shot (#1593): the stream persists scene rows only, and a
 * scene has zero shots until its shot-list entry lands. `persist-scenes`
 * re-upserts the final set afterwards; `reconcile-shots` only stamps the
 * title / workflow and assembles the result.
 *
 * Excessive *drops* trigger one retry with feedback; a second degraded
 * result keeps the first-pass LLM scenes (verbatim slices + metadata).
 * Fuzzy/normalized repairs that still produce a full partition are kept
 * without a second LLM call — #1218 timed out three times retrying 14
 * locally-repaired quotes with empty feedback. Dropped boundaries are
 * always logged and emitted as a non-fatal `generation.error`.
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
} from '@/models/server/llm-client';
import { PREVIEW_IMAGE_MODEL } from '@/models/models';
import { getMaxOutputTokens, SCENE_SPLIT_MODEL } from '@/models/models.config';
import {
  type SceneSplitBiblesResult,
  type SceneSplitScenesResult,
  sceneSplitBiblesResultSchema,
  sceneSplitScenesResultSchema,
} from '@/sequences/response-schemas';
import {
  attachSceneShots,
  attachShotLists,
  buildShotInserts,
  formatCastForShotList,
  formatDirectorStyleForShotList,
  formatScenesForShotListPrompt,
} from '@/shots/shot-list-pass';
import {
  shotListPassResultSchema,
  shotListPassSceneSchema,
} from '@/shots/shot-list.schema';
import {
  addLineGutter,
  isExcessivelyRepaired,
  sceneIndexForLine,
  type ResolvedBoundaries,
} from '@/sequences/boundary-split';
import {
  assembleScenes,
  createStreamingSceneParser,
  isRecord,
  type SceneSplittingScene,
  settledPrefix,
  stripCodeFences,
} from '@/sequences/server/streaming-scene-parser';
import { reconcileSceneTags } from '@/sequences/tag-reconcile';
import type {
  ElementBibleEntry,
  LocationBibleEntry,
} from '@/shots/scene-analysis.schema';
import { addMicros, type Microdollars, ZERO_MICROS } from '@/billing/money';
import { parsePartialJSON, type TokenUsage } from '@tanstack/ai';
import { deductWorkflowCredits } from '@/billing/server/workflow-deduction';
import {
  buildSceneInsert,
  buildSceneShotLinks,
} from '@/sequences/server/scene-persistence';
import { aspectRatioToImageSize } from '@/models/aspect-ratios';
import { generateId } from '@/platform/id';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { durationGridForModel } from '@/motion/snap-duration';
import {
  getChatPrompt,
  type ChatMessage,
} from '@/platform/server/ai/prompts-index';
import { buildPreviewPrompt } from '@/sequences/server/poster-prompt';
import { getGenerationChannel } from '@/platform/realtime';
import { previewImageDedupId } from '@/platform/server/workflow/dedup-ids';
import { OpenStoryWorkflowEntrypoint } from '@/platform/server/workflow/base-workflow';
import { triggerWorkflow } from '@/platform/server/workflow/client';
import { handleLlmAuthFailure } from '@/platform/server/workflow/llm-auth-failure';
import { sanitizeFailResponse } from '@/platform/server/workflow/sanitize-fail-response';
import type {
  ImageWorkflowInput,
  SceneSplitWorkflowInput,
  SceneSplitWorkflowResult,
} from '@/platform/server/workflow/types';
import type {
  WorkflowEvent,
  WorkflowStep,
  WorkflowStepConfig,
} from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { z } from 'zod';
import { getLogger } from '@/platform/logger';

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

const SHOT_LIST_STEP_NAME = 'scene-shot-list';
const SHOT_LIST_PROMPT_NAME = 'phase/scene-shot-list-chat';
const SHOT_LIST_LOG_NAME = `phase-${PHASE.number}-${SHOT_LIST_STEP_NAME}`;
/**
 * Scenes per shot-list call. Small enough that a talky batch's output sits
 * well under the model's cap; big enough that the recorded e2e script (4
 * scenes) is one call with an unchanged prompt. Batches run concurrently.
 */
const SHOT_LIST_BATCH_SCENES = 8;

/**
 * Persist one analysis scene as a `scenes` row as soon as the stream emits
 * it, so the Scenes spine (#986) grows scene groups live. No shot row (#1593):
 * the rail shows the scene as "listing shots…" until that scene's shot-list
 * entry lands (`persistSceneShots`) — a placeholder shot 1 carried the scene
 * label as its duration and had to be overwritten from the spec.
 */
async function persistStreamedScene(
  scopedDb: WorkflowScopedDb,
  sequenceId: string,
  scene: SceneSplittingScene,
  orderIndex: number
): Promise<void> {
  const sceneRow = await scopedDb.scenes.upsert(
    buildSceneInsert(sequenceId, scene, orderIndex)
  );
  // Seed the split script version as soon as the scene lands so composed
  // script / the Scenes script view have text mid-stream. Idempotent: the
  // final persist-scenes step re-seeds without duplicating, then overwrites
  // the content with the shot-list call's dialogue (#1585).
  await scopedDb.sceneScriptVersions.seedSplitVersions([
    {
      sceneId: sceneRow.id,
      content: scene.originalScript,
      createdAt: sceneRow.createdAt,
    },
  ]);
}

/**
 * Animatic text for a shot's preview: its spec (framing + action) when the
 * scene has 2+ shots, else the scene's verbatim slice (or title). The
 * recorded e2e fixtures are keyed on this text.
 */
function previewTextForShot(
  scene: SceneSplittingScene,
  shotNumber: number
): string {
  const spec = scene.shots?.find((shot) => shot.shotNumber === shotNumber);
  if (spec && (scene.shots?.length ?? 1) > 1) {
    const parts = [
      spec.framing.shotSize,
      spec.framing.angle,
      spec.framing.subjectStartState,
      spec.action,
    ]
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length > 0) return parts.join('. ');
  }
  return (
    scene.originalScript.extract || scene.metadata.title || 'A cinematic scene'
  );
}

/**
 * Fire-and-forget preview image for one shot. Failures are swallowed by
 * design (#1149): a throw here fails the shot-list batch step, and with it
 * the whole sequence, discarding every still that already rendered and cost
 * money. A content-checker hit on one of ~18 previews is a routine outcome,
 * not a reason to lose the run. The child still reports failure (see
 * ImageWorkflow.onFailure skipStorage emit).
 *
 * `skipStorage: true` names the preview path (no prompt version, no status
 * flip); the image workflow still copies bytes into R2. The deduplicationId
 * makes a replay of the batch step idempotent (see dedup-ids.ts).
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
  shot: { id: string; frameId: string; shotNumber: number };
  scene: SceneSplittingScene;
  scopedDb: WorkflowScopedDb;
}): Promise<void> {
  const sceneText = previewTextForShot(scene, shot.shotNumber);

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
 * for bible `firstMention` lines).
 */
type StreamResult = {
  scenes: SceneSplittingScene[];
  title: string;
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

type LlmStepBilling = {
  llmCostMicros: Microdollars;
  llmKeySource: 'team' | 'platform';
};

/** Shape produced by the bibles step (post JSON round-trip). */
type BiblesStepResult = SceneSplitBiblesResult & LlmStepBilling;

/** Shape produced by one shot-list batch step (post JSON round-trip). */
type ShotListStepResult = {
  /** The batch's scenes with their shots attached, in order. */
  scenes: SceneSplittingScene[];
  shotMapping: SceneSplitWorkflowResult['shotMapping'];
} & LlmStepBilling;

/**
 * One structured call consumed to completion, shared by the bibles and
 * shot-list steps: the stream is drained for its final validated payload.
 * `onAccumulated`, when given, sees the accumulated text at most once per
 * PARSE_COALESCE_CHARS and once more at the end, so a caller can act on
 * entries that have already settled (the shot list writes them). Same model,
 * same failure mode: no validated payload = the step fails; nothing falls
 * back to a local guess.
 */
async function runStructuredCall<T extends object>({
  input,
  scopedDb,
  stepName,
  logName = `phase-${PHASE.number}-${stepName}`,
  promptName,
  promptVars,
  responseSchema,
  maxTokens,
  onAccumulated,
}: {
  input: SceneSplitWorkflowInput;
  scopedDb: WorkflowScopedDb;
  stepName: string;
  logName?: string;
  promptName: string;
  promptVars: Record<string, string>;
  responseSchema: z.ZodType<T>;
  maxTokens: number;
  onAccumulated?: (accumulated: string, done: boolean) => Promise<void>;
}): Promise<T & LlmStepBilling> {
  const { modelId } = input;
  const { messages } = await getChatPrompt(promptName, promptVars);
  const llmKeyInfo = await scopedDb.credentials.resolveLlmKey(modelId);

  logger.info(`[SceneSplitWorkflow:cf] [LLM:${logName}] Starting call`, {
    model: modelId,
    keySource: llmKeyInfo.source,
    keyVia: llmKeyInfo.via,
    messageCount: messages.length,
  });

  let parsed: T | undefined;
  let usage: TokenUsage | undefined;
  let accumulatedLength = 0;
  let parsedChars = 0;
  for await (const chunk of callLLMStream<T>({
    model: modelId,
    messages,
    max_tokens: maxTokens,
    responseSchema,
    apiKey: llmKeyInfo,
    reasoning: PROMPT_REASONING,
    observationName: logName,
    tags: [stepName, `phase-${PHASE.number}`, 'analysis'],
    metadata: LOG_METADATA,
    userId: input.userId,
    sessionId: input.sequenceId,
  })) {
    accumulatedLength = chunk.accumulated.length;
    if (chunk.done) {
      parsed = chunk.parsed;
      usage = chunk.usage;
    }
    if (
      onAccumulated &&
      (chunk.done || accumulatedLength - parsedChars >= PARSE_COALESCE_CHARS)
    ) {
      parsedChars = accumulatedLength;
      await onAccumulated(chunk.accumulated, chunk.done);
    }
  }
  if (!parsed) {
    // Truncation at the token cap and a provider dropping the stream end the
    // same way (no validated payload); the numbers tell them apart.
    const completionTokens = usage?.completionTokens;
    const atCap =
      completionTokens !== undefined && completionTokens >= maxTokens;
    logger.error(
      `[SceneSplitWorkflow:cf] [LLM:${logName}] Stream ended without a validated structured-output payload`,
      { model: modelId, maxTokens, completionTokens, accumulatedLength, atCap }
    );
    throw new NonRetryableError(
      `[SceneSplitWorkflow:cf] [LLM:${logName}] Stream ended without a validated structured-output payload (model=${modelId}${atCap ? ', output hit the token cap' : ''})`
    );
  }
  return {
    ...parsed,
    llmCostMicros: llmCostFromUsage(usage, modelId, llmKeyInfo.via),
    llmKeySource: llmKeyInfo.source,
  };
}

/**
 * Write one scene's allocated shots and announce them (#1593): upsert the
 * scene row (stable id via orderIndex — the stream wrote it, a boundary
 * retry may not have), upsert its shots on `(sceneId, shotNumber)`, trim
 * shots past the kept count, emit `generation.shot:created` per shot and
 * fire each shot's preview (deduplicated per instance + shot, so a step
 * replay is idempotent). Returns the scene's shot mapping.
 */
async function persistSceneShots({
  input,
  scopedDb,
  sequenceId,
  parentInstanceId,
  scene,
  orderIndex,
  announcedShotIds,
}: {
  input: SceneSplitWorkflowInput;
  scopedDb: WorkflowScopedDb;
  sequenceId: string;
  parentInstanceId: string;
  scene: SceneSplittingScene;
  orderIndex: number;
  announcedShotIds?: ReadonlySet<string>;
}): Promise<SceneSplitWorkflowResult['shotMapping']> {
  const sceneRow = await scopedDb.scenes.upsert(
    buildSceneInsert(sequenceId, scene, orderIndex)
  );
  const inserts = buildShotInserts(
    sequenceId,
    [scene],
    new Map([[0, sceneRow.id]])
  );
  // `RETURNING` order is not guaranteed; every row here is this scene's, so
  // only the shot number matters.
  const rows = (await scopedDb.shots.bulkUpsert(inserts)).sort(
    (a, b) => (a.shotNumber ?? 1) - (b.shotNumber ?? 1)
  );
  await scopedDb.shots.deleteFromShotNumber(sceneRow.id, inserts.length + 1);
  for (const row of rows) {
    const alreadyAnnounced = announcedShotIds?.has(row.id) === true;
    if (!alreadyAnnounced) {
      await getGenerationChannel(sequenceId).emit('generation.shot:created', {
        shotId: row.id,
        sceneId: scene.sceneId,
        orderIndex,
      });
    }
    if (!row.anchorFrameId || alreadyAnnounced) continue;
    await triggerPreviewImage({
      input,
      sequenceId,
      parentInstanceId,
      shot: {
        id: row.id,
        frameId: row.anchorFrameId,
        shotNumber: row.shotNumber ?? 1,
      },
      scene,
      scopedDb,
    });
  }
  return rows.map((row) => ({
    analysisSceneId: scene.sceneId,
    shotId: row.id,
    // Anchor frame id captured from the same upsert — the batch prompt
    // workflow reads it from here instead of querying the DB (#991).
    frameId: row.anchorFrameId,
    shotNumber: row.shotNumber ?? 1,
  }));
}

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
              // vision genuinely failed for this row — or, for a clip or an
              // audio element (#1559), that nobody described it: those never
              // run vision, and what they ARE is the user's to say.
              const kind = el.kind ?? 'image';
              const fallback =
                kind === 'image'
                  ? ' (no visual reference available)'
                  : ` (${kind} reference, not described)`;
              const desc = el.description ? `: ${el.description}` : fallback;
              const media = kind === 'image' ? '' : ` [${kind}]`;
              return `- ${el.token}${media}${desc}`;
            })
            .join('\n')
        : '(none)';
    // Both script calls see the same numbered-gutter copy: scenes report
    // hintLine, bibles firstMention.lineNumber against it.
    const gutteredScript = addLineGutter(script);
    const splitMaxTokens = getMaxOutputTokens(SCENE_SPLIT_MODEL, 0.65);
    const biblesMaxTokens = getMaxOutputTokens(modelId, 0.65);
    // The shot list re-emits every spoken line verbatim (#1585), so on a
    // talky script it is the longest output of the phase; give it the
    // model's full ceiling.
    const shotListMaxTokens = getMaxOutputTokens(modelId, 1);

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
        let streamedScenes = 0;
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
                `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] chunk #${chunkCount} | ${finalText.length} chars | ${streamedScenes} scenes so far`
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
                streamedScenes++;

                if (sequenceId) {
                  // Persist before emitting so cache invalidation from the
                  // realtime events cannot race ahead of the DB write (#1072).
                  await persistStreamedScene(
                    scopedDb,
                    sequenceId,
                    ev.scene,
                    ev.index
                  );

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
              `streamedScenes=${streamedScenes} model=${SCENE_SPLIT_MODEL}. ` +
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
          SCENE_SPLIT_MODEL,
          llmKeyInfo.via
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
              llmCostFromUsage(
                retryPass.usage,
                SCENE_SPLIT_MODEL,
                llmKeyInfo.via
              )
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

        logger.info(
          `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Complete | ${chunkCount} chunks | ${scenes.length} scenes`
        );

        const streamResult: StreamResult = {
          scenes,
          title: resolvedTitle || 'Untitled',
          offsets,
          llmCostMicros,
          llmKeySource: llmKeyInfo.source,
        };
        return JSON.stringify(streamResult);
      }
    );

    const biblesStep = step.do(BIBLES_STEP_NAME, async (): Promise<string> => {
      const result = await runStructuredCall({
        input,
        scopedDb,
        stepName: BIBLES_STEP_NAME,
        promptName: BIBLES_PROMPT_NAME,
        promptVars: { script: gutteredScript, elements: elementsBlock },
        responseSchema: sceneSplitBiblesResultSchema,
        maxTokens: biblesMaxTokens,
      });
      logger.info(
        `[SceneSplitWorkflow:cf] [LLM:${BIBLES_LOG_NAME}] Complete | ${result.characterBible.length} characters | ${result.locationBible.length} locations | ${result.elementBible.length} elements`
      );
      return JSON.stringify(result satisfies BiblesStepResult);
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

    // Step 2b (#1486 / #1585): 1..N shots inside each resolved scene slice,
    // each carrying the lines spoken in it, speakers named from the bible.
    // The grid caps each scene's shot count and divides its label (#1593).
    const clipGrid = input.videoModel
      ? durationGridForModel(input.videoModel)
      : [];
    const batchStarts: number[] = [];
    for (let i = 0; i < reconciledScenes.length; i += SHOT_LIST_BATCH_SCENES) {
      batchStarts.push(i);
    }
    const batchSteps = await Promise.all(
      batchStarts.map((start, batchIndex) =>
        step.do(
          `${SHOT_LIST_STEP_NAME}-${batchIndex + 1}`,
          async (): Promise<string> => {
            const batch = reconciledScenes.slice(
              start,
              start + SHOT_LIST_BATCH_SCENES
            );
            const attached = new Map<number, SceneSplittingScene>();
            const shotMapping: SceneSplitWorkflowResult['shotMapping'] = [];
            // A scene's entry has settled (a later entry started, or the
            // stream ended): allocate, write, announce, preview — now, not
            // after the whole batch. Matched on sceneNumber only; an entry
            // that names no scene of this batch waits for the final
            // positional match in `attachShotLists`.
            const landScene = async (
              scene: SceneSplittingScene,
              orderIndex: number,
              opts?: { overwrite?: boolean }
            ): Promise<void> => {
              const already = attached.has(scene.sceneNumber);
              if (already && !opts?.overwrite) return;
              const previous = shotMapping.filter(
                (entry) => entry.analysisSceneId === scene.sceneId
              );
              attached.set(scene.sceneNumber, scene);
              if (!sequenceId) return;
              const mapping = await persistSceneShots({
                input,
                scopedDb,
                sequenceId,
                parentInstanceId: event.instanceId,
                scene,
                orderIndex,
                announcedShotIds: new Set(
                  previous.map((entry) => entry.shotId)
                ),
              });
              const kept = shotMapping.filter(
                (entry) => entry.analysisSceneId !== scene.sceneId
              );
              shotMapping.length = 0;
              shotMapping.push(...kept, ...mapping);
            };
            const result = await runStructuredCall({
              input,
              scopedDb,
              stepName: SHOT_LIST_STEP_NAME,
              logName: SHOT_LIST_LOG_NAME,
              promptName: SHOT_LIST_PROMPT_NAME,
              promptVars: {
                scenes: formatScenesForShotListPrompt(batch, clipGrid),
                style: formatDirectorStyleForShotList(input.styleConfig),
                characters: formatCastForShotList(biblesResult.characterBible),
              },
              responseSchema: shotListPassResultSchema,
              maxTokens: shotListMaxTokens,
              onAccumulated: async (accumulated, done) => {
                // The done chunk is the validated payload's job: a complete
                // last object would otherwise persist twice, and a truncated
                // last object must not stick.
                if (done) return;
                const raw = parsePartialJSON(stripCodeFences(accumulated));
                if (!isRecord(raw)) return;
                for (const entry of settledPrefix(
                  raw.scenes,
                  shotListPassSceneSchema,
                  done
                )) {
                  const index = batch.findIndex(
                    (scene) => scene.sceneNumber === entry.sceneNumber
                  );
                  const scene = batch[index];
                  if (!scene || attached.has(scene.sceneNumber)) continue;
                  await landScene(
                    attachSceneShots(scene, entry.shots, clipGrid),
                    start + index
                  );
                }
              },
            });
            // The validated payload is the authority: it throws on an omitted
            // scene, lands anything the stream did not, and overwrites a
            // streamed prefix so a half-spec cannot stick.
            const final = attachShotLists(batch, result, clipGrid);
            for (const [index, scene] of final.entries()) {
              await landScene(scene, start + index, { overwrite: true });
            }
            const scenes = final;
            const shots = scenes.flatMap((scene) => scene.shots ?? []);
            logger.info(
              `[SceneSplitWorkflow:cf] [LLM:${SHOT_LIST_LOG_NAME}] Batch ${batchIndex + 1}/${batchStarts.length} complete | ${scenes.length} scenes | ${shots.length} shots | ${shots.reduce((n, shot) => n + shot.dialogue.length, 0)} dialogue lines`
            );
            return JSON.stringify({
              scenes,
              shotMapping,
              llmCostMicros: result.llmCostMicros,
              llmKeySource: result.llmKeySource,
            } satisfies ShotListStepResult);
          }
        )
      )
    );
    const shotListBatches: ShotListStepResult[] = batchSteps.map((json) =>
      JSON.parse(json)
    );
    if (
      shotListBatches.some(
        (batch) =>
          !Array.isArray(batch.scenes) || !Array.isArray(batch.shotMapping)
      )
    ) {
      throw new NonRetryableError(
        'scene-shot-list returned a malformed result from cache',
        'WorkflowValidationError'
      );
    }
    const scenesWithShots = shotListBatches.flatMap((batch) => batch.scenes);
    const shotListStep: LlmStepBilling = {
      llmCostMicros: shotListBatches.reduce(
        (sum, batch) => addMicros(sum, batch.llmCostMicros),
        ZERO_MICROS
      ),
      llmKeySource: shotListBatches[0]?.llmKeySource ?? 'platform',
    };

    // Step 3: title + workflow stamp, and the result the parent reads. The
    // shot rows are already written and announced by the batch steps.
    const reconcileJson = await step.do(
      'reconcile-shots',
      async (): Promise<string> => {
        const resolvedTitle = streamResult.title || 'Untitled';
        if (sequenceId) {
          // Status stays 'processing' until storyboard-workflow completes
          // all phases.
          await scopedDb.sequences.updateTitle(sequenceId, resolvedTitle);
          await scopedDb.sequences.updateWorkflow(
            sequenceId,
            'analyze-script-shorter-prompts-batch-size-1'
          );
        }
        return JSON.stringify({
          scenes: scenesWithShots,
          title: resolvedTitle,
          shotMapping: shotListBatches.flatMap((batch) => batch.shotMapping),
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

    // Step 4b (#908 / #1072 / #1486): authoritative upsert of `scenes` rows +
    // shot links. Streaming wrote the scene rows; the shot-list batches
    // already upserted shots 1..N. This step re-upserts the final scene set
    // + shot links (stable ids via orderIndex), seeds scene_script_versions,
    // and trims orphan tail rows if a re-analyze produced fewer scenes.
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
        // The stream seeded each split version with the regex dialogue
        // preview; the shot-list call's lines (#1585) are what has to land
        // in the row.
        await scopedDb.sceneScriptVersions.updateSplitContent(scriptSeeds);
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
    await step.do('deduct-llm-credits-scene-shot-list', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: shotListStep.llmCostMicros,
        usedOwnKey: shotListStep.llmKeySource === 'team',
        description: `LLM analysis (${modelId})`,
        idempotencyKey: `${event.instanceId}:llm-${SHOT_LIST_STEP_NAME}`,
        reservationId: input.reservationId,
        metadata: {
          model: modelId,
          phase: PHASE.number,
          phaseName: PHASE.name,
          stepName: SHOT_LIST_STEP_NAME,
          sequenceId,
          costMicros: shotListStep.llmCostMicros,
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
