import {
  shotIdAtTime,
  windowForShot,
  type PackedClipWindow,
} from '@/shots/packed-clip-window';

/**
 * Packed clips keep one player mounted while shot selection lives in the URL.
 * Router updates and media seeks complete independently: a timeupdate must
 * never turn an uncommitted navigation into a seek back to the previous shot.
 */
export function createPackedPlayback() {
  let source: string | undefined;
  let selectedShotId: string | undefined;
  let windows: readonly PackedClipWindow[] = [];
  let pendingSeek: number | null = null;
  const playbackSelections = new Set<string>();

  return {
    select(
      nextSource: string,
      shotId: string | undefined,
      nextWindows: readonly PackedClipWindow[]
    ): number | null {
      const sourceChanged = source !== nextSource;
      windows = nextWindows;
      if (sourceChanged || selectedShotId !== shotId) {
        const followsPlayback =
          !sourceChanged && shotId != null && playbackSelections.has(shotId);
        source = nextSource;
        selectedShotId = shotId;
        if (followsPlayback) {
          // A newer navigation may supersede intermediate chapters. Retire
          // those requests too, so scrubbing back can select them again.
          for (const requested of playbackSelections) {
            playbackSelections.delete(requested);
            if (requested === shotId) break;
          }
          pendingSeek = null;
        } else {
          playbackSelections.clear();
          // Only navigation requests a seek. Playback itself can cross a
          // chapter boundary (or end) without rewinding the current chapter.
          pendingSeek =
            source && shotId && windows.length > 1
              ? (windowForShot(windows, shotId)?.startSeconds ?? null)
              : null;
        }
      }
      return pendingSeek;
    },
    timeUpdate(eventSource: string, time: number): string | undefined {
      // Events queued by a player that navigation just replaced are obsolete.
      if (eventSource !== source) return undefined;
      const member = shotIdAtTime(windows, time);
      if (pendingSeek != null) {
        // A late event from before a manual seek must not undo the click.
        if (member !== selectedShotId) return undefined;
        pendingSeek = null;
      }
      if (
        !member ||
        member === selectedShotId ||
        playbackSelections.has(member)
      ) {
        return undefined;
      }
      playbackSelections.add(member);
      return member;
    },
  };
}
