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
  isOfferedVideoModel,
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
  const max = referenceSecondsLimit(model, ref.kind);
  if (max === null || ref.durationSeconds == null) return true;
  return ref.durationSeconds <= max;
}

/**
 * The longest SINGLE reference of this kind the model will take, or null when
 * it states no limit.
 *
 * Falls back to the combined ceiling where no per-file one is declared: one
 * file on its own IS the whole combined budget, so Seedance 2.0's "combined
 * duration must be between 2 and 15 seconds" caps a lone clip at 15s just as
 * firmly as an explicit per-file rule would.
 */
export function referenceSecondsLimit(
  model: ImageToVideoModel,
  kind: 'video' | 'audio'
): number | null {
  const config = getMotionReferenceEndpoint(model);
  const limit = kind === 'video' ? config?.videoSeconds : config?.audioSeconds;
  return limit?.max ?? limit?.maxCombined ?? null;
}

export type ReferenceUsability =
  /** Every model that could render this shot will carry it. Images, today. */
  | { level: 'ok' }
  /**
   * Some models carry it, others describe it in prose instead. True of EVERY
   * clip and voice line — only the Seedance family, H3 Max and Omni Flash take
   * them at all — so this is the normal state for those, not an edge case.
   */
  | { level: 'limited'; models: ImageToVideoModel[]; maxSeconds: number | null }
  /**
   * No offered model can carry it. Today that means only one thing: longer
   * than the most generous ceiling in the catalog. Nothing the user can do
   * except trim it, so it reads as an error rather than a warning.
   */
  | { level: 'unusable'; maxSeconds: number };

/** Every offered video model that would actually SEND this reference. */
function modelsAcceptingReference(ref: {
  kind: 'image' | 'video' | 'audio';
  durationSeconds: number | null;
}): ImageToVideoModel[] {
  return Object.keys(IMAGE_TO_VIDEO_MODELS)
    .filter((key): key is ImageToVideoModel => key in IMAGE_TO_VIDEO_MODELS)
    .filter((model) => isOfferedVideoModel(model, { byteplus: true }))
    .filter((model) => {
      if (ref.kind === 'image') return true;
      // `acceptsReference` deliberately tolerates a kind the model does not
      // take (it degrades to prose). Here the question is stricter: would the
      // file actually ride?
      if (!motionReferenceSupport(model)[ref.kind]) return false;
      return acceptsReference(model, ref);
    });
}

/**
 * How usable is this element as a reference, across the whole catalog (#1559)?
 * Drives the badge on the element tile: nothing for a still, a warning naming
 * the models that take it for a clip or voice line, an error when its length
 * puts it beyond every one of them.
 */
export function referenceUsability(ref: {
  kind: 'image' | 'video' | 'audio';
  durationSeconds: number | null;
}): ReferenceUsability {
  if (ref.kind === 'image') return { level: 'ok' };
  const kind = ref.kind;
  const models = modelsAcceptingReference(ref);
  if (models.length > 0) {
    // The roomiest ceiling among the models that will take it — what the user
    // is working against if they add a longer one next time.
    const limits = models
      .map((model) => referenceSecondsLimit(model, kind))
      .filter((max): max is number => max !== null);
    return {
      level: 'limited',
      models,
      maxSeconds: limits.length > 0 ? Math.max(...limits) : null,
    };
  }
  // Nothing takes it. The only cause today is length, so report the ceiling it
  // has to come under — computed from the catalog rather than hardcoded, so a
  // roomier model appearing moves it on its own.
  const ceilings = Object.keys(IMAGE_TO_VIDEO_MODELS)
    .filter((key): key is ImageToVideoModel => key in IMAGE_TO_VIDEO_MODELS)
    .filter((model) => isOfferedVideoModel(model, { byteplus: true }))
    .filter((model) => motionReferenceSupport(model)[kind])
    .map((model) => referenceSecondsLimit(model, kind))
    .filter((max): max is number => max !== null);
  return { level: 'unusable', maxSeconds: Math.max(0, ...ceilings) };
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
