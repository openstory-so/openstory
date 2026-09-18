import type { ScopedDb } from '@/platform/server/db/scoped';
import type { Sequence } from '@/platform/server/db/schema';
import type { Scene } from '@/shots/scene-analysis.schema';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/models/models.config';
import {
  loadSceneContextBySequence,
  resolveSceneForShot,
} from '@/shots/server/scene-script';
import { musicPromptInputHashMatches } from '@/shots/input-hash';
import { buildMusicSceneSummaries } from './workflows/music-scene-summaries';
import { readMusicTrackStaleness } from './music-track-staleness';
import { getLogger } from '@/platform/logger';
const logger = getLogger(['openstory', 'music', 'staleness']);

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
    };
  }

  // Track staleness is INDEPENDENT of the prompt's (#1657): a hand-edited
  // prompt nulls `musicPromptInputHash` — so the prompt reads 'untracked' —
  // while leaving the track stale against the text it was rendered from.
  const shots = await scopedDb.shots.listBySequence(sequence.id);
  const musicTrack = await readMusicTrackStaleness(scopedDb, sequence, shots);

  // No stored hash: legacy sequence or never generated. Surface explicitly
  // so the UI can suppress the "regenerate" prompt without claiming
  // freshness.
  if (!sequence.musicPromptInputHash) {
    return { musicPrompt: 'untracked' as const, musicTrack };
  }

  try {
    const sceneContext = await loadSceneContextBySequence(
      scopedDb,
      sequence.id
    );
    const scenes = shots
      .map((shot) => resolveSceneForShot(shot, sceneContext).scene)
      .filter((scene): scene is Scene => scene !== null);
    if (scenes.length === 0) {
      return { musicPrompt: 'untracked' as const, musicTrack };
    }
    const sceneSummaries = buildMusicSceneSummaries(scenes);

    const latest = await scopedDb.sequenceMusicPromptVersions.getLatest(
      sequence.id
    );
    const analysisModel =
      latest?.analysisModel ??
      getAnalysisModelById(sequence.analysisModel)?.id ??
      DEFAULT_ANALYSIS_MODEL;

    const musicUpToDate = await musicPromptInputHashMatches(
      sequence.musicPromptInputHash,
      { sceneSummaries, analysisModel }
    );

    return {
      musicPrompt: musicUpToDate ? ('fresh' as const) : ('stale' as const),
      musicTrack,
    };
  } catch (error) {
    // Hash uncomputable (e.g., scene metadata missing a required field).
    // Surface as untracked so the UI doesn't lie about freshness.
    logger.warn(`uncomputable for sequence ${sequence.id}:`, { err: error });
    return { musicPrompt: 'untracked' as const, musicTrack };
  }
}
