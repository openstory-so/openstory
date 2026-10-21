/**
 * A line performed at the mic, in the character's voice (#1802).
 *
 * The user records one line; the take is turned into the speaker's voice with
 * the user's delivery kept:
 *
 *  - **ElevenLabs voice** → Voice Changer (Speech to Speech). Timing, pitch
 *    and emotion come from the take; the voice from the character.
 *  - **Seed voice** → Seed Audio with the take as a second reference,
 *    checked by Scribe like every Seed take. The prompt is experimental
 *    (Record is behind `MIC_TAKES_ENABLED` until it is reliable).
 *
 * A shot's audio is one range of one speech, and it must speak all of the
 * shot's lines. So the converted line is SPLICED into the shot's current
 * reading: that line's window is replaced, the shot's other lines keep the
 * delivery they had. The result is its own `dialogue_speeches` row — the
 * provider's files are still never joined; this is a new file we made. A shot
 * with no current reading takes a mic line only when it has one voiced line,
 * and the line is then the whole speech.
 *
 * Bytes never cross a step (#1645): this runs inside one `step.do` and
 * returns the small record. The base speech is never held: the section either
 * side of the line streams from R2 into the upload. Only the converted take
 * (≤ 30 s) is in memory, because its speech has to be found in it.
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
import { recordCheckedTake } from '@/cast/server/voice/seed-audio';
import { loadSeedVoice, readSeedClip } from '@/cast/server/voice/seed-voice';
import { WORD_LEAD_SECONDS } from '@/cast/server/voice/take-check';
import type { Microdollars } from '@/billing/money';
import { createElevenLabsSdk } from '@/models/server/elevenlabs-config';
import { DIALOGUE_STS_MODEL } from '@/motion/dialogue-tts';
import { generateId } from '@/platform/id';
import type { DialogueSpeechTurn } from '@/platform/server/db/schema';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { uploadResponse } from '@/platform/server/storage/upload-response';
import { readStorageObject, readStorageStream } from '#storage';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  honestDataSize,
  isSilentWav,
  parseWavHeader,
  trimmedEndSeconds,
  trimmedStartSeconds,
  wavDurationSeconds,
  wavFrameMath,
  wavHeader,
  type WavFormat,
} from './pad-dialogue-audio';

/** Seed takes per mic line before it fails. */
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
 * speech, where the line sits in it, and every turn of THIS shot.
 */
export type DialogueTakeBase = {
  storageKey: string;
  fromSeconds: number;
  toSeconds: number;
  lineStartSeconds: number;
  lineEndSeconds: number;
  turns: DialogueSpeechTurn[];
};

type Charge = { endpointId: string; model: string; costMicros: Microdollars };

export type RecordedDialogueTake = {
  speechId: string;
  storageKey: string;
  url: string;
  durationSeconds: number;
  turns: DialogueSpeechTurn[];
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
  if (!takeFmt) {
    throw new NonRetryableError('The converted take is not a PCM WAV');
  }
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
    : { before: null, after: null, fmt: takeFmt };
  const bytesPerSecond = takeMath.bytesPerSecond;
  const beforeBytes = before?.size ?? 0;
  const dataSize = beforeBytes + spoken.length + (after?.size ?? 0);
  const header = wavHeader(dataSize, fmt);

  const speechId = generateId();
  // workerd's r2.put() needs the length of a stream (#738); it is exact here.
  const uploaded = await uploadResponse(
    new Response(joinedStream([header, before?.body, spoken, after?.body]), {
      headers: { 'content-length': String(header.length + dataSize) },
    }),
    STORAGE_BUCKETS.AUDIO,
    `${input.teamId}/${input.sequenceId}/dialogue-speeches/${speechId}.wav`,
    { contentType: 'audio/wav' }
  );
  const durationSeconds = dataSize / bytesPerSecond;
  return {
    speechId,
    storageKey: uploaded.fullPath,
    url: uploaded.publicUrl,
    durationSeconds,
    turns: splicedTurns({
      shotId: input.shotId,
      line: input.line,
      ttsModel: converted.ttsModel,
      base: input.base,
      lineStartSeconds: beforeBytes / bytesPerSecond,
      takeSeconds: spoken.length / bytesPerSecond,
      durationSeconds,
    }),
    charges: converted.charges,
  };
}

