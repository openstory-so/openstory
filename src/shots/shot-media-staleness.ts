/**
 * Dialogue-audio and video staleness as the same ArtifactStaleness vocabulary
 * the rail dots already use for prompts and stills (#1703).
 *
 * Pure: callers load clips / segments and pass the booleans. Never first-creates
 * a recording or a clip (`untracked` when nothing exists yet).
 */

import type { ArtifactStaleness } from '@/shots/server/shot-staleness';

export function dialogueArtifactStaleness(input: {
  /** The shot currently has lines a model would speak. */
  voiced: boolean;
  /** The shot already holds dialogue audio (any clips). */
  hasAudio: boolean;
  /** Those clips still match the current reading. */
  matching: boolean;
  /** A recording claim is live for this shot. */
  generating?: boolean;
}): ArtifactStaleness {
  if (!input.voiced || !input.hasAudio) return 'untracked';
  if (input.generating) return 'updating';
  return input.matching ? 'fresh' : 'stale';
}

export function videoArtifactStaleness(input: {
  hasVideo: boolean;
  alreadyStale: boolean;
  generating: boolean;
}): ArtifactStaleness {
  if (!input.hasVideo) return 'untracked';
  if (input.generating) return 'updating';
  return input.alreadyStale ? 'stale' : 'fresh';
}
