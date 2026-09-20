/**
 * Upload-ledger verdict (#1682). Not a bible field: the script only
 * answers person vs not-a-person (`isPerson`). `real` means the ledger
 * saw an identifiable person (signed or still awaiting a release).
 */
export type Likeness = 'real' | 'none';

/**
 * BytePlus CreateAsset is spent unless this is known not to be a person.
 * A missing value (in-flight payloads) means register.
 */
export function registersWithArk(
  isPerson: boolean | null | undefined
): boolean {
  return isPerson !== false;
}

/** A signed talent portrait is a person; otherwise keep the bible value. */
export function isPersonFromTalentCast(
  isPerson: boolean,
  talentHasSignedRelease: boolean | null | undefined
): boolean {
  return talentHasSignedRelease ? true : isPerson;
}
