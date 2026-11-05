import { describe, expect, it, vi } from 'vitest';
import { AttestationRequiredError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';

const callLLMStream = vi.fn();
vi.doMock('@/models/server/llm-client', () => ({
  callLLMStream,
  llmCostFromUsage: () => 0,
}));

const { describeUpload } = await import('./describe-upload');

const organizationId = '01J00000000000000000000000';
const url = `/r2/characters/org/${organizationId}/characters/drafts/x.jpg`;

function scopedDbWithLedger(rows: unknown[]) {
  return {
    organizationId,
    compliance: {
      attestations: { listForSubject: vi.fn(() => Promise.resolve(rows)) },
    },
    apiKeys: { resolveLlmKey: vi.fn() },
    billing: { hasEnoughCredits: vi.fn(), deductCredits: vi.fn() },
  } as unknown as ScopedDb;
}

describe('describeUpload', () => {
  it('sends nothing to the model for an upload with no likeness verdict', async () => {
    await expect(
      describeUpload({
        scopedDb: scopedDbWithLedger([]),
        userId: 'u',
        url,
        filename: 'x.jpg',
        subject: 'character',
      })
    ).rejects.toBeInstanceOf(AttestationRequiredError);
    expect(callLLMStream).not.toHaveBeenCalled();
  });
});
