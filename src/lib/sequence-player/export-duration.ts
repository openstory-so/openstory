/**
 * Browser-export duration policy (#1430).
 *
 * The product targets 5-minute films (`targetSeconds` max 300, composer 5m
 * chip). Encoded clip durations overshoot that — enhancer labels are allowed
 * ±10%, and motion models return slightly longer than requested — so a 300s
 * gate rejected real 5-minute sequences. This cap is only a memory/time
 * safety valve for the in-memory MP4 + OfflineAudioContext path; it matches
 * the server-export cap in `containers/video-export`.
 */

export const MAX_BROWSER_EXPORT_DURATION_SECONDS = 10 * 60;

export function assertBrowserExportDuration(
  totalDurationSeconds: number
): void {
  if (totalDurationSeconds > MAX_BROWSER_EXPORT_DURATION_SECONDS) {
    throw new Error(
      `Sequence is ${totalDurationSeconds.toFixed(1)}s long; browser export currently caps at ${MAX_BROWSER_EXPORT_DURATION_SECONDS}s.`
    );
  }
}
