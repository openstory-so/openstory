/**
 * Making and loading Seed voices (#1765). See `@/cast/seed-voice` for what a
 * Seed voice is.
 *
 * A take is ONE Seed Audio call reading the range script's three sections,
 * so the three clips are one person. Scribe transcribes it; a take that said
 * anything but the script fails (it is recorded again by the step's retry).
 * The sections are cut from the WAV by the transcription's word timings,
 * each is run through voice isolation, and the MP3s land in R2 with a
 * `voice.json` naming them. The whole read is kept too, for audition.
 */

import {
  SEED_VOICE_MOODS,
  seedVoiceFolder,
  type SeedVoiceBundle,
  type SeedVoiceMood,
} from '@/cast/seed-voice';
import {
  parseWavHeader,
  wavDurationSeconds,
  wavFrameMath,
  wavHeader,
} from '@/motion/server/pad-dialogue-audio';
import { honestDataSize } from '@/motion/server/synthesize-dialogue';
import { buildR2Key, STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { readStorageObject, uploadFile } from '#storage';
import { isolateVoice, transcribeSpeech } from './elevenlabs-voice';
import { SEED_BOOTH_PROMPT, seedAudio } from './seed-audio';
import { checkTake, locateParts } from './take-check';
import { z } from 'zod';

export type RangeScript = Record<SeedVoiceMood, string>;

const seedVoiceBundleSchema = z.object({
  description: z.string(),
  clips: z.object({ normal: z.string(), quiet: z.string(), loud: z.string() }),
}) satisfies z.ZodType<SeedVoiceBundle>;

/** Room kept around each section so a clip never opens or ends mid-word. */
const LEAD_SECONDS = 0.15;
const TAIL_SECONDS = 0.2;

export type RecordedRangeRead = {
  /** The whole read, for audition. */
  url: string;
  path: string;
  /** What the take spent, for billing. */
  seedSeconds: number;
  transcribedSeconds: number;
  isolatedSeconds: number;
};

/** The prompt that reads all three sections in one voice. */
function rangeReadPrompt(description: string, script: RangeScript): string {
  return `${SEED_BOOTH_PROMPT} Speaker: ${description} They speak in three parts, at a natural conversational pace. First, relaxed and conversational: "${script.normal}" Then they drop to a whisper: "${script.quiet}" Then, raised and annoyed: "${script.loud}"`;
}

export async function recordRangeRead(input: {
  seedKey: string;
  elevenLabsKey: string;
  voiceId: string;
  description: string;
  script: RangeScript;
}): Promise<RecordedRangeRead> {
  const take = await seedAudio({
    apiKey: input.seedKey,
    prompt: rangeReadPrompt(input.description, input.script),
    references: [],
  });
  honestDataSize(take.wav);
  const heard = await transcribeSpeech(
    input.elevenLabsKey,
    take.wav,
    'audio/wav'
  );
  const script = SEED_VOICE_MOODS.map((mood) => input.script[mood]).join(' ');
  const check = checkTake(script, heard.words);
  const spans = locateParts(
    heard.words,
    SEED_VOICE_MOODS.map((mood) => input.script[mood])
  );
  if (!check.ok || spans.some((span) => !span)) {
    throw new Error(
      `Seed range read did not say its script${check.extraText ? ` (heard extra: "${check.extraText.slice(0, 120)}")` : ''}${check.missing.length ? ` (missing: ${check.missing.slice(0, 8).join(' ')})` : ''}`
    );
  }

  const folder = seedVoiceFolder(input.voiceId);
  const cut = SEED_VOICE_MOODS.map((mood, i) => {
    const span = spans[i];
    if (!span) throw new Error(`Seed range read has no ${mood} section`);
    return {
      mood,
      section: sliceWav(
        take.wav,
        span.start - LEAD_SECONDS,
        span.end + TAIL_SECONDS
      ),
    };
  });
  const isolatedSeconds = cut.reduce(
    (sum, { section }) => sum + (wavDurationSeconds(section) ?? 0),
    0
  );
  const stored = await Promise.all(
    cut.map(async ({ mood, section }) => {
      const clean = await isolateVoice(
        input.elevenLabsKey,
        section,
        'audio/wav'
      );
      const uploaded = await uploadFile(
        STORAGE_BUCKETS.AUDIO,
        `${folder}/${mood}.mp3`,
        clean,
        { contentType: 'audio/mpeg', upsert: true }
      );
      return [mood, uploaded.fullPath] as const;
    })
  );
  const clips = Object.fromEntries(stored);
  const read = await uploadFile(
    STORAGE_BUCKETS.AUDIO,
    `${folder}/read.wav`,
    take.wav,
    { contentType: 'audio/wav', upsert: true }
  );
  const bundle = seedVoiceBundleSchema.parse({
    description: input.description,
    clips,
  });
  await uploadFile(
    STORAGE_BUCKETS.AUDIO,
    `${folder}/voice.json`,
    new TextEncoder().encode(JSON.stringify(bundle)),
    { contentType: 'application/json', upsert: true }
  );
  return {
    url: read.publicUrl,
    path: read.fullPath,
    seedSeconds: take.billedSeconds,
    transcribedSeconds: heard.seconds,
    isolatedSeconds,
  };
}

/** A Seed voice's description and clip keys. Throws for a voice with no bundle. */
export async function loadSeedVoice(voiceId: string): Promise<SeedVoiceBundle> {
  const key = buildR2Key(
    STORAGE_BUCKETS.AUDIO,
    `${seedVoiceFolder(voiceId)}/voice.json`
  );
  const stored = await readStorageObject(key);
  if (!stored) throw new Error(`Seed voice ${voiceId} has no bundle`);
  return seedVoiceBundleSchema.parse(
    JSON.parse(new TextDecoder().decode(stored.bytes))
  );
}

/** A reference clip's bytes. */
export async function readSeedClip(storageKey: string): Promise<Uint8Array> {
  const stored = await readStorageObject(storageKey);
  if (!stored) throw new Error(`Seed voice clip ${storageKey} is missing`);
  return stored.bytes;
}

/** `[from, to)` seconds of a PCM WAV as its own WAV, clamped to the file. */
function sliceWav(
  wav: Uint8Array,
  fromSeconds: number,
  toSeconds: number
): Uint8Array<ArrayBuffer> {
  const fmt = parseWavHeader(wav);
  if (!fmt) throw new Error('Seed Audio returned audio that is not a PCM WAV');
  const available = Math.min(fmt.dataSize, wav.length - fmt.dataStart);
  const { snap } = wavFrameMath(fmt, available);
  const from = snap(fromSeconds);
  const to = Math.max(from, snap(toSeconds));
  const out = new Uint8Array(44 + (to - from));
  out.set(wavHeader(to - from, fmt));
  out.set(wav.subarray(fmt.dataStart + from, fmt.dataStart + to), 44);
  return out;
}
