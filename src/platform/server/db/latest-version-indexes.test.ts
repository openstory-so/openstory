/**
 * Latest-row readers filter by owner and status. With no sqlite_stat1, D1
 * prefers a status-leading index and reads the whole table (#2347, since
 * #2245). These plans are the migrated schema with no ANALYZE, same as prod.
 * A status-leading SEARCH fails the test.
 */

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  not,
  sql,
} from 'drizzle-orm';
import { afterAll, expect, test } from 'vitest';
import {
  characterVoiceVersions,
  framePromptVersions,
  frameVariants,
  generatedAssets,
  sequenceMusicVariants,
  sequences,
  shotDialogueClaims,
  shotPromptVersions,
  shotVariants,
  videoVariants,
} from '@/platform/server/db/schema';
import { createTestDb } from '@/platform/server/db/test-d1';

const batch = Array.from({ length: 90 }, (_, i) => `01OWNER${i}`);
const one = batch[0] ?? '01OWNER0';

type PlanQuery = { toSQL(): { sql: string; params: unknown[] } };

const { db, close } = await createTestDb();

afterAll(() => close());

async function plan(query: PlanQuery): Promise<string> {
  const compiled = query.toSQL();
  const explained = await db.$client
    .prepare(`EXPLAIN QUERY PLAN ${compiled.sql}`)
    .bind(
      ...compiled.params.map((value) =>
        value instanceof Date ? value.getTime() : value
      )
    )
    .all();
  return explained.results
    .map((row) => {
      const detail = row.detail;
      return typeof detail === 'string' ? detail : '';
    })
    .join('\n');
}