type SampleStream = { body: ReadableStream<Uint8Array>; size: number };

/**
 * The base section's samples either side of the line, as two ranged STREAMS
 * — the base speech is never read into the worker.
 */
async function baseAround(
  base: DialogueTakeBase,
  takeFmt: WavFormat
): Promise<{
  before: SampleStream | null;
  after: SampleStream | null;
  fmt: WavFormat;
}> {
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
  // The line must sit in the section: a clamp would splice beside it.
  if (
    base.lineEndSeconds <= base.fromSeconds ||
    base.lineStartSeconds >= base.toSeconds
  ) {
    throw new NonRetryableError(
      'The line does not sit in the reading it goes into'
    );
  }
  const { snap } = wavFrameMath(fmt, fmt.dataSize);
  const from = snap(base.fromSeconds);
  const to = Math.max(from, snap(base.toSeconds));
  const lineStart = Math.min(to, Math.max(from, snap(base.lineStartSeconds)));
  const lineEnd = Math.min(to, Math.max(lineStart, snap(base.lineEndSeconds)));
  const read = async (start: number, end: number) => {
    if (end <= start) return null;
    const got = await readStorageStream(base.storageKey, {
      offset: fmt.dataStart + start,
      length: end - start,
    });
    if (!got || got.size !== end - start) {
      await got?.body.cancel();
      throw new NonRetryableError(
        'The current reading is shorter than its header says'
      );
    }
    return got;
  };
  const before = await read(from, lineStart);
  const after = await read(lineEnd, to).catch(async (error: unknown) => {
    await before?.body.cancel();
    throw error;
  });
  return { before, after, fmt };
}

/** The parts in order, each stream read only once the one before is done. */
function joinedStream(
  parts: readonly (Uint8Array | ReadableStream<Uint8Array> | undefined)[]
): ReadableStream<Uint8Array> {
  let at = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        if (at >= parts.length) return controller.close();
        const part = parts[at];
        if (!part || part instanceof Uint8Array) {
          at++;
          if (part && part.length > 0) return controller.enqueue(part);
          continue;
        }
        reader ??= part.getReader();
        const { done, value } = await reader.read();
        if (!done) return controller.enqueue(value);
        reader = null;
        at++;
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
      for (const part of parts.slice(at + 1)) {
        if (part instanceof ReadableStream) await part.cancel(reason);
      }
    },
  });
}

/**
 * The new speech's turns. With a base: the shot's turns re-timed onto the
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
}): DialogueSpeechTurn[] {
  const lineTurn: DialogueSpeechTurn = {
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
  const takeSeconds = wavDurationSeconds(take);
  if (takeSeconds == null) {
    throw new NonRetryableError('The recorded take is not a PCM WAV');
  }
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
    throw new NonRetryableError('Voice Changer returned an empty audio body');
  }
  honestDataSize(wav);
  const durationSeconds = wavDurationSeconds(wav);
  if (durationSeconds == null) {
    throw new NonRetryableError(
      'Voice Changer returned audio that is not a PCM WAV'
    );
  }
  if (isSilentWav(wav)) {
    throw new NonRetryableError('No speech was heard in the take');
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

/** The Seed prompt: each reference's job, then the line. */
function seedGuidedPrompt(
  line: Pick<DialogueTakeLine, 'character' | 'text'>
): string {
  const name = line.character.trim() || 'Narrator';
  return [
    '@Audio1: Exact master audio track; preserve word-for-word delivery, exact vocal timbre, room tone, and sound effects completely intact. Do not replace, remix, or add underlying music.',
    '@Audio2: the lines that should be delivered',
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
  const prompt = seedGuidedPrompt(line);
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
      throw new NonRetryableError(
        'Seed Audio returned audio that is not a PCM WAV'
      );
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
  // ponytail: failed takes are not billed to the team.
  throw new NonRetryableError(
    `Seed Audio did not say the line in ${SEED_TAKE_ATTEMPTS} takes (last: ${lastProblem}). Try the take again.`
  );
}
