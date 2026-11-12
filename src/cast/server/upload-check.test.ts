import { describe, expect, it, vi } from 'vitest';
import { generateId } from '@/platform/id';
import type { EnforcementRow } from '@/platform/server/compliance/enforcement';

const mockLoadComplianceRecords = vi.fn();
vi.doMock('@/platform/server/db/scoped', () => ({
  loadComplianceRecords: mockLoadComplianceRecords,
}));

const { checkFailure, requireUploadCheckAllowed } =
  await import('./upload-check');
const { STORAGE_BUCKETS } = await import('@/platform/server/storage/buckets');

const suspended: EnforcementRow = {
  id: generateId(),
  action: 'generation_suspended',
  reason: 'portrait_rights',
  notes: null,
  effectiveAt: new Date(Date.now() - 60_000),
  expiresAt: null,
  revokedAt: null,
};

const upload = (contentType: string) => ({
  bucket: STORAGE_BUCKETS.TALENT,
  contentType,
  organizationId: generateId(),
  userId: generateId(),
});

describe('requireUploadCheckAllowed (#2192)', () => {
  it('refuses a checked upload before any bytes when the check could not start', async () => {
    mockLoadComplianceRecords.mockResolvedValue({ enforcement: [suspended] });
    await expect(
      requireUploadCheckAllowed(upload('image/png'))
    ).rejects.toThrow('New generations are paused');
  });

  it('lets an upload the check never judges through without a lookup', async () => {
    mockLoadComplianceRecords.mockClear();
    await requireUploadCheckAllowed(upload('audio/mpeg'));
    expect(mockLoadComplianceRecords).not.toHaveBeenCalled();
  });

  it('lets a clean account through', async () => {
    mockLoadComplianceRecords.mockResolvedValue({ enforcement: [] });
    await requireUploadCheckAllowed(upload('video/mp4'));
  });
});

describe('checkFailure', () => {
  const failed = (error: string | null) =>
    checkFailure({ attempt: 1, status: 'errored', error });

  it('keeps a refusal the engine reports as `Error: CODE: message`', () => {
    const error = failed(
      'Error: INSUFFICIENT_CREDITS: Insufficient credits for talent vision'
    );
    expect(error.code).toBe('INSUFFICIENT_CREDITS');
    expect(error.message).toBe('Insufficient credits for talent vision');
    expect(error.statusCode).toBe(400);
  });

  it('keeps a refusal reported as `CODE: message`', () => {
    expect(failed('VALIDATION_ERROR: Not readable').code).toBe(
      'VALIDATION_ERROR'
    );
  });

  it('reports any other failure as a stopped check', () => {
    expect(failed('Error: fetch failed').code).toBe('UPLOAD_CHECK_FAILED');
    expect(failed(null).code).toBe('UPLOAD_CHECK_FAILED');
  });
});
