/**
 * Which references a motion model will actually use (#1559) — and, when it
 * will not, what to tell the user.
 *
 * There is no fallback. A clip or voice line the selected model cannot use —
 * it takes no reference of that kind, the file is too long, too short, or in
 * a format no model takes, or it is audio with nothing to ride alongside —
 * refuses the shot. Describing it in the prompt instead rendered a clip that
 * ignored what the user attached and said so nowhere; sending it anyway came
 * back as a provider error after Generate. So one question, `referenceProblem`,
 * drives the warning before Generate, the tile badge, the create-time check,
 * and the refusal at submit, and they cannot disagree.
 *
 * Read off `MOTION_REFERENCE_ENDPOINTS`, the same table the request builders
 * bind from. Stills are out of scope: a sheet a model cannot carry is still
 * described in the prompt, the long-standing contract for cast and locations.
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
import { isElementVoiceToken } from '@/motion/dialogue-tts';

type ReferenceKind = 'image' | 'video' | 'audio';

type AttachedReference = {
  token?: string;
  kind?: ReferenceKind;
  durationSeconds?: number | null;
  /** The stored file — an element row's `imageUrl`, a built reference's `referenceImageUrl`. */
  imageUrl?: string | null;
  referenceImageUrl?: string;
};

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
 * What every model that documents its formats accepts — the Seedance family,
 * on fal and on Ark. H3 Max and Omni Flash state none, so the one rule covers
 * them too. Uploads convert other audio to WAV before storing it; this catches
 * the rows stored before that did.
 */
const REFERENCE_FORMATS = {
  video: { exts: ['mp4', 'mov'], accepts: 'MP4 or MOV' },
  audio: { exts: ['mp3', 'wav'], accepts: 'MP3 or WAV' },
} as const;

