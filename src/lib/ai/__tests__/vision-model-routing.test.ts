import { describe, expect, it } from 'vitest';
import {
  analysisModelSupportsVision,
  DEFAULT_VISION_MODEL,
  resolveVisionModel,
} from '../models.config';

// Text-only analysis models can't see the rendered still the motion-prompt pass
// conditions on (#929), so an image-bearing call on one routes to
// DEFAULT_VISION_MODEL. GLM-4.6V was tried as GLM-5.2's companion (#942) but
// couldn't do strict structured outputs, so we fell back to the default (#944).
// GLM-5.3 Flash can (#1367), so it runs its own image calls.
describe('vision-model routing', () => {
  it('routes a text-only model with an image to DEFAULT_VISION_MODEL', () => {
    expect(analysisModelSupportsVision('deepseek/deepseek-v3.2')).toBe(false);
    expect(resolveVisionModel('deepseek/deepseek-v3.2', true)).toBe(
      DEFAULT_VISION_MODEL
    );
  });

  it('leaves a text-only model unchanged when there is no image', () => {
    expect(resolveVisionModel('deepseek/deepseek-v3.2', false)).toBe(
      'deepseek/deepseek-v3.2'
    );
  });

  it('leaves a vision-capable model unchanged even with an image', () => {
    expect(resolveVisionModel('x-ai/grok-4.6', true)).toBe('x-ai/grok-4.6');
  });

  // The fallback target must itself accept images, or routing to it is pointless.
  it('DEFAULT_VISION_MODEL is itself vision-capable', () => {
    expect(analysisModelSupportsVision(DEFAULT_VISION_MODEL)).toBe(true);
  });
});
