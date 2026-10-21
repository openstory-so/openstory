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

/**
 * A signed uploaded portrait is a person; a cleared or missing ledger
 * row does not flip the bible (`isPerson` includes stylised people).
 */
export function isPersonFromUploadLedger(
  isPerson: boolean,
  likeness: Likeness | null | undefined
): boolean {
  return likeness === 'real' ? true : isPerson;
}

/**
 * Why a character must stay a person (#2065): it is cast with a talent that
 * is a real person, or a sheet it wears is an upload the ledger saw a real
 * person in. Null leaves `isPerson` to the bible. Computed server-side
 * (`personLocksOf`); never taken off the client.
 */
export type PersonLock =
  | { reason: 'talent'; talentName: string }
  | { reason: 'upload' };

/** The one line the form shows and the refused edit answers with. */
export function personLockMessage(lock: PersonLock): string {
  switch (lock.reason) {
    case 'talent':
      return `Cast with ${lock.talentName}, a real person.`;
    case 'upload':
      return 'Its sheet is an uploaded photo of a real person.';
  }
}
