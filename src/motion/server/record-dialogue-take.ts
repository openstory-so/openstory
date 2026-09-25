/**
 * A line performed at the mic, in the character's voice (#1802).
 *
 * The user records one line; the take is turned into the speaker's voice with
 * the user's delivery kept:
 *
 *  - **ElevenLabs voice** → Voice Changer (Speech to Speech). Timing, pitch
 *    and emotion come from the take; the voice from the character.
 *  - **Seed voice** → Seed Audio with the take as a second reference, a
 *    guide read whose delivery Seed copies (Seed copies a reference's
 *    delivery as well as its voice), checked by Scribe like every Seed take.
 *
 * A shot's audio is one range of one recording, and it must speak all of the
 * shot's lines. So the converted line is SPLICED into the shot's current
 * reading: that line's window is replaced, the shot's other lines keep the
 * delivery they had. The result is its own `dialogue_recordings` row — the
 * provider's files are still never joined; this is a new file we made. A shot
 * with no current reading takes a mic line only when it has one voiced line,
 * and the line is then the whole recording.
 *
 * Bytes never cross a step (#1645): this runs inside one `step.do`, reads
 * only the shot's section of the base recording (ranged), and returns the
 * small record.
 */

import {
  ELEVENLABS_SCRIBE_ENDPOINT,
  ELEVENLABS_STS_ENDPOINT,
  scribeCost,
  speechToSpeechCost,
} from '@/billing/elevenlabs-pricing';
import {
  SEED_AUDIO_ENDPOINT,
  seedAudioCost,
} from '@/billing/seed-speech-pricing';
import { SEED_AUDIO_MODEL, voiceProviderOf } from '@/cast/seed-voice';
import { SCRIBE_MODEL } from '@/cast/server/voice/elevenlabs-voice';
import {
  recordCheckedTake,
  SEED_BOOTH_PROMPT,
} from '@/cast/server/voice/seed-audio';
import { loadSeedVoice, readSeedClip } from '@/cast/server/voice/seed-voice';
import { WORD_LEAD_SECONDS } from '@/cast/server/voice/take-check';
import type { Microdollars } from '@/billing/money';
import { createElevenLabsSdk } from '@/models/server/elevenlabs-config';
import { DIALOGUE_STS_MODEL } from '@/motion/dialogue-tts';
import { generateId } from '@/platform/id';
import type { DialogueRecordingTurn } from '@/platform/server/db/schema';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { readStorageObject, uploadFile } from '#storage';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  honestDataSize,
  parseWavHeader,
  trimmedEndSeconds,
  trimmedStartSeconds,
  wavDurationSeconds,
  wavFrameMath,
  wavHeader,
  type WavFormat,
} from './pad-dialogue-audio';

/** Seed takes per mic line before it fails, as for a scene. */
const SEED_TAKE_ATTEMPTS = 3;
/** Enough for any header a provider writes. */
const HEADER_PROBE_BYTES = 4096;

/** The line the take performs. `index` is shot-relative, as everywhere. */
export type DialogueTakeLine = {
  index: number;
  voiceId: string;
  character: string;
  text: string;
  tone: string;
};

/**
 * The shot's current reading, snapshotted at the trigger: its range of the
 * recording, where the line sits in it, and every turn of THIS shot.
 */
export type DialogueTakeBase = {
  storageKey: string;
  fromSeconds: number;
  toSeconds: number;
  lineStartSeconds: number;
  lineEndSeconds: number;
  turns: DialogueRecordingTurn[];
};

type Charge = { endpointId: string; model: string; costMicros: Microdollars };

export type RecordedDialogueTake = {
  recordingId: string;
  storageKey: string;
  url: string;
  durationSeconds: number;
  turns: DialogueRecordingTurn[];
  charges: Charge[];
};

/** The take in the speaker's voice, and where its speech sits. */
type ConvertedTake = {
  wav: Uint8Array<ArrayBuffer>;
  speechFrom: number;
  speechTo: number;
  ttsModel: string;
  charges: Charge[];
};

