/**
 * Save face as talent keeps the rights gate across the copy (#2018): an
 * uploaded sheet carries its ledger row and `isHuman` to the talent, an
 * upload with no ledger row is refused, a generated sheet is an AI face.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { AttestationRequiredError } from '@/platform/errors';
import { asStub } from '@/test/as-stub';

const requireUploadRights = vi.fn();
const carryUploadRights = vi.fn(async () => undefined);
const enqueueLibraryTalentSheet = vi.fn(async () => 'run-1');

vi.doMock('@/cast/server/upload-rights', () => ({
  requireUploadRights,
  carryUploadRights,
}));
vi.doMock('./enqueue-library-talent-sheet', () => ({
  enqueueLibraryTalentSheet,
}));

const { saveCharacterFaceAsTalent, talentSheetStoragePath } =
  await import('./save-character-face');

const UPLOAD_URL = '/r2/sequences/team-1/uploads/mia.png';
const character = {
  id: 'char-1',
  name: 'Mia',
  characterId: 'mia',
  physicalDescription: 'tall, red hair',
  selectedSheetVersionId: 'sheet-1',
  sheetImageUrl: UPLOAD_URL,
  age: '',
  gender: '',
  ethnicity: '',
  standardClothing: '',
  distinguishingFeatures: '',
  personality: '',
  movement: '',
  voiceDescription: '',
  voiceOnly: false,
  isPerson: true,
  consistencyTag: 'mia',
  looks: [],
};

const talentCreate = vi.fn(async (row: { isHuman: boolean }) => ({
  id: 'tal-1',
  name: 'Mia',
  description: 'tall, red hair',
  ...row,
}));

function scopedDb(sheet: { model: string; url: string } | null): ScopedDb {
  // stub covering only what saveCharacterFaceAsTalent reads
  return asStub<ScopedDb>({
    sequences: { getForUser: vi.fn(async () => ({ id: 'seq-1' })) },
    characters: { getById: vi.fn(async () => character) },
    characterSheetVariants: { getById: vi.fn(async () => sheet) },
    talent: { create: talentCreate },
  });
}

const ctx = { userId: 'u1', teamId: 'team-1' };
const args = { sequenceId: 'seq-1', characterId: 'char-1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('saveCharacterFaceAsTalent', () => {
  it('an uploaded sheet of a real person: the talent is human and its sheet URL is covered before the run', async () => {
    requireUploadRights.mockResolvedValue(
      new Map([[UPLOAD_URL, { depictsRealPerson: true }]])
    );

    const result = await saveCharacterFaceAsTalent(
      scopedDb({ model: 'user-upload', url: UPLOAD_URL }),
      ctx,
      args
    );

    expect(talentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ isHuman: true })
    );
    const [, from, to] = carryUploadRights.mock.calls[0] ?? [];
    const sheetId = asStub<{ sheetId: string }>(
      enqueueLibraryTalentSheet.mock.calls[0]?.[1]
    ).sheetId;
    expect(from).toBe(UPLOAD_URL);
    expect(to).toContain(talentSheetStoragePath('team-1', 'tal-1', sheetId));
    expect(carryUploadRights.mock.invocationCallOrder[0]).toBeLessThan(
      enqueueLibraryTalentSheet.mock.invocationCallOrder[0] ?? 0
    );
    expect(enqueueLibraryTalentSheet.mock.calls[0]?.[1]).toMatchObject({
      talentId: 'tal-1',
      activity: 'portrait',
      workflowInput: expect.objectContaining({ uploadedSheetUrl: UPLOAD_URL }),
    });
    expect(result.runId).toBe('run-1');
  });

  it('an upload with no ledger row is refused before any row is written', async () => {
    requireUploadRights.mockRejectedValue(
      new AttestationRequiredError(
        'This image has not been checked for a real person yet'
      )
    );

    await expect(
      saveCharacterFaceAsTalent(
        scopedDb({ model: 'user-upload', url: UPLOAD_URL }),
        ctx,
        args
      )
    ).rejects.toBeInstanceOf(AttestationRequiredError);
    expect(talentCreate).not.toHaveBeenCalled();
    expect(enqueueLibraryTalentSheet).not.toHaveBeenCalled();
  });

  it('a generated sheet is an AI face: no ledger, isHuman false', async () => {
    await saveCharacterFaceAsTalent(
      scopedDb({ model: 'fal-ai/gpt-image-2', url: '/r2/sheets/gen.png' }),
      ctx,
      args
    );

    expect(requireUploadRights).not.toHaveBeenCalled();
    expect(carryUploadRights).not.toHaveBeenCalled();
    expect(talentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ isHuman: false })
    );
  });

  it('a character with no sheet is refused', async () => {
    await expect(
      saveCharacterFaceAsTalent(scopedDb(null), ctx, args)
    ).rejects.toThrow(/no sheet yet/);
    expect(talentCreate).not.toHaveBeenCalled();
  });
});
