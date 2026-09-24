/**
 * Client-safe dialogue-audio helpers (#1554): speaker→voice, the shared
 * `DIALOGUE` token, v3 tone tags, picker sentinels, and the shape-stable
 * hash body.
 */

import { isSeedVoiceId, SEED_AUDIO_MODEL } from '@/cast/seed-voice';
import { matchSpeaker } from '@/cast/voice';
import {
  getMotionReferenceEndpoint,
  type ImageToVideoModel,
} from '@/models/models';
import { durationGridForModel } from '@/motion/model-capabilities';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import type {
  DialogueLine,
  MotionDialogue,
} from '@/shots/scene-analysis.schema';

/** ElevenLabs model an ElevenLabs voice's dialogue is recorded with (a Seed voice's is `SEED_AUDIO_MODEL`). */
export const DIALOGUE_TTS_MODEL = 'eleven_v3';

/** A dialogue model as the readings list names it. */
export function dialogueModelLabel(model: string): string {
  if (model === SEED_AUDIO_MODEL) return 'Seed Audio';
  if (model === DIALOGUE_TTS_MODEL) return 'ElevenLabs v3';
  return model;
}

/**
 * Text-to-Dialogue stability (0–1). Default 0.5 is a bit monotone for
 * acted conversation; lower opens emotional range without going erratic.
 */
export const DIALOGUE_TTS_STABILITY = 0.35;

/**
 * One token for the whole shot conversation so Text to Dialogue’s single
 * clip binds as `@Audio1` / `Audio 1` on every voiced line.
 */
export const DIALOGUE_CLIP_TOKEN = 'DIALOGUE';

/**
 * The clip a shot holds for a section of a recording (#1657). The one place
 * that says a generated dialogue clip's `id` IS its section id.
 */
export function sectionClip(
  section: {
    id: string;
    recordingId: string;
    sourceKey: string;
    spokenLines: MotionAudioClip['spokenLines'] | null;
  },
  cut: { url: string; durationSeconds: number }
): MotionAudioClip {
  return {
    id: section.id,
    url: cut.url,
    token: DIALOGUE_CLIP_TOKEN,
    durationSeconds: cut.durationSeconds,
    sourceKey: section.sourceKey,
    recordingId: section.recordingId,
    ...(section.spokenLines && { spokenLines: section.spokenLines }),
  };
}

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

/**
 * Headroom under a hard cap (#1651). An alignment end time measures the last
 * spoken character, not the file: trailing silence and encoder padding land
 * after it, and a provider rounds its own way (H3 Max reported 1.959s on a
 * clip we measured at 2). So the fit target is the cap minus this, which is
 * where the issue's 14.8s for a 15s limit comes from.
 */
export const DIALOGUE_FIT_SLACK_SECONDS = 0.2;

/**
 * Planning heuristic only (#1651): roughly what eleven_v3 speaks in a second,
 * so 15s budgets ~30 words. It sizes the shot-list rule and the rewrite brief
 * — it is never evidence that a take fits. Only the measured file is that.
 */
export const DIALOGUE_WORDS_PER_SECOND = 2;

/** Used when a model publishes no grid and no audio window. H3 Max's number. */
const DIALOGUE_FALLBACK_MAX_SECONDS = 15;

/**
 * Longest dialogue take every selected model can carry (#1651). Two ceilings,
 * whichever is lower: the model's reference-audio window (H3 Max 15s) and the
 * longest clip its duration grid renders — the clip is stretched to cover the
 * audio (`raiseShotDurationToCoverAudio`) and cannot stretch past the grid, so
 * audio beyond it has nowhere to play. Min across models, like
 * {@link dialogueAudioMinSeconds} takes the max, so one take rides on all of
 * them.
 */
export function dialogueAudioMaxSeconds(
  models: readonly ImageToVideoModel[]
): number {
  const ceilings = models.map((model) => {
    const grid = durationGridForModel(model);
    const gridMax =
      grid.length > 0 ? Math.max(...grid) : DIALOGUE_FALLBACK_MAX_SECONDS;
    const audio = getMotionReferenceEndpoint(model)?.audioSeconds;
    return Math.min(gridMax, audio?.max ?? audio?.maxCombined ?? gridMax);
  });
  return ceilings.length > 0
    ? Math.min(...ceilings)
    : DIALOGUE_FALLBACK_MAX_SECONDS;
}

