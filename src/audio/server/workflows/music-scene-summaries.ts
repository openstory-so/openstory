import type { Scene } from '@/shots/scene-analysis.schema';
import { getLogger } from '@/platform/logger';
import { plainSceneTitle } from '@/platform/markdown-plain';
import type { NewScene, Shot } from '@/platform/server/db/schema';
import type { MusicSceneSummary } from '@/platform/server/workflow/types';
import type { LegacyMusicShotSummary } from '@/shots/input-hash';
import { sceneShotSpecs, shotDurationMs } from '@/shots/shot-list-pass';
import { buildSceneInsert } from '@/sequences/server/scene-persistence';

const logger = getLogger(['openstory', 'workflow', 'music']);

type MusicSceneRow = {
  sceneId: string;
  musicDesign: NonNullable<Scene['musicDesign']>;
};

type SceneFields = Pick<
  NewScene,
  'title' | 'storyBeat' | 'location' | 'timeOfDay'
> & { id: string };
type ShotFields = Pick<Shot, 'sceneId' | 'durationMs'>;
type StoredShotFields = ShotFields & Pick<Shot, 'id' | 'shotNumber'>;

/** `composeSceneForShot`'s default for a shot row with no duration. */
const shotMs = (shot: ShotFields) => shot.durationMs ?? 3000;

/**
 * The music LLM's input and its prompt hash: one summary per scene with
 * shots, in scene order, from the scene row, its shots' durations and its
 * head shot's visual prompt text (#1783). The ONLY builder — the pipeline
 * stamp reaches it through {@link musicSceneSummariesFromAnalysis}, every
 * verify and regenerate through {@link musicSceneSummariesFromRows}, so the
 * two cannot hash different values for the same sequence.
 */
function buildMusicSceneSummaries(
  scenes: ReadonlyArray<SceneFields & { visualSummary: string }>,
  shots: readonly ShotFields[]
): MusicSceneSummary[] {
  return scenes.flatMap((scene) => {
    const own = shots.filter((shot) => shot.sceneId === scene.id);
    if (own.length === 0) return [];
    return [
      {
        sceneId: scene.id,
        title: scene.title ?? '',
        storyBeat: scene.storyBeat ?? '',
        durationSeconds:
          own.reduce((total, shot) => total + shotMs(shot), 0) / 1000,
        location: scene.location ?? '',
        timeOfDay: scene.timeOfDay ?? '',
        visualSummary: scene.visualSummary,
      },
    ];
  });
}

/**
 * Pipeline side: the analysis scenes through the SAME insert builders that
 * wrote their `scenes` / `shots` rows (`buildSceneInsert`,
 * `buildShotInserts`' `sceneShotSpecs`), so the stamp hashes the rows verify
 * will read — without a mid-run read.
 *
 * `visualSummaryBySceneId` is the visual prompt text the run wrote onto each
 * scene's head shot (the LLM's on a 1-shot scene, the derived one on a 2+
 * shot scene); a scene with none (reference-only) sends `''`.
 *
 * Throws when `scene.metadata` is missing rather than defaulting, which would
 * hash-alias a corrupt scene with a real one.
 */
export function musicSceneSummariesFromAnalysis(
  scenes: readonly Scene[],
  visualSummaryBySceneId: Readonly<Record<string, string>>
): MusicSceneSummary[] {
  const rows: Array<SceneFields & { visualSummary: string }> = [];
  const shots: ShotFields[] = [];
  for (const [index, scene] of scenes.entries()) {
    const { metadata } = scene;
    if (!metadata) {
      throw new Error(
        `Scene ${scene.sceneId} is missing metadata; cannot build music scene summary`
      );
    }
    rows.push({
      id: scene.sceneId,
      ...buildSceneInsert('', scene, index),
      visualSummary: visualSummaryBySceneId[scene.sceneId] ?? '',
    });
    for (const spec of sceneShotSpecs({ shots: scene.shots, metadata })) {
      shots.push({ sceneId: scene.sceneId, durationMs: shotDurationMs(spec) });
    }
  }
  return buildMusicSceneSummaries(rows, shots);
}

/**
 * Verify / regenerate side, from the stored rows (scenes in `orderIndex`
 * order). `visualPromptByShotId` is each shot's selected visual prompt text
 * (`loadVisualPromptByShotId`); a scene reads its head shot's — the lowest
 * shot number. `legacyShotSummaries` is the pre-#1783 per-shot shape, for
 * `musicPromptInputHashMatches` only — delete after `LEGACY_HASH_UNTIL`.
 */
export function musicSceneSummariesFromRows(
  scenes: readonly SceneFields[],
  shots: readonly StoredShotFields[],
  visualPromptByShotId: ReadonlyMap<string, string>
): {
  sceneSummaries: MusicSceneSummary[];
  legacyShotSummaries: LegacyMusicShotSummary[];
} {
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));
  const headOf = (sceneId: string) =>
    shots
      .filter((shot) => shot.sceneId === sceneId)
      .reduce<StoredShotFields | undefined>(
        (head, shot) =>
          head && (head.shotNumber ?? Infinity) <= (shot.shotNumber ?? Infinity)
            ? head
            : shot,
        undefined
      );
  return {
    sceneSummaries: buildMusicSceneSummaries(
      scenes.map((scene) => {
        const head = headOf(scene.id);
        return {
          ...scene,
          visualSummary: (head && visualPromptByShotId.get(head.id)) ?? '',
        };
      }),
      shots
    ),
    legacyShotSummaries: shots.flatMap((shot) => {
      const scene = shot.sceneId ? byId.get(shot.sceneId) : undefined;
      if (!scene) return [];
      return [
        {
          sceneId: scene.id,
          title: plainSceneTitle(scene.title),
          storyBeat: scene.storyBeat ?? '',
          durationSeconds: shotMs(shot) / 1000,
          location: scene.location ?? '',
          timeOfDay: scene.timeOfDay ?? '',
          visualSummary: '',
        },
      ];
    }),
  };
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
