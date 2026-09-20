/**
 * Record a conversation with ElevenLabs Text to Dialogue (#1554, #1657).
 * Multiple speakers act the turns against each other in ONE call — not one
 * TTS file per line — and the whole file is parked in R2 exactly as the
 * provider returned it. Each shot the call spoke gets a time range of it;
 * nothing is cut here (`cutAudioSection` does that, from R2, per shot).
 *
 * `convertWithTimestamps` rather than `convert` (#1651): the voice segments
 * it returns are where each turn sits, which is what the per-shot ranges are
 * built from, and how we learn where speech ends so the trailing silence can
 * come off. It answers base64 JSON instead of a stream, so the recording is
 * buffered once either way — the caller runs this inside its own step so only
 * the small record below crosses the Workflows checkpoint (#1645, 1 MiB).
 */

import { generateId } from '@/platform/id';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { uploadFile } from '#storage';
import { createElevenLabsSdk } from '@/models/server/elevenlabs-config';
import {
  DIALOGUE_TTS_MODEL,
  DIALOGUE_TTS_STABILITY,
  ttsUtterance,
} from '@/motion/dialogue-tts';
import {
  parseWavHeader,
  trimmedEndSeconds,
  wavDurationSeconds,
} from './pad-dialogue-audio';
import type {
  DialogueRecordingTurn,
  MotionAudioClip,
} from '@/platform/server/db/schema';
import type { ReferenceImageDescription } from '@/stills/reference-image-prompt';

/** One turn to speak. `index` is shot-relative, as everywhere (#1657). */
export type DialogueCallLine = {
  shotId: string;
  index: number;
  voiceId: string;
  text: string;
  tone: string;
};

export type RecordedDialogueCall = {
  /** Minted in here, inside the caller's step, so a replay keeps the id. */
  recordingId: string;
  /** `<bucket>/<path>` — what `cutAudioSection` ranges into. */
  storageKey: string;
  url: string;
  durationSeconds: number;
  characterCount: number;
  /** Where each turn sits in the recording, in the order it was sent. */
  turns: DialogueRecordingTurn[];
  /** Each shot's range of the recording, its trailing silence already off. */
  windows: Array<{ shotId: string; fromSeconds: number; toSeconds: number }>;
};

/**
 * One Text to Dialogue call, parked whole in R2.
 *
 * Memory: the provider's base64 (4/3 × the WAV) and the decoded WAV are the
 * only two copies. The decode goes slice by slice into a preallocated buffer
 * — a whole-file `atob` would add a third, a binary string as long as the
 * WAV — and the trailing silence is MEASURED in place, not trimmed into a
 * new buffer. The WAV is handed to `r2.put` as it is.
 */
