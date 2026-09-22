import { describe, expect, it } from 'vitest';
import { supportsDraftMode } from '@/models/models';
import { draftTaskUsable } from './draft-mode';

const DAY = 24 * 60 * 60 * 1000;

describe('draftTaskUsable', () => {
  const now = Date.UTC(2026, 8, 23);

  it('is usable inside the seven-day window', () => {
    expect(draftTaskUsable(now - 6 * DAY, now)).toBe(true);
    expect(draftTaskUsable(new Date(now - 1000), now)).toBe(true);
  });

  it('expires at seven days', () => {
    expect(draftTaskUsable(now - 7 * DAY, now)).toBe(false);
    expect(draftTaskUsable(new Date(now - 8 * DAY).toISOString(), now)).toBe(
      false
    );
  });
});

describe('supportsDraftMode', () => {
  it('is Seedance 2.5 only — fal has no draft flag and 2.0 has no draft mode', () => {
    expect(supportsDraftMode('seedance_v2_5')).toBe(true);
    expect(supportsDraftMode('seedance_v2')).toBe(false);
    expect(supportsDraftMode('seedance_v2_mini')).toBe(false);
    expect(supportsDraftMode('grok_imagine_video_1_5')).toBe(false);
  });
});
