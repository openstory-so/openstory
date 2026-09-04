import { describe, expect, it, vi } from 'vitest';
import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { usdToMicros } from '@/lib/billing/money';

const sendSequenceReadyEmail = vi.fn();
vi.doMock('@/lib/services/email-service', () => ({
  sendSequenceReadyEmail,
}));

const captureProductEvent = vi.fn();
vi.doMock('@/lib/observability/product-events', () => ({
  captureProductEvent,
}));

const { notifySequenceReady, sequenceReadyDedupKey } =
  await import('./notify-sequence-ready');

function makeScopedDb(opts: { claim: boolean }) {
  const claimReadyEmailSend = vi.fn(async () => opts.claim);
  const releaseReadyEmailSend = vi.fn(async () => undefined);
  const listBySequence = vi.fn(async () => [
    { durationMs: 5000 },
    { durationMs: 5000 },
  ]);
  const getBalance = vi.fn(async () => usdToMicros(6.4));
  const getForUser = vi.fn(async () => ({ title: 'The Long Walk' }));
  const stub = {
    sequences: { claimReadyEmailSend, releaseReadyEmailSend },
    liveRead: {
      sequences: { getForUser },
      shots: { listBySequence },
      billing: { getBalance },
    },
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- helper only touches the claim + liveRead surface
  const scopedDb = stub as unknown as WorkflowScopedDb;
  return { scopedDb, claimReadyEmailSend, releaseReadyEmailSend };
}

const OPTS = {
  sequenceId: 'seq_1',
  ownerEmail: 'owner@example.com',
  sequenceUrl: 'https://openstory.so/sequences/seq_1/scenes',
  posterUrl: '/r2/posters/seq_1.png',
  userId: 'u1',
};

describe('notifySequenceReady', () => {
  it('uses the ${sequenceId}:ready dedup key', () => {
    expect(sequenceReadyDedupKey('seq_1')).toBe('seq_1:ready');
  });

  it('sends once and skips when the claim is already taken', async () => {
    sendSequenceReadyEmail.mockReset();
    captureProductEvent.mockReset();
    sendSequenceReadyEmail.mockResolvedValue({ success: true });

    const first = makeScopedDb({ claim: true });
    expect(
      await notifySequenceReady({ ...OPTS, scopedDb: first.scopedDb })
    ).toBe('sent');

    const second = makeScopedDb({ claim: false });
    expect(
      await notifySequenceReady({ ...OPTS, scopedDb: second.scopedDb })
    ).toBe('skipped');

    expect(sendSequenceReadyEmail).toHaveBeenCalledTimes(1);
    expect(sendSequenceReadyEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'owner@example.com',
        title: 'The Long Walk',
        clipMeta: '2 clips · 10s',
        balanceDisplay: '$6.40',
      })
    );
    expect(captureProductEvent).toHaveBeenCalledWith({
      distinctId: 'u1',
      event: 'sequence_ready_email_sent',
      properties: { sequence_id: 'seq_1' },
    });
    expect(second.claimReadyEmailSend).toHaveBeenCalledWith('seq_1');
    expect(sendSequenceReadyEmail.mock.calls[0]?.[0].watchUrl).toContain(
      'utm_campaign=ready'
    );
  });

  it('skips API-key sequences (notify: false) without claiming', async () => {
    sendSequenceReadyEmail.mockReset();
    const { scopedDb, claimReadyEmailSend } = makeScopedDb({ claim: true });

    expect(
      await notifySequenceReady({
        ...OPTS,
        scopedDb,
        notify: false,
      })
    ).toBe('skipped');

    expect(claimReadyEmailSend).not.toHaveBeenCalled();
    expect(sendSequenceReadyEmail).not.toHaveBeenCalled();
  });

  it('releases the claim when send fails so a retry can re-claim', async () => {
    sendSequenceReadyEmail.mockReset();
    sendSequenceReadyEmail.mockResolvedValue({
      success: false,
      error: 'bounce',
    });
    const { scopedDb, releaseReadyEmailSend } = makeScopedDb({ claim: true });

    await expect(notifySequenceReady({ ...OPTS, scopedDb })).rejects.toThrow(
      'bounce'
    );
    expect(releaseReadyEmailSend).toHaveBeenCalledWith('seq_1');
  });
});
