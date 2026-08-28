import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { MusicSceneSummary } from '@/lib/workflow/types';

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
 * A length mismatch would silently attach another scene's cue — throw instead.
 */
export function joinMusicDesignByIndex(
  scenes: readonly Scene[],
  musicScenes: ReadonlyArray<MusicSceneRow>
): Scene[] {
  if (musicScenes.length !== scenes.length) {
    throw new Error(
      `Music design returned ${musicScenes.length} scene(s) but ${scenes.length} were sent; refusing to pair by position`
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
