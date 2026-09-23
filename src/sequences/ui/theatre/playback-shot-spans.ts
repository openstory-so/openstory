/**
 * Shot spans on the same clock as `toPlaybackScenes` (#1771).
 *
 * Consecutive shots that share a video URL are one playback scene (a packed
 * clip). A still is its own scene and holds for the recorded-dialogue
 * duration when the clips report one, otherwise `durationMs`.
 *
 * Estimates use those timings. The stitcher then reports real scene
 * durations (`applySceneDurations`); an HLS timeline only reports the total
 * (`scaleSpansToDuration`). Poster times stay file in-points — they are not
 * the scaled stitch clock.
 */

import { durationSecondsOf } from '@/shots/packed-clip-window';

export type PlaybackSpanShot = {
  id: string;
  shotNumber: number | null;
  durationMs: number | null;
  previewThumbnailUrl: string | null;
  video: { url: string | null } | null;
  image: { url: string | null } | null;
  audioClips: readonly { durationSeconds?: number | null }[] | null;
};

export type PlaybackShotSpan = {
  shotId: string;
  shotNumber: number | null;
  /** Index into the collapsed playback-scene list. */
  sceneIndex: number;
  startSeconds: number;
  endSeconds: number;
  /** Selected still, else the storyboard preview. Null when the thumb is a video frame. */
  thumbnailUrl: string | null;
  videoPosterUrl: string | null;
  /** In-point inside the video file. Ignored when `videoPosterUrl` is null. */
  videoPosterSeconds: number;
};

function stillHoldSeconds(shot: PlaybackSpanShot): number {
  let audio = 0;
  for (const clip of shot.audioClips ?? []) {
    if (
      typeof clip.durationSeconds === 'number' &&
      Number.isFinite(clip.durationSeconds) &&
      clip.durationSeconds > 0
    ) {
      audio += clip.durationSeconds;
    }
  }
  if (audio > 0) return audio;
  return durationSecondsOf(shot.durationMs);
}

function thumb(
  shot: PlaybackSpanShot,
  videoPosterSeconds: number
): Pick<
  PlaybackShotSpan,
  'thumbnailUrl' | 'videoPosterUrl' | 'videoPosterSeconds'
> {
  // Same order as the rail tile: still, then the clip frame, then the preview.
  if (shot.image?.url) {
    return {
      thumbnailUrl: shot.image.url,
      videoPosterUrl: null,
      videoPosterSeconds: 0,
    };
  }
  if (shot.video?.url) {
    return {
      thumbnailUrl: null,
      videoPosterUrl: shot.video.url,
      videoPosterSeconds,
    };
  }
  return {
    thumbnailUrl: shot.previewThumbnailUrl,
    videoPosterUrl: null,
    videoPosterSeconds: 0,
  };
}

export function playbackShotSpans(
  shots: readonly PlaybackSpanShot[]
): PlaybackShotSpan[] {
  const spans: PlaybackShotSpan[] = [];
  let sceneIndex = -1;
  let cursor = 0;
  let index = 0;
  while (index < shots.length) {
    const shot = shots[index];
    if (!shot) break;
    const videoUrl = shot.video?.url;
    if (!videoUrl) {
      sceneIndex += 1;
      const duration = stillHoldSeconds(shot);
      spans.push({
        shotId: shot.id,
        shotNumber: shot.shotNumber,
        sceneIndex,
        startSeconds: cursor,
        endSeconds: cursor + duration,
        ...thumb(shot, 0),
      });
      cursor += duration;
      index += 1;
      continue;
    }

    const group: PlaybackSpanShot[] = [shot];
    let next = index + 1;
    while (next < shots.length) {
      const member = shots[next];
      if (!member || member.video?.url !== videoUrl) break;
      group.push(member);
      next += 1;
    }
    sceneIndex += 1;
    let local = 0;
    for (const member of group) {
      const duration = durationSecondsOf(member.durationMs);
      spans.push({
        shotId: member.id,
        shotNumber: member.shotNumber,
        sceneIndex,
        startSeconds: cursor + local,
        endSeconds: cursor + local + duration,
        ...thumb(member, local),
      });
      local += duration;
    }
    cursor += local;
    index = next;
  }
  return spans;
}

export function playbackSceneCount(spans: readonly PlaybackShotSpan[]): number {
  const last = spans[spans.length - 1];
  return last ? last.sceneIndex + 1 : 0;
}

/**
 * Replace each collapsed scene's estimate with the player's measured
 * duration, keeping member proportions. A length mismatch leaves the
 * estimate in place.
 */
export function applySceneDurations(
  spans: readonly PlaybackShotSpan[],
  durations: readonly number[]
): PlaybackShotSpan[] {
  const sceneCount = playbackSceneCount(spans);
  if (sceneCount === 0 || durations.length !== sceneCount) return spans.slice();

  const out: PlaybackShotSpan[] = [];
  let cursor = 0;
  for (let scene = 0; scene < sceneCount; scene++) {
    const members = spans.filter((span) => span.sceneIndex === scene);
    const measured = durations[scene] ?? 0;
    const estimated = members.reduce(
      (sum, span) => sum + (span.endSeconds - span.startSeconds),
      0
    );
    let local = 0;
    members.forEach((member, memberIndex) => {
      const weight = member.endSeconds - member.startSeconds;
      const duration =
        memberIndex === members.length - 1
          ? Math.max(0, measured - local)
          : estimated > 0
            ? (weight / estimated) * measured
            : measured / members.length;
      out.push({
        ...member,
        startSeconds: cursor + local,
        endSeconds: cursor + local + duration,
      });
      local += duration;
    });
    cursor += measured;
  }
  return out;
}

/** Stretch the estimate so it fills a known media duration (HLS total). */
export function scaleSpansToDuration(
  spans: readonly PlaybackShotSpan[],
  duration: number
): PlaybackShotSpan[] {
  if (spans.length === 0 || !(duration > 0)) return spans.slice();
  const estimated = spans[spans.length - 1]?.endSeconds ?? 0;
  if (!(estimated > 0)) return spans.slice();
  const factor = duration / estimated;
  let cursor = 0;
  return spans.map((span, index) => {
    const scaled = (span.endSeconds - span.startSeconds) * factor;
    const spanDuration =
      index === spans.length - 1 ? Math.max(0, duration - cursor) : scaled;
    const next = {
      ...span,
      startSeconds: cursor,
      endSeconds: cursor + spanDuration,
    };
    cursor += spanDuration;
    return next;
  });
}

/** Half-open `[start, end)`. A playhead at or past the last end stays on the last shot. */
export function shotIdAtPlaybackTime(
  spans: readonly PlaybackShotSpan[],
  time: number
): string | undefined {
  const last = spans[spans.length - 1];
  if (!last) return undefined;
  for (const span of spans) {
    if (time >= span.startSeconds && time < span.endSeconds) return span.shotId;
  }
  return last.shotId;
}

export function spanStartForShot(
  spans: readonly PlaybackShotSpan[],
  shotId: string
): number | undefined {
  return spans.find((span) => span.shotId === shotId)?.startSeconds;
}
