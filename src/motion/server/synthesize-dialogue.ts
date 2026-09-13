/**
 * Synthesise one dialogue line via ElevenLabs TTS and park the clip in R2
 * (#1554). Called from a MotionWorkflow step; the key comes through the
 * credentials hatch, never the env.
 */

import { generateSpeech } from '@tanstack/ai';
import { generateId } from '@/platform/id';
import { STORAGE_BUCKETS } from '@/platform/server/storage/buckets';
import { uploadFile } from '#storage';
import { measureStoredMediaDuration } from '@/cast/server/sequence-elements/media-duration';
import {
  elevenLabsAdapterConfig,
  loadElevenLabsSpeech,
} from '@/models/server/elevenlabs-config';
import {
  DIALOGUE_TTS_MODEL,
  ttsUtterance,
  type VoicedDialogueLine,
} from '@/motion/dialogue-tts';
import type { MotionAudioClip } from '@/platform/server/db/schema';
import type { ReferenceImageDescription } from '@/stills/reference-image-prompt';

export type SynthesizeDialogueInput = {
  apiKey: string;
  teamId: string;
  sequenceId: string;
  shotId: string;
  line: VoicedDialogueLine;
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
  const result = await generateSpeech({
    adapter,
    text: utterance,
    voice: input.line.voiceId,
    format: 'mp3',
  });

  const id = generateId();
  const path = `${input.teamId}/${input.sequenceId}/${input.shotId}/${id}.mp3`;
  const uploaded = await uploadFile(
    STORAGE_BUCKETS.AUDIO,
    path,
    Buffer.from(result.audio, 'base64'),
    { contentType: result.contentType || 'audio/mpeg', upsert: true }
  );
  const durationSeconds = await measureStoredMediaDuration(path);

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
