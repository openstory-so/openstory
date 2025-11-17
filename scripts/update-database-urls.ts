#!/usr/bin/env bun
/**
 * Database URL Update Script
 *
 * Migrates Supabase Storage URLs to R2 by:
 * 1. Extracting storage paths from Supabase URLs
 * 2. Populating *_path columns for frames
 * 3. Optionally cleaning up old Supabase URLs
 *
 * Usage:
 *   bun scripts/update-database-urls.ts --dry-run              # Preview changes
 *   bun scripts/update-database-urls.ts                        # Populate missing paths
 *   bun scripts/update-database-urls.ts --cleanup --dry-run    # Preview URL cleanup
 *   bun scripts/update-database-urls.ts --cleanup              # Clean up old URLs
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { schema } from '../src/lib/db/schema';

// Load POSTGRES_URL from environment
const POSTGRES_URL = process.env.POSTGRES_URL;

if (!POSTGRES_URL) {
  console.error('❌ Missing POSTGRES_URL environment variable');
  process.exit(1);
}

// Create database connection for script
const sql = postgres(POSTGRES_URL, {
  max: 1,
  ssl: 'require',
});

const db = drizzle(sql, {
  schema,
  casing: 'snake_case',
});

type FrameUpdate = {
  thumbnailPath?: string | null;
  videoPath?: string | null;
  thumbnailUrl?: string | null;
  videoUrl?: string | null;
};

type UpdateStats = {
  framesUpdated: number;
  pathsPopulated: number;
  urlsCleared: number;
  errors: number;
};

function isSupabaseUrl(url: string | null): boolean {
  if (!url) return false;
  return url.includes('supabase.co/storage');
}

/**
 * Extract storage path from Supabase URL
 * Example: https://xyz.supabase.co/storage/v1/object/public/videos/teams/abc/seq/frame.mp4
 * Returns: teams/abc/seq/frame.mp4
 */
function extractPathFromSupabaseUrl(
  url: string,
  bucket: string
): string | null {
  try {
    // Pattern: /storage/v1/object/public/{bucket}/{path}
    // OR: /storage/v1/object/sign/{bucket}/{path}?token=...
    const publicMatch = url.match(
      new RegExp(`/storage/v1/object/public/${bucket}/(.+?)(?:\\?|$)`)
    );
    if (publicMatch) return publicMatch[1];

    const signMatch = url.match(
      new RegExp(`/storage/v1/object/sign/${bucket}/(.+?)(?:\\?|$)`)
    );
    if (signMatch) return signMatch[1];

    return null;
  } catch (error) {
    console.error(`Failed to parse URL: ${url}`, error);
    return null;
  }
}

