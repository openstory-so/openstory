/**
 * Audio Storage Service
 * Handles uploading and managing audio files in R2 Storage
 */

import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { uploadResponse } from '@/lib/storage/upload-response';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/shared/utils/file';
import { generateId } from '@/shared/id';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'audio', 'audio-storage']);

type UploadAudioOptions = {
  audioUrl: string;
  teamId: string;
  sequenceId: string;
  shotId?: string;
  sequenceTitle: string;
  sceneTitle?: string;
};

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

/**
 * Convert a string to a URL-safe slug
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

/**
 * Upload an audio file from URL to R2 Storage
 * Uses human-readable filename with short hash for uniqueness:
 * {sequence-slug}_{scene-slug}_{hash}_openstory.{ext}
 */
export async function uploadAudioToStorage(
  options: UploadAudioOptions
): Promise<StorageResult> {
  try {
    const { audioUrl, teamId, sequenceId, shotId, sequenceTitle, sceneTitle } =
      options;

    const response = await fetch(audioUrl);

    if (!response.ok) {
      throw new Error(`Failed to download audio: ${response.statusText}`);
    }

    // Determine extension from URL or content-type
    const urlExtension = getExtensionFromUrl(audioUrl);
    const responseContentType = response.headers.get('content-type');

    let extension = urlExtension;
    if (urlExtension === 'jpg' && responseContentType) {
      if (responseContentType.includes('wav')) extension = 'wav';
      else if (
        responseContentType.includes('mp3') ||
        responseContentType.includes('mpeg')
      )
        extension = 'mp3';
      else if (responseContentType.includes('ogg')) extension = 'ogg';
      else extension = 'wav'; // Default to wav for audio
    }

    const ulid = generateId();
    const shortHash = ulid.slice(-6).toLowerCase();
    const sequenceSlug = slugify(sequenceTitle) || 'audio';
    const sceneSlug = sceneTitle ? slugify(sceneTitle) : 'track';
    const filename = `${sequenceSlug}_${sceneSlug}_${shortHash}_openstory.${extension}`;

    // Store under shot path if per-scene, otherwise under sequence
    const storagePath = shotId
      ? `teams/${teamId}/sequences/${sequenceId}/frames/${shotId}/${filename}`
      : `teams/${teamId}/sequences/${sequenceId}/music/${filename}`;

    logger.info(`Generated filename: ${filename}`, {
      ulid,
      shotId,
      storagePath,
    });

    const contentType = getMimeTypeFromExtension(extension);

    // Stream directly to R2 Storage (avoids buffering entire audio in memory)
    const result = await uploadResponse(
      response,
      STORAGE_BUCKETS.AUDIO,
      storagePath,
      {
        contentType,
      }
    );

    return {
      success: true,
      url: result.publicUrl,
      path: storagePath,
    };
  } catch (error) {
    logger.error('Upload failed:', { err: error });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to upload audio',
    };
  }
}
