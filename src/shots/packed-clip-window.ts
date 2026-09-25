/**
 * In-points for a packed in-clip render (#1510). Several shots share one
 * video URL; each shot owns a window whose length is `shots.durationMs`.
 *
 * Offsets are derived from current membership + timings, never stored — a
 * model switch that re-tiles (#953) must not leave stale in-points behind.
 */

const DEFAULT_SHOT_SECONDS = 3;

export type PackedClipShot = {
  id: string;
  shotNumber: number | null;
  durationMs: number | null;
};

export type PackedClipWindow = {
  id: string;
  shotNumber: number | null;
  index: number;
  startSeconds: number;
  durationSeconds: number;
  endSeconds: number;
};

export function durationSecondsOf(
  durationMs: number | null | undefined
): number {
  if (
    typeof durationMs === 'number' &&
    Number.isFinite(durationMs) &&
    durationMs > 0
  ) {
    return durationMs / 1000;
  }
  return DEFAULT_SHOT_SECONDS;
}

/** Ordered windows for the shots that share one packed clip. */
export function packedClipWindows(
  shots: readonly PackedClipShot[]
): PackedClipWindow[] {
  let elapsed = 0;
  return shots.map((shot, index) => {
    const durationSeconds = durationSecondsOf(shot.durationMs);
    const startSeconds = elapsed;
    const endSeconds = elapsed + durationSeconds;
    elapsed = endSeconds;
    return {
      id: shot.id,
      shotNumber: shot.shotNumber,
      index,
      startSeconds,
      durationSeconds,
      endSeconds,
    };
  });
}

export function windowForShot(
  windows: readonly PackedClipWindow[],
  shotId: string
): PackedClipWindow | undefined {
  return windows.find((window) => window.id === shotId);
}

/**
 * Which member owns `currentTime`. Half-open `[start, end)` so the cut
 * instant belongs to the next shot. A playhead at or past the last end
 * still maps to the last shot (ended / rounding).
 */
export function shotIdAtTime(
  windows: readonly PackedClipWindow[],
  currentTime: number
): string | undefined {
  const last = windows[windows.length - 1];
  if (!last) return undefined;
  for (const window of windows) {
    if (currentTime >= window.startSeconds && currentTime < window.endSeconds) {
      return window.id;
    }
  }
  return last.id;
}

/**
 * Media-fragment time for a packed-clip poster. `#t=0.001` is the existing
 * first-frame pin; later members offset by their in-point plus the same
 * epsilon so the decoder paints a frame inside the window.
 */
export function videoPosterTimeSeconds(startSeconds: number): number {
  return Math.max(0.001, startSeconds + 0.001);
}

export function videoPosterSrc(url: string, startSeconds = 0): string {
  return `${url}#t=${videoPosterTimeSeconds(startSeconds)}`;
}

/**
 * Shots that share `current`'s render segment, in the order `shots` is
 * already sorted. A one-shot (or unassigned) segment is `[current]`.
 */
export function packedPlaybackGroup<
  S extends { id: string; renderSegmentId: string | null },
>(shots: readonly S[], current: S): S[] {
  const segmentId = current.renderSegmentId;
  if (segmentId === null) return [current];
  const group = shots.filter((shot) => shot.renderSegmentId === segmentId);
  return group.length > 0 ? group : [current];
}

/** WebVTT chapters for the packed clip — one cue per member shot. */
export function generatePackedShotChaptersVTT(
  shots: readonly PackedClipShot[]
): string {
  const lines: string[] = ['WEBVTT', '', 'NOTE Packed in-clip shots', ''];
  for (const window of packedClipWindows(shots)) {
    lines.push(
      `${formatTimestamp(window.startSeconds)} --> ${formatTimestamp(window.endSeconds)}`
    );
    lines.push(`Shot ${window.shotNumber ?? window.index + 1}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Inspector Generate Motion label when the request covers N packed shots. */
export function motionGenerateLabel(
  packedShotCount: number,
  hasVideo: boolean,
  draft = false
): string {
  // A draft is never "regenerated": the clip on screen may be a final, and a
  // new draft is a new take, not a redo of it (#1756).
  if (draft) {
    const noun = packedShotCount > 1 ? `${packedShotCount} drafts` : 'draft';
    return hasVideo ? `Generate new ${noun}` : `Generate ${noun}`;
  }
  if (packedShotCount > 1) {
    return hasVideo
      ? `Regenerate ${packedShotCount} shots`
      : `Generate ${packedShotCount} shots`;
  }
  return hasVideo ? 'Regenerate Motion' : 'Generate Motion';
}

function formatTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const h = hours.toString().padStart(2, '0');
  const m = minutes.toString().padStart(2, '0');
  const s = secs.toFixed(3).padStart(6, '0');
  return `${h}:${m}:${s}`;
}
