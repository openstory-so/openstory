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

/**
 * Can this model carry a reference of this kind and length? The one question
 * asked by all three gates (#1559) — the create-time schema, the scene panel,
 * and the submit refusal — so a sequence cannot be accepted for a run that
 * submit will then refuse.
 *
 * Unknown length is always accepted: we only learn it if the browser could
 * decode the file, and guessing "probably too long" would block a reference
 * the provider would have taken.
 */
export function acceptsReference(
  model: ImageToVideoModel,
  ref: { kind: 'image' | 'video' | 'audio'; durationSeconds: number | null }
): boolean {
  if (ref.kind === 'image') return true;
  if (!motionReferenceSupport(model)[ref.kind]) {
    // The model takes no reference of this kind at all. That is a disclosure,
    // not a blocker — elements live on the sequence while models vary per
    // render, so the binding describes it in prose and the panel says so.
    return true;
  }
  const config = getMotionReferenceEndpoint(model);
  const max =
    ref.kind === 'video'
      ? config?.videoSeconds?.max
      : config?.audioSeconds?.max;
  if (max === undefined || ref.durationSeconds == null) return true;
  return ref.durationSeconds <= max;
}

/** The longest reference of this kind the model will take, or null for no limit. */
export function referenceSecondsLimit(
  model: ImageToVideoModel,
  kind: 'video' | 'audio'
): number | null {
  const config = getMotionReferenceEndpoint(model);
  const max =
    kind === 'video' ? config?.videoSeconds?.max : config?.audioSeconds?.max;
  return max ?? null;
}

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
  const tooLong: { token: string; max: number }[] = [];
  for (const el of attached) {
    if (el.kind === 'image' || acceptsReference(model, el)) continue;
    const max = referenceSecondsLimit(model, el.kind);
    if (max !== null) tooLong.push({ token: el.token, max });
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
