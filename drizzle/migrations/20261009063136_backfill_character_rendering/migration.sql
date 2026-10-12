-- Custom data migration (#2017): every bible version of a seen character
-- gets a `rendering` — what the character is rendered as — taken from the
-- style of the first sequence that cast it: the style's medium (the
-- sequence's own snapshot first, then the catalog row), else the medium its
-- system template is given in this same release, by the style's name (a
-- stored config from before it has none), else "Photoreal live action".
-- Never the art style: that is scene prose. A voice-only version keeps
-- null. Hand-written because it is a pure data backfill, which drizzle-kit
-- cannot emit.
UPDATE `character_bible_versions` SET `rendering` = COALESCE(
  (
    SELECT COALESCE(
      NULLIF(TRIM(json_extract(ssv.`config`, '$.look.medium')), ''),
      NULLIF(TRIM(json_extract(st.`config`, '$.look.medium')), ''),
      CASE st.`name`
        WHEN 'Animatic' THEN 'Rough pencil-and-marker pre-vis sketch'
        WHEN 'Animated' THEN 'Stylized painterly animation'
        WHEN 'Bedtime Storybook' THEN 'Hand-painted storybook illustration'
        WHEN 'Saturday Morning Cartoon' THEN 'Flat 2D cartoon animation'
        WHEN 'Claymation' THEN 'Stop-motion claymation'
        WHEN 'Paper Cutout' THEN 'Stop-motion paper cutout animation'
        WHEN 'Watercolour Fable' THEN 'Watercolor illustration'
        WHEN 'Pop-Up Book' THEN 'Layered papercraft diorama'
        WHEN 'Felt and Yarn' THEN 'Stop-motion felt and yarn puppet animation'
        WHEN 'Chalkboard Doodle' THEN 'Chalk drawing on a blackboard'
        WHEN 'Lo-Fi Anime' THEN '2D cel-shaded anime'
        WHEN 'Hand-Drawn Picture Book' THEN 'Crayon and colored-pencil picture book illustration'
        WHEN 'Rough Storyboard' THEN 'Rough pencil-and-marker storyboard sketch'
        WHEN 'Low-Detail Blockout' THEN 'Untextured 3D greybox blockout'
        WHEN 'Mood-Only Frames' THEN 'Painterly still-frame painting'
        WHEN 'Black & White Previz' THEN 'Monochrome previz render'
        WHEN 'Schematic Concept' THEN 'Diagrammatic line illustration'
        WHEN 'Marker Rough' THEN 'Marker comp illustration'
        WHEN 'Greyscale Layout' THEN 'Greyscale tonal painting'
      END
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
