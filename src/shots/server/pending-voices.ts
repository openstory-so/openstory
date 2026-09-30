/**
 * Voices a continue designs in its own references wave (#1818). The plan is
 * built at the click, before those voices exist, so their speakers ride the
 * plan under a placeholder id; once the wave lands, the run swaps each
 * placeholder for the voice it made. A speaker whose voice did not land holds
 * every shot that needs it — a clip is never rendered without its voice.
 */

import { ttsModelForVoice, voicedDialogueLines } from '@/motion/dialogue-tts';
import type { VoicedDialogueLine } from '@/motion/dialogue-tts';
import type { UpdateStalePlan } from './update-stale-plan';

const PENDING_VOICE_PREFIX = 'pending-voice:';

export function pendingVoiceId(characterId: string): string {
  return `${PENDING_VOICE_PREFIX}${characterId}`;
}

type Bound<L> = { line: L } | { unvoiced: true };

function bindLine<L extends VoicedDialogueLine>(
  line: L,
  designed: Readonly<Record<string, string>>
): Bound<L> {
  if (!line.voiceId.startsWith(PENDING_VOICE_PREFIX)) return { line };
  const voiceId = designed[line.voiceId.slice(PENDING_VOICE_PREFIX.length)];
  if (!voiceId) return { unvoiced: true };
  return { line: { ...line, voiceId, ttsModel: ttsModelForVoice(voiceId) } };
}

function bindLines<L extends VoicedDialogueLine>(
  lines: readonly L[],
  designed: Readonly<Record<string, string>>
): L[] | null {
  const out: L[] = [];
  for (const line of lines) {
    const bound = bindLine(line, designed);
    if ('unvoiced' in bound) return null;
    out.push(bound.line);
  }
  return out;
}

/**
 * The plan with every placeholder bound to `designed` (character id → the
 * voice id the wave made), plus the shots held because a voice they speak in
 * did not land. A scene recording that needs a missing voice is dropped
 * whole: it is one conversation, and recording it without a speaker would
 * hand every shot in it the wrong audio.
 */
export function bindPendingVoices(
  plan: UpdateStalePlan,
  designed: Readonly<Record<string, string>>
): { plan: UpdateStalePlan; unvoicedShotIds: Set<string> } {
  const unvoicedShotIds = new Set<string>();
  const characterVoices = plan.characterVoices.flatMap((character) => {
    if (!character.voiceId.startsWith(PENDING_VOICE_PREFIX)) return [character];
    const voiceId =
      designed[character.voiceId.slice(PENDING_VOICE_PREFIX.length)];
    return voiceId ? [{ ...character, voiceId }] : [];
  });
  const scenes = (plan.dialogueSpeech?.scenes ?? []).flatMap((job) => {
    const voiced = bindLines(job.voiced, designed);
    if (voiced) return [{ ...job, voiced }];
    for (const line of job.voiced) unvoicedShotIds.add(line.shotId);
    return [];
  });

  const targets = plan.targets.map((target) => {
    // Its own lines, matched to speakers exactly as the render matches them.
    // A shot that says nothing has no voice to wait for.
    const own = voicedDialogueLines(target.dialogue, plan.characterVoices);
    if (own.length === 0) return target;
    const dialogueContext = bindLines(target.dialogueContext, designed);
    if (!bindLines(own, designed) || !dialogueContext) {
      unvoicedShotIds.add(target.shotId);
      return target;
    }
    return { ...target, dialogueContext };
  });

  return {
    plan: {
      ...plan,
      characterVoices,
      dialogueSpeech:
        plan.dialogueSpeech && scenes.length > 0
          ? { ...plan.dialogueSpeech, scenes }
          : null,
      targets,
    },
    unvoicedShotIds,
  };
}
