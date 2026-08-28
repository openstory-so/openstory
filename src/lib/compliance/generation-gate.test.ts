import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountRestrictedError } from '@/lib/errors';
import type { EnforcementAction } from '@/lib/db/schema/compliance';

const mockLoadComplianceRecords = vi.fn();

vi.doMock('@/lib/db/scoped', () => ({
  loadComplianceRecords: mockLoadComplianceRecords,
}));

const { requireGenerationAllowed } = await import('./generation-gate');

const USER_ID = 'user_1';
const TEAM_ID = 'team_1';
const NOW = new Date('2026-08-12T12:00:00Z');

function enforcementRow(
  overrides: Partial<EnforcementAction> = {}
): EnforcementAction {
  return {
    id: 'enf_1',
    subjectUserId: USER_ID,
    subjectTeamId: null,
    action: 'generation_suspended',
    reason: 'portrait_rights',
    notes: null,
    reportId: null,
    actorUserId: 'admin_1',
    appliedBySystem: null,
    effectiveAt: new Date(NOW.getTime() - 60_000),
    expiresAt: null,
    revokedAt: null,
    revokedByUserId: null,
    revokedReason: null,
    notifiedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  mockLoadComplianceRecords.mockReset();
});

describe('requireGenerationAllowed', () => {
  it('throws ACCOUNT_RESTRICTED when generation is suspended', async () => {
    mockLoadComplianceRecords.mockResolvedValue({
      enforcement: [enforcementRow()],
    });

    await expect(
      requireGenerationAllowed({
        userId: USER_ID,
        teamId: TEAM_ID,
      })
    ).rejects.toBeInstanceOf(AccountRestrictedError);
  });

  it('allows a clean account', async () => {
    mockLoadComplianceRecords.mockResolvedValue({
      enforcement: [],
    });

    await expect(
      requireGenerationAllowed({
        userId: USER_ID,
        teamId: TEAM_ID,
      })
    ).resolves.toBeUndefined();
  });
});
