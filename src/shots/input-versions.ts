/**
 * Which versions an artifact read (#1862).
 *
 * A prompt and a still are made from inputs that have history: the scene's
 * script version, the style snapshot, each character's pinned bible and the
 * look it wore, each location's bible, and (for a still) the sheet each
 * reference was drawn from. The hash says THAT they moved; this says WHICH
 * rows the run read, so a stale verdict can name the fields by an exact
 * pointer compare against what the sequence pins now, never by "the version
 * that was newest at that time".
 *
 * Provenance only: never part of any hash body (no stored digest moves),
 * never filtered in SQL, and never a copy of authored data — ids only. A
 * row written before the column exists has none; its cause falls back to
 * the pin walk or the clock and says so.
 *
 * Keys are the ids the prompt context names: a character's SCRIPT id
 * (`char_001`), a location's script id, a scene's `Scene.sceneId`.
 */

/**
 * Everything a sequence pins, snapshotted once at the trigger and frozen on
 * the payload, so a run that writes prompts for several scenes stamps each
 * from the same read. `scenes` holds every scene the run may write for.
 */
export type SequenceInputVersions = {
  /** `sequence_style_versions.id`; null while an automatic style is still deriving. */
  style: string | null;
  /**
   * By script character id: the pinned bible, each look's pinned version, and
   * the default look's id — what a bible entry from before looks wears.
   */
  characters: Record<
    string,
    { bible: string; defaultLook: string; looks: Record<string, string> }
  >;
  /** By script location id → `location_bible_versions.id` (null before #1600). */
  locations: Record<string, string | null>;
  /** By `Scene.sceneId` → `scene_script_versions.id` (null before #1600). */
  scenes: Record<string, string | null>;
};

/** What one prompt read: {@link SequenceInputVersions} narrowed to its references. */
export type PromptInputVersions = {
  scene: string | null;
  style: string | null;
  /** The pinned bible and the version of the look worn in this shot's scene. */
  characters: Record<string, { bible: string; look: string }>;
  locations: Record<string, string | null>;
};

/**
 * What a still read beyond its prompt: the prompt's own record is on the
 * `frame_prompt_versions` row the still points at (`promptVersionId`), so it
 * is not repeated here. By character / location ROW id → the sheet version
 * the reference was drawn from, null when none had landed.
 */
export type StillInputVersions = {
  sheets: Record<string, string | null>;
  locationSheets: Record<string, string | null>;
};

const required = <V>(map: Record<string, V>, id: string, what: string): V => {
  const value = map[id];
  if (value === undefined) {
    throw new Error(`inputVersions: ${what} ${id} was not snapshotted`);
  }
  return value;
};

/**
 * The prompt's record from the sequence snapshot and the context it was
 * hashed from (already narrowed to what the prompt references, with each
 * character wearing the scene's look first). A referenced id with no entry
 * is a bug at the trigger, not a gap to paper over: the stamp fails loudly.
 */
export function promptInputVersionsFor(
  snapshot: SequenceInputVersions,
  narrowed: {
    scene: { sceneId: string };
    characterBible: readonly {
      characterId: string;
      looks: readonly { lookId: string }[];
    }[];
    locationBible: readonly { locationId: string }[];
  }
): PromptInputVersions {
  return {
    scene: required(snapshot.scenes, narrowed.scene.sceneId, 'scene'),
    style: snapshot.style,
    characters: Object.fromEntries(
      narrowed.characterBible.map((entry) => {
        const character = required(
          snapshot.characters,
          entry.characterId,
          'character'
        );
        // An entry from before looks (#2015) names none: it wore the default.
        const worn = entry.looks[0]?.lookId ?? character.defaultLook;
        return [
          entry.characterId,
          {
            bible: character.bible,
            look: required(
              character.looks,
              worn,
              `look of ${entry.characterId}`
            ),
          },
        ];
      })
    ),
    locations: Object.fromEntries(
      narrowed.locationBible.map((entry) => [
        entry.locationId,
        required(snapshot.locations, entry.locationId, 'location'),
      ])
    ),
  };
}

/**
 * The sequence snapshot from the rows a trigger already holds: the cast as
 * the sequence casts it (pinned bible, each look's pinned version), its
 * locations and scenes, and the style version it points at.
 */
export function sequenceInputVersionsOf(rows: {
  styleVersionId: string | null;
  characters: readonly {
    characterId: string;
    selectedBibleVersionId: string;
    /** The default look off a scoped read (the row wears it). */
    lookId: string;
    looks: readonly { id: string; lookVersionId: string }[];
  }[];
  locations: readonly {
    locationId: string;
    selectedBibleVersionId: string | null;
  }[];
  scenes: readonly { sceneId: string; scriptVersionId: string | null }[];
}): SequenceInputVersions {
  return {
    style: rows.styleVersionId,
    characters: Object.fromEntries(
      rows.characters.map((c) => [
        c.characterId,
        {
          bible: c.selectedBibleVersionId,
          defaultLook: c.lookId,
          looks: Object.fromEntries(
            c.looks.map((look) => [look.id, look.lookVersionId])
          ),
        },
      ])
    ),
    locations: Object.fromEntries(
      rows.locations.map((l) => [l.locationId, l.selectedBibleVersionId])
    ),
    scenes: Object.fromEntries(
      rows.scenes.map((s) => [s.sceneId, s.scriptVersionId])
    ),
  };
}

/**
 * What a still's references were drawn from, read off the references the
 * render was given: each carries `provenanceKey` (`kind:rowId:identity`,
 * `referenceProvenanceKey`), whose identity is the sheet version id, or the
 * image url for a sheet from before #1419. Keyed by the entity's ROW id.
 */
export function stillInputVersionsFromReferences(
  references: readonly { provenanceKey?: string }[]
): StillInputVersions {
  const sheets: Record<string, string | null> = {};
  const locationSheets: Record<string, string | null> = {};
  for (const reference of references) {
    if (!reference.provenanceKey) continue;
    const [kind, rowId, identity] = reference.provenanceKey.split(':', 3);
    if (!rowId) continue;
    const version = identity ? identity : null;
    if (kind === 'character') sheets[rowId] = version;
    else if (kind === 'location') locationSheets[rowId] = version;
  }
  return { sheets, locationSheets };
}