async function updateFramePaths(
  dryRun: boolean
): Promise<{ updated: number; errors: number }> {
  console.log('\n📦 Processing frames...');

  const frames = await db.query.frames.findMany({
    columns: {
      id: true,
      thumbnailUrl: true,
      thumbnailPath: true,
      videoUrl: true,
      videoPath: true,
    },
  });

  let updated = 0;
  let errors = 0;

  for (const frame of frames) {
    const updates: FrameUpdate = {};
    let needsUpdate = false;

    // Extract thumbnail path from Supabase URL if missing
    if (frame.thumbnailUrl && !frame.thumbnailPath) {
      const path = extractPathFromSupabaseUrl(frame.thumbnailUrl, 'thumbnails');
      if (path) {
        updates.thumbnailPath = path;
        needsUpdate = true;
        console.log(`  [${frame.id}] Will populate thumbnail_path: ${path}`);
      } else {
        console.warn(
          `  [${frame.id}] ⚠️  Could not extract thumbnail path from: ${frame.thumbnailUrl}`
        );
        errors++;
      }
    }

    // Extract video path from Supabase URL if missing
    if (frame.videoUrl && !frame.videoPath) {
      const path = extractPathFromSupabaseUrl(frame.videoUrl, 'videos');
      if (path) {
        updates.videoPath = path;
        needsUpdate = true;
        console.log(`  [${frame.id}] Will populate video_path: ${path}`);
      } else {
        console.warn(
          `  [${frame.id}] ⚠️  Could not extract video path from: ${frame.videoUrl}`
        );
        errors++;
      }
    }

    if (needsUpdate && !dryRun) {
      try {
        await db
          .update(schema.frames)
          .set(updates)
          .where(eq(schema.frames.id, frame.id));
        updated++;
      } catch (error) {
        console.error(
          `  [${frame.id}] ❌ Update failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
        errors++;
      }
    } else if (needsUpdate && dryRun) {
      updated++;
    }
  }

  if (dryRun) {
    console.log(`\n✅ Would update ${updated} frames (DRY RUN)`);
  } else {
    console.log(`\n✅ Updated ${updated} frames`);
  }

  if (errors > 0) {
    console.warn(`⚠️  ${errors} errors encountered`);
  }

  return { updated, errors };
}

async function cleanupSupabaseUrls(
  dryRun: boolean
): Promise<{ updated: number; errors: number }> {
  console.log('\n🧹 Cleaning up Supabase URLs...');

  const frames = await db.query.frames.findMany({
    columns: {
      id: true,
      thumbnailUrl: true,
      thumbnailPath: true,
      videoUrl: true,
      videoPath: true,
    },
  });

  let updated = 0;
  let errors = 0;

  for (const frame of frames) {
    const updates: FrameUpdate = {};
    let needsUpdate = false;

    // Clear Supabase thumbnail URLs if path exists (path is source of truth)
    if (isSupabaseUrl(frame.thumbnailUrl) && frame.thumbnailPath) {
      updates.thumbnailUrl = null;
      needsUpdate = true;
      console.log(`  [${frame.id}] Will clear thumbnail_url (path exists)`);
    }

    // Clear Supabase video URLs if path exists
    if (isSupabaseUrl(frame.videoUrl) && frame.videoPath) {
      updates.videoUrl = null;
      needsUpdate = true;
      console.log(`  [${frame.id}] Will clear video_url (path exists)`);
    }

    if (needsUpdate && !dryRun) {
      try {
        await db
          .update(schema.frames)
          .set(updates)
          .where(eq(schema.frames.id, frame.id));
        updated++;
      } catch (error) {
        console.error(
          `  [${frame.id}] ❌ Update failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
        errors++;
      }
    } else if (needsUpdate && dryRun) {
      updated++;
    }
  }

  if (dryRun) {
    console.log(`\n✅ Would clear URLs from ${updated} frames (DRY RUN)`);
  } else {
    console.log(`\n✅ Cleared URLs from ${updated} frames`);
  }

  if (errors > 0) {
    console.warn(`⚠️  ${errors} errors encountered`);
  }

  return { updated, errors };
}

function generateRollbackSQL(_stats: UpdateStats) {
  console.log('\n📝 Rollback SQL (save this before running migration):');
  console.log('='.repeat(60));
  console.log(
    `
-- Rollback script generated at ${new Date().toISOString()}
-- Use this to restore original state if needed

-- Note: This is a generic rollback template
-- For precise rollback, backup your database before migration

BEGIN;

-- Example: Restore paths if needed
-- UPDATE frames SET thumbnail_path = NULL WHERE thumbnail_path IS NOT NULL;
-- UPDATE frames SET video_path = NULL WHERE video_path IS NOT NULL;

ROLLBACK; -- Change to COMMIT when ready to execute
  `.trim()
  );
  console.log('='.repeat(60));
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const cleanup = args.includes('--cleanup');
  const help = args.includes('--help') || args.includes('-h');

  if (help) {
    console.log(
      `
Database URL Update Script

Usage:
  bun scripts/update-database-urls.ts [options]

Options:
  --dry-run       Preview changes without applying them
  --cleanup       Clean up old Supabase URLs (after paths are populated)
  --help, -h      Show this help message

Examples:
  # Preview path population
  bun scripts/update-database-urls.ts --dry-run

  # Populate missing paths
  bun scripts/update-database-urls.ts

  # Preview URL cleanup
  bun scripts/update-database-urls.ts --cleanup --dry-run

  # Clean up old URLs
  bun scripts/update-database-urls.ts --cleanup

Workflow:
  1. Run verification script first: bun scripts/verify-production-urls.ts
  2. Run this script with --dry-run to preview changes
  3. Run without --dry-run to apply changes
  4. Optionally run with --cleanup to remove old URLs
    `.trim()
    );
    process.exit(0);
  }

  console.log('🔄 Database URL Update Script');
  console.log('==============================\n');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE UPDATE'}`);
  console.log(`Operation: ${cleanup ? 'CLEANUP URLs' : 'POPULATE PATHS'}`);

  if (!dryRun) {
    console.log(
      '\n⚠️  WARNING: Running in LIVE mode - changes will be applied!'
    );
    console.log('Press Ctrl+C within 5 seconds to cancel...\n');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  try {
    const stats: UpdateStats = {
      framesUpdated: 0,
      pathsPopulated: 0,
      urlsCleared: 0,
      errors: 0,
    };

    if (cleanup) {
      const result = await cleanupSupabaseUrls(dryRun);
      stats.framesUpdated = result.updated;
      stats.urlsCleared = result.updated;
      stats.errors = result.errors;
    } else {
      const result = await updateFramePaths(dryRun);
      stats.framesUpdated = result.updated;
      stats.pathsPopulated = result.updated;
      stats.errors = result.errors;
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 SUMMARY');
    console.log('='.repeat(60));
    console.log(`Frames processed: ${stats.framesUpdated}`);
    if (!cleanup) {
      console.log(`Paths populated: ${stats.pathsPopulated}`);
    } else {
      console.log(`URLs cleared: ${stats.urlsCleared}`);
    }
    console.log(`Errors: ${stats.errors}`);
    console.log(
      `Mode: ${dryRun ? 'DRY RUN (no changes made)' : 'LIVE UPDATE (changes applied)'}`
    );

    if (!dryRun && stats.framesUpdated > 0) {
      generateRollbackSQL(stats);
    }

    if (dryRun) {
      console.log('\n💡 Run without --dry-run to apply these changes');
    } else {
      console.log('\n✅ Migration complete!');

      if (!cleanup && stats.pathsPopulated > 0) {
        console.log('\n📋 Next steps:');
        console.log('   1. Verify signed URLs regenerate correctly');
        console.log(
          '   2. Run file migration: bun scripts/migrate-supabase-to-r2.ts --all'
        );
        console.log(
          '   3. Optionally cleanup old URLs: bun scripts/update-database-urls.ts --cleanup'
        );
      }
    }

    console.log('='.repeat(60));
  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

void main();
