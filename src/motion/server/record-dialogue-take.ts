/**
 * Record one scene's dialogue as a SINGLE take and cut each shot's clip out
 * of it (#1657).
 *
 * Why one take per scene and not one per shot: Text to Dialogue acts the
 * turns it is given against each other. Recording each shot alone makes
 * every clip a cold read — the reply to a line the model never heard. So the
 * scene is recorded whole and sliced at the provider's own per-turn voice
 * segments. Each shot still ends up with exactly what it had before (one
 * `MotionAudioClip` on `shots.audioClips`, keyed by its AUTHORED lines), so
 * nothing downstream of the clip changes.
 *
 * Three things this file is careful about:
 *
 *  - **Bytes never cross a step.** A chunk is recorded and parked in R2
 *    inside its own step; the assemble step reads the chunks back by key,
 *    joins them, slices, and uploads. Only `{ url, durationSeconds, … }`
 *    records ride the Workflows checkpoint (#1645, 1 MiB).
 *  - **The fit ladder is per SHOT, the recording is per SCENE** (#1651). A
 *    slice over its shot's limit sends THAT shot's turns to the rewrite, and
 *    the whole scene is then re-recorded — the other shots' words are
 *    unchanged but their delivery is not independent of them.
 *  - **`sourceKey` keys the authored lines.** A rewrite records its delivered
 *    wording as `spokenLines` (and on the take as `segments[].spokenText`),
 *    so matching, staleness and the manifest's `audioSourceKey` do not move.
 *
 * ponytail: the assemble step holds the whole take in memory (44.1kHz/16-bit
 * mono ≈ 88 KB/s, so a 90s scene ≈ 8 MB). Every shot clip is capped at the
 * provider's audio window, so a scene cannot grow unboundedly; if one ever
 * does, slice straight from ranged R2 reads instead of concatenating.
 */

import {
  ELEVENLABS_TTS_ENDPOINT,
  estimateTtsCost,
} from '@/billing/elevenlabs-pricing';
import { deductWorkflowCredits } from '@/billing/server/workflow-deduction';
import {
  DIALOGUE_CLIP_TOKEN,
  DIALOGUE_TTS_MODEL,
  dialogueClipSourceKey,
  dialogueFitBudget,
  spokenLinesFor,
  ttsUtterance,
} from '@/motion/dialogue-tts';
import {
  MAX_DIALOGUE_FIT_ATTEMPTS,
  shortenDialogueLines,
} from '@/motion/server/fit-dialogue-clip';
import {
  concatWavs,
  padWavToMinDuration,
  sliceWav,
  trimWavTrailingSilence,
} from '@/motion/server/pad-dialogue-audio';
import {
  synthesizeDialogueTakeChunk,
  type DialogueTakeChunk,
} from '@/motion/server/synthesize-dialogue';
import type { AnalysisModelId } from '@/models/models.config';
import { generateId } from '@/platform/id';
import { getLogger } from '@/platform/logger';
import type {
  DialogueTakeSegment,
  MotionAudioClip,
} from '@/platform/server/db/schema';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { readStorageObject, uploadFile } from '#storage';
import type { SceneVoicedLine } from '@/shots/scene-dialogue';
import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'dialogue-take']);

/**
 * Characters of `ttsUtterance` text per Text to Dialogue call. ElevenLabs'
 * own reliability line for v3 — past it a long conversation starts dropping
 * turns. A scene over the line is split at a SHOT boundary, never inside a
 * shot, so no clip is ever cut across two recordings.
 */
export const DIALOGUE_TAKE_CHUNK_CHARS = 2000;

export type RecordDialogueTakeArgs = {
  scopedDb: WorkflowScopedDb;
  workflowRunId: string;
  userId: string;
  teamId: string;
  sequenceId: string;
  sceneId: string;
  /** The `scene_dialogue_versions` row these lines come from. */
  dialogueVersionId: string;
  /** The scene's voiced turns, in speaking order (`sceneVoicedLines`). */
  lines: readonly SceneVoicedLine[];
  /** Clip length per shot, so a rewrite aims at the cut, not just the cap. */
  shotSeconds: Record<string, number | undefined>;
  /** Provider per-file floor — a short slice is padded up to it. */
  minDurationSeconds?: number;
  /** Longest clip every selected model can carry (`dialogueAudioMaxSeconds`). */
  maxDurationSeconds: number;
  analysisModelId?: AnalysisModelId;
  reservationId?: string;
  /** Durable step-name prefix — unique per scene within a run. */
  stepPrefix: string;
  workflowName: string;
};

