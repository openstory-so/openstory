/**
 * Display names for activity-log lines. Catalogues are client-safe; the
 * summary a person reads must not be a provider slug.
 */

import {
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
} from '@/models/models';
import { getAnalysisModelById } from '@/models/models.config';
import {
  GENERATION_STAGE_META,
  isGenerationStage,
  type GenerationStage,
} from '@/sequences/pipeline';

const named = (catalog: object, key: string): string | undefined => {
  const row = Object.entries(catalog).find(([id]) => id === key)?.[1];
  if (
    row !== null &&
    typeof row === 'object' &&
    'name' in row &&
    typeof row.name === 'string'
  ) {
    return row.name;
  }
  return undefined;
};

/** A model key's catalogue name, or the key with underscores read as spaces. */
export function mediaModelName(key: string): string {
  return (
    named(IMAGE_MODELS, key) ??
    named(IMAGE_TO_VIDEO_MODELS, key) ??
    named(AUDIO_MODELS, key) ??
    getAnalysisModelById(key)?.name ??
    key.replaceAll('_', ' ')
  );
}

/** History line for a sheet run that has taken its claim. */
export function sheetStartedSummary(name: string, model: string): string {
  return `Started a sheet for ${name} with ${mediaModelName(model)}`;
}

/** History line for a sheet that landed. */
export function sheetGeneratedSummary(name: string, model: string): string {
  return `Generated a sheet for ${name} with ${mediaModelName(model)}`;
}

/** Settings whose changes get a history line. Model keys are NOT staleness labels. */
const HISTORY_SETTING_KEYS = [
  'styleId',
  'aspectRatio',
  'imageModel',
  'videoModel',
  'musicModel',
  'analysisModel',
  'generationStopAt',
] as const;

export type HistorySettingKey = (typeof HISTORY_SETTING_KEYS)[number];

/** Raw from/to stored on `sequence.settings-changed`. Names are resolved at read. */
export type SettingsFieldChange = {
  field: HistorySettingKey;
  from: string | null;
  to: string | null;
};

type HistorySettingValues = {
  styleId: string | null;
  aspectRatio: string;
  imageModel: string;
  videoModel: string;
  musicModel: string | null;
  analysisModel: string;
  generationStopAt: GenerationStage | null;
};

/**
 * One sentence per field whose stored value actually moved. Empty when the
 * write repeats the current row (a storyboard step re-sends `generationStopAt`
 * on every run).
 */
export function describeSettingsChange(
  before: HistorySettingValues,
  values: Partial<HistorySettingValues>
): {
  fields: HistorySettingKey[];
  changes: SettingsFieldChange[];
  summary: string;
} | null {
  const sentences: string[] = [];
  const fields: HistorySettingKey[] = [];
  const changes: SettingsFieldChange[] = [];
  const changed = (key: HistorySettingKey): boolean =>
    key in values && values[key] !== before[key];
  const note = (field: HistorySettingKey) => {
    fields.push(field);
    const from = before[field];
    const to = values[field];
    changes.push({
      field,
      from: from == null ? null : String(from),
      to: to == null ? null : String(to),
    });
  };

  if (changed('styleId')) {
    note('styleId');
    sentences.push('Changed the style');
  }
  if (changed('aspectRatio') && values.aspectRatio) {
    note('aspectRatio');
    sentences.push(`Changed aspect ratio to ${values.aspectRatio}`);
  }
  if (changed('imageModel') && values.imageModel) {
    note('imageModel');
    sentences.push(
      `Changed the image model to ${mediaModelName(values.imageModel)}`
    );
  }
  if (changed('videoModel') && values.videoModel) {
    note('videoModel');
    sentences.push(
      `Changed the video model to ${mediaModelName(values.videoModel)}`
    );
  }
  if (changed('musicModel') && values.musicModel) {
    note('musicModel');
    sentences.push(
      `Changed the music model to ${mediaModelName(values.musicModel)}`
    );
  }
  if (changed('analysisModel') && values.analysisModel) {
    note('analysisModel');
    sentences.push(
      `Changed the analysis model to ${mediaModelName(values.analysisModel)}`
    );
  }
  if (changed('generationStopAt') && values.generationStopAt) {
    const stop = values.generationStopAt;
    if (isGenerationStage(stop)) {
      note('generationStopAt');
      sentences.push(
        `Changed where generation stops to ${GENERATION_STAGE_META[stop].shortName}`
      );
    }
  }
  if (sentences.length === 0) return null;
  return { fields, changes, summary: sentences.join('. ') };
}
