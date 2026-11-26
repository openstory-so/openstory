/** The body the product's own builders send each gateway model, for the coverage check (#2432). */

import { NATIVE_GROK_VIDEO_MODEL } from '@/models/grok-native';
import {
  getTextToImageModelId,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
} from '@/models/models';
import { buildGrokVideoRequest } from '@/motion/server/build-grok-video-request';
import { buildMotionRequest } from '@/motion/server/build-model-input';
import type { JsonValue } from '@/platform/server/db/schema';
import { typedEntries } from '@/platform/typed-object';
import { buildImageRequest } from '@/stills/build-image-request';
import { z } from 'zod';

const PROMPT =
  'Mara, a ferry mechanic, wipes her hands on a rag in the engine room';
const STILL = 'https://media.example.com/still.png';
const REFERENCE = {
  referenceImageUrl: 'https://media.example.com/mara-sheet.png',
  description: 'Mara, a ferry mechanic',
  role: 'character',
  token: 'MARA',
} as const;

type Body = Record<string, JsonValue>;

/** The builder's output as JSON: what reaches the provider. */
function json(input: unknown): Body {
  return z
    .record(z.string(), z.json())
    .parse(JSON.parse(JSON.stringify(input)));
}

/** A builder that refuses this model (no route on that via) contributes no body. */
function attempt(build: () => { endpointId: string; input: unknown }) {
  try {
    const { endpointId, input } = build();
    return [[endpointId, json(input)] as const];
  } catch {
    return [];
  }
}

/**
 * `provider/id` to the body the product sends: fal stills (text-to-image and,
 * with one reference, edit) and fal motion (5 s, 16:9, the builder's default
 * resolution and audio) from a start frame, with one reference, and reference-only;
 * native Grok video. Ark, Gemini, Grok stills and Seed Audio have no entry yet.
 */
export function productBodies(): Map<string, Body> {
  const fal = [
    ...typedEntries(IMAGE_MODELS).flatMap(([model]) =>
      getTextToImageModelId(model)
        ? [
            ...attempt(() =>
              buildImageRequest({ model, prompt: PROMPT, numImages: 1 })
            ),
            ...attempt(() =>
              buildImageRequest({
                model,
                prompt: PROMPT,
                numImages: 1,
                referenceImageUrls: [REFERENCE.referenceImageUrl],
              })
            ),
          ]
        : []
    ),
    ...typedEntries(IMAGE_TO_VIDEO_MODELS).flatMap(([model]) => {
      const base = {
        prompt: PROMPT,
        duration: 5,
        aspectRatio: '16:9',
        model,
      } as const;
      return [
        ...attempt(() =>
          buildMotionRequest({ ...base, imageUrl: STILL }, model)
        ),
        ...attempt(() =>
          buildMotionRequest(
            { ...base, imageUrl: STILL, referenceImages: [REFERENCE] },
            model
          )
        ),
        ...attempt(() =>
          buildMotionRequest(
            { ...base, referenceOnly: true, referenceImages: [REFERENCE] },
            model
          )
        ),
        ...attempt(() =>
          buildMotionRequest({ ...base, referenceOnly: true }, model)
        ),
      ];
    }),
  ];
  const bodies = new Map(fal.map(([id, body]) => [`fal/${id}`, body]));
  const [grok] = attempt(() =>
    buildGrokVideoRequest({
      prompt: PROMPT,
      imageUrl: STILL,
      duration: 5,
      aspectRatio: '16:9',
    })
  );
  if (grok) bodies.set(`grok/${NATIVE_GROK_VIDEO_MODEL}`, grok[1]);
  return bodies;
}
