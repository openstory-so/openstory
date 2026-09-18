/**
 * Synthesise a shot’s dialogue as one ElevenLabs Text to Dialogue clip
 * (#1554). Multiple speakers act the conversation in a single take — not
 * one TTS file per line. Parked in R2 and bound as `@Audio1` / `Audio 1`.
 *
 * `convertWithTimestamps` rather than `convert` (#1651): the alignment it
 * returns is how we learn where speech ends, which is what lets the trailing
 * silence come off and the duration guard compare against a real number. It
 * answers base64 JSON instead of a stream, so the whole take is buffered
 * either way — the caller uploads inside its own step so only the small
 * `{ url, path }` record crosses the Workflows checkpoint (#1645).
 */

import { generateId } from '@/platform/id';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { uploadFile } from '#storage';
import { createElevenLabsSdk } from '@/models/server/elevenlabs-config';
import {
  DIALOGUE_CLIP_TOKEN,
  DIALOGUE_TTS_MODEL,
  DIALOGUE_TTS_STABILITY,
  dialogueClipSourceKey,
  spokenLinesFor,
  ttsUtterance,
  type VoicedDialogueLine,
} from '@/motion/dialogue-tts';
import {
  padWavToMinDuration,
  trimWavTrailingSilence,
  wavDurationSeconds,
} from './pad-dialogue-audio';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import type { ReferenceImageDescription } from '@/stills/reference-image-prompt';

export type SynthesizeDialogueInput = {
  apiKey: string;
  teamId: string;
  sequenceId: string;
  shotId: string;
  /** The turns to speak. A rewritten take (#1651) passes its shortened text. */
  lines: readonly VoicedDialogueLine[];
  /**
   * The lines as AUTHORED, which key the clip (#1651). Defaults to `lines`.
   * A rewrite must not move `sourceKey`: it is what motion, staleness and the
   * manifest's `audioSourceKey` match on, and a moved key would re-synthesise
   * the take on every later read. The delivered wording rides `spokenLines`.
   */
  keyLines?: readonly VoicedDialogueLine[];
  /**
   * Provider per-file floor (H3 Max 2s, Seedance 2.5 1.8s). A short
   * one-liner is padded with silence so the clip still rides as a reference.
   */
  minDurationSeconds?: number;
};

export type SynthesizedDialogueClip = {
  clip: MotionAudioClip;
  characterCount: number;
  /**
   * Where the provider's alignment says the last character is spoken, or null
   * when it returned none. NOT the clip length — trailing silence and encoder
   * padding sit after it, which is why `clip.durationSeconds` (measured off
   * the WAV) is what the duration guard reads.
   */
  speechEndSeconds: number | null;
};

export async function synthesizeDialogueClip(
  input: SynthesizeDialogueInput
): Promise<SynthesizedDialogueClip> {
  if (input.lines.length === 0) {
    throw new Error('synthesizeDialogueClip requires at least one line');
  }
  const turns = input.lines.map((line) => ({
    text: ttsUtterance(line.text, line.tone),
    voiceId: line.voiceId,
  }));
  const characterCount = turns.reduce((sum, turn) => sum + turn.text.length, 0);

  const client = await createElevenLabsSdk(input.apiKey);
  const result = await client.textToDialogue.convertWithTimestamps({
    modelId: DIALOGUE_TTS_MODEL,
    outputFormat: 'wav_44100',
    inputs: turns,
    settings: { stability: DIALOGUE_TTS_STABILITY },
  });
  let wav = decodeBase64(result.audioBase64);
  if (wav.byteLength === 0) {
    throw new Error('Dialogue TTS returned an empty audio body');
  }
  if (wavDurationSeconds(wav) == null) {
    throw new Error('Dialogue TTS returned audio that is not a PCM WAV');
  }

  // Trailing silence first, so the guard and the stored length both describe
  // the file as it will be submitted. `speechEndSeconds` only ever moves the
  // trim point LATER (see `trimWavTrailingSilence`), so an absent, empty or
  // nonsensical alignment cannot cut speech — and cannot skip the guard
  // either, because the duration comes off the WAV, not the alignment.
  const speechEndSeconds = speechEndFrom(result);
  let { bytes, durationSeconds } = trimWavTrailingSilence(
    wav,
    speechEndSeconds
  );
  wav = bytes;
  const min = input.minDurationSeconds;
  if (min != null) {
    const padded = padWavToMinDuration(wav, min);
    wav = padded.bytes;
    durationSeconds = padded.durationSeconds;
  }

  const keyLines = input.keyLines ?? input.lines;
  const spokenLines = spokenLinesFor(keyLines, input.lines);
  const id = generateId();
  const path = `${input.teamId}/${input.sequenceId}/${input.shotId}/${id}.wav`;
  const uploaded = await uploadFile(STORAGE_BUCKETS.AUDIO, path, wav, {
    contentType: 'audio/wav',
    upsert: true,
  });

  return {
    clip: {
      id,
      url: uploaded.publicUrl,
      token: DIALOGUE_CLIP_TOKEN,
      durationSeconds,
      sourceKey: dialogueClipSourceKey(keyLines),
      ...(spokenLines && { spokenLines }),
    },
    characterCount,
    speechEndSeconds,
  };
}

