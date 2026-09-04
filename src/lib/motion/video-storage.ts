/**
 * Video Storage Service
 * Handles uploading and managing videos in R2 Storage
 */

import { getEnv } from '#env';
import { STORAGE_BUCKETS, r2KeyFromUrl } from '@/lib/storage/buckets';
import { getSignedUrlWithDownload } from '#storage';
import { uploadResponse } from '@/lib/storage/upload-response';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/lib/utils/file';
import { generateId } from '@/lib/db/id';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'motion', 'video-storage']);

type UploadVideoOptions = {
  videoUrl: string;
  teamId: string;
  sequenceId: string;
  shotId: string;
  sequenceTitle: string;
  sceneTitle?: string;
  /** Required to download Google Files API URIs (native Omni Flash). */
  googleApiKey?: string;
};

/**
 * Convert a string to a URL-safe slug
 * - Lowercase
 * - Replace spaces and special chars with hyphens
 * - Remove consecutive hyphens
 * - Trim hyphens from start/end
 * - Limit length to 50 chars
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

type StorageResult =
  | {
      success: true;
      url: string;
      path: string;
    }
  | {
      success: false;
      error: string;
    };

export type UploadedVideo = {
  url: string;
  path: string;
  contentType: string;
};

function videoExtensionFromSource(
  videoUrl: string,
  contentType: string | null
): string {
  const urlExtension = getExtensionFromUrl(videoUrl);
  if (urlExtension !== 'jpg') return urlExtension;
  if (contentType?.includes('webm')) return 'webm';
  if (contentType?.includes('quicktime') || contentType?.includes('mov')) {
    return 'mov';
  }
  return 'mp4';
}

/** `r2KeyFromUrl` includes the bucket; callers store the bucket-relative path. */
function storedVideoPath(key: string): string {
  const prefix = `${STORAGE_BUCKETS.VIDEOS}/`;
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/**
 * Pull a provider clip into the videos bucket. Same shape as
 * {@link uploadImageFromUrl}: callers own the key layout. Already-stored
 * `/r2/…` URLs are returned as-is (no second copy). The body is streamed
 * through {@link uploadResponse} — not buffered, then re-uploaded.
 */
export async function uploadVideoFromUrl(
  videoUrl: string,
  buildPath: (extension: string) => string,
  options?: { googleApiKey?: string }
): Promise<UploadedVideo> {
  const alreadyStored = r2KeyFromUrl(videoUrl);
  if (alreadyStored) {
    const extension = alreadyStored.split('.').pop() || 'mp4';
    return {
      url: videoUrl,
      path: storedVideoPath(alreadyStored),
      contentType: getMimeTypeFromExtension(extension),
    };
  }

  const response = await fetchVideoForUpload(videoUrl, {
    googleApiKey: options?.googleApiKey,
  });

  const extension = videoExtensionFromSource(
    videoUrl,
    response.headers.get('content-type')
  );
  const contentType = getMimeTypeFromExtension(extension);
  const storagePath = buildPath(extension);
  const result = await uploadResponse(
    response,
    STORAGE_BUCKETS.VIDEOS,
    storagePath,
    { contentType }
  );
  return { url: result.publicUrl, path: storagePath, contentType };
}

/**
 * Sequence motion ingest. Filename is `{sequence}_{scene}_{hash}_openstory.ext`.
 */
export async function uploadVideoToStorage(
  options: UploadVideoOptions
): Promise<StorageResult> {
  try {
    const {
      videoUrl,
      teamId,
      sequenceId,
      shotId,
      sequenceTitle,
      sceneTitle,
      googleApiKey,
    } = options;

    const ulid = generateId();
    const shortHash = ulid.slice(-6).toLowerCase();
    const sequenceSlug = slugify(sequenceTitle) || 'video';
    const sceneSlug = sceneTitle ? slugify(sceneTitle) : 'scene';

    logger.info(`Generated filename with hash: ${shortHash}`, {
      ulid,
      filename: `${sequenceSlug}_${sceneSlug}_${shortHash}_openstory`,
      shotId,
    });

    const uploaded = await uploadVideoFromUrl(
      videoUrl,
      (extension) =>
        `teams/${teamId}/sequences/${sequenceId}/frames/${shotId}/${sequenceSlug}_${sceneSlug}_${shortHash}_openstory.${extension}`,
      { googleApiKey }
    );
    return { success: true, url: uploaded.url, path: uploaded.path };
  } catch (error) {
    logger.error('Upload failed:', { err: error });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to upload video',
    };
  }
}

/**
 * Generate a signed download URL with custom filename
 * Uses AWS ResponseContentDisposition to force browser download
 *
 * @param path - R2 storage path (e.g., 'teams/123/sequences/456/frames/789/motion.mp4')
 * @param filename - Download filename (e.g., 'desert-scene_openstory.mp4')
 * @param expiresIn - Expiration time in seconds (default: 3600 = 1 hour)
 */
