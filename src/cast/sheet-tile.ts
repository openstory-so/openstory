/**
 * Square-tile crop for a character sheet.
 *
 * A sheet is four panels side by side; panel 2 is the close-up. The image
 * is laid out four boxes wide and slid one box left, so the box (which must
 * clip: `overflow-hidden`) shows panel 2. `origin` is panel 2's centre, so
 * a hover zoom stays on it. A dedicated portrait uses object-top so a tall
 * image is not centre-cropped.
 */
const SHEET_SQUARE_IMAGE_CLASS =
  'block h-full w-[400%] max-w-none -translate-x-1/4 origin-[37.5%_center] object-cover object-top';

const PORTRAIT_SQUARE_IMAGE_CLASS = 'h-full w-full object-cover object-top';

export function sheetSquareImageClassName(isSheet: boolean): string {
  return isSheet ? SHEET_SQUARE_IMAGE_CLASS : PORTRAIT_SQUARE_IMAGE_CLASS;
}
