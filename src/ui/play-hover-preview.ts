/**
 * Play a muted hover preview. Two rejections are expected and ignored: the
 * mouse leaves and pauses before play() settles (AbortError), or the clip has
 * no playable source (NotSupportedError); the poster stays either way. Any
 * other rejection is rethrown so it still reaches error tracking (#2132).
 */
export function playHoverPreview(video: HTMLVideoElement): void {
  video.play().catch((error: unknown) => {
    if (
      error instanceof DOMException &&
      (error.name === 'AbortError' || error.name === 'NotSupportedError')
    )
      return;
    throw error;
  });
}