export async function getVideoDownloadUrl(
  path: string,
  filename: string,
  expiresIn: number = 3600
): Promise<string> {
  const url = await getSignedUrlWithDownload(
    STORAGE_BUCKETS.VIDEOS,
    path,
    filename,
    expiresIn
  );

  return url;
}

const GEMINI_FILES_HOST = 'generativelanguage.googleapis.com';
const DATA_URI = /^data:([^;,]+);base64,([\s\S]*)$/;

export function isDataVideoUrl(url: string): boolean {
  return url.startsWith('data:');
}

export function isGeminiFilesVideoUrl(url: string): boolean {
  if (url.startsWith('files/')) return true;
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === GEMINI_FILES_HOST &&
      parsed.pathname.includes('/files/')
    );
  } catch {
    return false;
  }
}

/** Workflows persist `step.do` results at 1 MiB. Inline Omni MP4s miss that. */
export function videoUrlFitsWorkflowCheckpoint(url: string): boolean {
  return !isDataVideoUrl(url) && url.length <= 2048;
}

export function geminiFileIdFromUrl(url: string): string | undefined {
  const match = url.match(/files\/([a-zA-Z0-9_-]+)/);
  return match?.[1];
}

function geminiFilesOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin;
    }
  } catch {
    // `files/<id>` form
  }
  const override = getEnv().GEMINI_BASE_URL;
  if (typeof override === 'string' && override.length > 0) {
    try {
      return new URL(override).origin;
    } catch {
      return override.replace(/\/$/, '');
    }
  }
  return `https://${GEMINI_FILES_HOST}`;
}

function geminiFileUrl(
  sourceUrl: string,
  fileId: string,
  kind: 'metadata' | 'download'
): string {
  const origin = geminiFilesOrigin(sourceUrl);
  return kind === 'download'
    ? `${origin}/v1beta/files/${fileId}:download?alt=media`
    : `${origin}/v1beta/files/${fileId}`;
}

async function geminiAuthedFetch(
  url: string,
  apiKey: string
): Promise<Response> {
  return globalThis.fetch(url, {
    headers: { 'x-goog-api-key': apiKey },
  });
}

export async function getGeminiFileState(
  url: string,
  apiKey: string
): Promise<'ACTIVE' | 'FAILED' | 'PROCESSING' | 'UNKNOWN'> {
  const fileId = geminiFileIdFromUrl(url);
  if (!fileId) return 'UNKNOWN';
  const response = await geminiAuthedFetch(
    geminiFileUrl(url, fileId, 'metadata'),
    apiKey
  );
  if (response.status === 404) return 'PROCESSING';
  if (!response.ok) {
    throw new Error(
      `Gemini Files API returned ${response.status} ${response.statusText}`
    );
  }
  const body: unknown = await response.json();
  const state =
    body &&
    typeof body === 'object' &&
    'state' in body &&
    typeof body.state === 'string'
      ? body.state.toUpperCase()
      : undefined;
  if (state === 'ACTIVE' || state === 'FAILED') return state;
  return 'PROCESSING';
}

function responseFromDataUri(url: string): Response {
  const match = DATA_URI.exec(url);
  if (!match?.[1] || match[2] === undefined) {
    throw new Error(
      'Malformed data URI; expected data:<mime>;base64,<payload>'
    );
  }
  const mimeType = match[1];
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Response(bytes, {
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(bytes.length),
    },
  });
}

/** Open a provider video URL as a fetch Response for R2 upload. */
export async function fetchVideoForUpload(
  url: string,
  options?: { googleApiKey?: string }
): Promise<Response> {
  if (isDataVideoUrl(url)) {
    return responseFromDataUri(url);
  }

  if (isGeminiFilesVideoUrl(url)) {
    const apiKey = options?.googleApiKey;
    if (!apiKey) {
      throw new Error(
        'Google Files API video URL requires a Google API key to download'
      );
    }
    const fileId = geminiFileIdFromUrl(url);
    if (!fileId) {
      throw new Error(`Could not parse Gemini file id from ${url}`);
    }
    const downloadUrl = /^https?:\/\//.test(url)
      ? url
      : geminiFileUrl(url, fileId, 'download');
    const response = await geminiAuthedFetch(downloadUrl, apiKey);
    if (!response.ok) {
      throw new Error(
        `Failed to download Gemini file ${fileId}: ${response.status} ${response.statusText}`
      );
    }
    return response;
  }

  const response = await globalThis.fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download video: ${response.status} ${response.statusText}`
    );
  }
  return response;
}
