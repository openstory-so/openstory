/**
 * What a history row shows, read from an event's `data`: the sentence, the
 * lines under it (a setting's from → to, or the previous text of an edit),
 * the media it names, and which rows fold into one. Client-safe.
 */

import { GENERATION_STAGE_META, isGenerationStage } from '@/sequences/pipeline';
import { mediaModelName } from '@/sequences/model-label';
import type { HistorySettingKey } from '@/sequences/model-label';

/** What the inspector is showing. Omitted means the whole sequence. */
export type HistoryScope =
  | { readonly shotId: string }
  | { readonly sceneIds: readonly string[] };

export type HistoryChange = {
  label: string;
  /** Previous value, already named for a person. */
  from: string;
  /** Next value. Null when the event only kept the previous text. */
  to: string | null;
};

const SETTING_LABELS: Record<HistorySettingKey, string> = {
  styleId: 'Style',
  aspectRatio: 'Aspect ratio',
  imageModel: 'Image',
  videoModel: 'Video',
  musicModel: 'Music',
  analysisModel: 'Script',
  generationStopAt: 'Stops',
};

/** Previous text worth reading. Structural ids and hashes are not in here. */
const PREVIOUS_LABELS: Record<string, string> = {
  name: 'Name',
  age: 'Age',
  gender: 'Gender',
  ethnicity: 'Ethnicity',
  physicalDescription: 'Description',
  personality: 'Personality',
  movement: 'Movement',
  voiceOnly: 'Voice only',
  isPerson: 'Person',
  rendering: 'Rendering',
  consistencyTag: 'Tag',
  clothing: 'Clothing',
  standardClothing: 'Clothing',
  styling: 'Styling',
  voiceDescription: 'Voice',
  type: 'Type',
  description: 'Description',
  architecturalStyle: 'Architecture',
  keyFeatures: 'Features',
  ambiance: 'Ambiance',
  prompt: 'Prompt',
  tags: 'Tags',
  title: 'Title',
};

const CLIP = 96;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clip(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return 'empty';
  if (flat.length <= CLIP) return flat;
  return `${flat.slice(0, CLIP - 1)}…`;
}

function settingValue(
  field: HistorySettingKey,
  value: string | null,
  styleNames: ReadonlyMap<string, string>
): string {
  if (value == null || value.length === 0) return 'None';
  if (field === 'styleId') return styleNames.get(value) ?? 'Removed style';
  if (field === 'generationStopAt') {
    return isGenerationStage(value)
      ? GENERATION_STAGE_META[value].shortName
      : value;
  }
  if (
    field === 'imageModel' ||
    field === 'videoModel' ||
    field === 'musicModel' ||
    field === 'analysisModel'
  ) {
    return mediaModelName(value);
  }
  return value;
}

function isSettingField(value: string): value is HistorySettingKey {
  return value in SETTING_LABELS;
}

/** Style ids a settings change still needs a name for. */
export function styleIdsInHistoryData(data: unknown): string[] {
  if (!isRecord(data) || !Array.isArray(data.changes)) return [];
  const ids: string[] = [];
  for (const change of data.changes) {
    if (!isRecord(change) || change.field !== 'styleId') continue;
    if (typeof change.from === 'string' && change.from.length > 0) {
      ids.push(change.from);
    }
    if (typeof change.to === 'string' && change.to.length > 0) {
      ids.push(change.to);
    }
  }
  return ids;
}

function settingChanges(
  data: Record<string, unknown>,
  styleNames: ReadonlyMap<string, string>
): HistoryChange[] {
  if (!Array.isArray(data.changes)) return [];
  const lines: HistoryChange[] = [];
  for (const change of data.changes) {
    if (!isRecord(change) || typeof change.field !== 'string') continue;
    if (!isSettingField(change.field)) continue;
    const from = change.from;
    const to = change.to;
    lines.push({
      label: SETTING_LABELS[change.field],
      from: settingValue(
        change.field,
        typeof from === 'string' ? from : null,
        styleNames
      ),
      to: settingValue(
        change.field,
        typeof to === 'string' ? to : null,
        styleNames
      ),
    });
  }
  return lines;
}

function previousText(value: unknown): string | null {
  if (typeof value === 'string') return clip(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value == null) return 'empty';
  return null;
}

function previousChanges(data: Record<string, unknown>): HistoryChange[] {
  if (!isRecord(data.prevState)) return [];
  const lines: HistoryChange[] = [];
  for (const [key, label] of Object.entries(PREVIOUS_LABELS)) {
    if (!(key in data.prevState)) continue;
    const from = previousText(data.prevState[key]);
    if (from == null) continue;
    lines.push({ label, from, to: null });
  }
  return lines;
}

/** The file ids a generation event stored, when it stored them. */
export function mediaVersionIds(data: unknown): {
  versionId: string | null;
  prevVersionId: string | null;
} {
  if (!isRecord(data)) return { versionId: null, prevVersionId: null };
  const id = (key: string): string | null => {
    const value = data[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  return {
    versionId: id('versionId'),
    prevVersionId: id('prevVersionId'),
  };
}

/**
 * The sentence a person reads. Stored summaries name the model by its key
 * (`minimax_h3_max`); the catalogue name replaces that key at read time.
 */
export function displaySummary(summary: string, data: unknown): string {
  if (!isRecord(data) || typeof data.model !== 'string' || data.model === '') {
    return summary;
  }
  return summary.replaceAll(data.model, mediaModelName(data.model));
}

/**
 * Diff lines for one event. A stored from/to wins. Otherwise the previous
 * text of an edit, which is all that row kept.
 */
export function historyChanges(
  data: unknown,
  styleNames: ReadonlyMap<string, string> = new Map()
): HistoryChange[] {
  if (!isRecord(data)) return [];
  const settings = settingChanges(data, styleNames);
  if (settings.length > 0) return settings;
  return previousChanges(data);
}

type ClipEvent = {
  id: string;
  kind: string;
  targetId: string;
  versionId: string | null;
  previousPreview: { url: string; model: string } | null;
};

/**
 * A finished primary render logs the file and then selects that same file.
 * Those are one action. A later pick of an older clip stays, and so does a
 * render that never became the shot's clip.
 *
 * `events` is newest first. The kept row is the render. It takes the
 * selection's previous still when the render did not store one.
 */
export function hideAutoSelectedRenders<T extends ClipEvent>(
  events: readonly T[]
): T[] {
  const hidden = new Set<string>();
  const previousByRender = new Map<string, T['previousPreview']>();
  for (let i = 0; i < events.length; i++) {
    const selected = events[i];
    if (
      !selected ||
      selected.kind !== 'video.selected' ||
      !selected.versionId
    ) {
      continue;
    }
    let olderIndex = i + 1;
    while (
      olderIndex < events.length &&
      events[olderIndex]?.targetId !== selected.targetId
    ) {
      olderIndex++;
    }
    const rendered = events[olderIndex];
    if (
      rendered?.kind !== 'video.rendered' ||
      rendered.versionId !== selected.versionId
    ) {
      continue;
    }
    hidden.add(selected.id);
    if (selected.previousPreview && !rendered.previousPreview) {
      previousByRender.set(rendered.id, selected.previousPreview);
    }
  }
  return events.flatMap((event) => {
    if (hidden.has(event.id)) return [];
    const previousPreview = previousByRender.get(event.id);
    if (!previousPreview) return [event];
    return [{ ...event, previousPreview }];
  });
}
