import { describe, expect, it } from 'vitest';
import {
  DEV_TUNNEL_ORIGINS,
  DEV_TUNNEL_SLOT_COUNT,
  DEV_TUNNEL_SLOT_NAMES,
  devTunnelHostname,
  devTunnelLocalPort,
  devTunnelName,
  devTunnelOrigin,
  devTunnelSlotNumber,
  isDevTunnelHostname,
  isDevTunnelSlotName,
  slotFromHostname,
  slotFromOrigin,
} from './dev-tunnel-slots';

describe('dev tunnel slots', () => {
  it('names ten slots dev1–dev10', () => {
    expect(DEV_TUNNEL_SLOT_NAMES).toEqual([
      'dev1',
      'dev2',
      'dev3',
      'dev4',
      'dev5',
      'dev6',
      'dev7',
      'dev8',
      'dev9',
      'dev10',
    ]);
    expect(DEV_TUNNEL_SLOT_COUNT).toBe(10);
  });

  it('maps slot 1 to port 3000 and slot 10 to port 3009', () => {
    expect(devTunnelSlotNumber('dev1')).toBe(1);
    expect(devTunnelLocalPort('dev1')).toBe(3000);
    expect(devTunnelSlotNumber('dev10')).toBe(10);
    expect(devTunnelLocalPort('dev10')).toBe(3009);
  });

  it('uses a dedicated named tunnel and HTTPS origin per slot', () => {
    expect(devTunnelName('dev1')).toBe('openstory-dev1');
    expect(devTunnelHostname('dev1')).toBe('dev1.openstory.so');
    expect(devTunnelOrigin('dev3')).toBe('https://dev3.openstory.so');
    expect(devTunnelName('dev10')).toBe('openstory-dev10');
  });

  it('recognizes only the ten public slot hostnames', () => {
    expect(isDevTunnelSlotName('dev1')).toBe(true);
    expect(isDevTunnelSlotName('dev11')).toBe(false);
    expect(isDevTunnelHostname('dev1.openstory.so')).toBe(true);
    expect(isDevTunnelHostname('dev10.openstory.so')).toBe(true);
    expect(isDevTunnelHostname('dev11.openstory.so')).toBe(false);
    expect(isDevTunnelHostname('openstory.so')).toBe(false);
    expect(isDevTunnelHostname('localhost')).toBe(false);
    expect(slotFromHostname('dev4.openstory.so')).toBe('dev4');
    expect(slotFromHostname('DEV4.openstory.so:443')).toBe('dev4');
    expect(slotFromOrigin('https://dev2.openstory.so/login')).toBe('dev2');
    expect(slotFromOrigin('http://localhost:3000')).toBeUndefined();
  });

  it('lists every slot origin for Better Auth trustedOrigins', () => {
    expect(DEV_TUNNEL_ORIGINS).toEqual([
      'https://dev1.openstory.so',
      'https://dev2.openstory.so',
      'https://dev3.openstory.so',
      'https://dev4.openstory.so',
      'https://dev5.openstory.so',
      'https://dev6.openstory.so',
      'https://dev7.openstory.so',
      'https://dev8.openstory.so',
      'https://dev9.openstory.so',
      'https://dev10.openstory.so',
    ]);
  });
});
