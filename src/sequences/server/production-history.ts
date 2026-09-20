import { z } from 'zod';
import { createSelectSchema } from 'drizzle-orm/zod';
import {
  frameVariants,
  videoVariants,
  characterSheetVariants,
  locationSheetVariants,
  sequenceMusicVariants,
  framePromptVersions,
  shotPromptVersions,
  sequenceMusicPromptVersions,
  sceneScriptVersions,
} from '@/platform/server/db/schema';
import { projectRead, readDate } from '@/platform/server/read-projection';
import { readPage } from '@/platform/server/read-page';
import type { PageInput } from '@/platform/server/read-page';
import type { VersionListOptions } from '@/platform/server/db/read-page';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { NotFoundError, ValidationError } from '@/platform/errors';
import { productionAccess } from './production-access';

export const versionKindSchema = z.enum([
  'image',
  'video',
  'character_sheet',
  'location_sheet',
  'music',
  'visual_prompt',
  'motion_prompt',
  'music_prompt',
  'scene_script',
]);
type VersionKind = z.infer<typeof versionKindSchema>;
export const versionSummarySchema = z.object({
  id: z.string(),
  kind: versionKindSchema,
  entityId: z.string(),
  selected: z.boolean(),
  createdAt: readDate,
  model: z.string().nullable(),
  status: z.string(),
  url: z.string().nullable(),
  error: z.string().nullable(),
  discardedAt: readDate.nullable(),
});
function inspectVersionSummary(
  row: {
    id: string;
    kind: VersionKind;
    entityId: string;
    selected: boolean;
    createdAt: Date;
    model?: string;
    analysisModel?: string | null;
    status?: string;
    url?: string | null;
    error?: string | null;
    discardedAt?: Date | null;
  },
  origin: string
) {
  return projectRead(
    versionSummarySchema,
    {
      ...row,
      model: row.model ?? row.analysisModel ?? null,
      status: row.status ?? 'completed',
      url: row.url ?? null,
      error: row.error ?? null,
      discardedAt: row.discardedAt ?? null,
    },
    origin
  );
}
const frameVariantsReadSchema = createSelectSchema(frameVariants)
  .pick({
    id: true,
    frameId: true,
    sequenceId: true,
    kind: true,
    model: true,
    resolution: true,
    sourceVariantId: true,
    url: true,
    status: true,
    workflowRunId: true,
    generatedAt: true,
    error: true,
    promptHash: true,
    inputHash: true,
    dependsOnVersionId: true,
    promptVersionId: true,
    discardedAt: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    createdAt: readDate,
    updatedAt: readDate,
    generatedAt: readDate.nullable(),
    discardedAt: readDate.nullable(),
  });
const videoVariantsReadSchema = createSelectSchema(videoVariants)
  .pick({
    id: true,
    renderSegmentId: true,
    sequenceId: true,
    model: true,
    resolution: true,
    manifest: true,
    url: true,
    status: true,
    workflowRunId: true,
    generatedAt: true,
    error: true,
    isPrimary: true,
    inputHash: true,
    discardedAt: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    createdAt: readDate,
    updatedAt: readDate,
    generatedAt: readDate.nullable(),
    discardedAt: readDate.nullable(),
    manifest: z.json(),
  });
const characterSheetVariantsReadSchema = createSelectSchema(
  characterSheetVariants
)
  .pick({
    id: true,
    characterId: true,
    model: true,
    url: true,
    status: true,
    workflowRunId: true,
    generatedAt: true,
    error: true,
    inputHash: true,
    divergedAt: true,
    discardedAt: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    createdAt: readDate,
    updatedAt: readDate,
    generatedAt: readDate.nullable(),
    discardedAt: readDate.nullable(),
    divergedAt: readDate.nullable(),
  });
const locationSheetVariantsReadSchema = createSelectSchema(
  locationSheetVariants
)
  .pick({
    id: true,
    parentType: true,
    parentId: true,
    model: true,
    url: true,
    status: true,
    workflowRunId: true,
    generatedAt: true,
    error: true,
    inputHash: true,
    divergedAt: true,
    discardedAt: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    createdAt: readDate,
    updatedAt: readDate,
    generatedAt: readDate.nullable(),
    discardedAt: readDate.nullable(),
    divergedAt: readDate.nullable(),
  });
const sequenceMusicVariantsReadSchema = createSelectSchema(
  sequenceMusicVariants
)
  .pick({
    id: true,
    sequenceId: true,
    url: true,
    loudnessGainDb: true,
    prompt: true,
    tags: true,
    durationSeconds: true,
    model: true,
    status: true,
    workflowRunId: true,
    generatedAt: true,
    error: true,
    inputHash: true,
    divergedAt: true,
    discardedAt: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    createdAt: readDate,
    updatedAt: readDate,
    generatedAt: readDate.nullable(),
    discardedAt: readDate.nullable(),
    divergedAt: readDate.nullable(),
    // Declared integer() but holds the provider-measured length, which is
    // fractional — the generated validator would reject a real track.
    durationSeconds: z.number().nullable(),
  });
