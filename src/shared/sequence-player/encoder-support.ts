/**
 * Encoder-support probe for browser export (#1397) and the route that picks
 * the server-side container when the browser can't encode AAC (#1402).
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
 * The server-side container export (#968) covers both gaps: AAC mix and
 * mixed-res decode→letterbox→re-encode. `chooseExportRoute` sends any encoder
 * gap to the container when it is bound; otherwise keep the #1397 error
 * (plain `bun dev`, PR previews, e2e).
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

export type EncoderProbe = {
  audioOk: boolean;
  videoOk: boolean;
};

export type EncoderGap = {
  missingAac: boolean;
  missingAvc: boolean;
  canTransmux: boolean;
};

export type ExportRoute = 'server' | 'unsupported';

/**
 * Named error thrown when the browser cannot encode what this export needs.
 * Theatre prefers the container when it is bound; this is the #1397 toast
 * when it is not.
 */
export class EncoderUnsupportedError extends Error {
  readonly missingAac: boolean;
  readonly missingAvc: boolean;
  readonly canTransmux: boolean;

  constructor(gap: EncoderGap) {
    super(encoderSupportMessage(gap));
    this.name = 'EncoderUnsupportedError';
    this.missingAac = gap.missingAac;
    this.missingAvc = gap.missingAvc;
    this.canTransmux = gap.canTransmux;
  }
}

function encoderSupportMessage(gap: {
  missingAac: boolean;
  missingAvc: boolean;
}): string {
  const missing: string[] = [];
  if (gap.missingAac) missing.push('AAC audio');
  if (gap.missingAvc) missing.push('H.264 video');
  return `This browser can't encode ${missing.join(' or ')}, which this export needs. Try Chrome, Edge, or Safari.`;
}

export async function probeEncoderSupport(
  needs: EncoderNeeds
): Promise<EncoderProbe> {
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
  return { audioOk, videoOk };
}

/**
 * Throws a message naming the missing codec(s) when the browser can't encode
 * what this export needs. Resolves silently otherwise.
 */
export async function assertEncoderSupport(needs: EncoderNeeds): Promise<void> {
  const { audioOk, videoOk } = await probeEncoderSupport(needs);
  if (audioOk && videoOk) return;
  throw new Error(
    encoderSupportMessage({ missingAac: !audioOk, missingAvc: !videoOk })
  );
}

/**
 * Decide whether an encoder gap can be rescued by the container.
 *
 * When the container (or `VIDEO_EXPORT_DEV_URL`) is bound it handles AAC
 * mix and mixed-res re-encode. Otherwise keep the #1397 error.
 */
export function chooseExportRoute(
  _gap: EncoderGap,
  serverExportAvailable: boolean
): ExportRoute {
  return serverExportAvailable ? 'server' : 'unsupported';
}
