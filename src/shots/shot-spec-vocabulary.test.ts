import { describe, expect, it } from 'vitest';
import { WORKFLOW_CHAT_PROMPTS } from '@/platform/server/ai/workflow-prompts';
import {
  CAMERA_ANGLES,
  CAMERA_MOVES,
  SHOT_SIZES,
} from './shot-spec-vocabulary';

describe('shot spec vocabulary', () => {
  it('suggests the lists the shot-list prompt names', () => {
    const prompt = (WORKFLOW_CHAT_PROMPTS['phase/scene-shot-list-chat'] ?? [])
      .map((message) => message.content)
      .join('\n');
    expect(prompt).toContain(`shotSize — one of: ${SHOT_SIZES.join(', ')}.`);
    expect(prompt).toContain(`angle — one of: ${CAMERA_ANGLES.join(', ')}.`);
    expect(prompt).toContain(`Usually one of: ${CAMERA_MOVES.join(', ')}.`);
  });
});
