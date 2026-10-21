import { describe, expect, it, vi } from 'vitest';

const captureProductEvent = vi.fn();
vi.doMock('@/platform/server/observability/product-events', () => ({
  captureProductEvent,
}));

const warn = vi.fn();
vi.doMock('@/platform/logger', () => ({
  getLogger: () => ({ warn }),
}));

const { reportGiftRedeemRefusal } = await import('./gift-redeem-report');

describe('reportGiftRedeemRefusal', () => {
  it('logs the code, reason, user, and team, and sends the PostHog event', () => {
    captureProductEvent.mockClear();
    warn.mockClear();

    reportGiftRedeemRefusal({
      code: ' wwmmhx ',
      reason: 'fully_redeemed',
      userId: 'user_1',
      teamId: 'team_1',
    });

    expect(warn).toHaveBeenCalledWith('Gift code redeem refused', {
      code: 'WWMMHX',
      reason: 'fully_redeemed',
      userId: 'user_1',
      teamId: 'team_1',
    });
    expect(captureProductEvent).toHaveBeenCalledWith({
      distinctId: 'user_1',
      event: 'gift_code_redeem_failed',
      properties: {
        reason: 'fully_redeemed',
        code: 'WWMMHX',
        teamId: 'team_1',
      },
    });
  });
});
