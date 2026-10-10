/**
 * The portrait is a paid call the sheet run's reservation does not cover:
 * it is drawn only when the team can pay, recorded, then charged.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import { asStub } from '@/test/as-stub';

const mockGenerate = vi.fn();
const mockStore = vi.fn();
const mockDeduct = vi.fn();
const mockRecordProvenance = vi.fn();
const mockCreateReservation = vi.fn();
const mockZeroReservation = vi.fn();
const mockDeleteFile = vi.fn();

vi.doMock('#storage', () => ({ deleteFile: mockDeleteFile }));
vi.doMock('@/stills/server/image-generation', () => ({
  generateImageWithProvider: mockGenerate,
}));
vi.doMock('@/stills/server/image-storage', () => ({
  storeGeneratedPng: mockStore,
}));
vi.doMock('@/billing/server/workflow-deduction', () => ({
  deductWorkflowCredits: mockDeduct,
  extractImageCost: () => 33_600,
}));
vi.doMock('@/billing/server/fal-pricing-live', () => ({
  getEffectiveFalPricing: () => Promise.resolve(new Map()),
}));
vi.doMock('@/platform/server/compliance/provenance', () => ({
  recordProvenance: mockRecordProvenance,
}));

const { drawSheetPortrait } = await import('./sheet-portrait');

const scopedDb = asStub<WorkflowScopedDb>({
  teamId: 'team-1',
  provenance: {},
  billing: {
    createReservation: mockCreateReservation,
    zeroReservation: mockZeroReservation,
  },
});

const draw = () =>
  drawSheetPortrait({
    scopedDb,
    kind: 'character',
    sheetUrl: '/r2/characters/team-1/seq-1/char-1/sheet.png',
    storageDir: 'team-1/seq-1/char-1',
    subjectId: 'char-1',
    chargeKey: 'run-1',
    userId: 'user-1',
    sequenceId: 'seq-1',
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateReservation.mockResolvedValue({
    ok: true,
    reservationId: 'hold-1',
    remaining: 33_600,
    replay: false,
  });
  mockGenerate.mockResolvedValue({
    imageUrls: ['https://provider.example/out.png'],
    metadata: { usedOwnKey: false, requestId: 'req-1' },
    via: 'google',
  });
  mockStore.mockResolvedValue({
    url: '/r2/characters/team-1/seq-1/char-1/p-portrait.png',
    path: 'team-1/seq-1/char-1/p-portrait.png',
  });
});

describe('drawSheetPortrait', () => {
  it('makes no paid call when the team cannot pay', async () => {
    mockCreateReservation.mockResolvedValue({ ok: false });

    expect(await draw()).toBeNull();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockDeduct).not.toHaveBeenCalled();
  });

  it('draws from the sheet, records it, then charges once per run', async () => {
    expect(await draw()).toBe(
      '/r2/characters/team-1/seq-1/char-1/p-portrait.png'
    );
    expect(mockGenerate.mock.calls[0]?.[0].referenceImageUrls).toEqual([
      '/r2/characters/team-1/seq-1/char-1/sheet.png',
    ]);
    expect(mockRecordProvenance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        assetKind: 'character_sheet',
        assetId: 'char-1',
        storageKey: 'team-1/seq-1/char-1/p-portrait.png',
        workflowRunId: 'run-1',
      })
    );
    expect(mockDeduct).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'run-1:portrait',
        reservationId: 'hold-1',
      })
    );
    // The hold is taken before the paid call and released after the charge.
    expect(mockCreateReservation.mock.invocationCallOrder[0]).toBeLessThan(
      mockGenerate.mock.invocationCallOrder[0] ?? 0
    );
    expect(mockZeroReservation).toHaveBeenCalledWith('hold-1');
    // The audit row comes before the charge.
    expect(mockRecordProvenance.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeduct.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('releases the hold and charges nothing when the call fails', async () => {
    mockGenerate.mockRejectedValue(new Error('content flagged'));

    expect(await draw()).toBeNull();
    expect(mockDeduct).not.toHaveBeenCalled();
    expect(mockZeroReservation).toHaveBeenCalledWith('hold-1');
  });

  it('still charges a paid call whose image could not be recorded, and keeps no image', async () => {
    mockRecordProvenance.mockRejectedValue(new Error('d1 down'));

    expect(await draw()).toBeNull();
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
    expect(mockDeduct).toHaveBeenCalledTimes(1);
  });

  it('throws when the charge for a paid call cannot be taken', async () => {
    mockDeduct.mockRejectedValue(new Error('ledger down'));

    await expect(draw()).rejects.toThrow('ledger down');
  });
});
