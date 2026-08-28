import { describe, expect, test } from 'vitest';
import { sceneAnalysisExample } from './scene-analysis.example';
import { sceneAnalysisSchema } from './scene-analysis.schema';

describe('Scene Analysis Schema Validation', () => {
  test('example data conforms to schema', () => {
    const result = sceneAnalysisSchema.safeParse(sceneAnalysisExample);

    if (!result.success) {
      console.error(
        'Validation errors:',
        JSON.stringify(result.error.format(), null, 2)
      );
    }

    expect(result.success).toBe(true);
  });

  test('example has correct structure', () => {
    expect(sceneAnalysisExample.scenes).toHaveLength(1);
    expect(sceneAnalysisExample.characterBible).toHaveLength(1);
    expect(sceneAnalysisExample.projectMetadata).toBeDefined();
  });

  test('scenes have required fields', () => {
    for (const scene of sceneAnalysisExample.scenes) {
      expect(scene.sceneId).toBeDefined();
      expect(scene.sceneNumber).toBeGreaterThan(0);
      expect(scene.originalScript).toBeDefined();
      expect(scene.metadata).toBeDefined();
      // `prompts` was removed from the Scene shape (#713): visual prompts live
      // in frame_prompt_versions, motion prompts in shot_prompt_versions.
    }
  });

  test('character bible entries have required fields', () => {
    for (const character of sceneAnalysisExample.characterBible) {
      expect(character.characterId).toBeDefined();
      expect(character.name).toBeDefined();
      expect(character.physicalDescription).toBeDefined();
      expect(character.standardClothing).toBeDefined();
      expect(character.consistencyTag).toBeDefined();
    }
  });
});
