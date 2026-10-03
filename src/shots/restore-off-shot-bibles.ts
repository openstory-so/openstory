import type {
  CharacterBible,
  LocationBible,
} from '@/platform/server/db/schema/bible-versions';
import type {
  CharacterBibleEntry,
  LocationBibleEntry,
} from '@/shots/scene-analysis.schema';

/**
 * The bible a prompt hash was stamped against, for entities the shot does
 * not reference (#2012).
 *
 * Per-shot scope drops those entities from the new digest. Prompts stamped
 * with the scene roster still carry them, so a verify that only hashed the
 * shot would mark every one stale. Rebuilding the scene-scoped bibles with
 * off-shot entries reverted to the version live at the stamp — and dropping
 * an entry that did not exist yet — makes that old digest match until an
 * on-shot input moves.
 */

type VersionAt = { createdAt: Date };

function versionAt<V extends VersionAt>(
  history: readonly V[] | undefined,
  at: number
): V | null {
  let then: V | undefined;
  for (const version of history ?? []) {
    if (version.createdAt.getTime() <= at) then = version;
  }
  return then ?? null;
}

function text(value: string | null | undefined): string {
  return value ?? '';
}

export function restoreOffShotCharacters<T extends CharacterBibleEntry>(
  sceneEntries: readonly T[],
  shotCharacterIds: ReadonlySet<string>,
  historyByCharacterId: ReadonlyMap<
    string,
    readonly (CharacterBible & VersionAt)[]
  >,
  at: number
): T[] {
  return sceneEntries.flatMap((entry) => {
    if (shotCharacterIds.has(entry.characterId)) return [entry];
    const then = versionAt(historyByCharacterId.get(entry.characterId), at);
    if (!then) return [];
    return [
      {
        ...entry,
        name: text(then.name),
        age: text(then.age),
        gender: text(then.gender),
        ethnicity: text(then.ethnicity),
        physicalDescription: text(then.physicalDescription),
        standardClothing: text(then.standardClothing),
        distinguishingFeatures: text(then.distinguishingFeatures),
        personality: text(then.personality),
        movement: text(then.movement),
        voiceOnly: then.voiceOnly,
        isPerson: then.isPerson,
        consistencyTag: text(then.consistencyTag),
      },
    ];
  });
}

export function restoreOffShotLocations<T extends LocationBibleEntry>(
  sceneEntries: readonly T[],
  shotLocationIds: ReadonlySet<string>,
  historyByLocationId: ReadonlyMap<
    string,
    readonly (LocationBible & VersionAt)[]
  >,
  at: number
): T[] {
  return sceneEntries.flatMap((entry) => {
    if (shotLocationIds.has(entry.locationId)) return [entry];
    const then = versionAt(historyByLocationId.get(entry.locationId), at);
    if (!then) return [];
    const type =
      then.type === 'exterior' ||
      then.type === 'interior' ||
      then.type === 'both'
        ? then.type
        : entry.type;
    return [
      {
        ...entry,
        name: text(then.name),
        type,
        description: text(then.description),
        architecturalStyle: text(then.architecturalStyle),
        keyFeatures: text(then.keyFeatures),
        ambiance: text(then.ambiance),
        consistencyTag: text(then.consistencyTag),
      },
    ];
  });
}
