/**
 * Frozen inputs for the analysis speed/quality eval.
 *
 * Later pipeline stages do NOT consume a candidate model's own earlier output
 * — every model sees the same gold screenplay split, bibles, and still, so a
 * bad scene-split cannot poison visual/motion scores.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayRecordedE2eScenes } from '@/lib/ai/recorded-e2e-scenes';
import type {
  CharacterBibleEntry,
  LocationBibleEntry,
  Scene,
} from '@/lib/ai/scene-analysis.schema';
import { DEFAULT_STYLE_TEMPLATES } from '@/lib/style/style-templates';
import type { StyleConfig } from '@/lib/style/style-config';

const DIR = dirname(fileURLToPath(import.meta.url));

/** Nine-beat prose product-ad with no INT./EXT. headings — the hard split case. */
export const PROSE_SCRIPT = `A woman in a black turtleneck stands at a white bathroom sink and twists a coral lipstick up into the hard morning light, the bullet catching a sharp highlight.

She swipes it on in two strokes, presses her lips together, and looks straight into the lens as if daring it to blink.

Her hand drops the tube into a canvas tote. She shoulders the bag and opens the apartment door in one motion, already moving.

On the stoop she takes the steps two at a time, cutting between parked cars into a wall of pedestrians, late-afternoon sun flaring off a windshield.

At a dumpling window she bites a dumpling in half, dabs her mouth with a thin napkin, and the napkin comes away clean. She raises an eyebrow at camera.

An express train slams past on the platform behind her, stainless doors strobing her reflection into a coral smear. She laughs and gives up on the reflection.

Inside the lurching subway car she uncaps the tube one-handed, presses coral on by feel, caps it, and drops it into her jacket pocket.

She jogs a night crosswalk against the countdown, taxis stacked and idling, and glances back over her shoulder with a grin.

On a small brick comedy-club stage she lifts the mic, leans in, and the room's laughter breaks across her face — coral mouth wide open, the color still exactly where it started.`;

export const PROSE_GOLD_BEATS = 9;

export type TalentRow = {
  id: string;
  name: string;
  description: string | null;
  defaultSheet: { metadata?: CharacterBibleEntry | null } | null;
};

export type LocationRow = {
  id: string;
  name: string;
  description: string | null;
  referenceImageUrl: string | null;
};

/** Unambiguous 2×2 casting case with one clear pairing per talent. */
export const TALENT_CASE = {
  characters: [
    {
      characterId: 'char_scarlett_vega',
      name: 'SCARLETT VEGA',
      age: '27',
      gender: 'Female',
      ethnicity: 'Latina',
      physicalDescription:
        '5\'6", lean, shoulder-length dark brown hair, olive-tan skin, dark brown eyes.',
      standardClothing: 'Fitted black turtleneck, dark jeans, scuffed boots.',
      distinguishingFeatures:
        'Signature glossy coral lipstick, gold hoop earrings.',
      consistencyTag: 'scarlett_vega',
    },
    {
      characterId: 'char_jack_cole',
      name: 'JACK COLE',
      age: '44',
      gender: 'Male',
      ethnicity: 'White',
      physicalDescription:
        '6\'1", broad-shouldered, salt-and-pepper stubble, short grey-brown hair.',
      standardClothing: 'Navy chore coat over a faded tee, work jeans.',
      distinguishingFeatures:
        'Scar through the left eyebrow, scuffed silver watch.',
      consistencyTag: 'jack_cole',
    },
  ] satisfies CharacterBibleEntry[],
  talent: [
    {
      id: 'talent_sienna',
      name: 'Sienna Blake',
      description:
        'Young adult woman, golden blonde, beach-tanned, wide smile. Product-ad and rom-com lead energy.',
      defaultSheet: { metadata: null },
    },
    {
      id: 'talent_marcus',
      name: 'Marcus Hale',
      description:
        'Man in his mid-forties, broad build, salt-and-pepper stubble, weathered face. Character-actor presence.',
      defaultSheet: { metadata: null },
    },
  ] satisfies TalentRow[],
  gold: [
    { talentId: 'talent_sienna', characterId: 'char_scarlett_vega' },
    { talentId: 'talent_marcus', characterId: 'char_jack_cole' },
  ],
};

