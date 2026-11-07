/**
 * A recorded ElevenLabs 429 or 5xx (#2295). It was transient when recorded,
 * but replay answers it on every call, so the run retries it forever. Other
 * 4xx stay: the tape relies on recorded ones like `voice_limit_reached`.
 */
export function isTransientElevenLabsRecording(fixture: unknown): boolean {
  if (!fixture || typeof fixture !== 'object') return false;
  if (!('match' in fixture) || !('response' in fixture)) return false;
  const { match, response } = fixture;
  if (!match || typeof match !== 'object' || !('endpoint' in match)) {
    return false;
  }
  if (
    typeof match.endpoint !== 'string' ||
    !match.endpoint.startsWith('elevenlabs')
  ) {
    return false;
  }
  if (!response || typeof response !== 'object' || !('status' in response)) {
    return false;
  }
  const { status } = response;
  return typeof status === 'number' && (status === 429 || status >= 500);
}
