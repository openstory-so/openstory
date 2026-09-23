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

import { isSeedVoiceId } from '@/cast/seed-voice';
import { deductWorkflowCredits } from '@/billing/server/workflow-deduction';
import {
  dialogueClipSourceKey,
  dialogueFitBudget,
  sectionClip,
  spokenLinesFor,
  ttsCharacterCount,
} from '@/motion/dialogue-tts';
import { cutAudioSection } from '@/motion/server/cut-audio-section';
import {
  MAX_DIALOGUE_FIT_ATTEMPTS,
  shortenDialogueLines,
} from '@/motion/server/fit-dialogue-clip';
import { AUDIO_MIN_PAD_SLACK_SECONDS } from '@/motion/server/pad-dialogue-audio';
import {
  recordSeedDialogueCall,
  SEED_MAX_SPEAKERS,
} from '@/motion/server/record-seed-dialogue';
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

/**
 * Line characters per Seed Audio call (#1765). Its prompt also carries the
 * booth and each speaker's description under a 3,000-character cap, and a
 * take runs well past its words (22 s of lines came back as 24–40 s) under a
 * 120 s cap.
 */
const SEED_TAKE_CHUNK_CHARS = 1000;

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

/** A call's record plus the section id minted for each shot it spoke. */
type RecordedCall = RecordedDialogueCall & {
  sectionIdByShotId: Record<string, string>;
};

/** Every shot a call spoke was minted a section id; a miss is a bug, not silence. */
function sectionIdOf(call: RecordedCall, shotId: string): string {
  const id = call.sectionIdByShotId[shotId];
  if (!id) {
    throw new NonRetryableError(
      `Recording ${call.recordingId} has no section for shot ${shotId}`
    );
  }
  return id;
}

export async function recordDialogue(
  step: WorkflowStep,
  args: RecordDialogueArgs
): Promise<Record<string, MotionAudioClip[]>> {
  const spokenShotIds = new Set(voicedShotIds(args.lines));
  const adopting = args.adoptShotIds.filter((id) => spokenShotIds.has(id));
  if (adopting.length === 0 || adopting.length !== args.adoptShotIds.length) {
    throw new NonRetryableError(
      'recordDialogue requires every adopting shot to have a voiced line'
    );
  }
  // Claim before anything is spent (#1657) — the same lifecycle every other
  // generation has. A shot another run is already recording, for the same
  // words, is not ours to adopt; with none left there is nothing to do.
  const claimIdByShotId = await step.do(
    `${args.stepPrefix}-claim`,
    async () => {
      const claims = await args.scopedDb.shotDialogue.claimRecording({
        shots: adopting.map((shotId) => ({
          shotId,
          sourceKey: dialogueClipSourceKey(linesOf(args.lines, shotId)),
        })),
        workflowRunId: args.workflowRunId,
      });
      // The open panel shows "Recording…" from here (#1653).
      await Promise.all(
        Object.keys(claims).map((shotId) =>
          getGenerationChannel(args.sequenceId).emit(
            'generation.shot:updated',
            { shotId, updateType: 'dialogue-audio', metadata: null }
          )
        )
      );
      return claims;
    }
  );
  const claimed = adopting.filter((shotId) => claimIdByShotId[shotId]);
  if (claimed.length === 0) return {};
  try {
    return await recordClaimed(step, args, claimed, claimIdByShotId);
  } catch (error) {
    // A claim must never outlive its run's ability to complete it.
    await step.do(`${args.stepPrefix}-fail-claims`, () =>
      args.scopedDb.shotDialogue.failClaims(
        Object.values(claimIdByShotId),
        error instanceof Error ? error.message : String(error)
      )
    );
    throw error;
  }
}

