import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { getLogger } from '@/lib/observability/logger';
import type { MusicSceneSummary } from '@/lib/workflow/types';

const logger = getLogger(['openstory', 'workflow', 'music']);

type MusicSceneRow = {
  sceneId: string;
  musicDesign: NonNullable<Scene['musicDesign']>;
};

/**
 * Throws when `scene.metadata` is missing rather than `||`-defaulting to
 * placeholders. Defaulting would hash-alias corrupt scenes with real
 * "Untitled Scene" / 5s values, silently keeping the music prompt's
 * input_hash matching after upstream metadata went missing.
 */
export function buildMusicSceneSummaries(
  scenes: readonly Scene[],
  /**
   * Visual prompt text per scene (the shot's `frame.imagePrompt` mirror),
   * keyed by `sceneId`. The structured visual prompt moved off `scene.prompts`
   * to `frame_prompt_versions` (#713), so the caller (which has DB access)
   * supplies it here for the music prompt's visual grounding. Empty when a
   * scene has no generated visual prompt yet.
   */
  visualSummaryBySceneId: Record<string, string> = {}
): MusicSceneSummary[] {
  return scenes.map((scene) => {
    if (!scene.metadata) {
      throw new Error(
        `Scene ${scene.sceneId} is missing metadata; cannot build music scene summary`
      );
    }
    return {
      sceneId: scene.sceneId,
      title: scene.metadata.title,
      storyBeat: scene.metadata.storyBeat,
      durationSeconds: scene.metadata.durationSeconds,
      location: scene.metadata.location,
      timeOfDay: scene.metadata.timeOfDay,
      visualSummary: visualSummaryBySceneId[scene.sceneId] ?? '',
    };
  });
}

/**
 * Pair per-scene music design onto analysis scenes by index.
 *
 * Scene ids are server-minted ULIDs; the music LLM is asked to echo them and
 * routinely mangles them (and static e2e fixtures never can). The summaries
 * we send are index-aligned with this array, so position is the contract.
 *
 * Extra trailing rows are dropped (Luna and similar sometimes emit one more
 * scene than they were given). Fewer rows still throws — padding would invent
 * a cue, and pairing a short list by position would attach another scene's
 * music to the remainder.
 */
export function joinMusicDesignByIndex(
  scenes: readonly Scene[],
  musicScenes: ReadonlyArray<MusicSceneRow>
): Scene[] {
  if (musicScenes.length < scenes.length) {
    throw new Error(
      `Music design returned ${musicScenes.length} scene(s) but ${scenes.length} were sent; refusing to pair by position`
    );
  }
  if (musicScenes.length > scenes.length) {
    logger.warn(
      'Dropping extra music-design rows ({returned} returned, {sent} sent)',
      {
        sent: scenes.length,
        returned: musicScenes.length,
        extraSceneIds: musicScenes
          .slice(scenes.length)
          .map((row) => row.sceneId),
      }
    );
  }
  return scenes.map((scene, index) => {
    const row = musicScenes[index];
    if (!row) {
      throw new Error(`Music design missing row at index ${index}`);
    }
    return { ...scene, musicDesign: row.musicDesign };
  });
}
