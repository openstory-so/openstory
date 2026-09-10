/**
 * Build reference-to-video input (prompt + image/video/audio url lists) from
 * the rendered still + cast/element reference media (#873, #1559).
 *
 * Models in `MOTION_REFERENCE_ENDPOINTS` accept references on a dedicated
 * reference-to-video endpoint whose start frame is optional. It takes an
 * image list (`image_urls` or `reference_image_urls`) bound to prompt
 * tokens — Seedance's `@Image1…N`, H3 Max's `Image 1…N`, Kling O3's
 * `@Image1…N` — via the endpoint's `tag` config, and on Seedance / H3 Max two
 * more lists for reference CLIPS (`@Video1…N`) and AUDIO (`@Audio1…N`).
 *
 * Binding follows the vendors' own prompt examples: the FIRST line declares
 * the still as the starting frame ("Use @Image1 as the starting frame."),
 * and each
 * reference is bound INLINE by substituting its canonical token ("SCARLETT",
 * "CORAL_LIPSTICK", "STEVE_LINE_3") with the model's tag at the exact
 * narrative moment it appears. References never mentioned in the prompt fall
 * back to a trailing legend line so their media isn't orphaned.
 *
 * `startImageUrl` is the still ONLY when it rides the image list. Kling O3
 * has a real `start_image_url`, so `buildMotionRequest` pins the still there
 * and passes null here — the binding is then the reference-only shape below,
 * which is correct: with the frame guaranteed by the request there is nothing
 * for the prose to declare.
 *
 * Each kind is capped and numbered independently (`maxImages` / `maxVideos` /
 * `maxAudio`, plus the endpoint's combined file cap), because the tag
 * namespaces are independent: `@Video1` is the first CLIP, not the first file.
 * A still in the image list consumes one slot, so at most `maxImages - 1`
 * image references are taken. Overflow — and every reference of a kind this
 * endpoint does not take at all — has its token replaced with a plain
 * description instead, keeping the prompt self-contained and saying in prose
 * what the media would have said. A token that never appeared in the prompt
 * leaves no trace, which is why `submitFalMotionJob` warns and emits
 * `motion_references_over_cap` when the list is over budget.
 *
 * REFERENCE-ONLY (`startImageUrl: null`): no still was ever rendered, so slot
 * 1 belongs to the first real reference and the starting-frame line is
 * dropped — telling the model to open on `@Image1` when `@Image1` is a
 * character sheet makes it open on the sheet, flat lighting and all. The
 * whole `maxImages` budget goes to references, and the prompt itself carries
 * the composition the still would otherwise have supplied (see the
 * reference-only motion prompt template in `workflow-prompts.ts`).
 */

import type {
  MediaDurationLimit,
  MotionReferenceEndpointConfig,
} from '@/models/models';
import type { ReferenceImageDescription } from '@/stills/reference-image-prompt';
import {
  appendLegendWithinLimit,
  inlineReferenceDescription,
  substituteReferenceTags,
} from '@/stills/reference-legend';

/**
 * The knobs the prompt binding needs. The native Grok / Gemini builders pass
 * their own (one model id serves every task there, so they have no separate
 * reference or text-to-video endpoint to name) — and, declaring no video or
 * audio capacity, they inline those references as prose rather than sending
 * media those APIs have no verified slot for.
 */
export type ReferencePromptBinding = Pick<
  MotionReferenceEndpointConfig,
  | 'tag'
  | 'maxImages'
  | 'maxVideos'
  | 'maxAudio'
  | 'maxCombined'
  | 'videoTag'
  | 'audioTag'
  | 'videoSeconds'
  | 'audioSeconds'
>;

type Kind = 'image' | 'video' | 'audio';

const kindOf = (ref: ReferenceImageDescription): Kind => ref.kind ?? 'image';

/**
 * Split references into the ones this endpoint will actually carry, per kind,
 * and the overflow that has to become prose.
 *
 * Audio never rides alone: every reference endpoint we submit to states "at
 * least one reference image or video is required", so a shot whose only
 * reference is a voice line has no request to make of them — it describes the
 * line instead and goes to the prompt-only route.
 *
 * Clips and audio are also checked against the endpoint's length limits
 * (#1559): a 10s clip on Omni Flash, whose ceiling is 3s, is rejected outright
 * by the provider, so sending it would fail the whole shot rather than degrade
 * it. Over-length references overflow into prose like any other, and the scene
 * panel says so. A reference of unknown length is always attached — guessing
 * it is too long would drop one the provider might have taken.
 */
