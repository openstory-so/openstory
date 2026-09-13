/**
 * Synthesise a shot’s dialogue as one ElevenLabs Text to Dialogue clip
 * (#1554). Multiple speakers act the conversation in a single take — not
 * one TTS file per line. Parked in R2 and bound as `@Audio1` / `Audio 1`.
 */

import { generateId } from '@/platform/id';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { uploadFile } from '#storage';
import { createElevenLabsSdk } from '@/models/server/elevenlabs-config';
import {
  DIALOGUE_CLIP_TOKEN,
  DIALOGUE_TTS_MODEL,
  ttsUtterance,
  type VoicedDialogueLine,
} from '@/motion/dialogue-tts';
import { padWavToMinDuration, wavDurationSeconds } from './pad-dialogue-audio';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import type { ReferenceImageDescription } from '@/stills/reference-image-prompt';

export type SynthesizeDialogueInput = {
  apiKey: string;
  teamId: string;
  sequenceId: string;
  shotId: string;
  lines: readonly VoicedDialogueLine[];
  /**
   * Provider per-file floor (H3 Max 2s, Seedance 2.5 1.8s). A short
   * one-liner is padded with silence so the clip still rides as a reference.
   */
  minDurationSeconds?: number;
};

export async function synthesizeDialogueClip(
  input: SynthesizeDialogueInput
): Promise<{ clip: MotionAudioClip; characterCount: number }> {
  if (input.lines.length === 0) {
    throw new Error('synthesizeDialogueClip requires at least one line');
  }
  const turns = input.lines.map((line) => ({
    text: ttsUtterance(line.text, line.tone),
    voiceId: line.voiceId,
  }));
  const characterCount = turns.reduce((sum, turn) => sum + turn.text.length, 0);

  const client = await createElevenLabsSdk(input.apiKey);
  const stream = await client.textToDialogue.convert({
    modelId: DIALOGUE_TTS_MODEL,
    outputFormat: 'wav_44100',
    inputs: turns,
  });
  let wav = await collectStream(stream);
  let durationSeconds = wavDurationSeconds(wav);
  const min = input.minDurationSeconds;
  if (min != null && durationSeconds != null && durationSeconds < min) {
    const padded = padWavToMinDuration(wav, min);
    wav = padded.bytes;
    durationSeconds = padded.durationSeconds;
  }

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
    },
    characterCount,
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

async function collectStream(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const push = (chunk: Uint8Array) => {
    chunks.push(chunk);
    total += chunk.byteLength;
  };
  if (isWebStream(stream)) {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) push(value);
    }
  } else {
    for await (const chunk of stream) push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function isWebStream(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>
): stream is ReadableStream<Uint8Array> {
  return 'getReader' in stream && typeof stream.getReader === 'function';
}
