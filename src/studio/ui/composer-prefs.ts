/**
 * The Studio composer's last settings, per activity. A user who turned
 * "Draft first" off kept getting drafts after a reload, because every visit
 * started from the defaults. This remembers model, aspect, resolution,
 * length, audio, draft and count in this browser.
 *
 * localStorage, not the server: it is a per-viewer convenience. Every read
 * and write is wrapped, and a bad or stale field is dropped on its own, so a
 * retired model id never blocks the rest.
 */
import { aspectRatioSchema, type AspectRatio } from '@/models/aspect-ratios';
import {
  isValidImageToVideoModel,
  isValidTextToImageModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/models/models';
import { isResolution, type Resolution } from '@/models/resolutions';
import type { StudioDuration } from '@/studio/text-to-video';

export type StudioComposerPrefs = {
  imageModel?: TextToImageModel;
  videoModel?: ImageToVideoModel;
  aspectRatio?: AspectRatio;
  resolution?: Resolution;
  count?: 1 | 2 | 4;
  duration?: StudioDuration;
  generateAudio?: boolean;
  draft?: boolean;
};

const storageKey = (activity: 'image' | 'video') =>
  `openstory_studio_composer_${activity}_v1`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keeps only the fields that still parse. */
export function parseStudioComposerPrefs(raw: unknown): StudioComposerPrefs {
  if (!isRecord(raw)) return {};
  const prefs: StudioComposerPrefs = {};
  if (isValidTextToImageModel(raw.imageModel))
    prefs.imageModel = raw.imageModel;
  if (isValidImageToVideoModel(raw.videoModel))
    prefs.videoModel = raw.videoModel;
  const aspect = aspectRatioSchema.safeParse(raw.aspectRatio);
  if (aspect.success) prefs.aspectRatio = aspect.data;
  if (isResolution(raw.resolution)) prefs.resolution = raw.resolution;
  if (raw.count === 1 || raw.count === 2 || raw.count === 4)
    prefs.count = raw.count;
  if (
    raw.duration === 'auto' ||
    (typeof raw.duration === 'number' &&
      Number.isFinite(raw.duration) &&
      raw.duration > 0)
  )
    prefs.duration = raw.duration;
  if (typeof raw.generateAudio === 'boolean')
    prefs.generateAudio = raw.generateAudio;
  if (typeof raw.draft === 'boolean') prefs.draft = raw.draft;
  return prefs;
}

export function loadStudioComposerPrefs(
  activity: 'image' | 'video'
): StudioComposerPrefs {
  try {
    const raw = window.localStorage.getItem(storageKey(activity));
    return raw ? parseStudioComposerPrefs(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function saveStudioComposerPrefs(
  activity: 'image' | 'video',
  prefs: StudioComposerPrefs
): void {
  try {
    window.localStorage.setItem(storageKey(activity), JSON.stringify(prefs));
  } catch {
    // Private window or blocked storage: the composer still works.
  }
}