function partitionReferences(
  binding: ReferencePromptBinding | null,
  references: ReferenceImageDescription[],
  hasStartFrame: boolean
): {
  images: ReferenceImageDescription[];
  videos: ReferenceImageDescription[];
  audio: ReferenceImageDescription[];
  overflow: ReferenceImageDescription[];
} {
  const withUrls = references.filter((ref) => ref.referenceImageUrl);
  const budget: Record<Kind, number> = {
    image: (binding?.maxImages ?? 0) - (hasStartFrame ? 1 : 0),
    video: binding?.maxVideos ?? 0,
    audio: binding?.maxAudio ?? 0,
  };
  const taken: Record<Kind, ReferenceImageDescription[]> = {
    image: [],
    video: [],
    audio: [],
  };
  const overflow: ReferenceImageDescription[] = [];
  // The combined cap counts the still too — it is a file on the request.
  let filesLeft =
    (binding?.maxCombined ?? Number.POSITIVE_INFINITY) -
    (hasStartFrame ? 1 : 0);
  const limits: Partial<Record<Kind, MediaDurationLimit | undefined>> = {
    video: binding?.videoSeconds,
    audio: binding?.audioSeconds,
  };
  const secondsUsed: Record<Kind, number> = { image: 0, video: 0, audio: 0 };

  for (const ref of withUrls) {
    const kind = kindOf(ref);
    if (taken[kind].length >= budget[kind] || filesLeft <= 0) {
      overflow.push(ref);
      continue;
    }
    if (exceedsDuration(ref, limits[kind], secondsUsed[kind])) {
      overflow.push(ref);
      continue;
    }
    taken[kind].push(ref);
    secondsUsed[kind] += ref.durationSeconds ?? 0;
    filesLeft -= 1;
  }

  if (
    taken.audio.length > 0 &&
    taken.image.length === 0 &&
    taken.video.length === 0 &&
    !hasStartFrame
  ) {
    overflow.push(...taken.audio);
    taken.audio = [];
  }

  return {
    images: taken.image,
    videos: taken.video,
    audio: taken.audio,
    overflow,
  };
}

/**
 * The references that will ride on the wire for this endpoint — what "this
 * shot has references" MEANS at routing time. A shot carrying only media the
 * endpoint cannot take is a prompt-only shot, and routing it to the
 * reference-to-video endpoint would 422 on an empty image list.
 */
export function bindableReferences(
  binding: ReferencePromptBinding | null,
  references: ReferenceImageDescription[],
  hasStartFrame = false
): ReferenceImageDescription[] {
  const parts = partitionReferences(binding, references, hasStartFrame);
  return [...parts.images, ...parts.videos, ...parts.audio];
}

/**
 * Would attaching this reference bust the endpoint's length limits? Unknown
 * length is never "too long" — see `partitionReferences`.
 */
function exceedsDuration(
  ref: ReferenceImageDescription,
  limit: MediaDurationLimit | undefined,
  secondsAlreadyTaken: number
): boolean {
  const seconds = ref.durationSeconds;
  if (!limit || seconds == null) return false;
  if (limit.max !== undefined && seconds > limit.max) return true;
  return (
    limit.maxCombined !== undefined &&
    secondsAlreadyTaken + seconds > limit.maxCombined
  );
}

const atVideo = (position: number): string => `@Video${position}`;
const atAudio = (position: number): string => `@Audio${position}`;

export function buildReferenceVideoPrompt(
  config: ReferencePromptBinding,
  basePrompt: string,
  /** The rendered still, or null in reference-only mode (no start frame). */
  startImageUrl: string | null,
  references: ReferenceImageDescription[],
  maxPromptLength?: number,
  options?: { skipLegend?: boolean }
): {
  prompt: string;
  imageUrls: string[];
  videoUrls: string[];
  audioUrls: string[];
} {
  // The still, when there is one, always takes the first slot; cast/element
  // refs fill the rest. Reference-only frees that slot for a real reference,
  // which also shifts every image tag down by one. Clip and audio tags are
  // their own namespace and always start at 1.
  const firstImageSlot = startImageUrl ? 2 : 1;
  const { images, videos, audio, overflow } = partitionReferences(
    config,
    references,
    Boolean(startImageUrl)
  );

  const videoTag = config.videoTag ?? atVideo;
  const audioTag = config.audioTag ?? atAudio;
  const bound: { ref: ReferenceImageDescription; render: string }[] = [
    ...images.map((ref, index) => ({
      ref,
      render: config.tag(index + firstImageSlot),
    })),
    ...videos.map((ref, index) => ({ ref, render: videoTag(index + 1) })),
    ...audio.map((ref, index) => ({ ref, render: audioTag(index + 1) })),
  ];

  const { prompt: substituted, mentioned } = substituteReferenceTags(
    basePrompt,
    [
      // Attached refs bind inline to their tag.
      ...bound.map(({ ref, render }) => ({ token: ref.token, render })),
      // Overflow refs have no slot — swap tokens for descriptions.
      ...overflow.map((ref) => ({
        token: ref.token,
        render: inlineReferenceDescription(ref),
      })),
    ]
  );

  // Reference-only has no starting frame to declare, and pointing the model
  // at `@Image1` there would make it open on a character sheet.
  const body = startImageUrl
    ? `Use ${config.tag(1)} as the starting frame.\n${substituted}`
    : substituted;

  const result = {
    imageUrls: [
      ...(startImageUrl ? [startImageUrl] : []),
      ...images.map((ref) => ref.referenceImageUrl),
    ],
    videoUrls: videos.map((ref) => ref.referenceImageUrl),
    audioUrls: audio.map((ref) => ref.referenceImageUrl),
  };

  // Legend fallback: attached refs whose token never appeared in the prompt
  // would otherwise be orphaned media.
  //
  // The image line's wording is load-bearing beyond taste: aimock replays
  // recorded fal fixtures by string-matching the request body, so an
  // image-only prompt must render byte-identically to before #1559.
  const legendLines = options?.skipLegend
    ? []
    : bound
        .map(({ ref, render }, index) =>
          mentioned[index]
            ? null
            : `${render}: ${ref.description} — keep ${
                kindOf(ref) === 'image' ? 'visually ' : ''
              }consistent throughout the shot.`
        )
        .filter((line) => line !== null);

  if (legendLines.length === 0) {
    return { prompt: body, ...result };
  }
  const legend = `Reference images:\n${legendLines.join('\n')}`;
  return {
    prompt: appendLegendWithinLimit(body, legend, maxPromptLength),
    ...result,
  };
}
