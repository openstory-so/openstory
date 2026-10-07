/**
 * A look other than the default is drawn from the default look's sheet
 * (#2015). The panel, the refusal, and the generators share these words.
 */

/**
 * The face every other look is drawn from: the default look's selected
 * sheet, whatever its last attempt did. A failed or running re-roll leaves
 * that sheet selected and on screen, and it is still the face; the one the
 * re-roll lands replaces it, and the looks drawn from the old one go stale.
 * `id` is that look's id, which is the character's. A sheet from before
 * versions is the row keyed to that id, and the pointer stays null (#1419).
 */
export function populatedDefaultSheet(sheet: {
  id: string;
  sheetImageUrl: string | null;
  selectedSheetVersionId: string | null;
}): LookSheetFace | null {
  if (!sheet.sheetImageUrl) return null;
  return {
    url: sheet.sheetImageUrl,
    versionId: sheet.selectedSheetVersionId ?? sheet.id,
  };
}

/** The default look's sheet, as a non-default look's payload carries it. */
export type LookSheetFace = { url: string; versionId: string };

type LookFaceSource = {
  id: string;
  isDefault: boolean;
  name: string;
  sheetImageUrl: string | null;
  sheetStatus: string;
  selectedSheetVersionId: string | null;
};

export function defaultLookName(
  looks: readonly { isDefault: boolean; name: string }[]
): string {
  return looks.find((look) => look.isDefault)?.name ?? 'The default look';
}

/**
 * `ready` when the default look has a selected sheet to draw from;
 * `generating` when its first sheet is on the way.
 */
export function defaultLookFaceState(
  looks: readonly LookFaceSource[]
): 'ready' | 'missing' | 'generating' {
  const face = looks.find((look) => look.isDefault);
  if (face && populatedDefaultSheet(face)) return 'ready';
  if (face?.sheetStatus === 'generating') return 'generating';
  return 'missing';
}

/**
 * Why a look other than the default cannot be generated or uploaded.
 * Null when this look is the default, or the default sheet is ready.
 */
export function lookSheetFaceRefusal(
  looks: readonly LookFaceSource[],
  lookIsDefault: boolean
): string | null {
  if (lookIsDefault) return null;
  const state = defaultLookFaceState(looks);
  if (state === 'ready') return null;
  return lookSheetFaceMessage(defaultLookName(looks), state);
}

/** The selected default sheet a non-default look is drawn from. */
export function defaultLookFace(
  looks: readonly LookFaceSource[]
): LookSheetFace | null {
  const face = looks.find((look) => look.isDefault);
  return face ? populatedDefaultSheet(face) : null;
}

/** "Default" is the synthesized name, so the sentence does not say it twice. */
function defaultLookLabel(name: string): string {
  return name.trim().toLowerCase() === 'default'
    ? 'the default look'
    : `the default look, ${name}`;
}

/** What the panel says while the default look itself is on screen. */
export function defaultLookCaption(
  name: string,
  hasOtherLooks: boolean
): string {
  if (!hasOtherLooks) {
    return 'This is the default look. Looks you add keep this face and change the outfit.';
  }
  return `This is ${defaultLookLabel(name)}. Other looks keep this face and change the outfit.`;
}

/**
 * What to tell someone looking at a look that is not the default.
 * `ready` means that look may be generated or uploaded.
 */
export function lookSheetFaceMessage(
  defaultLookName: string,
  state: 'ready' | 'missing' | 'generating'
): string {
  const who = defaultLookLabel(defaultLookName);
  if (state === 'ready') {
    return `Drawn from ${who}. The face stays; the outfit changes.`;
  }
  if (state === 'generating') {
    return `Drawn from ${who}. That sheet is still generating.`;
  }
  return `Drawn from ${who}. Generate that sheet first.`;
}
