import type { ShotView } from '@/shots/shot-view';
import type { SceneSelection } from '@/shots/ui/scene-selection';

export type AnimaticShot = Pick<
  ShotView,
  | 'id'
  | 'sceneId'
  | 'shotNumber'
  | 'durationMs'
  | 'previewThumbnailUrl'
  | 'dialogue'
  | 'audioClips'
> & { image: { url: string | null } | null };

/** Match the scene rail, including legacy shots without a scene. */
export function orderAnimaticShots(
  shots: readonly AnimaticShot[],
  sceneIds: readonly string[]
) {
  const rank = new Map(sceneIds.map((id, index) => [id, index]));
  return [...shots].sort(
    (a, b) =>
      (rank.get(a.sceneId ?? '') ?? sceneIds.length) -
        (rank.get(b.sceneId ?? '') ?? sceneIds.length) ||
      (a.shotNumber ?? 0) - (b.shotNumber ?? 0)
  );
}

export function animaticSceneId(
  selection: SceneSelection,
  shots: readonly AnimaticShot[]
) {
  return (
    shots.find((shot) => shot.id === selection.shotId)?.sceneId ??
    selection.sceneIds[0] ??
    null
  );
}

export function animaticLines(shot: AnimaticShot, clipIndex: number) {
  const clip = shot.audioClips?.[clipIndex];
  const spoken = new Map(
    clip?.spokenLines?.map((line) => [line.index, line.text])
  );
  return (shot.dialogue?.lines ?? []).map((line, index) => ({
    character: line.character,
    text: spoken.get(index) ?? line.line,
  }));
}
