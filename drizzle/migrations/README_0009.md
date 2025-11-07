# Migration 0009: Move pg_trgm Extension to Extensions Schema

## Overview

This migration moves the `pg_trgm` (PostgreSQL trigram) extension from the `public` schema to a dedicated `extensions` schema.

## Why This Change?

### Security & Organization

- **Isolates extensions**: Keeps system extensions separate from user data
- **Best Practice**: Follows PostgreSQL recommendations for extension management
- **Maintainability**: Makes it clear which schemas contain extensions vs. application data

### What is pg_trgm?

The trigram extension provides:

- **Fuzzy text search**: Find "cyberpunk" when searching "cyber punk"
- **Fast pattern matching**: LIKE queries with wildcards run much faster
- **Similarity searches**: Used for autocomplete and search-as-you-type
- **Typo-tolerant searches**: Finds close matches even with spelling errors

### Current Usage

Used in `styles` table for fast name searching:

```typescript
// src/lib/db/schema/libraries.ts:92-95
index('idx_styles_name_gin').using(
  'gin',
  table.name.asc().nullsLast().op('gin_trgm_ops')
),
```

## What This Migration Does

1. **Creates `extensions` schema** (if not exists)
2. **Drops pg_trgm from public schema**
3. **Recreates pg_trgm in extensions schema**
4. **Updates search_path** to include extensions schema

## Important Notes

### Search Path

The migration updates the database search path:

```sql
ALTER DATABASE postgres SET search_path TO public, extensions;
```

This ensures that pg_trgm operators (like `gin_trgm_ops`) work without schema qualification.

### Existing Indexes

The GIN index on `styles.name` continues to work without changes because:

- The operators are resolved via the search_path
- Index definitions don't need schema prefixes
- No application code changes required

## Running This Migration

### Local Development

```bash
# Start local Supabase
bun supabase:start

# Run the migration
bun db:migrate
```

### Production

This migration will be applied automatically when deployed, but verify:

1. The `extensions` schema is created
2. The search_path includes `extensions`
3. Text search on styles still works

## Verification

After running the migration, verify:

```sql
-- Check extension is in correct schema
SELECT extname, nspname
FROM pg_extension e
JOIN pg_namespace n ON e.extnamespace = n.oid
WHERE extname = 'pg_trgm';

-- Should return: pg_trgm | extensions

-- Check search_path
SHOW search_path;

-- Should include: public, extensions

-- Test the index still works
EXPLAIN ANALYZE
SELECT * FROM styles
WHERE name ILIKE '%cyber%';

-- Should show: "Index Scan using idx_styles_name_gin"
```

## Rollback

If needed, to rollback:

```sql
DROP EXTENSION IF EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
ALTER DATABASE postgres SET search_path TO public;
```

## References

- [PostgreSQL Extensions Documentation](https://www.postgresql.org/docs/current/sql-createextension.html)
- [pg_trgm Documentation](https://www.postgresql.org/docs/current/pgtrgm.html)
- [Schema Best Practices](https://wiki.postgresql.org/wiki/Don%27t_Do_This#Don.27t_use_public_schema)
