import { describe, expect, it } from 'vitest';
import {
  talentSheetUrl,
  talentSquareImageClassName,
  talentSquarePreview,
} from './talent-preview';

const SHEET = '/r2/talent/sheet.png';
const HEADSHOT = '/r2/talent/headshot.png';

describe('talentSheetUrl', () => {
  it('prefers the default convergent sheet over other sheets', () => {
    expect(
      talentSheetUrl({
        sheets: [
          { imageUrl: '/r2/other.png', isDefault: false, divergedAt: null },
          { imageUrl: SHEET, isDefault: true, divergedAt: null },
        ],
      })
    ).toBe(SHEET);
  });

  it('skips a divergent default sheet', () => {
    expect(
      talentSheetUrl({
        defaultSheet: { imageUrl: SHEET, divergedAt: new Date() },
        sheets: [
          { imageUrl: '/r2/ok.png', isDefault: false, divergedAt: null },
        ],
      })
    ).toBe('/r2/ok.png');
  });
});

describe('talentSquarePreview', () => {
  it('uses a dedicated headshot when it is not the sheet', () => {
    expect(
      talentSquarePreview({
        imageUrl: HEADSHOT,
        defaultSheet: { imageUrl: SHEET, divergedAt: null },
      })
    ).toEqual({ url: HEADSHOT, isSheet: false });
  });

  it('treats imageUrl as a sheet when it is the same url (save-to-library stamp)', () => {
    expect(
      talentSquarePreview({
        imageUrl: SHEET,
        defaultSheet: { imageUrl: SHEET, divergedAt: null },
      })
    ).toEqual({ url: SHEET, isSheet: true });
  });

  it('falls back to the sheet when there is no headshot', () => {
    expect(
      talentSquarePreview({
        imageUrl: null,
        defaultSheet: { imageUrl: SHEET, divergedAt: null },
      })
    ).toEqual({ url: SHEET, isSheet: true });
  });

  it('uses a headshot with no sheet as a portrait, not a grid', () => {
    expect(talentSquarePreview({ imageUrl: HEADSHOT })).toEqual({
      url: HEADSHOT,
      isSheet: false,
    });
  });
});

describe('talentSquareImageClassName', () => {
  it('aims a sheet at panel 2 (1/3, not the panel centre) and a headshot at the top', () => {
    expect(talentSquareImageClassName(true)).toContain('object-[33.333%_top]');
    expect(talentSquareImageClassName(true)).not.toContain('37.5%');
    expect(talentSquareImageClassName(false)).toContain('object-top');
    expect(talentSquareImageClassName(false)).not.toContain('33.333%');
  });
});
