/**
 * Derive an uppercase token from a filename stem.
 * Strips extension, non-alphanumeric characters, collapses runs to `_`.
 */
export function deriveTokenFromFilename(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, '');
  const cleaned = stem
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'ELEMENT';
}
