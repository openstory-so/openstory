import { describe, expect, it, vi } from 'vitest';

const env: Record<string, string | undefined> = {};
vi.doMock('#env', () => ({ getEnv: () => env }));
const { gatewayPlatformFeeBps } = await import('./platform-fee');

describe('gatewayPlatformFeeBps', () => {
  it('is 0 when unset or empty', () => {
    env.GATEWAY_PLATFORM_FEE_BPS = undefined;
    expect(gatewayPlatformFeeBps()).toBe(0);
    env.GATEWAY_PLATFORM_FEE_BPS = '';
    expect(gatewayPlatformFeeBps()).toBe(0);
  });

  it('reads a whole number of basis points', () => {
    env.GATEWAY_PLATFORM_FEE_BPS = '250';
    expect(gatewayPlatformFeeBps()).toBe(250);
    env.GATEWAY_PLATFORM_FEE_BPS = '10000';
    expect(gatewayPlatformFeeBps()).toBe(10_000);
  });

  it.each(['-1', '2.5', '10001', 'abc', ' 5', '5%'])('refuses %j', (raw) => {
    env.GATEWAY_PLATFORM_FEE_BPS = raw;
    expect(() => gatewayPlatformFeeBps()).toThrow('GATEWAY_PLATFORM_FEE_BPS');
  });
});
