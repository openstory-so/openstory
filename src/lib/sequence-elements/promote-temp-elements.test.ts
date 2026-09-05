import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/db/scoped';
import type { TempElementUpload } from './promote-temp-elements';

const mockTriggerWorkflow = vi.fn();
const mockCreate = vi.fn();
const mockEnsureUniqueToken = vi.fn();

vi.doMock('@/lib/workflow/client', () => ({
  triggerWorkflow: mockTriggerWorkflow,
}));

const { promoteTempElements } = await import('./promote-temp-elements');

function makeScopedDb(): ScopedDb {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only sequenceElements.create + ensureUniqueToken
  return {
    sequenceElements: {
      create: mockCreate,
      ensureUniqueToken: mockEnsureUniqueToken,
    },
  } as unknown as ScopedDb;
}

function makeUpload(
  overrides: Partial<TempElementUpload> = {}
): TempElementUpload {
  return {
    tempPath: 'elements/team-1/uploads/up-1.png',
    tempPublicUrl: '/r2/elements/team-1/uploads/up-1.png',
    filename: 'jersey.png',
    token: 'JERSEY',
    description: 'A red jersey',
    consistencyTag: 'red-jersey',
    ...overrides,
  };
}

function promote(uploads: TempElementUpload[], sequenceId = 'seq-1') {
  return promoteTempElements({
    scopedDb: makeScopedDb(),
    teamId: 'team-1',
    userId: 'user-1',
    sequenceId,
    uploads,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTriggerWorkflow.mockResolvedValue('run-1');
  mockEnsureUniqueToken.mockImplementation(
    async (_sequenceId: string, token: string) => token
  );
  mockCreate.mockImplementation(async (values: Record<string, unknown>) => ({
    ...values,
  }));
});

describe('promoteTempElements', () => {
  it('points the row at the uploaded object without moving it', async () => {
    await promote([makeUpload()]);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      sequenceId: 'seq-1',
      token: 'JERSEY',
      imagePath: 'elements/team-1/uploads/up-1.png',
      imageUrl: '/r2/elements/team-1/uploads/up-1.png',
      visionStatus: 'completed',
    });
  });

  it('derives the image URL from the path instead of trusting the payload', async () => {
    await promote([
      makeUpload({ tempPublicUrl: 'https://evil.test/attacker.png' }),
    ]);

    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      imageUrl: '/r2/elements/team-1/uploads/up-1.png',
    });
  });

  it('lets several sequences claim the same upload (multi-model creation)', async () => {
    // One draft upload, one create per selected analysis model. Under the old
    // temp-then-move design the first promotion deleted the object and the
    // rest threw `Source file not found`.
    const upload = makeUpload();
    await Promise.all([promote([upload], 'seq-1'), promote([upload], 'seq-2')]);

    expect(mockCreate).toHaveBeenCalledTimes(2);
    const rows = mockCreate.mock.calls.map((call) => call[0]);
    expect(new Set(rows.map((row) => row.sequenceId))).toEqual(
      new Set(['seq-1', 'seq-2'])
    );
    // Same object, distinct rows.
    expect(new Set(rows.map((row) => row.imagePath)).size).toBe(1);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  it('still promotes a legacy `temp/` draft restored from localStorage', async () => {
    await promote([
      makeUpload({
        tempPath: 'elements/team-1/temp/up-1.png',
        tempPublicUrl: '/r2/elements/team-1/temp/up-1.png',
      }),
    ]);

    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      imagePath: 'elements/team-1/temp/up-1.png',
      imageUrl: '/r2/elements/team-1/temp/up-1.png',
    });
  });

  it('skips a path outside the team namespace', async () => {
    await promote([
      makeUpload({ tempPath: 'elements/team-2/uploads/up-1.png' }),
      makeUpload({ tempPath: 'elements/team-1/../team-2/up-2.png' }),
    ]);

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('falls back to the vision workflow when the draft carries no description', async () => {
    await promote([makeUpload({ description: null, consistencyTag: null })]);

    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      visionStatus: 'pending',
    });
    expect(mockTriggerWorkflow).toHaveBeenCalledWith(
      '/element-vision',
      expect.objectContaining({
        imageUrl: '/r2/elements/team-1/uploads/up-1.png',
        teamId: 'team-1',
        userId: 'user-1',
      }),
      expect.anything()
    );
  });

  it('skips the vision workflow when vision already ran inline', async () => {
    await promote([makeUpload()]);
    expect(mockTriggerWorkflow).not.toHaveBeenCalled();
  });
});
