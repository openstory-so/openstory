/**
 * Resolution order for "does this shot animate from a start frame".
 *
 * Three places must agree: the checkbox, the eligibility filter, and the
 * submit path that either passes the still or does not. A disagreement is
 * expensive — a shot judged eligible but submitted without its still renders
 * as something else at full price.
 */

import { describe, expect, it } from 'vitest';
import {
  canUseStartFrame,
  rendersReferenceOnly,
  usesStartFrame,
} from './use-start-frame';

const IMAGE_SEQ = { generateStartFrames: true };
const REF_ONLY_SEQ = { generateStartFrames: false };

describe('usesStartFrame', () => {
  it('inherits the sequence when the shot has no override', () => {
    expect(usesStartFrame({ useStartFrame: null }, IMAGE_SEQ)).toBe(true);
    expect(usesStartFrame({ useStartFrame: null }, REF_ONLY_SEQ)).toBe(false);
    // Undefined is the same "not set" as null — a Shot read through a partial
    // projection must not silently flip the mode.
    expect(usesStartFrame({}, REF_ONLY_SEQ)).toBe(false);
  });

  it('lets a shot override the sequence in both directions', () => {
    expect(usesStartFrame({ useStartFrame: false }, IMAGE_SEQ)).toBe(false);
    expect(usesStartFrame({ useStartFrame: true }, REF_ONLY_SEQ)).toBe(true);
  });

  it('rendersReferenceOnly is exactly the inverse', () => {
    for (const shot of [
      { useStartFrame: null },
      { useStartFrame: true },
      { useStartFrame: false },
    ]) {
      for (const seq of [IMAGE_SEQ, REF_ONLY_SEQ]) {
        expect(rendersReferenceOnly(shot, seq)).toBe(
          !usesStartFrame(shot, seq)
        );
      }
    }
  });
});

describe('canUseStartFrame', () => {
  it('needs a still to point at', () => {
    expect(canUseStartFrame({ image: { url: 'https://x/still.png' } })).toBe(
      true
    );
    expect(canUseStartFrame({ image: { url: null } })).toBe(false);
    expect(canUseStartFrame({ image: null })).toBe(false);
    expect(canUseStartFrame({})).toBe(false);
  });
});
