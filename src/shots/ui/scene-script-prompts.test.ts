/**
 * Inspector tab default vs sticky pick (#1624).
 *
 * Cast is the sequence default, but it is not an explicit pick — opening a
 * shot with no facet must land on Video, not keep Cast.
 */

import { describe, expect, it } from 'vitest';
import { effectiveTabFor, tabsForScope } from './scene-script-prompts';

describe('effectiveTabFor', () => {
  it('defaults to the first tab of the current scope when nothing is picked', () => {
    expect(effectiveTabFor('sequence', undefined)).toBe('cast');
    expect(effectiveTabFor('scenes', undefined)).toBe('script');
    expect(effectiveTabFor('shot', undefined)).toBe('shot');
  });

  it('keeps an explicit pick that the new scope still offers', () => {
    expect(effectiveTabFor('shot', 'cast')).toBe('cast');
    expect(effectiveTabFor('shot', 'location')).toBe('location');
    expect(effectiveTabFor('sequence', 'elements')).toBe('elements');
  });

  it('falls back when the pick is not offered at the new scope', () => {
    expect(effectiveTabFor('shot', 'music')).toBe('shot');
    expect(effectiveTabFor('shot', 'script')).toBe('shot');
    expect(effectiveTabFor('sequence', 'motion-prompt')).toBe('cast');
    expect(effectiveTabFor('scenes', 'motion-prompt')).toBe('script');
  });

  it('orders shot tabs the way a clip is made (#2350)', () => {
    expect(tabsForScope('shot').map((t) => t.label)).toEqual([
      'Shot',
      'Image',
      'Video',
      'Cast',
      'Locations',
      'Elements',
    ]);
  });
});
