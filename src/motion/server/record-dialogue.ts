/**
 * Record a conversation and keep it per shot (#1657): record wide, keep
 * narrow.
 *
 * Text to Dialogue acts the turns it is given against each other, so a shot
 * recorded alone is a cold read — the reply to a line the model never heard.
 * The call therefore speaks the whole conversation it is handed. But only the
 * shots in `adoptShotIds` — the ones whose clip no longer matches their lines
 * — take the new audio. Every other shot the call spoke gets an UNSELECTED
 * section row (a reading the user can pick later) and keeps the clip it had,
 * so nothing of theirs goes stale because a neighbour's line was edited.
 *
 * What this file is careful about:
 *
 *  - **Bytes never cross a step.** A call is recorded and parked whole in R2
 *    inside its own step, and each adopting shot's file is cut R2 → R2 inside
 *    its own step. Only small records ride the Workflows checkpoint (#1645).
 *  - **Recordings are never joined.** A conversation over the provider's
 *    reliability line is split at a shot boundary into separate calls, each
 *    its own `dialogue_recordings` row; a call with no adopting shot in it is
 *    not made at all.
 *  - **The fit ladder is per adopting SHOT** (#1651). A section over its
 *    shot's limit sends THAT shot's turns to the rewrite, and the call it
 *    sits in is re-recorded — delivery is not independent of the words around
 *    it. A context shot is never measured: it is not adopting anything.
 *  - **`sourceKey` keys the authored lines.** A rewrite records its delivered
 *    wording as `spokenLines` (and on the recording's turn as `spokenText`),
 *    so matching, staleness and the manifest's `audioSourceKey` do not move.
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
import { cutAudioSection } from '@/motion/server/cut-audio-section';
import {
  MAX_DIALOGUE_FIT_ATTEMPTS,
  shortenDialogueLines,
} from '@/motion/server/fit-dialogue-clip';
import { AUDIO_MIN_PAD_SLACK_SECONDS } from '@/motion/server/pad-dialogue-audio';
import {
  recordDialogueCall,
  type RecordedDialogueCall,
} from '@/motion/server/synthesize-dialogue';
import type { AnalysisModelId } from '@/models/models.config';
import { generateId } from '@/platform/id';
import { getLogger } from '@/platform/logger';
import { getGenerationChannel } from '@/platform/realtime';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import {
  DIALOGUE_TAKE_CHUNK_CHARS,
  recordingKey,
  voicedShotIds,
  type SceneVoicedLine,
} from '@/shots/shot-dialogue';
import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'dialogue-recording']);

export type RecordDialogueArgs = {
  scopedDb: WorkflowScopedDb;
  workflowRunId: string;
  userId: string;
  teamId: string;
  sequenceId: string;
  /** The conversation to speak, in speaking order (`sceneConversation`). */
  lines: readonly SceneVoicedLine[];
  /** The shots that take the new audio. Everyone else is context. */
  adoptShotIds: readonly string[];
  /** shot id → the `shot_dialogue_versions` row spoken (absent = derived). */
  dialogueVersionIdByShotId: Record<string, string>;
  /** Clip length per shot, so a rewrite aims at the cut, not just the cap. */
  shotSeconds: Record<string, number | undefined>;
  /** Provider per-file floor — a short section is padded up to it. */
  minDurationSeconds?: number;
  /** Longest clip every selected model can carry (`dialogueAudioMaxSeconds`). */
  maxDurationSeconds: number;
  analysisModelId?: AnalysisModelId;
  reservationId?: string;
  /** Durable step-name prefix — unique per conversation within a run. */
  stepPrefix: string;
  workflowName: string;
};

export type RecordedDialogue = {
  /** The adopting shots' new clips — nothing for a shot that was context. */
  clipsByShotId: Record<string, MotionAudioClip[]>;
  /** TTS characters billed across every call and attempt. */
  characterCount: number;
};

/** A call's record plus the section id minted for each shot it spoke. */
type RecordedCall = RecordedDialogueCall & {
  sectionIdByShotId: Record<string, string>;
};

