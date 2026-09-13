/**
 * Client-safe dialogue-audio helpers (#1554): speaker→voice, the shared
 * `DIALOGUE` token, v3 tone tags, picker sentinels, and the shape-stable
 * hash body.
 */

import { matchSpeaker } from '@/cast/voice';
import {
  getMotionReferenceEndpoint,
  type ImageToVideoModel,
} from '@/models/models';
import type {
  DialogueLine,
  MotionDialogue,
} from '@/shots/scene-analysis.schema';

/** ElevenLabs model every dialogue clip is synthesised with. */
export const DIALOGUE_TTS_MODEL = 'eleven_v3';

/**
 * One token for the whole shot conversation so Text to Dialogue’s single
 * clip binds as `@Audio1` / `Audio 1` on every voiced line.
 */
export const DIALOGUE_CLIP_TOKEN = 'DIALOGUE';

/**
 * Persisted on a line the user opted out of the generated take: the video
 * model invents the voice. Not an element token — matching, assembly and
 * orphan warnings must ignore it.
 */
export const VIDEO_MODEL_VOICE_TOKEN = '__video_model__';

/** UI-only picker value; persist as no `voiceToken` so Text to Dialogue still runs. */
export const GENERATED_VOICE = '__generated__';

/** True when `voiceToken` names a user-uploaded audio element. */
export function isElementVoiceToken(
  token: string | null | undefined
): token is string {
  return (
    Boolean(token) &&
    token !== DIALOGUE_CLIP_TOKEN &&
    token !== VIDEO_MODEL_VOICE_TOKEN &&
    token !== GENERATED_VOICE
  );
}

function tokenToPickerValue(voiceToken: string | undefined): string {
  if (!voiceToken || voiceToken === DIALOGUE_CLIP_TOKEN) return GENERATED_VOICE;
  if (voiceToken === VIDEO_MODEL_VOICE_TOKEN) return VIDEO_MODEL_VOICE_TOKEN;
  return voiceToken;
}

/** One value for the shot. Mixed legacy per-line bindings read as Generated. */
export function shotPickerValue(
  lines: readonly { voiceToken?: string }[]
): string {
  const first = tokenToPickerValue(lines[0]?.voiceToken);
  return lines.every((line) => tokenToPickerValue(line.voiceToken) === first)
    ? first
    : GENERATED_VOICE;
}

export function persistToken(value: string): string | undefined {
  if (value === GENERATED_VOICE) return undefined;
  if (value === VIDEO_MODEL_VOICE_TOKEN) return VIDEO_MODEL_VOICE_TOKEN;
  return value;
}

