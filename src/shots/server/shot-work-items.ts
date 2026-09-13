/**
 * Expand analysis scenes + shotMapping into one work item per clip (#1486).
 *
 * Image / motion still keyed off `sceneId` and `.find()`'d the first mapping
 * row, so extra shots never got a still or a video. This is the shared list
 * those phases iterate.
 *
 * A 1-shot scene (one mapping row, or none) stays a single item in scene
 * order — same length and order as `scenes`, so existing 1:1 alignments
 * (imageUrls[i] ↔ scenes[i]) keep working.
 */

import type { Scene } from '@/shots/scene-analysis.schema';
import { deriveShots, type DerivedShot } from '@/shots/shot-list.derive';
import type { ShotSpec } from '@/shots/shot-list.schema';
import type { StyleConfig } from '@/look/style-config';
import { dialogueForShot } from '@/shots/shot-list-pass';

/**
 * The scene as one clip sees it: only the dialogue spoken in that shot
 * (#1585), stamps stripped. Every prompt and every prompt-input hash goes
 * through here or `composeSceneForShot`, never the raw split scene — the
 * visual-prompt batch included, which is per scene but stores and verifies
 * against the anchor shot.
 */
export function sceneForShot(scene: Scene, shotNumber: number): Scene {
  return {
    ...scene,
    originalScript: {
      ...scene.originalScript,
      dialogue: dialogueForShot(scene.originalScript.dialogue, shotNumber),
    },
  };
}

/**
 * A neighbouring scene as prompt context: every line, stamps stripped. Not
 * hashed, but it is prompt text, and the stamp is a storage fact.
 */
export function sceneAsContext(scene: Scene): Scene {
  return {
    ...scene,
    originalScript: {
      ...scene.originalScript,
      dialogue: scene.originalScript.dialogue.map(
        ({ shotNumber: _stamp, ...line }) => line
      ),
    },
  };
}

export type ShotMappingRow = {
  analysisSceneId: string;
  shotId: string;
  frameId?: string | null;
  shotNumber?: number;
};

export type ShotWorkItem = {
  scene: Scene;
  sceneIndex: number;
  mapping: {
    analysisSceneId: string;
    shotId: string;
    frameId: string | null;
    shotNumber: number;
  };
  /** First mapping row for this scene — keeps the LLM prompt path. */
  isSceneHead: boolean;
  /** This scene has 2+ mapping rows. */
  hasSiblingShots: boolean;
};

export function shotWorkItems(
  scenes: readonly Scene[],
  shotMapping: ReadonlyArray<ShotMappingRow> | undefined
): ShotWorkItem[] {
  const mapping = shotMapping ?? [];
  const items: ShotWorkItem[] = [];

  for (const [sceneIndex, scene] of scenes.entries()) {
    const rows = mapping
      .filter((row) => row.analysisSceneId === scene.sceneId)
      .slice()
      .sort((a, b) => (a.shotNumber ?? 1) - (b.shotNumber ?? 1));

    if (rows.length === 0) {
      items.push({
        scene,
        sceneIndex,
        mapping: {
          analysisSceneId: scene.sceneId,
          shotId: '',
          frameId: null,
          shotNumber: 1,
        },
        isSceneHead: true,
        hasSiblingShots: false,
      });
      continue;
    }

    const hasSiblingShots = rows.length > 1;
    for (const [rowIndex, row] of rows.entries()) {
      items.push({
        scene: sceneForShot(scene, row.shotNumber ?? 1),
        sceneIndex,
        mapping: {
          analysisSceneId: row.analysisSceneId,
          shotId: row.shotId,
          frameId: row.frameId ?? null,
          shotNumber: row.shotNumber ?? 1,
        },
        isSceneHead: rowIndex === 0,
        hasSiblingShots,
      });
    }
  }

  return items;
}

/** Clip length written onto the motion job: spec for 2+ shots, scene total otherwise. */
export function clipDurationSeconds(item: ShotWorkItem): number {
  const specs = item.scene.shots;
  if (specs && specs.length > 1) {
    const spec = specForItem(item, specs);
    if (spec && spec.durationSeconds > 0) return spec.durationSeconds;
  }
  return item.scene.metadata?.durationSeconds || 3;
}

/** Snapshot / context map key: sceneId on the 1-shot path, scene::shot otherwise. */
export function imageSnapshotKey(item: ShotWorkItem): string {
  return item.hasSiblingShots && item.mapping.shotId
    ? `${item.scene.sceneId}::${item.mapping.shotId}`
    : item.scene.sceneId;
}

export function snapshotLookupKey(snapshot: {
  sceneId: string;
  shotId?: string;
}): string {
  return snapshot.shotId
    ? `${snapshot.sceneId}::${snapshot.shotId}`
    : snapshot.sceneId;
}

function specForItem(
  item: ShotWorkItem,
  specs: readonly ShotSpec[] = item.scene.shots ?? []
): ShotSpec | undefined {
  return specs.find((spec) => spec.shotNumber === item.mapping.shotNumber);
}

/**
 * Assembled visual + motion prompts for a non-head shot. Null when the scene
 * is 1-shot (LLM path) or the spec is missing.
 */
export function derivedShotForItem(
  item: ShotWorkItem,
  styleConfig: StyleConfig
): DerivedShot | null {
  if (!item.hasSiblingShots || item.isSceneHead) return null;
  const specs = item.scene.shots;
  if (!specs || specs.length <= 1) return null;
  const derived = deriveShots(
    {
      sceneId: item.scene.sceneId,
      sceneNumber: item.scene.sceneNumber,
      originalScript: {
        extract: item.scene.originalScript.extract,
        dialogue: item.scene.originalScript.dialogue,
      },
      metadata: {
        title: item.scene.metadata?.title ?? '',
        durationSeconds: item.scene.metadata?.durationSeconds ?? 3,
        location: item.scene.metadata?.location ?? '',
        timeOfDay: item.scene.metadata?.timeOfDay ?? '',
        storyBeat: item.scene.metadata?.storyBeat ?? '',
      },
      continuity: {
        characterTags: item.scene.continuity?.characterTags ?? [],
        environmentTag: item.scene.continuity?.environmentTag ?? '',
        elementTags: item.scene.continuity?.elementTags ?? [],
        colorPalette: item.scene.continuity?.colorPalette ?? '',
        lightingSetup: item.scene.continuity?.lightingSetup ?? '',
        styleTag: item.scene.continuity?.styleTag ?? '',
      },
      dialoguePresent: item.scene.originalScript.dialogue.length > 0,
      continuousFromPrevious: false,
      shots: [...specs],
    },
    styleConfig
  );
  return (
    derived.find((shot) => shot.shotNumber === item.mapping.shotNumber) ?? null
  );
}