export async function recordDialogue(
  step: WorkflowStep,
  args: RecordDialogueArgs
): Promise<RecordedDialogue> {
  const spokenShotIds = new Set(voicedShotIds(args.lines));
  const adopting = args.adoptShotIds.filter((id) => spokenShotIds.has(id));
  if (adopting.length === 0 || adopting.length !== args.adoptShotIds.length) {
    throw new Error(
      'recordDialogue requires every adopting shot to have a voiced line'
    );
  }
  const adopts = new Set(adopting);
  const budgetFor = (shotId: string) =>
    dialogueFitBudget({
      shotSeconds: args.shotSeconds[shotId],
      maxSeconds: args.maxDurationSeconds,
    });
  // The length of the FILE the shot will be handed: padding counts, because
  // the provider measures the file.
  const fileSeconds = (window: { fromSeconds: number; toSeconds: number }) => {
    const spoken = window.toSeconds - window.fromSeconds;
    return args.minDurationSeconds == null
      ? spoken
      : Math.max(spoken, args.minDurationSeconds + AUDIO_MIN_PAD_SLACK_SECONDS);
  };

  // Calls are fixed by the AUTHORED lines: a rewrite only ever shortens, so a
  // call that fit still fits, and its index stays a stable durable name.
  const calls = chunkTakeLines(args.lines)
    .map((chunk, index) => ({ index, shotIds: voicedShotIds(chunk) }))
    .filter((call) => call.shotIds.some((id) => adopts.has(id)));

  let spoken: SceneVoicedLine[] = [...args.lines];
  let characterCount = 0;
  const recorded = new Map<number, RecordedCall>();
  let toRecord = calls;

  for (let attempt = 0; ; attempt++) {
    const suffix = attempt === 0 ? '' : `-refit-${attempt}`;
    for (const call of toRecord) {
      const callLines = spoken.filter((line) =>
        call.shotIds.includes(line.shotId)
      );
      const result = await step.do(
        `${args.stepPrefix}-chunk-${call.index}${suffix}`,
        async (): Promise<RecordedCall> => {
          const { key } =
            await args.scopedDb.credentials.resolveKey('elevenlabs');
          const made = await recordDialogueCall({
            apiKey: key,
            teamId: args.teamId,
            sequenceId: args.sequenceId,
            lines: callLines,
          });
          await deductWorkflowCredits({
            scopedDb: args.scopedDb,
            costMicros: estimateTtsCost(made.characterCount),
            usedOwnKey: false,
            description: `Dialogue (${callLines.length} line${callLines.length === 1 ? '' : 's'})`,
            idempotencyKey: `${args.workflowRunId}:dialogue-tts:${args.stepPrefix}:${call.index}${suffix}`,
            reservationId: args.reservationId,
            metadata: {
              endpointId: ELEVENLABS_TTS_ENDPOINT,
              model: DIALOGUE_TTS_MODEL,
              characterCount: made.characterCount,
              clipCount: 1,
              attempt,
            },
            workflowName: args.workflowName,
          });
          // Section ids are minted with the recording, inside this step: the
          // clip and the row have to agree on them across a persist retry.
          return {
            ...made,
            sectionIdByShotId: Object.fromEntries(
              made.windows.map((window) => [window.shotId, generateId()])
            ),
          };
        }
      );
      recorded.set(call.index, result);
      characterCount += result.characterCount;
    }

    const over = [...recorded.entries()].flatMap(([callIndex, call]) =>
      call.windows
        .filter(
          (window) =>
            adopts.has(window.shotId) &&
            fileSeconds(window) > budgetFor(window.shotId).limitSeconds
        )
        .map((window) => ({
          callIndex,
          shotId: window.shotId,
          measured: fileSeconds(window),
        }))
    );
    const worst = over[0];
    if (!worst) break;
    const worstLimit = budgetFor(worst.shotId).limitSeconds;
    if (attempt >= MAX_DIALOGUE_FIT_ATTEMPTS) {
      throw tooLong(worst.shotId, worst.measured, worstLimit);
    }

    // Rewrite only the shots that overran; the rest of their call is
    // re-recorded as it was (delivery is not independent of it).
    const rerecord = new Set<number>();
    for (const shot of over) {
      const shortened = await shortenDialogueLines(step, {
        scopedDb: args.scopedDb,
        workflowRunId: args.workflowRunId,
        userId: args.userId,
        sequenceId: args.sequenceId,
        shotId: shot.shotId,
        reservationId: args.reservationId,
        analysisModelId: args.analysisModelId,
        lines: spoken.filter((line) => line.shotId === shot.shotId),
        measuredSeconds: shot.measured,
        targetSeconds: budgetFor(shot.shotId).targetSeconds,
        name: `${args.stepPrefix}-shorten-${shot.shotId}-${attempt + 1}`,
      });
      if (!shortened) continue;
      // Merged by shot-relative index, so a model that drops or invents a
      // turn cannot move a speaker or a voice (see `shortenDialogueLines`).
      const byIndex = new Map(shortened.map((line) => [line.index, line.text]));
      spoken = spoken.map((line) =>
        line.shotId === shot.shotId
          ? { ...line, text: byIndex.get(line.index) ?? line.text }
          : line
      );
      rerecord.add(shot.callIndex);
    }
    // A rewrite that produced nothing usable leaves the same words to record,
    // so the next call is the same length: stop here with the real numbers
    // rather than billing an identical one.
    if (rerecord.size === 0) {
      throw tooLong(worst.shotId, worst.measured, worstLimit);
    }
    logger.warn(
      `[dialogue-recording] ${args.stepPrefix}: ${over.length} section(s) over budget — re-recording ${rerecord.size} call(s) (attempt ${attempt + 1}/${MAX_DIALOGUE_FIT_ATTEMPTS})`
    );
    toRecord = calls.filter((call) => rerecord.has(call.index));
  }

  // One cut per adopting shot, each in its own step: R2 → R2, no bytes here.
  const clipsByShotId: Record<string, MotionAudioClip[]> = {};
  for (const call of recorded.values()) {
    for (const window of call.windows) {
      const shotId = window.shotId;
      const sectionId = call.sectionIdByShotId[shotId];
      if (!adopts.has(shotId) || !sectionId) continue;
      const cut = await step.do(`${args.stepPrefix}-cut-${shotId}`, () =>
        cutAudioSection({
          storageKey: call.storageKey,
          recordingId: call.recordingId,
          teamId: args.teamId,
          sequenceId: args.sequenceId,
          fromSeconds: window.fromSeconds,
          toSeconds: window.toSeconds,
          minDurationSeconds: args.minDurationSeconds,
        })
      );
      const delivered = spokenLinesFor(
        linesOf(args.lines, shotId),
        linesOf(spoken, shotId)
      );
      clipsByShotId[shotId] = [
        {
          id: sectionId,
          url: cut.url,
          token: DIALOGUE_CLIP_TOKEN,
          durationSeconds: cut.durationSeconds,
          sourceKey: dialogueClipSourceKey(linesOf(args.lines, shotId)),
          recordingId: call.recordingId,
          ...(delivered && { spokenLines: delivered }),
        },
      ];
    }
  }

  // Only the recordings that survived the ladder get rows. `appendRecording`
  // is a no-op for a recording id it already holds, and `setAudioClips` is an
  // overwrite, so a retry of this step lands on the same state.
  await step.do(`${args.stepPrefix}-persist`, async () => {
    for (const call of recorded.values()) {
      const callShotIds = call.windows.map((window) => window.shotId);
      await args.scopedDb.shotDialogue.appendRecording({
        id: call.recordingId,
        sequenceId: args.sequenceId,
        storageKey: call.storageKey,
        url: call.url,
        durationSeconds: call.durationSeconds,
        turns: call.turns.map((turn) => {
          const authored = lineAt(args.lines, turn)?.text;
          const said = lineAt(spoken, turn)?.text;
          return said !== undefined && said !== authored
            ? { ...turn, spokenText: said }
            : turn;
        }),
        inputHash:
          recordingKey(
            args.lines.filter((line) => callShotIds.includes(line.shotId))
          ) ?? '',
        characterCount: call.characterCount,
        workflowRunId: args.workflowRunId,
        sections: call.windows.flatMap((window) => {
          const id = call.sectionIdByShotId[window.shotId];
          if (!id) return [];
          return [
            {
              id,
              shotId: window.shotId,
              fromSeconds: window.fromSeconds,
              toSeconds: window.toSeconds,
              sourceKey: dialogueClipSourceKey(
                linesOf(args.lines, window.shotId)
              ),
              spokenLines:
                spokenLinesFor(
                  linesOf(args.lines, window.shotId),
                  linesOf(spoken, window.shotId)
                ) ?? null,
              dialogueVersionId:
                args.dialogueVersionIdByShotId[window.shotId] ?? null,
              selected: adopts.has(window.shotId),
            },
          ];
        }),
      });
    }
    for (const [shotId, clips] of Object.entries(clipsByShotId)) {
      await args.scopedDb.shots.setAudioClips(shotId, clips);
      // The open video panel re-reads the shot (#1653).
      await getGenerationChannel(args.sequenceId).emit(
        'generation.shot:updated',
        { shotId, updateType: 'dialogue-audio', metadata: null }
      );
    }
  });

  return { clipsByShotId, characterCount };
}

const linesOf = (lines: readonly SceneVoicedLine[], shotId: string) =>
  lines.filter((line) => line.shotId === shotId);

const lineAt = (
  lines: readonly SceneVoicedLine[],
  turn: { shotId: string; index: number }
) =>
  lines.find(
    (line) => line.shotId === turn.shotId && line.index === turn.index
  );

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
 * Split a conversation into Text to Dialogue calls, breaking only between
 * shots. Consecutive turns of one shot are grouped first, so a shot is never
 * split across two recordings.
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
