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
  it('lays a sheet out four boxes wide and slides panel 2 into the box; a headshot fills it from the top', () => {
    const sheet = talentSquareImageClassName(true).split(' ');
    expect(sheet).toEqual(
      expect.arrayContaining(['w-[400%]', 'max-w-none', '-translate-x-1/4'])
    );
    expect(sheet).not.toContain('w-full');
    const headshot = talentSquareImageClassName(false).split(' ');
    expect(headshot).toEqual(expect.arrayContaining(['w-full', 'object-top']));
    expect(headshot).not.toContain('w-[400%]');
  });
});