const framePromptVersionsReadSchema = createSelectSchema(framePromptVersions)
  .pick({
    id: true,
    frameId: true,
    text: true,
    components: true,
    source: true,
    inputHash: true,
    analysisModel: true,
    status: true,
    workflowRunId: true,
    createdAt: true,
    createdBy: true,
  })
  .extend({ createdAt: readDate, components: z.json().nullable() });
const shotPromptVersionsReadSchema = createSelectSchema(shotPromptVersions)
  .pick({
    id: true,
    shotId: true,
    promptType: true,
    text: true,
    components: true,
    parameters: true,
    dialogue: true,
    audio: true,
    source: true,
    audioClips: true,
    usesStartFrame: true,
    inputHash: true,
    analysisModel: true,
    status: true,
    workflowRunId: true,
    createdAt: true,
    createdBy: true,
  })
  .extend({
    createdAt: readDate,
    components: z.json().nullable(),
    parameters: z.json().nullable(),
    dialogue: z.json().nullable(),
    audio: z.json().nullable(),
    audioClips: z.json().nullable(),
  });
const sequenceMusicPromptVersionsReadSchema = createSelectSchema(
  sequenceMusicPromptVersions
)
  .pick({
    id: true,
    sequenceId: true,
    promptType: true,
    prompt: true,
    tags: true,
    source: true,
    inputHash: true,
    analysisModel: true,
    createdAt: true,
    createdBy: true,
  })
  .extend({ createdAt: readDate });
const sceneScriptVersionsReadSchema = createSelectSchema(sceneScriptVersions)
  .pick({
    id: true,
    sceneId: true,
    content: true,
    source: true,
    createdAt: true,
    createdBy: true,
  })
  .extend({ createdAt: readDate, content: z.json() });

type Access = ReturnType<typeof productionAccess>;
type VersionRow = Omit<
  Parameters<typeof inspectVersionSummary>[0],
  'kind' | 'entityId' | 'selected'
>;
type VersionInput = { sequenceId: string; kind: VersionKind; entityId: string };

/**
 * One history kind: which production entity owns it, the editor's own list and
 * get reads for it, and what "selected" means. `get` must scope the row to its
 * parent — the id-only getters carry no ownership check of their own.
 */
function versionKind<P extends { id: string }, R extends VersionRow>(def: {
  parent: (access: Access, input: VersionInput) => Promise<P>;
  list: (
    scopedDb: ScopedDb,
    parent: P,
    options: Required<VersionListOptions>
  ) => Promise<R[]>;
  get: (scopedDb: ScopedDb, parent: P, versionId: string) => Promise<R | null>;
  selected: (row: R, parent: P) => boolean;
  schema: z.ZodType<object>;
}) {
  return {
    async list(
      scopedDb: ScopedDb,
      input: VersionInput & PageInput & { includeDiscarded: boolean },
      origin: string
    ) {
      const parent = await def.parent(productionAccess(scopedDb), input);
      const page = await readPage(
        input,
        [
          input.sequenceId,
          input.kind,
          input.entityId,
          String(input.includeDiscarded),
        ],
        (next) =>
          def.list(scopedDb, parent, {
            includeDiscarded: input.includeDiscarded,
            page: next,
          })
      );
      return {
        versions: page.items.map((row) =>
          inspectVersionSummary(
            {
              ...row,
              kind: input.kind,
              entityId: parent.id,
              selected: def.selected(row, parent),
            },
            origin
          )
        ),
        nextCursor: page.nextCursor,
      };
    },
    async get(
      scopedDb: ScopedDb,
      input: VersionInput & { versionId: string },
      origin: string
    ) {
      const parent = await def.parent(productionAccess(scopedDb), input);
      const row = await def.get(scopedDb, parent, input.versionId);
      if (!row)
        throw new NotFoundError(
          'Version not found for this production entity.'
        );
      return {
        selected: def.selected(row, parent),
        ...projectRead(def.schema, row, origin),
      };
    },
  };
}

/** Music histories hang off the sequence itself. */
function sequenceParent(access: Access, input: VersionInput) {
  if (input.entityId !== input.sequenceId)
    throw new ValidationError(
      'Music histories use the sequence ID as entityId.'
    );
  return access.sequence(input.sequenceId);
}

