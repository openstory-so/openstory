/**
 * The 5-minute reconcile sweep binds `status`, and SQLite will not use a
 * partial index for a bound value — a composite (status, time) index is what
 * the planner seeks. `character_looks` is the exception: its predicate is
 * `IS NOT NULL`, which a partial index can prove.
 */

import { and, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import { afterAll, expect, test } from 'vitest';
import {
  characterLooks,
  characterSheetVariants,
  characterVoiceVersions,
  framePromptVersions,
  frameVariants,
  generatedAssets,
  sequenceElements,
  sequenceMusicVariants,
  sequences,
  shotDialogueClaims,
  shotPromptVersions,
  shotVariants,
  videoVariants,
} from '@/platform/server/db/schema';
import { createTestDb } from '@/platform/server/db/test-d1';

const cutoff = new Date(0);

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

function expectSeek(detail: string, index: string, rangeColumn: string) {
  expect(detail).toContain(`USING INDEX ${index}`);
  expect(detail).toContain(`${rangeColumn}<?`);
}

test('frame, video, shot and sequence sweeps seek status and age', async () => {
  expectSeek(
    await plan(
      db
        .select({ id: frameVariants.id })
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.status, 'generating'),
            lt(frameVariants.updatedAt, cutoff)
          )
        )
    ),
    'idx_frame_variants_status_updated',
    'updated_at'
  );
  expectSeek(
    await plan(
      db
        .select({ id: frameVariants.id })
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.status, 'pending'),
            isNotNull(frameVariants.workflowRunId),
            lt(frameVariants.updatedAt, cutoff)
          )
        )
    ),
    'idx_frame_variants_status_updated',
    'updated_at'
  );
  expectSeek(
    await plan(
      db
        .update(frameVariants)
        .set({ status: 'failed' })
        .where(
          and(
            eq(frameVariants.status, 'pending'),
            isNull(frameVariants.workflowRunId),
            lt(frameVariants.updatedAt, cutoff)
          )
        )
    ),
    'idx_frame_variants_status_updated',
    'updated_at'
  );
  expectSeek(
    await plan(
      db
        .select({ id: videoVariants.id })
        .from(videoVariants)
        .where(
          and(
            eq(videoVariants.status, 'generating'),
            lt(videoVariants.updatedAt, cutoff)
          )
        )
    ),
    'idx_video_variants_status_updated',
    'updated_at'
  );
  expectSeek(
    await plan(
      db
        .select({ id: shotVariants.id })
        .from(shotVariants)
        .where(
          and(
            eq(shotVariants.status, 'generating'),
            lt(shotVariants.updatedAt, cutoff)
          )
        )
    ),
    'idx_shot_variants_status_updated',
    'updated_at'
  );
  expectSeek(
    await plan(
      db
        .select({ id: shotVariants.id })
        .from(shotVariants)
        .where(
          and(
            eq(shotVariants.shotVariantStatus, 'generating'),
            lt(shotVariants.updatedAt, cutoff)
          )
        )
    ),
    'idx_shot_variants_shot_variant_status_updated',
    'updated_at'
  );
  expectSeek(
    await plan(
      db
        .select({ id: sequences.id })
        .from(sequences)
        .where(
          and(
            eq(sequences.status, 'processing'),
            isNotNull(sequences.workflowRunId),
            lt(sequences.updatedAt, cutoff)
          )
        )
    ),
    'idx_sequences_status_updated',
    'updated_at'
  );
});

