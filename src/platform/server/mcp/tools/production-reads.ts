import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import {
  projectRead,
  textWindowInput,
} from '@/platform/server/read-projection';
import {
  settingsSchema,
  readSequenceSettings,
  musicReadSchema,
  inspectMusic,
  frameReadSchema,
  segmentReadSchema,
  shotMembershipSchema,
  exportReadSchema,
  eventReadSchema,
  documentReadSchema,
  readDocument,
  audioClipSchema,
} from '@/sequences/server/production-inspection';
import {
  versionKindSchema,
  versionSummarySchema,
  listVersions,
  readVersion,
} from '@/sequences/server/production-history';
import { productionAccess } from '@/sequences/server/production-access';
import { composeSequenceScriptFromDb } from '@/shots/server/scene-script';
import { readPage } from '@/platform/server/read-page';
import { NotFoundError } from '@/platform/errors';
import {
  registerProductionRead,
  collectionInput,
  sequenceInput,
  type ReadToolContextFactory,
} from '../tool-context';

const documentInput = textWindowInput.extend({
  revision: z.string().length(64).optional(),
});
const versionInput = sequenceInput.extend({
  kind: versionKindSchema,
  entityId: ulidSchema,
});
const continuation = { nextCursor: z.string().nullable() };

/**
 * A version id is a ULID, except the preview stills backfilled by migration
 * 20260808025651, whose ids are `00` + the frame's ULID so they sort oldest.
 * list_versions hands those out, so get_version has to take them back.
 */
const versionIdSchema = z
  .string()
  .min(26)
  .max(28)
  .refine(
    (id) =>
      ulidSchema.safeParse(
        id.length === 28 && id.startsWith('00') ? id.slice(2) : id
      ).success,
    { message: 'Invalid version ID' }
  );

