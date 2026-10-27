import { describe, expect, it } from 'vitest';
import {
  explainSeedanceFailure,
  isSeedanceInternalServiceError,
  arkSendsSeedanceEdit,
  isSeedanceEdit,
  seedanceEditLengthMessage,
  seedanceEditSeconds,
  seedanceUserFacingError,
} from './seedance-edit';

describe('seedance edit constraints (#2036)', () => {
  it('is an edit only for the word plus a video, on Seedance 2.5 via Ark', () => {
    const ask = (over: Partial<Parameters<typeof isSeedanceEdit>[0]> = {}) =>
      isSeedanceEdit({
        model: 'seedance_v2_5',
        onArk: true,
        prompt: 'edit the walk',
        hasInputVideo: true,
        explicitEdit: false,
        ...over,
      });
    expect(ask()).toBe(true);
    expect(ask({ prompt: 'Edit @Video1.' })).toBe(true);
    expect(ask({ prompt: 'please EDIT the clip' })).toBe(true);
    // Whole word only.
    expect(ask({ prompt: 'credits and editorial notes' })).toBe(false);
    expect(ask({ prompt: 'the fox walks' })).toBe(false);
    expect(ask({ prompt: null })).toBe(false);
    expect(ask({ hasInputVideo: false })).toBe(false);
    expect(ask({ model: 'seedance_v2' })).toBe(false);
    // fal never sends an edit.
    expect(ask({ onArk: false })).toBe(false);
    // Studio edit mode needs no word.
    expect(ask({ prompt: 'the fox walks', explicitEdit: true })).toBe(true);
  });

  it('sends the edit only when the hold covers the request as built', () => {
    const sends = (
      held: number | null,
      prompt: string,
      clipSeconds: number[] = [8],
      model = 'seedance_v2_5'
    ) =>
      arkSendsSeedanceEdit(held, {
        model,
        prompt,
        references: clipSeconds.map((durationSeconds) => ({
          kind: 'video',
          durationSeconds,
        })),
      });
    expect(sends(8, 'edit the walk')).toBe(true);
    // Not held: a fixed length goes out, and Ark refuses it unbilled.
    expect(sends(null, 'edit the walk')).toBe(false);
    // Held for a shorter clip than a packed neighbour attached.
    expect(sends(8, 'edit the walk', [8, 28])).toBe(false);
    expect(sends(28, 'edit the walk', [8, 28])).toBe(true);
    // Held, but a rewrite dropped the word: the shot's own length.
    expect(sends(8, 'the fox walks')).toBe(false);
    expect(sends(8, 'edit the walk', [])).toBe(false);
    expect(sends(8, 'edit the walk', [8], 'seedance_v2')).toBe(false);
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
    // Seedance's own 30s clip reads a hair over; that still fits.
    expect(seedanceEditLengthMessage(30.04)).toBeNull();
    expect(seedanceEditLengthMessage(30.21)).toMatch(/30\.3s\.$/);
  });

  it('gives the longest clip an edit will follow, and null otherwise', () => {
    const clip = (durationSeconds: number | null) => ({
      kind: 'video',
      durationSeconds,
    });
    const seconds = (
      prompt: string | null,
      references: object[],
      over: { model?: string; onArk?: boolean } = {}
    ) =>
      seedanceEditSeconds({
        model: 'seedance_v2_5',
        onArk: true,
        prompt,
        references,
        ...over,
      });
    expect(seconds('edit the walk', [clip(24.2)])).toBe(25);
    expect(seconds('edit the walk', [clip(4), clip(12)])).toBe(12);
    // The cap when a length is unknown, or is not a number.
    expect(seconds('edit the walk', [clip(null)])).toBe(30);
    expect(seconds('edit the walk', [clip(Number.NaN)])).toBe(30);
    // Not an edit: no word, no clip, no prompt yet, another model, or fal.
    expect(seconds('the fox walks', [clip(24)])).toBeNull();
    expect(seconds('edit the walk', [{ kind: 'image' }])).toBeNull();
    expect(seconds(null, [clip(24)])).toBeNull();
    expect(
      seconds('edit the walk', [clip(24)], { model: 'seedance_v2' })
    ).toBeNull();
    expect(seconds('edit the walk', [clip(24)], { onArk: false })).toBeNull();
  });

  it('shows whole only the sentences this module writes', () => {
    expect(
      seedanceUserFacingError(
        "Seedance couldn't process this video. You were not charged for this video."
      )
    ).toMatch(/^Seedance couldn't/);
    expect(
      seedanceUserFacingError(
        'Seedance 2.5 refused this prompt for its length: raw provider text'
      )
    ).toBeNull();
    expect(seedanceUserFacingError(null)).toBeNull();
    expect(
      seedanceUserFacingError(
        "This video couldn't start. You weren't charged. Try again."
      )
    ).toMatch(/^This video couldn't start/);
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
      'Seedance read this as a video edit and refused it. Say "edit" in the prompt and use a clip between 4 and 30 seconds. You were not charged for this video.'
    );
    expect(
      explainSeedanceFailure(
        'BytePlus Ark motion submit failed (400 InvalidParameter): bad ratio',
        'byteplus'
      )
    ).toBe(
      "Seedance couldn't process this video. bad ratio. You were not charged for this video."
    );
    // The via decides, not the words in the message.
    expect(explainSeedanceFailure('InvalidParameter: nope', 'fal')).toBeNull();
    expect(
      explainSeedanceFailure(
        'Motion generation failed: InternalServiceError',
        'byteplus'
      )
    ).toBe(
      "Seedance couldn't process this video because of a temporary error. Try again. You were not charged for this video."
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
    expect(
      explainSeedanceFailure(
        'BytePlus OpenAPI CreateAsset failed (QuotaSharedPoolExceeded): Asset quota exceeded: the shared pool for projects without explicit allocation is full.',
        'byteplus'
      )
    ).toBe(
      "Our video provider is busy right now. You weren't charged. Try again in a few minutes."
    );
    expect(
      explainSeedanceFailure(
        'BytePlus asset asset-20261020163722-7plhr failed processing (/r2/b.png)',
        'byteplus',
        { images: ['/r2/a.png', '/r2/b.png'] }
      )
    ).toBe("@Image2 couldn't be processed. You weren't charged.");
    // Ark's reason on the refused asset reaches the user (#2207).
    expect(
      explainSeedanceFailure(
        'BytePlus asset asset-20261027052714-lsg7b failed processing (InputVideoSensitiveContentDetected.PolicyViolation): The request failed because the input video may be related to copyright restrictions. (/r2/clip.mp4)',
        'byteplus',
        { images: ['/r2/a.png'], videos: ['/r2/clip.mp4'] }
      )
    ).toBe("@Video1 was refused: it may be copyrighted. You weren't charged.");
    expect(
      explainSeedanceFailure(
        'BytePlus asset asset-1 failed processing (SomethingElse): The input image is too blurry (/r2/b.png)',
        'byteplus',
        { images: ['/r2/a.png', '/r2/b.png'] }
      )
    ).toBe(
      "@Image2 couldn't be processed: The input image is too blurry. You weren't charged."
    );
    expect(
      explainSeedanceFailure(
        'BytePlus OpenAPI CreateAsset failed (InvalidParameter.DurationTooLong): Duration must be between 1.8s and 30.2s (/r2/clip.mp4)',
        'byteplus',
        { images: ['/r2/a.png'], videos: ['/r2/clip.mp4'] }
      )
    ).toBe(
      "@Video1 couldn't be used. Duration must be between 1.8s and 30.2s. You were not charged for this video."
    );
    // A sequence shot asks with no references: the stored url still never shows.
    expect(
      explainSeedanceFailure(
        'BytePlus OpenAPI CreateAsset failed (InvalidParameter.DurationTooLong): Duration must be between 1.8s and 30.2s (/r2/clip.mp4)',
        'byteplus'
      )
    ).toBe(
      "Seedance couldn't process this video. Duration must be between 1.8s and 30.2s. You were not charged for this video."
    );
    expect(
      explainSeedanceFailure(
        'BytePlus asset asset-20261020163722-7plhr failed processing',
        'byteplus'
      )
    ).toBe(
      "One of your reference images couldn't be processed. You weren't charged."
    );
    expect(
      explainSeedanceFailure(
        "Our video provider is busy right now. You weren't charged. Try again in a few minutes.",
        'byteplus'
      )
    ).toBe(
      "Our video provider is busy right now. You weren't charged. Try again in a few minutes."
    );
  });
});
