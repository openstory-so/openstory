/**
 * Is a sequence behind the character it casts (#2017)? Its cast link pins a
 * bible, voice or look version that is not the character's current one. Read
 * off a cast read, so the panel and the cast rail agree with the server's
 * `listCastOfCharacter`, which also counts a live look the sequence has no
 * cast look for yet; that case shows once the list loads.
 */
export type VersionPins = {
  selectedBibleVersionId: string;
  currentBibleVersionId: string | null;
  selectedVoiceVersionId: string | null;
  currentVoiceVersionId: string | null;
  looks: readonly {
    deletedAt: Date | null;
    lookVersionId: string;
    currentLookVersionId: string;
  }[];
};

export function isBehindCurrentVersion(character: VersionPins): boolean {
  if (
    character.currentBibleVersionId !== null &&
    character.selectedBibleVersionId !== character.currentBibleVersionId
  ) {
    return true;
  }
  if (character.selectedVoiceVersionId !== character.currentVoiceVersionId) {
    return true;
  }
  return character.looks.some(
    (look) =>
      look.deletedAt === null &&
      look.lookVersionId !== look.currentLookVersionId
  );
}
