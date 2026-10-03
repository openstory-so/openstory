/** Video inspection for agents. Decode at the existing Cloudflare media edge;
 * only bounded JPEGs enter the Worker, never a whole video. */
import { videoReviewFrameUrl } from '@/look/cloudflare-video';
import { measureStoredMediaDuration } from '@/cast/server/sequence-elements/media-duration';
import { bytesToBase64 } from '@/platform/base64';
import { ValidationError } from '@/platform/errors';
import type { VideoManifest } from '@/platform/server/db/schema';
import {
  fromShareableUrl,
  r2KeyFromUrl,
  toCdnUrl,
} from '@/platform/server/storage/buckets';
import { sniffImageMimeType } from '@/platform/server/storage/file';

const MAX_FRAME_BYTES = 96 * 1024;

export function reviewWindow(
  shotId: string,
  manifest: VideoManifest,
  clipDurationMs: number
) {
  if (
    !Number.isFinite(clipDurationMs) ||
    clipDurationMs <= 0 ||
    clipDurationMs > 600_000
  ) {
    throw new ValidationError(
      'Video duration is unavailable or exceeds the 10-minute frame extraction limit.'
    );
  }
  if (!manifest.length)
    return {
      startMs: 0,
      durationMs: clipDurationMs,
      source: 'whole_clip' as const,
    };
  const index = manifest.findIndex((entry) => entry.shotId === shotId);
  const entry = manifest[index];
  if (!entry)
    throw new ValidationError(
      'The selected render does not contain this shot.'
    );
  if (manifest.length === 1)
    return {
      startMs: 0,
      durationMs: clipDurationMs,
      source: 'render_manifest' as const,
    };
  if (
    manifest.some(
      (entry) => !Number.isFinite(entry.durationMs) || entry.durationMs <= 0
    )
  ) {
    throw new ValidationError('The selected render has no usable shot timing.');
  }
  const startMs = manifest
    .slice(0, index)
    .reduce((sum, entry) => sum + entry.durationMs, 0);
  const endMs =
    index === manifest.length - 1
      ? clipDurationMs
      : Math.min(clipDurationMs, startMs + entry.durationMs);
  if (endMs <= startMs)
    throw new ValidationError('This shot starts beyond the selected video.');
  return {
    startMs,
    durationMs: endMs - startMs,
    source: 'render_manifest' as const,
  };
}

export function reviewTimestamps(
  durationMs: number,
  count: number,
  timestampsMs?: number[]
) {
  if (timestampsMs) {
    if (
      timestampsMs.some(
        (time) => !Number.isFinite(time) || time < 0 || time >= durationMs
      )
    ) {
      throw new ValidationError(
        'timestampsMs must fall within the shot video window (0 inclusive, durationMs exclusive).'
      );
    }
    return timestampsMs;
  }
  // End is exclusive. Seek just inside it to retrieve the final visible frame.
  const last = Math.max(0, durationMs - 1);
  return Array.from({ length: count }, (_, i) =>
    Math.round((last * i) / (count - 1))
  );
}

export async function prepareReviewVideo(url: string) {
  const stored = fromShareableUrl(url);
  const key = r2KeyFromUrl(stored);
  const cdn = toCdnUrl(stored);
  if (!key || !cdn || !videoReviewFrameUrl(cdn, 512, 0)) {
    throw new ValidationError(
      'Frame inspection requires a stored video on the configured Cloudflare media transformation zone. Local-only storage and external videos are not supported.'
    );
  }
  const duration = await measureStoredMediaDuration(key);
  if (!duration)
    throw new ValidationError('Could not measure the stored video duration.');
  return { url: cdn, durationMs: duration * 1000 };
}

export async function readReviewFrame(
  url: string,
  timestampMs: number,
  maxWidth: number
) {
  const transformed = videoReviewFrameUrl(url, maxWidth, timestampMs);
  if (!transformed)
    throw new ValidationError(
      'Video is outside the media transformation zone.'
    );
  const response = await fetch(transformed, {
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new ValidationError(`Frame extraction failed (${response.status}).`);
  }
  if (Number(response.headers.get('content-length')) > MAX_FRAME_BYTES) {
    await response.body.cancel();
    throw new ValidationError(
      'Frame exceeds 96 KiB. Retry with a smaller maxWidth.'
    );
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_FRAME_BYTES);
  let size = 0;
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      const value = chunk.value;
      if (size + value.length > MAX_FRAME_BYTES) {
        throw new ValidationError(
          'Frame exceeds 96 KiB. Retry with a smaller maxWidth.'
        );
      }
      bytes.set(value, size);
      size += value.length;
      chunk = await reader.read();
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const image = bytes.subarray(0, size);
  if (sniffImageMimeType(image) !== 'image/jpeg') {
    throw new ValidationError('Frame extraction did not return a JPEG image.');
  }
  return {
    type: 'image' as const,
    mimeType: 'image/jpeg',
    data: bytesToBase64(image),
  };
}
