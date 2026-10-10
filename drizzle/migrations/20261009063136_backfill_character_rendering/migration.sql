-- Custom data migration (#2017): every bible version of a seen character
-- gets a `rendering` — what the character is rendered as — taken from the
-- style of the first sequence that cast it: the style's medium (the sequence's
-- own snapshot first, then the catalog row), else "Photoreal live action". A
-- voice-only version keeps null. Hand-written because it is a pure data backfill, which
-- drizzle-kit cannot emit.
UPDATE `character_bible_versions` SET `rendering` = COALESCE(
  (
    SELECT COALESCE(
      json_extract(ssv.`config`, '$.look.medium'),
      json_extract(st.`config`, '$.look.medium')
    )
    FROM `sequence_cast` sc
    JOIN `sequences` s ON s.`id` = sc.`sequence_id`
    LEFT JOIN `sequence_style_versions` ssv ON ssv.`id` = s.`selected_style_version_id`
    LEFT JOIN `styles` st ON st.`id` = s.`style_id`
    WHERE sc.`character_id` = `character_bible_versions`.`character_id`
    ORDER BY sc.`created_at` ASC, sc.`id` ASC
    LIMIT 1
  ),
  'Photoreal live action'
)
WHERE `voice_only` = 0 AND `rendering` IS NULL;
