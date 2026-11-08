-- #2222: give every existing sequence, character, location and style a slug,
-- unique per organization. HAND-WRITTEN DATA BACKFILL: no schema diff, so
-- generated empty with `bun db:generate --custom`; the unique index lands in
-- the next migration.
--
-- A simpler slugify than `src/platform/slug.ts`: lowercase, every run of
-- characters outside [a-z0-9] becomes one '-', trimmed, cut to 60, empty is
-- 'untitled'. Accented letters become '-' here (JS strips the accent); only
-- new writes and renames use the JS form.
--
-- Collisions in an organization take '-2', '-3' by created_at then id. A
-- suffixed slug that meets a natural one (a title ending in a number) leaves
-- it to the older row; the newer gets its lowercased ULID appended.

WITH RECURSIVE
  src AS (SELECT t.id, t.organization_id AS org, t.created_at, t.title AS name FROM sequences t),
  walk(id, rest, out) AS (
    SELECT id, lower(name), '' FROM src
    UNION ALL
    SELECT id, substr(rest, 2),
      CASE
        WHEN substr(rest, 1, 1) BETWEEN 'a' AND 'z'
          OR substr(rest, 1, 1) BETWEEN '0' AND '9' THEN out || substr(rest, 1, 1)
        WHEN out = '' OR substr(out, -1) = '-' THEN out
        ELSE out || '-'
      END
    FROM walk WHERE rest != ''
  ),
  based AS (
    SELECT src.id, src.org, src.created_at,
      coalesce(nullif(rtrim(substr(rtrim(walk.out, '-'), 1, 60), '-'), ''), 'untitled') AS base
    FROM walk JOIN src ON src.id = walk.id WHERE walk.rest = ''
  ),
  ranked AS (
    SELECT id, org, created_at, base,
      row_number() OVER (PARTITION BY org, base ORDER BY created_at, id) AS n
    FROM based
  ),
  candidate AS (
    SELECT id, org, created_at,
      CASE WHEN n = 1 THEN base ELSE base || '-' || n END AS slug
    FROM ranked
  ),
  final AS (
    SELECT id,
      CASE
        WHEN row_number() OVER (PARTITION BY org, slug ORDER BY created_at, id) = 1 THEN slug
        ELSE slug || '-' || lower(id)
      END AS slug
    FROM candidate
  )
UPDATE sequences SET slug = final.slug FROM final WHERE sequences.id = final.id;
--> statement-breakpoint
WITH RECURSIVE
  src AS (SELECT t.id, t.organization_id AS org, t.created_at, coalesce(v.name, t.name) AS name FROM characters t LEFT JOIN character_bible_versions v ON v.id = t.selected_bible_version_id),
  walk(id, rest, out) AS (
    SELECT id, lower(name), '' FROM src
    UNION ALL
    SELECT id, substr(rest, 2),
      CASE
        WHEN substr(rest, 1, 1) BETWEEN 'a' AND 'z'
          OR substr(rest, 1, 1) BETWEEN '0' AND '9' THEN out || substr(rest, 1, 1)
        WHEN out = '' OR substr(out, -1) = '-' THEN out
        ELSE out || '-'
      END
    FROM walk WHERE rest != ''
  ),
  based AS (
    SELECT src.id, src.org, src.created_at,
      coalesce(nullif(rtrim(substr(rtrim(walk.out, '-'), 1, 60), '-'), ''), 'untitled') AS base
    FROM walk JOIN src ON src.id = walk.id WHERE walk.rest = ''
  ),
  ranked AS (
    SELECT id, org, created_at, base,
      row_number() OVER (PARTITION BY org, base ORDER BY created_at, id) AS n
    FROM based
  ),
  candidate AS (
    SELECT id, org, created_at,
      CASE WHEN n = 1 THEN base ELSE base || '-' || n END AS slug
    FROM ranked
  ),
  final AS (
    SELECT id,
      CASE
        WHEN row_number() OVER (PARTITION BY org, slug ORDER BY created_at, id) = 1 THEN slug
        ELSE slug || '-' || lower(id)
      END AS slug
    FROM candidate
  )
UPDATE characters SET slug = final.slug FROM final WHERE characters.id = final.id;
--> statement-breakpoint
WITH RECURSIVE
  src AS (SELECT t.id, t.organization_id AS org, t.created_at, coalesce(v.name, t.name) AS name FROM sequence_locations t LEFT JOIN location_bible_versions v ON v.id = t.selected_bible_version_id),
  walk(id, rest, out) AS (
    SELECT id, lower(name), '' FROM src
    UNION ALL
    SELECT id, substr(rest, 2),
      CASE
        WHEN substr(rest, 1, 1) BETWEEN 'a' AND 'z'
          OR substr(rest, 1, 1) BETWEEN '0' AND '9' THEN out || substr(rest, 1, 1)
        WHEN out = '' OR substr(out, -1) = '-' THEN out
        ELSE out || '-'
      END
    FROM walk WHERE rest != ''
  ),
  based AS (
    SELECT src.id, src.org, src.created_at,
      coalesce(nullif(rtrim(substr(rtrim(walk.out, '-'), 1, 60), '-'), ''), 'untitled') AS base
    FROM walk JOIN src ON src.id = walk.id WHERE walk.rest = ''
  ),
  ranked AS (
    SELECT id, org, created_at, base,
      row_number() OVER (PARTITION BY org, base ORDER BY created_at, id) AS n
    FROM based
  ),
  candidate AS (
    SELECT id, org, created_at,
      CASE WHEN n = 1 THEN base ELSE base || '-' || n END AS slug
    FROM ranked
  ),
  final AS (
    SELECT id,
      CASE
        WHEN row_number() OVER (PARTITION BY org, slug ORDER BY created_at, id) = 1 THEN slug
        ELSE slug || '-' || lower(id)
      END AS slug
    FROM candidate
  )
UPDATE sequence_locations SET slug = final.slug FROM final WHERE sequence_locations.id = final.id;
--> statement-breakpoint
WITH RECURSIVE
  src AS (SELECT t.id, t.organization_id AS org, t.created_at, t.name AS name FROM styles t),
  walk(id, rest, out) AS (
    SELECT id, lower(name), '' FROM src
    UNION ALL
    SELECT id, substr(rest, 2),
      CASE
        WHEN substr(rest, 1, 1) BETWEEN 'a' AND 'z'
          OR substr(rest, 1, 1) BETWEEN '0' AND '9' THEN out || substr(rest, 1, 1)
        WHEN out = '' OR substr(out, -1) = '-' THEN out
        ELSE out || '-'
      END
    FROM walk WHERE rest != ''
  ),
  based AS (
    SELECT src.id, src.org, src.created_at,
      coalesce(nullif(rtrim(substr(rtrim(walk.out, '-'), 1, 60), '-'), ''), 'untitled') AS base
    FROM walk JOIN src ON src.id = walk.id WHERE walk.rest = ''
  ),
  ranked AS (
    SELECT id, org, created_at, base,
      row_number() OVER (PARTITION BY org, base ORDER BY created_at, id) AS n
    FROM based
  ),
  candidate AS (
    SELECT id, org, created_at,
      CASE WHEN n = 1 THEN base ELSE base || '-' || n END AS slug
    FROM ranked
  ),
  final AS (
    SELECT id,
      CASE
        WHEN row_number() OVER (PARTITION BY org, slug ORDER BY created_at, id) = 1 THEN slug
        ELSE slug || '-' || lower(id)
      END AS slug
    FROM candidate
  )
UPDATE styles SET slug = final.slug FROM final WHERE styles.id = final.id;
