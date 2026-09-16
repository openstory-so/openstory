/**
 * Fit a shot's recorded dialogue inside the clip that has to carry it (#1651).
 *
 * ElevenLabs v3 takes no target or maximum duration — script length and
 * delivery cues influence timing and guarantee nothing. So the length is
 * discovered, not requested: record, measure the file, and when it overruns,
 * say less and record again.
 *
 * The ladder, cheapest first:
 *  1. Trailing silence comes off every take inside `synthesizeDialogueClip` —
 *     free, and it is usually the whole overrun.
 *  2. Still over: an LLM tightens the turns to the shot's word budget and the
 *     take is re-recorded. Bounded by {@link MAX_DIALOGUE_FIT_ATTEMPTS}, since
 *     each pass bills one more TTS call.
 *  3. Still over: the shot FAILS here, with the numbers in the message. It is
 *     never submitted. A provider that rejects a 15.4s reference reports it as
 *     an opaque request error minutes later, on the render the user paid for.
 *
 * There is deliberately no time-compression stage. Speeding speech up to fit
 * changes the performance the user cast, and a pitch-preserving stretch in
 * workerd would be ours to write and tune. Trimming silence is the fitting
 * the issue asks for; the rewrite is the recovery.
 * ponytail: if steady-state failures show takes landing 1–3% over after the
 * rewrites, a WSOLA stretch capped at ~1.05x is the next rung.
 */

import {
  ELEVENLABS_TTS_ENDPOINT,
  estimateTtsCost,
} from '@/billing/elevenlabs-pricing';
import { deductWorkflowCredits } from '@/billing/server/workflow-deduction';
import {
  dialogueFitBudget,
  dialogueWordBudget,
  spokenWordCount,
  type VoicedDialogueLine,
} from '@/motion/dialogue-tts';
import { synthesizeDialogueClip } from '@/motion/server/synthesize-dialogue';
import { durableLLMCallCf } from '@/models/server/llm-call-helper';
import {
  DEFAULT_ANALYSIS_MODEL,
  type AnalysisModelId,
} from '@/models/models.config';
import { getLogger } from '@/platform/logger';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { z } from 'zod';

const logger = getLogger(['openstory', 'workflow', 'dialogue-fit']);

/**
 * Rewrite-and-re-record passes after the first take. Two, because each pass
 * costs another TTS call plus an LLM call and the first rewrite lands the
 * large majority — the second is for a take that was far over.
 */
export const MAX_DIALOGUE_FIT_ATTEMPTS = 2;

/** Plain strings/numbers — no bounds (Bedrock rejects integer bounds). */
export const shortenDialogueResponseSchema = z.object({
  turns: z.array(
    z.object({
      index: z.number(),
      character: z.string(),
      line: z.string(),
    })
  ),
});

export type FitDialogueClipArgs = {
  scopedDb: WorkflowScopedDb;
  workflowRunId: string;
  userId: string;
  teamId: string;
  sequenceId: string;
  shotId: string;
  /** The lines as authored. These key the clip, whatever is finally spoken. */
  lines: readonly VoicedDialogueLine[];
  /** Provider per-file floor — a short take is padded up to it. */
  minDurationSeconds?: number;
  /** Longest take every selected model can carry (`dialogueAudioMaxSeconds`). */
  maxDurationSeconds: number;
  /** This shot's clip length, so a rewrite aims at the cut, not just the cap. */
  shotSeconds?: number | null;
  analysisModelId?: AnalysisModelId;
  reservationId?: string;
  /** Durable step-name prefix — unique per shot within a run. */
  stepPrefix: string;
  /** For the credit ledger line. */
  workflowName: string;
};

export type FittedDialogueClip = {
  clip: MotionAudioClip;
  /** What was spoken: the authored lines, or the rewrite that fit. */
  lines: VoicedDialogueLine[];
  /** TTS characters billed across every attempt. */
  characterCount: number;
};

