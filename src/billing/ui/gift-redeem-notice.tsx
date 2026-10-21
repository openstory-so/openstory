import {
  giftRedeemMessage,
  giftRedeemOffersTopUp,
  type GiftRedeemReason,
} from '@/billing/gift-redeem';
import { Alert, AlertDescription } from '@/ui/shadcn/alert';
import { Button } from '@/ui/shadcn/button';
import { openAddCreditsDialog } from './use-add-credits-dialog';

/**
 * The reason for a refused gift code, in plain language.
 * Used-up codes get a top-up button instead of another Redeem click (#2033).
 */
export function GiftRedeemNotice({ reason }: { reason: GiftRedeemReason }) {
  return (
    <div className="flex flex-col gap-3">
      <Alert>
        <AlertDescription>{giftRedeemMessage(reason)}</AlertDescription>
      </Alert>
      {giftRedeemOffersTopUp(reason) ? (
        <Button type="button" onClick={() => openAddCreditsDialog('gift_code')}>
          Top up credits
        </Button>
      ) : null}
    </div>
  );
}
