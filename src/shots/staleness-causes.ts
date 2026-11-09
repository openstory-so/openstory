/**
 * Plain words for a stale artifact's cause (#2344). A manifest diff names
 * the leaf paths whose digest moved (`character:<id>/standardClothing`,
 * `styleConfig/lighting`, `scene/metadata/timeOfDay`); this turns them into
 * the labels the chips show, grouped per entity. The legacy timestamp guess
 * in `shot-staleness.ts` reads the same tables, so the two spellings agree.
 */

import type {
  CharacterBible,
  LocationBible,
  SceneNarrative,
} from '@/platform/server/db/schema';

/** Plain words for the bible fields a cause names (#1600). */
export const CHARACTER_LABELS: Record<keyof CharacterBible, string> = {
  name: 'name',
  age: 'age',
  gender: 'gender',
  ethnicity: 'ethnicity',
  physicalDescription: 'description',
  rendering: 'rendering',
  personality: 'personality',
  movement: 'movement',
  voiceOnly: 'voice only',
  isPerson: 'person',
  consistencyTag: 'tag',
};

/** The look fields a cause names (#2015). The name is a label: renaming a look redraws nothing. */
export const LOOK_LABELS = {
  clothing: 'clothing',
  styling: 'styling',
} as const;

export const LOCATION_LABELS: Record<keyof LocationBible, string> = {
  name: 'name',
  type: 'interior/exterior',
  description: 'description',
  architecturalStyle: 'architecture',
  keyFeatures: 'features',
  ambiance: 'ambiance',
  rendering: 'rendering',
  consistencyTag: 'tag',
};

/** Plain words for the style knobs a cause names (the hash body's keys). */
export const STYLE_LABELS: Record<string, string> = {
  mood: 'mood',
  artStyle: 'art style',
  lighting: 'lighting',
  colorPalette: 'palette',
  cameraWork: 'camera',
  referenceFilms: 'references',
  colorGrading: 'grading',
  medium: 'medium',
  shots: 'shots',
  pace: 'pace',
  energy: 'energy',
};

/** Plain words for the scene fields a cause names; the title is a label. */
export const SCENE_LABELS: Partial<Record<keyof SceneNarrative, string>> = {
  location: 'heading',
  timeOfDay: 'time of day',
  storyBeat: 'story beat',
  continuity: 'cast and tags',
};

/** Every hash that stores a manifest. Clips compare pointers instead. */
export type ManifestArtifact =
  | 'still'
  | 'visual-prompt'
  | 'motion-prompt'
  | 'spec'
  | 'character-sheet'
  | 'location-sheet'
  | 'music-prompt'
  | 'music-track';

/** Display names for the ids a prompt manifest keys its cast and places by. */
export type CauseNames = {
  characters?: ReadonlyMap<string, string>;
  locations?: ReadonlyMap<string, string>;
};

const CHARACTER_FIELDS: Record<string, string> = {
  ...CHARACTER_LABELS,
  standardClothing: LOOK_LABELS.clothing,
  styling: LOOK_LABELS.styling,
  distinguishingFeatures: 'features',
};

const LOCATION_FIELDS: Record<string, string> = { ...LOCATION_LABELS };

const SCENE_FIELDS: Record<string, string> = {
  ...SCENE_LABELS,
  lightingSetup: 'lighting',
  colorPalette: 'palette',
  durationSeconds: 'duration',
};

/** Keys that stand alone, with the label they show under. */
const FLAT_LABELS: Record<string, string> = {
  aspectRatio: 'Aspect ratio',
  analysisModel: 'Script model',
  imageModel: 'Image model',
  audioModel: 'Music model',
  referenceOnly: 'Start frame mode',
  startingFrameImageUrl: 'Image re-rendered',
  visualPrompt: 'Visual prompt',
  seed: 'Seed',
  size: 'Size',
  characterSheetHashes: 'Character sheet',
  locationSheetHashes: 'Location sheet',
  elementReferenceHashes: 'Element reference',
  spec: 'Shot spec',
  styling: 'styling',
  faceSheetVersionId: 'default look sheet',
  referencePhotoUrl: 'reference photo',
  referencePhotoHashes: 'reference photos',
  scriptExtract: 'Script',
  lines: 'Dialogue',
  characterTags: 'Scene: cast',
  elementTags: 'Scene: tags',
  environmentTag: 'Scene: location tag',
  prompt: 'Music prompt',
  tags: 'Tags',
  durationSeconds: 'Duration',
};

/** Body keys that only ever move with the hash shape itself. */
const SHAPE_KEYS = new Set(['artifact', 'hashVersion', 'version']);

const quoted = (names: ReadonlyMap<string, string> | undefined, id: string) =>
  names?.get(id) ? `"${names.get(id)}"` : id;

/**
 * Labels for the manifest keys that moved, grouped per entity:
 * `Character "Mia": clothing, styling`, `Scene: time of day`, `Style:
 * lighting`. Deterministic for a given key set; a key no table knows is
 * shown as it is, never dropped.
 */
export function describeManifestCauses(
  artifact: ManifestArtifact,
  keys: readonly string[],
  names: CauseNames = {}
): string[] {
  const groups = new Map<string, Set<string>>();
  const add = (group: string, field?: string) => {
    const fields = groups.get(group) ?? new Set<string>();
    if (field) fields.add(field);
    groups.set(group, fields);
  };
  for (const key of keys) {
    const [head = '', ...rest] = key.split('/');
    if (SHAPE_KEYS.has(head)) continue;
    const field = rest[0] ?? '';
    const entity = head.indexOf(':');
    if (entity > 0) {
      const kind = head.slice(0, entity);
      const id = head.slice(entity + 1).replace(/#\d+$/, '');
      if (kind === 'character') {
        add(
          `Character ${quoted(names.characters, id)}`,
          CHARACTER_FIELDS[field] ?? field
        );
      } else if (kind === 'location') {
        add(
          `Location ${quoted(names.locations, id)}`,
          LOCATION_FIELDS[field] ?? field
        );
      } else if (kind === 'element') {
        add(`Element ${id}`);
      } else {
        add(key);
      }
      continue;
    }
    if (head === 'scene') {
      if (field === 'originalScript') {
        add(
          rest[1] === 'dialogue' && artifact === 'motion-prompt'
            ? 'Dialogue'
            : 'Script'
        );
      } else if (field === 'metadata') {
        add('Scene', SCENE_FIELDS[rest[1] ?? ''] ?? rest[1]);
      } else {
        add('Scene', SCENE_FIELDS[field] ?? field);
      }
      continue;
    }
    if (head === 'styleConfig') {
      add('Style', STYLE_LABELS[field] ?? field);
      continue;
    }
    if (head === 'characterBible') {
      add(CHARACTER_FIELDS[field] ?? field);
      continue;
    }
    if (head === 'locationBible') {
      add(LOCATION_FIELDS[field] ?? field);
      continue;
    }
    if (head === 'sceneSummaries') {
      add(`Scene ${Number(field) + 1}`, SCENE_FIELDS[rest[1] ?? ''] ?? rest[1]);
      continue;
    }
    add(FLAT_LABELS[head] ?? key);
  }
  return [...groups].map(([group, fields]) =>
    fields.size > 0 ? `${group}: ${[...fields].join(', ')}` : group
  );
}
