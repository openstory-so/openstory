/**
 * Which audio an upload may store (#2265).
 *
 * MP3 and WAV are stored as themselves. M4A, OGG and FLAC are stored as
 * 16-bit 48 kHz mono WAV when the video-export container can run, and refused
 * with the no-container message when it cannot (plain `bun dev`, e2e). Music
 * is the exception there: the browser plays M4A and OGG, so those still store
 * as themselves until a container is up. `dialogue` is a scene recording
 * (#2264): WAV until a container is up, then M4A, OGG and FLAC become WAV too.
 */

import { ValidationError } from '@/platform/errors';
import { UPLOAD_EXTENSIONS } from '@/shots/server/upload-media';

/** Media type to extension, for every type any use accepts. */
const UPLOAD_MEDIA_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

/** Re-encoded to WAV. Not stored under these extensions. */
const TRANSCODE_EXTENSIONS = new Set(['m4a', 'ogg', 'flac']);

const ELEMENT_EXTENSIONS = [
  ...UPLOAD_EXTENSIONS.image,
  'mp3',
  'wav',
  'mp4',
  'mov',
];

export type AudioUploadUse =
  | 'shot_image'
  | 'shot_video'
  | 'music'
  | 'character_sheet'
  | 'location_sheet'
  | 'element'
  | 'studio'
  | 'stitch'
  | 'dialogue';

export type AudioUploadPlan = {
  extension: string;
  /** Stored object type. `audio/wav` when `transcode` is set. */
  contentType: string;
  transcode: boolean;
};

function baseExtensions(use: AudioUploadUse): readonly string[] {
  switch (use) {
    case 'shot_image':
    case 'character_sheet':
    case 'location_sheet':
      return UPLOAD_EXTENSIONS.image;
    case 'shot_video':
      return UPLOAD_EXTENSIONS.video;
    case 'music':
      return UPLOAD_EXTENSIONS.audio;
    case 'element':
    case 'studio':
      return ELEMENT_EXTENSIONS;
    case 'stitch':
      return [
        ...UPLOAD_EXTENSIONS.image,
        ...UPLOAD_EXTENSIONS.video,
        ...UPLOAD_EXTENSIONS.audio,
      ];
    case 'dialogue':
      return ['wav'];
  }
}

/** Uses whose non-MP3/WAV audio the container re-encodes. */
function transcodes(use: AudioUploadUse): boolean {
  return (
    use === 'element' ||
    use === 'studio' ||
    use === 'music' ||
    use === 'dialogue'
  );
}

function allowedExtensions(
  use: AudioUploadUse,
  transcoderAvailable: boolean
): readonly string[] {
  const base = baseExtensions(use);
  if (!transcoderAvailable || !transcodes(use)) return base;
  return [...base, ...TRANSCODE_EXTENSIONS];
}

/**
 * The refusal for this environment, or null when the file may be stored.
 * The words are the no-container list, so plain dev and e2e keep today's message.
 */
function audioUploadRefusal(
  use: AudioUploadUse,
  mediaType: string,
  transcoderAvailable: boolean
): string | null {
  const type = mediaType.trim().toLowerCase();
  const ext = UPLOAD_MEDIA_TYPES[type];
  if (!ext || !allowedExtensions(use, transcoderAvailable).includes(ext)) {
    return `A ${use} upload must be ${baseExtensions(use).join(', ')}; got ${type || 'no type'}.`;
  }
  return null;
}

export function planAudioUpload(
  use: AudioUploadUse,
  mediaType: string,
  transcoderAvailable: boolean
): AudioUploadPlan {
  const refusal = audioUploadRefusal(use, mediaType, transcoderAvailable);
  if (refusal) throw new ValidationError(refusal);
  const type = mediaType.trim().toLowerCase();
  const ext = UPLOAD_MEDIA_TYPES[type] ?? '';
  if (transcoderAvailable && transcodes(use) && TRANSCODE_EXTENSIONS.has(ext)) {
    return { extension: 'wav', contentType: 'audio/wav', transcode: true };
  }
  return { extension: ext, contentType: type, transcode: false };
}
