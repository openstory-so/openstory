/**
 * Dressing a character in a look (#2015). Pure, so the stamp, the verify, the
 * cause list and the render all resolve a scene's outfit the same way.
 *
 * A character off a scoped read wears its default look: its clothing and
 * sheet sit under the names the character's own columns had. A scene picks
 * one look per character (`continuity.characterLooks`); `dressForScene`
 * swaps that look's clothing and sheet in. A character the scene does not
 * pick a look for keeps its default, so nothing moves for a sequence that
 * never uses looks.
 */

import type {
  CharacterLook,
  CharacterLookMinimal,
} from '@/platform/server/db/schema';

/** What a look puts on a character. Sheet detail only when the look carries it. */
type WearableLook = CharacterLookMinimal &
  Partial<
    Pick<
      CharacterLook,
      | 'sheetImagePath'
      | 'sheetGeneratedAt'
      | 'sheetError'
      | 'pendingPromoteSheetVersionId'
    >
  >;

/**
 * The one resolver of a look's styling (#2065). A character's DEFAULT look
 * owns what the bible called distinguishing features: until its styling is
 * next edited, that text still sits on the bible version
 * (`legacyDistinguishingFeatures`), and the look's styling is its own
 * joined with it. Any other look's styling is its own; pass `null`.
 *
 * Blank parts are skipped, and features the styling already holds are not
 * repeated, so a look version written from the effective text stays right
 * while a sequence still pins the older bible version. This is the designed read, not a fallback: every look read, prompt
 * and current digest goes through it.
 */
export function effectiveStyling(
  styling: string | null | undefined,
  legacyFeatures: string | null | undefined
): string | null {
  const own = (styling ?? '').trim();
  const features = (legacyFeatures ?? '').trim();
  // No features to join: the look's own value, untouched.
  if (!features || own.includes(features)) return styling ?? null;
  return own ? `${own}\n${features}` : features;
}

/** `character`, wearing `look`. */
export function wearLook<T extends object>(character: T, look: WearableLook) {
  return {
    ...character,
    lookId: look.id,
    lookName: look.name,
    standardClothing: look.clothing,
    styling: look.styling,
    sheetImageUrl: look.sheetImageUrl,
    sheetStatus: look.sheetStatus,
    sheetInputHash: look.sheetInputHash,
    selectedSheetVersionId: look.selectedSheetVersionId,
    ...(look.sheetImagePath === undefined
      ? {}
      : {
          sheetImagePath: look.sheetImagePath,
          sheetGeneratedAt: look.sheetGeneratedAt ?? null,
          sheetError: look.sheetError ?? null,
          pendingPromoteSheetVersionId:
            look.pendingPromoteSheetVersionId ?? null,
        }),
  };
}

/**
 * `character` with one look's sheet replaced — a sheet a run just made, or a
 * placeholder for one it is about to make. Lands on the look's entry and, when
 * the character is wearing that look, on the character too, so dressing it
 * for a scene afterwards cannot bring the old sheet back.
 */
export function withLookSheet<
  T extends { lookId: string; looks: readonly WearableLook[] },
>(
  character: T,
  lookId: string,
  sheet: Pick<
    CharacterLookMinimal,
    'sheetImageUrl' | 'selectedSheetVersionId'
  > &
    Partial<Pick<CharacterLookMinimal, 'sheetInputHash'>>
): T {
  return {
    ...character,
    looks: character.looks.map((look) =>
      look.id === lookId ? { ...look, ...sheet } : look
    ),
    ...(character.lookId === lookId ? sheet : {}),
  };
}

/** A scene's picks: character tag → look id. */
export type SceneLookPicks = Record<string, string> | null | undefined;

/**
 * The look a scene picks for this character, or null for its default. Matched
 * by look id alone: a look belongs to one character, so the tag it is filed
 * under is only a label and a renamed character keeps its pick.
 */
export function pickedLook<L extends { id: string }>(
  character: { looks: readonly L[] },
  picks: SceneLookPicks
): L | null {
  if (!picks) return null;
  const ids = Object.values(picks);
  return character.looks.find((look) => ids.includes(look.id)) ?? null;
}

const hasLooks = (
  character: object
): character is { looks: readonly WearableLook[] } =>
  'looks' in character && Array.isArray(character.looks);

/**
 * Each character wearing what this scene picks for it. A character with no
 * `looks` passes through: a bible entry in a prompt context was dressed when
 * the context was loaded.
 */
export function dressForScene<T extends object>(
  characters: readonly T[],
  picks: SceneLookPicks
): T[] {
  return characters.map((character) => {
    const look = hasLooks(character) ? pickedLook(character, picks) : null;
    return look ? wearLook(character, look) : character;
  });
}

/**
 * Is this character in its default look? True too for a character with no
 * looks listed: one a run hands back before its look rows are read.
 */
export function wearsDefaultLook(character: {
  lookId: string;
  looks: readonly Pick<CharacterLookMinimal, 'id' | 'isDefault'>[];
}): boolean {
  const worn = character.looks.find((look) => look.id === character.lookId);
  return worn?.isDefault ?? true;
}

/**
 * Whose sheet a look's is, for a line of copy: `Mia`, or `Mia (Gala gown)`
 * when the look is not her default. Undefined when no character has the look.
 */
export function sheetLookName(
  characters: readonly {
    name: string;
    lookId: string;
    looks: readonly Pick<CharacterLookMinimal, 'id' | 'name' | 'isDefault'>[];
  }[],
  lookId: string
): string | undefined {
  for (const character of characters) {
    const look = character.looks.find((l) => l.id === lookId);
    if (look) {
      return look.isDefault
        ? character.name
        : `${character.name} (${look.name})`;
    }
    // A character with no look row yet: its default answers to `lookId`.
    if (character.lookId === lookId) return character.name;
  }
  return undefined;
}
