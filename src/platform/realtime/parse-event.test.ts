import { describe, expect, it } from 'vitest';
import {
  everyRealtimeEventIsParsed,
  isSelectedRealtimeEvent,
  parseRealtimeUserEvent,
} from './parse-event';

const balance = {
  event: 'billing.balance:updated',
  channel: 'billing:team_1',
  data: {
    teamId: 'team_1',
    balanceUsd: 12,
    availableUsd: 10,
    reservedUsd: 2,
    asOfMs: 1,
    amountUsd: -1,
  },
};

describe('parseRealtimeUserEvent', () => {
  it('covers every schema path', () => {
    expect(everyRealtimeEventIsParsed).toBe(true);
  });

  it('returns the parsed member and drops unknown or incomplete events', () => {
    const parsed = parseRealtimeUserEvent(balance);
    expect(parsed).toMatchObject({
      event: 'billing.balance:updated',
      channel: 'billing:team_1',
      data: { teamId: 'team_1', balanceUsd: 12 },
    });
    expect(
      parseRealtimeUserEvent({
        ...balance,
        data: { teamId: 'team_1' },
      })
    ).toBeNull();
    expect(
      parseRealtimeUserEvent({
        event: 'not.an.event',
        channel: 'billing:team_1',
        data: {},
      })
    ).toBeNull();
  });

  it('narrows a parsed member to the subscribed event', () => {
    const parsed = parseRealtimeUserEvent(balance);
    if (!parsed) throw new Error('expected a parsed balance event');
    expect(
      isSelectedRealtimeEvent(parsed, ['generation.complete'] as const)
    ).toBe(false);
    if (
      !isSelectedRealtimeEvent(parsed, ['billing.balance:updated'] as const)
    ) {
      throw new Error('expected the balance event to be selected');
    }
    expect(parsed.data.teamId).toBe('team_1');
  });
});