export async function fitDialogueClip(
  step: WorkflowStep,
  args: FitDialogueClipArgs
): Promise<FittedDialogueClip> {
  const { targetSeconds, limitSeconds } = dialogueFitBudget({
    shotSeconds: args.shotSeconds,
    maxSeconds: args.maxDurationSeconds,
  });

  let spoken: VoicedDialogueLine[] = [...args.lines];
  let characterCount = 0;

  for (let attempt = 0; ; attempt++) {
    const suffix = attempt === 0 ? '' : `-refit-${attempt}`;
    const take = await step.do(
      `${args.stepPrefix}${suffix}`,
      async (): Promise<{ clip: MotionAudioClip; characterCount: number }> => {
        const { key } =
          await args.scopedDb.credentials.resolveKey('elevenlabs');
        const result = await synthesizeDialogueClip({
          apiKey: key,
          teamId: args.teamId,
          sequenceId: args.sequenceId,
          shotId: args.shotId,
          lines: spoken,
          keyLines: args.lines,
          minDurationSeconds: args.minDurationSeconds,
        });
        await deductWorkflowCredits({
          scopedDb: args.scopedDb,
          costMicros: estimateTtsCost(result.characterCount),
          usedOwnKey: false,
          description: `Dialogue (${spoken.length} line${spoken.length === 1 ? '' : 's'})`,
          idempotencyKey: `${args.workflowRunId}:dialogue-tts:${args.shotId}${suffix}`,
          reservationId: args.reservationId,
          metadata: {
            endpointId: ELEVENLABS_TTS_ENDPOINT,
            model: 'eleven_v3',
            characterCount: result.characterCount,
            clipCount: 1,
            attempt,
          },
          workflowName: args.workflowName,
        });
        return { clip: result.clip, characterCount: result.characterCount };
      }
    );
    characterCount += take.characterCount;

    // Measured off the stored WAV, never off the alignment: trailing silence
    // and encoder padding are part of the file the provider will reject. A
    // clip whose length we could not measure never gets here —
    // `synthesizeDialogueClip` throws on audio it cannot parse.
    const measured = take.clip.durationSeconds ?? 0;
    if (measured <= limitSeconds) {
      return { clip: take.clip, lines: spoken, characterCount };
    }
    if (attempt >= MAX_DIALOGUE_FIT_ATTEMPTS) {
      throw tooLong(measured, limitSeconds);
    }
    logger.warn(
      `[dialogue-fit] Shot ${args.shotId} take ${measured.toFixed(2)}s over ${limitSeconds.toFixed(2)}s — rewriting (attempt ${attempt + 1}/${MAX_DIALOGUE_FIT_ATTEMPTS})`
    );
    // A rewrite that produced nothing usable leaves the same words to record,
    // so the next take is the same length: stop here with the real numbers
    // rather than billing an identical one.
    const shortened = await shortenDialogueLines(step, {
      ...args,
      lines: spoken,
      measuredSeconds: measured,
      targetSeconds,
      name: `${args.stepPrefix}-shorten-${attempt + 1}`,
    });
    if (!shortened) throw tooLong(measured, limitSeconds);
    spoken = shortened;
  }
}

function tooLong(measured: number, limitSeconds: number): NonRetryableError {
  return new NonRetryableError(
    `This shot's dialogue records at ${measured.toFixed(1)}s and has to fit ${limitSeconds.toFixed(1)}s. ` +
      `Shortening it did not get it under. Cut the lines on this shot, split them ` +
      `across more shots, or pick a video model that takes longer audio.`
  );
}

/**
 * Tighten the turns to `targetSeconds` worth of words, keeping every speaker.
 * The rewrite is merged BY INDEX onto the lines we already hold, so a model
 * that drops, reorders or invents a turn cannot change who speaks or with
 * whose voice — the worst it can do is leave a line as it was, which is what
 * the null return reports.
 */
async function shortenDialogueLines(
  step: WorkflowStep,
  args: FitDialogueClipArgs & {
    lines: readonly VoicedDialogueLine[];
    measuredSeconds: number;
    targetSeconds: number;
    name: string;
  }
): Promise<VoicedDialogueLine[] | null> {
  const wordBudget = dialogueWordBudget(args.targetSeconds);
  const response = await durableLLMCallCf(
    step,
    {
      name: args.name,
      phase: { number: 4, name: 'Shortening dialogue…' },
      promptName: 'phase/shorten-dialogue-chat',
      promptVariables: {
        turns: JSON.stringify(
          args.lines.map((line) => ({
            index: line.index,
            character: line.character,
            line: line.text,
          })),
          null,
          2
        ),
        measuredSeconds: args.measuredSeconds.toFixed(1),
        targetSeconds: args.targetSeconds.toFixed(1),
        wordBudget: String(wordBudget),
        currentWords: String(spokenWordCount(args.lines)),
      },
      modelId: args.analysisModelId ?? DEFAULT_ANALYSIS_MODEL,
      responseSchema: shortenDialogueResponseSchema,
      additionalMetadata: { shotId: args.shotId },
    },
    {
      sequenceId: args.sequenceId,
      userId: args.userId,
      workflowRunId: args.workflowRunId,
      scopedDb: args.scopedDb,
      reservationId: args.reservationId,
    }
  );

  const rewritten = new Map<number, string>();
  for (const turn of response.turns) {
    const text = turn.line.trim();
    if (text) rewritten.set(turn.index, text);
  }
  const merged = args.lines.map((line) => {
    const text = rewritten.get(line.index);
    return text && text !== line.text ? { ...line, text } : line;
  });
  return merged.every((line, i) => line.text === args.lines[i]?.text)
    ? null
    : merged;
}
