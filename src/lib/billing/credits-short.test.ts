import { describe, expect, it } from 'vitest';
import { micros } from '@/lib/billing/money';
import {
  CREDITS_SHORT_TITLE,
  creditsShortHint,
  creditsShortStatusError,
  isCreditsShortError,
} from './credits-short';

describe('isCreditsShortError', () => {
  it('matches the persisted reservation-short statusError', () => {
    expect(
      isCreditsShortError(
        'Not enough credits to generate images for 11 scenes. Add credits and retry.'
      )
    ).toBe(true);
  });

  it('matches when a child-workflow prefix wraps the statusError', () => {
    expect(
      isCreditsShortError(
        'Child workflow analyze-script:1 failed: Not enough credits to generate images for 11 scenes. Add $4.20 more, then continue.'
      )
    ).toBe(true);
  });

  it('matches Error instances', () => {
    expect(
      isCreditsShortError(
        new Error(
          'Not enough credits to generate images for 3 scenes. Add credits, then continue.'
        )
      )
    ).toBe(true);
  });

  it('does not match unrelated failures', () => {
    expect(isCreditsShortError('Generation was interrupted')).toBe(false);
    expect(isCreditsShortError('Blocked by the content checker')).toBe(false);
    expect(isCreditsShortError(undefined)).toBe(false);
  });
});

describe('creditsShortStatusError', () => {
  it('names the scene count and how much more is needed', () => {
    expect(
      creditsShortStatusError({
        sceneCount: 11,
        neededMicros: micros(4_200_000),
      })
    ).toBe(
      'Not enough credits to generate images for 11 scenes. Add $4.20 more, then continue.'
    );
  });

  it('omits a $0.00 shortfall', () => {
    expect(
      creditsShortStatusError({
        sceneCount: 4,
        neededMicros: micros(0),
      })
    ).toBe(
      'Not enough credits to generate images for 4 scenes. Add credits, then continue.'
    );
  });
});

describe('creditsShortHint', () => {
  it('uses scene count and amount from the stored message', () => {
    expect(
      creditsShortHint(
        creditsShortStatusError({
          sceneCount: 11,
          neededMicros: micros(4_200_000),
        })
      )
    ).toBe(
      'This sequence has 11 scenes — more than the first estimate. Add $4.20 more, then continue generation.'
    );
  });

  it('still reads the pre-#1328 copy', () => {
    expect(
      creditsShortHint(
        'Not enough credits to generate images for 11 scenes. Add credits and retry.'
      )
    ).toBe(
      'This sequence has 11 scenes — more than the first estimate. Add credits, then continue generation.'
    );
  });

  it('falls back when the message has no scene count', () => {
    expect(creditsShortHint('Not enough credits to generate images.')).toBe(
      'Scene split found more work than the first estimate. Add credits, then continue generation.'
    );
  });
});

describe('CREDITS_SHORT_TITLE', () => {
  it('is a top-up prompt, not a failure', () => {
    expect(CREDITS_SHORT_TITLE).toBe('Add credits to continue');
    expect(CREDITS_SHORT_TITLE.toLowerCase()).not.toContain('fail');
  });
});
