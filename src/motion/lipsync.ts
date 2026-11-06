/**
 * Lip-sync a finished clip to its dialogue (#2263).
 *
 * sync-3 (`fal-ai/sync-lipsync/v3`) rewrites mouth movement on a clip that
 * already exists. The section already fits the shot (`dialogueFitBudget`),
 * so the call uses `cut_off` and does not remap timing. The price is a
 * static card until `model_pricing` carries the fal row.
 *
 * Client-safe: the cost estimate and the server gate share this module.
 */

import { usdToMicros, type Microdollars } from '@/billing/money';
import type { ImageToVideoModel } from '@/models/models';
import type { RenderedResolution } from '@/models/resolutions';
import { modelTakesDialogueAudio } from '@/motion/dialogue-tts';

/** Catalog id stamped on the version. Not an image-to-video model, so the
 * voiceless-model audio shortcut does not apply and a later voice edit
 * marks this version stale. */
export const LIPSYNC_MODEL_ID = 'sync-lipsync-3';

export const LIPSYNC_FAL_ENDPOINT = 'fal-ai/sync-lipsync/v3';

/** The section already fits. Do not remap the clip. */
export const LIPSYNC_SYNC_MODE = 'cut_off' as const;

/** fal's published sync-3 rate, USD per minute of source video. */
const LIPSYNC_USD_PER_MINUTE = 8;

const FALLBACK_DURATION_SECONDS = 5;

export function estimateLipsyncCost(durationSeconds: number): Microdollars {
  const seconds =
    Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : FALLBACK_DURATION_SECONDS;
  return usdToMicros((seconds / 60) * LIPSYNC_USD_PER_MINUTE);
}

export function lipsyncFalInput(
  videoUrl: string,
  audioUrl: string
): {
  video_url: string;
  audio_url: string;
  sync_mode: typeof LIPSYNC_SYNC_MODE;
} {
  return {
    video_url: videoUrl,
    audio_url: audioUrl,
    sync_mode: LIPSYNC_SYNC_MODE,
  };
}

/**
 * Copy a render manifest and restamp only this shot's dialogue audio.
 * Picture pointers stay, so a later prompt or still still stales the
 * lip-sync for a re-render.
 */
export function lipsyncManifest<
  T extends {
    shotId: string;
    audioClipIds: string[];
    audioSourceKey: string | null;
  },
>(
  manifest: readonly T[],
  shotId: string,
  audio: { clipIds: readonly string[]; sourceKey: string }
): T[] {
  return manifest.map((entry) =>
    entry.shotId === shotId
      ? {
          ...entry,
          audioClipIds: [...audio.clipIds],
          audioSourceKey: audio.sourceKey,
        }
      : { ...entry }
  );
}

export type LipsyncRefusal =
  | 'no-clip'
  | 'packed'
  | 'generating'
  | 'no-audio'
  | 'many-clips'
  | 'unkeyed-audio';

export const LIPSYNC_REFUSAL: Record<LipsyncRefusal, string> = {
  'no-clip': 'This shot has no finished clip to lip-sync.',
  packed: 'Lip-sync works on a single-shot clip.',
  generating: 'A video is already generating for this shot.',
  'no-audio': 'This shot has no dialogue audio to lip-sync.',
  'many-clips': 'This shot has more than one dialogue clip.',
  'unkeyed-audio': 'Record the dialogue before lip-syncing.',
};

type LipsyncClip = {
  id: string;
  url: string;
  sourceKey?: string;
  durationSeconds: number | null;
};

type LipsyncEntry = {
  shotId: string;
  durationMs?: number;
  audioClipIds: string[];
  audioSourceKey: string | null;
};

export type LipsyncPlan<T extends LipsyncEntry = LipsyncEntry> = {
  renderSegmentId: string;
  videoUrl: string;
  audioUrl: string;
  clipIds: string[];
  sourceKey: string;
  manifest: T[];
  durationSeconds: number;
  resolution: RenderedResolution | null;
  cost: Microdollars;
};

