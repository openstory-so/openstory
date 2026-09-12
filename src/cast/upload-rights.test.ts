import { describe, expect, it } from 'vitest';
import { getPublicAssetsDomain } from '@/platform/public-assets';
import { needsLikenessCheck } from './upload-rights';

describe('needsLikenessCheck', () => {
  it('gates raw URLs and unsaved uploads', () => {
    expect(needsLikenessCheck('https://example.com/anyone.jpg')).toBe(true);
    expect(needsLikenessCheck('http://example.com/anyone.jpg')).toBe(true);
    expect(needsLikenessCheck('/r2/talent/team1/temp/01A.png')).toBe(true);
    expect(needsLikenessCheck('/r2/locations/team1/temp/01A.png')).toBe(true);
    expect(needsLikenessCheck('/r2/elements/team1/uploads/01A.png')).toBe(true);
  });

  it('exempts library rows, generated stills, and our assets domain', () => {
    expect(needsLikenessCheck('/r2/talent/team1/tal1/a.png')).toBe(false);
    expect(needsLikenessCheck('/r2/locations/team1/library/a.png')).toBe(false);
    expect(needsLikenessCheck('/r2/elements/team1/seq1/a.png')).toBe(false);
    expect(
      needsLikenessCheck('/r2/thumbnails/teams/t/studio/a/image.png')
    ).toBe(false);
    expect(
      needsLikenessCheck(
        `https://${getPublicAssetsDomain()}/talent/ava/sheet.webp`
      )
    ).toBe(false);
  });
});
