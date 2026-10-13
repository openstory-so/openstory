-- Custom data migration (#2104): a storyboard run used to copy its first
-- failed unit's error (one shot's clip, still or prompt) onto the sequence
-- and mark the whole sequence failed. Nothing cleared it, so the sequence
-- stayed failed after the shot was fixed or deleted. The run no longer does
-- that; this puts the rows it already wrote back to completed, where the
-- failure is read from the shots themselves.
-- Only the two texts that nothing but a unit failure wrote: a clip's content
-- checker message, and the "N steps failed. First: …" wrapper. A lone unit
-- error of any other wording cannot be told from a run-level one and stays.
-- Hand-written because it is a pure data repair, which drizzle-kit cannot
-- emit.
UPDATE `sequences` SET `status` = 'completed', `status_error` = NULL
WHERE `status` = 'failed'
  AND (
    `status_error` LIKE '%Content checker rejected %'
    OR `status_error` LIKE '% steps failed. First: %'
  );
