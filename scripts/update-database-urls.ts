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

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Missing Supabase credentials');
  console.error(
    'Required: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY'
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

type FrameRow = {
  id: string;
  thumbnail_url: string | null;
  thumbnail_path: string | null;
  video_url: string | null;
  video_path: string | null;
};

type FrameUpdate = {
  thumbnail_path?: string | null;
  video_path?: string | null;
  thumbnail_url?: string | null;
  video_url?: string | null;
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

  const { data: frames, error: fetchError } = await supabase
    .from('frames')
    .select('id, thumbnail_url, thumbnail_path, video_url, video_path');

  if (fetchError) {
    throw new Error(`Failed to fetch frames: ${fetchError.message}`);
  }

  if (!frames) {
    throw new Error('No frames data returned');
  }

  let updated = 0;
  let errors = 0;

  for (const frame of frames as FrameRow[]) {
    const updates: FrameUpdate = {};
    let needsUpdate = false;

    // Extract thumbnail path from Supabase URL if missing
    if (frame.thumbnail_url && !frame.thumbnail_path) {
      const path = extractPathFromSupabaseUrl(
        frame.thumbnail_url,
        'thumbnails'
      );
      if (path) {
        updates.thumbnail_path = path;
        needsUpdate = true;
        console.log(`  [${frame.id}] Will populate thumbnail_path: ${path}`);
      } else {
        console.warn(
          `  [${frame.id}] ⚠️  Could not extract thumbnail path from: ${frame.thumbnail_url}`
        );
        errors++;
      }
    }

    // Extract video path from Supabase URL if missing
    if (frame.video_url && !frame.video_path) {
      const path = extractPathFromSupabaseUrl(frame.video_url, 'videos');
      if (path) {
        updates.video_path = path;
        needsUpdate = true;
        console.log(`  [${frame.id}] Will populate video_path: ${path}`);
      } else {
        console.warn(
          `  [${frame.id}] ⚠️  Could not extract video path from: ${frame.video_url}`
        );
        errors++;
      }
    }

    if (needsUpdate && !dryRun) {
      const { error: updateError } = await supabase
        .from('frames')
        .update(updates)
        .eq('id', frame.id);

      if (updateError) {
        console.error(
          `  [${frame.id}] ❌ Update failed: ${updateError.message}`
        );
        errors++;
      } else {
        updated++;
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

  const { data: frames, error: fetchError } = await supabase
    .from('frames')
    .select('id, thumbnail_url, thumbnail_path, video_url, video_path');

  if (fetchError) {
    throw new Error(`Failed to fetch frames: ${fetchError.message}`);
  }

  if (!frames) {
    throw new Error('No frames data returned');
  }

  let updated = 0;
  let errors = 0;

  for (const frame of frames as FrameRow[]) {
    const updates: FrameUpdate = {};
    let needsUpdate = false;

    // Clear Supabase thumbnail URLs if path exists (path is source of truth)
    if (isSupabaseUrl(frame.thumbnail_url) && frame.thumbnail_path) {
      updates.thumbnail_url = null;
      needsUpdate = true;
      console.log(`  [${frame.id}] Will clear thumbnail_url (path exists)`);
    }

    // Clear Supabase video URLs if path exists
    if (isSupabaseUrl(frame.video_url) && frame.video_path) {
      updates.video_url = null;
      needsUpdate = true;
      console.log(`  [${frame.id}] Will clear video_url (path exists)`);
    }

    if (needsUpdate && !dryRun) {
      const { error: updateError } = await supabase
        .from('frames')
        .update(updates)
        .eq('id', frame.id);

      if (updateError) {
        console.error(
          `  [${frame.id}] ❌ Update failed: ${updateError.message}`
        );
        errors++;
      } else {
        updated++;
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
  console.log(`Environment: ${SUPABASE_URL}`);
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
  }
}

void main();
