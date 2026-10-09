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
