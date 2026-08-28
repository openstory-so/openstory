/**
 * Scene↔bible membership (#1218).
 *
 * Scene-split no longer asks the LLM for continuity tags. After the bibles
 * call joins, each scene's verbatim slice is scanned for bible names /
 * tokens and the matching `consistencyTag`s are stamped on. Downstream
 * prompt assembly and reference-image binding join on these tags.
 */

import { matchLocationsToScene } from '@/lib/workflows/scene-matching';
import type { SceneSplitBiblesResult } from './response-schemas';
import type { SceneSplittingScene } from './streaming-scene-parser';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('_');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wholeWord(haystackUpper: string, needleUpper: string): boolean {
  if (needleUpper.length === 0) return false;
  const re = new RegExp(
    `(?:^|[^A-Z0-9_])${escapeRegex(needleUpper)}(?:[^A-Z0-9_]|$)`
  );
  return re.test(haystackUpper);
}

function characterMentioned(extract: string, name: string): boolean {
  const haystack = extract.toUpperCase();
  const nameUpper = name.toUpperCase().trim();
  if (nameUpper.length < 2) return false;
  if (wholeWord(haystack, nameUpper)) return true;
  const first = nameUpper.split(/\s+/)[0];
  return Boolean(first && first.length >= 3 && wholeWord(haystack, first));
}

/**
 * Split tokens are UPPER_SNAKE; the script often names the object in prose
 * ("coral lipstick") rather than echoing `CORAL_LIPSTICK`. Underscores fold
 * to spaces so the phrase still matches as a whole.
 */
function elementMentioned(extract: string, token: string): boolean {
  const haystack = extract.toUpperCase();
  const tokenUpper = token.toUpperCase().trim();
  if (tokenUpper.length < 2) return false;
  if (wholeWord(haystack, tokenUpper)) return true;
  const prose = tokenUpper.replace(/_/g, ' ').trim();
  if (prose.length < 4) return false;
  if (prose.includes(' ')) return haystack.includes(prose);
  return wholeWord(haystack, prose);
}

export type TagReconcileStats = {
  assignedCharacterTags: number;
  assignedEnvironmentTags: number;
  assignedElementTags: number;
};

export function reconcileSceneTags(
  scenes: SceneSplittingScene[],
  bibles: Pick<
    SceneSplitBiblesResult,
    'characterBible' | 'locationBible' | 'elementBible'
  >
): { scenes: SceneSplittingScene[]; stats: TagReconcileStats } {
  const stats: TagReconcileStats = {
    assignedCharacterTags: 0,
    assignedEnvironmentTags: 0,
    assignedElementTags: 0,
  };

  const canonicalCharacterTag = (entry: {
    name: string;
    consistencyTag: string;
  }): string => entry.consistencyTag || slugify(entry.name);
  const canonicalLocationTag = (entry: {
    name: string;
    consistencyTag: string;
  }): string => entry.consistencyTag || slugify(entry.name);

  const reconciled = scenes.map((scene) => {
    const extract = scene.originalScript.extract;
    const characterTags: string[] = [];
    for (const entry of bibles.characterBible) {
      if (!characterMentioned(extract, entry.name)) continue;
      const tag = canonicalCharacterTag(entry);
      if (!characterTags.includes(tag)) {
        characterTags.push(tag);
        stats.assignedCharacterTags++;
      }
    }

    const [locationMatch] = matchLocationsToScene(
      bibles.locationBible,
      '',
      scene.metadata.location
    );
    const environmentTag = locationMatch
      ? canonicalLocationTag(locationMatch)
      : '';
    if (environmentTag) stats.assignedEnvironmentTags++;

    const elementTagsList: string[] = [];
    for (const entry of bibles.elementBible) {
      if (!elementMentioned(extract, entry.token)) continue;
      const token = entry.token.toUpperCase();
      if (!elementTagsList.includes(token)) {
        elementTagsList.push(token);
        stats.assignedElementTags++;
      }
    }
    const elementTags = elementTagsList.length > 0 ? elementTagsList : null;

    return {
      ...scene,
      continuity: {
        ...scene.continuity,
        characterTags,
        environmentTag,
        elementTags,
        colorPalette:
          scene.continuity.colorPalette || locationMatch?.colorPalette || '',
        lightingSetup:
          scene.continuity.lightingSetup || locationMatch?.lightingSetup || '',
      },
    };
  });

  // Continuation slices often name nobody ("She leans into the mirror")
  // and never repeat the product token. Keep the previous scene's tags so
  // reference-image binding and fal Image-N numbering stay stable.
  for (let i = 1; i < reconciled.length; i++) {
    const scene = reconciled[i];
    const previous = reconciled[i - 1];
    if (!scene || !previous) continue;
    if (
      scene.continuity.characterTags.length === 0 &&
      previous.continuity.characterTags.length > 0
    ) {
      scene.continuity.characterTags = [...previous.continuity.characterTags];
      stats.assignedCharacterTags += previous.continuity.characterTags.length;
    }
    if (!scene.continuity.elementTags && previous.continuity.elementTags) {
      scene.continuity.elementTags = [...previous.continuity.elementTags];
      stats.assignedElementTags += previous.continuity.elementTags.length;
    }
  }

  return { scenes: reconciled, stats };
}
