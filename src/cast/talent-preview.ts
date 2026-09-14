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
  isDefault?: boolean | null;
  divergedAt?: Date | string | null;
};

export type TalentPreviewInput = {
  imageUrl?: string | null;
  defaultSheet?: SheetLike | null;
  sheets?: readonly SheetLike[] | null;
};

function sheetUrlIfConvergent(
  sheet: SheetLike | null | undefined
): string | null {
  if (!sheet || sheet.divergedAt) return null;
  return sheet.imageUrl ?? null;
}

/** Default / first convergent sheet url. Divergent rows are not an identity. */
export function talentSheetUrl(talent: TalentPreviewInput): string | null {
  const fromDefault = sheetUrlIfConvergent(talent.defaultSheet);
  if (fromDefault) return fromDefault;
  const sheets = talent.sheets ?? [];
  const preferred =
    sheets.find((s) => s.isDefault && !s.divergedAt) ??
    sheets.find((s) => !s.divergedAt);
  return preferred?.imageUrl ?? null;
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
 * 4-panel sheets are landscape. In a square tile, pin to panel 2 (close-up):
 * columns sit at 0/25/50/75%, so panel 2's centre is 37.5% from the left,
 * and the close-up is composed from the top of that column.
 */
const TALENT_SHEET_SQUARE_IMAGE_CLASS =
  'h-full w-full object-cover object-[37.5%_top]';

/** Dedicated headshot — object-top so a tall copied portrait is not centre-cropped. */
const TALENT_HEADSHOT_SQUARE_IMAGE_CLASS =
  'h-full w-full object-cover object-top';

export function talentSquareImageClassName(isSheet: boolean): string {
  return isSheet
    ? TALENT_SHEET_SQUARE_IMAGE_CLASS
    : TALENT_HEADSHOT_SQUARE_IMAGE_CLASS;
}
