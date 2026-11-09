import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence, Shot } from '@/platform/server/db/schema';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/models/models.config';
import {
  diffManifests,
  musicPromptInputHashMatches,
  stampMusicPromptInput,
  type Stamped,
} from '@/shots/input-hash';
import {
  describeManifestCauses,
  type ManifestArtifact,
} from '@/shots/staleness-causes';
import { musicSceneSummariesFromRows } from './workflows/music-scene-summaries';
import {
  musicTrackStaleness,
  type MusicTrackStaleness,
} from '@/audio/music-track-staleness';
import { sumShotDurationsSeconds } from '@/sequences/server/shot-durations';
import { getLogger } from '@/platform/logger';
const logger = getLogger(['openstory', 'music', 'staleness']);

/**
 * What moved between a stale stamp and now (#2344): the stored manifest
 * against the live one. Empty for a row stamped before manifests (logged); a
 * stale verdict whose manifests match is a stamp ≠ verify bug, logged and unnamed.
 */
async function musicCauses(
  scopedDb: Pick<ScopedDb, 'inputManifests'>,
  artifact: ManifestArtifact,
  sequenceId: string,
  stored: string,
  live: Stamped
): Promise<string[]> {
  const was = (await scopedDb.inputManifests.getByHashes([stored])).get(stored);
  if (!was) {
    logger.warn(
      `no stored manifest for ${artifact} on sequence ${sequenceId}`,
      {
        stored,
      }
    );
    return [];
  }
  const moved = diffManifests(was, live.manifest);
  if (moved.length === 0) {
    logger.error(
      `stale ${artifact} on sequence ${sequenceId} with no differing input: stamp and verify disagree`,
      { stored, live: live.hash }
    );
    return [];
  }
  return describeManifestCauses(artifact, moved);
}

/**
 * Track length a regeneration asks for: `generateMusicFn`'s rule (shot
 * durations, 10s each when unset, 30s floor for an empty sequence). Rounded,
 * so a fractional sum hashes the same from the plan and from this read.
 */
export function musicRequestDurationSeconds(
  shots: ReadonlyArray<Pick<Shot, 'durationMs'>>
): number {
  return Math.round(sumShotDurationsSeconds(shots)) || 30;
}

/**
 * Live read behind {@link musicTrackStaleness}: the selected track (#1115),
 * compared against the sequence's current prompt / tags / shot durations
 * (#1657). The track's own model is the lever it was rendered with.
 */
async function readMusicTrackStaleness(
  scopedDb: Pick<ScopedDb, 'sequenceVariants' | 'inputManifests'>,
  sequence: Pick<
    Sequence,
    'id' | 'selectedMusicVariantId' | 'musicPrompt' | 'musicTags'
  >,
  shots: ReadonlyArray<Pick<Shot, 'durationMs'>>
): Promise<{ status: MusicTrackStaleness; causes: string[] }> {
  const untracked = { status: 'untracked' as const, causes: [] };
  if (!sequence.selectedMusicVariantId) return untracked;
  const track = await scopedDb.sequenceVariants.getMusicById(
    sequence.selectedMusicVariantId
  );
  if (!track || track.status !== 'completed') return untracked;
  const { status, live } = await musicTrackStaleness({
    storedInputHash: track.inputHash,
    prompt: sequence.musicPrompt,
    tags: sequence.musicTags,
    requestDurationSeconds: musicRequestDurationSeconds(shots),
    audioModel: track.model,
  });
  return {
    status,
    causes:
      status === 'stale' && track.inputHash && live
        ? await musicCauses(
            scopedDb,
            'music-track',
            sequence.id,
            track.inputHash,
            live
          )
        : [],
  };
}

/** Shared read-only derivation used by editor and production inspection. */
export async function readMusicPromptStaleness(
  scopedDb: ScopedDb,
  sequence: Sequence
) {
  // Mid-run (#1121): the hash is taken over the scene summaries, and a
  // storyboard run is still writing scenes — the divergence is the pipeline
  // working, not the user's edit. Same short-circuit as
  // `computeShotStaleness`, for the same reason: no verdict while the
  // sequence is being built.
  if (sequence.status === 'processing') {
    return {
      musicPrompt: 'generating' as const,
      musicTrack: 'generating' as const,
      musicPromptCauses: [],
      musicTrackCauses: [],
    };
  }

  // Track staleness is INDEPENDENT of the prompt's (#1657): a hand-edited
  // prompt selects a row with no hash — so the prompt reads 'untracked' —
  // while leaving the track stale against the text it was rendered from.
  const shots = await scopedDb.shots.listBySequence(sequence.id);
  const track = await readMusicTrackStaleness(scopedDb, sequence, shots);
  const musicTrack = track.status;
  const musicTrackCauses = track.causes;

  // No stored hash: legacy sequence or never generated. Surface explicitly
  // so the UI can suppress the "regenerate" prompt without claiming
  // freshness.
  const stored = sequence.musicPromptInputHash;
  if (!stored) {
    return {
      musicPrompt: 'untracked' as const,
      musicTrack,
      musicPromptCauses: [],
      musicTrackCauses,
    };
  }

  try {
    const { sceneSummaries, legacyShotSummaries } = musicSceneSummariesFromRows(
      await scopedDb.scenes.listBySequence(sequence.id),
      shots
    );
    if (sceneSummaries.length === 0) {
      return {
        musicPrompt: 'untracked' as const,
        musicTrack,
        musicPromptCauses: [],
        musicTrackCauses,
      };
    }

    const selected = await scopedDb.sequenceMusicPromptVersions.getSelected(
      sequence.id
    );
    const analysisModel =
      selected?.analysisModel ??
      getAnalysisModelById(sequence.analysisModel)?.id ??
      DEFAULT_ANALYSIS_MODEL;

    const musicUpToDate = await musicPromptInputHashMatches(
      stored,
      { sceneSummaries, analysisModel },
      legacyShotSummaries
    );

    return {
      musicPrompt: musicUpToDate ? ('fresh' as const) : ('stale' as const),
      musicTrack,
      musicPromptCauses: musicUpToDate
        ? []
        : await musicCauses(
            scopedDb,
            'music-prompt',
            sequence.id,
            stored,
            await stampMusicPromptInput({ sceneSummaries, analysisModel })
          ),
      musicTrackCauses,
    };
  } catch (error) {
    // Hash uncomputable (e.g., scene metadata missing a required field).
    // Surface as untracked so the UI doesn't lie about freshness.
    logger.warn(`uncomputable for sequence ${sequence.id}:`, { err: error });
    return {
      musicPrompt: 'untracked' as const,
      musicTrack,
      musicPromptCauses: [],
      musicTrackCauses,
    };
  }
}
