/**
 * ShotView — a shot with the rows a read path resolves alongside it.
 *
 * A shot owns no assets. Its still lives on the anchor `frame`'s selected
 * `frame_variants` row, its prompt on the selected `frame_prompt_versions` row,
 * and its video on the `video_variants` row the shot's render segment points
 * at. This type is the assembled read model — it exposes those rows AS
 * THEMSELVES rather than flattening them into a third set of names.
 */

import type { AssemblableMotionPrompt } from '@/lib/ai/scene-analysis.schema';
import type {
  Frame,
  FramePromptVersion,
  FrameVariant,
  Shot,
  VideoVariant,
} from '@/lib/db/schema';

/**
 * The narrow slice of a shot's sources that readiness tallies are derived from
 * — a still url and a video lifecycle, nothing else.
 *
 * Exists so a caller that only needs counts (`GET /api/v1/sequences`) can read
 * five scalar columns instead of materialising a full {@link ShotView} per
 * shot: the wide view carries `shots.metadata`, the visual prompt and the
 * motion prompt, which together made listing a page of sequences approach the
 * 128 MB isolate ceiling (#1161). The derivations below are shared with
 * {@link toShotView}, so the two paths cannot report different readiness.
 */
export type ShotReadiness = {
  /** `frame_variants.url` of the anchor frame's SELECTED image version. */
  selectedImageUrl: string | null;
  /** `frame_variants.url` of the anchor frame's newest `kind: 'preview'` row. */
  previewImageUrl: string | null;
  /** Whether `render_segments.selectedVideoVersionId` resolves to a version. */
  hasSelectedVideo: boolean;
  /** `status` of the newest non-`variantOnly` render, or null if none exists. */
  primaryVideoStatus: VideoVariant['status'] | null;
};

/**
 * The still url a shot exposes, or null while it has none: the selected
 * variant's stored url, else the fast preview variant's CDN url.
 */
export function readinessImageUrl(
  readiness: Pick<ShotReadiness, 'selectedImageUrl' | 'previewImageUrl'>
): string | null {
  return readiness.selectedImageUrl ?? readiness.previewImageUrl ?? null;
}

/**
 * A shot's video status. The newest primary render's lifecycle wins; a shot
 * with no primary render behind its selection reads `completed` (pre-#1067
 * rows), and one with neither reads `pending` — see {@link ShotView.videoStatus}.
 */
export function readinessVideoStatus(
  readiness: Pick<ShotReadiness, 'hasSelectedVideo' | 'primaryVideoStatus'>
): VideoVariant['status'] {
  return (
    readiness.primaryVideoStatus ??
    (readiness.hasSelectedVideo ? 'completed' : 'pending')
  );
}

export type ShotGridSheet = {
  url: string | null;
  // Sourced from a `frame_variants` row, whose status union is wider than the
  // frame's (adds 'cancelled', #1085).
  status: Frame['imageStatus'] | FrameVariant['status'];
};

/**
 * The rows a shot's view is assembled from. An object (not positional args) so
 * adding a source can't silently re-bind an existing one. Required, not
 * optional, so a new read path can't quietly assemble an empty view for a shot
 * that has one.
 */
export type ShotViewSources = {
  /** The anchor frame's selected `frame_variants` row. */
  image: FrameVariant | null;
  /**
   * The anchor frame's newest non-discarded `kind: 'preview'` row (#1101) —
   * the pre-prompt stand-in shown while the real still is still being made.
   * Never selectable, so it is resolved as its own source rather than through
   * `frames.selectedImageVersionId`.
   */
  preview: FrameVariant | null;
  /** The anchor frame's selected `frame_prompt_versions` row. */
  imagePromptVersion: FramePromptVersion | null;
  /** The version `render_segments.selectedVideoVersionId` points at. */
  video: VideoVariant | null;
  /**
   * The newest non-`variantOnly` render for the shot's segment — its lifecycle
   * IS the shot's video status. Separate from `video` because only a
   * `completed` version is ever selectable, so the pointer alone can never
   * express generating/failed.
   */
  primaryVideo: VideoVariant | null;
  gridSheet?: ShotGridSheet | null;
  motionPrompt?: AssemblableMotionPrompt | null;
  /**
   * In-flight variant upscale: the generating framing version the promote
   * claim points at, when it already has a cropped-tile url (minted at
   * click). Regular still gens are also `generating` with a null url, so
   * the url is the discriminator.
   */
  pendingUpscaleUrl?: string | null;
};