function fileExtension(url: string | null | undefined): string | null {
  const match = url?.split(/[?#]/)[0]?.match(/\.([a-z0-9]+)$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * The shortest and longest SINGLE file of this kind the model takes, null
 * where it states none. The ceiling falls back to the combined one: a lone
 * file IS the whole combined budget.
 */
function lengthWindow(
  model: ImageToVideoModel,
  kind: 'video' | 'audio'
): { min: number | null; max: number | null } {
  const config = getMotionReferenceEndpoint(model);
  const limit = kind === 'video' ? config?.videoSeconds : config?.audioSeconds;
  return {
    min: limit?.min ?? null,
    max: limit?.max ?? limit?.maxCombined ?? null,
  };
}

export type ReferenceProblem =
  | { reason: 'unsupported' }
  | { reason: 'format'; ext: string; accepts: string }
  | { reason: 'too-long'; maxSeconds: number }
  | { reason: 'too-short'; minSeconds: number };

/**
 * Can THIS model use this clip or voice line? Null when it can. An unknown
 * length is never too long or too short: guessing would block a reference the
 * provider might take, and the server measures lengths it does not have.
 */
export function referenceProblem(
  model: ImageToVideoModel,
  ref: AttachedReference
): ReferenceProblem | null {
  const kind = ref.kind ?? 'image';
  if (kind === 'image') return null;
  if (!motionReferenceSupport(model)[kind]) return { reason: 'unsupported' };
  const ext = fileExtension(ref.referenceImageUrl ?? ref.imageUrl);
  const formats = REFERENCE_FORMATS[kind];
  if (ext && !(formats.exts as readonly string[]).includes(ext)) {
    return { reason: 'format', ext, accepts: formats.accepts };
  }
  const seconds = ref.durationSeconds;
  if (seconds == null) return null;
  const { min, max } = lengthWindow(model, kind);
  if (max !== null && seconds > max) {
    return { reason: 'too-long', maxSeconds: max };
  }
  if (min !== null && seconds < min) {
    return { reason: 'too-short', minSeconds: min };
  }
  return null;
}

/**
 * The create-time question: is this FILE fit for the model? Everything but
 * "the model takes no clips at all", which is a per-shot question — at
 * creation no shot has claimed the element yet.
 */
export function acceptsReference(
  model: ImageToVideoModel,
  ref: AttachedReference
): boolean {
  const problem = referenceProblem(model, ref);
  return problem === null || problem.reason === 'unsupported';
}

function offeredModels(): ImageToVideoModel[] {
  return Object.keys(IMAGE_TO_VIDEO_MODELS)
    .filter((key): key is ImageToVideoModel => key in IMAGE_TO_VIDEO_MODELS)
    .filter((model) => isOfferedVideoModel(model, { byteplus: true }));
}

/** Every offered video model that would actually SEND this reference. */
function modelsAcceptingReference(ref: AttachedReference): ImageToVideoModel[] {
  return offeredModels().filter(
    (model) => referenceProblem(model, ref) === null
  );
}

export type ReferenceUsability =
  /** Every model that could render this shot will carry it. Images. */
  | { level: 'ok' }
  /**
   * Some models use it. True of EVERY clip and voice line — only the Seedance
   * family, H3 Max and Omni Flash take them at all — so this is the normal
   * state for those, not an edge case.
   *
   * `tooLong` / `tooShort` are models that take this KIND of file but not
   * this length, kept apart so the summary can name them: a list naming only
   * the models that fit read as "only Seedance 2.5 takes clips" for a 15.05s
   * file that four other models take at 15s or less.
   */
  | {
      level: 'limited';
      models: ImageToVideoModel[];
      tooLong: { model: ImageToVideoModel; maxSeconds: number }[];
      tooShort: { model: ImageToVideoModel; minSeconds: number }[];
    }
  /** No offered model can use it, and why — the fix is to the file. */
  | {
      level: 'unusable';
      problem:
        | { reason: 'format'; ext: string; accepts: string }
        | { reason: 'too-long'; maxSeconds: number }
        | { reason: 'too-short'; minSeconds: number };
    };

/**
 * How usable is this element as a reference, across the whole catalog? Drives
 * the tile badge when no model is in scope.
 */
export function referenceUsability(ref: AttachedReference): ReferenceUsability {
  const kind = ref.kind ?? 'image';
  if (kind === 'image') return { level: 'ok' };
  const models = modelsAcceptingReference(ref);
  const takers = offeredModels().filter(
    (model) => motionReferenceSupport(model)[kind]
  );
  const problems = takers.flatMap((model) => {
    const problem = referenceProblem(model, ref);
    return problem ? [{ model, problem }] : [];
  });
  const tooLong = problems.flatMap(({ model, problem }) =>
    problem.reason === 'too-long'
      ? [{ model, maxSeconds: problem.maxSeconds }]
      : []
  );
  const tooShort = problems.flatMap(({ model, problem }) =>
    problem.reason === 'too-short'
      ? [{ model, minSeconds: problem.minSeconds }]
      : []
  );
  if (models.length > 0) return { level: 'limited', models, tooLong, tooShort };

  // Nothing takes it. Report the fix: the format, or the length window it has
  // to come inside — computed from the catalog, so a roomier model appearing
  // moves it on its own.
  const format = problems.find(({ problem }) => problem.reason === 'format');
  if (format?.problem.reason === 'format') {
    return { level: 'unusable', problem: format.problem };
  }
  if (tooShort.length > 0 && tooLong.length === 0) {
    return {
      level: 'unusable',
      problem: {
        reason: 'too-short',
        minSeconds: Math.min(...tooShort.map((t) => t.minSeconds)),
      },
    };
  }
  return {
    level: 'unusable',
    problem: {
      reason: 'too-long',
      maxSeconds: Math.max(0, ...tooLong.map((t) => t.maxSeconds)),
    },
  };
}

/**
 * One line per attached clip or voice line `model` cannot use, naming the
 * fix: "H3 Max can't use SMOKE_INK — 15.05s, over its 15s limit. Trim it, or
 * use Seedance 2.5." Empty when every attachment is usable. Per element —
 * see `unusableShotReferenceLines` for what depends on the whole shot.
 */
export function unusableReferenceLines(
  model: ImageToVideoModel,
  attached: Iterable<AttachedReference>
): string[] {
  const name = IMAGE_TO_VIDEO_MODELS[model].name;
  const lines: string[] = [];
  for (const ref of attached) {
    const problem = referenceProblem(model, ref);
    const kind = ref.kind ?? 'image';
    if (!problem || kind === 'image') continue;
    const noun = kind === 'video' ? 'clip' : 'audio file';
    const token = ref.token ?? `this ${noun}`;
    const others = modelsAcceptingReference(ref);
    const orUse = others.length > 0 ? `, or use ${listModelNames(others)}` : '';
    const seconds = Number((ref.durationSeconds ?? 0).toFixed(2));
    switch (problem.reason) {
      case 'format':
        lines.push(
          `${name} can't use ${token} — it is ${problem.ext.toUpperCase()}, and models take ${problem.accepts}. Replace it with an ${problem.accepts} file.`
        );
        break;
      case 'unsupported':
        lines.push(
          others.length > 0
            ? `${name} can't use ${token} — it takes no reference ${kind === 'video' ? 'clips' : 'audio'}. Use ${listModelNames(others)}.`
            : `${name} can't use ${token} — it takes no reference ${kind === 'video' ? 'clips' : 'audio'}.`
        );
        break;
      case 'too-long':
        lines.push(
          `${name} can't use ${token} — ${seconds}s, over its ${problem.maxSeconds}s limit. Trim it${orUse}.`
        );
        break;
      case 'too-short':
        lines.push(
          `${name} can't use ${token} — ${seconds}s, under its ${problem.minSeconds}s minimum. Use a longer ${noun}${orUse}.`
        );
        break;
    }
  }
  return lines;
}

/**
 * Everything `unusableReferenceLines` says, plus what only the whole shot can
 * answer: a voice line with nothing to ride alongside. Every reference
 * endpoint that takes audio refuses it alone ("At least one reference image or
 * video is required" — Seedance; "Audio cannot be the only reference input" —
 * H3 Max). With no start frame and no sheet or clip bound, there is nothing
 * for it to ride with.
 */
export function unusableShotReferenceLines(
  model: ImageToVideoModel,
  attached: AttachedReference[],
  hasStartFrame: boolean
): string[] {
  const lines = unusableReferenceLines(model, attached);
  if (hasStartFrame) return lines;
  const support = motionReferenceSupport(model);
  const usable = attached.filter(
    (ref) => referenceProblem(model, ref) === null
  );
  const kindOf = (ref: AttachedReference) => ref.kind ?? 'image';
  const voices = usable.filter((ref) => kindOf(ref) === 'audio');
  const carriers = usable.filter(
    (ref) =>
      (kindOf(ref) === 'image' && support.image) ||
      (kindOf(ref) === 'video' && support.video)
  );
  if (!support.audio || voices.length === 0 || carriers.length > 0) {
    return lines;
  }
  const tokens = voices.map((ref) => ref.token ?? 'the audio file');
  const which = tokens.length === 1 ? tokens[0] : `${tokens.join(' and ')}`;
  return [
    ...lines,
    `${IMAGE_TO_VIDEO_MODELS[model].name} can't send ${which} on its own — it needs a reference image or clip alongside. Add a cast member, location or element to this shot, or use a start frame.`,
  ];
}

/**
 * Dialogue lines bound to a voice that no longer exists — the element was
 * deleted after it was picked (#1559). The binding still names it, so the
 * prompt would carry a raw token with no file behind it and the model would
 * invent a voice. Only models that take audio are asked; the rest never send
 * a voice at all.
 */
export function missingVoiceLines(
  model: ImageToVideoModel,
  dialogue:
    | { lines: { character: string; voiceToken?: string }[] }
    | null
    | undefined,
  elements: { token: string }[]
): string[] {
  if (!motionReferenceSupport(model).audio) return [];
  const live = new Set(elements.map((el) => el.token));
  return (dialogue?.lines ?? []).flatMap((line) =>
    isElementVoiceToken(line.voiceToken) && !live.has(line.voiceToken)
      ? [
          `${line.voiceToken}, the voice on ${line.character || 'the narrator'}'s line, was deleted — pick another voice.`,
        ]
      : []
  );
}

/**
 * Refuse a render whose model cannot use what the shot attaches. Shared by
 * the submit path (the last word) and the server fns that trigger renders,
 * which refuse before reserving credits rather than after a failed job.
 */
export function assertReferencesUsable(
  model: ImageToVideoModel,
  attached: AttachedReference[],
  hasStartFrame: boolean
): void {
  const lines = unusableShotReferenceLines(model, attached, hasStartFrame);
  if (lines.length > 0) throw new Error(lines.join(' '));
}

/** "H3 Max, Seedance 2.0 and Seedance 2.5" */
export function listModelNames(models: ImageToVideoModel[]): string {
  const names = models.map((model) => IMAGE_TO_VIDEO_MODELS[model].name);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
