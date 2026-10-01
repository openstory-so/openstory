/**
 * Readers for child-workflow JSON.
 *
 * `spawnAndAwaitChild` recovers a timed-out child from `instance.status().output`,
 * which is JSON, and the wake event's payload is JSON too. A reader checks that
 * value and returns the type the parent asked for. `readUnknown` is the reader
 * for a parent that does not use the output.
 */

import type { MotionAudioClip } from '@/platform/server/db/schema/shot-prompt-versions';
import type {
  CharacterSheetWorkflowResult,
  CharacterVoiceWorkflowResult,
  DialogueAudioWorkflowResult,
  LocationSheetWorkflowResult,
  MotionWorkflowResult,
  MusicWorkflowResult,
} from '@/platform/server/workflow/types';

export function readUnknown(value: unknown): unknown {
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function recordOf(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function has(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key) && record[key] !== undefined;
}

export function requiredString(
  record: Record<string, unknown>,
  key: string
): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

export function optionalString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  if (!has(record, key)) return undefined;
  return requiredString(record, key);
}

export function nullableString(
  record: Record<string, unknown>,
  key: string
): string | null {
  if (!Object.hasOwn(record, key)) throw new Error(`${key} is required`);
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string or null`);
  }
  return value;
}

export function optionalNullableString(
  record: Record<string, unknown>,
  key: string
): string | null | undefined {
  if (!has(record, key)) return undefined;
  return nullableString(record, key);
}

function requiredBoolean(
  record: Record<string, unknown>,
  key: string
): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
  return value;
}

export function optionalBoolean(
  record: Record<string, unknown>,
  key: string
): boolean | undefined {
  if (!has(record, key)) return undefined;
  return requiredBoolean(record, key);
}

export function requiredNumber(
  record: Record<string, unknown>,
  key: string
): number {
  const value = record[key];
  if (typeof value !== 'number') throw new Error(`${key} must be a number`);
  return value;
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string
): number | undefined {
  if (!has(record, key)) return undefined;
  return requiredNumber(record, key);
}

export function nullableNumber(
  record: Record<string, unknown>,
  key: string
): number | null {
  if (!Object.hasOwn(record, key)) throw new Error(`${key} is required`);
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'number') {
    throw new Error(`${key} must be a number or null`);
  }
  return value;
}

export function stringEnum<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  key: string
): T {
  const match = allowed.find((item) => item === value);
  if (match === undefined) {
    throw new Error(`${key} must be one of ${allowed.join(', ')}`);
  }
  return match;
}

export function readArray<T>(
  value: unknown,
  readItem: (item: unknown) => T,
  label: string
): T[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item) => readItem(item));
}

export function withOptional<K extends string, V>(
  key: K,
  value: V | undefined
): { [P in K]?: V } {
  const out: { [P in K]?: V } = {};
  if (value !== undefined) out[key] = value;
  return out;
}

export function readMotionWorkflowResult(value: unknown): MotionWorkflowResult {
  const record = recordOf(value, 'motion result');
  return {
    videoUrl: requiredString(record, 'videoUrl'),
    ...withOptional('duration', optionalNumber(record, 'duration')),
  };
}

export function readMusicWorkflowResult(value: unknown): MusicWorkflowResult {
  const record = recordOf(value, 'music result');
  return {
    audioUrl: requiredString(record, 'audioUrl'),
    ...withOptional('duration', optionalNumber(record, 'duration')),
  };
}

export function readCharacterVoiceWorkflowResult(
  value: unknown
): CharacterVoiceWorkflowResult {
  const record = recordOf(value, 'character voice result');
  return {
    voiceId: nullableString(record, 'voiceId'),
    voiceDescription: requiredString(record, 'voiceDescription'),
  };
}

export function readCharacterSheetWorkflowResult(
  value: unknown
): CharacterSheetWorkflowResult {
  const record = recordOf(value, 'character sheet result');
  return {
    sheetImageUrl: requiredString(record, 'sheetImageUrl'),
    ...withOptional('characterDbId', optionalString(record, 'characterDbId')),
    ...withOptional('sheetImagePath', optionalString(record, 'sheetImagePath')),
    ...withOptional(
      'sheetVersionId',
      optionalNullableString(record, 'sheetVersionId')
    ),
    ...withOptional('diverged', optionalBoolean(record, 'diverged')),
  };
}

export function readLocationSheetWorkflowResult(
  value: unknown
): LocationSheetWorkflowResult {
  const record = recordOf(value, 'location sheet result');
  return {
    referenceImageUrl: requiredString(record, 'referenceImageUrl'),
    ...withOptional('locationDbId', optionalString(record, 'locationDbId')),
    ...withOptional(
      'referenceImagePath',
      optionalString(record, 'referenceImagePath')
    ),
    ...withOptional(
      'sheetVersionId',
      optionalNullableString(record, 'sheetVersionId')
    ),
    ...withOptional('diverged', optionalBoolean(record, 'diverged')),
  };
}

function readSpokenLine(value: unknown): { index: number; text: string } {
  const record = recordOf(value, 'spoken line');
  return {
    index: requiredNumber(record, 'index'),
    text: requiredString(record, 'text'),
  };
}

function readMotionAudioClip(value: unknown): MotionAudioClip {
  const record = recordOf(value, 'dialogue clip');
  const spokenLines = has(record, 'spokenLines')
    ? readArray(record.spokenLines, readSpokenLine, 'spokenLines')
    : undefined;
  return {
    id: requiredString(record, 'id'),
    url: requiredString(record, 'url'),
    token: requiredString(record, 'token'),
    durationSeconds: nullableNumber(record, 'durationSeconds'),
    ...withOptional('sourceKey', optionalString(record, 'sourceKey')),
    ...withOptional('spokenLines', spokenLines),
    ...withOptional('speechId', optionalString(record, 'speechId')),
    ...withOptional('recordingId', optionalString(record, 'recordingId')),
  };
}

export function readDialogueAudioWorkflowResult(
  value: unknown
): DialogueAudioWorkflowResult {
  const record = recordOf(value, 'dialogue audio result');
  const clips = recordOf(record.clipsByShotId, 'clipsByShotId');
  const clipsByShotId: Record<string, MotionAudioClip[]> = {};
  for (const [shotId, shotClips] of Object.entries(clips)) {
    clipsByShotId[shotId] = readArray(
      shotClips,
      readMotionAudioClip,
      `clipsByShotId.${shotId}`
    );
  }
  return { clipsByShotId };
}

function readStringEntry(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} entries must be strings`);
  }
  return value;
}

