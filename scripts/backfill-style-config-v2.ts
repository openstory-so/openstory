/**
 * Backfill `styles.config` blobs from the flat v1 shape to grouped v2 (#858).
 *
 * Pure column-data UPDATEs on one JSON column — no DDL, no table rebuild, so
 * the D1 CASCADE trap documented in CLAUDE.md is not in play. Hash-neutral by
 * design: `styleConfigHashBody` projects v2 back to the v1 key names, so
 * rewriting a blob changes no stored prompt/sheet hash and flips no staleness
 * banner.
 *
 * Behavior:
 * - v1 rows are converted through the same validated `migrateStyleConfigV1ToV2`
 *   the runtime uses. All rows are converted (and validated) BEFORE the first
 *   write; a conversion failure aborts with per-row diagnostics and writes
 *   nothing. Writes themselves are per-row, so a mid-loop infrastructure
 *   failure can leave a partial state — safe, because re-running skips
 *   already-converted rows.
 * - Rows that already look v2 are re-validated (not skipped blind): a
 *   corrupt "v2-shaped" blob is exactly what this script exists to find.
 *
 * Usage: bun scripts/backfill-style-config-v2.ts [--local|--test|--d1] [--dry-run]
 */
import { eq } from 'drizzle-orm';
import { styles } from '@/lib/db/schema';
import {
  isStyleConfigV2,
  migrateStyleConfigV1ToV2,
  StyleConfigSchema,
  type StyleConfig,
} from '@/lib/style/style-config';
import { createSeedDb, parseSeedTarget } from './seed-db-client';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const target = parseSeedTarget(process.argv.slice(2));
  const { db, dispose } = await createSeedDb(target);

  try {
    const rows = await db
      .select({ id: styles.id, name: styles.name, config: styles.config })
      .from(styles);

    const toWrite: Array<{ id: string; name: string; config: StyleConfig }> =
      [];
    const invalid: Array<{ id: string; name: string; message: string }> = [];
    let alreadyV2 = 0;

    for (const row of rows) {
      if (isStyleConfigV2(row.config)) {
        // Validate, don't skip blind — a corrupt v2-shaped blob would throw
        // at every read boundary and this is the tool meant to surface it.
        const check = StyleConfigSchema.safeParse(row.config);
        if (check.success) alreadyV2++;
        else
          invalid.push({
            id: row.id,
            name: row.name,
            message: check.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; '),
          });
        continue;
      }
      try {
        toWrite.push({
          id: row.id,
          name: row.name,
          config: migrateStyleConfigV1ToV2(row.config),
        });
      } catch (error) {
        invalid.push({
          id: row.id,
          name: row.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    console.log(
      `${rows.length} style row(s): ${alreadyV2} already v2, ${toWrite.length} to migrate, ${invalid.length} invalid`
    );

    if (invalid.length > 0) {
      console.error('\nInvalid style configs (nothing was written):');
      for (const row of invalid) {
        console.error(`  ${row.id} (${row.name}): ${row.message}`);
      }
      process.exit(1);
    }

    if (DRY_RUN) {
      for (const row of toWrite) {
        console.log(`  would migrate ${row.id} (${row.name})`);
      }
      console.log('\nDry run — nothing written.');
      return;
    }

    // Deliberately no `updatedAt` bump: a shape migration is not a user edit
    // and must not reorder "recently updated" listings.
    for (const row of toWrite) {
      await db
        .update(styles)
        .set({ config: row.config })
        .where(eq(styles.id, row.id));
      console.log(`  migrated ${row.id} (${row.name})`);
    }
    console.log(`\nDone: ${toWrite.length} row(s) migrated.`);
  } finally {
    await dispose();
  }
}

void main();
