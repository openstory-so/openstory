/**
 * Which KINDS of reference a motion model will actually carry (#1559).
 *
 * Attaching a clip or an audio element to a shot whose model takes neither is
 * allowed — the binding inlines its description as prose so the prompt still
 * says what the reference would have shown — but the scene panel has to SAY
 * so. Silently dropping a dialogue line the user attached is the failure this
 * exists to prevent.
 *
 * Read off `MOTION_REFERENCE_ENDPOINTS`, the same table the request builders
 * bind from, so the notice and the request can never disagree.
 *
 * Client-safe.
 */

import {
  getMotionReferenceEndpoint,
  IMAGE_TO_VIDEO_MODELS,
  type ImageToVideoModel,
} from '@/models/models';
import { isNativeGrokVideoModel } from '@/models/grok-native';

export type MotionReferenceSupport = {
  image: boolean;
  video: boolean;
  audio: boolean;
};

export function motionReferenceSupport(
  model: ImageToVideoModel
): MotionReferenceSupport {
  const config = getMotionReferenceEndpoint(model);
  return {
    // Grok Imagine carries stills as native xAI prompt parts and has no row in
    // the table. Kling used to be the other exception; #1498 moved it onto a
    // real reference endpoint, so `maxImages` now answers for it.
    image: (config?.maxImages ?? 0) > 0 || isNativeGrokVideoModel(model),
    video: (config?.maxVideos ?? 0) > 0,
    audio: (config?.maxAudio ?? 0) > 0,
  };
}

/**
 * "Seedance 2.5 uses images, clips and audio" — one line for the panel, or
 * `null` when every attached kind is carried and there is nothing to warn
 * about.
 */
export function unsupportedReferenceNotice(
  model: ImageToVideoModel,
  attachedKinds: Iterable<'image' | 'video' | 'audio'>
): string | null {
  const support = motionReferenceSupport(model);
  const labels = { image: 'images', video: 'clips', audio: 'audio' } as const;
  const dropped = [...new Set(attachedKinds)]
    .filter((kind) => !support[kind])
    .map((kind) => labels[kind]);
  if (dropped.length === 0) return null;
  return `${IMAGE_TO_VIDEO_MODELS[model].name} takes no reference ${listed(dropped)} — those are described in the prompt instead of sent.`;
}

/**
 * The attached clips and audio this model is too short to take (#1559).
 *
 * These BLOCK the render rather than degrading it — see `overlongReferences`.
 * So this line is a pre-flight warning, not an after-the-fact disclosure: it
 * exists so the user trims the file before spending credits, instead of
 * meeting the same refusal from the submit path.
 */
export function overlongReferenceNotice(
  model: ImageToVideoModel,
  attached: Iterable<{
    token: string;
    kind: 'image' | 'video' | 'audio';
    durationSeconds: number | null;
  }>
): string | null {
  const config = getMotionReferenceEndpoint(model);
  if (!config) return null;
  const tooLong: { token: string; max: number }[] = [];
  for (const el of attached) {
    if (el.kind === 'image' || el.durationSeconds == null) continue;
    const max =
      el.kind === 'video' ? config.videoSeconds?.max : config.audioSeconds?.max;
    if (max !== undefined && el.durationSeconds > max) {
      tooLong.push({ token: el.token, max });
    }
  }
  if (tooLong.length === 0) return null;
  const max = tooLong[0]?.max ?? 0;
  const tokens = listed(tooLong.map((t) => t.token));
  const isOne = tooLong.length === 1;
  return `${IMAGE_TO_VIDEO_MODELS[model].name} takes references up to ${max}s, so ${tokens} ${isOne ? 'is' : 'are'} too long and ${isOne ? 'this shot' : 'these shots'} will not render. Trim ${isOne ? 'it' : 'them'}, or pick a model that takes ${isOne ? 'it' : 'them'}.`;
}

function listed(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}
