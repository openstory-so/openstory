/**
 * Theatre play path (#1402 follow-up): prefer a stitched MP4 of the current
 * cut, and only live-stitch in the browser when that MP4 cannot exist.
 *
 * `native`        — a matching export is ready; play it in <video>.
 * `wait-for-cut`  — transmux-compatible + container available; render on the
 *                   server, then swap to native. Preview-now escapes to stitch.
 * `stitch`        — mixed-res, no container, user asked to preview, or the
 *                   server render already failed.
 */
export type TheatrePlaybackMode = 'native' | 'wait-for-cut' | 'stitch';

export function theatrePlaybackMode(input: {
  freshExportUrl: string | null;
  serverExportAvailable: boolean;
  /** Null until the stitcher has probed scene codecs. */
  canTransmux: boolean | null;
  previewLive: boolean;
  playCutFailed: boolean;
}): TheatrePlaybackMode {
  if (input.freshExportUrl) return 'native';
  if (input.previewLive || input.playCutFailed) return 'stitch';
  if (input.canTransmux === true && input.serverExportAvailable) {
    return 'wait-for-cut';
  }
  return 'stitch';
}
