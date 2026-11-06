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

import { micros, usdToMicros, type Microdollars } from '@/billing/money';
import {
  isValidImageToVideoModel,
  type ImageToVideoModel,
} from '@/models/models';
import type { RenderedResolution } from '@/models/resolutions';
import { modelTakesDialogueAudio } from '@/motion/dialogue-tts';

/** Price-card id for sync-3. The version row keeps the video model that
 * rendered the clip; this id is not a video model. */
export const LIPSYNC_MODEL_ID = 'sync-lipsync-3';

export const LIPSYNC_FAL_ENDPOINT = 'fal-ai/sync-lipsync/v3';

/** The section already fits. Do not remap the clip. */
export const LIPSYNC_SYNC_MODE = 'cut_off' as const;

/** fal's published sync-3 rate, USD per minute of source video. */
const LIPSYNC_USD_PER_MINUTE = 8;

export function estimateLipsyncCost(durationSeconds: number): Microdollars {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('Lip-sync needs the clip duration to price the run.');
  }
  return usdToMicros((durationSeconds / 60) * LIPSYNC_USD_PER_MINUTE);
}

/**
 * A fal queue result with an HTTP status is the job's answer. 408, 429 and
 * 5xx are the transport and can be retried. An error with no status is a
 * dropped connection.
 */
export function lipsyncResultIsTerminal(error: unknown): boolean {
  if (!(error instanceof Error) || !('status' in error)) return false;
  const { status } = error;
  if (typeof status !== 'number') return false;
  if (status === 408 || status === 429 || status >= 500) return false;
  return status >= 400;
}

/**
 * What to add to a motion quote before the clip exists. Same gate as
 * `planMotionLipsync`: models that upload dialogue, drafts, and silent
 * shots stay at zero. The duration is the one the video quote already uses.
 */
export function estimateMotionLipsyncCost(input: {
  model: ImageToVideoModel;
  draft: boolean;
  durationSeconds: number;
  speaks: boolean;
}): Microdollars {
  if (!input.speaks || input.draft || modelTakesDialogueAudio(input.model)) {
    return micros(0);
  }
  return estimateLipsyncCost(input.durationSeconds);
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
  | 'unkeyed-audio'
  | 'no-duration';

export const LIPSYNC_REFUSAL: Record<LipsyncRefusal, string> = {
  'no-clip': 'This shot has no finished clip to lip-sync.',
  packed: 'Lip-sync works on a single-shot clip.',
  generating: 'A video is already generating for this shot.',
  'no-audio': 'This shot has no dialogue audio to lip-sync.',
  'many-clips': 'This shot has more than one dialogue clip.',
  'unkeyed-audio': 'Record the dialogue before lip-syncing.',
  'no-duration': 'This clip has no duration to price the lip-sync.',
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
  /** The model that rendered the clip. The lip-sync row keeps it. */
  videoModel: ImageToVideoModel;
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
    model: string;
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
  // Every version row, a lip-sync included, keeps the render model.
  if (!isValidImageToVideoModel(selected.model)) {
    throw new Error(
      `Selected video for shot ${input.shotId} has no video model: ${selected.model}`
    );
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
    clipSeconds;
  if (durationSeconds == null) return { ok: false, reason: 'no-duration' };

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
      videoModel: selected.model,
      cost: estimateLipsyncCost(durationSeconds),
    },
  };
}

/**
 * The motion phase. Kling, Omni Flash and Grok cannot take the dialogue
 * file, so the finished clip is synced after the render. A packed clip is
 * one video and one spanning dialogue file, and that pair is what sync-3
 * gets. Seedance and MiniMax already uploaded that file, so they are never
 * synced. A variant-only take is left as rendered.
 */
export function planMotionLipsync<T extends LipsyncEntry>(input: {
  model: ImageToVideoModel;
  draftPreview: boolean;
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
  if (input.draftPreview || input.variantOnly) return null;
  if (!input.videoUrl || !input.manifest || input.manifest.length === 0) {
    return null;
  }
  const clips = (input.clips ?? []).filter((clip) => clip.url);
  const urls = new Set(clips.map((clip) => clip.url));
  if (input.manifest.length > 1) {
    const audioUrl = clips[0]?.url;
    if (!audioUrl || urls.size !== 1) return null;
    const covered = input.manifest.map((entry) =>
      positiveSeconds(entry.durationMs == null ? null : entry.durationMs / 1000)
    );
    const durationSeconds = covered.every(
      (seconds): seconds is number => seconds != null
    )
      ? positiveSeconds(covered.reduce((sum, seconds) => sum + seconds, 0))
      : null;
    const sourceKey = clips[0]?.sourceKey ?? input.manifest[0]?.audioSourceKey;
    if (!durationSeconds || !sourceKey || !input.renderSegmentId) return null;
    return {
      renderSegmentId: input.renderSegmentId,
      videoUrl: input.videoUrl,
      audioUrl,
      clipIds: clips.map((clip) => clip.id),
      sourceKey,
      manifest: input.manifest.map((entry) => ({ ...entry })),
      durationSeconds,
      resolution: input.resolution,
      videoModel: input.model,
      cost: estimateLipsyncCost(durationSeconds),
    };
  }
  const planned = planLipsync({
    shotId: input.shotId,
    renderSegmentId: input.renderSegmentId,
    selected: {
      url: input.videoUrl,
      status: 'completed',
      model: input.model,
      resolution: input.resolution,
      manifest: input.manifest,
    },
    generating: false,
    clips,
    shotDurationMs: input.shotDurationMs,
  });
  return planned.ok ? planned.plan : null;
}
