/**
 * Paste-to-import for the studio composer (#1274). A scene's optimised
 * prompt panel copies the exact fal request JSON; pasting it into the
 * composer rebuilds the references and the prompt instead of dumping JSON
 * into the editor. Client-safe: pure parsing.
 *
 * Recognised shapes (any subset):
 *   - `image_urls[]` (Seedance / Kling / Veo) or `reference_image_urls[]`
 *     (Grok, `<IMAGE_0>` → `Image1`) → images
 *   - `elements[].frontal_image_url` (+ `reference_image_urls[]`) (Kling) →
 *     images, `@ElementN` → `ImageN`
 *   - `image_url` / `start_image_url` / `first_frame_url` → start frame
 *   - `end_image_url` / `last_frame_url` → end frame
 *   - `video_urls[]` / `reference_video_urls[]`, `audio_urls[]` /
 *     `reference_audio_urls[]`
 */

import { z } from 'zod';

type StudioPasteImport = {
  prompt: string;
  images: string[];
  videos: string[];
  audio: string[];
  startImageUrl?: string;
  endImageUrl?: string;
};

const urlList = z.array(z.string().min(1)).optional();
const url = z.string().min(1).optional();

const requestSchema = z.looseObject({
  prompt: z.string().min(1),
  image_urls: urlList,
  reference_image_urls: urlList,
  video_urls: urlList,
  audio_urls: urlList,
  reference_video_urls: urlList,
  reference_audio_urls: urlList,
  elements: z
    .array(
      z.looseObject({
        frontal_image_url: url,
        reference_image_urls: urlList,
      })
    )
    .optional(),
  image_url: url,
  start_image_url: url,
  first_frame_url: url,
  end_image_url: url,
  last_frame_url: url,
});

/** Null when the text is not a request-JSON object with a `prompt`. */
export function parseStudioPaste(text: string): StudioPasteImport | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const parsed = requestSchema.safeParse(json);
  if (!parsed.success) return null;
  const body = parsed.data;

  const images = [
    ...(body.image_urls ?? []),
    ...(body.reference_image_urls ?? []),
  ];
  // xAI numbers stills from zero: `<IMAGE_0>` → `Image1`.
  let prompt = body.prompt.replace(
    /<IMAGE_(\d+)>/g,
    (_m, n: string) => `Image${Number(n) + 1}`
  );

  if (body.elements && body.elements.length > 0) {
    // Element N's frontal still becomes Image N so `@ElementN` keeps pointing
    // at the same face; extra reference angles go after all frontals.
    const frontals = body.elements.flatMap((el) =>
      el.frontal_image_url ? [el.frontal_image_url] : []
    );
    const extras = body.elements.flatMap((el) => el.reference_image_urls ?? []);
    images.push(...frontals, ...extras);
    prompt = prompt.replace(/@?Element(\d+)\b/g, 'Image$1');
  }

  // Pills store the bare token; the request carries `@ImageN` (Seedance)
  // or `Image N` (H3 Max).
  prompt = prompt.replace(/@(Image|Video|Audio)(\d+)/g, '$1$2');
  prompt = prompt.replace(/\b(Image|Video|Audio) (\d+)\b/g, '$1$2');

  const startImageUrl =
    body.start_image_url ?? body.first_frame_url ?? body.image_url;
  const endImageUrl = body.end_image_url ?? body.last_frame_url;

  return {
    prompt,
    images: [...new Set(images)],
    videos: body.video_urls ?? body.reference_video_urls ?? [],
    audio: body.audio_urls ?? body.reference_audio_urls ?? [],
    ...(startImageUrl && { startImageUrl }),
    ...(endImageUrl && { endImageUrl }),
  };
}
