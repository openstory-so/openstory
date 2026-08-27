/**
 * Failure Analysis Utility
 * Analyzes shots + sequence to determine what failed and whether smart retry is possible.
 */

import {
  contentRejectionSubjects,
  isContentRejectionError,
} from '@/lib/ai/content-rejection';
import {
  CREDITS_SHORT_TITLE,
  isCreditsShortError,
} from '@/lib/billing/credits-short';
import type { SceneRow } from '@/lib/db/schema/scenes';
import type { Shot } from '@/lib/db/schema/shots';
import type { Sequence } from '@/lib/db/schema/sequences';
import type { ShotView } from '@/lib/shots/shot-view';

/** Scene titles keyed by scene id — the label source for each failed shot. */
type ScenesById = ReadonlyMap<string, Pick<SceneRow, 'title' | 'orderIndex'>>;

type FailureCategory =
  | 'image'
  | 'motion'
  | 'music'
  | 'motion-prompts'
  | 'music-prompt';

type ShotFailure = {
  shotId: string;
  sceneNumber: number;
  sceneTitle: string;
  error: string | null;
};

type FailureGroup = {
  category: FailureCategory;
  label: string;
  shots: ShotFailure[];
  error?: string | null;
};

export type FailureSummary = {
  requiresFullRetry: boolean;
  headline: string;
  groups: FailureGroup[];
  totalFailures: number;
  hasFailed: boolean;
  error?: string | null;
  /**
   * Content-checker-only failures are a warning (edit script / prompt / retry).
   * A reservation-short stop (#1328) is a credits prompt, not a generation
   * error. Mixed or infrastructure failures stay 'error'.
   */
  tone: 'error' | 'warning' | 'credits';
};

function sceneNumberOf(shot: Shot, scenesById: ScenesById): number {
  const scene = shot.sceneId ? scenesById.get(shot.sceneId) : null;
  return (scene?.orderIndex ?? 0) + 1;
}

function getSceneTitle(shot: Shot, scenesById: ScenesById): string {
  const scene = shot.sceneId ? scenesById.get(shot.sceneId) : null;
  return scene?.title || `Scene ${sceneNumberOf(shot, scenesById)}`;
}

function groupIsContentOnly(group: FailureGroup): boolean {
  if (group.shots.length > 0) {
    return group.shots.every(
      (shot) => !!shot.error && isContentRejectionError(shot.error)
    );
  }
  return !!group.error && isContentRejectionError(group.error);
}

/** Sequence-level statusError → banner tone. Credits-short outranks a wrapped content-checker phrase. */
function toneOf(error: string | null | undefined): FailureSummary['tone'] {
  if (error && isCreditsShortError(error)) return 'credits';
  if (error && isContentRejectionError(error)) return 'warning';
  return 'error';
}

const FULL_RETRY_HEADLINE = 'Generation failed \u2014 full retry required';

/** "A", "A and B", "A, B and C". */
function listNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function fullRetryHeadline(error: string | null | undefined): string {
  const tone = toneOf(error);
  if (tone === 'credits') return CREDITS_SHORT_TITLE;
  if (tone !== 'warning') return FULL_RETRY_HEADLINE;
  const subjects = contentRejectionSubjects(error ?? '');
  return `${subjects.length > 0 ? listNames(subjects) : 'Script'} didn't pass the content checker \u2014 regenerate to retry`;
}

function buildHeadline(
  groups: FailureGroup[],
  requiresFullRetry: boolean,
  error: string | null | undefined,
  clipsReady: number,
  clipsTotal: number
): string {
  if (groups.length === 0) {
    if (requiresFullRetry) return fullRetryHeadline(error);
    return 'No failures detected';
  }

  if (requiresFullRetry) {
    const promptGroups = groups.filter(
      (g) => g.category === 'motion-prompts' || g.category === 'music-prompt'
    );
    if (promptGroups.length > 0) {
      const names = promptGroups.map((g) => g.label).join(' and ');
      return `${names} \u2014 full retry required`;
    }
    return fullRetryHeadline(error);
  }

  const parts: string[] = [];
  for (const group of groups) {
    if (group.category === 'image') {
      const n = group.shots.length;
      parts.push(
        groupIsContentOnly(group)
          ? n === 1
            ? "1 still didn't pass the content checker"
            : `${n} stills didn't pass the content checker`
          : `${n} image${n !== 1 ? 's' : ''} failed`
      );
    } else if (group.category === 'motion') {
      const n = group.shots.length;
      parts.push(
        groupIsContentOnly(group)
          ? n === 1
            ? "1 clip didn't pass the content checker"
            : `${n} clips didn't pass the content checker`
          : `${n} motion video${n !== 1 ? 's' : ''} failed`
      );
    } else if (group.category === 'music') {
      parts.push(
        groupIsContentOnly(group)
          ? "music didn't pass the content checker"
          : 'music generation failed'
      );
    } else if (group.category === 'music-prompt') {
      parts.push('music prompt generation failed');
    }
  }

  const failure = parts.join(' and ');
  // Lead with what worked so a single miss doesn't headline the first run
  // (#1286). "6 of 7 clips ready · 1 image failed".
  if (clipsTotal > 0) {
    const ready = `${clipsReady} of ${clipsTotal} clips ready`;
    return failure ? `${ready} \u00b7 ${failure}` : ready;
  }
  return failure;
}

/**
 * `analyzeFailures` only once the shot list has resolved. `shots ?? []` on a
 * failed sequence is the same shape as "analysis never produced shots", so
 * SSR would emit the generic full-retry banner and hydration would replace it
 * with the content-checker banner once shots land.
 */
