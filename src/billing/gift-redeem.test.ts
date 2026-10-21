import { describe, expect, it } from 'vitest';
import {
  giftCodeSubmitAllowed,
  giftRedeemHolderReason,
  giftRedeemMessage,
  giftRedeemOffersTopUp,
  normalizeGiftCode,
} from './gift-redeem';

describe('gift redeem reasons', () => {
  it('normalizes a code the way the server looks it up', () => {
    expect(normalizeGiftCode('  ab12cd ')).toBe('AB12CD');
  });

  it('says who already redeemed, and when the account limit is the reason', () => {
    expect(giftRedeemHolderReason('user_1', 'user_1')).toBe('already_redeemed');
    expect(giftRedeemHolderReason('user_1', 'user_2')).toBe('one_per_account');
    expect(giftRedeemHolderReason(null, 'user_2')).toBe('one_per_account');
  });

  it('offers a top-up for codes that are already used up', () => {
    expect(giftRedeemOffersTopUp('already_redeemed')).toBe(true);
    expect(giftRedeemOffersTopUp('fully_redeemed')).toBe(true);
    expect(giftRedeemOffersTopUp('invalid')).toBe(false);
    expect(giftRedeemOffersTopUp('expired')).toBe(false);
    expect(giftRedeemOffersTopUp('one_per_account')).toBe(false);
  });

  it('blocks another submit of a code that was already refused', () => {
    expect(
      giftCodeSubmitAllowed({
        code: 'WWMMHX',
        pending: false,
        lockedCode: 'WWMMHX',
      })
    ).toBe(false);
    expect(
      giftCodeSubmitAllowed({
        code: 'WWMMHX',
        pending: true,
        lockedCode: null,
      })
    ).toBe(false);
    expect(
      giftCodeSubmitAllowed({
        code: 'V6VZUD',
        pending: false,
        lockedCode: 'WWMMHX',
      })
    ).toBe(true);
    expect(
      giftCodeSubmitAllowed({ code: '  ', pending: false, lockedCode: null })
    ).toBe(false);
  });

  it('gives each reason a specific sentence', () => {
    expect(giftRedeemMessage('invalid')).toBe(
      "We couldn't find that gift code."
    );
    expect(giftRedeemMessage('expired')).toBe('This gift code has expired.');
    expect(giftRedeemMessage('fully_redeemed')).toBe(
      'This gift code has been fully redeemed.'
    );
    expect(giftRedeemMessage('already_redeemed')).toBe(
      'You already redeemed this gift code.'
    );
    expect(giftRedeemMessage('one_per_account')).toBe(
      'This gift code can only be redeemed once per account.'
    );
  });
});