export function readRegenerateShotsChildResult(value: unknown): {
  totalShots: number;
  successCount: number;
  failedShots: string[];
  divergedShotIds: string[];
} {
  const record = recordOf(value, 'regenerate shots result');
  return {
    totalShots: requiredNumber(record, 'totalShots'),
    successCount: requiredNumber(record, 'successCount'),
    failedShots: readArray(
      record.failedShots,
      (item) => readStringEntry(item, 'failedShots'),
      'failedShots'
    ),
    divergedShotIds: readArray(
      record.divergedShotIds,
      (item) => readStringEntry(item, 'divergedShotIds'),
      'divergedShotIds'
    ),
  };
}

export function readImageChildOutput(value: unknown): {
  imageUrl: string;
  shotId?: string;
  sequenceId?: string;
  frameVersionId?: string | null;
  cancelled?: boolean;
} {
  const record = recordOf(value, 'image result');
  return {
    imageUrl: requiredString(record, 'imageUrl'),
    ...withOptional('shotId', optionalString(record, 'shotId')),
    ...withOptional('sequenceId', optionalString(record, 'sequenceId')),
    ...withOptional(
      'frameVersionId',
      optionalNullableString(record, 'frameVersionId')
    ),
    ...withOptional('cancelled', optionalBoolean(record, 'cancelled')),
  };
}
