/**
 * Record a conversation with Seed Audio (#1765) — the Seed side of
 * `recordDialogueCall`, returning the same record so everything after the
 * call (sections, cuts, claims) is unchanged.
 *
 * What is different from ElevenLabs Text to Dialogue:
 *
 *  - **Up to three speakers, three references per call.** Each speaker's
 *    normal clip is always sent; a whispered or raised line also gets that
 *    mood's clip while a slot is free (none is, with three speakers). A line whose mood clip did not fit is spoken
 *    against the normal clip, with its tone in words.
 *  - **Every take is transcribed.** Seed sometimes speaks invented words.
 *    Nonsense before the script is cut off (the first shot's range starts at
 *    the script); anything else is a retake, up to {@link SEED_TAKE_ATTEMPTS}.
 *  - **Timings come from the transcription**, not from the provider: each
 *    turn is found in what Scribe heard, in order.
 */

import {
  ELEVENLABS_SCRIBE_ENDPOINT,
  scribeCost,
} from '@/billing/elevenlabs-pricing';
import {
  SEED_AUDIO_ENDPOINT,
  seedAudioCost,
} from '@/billing/seed-speech-pricing';
import {
  isSeedVoiceId,
  moodForTone,
  SEED_AUDIO_MODEL,
  type SeedVoiceBundle,
  type SeedVoiceMood,
} from '@/cast/seed-voice';
import {
  SCRIBE_MODEL,
  transcribeSpeech,
} from '@/cast/server/voice/elevenlabs-voice';
import {
  SEED_AUDIO_MAX_PROMPT_CHARS,
  SEED_AUDIO_MAX_REFERENCES,
  SEED_BOOTH_PROMPT,
  seedAudio,
} from '@/cast/server/voice/seed-audio';
import { loadSeedVoice, readSeedClip } from '@/cast/server/voice/seed-voice';
import { checkTake, locateParts } from '@/cast/server/voice/take-check';
import { generateId } from '@/platform/id';
import { getLogger } from '@/platform/logger';
import type { DialogueRecordingTurn } from '@/platform/server/db/schema';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { uploadFile } from '#storage';
import { NonRetryableError } from 'cloudflare:workflows';
import { trimmedEndSeconds, wavDurationSeconds } from './pad-dialogue-audio';
import {
  honestDataSize,
  shotSliceWindows,
  type DialogueCallLine,
  type RecordedDialogueCall,
} from './synthesize-dialogue';

const logger = getLogger(['openstory', 'workflow', 'seed-dialogue']);

/** Takes per call before the recording fails (#1765: 1 of 6 scenes needed a retake). */
const SEED_TAKE_ATTEMPTS = 3;

/**
 * Speakers per call: one reference clip each, so the reference cap is the
 * ceiling. Three held apart in testing (#1765); a fourth would have no clip
 * and Seed would invent its voice.
 */
export const SEED_MAX_SPEAKERS = SEED_AUDIO_MAX_REFERENCES;

/** Room kept before the script's first word when nonsense is cut off. */
const LEAD_SECONDS = 0.15;

export type SeedReference = { voiceId: string; mood: SeedVoiceMood };

/**
 * Which clips a call sends, `@Audio1` first: each speaker's normal clip, then
 * each other mood the lines need, in the order they first need it, while a
 * slot is free.
 */
export function pickSeedReferences(
  lines: readonly Pick<DialogueCallLine, 'voiceId' | 'tone'>[]
): SeedReference[] {
  const refs: SeedReference[] = [];
  const has = (ref: SeedReference) =>
    refs.some((r) => r.voiceId === ref.voiceId && r.mood === ref.mood);
  for (const line of lines) {
    const normal = { voiceId: line.voiceId, mood: 'normal' as const };
    if (!has(normal)) refs.push(normal);
  }
  for (const line of lines) {
    const ref = { voiceId: line.voiceId, mood: moodForTone(line.tone) };
    if (refs.length < SEED_AUDIO_MAX_REFERENCES && !has(ref)) refs.push(ref);
  }
  return refs;
}

/** The scene prompt: booth, the cast with their clips, then the lines. */
export function seedScenePrompt(
  lines: readonly DialogueCallLine[],
  refs: readonly SeedReference[],
  bundles: ReadonlyMap<string, SeedVoiceBundle>
): string {
  const tag = (voiceId: string, mood: SeedVoiceMood) => {
    const at = refs.findIndex((r) => r.voiceId === voiceId && r.mood === mood);
    return at < 0 ? null : `@Audio${at + 1}`;
  };
  const speakers = [...new Set(lines.map((line) => line.voiceId))];
  const nameOf = (voiceId: string) =>
    lines.find((line) => line.voiceId === voiceId)?.character.trim() ||
    'Narrator';
  const cast = speakers.map((voiceId) => {
    const quiet = tag(voiceId, 'quiet');
    const loud = tag(voiceId, 'loud');
    return [
      `${nameOf(voiceId)}: the exact voice and accent of ${tag(voiceId, 'normal') ?? ''}.`,
      quiet && `When whispering, the voice is ${quiet}.`,
      loud && `When raised, the voice is ${loud}.`,
      bundles.get(voiceId)?.description,
    ]
      .filter(Boolean)
      .join(' ');
  });
  const said = lines.map((line) => {
    const tone = line.tone.trim();
    return `${nameOf(line.voiceId)}${tone ? ` (${tone})` : ''}: ${line.text.trim()}`;
  });
  const who =
    speakers.length === 1 ? 'One speaker' : `${speakers.length} speakers`;
  return `${SEED_BOOTH_PROMPT} ${who}, at a natural conversational pace.\n${cast.join('\n')}\n\n${said.join('\n')}`;
}

