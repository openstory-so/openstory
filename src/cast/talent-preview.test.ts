import { describe, expect, it } from 'vitest';
import {
  isTalentPreparing,
  talentSheetUrl,
  talentSquareImageClassName,
  talentSquarePreview,
} from './talent-preview';

const SHEET = '/r2/talent/sheet.png';
const HEADSHOT = '/r2/talent/headshot.png';

describe('talentSheetUrl', () => {
  it('is the reference sheet, and nothing when there is none (#2018)', () => {
    expect(talentSheetUrl({ referenceSheet: { imageUrl: SHEET } })).toBe(SHEET);
    expect(talentSheetUrl({ referenceSheet: null })).toBeNull();
    expect(talentSheetUrl({})).toBeNull();
  });
});

describe('talentSquarePreview', () => {
  it('uses a dedicated headshot when it is not the sheet', () => {
    expect(
      talentSquarePreview({
        imageUrl: HEADSHOT,
        referenceSheet: { imageUrl: SHEET },
      })
    ).toEqual({ url: HEADSHOT, isSheet: false });
  });

  it('treats imageUrl as a sheet when it is the same url (save-to-library stamp)', () => {
    expect(
      talentSquarePreview({
        imageUrl: SHEET,
        referenceSheet: { imageUrl: SHEET },
      })
    ).toEqual({ url: SHEET, isSheet: true });
  });

  it('falls back to the sheet when there is no headshot', () => {
    expect(
      talentSquarePreview({
        imageUrl: null,
        referenceSheet: { imageUrl: SHEET },
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

describe('isTalentPreparing', () => {
  it('is preparing only with no reference sheet AND a held sheet claim (#2018)', () => {
    expect(
      isTalentPreparing({ referenceSheet: null, pendingPromoteSheetId: 'run' })
    ).toBe(true);
    expect(
      isTalentPreparing({ referenceSheet: null, pendingPromoteSheetId: null })
    ).toBe(false);
    expect(
      isTalentPreparing({
        referenceSheet: { imageUrl: SHEET },
        pendingPromoteSheetId: 'run',
      })
    ).toBe(false);
  });
});
