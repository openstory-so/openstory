/**
 * The two motion-prompt templates are a fork on one load-bearing rule, so the
 * contract worth pinning is that they disagree in the right direction.
 *
 * Image-to-video tells the LLM NOT to describe static detail — the video model
 * already sees it in the rendered still. Reference-only has no still, so the
 * same instruction would leave the set, the light and the framing for the
 * model to invent fresh on every shot. If a future edit copies one template's
 * rule into the other, these tests are what notices.
 */

import { describe, expect, it } from 'vitest';
import { getChatPrompt } from './index';

const IMAGE_TO_VIDEO = 'phase/motion-prompt-scene-generation-chat';
const REFERENCE_ONLY = 'phase/motion-prompt-reference-only-chat';

async function render(name: string) {
  const { messages } = await getChatPrompt(name, {
    startingFrameNote: 'NOTE',
    scene: '{"sceneId":"sc-1"}',
    sceneBefore: '(none)',
    sceneAfter: '(none)',
    characterBible: '[CHARACTERS]',
    locationBible: '[LOCATIONS]',
    elementBible: '[ELEMENTS]',
    styleConfig: '{}',
    aspectRatio: '16:9',
  });
  const system = messages.find((m) => m.role === 'system');
  const user = messages.find((m) => m.role === 'user');
  return {
    system: typeof system?.content === 'string' ? system.content : '',
    user: typeof user?.content === 'string' ? user.content : '',
  };
}

describe('motion prompt templates', () => {
  it('inverts the visual-redundancy rule for reference-only', async () => {
    const i2v = await render(IMAGE_TO_VIDEO);
    const refOnly = await render(REFERENCE_ONLY);

    expect(i2v.system).toContain('NO VISUAL REDUNDANCY');
    expect(refOnly.system).not.toContain('NO VISUAL REDUNDANCY');
    // Reference-only must ask for the still's job: framing, set, and light.
    expect(refOnly.system).toContain('SHOT SIZE AND LENS FEEL');
    expect(refOnly.system).toContain('THE SET');
    expect(refOnly.system).toContain('LIGHT');
  });

  it('still refuses to let reference-only describe identity', async () => {
    const { system } = await render(REFERENCE_ONLY);

    // The sheets carry identity; prose describing the same person competes
    // with them and drifts the likeness.
    expect(system).toContain('DESCRIBE THE SHOT, NEVER THE PEOPLE');
    expect(system).toMatch(/[Nn]ever write a character's face/);
  });

  it('gives reference-only the location and element bibles', async () => {
    const i2v = await render(IMAGE_TO_VIDEO);
    const refOnly = await render(REFERENCE_ONLY);

    expect(refOnly.user).toContain('[LOCATIONS]');
    expect(refOnly.user).toContain('[ELEMENTS]');
    // The image-to-video template interpolates neither — survivable there,
    // since the still already resolved the set.
    expect(i2v.user).not.toContain('[LOCATIONS]');
  });

  it('keeps the shared motion discipline in both', async () => {
    for (const name of [IMAGE_TO_VIDEO, REFERENCE_ONLY]) {
      const { system } = await render(name);
      expect(system).toContain('EXACTLY ONE PER SHOT');
      expect(system).toContain('NO MUSIC');
      expect(system).toMatch(/DIALOGUE EXTRACTION/);
    }
  });

  it('gives reference-only a bigger budget, since it does two jobs', async () => {
    const i2v = await render(IMAGE_TO_VIDEO);
    const refOnly = await render(REFERENCE_ONLY);

    expect(i2v.system).toContain('under 2000 characters');
    expect(refOnly.system).toContain('under 2500 characters');
  });
});
