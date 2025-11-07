# Move pg_trgm Extension to Dedicated Extensions Schema

## Summary

This PR moves the `pg_trgm` (PostgreSQL trigram) extension from the `public` schema to a new `extensions` schema, following PostgreSQL best practices for extension management.

## Why This Change?

### Benefits

- **Security**: Isolates system extensions from user/application data
- **Organization**: Clear separation between extensions and application schemas
- **Maintainability**: Makes extension management explicit and easier to audit
- **Best Practice**: Aligns with PostgreSQL community recommendations

### What is pg_trgm?

The trigram extension enables:

- **Fuzzy text search**: Match "cyberpunk" when searching "cyber punk"
- **Fast pattern matching**: Dramatically speeds up LIKE queries with wildcards
- **Similarity searches**: Powers autocomplete and search-as-you-type features
- **Typo tolerance**: Finds close matches even with spelling errors

### Current Usage in Codebase

Used in the `styles` table for fast name searching:

```typescript
// src/lib/db/schema/libraries.ts:92-95
index('idx_styles_name_gin').using(
  'gin',
  table.name.asc().nullsLast().op('gin_trgm_ops')
),
```

## Changes

### Files Added

- `drizzle/migrations/0009_move_pg_trgm_to_extensions_schema.sql` - Migration SQL
- `drizzle/migrations/README_0009.md` - Comprehensive documentation
- `drizzle/migrations/meta/0009_snapshot.json` - Drizzle snapshot

### Files Modified

- `drizzle/migrations/meta/_journal.json` - Updated migration journal

## Migration Details

The migration performs these operations:

1. Creates `extensions` schema (if not exists)
2. Drops `pg_trgm` from `public` schema
3. Recreates `pg_trgm` in `extensions` schema
4. Updates database search_path: `public, extensions`

### Key Points

- ✅ No application code changes required
- ✅ Existing GIN index on `styles.name` continues to work
- ✅ Zero downtime (extension recreated atomically)
- ✅ Operators resolved via search_path
- ✅ Fully reversible (rollback instructions in README)

## Testing Plan

### Before Merging

- [ ] Review SQL migration syntax
- [ ] Verify search_path configuration is appropriate
- [ ] Confirm no hardcoded schema references in queries

### After Deployment

```sql
-- Verify extension location
SELECT extname, nspname
FROM pg_extension e
JOIN pg_namespace n ON e.extnamespace = n.oid
WHERE extname = 'pg_trgm';
-- Expected: pg_trgm | extensions

-- Verify search_path
SHOW search_path;
-- Expected: public, extensions

-- Test index still works
EXPLAIN ANALYZE
SELECT * FROM styles WHERE name ILIKE '%cyber%';
-- Expected: Index Scan using idx_styles_name_gin
```

## Rollback Plan

If issues arise, rollback with:

```sql
DROP EXTENSION IF EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
ALTER DATABASE postgres SET search_path TO public;
```

## Documentation

See `drizzle/migrations/README_0009.md` for:

- Detailed explanation of pg_trgm usage
- Step-by-step migration guide
- Verification instructions
- Rollback procedures
- PostgreSQL best practices references

## Checklist

- [x] Migration SQL created and tested locally
- [x] Drizzle metadata updated (journal, snapshot)
- [x] Comprehensive documentation written
- [x] No application code changes required
- [x] Commit message follows project conventions
- [ ] PR reviewed and approved
- [ ] Ready to merge (DO NOT run migration until approved)

## Notes

⚠️ **Important**: This PR does NOT run the migration automatically. The migration will need to be run manually or via CI/CD after approval.

## Related Issues

Closes the issue requesting pg_trgm schema reorganization.
