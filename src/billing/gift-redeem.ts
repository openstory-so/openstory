/**
 * Gift-code redeem outcomes (#2033).
 *
 * Known refusals come back as data, not thrown errors, so the gift link and
 * the Credits form can show the reason without an error toast or a retry loop.
 * "Already redeemed" and "fully redeemed" are ordinary end states.
 */

const GIFT_REDEEM_REASONS = [
  'invalid',
  'expired',
  'fully_redeemed',
  'already_redeemed',
  'one_per_account',
] as const;

export type GiftRedeemReason = (typeof GIFT_REDEEM_REASONS)[number];

export type GiftRedeemResult =
  | { status: 'redeemed'; newBalance: number; amountUsd: number }
  | { status: 'refused'; reason: GiftRedeemReason };

const MESSAGES: Record<GiftRedeemReason, string> = {
  invalid: "We couldn't find that gift code.",
  expired: 'This gift code has expired.',
  fully_redeemed: 'This gift code has been fully redeemed.',
  already_redeemed: 'You already redeemed this gift code.',
  one_per_account: 'This gift code can only be redeemed once per account.',
};

export function normalizeGiftCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Redeem stays disabled while a request is out, and after a refusal of this code. */
export function giftCodeSubmitAllowed(input: {
  code: string;
  pending: boolean;
  lockedCode: string | null;
}): boolean {
  const normalized = normalizeGiftCode(input.code);
  return (
    normalized.length > 0 && !input.pending && input.lockedCode !== normalized
  );
}

export function giftRedeemMessage(reason: GiftRedeemReason): string {
  return MESSAGES[reason];
}

/** Settled codes: explain the state and offer a top-up, with no retry. */
export function giftRedeemOffersTopUp(reason: GiftRedeemReason): boolean {
  return reason === 'already_redeemed' || reason === 'fully_redeemed';
}

/**
 * A row already exists for this team. The person who redeemed it hears that
 * they did; anyone else on the account hears the one-per-account limit.
 * A missing holder (deleted user) is the account limit.
 */
export function giftRedeemHolderReason(
  holderUserId: string | null,
  currentUserId: string
): 'already_redeemed' | 'one_per_account' {
  return holderUserId === currentUserId
    ? 'already_redeemed'
    : 'one_per_account';
}