export async function recordDialogueTake(input: {
  elevenLabsKey: string;
  /** Required for a Seed voice. */
  seedKey: string | null;
  teamId: string;
  sequenceId: string;
  shotId: string;
  line: DialogueTakeLine;
  /** The user's take (a PCM WAV the browser encoded). */
  takeStorageKey: string;
  base: DialogueTakeBase | null;
}): Promise<RecordedDialogueTake> {
  const stored = await readStorageObject(input.takeStorageKey);
  if (!stored) {
    throw new NonRetryableError('The recorded take is missing from storage');
  }
  const converted =
    voiceProviderOf(input.line.voiceId) === 'seed'
      ? await convertWithSeed(input.line, stored.bytes, input)
      : await convertWithVoiceChanger(
          input.line,
          stored.bytes,
          input.elevenLabsKey
        );

  const takeFmt = parseWavHeader(converted.wav);
  if (!takeFmt) throw new Error('The converted take is not a PCM WAV');
  const takeMath = wavFrameMath(
    takeFmt,
    Math.min(takeFmt.dataSize, converted.wav.length - takeFmt.dataStart)
  );
  const takeFrom = takeMath.snap(converted.speechFrom);
  const takeTo = Math.max(takeFrom, takeMath.snap(converted.speechTo));
  if (takeTo === takeFrom) {
    throw new NonRetryableError('No speech was heard in the take');
  }
  const spoken = converted.wav.subarray(
    takeFmt.dataStart + takeFrom,
    takeFmt.dataStart + takeTo
  );

  const { before, after, fmt } = input.base
    ? await baseAround(input.base, takeFmt)
    : { before: EMPTY, after: EMPTY, fmt: takeFmt };
  const bytesPerSecond = takeMath.bytesPerSecond;
  const dataSize = before.length + spoken.length + after.length;
  const wav = new Uint8Array(44 + dataSize);
  wav.set(wavHeader(dataSize, fmt));
  wav.set(before, 44);
  wav.set(spoken, 44 + before.length);
  wav.set(after, 44 + before.length + spoken.length);

  const recordingId = generateId();
  const uploaded = await uploadFile(
    STORAGE_BUCKETS.AUDIO,
    `${input.teamId}/${input.sequenceId}/dialogue-recordings/${recordingId}.wav`,
    wav,
    { contentType: 'audio/wav', upsert: true }
  );
  const durationSeconds = dataSize / bytesPerSecond;
  return {
    recordingId,
    storageKey: uploaded.fullPath,
    url: uploaded.publicUrl,
    durationSeconds,
    turns: splicedTurns({
      shotId: input.shotId,
      line: input.line,
      ttsModel: converted.ttsModel,
      base: input.base,
      lineStartSeconds: before.length / bytesPerSecond,
      takeSeconds: spoken.length / bytesPerSecond,
      durationSeconds,
    }),
    charges: converted.charges,
  };
}

const EMPTY = new Uint8Array(0);

/** The base section's samples either side of the line — two ranged reads. */
async function baseAround(
  base: DialogueTakeBase,
  takeFmt: WavFormat
): Promise<{ before: Uint8Array; after: Uint8Array; fmt: WavFormat }> {
  const probe = await readStorageObject(base.storageKey, {
    offset: 0,
    length: HEADER_PROBE_BYTES,
  });
  if (!probe) {
    throw new NonRetryableError(
      'The reading this line goes into is missing from storage'
    );
  }
  const fmt = parseWavHeader(probe.bytes);
  if (!fmt) throw new NonRetryableError('The current reading is not a PCM WAV');
  if (
    fmt.sampleRate !== takeFmt.sampleRate ||
    fmt.channels !== takeFmt.channels ||
    fmt.bitsPerSample !== takeFmt.bitsPerSample
  ) {
    throw new NonRetryableError(
      `The take (${takeFmt.sampleRate} Hz, ${takeFmt.channels} ch) does not match the reading it goes into (${fmt.sampleRate} Hz, ${fmt.channels} ch)`
    );
  }
  const { snap } = wavFrameMath(fmt, fmt.dataSize);
  const from = snap(base.fromSeconds);
  const to = Math.max(from, snap(base.toSeconds));
  const lineStart = Math.min(to, Math.max(from, snap(base.lineStartSeconds)));
  const lineEnd = Math.min(to, Math.max(lineStart, snap(base.lineEndSeconds)));
  const read = async (start: number, end: number) => {
    if (end <= start) return EMPTY;
    const got = await readStorageObject(base.storageKey, {
      offset: fmt.dataStart + start,
      length: end - start,
    });
    if (!got || got.bytes.length !== end - start) {
      throw new NonRetryableError(
        'The current reading is shorter than its header says'
      );
    }
    return got.bytes;
  };
  const [before, after] = await Promise.all([
    read(from, lineStart),
    read(lineEnd, to),
  ]);
  return { before, after, fmt };
}

/**
 * The new recording's turns. With a base: the shot's turns re-timed onto the
 * spliced file — before the line they shift back by the section's start,
 * after it by the change in the line's length — and the line itself where
 * the take landed, stamped with the voice and the model that made it.
 */
export function splicedTurns(input: {
  shotId: string;
  line: DialogueTakeLine;
  ttsModel: string;
  base: Pick<
    DialogueTakeBase,
    'fromSeconds' | 'lineStartSeconds' | 'lineEndSeconds' | 'turns'
  > | null;
  /** Where the take starts in the new file (the length kept before it). */
  lineStartSeconds: number;
  takeSeconds: number;
  durationSeconds: number;
}): DialogueRecordingTurn[] {
  const lineTurn: DialogueRecordingTurn = {
    shotId: input.shotId,
    index: input.line.index,
    voiceId: input.line.voiceId,
    ttsModel: input.ttsModel,
    startSeconds: input.lineStartSeconds,
    endSeconds: input.lineStartSeconds + input.takeSeconds,
  };
  if (!input.base) return [lineTurn];
  const { base } = input;
  const lineEndNew = input.lineStartSeconds + input.takeSeconds;
  const clamp = (seconds: number) =>
    Math.min(input.durationSeconds, Math.max(0, seconds));
  const moved = (seconds: number) =>
    clamp(
      seconds <= base.lineStartSeconds
        ? seconds - base.fromSeconds
        : seconds - base.lineEndSeconds + lineEndNew
    );
  return base.turns
    .filter((turn) => turn.shotId === input.shotId)
    .map(({ spokenText: _, ...turn }) =>
      turn.index === input.line.index
        ? lineTurn
        : {
            ...turn,
            startSeconds: moved(turn.startSeconds),
            endSeconds: moved(turn.endSeconds),
          }
    );
}

