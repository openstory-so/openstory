/** A scene with no selected script version cannot be edited in place (#1793). */
export const NO_SCENE_SCRIPT_MESSAGE =
  'Scene has no script to edit. Re-run script analysis for this sequence first.';

/** True when the cached scene list already shows this scene has no script. */
export function cachedSceneHasNoScript(
  scenes: readonly { id: string; script: unknown }[] | undefined,
  sceneId: string
): boolean {
  const scene = scenes?.find((row) => row.id === sceneId);
  return scene != null && scene.script == null;
}