function expectOwner(detail: string, index: string) {
  expect(detail).toMatch(new RegExp(`USING (COVERING )?INDEX ${index}\\b`));
  expect(detail).not.toMatch(/INDEX \w+ \(status/);
}

test('latest prompts and previews seek the owner, not status', async () => {
  expectOwner(
    await plan(
      db
        .select({
          id: framePromptVersions.id,
          position:
            sql<number>`row_number() over (partition by ${framePromptVersions.frameId} order by ${framePromptVersions.createdAt} desc, ${framePromptVersions.id} desc)`.as(
              'position'
            ),
        })
        .from(framePromptVersions)
        .where(
          and(
            inArray(framePromptVersions.frameId, batch),
            eq(framePromptVersions.status, 'completed')
          )
        )
    ),
    'idx_frame_prompt_versions_frame_status_created'
  );
  expectOwner(
    await plan(
      db
        .select({
          id: framePromptVersions.id,
          position:
            sql<number>`row_number() over (partition by ${framePromptVersions.frameId} order by ${framePromptVersions.createdAt} desc, ${framePromptVersions.id} desc)`.as(
              'position'
            ),
        })
        .from(framePromptVersions)
        .where(
          and(
            inArray(framePromptVersions.frameId, batch),
            eq(framePromptVersions.status, 'completed'),
            isNotNull(framePromptVersions.inputHash)
          )
        )
    ),
    'idx_frame_prompt_versions_frame_hash'
  );
  expectOwner(
    await plan(
      db
        .select()
        .from(framePromptVersions)
        .where(
          and(
            eq(framePromptVersions.frameId, one),
            eq(framePromptVersions.status, 'completed')
          )
        )
        .orderBy(desc(framePromptVersions.createdAt))
        .limit(1)
    ),
    'idx_frame_prompt_versions_frame_status_created'
  );
  expectOwner(
    await plan(
      db
        .select({
          id: shotPromptVersions.id,
          position:
            sql<number>`row_number() over (partition by ${shotPromptVersions.shotId} order by ${shotPromptVersions.createdAt} desc, ${shotPromptVersions.id} desc)`.as(
              'position'
            ),
        })
        .from(shotPromptVersions)
        .where(
          and(
            inArray(shotPromptVersions.shotId, batch),
            eq(shotPromptVersions.promptType, 'motion'),
            eq(shotPromptVersions.status, 'completed')
          )
        )
    ),
    'idx_shot_prompt_versions_shot_type_status_created'
  );
  expectOwner(
    await plan(
      db
        .select()
        .from(shotPromptVersions)
        .where(
          and(
            eq(shotPromptVersions.shotId, one),
            eq(shotPromptVersions.promptType, 'motion'),
            lte(shotPromptVersions.createdAt, new Date(0)),
            eq(shotPromptVersions.status, 'completed')
          )
        )
        .orderBy(desc(shotPromptVersions.createdAt))
        .limit(50)
    ),
    'idx_shot_prompt_versions_shot_type_status_created'
  );
  expectOwner(
    await plan(
      db
        .select({
          id: frameVariants.id,
          position:
            sql<number>`row_number() over (partition by ${frameVariants.frameId} order by ${frameVariants.createdAt} desc, ${frameVariants.id} desc)`.as(
              'position'
            ),
        })
        .from(frameVariants)
        .where(
          and(
            inArray(frameVariants.frameId, batch),
            eq(frameVariants.kind, 'preview'),
            eq(frameVariants.status, 'completed'),
            isNotNull(frameVariants.url),
            isNull(frameVariants.discardedAt)
          )
        )
    ),
    'idx_frame_variants_frame_kind_status'
  );
});

test('other owner-and-status readers stay off the sweep indexes', async () => {
  expectOwner(
    await plan(
      db
        .select({ id: frameVariants.id })
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.sequenceId, 'seq'),
            eq(frameVariants.status, 'completed'),
            isNotNull(frameVariants.storagePath)
          )
        )
    ),
    'idx_frame_variants_sequence_status'
  );
  expectOwner(
    await plan(
      db
        .update(frameVariants)
        .set({ isPrimary: false })
        .where(
          and(
            eq(frameVariants.frameId, 'frame'),
            eq(frameVariants.isPrimary, true),
            eq(frameVariants.status, 'failed')
          )
        )
    ),
    'idx_frame_variants_frame_status'
  );
  expectOwner(
    await plan(
      db
        .select({ id: frameVariants.id })
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.frameId, 'frame'),
            eq(frameVariants.workflowRunId, 'run'),
            eq(frameVariants.status, 'generating')
          )
        )
    ),
    'idx_frame_variants_frame_status'
  );
  expectOwner(
    await plan(
      db
        .select({ id: videoVariants.id })
        .from(videoVariants)
        .where(
          and(
            eq(videoVariants.sequenceId, 'seq'),
            eq(videoVariants.status, 'completed'),
            isNotNull(videoVariants.storagePath)
          )
        )
        .orderBy(asc(videoVariants.id))
    ),
    'idx_video_variants_sequence_status'
  );
  expectOwner(
    await plan(
      db
        .select({ id: videoVariants.id })
        .from(videoVariants)
        .where(
          and(
            eq(videoVariants.renderSegmentId, 'seg'),
            eq(videoVariants.model, 'model'),
            eq(videoVariants.workflowRunId, 'run'),
            eq(videoVariants.status, 'generating')
          )
        )
    ),
    'idx_video_variants_group'
  );
  expectOwner(
    await plan(
      db
        .update(sequenceMusicVariants)
        .set({ divergedAt: new Date(0) })
        .where(
          and(
            eq(sequenceMusicVariants.sequenceId, 'seq'),
            eq(sequenceMusicVariants.model, 'model'),
            eq(sequenceMusicVariants.status, 'completed'),
            isNull(sequenceMusicVariants.divergedAt)
          )
        )
    ),
    'idx_sequence_music_variants_sequence_status'
  );
  expectOwner(
    await plan(
      db
        .select()
        .from(sequenceMusicVariants)
        .where(eq(sequenceMusicVariants.sequenceId, 'seq'))
        .orderBy(asc(sequenceMusicVariants.id))
    ),
    'idx_sequence_music_variants_sequence_status'
  );
  expectOwner(
    await plan(
      db
        .select()
        .from(shotDialogueClaims)
        .where(
          and(
            eq(shotDialogueClaims.shotId, 'shot'),
            eq(shotDialogueClaims.status, 'generating')
          )
        )
        .orderBy(desc(shotDialogueClaims.createdAt))
    ),
    'idx_shot_dialogue_claims_shot_status_created'
  );
  expectOwner(
    await plan(
      db
        .select({ id: shotDialogueClaims.id })
        .from(shotDialogueClaims)
        .where(
          and(
            eq(shotDialogueClaims.workflowRunId, 'run'),
            eq(shotDialogueClaims.status, 'generating'),
            inArray(shotDialogueClaims.shotId, batch)
          )
        )
    ),
    'idx_shot_dialogue_claims_shot_status_created'
  );
  const liveClaims = await plan(
    db
      .selectDistinct({ shotId: shotDialogueClaims.shotId })
      .from(shotDialogueClaims)
      .where(
        and(
          inArray(shotDialogueClaims.shotId, batch),
          eq(shotDialogueClaims.status, 'generating'),
          isNotNull(shotDialogueClaims.pendingSourceKey)
        )
      )
  );
  expect(liveClaims).toContain('uq_shot_dialogue_claims_live');
  expect(liveClaims).not.toMatch(/INDEX \w+ \(status/);
  expectOwner(
    await plan(
      db
        .select()
        .from(characterVoiceVersions)
        .where(
          and(
            eq(characterVoiceVersions.characterId, 'character'),
            inArray(characterVoiceVersions.status, ['pending', 'generating'])
          )
        )
    ),
    'idx_character_voice_versions_character_created'
  );
  expectOwner(
    await plan(
      db.select().from(shotVariants).where(eq(shotVariants.shotId, 'shot'))
    ),
    'idx_shot_variants_shot_type'
  );
  expectOwner(
    await plan(
      db
        .select({ id: sequences.id })
        .from(sequences)
        .where(
          and(
            eq(sequences.organizationId, 'org'),
            not(eq(sequences.status, 'archived'))
          )
        )
        .orderBy(desc(sequences.updatedAt))
    ),
    'idx_sequences_organization_slug'
  );
  expectOwner(
    await plan(
      db
        .select({ id: sequences.id })
        .from(sequences)
        .where(
          and(
            eq(sequences.organizationId, 'org'),
            eq(sequences.status, 'archived')
          )
        )
    ),
    'idx_sequences_organization_slug'
  );
  expectOwner(
    await plan(
      db
        .select()
        .from(generatedAssets)
        .where(eq(generatedAssets.organizationId, 'org'))
        .orderBy(desc(generatedAssets.id))
    ),
    'idx_generated_assets_organization'
  );
});
