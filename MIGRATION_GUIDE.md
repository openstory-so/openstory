# Production R2 Migration Guide

Complete guide for migrating production videos and assets from Supabase Storage to Cloudflare R2.

## Overview

This migration handles both file copying AND database URL updates. The existing `migrate-supabase-to-r2.ts` script only copies files - these new scripts handle the database side.

## Migration Architecture

### Dual Storage Pattern

The system uses a modern dual-storage approach:

1. **Storage Paths** (`thumbnail_path`, `video_path`):
   - Permanently stored in database
   - Format: `teams/{teamId}/{sequenceId}/{frameId}.{ext}`
   - Used to generate fresh signed URLs on-demand

2. **Signed URLs** (`thumbnail_url`, `video_url`):
   - May contain old Supabase Storage URLs OR new R2 signed URLs
   - Expire after a set time (default: 1 hour)
   - Regenerated automatically via `frameService.enrichFrameWithSignedUrls()`

### Key Insight

**If `thumbnail_path` and `video_path` are populated, URLs regenerate automatically!** Old Supabase URLs are ignored when paths exist.

## Prerequisites

### 1. Environment Variables

Ensure these are set in your production environment:

```bash
# Supabase (for verification and migration)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Cloudflare R2
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=your-r2-access-key-id
R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
R2_BUCKET_NAME=velro-storage  # or velro-storage-dev
```

### 2. Database Backup

**CRITICAL: Backup your production database before any migration!**

```sql
-- Using Supabase CLI or Dashboard
-- Create a manual backup before proceeding
```

## New Migration Scripts

### 1. `verify-production-urls.ts` - Pre-Migration Audit

Analyzes the current state of your database:

```bash
bun scripts/verify-production-urls.ts
```

**Output:**

- Total frames and their path/URL status
- Count of Supabase URLs still in database
- Library resources (styles, characters, vfx, audio) status
- Recommendations for next steps

**Example Output:**

```
📊 Analyzing frames table...
  Total frames: 1500
  With video_path: 1200 (80.0%)
  With thumbnail_path: 1200 (80.0%)
  Supabase video URLs: 300
  Supabase thumbnail URLs: 300
  Frames missing paths: 300 ⚠️

📋 SUMMARY
Total Supabase URLs found: 600
   - Frame videos: 300
   - Frame thumbnails: 300
   ...

⚡ RECOMMENDATION:
   Run the database URL update script to populate missing paths
   Command: bun scripts/update-database-urls.ts --dry-run
```

### 2. `update-database-urls.ts` - Database URL Migrator

Populates missing storage paths and optionally cleans up old URLs.

**Modes:**

```bash
# Preview path population (safe - no changes)
bun scripts/update-database-urls.ts --dry-run

# Populate missing paths (writes to DB)
bun scripts/update-database-urls.ts

# Preview URL cleanup (safe - no changes)
bun scripts/update-database-urls.ts --cleanup --dry-run

# Clean up old Supabase URLs (writes to DB)
bun scripts/update-database-urls.ts --cleanup

# Show help
bun scripts/update-database-urls.ts --help
```

**What it does:**

**Populate Mode** (default):

- Extracts storage paths from Supabase URLs
- Populates missing `thumbnail_path` and `video_path` columns
- Only updates frames with missing paths

**Cleanup Mode** (`--cleanup`):

- Clears old Supabase URLs from database
- Only clears URLs when corresponding path exists
- Paths remain as source of truth for URL regeneration

## Step-by-Step Migration Process

### Step 1: Pre-Migration Verification

Run the verification script to understand current state:

```bash
bun scripts/verify-production-urls.ts
```

**Analyze the output:**

- How many frames have paths populated?
- How many Supabase URLs remain?
- Are there frames with URLs but no paths? (these need migration)

### Step 2: Populate Missing Paths (Dry Run)

Preview what changes will be made:

```bash
bun scripts/update-database-urls.ts --dry-run
```

**Review the output carefully:**

- Check that extracted paths look correct
- Verify frame IDs match expectations
- Look for any errors or warnings

**Example Output:**

