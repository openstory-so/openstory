---
name: block-d1-unsafe-migration-sql
enabled: true
event: file
action: block
conditions:
  - field: file_path
    operator: regex_match
    pattern: drizzle/migrations/.*/migration\.sql$
  - field: new_text
    operator: regex_match
    pattern: (EXISTS\s*\(\s*SELECT|NOT\s+EXISTS\s*\(\s*SELECT|DROP\s+TABLE|__new_|UPDATE[^;]{0,600}=\s*\(\s*SELECT|COALESCE\s*\([^;]{0,400}\(\s*SELECT)
---

🚫 **D1-unsafe migration SQL blocked**

This migration SQL matches patterns that have **frozen production deploys** on Cloudflare D1 (issues **#612**, **#1019**).

**What was detected (one or more):**

- `WHERE EXISTS (SELECT …)` or `NOT EXISTS (SELECT …)` on an **UPDATE** — per-row correlated subquery; trips D1 remote CPU limit (7429)
- `SET col = (SELECT …)` on an **UPDATE** — same failure class
- `COALESCE(…, (SELECT …))` with a correlated `WHERE` inside an **INSERT … SELECT** — O(scenes × shots) without an index
- `DROP TABLE` / `__new_` table-rebuild shuffle — **ON DELETE CASCADE** fires inside D1’s implicit transaction (#612)

**Safe patterns instead:**

1. **Backfill UPDATE:** set-based join — `UPDATE target SET … FROM (…) AS src WHERE target.id = src.id`
2. **Backfill INSERT:** one windowed pass — `ROW_NUMBER() OVER (PARTITION BY …)` in a subquery, then `JOIN` (see #1019 / #1030 migrations)
3. **Schema change:** prefer `ALTER TABLE … ADD COLUMN` / `RENAME COLUMN` — never table rebuild via `__new_`

**Before committing migration SQL:**

```bash
bun scripts/check-migrations.ts drizzle/migrations/<dir>/migration.sql
```

Must exit 0. Lefthook runs this on staged `drizzle/migrations/**/*.sql` at pre-commit.

See **AGENTS.md § D1 table-rebuild trap** and `scripts/check-migrations.ts`.
