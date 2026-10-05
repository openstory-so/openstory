import { describe, expect, it } from 'vitest';
import {
  explainSeedanceFailure,
  isSeedanceInternalServiceError,
  seedance25FollowsInputVideo,
  seedanceEditLengthMessage,
} from './seedance-edit';

describe('seedance edit constraints (#2036)', () => {
  it('treats a Seedance 2.5 video as an edit and leaves 2.0 alone', () => {
    expect(seedance25FollowsInputVideo('seedance_v2_5', true)).toBe(true);
    expect(seedance25FollowsInputVideo('seedance_v2_5', false)).toBe(false);
    expect(seedance25FollowsInputVideo('seedance_v2', true)).toBe(false);
  });

  it('names a known length outside 4–30s and stays quiet otherwise', () => {
    expect(seedanceEditLengthMessage(3)).toBe(
      'Seedance can only edit a video between 4 and 30 seconds. This one is 3s.'
    );
    expect(seedanceEditLengthMessage(31)).toMatch(/31s\.$/);
    expect(seedanceEditLengthMessage(4)).toBeNull();
    expect(seedanceEditLengthMessage(30)).toBeNull();
    expect(seedanceEditLengthMessage(null)).toBeNull();
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
        'BytePlus Ark studio motion submit failed (400 InvalidParameter.TaskTypeConstraint): duration must be -1'
      )
    ).toBe(
      "Seedance couldn't process this edit because the clip has to be between 4 and 30 seconds, and the length has to follow the clip. The credits for this generation were refunded."
    );
    expect(
      explainSeedanceFailure('Motion generation failed: InternalServiceError', {
        via: 'byteplus',
      })
    ).toBe(
      "Seedance couldn't process this video because of a temporary error. We tried again once and it failed again. The credits for this generation were refunded."
    );
    expect(
      explainSeedanceFailure('Motion generation failed: Kling exploded', {
        via: 'fal',
      })
    ).toBeNull();
    expect(
      explainSeedanceFailure(
        'Seedance blocked an image that may show a real person. Swap or regenerate it.',
        { via: 'byteplus' }
      )
    ).toBeNull();
  });
});
