import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/platform/server/db/scoped';
import type { DraftElementUploadInput } from '@/cast/draft-element-upload';
import { asStub } from '@/test/as-stub';

const mockTriggerWorkflow = vi.fn();
const mockFileExists = vi.fn();
const mockCreate = vi.fn();
const mockEnsureUniqueToken = vi.fn();
const mockUpdateVisionStatus = vi.fn();
const mockRequireRights = vi.fn();

vi.doMock('@/platform/server/workflow/client', () => ({
  triggerWorkflow: mockTriggerWorkflow,
}));
vi.doMock('#storage', () => ({ fileExists: mockFileExists }));
vi.doMock('@/cast/server/upload-rights', () => ({
  requireUploadRightsFor: mockRequireRights,
}));

const mockUpdate = vi.fn();
const mockGetById = vi.fn();

const {
  assertDraftElementUploadsAttachable,
  attachDraftElementUploads,
  attachElementUpload,
  replaceElementUpload,
} = await import('./attach-element-upload');

function makeScopedDb(): ScopedDb {
  // stub covering only the sequenceElements methods attach calls
  return asStub<ScopedDb>({
    sequenceElements: {
      create: mockCreate,
      update: mockUpdate,
      getById: mockGetById,
      ensureUniqueToken: mockEnsureUniqueToken,
      updateVisionStatus: mockUpdateVisionStatus,
    },
  });
}

function makeUpload(
  overrides: Partial<DraftElementUploadInput> = {}
): DraftElementUploadInput {
  return {
    tempPath: 'elements/organization-1/uploads/up-1.png',
    tempPublicUrl: '/r2/elements/organization-1/uploads/up-1.png',
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
    organizationId: 'organization-1',
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
  mockRequireRights.mockResolvedValue({ depictsRealPerson: false });
});

describe('attachElementUpload', () => {
  it('points the row at the uploaded object without moving it', async () => {
    await attachDrafts([makeUpload()]);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      sequenceId: 'seq-1',
      token: 'JERSEY',
      imagePath: 'elements/organization-1/uploads/up-1.png',
      imageUrl: '/r2/elements/organization-1/uploads/up-1.png',
      visionStatus: 'completed',
    });
  });

  it('derives the image URL from the path instead of trusting the payload', async () => {
    await attachDrafts([
      makeUpload({ tempPublicUrl: 'https://evil.test/attacker.png' }),
    ]);

    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      imageUrl: '/r2/elements/organization-1/uploads/up-1.png',
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

  it('rejects a path outside the organization namespace instead of skipping it', async () => {
    await expect(
      attachDrafts([
        makeUpload({ tempPath: 'elements/organization-2/uploads/x.png' }),
      ])
    ).rejects.toThrow(/outside this organization's storage/);
    await expect(
      attachDrafts([
        makeUpload({
          tempPath: 'elements/organization-1/../organization-2/x.png',
        }),
      ])
    ).rejects.toThrow(/outside this organization's storage/);

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
      'organization-1/uploads/up-1.png'
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
        imageUrl: '/r2/elements/organization-1/uploads/up-1.png',
        organizationId: 'organization-1',
        userId: 'user-1',
      })
    );
  });

  it('marks the row failed when the vision trigger throws', async () => {
    mockTriggerWorkflow.mockRejectedValue(new Error('binding down'));

    await expect(
      attachElementUpload({
        scopedDb: makeScopedDb(),
        organizationId: 'organization-1',
        userId: 'user-1',
        sequenceId: 'seq-1',
        path: 'elements/organization-1/seq-1/el-1.png',
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
        scopedDb: makeScopedDb(),
        organizationId: 'organization-1',
        uploads: [
          makeUpload(),
          makeUpload({ tempPath: 'elements/organization-1/uploads/gone.png' }),
        ],
      })
    ).rejects.toThrow(/no longer available in storage/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('refuses an image with no likeness clearance, checks a clip, and never an audio file (#1581, #1930)', async () => {
    mockFileExists.mockResolvedValue(true);
    mockRequireRights.mockRejectedValueOnce(new Error('not checked'));

    await expect(
      assertDraftElementUploadsAttachable({
        scopedDb: makeScopedDb(),
        organizationId: 'organization-1',
        uploads: [makeUpload()],
      })
    ).rejects.toThrow('not checked');
    expect(mockRequireRights).toHaveBeenCalledWith(
      expect.anything(),
      '/r2/elements/organization-1/uploads/up-1.png'
    );

    mockRequireRights.mockClear();
    await assertDraftElementUploadsAttachable({
      scopedDb: makeScopedDb(),
      organizationId: 'organization-1',
      uploads: [
        makeUpload({
          tempPath: 'elements/organization-1/uploads/walk.mp4',
          filename: 'walk.mp4',
        }),
      ],
    });
    expect(mockRequireRights).toHaveBeenCalledWith(
      expect.anything(),
      '/r2/elements/organization-1/uploads/walk.mp4'
    );

    mockRequireRights.mockClear();
    await assertDraftElementUploadsAttachable({
      scopedDb: makeScopedDb(),
      organizationId: 'organization-1',
      uploads: [
        makeUpload({
          tempPath: 'elements/organization-1/uploads/line.mp3',
          filename: 'line.mp3',
        }),
      ],
    });
    expect(mockRequireRights).not.toHaveBeenCalled();
  });

  it('writes the ledger verdict onto the row as personInMedia (#2238)', async () => {
    mockRequireRights.mockResolvedValue({ depictsRealPerson: true });
    await attachDrafts([makeUpload()]);
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      personInMedia: true,
    });

    mockCreate.mockClear();
    await attachDrafts([
      makeUpload({
        tempPath: 'elements/organization-1/uploads/line.mp3',
        filename: 'line.mp3',
      }),
    ]);
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      personInMedia: false,
    });
  });

  it('rewrites personInMedia on replace from the new upload (#2238)', async () => {
    mockGetById.mockResolvedValue({ id: 'el-1', sequenceId: 'seq-1' });
    mockUpdate.mockImplementation(async (id: string, values: object) => ({
      id,
      uploadedFilename: 'portrait.png',
      token: 'JERSEY',
      ...values,
    }));
    mockRequireRights.mockResolvedValue({ depictsRealPerson: true });

    await replaceElementUpload({
      scopedDb: makeScopedDb(),
      organizationId: 'organization-1',
      userId: 'user-1',
      sequenceId: 'seq-1',
      elementId: 'el-1',
      path: 'elements/organization-1/uploads/portrait.png',
      filename: 'portrait.png',
    });
    expect(mockUpdate.mock.calls[0]?.[1]).toMatchObject({
      personInMedia: true,
    });
  });

  it('refuses a video filename on a non-video stored path (#2153)', async () => {
    mockFileExists.mockResolvedValue(true);

    await expect(
      assertDraftElementUploadsAttachable({
        scopedDb: makeScopedDb(),
        organizationId: 'organization-1',
        uploads: [
          makeUpload({
            tempPath: 'elements/organization-1/uploads/still.png',
            filename: 'walk.mp4',
          }),
        ],
      })
    ).rejects.toThrow(/does not match the stored upload/);
    expect(mockRequireRights).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
