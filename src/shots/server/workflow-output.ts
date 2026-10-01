/**
 * Readers for child-workflow results whose JSON includes scenes, bibles, or
 * prompts. Platform stays domain-blind, so those checks live here.
 */

import { z } from 'zod';
import { ELEMENT_KINDS } from '@/cast/element-kind';
import type { SequenceElementMinimal } from '@/platform/server/db/schema/sequence-elements';
import {
  readArray,
  recordOf,
  requiredString,
  stringEnum,
  nullableString,
  nullableNumber,
  optionalBoolean,
  optionalNullableString,
  optionalString,
  withOptional,
} from '@/platform/server/workflow/child-output';
import type {
  ElementSheetWorkflowResult,
  LocationMatchingWorkflowOutput,
  MusicPromptWorkflowResult,
  SceneSplitWorkflowResult,
  ShotSpecRewriteWorkflowResult,
  TalentCharacterMatch,
  TalentMatchingWorkflowOutput,
} from '@/platform/server/workflow/types';
import { musicDesignResultSchema } from '@/sequences/response-schemas';
import {
  readCharacterBibleEntry,
  readElementBibleEntry,
  readLocationBibleEntry,
  sceneSchema,
  storedDialogueLineSchema,
  type Scene,
} from '@/shots/scene-analysis.schema';
import { shotSpecSchema } from '@/shots/shot-list.schema';

const storedSceneSchema = sceneSchema.extend({
  originalScript: z.object({
    extract: z.string(),
    dialogue: z.array(storedDialogueLineSchema),
  }),
  shots: z.array(shotSpecSchema).optional(),
});

function readScene(value: unknown): Scene {
  return storedSceneSchema.parse(value);
}

function readScenes(value: unknown, label: string): Scene[] {
  return readArray(value, readScene, label);
}

function readStringRecord(
  value: unknown,
  label: string
): Record<string, string> {
  const record = recordOf(value, label);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== 'string') {
      throw new Error(`${label}.${key} must be a string`);
    }
    out[key] = item;
  }
  return out;
}

function readShotMappingEntry(
  value: unknown
): SceneSplitWorkflowResult['shotMapping'][number] {
  const record = recordOf(value, 'shot mapping');
  return {
    analysisSceneId: requiredString(record, 'analysisSceneId'),
    shotId: requiredString(record, 'shotId'),
    frameId: nullableString(record, 'frameId'),
    ...withOptional('shotNumber', optionalNumberFrom(record)),
  };
}

function optionalNumberFrom(
  record: Record<string, unknown>
): number | undefined {
  if (!Object.hasOwn(record, 'shotNumber') || record.shotNumber === undefined) {
    return undefined;
  }
  if (typeof record.shotNumber !== 'number') {
    throw new Error('shotNumber must be a number');
  }
  return record.shotNumber;
}

export function readSceneSplitWorkflowResult(
  value: unknown
): SceneSplitWorkflowResult {
  const record = recordOf(value, 'scene split result');
  return {
    scenes: readScenes(record.scenes, 'scenes'),
    title: requiredString(record, 'title'),
    shotMapping: readArray(
      record.shotMapping,
      readShotMappingEntry,
      'shotMapping'
    ),
    characterBible: readArray(
      record.characterBible,
      readCharacterBibleEntry,
      'characterBible'
    ),
    locationBible: readArray(
      record.locationBible,
      readLocationBibleEntry,
      'locationBible'
    ),
    elementBible: readArray(
      record.elementBible,
      readElementBibleEntry,
      'elementBible'
    ),
    dialogueVersionIdByShotId: readStringRecord(
      record.dialogueVersionIdByShotId,
      'dialogueVersionIdByShotId'
    ),
  };
}

function readTalentMatch(value: unknown): TalentCharacterMatch {
  const record = recordOf(value, 'talent match');
  const sheetMetadata =
    record.sheetMetadata === undefined
      ? undefined
      : readCharacterBibleEntry(record.sheetMetadata);
  return {
    characterId: requiredString(record, 'characterId'),
    talentId: requiredString(record, 'talentId'),
    talentName: requiredString(record, 'talentName'),
    sheetImageUrl: requiredString(record, 'sheetImageUrl'),
    ...withOptional('sheetMetadata', sheetMetadata),
    ...withOptional(
      'talentDescription',
      optionalString(record, 'talentDescription')
    ),
    personality: optionalString(record, 'personality') ?? '',
    movement: optionalString(record, 'movement') ?? '',
    voiceId: optionalNullableString(record, 'voiceId') ?? null,
    voiceDescription:
      optionalNullableString(record, 'voiceDescription') ?? null,
    ...withOptional(
      'hasSignedRelease',
      optionalBoolean(record, 'hasSignedRelease')
    ),
    ...withOptional(
      'sheetInputHash',
      optionalNullableString(record, 'sheetInputHash')
    ),
  };
}

export function readTalentMatchingWorkflowOutput(
  value: unknown
): TalentMatchingWorkflowOutput {
  const record = recordOf(value, 'talent matching result');
  return {
    matches: readArray(record.matches, readTalentMatch, 'matches'),
  };
}

export function readLocationMatchingWorkflowOutput(
  value: unknown
): LocationMatchingWorkflowOutput {
  const record = recordOf(value, 'location matching result');
  return {
    matches: readArray(record.matches, readLibraryLocationMatch, 'matches'),
  };
}

function readLibraryLocationMatch(
  value: unknown
): LocationMatchingWorkflowOutput['matches'][number] {
  const record = recordOf(value, 'location match');
  return {
    locationId: requiredString(record, 'locationId'),
    libraryLocationId: requiredString(record, 'libraryLocationId'),
    libraryLocationName: requiredString(record, 'libraryLocationName'),
    referenceImageUrl: requiredString(record, 'referenceImageUrl'),
    ...withOptional('description', optionalString(record, 'description')),
    ...withOptional(
      'referenceInputHash',
      optionalNullableString(record, 'referenceInputHash')
    ),
  };
}

function readSequenceElement(value: unknown): SequenceElementMinimal {
  const record = recordOf(value, 'element');
  return {
    id: requiredString(record, 'id'),
    token: requiredString(record, 'token'),
    description: nullableString(record, 'description'),
    imageUrl: nullableString(record, 'imageUrl'),
    consistencyTag: nullableString(record, 'consistencyTag'),
    kind: stringEnum(record.kind, ELEMENT_KINDS, 'kind'),
    durationSeconds: nullableNumber(record, 'durationSeconds'),
  };
}

export function readElementSheetWorkflowResult(
  value: unknown
): ElementSheetWorkflowResult {
  const record = recordOf(value, 'element sheet result');
  return {
    elements: readArray(record.elements, readSequenceElement, 'elements'),
  };
}

export function readMusicPromptWorkflowResult(
  value: unknown
): MusicPromptWorkflowResult {
  return musicDesignResultSchema.parse(value);
}

export function readShotSpecRewriteWorkflowResult(
  value: unknown
): ShotSpecRewriteWorkflowResult {
  const record = recordOf(value, 'shot spec rewrite result');
  return {
    specVersionId: nullableString(record, 'specVersionId'),
    visualVersionId: nullableString(record, 'visualVersionId'),
    motionVersionId: nullableString(record, 'motionVersionId'),
  };
}