export type RecordedDialogueTake = {
  takeId: string;
  url: string;
  durationSeconds: number;
  segments: DialogueTakeSegment[];
  /** TTS characters billed across every attempt. */
  characterCount: number;
  clipsByShotId: Record<string, MotionAudioClip[]>;
};

export async function recordDialogueTake(
  step: WorkflowStep,
  args: RecordDialogueTakeArgs
): Promise<RecordedDialogueTake> {
  if (args.lines.length === 0) {
    throw new Error('recordDialogueTake requires at least one voiced line');
  }
  const budgetFor = (shotId: string) =>
    dialogueFitBudget({
      shotSeconds: args.shotSeconds[shotId],
      maxSeconds: args.maxDurationSeconds,
    });

  let spoken: SceneVoicedLine[] = [...args.lines];
  let characterCount = 0;

  for (let attempt = 0; ; attempt++) {
    const suffix = attempt === 0 ? '' : `-refit-${attempt}`;
    const chunks = chunkTakeLines(spoken);
    const recorded: DialogueTakeChunk[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const takeChunk = await step.do(
        `${args.stepPrefix}-chunk-${index}${suffix}`,
        async (): Promise<DialogueTakeChunk> => {
          const { key } =
            await args.scopedDb.credentials.resolveKey('elevenlabs');
          const result = await synthesizeDialogueTakeChunk({
            apiKey: key,
            teamId: args.teamId,
            sequenceId: args.sequenceId,
            sceneId: args.sceneId,
            lines: chunk,
          });
          await deductWorkflowCredits({
            scopedDb: args.scopedDb,
            costMicros: estimateTtsCost(result.characterCount),
            usedOwnKey: false,
            description: `Dialogue (${chunk.length} line${chunk.length === 1 ? '' : 's'})`,
            idempotencyKey: `${args.workflowRunId}:dialogue-tts:${args.sceneId}:${index}${suffix}`,
            reservationId: args.reservationId,
            metadata: {
              endpointId: ELEVENLABS_TTS_ENDPOINT,
              model: DIALOGUE_TTS_MODEL,
              characterCount: result.characterCount,
              clipCount: 1,
              attempt,
            },
            workflowName: args.workflowName,
          });
          return result;
        }
      );
      recorded.push(takeChunk);
      characterCount += takeChunk.characterCount;
    }

    const authored = spoken;
    const assembled = await step.do(
      `${args.stepPrefix}-assemble${suffix}`,
      () =>
        assembleTake({
          recorded,
          spoken: authored,
          keyLines: args.lines,
          teamId: args.teamId,
          sequenceId: args.sequenceId,
          sceneId: args.sceneId,
          minDurationSeconds: args.minDurationSeconds,
        })
    );

    const over = assembled.slices.filter(
      (slice) =>
        (slice.clip.durationSeconds ?? 0) > budgetFor(slice.shotId).limitSeconds
    );
    if (over.length === 0) {
      return {
        takeId: assembled.takeId,
        url: assembled.url,
        durationSeconds: assembled.durationSeconds,
        segments: assembled.segments,
        characterCount,
        clipsByShotId: Object.fromEntries(
          assembled.slices.map((slice) => [slice.shotId, [slice.clip]])
        ),
      };
    }
    const worst = over[0];
    if (!worst) throw new Error('unreachable');
    const worstLimit = budgetFor(worst.shotId).limitSeconds;
    if (attempt >= MAX_DIALOGUE_FIT_ATTEMPTS) {
      throw tooLong(worst.shotId, worst.clip.durationSeconds ?? 0, worstLimit);
    }

    // Rewrite only the shots that overran; the rest of the conversation is
    // re-recorded as authored (delivery is not independent of it, so the
    // whole scene goes back to the provider).
    let next = spoken;
    let rewritten = false;
    for (const slice of over) {
      const budget = budgetFor(slice.shotId);
      const shotLines = spoken.filter((line) => line.shotId === slice.shotId);
      const shortened = await shortenDialogueLines(step, {
        scopedDb: args.scopedDb,
        workflowRunId: args.workflowRunId,
        userId: args.userId,
        sequenceId: args.sequenceId,
        shotId: slice.shotId,
        reservationId: args.reservationId,
        analysisModelId: args.analysisModelId,
        lines: shotLines,
        measuredSeconds: slice.clip.durationSeconds ?? 0,
        targetSeconds: budget.targetSeconds,
        name: `${args.stepPrefix}-shorten-${slice.shotId}-${attempt + 1}`,
      });
      if (!shortened) continue;
      // Merged by shot-relative index, so a model that drops or invents a
      // turn cannot move a speaker or a voice (see `shortenDialogueLines`).
      const byIndex = new Map(shortened.map((line) => [line.index, line.text]));
      next = next.map((line) =>
        line.shotId === slice.shotId && byIndex.get(line.index)
          ? { ...line, text: byIndex.get(line.index) ?? line.text }
          : line
      );
      rewritten = true;
    }
    if (!rewritten) {
      throw tooLong(worst.shotId, worst.clip.durationSeconds ?? 0, worstLimit);
    }
    logger.warn(
      `[dialogue-take] Scene ${args.sceneId}: ${over.length} slice(s) over budget — re-recording (attempt ${attempt + 1}/${MAX_DIALOGUE_FIT_ATTEMPTS})`
    );
    spoken = next;
  }
}

