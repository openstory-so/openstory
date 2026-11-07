import { loadSequenceStyle } from '@/look/server/sequence-style';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { type DeriveScene, deriveStillPrompt } from '@/shots/shot-list.derive';

/**
 * A still prompt for a shot with no selected visual prompt: derived from its
 * spec, never the raw scene script, whose spoken lines the image model letters
 * in as captions (#2291). Null when the shot has no spec to derive from.
 */
export async function derivedStillPrompt(
  scopedDb: Pick<ScopedDb, 'shotSpecVersions' | 'sequences' | 'styles'>,
  input: {
    shotId: string;
    scene: DeriveScene | null;
    sequence: { id: string; styleConfig?: unknown; styleId?: string | null };
  }
): Promise<string | null> {
  if (!input.scene) return null;
  const spec = await scopedDb.shotSpecVersions.getSelected(input.shotId);
  if (!spec) return null;
  const style = await loadSequenceStyle(scopedDb, input.sequence);
  const text = deriveStillPrompt(spec.spec, input.scene, style);
  return text.trim() ? text : null;
}

export const NO_STILL_PROMPT_MESSAGE =
  'This shot has no image prompt. Write one, or rewrite the shot.';
