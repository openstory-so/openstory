/**
 * Manual media inject helpers (#1108 Phase 3) — shared by the upload server
 * fns and their tests.
 *
 * The staleness contract for uploads (plan §4.4): a user-provided still/video
 * stamps its `inputHash` from the CURRENT inputs — the same builder the
 * generating workflow and the staleness verify use — so a later upstream edit
 * correctly re-stales it. `USER_UPLOAD_MODEL` is not a valid generation model
 * id, so `resolveImageModel` / `safeTextToImageModel` fall through to the next
 * tier wherever a real model is required.
 */

import { DEFAULT_IMAGE_MODEL, safeTextToImageModel } from '@/lib/ai/models';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type {
  Character,
  SequenceElement,
  SequenceLocation,
} from '@/lib/db/schema';
import { r2KeyFromUrl, type StorageBucket } from '@/lib/storage/buckets';
import { getExtensionFromUrl } from '@/lib/utils/file';
import { buildRegenerateShotSnapshot } from '@/lib/workflows/regenerate-shots-snapshot';

/**
 * Sentinel `model` for user-uploaded versions (stills, clips, tracks). Never a
 * valid generation model id — the model-resolution tiers skip it by design.
 */
export const USER_UPLOAD_MODEL = 'user-upload';

/**
 * Extensions each upload surface accepts. The PUT route takes its
 * `contentType` straight from the query string, so the client's `accept=`
 * filter is not a control — this allow-list is, and it is what keeps a
 * script-bearing `.svg` (or an `.html` typed as such) out of a bucket the
 * worker serves same-origin from `/r2/`.
 */
const UPLOAD_EXTENSIONS = {
  image: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
  video: ['mp4', 'webm', 'mov'],
  audio: ['mp3', 'wav', 'ogg', 'm4a'],
} as const satisfies Record<string, readonly string[]>;

export type UploadMediaSurface = keyof typeof UPLOAD_EXTENSIONS;

/**
 * The storage extension for an uploaded `filename`, or null when the surface
 * doesn't accept it. Deliberately NOT `getExtensionFromUrl`'s bare result:
 * that falls back to `jpg` for an extensionless name, which would store an
 * arbitrary body under an image extension.
 */
export function resolveUploadExtension(
  filename: string,
  surface: UploadMediaSurface
): string | null {
  if (!/\.[a-zA-Z0-9]+$/.test(filename)) return null;
  const ext = getExtensionFromUrl(filename);
  const allowed: readonly string[] = UPLOAD_EXTENSIONS[surface];
  return allowed.includes(ext) ? ext : null;
}

/** Human-readable accepted list, for the rejection message. */
export function uploadExtensionList(surface: UploadMediaSurface): string {
  return UPLOAD_EXTENSIONS[surface].join(', ');
}

/**
 * Parse a finalize-time media URL back to its bucket-relative `storagePath`
 * (the form the variant tables store), enforcing the team namespace: the key
 * must live exactly under `<bucket>/teams/<teamId>/` with no empty or `..`
 * segments (same boundary as `isValidElementStoragePath`). Returns null when
 * the URL is not a stored `/r2/` URL or escapes the namespace.
 */
export function parseUploadedStoragePath(
  publicUrl: string,
  bucket: StorageBucket,
  teamId: string
): string | null {
  const key = r2KeyFromUrl(publicUrl);
  if (key === null) return null;
  const prefix = `${bucket}/teams/${teamId}/`;
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  if (rest.length === 0) return null;
  if (rest.split('/').some((seg) => seg === '' || seg === '..')) return null;
  // storagePath is bucket-relative (matches uploadImageToStorage rows).
  return key.slice(`${bucket}/`.length);
}

/**
 * Input hash for an uploaded still, computed EXACTLY the way the staleness
 * verify recomputes it (`buildRegenerateShotSnapshot` — the same function
 * `computeShotStaleness` calls), so stamp == verify by construction (§8 risk
 * note). `promptText` is the prompt the upload is fresh against: the current
 * selection for an image-only replace (§4.3 B) or the NEW text for the atomic
 * prompt+image replace (§4.3 C).
 *
 * Returns null when there is no prompt: the verify side only compares when a
 * selected prompt exists, so a null stamp reads 'untracked' (never falsely
 * stale) until a prompt enters the picture.
 *
 * The model folded into the hash is `safeTextToImageModel(USER_UPLOAD_MODEL)`
 * → the app default — the same resolution the verify applies to the stored
 * row's `user-upload` model.
 */
export async function computeUploadedStillInputHash(args: {
  shotId: string;
  frameId: string;
  scene: Scene | null;
  promptText: string | null;
  characters: Character[];
  locations: SequenceLocation[];
  elements: SequenceElement[];
  aspectRatio: AspectRatio;
}): Promise<string | null> {
  if (!args.promptText || args.promptText.length === 0) return null;
  const snapshot = await buildRegenerateShotSnapshot({
    shot: { id: args.shotId },
    scene: args.scene,
    frameId: args.frameId,
    imagePrompt: args.promptText,
    characters: args.characters,
    locations: args.locations,
    elements: args.elements,
    imageModel: safeTextToImageModel(USER_UPLOAD_MODEL, DEFAULT_IMAGE_MODEL),
    aspectRatio: args.aspectRatio,
  });
  return snapshot.snapshotInputHash;
}