export function registerProductionReads(
  server: McpServer,
  context: ReadToolContextFactory
) {
  registerProductionRead(
    server,
    context,
    'get_sequence_settings',
    'Read sequence settings, pipeline stage, target duration, model defaults and effective style snapshot.',
    sequenceInput,
    z.object({ settings: settingsSchema }),
    async (input, { scopedDb, origin }) => ({
      settings: await readSequenceSettings(scopedDb, input.sequenceId, origin),
    })
  );
  registerProductionRead(
    server,
    context,
    'get_sequence_script',
    'Read the original or composed script in text windows. Composed uses active selected scene scripts and falls back to the original before scene scripts exist. Continue with nextOffset and revision; offsets are UTF-16 units.',
    sequenceInput.extend({
      mode: z.enum(['original', 'composed']).default('composed'),
      ...documentInput.shape,
    }),
    z.object({
      sequenceId: z.string(),
      mode: z.enum(['original', 'composed']),
      document: documentReadSchema,
    }),
    async (input, { scopedDb }) => {
      const sequence = await productionAccess(scopedDb).sequence(
        input.sequenceId
      );
      const original = sequence.script ?? '';
      // Same read and fallback as the editor's "Copy script".
      const text =
        input.mode === 'original'
          ? original
          : (await composeSequenceScriptFromDb(scopedDb, sequence.id)) ||
            original;
      return {
        sequenceId: sequence.id,
        mode: input.mode,
        document: await readDocument(text, input, 'text'),
      };
    }
  );
  registerProductionRead(
    server,
    context,
    'get_sequence_music',
    'Inspect current sequence music, enabled state, prompt, tags and generation result. Use list_versions kind music or music_prompt for histories; music selection is matched by output URL and model, not a stored version pointer.',
    sequenceInput,
    z.object({ music: musicReadSchema }),
    async (input, { scopedDb, origin }) => ({
      music: inspectMusic(
        await productionAccess(scopedDb).sequence(input.sequenceId),
        origin
      ),
    })
  );
  registerProductionRead(
    server,
    context,
    'list_frames',
    'Page every frame role for a shot by frame ID. orderIndex defines frame order; no missing frame is created. Use list_versions for image and visual_prompt histories.',
    collectionInput.extend({ shotId: ulidSchema }),
    z.object({ frames: z.array(frameReadSchema), ...continuation }),
    async (input, { scopedDb, origin }) => {
      await productionAccess(scopedDb).shot(input.sequenceId, input.shotId);
      const page = await readPage(
        input,
        [input.sequenceId, 'frames', input.shotId],
        (next) => scopedDb.frames.listByShot(input.shotId, next)
      );
      return {
        frames: page.items.map((row) =>
          projectRead(frameReadSchema, row, origin)
        ),
        nextCursor: page.nextCursor,
      };
    }
  );
  registerProductionRead(
    server,
    context,
    'get_frame',
    'Inspect a frame by database frameId, including role, selections, pending promotion and current image attempt.',
    sequenceInput.extend({ frameId: ulidSchema }),
    z.object({ frame: frameReadSchema }),
    async (input, { scopedDb, origin }) => ({
      frame: projectRead(
        frameReadSchema,
        await productionAccess(scopedDb).frame(input.sequenceId, input.frameId),
        origin
      ),
    })
  );
  registerProductionRead(
    server,
    context,
    'list_render_segments',
    'Page render segments by database ID, optionally within one scene. Each segment owns its video selection; use get_render_segment for member shots.',
    collectionInput.extend({ sceneId: ulidSchema.optional() }),
    z.object({ segments: z.array(segmentReadSchema), ...continuation }),
    async (input, { scopedDb, origin }) => {
      const access = productionAccess(scopedDb);
      const scene = input.sceneId
        ? await access.scene(input.sequenceId, input.sceneId)
        : null;
      if (!scene) await access.sequence(input.sequenceId);
      const page = await readPage(
        input,
        [input.sequenceId, 'segments', input.sceneId ?? ''],
        (next) =>
          scopedDb.renderSegments.listBySequence(input.sequenceId, {
            sceneId: scene?.id,
            liveScenesOnly: true,
            page: next,
          })
      );
      return {
        segments: page.items.map((row) =>
          projectRead(segmentReadSchema, row, origin)
        ),
        nextCursor: page.nextCursor,
      };
    }
  );
  registerProductionRead(
    server,
    context,
    'get_render_segment',
    'Inspect a render segment and page its current member shots by ID. shotNumber determines playback order. Use list_versions kind video for historical render manifests.',
    collectionInput.extend({ segmentId: ulidSchema }),
    z.object({
      segment: segmentReadSchema,
      shots: z.array(shotMembershipSchema),
      ...continuation,
    }),
    async (input, { scopedDb, origin }) => {
      const segment = await productionAccess(scopedDb).segment(
        input.sequenceId,
        input.segmentId
      );
      const page = await readPage(
        input,
        [input.sequenceId, 'segment-shots', segment.id],
        (next) =>
          scopedDb.shots.listBySequence(input.sequenceId, {
            sceneId: segment.sceneId,
            renderSegmentId: segment.id,
            page: next,
          })
      );
      return {
        segment: projectRead(segmentReadSchema, segment, origin),
        shots: page.items.map((row) =>
          projectRead(shotMembershipSchema, row, origin)
        ),
        nextCursor: page.nextCursor,
      };
    }
  );
  registerProductionRead(
    server,
    context,
    'list_versions',
    'Page production history by version ID, oldest ID first. entityId is a frame for image/visual_prompt, segment for video, character for character_sheet, sequence location for location_sheet, shot for motion_prompt, scene for scene_script, or sequenceId for music/music_prompt. Discarded versions are opt-in. get_version reads full content.',
    collectionInput.extend({
      kind: versionKindSchema,
      entityId: ulidSchema,
      includeDiscarded: z.boolean().default(false),
    }),
    z.object({ versions: z.array(versionSummarySchema), ...continuation }),
    (input, { scopedDb, origin }) => listVersions(scopedDb, input, origin)
  );
  registerProductionRead(
    server,
    context,
    'get_version',
    'Read one production version as a JSON document in bounded text windows, including prompts, audio, render manifests and provenance. Parent IDs follow list_versions. Concatenate document.text using nextOffset and revision before parsing JSON. Discarded versions remain addressable.',
    versionInput.extend({ versionId: versionIdSchema, ...documentInput.shape }),
    z.object({
      kind: versionKindSchema,
      entityId: z.string(),
      versionId: z.string(),
      selected: z.boolean(),
      document: documentReadSchema,
    }),
    async (input, { scopedDb, origin }) => {
      const version = await readVersion(scopedDb, input, origin);
      return {
        kind: input.kind,
        entityId: input.entityId,
        versionId: input.versionId,
        selected: version.selected,
        document: await readDocument(JSON.stringify(version), input, 'json'),
      };
    }
  );
  registerProductionRead(
    server,
    context,
    'get_shot_audio',
    'Read the shot working dialogue audio clips as a paged JSON document with playable URLs. Historical clips consumed by a render live in its motion_prompt version and video manifest. Continue using nextOffset and revision.',
    sequenceInput.extend({ shotId: ulidSchema, ...documentInput.shape }),
    z.object({ shotId: z.string(), document: documentReadSchema }),
    async (input, { scopedDb, origin }) => {
      const shot = await productionAccess(scopedDb).shot(
        input.sequenceId,
        input.shotId
      );
      const clips = projectRead(
        z.array(audioClipSchema),
        shot.audioClips ?? [],
        origin
      );
      return {
        shotId: shot.id,
        document: await readDocument(JSON.stringify(clips), input, 'json'),
      };
    }
  );
  registerProductionRead(
    server,
    context,
    'list_exports',
    'Page all existing sequence exports by ID, including processing and failed exports. Reads never enqueue, reuse or reconcile render work; sourceShotsHash identifies the exported cut.',
    collectionInput,
    z.object({ exports: z.array(exportReadSchema), ...continuation }),
    async (input, { scopedDb, origin }) => {
      await productionAccess(scopedDb).sequence(input.sequenceId);
      const page = await readPage(
        input,
        [input.sequenceId, 'exports'],
        (next) =>
          scopedDb.sequenceExports.listAllBySequence(input.sequenceId, next)
      );
      return {
        exports: page.items.map((row) =>
          projectRead(exportReadSchema, row, origin)
        ),
        nextCursor: page.nextCursor,
      };
    }
  );
  registerProductionRead(
    server,
    context,
    'get_export_status',
    'Inspect one existing export by exportId, with its status, source cut, duration and media URL. Does not start or reconcile an export.',
    sequenceInput.extend({ exportId: ulidSchema }),
    z.object({ export: exportReadSchema }),
    async (input, { scopedDb, origin }) => {
      await productionAccess(scopedDb).sequence(input.sequenceId);
      const row = await scopedDb.sequenceExports.getById(input.exportId);
      if (row?.sequenceId !== input.sequenceId)
        throw new NotFoundError('Export not found in this sequence.');
      return { export: projectRead(exportReadSchema, row, origin) };
    }
  );
  registerProductionRead(
    server,
    context,
    'list_sequence_events',
    'Page sequence activity by event ID, oldest first. Optional target type/ID filters are bound to the cursor; historical events may reference removed entities. Use get_sequence_event for change details.',
    collectionInput.extend({
      targetType: z
        .enum([
          'sequence',
          'scene',
          'shot',
          'frame',
          'variant',
          'character',
          'location',
          'element',
        ])
        .optional(),
      targetId: ulidSchema.optional(),
    }),
    z.object({ events: z.array(eventReadSchema), ...continuation }),
    async (input, { scopedDb, origin }) => {
      await productionAccess(scopedDb).sequence(input.sequenceId);
      const page = await readPage(
        input,
        [
          input.sequenceId,
          'events',
          input.targetType ?? '',
          input.targetId ?? '',
        ],
        (next) =>
          scopedDb.sequenceEvents.listBySequence(input.sequenceId, {
            targetType: input.targetType,
            targetId: input.targetId,
            page: next,
          })
      );
      return {
        events: page.items.map((row) =>
          projectRead(eventReadSchema, row, origin)
        ),
        nextCursor: page.nextCursor,
      };
    }
  );
  registerProductionRead(
    server,
    context,
    'get_sequence_event',
    'Read an activity event and its change details as a bounded JSON document. Continue using nextOffset and revision.',
    sequenceInput.extend({ eventId: ulidSchema, ...documentInput.shape }),
    z.object({ event: eventReadSchema, document: documentReadSchema }),
    async (input, { scopedDb, origin }) => {
      await productionAccess(scopedDb).sequence(input.sequenceId);
      const row = await scopedDb.sequenceEvents.getById(input.eventId);
      if (row?.sequenceId !== input.sequenceId)
        throw new NotFoundError('Event not found in this sequence.');
      return {
        event: projectRead(eventReadSchema, row, origin),
        document: await readDocument(
          JSON.stringify(projectRead(z.json(), row.data, origin)),
          input,
          'json'
        ),
      };
    }
  );
}
