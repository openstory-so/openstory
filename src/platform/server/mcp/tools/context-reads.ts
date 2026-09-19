import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import {
  referenceKindSchema,
  listEntityUsages,
  listShotReferences,
  readShotStaleness,
  listShotStaleness,
  shotStalenessSchema,
  artifactStalenessSchema,
} from '@/shots/server/production-context';
import { readReferenceStaleness } from '@/cast/server/production-staleness';
import { readSegmentStaleness } from '@/motion/server/production-staleness';
import { readMusicPromptStaleness } from '@/audio/server/music-staleness';
import {
  registerProductionRead,
  collectionInput,
  sequenceInput,
  type ReadToolContextFactory,
} from '../tool-context';
import { productionAccess } from '@/sequences/server/production-access';

export function registerContextReads(
  server: McpServer,
  context: ReadToolContextFactory
) {
  registerProductionRead(
    server,
    context,
    'list_shot_references',
    'Find characters, locations or elements used by a shot using the same matchers as the editor. limit bounds candidates examined; a page may be empty while nextCursor is non-null. Continue until null. IDs can be passed to the entity detail tools.',
    collectionInput.extend({ shotId: ulidSchema, kind: referenceKindSchema }),
    z.object({
      references: z.array(z.object({ id: z.string(), name: z.string() })),
      examined: z.number(),
      nextCursor: z.string().nullable(),
    }),
    async (input, { scopedDb }) => listShotReferences(scopedDb, input)
  );
  registerProductionRead(
    server,
    context,
    'list_entity_usages',
    'Find shots using a sequence character, location or element, optionally within one scene. limit bounds shots examined; empty pages may have nextCursor. Continue until null. Cursors bind the entity and scene filter.',
    collectionInput.extend({
      entityId: ulidSchema,
      kind: referenceKindSchema,
      sceneId: ulidSchema.optional(),
    }),
    z.object({
      usages: z.array(
        z.object({
          shotId: z.string(),
          sceneId: z.string().nullable(),
          shotNumber: z.number().nullable(),
        })
      ),
      examined: z.number(),
      nextCursor: z.string().nullable(),
    }),
    async (input, { scopedDb }) => listEntityUsages(scopedDb, input)
  );
  registerProductionRead(
    server,
    context,
    'get_shot_staleness',
    'Compute current visual prompt, motion prompt and anchor image freshness plus cause hints. Uses editor semantics without creating missing frames. Use get_render_segment_staleness for the selected video.',
    sequenceInput.extend({ shotId: ulidSchema }),
    shotStalenessSchema,
    async (input, { scopedDb }) =>
      readShotStaleness(scopedDb, input.sequenceId, input.shotId)
  );
  registerProductionRead(
    server,
    context,
    'list_shot_staleness',
    'Page active shots and compute their prompt/image freshness, optionally within one scene (limit 1–20, default 5). This is a detailed dependency read, more expensive than get_sequence_status.',
    collectionInput.extend({
      sceneId: ulidSchema.optional(),
      limit: z.int().min(1).max(20).default(5),
    }),
    z.object({
      shots: z.array(shotStalenessSchema),
      nextCursor: z.string().nullable(),
    }),
    async (input, { scopedDb }) => listShotStaleness(scopedDb, input)
  );
  registerProductionRead(
    server,
    context,
    'get_reference_staleness',
    'Compute character or location reference-sheet freshness using the existing sheet input hashes. Voice-only characters report applicable false. Does not generate sheets.',
    sequenceInput.extend({
      kind: z.enum(['character', 'location']),
      entityId: ulidSchema,
    }),
    z.object({ status: artifactStalenessSchema, applicable: z.boolean() }),
    async (input, { scopedDb }) =>
      readReferenceStaleness(
        scopedDb,
        input.sequenceId,
        input.kind,
        input.entityId
      )
  );
  registerProductionRead(
    server,
    context,
    'get_render_segment_staleness',
    'Compare the selected video manifest against current member shots, frames, motion prompts and dialogue voice bindings. This detailed dependency read does not plan or start generation.',
    sequenceInput.extend({ segmentId: ulidSchema }),
    z.object({ status: artifactStalenessSchema }),
    async (input, { scopedDb }) =>
      readSegmentStaleness(scopedDb, input.sequenceId, input.segmentId)
  );
  registerProductionRead(
    server,
    context,
    'get_music_staleness',
    'Compute sequence music-prompt freshness with the shared editor derivation. Track-level freshness is untracked: the product currently derives music regeneration from prompt changes.',
    sequenceInput,
    z.object({
      musicPrompt: artifactStalenessSchema,
      track: z.literal('untracked'),
    }),
    async (input, { scopedDb }) => ({
      ...(await readMusicPromptStaleness(
        scopedDb,
        await productionAccess(scopedDb).sequence(input.sequenceId)
      )),
      track: 'untracked' as const,
    })
  );
}
