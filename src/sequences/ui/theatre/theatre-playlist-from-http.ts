export function theatrePlaylistFromHttp(
  status: number,
  url: string
): string | null {
  if (status >= 200 && status < 300) return url;
  if (status >= 500) {
    throw new Error(`theatre playlist HTTP ${status}`);
  }
  return null;
}