```
📦 Processing frames...
  [abc-123] Will populate thumbnail_path: teams/team-1/seq-1/frame-1.jpg
  [abc-123] Will populate video_path: teams/team-1/seq-1/frame-1.mp4
  [def-456] Will populate thumbnail_path: teams/team-2/seq-2/frame-2.jpg
  ...

✅ Would update 300 frames (DRY RUN)

💡 Run without --dry-run to apply these changes
```

### Step 3: Populate Missing Paths (Live)

If dry run looks good, apply the changes:

```bash
bun scripts/update-database-urls.ts
```

**This will:**

- Wait 5 seconds for cancellation (Ctrl+C to abort)
- Update frames with missing paths
- Generate rollback SQL (save this!)
- Provide next steps

**Save the rollback SQL output!**

### Step 4: Verify Path Population

Run verification again to confirm paths were populated:

```bash
bun scripts/verify-production-urls.ts
```

**Expected result:**

- `Frames missing paths: 0` ✅
- Paths should be 100% populated
- Old Supabase URLs may still exist (harmless - ignored when path exists)

### Step 5: File Migration

Now run the existing file migration script:

```bash
# Dry run first (recommended!)
bun scripts/migrate-supabase-to-r2.ts --all --dry-run

# Copy all files from Supabase to R2
bun scripts/migrate-supabase-to-r2.ts --all
```

**This copies:**

- `thumbnails` bucket → R2 `thumbnails/` prefix
- `videos` bucket → R2 `videos/` prefix
- `audio` bucket → R2 `audio/` prefix
- `styles` bucket → R2 `styles/` prefix
- `characters` bucket → R2 `characters/` prefix
- `vfx` bucket → R2 `vfx/` prefix

**Verification:**

- Files are downloaded from Supabase
- Uploaded to R2 with same paths
- SHA-256 checksums verify integrity
- Progress shown for each file

### Step 6: Deploy Application with R2 Config

Deploy your application with R2 environment variables configured:

```bash
# Ensure these are set in production
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=velro-storage
```

**Verify signed URL generation:**

- Load a frame in production
- Check that `thumbnail_url` and `video_url` are R2 signed URLs
- Verify images/videos load correctly

### Step 7: Optional Cleanup

After confirming everything works, optionally clean up old Supabase URLs:

```bash
# Preview cleanup
bun scripts/update-database-urls.ts --cleanup --dry-run

# Clean up old URLs
bun scripts/update-database-urls.ts --cleanup
```

**This:**

- Sets `thumbnail_url` and `video_url` to `null` when path exists
- URLs will regenerate from paths on next API call
- Reduces database size slightly

## Rollback Plan

### If Migration Fails

1. **Keep Supabase Storage active** for 30 days minimum
2. **Revert environment variables** to use Supabase
3. **Use rollback SQL** generated by update script (if paths were modified)

### Rollback Database Changes

The update script generates rollback SQL. Example:

```sql
BEGIN;

-- Restore original state (if needed)
UPDATE frames SET thumbnail_path = NULL WHERE thumbnail_path IS NOT NULL;
UPDATE frames SET video_path = NULL WHERE video_path IS NOT NULL;

ROLLBACK; -- Change to COMMIT when ready to execute
```

### Rollback File Storage

If you need to revert to Supabase Storage:

1. Files remain in Supabase (not deleted by migration)
2. Update environment to use Supabase client
3. Old URLs in database will work (if not cleaned up)

## Monitoring & Verification

### Post-Migration Checks

1. **Signed URL Generation:**

   ```bash
   # Check application logs for URL generation errors
   # Verify frameService.enrichFrameWithSignedUrls() works
   ```

2. **Frontend Verification:**
   - Load sequences in production
   - Verify thumbnails display
   - Play videos to confirm playback
   - Check all library assets (styles, characters, vfx, audio)

3. **Database Queries:**

   ```sql
   -- Verify paths are populated
   SELECT COUNT(*) FROM frames WHERE video_path IS NULL;
   SELECT COUNT(*) FROM frames WHERE thumbnail_path IS NULL;

   -- Check for remaining Supabase URLs
   SELECT COUNT(*) FROM frames WHERE video_url LIKE '%supabase.co%';
   SELECT COUNT(*) FROM frames WHERE thumbnail_url LIKE '%supabase.co%';
   ```

