import {
  normalizeGiftCode,
  type GiftRedeemReason,
} from '@/billing/gift-redeem';
import { getLogger } from '@/platform/logger';
import { captureProductEvent } from '@/platform/server/observability/product-events';

const logger = getLogger(['openstory', 'billing', 'gift-redeem']);

/**
 * A refused redeem is a normal outcome. Log it and send
 * `gift_code_redeem_failed` so a repeat click is visible with a reason (#2033).
 * Never throws.
 */
export function reportGiftRedeemRefusal(args: {
  code: string;
  reason: GiftRedeemReason;
  userId: string;
  organizationId: string;
}): void {
  const code = normalizeGiftCode(args.code);
  logger.warn('Gift code redeem refused', {
    code,
    reason: args.reason,
    userId: args.userId,
    organizationId: args.organizationId,
  });
  captureProductEvent({
    distinctId: args.userId,
    event: 'gift_code_redeem_failed',
    properties: {
      reason: args.reason,
      code,
      organizationId: args.organizationId,
    },
  });
}