/** Two obvious matches and one distractor that must stay unmatched. */
export const LOCATION_CASE = {
  scriptLocations: [
    {
      locationId: 'loc_office',
      name: 'INT. MODERN OFFICE - DAY',
      type: 'interior',
      timeOfDay: 'day',
      description:
        'Open-plan glass office with white desks, monitor glow, city view through floor-to-ceiling windows.',
      architecturalStyle: 'Contemporary glass-and-steel corporate',
      keyFeatures: 'Glass walls, white desks, skyline view',
      colorPalette: 'white, cool grey, skyline blue',
      lightingSetup: 'Daylight through floor-to-ceiling glass',
      ambiance: 'Bright, professional, hushed',
      consistencyTag: 'office_modern_glass',
      firstMention: {
        text: 'INT. MODERN OFFICE - DAY',
        lineNumber: 1,
        sceneId: 's1',
      },
    },
    {
      locationId: 'loc_park',
      name: 'EXT. CITY PARK - LATE AFTERNOON',
      type: 'exterior',
      timeOfDay: 'late afternoon',
      description:
        'A downtown park with gravel paths, plane trees, and a stone fountain in warm low sun.',
      architecturalStyle: 'Municipal park landscape',
      keyFeatures: 'Gravel paths, plane trees, stone fountain',
      colorPalette: 'warm green, stone, late-afternoon gold',
      lightingSetup: 'Low sun through plane trees',
      ambiance: 'Open, warm, public',
      consistencyTag: 'park_city_afternoon',
      firstMention: {
        text: 'EXT. CITY PARK - LATE AFTERNOON',
        lineNumber: 8,
        sceneId: 's2',
      },
    },
    {
      locationId: 'loc_subway',
      name: 'INT. SUBWAY PLATFORM - NIGHT',
      type: 'interior',
      timeOfDay: 'night',
      description:
        'Deep underground express platform: tiled columns, yellow edge strip, a dark tunnel mouth.',
      architecturalStyle: 'Early 20th-century mass-transit',
      keyFeatures: 'Tiled columns, yellow platform edge, tunnel mouth',
      colorPalette: 'institutional green, white tile, yellow strip',
      lightingSetup: 'Overhead fluorescents, train-strobe reflections',
      ambiance: 'Loud, rushing, subterranean',
      consistencyTag: 'subway_platform_night',
      firstMention: {
        text: 'INT. SUBWAY PLATFORM - NIGHT',
        lineNumber: 14,
        sceneId: 's3',
      },
    },
  ] satisfies LocationBibleEntry[],
  library: [
    {
      id: 'lib_office',
      name: 'Modern Office Building',
      description:
        'Bright open-plan corporate office with glass partitions, white desks, and a skyline window wall.',
      referenceImageUrl: 'https://example.invalid/office.jpg',
    },
    {
      id: 'lib_park',
      name: 'City Park',
      description:
        'Urban park with tree-lined paths, a fountain, and late-afternoon sun on gravel.',
      referenceImageUrl: 'https://example.invalid/park.jpg',
    },
    {
      id: 'lib_beach',
      name: 'Beach House',
      description:
        'Weathered coastal bungalow, sand in the doorway, ocean glare through linen curtains.',
      referenceImageUrl: 'https://example.invalid/beach.jpg',
    },
  ] satisfies LocationRow[],
  gold: [
    { locationId: 'loc_office', libraryLocationId: 'lib_office' },
    { locationId: 'loc_park', libraryLocationId: 'lib_park' },
  ],
  unmatchedScriptIds: ['loc_subway'],
};

export type EvalGold = {
  screenplay: string;
  scenes: Scene[];
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
  elementBible: ReturnType<typeof replayRecordedE2eScenes>['elementBible'];
  styleConfig: StyleConfig;
  aspectRatio: '16:9';
  /** Scene used for visual + motion (dialogue beat, not the title card). */
  focusScene: Scene;
  sceneBefore: Scene | null;
  sceneAfter: Scene | null;
  startingFrameDataUri: string;
  screenplayHeadingStarts: number[];
};

function headingStarts(script: string): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of script.split('\n')) {
    if (/^(?:INT\.|EXT\.|INT\/EXT\.|I\/E\.)\s/i.test(line.trim())) {
      starts.push(offset);
    }
    offset += line.length + 1;
  }
  return starts;
}

function sceneAt(scenes: Scene[], index: number): Scene | null {
  return scenes[index] ?? null;
}

export function loadEvalGold(): EvalGold {
  const replayed = replayRecordedE2eScenes();
  const scenes = replayed.scenes as Scene[];
  // Scene 3 in the Coral fixture is the hallway dialogue beat — motion has
  // spoken lines AND a still to ground against.
  const focusIndex = Math.min(2, Math.max(0, scenes.length - 1));
  const style = DEFAULT_STYLE_TEMPLATES.find(
    (s) => s.name === 'Product Ad'
  )?.config;
  if (!style) throw new Error('Product Ad style template missing');

  const jpeg = readFileSync(resolve(DIR, 'starting-frame.jpg'));
  const startingFrameDataUri = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  const focusScene = sceneAt(scenes, focusIndex) ?? sceneAt(scenes, 0);
  if (!focusScene) throw new Error('Gold replay produced no scenes');

  return {
    screenplay: replayed.script,
    scenes,
    characterBible: replayed.characterBible,
    locationBible: replayed.locationBible,
    elementBible: replayed.elementBible,
    styleConfig: style,
    aspectRatio: '16:9',
    focusScene,
    sceneBefore: sceneAt(scenes, focusIndex - 1),
    sceneAfter: sceneAt(scenes, focusIndex + 1),
    startingFrameDataUri,
    screenplayHeadingStarts: headingStarts(replayed.script),
  };
}
