import { describe, expect, it } from 'vitest';
import {
  combineRealtimeStatus,
  jitterReconnectDelay,
  nextClientReconnectDelay,
  partitionRealtimeChannels,
  REALTIME_RECONNECT_MAX_MS,
  REALTIME_RECONNECT_MIN_MS,
} from './sse-session';

describe('partitionRealtimeChannels', () => {
  it('puts billing on its own stream and leaves talent and sequence together', () => {
    expect(
      partitionRealtimeChannels([
        'talent:01',
        'billing:team',
        'sequence-1',
        'billing:other',
      ])
    ).toEqual({
      billing: ['billing:team', 'billing:other'],
      heavy: ['talent:01', 'sequence-1'],
    });
  });

  it('returns empty groups when nothing is subscribed', () => {
    expect(partitionRealtimeChannels([])).toEqual({ billing: [], heavy: [] });
  });
});

describe('nextClientReconnectDelay', () => {
  it('doubles from one second and caps at thirty', () => {
    expect(nextClientReconnectDelay(0)).toBe(REALTIME_RECONNECT_MIN_MS);
    expect(nextClientReconnectDelay(1)).toBe(2_000);
    expect(nextClientReconnectDelay(2)).toBe(4_000);
    expect(nextClientReconnectDelay(5)).toBe(REALTIME_RECONNECT_MAX_MS);
    expect(nextClientReconnectDelay(20)).toBe(REALTIME_RECONNECT_MAX_MS);
  });
});

describe('jitterReconnectDelay', () => {
  it('spreads a shared delay across half to all of the base', () => {
    expect(jitterReconnectDelay(1_000, 0)).toBe(500);
    expect(jitterReconnectDelay(1_000, 1)).toBe(1_000);
    expect(jitterReconnectDelay(1_000, 0.5)).toBe(750);
  });
});

describe('combineRealtimeStatus', () => {
  it('keeps a connected heavy stream while billing is reconnecting', () => {
    expect(combineRealtimeStatus('connecting', 'connected')).toBe('connected');
    expect(combineRealtimeStatus('error', 'connected')).toBe('connected');
  });

  it('surfaces a heavy failure and a billing-only failure', () => {
    expect(combineRealtimeStatus('connected', 'error')).toBe('error');
    expect(combineRealtimeStatus('error', null)).toBe('error');
    expect(combineRealtimeStatus(null, null)).toBe('disconnected');
  });
});
