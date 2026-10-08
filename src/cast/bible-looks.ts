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
import { isValidId } from '@/platform/id';
import type { CharacterBibleWireEntry } from '@/sequences/response-schemas';
import type {
  CharacterBibleEntry,
  CharacterLookEntry,
} from '@/shots/scene-analysis.schema';
import { effectiveStyling } from './character-looks';
import type { SceneLookPicks } from './character-looks';

/** The name a default look carries until someone renames it. */
const DEFAULT_LOOK_NAME = 'Default';

/**
 * An entry with its looks made whole. One with none — recorded or stored
 * before looks — gets a default look from `standardClothing`. Slugs are
 * prefixed with the character's id, so two characters' `default` never
 * collide once a scene's picks are read by look id alone. A persisted id (a
 * `character_looks` ULID, as an attached character's looks carry, #2050) is
 * left as it is.
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
          lookId:
            look.lookId.startsWith(`${entry.characterId}:`) ||
            isValidId(look.lookId)
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The seam for a character bible entry written before #2065, which still
 * carries `distinguishingFeatures`: the text is folded into the styling of
 * the entry's DEFAULT look (`effectiveStyling`) and the key is dropped, so
 * nothing downstream reads it. Any other value is returned as it is.
 *
 * Which look is the default:
 *
 * - Looks under slug ids (the bibles call, before the cast is persisted):
 *   the default's slug is `default` (`bibleFromWire`), wherever it sits. An
 *   entry dressed for a scene lists the worn look first, so the default may
 *   not be first, or not there at all (`wornLookOnly`). Then no look takes
 *   the text and it is dropped for that run, which is what a live verify
 *   computes for a look that is not the default.
 * - Looks under persisted ids (a payload frozen from a cast read): the
 *   entry does not say which is the default. The default look's id is its
 *   character's row id, but an entry carries only the script id, and a look
 *   entry has no flag. So the FIRST look takes the text. That is the default
 *   look unless the entry was dressed for a scene that picks another look
 *   (`update-stale-plan`, `regenerate-shot-prompt`): there the worn look
 *   takes it, as the prompt queued before #2065 would have read it.
 *
 * An entry with no looks is left alone: the caller decides what that means
 * (a recorded bibles response gets a look, a payload from before #2015 is
 * failed).
 */
export function foldLegacyFeatures(entry: unknown): unknown {
  if (!isRecord(entry) || typeof entry.distinguishingFeatures !== 'string') {
    return entry;
  }
  const { distinguishingFeatures, ...rest } = entry;
  const looks: unknown[] = Array.isArray(rest.looks) ? rest.looks : [];
  if (!isRecord(looks[0])) return entry;
  const idOf = (look: unknown) =>
    isRecord(look) && typeof look.lookId === 'string' ? look.lookId : '';
  // Slug ids (`<characterId>:<slug>`, which no persisted id looks like) name
  // their default; persisted ids do not, so the first it is.
  const target = looks.every((look) => idOf(look).includes(':'))
    ? looks.findIndex((look) => idOf(look).endsWith(':default'))
    : 0;
  return {
    ...rest,
    looks: looks.map((look, index) =>
      index === target && isRecord(look)
        ? {
            ...look,
            styling:
              effectiveStyling(
                typeof look.styling === 'string' ? look.styling : '',
                distinguishingFeatures
              ) ?? '',
          }
        : look
    ),
  };
}

/** Payload keys that hold a TALENT's metadata: its features are its own. */
const TALENT_METADATA_KEYS = new Set([
  'talentMetadata',
  'sheetMetadata',
  'uploadedSheetMetadata',
  // A talent sheet row's own column, wherever a payload carries one.
  'metadata',
]);

/**
 * A workflow payload queued or frozen before #2065, made the current shape
 * (the payload seam, run once by the workflow base):
 *
 * - every character bible entry anywhere in it goes through
 *   {@link foldLegacyFeatures};
 * - a sheet payload keeps its look's styling beside the entry
 *   (`characterMetadata` + `lookStyling`), so the features join `lookStyling`
 *   there — on the default look only (`face` null), since no other look
 *   inherits them. The pair as queued is kept as `queuedLegacyStyling`, for
 *   the run's check of its own snapshot hash.
 *
 * A talent's metadata is not a character's and is left alone. A payload of
 * the current shape comes back unchanged.
 */
export function foldLegacyFeaturesInPayload<T>(payload: T): T {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!isRecord(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      // `characterMetadata` is folded below, with the styling beside it.
      out[key] =
        TALENT_METADATA_KEYS.has(key) || key === 'characterMetadata'
          ? child
          : walk(child);
    }
    const metadata = out.characterMetadata;
    if (
      isRecord(metadata) &&
      typeof metadata.distinguishingFeatures === 'string'
    ) {
      const { distinguishingFeatures, ...rest } = metadata;
      out.characterMetadata = rest;
      const own = typeof out.lookStyling === 'string' ? out.lookStyling : null;
      // The two as they were queued: the run's own snapshot hash was
      // stamped from them (`queuedLegacyStyling`).
      out.queuedLegacyStyling = { distinguishingFeatures, styling: own };
      if (out.face === null || out.face === undefined) {
        out.lookStyling = effectiveStyling(own, distinguishingFeatures);
      }
      return out;
    }
    return typeof out.characterId === 'string' ? foldLegacyFeatures(out) : out;
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the walk rebuilds the same shape, minus a key the type no longer has
  return walk(payload) as T;
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
  lineCount: number,
  /**
   * The attached cast's tags by script id (#2050). An entry that echoes a
   * cast id keeps that character's tag, so a re-analysis moves nothing of
   * hers. Two NEW characters may share a plain name, but a pick is filed
   * under the character's tag, so two of one tag would overwrite each
   * other's picks: a new entry's repeat of a tag in use gets a number
   * (`sarah`, `sarah_2`), as a repeated look name does.
   */
  castTagsById: ReadonlyMap<string, string>
): {
  characterBible: CharacterBibleEntry[];
  sceneLooks: Record<string, Record<string, string>>;
} {
  const sceneLooks: Record<string, Record<string, string>> = {};
  const tags = new Set(castTagsById.values());
  const characterBible = wire.map((given) => {
    const own = castTagsById.get(given.characterId);
    let tag = own ?? canonicalBibleTag(given);
    if (own === undefined) {
      for (let n = 2; tags.has(tag); n++)
        tag = `${canonicalBibleTag(given)}_${n}`;
      tags.add(tag);
    }
    const entry = { ...given, consistencyTag: tag };
    const slugs = new Set<string>();
    const names = new Set<string>();
    const resolved = given.looks.map((look, index) => {
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
    return withBibleLooks({ ...entry, looks: resolved });
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