/**
 * What one shot's take has to fit inside (#1651). Two numbers, because they
 * answer different questions:
 *
 * - `limitSeconds` is the refusal line — past it no model can carry the file
 *   at all, so a take still over it after the bounded rewrites fails the shot.
 * - `targetSeconds` is what a rewrite is asked for: the SHOT's own length when
 *   that is shorter, so the take fits the cut instead of stretching it. Speech
 *   between the two is kept (the clip stretches, #1554) rather than rewritten —
 *   raising a 5s shot to 6s is a pacing cost, not a broken render.
 */
export function dialogueFitBudget(input: {
  shotSeconds?: number | null;
  maxSeconds: number;
}): { targetSeconds: number; limitSeconds: number } {
  const limitSeconds = Math.max(
    1,
    input.maxSeconds - DIALOGUE_FIT_SLACK_SECONDS
  );
  const shot = input.shotSeconds;
  const targetSeconds =
    shot != null && Number.isFinite(shot) && shot > 0
      ? Math.max(1, Math.min(limitSeconds, shot))
      : limitSeconds;
  return { targetSeconds, limitSeconds };
}

/** Spoken words that fit `seconds`, as a brief for the rewrite. */
export function dialogueWordBudget(seconds: number): number {
  return Math.max(3, Math.floor(seconds * DIALOGUE_WORDS_PER_SECOND));
}

/** Words across a conversation — audio tags are not spoken, so not counted. */
export function spokenWordCount(lines: readonly { text: string }[]): number {
  return lines.reduce(
    (sum, line) => sum + line.text.trim().split(/\s+/).filter(Boolean).length,
    0
  );
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
      ttsModel: isSeedVoiceId(match.voiceId)
        ? SEED_AUDIO_MODEL
        : DIALOGUE_TTS_MODEL,
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

/**
 * Bound-audio identity for a video manifest (`VideoManifestEntry.audioSourceKey`).
 * Null when voiceless — the hasher omits it so stored voiceless digests do not
 * move. Voice ids live here, not on the motion-prompt hash: the LLM never
 * sees them; the clip binds them like a character sheet.
 */
export function audioSourceKeyFromVoicedLines(
  lines: readonly VoicedDialogueLine[]
): string | null {
  const key = dialogueClipSourceKey(lines);
  return key === '' ? null : key;
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
  lines: readonly Pick<VoicedDialogueLine, 'text' | 'tone'>[]
): number {
  return lines.reduce(
    (sum, line) => sum + ttsUtterance(line.text, line.tone).length,
    0
  );
}

/**
 * Copy TTS tokens onto the matching lines so `spokenLine` binds them — and
 * the voiced TEXT with them, which is normally identical and differs only when
 * a take was rewritten to fit (#1651). The prompt drives lip movement, so it
 * has to say what the bound audio says.
 */
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
      return {
        ...line,
        line: voicedLine.text,
        voiceToken: voicedLine.token,
      } satisfies DialogueLine;
    }),
  };
}

/**
 * The text a stored clip actually SPOKE (#1651). A take rewritten to fit its
 * shot records the delivered wording as `spokenLines`; the clip's `sourceKey`
 * still keys the lines as authored, so matching, staleness and the manifest's
 * `audioSourceKey` do not move and nothing re-synthesises. Reading it back is
 * what keeps the motion prompt saying what the audio says.
 *
 * A no-op for every clip minted without it — the overwhelming case, where the
 * authored text IS the delivered text.
 */
export function withSpokenText(
  lines: readonly VoicedDialogueLine[],
  clips:
    | readonly { spokenLines?: { index: number; text: string }[] }[]
    | null
    | undefined
): VoicedDialogueLine[] {
  const spoken = new Map<number, string>();
  for (const clip of clips ?? []) {
    for (const line of clip.spokenLines ?? []) {
      const text = line.text.trim();
      if (text) spoken.set(line.index, text);
    }
  }
  if (spoken.size === 0) return [...lines];
  return lines.map((line) => {
    const text = spoken.get(line.index);
    return text && text !== line.text ? { ...line, text } : line;
  });
}

/** Per-line delivered text for a clip, omitted when nothing was rewritten. */
export function spokenLinesFor(
  authored: readonly VoicedDialogueLine[],
  delivered: readonly VoicedDialogueLine[]
): { index: number; text: string }[] | undefined {
  const byIndex = new Map(authored.map((line) => [line.index, line.text]));
  const changed = delivered.filter(
    (line) => byIndex.get(line.index) !== line.text
  );
  return changed.length > 0
    ? changed.map((line) => ({ index: line.index, text: line.text }))
    : undefined;
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
