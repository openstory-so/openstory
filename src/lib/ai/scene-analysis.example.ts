import type { SceneAnalysis } from './scene-analysis.schema';

export const sceneAnalysisExample: SceneAnalysis = {
  projectMetadata: {
    title: "Project title from script or 'Untitled'",
  },

  characterBible: [
    {
      characterId: 'char_001',
      name: 'Character Name',
      age: 'age',
      gender: 'gender',
      ethnicity: 'ethnicity',
      physicalDescription: 'Complete physical description for prompts',
      standardClothing: 'Complete clothing description for prompts',
      distinguishingFeatures: 'Unique identifiers',
      consistencyTag: 'Short tag for continuity',
    },
  ],

  locationBible: [
    {
      locationId: 'loc_001',
      name: 'INT. OFFICE - DAY',
      type: 'interior',
      timeOfDay: 'day',
      description: 'Complete visual description of the location',
      architecturalStyle: 'Modern minimalist',
      keyFeatures: 'Large windows, exposed brick, vintage furniture',
      colorPalette: 'Cool blues, steel grays, warm wood accents',
      lightingSetup: 'Harsh overhead fluorescent',
      ambiance: 'Tense corporate',
      consistencyTag: 'office_modern_steel',
      firstMention: {
        text: 'INT. OFFICE - DAY',
        lineNumber: 1,
      },
    },
  ],

  scenes: [
    {
      sceneId: 'scene_001',
      sceneNumber: 1,

      originalScript: {
        extract: "Exact text from user's original script for this scene",
        dialogue: [
          {
            character: 'CHARACTER NAME or null if unknown',
            line: 'Exact dialogue text from user script',
            tone: '',
          },
        ],
      },

      metadata: {
        title: 'Scene Title',
        durationSeconds: 6,
        location: 'Specific location',
        timeOfDay: 'Exact time',
        storyBeat: 'What happens narratively',
      },

      // `prompts` removed from the Scene shape (#713): visual prompts live in
      // `frame_prompt_versions`, motion prompts in `shot_prompt_versions`.

      musicDesign: {
        presence: 'none',
        style: 'Genre if present',
        mood: 'Emotional quality if present',
        atmosphere: 'Overall sonic environment',
      },

      continuity: {
        characterTags: ['Character: consistency description'],
        environmentTag: 'Environment consistency description',
        colorPalette: 'Color palette description',
        lightingSetup: 'Lighting consistency notes',
        styleTag: 'Style consistency notes',
      },

      sourceImageUrl: 'https://example.com/image.jpg',
    },
  ],
};