function positiveSeconds(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * Whether this shot can be lip-synced, and the snapshot a run needs.
 * Packed clips and in-flight renders are refused. One dialogue file, keyed
 * to the lines it speaks.
 */
export function planLipsync<T extends LipsyncEntry>(input: {
  shotId: string;
  renderSegmentId: string | null;
  selected: {
    url: string | null;
    status: string;
    resolution?: RenderedResolution | null;
    manifest: readonly T[];
  } | null;
  generating: boolean;
  clips: readonly LipsyncClip[] | null;
  shotDurationMs: number | null;
}): { ok: true; plan: LipsyncPlan<T> } | { ok: false; reason: LipsyncRefusal } {
  if (!input.renderSegmentId) return { ok: false, reason: 'no-clip' };
  if (input.generating) return { ok: false, reason: 'generating' };
  const selected = input.selected;
  if (!selected?.url || selected.status !== 'completed') {
    return { ok: false, reason: 'no-clip' };
  }
  const entry = selected.manifest[0];
  if (selected.manifest.length !== 1 || entry?.shotId !== input.shotId) {
    return { ok: false, reason: 'packed' };
  }

  const clips = (input.clips ?? []).filter((clip) => clip.url);
  if (clips.length === 0) return { ok: false, reason: 'no-audio' };
  const urls = new Set(clips.map((clip) => clip.url));
  if (urls.size !== 1) return { ok: false, reason: 'many-clips' };
  const sourceKey = clips[0]?.sourceKey;
  if (!sourceKey || clips.some((clip) => clip.sourceKey !== sourceKey)) {
    return { ok: false, reason: 'unkeyed-audio' };
  }

  const clipSeconds = clips.reduce<number | null>((longest, clip) => {
    const seconds = positiveSeconds(clip.durationSeconds);
    if (seconds == null) return longest;
    return longest == null || seconds > longest ? seconds : longest;
  }, null);
  const durationSeconds =
    positiveSeconds(
      entry.durationMs == null ? null : entry.durationMs / 1000
    ) ??
    positiveSeconds(
      input.shotDurationMs == null ? null : input.shotDurationMs / 1000
    ) ??
    clipSeconds ??
    FALLBACK_DURATION_SECONDS;

  const audioUrl = clips[0]?.url;
  if (!audioUrl) return { ok: false, reason: 'no-audio' };

  return {
    ok: true,
    plan: {
      renderSegmentId: input.renderSegmentId,
      videoUrl: selected.url,
      audioUrl,
      clipIds: clips.map((clip) => clip.id),
      sourceKey,
      manifest: lipsyncManifest(selected.manifest, input.shotId, {
        clipIds: clips.map((clip) => clip.id),
        sourceKey,
      }),
      durationSeconds,
      resolution: selected.resolution ?? null,
      cost: estimateLipsyncCost(durationSeconds),
    },
  };
}

/**
 * The motion phase. Kling, Omni Flash and Grok cannot take the dialogue
 * file, so a finished single-shot clip is synced after the render. Seedance
 * and MiniMax already uploaded that file, so they are never synced. A packed
 * clip and a variant-only take are left as rendered.
 */
export function planMotionLipsync<T extends LipsyncEntry>(input: {
  model: ImageToVideoModel;
  draftPreview: boolean;
  packed: boolean;
  variantOnly: boolean;
  shotId: string;
  renderSegmentId: string | null;
  videoUrl: string | null;
  resolution: RenderedResolution | null;
  manifest: readonly T[] | null;
  clips: readonly LipsyncClip[] | null;
  shotDurationMs: number | null;
}): LipsyncPlan<T> | null {
  if (modelTakesDialogueAudio(input.model)) return null;
  if (input.draftPreview || input.packed || input.variantOnly) return null;
  if (!input.videoUrl || !input.manifest) return null;
  const planned = planLipsync({
    shotId: input.shotId,
    renderSegmentId: input.renderSegmentId,
    selected: {
      url: input.videoUrl,
      status: 'completed',
      resolution: input.resolution,
      manifest: input.manifest,
    },
    generating: false,
    clips: input.clips,
    shotDurationMs: input.shotDurationMs,
  });
  return planned.ok ? planned.plan : null;
}