const VERSION_KINDS = {
  image: versionKind({
    parent: (access, i) => access.frame(i.sequenceId, i.entityId),
    list: (db, frame, options) =>
      db.frameVariants.listByFrame(frame.id, options),
    get: async (db, frame, id) => {
      const row = await db.frameVariants.getById(id);
      return row?.frameId === frame.id ? row : null;
    },
    selected: (row, frame) => row.id === frame.selectedImageVersionId,
    schema: frameVariantsReadSchema,
  }),
  video: versionKind({
    parent: (access, i) => access.segment(i.sequenceId, i.entityId),
    list: (db, segment, options) =>
      db.videoVariants.listBySegment(segment.id, options),
    get: async (db, segment, id) => {
      const row = await db.videoVariants.getById(id);
      return row?.renderSegmentId === segment.id ? row : null;
    },
    selected: (row, segment) => row.id === segment.selectedVideoVersionId,
    schema: videoVariantsReadSchema,
  }),
  character_sheet: versionKind({
    parent: (access, i) => access.character(i.sequenceId, i.entityId),
    list: (db, character, options) =>
      db.characterSheetVariants.listByCharacter(character.id, options),
    get: async (db, character, id) => {
      const row = await db.characterSheetVariants.getById(id);
      return row?.characterId === character.id ? row : null;
    },
    // A pre-versioning sheet is the row keyed to the character's own id (#1419).
    selected: (row, character) =>
      row.id === (character.selectedSheetVersionId ?? character.id),
    schema: characterSheetVariantsReadSchema,
  }),
  location_sheet: versionKind({
    parent: (access, i) => access.location(i.sequenceId, i.entityId),
    list: (db, location, options) =>
      db.locationSheetVariants.listByParent(
        'sequence_location',
        location.id,
        options
      ),
    get: async (db, location, id) => {
      const row = await db.locationSheetVariants.getById(id);
      return row?.parentType === 'sequence_location' &&
        row.parentId === location.id
        ? row
        : null;
    },
    selected: (row, location) =>
      row.id === (location.selectedReferenceVersionId ?? location.id),
    schema: locationSheetVariantsReadSchema,
  }),
  music: versionKind({
    parent: sequenceParent,
    list: (db, sequence, options) =>
      db.sequenceVariants.listMusicBySequence(sequence.id, options),
    get: async (db, sequence, id) => {
      const row = await db.sequenceVariants.getMusicById(id);
      return row?.sequenceId === sequence.id ? row : null;
    },
    selected: (row, sequence) =>
      row.url !== null &&
      row.url === sequence.musicUrl &&
      row.model === sequence.musicModel,
    schema: sequenceMusicVariantsReadSchema,
  }),
  visual_prompt: versionKind({
    parent: (access, i) => access.frame(i.sequenceId, i.entityId),
    list: (db, frame, { page }) =>
      db.framePromptVersions.listByFrame(frame.id, page),
    get: (db, frame, id) =>
      db.framePromptVersions.getByIdForFrame(id, frame.id),
    selected: (row, frame) => row.id === frame.selectedImagePromptVersionId,
    schema: framePromptVersionsReadSchema,
  }),
  motion_prompt: versionKind({
    parent: (access, i) => access.shot(i.sequenceId, i.entityId),
    list: (db, shot, { page }) =>
      db.shotPromptVersions.listByShot(shot.id, 'motion', page),
    get: async (db, shot, id) => {
      const row = await db.shotPromptVersions.getByIdForShot(id, shot.id);
      return row?.promptType === 'motion' ? row : null;
    },
    selected: (row, shot) => row.id === shot.selectedMotionPromptVersionId,
    schema: shotPromptVersionsReadSchema,
  }),
  music_prompt: versionKind({
    parent: sequenceParent,
    list: (db, sequence, { page }) =>
      db.sequenceMusicPromptVersions.listBySequence(sequence.id, page),
    get: (db, sequence, id) =>
      db.sequenceMusicPromptVersions.getByIdForSequence(id, sequence.id),
    selected: (row, sequence) =>
      row.prompt === sequence.musicPrompt && row.tags === sequence.musicTags,
    schema: sequenceMusicPromptVersionsReadSchema,
  }),
  scene_script: versionKind({
    parent: (access, i) => access.scene(i.sequenceId, i.entityId),
    list: (db, scene, { page }) =>
      db.sceneScriptVersions.listByScene(scene.id, page),
    get: (db, scene, id) =>
      db.sceneScriptVersions.getByIdForScene(id, scene.id),
    selected: (row, scene) => row.id === scene.selectedScriptVersionId,
    schema: sceneScriptVersionsReadSchema,
  }),
} satisfies Record<VersionKind, ReturnType<typeof versionKind>>;

export function listVersions(
  scopedDb: ScopedDb,
  input: VersionInput & PageInput & { includeDiscarded: boolean },
  origin: string
) {
  return VERSION_KINDS[input.kind].list(scopedDb, input, origin);
}

export function readVersion(
  scopedDb: ScopedDb,
  input: VersionInput & { versionId: string },
  origin: string
) {
  return VERSION_KINDS[input.kind].get(scopedDb, input, origin);
}