test('prompt, voice, music and dialogue sweeps seek status and created_at', async () => {
  for (const table of [framePromptVersions, shotPromptVersions] as const) {
    const index =
      table === framePromptVersions
        ? 'idx_frame_prompt_versions_status_created'
        : 'idx_shot_prompt_versions_status_created';
    expectSeek(
      await plan(
        db
          .select({ id: table.id })
          .from(table)
          .where(
            and(
              inArray(table.status, ['pending', 'generating']),
              isNotNull(table.workflowRunId),
              lt(table.createdAt, cutoff)
            )
          )
      ),
      index,
      'created_at'
    );
    expectSeek(
      await plan(
        db
          .update(table)
          .set({ status: 'failed' })
          .where(
            and(
              inArray(table.status, ['pending', 'generating']),
              isNull(table.workflowRunId),
              lt(table.createdAt, cutoff)
            )
          )
      ),
      index,
      'created_at'
    );
  }

  expectSeek(
    await plan(
      db
        .select({ id: characterVoiceVersions.id })
        .from(characterVoiceVersions)
        .where(
          and(
            inArray(characterVoiceVersions.status, ['pending', 'generating']),
            isNotNull(characterVoiceVersions.workflowRunId),
            lt(characterVoiceVersions.createdAt, cutoff)
          )
        )
    ),
    'idx_character_voice_versions_status_created',
    'created_at'
  );
  expectSeek(
    await plan(
      db
        .update(sequenceMusicVariants)
        .set({ status: 'failed' })
        .where(
          and(
            eq(sequenceMusicVariants.status, 'pending'),
            isNull(sequenceMusicVariants.workflowRunId),
            lt(sequenceMusicVariants.createdAt, cutoff)
          )
        )
    ),
    'idx_sequence_music_variants_status_created',
    'created_at'
  );
  expectSeek(
    await plan(
      db
        .select({ id: shotDialogueClaims.id })
        .from(shotDialogueClaims)
        .where(
          and(
            eq(shotDialogueClaims.status, 'generating'),
            lt(shotDialogueClaims.createdAt, cutoff)
          )
        )
    ),
    'idx_shot_dialogue_claims_status_created',
    'created_at'
  );
});

test('asset, element and look sweeps seek the stuck rows', async () => {
  expectSeek(
    await plan(
      db
        .select({ id: generatedAssets.id })
        .from(generatedAssets)
        .where(
          and(
            inArray(generatedAssets.status, ['queued', 'running']),
            isNotNull(generatedAssets.workflowRunId),
            lt(generatedAssets.updatedAt, cutoff)
          )
        )
    ),
    'idx_generated_assets_status_updated',
    'updated_at'
  );
  expectSeek(
    await plan(
      db
        .update(generatedAssets)
        .set({ status: 'failed' })
        .where(
          and(
            eq(generatedAssets.status, 'queued'),
            isNull(generatedAssets.workflowRunId),
            lt(generatedAssets.updatedAt, cutoff)
          )
        )
    ),
    'idx_generated_assets_status_updated',
    'updated_at'
  );
  expectSeek(
    await plan(
      db
        .update(sequenceElements)
        .set({ visionStatus: 'failed' })
        .where(
          and(
            eq(sequenceElements.visionStatus, 'analyzing'),
            lt(sequenceElements.updatedAt, cutoff)
          )
        )
    ),
    'idx_sequence_elements_vision_updated',
    'updated_at'
  );

  const landed = await plan(
    db
      .select({ lookId: characterLooks.id })
      .from(characterLooks)
      .innerJoin(
        characterSheetVariants,
        eq(
          characterSheetVariants.id,
          characterLooks.pendingPromoteSheetVersionId
        )
      )
      .where(
        and(
          eq(characterSheetVariants.status, 'completed'),
          isNotNull(characterSheetVariants.url),
          isNull(characterSheetVariants.divergedAt),
          isNull(characterSheetVariants.discardedAt)
        )
      )
  );
  expect(landed).toContain('USING INDEX idx_character_looks_sheet_claim');

  const died = await plan(
    db
      .update(characterLooks)
      .set({ pendingPromoteSheetVersionId: null })
      .where(
        and(
          isNotNull(characterLooks.pendingPromoteSheetVersionId),
          lt(characterLooks.updatedAt, cutoff)
        )
      )
  );
  expect(died).toContain('USING INDEX idx_character_looks_sheet_claim');
});