export type ShotView = Shot & {
  /** The anchor frame — owns the still's lifecycle (status/error). */
  frame: Frame;
  image: FrameVariant | null;
  imagePromptVersion: FramePromptVersion | null;
  /**
   * Derived, not stored: the url of the newest non-discarded `kind: 'preview'`
   * version (#1101) — what `frames.previewImageUrl` used to hold. A raw fal CDN
   * url that expires, so it is a fallback BEHIND `image.url`, never a still.
   */
  previewThumbnailUrl: string | null;
  video: VideoVariant | null;
  primaryVideo: VideoVariant | null;
  /**
   * Derived, not stored: the newest primary render's lifecycle wins, so
   * re-rolling over a good video reads 'generating'. Falls back to the
   * selection for pre-#1067 rows that have no primary render behind them, and
   * to 'pending' when nothing has been rendered at all — a shot awaiting its
   * first render is exactly what the dropped `shots.videoStatus` column meant
   * by its `DEFAULT 'pending'`, and "not yet rendered" is how every eligibility
   * check spells "generate this one".
   */
  videoStatus: VideoVariant['status'];
  gridSheet: ShotGridSheet | null;
  motionPrompt: AssemblableMotionPrompt | null;
  /** Cropped tile for an in-flight variant upscale, or null. */
  pendingUpscaleUrl: string | null;
  /**
   * Client-only: grid-cell index for the CSS overlay while an upscale runs.
   * Server assembly always sends null; optimistic select and SSE clear it.
   */
  pendingUpscaleIndex: number | null;
};

/**
 * Assemble a shot whose anchor frame row is absent. Every shot should own one
 * (migration backfill + `shots.ensureAnchorFrames`), but a batch read that
 * left-joins must not DROP a frameless shot — that would make it vanish from
 * the list.
 */
export function shotViewMissingFrame(
  shot: Shot,
  video: Pick<ShotViewSources, 'video' | 'primaryVideo' | 'motionPrompt'>
): ShotView {
  const frame: Frame = {
    // Synthetic in-memory placeholder ONLY — never persisted and never used for
    // a frame_variants lookup. `id: shot.id` deliberately resurrects the
    // migration-only frame.id == shot.id equality the rest of the codebase
    // forbids at runtime (frames.ts `getAnchorByShot`); it is safe solely
    // because a frameless shot has no variants to resolve by frame id. Do NOT
    // pass this id to any `frame_variants`/`frame_prompt_versions` query.
    id: shot.id,
    shotId: shot.id,
    sequenceId: shot.sequenceId,
    orderIndex: 0,
    role: 'first',
    imageStatus: null,
    imageWorkflowRunId: null,
    imageError: null,
    selectedImageVersionId: null,
    selectedImagePromptVersionId: null,
    pendingPromoteVersionId: null,
    createdAt: shot.createdAt,
    updatedAt: shot.updatedAt,
  };
  // A frameless shot still has a video: video hangs off the segment.
  return toShotView(shot, frame, {
    image: null,
    preview: null,
    imagePromptVersion: null,
    ...video,
  });
}

export function toShotView(
  shot: Shot,
  frame: Frame,
  sources: ShotViewSources
): ShotView {
  const { image, preview, imagePromptVersion, video, primaryVideo } = sources;
  return {
    ...shot,
    frame,
    image,
    previewThumbnailUrl: preview?.url ?? null,
    imagePromptVersion,
    video,
    primaryVideo,
    videoStatus: readinessVideoStatus({
      hasSelectedVideo: video !== null,
      primaryVideoStatus: primaryVideo?.status ?? null,
    }),
    gridSheet: sources.gridSheet ?? null,
    motionPrompt: sources.motionPrompt ?? null,
    pendingUpscaleUrl: sources.pendingUpscaleUrl ?? null,
    pendingUpscaleIndex: null,
  };
}

/** Crop url on a generating pending-promote version; otherwise null. */
export function pendingUpscaleUrlFromVersion(
  version: FrameVariant | null | undefined
): string | null {
  if (
    !version ||
    version.status !== 'generating' ||
    !version.url ||
    !isBrowserDisplayableStillUrl(version.url)
  ) {
    return null;
  }
  return version.url;
}

/**
 * Trim URLs (`/cdn-cgi/image/trim=`) only resolve through a Cloudflare
 * Image Resizing edge. Patching one into `image.url` is what #1193's broken
 * preview was. `/r2/` and ordinary https URLs are safe to show.
 */
export function isBrowserDisplayableStillUrl(url: string): boolean {
  return !url.includes('/cdn-cgi/image/');
}

/**
 * Optimistic shot after the user picks a grid tile: keep the current still
 * (or swap in a displayable crop), spin the frame, remember the cell index
 * for the CSS overlay, and drop the old motion so the player doesn't keep
 * playing the previous video over the new start frame.
 */
export function shotAfterVariantSelect(
  shot: ShotView,
  imageUrl?: string,
  variantIndex?: number
): ShotView {
  return {
    ...shot,
    image:
      imageUrl && shot.image ? { ...shot.image, url: imageUrl } : shot.image,
    frame: { ...shot.frame, imageStatus: 'generating' },
    pendingUpscaleUrl: imageUrl ?? shot.pendingUpscaleUrl ?? null,
    pendingUpscaleIndex: variantIndex ?? shot.pendingUpscaleIndex ?? null,
    video: null,
    videoStatus: 'pending',
  };
}
