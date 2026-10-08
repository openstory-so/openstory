/**
 * Square-tile preview for a talent.
 *
 * Generated sheets are a 4-panel landscape grid (front, close-up, side, rear).
 * A dedicated headshot (`talent.imageUrl`) is the close-up panel, cropped by
 * `cropTalentSheetPortrait`. Save-to-library used to stamp the full sheet onto
 * `imageUrl`, so a url that still equals the sheet is treated as a sheet.
 */

type SheetLike = {
  imageUrl?: string | null;
};

export type TalentPreviewInput = {
  imageUrl?: string | null;
  /** The reference sheet (#2018): the row `talent.selectedSheetId` names. */
  referenceSheet?: SheetLike | null;
};

/** The reference sheet's url; a talent with no sheet yet has none. */
export function talentSheetUrl(talent: TalentPreviewInput): string | null {
  return talent.referenceSheet?.imageUrl ?? null;
}

/**
 * A talent whose face is still being made (#2018): no reference sheet yet,
 * and a sheet run holds the claim — Save face as talent, or a first Generate.
 * The picker shows it as preparing and a recast refuses it, so nobody casts
 * a face that is not there yet by description alone.
 */
export function isTalentPreparing(talent: {
  referenceSheet: SheetLike | null;
  pendingPromoteSheetId: string | null;
}): boolean {
  return !talent.referenceSheet && talent.pendingPromoteSheetId !== null;
}

export type TalentSquarePreview = {
  url: string | null;
  /** True when `url` is the 4-panel sheet — square tiles must crop to panel 2. */
  isSheet: boolean;
};

export function talentSquarePreview(
  talent: TalentPreviewInput
): TalentSquarePreview {
  const sheetUrl = talentSheetUrl(talent);
  const headshot = talent.imageUrl ?? null;
  if (headshot && headshot !== sheetUrl) {
    return { url: headshot, isSheet: false };
  }
  const url = headshot ?? sheetUrl;
  return { url, isSheet: url !== null && url === sheetUrl };
}

/**
 * A sheet is four panels side by side; panel 2 is the close-up. The image
 * is laid out four boxes wide and slid one box left, so the box (which must
 * clip: `overflow-hidden`) shows panel 2 and nothing of its neighbours,
 * whatever the sheet's shape:
 *
 * - 4:1 (talent sheets): the whole of panel 2.
 * - 16:9 (character sheets): each panel is taller than wide, so the panel
 *   fills the width and `object-top` keeps its top 44%, the head and
 *   shoulders.
 *
 * `origin` is panel 2's centre, so a hover zoom stays on it.
 */
const TALENT_SHEET_SQUARE_IMAGE_CLASS =
  'block h-full w-[400%] max-w-none -translate-x-1/4 origin-[37.5%_center] object-cover object-top';

/** Dedicated headshot — object-top so a tall copied portrait is not centre-cropped. */
const TALENT_HEADSHOT_SQUARE_IMAGE_CLASS =
  'h-full w-full object-cover object-top';

export function talentSquareImageClassName(isSheet: boolean): string {
  return isSheet
    ? TALENT_SHEET_SQUARE_IMAGE_CLASS
    : TALENT_HEADSHOT_SQUARE_IMAGE_CLASS;
}