### Error Monitoring

Monitor application logs for:

- `Failed to generate signed URL` errors
- Storage access errors
- Missing file errors

## Safety Features

### Dry-Run Mode

Both scripts support `--dry-run`:

- No database changes
- Preview exactly what will happen
- Safe to run in production

### 5-Second Cancellation Window

Live mode waits 5 seconds before executing:

- Press Ctrl+C to cancel if needed
- Time to review configuration
- Prevents accidental execution

### Rollback SQL Generation

Update script generates rollback SQL:

- Save this before migration
- Use to restore original state
- Specific to your database state

### Path Extraction Validation

URL parsing includes error handling:

- Logs warnings for unparseable URLs
- Continues processing other frames
- Reports error count in summary

## Database Schema Reference

### Tables with Storage URLs

**frames** (primary table):

- `thumbnail_url` (text) - Signed URL or NULL
- `thumbnail_path` (text) - Storage path (source of truth)
- `video_url` (text) - Signed URL or NULL
- `video_path` (text) - Storage path (source of truth)

**styles**:

- `preview_url` (text) - Preview image URL

**characters**:

- `lora_url` (text) - LoRA model file URL
- `preview_url` (text) - Character preview URL

**vfx**:

- `preview_url` (text) - VFX preset preview URL

**audio**:

- `file_url` (text, NOT NULL) - Audio file URL

**user**:

- `image` (text) - Profile image URL

### URL Patterns

**Supabase Storage:**

```
https://{project}.supabase.co/storage/v1/object/public/{bucket}/{path}
https://{project}.supabase.co/storage/v1/object/sign/{bucket}/{path}?token=...
```

**R2 Storage:**

```
https://{account}.r2.cloudflarestorage.com/{bucket}/{path}?X-Amz-...
```

## Troubleshooting

### Path Extraction Fails

**Symptom:** Script reports "Could not extract path from URL"

**Solution:**

- Verify URL format matches expected pattern
- Check if URL is from Supabase Storage
- Manual inspection may be needed for custom URLs

### Database Update Fails

**Symptom:** "Update failed" errors during migration

**Solution:**

- Check database permissions (service role key)
- Verify frame IDs exist
- Check for database constraints or triggers

### Signed URLs Don't Generate

**Symptom:** Images/videos don't load after migration

**Solution:**

- Verify R2 credentials are correct
- Check `getSignedUrl()` function in `storage.ts`
- Ensure paths match R2 file locations
- Test file migration completed successfully

## Complete Migration Checklist

- [ ] Backup production database
- [ ] Verify environment variables (Supabase + R2)
- [ ] Run `verify-production-urls.ts` to audit current state
- [ ] Run `update-database-urls.ts --dry-run` to preview changes
- [ ] Review dry-run output carefully
- [ ] Run `update-database-urls.ts` to populate paths (live)
- [ ] Save rollback SQL output
- [ ] Verify paths populated with `verify-production-urls.ts`
- [ ] Run `migrate-supabase-to-r2.ts --all --dry-run` to preview file copy
- [ ] Run `migrate-supabase-to-r2.ts --all` to copy files (live)
- [ ] Deploy application with R2 configuration
- [ ] Verify signed URLs generate correctly in production
- [ ] Test loading sequences, frames, and library assets
- [ ] Monitor error logs for 48 hours
- [ ] Optionally run `update-database-urls.ts --cleanup` to remove old URLs
- [ ] Keep Supabase Storage active for 30-day rollback window

## Support

If you encounter issues:

1. **Review this guide** for troubleshooting steps
2. **Check application logs** for specific errors
3. **Run verification script** to understand current state
4. **Use dry-run mode** to preview changes safely
5. **Keep rollback SQL** for emergency restoration

## Summary

This migration strategy ensures:

- ✅ Zero downtime (paths enable automatic URL regeneration)
- ✅ Safety first (dry-run mode, backups, rollback SQL)
- ✅ Comprehensive verification (before, during, and after)
- ✅ Clear documentation (step-by-step with examples)
- ✅ Rollback capability (30-day window with Supabase active)

The dual-storage pattern (paths + signed URLs) is the key innovation that makes this migration safe and reversible.
