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
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: a row stored before #2015 (a talent's metadata) has no looks
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
  sceneIdForLine: (lineNumber: number) => string,
  /** Lines in the script: a `lines` entry outside 1..lineCount is dropped. */
  lineCount: number
): {
  characterBible: CharacterBibleEntry[];
  sceneLooks: Record<string, Record<string, string>>;
} {
  const sceneLooks: Record<string, Record<string, string>> = {};
  const characterBible = wire.map((entry) => {
    const given = entry.looks;
    const slugs = new Set<string>();
    const names = new Set<string>();
    const looks = given.map((look, index) => {
      // Two looks of one character never share a name: the name is how a
      // re-analysis finds the look again, so a repeat gets a number.
      const baseName = look.name.trim() || DEFAULT_LOOK_NAME;
      let name = baseName;
      for (let n = 2; names.has(name.toLowerCase()); n++) {
        name = `${baseName} ${n}`;
      }
      names.add(name.toLowerCase());
      const base = index === 0 ? 'default' : slugifyTag(name) || 'look';
      let slug = base;
      for (let n = 2; slugs.has(slug); n++) slug = `${base}_${n}`;
      slugs.add(slug);
      const lookId = `${entry.characterId}:${slug}`;
      if (index > 0) {
        for (const line of look.lines) {
          // A line that is not in the script names no scene. The line → scene
          // lookup clamps, which would dress the first or last scene in an
          // outfit the script never put there.
          if (!Number.isInteger(line) || line < 1 || line > lineCount) continue;
          const sceneId = sceneIdForLine(line);
          if (sceneId) {
            (sceneLooks[sceneId] ??= {})[canonicalBibleTag(entry)] = lookId;
          }
        }
      }
      return {
        lookId,
        name,
        // The default outfit is asked for twice (`standardClothing` and the
        // first look). One left blank must not wipe the other.
        clothing:
          index === 0
            ? look.clothing.trim() || entry.standardClothing
            : look.clothing,
        styling: look.styling,
      };
    });
    return withBibleLooks({ ...entry, looks });
  });
  return { characterBible, sceneLooks };
}

/**
 * An entry as a prompt that has no use for outfits sees it (voice design):
 * no `looks` key at all, which is also the text such a prompt had before
 * looks existed.
 */
export function withoutLooks(
  entry: CharacterBibleEntry
): Omit<CharacterBibleEntry, 'looks'> {
  const { looks: _looks, ...rest } = entry;
  return rest;
}

/**
 * Entries as a shot's prompt sees them: each with only the look it wears in
 * that shot's scene (the first), never the character's other outfits.
 */
export function wornLookOnly(
  entries: readonly CharacterBibleEntry[]
): CharacterBibleEntry[] {
  return entries.map((entry) => ({
    ...entry,
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: an entry stored before #2015 has no looks
    looks: (entry.looks ?? []).slice(0, 1),
  }));
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