function tooLong(
  shotId: string,
  measured: number,
  limitSeconds: number
): NonRetryableError {
  return new NonRetryableError(
    `Shot ${shotId}'s dialogue records at ${measured.toFixed(1)}s and has to fit ${limitSeconds.toFixed(1)}s. ` +
      `Shortening it did not get it under. Cut the lines on this shot, split them ` +
      `across more shots, or pick a video model that takes longer audio.`
  );
}

/**
 * Split the scene's turns into Text to Dialogue calls, breaking only between
 * shots. Consecutive turns of one shot are grouped first, so a shot is never
 * split across two recordings even when the lines interleave.
 */
export function chunkTakeLines<
  T extends { shotId: string; text: string; tone: string },
>(lines: readonly T[], maxChars = DIALOGUE_TAKE_CHUNK_CHARS): T[][] {
  const groups: T[][] = [];
  for (const line of lines) {
    const last = groups.at(-1);
    if (last && last[0]?.shotId === line.shotId) last.push(line);
    else groups.push([line]);
  }
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const group of groups) {
    const groupChars = group.reduce(
      (sum, line) => sum + ttsUtterance(line.text, line.tone).length,
      0
    );
    if (current.length > 0 && size + groupChars > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(...group);
    size += groupChars;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * The window each shot's clip is cut from, in speaking order (#1657).
 *
 * A shot's clip starts where the PREVIOUS shot stopped speaking, so the
 * silence between two turns belongs to the shot that is about to speak — a
 * clip that opened on its own first syllable would sound cut into. It runs to
 * the next shot's first word (the last shot, to the end of the take), and
 * `speechEnd` is its own last word, which is where the tail is trimmed back
 * to.
 *
 * Interleaved shots (two shots trading lines inside one scene) get
 * overlapping windows by construction. That is the honest answer: each clip
 * carries the conversation around its own lines, and the alternative — a
 * clip missing its own reply — is worse.
 */
export function shotSliceWindows(
  segments: readonly DialogueTakeSegment[],
  takeDurationSeconds: number
): Array<{ shotId: string; from: number; to: number; speechEnd: number }> {
  const shotIds = [...new Set(segments.map((segment) => segment.shotId))];
  const spanOf = (shotId: string) => {
    const own = segments.filter((segment) => segment.shotId === shotId);
    return {
      firstWord: Math.min(...own.map((segment) => segment.startSeconds)),
      lastWord: Math.max(...own.map((segment) => segment.endSeconds)),
    };
  };
  return shotIds.map((shotId, index) => {
    const span = spanOf(shotId);
    const previous = index === 0 ? null : shotIds[index - 1];
    const following = shotIds[index + 1];
    const from = previous ? spanOf(previous).lastWord : 0;
    const to = following ? spanOf(following).firstWord : takeDurationSeconds;
    return {
      shotId,
      from,
      to: Math.max(span.lastWord, to),
      speechEnd: span.lastWord,
    };
  });
}

type AssembledTake = {
  takeId: string;
  url: string;
  durationSeconds: number;
  segments: DialogueTakeSegment[];
  slices: Array<{ shotId: string; clip: MotionAudioClip }>;
};

/**
 * Join the chunks, cut a clip per shot, and park everything in R2 — all
 * inside one step, so the audio itself never rides the checkpoint.
 *
 * Boundaries: the silence between two turns belongs to the FOLLOWING shot,
 * so a shot's clip starts where the previous shot stopped speaking and is
 * cut at the next shot's first word. The tail then comes off with the same
 * rule #1651 uses (`trimWavTrailingSilence` keeps whichever is LATER of the
 * last audible sample and the alignment end), and the result is padded up to
 * the provider's floor.
 */
async function assembleTake(input: {
  recorded: readonly DialogueTakeChunk[];
  /** What was actually spoken (a rewrite's wording, when there was one). */
  spoken: readonly SceneVoicedLine[];
  /** The lines as authored — these key every clip. */
  keyLines: readonly SceneVoicedLine[];
  teamId: string;
  sequenceId: string;
  sceneId: string;
  minDurationSeconds?: number;
}): Promise<AssembledTake> {
  const parts: Uint8Array[] = [];
  for (const chunk of input.recorded) {
    const object = await readStorageObject(chunk.storageKey);
    if (!object) {
      throw new Error(
        `Dialogue take chunk ${chunk.storageKey} is missing from storage`
      );
    }
    parts.push(object.bytes);
  }
  const joined = concatWavs(parts);
  const flat = input.recorded.flatMap((chunk, index) => {
    const offset = joined.offsetsSeconds[index] ?? 0;
    return chunk.segments.map((segment) => ({
      ...segment,
      startSeconds: segment.startSeconds + offset,
      endSeconds: segment.endSeconds + offset,
    }));
  });

  // One chunk IS the take, already in R2 — no second copy of the same bytes.
  const takeUrl =
    input.recorded.length === 1 && input.recorded[0]
      ? input.recorded[0].url
      : (
          await uploadFile(
            STORAGE_BUCKETS.AUDIO,
            `${input.teamId}/${input.sequenceId}/${input.sceneId}/${generateId()}.wav`,
            joined.bytes,
            { contentType: 'audio/wav', upsert: true }
          )
        ).publicUrl;

  const spokenByLineIndex = new Map(
    input.spoken.map((line) => [line.lineIndex, line.text])
  );
  const authoredByLineIndex = new Map(
    input.keyLines.map((line) => [line.lineIndex, line.text])
  );
  const segments: DialogueTakeSegment[] = flat.map((segment) => {
    const delivered = spokenByLineIndex.get(segment.lineIndex);
    const wasRewritten =
      delivered !== undefined &&
      delivered !== authoredByLineIndex.get(segment.lineIndex);
    return {
      lineIndex: segment.lineIndex,
      shotId: segment.shotId,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      ...(wasRewritten && delivered ? { spokenText: delivered } : {}),
    };
  });

  const takeId = generateId();
  const slices: AssembledTake['slices'] = [];
  for (const window of shotSliceWindows(segments, joined.durationSeconds)) {
    const shotId = window.shotId;
    const cut = sliceWav(joined.bytes, window.from, window.to);
    const trimmed = trimWavTrailingSilence(
      cut.bytes,
      window.speechEnd - window.from
    );
    const padded =
      input.minDurationSeconds == null
        ? trimmed
        : padWavToMinDuration(trimmed.bytes, input.minDurationSeconds);

    const authoredLines = input.keyLines.filter(
      (line) => line.shotId === shotId
    );
    const spokenLines = input.spoken.filter((line) => line.shotId === shotId);
    const clipId = generateId();
    const uploaded = await uploadFile(
      STORAGE_BUCKETS.AUDIO,
      `${input.teamId}/${input.sequenceId}/${shotId}/${clipId}.wav`,
      padded.bytes,
      { contentType: 'audio/wav', upsert: true }
    );
    const delivered = spokenLinesFor(authoredLines, spokenLines);
    slices.push({
      shotId,
      clip: {
        id: clipId,
        url: uploaded.publicUrl,
        token: DIALOGUE_CLIP_TOKEN,
        durationSeconds: padded.durationSeconds,
        sourceKey: dialogueClipSourceKey(authoredLines),
        takeId,
        ...(delivered && { spokenLines: delivered }),
      },
    });
  }

  return {
    takeId,
    url: takeUrl,
    durationSeconds: joined.durationSeconds,
    segments,
    slices,
  };
}
