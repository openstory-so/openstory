/**
 * Looks on a character bible entry (#2015): the analysis shape of
 * `character_looks`. Pure.
 *
 * An entry lists every outfit, the one WORN first, and `standardClothing` is
 * always that look's clothing. Off the bibles call the worn look is the
 * default; in a shot's prompt context it is the look the shot's scene picks
 * (`wearBibleLooks`). A look's id is a slug until the cast is persisted, then
 * the `character_looks.id` (`relabelBibleLooks`).
 */

import { canonicalBibleTag, slugifyTag } from '@/cast/bible-field';
import type { CharacterBibleWireEntry } from '@/sequences/response-schemas';
import type {
  CharacterBibleEntry,
  CharacterLookEntry,
} from '@/shots/scene-analysis.schema';
import type { SceneLookPicks } from './character-looks';

/** The name a default look carries until someone renames it. */
const DEFAULT_LOOK_NAME = 'Default';

/**
 * An entry with its looks made whole. One with none — recorded or stored
 * before looks — gets a default look from `standardClothing`. Slugs are
 * prefixed with the character's id, so two characters' `default` never
 * collide once a scene's picks are read by look id alone.
 */
export function withBibleLooks(
  entry: CharacterBibleEntry
): CharacterBibleEntry {
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: an entry cached or stored before #2015 has no looks
  const given = entry.looks ?? [];
  const looks: CharacterLookEntry[] =
    given.length > 0
      ? given.map((look) => ({
          ...look,
          lookId: look.lookId.startsWith(`${entry.characterId}:`)
            ? look.lookId
            : `${entry.characterId}:${look.lookId}`,
        }))
      : [
          {
            lookId: `${entry.characterId}:default`,
            name: DEFAULT_LOOK_NAME,
            clothing: entry.standardClothing,
            styling: '',
          },
        ];
  return { ...entry, looks, standardClothing: looks[0]?.clothing ?? '' };
}

/** The styling of the look an entry is wearing; `''` when none. */
export const wornStyling = (entry: CharacterBibleEntry): string =>
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: an entry stored before #2015 has no looks
  entry.looks?.[0]?.styling ?? '';

/**
 * Each entry wearing the look a scene picks for it: that look first, its
 * clothing as `standardClothing`. An entry the scene picks nothing for is
 * returned as it is, so an already-dressed entry stays dressed.
 */
export function wearBibleLooks<T extends CharacterBibleEntry>(
  entries: readonly T[],
  picks: SceneLookPicks
): T[] {
  const ids = Object.values(picks ?? {});
  return entries.map((entry) => {
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: an entry stored before #2015 has no looks
    const looks = entry.looks ?? [];
    const worn = looks.find((look) => ids.includes(look.lookId));
    if (!worn || worn === looks[0]) return entry;
    return {
      ...entry,
      standardClothing: worn.clothing,
      looks: [worn, ...looks.filter((look) => look !== worn)],
    };
  });
}

/**
 * The bibles call's characters as bible entries (#2015), and the looks each
 * scene picks: scene id → (character tag → look id). A wire look has a name
 * and the lines it is worn at; here it gets its slug id, and its lines
 * become picks on the scenes those lines fall in. The first look is the
 * default: it is what "no pick" means, so its lines are not read.
 */
export function bibleFromWire(
  wire: readonly CharacterBibleWireEntry[],
  sceneIdForLine: (lineNumber: number) => string
): {
  characterBible: CharacterBibleEntry[];
  sceneLooks: Record<string, Record<string, string>>;
} {
  const sceneLooks: Record<string, Record<string, string>> = {};
  const characterBible = wire.map((entry) => {
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a bibles result cached before #2015 has no looks
    const given = entry.looks ?? [];
    const taken = new Set<string>();
    const looks = given.map((look, index) => {
      const base = index === 0 ? 'default' : slugifyTag(look.name) || 'look';
      let slug = base;
      for (let n = 2; taken.has(slug); n++) slug = `${base}_${n}`;
      taken.add(slug);
      const lookId = `${entry.characterId}:${slug}`;
      if (index > 0) {
        for (const line of look.lines) {
          const sceneId = sceneIdForLine(line);
          if (sceneId) {
            (sceneLooks[sceneId] ??= {})[canonicalBibleTag(entry)] = lookId;
          }
        }
      }
      return {
        lookId,
        name: look.name,
        clothing: look.clothing,
        styling: look.styling,
      };
    });
    return withBibleLooks({ ...entry, looks });
  });
  return { characterBible, sceneLooks };
}

/** Entries with their look ids swapped for the persisted ones. */
export function relabelBibleLooks(
  entries: readonly CharacterBibleEntry[],
  ids: Readonly<Record<string, string>>
): CharacterBibleEntry[] {
  return entries.map(withBibleLooks).map((entry) => ({
    ...entry,
    looks: entry.looks.map((look) => ({
      ...look,
      lookId: ids[look.lookId] ?? look.lookId,
    })),
  }));
}

/** One scene's picks with their look ids swapped for the persisted ones. */
export function relabelLookPicks(
  picks: Readonly<Record<string, string>>,
  ids: Readonly<Record<string, string>>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(picks).flatMap(([tag, lookId]) => {
      const id = ids[lookId];
      // A look that was not persisted cannot be worn: the scene keeps the
      // character's default rather than a pick that names nothing.
      return id ? [[tag, id]] : [];
    })
  );
}
