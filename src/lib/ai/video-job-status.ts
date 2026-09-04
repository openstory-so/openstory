import { getVideoJobStatus as tanstackGetVideoJobStatus } from '@tanstack/ai';

/**
 * The fal adapter wraps ANY `queue.result` failure (5xx, network, deadline)
 * in this prefix; a 422 with `body.detail` becomes `Video generation failed:`
 * instead and is a real provider verdict.
 */
const RESULT_FETCH_FAILURE = /^Failed to retrieve video result/;

/**
 * `@tanstack/ai`'s `getVideoJobStatus` swallows a thrown `getVideoUrl` into
 * `{ status: 'failed', error }`, which the workflows read as a terminal
 * provider failure. But by then the job has already reported COMPLETED — only
 * the result fetch failed (fal answered 504 on nine clips of one run). Rethrow
 * so the poll step retries instead of failing the clip.
 */
export async function getVideoJobStatus(
  ...args: Parameters<typeof tanstackGetVideoJobStatus>
): ReturnType<typeof tanstackGetVideoJobStatus> {
  const result = await tanstackGetVideoJobStatus(...args);
  if (
    result.status === 'failed' &&
    result.error &&
    RESULT_FETCH_FAILURE.test(result.error)
  ) {
    throw new Error(result.error);
  }
  return result;
}
