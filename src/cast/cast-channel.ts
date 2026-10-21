/**
 * The realtime channel a character's sheet and voice runs report on
 * (#2017): the sequence's, or the character's own when the run was started
 * from no sequence (the Characters page). The page that started the run
 * listens on the same id.
 */
export function castChannelId(
  sequenceId: string | null,
  characterId: string
): string {
  return sequenceId ?? `character:${characterId}`;
}

/**
 * The same for a location's sheet run (#1695): the sequence's channel, or
 * the location's own when the run was started from the Locations page.
 */
export function locationChannelId(
  sequenceId: string | null,
  locationId: string
): string {
  return sequenceId ?? `location:${locationId}`;
}
