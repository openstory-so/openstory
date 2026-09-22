/**
 * What the studio gallery shows when a generation is opened (#1751).
 *
 * The stored prompt is the composer's markdown serialization, which
 * backslash-escapes punctuation (`*`, `_`, brackets, `~`, backticks), plus
 * whatever the user pasted from a request JSON (`\n`, `\"`). The editor
 * parses that back into prose; the gallery used to print the serialization
 * raw. `readableStudioPrompt` is the prose. References are the stills, clips,
 * and audio snapshotted on the run.
 */

import type { AspectRatio } from '@/models/aspect-ratios';
import { aspectRatioSchema } from '@/models/aspect-ratios';
import {
  isValidImageToVideoModel,
  isValidTextToImageModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/models/models';
import {
  isResolution,
  RESOLUTION_OPTIONS,
  type Resolution,
} from '@/models/resolutions';
import type { GeneratedAsset, JsonValue } from '@/platform/server/db/schema';
import type { StudioVideoMode } from '@/studio/text-to-video';
import { studioAspectRatio, studioPrompt } from './outputs';

export type StudioShownReference = {
  kind: 'image' | 'video' | 'audio';
  url: string;
  /** Caption under the tile: `Start`, `End`, or `@Image1`. */
  label: string;
  /** Prompt token (`Image1`) when the prompt names this tile. */
  tag: string | null;
};

export type StudioReuse = {
  prompt: string;
  aspectRatio: AspectRatio;
  resolution: Resolution | null;
  imageModel: TextToImageModel | null;
  videoModel: ImageToVideoModel | null;
  duration: number | null;
  mode: StudioVideoMode | null;
  generateAudio: boolean | null;
  /** Ark draft mode (#1756); null when the row predates it. */
  draft: boolean | null;
  referenceImages: string[];
  referenceVideos: string[];
  referenceAudio: string[];
  startImageUrl: string | null;
  endImageUrl: string | null;
};

const VIDEO_MODES = ['text', 'reference', 'frames'] as const;

function strings(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === 'string' && item.length > 0
  );
}

function oneString(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Request JSON pasted into the prompt field: show its `prompt`, not the blob. */
function unwrapPrompt(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return value;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed) && typeof parsed.prompt === 'string')
      return parsed.prompt;
  } catch {
    // Prose that happens to start with `{`.
  }
  return value;
}

/**
 * One JSON-string decode when the value is a legal JSON string body
 * (`\n`, `\"`, `\\`). Markdown escapes such as `\*` are not legal JSON
 * escapes, so those fall through to {@link unescapeMarkdown}.
 */
function tryJsonString(value: string): string | null {
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) < 32) return null;
  }
  try {
    const parsed: unknown = JSON.parse(`"${value}"`);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** Inverse of prosemirror-markdown's content escaper, plus a hard break. */
function unescapeMarkdown(value: string): string {
  return value
    .replace(/\\\r?\n/g, '\n')
    .replace(/\\([`*\\~[\]_])/g, '$1')
    .replace(/^(\s*)\\([#>*+-])/gm, '$1$2')
    .replace(/^(\s*\d+)\\\. /gm, '$1. ');
}

function unescapePrompt(value: string): string {
  if (!value.includes('\\')) return value;
  const decoded = tryJsonString(value);
  const text =
    decoded ??
    value
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"');
  return unescapeMarkdown(text);
}

export function readableStudioPrompt(value: string): string {
  return unescapePrompt(unwrapPrompt(value));
}

function tagged(
  kind: StudioShownReference['kind'],
  urls: string[],
  token: 'Image' | 'Video' | 'Audio'
): StudioShownReference[] {
  return urls.map((url, index) => {
    const tag = `${token}${index + 1}`;
    return { kind, url, label: `@${tag}`, tag };
  });
}

export function studioShownReferences(
  asset: GeneratedAsset
): StudioShownReference[] {
  const input = asset.input;
  const frames: StudioShownReference[] = [];
  const start = oneString(input.startImageUrl);
  const end = oneString(input.endImageUrl);
  if (start)
    frames.push({ kind: 'image', url: start, label: 'Start', tag: null });
  if (end) frames.push({ kind: 'image', url: end, label: 'End', tag: null });
  return [
    ...frames,
    ...tagged('image', strings(input.referenceImages), 'Image'),
    ...tagged('video', strings(input.referenceVideos), 'Video'),
    ...tagged('audio', strings(input.referenceAudio), 'Audio'),
  ];
}

const MODE_FACT: Record<StudioVideoMode, string> = {
  text: 'Text to video',
  reference: 'Reference to video',
  frames: 'Image to video',
};

function videoMode(value: JsonValue | undefined): StudioVideoMode | null {
  return VIDEO_MODES.find((mode) => mode === value) ?? null;
}

export function studioGenerationFacts(asset: GeneratedAsset): string[] {
  const facts: string[] = [studioAspectRatio(asset)];
  const resolution = asset.input.resolution;
  if (typeof resolution === 'string') {
    facts.push(
      RESOLUTION_OPTIONS.find((option) => option.value === resolution)?.label ??
        resolution
    );
  }
  const duration = asset.input.duration;
  if (
    typeof duration === 'number' &&
    Number.isFinite(duration) &&
    duration > 0
  ) {
    facts.push(`${duration}s`);
  }
  const mode = videoMode(asset.input.mode);
  if (mode) facts.push(MODE_FACT[mode]);
  if (asset.input.draft === true) facts.push('Draft');
  if (asset.input.generateAudio === true) facts.push('With audio');
  if (asset.input.generateAudio === false) facts.push('Silent');
  return facts;
}

/** Settings to load back into the composer. Null when there is no prompt. */
export function studioReuse(asset: GeneratedAsset): StudioReuse | null {
  const prompt = readableStudioPrompt(studioPrompt(asset)).trim();
  if (!prompt) return null;
  const input = asset.input;
  const duration = input.duration;
  const aspect = aspectRatioSchema.safeParse(input.aspectRatio);
  return {
    prompt,
    aspectRatio: aspect.success ? aspect.data : studioAspectRatio(asset),
    resolution: isResolution(input.resolution) ? input.resolution : null,
    imageModel: isValidTextToImageModel(input.imageModel)
      ? input.imageModel
      : null,
    videoModel: isValidImageToVideoModel(input.videoModel)
      ? input.videoModel
      : null,
    duration:
      typeof duration === 'number' && Number.isFinite(duration) && duration > 0
        ? duration
        : null,
    mode: videoMode(input.mode),
    generateAudio:
      typeof input.generateAudio === 'boolean' ? input.generateAudio : null,
    draft: typeof input.draft === 'boolean' ? input.draft : null,
    referenceImages: strings(input.referenceImages),
    referenceVideos: strings(input.referenceVideos),
    referenceAudio: strings(input.referenceAudio),
    startImageUrl: oneString(input.startImageUrl),
    endImageUrl: oneString(input.endImageUrl),
  };
}
