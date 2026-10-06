import { describe, expect, it } from 'vitest';
import {
  explainSeedanceFailure,
  isSeedanceInternalServiceError,
  promptRequestsSeedanceEdit,
  seedance25FollowsInputVideo,
  seedanceEditHoldSeconds,
  seedanceEditLengthMessage,
} from './seedance-edit';

describe('seedance edit constraints (#2036)', () => {
  it('follows the clip only when the prompt says edit', () => {
    expect(promptRequestsSeedanceEdit('Edit @Video1.')).toBe(true);
    expect(promptRequestsSeedanceEdit('please EDIT the clip')).toBe(true);
    expect(promptRequestsSeedanceEdit('credits and editorial notes')).toBe(
      false
    );
    expect(
      seedance25FollowsInputVideo('seedance_v2_5', true, 'edit the walk', false)
    ).toBe(true);
    expect(
      seedance25FollowsInputVideo('seedance_v2_5', true, 'the fox walks', false)
    ).toBe(false);
    expect(
      seedance25FollowsInputVideo(
        'seedance_v2_5',
        false,
        'edit the walk',
        false
      )
    ).toBe(false);
    expect(
      seedance25FollowsInputVideo('seedance_v2', true, 'edit the walk', false)
    ).toBe(false);
    expect(
      seedance25FollowsInputVideo('seedance_v2_5', true, 'the fox walks', true)
    ).toBe(true);
  });

  it('names a known length outside 4–30s and stays quiet otherwise', () => {
    expect(seedanceEditLengthMessage(3)).toBe(
      'Seedance can only edit a video between 4 and 30 seconds. This one is 3s.'
    );
    expect(seedanceEditLengthMessage(31)).toMatch(/31s\.$/);
    expect(seedanceEditLengthMessage(4)).toBeNull();
    expect(seedanceEditLengthMessage(30)).toBeNull();
    expect(seedanceEditLengthMessage(null)).toBeNull();
    // Just outside the window never rounds onto the edge.
    expect(seedanceEditLengthMessage(3.99)).toMatch(/3\.9s\.$/);
    expect(seedanceEditLengthMessage(30.01)).toMatch(/30\.1s\.$/);
  });

  it('holds for the clip an edit will follow, and for the shot otherwise', () => {
    const clip = (durationSeconds: number | null) => ({
      kind: 'video',
      durationSeconds,
    });
    const hold = (
      prompt: string | null,
      refs: object[],
      model = 'seedance_v2_5'
    ) => seedanceEditHoldSeconds(model, 5, prompt, refs);
    expect(hold('edit the walk', [clip(24.2)])).toBe(25);
    // Never less than the shot, and the cap when the length is unknown.
    expect(hold('edit the walk', [clip(4)])).toBe(5);
    expect(hold('edit the walk', [clip(null)])).toBe(30);
    // Not an edit: no word, no clip, no prompt yet, or another model.
    expect(hold('the fox walks', [clip(24)])).toBe(5);
    expect(hold('edit the walk', [{ kind: 'image' }])).toBe(5);
    expect(hold(null, [clip(24)])).toBe(5);
    expect(hold('edit the walk', [clip(24)], 'seedance_v2')).toBe(5);
  });

  it('retries InternalServiceError only for a BytePlus job', () => {
    expect(
      isSeedanceInternalServiceError('InternalServiceError: down', 'byteplus')
    ).toBe(true);
    expect(
      isSeedanceInternalServiceError('InternalServiceError: down', 'fal')
    ).toBe(false);
  });

  it('explains Ark failures in plain language and leaves other providers', () => {
    expect(
      explainSeedanceFailure(
        'BytePlus Ark studio motion submit failed (400 InvalidParameter.TaskTypeConstraint): duration must be -1',
        'byteplus'
      )
    ).toBe(
      'Seedance read this as a video edit and refused it. Say "edit" in the prompt and use a clip between 4 and 30 seconds. You were not charged for this generation.'
    );
    expect(
      explainSeedanceFailure(
        'BytePlus Ark motion submit failed (400 InvalidParameter): bad ratio',
        'byteplus'
      )
    ).toBe(
      "Seedance couldn't process this video. bad ratio. You were not charged for this generation."
    );
    // The via decides, not the words in the message.
    expect(explainSeedanceFailure('InvalidParameter: nope', 'fal')).toBeNull();
    expect(
      explainSeedanceFailure(
        'Motion generation failed: InternalServiceError',
        'byteplus'
      )
    ).toBe(
      "Seedance couldn't process this video because of a temporary error. Try again. You were not charged for this generation."
    );
    expect(
      explainSeedanceFailure('Motion generation failed: Kling exploded', 'fal')
    ).toBeNull();
    expect(
      explainSeedanceFailure(
        'Seedance blocked an image that may show a real person. Swap or regenerate it.',
        'byteplus'
      )
    ).toBeNull();
  });
});
