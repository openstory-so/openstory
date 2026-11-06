/**
 * Send an uploaded audio file to the video-export container and return the
 * WAV response (#2265). The body is streamed both ways: the Worker does not
 * buffer the source or the WAV.
 *
 * The container is production-only, same as export. Callers ask
 * `isServerExportAvailable` first and keep the no-container refusal when it
 * is false. `bun dev:all` sets `VIDEO_EXPORT_DEV_URL` and hits `bun dev:bunny`.
 */

import { getEnv } from '#env';
import { ValidationError } from '@/platform/errors';

/** One warm instance for a burst of uploads. `sleepAfter` on the DO still applies. */
const TRANSCODE_INSTANCE = 'audio-transcode';

type AudioTranscodeSource = {
  body: ReadableStream<Uint8Array>;
  byteLength: number;
  contentType: string;
};

type AudioTranscodeResult = {
  response: Response;
  byteLength: number;
};

function containerMessage(detail: string): string {
  try {
    const parsed: unknown = JSON.parse(detail);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'error' in parsed &&
      typeof parsed.error === 'string' &&
      parsed.error.length > 0
    ) {
      return parsed.error;
    }
  } catch {
    // The body was not JSON; use it raw below.
  }
  return detail;
}

/**
 * POST the source to `/transcode-audio` and return the WAV response, still
 * unread. A 4xx is the file; anything else is the container being down.
 */
export async function transcodeAudioUpload(
  source: AudioTranscodeSource
): Promise<AudioTranscodeResult> {
  const env = getEnv();
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: {
      'content-type': source.contentType,
      'content-length': String(source.byteLength),
    },
    body: source.body,
    duplex: 'half',
  };

  let response: Response;
  const devUrl = env.VIDEO_EXPORT_DEV_URL;
  if (devUrl) {
    response = await fetch(
      `${devUrl.replace(/\/$/, '')}/transcode-audio`,
      init
    );
  } else {
    const ns = env.VIDEO_EXPORT_CONTAINER;
    if (!ns) {
      throw new Error(
        'VIDEO_EXPORT_CONTAINER binding unavailable - audio transcode runs in production only'
      );
    }
    // Dynamic: a top-level import of Container does not construct under Vitest.
    const { getContainer } = await import('@cloudflare/containers');
    response = await getContainer(ns, TRANSCODE_INSTANCE).fetch(
      new Request('http://video-export/transcode-audio', init)
    );
  }

  if (!response.ok || !response.body) {
    const detail = containerMessage(
      (await response.text().catch(() => '')).slice(0, 300)
    );
    if (response.status >= 400 && response.status < 500) {
      throw new ValidationError(
        detail || 'That audio could not be converted to WAV.'
      );
    }
    throw new Error(`Audio transcode failed (${response.status}): ${detail}`);
  }

  const byteLength = Number(response.headers.get('content-length'));
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new Error(
      'Audio transcode returned no content-length - cannot stream the WAV to R2'
    );
  }
  return { response, byteLength };
}