export async function recordDialogueCall(input: {
  apiKey: string;
  teamId: string;
  sequenceId: string;
  lines: readonly DialogueCallLine[];
}): Promise<RecordedDialogueCall> {
  if (input.lines.length === 0) {
    throw new Error('recordDialogueCall requires at least one line');
  }
  const inputs = input.lines.map((line) => ({
    text: ttsUtterance(line.text, line.tone),
    voiceId: line.voiceId,
  }));
  const characterCount = inputs.reduce(
    (sum, turn) => sum + turn.text.length,
    0
  );

  const client = await createElevenLabsSdk(input.apiKey);
  const result = await client.textToDialogue.convertWithTimestamps({
    modelId: DIALOGUE_TTS_MODEL,
    outputFormat: 'wav_44100',
    inputs,
    settings: { stability: DIALOGUE_TTS_STABILITY },
  });
  const wav = decodeBase64(result.audioBase64);
  if (wav.byteLength === 0) {
    throw new Error('Dialogue TTS returned an empty audio body');
  }
  honestDataSize(wav);
  const durationSeconds = wavDurationSeconds(wav);
  if (durationSeconds == null) {
    throw new Error('Dialogue TTS returned audio that is not a PCM WAV');
  }

  const turns = recordingTurns(input.lines, result, durationSeconds);
  // `speechEnd` only ever moves a range's end LATER (see `trimmedEndSeconds`),
  // so a short-reporting segment cannot cut a word.
  const windows = shotSliceWindows(turns, durationSeconds).map((window) => ({
    shotId: window.shotId,
    fromSeconds: window.from,
    toSeconds: trimmedEndSeconds(wav, window.from, window.to, window.speechEnd),
  }));

  const recordingId = generateId();
  const uploaded = await uploadFile(
    STORAGE_BUCKETS.AUDIO,
    `${input.teamId}/${input.sequenceId}/dialogue-recordings/${recordingId}.wav`,
    wav,
    { contentType: 'audio/wav', upsert: true }
  );

  return {
    recordingId,
    storageKey: uploaded.fullPath,
    url: uploaded.publicUrl,
    durationSeconds,
    characterCount,
    turns,
    windows,
  };
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

/** base64 characters decoded per `atob` — a multiple of 4, so no group is split. */
const BASE64_SLICE_CHARS = 4 * 8192;

/**
 * Decode straight into one preallocated buffer, a slice at a time. A
 * whole-file `atob` builds a binary string as long as the audio before a
 * single byte is copied out of it.
 */
export function decodeBase64(input: string): Uint8Array<ArrayBuffer> {
  // `atob` skips whitespace, which would shift a slice off its 4-character
  // groups. Providers do not send any; the scan is what makes that safe to
  // rely on, and the copy is only paid when it is wrong.
  const base64 = /\s/.test(input) ? input.replace(/\s+/g, '') : input;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const out = new Uint8Array(Math.floor((base64.length * 3) / 4) - padding);
  let at = 0;
  for (let from = 0; from < base64.length; from += BASE64_SLICE_CHARS) {
    const binary = atob(base64.slice(from, from + BASE64_SLICE_CHARS));
    // Written past the end is dropped by the typed array; caught just below.
    for (let i = 0; i < binary.length; i++) out[at + i] = binary.charCodeAt(i);
    at += binary.length;
  }
  if (at !== out.length) {
    // A stray character shifted a group: the bytes are garbage.
    throw new Error(
      `Dialogue TTS returned base64 that decodes to ${at} bytes, expected ${out.length}`
    );
  }
  return out;
}

/**
 * Make the header's `data` size describe the bytes that are there. Every
 * later reader — `cutAudioSection` above all, which sees only the header —
 * does its arithmetic off that field, so a header claiming more than the file
 * holds (a streaming encoder's placeholder) is corrected once, here, in place.
 */
function honestDataSize(wav: Uint8Array<ArrayBuffer>): void {
  const fmt = parseWavHeader(wav);
  if (!fmt) return;
  const available = wav.length - fmt.dataStart;
  if (fmt.dataSize <= available) return;
  new DataView(wav.buffer).setUint32(fmt.dataStart - 4, available, true);
}

/**
 * Where each turn sits in the recording. `dialogueInputIndex` is the position
 * in the `inputs` we sent, so it maps straight back onto the lines; a turn
 * reported as several segments spans the outermost of them.
 *
 * A response with no segments can still be ranged when every line belongs to
 * ONE shot — there is nothing to divide, the whole recording is that shot's.
 * Across shots it cannot, and that fails here rather than handing some shot a
 * range of someone else's lines.
 */
function recordingTurns(
  lines: readonly DialogueCallLine[],
  result: { voiceSegments?: Array<VoiceSegmentTimes> | null },
  durationSeconds: number
): DialogueRecordingTurn[] {
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
        `Dialogue TTS returned no voice segments for a recording spanning ${shotIds.size} shots — there is no way to tell each shot's range`
      );
    }
    return lines.map((line) => ({
      shotId: line.shotId,
      index: line.index,
      voiceId: line.voiceId,
      ttsModel: DIALOGUE_TTS_MODEL,
      startSeconds: 0,
      endSeconds: durationSeconds,
    }));
  }
  return lines.map((line, at) => {
    const span = spans.get(at);
    if (!span) {
      throw new Error(
        `Dialogue TTS reported no timing for turn ${at + 1}/${lines.length} of the recording`
      );
    }
    return {
      shotId: line.shotId,
      index: line.index,
      voiceId: line.voiceId,
      ttsModel: DIALOGUE_TTS_MODEL,
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

/**
 * The range of the recording each shot keeps, in speaking order (#1657).
 *
 * A shot's range starts where the PREVIOUS shot stopped speaking, so the
 * silence between two turns belongs to the shot that is about to speak — a
 * clip that opened on its own first syllable would sound cut into. It runs to
 * the next shot's first word (the last shot, to the end of the recording),
 * and `speechEnd` is its own last word, which is where the tail is trimmed
 * back to.
 *
 * Interleaved shots (two shots trading lines inside one scene) get
 * overlapping ranges by construction. That is the honest answer: each clip
 * carries the conversation around its own lines, and the alternative — a
 * clip missing its own reply — is worse.
 */
export function shotSliceWindows(
  turns: ReadonlyArray<
    Pick<DialogueRecordingTurn, 'shotId' | 'startSeconds' | 'endSeconds'>
  >,
  recordingSeconds: number
): Array<{ shotId: string; from: number; to: number; speechEnd: number }> {
  const shotIds = [...new Set(turns.map((turn) => turn.shotId))];
  const spanOf = (shotId: string) => {
    const own = turns.filter((turn) => turn.shotId === shotId);
    return {
      firstWord: Math.min(...own.map((turn) => turn.startSeconds)),
      lastWord: Math.max(...own.map((turn) => turn.endSeconds)),
    };
  };
  return shotIds.map((shotId, index) => {
    const span = spanOf(shotId);
    const previous = index === 0 ? null : shotIds[index - 1];
    const following = shotIds[index + 1];
    const from = previous ? spanOf(previous).lastWord : 0;
    const to = following ? spanOf(following).firstWord : recordingSeconds;
    return {
      shotId,
      from,
      to: Math.max(span.lastWord, to),
      speechEnd: span.lastWord,
    };
  });
}
