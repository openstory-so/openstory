import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { DraftElementUploadInput } from '@/cast/draft-element-upload';

const mockTriggerWorkflow = vi.fn();
const mockFileExists = vi.fn();
const mockCreate = vi.fn();
const mockEnsureUniqueToken = vi.fn();
const mockUpdateVisionStatus = vi.fn();

vi.doMock('@/platform/server/workflow/client', () => ({
  triggerWorkflow: mockTriggerWorkflow,
}));
vi.doMock('#storage', () => ({ fileExists: mockFileExists }));

const {
  assertDraftElementUploadsAttachable,
  attachDraftElementUploads,
  attachElementUpload,
} = await import('./attach-element-upload');

function makeScopedDb(): ScopedDb {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- stub covering only the sequenceElements methods attach calls
  return {
    sequenceElements: {
      create: mockCreate,
      ensureUniqueToken: mockEnsureUniqueToken,
      updateVisionStatus: mockUpdateVisionStatus,
    },
  } as unknown as ScopedDb;
}

function makeUpload(
  overrides: Partial<DraftElementUploadInput> = {}
): DraftElementUploadInput {
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

function attachDrafts(
  uploads: DraftElementUploadInput[],
  sequenceId = 'seq-1'
) {
  return attachDraftElementUploads({
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
  mockFileExists.mockResolvedValue(true);
  mockEnsureUniqueToken.mockImplementation(
    async (_sequenceId: string, token: string) => token
  );
  mockCreate.mockImplementation(async (values: Record<string, unknown>) => ({
    ...values,
  }));
});

describe('attachElementUpload', () => {
  it('points the row at the uploaded object without moving it', async () => {
    await attachDrafts([makeUpload()]);

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
    await attachDrafts([
      makeUpload({ tempPublicUrl: 'https://evil.test/attacker.png' }),
    ]);

    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      imageUrl: '/r2/elements/team-1/uploads/up-1.png',
    });
  });

  it('lets several sequences claim the same upload (multi-model creation)', async () => {
    // One draft upload, one create per selected analysis model. Under the old
    // temp-then-move design the first attach deleted the object and the rest
    // threw `Source file not found`.
    const upload = makeUpload();
    await Promise.all([
      attachDrafts([upload], 'seq-1'),
      attachDrafts([upload], 'seq-2'),
    ]);

    const rows = mockCreate.mock.calls.map((call) => call[0]);
    expect(new Set(rows.map((row) => row.sequenceId))).toEqual(
      new Set(['seq-1', 'seq-2'])
    );
    // Same object, distinct rows.
    expect(new Set(rows.map((row) => row.imagePath)).size).toBe(1);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  it('rejects a path outside the team namespace instead of skipping it', async () => {
    await expect(
      attachDrafts([makeUpload({ tempPath: 'elements/team-2/uploads/x.png' })])
    ).rejects.toThrow(/outside this team's storage/);
    await expect(
      attachDrafts([
        makeUpload({ tempPath: 'elements/team-1/../team-2/x.png' }),
      ])
    ).rejects.toThrow(/outside this team's storage/);

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects an upload whose object is missing from storage', async () => {
    // The `moveFile` this replaced was the only thing proving the object
    // existed; without a check the row would point at a permanent 404.
    mockFileExists.mockResolvedValue(false);

    await expect(attachDrafts([makeUpload()])).rejects.toThrow(
      /no longer available in storage/
    );
    expect(mockFileExists).toHaveBeenCalledWith(
      'elements',
      'team-1/uploads/up-1.png'
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('falls back to the vision workflow when the draft carries no description', async () => {
    await attachDrafts([
      makeUpload({ description: null, consistencyTag: null }),
    ]);

    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      visionStatus: 'pending',
    });
    expect(mockTriggerWorkflow).toHaveBeenCalledWith(
      '/element-vision',
      expect.objectContaining({
        imageUrl: '/r2/elements/team-1/uploads/up-1.png',
        teamId: 'team-1',
        userId: 'user-1',
      })
    );
  });

  it('marks the row failed when the vision trigger throws', async () => {
    mockTriggerWorkflow.mockRejectedValue(new Error('binding down'));

    await expect(
      attachElementUpload({
        scopedDb: makeScopedDb(),
        teamId: 'team-1',
        userId: 'user-1',
        sequenceId: 'seq-1',
        path: 'elements/team-1/seq-1/el-1.png',
        filename: 'jersey.png',
      })
    ).rejects.toThrow('binding down');

    expect(mockUpdateVisionStatus).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      'binding down'
    );
  });

  it('derives a token from the filename when the draft carries none', async () => {
    await attachDrafts([makeUpload({ token: null })]);
    expect(mockEnsureUniqueToken).toHaveBeenCalledWith('seq-1', 'JERSEY');
  });
});

describe('assertDraftElementUploadsAttachable', () => {
  it('rejects the whole batch before create writes anything', async () => {
    // Runs ahead of the per-model fan-out in createSequences: a failure once a
    // sequence row exists would strand that row with no workflow behind it.
    mockFileExists.mockImplementation(
      async (_bucket: string, path: string) => !path.endsWith('gone.png')
    );

    await expect(
      assertDraftElementUploadsAttachable({
        teamId: 'team-1',
        uploads: [
          makeUpload(),
          makeUpload({ tempPath: 'elements/team-1/uploads/gone.png' }),
        ],
      })
    ).rejects.toThrow(/no longer available in storage/);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
