/**
 * Formats seconds into MM:SS format
 * @param seconds - Number of seconds to format
 * @returns Formatted time string (e.g., "02:45")
 */
export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}
