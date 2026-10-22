/**
 * Frames of a stored clip for the likeness check when Cloudflare cannot reach
 * it: local dev and CDN-less deploy-button installs have no public URL, so
 * Media Transformations has nothing to fetch (#1930). The clip goes to fal
 * storage (the same shim Ark inputs take) and fal's ffmpeg pulls the first,
 * middle and last frames.
 */

import { createFalClient } from '@fal-ai/client';
import { z } from 'zod';
import { ensureExternallyFetchableUrl } from '@/platform/server/storage/external-url';

const FRAME_TYPES = ['first', 'middle', 'last'] as const;

const extractFrameOutput = z.object({
  images: z.array(z.object({ url: z.string().url() })).nonempty(),
});

export async function falClipFrames(
  storedUrl: string,
  falApiKey: string
): Promise<string[]> {
  const videoUrl = await ensureExternallyFetchableUrl(storedUrl, falApiKey);
  // Upstream client, like the storage shim: this only runs against real fal.
  const fal = createFalClient({ credentials: falApiKey });
  // ponytail: fal spend here is not billed to the team (~$0.0002 per second
  // of clip, three calls); bill it if CDN-less installs start to matter.
  return Promise.all(
    FRAME_TYPES.map(async (frame_type) => {
      const { data } = await fal.subscribe('fal-ai/ffmpeg-api/extract-frame', {
        input: { video_url: videoUrl, frame_type },
      });
      return extractFrameOutput.parse(data).images[0].url;
    })
  );
}