/** Element tokens on the lines that no longer exist in the library. */
export function orphanedVoiceTokens(
  lines: readonly { voiceToken?: string }[],
  liveTokens: ReadonlySet<string>
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const token = line.voiceToken;
    if (!isElementVoiceToken(token) || liveTokens.has(token) || seen.has(token))
      continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/** True when this model’s reference-to-video route takes uploaded audio. */
export function modelTakesDialogueAudio(model: ImageToVideoModel): boolean {
  return (getMotionReferenceEndpoint(model)?.maxAudio ?? 0) > 0;
}

/**
 * Pad floor for a References-stage clip so the strictest selected model
 * (H3 Max 2s) can attach it. Defaults to 2s when nothing publishes a min.
 */
export function dialogueAudioMinSeconds(
  models: readonly ImageToVideoModel[]
): number {
  let min = 2;
  for (const model of models) {
    const floor = getMotionReferenceEndpoint(model)?.audioSeconds?.min;
    if (floor != null && floor > min) min = floor;
  }
  return min;
}

export type VoiceCharacter = {
  name: string;
  voiceId?: string | null;
  voiceOnly?: boolean;
};

/**
 * One turn in the shot's Text to Dialogue conversation. Snapshotted onto
 * the References child and, as a motion fallback, onto `voicedLines`.
 */
export type VoicedDialogueLine = {
  /** Index in the shot's dialogue array — maps the clip token onto that line. */
  index: number;
  /** Always `DIALOGUE_CLIP_TOKEN`; one conversation clip binds as `@Audio1`. */
  token: string;
  voiceId: string;
  text: string;
  tone: string;
  ttsModel: string;
  character: string;
};

/** The slice of a voiced line that the motion-prompt hash consumes. */
export type DialogueVoiceHashInput = {
  voiceId: string;
  line: string;
  tone: string;
  ttsModel: string;
};

/**
 * Map a free-text tone onto an eleven_v3 audio tag. The tone is lowercased
 * and wrapped (`whispered` → `[whispered]`); unknown tones are not rewritten
 * to v3's example vocabulary. Empty / punctuation-only tones produce no tag.
 */
export function toneToV3AudioTag(tone: string): string | null {
  const cleaned = tone
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  const words = cleaned.split(' ').slice(0, 3).join(' ');
  return `[${words}]`;
}

/** Text ElevenLabs should speak: optional v3 tag, then the line. */
export function ttsUtterance(text: string, tone: string): string {
  const tag = toneToV3AudioTag(tone);
  const line = text.trim();
  return tag ? `${tag} ${line}` : line;
}

/**
 * Compatibility token for pre-conversation-clip rows (`SARAH_L1`). Live
 * assembly and TTS agree on `DIALOGUE_CLIP_TOKEN`.
 */
export function dialogueTtsToken(character: string, index: number): string {
  const slug = character
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return `${slug || 'VOICE'}_L${index + 1}`;
}

/**
 * Dialogue lines whose speaker has a designed ElevenLabs voice and no
 * user-bound audio element (`voiceToken`). Those elements already ride as
 * `@AudioN`; synthesising over them would double the line. A line opted
 * into {@link VIDEO_MODEL_VOICE_TOKEN} is skipped the same way.
 */
export function voicedDialogueLines(
  dialogue: MotionDialogue | null | undefined,
  characters: readonly VoiceCharacter[]
): VoicedDialogueLine[] {
  if (!dialogue?.presence || dialogue.lines.length === 0) return [];
  const withVoices = characters.filter(
    (character): character is VoiceCharacter & { voiceId: string } =>
      typeof character.voiceId === 'string' && character.voiceId.length > 0
  );
  if (withVoices.length === 0) return [];

  const voiced: VoicedDialogueLine[] = [];
  dialogue.lines.forEach((line, index) => {
    if (line.voiceToken) return;
    const text = line.line.trim();
    if (!text) return;
    const match = matchSpeaker(line.character, withVoices);
    if (!match?.voiceId) return;
    voiced.push({
      index,
      token: DIALOGUE_CLIP_TOKEN,
      voiceId: match.voiceId,
      text,
      tone: line.tone ?? '',
      ttsModel: DIALOGUE_TTS_MODEL,
      character: line.character,
    });
  });
  return voiced;
}

/** Stable key stamped on a synthesised clip so motion can reuse it. */
export function dialogueClipSourceKey(
  lines: readonly VoicedDialogueLine[]
): string {
  const body = dialogueVoicesHashBody(
    lines.map((line) => ({
      voiceId: line.voiceId,
      line: line.text,
      tone: line.tone,
      ttsModel: line.ttsModel,
    }))
  );
  if (!body) return '';
  return body
    .map(
      (voice) =>
        `${voice.voiceId}\t${voice.line}\t${voice.tone}\t${voice.ttsModel}`
    )
    .join('\n');
}

function clipSourceKey(clip: unknown): string | undefined {
  if (clip === null || typeof clip !== 'object' || !('sourceKey' in clip)) {
    return undefined;
  }
  const key = clip.sourceKey;
  return typeof key === 'string' ? key : undefined;
}

/**
 * Stored clips that were synthesised from exactly these lines. Empty when
 * the clip is missing, was minted without a key, or the lines/voices moved.
 */
export function matchingDialogueClips<T>(
  clips: readonly T[] | null | undefined,
  lines: readonly VoicedDialogueLine[]
): T[] {
  if (!clips?.length || lines.length === 0) return [];
  const key = dialogueClipSourceKey(lines);
  if (!key) return [];
  return clips.every((clip) => clipSourceKey(clip) === key) ? [...clips] : [];
}

export function ttsCharacterCount(
  lines: readonly VoicedDialogueLine[]
): number {
  return lines.reduce(
    (sum, line) => sum + ttsUtterance(line.text, line.tone).length,
    0
  );
}

/** Copy TTS tokens onto the matching lines so `spokenLine` binds them. */
export function withVoicedLineTokens(
  dialogue: MotionDialogue | null | undefined,
  voiced: readonly VoicedDialogueLine[]
): MotionDialogue | null | undefined {
  if (!dialogue || voiced.length === 0) return dialogue;
  const byIndex = new Map(voiced.map((line) => [line.index, line]));
  return {
    ...dialogue,
    lines: dialogue.lines.map((line, index) => {
      const voicedLine = byIndex.get(index);
      if (!voicedLine || line.voiceToken) return line;
      return { ...line, voiceToken: voicedLine.token } satisfies DialogueLine;
    }),
  };
}

/**
 * Shape-stable hash body: omitted / empty hashes identically, so no stored
 * digest moves for a voiceless shot. Sorted so speaker order in the scene
 * cannot fork the digest.
 */
export function dialogueVoicesHashBody(
  voices: readonly DialogueVoiceHashInput[] | undefined
): DialogueVoiceHashInput[] | undefined {
  if (!voices?.length) return undefined;
  const projected = voices
    .map((voice) => ({
      voiceId: voice.voiceId.trim(),
      line: voice.line.trim(),
      tone: voice.tone.trim(),
      ttsModel: voice.ttsModel.trim(),
    }))
    .filter((voice) => voice.voiceId && voice.line && voice.ttsModel)
    .sort((a, b) => {
      const byVoice = a.voiceId.localeCompare(b.voiceId);
      if (byVoice !== 0) return byVoice;
      const byLine = a.line.localeCompare(b.line);
      if (byLine !== 0) return byLine;
      const byTone = a.tone.localeCompare(b.tone);
      return byTone !== 0 ? byTone : a.ttsModel.localeCompare(b.ttsModel);
    });
  return projected.length > 0 ? projected : undefined;
}

export function dialogueVoicesForHash(
  dialogue: MotionDialogue | null | undefined,
  characters: readonly VoiceCharacter[]
): DialogueVoiceHashInput[] | undefined {
  return dialogueVoicesHashBody(
    voicedDialogueLines(dialogue, characters).map((line) => ({
      voiceId: line.voiceId,
      line: line.text,
      tone: line.tone,
      ttsModel: line.ttsModel,
    }))
  );
}
