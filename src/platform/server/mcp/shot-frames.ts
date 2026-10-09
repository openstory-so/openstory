/**
 * Inline review frames for MCP (#2009).
 *
 * Sandboxed agents cannot fetch `*.openstory.so`. The Worker can: it asks
 * Cloudflare Media / Image Transformations for a small JPEG and returns the
 * bytes as an MCP image block. The clip itself never enters the isolate.
 */

/** Same host `app-image.tsx` and `cloudflare-video.ts` transform through. */
const TRANSFORM_HOST = 'assets.openstory.so';

/** Stay under the 256 KiB MCP response cap once base64 and JSON are added. */
const FRAME_JPEG_MAX_BYTES = 48_000;

const ZONE = 'openstory.so';

export function isOpenStoryZoneUrl(src: string): boolean {
  try {
    const url = new URL(src);
    return (
      url.protocol === 'https:' &&
      (url.hostname === ZONE || url.hostname.endsWith(`.${ZONE}`))
    );
  } catch {
    return false;
  }
}

/**
 * Evenly spaced instants across the clip, always including the start and a
 * frame just before the end. Explicit timestamps replace the grid.
 */
export function sampleTimestamps(
  durationMs: number,
  count: number,
  explicit?: number[]
): number[] {
  const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const last = duration > 50 ? duration - 50 : 0;
  const clamp = (ms: number) =>
    Math.min(Math.max(0, Math.round(ms)), last || duration);
  if (explicit && explicit.length > 0) {
    return explicit.slice(0, 8).map(clamp);
  }
  const n = Math.min(8, Math.max(1, Math.trunc(count)));
  if (n === 1) return [0];
  return Array.from({ length: n }, (_, index) =>
    Math.round((last * index) / (n - 1))
  );
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

export function frameJpegUrl(
  videoUrl: string,
  timestampMs: number,
  width: number
): string {
  return `https://${TRANSFORM_HOST}/cdn-cgi/media/mode=frame,time=${seconds(timestampMs)},format=jpg,width=${width}/${videoUrl}`;
}

/** One grid still of the clip. Tile order is left to right, top to bottom. */
export function spritesheetJpegUrl(
  videoUrl: string,
  durationMs: number,
  imageCount: number,
  width: number
): string {
  const duration = Math.max(durationMs / 1000, 0.1).toFixed(2);
  return `https://${TRANSFORM_HOST}/cdn-cgi/media/mode=spritesheet,time=0s,duration=${duration}s,imageCount=${imageCount},format=jpg,width=${width}/${videoUrl}`;
}

export function stillJpegUrl(imageUrl: string, width: number): string {
  return `https://${TRANSFORM_HOST}/cdn-cgi/image/width=${width},quality=75,format=jpeg/${imageUrl}`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** Download a transform result. Anything that is not a small image is skipped. */
export async function fetchJpeg(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<Uint8Array | null> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const type = response.headers.get('content-type') ?? '';
  if (type && !type.includes('image/')) return null;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > FRAME_JPEG_MAX_BYTES) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > FRAME_JPEG_MAX_BYTES) {
    return null;
  }
  return bytes;
}
