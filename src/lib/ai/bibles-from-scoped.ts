import type {
  CharacterBibleEntry,
  ElementBibleEntry,
  LocationBibleEntry,
} from '@/lib/ai/scene-analysis.schema';
import type {
  CharacterWithSheet,
  SequenceElement,
  SequenceLocationWithReference,
} from '@/lib/db/schema';

export function charactersToBible(
  rows: readonly CharacterWithSheet[]
): CharacterBibleEntry[] {
  return rows.map((c) => ({
    characterId: c.characterId,
    name: c.name,
    age: c.age ?? '',
    gender: c.gender ?? '',
    ethnicity: c.ethnicity ?? '',
    physicalDescription: c.physicalDescription ?? '',
    standardClothing: c.standardClothing ?? '',
    distinguishingFeatures: c.distinguishingFeatures ?? '',
    consistencyTag: c.consistencyTag ?? '',
  }));
}

export function sequenceLocationsToBible(
  rows: readonly SequenceLocationWithReference[]
): LocationBibleEntry[] {
  return rows.map((l) => ({
    locationId: l.locationId,
    name: l.name,
    type: l.type === 'exterior' || l.type === 'both' ? l.type : 'interior',
    timeOfDay: l.timeOfDay ?? '',
    description: l.description ?? '',
    architecturalStyle: l.architecturalStyle ?? '',
    keyFeatures: l.keyFeatures ?? '',
    colorPalette: l.colorPalette ?? '',
    lightingSetup: l.lightingSetup ?? '',
    ambiance: l.ambiance ?? '',
    consistencyTag: l.consistencyTag ?? '',
    firstMention: {
      sceneId: l.firstMentionSceneId ?? '',
      text: l.firstMentionText ?? '',
      lineNumber: l.firstMentionLine ?? 0,
    },
  }));
}

export function sequenceElementsToBible(
  rows: readonly SequenceElement[]
): ElementBibleEntry[] {
  return rows.map((e) => ({
    token: e.token,
    description: e.description ?? '',
    consistencyTag: e.consistencyTag ?? '',
    firstMention: {
      sceneId: e.firstMentionSceneId ?? '',
      text: e.firstMentionText ?? '',
      lineNumber: e.firstMentionLine ?? 0,
    },
  }));
}
