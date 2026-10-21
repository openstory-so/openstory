/**
 * `Content-Range` for an R2 object served as 206.
 *
 * `enable_fast_jsg_struct` (compatibility date 2025-12-03) puts every optional
 * field on the range struct, set to `undefined`. A suffix read is the one
 * whose `suffix` is a number. `"suffix" in range` is true for an offset read
 * too, and that produced `bytes NaN-NaN/…`, which the browser reports as
 * `MEDIA_ELEMENT_ERROR: Format error`.
 */
export function contentRangeHeader(
  range: { offset?: number; length?: number; suffix?: number },
  size: number
): string {
  if (typeof range.suffix === 'number') {
    const start = size - range.suffix;
    return `bytes ${start}-${size - 1}/${size}`;
  }
  const offset = typeof range.offset === 'number' ? range.offset : 0;
  const length =
    typeof range.length === 'number' ? range.length : size - offset;
  return `bytes ${offset}-${offset + length - 1}/${size}`;
}
