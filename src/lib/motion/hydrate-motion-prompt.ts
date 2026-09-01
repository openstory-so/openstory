import type {
  MotionDialogue,
  MotionPrompt,
  Scene,
} from '@/lib/ai/scene-analysis.schema';

function hasDialogue(dialogue: MotionPrompt['dialogue']): boolean {
  return Boolean(dialogue.presence && dialogue.lines.length > 0);
}

/**
 * Ensure structured dialogue is present when the scene script carries lines.
 *
 * The analysis pipeline sources dialogue from `originalScript.dialogue` (see
 * `deriveMotionPrompt` in shot-list.derive.ts). The motion-prompt LLM usually
 * extracts it too, but regenerate runs can return empty dialogue — hydrate
 * from the scene so audio-capable models still get lip-sync lines.
 */
export function hydrateMotionPromptFromScene(
  scene: Scene,
  motionPrompt: MotionPrompt
): MotionPrompt {
  if (hasDialogue(motionPrompt.dialogue)) {
    return motionPrompt;
  }

  const scriptLines = scene.originalScript.dialogue;
  if (!scriptLines.length) {
    return motionPrompt;
  }

  return {
    ...motionPrompt,
    dialogue: {
      presence: true,
      lines: scriptLines,
    } satisfies MotionDialogue,
  };
}
