/**
 * Encoder-support probe for browser export (#1397).
 *
 * `exportSequence` needs two WebCodecs encoders, and neither is universal:
 *
 * - **AAC** whenever the sequence has music or scene dialogue. Firefox ships
 *   no AAC encoder at all, so this is the common failure.
 * - **AVC** only on the re-encode path (mixed resolutions / differing decoder
 *   configs). Missing on some Linux Chromium builds.
 *
 * Without this probe the export runs its full decode pass first and dies
 * minutes later with a raw `DOMException` from the encoder error callback.
 *
 * The server-side container export (#968) covers the AAC case — it renders
 * exactly the uniform-AVC-plus-audio-mix shape — but explicitly rejects mixed
 * resolutions, so it can't stand in for the AVC case. Routing there is a
 * follow-up; this module is the prerequisite either way.
 */

import { canEncodeAudio, canEncodeVideo } from 'mediabunny';

export type EncoderNeeds = {
  /** Sequence has music or dialogue, so the AAC encoder is required. */
  audio: boolean;
  /** Transmux unavailable, so a video encoder is required to re-encode. */
  video: boolean;
  width: number;
  height: number;
  sampleRate: number;
  numberOfChannels: number;
  audioBitrate: number;
};

/**
 * Throws a message naming the missing codec(s) when the browser can't encode
 * what this export needs. Resolves silently otherwise.
 */
export async function assertEncoderSupport(needs: EncoderNeeds): Promise<void> {
  const [audioOk, videoOk] = await Promise.all([
    needs.audio
      ? canEncodeAudio('aac', {
          numberOfChannels: needs.numberOfChannels,
          sampleRate: needs.sampleRate,
          bitrate: needs.audioBitrate,
        })
      : Promise.resolve(true),
    needs.video
      ? canEncodeVideo('avc', { width: needs.width, height: needs.height })
      : Promise.resolve(true),
  ]);

  const missing: string[] = [];
  if (!audioOk) missing.push('AAC audio');
  if (!videoOk) missing.push('H.264 video');
  if (missing.length === 0) return;

  throw new Error(
    `This browser can't encode ${missing.join(' or ')}, which this export needs. Try Chrome, Edge, or Safari.`
  );
}