export function analyzeLoadedFailures(
  shots: ShotView[] | undefined,
  sequence: Sequence | undefined,
  scenesById: ScenesById
): FailureSummary | null {
  if (!sequence || shots === undefined) return null;
  return analyzeFailures(shots, sequence, scenesById);
}

export function analyzeFailures(
  // The still's lifecycle lives on the anchor frame (#989) and the video's on
  // the segment's primary render (#1067).
  shots: ShotView[],
  sequence: Sequence,
  scenesById: ScenesById
): FailureSummary {
  const groups: FailureGroup[] = [];
  let requiresFullRetry = false;

  // No shots → script analysis failed → full retry
  if (shots.length === 0 && sequence.status === 'failed') {
    return {
      requiresFullRetry: true,
      headline: fullRetryHeadline(sequence.statusError),
      groups: [],
      totalFailures: 1,
      hasFailed: true,
      error: sequence.statusError,
      tone: toneOf(sequence.statusError),
    };
  }

  // Failed images
  const failedImageShots = shots.filter(
    (f) => f.frame.imageStatus === 'failed'
  );
  if (failedImageShots.length > 0) {
    groups.push({
      category: 'image',
      label: `${failedImageShots.length} of ${shots.length} images failed`,
      shots: failedImageShots.map((f) => ({
        shotId: f.id,
        sceneNumber: sceneNumberOf(f, scenesById),
        sceneTitle: getSceneTitle(f, scenesById),
        error: f.frame.imageError,
      })),
    });
  }

  // Failed motion (only shots with thumbnails AND a motion prompt)
  const failedMotionShots = shots.filter(
    (f) =>
      f.videoStatus === 'failed' && f.image?.url && f.motionPrompt?.fullPrompt
  );
  if (failedMotionShots.length > 0) {
    groups.push({
      category: 'motion',
      label: `${failedMotionShots.length} of ${shots.length} motion videos failed`,
      shots: failedMotionShots.map((f) => ({
        shotId: f.id,
        sceneNumber: sceneNumberOf(f, scenesById),
        sceneTitle: getSceneTitle(f, scenesById),
        error: f.primaryVideo?.error ?? null,
      })),
    });
  }

  // Detect missing motion prompts (images completed but no motion prompt)
  const shotsWithImageButNoMotionPrompt = shots.filter(
    (f) => f.frame.imageStatus === 'completed' && !f.motionPrompt?.fullPrompt
  );
  if (
    shotsWithImageButNoMotionPrompt.length > 0 &&
    sequence.status === 'failed'
  ) {
    requiresFullRetry = true;
    groups.push({
      category: 'motion-prompts',
      label: 'Motion prompts were not generated',
      shots: shotsWithImageButNoMotionPrompt.map((f) => ({
        shotId: f.id,
        sceneNumber: sceneNumberOf(f, scenesById),
        sceneTitle: getSceneTitle(f, scenesById),
        error: null,
      })),
    });
  }

  // Failed music (only if musicPrompt exists)
  if (sequence.musicStatus === 'failed' && sequence.musicPrompt) {
    groups.push({
      category: 'music',
      label: 'Music generation failed',
      shots: [],
      error: sequence.musicError,
    });
  }

  // Detect missing music prompt
  if (sequence.status === 'failed' && !sequence.musicPrompt) {
    // Only flag as needing full retry if we have shots (otherwise already caught above)
    if (shots.length > 0 && sequence.musicStatus !== 'completed') {
      groups.push({
        category: 'music-prompt',
        label: 'Music prompt was not generated',
        shots: [],
      });
    }
  }

  // Mixed case: retryable failures + missing prompts → full retry wins
  if (
    requiresFullRetry &&
    groups.some((g) => g.category === 'image' || g.category === 'motion')
  ) {
    // Full retry re-runs everything including generation
  }

  // Catch-all: sequence failed but no specific failures identified
  if (sequence.status === 'failed' && groups.length === 0) {
    requiresFullRetry = true;
  }

  // Mid-pipeline crash (e.g. scene-split after streaming some shots, #1072):
  // later phases never ran, so the only "failures" are missing motion/music
  // prompts. That is not a real music-prompt failure — smart-retry would
  // mislead. Prefer the sequence statusError and force full regenerate.
  const onlyMissingDownstreamArtifacts =
    groups.length > 0 &&
    groups.every(
      (g) => g.category === 'music-prompt' || g.category === 'motion-prompts'
    );
  if (
    sequence.status === 'failed' &&
    sequence.statusError &&
    onlyMissingDownstreamArtifacts
  ) {
    return {
      requiresFullRetry: true,
      headline: fullRetryHeadline(sequence.statusError),
      groups: [],
      totalFailures: 1,
      hasFailed: true,
      error: sequence.statusError,
      tone: toneOf(sequence.statusError),
    };
  }

  const totalFailures = groups.reduce(
    (sum, g) => sum + Math.max(g.shots.length, 1),
    0
  );

  const hasFailed = groups.length > 0 || sequence.status === 'failed';

  const failedShotIds = new Set(
    groups.flatMap((g) => g.shots.map((s) => s.shotId))
  );
  const clipsReady = shots.filter((s) => !failedShotIds.has(s.id)).length;

  return {
    requiresFullRetry,
    headline: buildHeadline(
      groups,
      requiresFullRetry,
      sequence.statusError,
      clipsReady,
      shots.length
    ),
    groups,
    totalFailures,
    hasFailed,
    error: sequence.statusError,
    tone:
      requiresFullRetry || groups.length === 0
        ? toneOf(sequence.statusError)
        : groups.every(groupIsContentOnly)
          ? 'warning'
          : 'error',
  };
}
