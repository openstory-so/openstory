import { describe, expect, it } from 'vitest';
import type { SceneSplittingScene } from './streaming-scene-parser';
import { reconcileSceneTags } from './tag-reconcile';

function makeScene(
  extract: string,
  location = 'INT. OFFICE - DAY'
): SceneSplittingScene {
  return {
    sceneId: 'scene-1',
    sceneNumber: 1,
    originalScript: { extract, dialogue: [] },
    metadata: {
      title: 'Test',
      durationSeconds: 3,
      location,
      timeOfDay: 'day',
      storyBeat: '',
    },
    continuity: {
      characterTags: [],
      environmentTag: '',
      elementTags: null,
      colorPalette: '',
      lightingSetup: '',
      styleTag: '',
    },
  };
}

const characterBible = [
  {
    characterId: 'char_001',
    name: 'JACK',
    age: '30s',
    gender: 'male',
    ethnicity: '',
    physicalDescription: '',
    standardClothing: '',
    distinguishingFeatures: '',
    consistencyTag: 'jack_denim_weathered',
  },
];

const locationBible = [
  {
    locationId: 'loc_001',
    name: 'INT. OFFICE - DAY',
    type: 'interior' as const,
    timeOfDay: 'day',
    description: '',
    architecturalStyle: '',
    keyFeatures: '',
    colorPalette: 'cool steel',
    lightingSetup: 'overhead fluorescents',
    ambiance: '',
    consistencyTag: 'office_modern_steel',
    firstMention: {
      sceneId: 'scene-1',
      text: 'INT. OFFICE - DAY',
      lineNumber: 1,
    },
  },
];

const elementBible = [
  {
    token: 'CORAL_LIPSTICK',
    description: 'a lipstick',
    consistencyTag: 'coral-lipstick',
    firstMention: { sceneId: 'scene-1', text: 'the lipstick', lineNumber: 3 },
  },
];

describe('reconcileSceneTags', () => {
  it('assigns a character tag when the bible name appears in the slice', () => {
    const { scenes, stats } = reconcileSceneTags(
      [makeScene('JACK enters the office.')],
      { characterBible, locationBible: [], elementBible: [] }
    );
    expect(scenes[0]?.continuity.characterTags).toEqual([
      'jack_denim_weathered',
    ]);
    expect(stats.assignedCharacterTags).toBe(1);
  });

  it('does not invent tags for characters who are not in the slice', () => {
    const { scenes, stats } = reconcileSceneTags(
      [makeScene('An empty corridor. No one here.')],
      { characterBible, locationBible: [], elementBible: [] }
    );
    expect(scenes[0]?.continuity.characterTags).toEqual([]);
    expect(stats.assignedCharacterTags).toBe(0);
  });

  it('assigns the location tag from the scene heading', () => {
    const { scenes, stats } = reconcileSceneTags(
      [makeScene('INT. OFFICE - DAY\n\nJACK types.', 'INT. OFFICE - DAY')],
      { characterBible: [], locationBible, elementBible: [] }
    );
    expect(scenes[0]?.continuity.environmentTag).toBe('office_modern_steel');
    expect(scenes[0]?.continuity.colorPalette).toBe('cool steel');
    expect(scenes[0]?.continuity.lightingSetup).toBe('overhead fluorescents');
    expect(stats.assignedEnvironmentTags).toBe(1);
  });

  it('leaves environment empty when the heading matches no bible location', () => {
    const { scenes } = reconcileSceneTags(
      [makeScene('EXT. ALLEY - NIGHT\n\nRain.', 'EXT. ALLEY - NIGHT')],
      { characterBible: [], locationBible, elementBible: [] }
    );
    expect(scenes[0]?.continuity.environmentTag).toBe('');
  });

  it('assigns element tokens found in the slice', () => {
    const { scenes, stats } = reconcileSceneTags(
      [makeScene('She pockets the CORAL_LIPSTICK and walks on.')],
      { characterBible: [], locationBible: [], elementBible }
    );
    expect(scenes[0]?.continuity.elementTags).toEqual(['CORAL_LIPSTICK']);
    expect(stats.assignedElementTags).toBe(1);
  });

  it('assigns an element when the script names it in prose, not as the token', () => {
    const { scenes } = reconcileSceneTags(
      [makeScene('A slim coral lipstick tube tumbles after them.')],
      { characterBible: [], locationBible: [], elementBible }
    );
    expect(scenes[0]?.continuity.elementTags).toEqual(['CORAL_LIPSTICK']);
  });

  it('keeps elementTags null when no token appears', () => {
    const { scenes } = reconcileSceneTags(
      [makeScene('She walks on. Nothing in her hands.')],
      { characterBible: [], locationBible: [], elementBible }
    );
    expect(scenes[0]?.continuity.elementTags).toBeNull();
  });

  it('inherits character and element tags onto a nameless continuation slice', () => {
    const { scenes } = reconcileSceneTags(
      [
        makeScene('JACK pockets the coral lipstick and walks on.'),
        makeScene('She leans into the wing mirror.'),
      ],
      { characterBible, locationBible: [], elementBible }
    );
    expect(scenes[0]?.continuity.characterTags).toEqual([
      'jack_denim_weathered',
    ]);
    expect(scenes[0]?.continuity.elementTags).toEqual(['CORAL_LIPSTICK']);
    expect(scenes[1]?.continuity.characterTags).toEqual([
      'jack_denim_weathered',
    ]);
    expect(scenes[1]?.continuity.elementTags).toEqual(['CORAL_LIPSTICK']);
  });
});
