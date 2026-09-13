/**
 * Synthesise one dialogue line via ElevenLabs TTS and park the clip in R2
 * (#1554). Called from a MotionWorkflow step; the key comes through the
 * credentials hatch, never the env.
 */

import { generateSpeech } from '@tanstack/ai';
import { generateId } from '@/platform/id';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { uploadFile } from '#storage';
import {
  elevenLabsAdapterConfig,
  loadElevenLabsSpeech,
} from '@/models/server/elevenlabs-config';
import {
  DIALOGUE_TTS_MODEL,
  ttsUtterance,
  type VoicedDialogueLine,
} from '@/motion/dialogue-tts';
import {
  padWavToMinDuration,
  pcmToWav,
  wavDurationSeconds,
} from './pad-dialogue-audio';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import type { ReferenceImageDescription } from '@/stills/reference-image-prompt';

export type SynthesizeDialogueInput = {
  apiKey: string;
  teamId: string;
  sequenceId: string;
  shotId: string;
  line: VoicedDialogueLine;
  /**
   * Provider per-file floor (H3 Max 2s, Seedance 2.5 1.8s). Short lines are
   * padded with silence so the clip still rides as a reference instead of
   * 400ing the shot.
   */
  minDurationSeconds?: number;
  /** Adjacent lines in the same shot — ElevenLabs stitching. */
  previousText?: string;
  nextText?: string;
};

export async function synthesizeDialogueLine(
  input: SynthesizeDialogueInput
): Promise<{ clip: MotionAudioClip; characterCount: number }> {
  const utterance = ttsUtterance(input.line.text, input.line.tone);
  const createSpeech = await loadElevenLabsSpeech();
  const config = elevenLabsAdapterConfig(input.apiKey);
  const adapter = createSpeech(DIALOGUE_TTS_MODEL, input.apiKey, {
    timeoutInSeconds: config.timeoutInSeconds,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
  });
  // Raw PCM so we can wrap a WAV header and pad short lines with silence
  // in-process — Workers has no ffmpeg, and `format: 'wav'` on generateSpeech
  // falls through to mp3.
  const result = await generateSpeech({
    adapter,
    text: utterance,
    voice: input.line.voiceId,
    modelOptions: {
      outputFormat: 'pcm_44100',
      ...(input.previousText ? { previousText: input.previousText } : {}),
      ...(input.nextText ? { nextText: input.nextText } : {}),
    },
  });

  const pcm = new Uint8Array(Buffer.from(result.audio, 'base64'));
  let wav = pcmToWav(pcm);
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
      token: input.line.token,
      durationSeconds,
    },
    characterCount: utterance.length,
  };
}

/** Append synthesised clips as audio references the r2v binder already knows. */
export function dialogueClipsAsReferences(
  clips: readonly MotionAudioClip[]
): ReferenceImageDescription[] {
  return clips.map((clip) => ({
    referenceImageUrl: clip.url,
    description: `Dialogue line recorded as ${clip.token}`,
    kind: 'audio' as const,
    role: 'character' as const,
    token: clip.token,
    durationSeconds: clip.durationSeconds,
  }));
}
