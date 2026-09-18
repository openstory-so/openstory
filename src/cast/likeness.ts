/**
 * Who a character sheet depicts (#1682). Answers two questions: whether
 * BytePlus CreateAsset must register the still, and whether a signed
 * likeness release is required.
 *
 *   real       — an actual, identifiable person. Register; needs a release.
 *   fictional  — a made-up person (generated, or an uploaded AI face).
 *                Register; no release. Ark cannot tell this from `real`.
 *   none       — not a person (robot, animal, creature, object). Plain URL.
 *
 * A missing value (in-flight checkpoints, pre-column rows) means register.
 */
export type Likeness = 'real' | 'fictional' | 'none';

export function registersWithArk(
  likeness: Likeness | null | undefined
): boolean {
  return likeness !== 'none';
}

/** A signed talent portrait stamps `real`; otherwise keep the bible value. */
export function likenessFromTalentCast(
  bibleLikeness: Likeness,
  talentHasSignedRelease: boolean | null | undefined
): Likeness {
  if (talentHasSignedRelease) return 'real';
  return bibleLikeness === 'none' ? 'none' : 'fictional';
}

/** The script bible never carries `real`. */
export function bibleLikeness(likeness: Likeness): 'fictional' | 'none' {
  return likeness === 'none' ? 'none' : 'fictional';
}