export async function recordSeedDialogueCall(input: {
  seedKey: string;
  elevenLabsKey: string;
  teamId: string;
  sequenceId: string;
  lines: readonly DialogueCallLine[];
}): Promise<RecordedDialogueCall> {
  const { lines } = input;
  if (lines.length === 0) {
    throw new Error('recordSeedDialogueCall requires at least one line');
  }
  const older = [
    ...new Set(
      lines
        .filter((line) => !isSeedVoiceId(line.voiceId))
        .map((line) => line.character.trim() || 'The narrator')
    ),
  ];
  if (older.length > 0) {
    throw new NonRetryableError(
      `${older.join(' and ')} ${older.length === 1 ? 'has' : 'have'} an older ElevenLabs voice and share${older.length === 1 ? 's' : ''} this shot with a Seed voice; the two cannot be recorded together. Generate a new voice for ${older.join(' and ')}, then retry this shot.`
    );
  }
  const speakers = [...new Set(lines.map((line) => line.voiceId))];
  if (speakers.length > SEED_MAX_SPEAKERS) {
    throw new NonRetryableError(
      `One shot has ${speakers.length} speakers; Seed Audio takes one voice clip per speaker and ${SEED_MAX_SPEAKERS} at most. Split its lines across shots.`
    );
  }
  const bundles = new Map(
    await Promise.all(
      speakers.map(async (id) => [id, await loadSeedVoice(id)] as const)
    )
  );
  const refs = pickSeedReferences(lines);
  const references = await Promise.all(
    refs.map((ref) => {
      const bundle = bundles.get(ref.voiceId);
      if (!bundle) throw new Error(`Seed voice ${ref.voiceId} not loaded`);
      return readSeedClip(bundle.clips[ref.mood]);
    })
  );
  const prompt = seedScenePrompt(lines, refs, bundles);
  if (prompt.length > SEED_AUDIO_MAX_PROMPT_CHARS) {
    throw new NonRetryableError(
      `This conversation's Seed Audio prompt is ${prompt.length} characters; the limit is ${SEED_AUDIO_MAX_PROMPT_CHARS}. Shorten the lines or the voice descriptions.`
    );
  }
  const script = lines.map((line) => line.text).join(' ');

  let lastProblem = '';
  for (let attempt = 1; attempt <= SEED_TAKE_ATTEMPTS; attempt++) {
    const take = await seedAudio({ apiKey: input.seedKey, prompt, references });
    honestDataSize(take.wav);
    const durationSeconds = wavDurationSeconds(take.wav);
    if (durationSeconds == null) {
      throw new Error('Seed Audio returned audio that is not a PCM WAV');
    }
    const heard = await transcribeSpeech(
      input.elevenLabsKey,
      take.wav,
      'audio/wav'
    );
    const check = checkTake(script, heard.words);
    const spans = locateParts(
      heard.words,
      lines.map((line) => line.text)
    );
    if (!check.ok || spans.some((span) => !span)) {
      lastProblem = check.extraText
        ? `heard "${check.extraText.slice(0, 120)}"`
        : `missing ${check.missing.slice(0, 8).join(' ')}`;
      logger.warn(
        `[seed-dialogue] take ${attempt}/${SEED_TAKE_ATTEMPTS} failed its check: ${lastProblem}`
      );
      continue;
    }

    const turns: DialogueRecordingTurn[] = lines.map((line, at) => {
      const span = spans[at];
      if (!span) throw new Error(`Turn ${at + 1} was not found in the take`);
      return {
        shotId: line.shotId,
        index: line.index,
        voiceId: line.voiceId,
        ttsModel: SEED_AUDIO_MODEL,
        startSeconds: Math.max(0, span.start),
        endSeconds: Math.min(durationSeconds, span.end),
      };
    });
    // Nonsense before the script belongs to nobody: the first shot's range
    // starts just before the script's first word.
    const scriptStart = Math.max(
      0,
      (check.scriptStartSeconds ?? 0) - LEAD_SECONDS
    );
    const windows = shotSliceWindows(turns, durationSeconds).map(
      (window, at) => {
        const from =
          at === 0 ? Math.max(window.from, scriptStart) : window.from;
        return {
          shotId: window.shotId,
          fromSeconds: from,
          toSeconds: trimmedEndSeconds(
            take.wav,
            from,
            window.to,
            window.speechEnd
          ),
        };
      }
    );

    const recordingId = generateId();
    const uploaded = await uploadFile(
      STORAGE_BUCKETS.AUDIO,
      `${input.teamId}/${input.sequenceId}/dialogue-recordings/${recordingId}.wav`,
      take.wav,
      { contentType: 'audio/wav', upsert: true }
    );
    return {
      recordingId,
      storageKey: uploaded.fullPath,
      url: uploaded.publicUrl,
      durationSeconds,
      characterCount: script.length,
      turns,
      windows,
      charges: [
        {
          endpointId: SEED_AUDIO_ENDPOINT,
          model: SEED_AUDIO_MODEL,
          costMicros: seedAudioCost(take.billedSeconds),
        },
        {
          endpointId: ELEVENLABS_SCRIBE_ENDPOINT,
          model: SCRIBE_MODEL,
          costMicros: scribeCost(heard.seconds),
        },
      ],
    };
  }
  // ponytail: failed takes are not billed to the team; the platform eats them.
  throw new NonRetryableError(
    `Seed Audio did not say the lines in ${SEED_TAKE_ATTEMPTS} takes (last: ${lastProblem}). Try again, or reword the lines.`
  );
}
