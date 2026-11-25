/** R2 keys for gateway outputs: `teams/<organizationId>/<folder>/output-<n>.<ext>`. */

import {
  organizationKeyPrefix,
  STORAGE_BUCKETS,
  type StorageBucket,
} from '@/platform/server/storage/buckets';
import { getMimeTypeFromExtension } from '@/platform/server/storage/file';
import { uploadResponse } from '@/platform/server/storage/upload-response';
import type { GatewayJobKind, GatewayJobOutput } from '@/gateway/schema';
import type { GatewayMedia } from '@/gateway/server/providers';

/** R2 bucket per activity — assets reuse the existing media buckets. */
const ACTIVITY_BUCKETS: Record<GatewayJobKind, StorageBucket> = {
  image: STORAGE_BUCKETS.THUMBNAILS,
  video: STORAGE_BUCKETS.VIDEOS,
  audio: STORAGE_BUCKETS.AUDIO,
};

/** Extension map for provider URLs with no file extension (common on fal). */
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
};

/**
 * R2 key extension for one output: from the URL path when it has one,
 * otherwise from the content type — fal media URLs frequently omit the
 * extension, and defaulting a video to `.jpg` produces misleading download
 * filenames. `bin` when neither source knows.
 */
export function outputExtension(
  url: string,
  contentType: string | null
): string {
  try {
    const match = /\.([a-zA-Z0-9]+)$/.exec(new URL(url).pathname);
    if (match?.[1]) return match[1].toLowerCase();
  } catch {
    // Not an absolute URL — fall through to the content type.
  }
  const mime = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return (mime && EXTENSION_BY_MIME[mime]) || 'bin';
}

/** Streams one output into R2; runs in the step that produced it (#1645). */
export async function storeGatewayOutput(params: {
  media: GatewayMedia;
  kind: GatewayJobKind;
  organizationId: string;
  /** Under the organization's prefix, e.g. `gateway/<jobId>`. */
  folder: string;
  index: number;
}): Promise<GatewayJobOutput> {
  const { media } = params;
  let response: Response;
  let known: string | null;
  if ('base64' in media) {
    const bytes = Uint8Array.from(atob(media.base64), (c) => c.charCodeAt(0));
    response = new Response(bytes, {
      headers: { 'content-length': String(bytes.byteLength) },
    });
    known = media.contentType;
  } else {
    response = await fetch(media.url);
    if (!response.ok) {
      throw new Error(`Could not download the output (${response.status})`);
    }
    known = media.contentType ?? response.headers.get('content-type');
  }
  const extension = outputExtension('url' in media ? media.url : '', known);
  const contentType = known ?? getMimeTypeFromExtension(extension);
  const uploaded = await uploadResponse(
    response,
    ACTIVITY_BUCKETS[params.kind],
    `${organizationKeyPrefix(params.organizationId)}/${params.folder}/output-${params.index}.${extension}`,
    { contentType }
  );
  return { url: uploaded.publicUrl, path: uploaded.path, contentType };
}