/** ElevenLabs Voice Changer: the take's delivery, the character's voice. */
async function convertWithVoiceChanger(
  line: DialogueTakeLine,
  take: Uint8Array<ArrayBuffer>,
  apiKey: string
): Promise<ConvertedTake> {
  const takeSeconds = wavDurationSeconds(take) ?? 0;
  const client = await createElevenLabsSdk(apiKey);
  const stream = await client.speechToSpeech.convert(line.voiceId, {
    audio: new Blob([take], { type: 'audio/wav' }),
    modelId: DIALOGUE_STS_MODEL,
    outputFormat: 'wav_44100',
    // A laptop mic in a room: the take's noise is not part of the voice.
    removeBackgroundNoise: true,
  });
  const wav = new Uint8Array(await new Response(stream).arrayBuffer());
  if (wav.byteLength === 0) {
    throw new Error('Voice Changer returned an empty audio body');
  }
  honestDataSize(wav);
  const durationSeconds = wavDurationSeconds(wav);
  if (durationSeconds == null) {
    throw new Error('Voice Changer returned audio that is not a PCM WAV');
  }
  const speechFrom = trimmedStartSeconds(wav, 0, durationSeconds);
  return {
    wav,
    speechFrom,
    speechTo: trimmedEndSeconds(wav, speechFrom, durationSeconds),
    ttsModel: DIALOGUE_STS_MODEL,
    charges: [
      {
        endpointId: ELEVENLABS_STS_ENDPOINT,
        model: DIALOGUE_STS_MODEL,
        costMicros: speechToSpeechCost(takeSeconds),
      },
    ],
  };
}

/** The Seed prompt: the character's voice from @Audio1, the delivery from @Audio2. */
function seedGuidedPrompt(
  line: Pick<DialogueTakeLine, 'character' | 'text'>,
  description: string
): string {
  const name = line.character.trim() || 'Narrator';
  return [
    `${SEED_BOOTH_PROMPT} One speaker.`,
    `${name}: the exact voice and accent of @Audio1. ${description}`.trim(),
    `@Audio2 is a guide read of the same line. Copy its timing, pauses, emphasis, pitch movement and emotion exactly, but not its voice.`,
    '',
    `${name}: ${line.text.trim()}`,
  ].join('\n');
}

/** Seed Audio with the take as the delivery reference, checked by Scribe. */
async function convertWithSeed(
  line: DialogueTakeLine,
  take: Uint8Array<ArrayBuffer>,
  keys: { seedKey: string | null; elevenLabsKey: string }
): Promise<ConvertedTake> {
  if (!keys.seedKey) {
    throw new NonRetryableError('Seed Speech is not configured');
  }
  const bundle = await loadSeedVoice(line.voiceId);
  const voice = await readSeedClip(bundle.clips.normal);
  const prompt = seedGuidedPrompt(line, bundle.description);
  let lastProblem = '';
  for (let attempt = 1; attempt <= SEED_TAKE_ATTEMPTS; attempt++) {
    const made = await recordCheckedTake({
      seedKey: keys.seedKey,
      elevenLabsKey: keys.elevenLabsKey,
      prompt,
      references: [voice, take],
      parts: [line.text],
    });
    const durationSeconds = wavDurationSeconds(made.wav);
    if (durationSeconds == null) {
      throw new Error('Seed Audio returned audio that is not a PCM WAV');
    }
    const span = made.check.ok ? made.check.spans[0] : undefined;
    if (!made.check.ok || !span) {
      lastProblem = made.check.ok
        ? 'the line was not found'
        : made.check.problem;
      continue;
    }
    const speechFrom = Math.max(0, span.start - WORD_LEAD_SECONDS);
    return {
      wav: made.wav,
      speechFrom,
      speechTo: trimmedEndSeconds(
        made.wav,
        speechFrom,
        durationSeconds,
        span.end
      ),
      ttsModel: SEED_AUDIO_MODEL,
      charges: [
        {
          endpointId: SEED_AUDIO_ENDPOINT,
          model: SEED_AUDIO_MODEL,
          costMicros: seedAudioCost(made.billedSeconds),
        },
        {
          endpointId: ELEVENLABS_SCRIBE_ENDPOINT,
          model: SCRIBE_MODEL,
          costMicros: scribeCost(made.heardSeconds),
        },
      ],
    };
  }
  // ponytail: failed takes are not billed to the team, as for a scene.
  throw new NonRetryableError(
    `Seed Audio did not say the line in ${SEED_TAKE_ATTEMPTS} takes (last: ${lastProblem}). Try the take again.`
  );
}