/**
 * Last moment any character is spoken. Voice segments first (one per turn,
 * so the last one's end is the conversation's end); the character alignment
 * is the fallback for a response that carried no segments. Null when both
 * are missing, empty, or not finite numbers — an alignment we cannot read is
 * no alignment, never a pass.
 */
export function speechEndFrom(result: {
  voiceSegments?: Array<{ endTimeSeconds?: number }> | null;
  alignment?: { characterEndTimesSeconds?: number[] | null } | null;
  normalizedAlignment?: { characterEndTimesSeconds?: number[] | null } | null;
}): number | null {
  const ends = [
    ...(result.voiceSegments ?? []).map((segment) => segment.endTimeSeconds),
    ...(result.alignment?.characterEndTimesSeconds ?? []),
    ...(result.normalizedAlignment?.characterEndTimesSeconds ?? []),
  ].filter(
    (value): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0
  );
  return ends.length > 0 ? Math.max(...ends) : null;
}

/** Append the conversation clip as an audio reference the r2v binder knows. */
export function dialogueClipsAsReferences(
  clips: readonly MotionAudioClip[]
): ReferenceImageDescription[] {
  return clips.map((clip) => ({
    referenceImageUrl: clip.url,
    description: `Dialogue recorded as ${clip.token}`,
    kind: 'audio' as const,
    role: 'character' as const,
    token: clip.token,
    durationSeconds: clip.durationSeconds,
  }));
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** One turn of a scene take, as the recorder needs it. */
export type DialogueTakeLine = {
  /** Index into the scene's dialogue lines — what the take's segments name. */
  lineIndex: number;
  shotId: string;
  voiceId: string;
  text: string;
  tone: string;
};

export type DialogueTakeChunk = {
  /** `<bucket>/<path>`, so the next step can read the bytes back (#1645). */
  storageKey: string;
  url: string;
  durationSeconds: number;
  characterCount: number;
  /** Per-turn times, relative to this chunk's own start. */
  segments: Array<{
    lineIndex: number;
    shotId: string;
    startSeconds: number;
    endSeconds: number;
  }>;
};

/**
 * Record one chunk of a scene's dialogue take (#1657) and park it in R2.
 *
 * The whole scene is acted in ONE call wherever it fits, so every turn is
 * delivered in context; a long scene is split at a shot boundary by the
 * caller and joined by `concatWavs`. Untrimmed and unpadded: the take is the
 * recording as made, and trimming belongs to each shot's slice.
 *
 * Only the record below crosses the step boundary — the WAV rides R2, never
 * the Workflows checkpoint (#1645, 1 MiB).
 */
export async function synthesizeDialogueTakeChunk(input: {
  apiKey: string;
  teamId: string;
  sequenceId: string;
  sceneId: string;
  lines: readonly DialogueTakeLine[];
}): Promise<DialogueTakeChunk> {
  if (input.lines.length === 0) {
    throw new Error('synthesizeDialogueTakeChunk requires at least one line');
  }
  const turns = input.lines.map((line) => ({
    text: ttsUtterance(line.text, line.tone),
    voiceId: line.voiceId,
  }));
  const characterCount = turns.reduce((sum, turn) => sum + turn.text.length, 0);

  const client = await createElevenLabsSdk(input.apiKey);
  const result = await client.textToDialogue.convertWithTimestamps({
    modelId: DIALOGUE_TTS_MODEL,
    outputFormat: 'wav_44100',
    inputs: turns,
    settings: { stability: DIALOGUE_TTS_STABILITY },
  });
  const wav = decodeBase64(result.audioBase64);
  if (wav.byteLength === 0) {
    throw new Error('Dialogue TTS returned an empty audio body');
  }
  const durationSeconds = wavDurationSeconds(wav);
  if (durationSeconds == null) {
    throw new Error('Dialogue TTS returned audio that is not a PCM WAV');
  }

  const path = `${input.teamId}/${input.sequenceId}/${input.sceneId}/${generateId()}.wav`;
  const uploaded = await uploadFile(STORAGE_BUCKETS.AUDIO, path, wav, {
    contentType: 'audio/wav',
    upsert: true,
  });

  return {
    storageKey: uploaded.fullPath,
    url: uploaded.publicUrl,
    durationSeconds,
    characterCount,
    segments: takeSegments(input.lines, result, durationSeconds),
  };
}

/**
 * Where each turn sits in the chunk. `dialogueInputIndex` is the position in
 * the `inputs` we sent, so it maps straight back onto the lines; a turn
 * reported as several segments spans the outermost of them.
 *
 * A response with no segments can still be sliced when every line belongs to
 * ONE shot — there is nothing to cut, the whole chunk is that shot's. Across
 * shots it cannot, and that fails here rather than handing some shot a clip
 * of someone else's lines.
 */
function takeSegments(
  lines: readonly DialogueTakeLine[],
  result: { voiceSegments?: Array<VoiceSegmentTimes> | null },
  durationSeconds: number
): DialogueTakeChunk['segments'] {
  const spans = new Map<number, { start: number; end: number }>();
  for (const segment of result.voiceSegments ?? []) {
    const at = segment.dialogueInputIndex;
    const start = segment.startTimeSeconds;
    const end = segment.endTimeSeconds;
    if (
      typeof at !== 'number' ||
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      !Number.isFinite(start) ||
      !Number.isFinite(end)
    ) {
      continue;
    }
    const existing = spans.get(at);
    spans.set(at, {
      start: Math.min(existing?.start ?? start, start),
      end: Math.max(existing?.end ?? end, end),
    });
  }
  if (spans.size === 0) {
    const shotIds = new Set(lines.map((line) => line.shotId));
    if (shotIds.size > 1) {
      throw new Error(
        `Dialogue TTS returned no voice segments for a take spanning ${shotIds.size} shots — there is no way to cut each shot's clip`
      );
    }
    return lines.map((line) => ({
      lineIndex: line.lineIndex,
      shotId: line.shotId,
      startSeconds: 0,
      endSeconds: durationSeconds,
    }));
  }
  return lines.map((line, at) => {
    const span = spans.get(at);
    if (!span) {
      throw new Error(
        `Dialogue TTS reported no timing for turn ${at + 1}/${lines.length} of the take`
      );
    }
    return {
      lineIndex: line.lineIndex,
      shotId: line.shotId,
      startSeconds: Math.max(0, span.start),
      endSeconds: Math.min(durationSeconds, Math.max(span.start, span.end)),
    };
  });
}

type VoiceSegmentTimes = {
  dialogueInputIndex?: number;
  startTimeSeconds?: number;
  endTimeSeconds?: number;
};
