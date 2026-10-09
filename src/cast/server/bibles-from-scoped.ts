import type {
  CharacterBibleEntry,
  CharacterLookEntry,
  ElementBibleEntry,
  LocationBibleEntry,
} from '@/shots/scene-analysis.schema';
import type {
  LegacyStylingByCharacter,
  LegacyStylingParts,
} from '@/shots/input-hash';
import type {
  CharacterWithSheet,
  SequenceElement,
  SequenceLocationWithReference,
} from '@/platform/server/db/schema';

/**
 * A character's looks as bible looks (#2015), the one it is wearing first.
 * A character with no look row yet lists the one it wears.
 */
function looksToBible(c: CharacterWithSheet): CharacterLookEntry[] {
  const worn: CharacterLookEntry = {
    lookId: c.lookId,
    name: c.lookName,
    clothing: c.standardClothing ?? '',
    styling: c.styling ?? '',
  };
  return [
    worn,
    ...c.looks
      .filter((look) => look.id !== c.lookId && !look.deletedAt)
      .map((look) => ({
        lookId: look.id,
        name: look.name,
        clothing: look.clothing ?? '',
        styling: look.styling ?? '',
      })),
  ];
}

/** Nullable columns read as `''` — a bible entry's fields are all required. */
export function characterToBible(c: CharacterWithSheet): CharacterBibleEntry {
  return {
    looks: looksToBible(c),
    characterId: c.characterId,
    name: c.name,
    age: c.age ?? '',
    gender: c.gender ?? '',
    ethnicity: c.ethnicity ?? '',
    physicalDescription: c.physicalDescription ?? '',
    standardClothing: c.standardClothing ?? '',
    personality: c.personality ?? '',
    movement: c.movement ?? '',
    voiceDescription: c.voiceDescription ?? '',
    voiceOnly: c.voiceOnly,
    isPerson: c.isPerson,
    rendering: c.rendering ?? '',
    consistencyTag: c.consistencyTag ?? '',
  };
}

/**
 * The stored parts a digest stamped before #2065 hashed for this character,
 * in the look it is wearing: that look's own styling and the bible's legacy
 * features. Verify only (`LegacyStylingParts`).
 */
export function legacyStylingParts(
  c: Pick<
    CharacterWithSheet,
    'legacyDistinguishingFeatures' | 'lookId' | 'looks'
  >
): LegacyStylingParts {
  return {
    distinguishingFeatures: c.legacyDistinguishingFeatures,
    // A character with no look row yet has no styling of its own.
    styling:
      c.looks.find((look) => look.id === c.lookId)?.storedStyling ?? null,
  };
}

/** {@link legacyStylingParts} of each character, by its script id. */
export function legacyStylingByCharacter(
  rows: readonly CharacterWithSheet[]
): LegacyStylingByCharacter {
  return Object.fromEntries(
    rows.map((row) => [row.characterId, legacyStylingParts(row)])
  );
}

export function charactersToBible(
  rows: readonly CharacterWithSheet[]
): CharacterBibleEntry[] {
  return rows.map(characterToBible);
}

export function sequenceLocationsToBible(
  rows: readonly SequenceLocationWithReference[]
): LocationBibleEntry[] {
  return rows.map(locationToBible);
}

export function locationToBible(
  l: SequenceLocationWithReference
): LocationBibleEntry {
  return {
    locationId: l.locationId,
    name: l.name,
    type: l.type === 'exterior' || l.type === 'both' ? l.type : 'interior',
    description: l.description ?? '',
    architecturalStyle: l.architecturalStyle ?? '',
    keyFeatures: l.keyFeatures ?? '',
    ambiance: l.ambiance ?? '',
    consistencyTag: l.consistencyTag ?? '',
    firstMention: {
      sceneId: l.firstMentionSceneId ?? '',
      text: l.firstMentionText ?? '',
      lineNumber: l.firstMentionLine ?? 0,
    },
  };
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