/** The recording itself, for the shots this run holds a claim on. */
async function recordClaimed(
  step: WorkflowStep,
  args: RecordDialogueArgs,
  claimed: readonly string[],
  claimIdByShotId: Record<string, string>
): Promise<Record<string, MotionAudioClip[]>> {
  const adopts = new Set(claimed);
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
          const eleven =
            await args.scopedDb.credentials.resolveKey('elevenlabs');
          // A Seed voice is recorded by Seed, an ElevenLabs voice by
          // ElevenLabs (#1765) — `chunkTakeLines` never puts both in a call.
          const made = callLines.some((line) => isSeedVoiceId(line.voiceId))
            ? await recordSeedDialogueCall({
                seedKey: (
                  await args.scopedDb.credentials.resolveKey('seed-speech')
                ).key,
                elevenLabsKey: eleven.key,
                teamId: args.teamId,
                sequenceId: args.sequenceId,
                lines: callLines,
              })
            : await recordDialogueCall({
                apiKey: eleven.key,
                teamId: args.teamId,
                sequenceId: args.sequenceId,
                lines: callLines,
              });
          await deductWorkflowCredits({
            scopedDb: args.scopedDb,
            costMicros: made.costMicros,
            usedOwnKey: false,
            description: `Dialogue (${callLines.length} line${callLines.length === 1 ? '' : 's'})`,
            idempotencyKey: `${args.workflowRunId}:dialogue-tts:${args.stepPrefix}:${call.index}${suffix}`,
            reservationId: args.reservationId,
            metadata: {
              endpointId: made.endpointId,
              model: made.model,
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
    const first = over[0];
    if (!first) break;
    const firstLimit = budgetFor(first.shotId).limitSeconds;
    if (attempt >= MAX_DIALOGUE_FIT_ATTEMPTS) {
      throw tooLong(first.shotId, first.measured, firstLimit);
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
      throw tooLong(first.shotId, first.measured, firstLimit);
    }
    logger.warn(
      `[dialogue-recording] ${args.stepPrefix}: ${over.length} section(s) over budget — re-recording ${rerecord.size} call(s) (attempt ${attempt + 1}/${MAX_DIALOGUE_FIT_ATTEMPTS})`
    );
    toRecord = calls.filter((call) => rerecord.has(call.index));
  }

  // What each shot was asked to say, and what it said if the ladder rewrote it.
  const spokenOf = (shotId: string) => ({
    sourceKey: dialogueClipSourceKey(linesOf(args.lines, shotId)),
    spokenLines: spokenLinesFor(
      linesOf(args.lines, shotId),
      linesOf(spoken, shotId)
    ),
  });

  // One cut per adopting shot, each in its own step: R2 → R2, no bytes here.
  const clipsByShotId: Record<string, MotionAudioClip[]> = {};
  for (const call of recorded.values()) {
    for (const window of call.windows) {
      const shotId = window.shotId;
      if (!adopts.has(shotId)) continue;
      const sectionId = sectionIdOf(call, shotId);
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
      const { sourceKey, spokenLines } = spokenOf(shotId);
      clipsByShotId[shotId] = [
        sectionClip(
          {
            id: sectionId,
            recordingId: call.recordingId,
            sourceKey,
            spokenLines: spokenLines ?? null,
          },
          cut
        ),
      ];
    }
  }

  // Only the recordings that survived the ladder get rows. `appendRecording`
  // lands the reading AND promotes it — pointer and `shots.audioClips` in one
  // transaction, each guarded by the shot's claim — and is a no-op for a
  // recording id it already holds, so a retry of this step lands on the same
  // state. The step returns only the promoted shot ids: small, and what a
  // replay has to agree on.
  const promotedShotIds = await step.do(
    `${args.stepPrefix}-persist`,
    async () => {
      const promoted: string[] = [];
      for (const call of recorded.values()) {
        const callShotIds = call.windows.map((window) => window.shotId);
        const inputHash = recordingKey(
          args.lines.filter((line) => callShotIds.includes(line.shotId))
        );
        if (!inputHash) {
          throw new NonRetryableError(
            `Recording ${call.recordingId} has no voiced lines to key`
          );
        }
        const landed = await args.scopedDb.shotDialogue.appendRecording({
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
          inputHash,
          characterCount: call.characterCount,
          workflowRunId: args.workflowRunId,
          sections: call.windows.map((window) => {
            const { sourceKey, spokenLines } = spokenOf(window.shotId);
            return {
              id: sectionIdOf(call, window.shotId),
              shotId: window.shotId,
              fromSeconds: window.fromSeconds,
              toSeconds: window.toSeconds,
              sourceKey,
              spokenLines: spokenLines ?? null,
              dialogueVersionId:
                args.dialogueVersionIdByShotId[window.shotId] ?? null,
              adopt: (() => {
                const claimId = claimIdByShotId[window.shotId];
                const audioClips = clipsByShotId[window.shotId];
                return adopts.has(window.shotId) && claimId && audioClips
                  ? { claimId, audioClips }
                  : null;
              })(),
            };
          }),
        });
        promoted.push(...landed.promotedShotIds);
      }
      // The open panel re-reads the shot (#1653) — promoted or not, its list of
      // readings and its "recording…" state both moved.
      await Promise.all(
        claimed.map((shotId) =>
          getGenerationChannel(args.sequenceId).emit(
            'generation.shot:updated',
            {
              shotId,
              updateType: 'dialogue-audio',
              metadata: null,
            }
          )
        )
      );
      return promoted;
    }
  );

  // Only a PROMOTED reading is the shot's audio. A claim the user demoted or
  // cancelled while this recorded keeps its reading in the list, unselected,
  // and the caller renders from whatever the shot holds now.
  const promotedSet = new Set(promotedShotIds);
  return Object.fromEntries(
    Object.entries(clipsByShotId).filter(([shotId]) => promotedSet.has(shotId))
  );
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
 * Split a conversation into calls, breaking only between shots. Consecutive
 * turns of one shot are grouped first, so a shot is never split across two
 * recordings. A call also breaks where the provider changes (a Seed voice and
 * an ElevenLabs voice cannot share one, #1765), and a Seed call where a third
 * speaker would join or past {@link SEED_TAKE_CHUNK_CHARS}: a scene of three
 * or more Seed speakers is recorded as a series of two-person exchanges.
 */
export function chunkTakeLines<
  T extends { shotId: string; voiceId: string; text: string; tone: string },
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
  const seed = (chunk: readonly T[]) =>
    chunk.some((line) => isSeedVoiceId(line.voiceId));
  const speakers = (chunk: readonly T[]) =>
    new Set(chunk.map((line) => line.voiceId)).size;
  for (const group of groups) {
    const groupChars = ttsCharacterCount(group);
    const joined = [...current, ...group];
    const breaks =
      seed(current) !== seed(group) ||
      (seed(group) &&
        (speakers(joined) > SEED_MAX_SPEAKERS ||
          size + groupChars > Math.min(maxChars, SEED_TAKE_CHUNK_CHARS))) ||
      size + groupChars > maxChars;
    if (current.length > 0 && breaks) {
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
