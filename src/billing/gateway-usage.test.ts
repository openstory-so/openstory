import { describe, expect, it } from 'vitest';
import { gatewayUsageSince } from './gateway-usage';

describe('gatewayUsageSince', () => {
  it('opens at UTC midnight so the range is exactly that many whole days', () => {
    const now = new Date('2026-11-26T03:45:00Z');
    expect(gatewayUsageSince(7, now).toISOString()).toBe(
      '2026-11-20T00:00:00.000Z'
    );
    expect(gatewayUsageSince(30, now).toISOString()).toBe(
      '2026-10-28T00:00:00.000Z'
    );
  });
});
