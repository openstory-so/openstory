# Local Testing Guide for R2 Migration

Complete guide for safely testing the R2 migration scripts against production data locally.

## Quick Start (Recommended)

Use the automated script:

```bash
# 1. Start local Supabase (if not running)
bunx supabase start

# 2. Clone production database
./scripts/clone-production-db.sh

# 3. Test migration scripts
bun scripts/verify-production-urls.ts
bun scripts/update-database-urls.ts --dry-run
```

## Manual Method

If you prefer manual control or need to troubleshoot:

### Step 1: Get Production Database Credentials

Find your database password:

1. Go to Supabase Dashboard
2. Click **Database** → **Connection String**
3. Copy the password (or use Connection Pooler password)

### Step 2: Create Production Dump

```bash
# Extract project ref from your URL
PROJECT_REF="your-project-ref"  # e.g., "abc123def456"

# Create dump (enter password when prompted)
pg_dump "postgresql://postgres:[PASSWORD]@db.${PROJECT_REF}.supabase.co:5432/postgres" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  > production-dump.sql
```

**What these flags do:**

- `--clean`: Drop objects before recreating them
- `--if-exists`: Don't error if objects don't exist
- `--no-owner`: Don't set ownership (works better for local import)
- `--no-privileges`: Don't dump role permissions

### Step 3: Load Dump into Local Database

```bash
# Start local Supabase
bunx supabase start

# Get local database URL
bunx supabase status

# Load the dump
psql "postgresql://postgres:postgres@localhost:54322/postgres" < production-dump.sql
```

**Expected output:**

- Lots of SQL statements executing
- Some warnings are normal (about missing roles/extensions)
- Should end with "COMMIT"

### Step 4: Verify Import

```bash
# Check row counts
psql "postgresql://postgres:postgres@localhost:54322/postgres" -c "
  SELECT
    'frames' as table, COUNT(*) as rows FROM frames
  UNION ALL
  SELECT 'sequences', COUNT(*) FROM sequences
  UNION ALL
  SELECT 'teams', COUNT(*) FROM teams;
"
```

Expected output should match your production counts.

## Alternative: Using Supabase CLI

The Supabase CLI can also create dumps:

```bash
# Link to production project
bunx supabase link --project-ref your-project-ref

# Create dump
bunx supabase db dump -f production-dump.sql

# Load into local
bunx supabase db reset
psql "postgresql://postgres:postgres@localhost:54322/postgres" < production-dump.sql
```

## Troubleshooting

### Error: "password authentication failed"

**Problem:** Wrong database password

**Solution:**

1. Get fresh credentials from Supabase Dashboard
2. Make sure you're using the database password, not API keys
3. Try Connection Pooler password instead

### Error: "could not connect to server"

**Problem:** Local Supabase not running

**Solution:**

```bash
bunx supabase start
bunx supabase status  # Verify it's running
```

### Error: "relation already exists"

**Problem:** Local database has existing data

**Solution:**

```bash
# Reset local database first
bunx supabase db reset

# Then load dump
psql "postgresql://postgres:postgres@localhost:54322/postgres" < production-dump.sql
```

### Warning: "role does not exist"

**Problem:** Production roles don't exist locally

**Solution:** This is normal and safe to ignore. The `--no-owner` flag prevents ownership issues.

### Dump file is huge (>100MB)

**Problem:** Production database has lots of data

**Solution:** Create a filtered dump with just the tables you need:

```bash
# Only dump specific tables
pg_dump "postgresql://postgres:[PASSWORD]@db.${PROJECT_REF}.supabase.co:5432/postgres" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --table=frames \
  --table=sequences \
  --table=teams \
  > production-subset.sql
```

Or limit rows:

```bash
# Get just recent data (last 1000 frames)
psql "postgresql://postgres:[PASSWORD]@db.${PROJECT_REF}.supabase.co:5432/postgres" -c "
  COPY (
    SELECT * FROM frames
    ORDER BY created_at DESC
    LIMIT 1000
  ) TO STDOUT
" > frames-subset.sql
```

## Testing Workflow

Once you have production data loaded locally:

### 1. Initial Verification

```bash
# Check current state
bun scripts/verify-production-urls.ts
```

Look for:

- Total frames count
- How many have paths vs URLs
- Any Supabase URLs remaining

### 2. Test Path Population

```bash
# Dry run (safe - no changes)
bun scripts/update-database-urls.ts --dry-run
```

Review output:

- Check extracted paths look correct
- Verify frame IDs match expectations
- Look for any errors/warnings

### 3. Apply Changes (Local Only!)

```bash
# Actually update local database
bun scripts/update-database-urls.ts
```

### 4. Verify Results

```bash
# Check paths were populated
bun scripts/verify-production-urls.ts

# Or query directly
psql "postgresql://postgres:postgres@localhost:54322/postgres" -c "
  SELECT
    COUNT(*) as total_frames,
    COUNT(video_path) as with_video_path,
    COUNT(thumbnail_path) as with_thumbnail_path
  FROM frames;
"
```

### 5. Test URL Extraction

Check a few frames to see if path extraction worked correctly:

```bash
psql "postgresql://postgres:postgres@localhost:54322/postgres" -c "
  SELECT
    id,
    video_url,
    video_path,
    thumbnail_url,
    thumbnail_path
  FROM frames
  WHERE video_url LIKE '%supabase.co%'
  LIMIT 5;
"
```

## Safety Checklist

Before running on production:

- [ ] Successfully tested on local copy of production data
- [ ] Verified path extraction works correctly
- [ ] Checked for edge cases in your production URLs
- [ ] Reviewed dry-run output carefully
- [ ] Created backup of production database in Supabase Dashboard
- [ ] Saved rollback SQL generated by script
- [ ] Tested with `--dry-run` multiple times
- [ ] Confirmed local test results match expectations

## Quick Command Reference

```bash
# Clone production → local
./scripts/clone-production-db.sh

# Verify current state
bun scripts/verify-production-urls.ts

# Test migration (dry-run)
bun scripts/update-database-urls.ts --dry-run

# Apply migration locally
bun scripts/update-database-urls.ts

# Check local database
bunx supabase status
psql "postgresql://postgres:postgres@localhost:54322/postgres"

# Reset local database
bunx supabase db reset

# Stop local Supabase
bunx supabase stop
```

## Important Notes

- **Local testing is safe** - Your production database is never touched
- **Always start with dry-run** - Preview changes before applying
- **Local Supabase uses different ports** - Doesn't conflict with production
- **Data is isolated** - Local changes don't sync to production
- **Environment variables matter** - Make sure scripts read correct credentials

## Next Steps After Local Testing

Once you've verified the migration works locally:

1. Review the `MIGRATION_GUIDE.md` for production steps
2. Plan a maintenance window for production migration
3. Create fresh production backup before migration
4. Run production migration with `--dry-run` first
5. Keep Supabase Storage active for 30-day rollback window
