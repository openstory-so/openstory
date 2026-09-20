/**
 * Fit a shot's recorded dialogue inside the clip that has to carry it (#1651).
 *
 * ElevenLabs v3 takes no target or maximum duration — script length and
 * delivery cues influence timing and guarantee nothing. So the length is
 * discovered, not requested: record, measure the file, and when it overruns,
 * say less and record again.
 *
 * The ladder, cheapest first:
 *  1. Trailing silence comes off every section as it is measured
 *     (`trimmedEndSeconds`) — free, and it is usually the whole overrun.
 *  2. Still over: an LLM tightens the turns to the shot's word budget and the
 *     call is re-recorded. Bounded by {@link MAX_DIALOGUE_FIT_ATTEMPTS}, since
 *     each pass bills one more TTS call.
 *  3. Still over: the shot FAILS here, with the numbers in the message. It is
 *     never submitted. A provider that rejects a 15.4s reference reports it as
 *     an opaque request error minutes later, on the render the user paid for.
 *
 * There is deliberately no time-compression stage. Speeding speech up to fit
 * changes the performance the user cast, and a pitch-preserving stretch in
 * workerd would be ours to write and tune. Trimming silence is the fitting
 * the issue asks for; the rewrite is the recovery.
 * ponytail: if steady-state failures show sections landing 1–3% over after the
 * rewrites, a WSOLA stretch capped at ~1.05x is the next rung.
 */

import {
  dialogueWordBudget,
  spokenWordCount,
  type VoicedDialogueLine,
} from '@/motion/dialogue-tts';
import { durableLLMCallCf } from '@/models/server/llm-call-helper';
import {
  DEFAULT_ANALYSIS_MODEL,
  type AnalysisModelId,
} from '@/models/models.config';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { WorkflowStep } from 'cloudflare:workers';
import { z } from 'zod';

/**
 * Rewrite-and-re-record passes after the first call. Two, because each pass
 * costs another TTS call plus an LLM call and the first rewrite lands the
 * large majority — the second is for a section that was far over.
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

/**
 * Tighten the turns to `targetSeconds` worth of words, keeping every speaker.
 * The rewrite is merged BY INDEX onto the lines we already hold, so a model
 * that drops, reorders or invents a turn cannot change who speaks or with
 * whose voice — the worst it can do is leave a line as it was, which is what
 * the null return reports.
 */
export type ShortenDialogueArgs = {
  scopedDb: WorkflowScopedDb;
  workflowRunId: string;
  userId: string;
  sequenceId: string;
  /** For the LLM call's metadata and the rewrite brief. */
  shotId: string;
  reservationId?: string;
  analysisModelId?: AnalysisModelId;
  /** The turns to tighten, with the indexes the merge happens on. */
  lines: readonly VoicedDialogueLine[];
  measuredSeconds: number;
  targetSeconds: number;
  /** Durable step name. */
  name: string;
};

export async function shortenDialogueLines(
  step: WorkflowStep,
  args: ShortenDialogueArgs
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
