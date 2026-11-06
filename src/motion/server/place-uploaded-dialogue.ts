/**
 * A scene's uploaded recording, found line by line (#2264).
 *
 * Scribe transcribes the file and `checkParts` finds each of the scene's
 * lines in it, in order, the same letter alignment every Seed take is checked
 * with. Nothing is guessed: a line not found fails the upload with the line
 * named. The shots' ranges come from the found lines exactly as a Seed speech's
 * do. Bytes never cross a step (#1645): this runs inside one `step.do` and
 * returns the small record.
 */

import {
  ELEVENLABS_SCRIBE_ENDPOINT,
  scribeCost,
} from '@/billing/elevenlabs-pricing';
import type { Microdollars } from '@/billing/money';
import {
  SCRIBE_MODEL,
  transcribeSpeech,
  type HeardWord,
} from '@/cast/server/voice/elevenlabs-voice';
import { checkParts, WORD_LEAD_SECONDS } from '@/cast/server/voice/take-check';
import { UPLOADED_DIALOGUE_MODEL } from '@/motion/dialogue-tts';
import { generateId } from '@/platform/id';
import type { DialogueSpeechTurn } from '@/platform/server/db/schema';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import type { SceneVoicedLine } from '@/shots/shot-dialogue';
import { readStorageObject, storageObjectSize, uploadFile } from '#storage';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  honestDataSize,
  trimmedEndSeconds,
  wavDurationSeconds,
} from './pad-dialogue-audio';
import { shotSliceWindows } from './synthesize-dialogue';

type Window = { shotId: string; fromSeconds: number; toSeconds: number };

/** Scribe and the alignment hold the file whole: about 4 minutes of 48 kHz mono. */
export const MAX_DIALOGUE_UPLOAD_BYTES = 25 * 1024 * 1024;

type Charge = { endpointId: string; model: string; costMicros: Microdollars };

/**
 * Scribe's charge stands whether or not the lines were found: a failed
 * upload still spent the transcription.
 */
export type PlacedUpload = { charges: Charge[] } & (
  | {
      ok: true;
      speechId: string;
      storageKey: string;
      url: string;
      durationSeconds: number;
      turns: DialogueSpeechTurn[];
      windows: Window[];
    }
  | { ok: false; problem: string }
);

/**
 * Each line's turn and each shot's range in the recording. Throws, naming the
 * first line, when a line is not in it.
 */
export function placeLines(
  lines: readonly SceneVoicedLine[],
  heard: readonly HeardWord[],
  wav: Uint8Array,
  durationSeconds: number
): { turns: DialogueSpeechTurn[]; windows: Window[] } {
  const check = checkParts(
    heard,
    lines.map((line) => line.text)
  );
  if (!check.ok) {
    const first = check.doubtful[0];
    const line = first ? lines[first.line] : undefined;
    const who = line?.character.trim() || 'The narrator';
    throw new NonRetryableError(
      `${who}'s line "${line?.text.slice(0, 80) ?? ''}" was not found in the recording (${Math.round((first?.heardShare ?? 0) * 100)}% of it heard). The recording must speak the scene's lines, in order.`
    );
  }
  const turns: DialogueSpeechTurn[] = lines.map((line, at) => {
    const span = check.spans[at];
    if (!span) throw new Error(`Line ${at + 1} has no span`);
    return {
      shotId: line.shotId,
      index: line.index,
      // The character's voice: a later recast dates the scene like any speech.
      voiceId: line.voiceId,
      ttsModel: UPLOADED_DIALOGUE_MODEL,
      startSeconds: Math.max(0, span.start),
      endSeconds: Math.min(durationSeconds, span.end),
    };
  });
  // Anything before the first line belongs to nobody.
  const scriptStart = Math.max(0, check.scriptStartSeconds - WORD_LEAD_SECONDS);
  const windows = shotSliceWindows(turns, durationSeconds).map((window, at) => {
    const from = at === 0 ? Math.max(window.from, scriptStart) : window.from;
    return {
      shotId: window.shotId,
      fromSeconds: from,
      toSeconds: trimmedEndSeconds(wav, from, window.to, window.speechEnd),
    };
  });
  return { turns, windows };
}

export async function placeUploadedDialogue(input: {
  elevenLabsKey: string;
  organizationId: string;
  sequenceId: string;
  storageKey: string;
  lines: readonly SceneVoicedLine[];
}): Promise<PlacedUpload> {
  // Checked again here: the presigned key can be written after the click.
  const size = await storageObjectSize(input.storageKey);
  if (size == null || size > MAX_DIALOGUE_UPLOAD_BYTES) {
    throw new NonRetryableError(
      size == null
        ? 'The uploaded recording is missing from storage'
        : `The uploaded recording is over ${MAX_DIALOGUE_UPLOAD_BYTES / 1024 / 1024} MB`
    );
  }
  const stored = await readStorageObject(input.storageKey);
  if (!stored) {
    throw new NonRetryableError(
      'The uploaded recording is missing from storage'
    );
  }
  const wav = stored.bytes;
  honestDataSize(wav);
  const durationSeconds = wavDurationSeconds(wav);
  if (durationSeconds == null || durationSeconds <= 0) {
    throw new NonRetryableError('The uploaded recording is not a PCM WAV');
  }
  const heard = await transcribeSpeech(input.elevenLabsKey, wav, 'audio/wav');
  const charges: Charge[] = [
    {
      endpointId: ELEVENLABS_SCRIBE_ENDPOINT,
      model: SCRIBE_MODEL,
      costMicros: scribeCost(heard.seconds || durationSeconds),
    },
  ];
  let placed: ReturnType<typeof placeLines>;
  try {
    placed = placeLines(input.lines, heard.words, wav, durationSeconds);
  } catch (error) {
    if (!(error instanceof NonRetryableError)) throw error;
    return { ok: false, problem: error.message, charges };
  }
  // Its own speech file, header corrected, like every other speech.
  const speechId = generateId();
  const uploaded = await uploadFile(
    STORAGE_BUCKETS.AUDIO,
    `${input.organizationId}/${input.sequenceId}/dialogue-speeches/${speechId}.wav`,
    wav,
    { contentType: 'audio/wav', upsert: true }
  );
  return {
    ok: true,
    speechId,
    storageKey: uploaded.fullPath,
    url: uploaded.publicUrl,
    durationSeconds,
    ...placed,
    charges,
  };
}
